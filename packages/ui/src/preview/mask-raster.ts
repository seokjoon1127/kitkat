// 프리뷰 v2 — **자유 곡선(펜) 마스크와 여러 장 겹치기**를 알파 텍스처 한 장으로 굽는다 (W8 F17).
//
// 셰이더에서 베지어를 직접 래스터화하지 않는다. 브라우저의 Canvas2D(`Path2D` · `filter: blur()`)
// 로 굽는 이유는 하나다 — **렌더러와 같은 Chromium/Skia 래스터라이저**라서 모양·페더가 저절로
// 같아진다. 우리가 곡선 채우기를 다시 구현하면 그 순간 「두 번째 진실」이 생긴다.
//
// 무엇을 그릴지는 **렌더러 `maskLayerCss()` 가 낸 것을 그대로 읽어서** 정한다:
//   `clip-path: path(…)`      → Path2D 로 클립 (페더 0 · 한 장)
//   `mask-image: url(#…)`     → defs 의 `SvgMaskSpec`(d/rect · σ · 반전)
//   `mask-image: <gradient>`  → CSS 그라디언트 문자열
//   `mask-composite`          → 층끼리 합치는 순서 (**아래에서부터 접는다**)
// 렌더러가 저 모양을 바꾸면 미리보기가 자동으로 따라간다.
import type { Mask } from '@kitkat/schema';
import { maskLayerCss, type SvgMaskSpec } from '@kitkat/renderer/composition';
import { parseGradient, splitTopLevel, type GradStop, type ParsedGradient } from './gl-params.js';

/** 캔버스 합성 연산자 — 렌더러 `COMPOSITE_WK` 와 **같은 이름**이다. */
export type RasterOp = 'source-over' | 'source-in' | 'source-out';

const OP_OF: Record<string, RasterOp> = {
  add: 'source-over',
  subtract: 'source-out',
  intersect: 'source-in',
  // 렌더러가 webkit 이름을 낼 때도 있어서(단일 rect) 그대로 받아 둔다
  'source-over': 'source-over',
  'source-in': 'source-in',
  'source-out': 'source-out',
};

export type RasterLayerSpec =
  /** CSS 그라디언트 한 장 (circle · linear) */
  | { kind: 'grad'; grad: ParsedGradient }
  /** 도형 한 장 — 자유 곡선(d) 또는 사각형(rect). σ 로 번지고 필요하면 알파를 뒤집는다 */
  | {
      kind: 'shape';
      d?: string;
      rect?: { x: number; y: number; width: number; height: number };
      /** `clip-path: path(evenodd, …)` 의 반전 구멍 */
      evenodd: boolean;
      /**
       * 렌더러가 `clip-path` 로 낸 것인가. 그러면 캔버스도 `clip()` 으로 그린다 — 렌더러가
       * 하는 것과 같은 «클립» 연산이라서다. (실측으로는 `fill()` 과 결과가 거의 같았다:
       * 12 를 넘는 픽셀 228개 → 223개, 최대는 52 로 같다. 모양을 맞추려는 것이지
       * 차이를 없애려는 것이 아니다.)
       */
      clipRoute: boolean;
      sigma: number;
      invert: boolean;
    };

export type MaskRasterPlan = {
  /** 상자 밖 여유 px — 번진 가장자리가 잘리지 않게 (렌더러 필터 영역과 같은 규칙) */
  pad: number;
  texW: number;
  texH: number;
  boxW: number;
  boxH: number;
  /** 층 i 를 «그 아래 결과» 위에 얹는 방식. 맨 아래(마지막)는 그냥 그린다 */
  layers: { spec: RasterLayerSpec; op: RasterOp }[];
  /** 같으면 캔버스를 다시 굽지 않는다 (d · 상자 크기 · 페더 · op 목록이 전부 들어 있다) */
  key: string;
};

/** `path("D")` · `path(evenodd, "D")` */
const CLIP_PATH_RE = /^path\(\s*(?:(evenodd|nonzero)\s*,\s*)?["']([^"']*)["']\s*\)$/;
const URL_REF_RE = /^url\(#([^)]+)\)$/;

/**
 * 여유(pad) 상한 px. 렌더러의 필터 «영역» 은 3σ 만큼 넓지만 우리는 그 크기의 **텍스처를 들고
 * 있어야** 한다 — 1080x1920 상자에 페더 0.5 면 3σ = 810 이라 텍스처 한 장이 38MiB 다.
 * 여유가 필요한 이유는 «상자 밖으로 삐져나간 모양»이 번져 들어오는 것뿐인데, 그 경우가 아니면
 * 잘라도 결과가 같다(대조에서 확인 — 페더 0.3 케이스 평균 0.01·최대 1 로 그대로다).
 */
export const MASK_PAD_MAX = 96;

/** 페더 σ → 여유 px. 렌더러 `svgMaskSpec` 의 `Math.max(2, sigma * 3)` 을 상한만 씌워 쓴다. */
function padOf(sigma: number): number {
  return Math.min(MASK_PAD_MAX, Math.ceil(Math.max(2, sigma * 3)));
}

/**
 * 마스크 목록 → 「알파 한 장을 어떻게 구울지」. 셰이더가 이미 정확히 그리는 한 장짜리
 * rect·circle·linear 은 여기 오지 않는다(`maskShaderParams` 가 먼저 걸러낸다).
 * 못 읽으면 null — 호출자가 배지에 남긴다.
 */
export function maskRasterPlan(masks: Mask[], boxW: number, boxH: number): MaskRasterPlan | null {
  if (masks.length === 0 || !(boxW > 0) || !(boxH > 0)) return null;
  const css = maskLayerCss(masks, boxW, boxH, 'r') as {
    style: Record<string, unknown>;
    defs: SvgMaskSpec[];
  };
  const layers: { spec: RasterLayerSpec; op: RasterOp }[] = [];
  let pad = 0;

  const clip = css.style.clipPath;
  if (typeof clip === 'string') {
    const m = CLIP_PATH_RE.exec(clip.trim());
    if (!m) return null;
    layers.push({
      spec: {
        kind: 'shape', d: m[2] as string, evenodd: m[1] === 'evenodd',
        clipRoute: true, sigma: 0, invert: false,
      },
      op: 'source-over',
    });
  } else {
    const image = css.style.maskImage;
    if (typeof image !== 'string' || image.length === 0) return null;
    const images = splitTopLevel(image);
    const rawOps = typeof css.style.maskComposite === 'string'
      ? splitTopLevel(css.style.maskComposite as string)
      : [];
    for (let i = 0; i < images.length; i++) {
      const src = images[i] as string;
      // CSS 목록은 짧으면 되풀이된다 — 단일 rect 의 `intersect` 하나가 두 장에 걸리는 경우
      const opName = rawOps.length > 0 ? (rawOps[i % rawOps.length] as string) : 'add';
      const op = i === images.length - 1 ? 'source-over' : OP_OF[opName];
      if (!op) return null;
      const ref = URL_REF_RE.exec(src);
      if (ref) {
        const spec = css.defs.find((d) => d.id === ref[1]);
        if (!spec) return null;
        if (!spec.d && !spec.rect) return null;
        pad = Math.max(pad, padOf(spec.sigma));
        layers.push({
          spec: {
            kind: 'shape',
            ...(spec.d ? { d: spec.d } : {}),
            ...(spec.rect ? { rect: spec.rect } : {}),
            evenodd: false,
            clipRoute: false,
            sigma: spec.sigma,
            invert: spec.invert,
          },
          op,
        });
        continue;
      }
      const grad = parseGradient(src);
      if (!grad) return null;
      // 마스크 그라디언트는 렌더러가 `to bottom`(세로) 또는 `to right`(가로) 만 낸다
      if (grad.kind === 'linear') {
        const a = Math.round(grad.angleDeg);
        if (a !== 90 && a !== 180) return null;
      }
      layers.push({ spec: { kind: 'grad', grad }, op });
    }
  }
  if (layers.length === 0) return null;

  const bw = Math.max(1, Math.ceil(boxW));
  const bh = Math.max(1, Math.ceil(boxH));
  const texW = bw + pad * 2;
  const texH = bh + pad * 2;
  const key = `${texW}x${texH}:${pad}:${Math.round(boxW * 100)}x${Math.round(boxH * 100)}|` +
    layers.map((l) => `${l.op}~${specKey(l.spec)}`).join('|');
  return { pad, texW, texH, boxW, boxH, layers, key };
}

function specKey(s: RasterLayerSpec): string {
  if (s.kind === 'grad') {
    const g = s.grad;
    const stops = g.stops.map((t) => `${t.pos.toFixed(4)}@${t.color[3].toFixed(4)}`).join(',');
    return g.kind === 'linear'
      ? `L${Math.round(g.angleDeg)};${stops}`
      : `R${g.cx.toFixed(4)},${g.cy.toFixed(4)},${g.rx.toFixed(4)},${g.ry.toFixed(4)};${stops}`;
  }
  const r = s.rect;
  return `S${s.sigma.toFixed(3)};${s.invert ? 1 : 0};${s.evenodd ? 1 : 0};${s.clipRoute ? 1 : 0};` +
    (s.d ?? `${r?.x},${r?.y},${r?.width},${r?.height}`);
}

// ── 굽기 ──────────────────────────────────────────────────────────────────

type Ctx2D = CanvasRenderingContext2D;

/** 알파만 쓰므로 색은 언제나 흰색이다 — 프리멀티플라이 보간 차이를 아예 없앤다. */
function alphaColor(a: number): string {
  return `rgba(255,255,255,${Math.min(1, Math.max(0, a))})`;
}

function addStops(g: CanvasGradient, stops: GradStop[], lo: number, hi: number): void {
  const span = hi - lo;
  for (const s of stops) {
    const t = span > 0 ? (s.pos - lo) / span : 0;
    g.addColorStop(Math.min(1, Math.max(0, t)), alphaColor(s.color[3]));
  }
}

function stopRange(stops: GradStop[]): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of stops) {
    if (s.pos < lo) lo = s.pos;
    if (s.pos > hi) hi = s.pos;
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
  return { lo, hi: hi > lo ? hi : lo + 1e-6 };
}

/** 층 한 장을 «상자 좌표계»(원점 = 상자 왼쪽 위)에 그린다. 캔버스는 pad 만큼 밀려 있다. */
function drawSpec(ctx: Ctx2D, plan: MaskRasterPlan, spec: RasterLayerSpec): void {
  const { pad, boxW, boxH, texW, texH } = plan;
  ctx.save();
  ctx.translate(pad, pad);
  if (spec.kind === 'grad') {
    const g = spec.grad;
    if (g.kind === 'linear') {
      const { lo, hi } = stopRange(g.stops);
      const vertical = Math.round(g.angleDeg) === 180;
      const len = vertical ? boxH : boxW;
      const grad = vertical
        ? ctx.createLinearGradient(0, lo * len, 0, hi * len)
        : ctx.createLinearGradient(lo * len, 0, hi * len, 0);
      addStops(grad, g.stops, lo, hi);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, boxW, boxH);
    } else {
      const rx = Math.max(1e-3, g.rx * boxW);
      const ry = Math.max(1e-3, g.ry * boxH);
      const { lo, hi } = stopRange(g.stops);
      ctx.translate(g.cx * boxW, g.cy * boxH);
      ctx.scale(rx, ry);
      const grad = ctx.createRadialGradient(0, 0, Math.max(0, lo), 0, 0, Math.max(1e-6, hi));
      addStops(grad, g.stops, lo, hi);
      ctx.fillStyle = grad;
      // 상자를 «타원 반지름 단위» 로 옮겨서 덮는다 (스케일이 걸려 있으므로)
      ctx.fillRect(
        (0 - g.cx * boxW) / rx, (0 - g.cy * boxH) / ry, boxW / rx, boxH / ry,
      );
    }
    ctx.restore();
    return;
  }
  ctx.fillStyle = '#fff';
  if (spec.sigma > 0) ctx.filter = `blur(${spec.sigma}px)`;
  if (spec.d && spec.clipRoute) {
    // 렌더러가 `clip-path` 를 쓴 자리 — 캔버스도 같은 «클립» 연산으로 맞춘다
    ctx.clip(new Path2D(spec.d), spec.evenodd ? 'evenodd' : 'nonzero');
    ctx.fillRect(-pad, -pad, texW, texH);
  } else if (spec.d) {
    ctx.fill(new Path2D(spec.d), spec.evenodd ? 'evenodd' : 'nonzero');
  } else if (spec.rect) {
    ctx.fillRect(spec.rect.x, spec.rect.y, spec.rect.width, spec.rect.height);
  }
  ctx.filter = 'none';
  ctx.restore();
  if (!spec.invert) return;
  // 반전은 **번진 뒤에** 알파만 뒤집는다 (렌더러의 `feFuncA table "1 0"` 과 같은 자리).
  // 흰색 전면을 `xor` 로 얹으면 알파가 1-a 가 되고 색은 흰색 그대로다.
  ctx.save();
  ctx.globalCompositeOperation = 'xor';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, texW, texH);
  ctx.restore();
}

/** 마스크 알파가 물리는 텍스처 유닛. 0=미디어 · 1=효과 테이블 · 2=backdrop · 3=커브 테이블. */
export const MASK_TEX_UNIT = 4;

/** 이 컴퓨터에서 Canvas2D 로 마스크를 구울 수 있는가 (테스트 환경엔 DOM 이 없다). */
export function canRasterMask(): boolean {
  return typeof document !== 'undefined' && typeof Path2D !== 'undefined';
}

/**
 * 알파 텍스처 캐시. **같은 계획이면 다시 굽지 않는다** — `d` 가 매 프레임 바뀌는
 * `dKeys` 애니메이션에서만 다시 굽는다. 프레임마다 굽으면 fps 가 죽는다.
 */
export class MaskRasterizer {
  private readonly gl: WebGL2RenderingContext;
  private readonly cache = new Map<string, WebGLTexture>();
  private acc: HTMLCanvasElement | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private hits = 0;
  private misses = 0;
  private readonly max: number;

  /**
   * 텍스처를 몇 장까지 들고 있을지. 1080x1920 + 여유 한 장이 약 10MiB 라 넉넉히 잡지 않는다
   * (한 화면에 자유 곡선 마스크가 걸린 클립이 셋 넘게 겹치는 일은 거의 없다).
   */
  constructor(gl: WebGL2RenderingContext, max = 3) {
    this.gl = gl;
    this.max = max;
  }

  /** 재사용 적중률 — 대조 하네스가 숫자로 찍는다. */
  stats(): { hits: number; misses: number; entries: number } {
    return { hits: this.hits, misses: this.misses, entries: this.cache.size };
  }

  texture(plan: MaskRasterPlan): WebGLTexture | null {
    const found = this.cache.get(plan.key);
    if (found) {
      this.hits++;
      // 최근 것을 뒤로 (Map 은 넣은 순서를 지킨다 → 앞이 가장 오래된 것)
      this.cache.delete(plan.key);
      this.cache.set(plan.key, found);
      return found;
    }
    this.misses++;
    const gl = this.gl;
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (plan.texW > limit || plan.texH > limit) return null;
    if (!canRasterMask()) return null;
    this.acc ??= document.createElement('canvas');
    this.scratch ??= document.createElement('canvas');
    const canvas = bakeMaskAlpha(plan, this.acc, this.scratch);
    if (!canvas) return null;
    const tex = gl.createTexture();
    if (!tex) return null;
    // **0 번이 아니라 마스크 전용 유닛(4)에 올린다** — 0 번에는 이미 미디어가 물려 있다
    gl.activeTexture(gl.TEXTURE0 + MASK_TEX_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    } catch {
      gl.deleteTexture(tex);
      return null;
    }
    if (this.cache.size >= this.max) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        const old = this.cache.get(oldest.value);
        if (old) gl.deleteTexture(old);
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(plan.key, tex);
    return tex;
  }

  dispose(): void {
    for (const t of this.cache.values()) this.gl.deleteTexture(t);
    this.cache.clear();
    this.acc = null;
    this.scratch = null;
  }
}

/**
 * 계획대로 알파 캔버스를 굽는다. 캔버스 두 장(`acc`·`scratch`)은 호출자가 들고 있다 —
 * 프레임마다 새로 만들면 GC 가 튄다. 대조 하네스도 이 함수를 그대로 불러 «구운 알파»를 잰다.
 */
export function bakeMaskAlpha(
  plan: MaskRasterPlan,
  acc: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
): HTMLCanvasElement | null {
  if (!canRasterMask()) return null;
  acc.width = plan.texW;
  acc.height = plan.texH;
  const a = acc.getContext('2d') as Ctx2D | null;
  if (!a) return null;
  a.setTransform(1, 0, 0, 1, 0, 0);
  a.globalCompositeOperation = 'source-over';
  a.filter = 'none';
  a.clearRect(0, 0, plan.texW, plan.texH);
  const n = plan.layers.length;
  if (n === 1) {
    drawSpec(a, plan, (plan.layers[0] as { spec: RasterLayerSpec }).spec);
    return acc;
  }
  const sc = scratch;
  sc.width = plan.texW;
  sc.height = plan.texH;
  const s = sc.getContext('2d') as Ctx2D | null;
  if (!s) return null;
  const layer = (i: number): void => {
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.filter = 'none';
    s.clearRect(0, 0, plan.texW, plan.texH);
    drawSpec(s, plan, (plan.layers[i] as { spec: RasterLayerSpec }).spec);
  };
  // **아래에서부터 접는다** — m0 op1 (m1 op2 (m2 …)). 렌더러 CSS 의 접는 방향 그대로다.
  layer(n - 1);
  a.drawImage(sc, 0, 0);
  for (let i = n - 2; i >= 0; i--) {
    layer(i);
    a.globalCompositeOperation = (plan.layers[i] as { op: RasterOp }).op;
    a.drawImage(sc, 0, 0);
  }
  a.globalCompositeOperation = 'source-over';
  return acc;
}
