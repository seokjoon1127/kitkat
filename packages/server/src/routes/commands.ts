// POST /api/projects/:id/commands — 명령 배치 적용 + setReversed(true) 자동 reverse 잡 등록
// + W5: 클립 source 를 감시해 파생 미디어를 굽는 스케줄러(applyBatch 안에서 호출됨)
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { findClip, type Command } from '@kitkat/engine';
import {
  DEFAULT_TARGET_LUFS,
  newId,
  sourceKey,
  type AudioClipSource,
  type ClipSource,
  type DerivedMedia,
  type ProjectDoc,
} from '@kitkat/schema';
import {
  deriveMedia,
  estimateMotionBlurSeconds,
  makeWaveform,
  preprocessReverse,
  voiceIrPath,
  type DeriveSpec,
  type VoicePresetId,
} from '@kitkat/media';
import { sendError, type AppContext } from '../app.js';

/**
 * 배치에 setReversed(true)가 있고 해당 asset 에 reversedSrc 가 없으면
 * reverse 잡을 등록한다(완료 시 updateAsset 브로드캐스트). assetId 기준 중복 방지.
 */
export function scheduleReverseJobs(ctx: AppContext, doc: ProjectDoc, commands: Command[]): void {
  for (const cmd of commands) {
    if (cmd.type !== 'setReversed' || !cmd.reversed) continue;
    const found = findClip(doc, cmd.clipId);
    if (!found) continue;
    const clip = found.clip;
    if (!('assetId' in clip)) continue;
    const asset = doc.assets[clip.assetId];
    if (!asset || asset.kind !== 'video' || asset.reversedSrc) continue;
    if (ctx.jobs.hasActive('reverse', asset.id)) continue;
    const { id: assetId, src } = asset;
    ctx.jobs.enqueue(
      'reverse',
      doc.id,
      async () => {
        const rel = await preprocessReverse(path.join(ctx.mediaDir, src), ctx.mediaDir, assetId);
        await ctx.applyBatch(doc.id, [{ type: 'updateAsset', assetId, patch: { reversedSrc: rel } }]);
      },
      assetId,
    );
  }
}

/**
 * 문서 전체를 훑어 `source` 가 붙은 클립의 파생 파일을 굽는 잡을 등록한다 (X6, M2).
 * 명령 종류를 보지 않는다 — updateClip·addClip·restoreDoc 어디로든 들어올 수 있고,
 * 잡 완료가 일으킨 문서 변경(역재생·에셋 후처리)도 스케줄러를 깨워야 하므로 applyBatch 안에서 호출된다.
 *
 * 중복 방지 key 는 `<assetId>:<sourceKey>`. 이미 `asset.derived[key]` 가 있으면 건너뛴다
 * (파생 완료 → updateAsset → 다시 훑음 → 새 잡 없음 이라서 재귀는 자연히 멈춘다).
 */
/** 이 문서의 클립이 실제로 참조하는 `<assetId>:<sourceKey>` 조합 전부. */
export function liveDeriveKeys(doc: ProjectDoc): Set<string> {
  const live = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
      const key = sourceKey(clip);
      if (key !== null) live.add(`${clip.assetId}:${key}`);
    }
  }
  return live;
}

/**
 * 회수 계획 — 어떤 클립도 더 이상 참조하지 않는 `asset.derived` 키를 찾는다 (버그 A).
 * 슬라이더 한 번 드래그로 키가 수십 개 생기는데 지우는 코드가 없어 디스크가 터진다.
 *
 * 아직 `queued`/`running` 인 derive 잡의 키는 남긴다 — 지워봐야 그 잡이 곧 다시 써넣는다.
 * 문서에서 키를 빼는 것은 반드시 `updateAsset` 명령으로만 한다 (UI 의 undo 스택 보존 로직이
 * 명령 스트림을 그대로 재적용하기 때문). undo 로 돌아가면 다시 굽게 되는 것은 감수한다.
 */
export function planDerivePrune(
  ctx: AppContext,
  doc: ProjectDoc,
): { commands: Command[]; files: string[] } {
  const live = liveDeriveKeys(doc);
  const commands: Command[] = [];
  const files: string[] = [];
  for (const asset of Object.values(doc.assets)) {
    if (!asset.derived) continue;
    const kept: Record<string, DerivedMedia> = {};
    let dead = 0;
    for (const [key, media] of Object.entries(asset.derived)) {
      const jobKey = `${asset.id}:${key}`;
      if (live.has(jobKey) || ctx.jobs.hasActive('derive', jobKey)) {
        kept[key] = media;
        continue;
      }
      dead++;
      files.push(media.src);
      if (media.proxySrc) files.push(media.proxySrc);
    }
    if (dead === 0) continue;
    commands.push({ type: 'updateAsset', assetId: asset.id, patch: { derived: kept } });
  }
  return { commands, files };
}

/** 영구 실패 집합 상한 — 넘으면 오래된 것부터 버린다. */
const MAX_FAILED_DERIVE = 500;

/**
 * 실패한 derive 키를 서버 수명 동안 기억한다 (버그 B).
 * 실패한 잡은 `derived[key]` 를 안 만들고 `hasActive` 도 queued|running 만 세므로,
 * 기억해 두지 않으면 이후 **모든** applyBatch(빈 배치 포함)가 같은 잡을 다시 등록한다.
 * 키는 스펙의 해시라 같은 키가 다시 유효해질 일은 없다.
 */
function rememberDeriveFailure(ctx: AppContext, jobKey: string): void {
  ctx.failedDerive.delete(jobKey);
  ctx.failedDerive.add(jobKey);
  while (ctx.failedDerive.size > MAX_FAILED_DERIVE) {
    const oldest = ctx.failedDerive.values().next().value;
    if (oldest === undefined) break;
    ctx.failedDerive.delete(oldest);
  }
}

/**
 * W8 S3 의 새 필드를 DeriveSpec 으로 옮긴다 (에셋 id → 절대경로 변환 포함).
 * `matchTo` 는 `levels` 가 «반드시» 있어야 한다 — 호출 전에 awaitingMatchMeasure 로 거른다.
 */
async function fillSourceSpec(
  spec: DeriveSpec,
  source: ClipSource & AudioClipSource,
): Promise<void> {
  if (source.matchTo?.levels) {
    spec.matchTo = { levels: source.matchTo.levels, strength: source.matchTo.strength };
  }
  if (source.hueSat && source.hueSat.length > 0) spec.hueSat = source.hueSat;
  if (source.hsl && source.hsl.length > 0) spec.hsl = source.hsl;
  if (source.motionBlur) spec.motionBlur = source.motionBlur;
  if (source.voice && source.voice.preset !== 'off') {
    const v = source.voice;
    spec.voice = {
      preset: v.preset as VoicePresetId,
      targetLufs: v.targetLufs ?? DEFAULT_TARGET_LUFS,
    };
    if (v.reverb) {
      // IR 은 vendor/ir/ 에 있다 (scripts/prewarm.mjs voice-ir). 없으면 «조용히 건너뛰지 않고»
      // 잡을 실패시킨다 — 리버브를 켰는데 아무 일도 안 일어나는 것이 제일 나쁘다.
      const irAbs = voiceIrPath(v.reverb.irId);
      try {
        await access(irAbs);
      } catch {
        throw new Error(
          `공간감 IR 파일을 찾을 수 없습니다: ${v.reverb.irId} — \`node scripts/prewarm.mjs voice-ir\` 로 내려받으세요`,
        );
      }
      spec.voice.reverb = { irAbs, wet: v.reverb.wet };
    }
  }
}

/** matchTo 가 걸려 있는데 아직 측정이 안 됐으면 구울 수 없다. */
function awaitingMatchMeasure(source: ClipSource & AudioClipSource): boolean {
  return source.matchTo != null && source.matchTo.levels == null;
}

/** 이미 형식을 확인한 파형 파일 (`<assetId>:<waveformSrc>`) — 서버 수명 동안 한 번만 읽는다. */
const waveformChecked = new Set<string>();

/**
 * 옛 형식 파형(1000버킷 «배열»)을 다시 굽는다 (W8 F12-B).
 *
 * 새 형식은 `{ bucketMs, peaks, rms }` 다. 옛 파일은 **버킷 시간을 알 수 없어**
 * 「몇 번째 버킷이 몇 ms 인가」를 계산할 수 없다 → 더킹 구간을 못 만든다.
 * **조용히 근사해서 쓰지 않는다.** 다시 굽는 비용은 PCM 디코드뿐이라 60초에 0.2초다.
 */
export function scheduleWaveformRebake(ctx: AppContext, doc: ProjectDoc): void {
  for (const asset of Object.values(doc.assets)) {
    const rel = asset.waveformSrc;
    if (!rel) continue;
    const checkKey = `${asset.id}:${rel}`;
    if (waveformChecked.has(checkKey)) continue;
    waveformChecked.add(checkKey);

    const projectId = doc.id;
    const assetId = asset.id;
    const srcAbs = path.join(ctx.mediaDir, asset.src);
    void readFile(path.join(ctx.mediaDir, rel), 'utf8')
      .then((raw) => {
        let legacy: boolean;
        try {
          legacy = Array.isArray(JSON.parse(raw));
        } catch {
          legacy = true;   // 깨진 파일도 다시 굽는다
        }
        if (!legacy || ctx.jobs.hasActive('waveform', assetId)) return;
        ctx.jobs.enqueue(
          'waveform',
          projectId,
          async () => {
            const next = await makeWaveform(srcAbs, ctx.mediaDir, assetId);
            if (next) {
              await ctx.applyBatch(projectId, [
                { type: 'updateAsset', assetId, patch: { waveformSrc: next } },
              ]);
            }
            return { assetId, rebaked: next != null };
          },
          assetId,
        );
      })
      .catch(() => {
        // 파형 파일이 사라졌다 — 다음 기회에 다시 본다
        waveformChecked.delete(checkKey);
      });
  }
}

export function scheduleDeriveJobs(ctx: AppContext, doc: ProjectDoc): void {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
      const key = sourceKey(clip);
      if (key === null) continue;
      const asset = doc.assets[clip.assetId];
      if (!asset || asset.derived?.[key]) continue;

      // F4 — 기준 컷의 색 통계 측정(matchStats 잡)은 **F4 담당이 만든다.**
      // 지금은 문서에 `levels` 가 이미 있으면 그것을 쓰고, 없으면 이 조합을 «굽지 않는다»
      // (잡을 등록하지 않는다). 측정이 끝나 updateClip 으로 levels 가 들어오면 sourceKey 가
      // 바뀌고 스케줄러가 다시 돌면서 그때 굽는다. 측정 없이 항등으로 굽지 않는다 —
      // 「맞췄는데 아무 변화가 없다」가 제일 헷갈린다.
      if (awaitingMatchMeasure((clip.source ?? {}) as ClipSource & AudioClipSource)) continue;

      // reversed 클립의 파생은 반드시 reversedSrc 에서 굽는다.
      // sourceKey 는 reversedSrc 존재 여부를 담지 않으므로 원본에서 구워 두면
      // 나중에 역재생 파일이 생겨도 키가 같아 영영 틀린 파일이 남는다 → 아직 없으면 건너뛴다.
      // (역재생 잡이 끝나 updateAsset 이 일어나면 스케줄러가 다시 돌아 그때 굽는다.)
      const reversed = clip.kind === 'video' && clip.reversed === true;
      if (reversed && !asset.reversedSrc) continue;
      const bakeSrc = reversed ? asset.reversedSrc! : asset.src;

      const jobKey = `${asset.id}:${key}`;
      // 한 번 실패한 키는 다시 등록하지 않는다 — 안 그러면 편집할 때마다 같은 잡을 낳고,
      // ffmpeg 단계에서 실패하는 경우엔 재시도마다 원본 전체를 재인코딩한다 (버그 B).
      if (ctx.failedDerive.has(jobKey)) continue;
      if (ctx.jobs.hasActive('derive', jobKey)) continue;

      const projectId = doc.id;
      const assetId = asset.id;
      const audioOnly = asset.kind === 'audio';
      const source = (clip.source ?? {}) as ClipSource & AudioClipSource;
      // F3 — precise 모션 블러는 1080×1920 1초에 77초다. **느리다고 fast 로 바꾸지 않는다.**
      // 예상 시간은 **등록하는 순간** job.estimateSec 으로 나간다(WS 브로드캐스트) — 끝난 뒤에
      // 알려주는 건 소용이 없다. 잡 결과에도 같이 실어 「예상 vs 실제」를 대볼 수 있게 한다.
      const estimateSec = source.motionBlur
        ? estimateMotionBlurSeconds(source.motionBlur, {
            durationMs: asset.duration ?? clip.out - clip.in,
            width: asset.width ?? 1080,
            height: asset.height ?? 1920,
          })
        : 0;
      ctx.jobs.enqueue(
        'derive',
        projectId,
        async (_job, report, signal) => {
          // 큐에서 기다리는 사이 사용자가 값을 또 바꿔 이 키를 아무도 안 쓰게 됐으면 굽지 않는다.
          // (슬라이더 드래그 한 번이면 버려진 강도값이 수십 개 — 실패가 아니라 취소이므로
          //  error 가 아니라 조용히 done + result:{cancelled:true} 로 끝낸다.)
          const docNow = await ctx.store.get(projectId);
          if (!liveDeriveKeys(docNow).has(jobKey)) return { key, cancelled: true };

          try {
            const spec: DeriveSpec = {};
            if (source.lut) {
              const lutAsset = docNow.assets[source.lut.assetId];
              if (!lutAsset || lutAsset.kind !== 'lut') {
                throw new Error(
                  `LUT 에셋을 찾을 수 없습니다: ${source.lut.assetId} — .cube 파일을 먼저 임포트하세요`,
                );
              }
              spec.lut = {
                cubeAbs: path.join(ctx.mediaDir, lutAsset.src),
                intensity: source.lut.intensity,
              };
            }
            if (source.stabilize) spec.stabilize = source.stabilize;
            if (source.denoise) spec.denoise = source.denoise;
            if (source.pitch) spec.pitch = source.pitch;
            await fillSourceSpec(spec, source);

            const out = await deriveMedia(
              path.join(ctx.mediaDir, bakeSrc),
              ctx.mediaDir,
              assetId,
              key,
              spec,
              { ...(audioOnly ? { audioOnly: true } : {}), onProgress: report, signal },
            );
            // derived 에는 파일 경로만 넣는다 (DerivedMediaSchema 가 src/proxySrc 만 받는다).
            const media: DerivedMedia = {
              src: out.src,
              ...(out.proxySrc ? { proxySrc: out.proxySrc } : {}),
            };
            const prev = (await ctx.store.get(projectId)).assets[assetId]?.derived ?? {};
            await ctx.applyBatch(projectId, [
              { type: 'updateAsset', assetId, patch: { derived: { ...prev, [key]: media } } },
            ]);
            return {
              key,
              src: out.src,
              ...(estimateSec > 0 ? { estimateSec } : {}),
              // F11 — loudnorm 이 linear 로 못 가고 dynamic 으로 «말없이» 떨어지는 일이 있다.
              // 측정값을 그대로 돌려줘 인스펙터가 숫자와 이유를 보여줄 수 있게 한다.
              ...(out.loudnorm ? { loudnorm: out.loudnorm } : {}),
            };
          } catch (err) {
            rememberDeriveFailure(ctx, jobKey);
            throw err;
          }
        },
        { key: jobKey, ...(estimateSec > 0 ? { estimateSec } : {}) },
      );
    }
  }
}

export function registerCommandRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/projects/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      commands?: unknown;
      baseRevision?: unknown;
      clientId?: unknown;
    };
    if (!Array.isArray(body.commands)) {
      return reply.code(400).send({ error: 'commands 배열이 필요합니다' });
    }
    // splitClip의 오른쪽 조각 id는 적용 시점 난수가 아니라 명령에 실려야 결정적이다(C3 재적용).
    // 클라이언트가 안 채웠으면 서버가 여기서 채워 넣고, 채워진 명령을 그대로 적용·브로드캐스트한다.
    const commands = (body.commands as Command[]).map((cmd) =>
      cmd != null &&
      typeof cmd === 'object' &&
      cmd.type === 'splitClip' &&
      typeof (cmd as { newClipId?: unknown }).newClipId !== 'string'
        ? { ...cmd, newClipId: newId() }
        : cmd,
    );
    try {
      const next = await ctx.applyBatch(id, commands, {
        ...(typeof body.clientId === 'string' ? { clientId: body.clientId } : {}),
        ...(typeof body.baseRevision === 'number' ? { baseRevision: body.baseRevision } : {}),
      });
      scheduleReverseJobs(ctx, next, commands);
      return { revision: next.revision };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
