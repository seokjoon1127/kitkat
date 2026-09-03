// 프리뷰 v2 — 레이아웃/전환 결과를 WebGL 유니폼으로 옮기는 순수 변환 (DOM 무의존).
// computeVisualLayout(@kitkat/renderer/layout) 이 만든 CSS·SVG 표현을 셰이더가 쓸 수 있는
// 숫자로 바꾸고, **v2 가 못 그리는 것을 목록으로 돌려준다**(정확 미리보기 배지의 근거).

import type { Mask } from '@kitkat/schema';
// 배지에 쓸 이름은 **카탈로그 한 곳에서** 온다 (W8 F16 이 효과를 50종으로 늘렸다)
import { effectDef } from '@kitkat/schema';
import type { VisualGlStage, VisualOverlay, VisualSvgFilter } from '@kitkat/renderer/layout';
import type { ChromaKeyParams, GlStageData } from '@kitkat/renderer/composition';
// **수치는 렌더러에서만 나온다** (F15 의 핵심 규약). 셰이더가 쓸 상수를 여기서 다시 계산하지 않고
// 렌더러가 실제로 그리는 것 — SVG <filter> 노드 props 와 CSS 그라디언트 문자열 — 에서 읽어낸다.
import { buildFilterNodes, lightLeakCss, maskLayerCss, scanlinesCss } from '@kitkat/renderer/composition';

// ── CSS filter → 순서 있는 색 연산 ────────────────────────────────────────

export const OP_BRIGHTNESS = 1;
export const OP_CONTRAST = 2;
export const OP_SATURATE = 3;
export const OP_HUE = 4;
export const OP_GRAYSCALE = 5;
export const OP_SEPIA = 6;
export const OP_INVERT = 7;

export type ColorOp = { op: number; arg: number };

const OP_BY_NAME: Record<string, number> = {
  brightness: OP_BRIGHTNESS,
  contrast: OP_CONTRAST,
  saturate: OP_SATURATE,
  'hue-rotate': OP_HUE,
  grayscale: OP_GRAYSCALE,
  sepia: OP_SEPIA,
  invert: OP_INVERT,
};

function parseArg(raw: string): number {
  const s = raw.trim();
  if (s.endsWith('%')) return Number(s.slice(0, -1)) / 100;
  if (s.endsWith('deg')) return Number(s.slice(0, -3));
  if (s.endsWith('px')) return Number(s.slice(0, -2));
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * `effectsToFilter` 가 만든 CSS filter 문자열 → 순서를 보존한 연산 목록 + 블러 px 합.
 * blur 만 따로 빼는 이유: 셰이더에서 픽셀별로 못 하고 밉맵 LOD 로 **근사**하기 때문이다.
 */
export function parseCssFilter(css: string): { ops: ColorOp[]; blurPx: number } {
  const ops: ColorOp[] = [];
  let blurPx = 0;
  if (!css) return { ops, blurPx };
  const re = /([a-z-]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const name = m[1] as string;
    const arg = parseArg(m[2] as string);
    if (name === 'blur') {
      blurPx += Math.max(0, arg);
      continue;
    }
    const op = OP_BY_NAME[name];
    if (op !== undefined && Number.isFinite(arg)) ops.push({ op, arg });
  }
  return { ops, blurPx };
}

/** CSS filter 한 항목 — 색 연산이거나 블러(이웃 픽셀이 필요한 «공간» 연산)다. */
export type CssChainItem = { kind: 'op'; op: number; arg: number } | { kind: 'blur'; px: number };

/**
 * `parseCssFilter` 와 같은 문자열을 읽지만 **blur 의 자리를 지키며** 목록으로 돌려준다.
 * `blur(4px) contrast(2)` 와 `contrast(2) blur(4px)` 는 결과가 다르다 —
 * blur 를 뒤로 빼서 세는 `parseCssFilter` 로는 그 차이를 그릴 수 없다.
 */
export function parseCssChain(css: string): CssChainItem[] {
  const out: CssChainItem[] = [];
  if (!css) return out;
  const re = /([a-z-]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const name = m[1] as string;
    const arg = parseArg(m[2] as string);
    if (!Number.isFinite(arg)) continue;
    if (name === 'blur') {
      if (arg > 0) out.push({ kind: 'blur', px: arg });
      continue;
    }
    const op = OP_BY_NAME[name];
    if (op !== undefined) out.push({ kind: 'op', op, arg });
  }
  return out;
}

// ── SVG 필터 체인 → 테이블 1개 + 색행렬 1개 ───────────────────────────────

export type ChannelTables = { r: number[]; g: number[]; b: number[] };

const TABLE_N = 33;

function identityTable(): number[] {
  const t: number[] = [];
  for (let i = 0; i < TABLE_N; i++) t.push(i / (TABLE_N - 1));
  return t;
}

/** 33개 테이블을 0..1 입력에 대해 선형 보간 샘플 (feFuncR type="table" 과 같은 규칙). */
export function sampleTable(table: number[], x: number): number {
  const v = Math.min(1, Math.max(0, x)) * (TABLE_N - 1);
  const i = Math.min(TABLE_N - 2, Math.floor(v));
  const f = v - i;
  return (table[i] as number) * (1 - f) + (table[i + 1] as number) * f;
}

/** 테이블 합성: 먼저 acc 를 적용하고 그 위에 next 를 적용한 하나의 테이블. */
function composeTable(acc: number[], next: number[]): number[] {
  return acc.map((v) => sampleTable(next, v));
}

/** "a b c d e ..." 20개 문자열 → 4x5 행렬 (feColorMatrix values). */
export function parseColorMatrix(values: string): number[] | null {
  const nums = values
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (nums.length !== 20 || nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

/** 4x5 색행렬 두 개를 합성 (먼저 acc, 그 다음 next). */
export function composeColorMatrix(acc: number[], next: number[]): number[] {
  const out: number[] = new Array<number>(20).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (next[r * 5 + k] as number) * (acc[k * 5 + c] as number);
      if (c === 4) s += next[r * 5 + 4] as number;
      out[r * 5 + c] = s;
    }
  }
  return out;
}

export const IDENTITY_COLOR_MATRIX: number[] = [
  1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
];

export type SvgChain = {
  /** 채널별 33개 톤 테이블 (없으면 null) */
  tables: ChannelTables | null;
  /** 4x5 색행렬 (없으면 null) */
  matrix: number[] | null;
  /** 크로마키 판정 상수 — 셰이더가 렌더러와 **같은 수식**으로 그린다 (없으면 null) */
  chroma: ChromaKeyParams | null;
  /** v2 가 못 그리는 스테이지 이름들 */
  unsupported: string[];
  /**
   * 접은 결과의 순서가 실제 체인 순서와 다르다 — v2 는 언제나 테이블 → 행렬 순으로 그린다.
   * 색조정 커브는 이제 별도 스테이지(`curvesFilters`)로 빠져 CSS 효과 **앞**에서 적용되므로
   * `effectFilters` 만 넘기면 이 값은 **highlights/shadows(테이블) 대 temperature/tint(행렬)**
   * 의 상대 순서 문제만 가리킨다. `curvesFilters` 는 스테이지가 최대 1개(커브)라 절대 참이 될 수 없다.
   */
  orderApprox: boolean;
};

/**
 * 셰이더가 **정확히 그리는** 스테이지들. 여기 없는 종류만 배지에 「미지원」으로 남는다.
 * 크로마키는 W6 T1, sharpen·glow·chromaShift 는 W8 F15 에서 들어왔다(다중 패스).
 */
const DRAWN_STAGES = new Set(['curves', 'colorMatrix', 'chromaKey', 'sharpen', 'glow', 'chromaShift']);

/**
 * 효과 id 가 아닌 «안쪽» 스테이지 이름들. 나머지는 카탈로그(`EFFECT_CATALOG`)에서 끌어온다 —
 * 손으로 적으면 F16 이 효과를 늘릴 때마다 배지에 영문 id 가 새어 나온다.
 */
const INNER_STAGE_LABEL: Record<string, string> = {
  dirBlur: '방향 블러',
  blurMix: '흐림 섞기',
  displace: '왜곡',
  edge: '윤곽',
  discrete: '계단 톤',
  linearTransfer: '선형 톤',
  colorMatrix: '색행렬',
  curves: '색보정 커브',
  chromaKey: '크로마키',
};

/** 스테이지·오버레이 종류 → 사람이 읽는 이름. 카탈로그가 첫 번째 출처다. */
export function stageLabel(kind: string): string {
  return effectDef(kind)?.name ?? INNER_STAGE_LABEL[kind] ?? kind;
}

/**
 * SVG 필터 스테이지 배열(체인 순서) → 테이블 1개 + 색행렬 1개 + 못 그리는 목록.
 * 커브들은 함수 합성으로, 색행렬들은 행렬 곱으로 하나씩 접는다.
 * **한 스테이지 배열 안**의 순서만 다루므로 커브(`curvesFilters`)와 효과(`effectFilters`)는
 * 따로 넘겨야 한다 — 합친 `svgFilters` 를 넘기면 커브가 CSS 효과 뒤로 밀린다(layerColorParams 참고).
 */
export function composeSvgChain(stages: VisualSvgFilter[]): SvgChain {
  let tables: ChannelTables | null = null;
  let matrix: number[] | null = null;
  let chroma: ChromaKeyParams | null = null;
  const unsupported: string[] = [];
  let orderApprox = false;
  let sawMatrix = false;

  for (const s of stages) {
    if (s.kind === 'curves') {
      const d = s.data as ChannelTables | undefined;
      if (!d || !Array.isArray(d.r) || d.r.length !== TABLE_N) continue;
      if (sawMatrix) orderApprox = true;
      const base: ChannelTables = tables ?? {
        r: identityTable(),
        g: identityTable(),
        b: identityTable(),
      };
      tables = {
        r: composeTable(base.r, d.r),
        g: composeTable(base.g, d.g),
        b: composeTable(base.b, d.b),
      };
      continue;
    }
    if (s.kind === 'colorMatrix') {
      const d = s.data as { values?: string } | undefined;
      const m = d?.values ? parseColorMatrix(d.values) : null;
      if (!m) continue;
      sawMatrix = true;
      matrix = matrix ? composeColorMatrix(matrix, m) : m;
      continue;
    }
    if (s.kind === 'chromaKey') {
      // 크로마키는 체인의 **맨 끝**에만 온다(computeVisualLayout 규약) → 접을 것이 없다
      const d = s.data as ChromaKeyParams | undefined;
      if (d && Array.isArray(d.c) && typeof d.t === 'number' && typeof d.w === 'number') chroma = d;
      continue;
    }
    if (DRAWN_STAGES.has(s.kind)) continue;
    const label = stageLabel(s.kind);
    if (!unsupported.includes(label)) unsupported.push(label);
  }
  return { tables, matrix, chroma, unsupported, orderApprox };
}

// ── 레이아웃 색 필드 → 셰이더 파라미터 ─────────────────────────────────────

/** `layerColorParams` 가 보는 레이아웃 필드 (VisualLayout 의 부분집합). */
export type ColorLayout = {
  cssFilter: string;
  curvesFilters: VisualSvgFilter[];
  effectFilters: VisualSvgFilter[];
  /** W8 #8 WebGL 효과 — 체인 **맨 앞**. 없거나 비어 있으면 예전과 같다. */
  glStages?: VisualGlStage[];
};

export type LayerColorParams = {
  /** 색조정 커브 테이블 — CSS 연산 **앞**에 적용한다 (없으면 null) */
  preTable: ChannelTables | null;
  /** 효과 SVG 톤 테이블 — CSS 연산 **뒤**에 적용한다 (없으면 null) */
  tables: ChannelTables | null;
  /** 효과 색행렬 — 효과 테이블 뒤 (없으면 null) */
  matrix: number[] | null;
  /** 크로마키 — 색 연산 **맨 뒤**. 알파를 깎고 디스필한다 (없으면 null) */
  chroma: ChromaKeyParams | null;
  /** CSS 효과 색 연산 (전환 연산은 호출자가 이 뒤에 붙인다) */
  ops: ColorOp[];
  /** CSS 효과의 블러 px 합 (밉맵 근사) */
  blurPx: number;
  /** 근사·미지원 항목 (배지 사유) */
  approx: string[];
};

/**
 * 레이아웃의 색 관련 필드 → 셰이더가 그릴 순서대로 나눈 파라미터.
 * 렌더러의 최종 CSS 는 `url(#curves-…) <CSS 효과> url(#fx-…)` 이므로 순서는
 * **커브 테이블 → CSS 연산 → 효과 테이블 → 효과 행렬** 이다.
 * `svgFilters`(= curvesFilters + effectFilters)를 통째로 접으면 커브가 CSS 효과 **뒤**로
 * 밀려 렌더러와 색이 달라진다 — 그래서 두 배열을 따로 접는다.
 */
export function layerColorParams(layout: ColorLayout): LayerColorParams {
  const css = parseCssFilter(layout.cssFilter);
  const curves = composeSvgChain(layout.curvesFilters);
  const effects = composeSvgChain(layout.effectFilters);
  const approx = [...curves.unsupported, ...effects.unsupported].map((s) => `${s}(미지원)`);
  if (effects.orderApprox) approx.push('색보정 순서(근사)');
  if (css.blurPx > 0) approx.push('블러(근사)');
  return {
    preTable: curves.tables,
    tables: effects.tables,
    matrix: effects.matrix,
    chroma: effects.chroma,
    ops: css.ops,
    blurPx: css.blurPx,
    approx,
  };
}

// ── 블렌드 모드 ───────────────────────────────────────────────────────────

const BLEND_CODES: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
};

export function blendModeCode(mode?: string): number {
  if (!mode) return 0;
  return BLEND_CODES[mode] ?? 0;
}

// ── 전환 스타일 → 유니폼 ──────────────────────────────────────────────────

/** 2D 아핀 [a,b,c,d,e,f]: x' = a·x + c·y + e, y' = b·x + d·y + f */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

export function multiplyAffine(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** transform-origin 50% 50% 를 반영: T(c)·M·T(-c) */
export function aboutCenter(m: Affine, cx: number, cy: number): Affine {
  return multiplyAffine(multiplyAffine([1, 0, 0, 1, cx, cy], m), [1, 0, 0, 1, -cx, -cy]);
}

/** CSS transform 문자열 → 아핀. %는 래퍼(=캔버스) 크기 기준. */
export function parseTransform(css: string, w: number, h: number): Affine {
  let m: Affine = IDENTITY_AFFINE;
  const re = /([a-zA-Z]+)\(([^)]*)\)/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(css)) !== null) {
    const name = g[1] as string;
    const args = (g[2] as string).split(',').map((s) => s.trim());
    const pct = (s: string, base: number): number =>
      s.endsWith('%') ? (Number(s.slice(0, -1)) / 100) * base : Number(s.replace('px', ''));
    let step: Affine = IDENTITY_AFFINE;
    if (name === 'translateX') step = [1, 0, 0, 1, pct(args[0] ?? '0', w), 0];
    else if (name === 'translateY') step = [1, 0, 0, 1, 0, pct(args[0] ?? '0', h)];
    else if (name === 'translate')
      step = [1, 0, 0, 1, pct(args[0] ?? '0', w), pct(args[1] ?? '0', h)];
    else if (name === 'scale') {
      const sx = Number(args[0] ?? '1');
      const sy = args[1] !== undefined ? Number(args[1]) : sx;
      step = [sx, 0, 0, sy, 0, 0];
    } else if (name === 'rotate') {
      const deg = Number((args[0] ?? '0').replace('deg', ''));
      const r = (deg * Math.PI) / 180;
      step = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
    } else {
      continue;
    }
    m = multiplyAffine(m, step);
  }
  return m;
}

export const CLIP_NONE = 0;
export const CLIP_INSET = 1;
export const CLIP_CIRCLE_IN = 2; // 원 안쪽만 보인다 (circleOpen)
export const CLIP_CIRCLE_OUT = 3; // 원 바깥만 보인다 (circleClose)

export type ClipSpec = { kind: number; p: [number, number, number, number] };

export type TransitionParams = {
  /** 캔버스 좌표계 아핀 (transform-origin 반영 완료) */
  affine: Affine;
  opacity: number;
  blurPx: number;
  /** glitch 의 hue-rotate/saturate 처럼 전환이 얹는 색 연산 */
  ops: ColorOp[];
  clips: ClipSpec[];
  /** 근사·미지원 항목 (배지 사유) */
  approx: string[];
};

type StyleLike = Record<string, unknown>;

const RADIAL_MASK_RE = /rgba\(0,\s*0,\s*0,\s*0\)\s+([\d.]+)%\s*,\s*#fff/;

/**
 * activeTransitionStyles 가 준 CSS 스타일들 → 셰이더 유니폼.
 * translate/scale/rotate/opacity/inset·circle 클립은 **그대로** 옮기고,
 * blur 는 밉맵 근사, 그 밖에 해석 못 한 속성은 approx 에 남긴다.
 */
export function transitionParams(
  styles: StyleLike[],
  canvasW: number,
  canvasH: number,
): TransitionParams {
  let raw: Affine = IDENTITY_AFFINE;
  let opacity = 1;
  let blurPx = 0;
  const ops: ColorOp[] = [];
  const clips: ClipSpec[] = [];
  const approx: string[] = [];
  const halfDiag = Math.hypot(canvasW, canvasH) / 2;

  for (const style of styles) {
    if (typeof style.opacity === 'number') opacity *= style.opacity;
    if (typeof style.transform === 'string') {
      raw = multiplyAffine(raw, parseTransform(style.transform, canvasW, canvasH));
    }
    if (typeof style.filter === 'string') {
      const f = parseCssFilter(style.filter);
      ops.push(...f.ops);
      if (f.blurPx > 0) {
        blurPx += f.blurPx;
        if (!approx.includes('전환 블러(근사)')) approx.push('전환 블러(근사)');
      }
    }
    if (typeof style.clipPath === 'string') {
      const inset = /^inset\(([^)]*)\)$/.exec(style.clipPath.trim());
      if (inset) {
        const parts = (inset[1] as string).split(/\s+/).map((s) => Number(s.replace('%', '')) / 100);
        const [t = 0, r = 0, b = 0, l = 0] = parts;
        clips.push({ kind: CLIP_INSET, p: [t, r, b, l] });
      } else {
        const circle = /^circle\(([\d.]+)%/.exec(style.clipPath.trim());
        if (circle) {
          // circle() 의 % 기준은 sqrt(w²+h²)/√2 (CSS 사양)
          const ref = Math.hypot(canvasW, canvasH) / Math.SQRT2;
          const rpx = (Number(circle[1]) / 100) * ref;
          clips.push({ kind: CLIP_CIRCLE_IN, p: [rpx, canvasW / 2, canvasH / 2, 0] });
        } else {
          approx.push('전환 클립(미지원)');
        }
      }
    }
    const mask = (style.maskImage ?? style.WebkitMaskImage) as string | undefined;
    if (typeof mask === 'string') {
      const m = RADIAL_MASK_RE.exec(mask);
      if (m) {
        // circleClose: 안쪽 gone% 가 투명 — 바깥만 보인다. 기준은 farthest-corner = 대각선/2
        const rpx = (Number(m[1]) / 100) * halfDiag;
        clips.push({ kind: CLIP_CIRCLE_OUT, p: [rpx, canvasW / 2, canvasH / 2, 0] });
      } else {
        approx.push('전환 마스크(미지원)');
      }
    }
  }

  if (clips.length > 2) {
    approx.push('전환 클립 3겹 이상(앞 2개만 적용)');
    clips.length = 2;
  }

  return {
    affine: aboutCenter(raw, canvasW / 2, canvasH / 2),
    opacity,
    blurPx,
    ops,
    clips,
    approx,
  };
}

// ═══ W8 F15 — 「못 그림」 8종의 유니폼 ══════════════════════════════════════
//
// **모든 수치는 렌더러가 실제로 그리는 것에서 읽는다.** 두 군데서 같은 수식을 쓰면 갈리기
// 때문이다(W6 색보정 커브 순서). 읽는 곳은 두 가지다:
//   (1) `buildFilterNodes()` 가 만든 SVG <filter> 노드의 props — 샤픈 커널·글로우 임계·색수차 오프셋
//   (2) 렌더러가 내보내는 CSS 그라디언트 문자열 — 마스크·스캔라인·라이트리크·글리치 덮개
// 렌더러가 저 값을 바꾸면 프리뷰가 **자동으로** 따라간다.

/** 0..1 RGBA. */
export type RGBA = [number, number, number, number];
export type GradStop = { pos: number; color: RGBA };

export type LinearGradient = {
  kind: 'linear';
  repeating: boolean;
  /** CSS 각도 (0 = 위쪽, 시계 방향) */
  angleDeg: number;
  /** 정지 위치 단위 — 'pct' 는 0..1 분수, 'px' 는 픽셀 */
  unit: 'pct' | 'px';
  stops: GradStop[];
};
export type RadialGradient = {
  kind: 'radial';
  /** 상자 대비 0..1 */
  cx: number; cy: number; rx: number; ry: number;
  /** 위치는 반지름 대비 0..1 */
  stops: GradStop[];
};
export type ParsedGradient = LinearGradient | RadialGradient;

const NAMED: Record<string, RGBA> = {
  transparent: [0, 0, 0, 0],
  white: [1, 1, 1, 1],
  black: [0, 0, 0, 1],
};

/** 최상위 쉼표로 자른다 (`rgba(0,0,0,0)` 안의 쉼표는 건너뛴다). */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function hueToRgb(p: number, q: number, t0: number): number {
  let t = t0;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** CSS 색 문자열 → 0..1 RGBA. `#fff` · `rgba()` · `hsla()` · `transparent` 만 다룬다. */
export function parseCssColor(raw: string): RGBA | null {
  const s = raw.trim().toLowerCase();
  const named = NAMED[s];
  if (named) return [...named] as RGBA;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const v = parseInt(hex, 16);
      if (!Number.isFinite(v)) return null;
      const f = (n: number): number => (((v >> n) & 0xf) * 17) / 255;
      return [f(8), f(4), f(0), 1];
    }
    if (hex.length === 6) {
      const v = parseInt(hex, 16);
      if (!Number.isFinite(v)) return null;
      return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255, 1];
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const args = splitTopLevel(fn[2] as string).map((a) => a.trim());
  const num = (i: number, fallback = 0): number => {
    const a = args[i];
    if (a === undefined) return fallback;
    const v = a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a);
    return Number.isFinite(v) ? v : fallback;
  };
  const alpha = args.length > 3 ? Math.min(1, Math.max(0, num(3, 1))) : 1;
  if ((fn[1] as string).startsWith('rgb')) {
    const c = (i: number): number => {
      const a = args[i] ?? '0';
      return a.endsWith('%') ? num(i) : num(i) / 255;
    };
    return [c(0), c(1), c(2), alpha];
  }
  // hsl: h 는 도, s·l 은 %
  const h = (((num(0) % 360) + 360) % 360) / 360;
  const sat = Math.min(1, Math.max(0, num(1)));
  const li = Math.min(1, Math.max(0, num(2)));
  if (sat === 0) return [li, li, li, alpha];
  const q = li < 0.5 ? li * (1 + sat) : li + sat - li * sat;
  const p = 2 * li - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3), alpha];
}

const SIDE_ANGLE: Record<string, number> = {
  'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
};

/**
 * CSS 위치를 채워 넣는다 — 빠진 것은 앞뒤 사이를 균등 분배하고, 순서가 뒤집힌 것은
 * 앞 값으로 끌어올린다 (CSS 그라디언트 사양의 정지 위치 정규화).
 */
function fillStops(pos: (number | null)[], lo: number, hi: number): number[] {
  const out = pos.slice();
  if (out[0] === null) out[0] = lo;
  if (out[out.length - 1] === null) out[out.length - 1] = hi;
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i] !== null) continue;
    let j = i + 1;
    while (j < out.length && out[j] === null) j++;
    const a = out[i - 1] as number;
    const b = out[j] as number;
    for (let k = i; k < j; k++) out[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j - 1;
  }
  const res = out as number[];
  for (let i = 1; i < res.length; i++) if (res[i]! < res[i - 1]!) res[i] = res[i - 1]!;
  return res;
}

/** `linear-gradient(...)` · `repeating-linear-gradient(...)` · `radial-gradient(ellipse …)` 파싱. */
export function parseGradient(css: string): ParsedGradient | null {
  const s = css.trim();
  const m = /^(repeating-)?(linear|radial)-gradient\((.*)\)$/s.exec(s);
  if (!m) return null;
  const repeating = m[1] !== undefined;
  const parts = splitTopLevel(m[3] as string);
  if (parts.length < 2) return null;
  const head = (parts[0] as string).trim();
  let first = 0;
  let angleDeg = 180;
  let ell: { cx: number; cy: number; rx: number; ry: number } | null = null;
  if (m[2] === 'linear') {
    if (SIDE_ANGLE[head] !== undefined) {
      angleDeg = SIDE_ANGLE[head] as number;
      first = 1;
    } else if (/deg$/.test(head)) {
      angleDeg = Number(head.slice(0, -3));
      first = 1;
    }
  } else {
    // `ellipse RX% RY% at CX% CY%` 만 다룬다 (렌더러 maskStyle 이 내는 형태)
    const e = /^ellipse\s+([\d.]+)%\s+([\d.]+)%\s+at\s+([\d.]+)%\s+([\d.]+)%$/.exec(head);
    if (!e) return null;
    ell = {
      rx: Number(e[1]) / 100, ry: Number(e[2]) / 100,
      cx: Number(e[3]) / 100, cy: Number(e[4]) / 100,
    };
    first = 1;
  }
  const colors: RGBA[] = [];
  const raw: (number | null)[] = [];
  let unit: 'pct' | 'px' = 'pct';
  for (let i = first; i < parts.length; i++) {
    const tok = (parts[i] as string).trim();
    // 색과 위치를 가르는 마지막 공백 — 색 안의 공백은 괄호 안이라 안전하다
    const sp = /^(.*?)(?:\s+([-\d.]+(?:%|px)))?$/s.exec(tok);
    if (!sp) return null;
    const color = parseCssColor((sp[1] as string).trim());
    if (!color) return null;
    colors.push(color);
    const p = sp[2];
    if (p === undefined) {
      raw.push(null);
    } else if (p.endsWith('%')) {
      raw.push(Number(p.slice(0, -1)) / 100);
    } else {
      unit = 'px';
      raw.push(Number(p.slice(0, -2)));
    }
  }
  if (colors.length < 2) return null;
  const hi = unit === 'px' ? (raw.filter((v) => v !== null).pop() as number) ?? 1 : 1;
  const positions = fillStops(raw, 0, hi);
  const stops: GradStop[] = colors.map((c, i) => ({ pos: positions[i] as number, color: c }));
  if (ell) return { kind: 'radial', ...ell, stops };
  return { kind: 'linear', repeating, angleDeg, unit, stops };
}

// ── 1. 마스크 ─────────────────────────────────────────────────────────────

/** 4점 알파 램프 — `ramp4()` 가 셰이더에서 그대로 읽는다. */
export type MaskRamp = { pos: [number, number, number, number]; alpha: [number, number, number, number] };

export const MASK_NONE = 0;
export const MASK_RECT = 1;
export const MASK_CIRCLE = 2;
export const MASK_LINEAR = 3;
/** 알파 텍스처 한 장 (자유 곡선 · 여러 장 겹침) — `mask-raster.ts` 가 Canvas2D 로 굽는다. */
export const MASK_TEX = 4;

export type MaskParams = {
  kind: number;
  /** circle 전용 — 상자 대비 (cx, cy, rx, ry) */
  ell: [number, number, number, number];
  /** 가로 축 램프 (rect 전용). linear·circle 에서는 안 쓴다 */
  h: MaskRamp;
  /** 세로 축 램프(rect·linear) 또는 반지름 램프(circle) */
  v: MaskRamp;
};

const FLAT_RAMP: MaskRamp = { pos: [0, 0, 1, 1], alpha: [1, 1, 1, 1] };

function rampOf(g: LinearGradient | RadialGradient): MaskRamp | null {
  const s = g.stops;
  if (s.length < 2 || s.length > 4) return null;
  const pos: number[] = [];
  const alpha: number[] = [];
  for (let i = 0; i < 4; i++) {
    const st = s[Math.min(i, s.length - 1)] as GradStop;
    pos.push(st.pos);
    alpha.push(st.color[3]);
  }
  // 모자란 자리는 마지막 정지를 «위치 1» 로 늘려 채운다 (t > 마지막 → 마지막 알파)
  for (let i = s.length; i < 4; i++) pos[i] = Math.max(1, pos[i - 1] as number);
  return {
    pos: pos as [number, number, number, number],
    alpha: alpha as [number, number, number, number],
  };
}

export type MaskShaderResult = {
  /** 4점 램프로 «셰이더가 직접» 그릴 수 있는 것 (rect · circle · linear) */
  params: MaskParams | null;
  /**
   * 램프로는 못 그린다 — 알파 텍스처를 구워야 한다(자유 곡선 · 여러 장 겹침).
   * 굽는 것은 `mask-raster.ts` 가 하고, 실패하면 그때 배지가 붙는다.
   */
  needsRaster: boolean;
};

/**
 * 클립 마스크 → 셰이더 유니폼. **렌더러 `maskLayerCss` 가 낸 CSS 를 그대로 읽는다.**
 *
 * 한 장짜리 rect·circle·linear 은 지금처럼 4점 램프로 그린다 — 더 싸고 이미 정확하다
 * (실측 평균 0.03~0.04). 자유 곡선(path)·여러 장 겹침은 `needsRaster` 로 넘긴다.
 */
export function maskShaderParams(masks: Mask[], boxW: number, boxH: number): MaskShaderResult {
  const none: MaskShaderResult = { params: null, needsRaster: false };
  const raster: MaskShaderResult = { params: null, needsRaster: true };
  if (masks.length === 0) return none;
  if (masks.length > 1) return raster;
  const css = maskLayerCss(masks, boxW, boxH, 'm') as {
    style: Record<string, unknown>;
    defs: unknown[];
  };
  // SVG <mask> 참조나 clip-path 는 도형이다 — 알파 텍스처로 굽는다
  if (css.defs.length > 0 || typeof css.style.clipPath === 'string') return raster;
  const image = css.style.maskImage;
  // 렌더러가 아무 마스크도 안 낸다(모양이 비었다) — 그릴 것이 없다
  if (typeof image !== 'string' || image.length === 0) return none;
  const grads = splitTopLevel(image).map((g) => parseGradient(g));
  if (grads.some((g) => g === null)) return raster;
  if (grads.length === 1) {
    const g = grads[0] as ParsedGradient;
    const ramp = rampOf(g);
    if (!ramp) return raster;
    if (g.kind === 'radial') {
      return {
        params: { kind: MASK_CIRCLE, ell: [g.cx, g.cy, g.rx, g.ry], h: FLAT_RAMP, v: ramp },
        needsRaster: false,
      };
    }
    // 한 장짜리 선형은 렌더러가 언제나 `to bottom` 으로 낸다
    if (Math.round(g.angleDeg) !== 180) return raster;
    return {
      params: { kind: MASK_LINEAR, ell: [0, 0, 0, 0], h: FLAT_RAMP, v: ramp },
      needsRaster: false,
    };
  }
  if (grads.length !== 2) return raster;
  // rect — `to right` 와 `to bottom` 두 장을 교차(intersect)한다
  let h: MaskRamp | null = null;
  let v: MaskRamp | null = null;
  for (const g of grads) {
    if (!g || g.kind !== 'linear') return raster;
    const r = rampOf(g);
    if (!r) return raster;
    if (Math.round(g.angleDeg) === 90) h = r;
    else if (Math.round(g.angleDeg) === 180) v = r;
  }
  if (!h || !v) return raster;
  return { params: { kind: MASK_RECT, ell: [0, 0, 0, 0], h, v }, needsRaster: false };
}

// ── 5·6·7. 오버레이 (grain · scanlines · lightLeak) ────────────────────────

export const OV_GRAIN = 1;
export const OV_SCANLINES = 2;
export const OV_LIGHTLEAK = 3;

/**
 * 그레인 오버레이의 불투명도 계수 — 렌더러 `overlays.tsx` 의 `opacity: amount * 0.6`.
 * 렌더러가 이 값을 함수로 내보내지 않아 **여기서만 중복된다.** 테스트가 이 상수를 붙잡는다.
 */
export const GRAIN_OPACITY_SCALE = 0.6;

/**
 * feTurbulence(fractalNoise, baseFrequency 0.9, numOctaves 1) 를 회색으로 만든 노이즈의
 * **실측 표준편차**(헤드리스 Chrome 에서 잰 값, `test/preview-parity-gl.mjs` 참고).
 * 해시 노이즈의 진폭을 여기에 맞춰야 그레인의 «세기»가 렌더와 같아진다.
 */
export const GRAIN_NOISE_SIGMA = 0.0778;

export type OverlayParams =
  | { kind: 1; amount: number }
  | { kind: 2; alpha: number; edge: number; period: number }
  | {
      kind: 3;
      /** 그라디언트 선 방향 (화면 좌표, y 아래) 과 길이(px) */
      dir: [number, number];
      len: number;
      /** 프리멀티플라이드 색 5개 + 위치 */
      colors: RGBA[];
      pos: number[];
    };

/**
 * `VisualOverlay` → 셰이더 유니폼. 스캔라인·라이트리크는 **렌더러가 만든 CSS 문자열**
 * (`scanlinesCss` · `lightLeakCss`) 을 파싱해서 숫자를 얻는다.
 */
export function overlayShaderParams(
  o: VisualOverlay,
  boxW: number,
  boxH: number,
): OverlayParams | null {
  const num = (v: unknown, f: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : f);
  if (o.kind === 'grain') {
    return { kind: OV_GRAIN, amount: num(o.params.amount, 0.3) * GRAIN_OPACITY_SCALE };
  }
  if (o.kind === 'scanlines') {
    const g = parseGradient(scanlinesCss(num(o.params.amount, 0.3), num(o.params.period, 2)));
    if (!g || g.kind !== 'linear' || !g.repeating || g.unit !== 'px' || g.stops.length !== 4) {
      return null;
    }
    return {
      kind: OV_SCANLINES,
      alpha: (g.stops[0] as GradStop).color[3],
      edge: (g.stops[1] as GradStop).pos,
      period: (g.stops[3] as GradStop).pos,
    };
  }
  if (o.kind === 'lightLeak') {
    const g = parseGradient(lightLeakCss(num(o.params.amount, 0.4), num(o.params.hue, 30)));
    if (!g || g.kind !== 'linear' || g.stops.length !== 5) return null;
    const r = (g.angleDeg * Math.PI) / 180;
    const sn = Math.sin(r);
    const cs = Math.cos(r);
    return {
      kind: OV_LIGHTLEAK,
      dir: [sn, -cs],
      len: Math.abs(boxW * sn) + Math.abs(boxH * cs),
      colors: g.stops.map((s) => premul(s.color)),
      pos: g.stops.map((s) => s.pos),
    };
  }
  return null;
}

/** 프리멀티플라이드로 — CSS 그라디언트는 프리멀티플라이드 공간에서 보간된다. */
export function premul(c: RGBA, opacity = 1): RGBA {
  const a = c[3] * opacity;
  return [c[0] * a, c[1] * a, c[2] * a, a];
}

// ── 8. 글리치 전환 덮개 ───────────────────────────────────────────────────

export type GlitchBand = {
  /** 캔버스 대비 0..1 */
  top: number;
  bottom: number;
  /** 가로 이동 (캔버스 대비 0..1) */
  dx: number;
  /** 프리멀티플라이드 색(요소 opacity 까지 곱한 것) 4개 + 위치 */
  colors: RGBA[];
  pos: number[];
};

export type GlitchOverlay = {
  /** multiply 스캔라인 — 어두운 띠의 실효 알파 · 띠 끝 px · 주기 px */
  scan: { alpha: number; edge: number; period: number } | null;
  bands: GlitchBand[];
};

function pctOf(v: unknown): number | null {
  if (typeof v !== 'string' || !v.endsWith('%')) return null;
  const n = Number(v.slice(0, -1));
  return Number.isFinite(n) ? n / 100 : null;
}

/**
 * `transitionOverlays('glitch', v)` 가 낸 스타일들 → 셰이더 유니폼.
 * 렌더러가 스캔 한 장 + 찢김 띠 두 장을 내므로 그 모양을 그대로 읽는다.
 */
export function glitchOverlayParams(styles: StyleLike[]): GlitchOverlay | null {
  let scan: GlitchOverlay['scan'] = null;
  const bands: GlitchBand[] = [];
  for (const st of styles) {
    const op = typeof st.opacity === 'number' ? st.opacity : 1;
    const bg = st.background;
    if (typeof bg !== 'string') return null;
    const g = parseGradient(bg);
    if (!g || g.kind !== 'linear') return null;
    if (st.mixBlendMode === 'multiply') {
      if (!g.repeating || g.unit !== 'px' || g.stops.length !== 4) return null;
      scan = {
        alpha: (g.stops[0] as GradStop).color[3] * op,
        edge: (g.stops[1] as GradStop).pos,
        period: (g.stops[3] as GradStop).pos,
      };
      continue;
    }
    if (st.mixBlendMode !== 'screen') return null;
    const top = pctOf(st.top);
    const height = pctOf(st.height);
    if (top === null || height === null) return null;
    let dx = 0;
    if (typeof st.transform === 'string') {
      const t = /translateX\(([-\d.]+)%\)/.exec(st.transform);
      if (!t) return null;
      dx = Number(t[1]) / 100;
    }
    if (Math.round(g.angleDeg) !== 90 || g.stops.length !== 4) return null;
    bands.push({
      top,
      bottom: top + height,
      dx,
      colors: g.stops.map((s) => premul(s.color, op)),
      pos: g.stops.map((s) => s.pos),
    });
  }
  if (!scan && bands.length === 0) return null;
  return { scan, bands };
}

// ── 2·3·4·9. 공간 스테이지 (샤픈 · 글로우 · 색수차 · 블러) ──────────────────

type FeNode = { type: unknown; props: Record<string, unknown> };

/** React 엘리먼트 트리를 평평하게 — `buildFilterNodes` 의 결과에서 props 를 읽으려고. */
function flattenFe(nodes: unknown, out: FeNode[] = []): FeNode[] {
  if (Array.isArray(nodes)) {
    for (const n of nodes) flattenFe(n, out);
    return out;
  }
  const el = nodes as { type?: unknown; props?: Record<string, unknown> } | null;
  if (!el || typeof el !== 'object' || el.props === undefined) return out;
  out.push({ type: el.type, props: el.props });
  flattenFe(el.props.children, out);
  return out;
}

function feNodes(kind: VisualSvgFilter['kind'], data: unknown): FeNode[] {
  return flattenFe(buildFilterNodes([{ kind, id: 's0', data }]));
}

function feNum(n: FeNode | undefined, key: string): number {
  const v = n?.props[key];
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

export type SharpenParams = { kernel: number[]; divisor: number };

/** 샤픈 3x3 커널 — **렌더러가 만든 `feConvolveMatrix` props 를 그대로 읽는다.** */
export function sharpenShaderParams(data: unknown): SharpenParams | null {
  const n = feNodes('sharpen', data).find((x) => x.type === 'feConvolveMatrix');
  if (!n) return null;
  if (String(n.props.order).trim() !== '3 3') return null;
  const kernel = String(n.props.kernelMatrix).trim().split(/\s+/).map(Number);
  if (kernel.length !== 9 || kernel.some((v) => !Number.isFinite(v))) return null;
  const divisor = feNum(n, 'divisor') || 1;
  return { kernel, divisor };
}

export type GlowParams = { slope: number; intercept: number; sigma: number; amount: number };

/** 글로우 — 임계 선형전이 · 가우시안 σ · 되얹는 세기를 렌더러 노드에서 읽는다. */
export function glowShaderParams(data: unknown): GlowParams | null {
  const nodes = feNodes('glow', data);
  const funcs = nodes.filter((n) => n.type === 'feFuncR');
  const blur = nodes.find((n) => n.type === 'feGaussianBlur');
  if (funcs.length < 2 || !blur) return null;
  return {
    slope: feNum(funcs[0], 'slope'),
    intercept: feNum(funcs[0], 'intercept'),
    sigma: feNum(blur, 'stdDeviation'),
    amount: feNum(funcs[1], 'slope'),
  };
}

/** 색수차 — R 을 미는 `feOffset` 의 dx 를 읽는다(렌더러는 -px / +px 한 쌍을 낸다). */
export function chromaShiftShaderParams(data: unknown): { px: number } | null {
  const offs = feNodes('chromaShift', data).filter((n) => n.type === 'feOffset');
  if (offs.length < 2) return null;
  return { px: -feNum(offs[0], 'dx') };
}

/**
 * SVG `feGaussianBlur` 의 **상자 필터 3연쇄** 크기 (SVG 1.1 사양 15.17).
 * 브라우저(Skia)도 이 근사를 쓴다 — 「진짜 가우시안」을 그리면 오히려 렌더러와 갈린다.
 *   d = floor(σ · 3 · √(2π)/4 + 0.5)
 *   d 가 홀수: 크기 d 상자 3번(가운데 정렬)
 *   d 가 짝수: 크기 d 두 번(경계에 반 칸씩 어긋나게) + 크기 d+1 한 번
 */
export function boxBlurPlan(sigma: number): { size: number; start: number }[] {
  if (!(sigma > 0)) return [];
  const d = Math.floor((sigma * 3 * Math.sqrt(2 * Math.PI)) / 4 + 0.5);
  if (d <= 1) return [];
  if (d % 2 === 1) {
    const start = -(d - 1) / 2;
    return [{ size: d, start }, { size: d, start }, { size: d, start }];
  }
  return [
    { size: d, start: -d / 2 },
    { size: d, start: -d / 2 + 1 },
    { size: d + 1, start: -d / 2 },
  ];
}

// ── 클립 스테이지 계획 (렌더러 체인 순서 그대로) ───────────────────────────

export type SpatialStage =
  | { kind: 'blur'; sigma: number }
  | { kind: 'sharpen'; kernel: number[]; divisor: number }
  | { kind: 'glow'; slope: number; intercept: number; sigma: number; amount: number }
  | { kind: 'shift'; px: number }
  /** W8 #8 — WebGL 효과 6종. 수치는 렌더러(`effectGlStages`)가 이미 정규화한 것 그대로다. */
  | { kind: 'gl'; stage: GlStageData };

export type ColorStage =
  | { kind: 'table'; t: ChannelTables }
  | { kind: 'ops'; ops: ColorOp[] }
  | { kind: 'matrix'; m: number[] };

export type ClipStage = SpatialStage | ColorStage;

export type ClipPlan = {
  /** 렌더러 체인 순서 그대로. 크로마키는 빼서 `chroma` 로 준다(언제나 맨 끝이라 메인 패스가 한다) */
  stages: ClipStage[];
  /** 이웃 픽셀이 필요한 스테이지가 하나라도 있으면 다중 패스를 쓴다 */
  needsPasses: boolean;
  chroma: ChromaKeyParams | null;
  approx: string[];
};

const isSpatial = (s: ClipStage): s is SpatialStage =>
  s.kind === 'blur' || s.kind === 'sharpen' || s.kind === 'glow' || s.kind === 'shift' ||
  s.kind === 'gl';

/**
 * 레이아웃 → **순서를 지킨** 스테이지 목록.
 * 렌더러의 최종 순서는 `WebGL 효과 → 커브 → CSS 효과(blur 포함) → 효과 SVG → 크로마키` 다.
 * 접어서 «테이블 하나 + 행렬 하나»로 만드는 `layerColorParams` 와 달리 여기서는 안 접는다 —
 * 접으면 `커브 → 행렬 → 커브` 같은 순서를 못 그린다(예전 배지의 «색보정 순서(근사)»).
 */
export function planClipStages(layout: ColorLayout): ClipPlan {
  const stages: ClipStage[] = [];
  const approx: string[] = [];
  let chroma: ChromaKeyParams | null = null;

  const pushSvg = (list: VisualSvgFilter[]): void => {
    for (const s of list) {
      if (s.kind === 'curves') {
        const d = s.data as ChannelTables | undefined;
        if (d && Array.isArray(d.r) && d.r.length === TABLE_N) stages.push({ kind: 'table', t: d });
        continue;
      }
      if (s.kind === 'colorMatrix') {
        const m = parseColorMatrix(((s.data as { values?: string } | undefined)?.values) ?? '');
        if (m) stages.push({ kind: 'matrix', m });
        continue;
      }
      if (s.kind === 'chromaKey') {
        const d = s.data as ChromaKeyParams | undefined;
        if (d && Array.isArray(d.c)) chroma = d;
        continue;
      }
      if (s.kind === 'sharpen') {
        const p = sharpenShaderParams(s.data);
        if (p) stages.push({ kind: 'sharpen', ...p });
        else approx.push('샤픈(미지원)');
        continue;
      }
      if (s.kind === 'glow') {
        const p = glowShaderParams(s.data);
        if (p) stages.push({ kind: 'glow', ...p });
        else approx.push('글로우(미지원)');
        continue;
      }
      if (s.kind === 'chromaShift') {
        const p = chromaShiftShaderParams(s.data);
        if (p) stages.push({ kind: 'shift', px: p.px });
        else approx.push('색수차(미지원)');
        continue;
      }
      const label = stageLabel(s.kind);
      if (!approx.includes(`${label}(미지원)`)) approx.push(`${label}(미지원)`);
    }
  };

  // W8 #8 — WebGL 효과는 소스 픽셀에 «가장 먼저» (렌더러가 캔버스로 바꿔 그린 뒤 CSS filter 를 건다)
  for (const g of layout.glStages ?? []) {
    stages.push({ kind: 'gl', stage: { kind: g.kind, data: g.data } as GlStageData });
  }
  pushSvg(layout.curvesFilters);
  let ops: ColorOp[] = [];
  const flush = (): void => {
    if (ops.length > 0) stages.push({ kind: 'ops', ops });
    ops = [];
  };
  for (const item of parseCssChain(layout.cssFilter)) {
    if (item.kind === 'blur') {
      flush();
      stages.push({ kind: 'blur', sigma: item.px });
    } else {
      ops.push({ op: item.op, arg: item.arg });
    }
  }
  flush();
  pushSvg(layout.effectFilters);

  // 접어서 그릴 수 있는가 — 공간 스테이지가 없고, 색 순서가 「테이블 → ops → 테이블 → 행렬」에
  // 들어맞으면 지금까지처럼 **단일 패스**로 간다(성능 회귀 방지).
  const hasSpatial = stages.some(isSpatial);
  const SHAPE = ['table', 'ops', 'table', 'matrix'];
  let at = 0;
  let foldable = true;
  for (const s of stages) {
    while (at < SHAPE.length && SHAPE[at] !== s.kind) at++;
    if (at >= SHAPE.length) {
      foldable = false;
      break;
    }
    at++;
  }
  return { stages, needsPasses: hasSpatial || !foldable, chroma, approx };
}

export type FlashOverlay = { color: [number, number, number]; opacity: number };

/**
 * activeTransitionOverlays → 전체 화면 덮개.
 * whiteFlash/blackFlash 같은 단색은 `flashes` 로, glitch 의 스캔·찢김 띠는 `glitch` 로 나온다
 * (W8 F15 부터 셰이더가 그린다 — 예전엔 여기서 「미지원」 배지가 붙었다).
 */
export function transitionFlashes(overlays: { key: string; style: StyleLike }[]): {
  flashes: FlashOverlay[];
  glitch: GlitchOverlay | null;
  approx: string[];
} {
  const flashes: FlashOverlay[] = [];
  const approx: string[] = [];
  const rest: StyleLike[] = [];
  for (const o of overlays) {
    const bg = o.style.backgroundColor;
    const op = typeof o.style.opacity === 'number' ? o.style.opacity : 1;
    if (bg === '#ffffff') flashes.push({ color: [1, 1, 1], opacity: op });
    else if (bg === '#000000') flashes.push({ color: [0, 0, 0], opacity: op });
    else rest.push(o.style);
  }
  let glitch: GlitchOverlay | null = null;
  if (rest.length > 0) {
    glitch = glitchOverlayParams(rest);
    if (!glitch) approx.push('전환 덮개(미지원)');
  }
  return { flashes, glitch, approx };
}
