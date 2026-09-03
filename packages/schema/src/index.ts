import { z } from 'zod';
// W8 F16 — 전환·효과 목록의 «단 하나의 원천». Zod 열거형도 여기서 만든다.
import { EFFECT_TYPES as EFFECT_TYPE_LIST, TRANSITION_TYPES as TRANSITION_TYPE_LIST } from './catalog.js';
import type { EffectType, TransitionType } from './catalog.js';
import { rampDurationMs } from './derive.js';
import { KEYFRAME_PATH_MAX, KEYFRAME_PATH_RE } from './keyframe-paths.js';
import type { Easing } from './easing.js';

export const SCHEMA_VERSION = 1;

// ── C1 타입 ───────────────────────────────────────────────────────────────

export type Background =
  | { kind: 'color'; color: string /* #rrggbb */ }
  | { kind: 'blur'; amount: number /* px 4..80 */ }     // 맨 아래 비디오/이미지 클립을 확대·블러해 여백 채움
  | { kind: 'image'; assetId: string };

export type ProjectDoc = {
  schemaVersion: 1;
  id: string;                    // nanoid
  name: string;
  revision: number;              // 명령 배치 적용마다 +1
  settings: { width: number; height: number; fps: number; background: Background;
              coverMs?: number /* 커버(대표 이미지) 프레임 시각 ms (W5) */ };
  assets: Record<string, Asset>;
  tracks: Track[];               // 배열 순서 = 아래(0) → 위 렌더 순서
};

export type Asset = {
  id: string;
  kind: 'video' | 'audio' | 'image' | 'lut';
  src: string;                   // media/ 기준 상대경로, forward slash 전용
  name: string;
  duration?: number;             // ms
  width?: number; height?: number;
  proxySrc?: string;             // "proxies/<id>.g15.mp4" (540p, 0.5초마다 키프레임). 판 표시가 붙기 전 파일은 "proxies/<id>.mp4"
  waveformSrc?: string;          // "waveforms/<id>.json"
  thumbSrc?: string;             // "thumbs/<id>.jpg" (video/image 대표 썸네일 1장)
  reversedSrc?: string;          // "derived/<id>.rev.mp4"
  derived?: Record<string, DerivedMedia>;  // sourceKey → 파생 파일 (W5 M2)
  beats?: number[];              // 비트 감지 결과, ms 오름차순 정수 (W5 M4)
};

export type Track = {
  id: string;
  kind: 'video' | 'audio' | 'text' | 'overlay';
  name: string;
  volume?: number;               // 0..2 기본 1 — 트랙 전체 배율(audio/video 트랙용)
  muted?: boolean; locked?: boolean; hidden?: boolean;
  clips: Clip[];                 // start 오름차순, 같은 트랙 내 겹침 금지

  // ── W8 F12 — 진짜 사이드체인 더킹 (둘 다 optional: v1 문서 그대로 유효) ──
  /** 이 트랙을 «누르는» 트리거 트랙 id (보통 나레이션). 렌더 시 sidechaincompress 로 눌린다. */
  duckedBy?: string;
  /** amount 는 0..1 «배율» — 미리보기(키프레임)와 렌더(컴프)가 같은 숫자를 쓴다. 0.25 = -12dB. */
  duck?: { amount: number; attackMs: number; releaseMs: number };
};

export type Transform = { x: number; y: number; scale: number; rotation: number;
                          flipH?: boolean; flipV?: boolean };
export type Crop = { x: number; y: number; w: number; h: number };  // 소스 대비 정규화 0..1, 기본 전체
export type Keyframe = { time: number /* 클립 시작 기준 ms */;
  /** 경로 문자열 (W8 S1). 'x' | 'opacity' | 'effects#e3.params.amount' | 'mask.feather' | ... */
  prop: string;
  value: number; easing: Easing /* W8 S2 — 기존 4종 문자열 그대로 유효 */ };
export type Effect = { id: string; type: EffectType; params: Record<string, number | string | boolean> };
export type Transition = { type: TransitionType; duration: number /* ms */ };

// ── W8 F9 — 자유 마스크 (전부 optional: v1 문서 그대로 유효) ───────────────
/** masks[] 안에서만 의미가 있다(첫 레이어의 op 는 합성할 대상이 없어 무시된다). */
export type MaskOp = 'add' | 'subtract' | 'intersect';
/** 모양 자체의 키프레임. Keyframe.value 는 number 라 `d`(문자열)를 담을 수 없어 따로 둔다. */
export type MaskShapeKey = { time: number /* 클립 시작 기준 ms */; d: string; easing?: Easing };
export type Mask = {
  shape: 'rect' | 'circle' | 'linear' | 'path';
  feather: number /* 0..1 */;
  invert?: boolean;
  /** 마스크 상자 — 클립 상자 대비 0..1 */
  x: number; y: number; w: number; h: number;
  /**
   * shape==='path' 일 때 필수. 좌표는 **클립 상자가 아니라 「마스크 상자」 안의 0..1** 이다:
   *   최종 px = (x + dx·w)·boxW , (y + dy·h)·boxH
   * 이렇게 두면 «모양은 d, 위치·크기는 x/y/w/h» 가 맡아 F10 마스크 트래킹(= x/y/w/h 키프레임)이
   * 자유 마스크에도 그대로 붙는다. 좌표계를 클립 상자로 잡으면 트래킹을 두 번 만들어야 한다.
   */
  d?: string;
  op?: MaskOp;
  dKeys?: MaskShapeKey[];
};
export type ChromaKey = { color: string; similarity: number; smoothness: number;
                          spill?: number /* 0..1 — 경계에 남는 키 색 물듦 제거 강도. 기본 0.5 */ };

export type ClipBase = {
  id: string;
  start: number; duration: number;   // 타임라인 ms
  transform?: Transform;             // 기본 {x:0,y:0,scale:1,rotation:0}
  crop?: Crop;
  opacity?: number;                  // 0..1 기본 1
  keyframes?: Keyframe[];
  effects?: Effect[];
  transitionIn?: Transition; transitionOut?: Transition;
  curves?: ColorCurves;              // 색조정 커브 (W5)
  /**
   * W8 F3-B — 트랜스폼 모션 블러. 켄번스 줌·팬·글자 이동처럼 **합성 단계에서 움직이는 것**을
   * 흐린다(소스 영상 «속» 피사체는 F3-A 의 `ClipSource.motionBlur` 가 흐린다 — 다른 문제다).
   * 비디오·이미지·텍스트 **모든 클립**에 걸린다.
   */
  transformBlur?: TransformBlur;
};

export type VideoClip = ClipBase & {
  kind: 'video'; assetId: string;
  in: number; out: number;           // 소스 구간 ms (out > in)
  speed: number;                     // 0.1..100, duration === (out-in)/speed (±1ms)
                                     // — 예외: freeze/loop 는 검사 제외, speedRamp 는 rampDurationMs ±2ms (W5)
  reversed?: boolean;
  volume: number;                    // 0..2 기본 1
  fadeIn?: number; fadeOut?: number; // ms (오디오 페이드)
  blendMode?: 'normal'|'multiply'|'screen'|'overlay'|'darken'|'lighten'|'color-dodge'|'color-burn'|'hard-light'|'soft-light'|'difference';
  mask?: Mask; masks?: Mask[]; chromaKey?: ChromaKey;
  source?: ClipSource;               // 파생 미디어 스펙 (W5 M2)
  speedRamp?: SpeedRamp;             // 속도 커브 (W5 M6)
  freeze?: boolean;                  // true면 in 프레임을 duration 내내 정지 (규약: out===in+1, speed===1)
  loop?: boolean;                    // true면 소스를 반복해 duration 을 채움
};
export type ImageClip = ClipBase & { kind: 'image'; assetId: string;
  blendMode?: VideoClip['blendMode']; mask?: Mask; masks?: Mask[];
  // W8 F17 — 초록 배경 «이미지»(제품 컷아웃·AI 생성 이미지)도 흔하다.
  chromaKey?: ChromaKey };
export type AudioClip = {
  id: string; start: number; duration: number;
  kind: 'audio'; assetId: string;
  in: number; out: number; speed: number;
  volume: number; fadeIn?: number; fadeOut?: number;
  keyframes?: Keyframe[];            // prop 'volume'만 유효
  source?: AudioClipSource;          // 파생 미디어 스펙 (W5 M2, W8 S3 에서 voice 추가)
};
export type WordTiming = { text: string; start: number; duration: number };  // start = 클립 시작 기준 ms
export type TextClip = ClipBase & {
  kind: 'text'; text: string; style: TextStyle;
  animationIn?: TextAnim;    // ← W8 F8 에서 타입만 넓어졌다
  animationOut?: TextAnim;
  words?: WordTiming[]; highlightColor?: string;
};
export type TextStyle = {
  fontFamily: string;                // 기본 "Pretendard, 'Malgun Gothic', sans-serif"
  fontSize: number; color: string; bold?: boolean; italic?: boolean;
  strokeColor?: string; strokeWidth?: number;
  backgroundColor?: string; shadow?: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing?: number; lineHeight?: number;
};
export type Clip = VideoClip | ImageClip | AudioClip | TextClip;

// ── W5 확장 타입 (전부 optional 필드로만 쓰인다 — v1 문서 그대로 유효) ──────

// 색조정 커브: 0..1 정규화 점, x 오름차순, 최소 2점(0과 1 포함 권장)
export type CurvePoint = { x: number; y: number };
export type ColorCurves = { rgb?: CurvePoint[]; r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] };

// 파생 미디어 스펙 (M2) — 서버가 이 스펙대로 ffmpeg 로 클립 전용 파일을 굽는다
export type ClipSource = {
  lut?: { assetId: string; intensity: number };  // intensity 0..1, assetId 는 kind:'lut' 에셋
  stabilize?: { smoothing: number };             // 1..100 (vidstabtransform smoothing 프레임 수)
  denoise?: { amount: number };                  // 0..1 → afftdn nr = amount*40 (dB)
  pitch?: { semitones: number };                 // -12..12

  // ── W8 S3 확장 (전부 optional — 기존 문서가 그대로 유효하다) ──
  matchTo?: MatchTo;            // F4 컷별 색 맞추기 (colorlevels)
  hueSat?: HueSatBand[];        // F5 primary  (huesaturation) — hsl 보다 «먼저» 걸린다
  hsl?: HslSecondary[];         // F5 secondary(selectivecolor)
  motionBlur?: MotionBlurSpec;  // F3 소스 모션 블러 (minterpolate/tmix)
  voice?: VoiceSpec;            // F11 나레이션 체인 (video 클립의 오디오에도 건다)
};

// ── W8 S3 — F4 컷별 색 맞추기 ────────────────────────────────────────────
export type ChannelStat = { mean: number; std: number };  // 0..1 정규화
/**
 * 측정 결과 «캐시». 굽기 직전에 서버가 재지 않고 문서에 적어 둔다 (계획 04):
 * 그래야 sourceKey 가 클립 하나로 닫히고(doc 을 안 받는다), 같은 문서가 같은 결과를 낸다.
 * 대가는 «기준 컷을 나중에 색보정하면 자동으로 다시 안 맞춰진다» 인데,
 * refSourceKey 를 같이 저장해 두고 기준 클립의 현재 sourceKey 와 다르면 UI 가 배지를 띄운다.
 */
export type MatchLevels = {
  sampledAtMs: number[];        // 측정한 소스 시각들 — 재현·감사용
  refSourceKey: string;         // 기준 클립의 sourceKey (파생이 없으면 'raw')
  ref: [ChannelStat, ChannelStat, ChannelStat];     // r, g, b 순서 고정
  target: [ChannelStat, ChannelStat, ChannelStat];
};
export type MatchTo = {
  clipId: string;               // 기준 클립 id
  strength: number;             // 0..1 (기본 1 — 완전히 맞춤)
  region?: Crop;                // «대상» 클립에서 비교할 영역. 없으면 clip.crop, 그것도 없으면 전체
  refRegion?: Crop;             // «기준» 클립에서 비교할 영역 — 피부는 두 컷에서 다른 자리에 있다
  levels?: MatchLevels;         // 측정 결과 (없으면 아직 안 잰 것 — 굽지 않는다)
};

// ── W8 S3 — F5 HSL 세컨더리 ──────────────────────────────────────────────
export const HSL_FAMILIES = [
  'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks',
] as const;
export type HslFamily = typeof HSL_FAMILIES[number];
/** selectivecolor 의 계열별 CMYK 잉크 조정. 채도·색상 회전은 못 한다 → HueSatBand 를 같이 쓴다. */
export type HslSecondary = {
  id: string;
  family: HslFamily;
  cyan: number; magenta: number; yellow: number; black: number;   // 각 -1..1
};

export const HUESAT_BANDS = ['r', 'y', 'g', 'c', 'b', 'm'] as const;
export type HueSatBandName = typeof HUESAT_BANDS[number];
/** huesaturation — 6구간에 대한 색상 회전·채도·강도. selectivecolor 로 못 하는 것을 여기서 한다. */
export type HueSatBand = {
  id: string;
  bands: HueSatBandName[];      // 최소 1개
  hue: number;                  // -180..180 (도)
  saturation: number;           // -1..1
  intensity: number;            // -1..1
  preserveLightness?: boolean;  // huesaturation 의 lightness (기본 false)
};

// ── W8 S3 — F3 소스 모션 블러 ────────────────────────────────────────────
/** quality 기본은 'precise'. 느린 것은 예상 시간으로 알리고, 몰래 fast 로 바꾸지 않는다(계획 03). */
export type MotionBlurSpec = { shutterAngle: number; quality: 'fast' | 'precise' };

// ── W8 F3-B — 트랜스폼 모션 블러 (합성 단계, 파생 파일을 굽지 않는다) ────
/**
 * 한 프레임을 그릴 때 셔터가 열려 있는 구간을 `samples` 등분해 **레이아웃을 그만큼 계산하고
 * 겹쳐 그린다.** 소스 프레임은 같은 시각의 것 하나뿐이라 프레임 추출이 N배가 되지 않는다.
 * - `shutterAngle` 0~360 (180 = 표준 영화 셔터, 한 프레임 간격의 절반 동안 열려 있다)
 * - `samples` 4~32 (기본 12). 적으면 계단이 보이고, 많으면 그 수만큼 더 그린다.
 */
export type TransformBlur = { shutterAngle: number; samples: number };

// ── W8 S3 — F11 나레이션 오디오 체인 ─────────────────────────────────────
export const VOICE_PRESETS = ['off', 'broadcast', 'warm', 'bright', 'podcast'] as const;
export type VoicePreset = typeof VOICE_PRESETS[number];
export type VoiceSpec = {
  preset: VoicePreset;
  targetLufs?: number;                      // -30..-9, 기본 -14 (관행값이지 플랫폼 공식값이 아니다)
  reverb?: { irId: string; wet: number };   // wet 0..1 — vendor/ir/<irId>.wav
};

/** audio 클립의 source — 나레이션은 대부분 audio 클립이라 voice 가 여기에도 있어야 한다. */
export type AudioClipSource = {
  denoise?: { amount: number };
  pitch?: { semitones: number };
  voice?: VoiceSpec;
};

// 속도 커브 (M6)
export type SpeedPoint = { u: number; speed: number };  // u = 소스 구간 진행도 0..1, speed 0.1..100
export type SpeedRamp = { points: SpeedPoint[] };       // u 오름차순, points[0].u===0, 마지막 u===1, 최소 2점

// 파생 파일 (sourceKey → 파일)
export type DerivedMedia = { src: string; proxySrc?: string };

// 텍스트 템플릿 (M1)
export type TextTemplate = {
  id: string; name: string; style: TextStyle;
  animationIn?: TextAnim;
  animationOut?: TextAnim;
  transform?: Transform;
  highlightColor?: string;
};

// ── 전환·효과 목록은 **카탈로그에서 파생된다** (W8 F16, catalog.ts).
// 새 전환·효과를 넣는 곳은 catalog.ts 하나다 — 여기 손댈 일이 없다.
// 순서는 카탈로그 배열 순서 그대로이고, 앞머리(전환 23 · 효과 20)는 고정이다.
export {
  TRANSITION_TYPES, EFFECT_TYPES,
  TRANSITION_CATALOG, EFFECT_CATALOG,
  TRANSITION_GROUPS, EFFECT_GROUPS,
  TRANSITION_GROUP_LABELS, EFFECT_GROUP_LABELS,
  TRANSITION_OMISSIONS, PENDING_EFFECT_TYPES,
  transitionDef, effectDef, isPendingEffect, defaultEffectParams, effectParamStep,
  type TransitionType, type EffectType,
  type TransitionDef, type EffectDef, type EffectParamSpec,
  type TransitionGroup, type EffectGroup,
} from './catalog.js';
// params: brightness/contrast/saturation {amount 0..2 기본1}, hue {deg -180..180}, blur {px 0..50},
//         vignette/grayscale/sepia/invert {amount 0..1}
// W5 params 기본값:
//  temperature {amount:0}   -1(차갑게)..1(따뜻하게)
//  tint        {amount:0}   -1(초록)..1(자홍)
//  exposure    {stops:0}    -2..2 (EV)
//  highlights  {amount:0}   -1(밝은 곳 누르기)..1(올리기)
//  shadows     {amount:0}   -1(어두운 곳 누르기)..1(올리기)
//  sharpen     {amount:0}   0..2
//  glow        {amount:0.5, radius:16}   amount 0..1, radius 0..40 px
//  grain       {amount:0.3}              0..1
//  scanlines   {amount:0.3, lines:600}   amount 0..1, lines 100..2000
//  chromaShift {px:4}                    0..20
//  lightLeak   {amount:0.4, hue:30}      amount 0..1, hue 0..360
// ── 텍스트 애니메이션 21종 (v1 5종 + W8 F8 16종) ──
// **순서를 바꾸지 마라.** v1 5종은 값·의미·자리가 고정이고 새 것은 뒤에 붙인다.
//
// `drawStroke`(글자 획이 그려지는 효과)는 remotion 패키지가 전부 **4.0.520** 으로 맞춰지면서
// `@remotion/paths` 의 `evolvePath`·`getSubpaths` 를 쓸 수 있게 되어 **맨 뒤에 붙었다**
// (그전에는 4.0.519 위에 단독 설치하면 remotion 사본이 둘이 되어 렌더가 깨졌다).
// 글리프 외곽선 자체는 `composition/glyph-path.ts` 가 번들 ttf 를 직접 읽어 만든다.
export const TEXT_ANIM_TYPES = [
  // v1 5종
  'fade','slideUp','popIn','typewriter','wordHighlight',
  // 밀기 3
  'slideDown','slideLeft','slideRight',
  // 크기 2
  'scaleUp','scaleDown',
  // 흐림 1
  'blurIn',
  // 회전 3
  'rotateIn','flipX','flipY',
  // 와이프 4 (기하는 transitions.tsx 의 같은 이름과 «같은 방향»이다)
  'wipeLeft','wipeRight','wipeUp','wipeDown',
  // 탄력 2
  'bounceIn','springUp',
  // 획 1 — 붓글씨처럼 글자의 획이 그려져 나간다
  'drawStroke',
] as const;
export type TextAnimType = typeof TEXT_ANIM_TYPES[number];

// ── W8 F8 — 「단위 × 움직임」 두 축 ────────────────────────────────────────
export const TEXT_ANIM_UNITS = ['all', 'line', 'word', 'char'] as const;
export type TextAnimUnit = typeof TEXT_ANIM_UNITS[number];

export const TEXT_ANIM_ORIGINS = ['start', 'end', 'center', 'random'] as const;
export type TextAnimOrigin = typeof TEXT_ANIM_ORIGINS[number];

/** 단위별 기본 시차(ms). unit 이 없으면 'all' 이라 0 — 즉 v1 과 정확히 같은 그림이 나온다. */
export const TEXT_ANIM_DEFAULT_STAGGER: Record<TextAnimUnit, number> = {
  all: 0, line: 120, word: 60, char: 30,
};

/**
 * 등장/퇴장 애니메이션. `{ type, duration }` 만 있는 v1 문서는 `unit:'all'` 로 읽혀
 * **한 프레임도 다르지 않게** 그려진다 (아래 필드는 전부 optional).
 */
export type TextAnim = {
  type: TextAnimType;
  /** ms — 「등장이 끝나는 시각」. 시차를 넣어도 **전체가 이 안에서 끝난다**(시차를 줄인다). */
  duration: number;
  unit?: TextAnimUnit;          // 기본 'all'
  staggerMs?: number;           // 기본 TEXT_ANIM_DEFAULT_STAGGER[unit]
  easing?: Easing;              // W8 S2. 기본은 움직임별 기본 이징
  /** slide 계열 이동 px · blurIn 흐림 px · wipe 계열 그라디언트 폭 % (0 이면 칼처럼 자른다) */
  distance?: number;
  origin?: TextAnimOrigin;      // 시차 순서. 기본 'start'
};

/**
 * 이 움직임에 쓸 수 있는 단위. typewriter 는 정의상 글자 단위, wordHighlight 는 words 타이밍을
 * 쓰므로 단어 단위, `drawStroke` 는 **획이 글자 단위로만 의미가 있어** 글자·전체만 된다
 * (`'all'` 은 「모든 글자가 동시에 그려진다」= 시차 0 이다).
 * 나머지 18종은 4종 전부 — 유효 조합 18×4 + 1 + 1 + 2 = **76**.
 */
export function textAnimUnits(type: TextAnimType): readonly TextAnimUnit[] {
  if (type === 'typewriter') return ['char'];
  if (type === 'wordHighlight') return ['word'];
  if (type === 'drawStroke') return ['all', 'char'];
  return TEXT_ANIM_UNITS;
}

// ── W8 F9 — 자유 마스크 `d` 의 문법 검사 + CSS 주입 차단 ──────────────────
//
// `d` 는 `clip-path: path("…")` 라는 **CSS 문자열 안에 그대로 들어간다.** 따옴표 하나가
// 새어 들어가면 그 자리에서 CSS 를 빠져나가 임의의 속성을 쓸 수 있다 → 허용 문자만 받는다.

export const MASK_PATH_D_MAX = 4000;
export const MASK_PATH_MAX_CMDS = 500;
/** 따옴표·괄호·백슬래시·URL 문자는 통과하지 못한다. e/E 는 지수 표기 때문에 남긴다. */
export const MASK_PATH_D_RE = /^[MmLlCcQqZz0-9eE ,.+-]+$/;

export type MaskPathCommand = { cmd: string; nums: number[] };

/** 명령별 인자 개수. `A`(호)·`H V S T`(축약형)는 **일부러 없다** — 펜 툴이 만들지 않는다. */
const MASK_PATH_ARITY: Record<string, number> = { M: 2, L: 2, C: 6, Q: 4, Z: 0 };

/**
 * `d` 를 명령 목록으로. 문법이 틀리면 null.
 * 「명령 글자 하나 + 정확히 그 개수의 유한한 수」만 받는다(암시적 반복 인자를 안 받는다).
 */
export function parseMaskPathD(d: string): MaskPathCommand[] | null {
  if (typeof d !== 'string' || d.length === 0 || d.length > MASK_PATH_D_MAX) return null;
  if (!MASK_PATH_D_RE.test(d)) return null;
  const toks = d.replace(/([MmLlCcQqZz])/g, ' $1 ').replace(/,/g, ' ').trim().split(/\s+/);
  const out: MaskPathCommand[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i++]!;
    const arity = MASK_PATH_ARITY[t.toUpperCase()];
    if (arity === undefined) return null;               // 수가 명령보다 먼저 왔다 / 모르는 명령
    const nums: number[] = [];
    for (let k = 0; k < arity; k++) {
      const raw = toks[i++];
      if (raw === undefined) return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || raw === '') return null; // NaN·Infinity·1e999 거부
      nums.push(n);
    }
    out.push({ cmd: t, nums });
    if (out.length > MASK_PATH_MAX_CMDS) return null;
  }
  if (out.length === 0 || out[0]!.cmd.toUpperCase() !== 'M') return null;
  return out;
}

export function isValidMaskPathD(d: string): boolean {
  return parseMaskPathD(d) !== null;
}

/**
 * 명령 구성 문자열(예: `"MCCCZ"`). **dKeys 보간은 이게 같은 두 모양 사이에서만 된다** —
 * 정점을 더하거나 빼면 어느 점이 어느 점으로 가는지 정의되지 않는다. UI 는 이걸로 잠근다.
 */
export function maskPathSignature(d: string): string | null {
  const cmds = parseMaskPathD(d);
  return cmds ? cmds.map((c) => c.cmd.toUpperCase()).join('') : null;
}

/** 거부 사유(한국어). 통과하면 null. */
export function maskPathRejection(d: string): string | null {
  if (typeof d !== 'string' || d.length === 0) return '마스크 모양(d)이 비어 있습니다';
  if (d.length > MASK_PATH_D_MAX) return `마스크 모양이 너무 깁니다 (${d.length}자 > ${MASK_PATH_D_MAX}자)`;
  if (!MASK_PATH_D_RE.test(d)) {
    return '마스크 모양에 쓸 수 없는 문자가 있습니다 — M L C Q Z 와 숫자만 쓸 수 있습니다';
  }
  if (parseMaskPathD(d) === null) {
    return '마스크 모양 문법이 올바르지 않습니다 — M/L 은 좌표 2개, C 는 6개, Q 는 4개여야 하고 M 으로 시작해야 합니다';
  }
  return null;
}

// ── Zod 스키마 ────────────────────────────────────────────────────────────

const finiteNum = z.number().finite();
const msInt = z.number().int();                 // 시간은 정수 ms (Global Constraints)
const msNonNeg = msInt.nonnegative();
const msPos = msInt.positive();
const ratio01 = z.number().min(0).max(1);
const volume02 = z.number().min(0).max(2);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '#rrggbb 형식이어야 합니다');
// 문서에 저장되는 경로는 forward slash 전용 — 백슬래시 거부
const srcPath = z.string().min(1).regex(/^[^\\]+$/, '경로에 백슬래시(\\)를 쓸 수 없습니다');

// ── W5 확장 Zod ──────────────────────────────────────────────────────────

// ClipSourceSchema(matchTo.region)가 참조하므로 클립 필드보다 먼저 선언한다 —
// top-level const 는 선언 순서대로 평가되어, 뒤에 두면 TDZ ReferenceError 가 난다.
const CropSchema = z.object({ x: ratio01, y: ratio01, w: ratio01, h: ratio01 });

export const CurvePointSchema = z.object({ x: ratio01, y: ratio01 });

const curveArray = z.array(CurvePointSchema).min(2, '커브는 최소 2점이어야 합니다').superRefine((pts, ctx) => {
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.x <= pts[i - 1]!.x) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'x'], message: '커브 점의 x는 오름차순이어야 합니다' });
      break;
    }
  }
});

export const ColorCurvesSchema = z.object({
  rgb: curveArray.optional(), r: curveArray.optional(), g: curveArray.optional(), b: curveArray.optional(),
});

// ── W8 S3 확장 Zod — 범위는 전부 ffmpeg 필터의 실제 허용 범위에서 왔다 ──
const signed1 = z.number().min(-1).max(1);   // selectivecolor CMYK · huesaturation saturation/intensity

export const ChannelStatSchema = z.object({ mean: ratio01, std: ratio01 });

export const MatchLevelsSchema = z.object({
  sampledAtMs: z.array(msNonNeg).min(1, '측정 시각이 최소 1개는 있어야 합니다'),
  refSourceKey: z.string().min(1),
  ref: z.tuple([ChannelStatSchema, ChannelStatSchema, ChannelStatSchema]),
  target: z.tuple([ChannelStatSchema, ChannelStatSchema, ChannelStatSchema]),
});

export const MatchToSchema = z.object({
  clipId: z.string().min(1),
  strength: ratio01,
  region: CropSchema.optional(),
  refRegion: CropSchema.optional(),
  levels: MatchLevelsSchema.optional(),
});

export const HslSecondarySchema = z.object({
  id: z.string().min(1),
  family: z.enum(HSL_FAMILIES),
  cyan: signed1, magenta: signed1, yellow: signed1, black: signed1,
});

export const HueSatBandSchema = z.object({
  id: z.string().min(1),
  bands: z.array(z.enum(HUESAT_BANDS)).min(1, '색 구간을 최소 1개 골라야 합니다'),
  hue: z.number().min(-180).max(180),
  saturation: signed1,
  intensity: signed1,
  preserveLightness: z.boolean().optional(),
});

export const MotionBlurSchema = z.object({
  shutterAngle: z.number().min(0).max(360),
  quality: z.enum(['fast', 'precise']),
});

/**
 * W8 F3-B — 트랜스폼 모션 블러. samples 는 «한 프레임을 몇 번 더 그리는가» 라서 상한이 필요하다.
 * 4 미만이면 겹쳐 그린 자국이 계단으로 보이고, 32 를 넘으면 렌더 시간만 늘고 눈에 안 보인다.
 */
export const TransformBlurSchema = z.object({
  shutterAngle: z.number().min(0).max(360),
  samples: z.number().int().min(4).max(32),
});

export const VoiceSchema = z.object({
  preset: z.enum(VOICE_PRESETS),
  // -30..-9 LUFS. 트루피크 목표(-1.0 dBTP)는 노브를 열지 않는다 — 잘못 만지면 플랫폼 인코딩에서 클리핑.
  targetLufs: z.number().min(-30).max(-9).optional(),
  reverb: z.object({ irId: z.string().min(1), wet: ratio01 }).optional(),
});

export const ClipSourceSchema = z.object({
  lut: z.object({ assetId: z.string().min(1), intensity: ratio01 }).optional(),
  stabilize: z.object({ smoothing: z.number().int().min(1).max(100) }).optional(),
  denoise: z.object({ amount: ratio01 }).optional(),
  pitch: z.object({ semitones: z.number().min(-12).max(12) }).optional(),
  matchTo: MatchToSchema.optional(),
  hueSat: z.array(HueSatBandSchema).optional(),
  hsl: z.array(HslSecondarySchema).optional(),
  motionBlur: MotionBlurSchema.optional(),
  voice: VoiceSchema.optional(),
});

const AudioClipSourceSchema = z.object({
  denoise: z.object({ amount: ratio01 }).optional(),
  pitch: z.object({ semitones: z.number().min(-12).max(12) }).optional(),
  voice: VoiceSchema.optional(),
});

export const SpeedPointSchema = z.object({ u: ratio01, speed: z.number().min(0.1).max(100) });

export const SpeedRampSchema = z.object({
  points: z.array(SpeedPointSchema).min(2, '속도 램프는 최소 2점이어야 합니다').superRefine((pts, ctx) => {
    if (pts.length === 0) return;
    if (pts[0]!.u !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [0, 'u'], message: '첫 점의 u는 0이어야 합니다' });
    }
    if (pts[pts.length - 1]!.u !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [pts.length - 1, 'u'], message: '마지막 점의 u는 1이어야 합니다' });
    }
    for (let i = 1; i < pts.length; i++) {
      if (pts[i]!.u <= pts[i - 1]!.u) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'u'], message: '램프 점의 u는 오름차순이어야 합니다' });
        break;
      }
    }
  }),
});

export const DerivedMediaSchema = z.object({ src: srcPath, proxySrc: srcPath.optional() });

const beatsArray = z.array(msNonNeg).superRefine((arr, ctx) => {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i]! <= arr[i - 1]!) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: 'beats는 ms 오름차순이어야 합니다' });
      break;
    }
  }
});

const BackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('color'), color: hexColor }),
  z.object({ kind: z.literal('blur'), amount: z.number().min(4).max(80) }),
  z.object({ kind: z.literal('image'), assetId: z.string().min(1) }),
]);

const AssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['video', 'audio', 'image', 'lut']),
  src: srcPath,
  name: z.string(),
  duration: msNonNeg.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  proxySrc: srcPath.optional(),
  waveformSrc: srcPath.optional(),
  thumbSrc: srcPath.optional(),
  reversedSrc: srcPath.optional(),
  derived: z.record(z.string(), DerivedMediaSchema).optional(),
  beats: beatsArray.optional(),
});

const TransformSchema = z.object({
  x: finiteNum, y: finiteNum,
  scale: z.number().nonnegative().finite(),
  rotation: finiteNum,
  flipH: z.boolean().optional(), flipV: z.boolean().optional(),
});

// ── 이징 (W8 S2) — z.union 은 앞에서부터 맞는 것을 고르므로 기존 4종 문자열은
//    첫 분기에서 그대로 통과한다. 기존 문서의 파싱 경로가 한 글자도 안 바뀐다.
const EasingNameSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);

// p1x·p2x 는 CSS 규격대로 0..1 — **조용히 클램프하지 않고 거부한다.** 클램프하면 문서에
// 적힌 값과 실제 움직임이 달라져 「왜 내가 넣은 값이 안 먹지」의 원인이 된다.
// p1y·p2y 는 제한 없음 — 오버슈트(back 계열)를 허용해야 한다.
const BezierEasingSchema = z
  .object({ bezier: z.tuple([z.number().min(0).max(1), finiteNum, z.number().min(0).max(1), finiteNum]) })
  .strict();

const SpringEasingSchema = z
  .object({
    spring: z
      .object({
        damping: z.number().min(1).max(200).optional(),
        mass: z.number().min(0.1).max(10).optional(),
        stiffness: z.number().min(1).max(500).optional(),
        overshootClamping: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();   // .strict() 로 { bezier:[...], spring:{...} } 처럼 둘 다 든 값을 막는다

export const EasingSchema = z.union([EasingNameSchema, BezierEasingSchema, SpringEasingSchema]);

const KeyframeSchema = z.object({
  time: msNonNeg,
  // 문법은 스키마가, «이 클립에 허용된 경로인가»는 엔진이 본다 —
  // KeyframeSchema 는 clipBaseFields 안에서 재사용되어 클립 종류를 모르기 때문이다.
  prop: z
    .string()
    .min(1)
    .max(KEYFRAME_PATH_MAX)
    .regex(KEYFRAME_PATH_RE, '키프레임 prop 은 경로 문자열이어야 합니다 (예: x, mask.feather, effects#e1.params.amount)'),
  value: finiteNum,
  easing: EasingSchema,
});

// 카탈로그에서 파생된 배열은 «비어 있지 않은 튜플» 타입이 아니라서 z.enum 이 그대로 못 받는다 —
// 길이 0 은 catalog.test.ts 가 막으므로 여기서는 타입만 맞춰 준다.
const enumOf = <T extends string>(list: readonly T[]) => z.enum(list as unknown as [T, ...T[]]);

const EffectSchema = z.object({
  id: z.string().min(1),
  type: enumOf(EFFECT_TYPE_LIST),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
});

const TransitionSchema = z.object({ type: enumOf(TRANSITION_TYPE_LIST), duration: msNonNeg });

const maskPathD = z.string().superRefine((d, ctx) => {
  const why = maskPathRejection(d);
  if (why) ctx.addIssue({ code: z.ZodIssueCode.custom, message: why });
});

const MaskShapeKeySchema = z.object({
  time: msNonNeg,
  d: maskPathD,
  easing: EasingSchema.optional(),
});

const MaskSchema = z.object({
  shape: z.enum(['rect', 'circle', 'linear', 'path']),
  feather: ratio01,
  invert: z.boolean().optional(),
  x: finiteNum, y: finiteNum, w: finiteNum, h: finiteNum,
  d: maskPathD.optional(),
  op: z.enum(['add', 'subtract', 'intersect']).optional(),
  dKeys: z.array(MaskShapeKeySchema).optional(),
}).superRefine((m, ctx) => {
  if (m.shape === 'path' && m.d === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['d'], message: "shape:'path' 마스크에는 모양(d)이 있어야 합니다" });
  }
  if (!m.dKeys || m.dKeys.length === 0) return;
  if (m.shape !== 'path') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dKeys'], message: '모양 키프레임(dKeys)은 자유 곡선(path) 마스크에서만 쓸 수 있습니다' });
    return;
  }
  // 정점 개수가 다른 두 모양은 **조용히 이상한 값을 내는 대신 여기서 거부한다**.
  // 어느 점이 어느 점으로 가는지 정의되지 않기 때문이다 (계획 09 §모양 애니메이션).
  const sig = maskPathSignature(m.d ?? m.dKeys[0]!.d);
  m.dKeys.forEach((k, i) => {
    if (maskPathSignature(k.d) !== sig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['dKeys', i, 'd'],
        message: '모양 키프레임끼리는 정점 개수·종류가 같아야 합니다 — 키가 있는 동안에는 점을 더하거나 뺄 수 없습니다',
      });
    }
  });
  for (let i = 1; i < m.dKeys.length; i++) {
    if (m.dKeys[i]!.time <= m.dKeys[i - 1]!.time) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dKeys', i, 'time'], message: '모양 키프레임의 time 은 오름차순이어야 합니다' });
      break;
    }
  }
});

/** 겹칠 수 있는 마스크 목록. 8장을 넘기면 CSS 마스크 레이어가 프레임마다 비싸진다. */
const MasksSchema = z.array(MaskSchema).min(1, '마스크 목록이 비어 있습니다').max(8, '마스크는 8장까지입니다');

const ChromaKeySchema = z.object({ color: z.string().min(1), similarity: finiteNum, smoothness: finiteNum,
  spill: ratio01.optional() });

export const BLEND_MODES = ['normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference'] as const;

const clipBaseFields = {
  id: z.string().min(1),
  start: msNonNeg,
  duration: msPos,
  transform: TransformSchema.optional(),
  crop: CropSchema.optional(),
  opacity: ratio01.optional(),
  keyframes: z.array(KeyframeSchema).optional(),
  effects: z.array(EffectSchema).optional(),
  transitionIn: TransitionSchema.optional(),
  transitionOut: TransitionSchema.optional(),
  curves: ColorCurvesSchema.optional(),
  transformBlur: TransformBlurSchema.optional(),
};

const VideoClipSchema = z.object({
  ...clipBaseFields,
  kind: z.literal('video'),
  assetId: z.string().min(1),
  in: msNonNeg, out: msPos,
  speed: z.number().min(0.1).max(100),
  reversed: z.boolean().optional(),
  volume: volume02,
  fadeIn: msNonNeg.optional(), fadeOut: msNonNeg.optional(),
  blendMode: z.enum(BLEND_MODES).optional(),
  mask: MaskSchema.optional(),
  masks: MasksSchema.optional(),
  chromaKey: ChromaKeySchema.optional(),
  source: ClipSourceSchema.optional(),
  speedRamp: SpeedRampSchema.optional(),
  freeze: z.boolean().optional(),
  loop: z.boolean().optional(),
});

const ImageClipSchema = z.object({
  ...clipBaseFields,
  kind: z.literal('image'),
  assetId: z.string().min(1),
  blendMode: z.enum(BLEND_MODES).optional(),
  mask: MaskSchema.optional(),
  masks: MasksSchema.optional(),
  chromaKey: ChromaKeySchema.optional(),
});

const AudioClipSchema = z.object({
  id: z.string().min(1),
  start: msNonNeg,
  duration: msPos,
  kind: z.literal('audio'),
  assetId: z.string().min(1),
  in: msNonNeg, out: msPos,
  speed: z.number().min(0.1).max(100),
  volume: volume02,
  fadeIn: msNonNeg.optional(), fadeOut: msNonNeg.optional(),
  keyframes: z.array(KeyframeSchema).optional(),
  source: AudioClipSourceSchema.optional(),
});

const WordTimingSchema = z.object({ text: z.string(), start: msNonNeg, duration: msNonNeg });

const TextStyleSchema = z.object({
  fontFamily: z.string().min(1),
  fontSize: z.number().positive().finite(),
  color: z.string().min(1),
  bold: z.boolean().optional(), italic: z.boolean().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().nonnegative().finite().optional(),
  backgroundColor: z.string().optional(),
  shadow: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']),
  letterSpacing: finiteNum.optional(),
  lineHeight: z.number().positive().finite().optional(),
});

/**
 * W8 F8 — 두 축(움직임 × 단위). 새 필드는 **전부 optional** 이라 `{type,duration}` 인
 * v1 문서가 한 글자도 안 바뀐 채 통과한다.
 */
const TextAnimSchema = z
  .object({
    type: z.enum(TEXT_ANIM_TYPES),
    duration: msNonNeg,
    unit: z.enum(TEXT_ANIM_UNITS).optional(),
    staggerMs: z.number().min(0).max(2000).optional(),
    easing: EasingSchema.optional(),
    distance: z.number().min(0).max(2000).optional(),
    origin: z.enum(TEXT_ANIM_ORIGINS).optional(),
  })
  .superRefine((a, ctx) => {
    // 어긋난 조합은 **거부한다** — UI 는 애초에 안 보여 준다(계획 08 §축 2).
    if (a.unit !== undefined && !textAnimUnits(a.type).includes(a.unit)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['unit'],
        message: `'${a.type}' 애니메이션에는 '${a.unit}' 단위를 쓸 수 없습니다 (가능: ${textAnimUnits(a.type).join(', ')})`,
      });
    }
  });

export const TextTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  style: TextStyleSchema,
  animationIn: TextAnimSchema.optional(),
  animationOut: TextAnimSchema.optional(),
  transform: TransformSchema.optional(),
  highlightColor: z.string().optional(),
});

const TextClipSchema = z.object({
  ...clipBaseFields,
  kind: z.literal('text'),
  text: z.string(),
  style: TextStyleSchema,
  animationIn: TextAnimSchema.optional(),
  animationOut: TextAnimSchema.optional(),
  words: z.array(WordTimingSchema).optional(),
  highlightColor: z.string().optional(),
});

const ClipSchema: z.ZodType<Clip> = z
  .discriminatedUnion('kind', [VideoClipSchema, ImageClipSchema, AudioClipSchema, TextClipSchema])
  .superRefine((clip, ctx) => {
    if ((clip.kind === 'video' || clip.kind === 'audio') && clip.out <= clip.in) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['out'], message: 'out은 in보다 커야 합니다' });
    }
    if (clip.kind === 'video') {
      // freeze 클립 규약: out === in+1, speed === 1 (X1)
      if (clip.freeze === true && (clip.out !== clip.in + 1 || clip.speed !== 1)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['freeze'],
          message: 'freeze 클립은 out === in + 1, speed === 1 이어야 합니다',
        });
      }
      // duration 불변식 예외 (X1): freeze/loop 는 duration 검사 제외.
      // speedRamp 가 있으면 |duration - rampDurationMs| <= 2 를 검사한다.
      if (clip.speedRamp && clip.freeze !== true && clip.loop !== true && clip.out > clip.in) {
        const expected = rampDurationMs(clip as VideoClip);
        if (Math.abs(clip.duration - expected) > 2) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom, path: ['duration'],
            message: `duration(${clip.duration})이 rampDurationMs(${expected})와 2ms 넘게 다릅니다`,
          });
        }
      }
    }
  });

const TrackSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['video', 'audio', 'text', 'overlay']),
  name: z.string(),
  volume: volume02.optional(),
  muted: z.boolean().optional(), locked: z.boolean().optional(), hidden: z.boolean().optional(),
  clips: z.array(ClipSchema),
  // W8 F12 — 사이드체인 더킹. 자기참조·순환·트리거 트랙 존재 여부는 엔진이 BAD_DUCK 으로 막는다
  // (스키마는 문서 하나만 보므로 «다른 트랙 id» 를 여기서 확인할 수 없다).
  duckedBy: z.string().min(1).optional(),
  duck: z.object({
    amount: ratio01,
    // sidechaincompress 의 attack 0.01..2000 / release 0.01..9000 안에서, 엔진의 0..5000 규칙과 겹치는 범위
    attackMs: z.number().min(0).max(2000),
    releaseMs: z.number().min(0).max(5000),
  }).optional(),
});

export const ProjectDocSchema: z.ZodType<ProjectDoc> = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string(),
  revision: z.number().int().nonnegative(),
  settings: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive().finite(),
    background: BackgroundSchema,
    coverMs: msNonNeg.optional(),
  }),
  assets: z.record(z.string(), AssetSchema),
  tracks: z.array(TrackSchema),
});

export function validateDoc(x: unknown): ProjectDoc {
  return ProjectDocSchema.parse(x);
}

export {
  cubicBezier, easingFn, easingKey, springSettleTimeSec,
  EASING_NAMES, EASING_PRESETS, SPRING_DEFAULTS,
  type Easing, type EasingName, type EasingPreset, type SpringConfig,
} from './easing.js';
export {
  KEYFRAME_PATHS, KEYFRAME_PATH_MAX, KEYFRAME_PATH_RE,
  isKeyframablePath, isValidKeyframePath, keyframePathDef, keyframePathLabel, keyframePathRejection,
  readPath, writePath,
  type KeyframePathDef,
} from './keyframe-paths.js';
export { createEmptyProject, newId } from './factory.js';
export { findUnknownKeys, describeUnknownKeys } from './unknown-keys.js';
export { PROXY_TAG, isCurrentProxy, staleProxyTargets, staleProxyCount, type StaleProxyTarget } from './proxy-version.js';
export {
  sourceKey, rampDurationMs, rampSegments, curvesToTables, DEFAULT_TARGET_LUFS,
  type RampSegment,
} from './derive.js';
export {
  TEXT_TEMPLATES, TEXT_TEMPLATE_GROUPS, SPEED_RAMP_PRESETS, KINETIC_PRESETS, type KineticPreset,
} from './templates.js';
export { FONT_FAMILIES, FONT_FALLBACK, DEFAULT_FONT_FAMILY, type FontFamilyOption } from './fonts.js';
export {
  LOUDNESS_TARGETS, loudnessTarget, loudnessTargetOf,
  type LoudnessTarget, type LoudnessTargetId,
} from './loudness.js';
export {
  COLOR_PRESETS, hslFamiliesOfRgb, hslFamilyOfRgb, hueSatBandsOfRgb,
  type ColorPreset, type FamilyMatch, type PresetHsl, type PresetHueSat,
} from './color-presets.js';
