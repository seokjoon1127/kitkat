// 인스펙터 공용 순수 헬퍼 — React 비의존 (단위 테스트 대상)
import {
  curvesToTables,
  easingFn,
  easingKey,
  EASING_PRESETS,
  // W8 F16 — 전환·효과 카탈로그. 라벨·파라미터 메타가 전부 여기서 나온다.
  EFFECT_CATALOG,
  EFFECT_GROUPS,
  EFFECT_GROUP_LABELS,
  effectDef,
  effectParamStep,
  TRANSITION_CATALOG,
  TRANSITION_GROUPS,
  TRANSITION_GROUP_LABELS,
  KEYFRAME_PATHS,
  keyframePathDef,
  keyframePathLabel,
  keyframePathRejection,
  newId,
  readPath,
  sourceKey,
  SPRING_DEFAULTS,
  springSettleTimeSec,
  textAnimUnits,
  writePath,
} from '@kitkat/schema';
import {
  circleShape,
  interpolateKeyframes,
  serializeMaskShape,
  staggerTiming,
  textAnimStaggerMs,
} from '@kitkat/renderer/composition';
import type { Command } from '@kitkat/engine';
import type {
  Asset,
  AudioClip,
  ChromaKey,
  Clip,
  ClipSource,
  ColorCurves,
  Crop,
  CurvePoint,
  ColorPreset,
  Easing,
  Effect,
  EffectType,
  HslFamily,
  HslSecondary,
  HueSatBand,
  HueSatBandName,
  Keyframe,
  Mask,
  MaskOp,
  MotionBlurSpec,
  ProjectDoc,
  SpeedPoint,
  SpringConfig,
  TextAnim,
  TextAnimOrigin,
  TextAnimType,
  TextAnimUnit,
  Transform,
  TransformBlur,
  TransitionType,
  VideoClip,
} from '@kitkat/schema';

// ── 기본값 ────────────────────────────────────────────────────────────────

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0 };
export const DEFAULT_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };

export function defaultMask(): Mask {
  return { shape: 'rect', feather: 0.1, x: 0, y: 0, w: 1, h: 1 };
}

// ── W8 F9 — 자유 마스크 ───────────────────────────────────────────────────

/** 새 자유 마스크의 출발 모양 — 원(`C` 4개, 오차 0.03%). `A`(호)를 문법에 넣지 않는 이유다. */
export function defaultPathMask(): Mask {
  return {
    shape: 'path',
    feather: 0.15,
    x: 0.25, y: 0.25, w: 0.5, h: 0.5,
    d: serializeMaskShape(circleShape(0.5, 0.5, 0.5)),
  };
}

export const MASK_SHAPE_OPTIONS: Option[] = [
  { value: 'rect', label: '사각형' },
  { value: 'circle', label: '원형' },
  { value: 'linear', label: '선형' },
  { value: 'path', label: '자유 곡선(펜)' },
];

export const MASK_OP_LABELS: Record<MaskOp, string> = {
  add: '더하기(합집합)',
  subtract: '빼기(구멍)',
  intersect: '교차(교집합)',
};

export const MASK_OP_OPTIONS: Option[] = (['add', 'subtract', 'intersect'] as MaskOp[]).map((v) => ({
  value: v,
  label: MASK_OP_LABELS[v],
}));

/** 클립의 마스크 목록 — `masks` 가 있으면 그것, 없으면 `mask` 한 장. 렌더러의 규칙과 같다. */
export function clipMasks(clip: { mask?: Mask; masks?: Mask[] }): Mask[] {
  if (clip.masks && clip.masks.length > 0) return clip.masks;
  return clip.mask ? [clip.mask] : [];
}

/**
 * 마스크 목록 → updateClip patch. **한 장이면 `mask` 로 되돌린다** — 그래야 기존 문서 모양이
 * 유지되고 `mask.x` 같은 키프레임 경로가 계속 가리키는 곳이 있다.
 */
export function masksPatch(masks: Mask[]): Record<string, unknown> {
  if (masks.length === 0) return { mask: null, masks: null };
  if (masks.length === 1) return { mask: masks[0], masks: null };
  return { mask: null, masks };
}

/** 모양 키프레임이 있으면 정점을 더하거나 뺄 수 없다 — 보간이 정의되지 않기 때문이다. */
export function maskShapeLocked(mask: Mask): boolean {
  return (mask.dKeys?.length ?? 0) >= 2;
}

export function defaultChromaKey(): ChromaKey {
  return { color: '#00ff00', similarity: 0.4, smoothness: 0.1, spill: 0.5 };
}

// ── 효과 파라미터 정의 ────────────────────────────────────────────────────
//
// **손으로 적던 표가 사라졌다 (W8 F16).** 라벨도 파라미터도 전부 `@kitkat/schema` 의
// catalog.ts 에서 파생된다 — 새 효과를 넣을 때 이 파일을 고칠 일이 없다.

export type EffectParamDef = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
};

export const EFFECT_LABELS: Record<EffectType, string> = Object.fromEntries(
  EFFECT_CATALOG.map((d) => [d.id, d.name]),
) as Record<EffectType, string>;

export const EFFECT_PARAM_DEFS: Record<EffectType, EffectParamDef[]> = Object.fromEntries(
  EFFECT_CATALOG.map((d) => [
    d.id,
    d.params.map((p) => ({
      key: p.key, label: p.label, min: p.min, max: p.max, def: p.def, step: effectParamStep(p),
    })),
  ]),
) as Record<EffectType, EffectParamDef[]>;

export function defaultEffectParams(type: EffectType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of EFFECT_PARAM_DEFS[type] ?? []) out[d.key] = d.def;
  return out;
}

/**
 * 「대기」 효과 — 목록에는 있지만 아직 안 그려지는 것(카탈로그 `pending`).
 * 드롭다운에서 **고를 수 없게** 막고, 이미 문서에 들어 있으면 배지로 알린다.
 * (고를 수 있는데 아무 일도 안 일어나는 것이 제일 나쁘다.) W8 #8 부터 대기가 0 이라 늘 null 이다.
 */
export function effectPendingReason(type: EffectType): string | null {
  return effectDef(type)?.pending ?? null;
}

export type OptionGroup = { group: string; options: Option[] };

/** 효과 드롭다운 — 갈래별 optgroup. 대기 항목은 이름 뒤에 「(대기)」가 붙고 disabled 다. */
export function effectOptionGroups(): OptionGroup[] {
  return EFFECT_GROUPS.map((g) => ({
    group: EFFECT_GROUP_LABELS[g],
    options: EFFECT_CATALOG.filter((d) => d.group === g).map((d) => ({
      value: d.id,
      label: d.pending ? `${d.name} (대기)` : d.name,
      ...(d.pending ? { disabled: true } : {}),
    })),
  })).filter((g) => g.options.length > 0);
}

/** 전환 드롭다운 — 갈래별 optgroup. 전환에는 대기 항목이 없다(전부 지금 그려진다). */
export function transitionOptionGroups(): OptionGroup[] {
  return TRANSITION_GROUPS.map((g) => ({
    group: TRANSITION_GROUP_LABELS[g],
    options: TRANSITION_CATALOG.filter((d) => d.group === g).map((d) => ({
      value: d.id,
      label: d.name,
    })),
  })).filter((g) => g.options.length > 0);
}

export function makeEffect(type: EffectType): Effect {
  return { id: newId(), type, params: defaultEffectParams(type) };
}

// ── 선택지 라벨 ───────────────────────────────────────────────────────────

export type Option = { value: string; label: string; disabled?: boolean };

export const BLEND_OPTIONS: Option[] = [
  { value: 'normal', label: '표준' },
  { value: 'multiply', label: '곱하기' },
  { value: 'screen', label: '스크린' },
  { value: 'overlay', label: '오버레이' },
  { value: 'darken', label: '어둡게' },
  { value: 'lighten', label: '밝게' },
  { value: 'color-dodge', label: '컬러 닷지' },
  { value: 'color-burn', label: '컬러 번' },
  { value: 'hard-light', label: '하드 라이트' },
  { value: 'soft-light', label: '소프트 라이트' },
  { value: 'difference', label: '차이' },
];
export type BlendMode = NonNullable<VideoClip['blendMode']>;

// 전환 라벨도 카탈로그에서 파생된다 (W8 F16) — 51종을 손으로 적지 않는다.
export const TRANSITION_LABELS: Record<TransitionType, string> = Object.fromEntries(
  TRANSITION_CATALOG.map((d) => [d.id, d.name]),
) as Record<TransitionType, string>;

export const TEXT_ANIM_LABELS: Record<TextAnimType, string> = {
  fade: '페이드',
  slideUp: '위로 등장',
  popIn: '팝 인',
  typewriter: '타자기',
  wordHighlight: '단어 강조',
  // ── W8 F8 신규 15종 ──
  slideDown: '아래로 등장',
  slideLeft: '왼쪽으로 밀기',
  slideRight: '오른쪽으로 밀기',
  scaleUp: '작게→크게',
  scaleDown: '크게→작게',
  blurIn: '초점 맞추기',
  rotateIn: '돌며 등장',
  flipX: '가로축 뒤집기',
  flipY: '세로축 뒤집기',
  wipeLeft: '닦기 (좌→우)',
  wipeRight: '닦기 (우→좌)',
  wipeUp: '닦기 (위→아래)',
  wipeDown: '닦기 (아래→위)',
  bounceIn: '튀며 등장',
  springUp: '탄력 등장',
  drawStroke: '붓글씨 (획 그리기)',
};

// ── W8 F8 — 단위·순서 라벨과 「이 조합이 지금 어떻게 움직이나」 ────────────

export const TEXT_ANIM_UNIT_LABELS: Record<TextAnimUnit, string> = {
  all: '전체',
  line: '줄',
  word: '단어',
  char: '글자',
};

export const TEXT_ANIM_ORIGIN_LABELS: Record<TextAnimOrigin, string> = {
  start: '앞에서부터',
  end: '뒤에서부터',
  center: '가운데부터',
  random: '무작위',
};

/** 이 움직임이 실제로 고를 수 있는 단위만 (typewriter=글자, wordHighlight=단어 고정). */
export function textAnimUnitOptions(type: TextAnimType): Option[] {
  return textAnimUnits(type).map((u) => ({ value: u, label: TEXT_ANIM_UNIT_LABELS[u] }));
}

/** 단위 개수의 «대충 맞는» 값 — 시차가 얼마나 줄어드는지 미리 보여 주려고 센다. */
export function textUnitCount(text: string, unit: TextAnimUnit): number {
  if (unit === 'all') return 1;
  if (unit === 'line') return Math.max(1, text.split('\n').length);
  if (unit === 'word') return Math.max(1, (text.match(/\S+/g) ?? []).length);
  return Math.max(1, [...text].filter((c) => c.trim().length > 0).length);
}

export type TextAnimHint = {
  /** 실제로 적용되는 시차(ms) — 글자가 많으면 자동으로 줄어든다 */
  applied: number;
  /** 요청한 시차보다 줄었나 */
  compressed: boolean;
  /** 노란 경고 한 줄 (없으면 null) */
  warning: string | null;
};

/**
 * 인스펙터가 회색으로 함께 보여 주는 값. **자르지 않고 압축한다**는 규칙을 화면에서도 지킨다.
 * fps 경고는 «막지 않고» 알려만 준다 — 24fps(41.7ms/프레임)에서 시차 30ms 면
 * 여러 글자가 같은 프레임에 나온다. 이건 표본화의 문제이지 모양의 문제가 아니다.
 */
export function textAnimHint(anim: TextAnim, text: string, fps: number): TextAnimHint {
  const unit = anim.unit ?? 'all';
  const n = textUnitCount(text, unit);
  const want = textAnimStaggerMs(anim);
  const { stagger } = staggerTiming(n, anim.duration, want);
  const frameMs = fps > 0 ? 1000 / fps : 0;
  const warning =
    unit !== 'all' && stagger > 0 && stagger < frameMs
      ? `시차 ${stagger.toFixed(1)}ms 가 한 프레임(${frameMs.toFixed(1)}ms)보다 짧아 여러 ${TEXT_ANIM_UNIT_LABELS[unit]}가 같은 프레임에 나옵니다`
      : null;
  return { applied: stagger, compressed: stagger + 1e-9 < want, warning };
}

// (W8 F7) EASING_OPTIONS 4종·KEYFRAME_PROP_LABELS 6종은 없앴다 —
// 이징은 EASING_PRESETS 12종, 경로 라벨은 keyframeLabel 이 대신한다.

// ── 시간 표시 ─────────────────────────────────────────────────────────────

/** ms → "m:ss.mmm" (음수는 0으로 클램프) */
export function formatMs(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const rest = t % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(rest).padStart(3, '0')}`;
}

// ── 키프레임 기본값: 현재 클립 값에서 가져온다 ───────────────────────────

/** 경로가 가리키는 현재 값 (W8 S1 — prop 이 경로 문자열이 되면서 switch 6개가 한 줄이 됐다). */
export function currentPropValue(clip: Clip, prop: Keyframe['prop']): number {
  return readPath(clip, prop) ?? 0;
}

// ── W5: 색조정 커브 (X1 ColorCurves) ─────────────────────────────────────

export const CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'] as const;
export type CurveChannel = (typeof CURVE_CHANNELS)[number];

export const CURVE_CHANNEL_LABELS: Record<CurveChannel, string> = {
  rgb: 'RGB',
  r: 'R',
  g: 'G',
  b: 'B',
};

/** 항등 커브. 모듈 상수라서 참조가 안정적이다(디바운스 훅의 외부 값 동기화가 헛돌지 않게). */
export const DEFAULT_CURVE: readonly CurvePoint[] = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 1, y: 1 }),
]) as readonly CurvePoint[];

/** 인접한 두 점의 최소 x 간격 — 스키마가 x 오름차순(같은 값 불가)을 요구한다. */
export const CURVE_MIN_GAP = 0.005;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** 0..1 클램프 + x 오름차순 정렬 + x 가 겹치는 점 제거. 커밋 직전에 항상 통과시킨다. */
export function normalizeCurve(points: readonly CurvePoint[]): CurvePoint[] {
  const sorted = points
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev && p.x - prev.x < CURVE_MIN_GAP / 2) continue; // 겹치는 x 는 먼저 온 점을 남긴다
    out.push(p);
  }
  return out.length >= 2 ? out : [...(DEFAULT_CURVE as CurvePoint[])];
}

/**
 * 점 하나를 옮긴다. 양 끝점(첫·마지막)은 x 이동 금지 — y 만 바뀐다.
 * 가운데 점은 좌우 이웃 사이 CURVE_MIN_GAP 만큼 여유를 두고 클램프해 순서가 뒤집히지 않게 한다.
 */
export function moveCurvePoint(
  points: readonly CurvePoint[],
  index: number,
  x: number,
  y: number,
): CurvePoint[] {
  const next = points.map((p) => ({ ...p }));
  const p = next[index];
  if (!p) return next;
  p.y = clamp01(y);
  const isEnd = index === 0 || index === next.length - 1;
  if (!isEnd) {
    const lo = next[index - 1]!.x + CURVE_MIN_GAP;
    const hi = next[index + 1]!.x - CURVE_MIN_GAP;
    p.x = hi <= lo ? next[index]!.x : clamp(clamp01(x), lo, hi);
  }
  return next;
}

/** 빈 곳 클릭 → 점 추가. 기존 x 와 너무 가까우면 추가하지 않는다. */
export function addCurvePoint(points: readonly CurvePoint[], x: number, y: number): CurvePoint[] {
  const nx = clamp01(x);
  if (points.some((p) => Math.abs(p.x - nx) < CURVE_MIN_GAP)) return points.map((p) => ({ ...p }));
  return normalizeCurve([...points, { x: nx, y: clamp01(y) }]);
}

/** 점 삭제. 양 끝점은 지울 수 없다(최소 2점 + x=0,1 유지). */
export function removeCurvePoint(points: readonly CurvePoint[], index: number): CurvePoint[] {
  if (index <= 0 || index >= points.length - 1) return points.map((p) => ({ ...p }));
  return points.filter((_, i) => i !== index).map((p) => ({ ...p }));
}

/** 항등 커브인가 — 저장할 가치가 없는 커브를 걸러낸다. */
export function isIdentityCurve(points: readonly CurvePoint[]): boolean {
  return points.length === 2 && points[0]!.x === 0 && points[0]!.y === 0
    && points[1]!.x === 1 && points[1]!.y === 1;
}

/**
 * 한 채널을 갈아끼운 ColorCurves. 남는 채널이 없으면 null(= curves 필드 삭제).
 * 항등 커브는 채널을 지우는 것과 같게 취급한다.
 */
export function setCurveChannel(
  curves: ColorCurves | undefined,
  channel: CurveChannel,
  points: readonly CurvePoint[] | null,
): ColorCurves | null {
  const next: ColorCurves = { ...(curves ?? {}) };
  if (points === null || isIdentityCurve(points)) delete next[channel];
  else next[channel] = normalizeCurve(points);
  return CURVE_CHANNELS.some((c) => next[c]) ? next : null;
}

/**
 * 커브를 SVG path("d") 로. 렌더러와 같은 단조 3차 보간(schema curvesToTables)을 그대로 써서
 * 미리보기 곡선과 실제 결과가 갈리지 않게 한다. y 는 위가 1 이므로 뒤집는다.
 */
export function curvePath(points: readonly CurvePoint[], w: number, h: number): string {
  const tables = curvesToTables({ rgb: normalizeCurve(points) });
  const ys = tables?.r ?? [];
  if (ys.length === 0) return '';
  const n = ys.length - 1;
  return ys
    .map((y, i) => `${i === 0 ? 'M' : 'L'}${((i / n) * w).toFixed(2)},${((1 - y) * h).toFixed(2)}`)
    .join(' ');
}

// ── W8 F3: 모션 블러 ─────────────────────────────────────────────────────
// A(소스) 와 B(트랜스폼)는 **다른 문제**다. A 는 영상 파일을 다시 굽고(느리다), B 는 합성할 때
// 겹쳐 그린다(파일을 안 굽는다). 인스펙터가 둘을 같은 이름으로 부르면 안 되는 이유다.

/** A 를 켤 때의 기본값. **`precise` 가 기본이다** — 느린 건 예상 시간으로 알리고 사용자가 고른다. */
export const DEFAULT_SOURCE_MOTION_BLUR: MotionBlurSpec = { shutterAngle: 180, quality: 'precise' };
/** B 를 켤 때의 기본값 (180° = 표준 영화 셔터, 12장). */
export const DEFAULT_TRANSFORM_BLUR: TransformBlur = { shutterAngle: 180, samples: 12 };

// 프록시 판 판정은 @kitkat/schema 의 것을 그대로 쓴다 (브라우저에서 안전한 순수 코드).
// 전에는 여기 «옮겨 적은 사본»이 있었다 — 사본은 원본이 바뀔 때 조용히 낡는다 (W8 F17 리뷰 #3).
export { PROXY_TAG, isCurrentProxy, staleProxyCount } from '@kitkat/schema';

/**
 * 1080×1920 «영상 1초»를 굽는 데 걸리는 초 (계획 03 실측).
 *
 * **@kitkat/media 의 `MOTION_BLUR_SEC_PER_SEC` 를 옮겨 적은 것이다** — 브라우저 번들에
 * ffmpeg 래퍼(node 전용)를 끌어올 수 없다. 한쪽을 고치면 다른 쪽도 고쳐야 하고,
 * `ui/test/motion-blur.test.ts` 가 두 값이 어긋나면 실패한다.
 */
export const MOTION_BLUR_SEC_PER_SEC = { precise: 77, fast: 0.8 } as const;
const MOTION_BLUR_REF_PIXELS = 1080 * 1920;

/** 셔터 각도 → 섞을 프레임 수. 2 미만이면 필터를 걸어도 항등이라 굽지 않는다. */
export function motionBlurFrames(mb: MotionBlurSpec): number {
  return mb.quality === 'precise'
    ? Math.round((8 * mb.shutterAngle) / 360)
    : Math.round((3 * mb.shutterAngle) / 180);
}

/** 소스 모션 블러 예상 소요 시간(초). 해상도에 선형 환산한다. */
export function estimateSourceMotionBlurSec(
  mb: MotionBlurSpec,
  info: { durationMs?: number; width?: number; height?: number },
): number {
  if (motionBlurFrames(mb) < 2) return 0;
  const sec = (info.durationMs ?? 0) / 1000;
  const px = (info.width ?? 1080) * (info.height ?? 1920);
  return Math.round(sec * MOTION_BLUR_SEC_PER_SEC[mb.quality] * (px / MOTION_BLUR_REF_PIXELS));
}

/** 초 → 「약 38분」 같은 사람 말. 0 이면 빈 문자열. */
export function formatEstimate(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `약 ${Math.max(1, Math.round(sec))}초`;
  const min = Math.round(sec / 60);
  if (min < 60) return `약 ${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `약 ${h}시간` : `약 ${h}시간 ${m}분`;
}

/**
 * 굽기 전에 사용자에게 물을 문장. **몰래 느린 걸 돌리지도, 몰래 빠른 걸로 바꾸지도 않는다** —
 * 시간을 적어 주고 사용자가 고른다.
 */
export function motionBlurConfirmMessage(sec: number): string {
  return `모션 블러를 적용한 영상 파일을 새로 만듭니다. ${formatEstimate(sec)} 걸립니다. 계속할까요?`;
}

// ── W5: 파생 미디어 (X1 ClipSource / M2) ─────────────────────────────────

/** 빈 파생 스펙이면 null — updateClip {source: null} 로 필드를 지운다. */
export function normalizeClipSource(src: ClipSource): ClipSource | null {
  const next: ClipSource = {};
  if (src.lut) next.lut = { assetId: src.lut.assetId, intensity: clamp01(src.lut.intensity) };
  if (src.stabilize) {
    next.stabilize = { smoothing: Math.round(clamp(src.stabilize.smoothing, 1, 100)) };
  }
  if (src.denoise) next.denoise = { amount: clamp01(src.denoise.amount) };
  if (src.pitch) next.pitch = { semitones: clamp(src.pitch.semitones, -12, 12) };
  // W8 F4·F5 — 색 맞추기와 HSL. 여기 안 실으면 LUT 슬라이더를 한 번 미는 순간
  // 사용자가 맞춰 둔 색이 조용히 사라진다 (normalizeClipSource 가 새 객체를 만들기 때문).
  if (src.matchTo) next.matchTo = { ...src.matchTo, strength: clamp01(src.matchTo.strength) };
  const hueSat = (src.hueSat ?? []).map((b) => ({
    ...b,
    hue: clamp(b.hue, -180, 180),
    saturation: clamp(b.saturation, -1, 1),
    intensity: clamp(b.intensity, -1, 1),
  }));
  if (hueSat.length > 0) next.hueSat = hueSat;
  const hsl = (src.hsl ?? []).map((s) => ({
    ...s,
    cyan: clamp(s.cyan, -1, 1),
    magenta: clamp(s.magenta, -1, 1),
    yellow: clamp(s.yellow, -1, 1),
    black: clamp(s.black, -1, 1),
  }));
  if (hsl.length > 0) next.hsl = hsl;
  if (src.motionBlur) next.motionBlur = src.motionBlur;
  // W8 F11 — 나레이션 체인. `preset: 'off'` 는 **필드째 지운다**(sourceKey 를 깨끗하게 두고
  // 필요 없는 파생을 안 만든다). 여기 안 넣으면 인스펙터가 고른 값이 조용히 사라진다.
  if (src.voice && src.voice.preset !== 'off') {
    next.voice = {
      preset: src.voice.preset,
      ...(src.voice.targetLufs !== undefined
        ? { targetLufs: clamp(src.voice.targetLufs, -30, -9) }
        : {}),
      ...(src.voice.reverb
        ? { reverb: { irId: src.voice.reverb.irId, wet: clamp01(src.voice.reverb.wet) } }
        : {}),
    };
  }
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * 파생 파일을 아직 굽는 중인가 — source 가 있는데 asset.derived[sourceKey] 가 없으면 대기.
 * 대기 중에는 미리보기·렌더가 원본을 쓴다.
 */
export function derivePending(clip: VideoClip | AudioClip, asset: Asset | undefined): boolean {
  const key = sourceKey(clip);
  if (key === null) return false;
  return !asset?.derived?.[key];
}

// ── W5: 속도 램프 (X1 SpeedRamp / M6) ────────────────────────────────────

export const RAMP_MIN_GAP = 0.01;

/** u 오름차순 정렬 + 첫 점 u=0 · 마지막 점 u=1 고정 + speed 0.1..100 클램프 (엔진 검증과 같은 규칙). */
export function normalizeRampPoints(points: readonly SpeedPoint[]): SpeedPoint[] {
  const sorted = points
    .map((p) => ({ u: clamp01(p.u), speed: clamp(p.speed, 0.1, 100) }))
    .sort((a, b) => a.u - b.u);
  const out: SpeedPoint[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev && p.u - prev.u < RAMP_MIN_GAP / 2) continue;
    out.push(p);
  }
  while (out.length < 2) out.push({ u: 1, speed: out[0]?.speed ?? 1 });
  out[0]!.u = 0;
  out[out.length - 1]!.u = 1;
  return out;
}

/** u 간격이 가장 넓은 곳 한가운데에 점을 하나 넣는다(speed 는 선형 보간). */
export function insertRampPoint(points: readonly SpeedPoint[]): SpeedPoint[] {
  const pts = normalizeRampPoints(points);
  let best = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    if (pts[i + 1]!.u - pts[i]!.u > pts[best + 1]!.u - pts[best]!.u) best = i;
  }
  const a = pts[best]!;
  const b = pts[best + 1]!;
  const u = Math.round(((a.u + b.u) / 2) * 1000) / 1000;
  if (u - a.u < RAMP_MIN_GAP || b.u - u < RAMP_MIN_GAP) return pts;
  const speed = Math.round(((a.speed + b.speed) / 2) * 100) / 100;
  return normalizeRampPoints([...pts.slice(0, best + 1), { u, speed }, ...pts.slice(best + 1)]);
}

/** 점 삭제 — 양 끝점(u=0, u=1)은 지울 수 없다. */
export function removeRampPoint(points: readonly SpeedPoint[], index: number): SpeedPoint[] {
  if (index <= 0 || index >= points.length - 1) return normalizeRampPoints(points);
  return normalizeRampPoints(points.filter((_, i) => i !== index));
}

// ═══ W8 F7: 이징 (베지어·스프링) ═════════════════════════════════════════
//
// 그리기·클램프 규칙만 여기 둔다. 이징 «계산»은 schema 의 easingFn 한 벌뿐이다 —
// 사본을 만들면 편집기에 그려진 곡선과 실제 렌더가 갈린다.

/**
 * 이징 편집기의 좌표계. 색 커브(0..1)와 달리 **y 를 −0.5..1.5 로 넓힌다** —
 * 스프링과 back 계열은 곡선이 1을 넘고 0 아래로 내려가기 때문이다.
 * 가로세로는 그대로 100×100 이라 CurvesSection 과 같은 드래그 계산·같은 CSS 를 쓴다.
 */
export const EASE_VIEW = { W: 100, H: 100, PAD: 8, Y_MIN: -0.5, Y_MAX: 1.5 } as const;

/** 이징 값(y) → SVG 세로좌표. y=1 이 위쪽 기준선, y=0 이 아래쪽 기준선. */
export function easeToSvgY(y: number): number {
  return ((EASE_VIEW.Y_MAX - y) / (EASE_VIEW.Y_MAX - EASE_VIEW.Y_MIN)) * EASE_VIEW.H;
}

/** SVG 세로좌표 → 이징 값(y). */
export function easeFromSvgY(sy: number): number {
  return EASE_VIEW.Y_MAX - (sy / EASE_VIEW.H) * (EASE_VIEW.Y_MAX - EASE_VIEW.Y_MIN);
}

export type EasingKind = 'name' | 'bezier' | 'spring';

export function easingKind(e: Easing): EasingKind {
  if (typeof e === 'string') return 'name';
  return 'spring' in e ? 'spring' : 'bezier';
}

/** 이 이징과 «같은» 프리셋의 id. easingKey 로 비교하므로 {bezier:[0.42,0,0.58,1]} 도 easeInOut 로 잡힌다. */
export function easingPresetId(e: Easing): string | null {
  const key = easingKey(e);
  return EASING_PRESETS.find((p) => easingKey(p.easing) === key)?.id ?? null;
}

/** 드롭다운·칩에 쓰는 이름. 프리셋이 아니면 「사용자 지정 …」. */
export function easingLabel(e: Easing): string {
  const id = easingPresetId(e);
  if (id) return EASING_PRESETS.find((p) => p.id === id)!.name;
  return easingKind(e) === 'spring' ? '사용자 지정 스프링' : '사용자 지정 곡선';
}

/**
 * 베지어 제어점 [p1x,p1y,p2x,p2y]. 이름 4종은 schema 와 «같은 값»을 돌려준다
 * (프리셋을 고른 뒤 점을 움직이면 그 자리에서 {bezier} 로 바뀐다 — 프리셋은 출발점이다).
 * 스프링은 제어점이 없어 null.
 */
export function easingControlPoints(e: Easing): [number, number, number, number] | null {
  if (typeof e === 'string') {
    if (e === 'easeIn') return [0.42, 0, 1, 1];
    if (e === 'easeOut') return [0, 0, 0.58, 1];
    if (e === 'easeInOut') return [0.42, 0, 0.58, 1];
    return [0, 0, 1, 1]; // linear — cubic-bezier(0,0,1,1) 은 직선과 같다
  }
  return 'bezier' in e ? [e.bezier[0], e.bezier[1], e.bezier[2], e.bezier[3]] : null;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * 제어점 하나를 옮긴 베지어 이징.
 * **x 는 0..1 로 막는다** — CSS 규격이자 스키마가 «클램프하지 않고 거부»하는 값이라,
 * 여기서 막지 않으면 드래그 한 번에 문서가 BAD_KEYFRAME 으로 튕긴다.
 * y 는 편집기가 보여 주는 −0.5..1.5 까지만(오버슈트는 살리되 화면 밖으로 못 나가게).
 */
export function moveEasingPoint(e: Easing, which: 0 | 1, x: number, y: number): Easing {
  const p = easingControlPoints(e) ?? [0.42, 0, 0.58, 1];
  const next: [number, number, number, number] = [p[0], p[1], p[2], p[3]];
  next[which * 2] = round3(clamp01(x));
  next[which * 2 + 1] = round3(clamp(y, EASE_VIEW.Y_MIN, EASE_VIEW.Y_MAX));
  return { bezier: next };
}

/** 스프링 슬라이더 3종 — 범위는 스키마(zod)와 같다. 넘으면 문서가 거부된다. */
export const SPRING_RANGES = {
  damping: { label: '감쇠', hint: '클수록 안 튕긴다', min: 1, max: 200, step: 1, digits: 0 },
  mass: { label: '무게', hint: '클수록 무겁고 느리다', min: 0.1, max: 10, step: 0.1, digits: 1 },
  stiffness: { label: '세기', hint: '클수록 빠르다', min: 1, max: 500, step: 1, digits: 0 },
} as const;

export type SpringParamKey = keyof typeof SPRING_RANGES;
export const SPRING_PARAM_KEYS: readonly SpringParamKey[] = ['damping', 'mass', 'stiffness'];

export function springConfigOf(e: Easing): SpringConfig | null {
  return typeof e === 'object' && 'spring' in e ? e.spring : null;
}

export function springParamValue(c: SpringConfig, key: SpringParamKey): number {
  return c[key] ?? SPRING_DEFAULTS[key];
}

/** 슬라이더 값 → 이징. 스프링이 아니었으면 기본값에서 시작한다. */
export function withSpringParam(e: Easing, key: SpringParamKey, v: number): Easing {
  const cur = springConfigOf(e) ?? {};
  const r = SPRING_RANGES[key];
  return { spring: { ...cur, [key]: round3(clamp(v, r.min, r.max)) } };
}

export function withOvershootClamping(e: Easing, on: boolean): Easing {
  const cur = springConfigOf(e) ?? {};
  const next: SpringConfig = { ...cur };
  if (on) next.overshootClamping = true;
  else delete next.overshootClamping;
  return { spring: next };
}

/** 「정착까지 1.84초」 — 스프링이 실제로 얼마나 오래 흔들리는지 숫자로 보여 준다. */
export function springSettleLabel(c: SpringConfig): string {
  return `정착까지 ${springSettleTimeSec(c).toFixed(2)}초`;
}

/**
 * 이징 곡선의 SVG path. **종류와 무관하게 easingFn 을 샘플링한다** —
 * 베지어면 제어점이, 스프링이면 슬라이더가 보이지만 «그림은 한 곳에서 같은 방식»으로 나온다.
 */
export function easingCurvePath(e: Easing, samples = 120): string {
  const f = easingFn(e);
  const out: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    out.push(`${i === 0 ? 'M' : 'L'}${(u * EASE_VIEW.W).toFixed(2)},${easeToSvgY(f(u)).toFixed(2)}`);
  }
  return out.join(' ');
}

/** 곡선의 최댓값(오버슈트 확인용). 1 을 넘으면 「목표를 지나쳤다 돌아온다」는 뜻이다. */
export function easingPeak(e: Easing, samples = 200): number {
  const f = easingFn(e);
  let max = 0;
  for (let i = 0; i <= samples; i++) max = Math.max(max, f(i / samples));
  return max;
}

// ═══ W8 F13: 아무 값에나 키프레임 ════════════════════════════════════════

/** 재생헤드 → 클립 기준 정수 ms (엔진이 0 이상의 정수만 받는다). */
export function clipLocalMs(clip: Clip, playheadMs: number): number {
  return Math.max(0, Math.min(clip.duration, Math.round(playheadMs - clip.start)));
}

/** `effects#<id>.params.<key>` 분해 (아니면 null). */
export function effectPathParts(path: string): { id: string; key: string } | null {
  const m = /^effects#([A-Za-z0-9_-]+)\.params\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  return m ? { id: m[1]!, key: m[2]! } : null;
}

export function effectParamPath(effectId: string, key: string): string {
  return `effects#${effectId}.params.${key}`;
}

/**
 * 경로의 한국어 라벨. 효과 경로는 그 클립의 실제 효과 종류·파라미터 이름으로 풀어 쓴다
 * (schema 의 keyframePathLabel 은 클립을 몰라서 「효과 amount」까지밖에 못 준다).
 */
export function keyframeLabel(clip: Clip, path: string): string {
  const eff = effectPathParts(path);
  if (eff) {
    const fx = ('effects' in clip ? clip.effects : undefined)?.find((x) => x.id === eff.id);
    if (!fx) return `효과(삭제됨) · ${eff.key}`;
    const def = EFFECT_PARAM_DEFS[fx.type]?.find((d) => d.key === eff.key);
    return `${EFFECT_LABELS[fx.type]} · ${def?.label ?? eff.key}`;
  }
  return keyframePathLabel(clip.kind, path);
}

/** 화이트리스트에 적힌 순서 — 그룹을 늘 같은 순서로 보여 주기 위한 것. */
function pathOrder(kind: Clip['kind'], path: string): number {
  const def = keyframePathDef(kind, path);
  if (!def) return 999;
  const i = KEYFRAME_PATHS[kind].indexOf(def);
  return i < 0 ? 999 : i;
}

export type KeyframeItem = { index: number; kf: Keyframe };

export type KeyframeGroup = {
  path: string;
  label: string;
  /** time 오름차순 */
  items: KeyframeItem[];
  /** 가리키는 대상이 지금 없다(마스크를 껐다·효과를 지웠다) — 문서에는 남고 무동작이다. */
  missing: boolean;
  /** 화이트리스트 밖 경로(손으로 고친 문서 등). null 이면 정상. */
  rejection: string | null;
};

/**
 * 키프레임을 «경로별로» 묶는다. 평평한 목록은 경로가 40개가 되면 못 쓴다.
 * 대상이 없어진 경로도 «지우지 않고» 그대로 보여 준다 — 마스크를 껐다 켜면 살아 돌아와야 한다.
 */
export function groupClipKeyframes(clip: Clip): KeyframeGroup[] {
  const kfs = clip.keyframes ?? [];
  const map = new Map<string, KeyframeItem[]>();
  kfs.forEach((kf, index) => {
    const list = map.get(kf.prop);
    if (list) list.push({ index, kf });
    else map.set(kf.prop, [{ index, kf }]);
  });
  const groups: KeyframeGroup[] = [];
  for (const [path, items] of map) {
    items.sort((a, b) => a.kf.time - b.kf.time || a.index - b.index);
    groups.push({
      path,
      label: keyframeLabel(clip, path),
      items,
      missing: readPath(clip, path) === undefined,
      rejection: keyframePathRejection(clip.kind, path),
    });
  }
  groups.sort(
    (a, b) =>
      pathOrder(clip.kind, a.path) - pathOrder(clip.kind, b.path) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return groups;
}

/** 그 시각에 «실제로 보이는» 값 — 키프레임이 이미 있으면 보간값, 없으면 클립의 현재 값. */
export function keyframeValueAt(clip: Clip, path: string, timeMs: number): number {
  const base = readPath(clip, path) ?? 0;
  return interpolateKeyframes(clip.keyframes, path, timeMs, base);
}

/**
 * 문서에 «아직 없는» 값을 화면에 보이는 값으로 실체화하는 patch.
 *
 * 왜 필요한가: 「자간」은 `style.letterSpacing` 이 없으면 0 으로 그려지고, 「크롭 X」는
 * `crop` 이 통째로 없으면 0 으로 그려진다. 그 상태로 키프레임을 걸면 엔진이
 * 「가리키는 값이 없다」며 거부한다 — 사용자 눈에는 값이 보이는데 말이다.
 * 그래서 ◆ 를 누르는 «그 순간» 보이던 값을 문서에 적어 준다.
 *
 * 부모 객체를 만들어 주는 것은 transform·crop 둘뿐이다 — 기본값이 명확한 경우다.
 * mask·chromaKey 는 «없으면 없는 것»이라 만들지 않는다(체크박스로 켜는 것이 사용자의 뜻이다).
 */
export function materializePatch(
  clip: Clip,
  path: string,
  value: number,
): Record<string, unknown> | null {
  if (!Number.isFinite(value)) return null;
  const head = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path)?.[0];
  if (!head) return null;
  const next = writePath(clip, path, value);
  if (next !== clip) return { [head]: (next as unknown as Record<string, unknown>)[head] };
  // 부모가 통째로 없는 경우 — 기본값이 분명한 것만 만들어 준다
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  const seed = m ? PARENT_SEEDS[m[1]!] : undefined;
  if (!m || !seed || (clip as unknown as Record<string, unknown>)[m[1]!] !== undefined) return null;
  return { [m[1]!]: { ...seed(), [m[2]!]: value } };
}

const PARENT_SEEDS: Record<string, () => Record<string, unknown>> = {
  transform: () => ({ ...DEFAULT_TRANSFORM }),
  crop: () => ({ ...DEFAULT_CROP }),
};

export type KeyframeDotStatus =
  | 'off' // ◇ 이 값에 키프레임 없음
  | 'on' // ◆ 재생헤드에 키프레임 있음
  | 'other' // ◈ 키프레임은 있지만 재생헤드엔 없음
  | 'blocked'; // 걸 수 없음 — title 에 이유

export type KeyframeDotState = {
  status: KeyframeDotStatus;
  title: string;
  timeMs: number;
  /** blocked 인 이유. 'rejected' = 화이트리스트 밖, 'missing' = 가리키는 값이 없음. */
  blocked: 'rejected' | 'missing' | null;
  /** 키프레임을 걸기 전에 먼저 보내야 하는 updateClip patch (없으면 null). */
  materialize: Record<string, unknown> | null;
};

/**
 * 필드 옆 마름모 버튼의 상태. 걸 수 없으면 **왜 안 되는지**를 title 에 담는다.
 * `value` 는 화면에 보이는 현재 값 — 문서에 아직 없는 값이면 이걸로 실체화한다.
 */
export function keyframeDotState(
  clip: Clip,
  path: string,
  playheadMs: number,
  value?: number,
): KeyframeDotState {
  const timeMs = clipLocalMs(clip, playheadMs);
  const base = { timeMs, blocked: null, materialize: null } as const;
  const rejection = keyframePathRejection(clip.kind, path);
  if (rejection) return { ...base, status: 'blocked', title: rejection, blocked: 'rejected' };

  let materialize: Record<string, unknown> | null = null;
  if (readPath(clip, path) === undefined) {
    materialize = value === undefined ? null : materializePatch(clip, path, value);
    if (!materialize) {
      // 엔진이 «설정 시점에 대상이 실재하는지»를 보고 거부한다 — 같은 문구로 먼저 알려 준다.
      return {
        ...base,
        status: 'blocked',
        blocked: 'missing',
        title: `'${path}' 가 가리키는 값이 이 클립에 없습니다 — 먼저 그 값을 켜고 키프레임을 거세요`,
      };
    }
  }

  const list = (clip.keyframes ?? []).filter((k) => k.prop === path);
  if (list.length === 0) {
    return { ...base, materialize, status: 'off', title: `${formatMs(timeMs)} 에 키프레임 추가` };
  }
  return list.some((k) => k.time === timeMs)
    ? { ...base, materialize, status: 'on', title: `${formatMs(timeMs)} 의 키프레임 삭제` }
    : {
        ...base,
        materialize,
        status: 'other',
        title: `키프레임 ${list.length}개 — ${formatMs(timeMs)} 에 추가`,
      };
}

/**
 * ◆ 를 한 번 눌렀을 때 보낼 명령들. 걸 수 없으면 빈 배열.
 * 실체화가 필요하면 updateClip 과 setKeyframes 를 **한 번에** 보낸다(실행취소도 한 칸).
 */
export function keyframeDotCommands(
  clip: Clip,
  path: string,
  playheadMs: number,
  value?: number,
): Command[] {
  const st = keyframeDotState(clip, path, playheadMs, value);
  if (st.status === 'blocked') return [];
  if (st.materialize) {
    const kfs = clip.keyframes ?? [];
    return [
      { type: 'updateClip', clipId: clip.id, patch: st.materialize },
      {
        type: 'setKeyframes',
        clipId: clip.id,
        keyframes: [
          ...kfs,
          {
            time: st.timeMs,
            prop: path,
            value: value ?? 0,
            easing: inheritedEasing(kfs, path, st.timeMs),
          },
        ],
      },
    ];
  }
  const next = toggleKeyframeAt(clip, path, playheadMs);
  return next ? [{ type: 'setKeyframes', clipId: clip.id, keyframes: next }] : [];
}

/** 새 키프레임의 이징 — 바로 앞 키프레임의 성격을 이어받는다(없으면 linear). */
function inheritedEasing(kfs: readonly Keyframe[], path: string, timeMs: number): Easing {
  let best: Keyframe | undefined;
  for (const k of kfs) {
    if (k.prop !== path || k.time > timeMs) continue;
    if (!best || k.time > best.time) best = k;
  }
  return best?.easing ?? 'linear';
}

/**
 * ◆ 토글 — 재생헤드 시각에 키프레임을 «현재 보이는 값»으로 추가하고, 이미 있으면 지운다.
 * 걸 수 없는 경로면 null(호출 쪽이 아무것도 보내지 않는다).
 */
export function toggleKeyframeAt(clip: Clip, path: string, playheadMs: number): Keyframe[] | null {
  const st = keyframeDotState(clip, path, playheadMs);
  if (st.status === 'blocked') return null;
  const kfs = clip.keyframes ?? [];
  if (st.status === 'on') return kfs.filter((k) => !(k.prop === path && k.time === st.timeMs));
  return [
    ...kfs,
    {
      time: st.timeMs,
      prop: path,
      value: keyframeValueAt(clip, path, st.timeMs),
      easing: inheritedEasing(kfs, path, st.timeMs),
    },
  ];
}

export function replaceKeyframe(kfs: readonly Keyframe[], index: number, kf: Keyframe): Keyframe[] {
  return kfs.map((k, i) => (i === index ? kf : k));
}

export function removeKeyframeAt(kfs: readonly Keyframe[], index: number): Keyframe[] {
  return kfs.filter((_, i) => i !== index);
}

export function removeKeyframePath(kfs: readonly Keyframe[], path: string): Keyframe[] {
  return kfs.filter((k) => k.prop !== path);
}

/**
 * 효과를 지울 때 그 효과의 키프레임도 같이 지운다.
 * 안 그러면 «가리키는 게 없는» 키프레임이 문서에 남고, 그 효과를 다시 추가해도 id 가 달라서 안 붙는다.
 */
export function keyframesWithoutEffect(kfs: readonly Keyframe[], effectId: string): Keyframe[] {
  const head = `effects#${effectId}`;
  return kfs.filter((k) => k.prop !== head && !k.prop.startsWith(`${head}.`));
}

/** 미니 타임라인: 클립 시간 → 0..1 가로 비율. */
export function keyframeRatio(clip: Clip, timeMs: number): number {
  return clip.duration > 0 ? clamp01(timeMs / clip.duration) : 0;
}

/** 미니 타임라인: 0..1 가로 비율 → 정수 ms. */
export function keyframeTimeFromRatio(clip: Clip, ratio: number): number {
  return Math.max(0, Math.min(clip.duration, Math.round(clamp01(ratio) * clip.duration)));
}

export type KeyframePathChoice = { value: string; label: string };
export type KeyframePathChoiceGroup = { group: string; options: KeyframePathChoice[] };

function choiceGroup(path: string): string {
  if (path.startsWith('effects#')) return '효과';
  if (path.startsWith('crop.')) return '크롭';
  if (path.startsWith('mask.')) return '마스크';
  if (path.startsWith('chromaKey.')) return '크로마키';
  if (path.startsWith('style.')) return '텍스트';
  if (path === 'volume') return '오디오';
  return '위치·모양';
}

/**
 * 「추가」 드롭다운 목록 — `KEYFRAME_PATHS[kind]` 에서 만든다.
 * **그 클립에 실제로 있는 효과만** 펼치고, 대상이 없는 값(마스크 꺼짐 등)은 아예 안 보여 준다
 * (엔진이 설정 시점에 거부하므로, 고를 수 있게 두면 「추가했는데 오류」가 된다).
 */
export function keyframePathChoices(clip: Clip): KeyframePathChoiceGroup[] {
  const groups = new Map<string, KeyframePathChoice[]>();
  const push = (path: string, label: string) => {
    const g = choiceGroup(path);
    const list = groups.get(g);
    if (list) list.push({ value: path, label });
    else groups.set(g, [{ value: path, label }]);
  };

  for (const def of KEYFRAME_PATHS[clip.kind]) {
    if (def.path === 'effects#*.params.*') {
      const effects = ('effects' in clip ? clip.effects : undefined) ?? [];
      for (const fx of effects) {
        for (const p of EFFECT_PARAM_DEFS[fx.type] ?? []) {
          const path = effectParamPath(fx.id, p.key);
          if (readPath(clip, path) !== undefined) push(path, `${EFFECT_LABELS[fx.type]} · ${p.label}`);
        }
      }
      continue;
    }
    if (readPath(clip, def.path) === undefined) continue;
    push(def.path, def.label);
  }
  return [...groups].map(([group, options]) => ({ group, options }));
}

// ── W8 F4: 컷 색 맞추기 ───────────────────────────────────────────────────

/**
 * 기준 클립이 «지금 보이는» 색의 identity — 파생이 있으면 그 키, 없으면 'raw'.
 * 서버 routes/match.ts 의 refSourceKeyOf 와 같은 규칙이어야 배지가 거짓말을 안 한다.
 */
export function refSourceKeyOf(ref: Clip | undefined, assets: Record<string, Asset>): string {
  if (!ref || ref.kind !== 'video') return 'raw';
  const key = sourceKey(ref);
  if (key === null) return 'raw';
  return assets[ref.assetId]?.derived?.[key] ? key : 'raw';
}

export type MatchState =
  | 'off'         // matchTo 없음
  | 'missing'     // 기준 클립이 사라졌다
  | 'unmeasured'  // 걸었지만 아직 안 쟀다 — 서버가 굽지 않는다
  | 'stale'       // 기준 컷의 색이 바뀌었다 — 다시 재야 한다
  | 'baking'      // 다 쟀고 파생을 굽는 중
  | 'ready';

/** 인스펙터 배지 상태 — 「조용히 옛 값을 쓰지 않는다」를 화면으로 지킨다. */
export function matchState(
  clip: VideoClip,
  refClip: Clip | undefined,
  assets: Record<string, Asset>,
): MatchState {
  const m = clip.source?.matchTo;
  if (!m) return 'off';
  if (!refClip) return 'missing';
  if (!m.levels) return 'unmeasured';
  if (m.levels.refSourceKey !== refSourceKeyOf(refClip, assets)) return 'stale';
  return derivePending(clip, assets[clip.assetId]) ? 'baking' : 'ready';
}

export const MATCH_STATE_LABELS: Record<MatchState, string> = {
  off: '',
  missing: '기준 컷이 사라졌습니다 — 다시 고르세요',
  unmeasured: '아직 측정 안 됨 — 「색 재기」를 누르면 굽습니다',
  stale: '기준 컷이 바뀌었습니다 — 다시 재기',
  baking: '굽는 중… (미리보기는 원본)',
  ready: '적용됨',
};

/** 문서 안에서 «기준으로 삼을 수 있는» 클립들 (자기 자신 제외, 시간순). */
export function matchCandidates(
  doc: ProjectDoc,
  selfId: string,
): { clip: Clip; label: string }[] {
  const out: { clip: Clip; label: string }[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.id === selfId) continue;
      if (clip.kind !== 'video' && clip.kind !== 'image') continue;
      const asset = doc.assets[clip.assetId];
      out.push({ clip, label: `${formatMs(clip.start)} · ${asset?.name ?? clip.assetId}` });
    }
  }
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

/** 0..1 사각형 정규화 — 드래그로 만든 사각형을 커밋하기 직전에 통과시킨다. */
export function normalizeRegion(r: Crop): Crop {
  const x = clamp01(Math.min(r.x, r.x + r.w));
  const y = clamp01(Math.min(r.y, r.y + r.h));
  const w = clamp(Math.abs(r.w), 0.01, 1 - x);
  const h = clamp(Math.abs(r.h), 0.01, 1 - y);
  return {
    x: Math.round(x * 1000) / 1000,
    y: Math.round(y * 1000) / 1000,
    w: Math.round(w * 1000) / 1000,
    h: Math.round(h * 1000) / 1000,
  };
}

// ── W8 F5: HSL 세컨더리 ───────────────────────────────────────────────────

export const HSL_FAMILY_LABELS: Record<HslFamily, string> = {
  reds: '빨강', yellows: '노랑', greens: '초록', cyans: '청록', blues: '파랑',
  magentas: '자홍', whites: '밝은 곳', neutrals: '중간톤', blacks: '어두운 곳',
};

/** 칩을 그 계열의 «실제 색» 으로 칠한다 — 글자로 읽는 것보다 훨씬 빨리 찾는다. */
export const HSL_FAMILY_SWATCH: Record<HslFamily, string> = {
  reds: '#d94b4b', yellows: '#d9c74b', greens: '#4fb64f', cyans: '#4bc9d9',
  blues: '#4b6fd9', magentas: '#c14bd9', whites: '#f2f2f2', neutrals: '#8a8a95',
  blacks: '#2a2a33',
};

export const HUESAT_BAND_LABELS: Record<HueSatBandName, string> = {
  r: '빨강', y: '노랑', g: '초록', c: '청록', b: '파랑', m: '자홍',
};

/**
 * CMYK 슬라이더 라벨은 색 이름이 아니라 «방향» 으로 쓴다 —
 * CMYK 를 모르는 사람도 슬라이더를 밀면 뭐가 되는지 안다.
 */
export const HSL_INK_FIELDS = [
  { key: 'cyan', label: '청록 ↔ 빨강' },
  { key: 'magenta', label: '자홍 ↔ 초록' },
  { key: 'yellow', label: '노랑 ↔ 파랑' },
  { key: 'black', label: '밝게 ↔ 어둡게' },
] as const;

export function emptyHsl(family: HslFamily): HslSecondary {
  return { id: newId(), family, cyan: 0, magenta: 0, yellow: 0, black: 0 };
}

export function emptyHueSat(bands: HueSatBandName[]): HueSatBand {
  return { id: newId(), bands, hue: 0, saturation: 0, intensity: 0 };
}

/** 값이 전부 0인 조정은 저장하지 않는다 — 결과가 같은 파생 파일만 하나 더 굽는다. */
export function isIdentityHsl(h: HslSecondary): boolean {
  return h.cyan === 0 && h.magenta === 0 && h.yellow === 0 && h.black === 0;
}

export function isIdentityHueSat(b: HueSatBand): boolean {
  return b.hue === 0 && b.saturation === 0 && b.intensity === 0;
}

/**
 * 프리셋을 현재 source 에 얹는다. 같은 family 는 **덮어쓴다** —
 * selectivecolor 는 계열마다 인자가 하나뿐이라 둘이 있으면 뒤엣것이 조용히 이긴다
 * (엔진도 중복을 막는다). hueSat 은 체인이라 그냥 뒤에 붙인다.
 */
export function applyColorPreset(src: ClipSource, preset: ColorPreset): ClipSource {
  const next: ClipSource = { ...src };
  if (preset.hsl && preset.hsl.length > 0) {
    const byFamily = new Map<HslFamily, HslSecondary>();
    for (const h of src.hsl ?? []) byFamily.set(h.family, h);
    for (const p of preset.hsl) {
      byFamily.set(p.family, { id: byFamily.get(p.family)?.id ?? newId(), ...p });
    }
    next.hsl = [...byFamily.values()];
  }
  if (preset.hueSat && preset.hueSat.length > 0) {
    next.hueSat = [
      ...(src.hueSat ?? []),
      ...preset.hueSat.map((p) => ({ id: newId(), ...p, bands: [...p.bands] })),
    ];
  }
  return next;
}
