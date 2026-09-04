import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectEncoder,
  ffprobeJson,
  runFfmpeg,
  runFfmpegProgress,
  PROXY_GOP,
  PROXY_TAG,
  videoEncoderArgs,
  type EncoderName,
} from './ffmpeg.js';

/**
 * 비디오 인코딩 패스 실행 — 하드웨어 인코더가 실패하면 libx264 로 한 번 재시도한다.
 *
 * 이 머신의 h264_qsv 는 vidstabtransform 출력을 받으면 액세스 위반(0xC0000005)으로
 * ffmpeg 프로세스째 죽는다. detectEncoder 의 1프레임 시험 인코딩은 이런 필터 조합별
 * 크래시를 잡아내지 못하므로, 인코딩 지점마다 소프트웨어 인코더로 물러설 길을 둔다.
 */
async function runEncodePass(
  buildArgs: (encoderArgs: string[]) => string[],
  enc: EncoderName,
  crf: number,
  durationMs: number | undefined,
  onProgress?: (p: number) => void,
  opts?: { cwd?: string; signal?: AbortSignal },
): Promise<void> {
  try {
    await runFfmpegProgress(buildArgs(videoEncoderArgs(enc, crf)), durationMs, onProgress, opts);
  } catch (err) {
    if (enc === 'libx264') throw err;
    try {
      await runFfmpegProgress(
        buildArgs(videoEncoderArgs('libx264', crf)),
        durationMs,
        onProgress,
        opts,
      );
    } catch (fallbackErr) {
      // 두 인코더 모두 실패 — 폴백 메시지만 남기면 진짜 원인(입력 오류·디스크 부족 등)이 가려진다
      const first = err instanceof Error ? err.message : String(err);
      const second = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`인코딩 실패 — ${enc}: ${first} / libx264: ${second}`);
    }
  }
}

// ── W8 S3 스펙 타입 ──────────────────────────────────────────────────────
// schema 의 ClipSource 와 같은 모양이지만 media 는 @kitkat/schema 에 의존하지 않는다
// (에셋 id → 절대경로 변환은 서버가 한다: lut.assetId → cubeAbs, voice.reverb.irId → irAbs).

export type ChannelStat = { mean: number; std: number };  // 0..1 정규화
export type MatchLevels = {
  sampledAtMs: number[];
  refSourceKey: string;
  ref: [ChannelStat, ChannelStat, ChannelStat];      // r, g, b
  target: [ChannelStat, ChannelStat, ChannelStat];
};
export type HslFamily =
  | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'
  | 'whites' | 'neutrals' | 'blacks';
export type HslSecondary = {
  id: string; family: HslFamily;
  cyan: number; magenta: number; yellow: number; black: number;   // -1..1
};
export type HueSatBand = {
  id: string;
  bands: ('r' | 'y' | 'g' | 'c' | 'b' | 'm')[];
  hue: number; saturation: number; intensity: number;
  preserveLightness?: boolean;
};
export type MotionBlurSpec = { shutterAngle: number; quality: 'fast' | 'precise' };
export type VoicePresetId = 'broadcast' | 'warm' | 'bright' | 'podcast';
export type VoiceDeriveSpec = {
  preset: VoicePresetId;
  reverb?: { irAbs: string; wet: number };         // wet 0..1
};

/** 음량 맞춤. voice 와 «독립» 이다 — 목소리 프리셋 없이도 걸 수 있어야 한다. */
export type LoudnessDeriveSpec = { targetLufs: number };

export type DeriveSpec = {
  lut?: { cubeAbs: string; intensity: number };
  stabilize?: { smoothing: number };
  denoise?: { amount: number };
  pitch?: { semitones: number };
  // W8 S3 — 아래 순서가 곧 필터 순서다 (deriveMedia 주석 참조)
  matchTo?: { levels: MatchLevels; strength: number };
  hueSat?: HueSatBand[];
  hsl?: HslSecondary[];
  motionBlur?: MotionBlurSpec;
  voice?: VoiceDeriveSpec;
  loudness?: LoudnessDeriveSpec;   // 2패스 loudnorm. voice 뒤에 붙는다(체인 순서 맨 끝)
};

/** 2패스 loudnorm 이 stats_file 로 남기는 JSON (문자열 필드들 — ffmpeg 이 따옴표로 낸다). */
export type LoudnormStats = {
  input_i: string; input_tp: string; input_lra: string; input_thresh: string;
  output_i: string; output_tp: string; output_lra: string; output_thresh: string;
  normalization_type: 'linear' | 'dynamic';
  target_offset: string;
};

type SrcInfo = { durationMs: number | undefined; hasAudio: boolean; fps: { num: number; den: number } };

/** "30000/1001" 같은 유리수 프레임레이트. 못 읽으면 30/1. */
function parseRate(s: string | undefined): { num: number; den: number } {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '');
  if (!m) return { num: 30, den: 1 };
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return { num: 30, den: 1 };
  return { num, den };
}

async function probeSrc(absSrc: string): Promise<SrcInfo> {
  const info = await ffprobeJson(absSrc);
  const durationSec = Number(info.format?.duration ?? NaN);
  const video = (info.streams ?? []).find((s) => s.codec_type === 'video');
  return {
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : undefined,
    hasAudio: (info.streams ?? []).some((s) => s.codec_type === 'audio'),
    fps: parseRate(video?.r_frame_rate ?? video?.avg_frame_rate),
  };
}

/** 필터 인자용 숫자 — 지수표기(1e-7)는 ffmpeg 파서가 못 읽으므로 고정소수로 낸다. */
function num(n: number): string {
  return (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '') || '0';
}

// ── (2) matchTo → colorlevels ────────────────────────────────────────────

const CH = ['r', 'g', 'b'] as const;
const clip01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 채널별 아핀 사상 out = a·in + b (강도 s 적용 후). */
function affine(levels: MatchLevels, s: number, i: number): { a: number; b: number } {
  const ref = levels.ref[i]!;
  const tgt = levels.target[i]!;
  // σ_target 이 0 이면(단색 프레임) 대비 배율이 무한대가 된다 — 평균만 옮긴다.
  const a0 = tgt.std > 1e-6 ? ref.std / tgt.std : 1;
  const b0 = ref.mean - a0 * tgt.mean;
  // 아핀 사상이라 «사상을 보간» 과 «결과를 보간» 이 정확히 같다 → s=0.5 는 진짜 절반이다.
  return { a: 1 + (a0 - 1) * s, b: b0 * s };
}

type LevelArgs = { imin: number; imax: number; omin: number; omax: number };

/**
 * a·in+b 를 colorlevels 파라미터로 역산한다.
 *
 * ⚠️ **음수 imin/imax 를 내면 안 된다 (2026-09-02 실측으로 바로잡음).**
 * `ffmpeg -h filter=colorlevels` 는 범위를 -1..1 로 적지만, 실제 구현
 * (libavfilter/vf_colorlevels.c)은 음수를 «범위» 가 아니라 **자동 검출 신호**로 읽는다:
 * ```c
 * int imin = lrint(r->in_min * UINT8_MAX);
 * if (imin < 0) { imin = 프레임 전체를 훑어 찾은 최솟값; }   // imax 도 같다
 * ```
 * 그래서 옛 역산(`imin = -b/a`)은 **밝히는 보정(b>0)마다** 필터를 자동 검출로 떨어뜨렸다.
 * 실측: 0..255 램프에 `imin=-0.2` 를 걸면 출력이 의도한 사상과 **최대 39/255** 어긋난다.
 * (그 상태로 컷 맞추기를 돌리면 색차 감소가 94% → 57% 로 주저앉는다 — 실측.)
 *
 * 고친 역산은 두 갈래다. 어느 쪽이든 직선의 기울기는 정확히 a, 절편은 정확히 b 로 남고
 * imin·imax 가 절대 음수가 되지 않는다:
 * ```
 *   b ≥ 0 (밝히기)  : imin = 0      omin = b   imax = min(1,(1-b)/a)  omax = a·imax+b
 *   b < 0 (어둡히기): imin = -b/a   omin = 0   imax = min(1,(1-b)/a)  omax = a·imax+b
 * ```
 * 필터는 이 네 점으로 직선 하나를 세우고 0..255 로 클리핑할 뿐이라, 클리핑 지점도 원하는
 * 사상과 같아진다. 남는 오차는 ffmpeg 이 파라미터를 8비트로 반올림하는 데서 오는
 * **최대 1.8/255** 뿐이다(실측, a=2.2 같은 급한 기울기에서). 그건 필터의 한계지 사상의 오차가
 * 아니므로 아래 `levelsMaxError` 는 연속 사상으로만 검산한다.
 */
function solveLevels(a: number, b: number): LevelArgs | null {
  if (!(a > 1e-9)) return null;
  const imin = b >= 0 ? 0 : -b / a;
  const imax = Math.min(1, (1 - b) / a);
  if (imin < 0 || imin > 1 || imax - imin < 1e-6) return null;
  return { imin, imax, omin: clip01(a * imin + b), omax: clip01(a * imax + b) };
}

/** 필터가 실제로 낼 값 — 반드시 «문자열로 나갈 반올림된 값» 으로 검산한다. */
function applyLevels(p: LevelArgs, x: number): number {
  return clip01(((x - p.imin) * (p.omax - p.omin)) / (p.imax - p.imin) + p.omin);
}

/** 입력 0..255 전부를 넣어 원하는 사상과 비교한 최대 오차. 1/255 초과면 표현 불가. */
function levelsMaxError(a: number, b: number, p: LevelArgs): number {
  let worst = 0;
  for (let x = 0; x <= 255; x++) {
    const inV = x / 255;
    const err = Math.abs(applyLevels(p, inV) - clip01(a * inV + b));
    if (err > worst) worst = err;
  }
  return worst;
}

const LEVELS_TOL = 1 / 255;

function levelsAt(levels: MatchLevels, s: number): LevelArgs[] | null {
  const out: LevelArgs[] = [];
  for (let i = 0; i < 3; i++) {
    const { a, b } = affine(levels, s, i);
    const p = solveLevels(a, b);
    if (!p) return null;
    // 문자열로 나갈 값 그대로 검산 (반올림 오차까지 포함해서 봐야 «실제로» 맞는다)
    const rounded: LevelArgs = {
      imin: Number(num(p.imin)), imax: Number(num(p.imax)),
      omin: Number(num(p.omin)), omax: Number(num(p.omax)),
    };
    if (rounded.imax - rounded.imin < 1e-6) return null;
    if (levelsMaxError(a, b, rounded) > LEVELS_TOL) return null;
    out.push(rounded);
  }
  return out;
}

/**
 * μ·σ 이동 → colorlevels 인자 문자열.
 *
 * **표현 불가면 조용히 클램프하지 않고 throw 한다** — 「대충 비슷하게」 구운 파일은
 * 사용자가 왜 안 맞는지 알 수 없다. 대신 표현 가능한 최대 강도를 이분 탐색으로 찾아 알려준다
 * (s→0 이면 a→1 이라 반드시 표현 가능한 s 가 존재한다).
 *
 * ⚠️ **계획 04 의 「a = σ_ref/σ_target 이 0.5 미만이면 표현 불가」는 사실이 아니다.**
 * imin/imax 를 -1..1 로 클램프한 «뒤» o 값을 다시 풀면 기울기가 그대로 a 로 남는다
 * (a·imin+b = 0, a·imax+b = 1 이 정의라서 클램프해도 clip01 이 물지 않는다).
 * μ 가 0..1 이라는 제약 때문에 b ≥ −a · b ≤ 1+a 가 항상 성립해 구간이 안 뭉개진다.
 * 4,900 조합 격자 검산(μ 7 × σ 5 × 양쪽 × 강도 4) 결과 **던진 것은 25개뿐**이고 전부
 * μ_ref=0(완전 검정 기준) & μ_tgt=1(완전 흰 대상) 이라는 퇴화 코너였다.
 * a=0.3 짜리는 전부 «정확히» 표현된다. 그래도 가드는 남긴다 — 퇴화 입력은 실제로 있다.
 *
 * `preserve=none`(기본)을 쓴다 — `preserve=lum` 은 밝기를 보존하는데 컷 맞추기는
 * 밝기까지 맞추는 게 목적이다.
 */
export function matchColorLevels(levels: MatchLevels, strength: number): string {
  const s = clip01(strength);
  const solved = levelsAt(levels, s);
  if (!solved) {
    let lo = 0;
    let hi = s;
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      if (levelsAt(levels, mid)) lo = mid;
      else hi = mid;
    }
    const pct = Math.floor(lo * 100);
    throw new Error(
      `색 맞추기를 colorlevels 로 표현할 수 없습니다 (대상 컷의 대비가 기준보다 너무 큽니다). ` +
        `강도를 ${pct}% 이하로 낮추면 표현됩니다.`,
    );
  }
  const parts = solved.flatMap((p, i) => {
    const c = CH[i]!;
    return [
      `${c}imin=${num(p.imin)}`, `${c}imax=${num(p.imax)}`,
      `${c}omin=${num(p.omin)}`, `${c}omax=${num(p.omax)}`,
    ];
  });
  return `colorlevels=${parts.join(':')}:preserve=none`;
}

// ── (3) hueSat → huesaturation / (4) hsl → selectivecolor ────────────────

function hueSatFilters(bands: HueSatBand[]): string[] {
  return bands.map(
    (b) =>
      `huesaturation=colors=${b.bands.join('+')}:hue=${num(b.hue)}` +
      `:saturation=${num(b.saturation)}:intensity=${num(b.intensity)}` +
      `:strength=1:lightness=${b.preserveLightness === true ? 1 : 0}`,
  );
}

/**
 * selectivecolor 는 계열마다 인자가 «하나» 뿐이라 같은 family 가 둘이면 뒤엣것이 앞엣것을
 * 덮어쓴다. 여기서도 배열 순서대로 마지막 값을 쓴다(ffmpeg 과 같은 동작). 중복 자체는
 * 엔진이 BAD_HSL 로 막는다.
 *
 * `correction_method=absolute`(기본) — relative 는 이미 있는 잉크량에 비례해 적용되어
 * 같은 값이라도 소스마다 결과가 달라진다. 프리셋 값이 소스와 무관한 뜻을 가지려면 absolute 여야 한다.
 */
function hslFilter(list: HslSecondary[]): string {
  const byFamily = new Map<string, string>();
  for (const h of list) {
    byFamily.set(h.family, `${num(h.cyan)} ${num(h.magenta)} ${num(h.yellow)} ${num(h.black)}`);
  }
  const args = [...byFamily].map(([f, v]) => `${f}=${v}`);
  return `selectivecolor=correction_method=absolute:${args.join(':')}`;
}

// ── (6) motionBlur → minterpolate / tmix ─────────────────────────────────

/** precise 가 소스를 몇 배로 올려 찍는가 (셔터 구간을 8등분해 섞는다). */
const PRECISE_SUBFRAMES = 8;

/** 셔터 각도 → 섞을 프레임 수. 2 미만이면 섞을 게 없다(= 블러 없음). */
function blurFrames(mb: MotionBlurSpec): number {
  return mb.quality === 'precise'
    ? Math.round((PRECISE_SUBFRAMES * mb.shutterAngle) / 360)
    : Math.round((3 * mb.shutterAngle) / 180);
}

function motionBlurFilters(mb: MotionBlurSpec, fps: { num: number; den: number }): string[] {
  const frames = blurFrames(mb);
  if (frames < 2) return [];   // shutterAngle 0 근처 — 필터를 걸어도 항등이다
  if (mb.quality === 'fast') return [`tmix=frames=${frames}`];
  // 8배로 보간해 «진짜 셔터» 를 만들고, 섞은 뒤 원래 프레임레이트로 되돌린다.
  return [
    `minterpolate=fps=${fps.num * PRECISE_SUBFRAMES}/${fps.den}:mi_mode=mci:mc_mode=aobmc`,
    `tmix=frames=${frames}`,
    `fps=${fps.num}/${fps.den}`,
  ];
}

/**
 * 모션 블러 예상 소요 시간(초). 계획 03 의 1080×1920 실측(precise 77초/초, fast 0.8초/초)을
 * 픽셀 수로 선형 환산한다. **느리다고 fast 로 바꾸지 않는다 — 시간을 알려주고 사용자가 고른다.**
 */
export const MOTION_BLUR_SEC_PER_SEC = { precise: 77, fast: 0.8 } as const;
const REF_PIXELS = 1080 * 1920;

export function estimateMotionBlurSeconds(
  mb: MotionBlurSpec,
  info: { durationMs?: number; width?: number; height?: number },
): number {
  if (blurFrames(mb) < 2) return 0;
  const sec = (info.durationMs ?? 0) / 1000;
  const px = (info.width ?? 1080) * (info.height ?? 1920);
  return Math.round(sec * MOTION_BLUR_SEC_PER_SEC[mb.quality] * (px / REF_PIXELS));
}

// ── (7) 오디오: 나레이션 체인 + 2패스 loudnorm ───────────────────────────

type VoiceParams = {
  highpass: number;
  deesserI: number; deesserM: number;
  eq200: number; eq400: number; eq3500: number; eq10k: number;
  threshold: number; ratio: number; attack: number; release: number;
  lra: number;
};

/**
 * 프리셋 4종 (계획 11 의 표 그대로).
 * threshold 는 dB 가 아니라 선형값 — 0.0891 = 10^(-21/20), 0.0631 = 10^(-24/20).
 * makeup 2 는 «2배(+6dB)» 다 (acompressor 의 makeup 범위는 1..64, 1이 무보정).
 */
const VOICE_PRESETS: Record<VoicePresetId, VoiceParams> = {
  broadcast: { highpass: 80, deesserI: 0.35, deesserM: 0.5, eq200: -3, eq400: -2, eq3500: 3, eq10k: 2, threshold: 0.0891, ratio: 3, attack: 5, release: 120, lra: 11 },
  warm:      { highpass: 100, deesserI: 0.3, deesserM: 0.5, eq200: 1.5, eq400: -1, eq3500: 1.5, eq10k: 0, threshold: 0.0891, ratio: 2.5, attack: 10, release: 200, lra: 11 },
  bright:    { highpass: 90, deesserI: 0.45, deesserM: 0.6, eq200: -4, eq400: -3, eq3500: 4.5, eq10k: 3.5, threshold: 0.0891, ratio: 3, attack: 3, release: 100, lra: 11 },
  podcast:   { highpass: 75, deesserI: 0.35, deesserM: 0.5, eq200: -2, eq400: -2, eq3500: 3, eq10k: 1.5, threshold: 0.0631, ratio: 4, attack: 5, release: 150, lra: 7 },
};

export const VOICE_TRUE_PEAK_DB = -1.0;

/**
 * 음악용 LRA(허용 음량 폭). **loudnorm 은 원본의 폭이 LRA 보다 넓으면 혼자 「동적 모드」로
 * 바꿔** 곡 안의 여린 데를 올리고 센 데를 눌러 평평하게 만든다. 목소리 프리셋 값(11·7)을
 * 음악에 그대로 주면 그 일이 벌어진다. 20 이면 대부분의 곡이 「상수 게인 1번」(linear)에
 * 머물러 음량만 바뀌고 셈여림은 그대로다.
 */
export const MUSIC_LRA = 20;

/**
 * 어떤 LRA 로 맞출 것인가. **사용자 노브로 열지 않는다** — 틀리게 만지면 곡이 평평해지는데
 * 화면에는 「음량을 맞췄다」고만 보여서 원인을 못 찾는다.
 * voice 체인에는 acompressor 가 들어 있어 이미 폭이 좁혀졌으므로 프리셋 값이 맞고,
 * voice 가 없으면 아무것도 안 좁혔으니 넉넉히 준다.
 */
export function loudnessLra(spec: DeriveSpec): number {
  return spec.voice ? voiceLra(spec.voice.preset) : MUSIC_LRA;
}

/**
 * loudnorm 앞까지의 나레이션 체인 (highpass → deesser → EQ 4단 → comp → limiter).
 *
 * - **디에서가 컴프 «앞»** 이다. 뒤에 두면 치찰음의 순간 피크에 컴프가 반응해 문장 전체를
 *   헛되이 눌렀다 놓는다(펌핑).
 * - **`alimiter` 는 `level=false` 가 필수다.** 기본값 `level=true` 는 리미터에 닿지도 않은
 *   신호까지 +1.0dB 끌어올린다(2026-09-02 이 빌드 실측: -38dB 사인의 max -56.0 → -55.0).
 *   게인 조정은 loudnorm 이 할 일이다.
 * - `latency=true` 로 룩어헤드 지연을 보정해 파생 파일 길이가 소스와 어긋나지 않게 한다.
 * - 10kHz 는 **`highshelf`** 다. 계획 11 이 적은 `equalizer=f=10000:t=h:w=0.7` 은
 *   «0.7 **Hz** 폭의 벨» 이라 실측 변화량이 0.0dB 인 무동작 필터였다(9kHz 이상 대역
 *   -20.9dB → -20.9dB). `highshelf=f=10000:t=q:w=0.7` 은 같은 조건에서 +1.8dB 로,
 *   계획이 말한 「공기감(하이셸프)」과 일치한다.
 */
export function voiceChain(preset: VoicePresetId): string {
  const p = VOICE_PRESETS[preset];
  return [
    `highpass=f=${p.highpass}`,
    `deesser=i=${num(p.deesserI)}:m=${num(p.deesserM)}:f=0.5`,
    `equalizer=f=200:t=q:w=1.0:g=${num(p.eq200)}`,
    `equalizer=f=400:t=q:w=1.5:g=${num(p.eq400)}`,
    `equalizer=f=3500:t=q:w=1.2:g=${num(p.eq3500)}`,
    `highshelf=f=10000:t=q:w=0.7:g=${num(p.eq10k)}`,
    `acompressor=threshold=${num(p.threshold)}:ratio=${num(p.ratio)}:attack=${num(p.attack)}` +
      `:release=${num(p.release)}:makeup=2:knee=6:detection=rms`,
    `alimiter=limit=0.891:attack=5:release=50:level=false:latency=true`,
  ].join(',');
}

export function voiceLra(preset: VoicePresetId): number {
  return VOICE_PRESETS[preset].lra;
}

/** 1패스: 체인 «적용 후» 의 라우드니스를 잰다 (컴프·리미터가 라우드니스를 바꾸므로). */
function loudnormMeasure(targetLufs: number, lra: number, statsName: string): string {
  return (
    `loudnorm=I=${num(targetLufs)}:TP=${num(VOICE_TRUE_PEAK_DB)}:LRA=${lra}` +
    `:print_format=json:stats_file=${statsName}`
  );
}

/**
 * 1패스 측정값이 2패스에 쓸 수 있는 값인가.
 *
 * **거의 무음인 소스는 `input_i` 가 `-inf` 로 나온다.** 그걸 그대로 `measured_I` 에 넣으면
 * ffmpeg 이 `Error applying option 'measured_I' to filter 'loudnorm': Result too large` 로 죽는다
 * (F11 담당 실측). 그런 소스는 애초에 라우드니스를 맞출 대상이 아니므로 **1패스로 물러선다** —
 * 조용히 무음을 증폭하지 않는다.
 */
export function loudnormStatsUsable(m: LoudnormStats): boolean {
  const nums = [m.input_i, m.input_lra, m.input_tp, m.input_thresh, m.target_offset];
  return nums.every((v) => Number.isFinite(Number(v)));
}

/** 2패스: 1패스가 잰 값을 measured_* 로 넣는다. 출력 stats 도 남겨 normalization_type 을 읽는다. */
function loudnormApply(targetLufs: number, lra: number, m: LoudnormStats, statsName: string): string {
  return (
    `loudnorm=I=${num(targetLufs)}:TP=${num(VOICE_TRUE_PEAK_DB)}:LRA=${lra}` +
    `:measured_I=${m.input_i}:measured_LRA=${m.input_lra}:measured_TP=${m.input_tp}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}` +
    `:print_format=json:stats_file=${statsName}`
  );
}

async function readLoudnormStats(abs: string): Promise<LoudnormStats> {
  const raw = await readFile(abs, 'utf8');
  return JSON.parse(raw) as LoudnormStats;
}

/** 이 파일 기준 저장소 루트 (src/ 든 dist/ 든 3단계 위) — ncnn.ts 와 같은 규칙. */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * 번들 IR 의 절대경로. `scripts/prewarm.mjs voice-ir` 이 vendor/ir/ 에 푼다.
 *
 * ⚠️ 번들 IR 은 Voxengo IM Reverbs 다 — "royalty-free for any purpose, including commercial
 * usage" 이지만 **파일 자체를 팔거나 배포로 수익을 내는 것은 금지**다.
 * kitkat 을 «판매» 할 계획이 생기면 라이선스를 다시 확인해야 한다.
 */
export function voiceIrPath(irId: string): string {
  return path.join(repoRoot(), 'vendor', 'ir', ...irId.split('/')) + '.wav';
}

/**
 * afftdn(잡음) → 나레이션 체인 → rubberband(피치).
 * loudnorm 과 리버브는 2패스·2입력이라 여기 안 들어간다(deriveMedia 가 붙인다).
 * 순서는 S3 계약: denoise → deesser → EQ → comp → limiter → pitch → loudnorm.
 */
export function audioFilterChain(spec: DeriveSpec): string | null {
  const parts: string[] = [];
  if (spec.denoise) {
    // afftdn nr 허용 범위는 0.01 이상 — amount 0 도 유효한 스펙이므로 하한으로 클램프
    const nr = Math.max(0.01, spec.denoise.amount * 40);
    parts.push(`afftdn=nr=${nr.toFixed(2)}:nf=-25`);
  }
  if (spec.voice) parts.push(voiceChain(spec.voice.preset));
  if (spec.pitch) {
    parts.push(`rubberband=pitch=${Math.pow(2, spec.pitch.semitones / 12).toFixed(6)}`);
  }
  return parts.length > 0 ? parts.join(',') : null;
}

// ── 필터 그래프 조립 ─────────────────────────────────────────────────────

/**
 * S3 가 고정한 비디오 필터 순서 중 **LUT 앞**에 오는 것들.
 *
 * 순서에 근거가 있다: 색 맞추기(matchTo)는 「기준에 맞추는 보정」이고 LUT 은 「마무리 룩」이다.
 * **룩을 먼저 먹이면 그 위에서 맞추게 되어 룩이 어긋난다.**
 * hueSat(6구간 광범위 = primary)이 hsl(9계열 CMYK 미세조정 = secondary)보다 먼저인 것도
 * 같은 이유다 — 반대로 하면 미세 조정한 결과를 광범위 조작이 다시 밀어버린다.
 */
function preLutFilters(spec: DeriveSpec): string[] {
  const out: string[] = [];
  if (spec.matchTo) out.push(matchColorLevels(spec.matchTo.levels, spec.matchTo.strength));
  if (spec.hueSat && spec.hueSat.length > 0) out.push(...hueSatFilters(spec.hueSat));
  if (spec.hsl && spec.hsl.length > 0) out.push(hslFilter(spec.hsl));
  return out;
}

/** LUT 뒤 — 모션 블러는 최종 룩이 정해진 화면을 섞어야 한다. */
function postLutFilters(spec: DeriveSpec, fps: { num: number; den: number }): string[] {
  return spec.motionBlur ? motionBlurFilters(spec.motionBlur, fps) : [];
}

/**
 * S3 가 고정한 비디오 필터 순서 전체 (matchTo → hueSat → hsl → lut → motionBlur).
 * deriveMedia 의 단순 경로가 이것을 그대로 쓰고, 테스트가 «순서 계약» 을 직접 본다.
 * LUT 부분강도(intensity<1)는 split/blend 가 필요해 filter_complex 로 따로 조립한다.
 */
export function videoFilterChain(
  spec: DeriveSpec,
  fps: { num: number; den: number } = { num: 30, den: 1 },
  lutFile = 'lut.cube',
): string[] {
  return [
    ...preLutFilters(spec),
    ...(spec.lut ? [`lut3d=file=${lutFile}`] : []),
    ...postLutFilters(spec, fps),
  ];
}

/** [in]f1,f2[out] — 필터가 없으면 null/anull 로 이어 그래프를 항상 유효하게 둔다. */
function link(inLabel: string, filters: string[], outLabel: string, audio = false): string {
  const body = filters.length > 0 ? filters.join(',') : audio ? 'anull' : 'null';
  return `[${inLabel}]${body}[${outLabel}]`;
}

// ── deriveMedia ──────────────────────────────────────────────────────────

/**
 * 파생 미디어 생성 → media/ 기준 상대경로(forward slash).
 * video: "derived/<assetId>.<key>.mp4" + 프록시 "derived/<assetId>.<key>.p.g15.mp4" (판 표시는 원본 프록시와 같은 규칙)
 * audio(audioOnly): "derived/<assetId>.<key>.m4a" (프록시 없음)
 *
 * **필터 순서 (S3 계약 — 이 순서가 곧 결과다):**
 * ```
 *   1) stabilize   vidstab 2패스 (별도 패스)
 *   2) matchTo     colorlevels        ← 기준에 맞추기가 먼저
 *   3) hueSat      huesaturation      ← primary (6구간 광범위)
 *   4) hsl         selectivecolor     ← secondary (9계열 CMYK)
 *   5) lut         lut3d              ← 마무리 룩
 *   6) motionBlur  tmix / minterpolate
 *   7) 오디오      denoise → deesser → EQ → comp → limiter → pitch → loudnorm(2패스)
 * ```
 * 2~6 은 **한 패스**에 들어간다 — 색보정을 늘려도 인코딩이 늘지 않는다.
 *
 * 2패스가 필요한 것이 둘이다(vidstab, loudnorm). 패스 수는 아래 `passPlan` 배열의 길이로
 * 계산한다 — 산술식에 하드코딩하지 않아서 패스가 또 늘어도 분모만 자동으로 따라온다.
 */
export async function deriveMedia(
  absSrc: string,
  mediaDir: string,
  assetId: string,
  key: string,
  spec: DeriveSpec,
  opts?: { audioOnly?: boolean; onProgress?: (p: number) => void; signal?: AbortSignal },
): Promise<{ src: string; proxySrc?: string; loudnorm?: LoudnormStats }> {
  const audioOnly = opts?.audioOnly === true;
  const info = await probeSrc(absSrc);

  const af = audioFilterChain(spec);
  const useLut = !audioOnly && spec.lut != null;
  const useStab = !audioOnly && spec.stabilize != null;
  const pre = audioOnly ? [] : preLutFilters(spec);
  const post = audioOnly ? [] : postLutFilters(spec, info.fps);
  // voice·loudness 둘 다 오디오가 있을 때만 의미가 있다 — 없으면 loudnorm 패스도 돌지 않는다
  const voice = info.hasAudio ? spec.voice : undefined;
  // 음량 맞춤은 voice 와 «독립» 이다. 목소리 프리셋 없이 음악에만 걸 수 있어야 한다.
  const loudness = info.hasAudio ? spec.loudness : undefined;
  const lra = loudnessLra(spec);
  // 오디오 없는 소스에 loudness 만 있으면 실제로 할 일이 없다 — 반드시 오디오로 게이트된
  // loudness 를 봐야 한다(spec.loudness 를 그대로 보면 무음 소스에서 뒤 단계가 통째로
  // 건너뛰어져 partOut 이 아예 안 만들어지고 ffmpeg 의 "No such file" 로 죽는다).
  if (!useLut && !useStab && af == null && pre.length === 0 && post.length === 0 && loudness == null) {
    throw new Error('빈 파생 스펙');
  }

  const enc = await detectEncoder();

  const rel = audioOnly ? `derived/${assetId}.${key}.m4a` : `derived/${assetId}.${key}.mp4`;
  const outAbs = path.join(mediaDir, 'derived', path.basename(rel));
  // 판 표시(.g15)는 원본 프록시와 같은 규칙 — isCurrentProxy 하나로 둘 다 판정한다 (리뷰 #3)
  const proxyRel = `derived/${assetId}.${key}.p.${PROXY_TAG}.mp4`;
  const proxyAbs = path.join(mediaDir, 'derived', path.basename(proxyRel));
  await mkdir(path.dirname(outAbs), { recursive: true });

  // 최종 경로에 바로 쓰면 뒷 패스(프록시)가 실패했을 때 아무도 참조하지 않는
  // 원본 크기 파일이 디스크에 남는다. .part 로 쓰고 전부 성공했을 때만 옮긴다.
  const partOut = `${outAbs}.part${audioOnly ? '.m4a' : '.mp4'}`;
  const partProxy = `${proxyAbs}.part.mp4`;
  let committed = false;

  // stabilize 단독(video)이면 vidstab 2패스째가 곧 최종 파일 — 불필요한 재인코딩 생략
  const needStageB = audioOnly || useLut || af != null || pre.length > 0 || post.length > 0 || loudness != null;

  // 가변 패스 수 — 배열에 넣은 만큼이 분모다
  const passPlan: string[] = [];
  if (useStab) passPlan.push('stabilize:detect', 'stabilize:apply');
  if (loudness) passPlan.push('loudnorm:measure');
  if (needStageB) passPlan.push('main');
  if (!audioOnly) passPlan.push('proxy');
  const passes = passPlan.length;

  let done = 0;
  const onProgress = opts?.onProgress;
  const passProgress = onProgress
    ? (p: number) => onProgress((done + Math.min(1, p)) / passes)
    : undefined;
  const endPass = () => {
    done++;
    onProgress?.(done / passes);
  };

  // trf·lut·loudnorm stats 를 짧은 상대 이름으로 두고 cwd 를 tmp 로 잡는다
  // (Windows 절대경로의 드라이브 콜론이 ffmpeg 필터 인자를 깨는 것 방지)
  const tmp = await mkdtemp(path.join(tmpdir(), 'kitkat-derive-'));
  try {
    let stageSrc = absSrc;
    if (useStab) {
      await runFfmpegProgress(
        ['-y', '-i', absSrc, '-vf', 'vidstabdetect=shakiness=5:result=tr.trf', '-f', 'null', '-'],
        info.durationMs, passProgress, { cwd: tmp },
      );
      endPass();
      const stabOut = needStageB ? path.join(tmp, 'stab.mp4') : partOut;
      await runEncodePass(
        (encoderArgs) => [
          '-y', '-i', absSrc,
          '-vf', `vidstabtransform=input=tr.trf:smoothing=${spec.stabilize!.smoothing},unsharp=5:5:0.8:3:3:0.4`,
          ...encoderArgs,
          ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
          stabOut,
        ],
        enc, 18, info.durationMs, passProgress, { cwd: tmp },
      );
      endPass();
      stageSrc = stabOut;
    }

    // ── 오디오 그래프 조립 (loudnorm 2패스 · 리버브) ──
    const useReverb = voice?.reverb != null;
    let measured: LoudnormStats | undefined;
    if (loudness) {
      // 1패스: «체인 적용 후» 를 잰다. 리버브도 라우드니스를 바꾸므로 리버브 뒤에서 잰다.
      const measureArgs = ['-y', '-i', stageSrc];
      if (useReverb) measureArgs.push('-i', voice!.reverb!.irAbs);
      if (useReverb) {
        measureArgs.push(
          '-filter_complex',
          [
            link('0:a', [...(af ? [af] : []), 'aformat=channel_layouts=stereo'], 'dry', true),
            `[dry][1:a]afir=dry=1:wet=${num(voice!.reverb!.wet)}:irfmt=input:gtype=peak[rv]`,
            link('rv', [loudnormMeasure(loudness.targetLufs, lra, 'ln1.json')], 'aout', true),
          ].join(';'),
          '-map', '[aout]',
        );
      } else {
        measureArgs.push('-vn', '-af',
          [...(af ? [af] : []), loudnormMeasure(loudness.targetLufs, lra, 'ln1.json')].join(','));
      }
      measureArgs.push('-f', 'null', '-');
      await runFfmpegProgress(measureArgs, info.durationMs, passProgress, { cwd: tmp });
      const raw = await readLoudnormStats(path.join(tmp, 'ln1.json'));
      // 거의 무음이면 input_i 가 -inf 로 나온다 → measured_* 에 넣으면 ffmpeg 이 죽는다.
      // 그런 소스는 맞출 라우드니스가 없으므로 1패스(측정 없는 loudnorm)로 물러선다.
      measured = loudnormStatsUsable(raw) ? raw : undefined;
      endPass();
    }

    /** 2패스 loudnorm 까지 붙인 오디오 필터 목록(체인 순서 그대로). */
    const audioParts = (): string[] => {
      const parts = af ? [af] : [];
      if (loudness && measured) parts.push(loudnormApply(loudness.targetLufs, lra, measured, 'ln2.json'));
      return parts;
    };
    // loudnorm 은 트루피크 검출을 위해 내부에서 192kHz 로 업샘플한다 — 출력 샘플레이트를
    // 안 적으면 그대로 192kHz 로 인코딩되어 파일이 커지고 일부 플레이어가 못 읽는다.
    const arArgs = loudness ? ['-ar', '48000'] : [];

    if (audioOnly) {
      const args = ['-y', '-i', stageSrc];
      if (useReverb) {
        args.push(
          '-i', voice!.reverb!.irAbs,
          '-filter_complex',
          [
            link('0:a', [...(af ? [af] : []), 'aformat=channel_layouts=stereo'], 'dry', true),
            `[dry][1:a]afir=dry=1:wet=${num(voice!.reverb!.wet)}:irfmt=input:gtype=peak[rv]`,
            link('rv', loudness && measured
              ? [loudnormApply(loudness.targetLufs, lra, measured, 'ln2.json')] : [], 'aout', true),
          ].join(';'),
          '-map', '[aout]',
        );
      } else {
        // loudness 만 있고(af==null) 1패스 측정이 무음이라 물러섰으면(measured==undefined)
        // audioParts() 가 빈 배열이다 — 그때 '-af' ''를 넘기면 ffmpeg 이 그 자리에서 죽는다.
        const parts = audioParts();
        args.push('-vn', ...(parts.length > 0 ? ['-af', parts.join(',')] : []));
      }
      args.push('-c:a', 'aac', '-b:a', '192k', ...arArgs, partOut);
      await runFfmpegProgress(args, info.durationMs, passProgress, { cwd: tmp });
      endPass();
      const stats = loudness ? await readLoudnormStats(path.join(tmp, 'ln2.json')).catch(() => undefined) : undefined;
      await rename(partOut, outAbs);
      committed = true;
      return { src: rel, ...(stats ? { loudnorm: stats } : {}) };
    }

    if (needStageB) {
      if (useLut) await copyFile(spec.lut!.cubeAbs, path.join(tmp, 'lut.cube'));
      const lutBlend = useLut && spec.lut!.intensity < 0.999;
      // af 가 없어도 loudnorm 만 붙는 경우가 있다(음악 음량 맞춤) — 목록이 비었는지로 판정한다
      const applyAudio = info.hasAudio && audioParts().length > 0;
      // 두 입력이 필요한 리버브, 그리고 split/blend 가 필요한 LUT 부분강도만 filter_complex 다.
      const needComplex = lutBlend || useReverb;

      await runEncodePass(
        (encoderArgs) => {
          const args = ['-y', '-i', stageSrc];
          if (useReverb) args.push('-i', voice!.reverb!.irAbs);

          if (needComplex) {
            const graphs: string[] = [];
            if (lutBlend) {
              graphs.push(link('0:v', pre, 'p'));
              graphs.push(
                `[p]split[a][b];[b]lut3d=file=lut.cube[l];` +
                  `[a][l]blend=all_mode=normal:all_opacity=${num(spec.lut!.intensity)}[bl]`,
              );
              graphs.push(link('bl', post, 'v'));
            } else {
              graphs.push(link('0:v', [...pre, ...(useLut ? ['lut3d=file=lut.cube'] : []), ...post], 'v'));
            }
            if (useReverb) {
              graphs.push(link('0:a', [...(af ? [af] : []), 'aformat=channel_layouts=stereo'], 'dry', true));
              graphs.push(
                `[dry][1:a]afir=dry=1:wet=${num(voice!.reverb!.wet)}:irfmt=input:gtype=peak[rv]`,
              );
              graphs.push(
                link('rv', loudness && measured
                  ? [loudnormApply(loudness.targetLufs, lra, measured, 'ln2.json')] : [], 'aout', true),
              );
            }
            args.push('-filter_complex', graphs.join(';'), '-map', '[v]');
            if (useReverb) args.push('-map', '[aout]');
            else args.push('-map', '0:a?');
          } else {
            const vf = videoFilterChain(spec, info.fps);
            if (vf.length > 0) args.push('-vf', vf.join(','));
            if (applyAudio) args.push('-af', audioParts().join(','));
          }

          args.push(...encoderArgs);
          args.push(...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k', ...arArgs] : ['-an']));
          args.push(partOut);
          return args;
        },
        enc, 18, info.durationMs, passProgress, { cwd: tmp },
      );
      endPass();
    }

    const stats = loudness
      ? await readLoudnormStats(path.join(tmp, 'ln2.json')).catch(() => undefined)
      : undefined;

    // 540p 프록시 (makeProxy 와 같은 형태 — 키프레임 간격까지 같아야 스크럽이 같다)
    await runEncodePass(
      (encoderArgs) => [
        '-y', '-i', partOut,
        '-vf', 'scale=-2:540',
        ...encoderArgs,
        '-g', String(PROXY_GOP),
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        partProxy,
      ],
      enc, 28, info.durationMs, passProgress,
    );
    endPass();
    await rename(partOut, outAbs);
    await rename(partProxy, proxyAbs);
    committed = true;
    return { src: rel, proxySrc: proxyRel, ...(stats ? { loudnorm: stats } : {}) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
    if (!committed) {
      // 실패했으면 반쯤 만든 파일을 남기지 않는다
      await rm(partOut, { force: true });
      await rm(partProxy, { force: true });
    }
  }
}

/** GIF → 알파 보존 webm (스티커용, vp9 yuva420p). */
export async function gifToWebm(absSrc: string, outAbs: string): Promise<void> {
  await mkdir(path.dirname(outAbs), { recursive: true });
  await runFfmpeg([
    '-y', '-i', absSrc,
    '-vf', 'format=rgba',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
    outAbs,
  ]);
}

/** 업스케일 2x/4x — lanczos + unsharp. */
export async function upscaleVideo(
  absSrc: string,
  outAbs: string,
  scale: 2 | 4,
  onProgress?: (p: number) => void,
): Promise<void> {
  await mkdir(path.dirname(outAbs), { recursive: true });
  const info = await probeSrc(absSrc);
  const enc = await detectEncoder();
  await runEncodePass(
    (encoderArgs) => [
      '-y', '-i', absSrc,
      '-vf', `scale=iw*${scale}:ih*${scale}:flags=lanczos,unsharp=5:5:0.6:5:5:0.0`,
      ...encoderArgs,
      ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      outAbs,
    ],
    enc, 18, info.durationMs, onProgress,
  );
}

/** 프레임 보간 — minterpolate(mci/aobmc/vsbmc). */
export async function interpolateFps(
  absSrc: string,
  outAbs: string,
  fps: number,
  onProgress?: (p: number) => void,
): Promise<void> {
  await mkdir(path.dirname(outAbs), { recursive: true });
  const info = await probeSrc(absSrc);
  const enc = await detectEncoder();
  await runEncodePass(
    (encoderArgs) => [
      '-y', '-i', absSrc,
      '-vf', `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`,
      ...encoderArgs,
      ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      outAbs,
    ],
    enc, 18, info.durationMs, onProgress,
  );
}
