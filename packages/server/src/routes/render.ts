// 렌더·자막 잡 + 잡 조회 — C3
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_FONT_FAMILY,
  newId,
  type ProjectDoc,
  type TextClip,
  type TextStyle,
} from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import { renderAudioStem, renderCover, renderProject } from '@kitkat/renderer';
import { toGif } from '@kitkat/media';
import { AiUnavailableError, ensurePython, transcribe } from '@kitkat/ai';
import { sendError, type AppContext } from '../app.js';
import { stageProgress } from '../jobs.js';
import {
  DUCK_TOLERANCE_DB,
  MAX_DUCK_ATTEMPTS,
  SIDECHAIN_STAGE_WEIGHTS,
  SIDECHAIN_SUBTRACT_STAGE_WEIGHTS,
  SILENT_LUFS,
  amountToDb,
  canSubtractStems,
  countFullScaleSamples,
  estimatePlainRenderSeconds,
  estimateSidechainSeconds,
  extractPcmAudio,
  findDuckPairs,
  hasAudioStream,
  levelScGain,
  measureGraphVolume,
  measureLoudness,
  measureVolume,
  muxSidechain,
  nextThresholdDb,
  pcmShape,
  pcmShapesMatch,
  sidechainGraph,
  stripVolumeKeyframes,
  subtractStem,
  thresholdDbFor,
  thresholdLinear,
  triggerVoiceIntervals,
  type DuckAttempt,
  type DuckPair,
} from '../sidechain.js';

const toPosix = (p: string) => p.replaceAll('\\', '/');

const DEFAULT_CAPTION_STYLE: TextStyle = {
  // 번들된 Noto Sans KR (media/fonts/) — 예전 기본값 Pretendard 는 설치돼 있지 않았다 (T2/G2)
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 64,
  color: '#ffffff',
  bold: true,
  strokeColor: '#000000',
  strokeWidth: 6,
  align: 'center',
};

/** 문서 길이(ms) — renderer 의 docDurationMs 와 같은 규칙(최소 1초). */
function docDurationMs(doc: ProjectDoc): number {
  let max = 0;
  for (const t of doc.tracks) for (const c of t.clips) max = Math.max(max, c.start + c.duration);
  return Math.max(1000, max);
}

/**
 * 진짜 사이드체인 더킹 렌더 (W8 F12-A) — 4단계.
 *
 * ```
 *  1) 트리거 스템 (wav)   renderAudioStem(soloTrackIds:[트리거])
 *  2) 눌릴 스템   (wav)   renderAudioStem(soloTrackIds:[눌릴]) — volume 키프레임 제거본
 *  3) 영상 + 나머지 트랙  renderProject(두 트랙 muted)
 *  4) 믹스 + 먹싱         sidechaincompress + amix, 영상은 -c:v copy
 * ```
 *
 * **스템을 먼저 하는 이유:** 3번이 제일 오래 걸리는데(5초에 22초), 사용자가 트랙을 잘못 골라
 * 트리거 스템이 무음이면 그 22초를 통째로 버린다. 1번이 끝난 시점에 라우드니스를 재서
 * 사실상 무음이면 **3번을 시작하기 전에** 실패시킨다.
 *
 * ## 스템 뺄셈 (F17 V5-6) — 조건이 맞으면 3단계
 *
 * ```
 *  1) 트리거 스템 (wav)
 *  2) 영상 + 두 트랙 포함, audioCodec pcm-16 (무손실 «전체 믹스»)
 *  3) 눌릴 스템 = 전체 − 트리거   ← 스템 렌더 한 장이 통째로 없어진다
 *  4) 믹스 + 먹싱 (그대로)
 * ```
 *
 * 조건은 `canSubtractStems` 가 판정하고, 못 맞추면 **조용히 위 4단계로 간다**(속도만 다르다).
 * 포화(클리핑)는 섞어 봐야 알 수 있어 2번 뒤에 표본을 세고, 하나라도 잘렸으면
 * **눌릴 스템을 그때 굽는다** — 이미 구운 영상은 그대로 쓰므로 폴백에 추가 영상 렌더가 없다.
 * 물러선 사실은 잡 결과의 `sidechain.stemSubtract` 에 남는다.
 */
async function renderSidechain(
  doc: ProjectDoc,
  pair: DuckPair,
  opts: {
    mediaDir: string;
    outAbs: string;
    tmpDir: string;
    range?: { start: number; end: number };
    proxy?: boolean;
    width?: number;
    height?: number;
    fps?: number;
    transparent?: boolean;
    report: (p: number) => void;
    /** 잡 큐 시간 초과 → 스템·영상 렌더 전부 멈춘다 (리뷰 #12) */
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const plan = canSubtractStems(doc, [pair], { transparent: opts.transparent === true });
  const { passProgress, endPass } = stageProgress(
    plan.ok ? SIDECHAIN_SUBTRACT_STAGE_WEIGHTS : SIDECHAIN_STAGE_WEIGHTS,
    opts.report,
  );
  const triggerWav = path.join(opts.tmpDir, 'trigger.wav');
  const duckedWav = path.join(opts.tmpDir, 'ducked.wav');
  const fullWav = path.join(opts.tmpDir, 'full.wav');
  // ⚠️ 뺄셈 경로는 **.mkv 여야 한다.** Remotion 은 h264 + pcm-16 을 지원하지만
  //    `validateOutputFilename` 이 확장자를 mkv·mov 로 못 박는다 (실측: .mp4 로 주면
  //    「the output filename must end in one of the following: mkv, mov」로 죽는다).
  //    최종 파일은 어차피 `muxSidechain` 이 `-c:v copy` 로 옮겨 담으므로 중간 그릇은 상관없다.
  const videoTmp = path.join(
    opts.tmpDir,
    plan.ok ? 'video.mkv' : `video${path.extname(opts.outAbs) || '.mp4'}`,
  );
  const stemOpts = {
    signal: opts.signal,
    mediaDir: opts.mediaDir,
    ...(opts.range ? { range: opts.range } : {}),
    onProgress: passProgress,
  };
  /** 눌릴 스템을 «따로» 굽는다 — 3패스 경로와 포화 폴백이 같이 쓴다. */
  const bakeDuckedStem = (): Promise<unknown> =>
    // 키프레임 더킹이 걸려 있으면 지운 사본으로 굽는다(이중 더킹 방지).
    renderAudioStem(stripVolumeKeyframes(doc, pair.duckedTrackId), {
      ...stemOpts,
      outPath: duckedWav,
      soloTrackIds: [pair.duckedTrackId],
    });
  const renderVideo = (
    videoDoc: ProjectDoc,
    audioCodec?: 'pcm-16',
  ): Promise<unknown> =>
    renderProject(videoDoc, {
      signal: opts.signal,
      mediaDir: opts.mediaDir,
      outPath: videoTmp,
      ...(opts.range ? { range: opts.range } : {}),
      ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
      ...(opts.width !== undefined ? { width: opts.width } : {}),
      ...(opts.height !== undefined ? { height: opts.height } : {}),
      ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
      ...(opts.transparent ? { transparent: true } : {}),
      ...(audioCodec ? { audioCodec } : {}),
      onProgress: passProgress,
    });

  // 1) 트리거 스템
  await renderAudioStem(doc, { ...stemOpts, outPath: triggerWav, soloTrackIds: [pair.triggerTrackId] });
  endPass();
  const trigger = await measureLoudness(triggerWav);
  if (!(trigger.i > SILENT_LUFS)) {
    const trackName = doc.tracks.find((t) => t.id === pair.triggerTrackId)?.name ?? pair.triggerTrackId;
    throw new Error(
      `더킹 트리거 트랙 「${trackName}」이 사실상 무음입니다 (${
        Number.isFinite(trigger.i) ? trigger.i.toFixed(1) : '-∞'
      } LUFS). ` + '트랙을 잘못 고르지 않았는지, 음소거·볼륨 0 이 아닌지 확인하세요.',
    );
  }

  // 2~3) 눌릴 스템과 영상 — 뺄셈이 되면 순서가 뒤집히고 스템 렌더가 한 장 없어진다.
  let videoHasAudio: boolean;
  const stemSubtract: Record<string, unknown> = { used: false };
  if (!plan.ok) {
    stemSubtract.reason = plan.reason;

    // 2) 눌릴 스템
    await bakeDuckedStem();
    endPass();

    // 3) 영상 + 나머지 트랙 (두 트랙은 muted — 4번에서 섞는다)
    await renderVideo({
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === pair.duckedTrackId || t.id === pair.triggerTrackId ? { ...t, muted: true } : t,
      ),
    });
    endPass();
    videoHasAudio = await hasAudioStream(videoTmp);
  } else {
    // 2') 영상 + 두 트랙 «포함», 오디오는 무손실 pcm-16.
    //     aac 192k 로 구우면 잔차가 −17.6dB 라 그냥 들린다 (F17 V5-6 실측).
    //     눌릴 트랙의 volume 키프레임은 여기서도 지운다 — 안 그러면 뺄셈 결과가
    //     3패스의 눌릴 스템과 달라진다(이중 더킹).
    await renderVideo(stripVolumeKeyframes(doc, pair.duckedTrackId), 'pcm-16');
    endPass();

    // 3') 전체 믹스를 꺼내 «잘린 표본»을 세고, 0 일 때만 뺀다.
    await extractPcmAudio(videoTmp, fullWav);
    const clipping = await countFullScaleSamples(fullWav);
    const shapes = { full: await pcmShape(fullWav), trigger: await pcmShape(triggerWav) };
    const aligned = pcmShapesMatch(shapes.full, shapes.trigger);
    stemSubtract.clippedSamples = clipping.full;
    stemSubtract.totalSamples = clipping.total;
    if (clipping.full > 0) {
      // 0.07% 만 잘려도 잔차가 −36.2dB 로 들린다 (F17 V5-6 실측) → 조용히 품질을 떨어뜨리지 않고
      // 스템을 «그때» 굽는다. 영상은 이미 있으므로 추가 영상 렌더는 없다.
      stemSubtract.reason =
        `전체 믹스가 포화했다 (${clipping.full}/${clipping.total} 표본, ` +
        `${((clipping.full / Math.max(1, clipping.total)) * 100).toFixed(4)}%)`;
      await bakeDuckedStem();
    } else if (!aligned) {
      stemSubtract.reason =
        `표본 정렬이 어긋났다 (전체 ${shapes.full.sampleRate}Hz/${shapes.full.channels}ch/` +
        `${shapes.full.samples}표본, 트리거 ${shapes.trigger.sampleRate}Hz/` +
        `${shapes.trigger.channels}ch/${shapes.trigger.samples}표본)`;
      await bakeDuckedStem();
    } else {
      await subtractStem(fullWav, triggerWav, duckedWav);
      stemSubtract.used = true;
    }
    // 영상 안에 «전체 믹스»가 들어 있다 — amix 에 또 넣으면 두 번 섞인다.
    // muxSidechain 은 `-map 0:v` 만 하므로 그 오디오는 최종 파일에 안 들어간다.
    videoHasAudio = false;
  }

  // 4) 믹스 — threshold 는 공식으로 잡고 «재서» 고친다 (공식이 정확하지 않다는 것을 W7 이 실측했다).
  const levelSc = levelScGain(trigger.i);
  const targetDb = -amountToDb(pair.duck.amount);
  let thresholdDb = thresholdDbFor(pair.duck.amount);
  const graphOpts = {
    levelSc,
    threshold: thresholdLinear(thresholdDb),
    attackMs: pair.duck.attackMs,
    releaseMs: pair.duck.releaseMs,
    videoHasAudio,
  };

  // 목소리 구간을 알아야 「목소리가 있는 동안 얼마나 눌렸는지」를 잴 수 있다 (B 의 포락선).
  // ⚠️ 구간은 «타임라인» 기준인데 스템은 range.start 부터 시작한다 — 옮기고 잘라야 한다.
  //    (안 그러면 구간 밖 렌더에서 고른 표본이 0개가 되어 측정이 실패한다.)
  const timeline = await triggerVoiceIntervals(doc, opts.mediaDir, pair.triggerTrackId);
  const from = opts.range?.start ?? 0;
  const to = opts.range?.end ?? Infinity;
  const intervals = timeline
    .map((iv) => ({ start: Math.max(iv.start, from) - from, end: Math.min(iv.end, to) - from }))
    .filter((iv) => iv.end > iv.start);
  const attempts: DuckAttempt[] = [];
  if (intervals.length > 0) {
    const base = await measureVolume(duckedWav, intervals);
    for (let n = 0; n < MAX_DUCK_ATTEMPTS; n++) {
      const out = await measureGraphVolume(
        [duckedWav, triggerWav],
        // 측정 그래프는 «눌린 음악만» 낸다 — 나레이션이 섞이면 감쇠량을 못 잰다.
        sidechainGraph({ ...graphOpts, threshold: thresholdLinear(thresholdDb), duckedOnly: true }),
        intervals,
      );
      const actual = out.mean - base.mean;
      attempts.push({ thresholdDb: Number(thresholdDb.toFixed(2)), actualDb: Number(actual.toFixed(2)) });
      if (Math.abs(actual - targetDb) <= DUCK_TOLERANCE_DB) break;
      if (n === MAX_DUCK_ATTEMPTS - 1) break;  // 못 맞췄으면 숫자를 결과에 남긴다
      thresholdDb = nextThresholdDb(attempts, targetDb);
    }
  }
  const landed = attempts[attempts.length - 1];

  await muxSidechain(videoTmp, duckedWav, triggerWav, opts.outAbs, {
    ...graphOpts,
    threshold: thresholdLinear(thresholdDb),
  });
  endPass();

  return {
    sidechain: {
      duckedTrackId: pair.duckedTrackId,
      triggerTrackId: pair.triggerTrackId,
      triggerLufs: Number(trigger.i.toFixed(2)),
      levelSc: Number(levelSc.toFixed(4)),
      thresholdDb: Number(thresholdDb.toFixed(2)),
      targetDb: Number(targetDb.toFixed(2)),
      /** 믹스 시도마다의 threshold·실측 감쇠(dB). 마지막 것이 최종 결과다. */
      attempts,
      ...(landed ? { measuredDb: landed.actualDb } : {}),
      // 목표에 못 들었으면 «숨기지 않고» 표시한다.
      ...(landed && Math.abs(landed.actualDb - targetDb) > DUCK_TOLERANCE_DB
        ? { offTarget: true }
        : {}),
      voiceIntervals: intervals.length,
      videoHasAudio,
      /** 스템 뺄셈(F17 V5-6)을 썼는가. 못 썼으면 `reason` 에 왜인지 남는다. */
      stemSubtract,
    },
  };
}

type RenderBody = {
  range?: { start: number; end: number };
  proxy?: boolean;
  format?: 'mp4' | 'gif' | 'mov';
  /** 알파 보존 출력. format:'mov' 면 기본 true (X6) */
  transparent?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  outName?: string;
};

export function registerRenderRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/projects/:id/render', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as RenderBody;
    try {
      const doc0 = await ctx.store.get(id); // 없으면 404
      const format: 'mp4' | 'gif' | 'mov' =
        body.format === 'gif' ? 'gif' : body.format === 'mov' ? 'mov' : 'mp4';
      // mov 는 알파 보존이 기본 — 명시적으로 false 를 줘야 끈다
      const transparent = format === 'mov' ? body.transparent !== false : body.transparent === true;
      const rawName =
        typeof body.outName === 'string' && body.outName.trim() !== ''
          ? body.outName.trim()
          : `${id}-${Date.now()}`;
      const base = rawName.replace(/\.(mp4|gif|mov)$/i, '').replace(/[^\w.가-힣-]+/g, '_');
      const outFile = `${base}.${format}`;

      // 진짜 사이드체인은 gif 에는 안 쓴다(오디오가 없다). 쌍이 둘 이상이면 첫 쌍만 —
      // 나머지는 키프레임 근사로 남고, 그 사실을 잡 결과에 담는다.
      const pairs0 = format === 'gif' ? [] : findDuckPairs(doc0);
      const rangeMs = body.range
        ? Math.max(0, body.range.end - body.range.start)
        : docDurationMs(doc0);
      // 뺄셈이 되는 문서면 스템이 한 장뿐이라 32% 짧다 — 예상 시간도 그 숫자로 낸다.
      const subtract0 = canSubtractStems(doc0, pairs0, { transparent }).ok;
      const estimateSec =
        pairs0.length > 0
          ? estimateSidechainSeconds(rangeMs, { subtract: subtract0 })
          : estimatePlainRenderSeconds(rangeMs);

      const job = ctx.jobs.enqueue('render', id, async (_job, report, signal) => {
        const doc = await ctx.store.get(id);
        const rendersDir = path.join(ctx.mediaDir, 'renders');
        await fs.mkdir(rendersDir, { recursive: true });

        // ── W8 F12-A: 사이드체인 더킹이 켜져 있으면 4단계 경로 ──
        const pairs = format === 'gif' ? [] : findDuckPairs(doc);
        const pair = pairs[0];
        if (pairs.length > 1) {
          // 조용히 하나만 처리하면 «어떤 트랙은 눌리고 어떤 트랙은 안 눌린» 결과가 나온다.
          // 그런 결과를 말없이 내보내느니 여기서 멈춘다.
          const names = pairs
            .map((p) => doc.tracks.find((t) => t.id === p.duckedTrackId)?.name ?? p.duckedTrackId)
            .join(', ');
          throw new Error(
            `사이드체인 더킹은 아직 한 쌍만 지원합니다 — 지금 ${pairs.length}쌍이 켜져 있습니다 (${names}). ` +
              '더킹 창에서 한 쌍만 남기고 「진짜 사이드체인 컴프로 렌더」를 꺼 주세요.',
          );
        }
        if (pair) {
          const outAbs = path.join(rendersDir, outFile);
          const tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'kitkat-sidechain-'));
          try {
            const info = await renderSidechain(doc, pair, {
              signal,
              mediaDir: ctx.mediaDir,
              outAbs,
              tmpDir,
              ...(body.range ? { range: body.range } : {}),
              ...(body.proxy !== undefined ? { proxy: body.proxy } : {}),
              ...(typeof body.width === 'number' ? { width: body.width } : {}),
              ...(typeof body.height === 'number' ? { height: body.height } : {}),
              ...(typeof body.fps === 'number' ? { fps: body.fps } : {}),
              ...(transparent ? { transparent: true } : {}),
              report,
            });
            return {
              url: `/media/renders/${outFile}`,
              path: toPosix(outAbs),
              estimateSec,
              ...info,
            };
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
          }
        }

        // 단계 가중치 — mp4/mov 는 단계 하나, gif 는 「렌더 0.9 + gif 변환 0.1」(기존 비율 그대로)
        const { passProgress, endPass } = stageProgress(
          format === 'gif' ? [0.9, 0.1] : [1],
          report,
        );
        // gif 만 중간 mp4 를 거친다. mov 는 renderProject 결과가 곧 최종 파일.
        const renderAbs = path.join(rendersDir, format === 'gif' ? `${base}.tmp.mp4` : outFile);
        await renderProject(doc, {
          signal,
          mediaDir: ctx.mediaDir,
          outPath: renderAbs,
          ...(body.range ? { range: body.range } : {}),
          ...(body.proxy !== undefined ? { proxy: body.proxy } : {}),
          ...(typeof body.width === 'number' ? { width: body.width } : {}),
          ...(typeof body.height === 'number' ? { height: body.height } : {}),
          ...(typeof body.fps === 'number' ? { fps: body.fps } : {}),
          ...(transparent ? { transparent: true } : {}),
          onProgress: passProgress,
        });
        endPass();
        let finalAbs = renderAbs;
        if (format === 'gif') {
          finalAbs = path.join(rendersDir, outFile);
          await toGif(renderAbs, finalAbs, {});
          await fs.rm(renderAbs, { force: true });
          endPass();
        }
        return { url: `/media/renders/${outFile}`, path: toPosix(finalAbs) };
      });
      // 예상 시간을 «잡 등록 응답»에 담는다 — 사이드체인은 스템 2장 때문에 2배 넘게 걸린다.
      return { jobId: job.id, estimateSec, sidechain: pairs0.length > 0 };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 커버(대표 이미지) 1장 + settings.coverMs 기록 (X6/M5) ────────────────
  app.post('/api/projects/:id/cover', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { timeMs?: unknown; proxy?: unknown };
    try {
      const doc = await ctx.store.get(id); // 없으면 404
      let timeMs = doc.settings.coverMs ?? 0;
      if (body.timeMs !== undefined) {
        if (typeof body.timeMs !== 'number' || !Number.isInteger(body.timeMs) || body.timeMs < 0) {
          return reply.code(400).send({ error: 'timeMs 는 0 이상의 정수(ms)여야 합니다' });
        }
        timeMs = body.timeMs;
      }
      const proxy = body.proxy === true;
      const outFile = `${id}-cover.jpg`;

      const job = ctx.jobs.enqueue(
        'cover',
        id,
        async (_job, _report, signal) => {
          const docNow = await ctx.store.get(id);
          const rendersDir = path.join(ctx.mediaDir, 'renders');
          await fs.mkdir(rendersDir, { recursive: true });
          const outAbs = path.join(rendersDir, outFile);
          await renderCover(docNow, {
            signal,
            mediaDir: ctx.mediaDir,
            outPath: outAbs,
            timeMs,
            ...(proxy ? { proxy: true } : {}),
          });
          await ctx.applyBatch(id, [{ type: 'setSettings', settings: { coverMs: timeMs } }]);
          return { url: `/media/renders/${outFile}`, path: toPosix(outAbs) };
        },
        id,
      );
      return { jobId: job.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/projects/:id/captions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      assetId?: unknown;
      trackId?: unknown;
      style?: Partial<TextStyle>;
      language?: unknown;
    };
    try {
      const doc = await ctx.store.get(id);
      if (typeof body.assetId !== 'string') {
        return reply.code(400).send({ error: 'assetId 가 필요합니다' });
      }
      const assetId = body.assetId;
      if (!doc.assets[assetId]) {
        return reply.code(404).send({ error: `에셋 없음: ${assetId}` });
      }

      // AiUnavailableError → 501 (C6)
      try {
        const status = await ensurePython();
        if (!status.ok) {
          return reply.code(501).send({ error: status.hint ?? '자동자막 엔진을 사용할 수 없습니다' });
        }
      } catch (err) {
        if (err instanceof AiUnavailableError) {
          return reply.code(501).send({ error: err.message });
        }
        throw err;
      }

      const trackIdOpt = typeof body.trackId === 'string' ? body.trackId : undefined;
      const language = typeof body.language === 'string' ? body.language : undefined;
      const styleOverride = body.style && typeof body.style === 'object' ? body.style : undefined;

      const job = ctx.jobs.enqueue('captions', id, async () => {
        const docNow = await ctx.store.get(id);
        const asset = docNow.assets[assetId];
        if (!asset) throw new Error(`에셋 없음: ${assetId}`);
        const segments = await transcribe(
          path.join(ctx.mediaDir, asset.src),
          language ? { language } : undefined,
        );

        const commands: Command[] = [];
        let trackId = trackIdOpt;
        if (!trackId) {
          // 기존 클립과 겹치지 않는 text 트랙을 고르고, 없으면 새 "자막" 트랙 생성
          const fits = (track: { clips: { start: number; duration: number }[] }) =>
            segments.every((seg) =>
              track.clips.every(
                (c) => seg.start + seg.duration <= c.start || c.start + c.duration <= seg.start,
              ),
            );
          const textTrack = docNow.tracks.find((t) => t.kind === 'text' && fits(t));
          if (textTrack) {
            trackId = textTrack.id;
          } else {
            trackId = newId();
            commands.push({ type: 'addTrack', track: { id: trackId, kind: 'text', name: '자막' } });
          }
        }
        for (const seg of segments) {
          const clip: TextClip = {
            id: newId(),
            kind: 'text',
            start: seg.start,
            duration: seg.duration,
            text: seg.text,
            style: { ...DEFAULT_CAPTION_STYLE, ...styleOverride },
            transform: { x: 0, y: 0.35, scale: 1, rotation: 0 },
            animationIn: { type: 'wordHighlight', duration: Math.min(400, seg.duration) },
            highlightColor: '#ffd400',
            // 미디어 절대 ms → 클립 상대 ms
            words: seg.words.map((w) => ({
              text: w.text,
              start: w.start - seg.start,
              duration: w.duration,
            })),
          };
          commands.push({ type: 'addClip', trackId, clip });
        }
        if (commands.length > 0) await ctx.applyBatch(id, commands);
        return { segments: segments.length };
      });
      return { jobId: job.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/jobs/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = ctx.jobs.get(jobId);
    if (!job) return reply.code(404).send({ error: `잡 없음: ${jobId}` });
    return job;
  });
}
