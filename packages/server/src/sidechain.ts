// 진짜 사이드체인 더킹 (W8 F12-A) — 렌더 시 스템 2장을 만들어 `sidechaincompress` 로 섞는다.
//
// 왜 스템을 따로 굽나: Remotion 은 오디오를 자체 ffmpeg 파이프라인으로 섞고 필터를 `volume`
// 하나만 건다. 컴프를 끼워 넣을 자리가 없다 → 트리거(나레이션)와 눌릴(음악) 트랙을 각각
// 오디오 전용으로 렌더한 뒤 ffmpeg 에서 섞는다.
//
// 미리보기는 볼륨 키프레임 근사다(PRD P3: 결과물 무타협, 미리보기는 프록시). 숨기지 않고 UI 에 적는다.
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { Clip, ProjectDoc, Track } from '@kitkat/schema';
import { voiceIntervalsFromEnvelope, type DuckInterval, type VoiceEnvelope } from '@kitkat/engine';

// ── 상수 ─────────────────────────────────────────────────────────────────

/** 감지 경로를 이 라우드니스로 맞춘다 — 조용히 녹음된 나레이션에서도 더킹이 걸리게. */
export const DETECT_LUFS = -16;
/** 컴프 비율 고정. 감쇠량은 threshold 로 잡는다(ratio 를 같이 흔들면 역산이 불안정해진다). */
export const DUCK_RATIO = 4;
/** 트리거가 이보다 조용하면 사실상 무음 — 22초짜리 영상 렌더를 시작하기 «전에» 실패시킨다. */
export const SILENT_LUFS = -70;
/** 실측 감쇠가 목표와 이만큼 넘게 다르면 threshold 를 고쳐 한 번 더 섞는다. */
export const DUCK_TOLERANCE_DB = 1.5;

// sidechaincompress 의 실제 인자 범위 (ffmpeg -h filter=sidechaincompress 로 확인)
const LEVEL_SC_MIN = 0.015625;
const LEVEL_SC_MAX = 64;
const THRESHOLD_MIN = 0.000977;
const THRESHOLD_MAX = 1;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 필터 인자용 숫자 — 지수표기(1e-7)는 ffmpeg 파서가 못 읽는다. */
function num(n: number): string {
  return (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '') || '0';
}

// ── 순수 계산 ────────────────────────────────────────────────────────────

/** 감쇠 배율(0..1) → dB. 0.25 → 12.04dB. */
export function amountToDb(amount: number): number {
  if (amount <= 0) return 60;
  return -20 * Math.log10(Math.min(1, amount));
}

/**
 * `level_sc` — **감지 경로에만** 걸리는 게인.
 *
 * ⚠️ 계획 12 가 잡은 결함: W7 조사의 필터그래프는 `loudnorm` 을 `asplit` **앞**에 걸어
 * **들리는 나레이션까지 -16 LUFS 로 덮어쓴다.** 사용자가 맞춰 놓은 나레이션 크기나
 * F11 나레이션 체인이 앉힌 -14 LUFS 가 통째로 무시된다. `level_sc` 는 감지 경로의
 * 게인만 바꾸므로 **들리는 소리에는 어떤 필터도 안 붙는다.**
 */
export function levelScGain(measuredLufs: number): number {
  if (!Number.isFinite(measuredLufs)) return 1;
  return clamp(Math.pow(10, (DETECT_LUFS - measuredLufs) / 20), LEVEL_SC_MIN, LEVEL_SC_MAX);
}

/**
 * 목표 감쇠 D(dB) → threshold(선형).
 * downward 컴프의 감쇠 ≈ (L_sc − T)·(1 − 1/ratio) 이므로 ratio=4 에서 T_dB = L_sc − D/0.75.
 *
 * **이 공식은 정확하지 않다** (RMS 통합값보다 순간 피크가 높다 — W7 실측에서 7.5dB 예측에
 * 실측 10.3dB). 믹스가 1초도 안 걸리므로 재서 고친다 → `correctThresholdDb`.
 */
export function thresholdDbFor(amount: number, lscDb: number = DETECT_LUFS): number {
  return lscDb - amountToDb(amount) / (1 - 1 / DUCK_RATIO);
}

export function thresholdLinear(thresholdDb: number): number {
  return clamp(Math.pow(10, thresholdDb / 20), THRESHOLD_MIN, THRESHOLD_MAX);
}

/**
 * 실측 감쇠가 목표와 다르면 threshold 를 그만큼 옮긴다 (같은 1차식의 역함수).
 *
 * **`actualDb`·`targetDb` 는 둘 다 «음수»** 다 (-12dB 처럼). 감쇠 A = −(L_sc − T)·0.75 이므로
 * T = L_sc + A/0.75 → T_new = T_old + (목표 − 실측)/0.75.
 *
 * ⚠️ 부호를 뒤집으면 **덜 눌리는 쪽으로 «수정»** 한다. 실측으로 잡았다:
 * threshold −32.05dB 에서 −7.1dB 가 나왔을 때 부호가 뒤집힌 식은 −25.47dB 를 내놓았고
 * 그 값의 실측은 −4.5dB — 목표(−12dB)에서 더 멀어졌다.
 */
export function correctThresholdDb(
  thresholdDb: number,
  actualDb: number,
  targetDb: number,
  slope: number = 1 - 1 / DUCK_RATIO,
): number {
  return thresholdDb + (targetDb - actualDb) / slope;
}

export type DuckAttempt = { thresholdDb: number; actualDb: number };

/**
 * 다음에 시도할 threshold — **두 번째 보정부터는 «실측 기울기»(할선법)를 쓴다.**
 *
 * 모형 기울기 0.75 는 실제와 2배 가까이 다르다. 이 컴퓨터 실측(2026-09-02, 목표 −12.04dB):
 * `(−32.05dB → −7.1dB)` 과 `(−38.64dB → −9.6dB)` 사이 기울기는 **0.38** 이지 0.75 가 아니다.
 * 0.75 만 쓰면 보정 한 번에 −9.6dB 에서 멈춰 목표에서 2.4dB 벗어난 채 끝난다(허용 오차 1.5dB 초과).
 * 두 점을 얻은 뒤부터 실측 기울기로 갈아타면 세 번째에 −12.1dB 로 들어온다.
 */
export function nextThresholdDb(history: readonly DuckAttempt[], targetDb: number): number {
  const last = history[history.length - 1]!;
  const prev = history[history.length - 2];
  let slope = 1 - 1 / DUCK_RATIO;
  if (prev) {
    const dT = last.thresholdDb - prev.thresholdDb;
    const s = dT !== 0 ? (last.actualDb - prev.actualDb) / dT : 0;
    if (s > 0.05 && s < 2) slope = s;   // 퇴화한 기울기는 무시하고 모형값으로 물러선다
  }
  return correctThresholdDb(last.thresholdDb, last.actualDb, targetDb, slope);
}

/**
 * 믹스 측정 최대 횟수.
 *
 * ⚠️ 계획 12 는 「최대 2회」였는데 **2회로는 검증 2(±1.5dB)를 못 지킨다** — 위 실측처럼
 * 모형 기울기가 2배 어긋나기 때문이다. 측정 한 번이 10초 프로젝트에서 0.2~0.3초라
 * (전체 3회에 1.1초) 늘려도 사실상 공짜다. 목표에 들면 즉시 멈춘다.
 */
export const MAX_DUCK_ATTEMPTS = 4;

export type SidechainGraphOpts = {
  levelSc: number;
  threshold: number;
  attackMs: number;
  releaseMs: number;
  /** 영상 입력에 오디오 스트림이 있는가 — 없으면 amix 입력이 2개다. */
  videoHasAudio: boolean;
  /** true 면 눌린 음악만 [out] 으로 낸다 (감쇠량 측정용 — 나레이션이 섞이면 못 잰다). */
  duckedOnly?: boolean;
};

/**
 * 4단계 필터그래프. 입력 [0]=영상 mp4 · [1]=눌릴 스템 · [2]=트리거 스템.
 *
 * - `asplit` 이 필요한 이유: 필터그래프의 출력 패드는 한 곳에만 연결된다. 트리거를
 *   「감지용」과 「들리는 소리용」 두 곳에 쓰려면 반드시 쪼개야 한다.
 * - `normalize=0` 이 필수다 — `amix` 기본값은 입력 수로 나눠 전체가 1/N 이 된다.
 */
export function sidechainGraph(o: SidechainGraphOpts): string {
  const comp =
    `sidechaincompress=level_sc=${num(o.levelSc)}:threshold=${num(o.threshold)}` +
    `:ratio=${DUCK_RATIO}:attack=${num(clamp(o.attackMs, 0.01, 2000))}` +
    `:release=${num(clamp(o.releaseMs, 0.01, 9000))}` +
    `:makeup=1:knee=6:detection=rms:link=average`;
  if (o.duckedOnly) {
    // 측정용: 입력이 [0]=눌릴 스템 · [1]=트리거 둘뿐이고 트리거를 쪼갤 필요도 없다
    // (나레이션이 섞이면 «음악이 얼마나 눌렸는지» 를 못 잰다).
    return `[0:a][1:a]${comp}[out]`;
  }
  const mixInputs = ['[mduck]', '[vout]', ...(o.videoHasAudio ? ['[0:a]'] : [])];
  return [
    `[2:a]asplit=2[vdet][vout]`,
    `[1:a][vdet]${comp}[mduck]`,
    `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:normalize=0[out]`,
  ].join(';');
}

/** 이 문서에서 «눌릴 트랙 → 트리거 트랙» 쌍. duckedBy 와 duck 이 둘 다 있어야 유효하다. */
export type DuckPair = {
  duckedTrackId: string;
  triggerTrackId: string;
  duck: NonNullable<Track['duck']>;
};

export function findDuckPairs(doc: ProjectDoc): DuckPair[] {
  const out: DuckPair[] = [];
  for (const t of doc.tracks) {
    if (!t.duckedBy || !t.duck) continue;
    if (!doc.tracks.some((x) => x.id === t.duckedBy)) continue;
    // amount 1 = 「하나도 안 낮춘다」 → 컴프를 걸 이유가 없다. 걸어 두면 threshold 가 -16dB 라
    // 오히려 큰 소리를 «건드린다». 스템 2장 값을 치를 이유도 없으니 보통 렌더로 간다.
    if (t.duck.amount >= 0.999) continue;
    out.push({ duckedTrackId: t.id, triggerTrackId: t.duckedBy, duck: t.duck });
  }
  return out;
}

/**
 * 눌릴 트랙의 **volume 키프레임을 지운 doc 사본**.
 * 키프레임 더킹과 사이드체인이 둘 다 걸리면 이중으로 눌린다 — 렌더에서는 사이드체인만 쓴다.
 */
export function stripVolumeKeyframes(doc: ProjectDoc, trackId: string): ProjectDoc {
  return {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId) return t;
      return {
        ...t,
        clips: t.clips.map((c) => {
          if (!c.keyframes || !c.keyframes.some((k) => k.prop === 'volume')) return c;
          const rest = c.keyframes.filter((k) => k.prop !== 'volume');
          const next = { ...c };
          if (rest.length > 0) next.keyframes = rest;
          else delete next.keyframes;
          return next;
        }),
      };
    }),
  };
}

// ── 스템 뺄셈 최적화 (W8 F17 V5-6) — 「전체 − 트리거 = 눌릴 스템」이 성립하는가 ────
//
// 실측(F17 V5-6, 768,000 표본): Remotion 은 트랙마다 wav 를 굽고 «정수 덧셈»으로 섞으므로
// `전체 = 양자화(트리거) + 양자화(눌릴)` 이 항등식이다 — 오차 정확히 0, 상관계수 1.000000000.
// 그래서 눌릴 스템을 따로 굽지 않고 «전체 믹스 − 트리거» 로 얻으면 스템 렌더 한 장을 통째로 아낀다.
//
// 다만 항등식이 깨지는 자리가 셋 있고, 여기서 «전부» 막는다.

/**
 * 이 클립이 소리를 낼 수 있는가.
 *
 * 볼륨이 0 이라도 **volume 키프레임이 0 을 넘으면 소리가 난다** — 그래서 키프레임까지 본다.
 * 판정이 애매하면 «난다» 쪽으로 기운다(그러면 3패스로 물러설 뿐, 소리가 틀리지는 않는다).
 */
function clipCanSound(clip: Clip): boolean {
  if (clip.kind !== 'audio' && clip.kind !== 'video') return false;
  if (clip.volume > 0) return true;
  return clip.keyframes?.some((k) => k.prop === 'volume' && k.value > 0) === true;
}

/** 이 트랙이 최종 믹스에 소리를 넣는가 (hidden 트랙은 컴포지션에서 통째로 빠진다). */
function trackCanSound(track: Track): boolean {
  if (track.hidden === true || track.muted === true) return false;
  if ((track.volume ?? 1) <= 0) return false;
  return track.clips.some(clipCanSound);
}

/** 소리를 내는 트랙 id 들 (문서 순서). */
export function audioSourceTrackIds(doc: ProjectDoc): string[] {
  return doc.tracks.filter(trackCanSound).map((t) => t.id);
}

/** 소리를 내는 클립 중 **비디오 클립**이 하나라도 있는가. */
function hasSoundingVideoClip(doc: ProjectDoc): boolean {
  return doc.tracks.some(
    (t) => trackCanSound(t) && t.clips.some((c) => c.kind === 'video' && clipCanSound(c)),
  );
}

export type SubtractDecision = { ok: true } | { ok: false; reason: string };

/**
 * 스템 뺄셈을 써도 되는가 — **순수 판정**. 하나라도 못 맞추면 조용히 3패스로 간다
 * (사용자에게는 속도만 다르다).
 *
 * 조건과 근거:
 *
 * 1. **더킹 쌍이 정확히 1개.** `전체 − 트리거` 는 「트리거를 뺀 전부」지 「눌릴 트랙」이 아니다.
 *    쌍이 둘이면 어느 트랙을 얻은 건지 정할 수 없다.
 * 2. **소리 나는 트랙이 정확히 그 두 개.** 셋째 트랙이 있으면 그 소리가 「눌릴 스템」에 섞여
 *    들어가 **더킹하면 안 되는 소리까지 눌린다.**
 * 3. **소리 내는 비디오 클립이 없다.** 영상 클립의 소리도 「나머지」라 위 2 의 셋째가 된다.
 *    거기에 더해 비디오는 `proxy` 일 때 음원이 **프록시 파일(96k aac)로 갈린다**
 *    (`resolveMediaSrc` 는 프록시를 보고 `resolveAudioSrc` 는 안 본다) — 영상 렌더와 스템 렌더의
 *    입력 자체가 달라져 뺄셈이 성립하지 않는다. 오디오 클립만 있으면 이 갈림이 없다.
 * 4. **알파(투명) 출력이 아니다.** prores 도 pcm-16 을 받지만(remotion `supportedAudioCodecs`)
 *    이 경로는 실측하지 않았다. 실측 안 한 조합을 빠른 길로 보내지 않는다.
 *
 * ⚠️ 포화(클리핑)는 여기서 못 본다 — 실제로 섞어 봐야 안다. 렌더 뒤에 표본을 세서 막는다
 * (`countFullScaleSamples`).
 */
export function canSubtractStems(
  doc: ProjectDoc,
  pairs: readonly DuckPair[],
  opts: { transparent?: boolean } = {},
): SubtractDecision {
  if (pairs.length !== 1) {
    return { ok: false, reason: `더킹 쌍이 1개가 아니다 (${pairs.length}쌍)` };
  }
  if (opts.transparent === true) {
    return { ok: false, reason: '알파(투명) 출력 — pcm-16 전체 믹스를 실측하지 않았다' };
  }
  const pair = pairs[0]!;
  // 트랙 수보다 «먼저» 본다 — 소리 내는 비디오 클립은 트랙 수도 늘리는데,
  // 그때 「3개다」보다 「비디오 클립이 소리를 낸다」가 고칠 거리를 알려 준다.
  if (hasSoundingVideoClip(doc)) {
    return { ok: false, reason: '소리 내는 비디오 클립이 있다 (프록시 여부로 음원이 갈린다)' };
  }
  const sounding = audioSourceTrackIds(doc);
  if (sounding.length !== 2) {
    return { ok: false, reason: `소리 나는 오디오 트랙이 2개가 아니다 (${sounding.length}개)` };
  }
  if (!sounding.includes(pair.duckedTrackId) || !sounding.includes(pair.triggerTrackId)) {
    return { ok: false, reason: '소리 나는 두 트랙이 더킹 쌍과 다르다' };
  }
  return { ok: true };
}

// ── pcm-16 wav 다루기 (포화 검사·뺄셈) ───────────────────────────────────

/**
 * RIFF/WAVE 의 `data` 청크 위치. 청크 순서를 가정하지 않고 훑는다
 * (`LIST`/`fact` 가 앞에 붙는 파일이 있다).
 */
export function findWavDataChunk(header: Buffer): { offset: number; size: number } | null {
  if (header.length < 12) return null;
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let p = 12;
  while (p + 8 <= header.length) {
    const id = header.toString('ascii', p, p + 4);
    const size = header.readUInt32LE(p + 4);
    if (id === 'data') return { offset: p + 8, size };
    p += 8 + size + (size % 2); // 청크는 짝수 바이트로 패딩된다
  }
  return null;
}

/** s16 표본 배열에서 «끝까지 찬» 표본 수 (+32767 / −32768). 짝수 바이트만 본다. */
export function countFullScaleInt16(buf: Buffer): { full: number; total: number } {
  let full = 0;
  const n = buf.length - (buf.length % 2);
  for (let i = 0; i < n; i += 2) {
    const v = buf.readInt16LE(i);
    if (v >= 32767 || v <= -32768) full++;
  }
  return { full, total: n / 2 };
}

/**
 * pcm-16 wav 의 포화 표본 수를 **정확히** 센다.
 *
 * `volumedetect` 의 `histogram_0db` 는 「0dB 로 반올림되는 칸」이라 안 잘린 큰 표본까지 세고,
 * `astats` 의 `Peak count` 는 최대 «한쪽 극»만 센다(+32767 과 −32768 중 하나). 둘 다 못 쓴다.
 * 파일을 흘려 읽으며 직접 센다 — 48kHz 스테레오 5분이 57MB 라 0.1초 안에 끝난다.
 */
export async function countFullScaleSamples(
  wavAbs: string,
): Promise<{ full: number; total: number }> {
  const fh = await open(wavAbs, 'r');
  let dataOffset: number;
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(header, 0, header.length, 0);
    const chunk = findWavDataChunk(header.subarray(0, bytesRead));
    if (!chunk) throw new Error(`wav 의 data 청크를 찾지 못했습니다: ${wavAbs}`);
    dataOffset = chunk.offset;
  } finally {
    await fh.close();
  }

  let full = 0;
  let total = 0;
  let odd: number | null = null; // 청크 경계에 걸친 홀수 바이트
  for await (const c of createReadStream(wavAbs, { start: dataOffset })) {
    let buf = c as Buffer;
    if (odd !== null) {
      buf = Buffer.concat([Buffer.from([odd]), buf]);
      odd = null;
    }
    if (buf.length % 2 === 1) {
      odd = buf[buf.length - 1]!;
      buf = buf.subarray(0, buf.length - 1);
    }
    const r = countFullScaleInt16(buf);
    full += r.full;
    total += r.total;
  }
  return { full, total };
}

/** 영상 파일의 오디오를 wav 로 «복사»한다 (재인코딩 없음 — pcm-16 이 그대로 나온다). */
export async function extractPcmAudio(videoAbs: string, outWav: string): Promise<void> {
  await runFfmpegStderr(['-v', 'error', '-y', '-i', videoAbs, '-vn', '-c:a', 'copy', outWav]);
}

/**
 * `전체 − 트리거` — 위상 반전 + `amix`.
 *
 * `dither_method 0` 으로 디더를 끈다. 실측상 디더를 켜도(triangular 강제 포함) 결과가 같았지만,
 * **비트 단위 동일성이 이 최적화의 전부**라 우연에 기대지 않는다.
 * `normalize=0` 이 없으면 amix 가 1/N 로 나눠 값이 반토막 난다.
 */
export const SUBTRACT_GRAPH =
  '[1:a]volume=-1[neg];[0:a][neg]amix=inputs=2:duration=longest:normalize=0[out]';

export async function subtractStem(
  fullWav: string,
  triggerWav: string,
  outWav: string,
): Promise<void> {
  await runFfmpegStderr([
    '-v', 'error', '-y',
    '-dither_method', '0',
    '-i', fullWav, '-i', triggerWav,
    '-filter_complex', SUBTRACT_GRAPH,
    '-map', '[out]', '-c:a', 'pcm_s16le',
    outWav,
  ]);
}

/** 두 오디오의 «표본 정렬»이 맞는지 — 샘플레이트·채널·표본 수. 하나라도 다르면 뺄셈이 무의미하다. */
export type PcmShape = { sampleRate: number; channels: number; samples: number };

export async function pcmShape(absPath: string): Promise<PcmShape> {
  const res = await execa(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
     'stream=sample_rate,channels,duration_ts,nb_frames', '-of', 'json', absPath],
    { reject: false },
  );
  if (res.exitCode !== 0) throw new Error(`ffprobe 실패: ${String(res.stderr).slice(-400)}`);
  const s = (JSON.parse(String(res.stdout)) as { streams?: Record<string, unknown>[] }).streams?.[0];
  const n = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  return {
    sampleRate: n(s?.sample_rate),
    channels: n(s?.channels),
    samples: n(s?.duration_ts) || n(s?.nb_frames),
  };
}

export function pcmShapesMatch(a: PcmShape, b: PcmShape): boolean {
  return a.sampleRate === b.sampleRate && a.channels === b.channels && a.samples === b.samples;
}

// ── 비용 예상 (5초 1080×1920 실측을 길이로 선형 환산) ────────────────────

/**
 * 실측(2026-09-02, 이 컴퓨터, 1080×1920 5초): 영상+오디오 22.24초 · **오디오 스템 20.7~22.7초**
 * · 사이드체인 믹스 0.72초.
 *
 * ⚠️ 계획 12 는 스템을 12.71초로 적었다 — S5 재실측에서 20.7~22.7초가 나왔다. 낙관적인
 * 숫자를 UI 에 띄우면 「예상 48초」가 실제 65초가 된다. **실측값을 쓴다.**
 *
 * ⚠️ **절대 초는 프로젝트에 따라 3~5배까지 어긋난다.** 같은 코드로 10초 1080×1920 프로젝트
 * (h264 클립 1 + 오디오 2트랙)를 실제로 렌더한 결과: 보통 216.5초 · 사이드체인 405.5초.
 * 이 식은 44초·130초를 예측했다. **배수(1.87배)는 잘 맞는다** — UI 는 배수를 앞세우고
 * 초는 「어림」이라고 밝힌다. 정확한 예측은 프로젝트별 실측 캐시가 있어야 가능하다(F17 감).
 */
export const RENDER_SEC_PER_SEC = { video: 22.24 / 5, stem: 21 / 5, mix: 0.72 / 5 } as const;

/**
 * 사이드체인 렌더 예상 시간(초) — 잡 등록 응답에 담아 UI 가 미리 보여준다.
 *
 * `subtract` 면 스템이 한 장뿐이다(눌릴 스템을 「전체 − 트리거」로 얻는다):
 * 12.99 초/초 → 8.79 초/초, **32% 짧다**.
 */
export function estimateSidechainSeconds(
  durationMs: number,
  opts: { subtract?: boolean } = {},
): number {
  const sec = Math.max(0, durationMs) / 1000;
  const { video, stem, mix } = RENDER_SEC_PER_SEC;
  return Math.round(sec * (video + stem * (opts.subtract ? 1 : 2) + mix));
}

export function estimatePlainRenderSeconds(durationMs: number): number {
  return Math.round((Math.max(0, durationMs) / 1000) * RENDER_SEC_PER_SEC.video);
}

/** 단계 가중치 [트리거 스템, 눌릴 스템, 영상, 믹스] — 위 실측 비율 그대로. */
export const SIDECHAIN_STAGE_WEIGHTS: readonly number[] = [
  RENDER_SEC_PER_SEC.stem,
  RENDER_SEC_PER_SEC.stem,
  RENDER_SEC_PER_SEC.video,
  RENDER_SEC_PER_SEC.mix,
];

/**
 * 뺄셈 경로의 단계 가중치 [트리거 스템, 영상+전체오디오, 믹스] — 눌릴 스템 단계가 없다.
 *
 * 포화 폴백이 걸리면 눌릴 스템을 그때 굽는데, 그 진행률은 마지막(믹스) 단계로 흘려보낸다.
 * 흔한 쪽(폴백 없음)에 맞춘 가중치다 — 폴백은 막대가 끝에서 천천히 차는 정도로 어긋난다.
 */
export const SIDECHAIN_SUBTRACT_STAGE_WEIGHTS: readonly number[] = [
  RENDER_SEC_PER_SEC.stem,
  RENDER_SEC_PER_SEC.video,
  RENDER_SEC_PER_SEC.mix,
];

// ── ffmpeg 실행 ──────────────────────────────────────────────────────────

/** `-v info` 로 돌려 stderr 를 받는다 (volumedetect 는 stderr 에만 찍는다). */
async function runFfmpegStderr(args: string[], cwd?: string): Promise<string> {
  const res = await execa('ffmpeg', ['-hide_banner', '-nostats', ...args], {
    ...(cwd ? { cwd } : {}),
    reject: false,
  });
  if (res.exitCode !== 0) {
    throw new Error(`ffmpeg 실패 (exit ${res.exitCode}): ${String(res.stderr).slice(-800)}`);
  }
  return String(res.stderr);
}

export type LoudnessStats = { i: number; tp: number; lra: number };

/** 통합 라우드니스 측정 — loudnorm 의 stats_file 을 읽는다(stderr 파싱 불필요). */
export async function measureLoudness(absPath: string): Promise<LoudnessStats> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'kitkat-ln-'));
  try {
    await runFfmpegStderr(
      ['-v', 'error', '-y', '-i', absPath, '-af',
       `loudnorm=I=${DETECT_LUFS}:TP=-1.5:LRA=11:print_format=json:stats_file=ln.json`,
       '-f', 'null', '-'],
      tmp,
    );
    const raw = JSON.parse(await readFile(path.join(tmp, 'ln.json'), 'utf8')) as Record<string, string>;
    const n = (s: string | undefined): number => {
      const v = Number(s);
      return Number.isFinite(v) ? v : -Infinity;
    };
    return { i: n(raw.input_i), tp: n(raw.input_tp), lra: n(raw.input_lra) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** `aselect` 표현식 — 구간이 없으면 전체(1). ffmpeg 파서용으로 홑따옴표로 감싼다. */
export function selectExpr(intervals: readonly DuckInterval[]): string {
  if (intervals.length === 0) return '1';
  const terms = intervals.map(
    (iv) => `between(t\\,${(iv.start / 1000).toFixed(3)}\\,${(iv.end / 1000).toFixed(3)})`,
  );
  return terms.join('+');
}

const MEAN_RE = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/;
const MAX_RE = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/;

/** 지정한 구간들만 골라 mean/max dB 를 잰다 (volumedetect). 구간이 비면 파일 전체. */
export async function measureVolume(
  absPath: string,
  intervals: readonly DuckInterval[],
): Promise<{ mean: number; max: number }> {
  const af = `aselect='${selectExpr(intervals)}',volumedetect`;
  const stderr = await runFfmpegStderr(['-v', 'info', '-i', absPath, '-af', af, '-f', 'null', '-']);
  const mean = MEAN_RE.exec(stderr);
  const max = MAX_RE.exec(stderr);
  if (!mean || !max) {
    throw new Error(`볼륨 측정 결과를 읽지 못했습니다: ${stderr.slice(-400)}`);
  }
  return { mean: Number(mean[1]), max: Number(max[1]) };
}

/** 필터그래프를 돌린 «출력만» 측정한다 (믹스 파일을 만들지 않고 감쇠량만 잰다). */
export async function measureGraphVolume(
  inputs: readonly string[],
  graph: string,
  intervals: readonly DuckInterval[],
): Promise<{ mean: number; max: number }> {
  const args = ['-v', 'info'];
  for (const i of inputs) args.push('-i', i);
  args.push(
    '-filter_complex', `${graph};[out]aselect='${selectExpr(intervals)}',volumedetect[m]`,
    '-map', '[m]', '-f', 'null', '-',
  );
  const stderr = await runFfmpegStderr(args);
  const mean = MEAN_RE.exec(stderr);
  const max = MAX_RE.exec(stderr);
  if (!mean || !max) throw new Error(`감쇠 측정 실패: ${stderr.slice(-400)}`);
  return { mean: Number(mean[1]), max: Number(max[1]) };
}

/** 4단계 — 영상은 `-c:v copy`(재인코딩 없음)라 1초도 안 걸린다. */
export async function muxSidechain(
  videoAbs: string,
  duckedWav: string,
  triggerWav: string,
  outAbs: string,
  o: SidechainGraphOpts,
): Promise<void> {
  await runFfmpegStderr([
    '-v', 'error', '-y',
    '-i', videoAbs, '-i', duckedWav, '-i', triggerWav,
    '-filter_complex', sidechainGraph(o),
    '-map', '0:v', '-map', '[out]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    outAbs,
  ]);
}

export async function hasAudioStream(absPath: string): Promise<boolean> {
  const res = await execa(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', absPath],
    { reject: false },
  );
  return res.exitCode === 0 && String(res.stdout).trim() !== '';
}

// ── 목소리 구간 (측정용) ─────────────────────────────────────────────────

/**
 * 트리거 트랙의 파형 포락선을 읽어 실제 «말하는» 구간을 구한다.
 * 옛 형식(1000버킷 배열) 파형은 버킷 시간을 알 수 없어 쓰지 않는다 — 그 클립은
 * `voiceIntervalsFromEnvelope` 안에서 클립 전체로 물러선다.
 */
export async function triggerVoiceIntervals(
  doc: ProjectDoc,
  mediaDir: string,
  triggerTrackId: string,
): Promise<DuckInterval[]> {
  const track = doc.tracks.find((t) => t.id === triggerTrackId);
  if (!track) return [];
  const clips = track.clips.filter(
    (c): c is Extract<typeof c, { kind: 'audio' | 'video' }> => c.kind === 'audio' || c.kind === 'video',
  );
  const envelopes: Record<string, VoiceEnvelope> = {};
  for (const clip of clips) {
    const asset = doc.assets[clip.assetId];
    if (!asset?.waveformSrc || envelopes[clip.assetId]) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(mediaDir, asset.waveformSrc), 'utf8')) as unknown;
      if (Array.isArray(raw)) continue; // 옛 형식 — 다시 구워야 한다
      const w = raw as { bucketMs?: number; rms?: number[] };
      if (typeof w.bucketMs === 'number' && Array.isArray(w.rms)) {
        envelopes[clip.assetId] = { bucketMs: w.bucketMs, rms: w.rms };
      }
    } catch {
      // 파형 파일이 없거나 깨졌다 — 클립 전체로 물러선다(구간이 없으면 측정을 못 한다)
    }
  }
  return voiceIntervalsFromEnvelope(clips, envelopes);
}
