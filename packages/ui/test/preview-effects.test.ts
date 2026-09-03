// W8 F15 — 「빠른 미리보기가 못 그리던 9종」의 파라미터 변환.
//
// 여기서는 **브라우저 없이** 확인할 수 있는 것만 본다:
//   (1) 셰이더가 받는 숫자가 **렌더러가 실제로 그리는 값과 같은지**
//       (렌더러의 `buildFilterNodes` props · `maskLayerCss`/`scanlinesCss`/`lightLeakCss` 문자열)
//   (2) 스테이지 순서·패스 필요 여부·표면 크기
//   (3) 셰이더 소스의 골격
// 픽셀이 실제로 같은지는 헤드리스 Chrome 이 필요해서 `preview-parity.mjs` 가 따로 잰다.
import { describe, expect, it } from 'vitest';
import type { Asset, Effect, ImageClip, Mask, VideoClip } from '@kitkat/schema';
import { EFFECT_CATALOG, PENDING_EFFECT_TYPES, effectDef } from '@kitkat/schema';
import { computeVisualLayout } from '@kitkat/renderer/layout';
import {
  activeTransitionOverlays,
  buildFilterNodes,
  lightLeakCss,
  maskLayerCss,
  scanlinesCss,
  transitionOverlays,
} from '@kitkat/renderer/composition';
import {
  MASK_CIRCLE,
  MASK_LINEAR,
  MASK_RECT,
  OV_GRAIN,
  OV_LIGHTLEAK,
  OV_SCANLINES,
  boxBlurPlan,
  chromaShiftShaderParams,
  glitchOverlayParams,
  glowShaderParams,
  maskShaderParams,
  overlayShaderParams,
  parseCssChain,
  parseCssColor,
  parseGradient,
  planClipStages,
  premul,
  sharpenShaderParams,
  splitTopLevel,
  stageLabel,
  transitionFlashes,
} from '../src/preview/gl-params.js';
import { MASK_PAD_MAX, maskRasterPlan } from '../src/preview/mask-raster.js';
import { PASS_SHADER_SRC, passSurface } from '../src/preview/gl-passes.js';
import { GLITCH_FRAG_SRC, PREVIEW_FRAG_SRC, passPadding } from '../src/preview/gl.js';
import { PARITY_MEASURED, PARITY_THRESHOLD, parityKeys, parityNote } from '../src/preview/gl-parity.js';

const W = 1920;
const H = 1080;

const ASSET: Asset = {
  id: 'a1', kind: 'image', src: 'a1.png', name: 'a1', duration: 5000, width: W, height: H,
};

function layoutOf(over: Partial<ImageClip>): ReturnType<typeof computeVisualLayout> {
  const clip = { id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 4000, ...over } as ImageClip;
  return computeVisualLayout({ clip, asset: ASSET, canvasW: W, canvasH: H, tMs: 0 });
}

const fx = (type: string, params: Record<string, number>): Effect =>
  ({ id: `e-${type}`, type, params }) as Effect;

// ── CSS 파서 ──────────────────────────────────────────────────────────────

describe('CSS 색·그라디언트 파서', () => {
  it('색 문자열 4종을 0..1 RGBA 로 읽는다', () => {
    expect(parseCssColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(parseCssColor('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseCssColor('rgba(255,0,128,0.5)')).toEqual([1, 0, 128 / 255, 0.5]);
    const hsl = parseCssColor('hsla(0,100%,50%,1)');
    expect(hsl?.[0]).toBeCloseTo(1, 6);
    expect(hsl?.[1]).toBeCloseTo(0, 6);
  });

  it('괄호 안의 쉼표를 넘어가며 자른다', () => {
    expect(splitTopLevel('rgba(0,0,0,0) 0%, #fff 50%')).toEqual(['rgba(0,0,0,0) 0%', '#fff 50%']);
  });

  it('반복 선형 그라디언트를 px 단위로 읽는다', () => {
    const g = parseGradient(scanlinesCss(0.4, 6));
    expect(g?.kind).toBe('linear');
    if (g?.kind !== 'linear') throw new Error('linear 여야 한다');
    expect(g.repeating).toBe(true);
    expect(g.unit).toBe('px');
    expect(g.angleDeg).toBe(180);
    expect(g.stops.map((s) => s.pos)).toEqual([0, 3, 3, 6]);
    expect(g.stops[0]?.color[3]).toBeCloseTo(0.3, 6); // 0.4 * 0.75
  });

  it('타원 방사 그라디언트의 중심·반지름을 읽는다', () => {
    const g = parseGradient('radial-gradient(ellipse 30% 40% at 50% 60%, #fff 70%, transparent 100%)');
    expect(g?.kind).toBe('radial');
    if (g?.kind !== 'radial') throw new Error('radial 이어야 한다');
    expect([g.rx, g.ry, g.cx, g.cy]).toEqual([0.3, 0.4, 0.5, 0.6]);
    expect(g.stops.map((s) => s.pos)).toEqual([0.7, 1]);
  });

  it('프리멀티플라이드 변환은 알파를 곱한다', () => {
    expect(premul([1, 0.5, 0, 0.4], 0.5)).toEqual([0.2, 0.1, 0, 0.2]);
  });
});

// ── 1. 마스크 ─────────────────────────────────────────────────────────────

describe('마스크 → 셰이더 유니폼', () => {
  const rect: Mask = { shape: 'rect', feather: 0.4, x: 0.1, y: 0.2, w: 0.6, h: 0.5 };

  it('rect 는 두 축 램프로 나온다 (렌더러 CSS 의 정지 위치 그대로)', () => {
    const r = maskShaderParams([rect], 1000, 500);
    expect(r.needsRaster).toBe(false);
    expect(r.params?.kind).toBe(MASK_RECT);
    // 렌더러: to right → x, x+fx, x+w-fx, x+w  (fx = feather*w/2)
    const fxw = (0.4 * 0.6) / 2;
    expect(r.params?.h.pos.map((v) => Number(v.toFixed(4)))).toEqual(
      [0.1, 0.1 + fxw, 0.1 + 0.6 - fxw, 0.7].map((v) => Number(v.toFixed(4))),
    );
    expect(r.params?.h.alpha).toEqual([0, 1, 1, 0]);
  });

  it('반전 rect 는 알파가 뒤집힌다 (1-알파가 아니라 두 축을 각각 뒤집어 곱한다)', () => {
    const r = maskShaderParams([{ ...rect, invert: true }], 1000, 500);
    expect(r.params?.h.alpha).toEqual([1, 0, 0, 1]);
    expect(r.params?.v.alpha).toEqual([1, 0, 0, 1]);
  });

  it('circle 은 타원 중심·반지름과 반지름 램프로 나온다', () => {
    const r = maskShaderParams([{ shape: 'circle', feather: 0.25, x: 0.2, y: 0.1, w: 0.5, h: 0.8 }], 800, 600);
    expect(r.params?.kind).toBe(MASK_CIRCLE);
    expect(r.params?.ell).toEqual([0.2 + 0.25, 0.1 + 0.4, 0.25, 0.4]);
    expect(r.params?.v.pos[0]).toBeCloseTo(0.75, 6); // solid = 1 - feather
    expect(r.params?.v.alpha[0]).toBe(1);
  });

  it('linear 은 세로 램프만 쓴다', () => {
    const r = maskShaderParams([{ shape: 'linear', feather: 0.3, x: 0, y: 0.1, w: 1, h: 0.6 }], 800, 600);
    expect(r.params?.kind).toBe(MASK_LINEAR);
    expect(r.params?.v.pos[0]).toBeCloseTo(0.1, 6);
    expect(r.params?.v.pos[3]).toBeCloseTo(0.7, 6);
  });

  it('자유 곡선·여러 장은 램프가 아니라 «구운 알파» 경로로 넘어간다 (W8 F17)', () => {
    const path: Mask = { shape: 'path', feather: 0.2, x: 0, y: 0, w: 1, h: 1, d: 'M 0,0 L 1,0 L 1,1 Z' };
    expect(maskShaderParams([path], 100, 100)).toEqual({ params: null, needsRaster: true });
    // 페더 0 은 렌더러가 clip-path 로 낸다 — 그것도 구워야 한다
    expect(maskShaderParams([{ ...path, feather: 0 }], 100, 100).needsRaster).toBe(true);
    expect(maskShaderParams([rect, rect], 100, 100).needsRaster).toBe(true);
    expect(maskShaderParams([], 100, 100)).toEqual({ params: null, needsRaster: false });
  });

  it('한 장짜리 rect·circle·linear 은 굽지 않는다 (지금 셰이더가 더 싸고 이미 정확하다)', () => {
    for (const m of [
      rect,
      { shape: 'circle', feather: 0.25, x: 0.2, y: 0.1, w: 0.5, h: 0.8 } as Mask,
      { shape: 'linear', feather: 0.3, x: 0, y: 0.1, w: 1, h: 0.6 } as Mask,
    ]) {
      expect(maskShaderParams([m], 1000, 500).needsRaster).toBe(false);
    }
  });

  it('램프 위치가 렌더러가 낸 CSS 와 자릿수까지 같다', () => {
    const css = maskLayerCss([rect], 1000, 500, 'm').style as Record<string, string>;
    const g = parseGradient(splitTopLevel(css.maskImage as string)[1] as string);
    const r = maskShaderParams([rect], 1000, 500);
    if (g?.kind !== 'linear') throw new Error('linear 여야 한다');
    expect(r.params?.v.pos.slice(0, g.stops.length)).toEqual(g.stops.map((s) => s.pos));
  });
});

// ── 1-b. 자유 곡선·여러 장 → 구울 알파의 «계획» (W8 F17) ───────────────────

describe('마스크 알파 굽기 계획', () => {
  const D = 'M 0.1,0.1 C 0.9,0.1 0.9,0.9 0.5,0.9 L 0.1,0.5 Z';
  const path = (over: Partial<Mask> = {}): Mask =>
    ({ shape: 'path', feather: 0, x: 0.1, y: 0.1, w: 0.8, h: 0.8, d: D, ...over }) as Mask;

  it('페더 0 한 장은 clip-path 경로다 — 여유(pad) 없이 상자 크기 그대로 굽는다', () => {
    const p = maskRasterPlan([path()], 400, 300);
    expect(p?.layers).toHaveLength(1);
    const s = p?.layers[0]?.spec;
    if (s?.kind !== 'shape') throw new Error('shape 여야 한다');
    expect(s.clipRoute).toBe(true);
    expect(s.sigma).toBe(0);
    expect(p?.pad).toBe(0);
    expect([p?.texW, p?.texH]).toEqual([400, 300]);
    // 좌표는 «마스크 상자 0..1» → 클립 상자 px 로 옮겨져 있다 (0.1 → 0.1+0.1*0.8 = 0.18 → 72)
    expect(s.d).toContain('M 72,54');
  });

  it('페더가 있으면 SVG <mask> 경로 — σ 는 렌더러 maskSigma, 여유는 3σ', () => {
    const p = maskRasterPlan([path({ feather: 0.2 })], 400, 300);
    const s = p?.layers[0]?.spec;
    if (s?.kind !== 'shape') throw new Error('shape 여야 한다');
    expect(s.clipRoute).toBe(false);
    expect(s.sigma).toBeCloseTo((0.2 * 300) / 2, 6); // maskSigma = feather·min(w,h)/2
    expect(p?.pad).toBe(Math.ceil(3 * 30));
    expect([p?.texW, p?.texH]).toEqual([400 + 180, 300 + 180]);
  });

  it('여유는 96px 에서 끊는다 — 안 끊으면 세로 영상 마스크 한 장이 38MiB 가 된다', () => {
    // 1080x1920 · 페더 0.5 → σ = 270 → 3σ = 810
    const p = maskRasterPlan([path({ feather: 0.5 })], 1080, 1920);
    expect(p?.pad).toBe(MASK_PAD_MAX);
    expect((p as { texW: number }).texW * (p as { texH: number }).texH * 4)
      .toBeLessThan(12 * 1024 * 1024);
  });

  it('반전 — 페더 0 은 evenodd 구멍, 페더가 있으면 알파를 뒤집는다', () => {
    const hard = maskRasterPlan([path({ invert: true })], 400, 300)?.layers[0]?.spec;
    if (hard?.kind !== 'shape') throw new Error('shape 여야 한다');
    expect(hard.evenodd).toBe(true);
    expect(hard.invert).toBe(false);
    const soft = maskRasterPlan([path({ feather: 0.2, invert: true })], 400, 300)?.layers[0]?.spec;
    if (soft?.kind !== 'shape') throw new Error('shape 여야 한다');
    expect(soft.invert).toBe(true);
  });

  it('여러 장은 «아래에서부터» 접고, 층 i 의 합성은 masks[i+1] 의 op 다', () => {
    const circle: Mask = { shape: 'circle', feather: 0.2, x: 0, y: 0, w: 0.6, h: 0.6 };
    for (const [op, want] of [
      ['add', 'source-over'], ['subtract', 'source-out'], ['intersect', 'source-in'],
    ] as const) {
      const p = maskRasterPlan([circle, path({ feather: 0.1, op })], 400, 300);
      expect(p?.layers.map((l) => l.op)).toEqual([want, 'source-over']);
      // 그라디언트로 되는 모양(circle)은 그라디언트로, 나머지는 도형으로 온다
      expect(p?.layers[0]?.spec.kind).toBe('grad');
      expect(p?.layers[1]?.spec.kind).toBe('shape');
    }
  });

  it('3장 이상도 순서대로 — rect 는 도형, linear 는 그라디언트', () => {
    const p = maskRasterPlan([
      { shape: 'rect', feather: 0.1, x: 0, y: 0, w: 1, h: 1 },
      { shape: 'linear', feather: 0.2, x: 0, y: 0, w: 1, h: 1, op: 'intersect' },
      path({ feather: 0.1, op: 'add' }),
    ], 400, 300);
    expect(p?.layers.map((l) => l.spec.kind)).toEqual(['shape', 'grad', 'shape']);
    expect(p?.layers.map((l) => l.op)).toEqual(['source-in', 'source-over', 'source-over']);
  });

  it('캐시 키는 모양·상자 크기·페더가 같으면 같고, 하나라도 다르면 달라진다', () => {
    const a = maskRasterPlan([path({ feather: 0.1 })], 400, 300) as { key: string };
    const b = maskRasterPlan([path({ feather: 0.1 })], 400, 300) as { key: string };
    expect(a.key).toBe(b.key);
    const moved = maskRasterPlan([path({ feather: 0.1, d: D.replace('0.5,0.9', '0.55,0.9') })], 400, 300);
    expect(moved?.key).not.toBe(a.key);
    expect(maskRasterPlan([path({ feather: 0.11 })], 400, 300)?.key).not.toBe(a.key);
    expect(maskRasterPlan([path({ feather: 0.1 })], 401, 300)?.key).not.toBe(a.key);
  });

  it('모양이 비었거나 상자가 0 이면 계획이 없다 (호출자가 배지를 붙인다)', () => {
    expect(maskRasterPlan([], 400, 300)).toBeNull();
    expect(maskRasterPlan([path()], 0, 300)).toBeNull();
    expect(maskRasterPlan([{ ...path(), d: 'nonsense' }], 400, 300)).toBeNull();
  });
});

// ── 2·3·4. 샤픈 · 글로우 · 색수차 (렌더러 <filter> props 에서 읽는다) ────────

describe('SVG 스테이지 → 셰이더 상수', () => {
  it('샤픈 커널은 렌더러 feConvolveMatrix 의 kernelMatrix 그대로다', () => {
    const p = sharpenShaderParams({ amount: 1.4 });
    const nodes = buildFilterNodes([{ kind: 'sharpen', id: 's0', data: { amount: 1.4 } }]);
    const el = nodes[0] as { props: { kernelMatrix: string; divisor: number } };
    expect(p?.kernel).toEqual(el.props.kernelMatrix.trim().split(/\s+/).map(Number));
    expect(p?.divisor).toBe(el.props.divisor);
    // amount 1.4 → a = 0.7 → 가운데 1+4a = 3.8
    expect(p?.kernel[4]).toBeCloseTo(3.8, 6);
  });

  it('글로우 임계·번짐·세기를 렌더러 노드에서 읽는다', () => {
    const p = glowShaderParams({ amount: 0.8, radius: 16 });
    expect(p?.sigma).toBe(8); // radius / 2
    expect(p?.amount).toBe(0.8);
    // 임계 0.65 → slope = 1/(1-0.65)
    expect(p?.slope).toBeCloseTo(1 / 0.35, 3);
    expect(p?.intercept).toBeCloseTo(-0.65 / 0.35, 3);
  });

  it('색수차 오프셋은 feOffset 의 dx 부호를 뒤집은 값이다', () => {
    expect(chromaShiftShaderParams({ px: 6 })?.px).toBe(6);
  });
});

// ── 5·6·7. 오버레이 ───────────────────────────────────────────────────────

describe('오버레이 → 셰이더 유니폼', () => {
  it('그레인은 요소 불투명도(amount x 0.6)를 그대로 쓴다', () => {
    const p = overlayShaderParams({ kind: 'grain', params: { amount: 0.5 } }, 100, 100);
    expect(p?.kind).toBe(OV_GRAIN);
    if (p?.kind !== OV_GRAIN) throw new Error('grain');
    expect(p.amount).toBeCloseTo(0.3, 6);
  });

  it('스캔라인 알파·주기가 렌더러 CSS 와 같다', () => {
    const p = overlayShaderParams(
      { kind: 'scanlines', params: { amount: 0.6, lines: 600, period: 4 } }, 100, 100,
    );
    if (p?.kind !== OV_SCANLINES) throw new Error('scanlines');
    expect(p.alpha).toBeCloseTo(0.45, 6); // 0.6 * 0.75
    expect(p.edge).toBe(2);
    expect(p.period).toBe(4);
    expect(scanlinesCss(0.6, 4)).toContain('rgba(0,0,0,0.45)');
  });

  it('라이트리크 정지 5개를 프리멀티플라이드로 옮기고 115도 방향을 잡는다', () => {
    const p = overlayShaderParams({ kind: 'lightLeak', params: { amount: 0.7, hue: 30 } }, 1000, 500);
    if (p?.kind !== OV_LIGHTLEAK) throw new Error('lightLeak');
    expect(p.colors).toHaveLength(5);
    expect(p.pos).toEqual([0, 0.38, 0.52, 0.64, 0.84]);
    // 첫·마지막은 투명
    expect(p.colors[0]).toEqual([0, 0, 0, 0]);
    expect(p.colors[4]).toEqual([0, 0, 0, 0]);
    // 가운데 정지의 알파 = amount
    expect(p.colors[2]?.[3]).toBeCloseTo(0.7, 6);
    // 방향 (sin115, -cos115) · 길이 = |w sin| + |h cos|
    const r = (115 * Math.PI) / 180;
    expect(p.dir[0]).toBeCloseTo(Math.sin(r), 9);
    expect(p.len).toBeCloseTo(Math.abs(1000 * Math.sin(r)) + Math.abs(500 * Math.cos(r)), 6);
    expect(lightLeakCss(0.7, 30)).toContain('115deg');
  });
});

// ── 8. 글리치 덮개 ────────────────────────────────────────────────────────

describe('글리치 전환 덮개', () => {
  it('스캔라인 한 장 + 찢김 띠 두 장을 유니폼으로 푼다', () => {
    const styles = transitionOverlays('glitch', 0.4).map((o) => o.style as Record<string, unknown>);
    const g = glitchOverlayParams(styles);
    expect(g?.scan?.period).toBe(5);
    expect(g?.scan?.edge).toBe(2);
    // 어두운 띠 알파 0.5 x 요소 opacity(gone x 0.55 = 0.33)
    expect(g?.scan?.alpha).toBeCloseTo(0.165, 6);
    expect(g?.bands).toHaveLength(2);
    for (const b of g?.bands ?? []) {
      expect(b.bottom).toBeGreaterThan(b.top);
      expect(b.colors).toHaveLength(4);
      // 첫·마지막 정지는 완전 투명, 가운데 둘은 색이 있다
      expect(b.colors[0]).toEqual([0, 0, 0, 0]);
      expect(b.colors[3]).toEqual([0, 0, 0, 0]);
      expect(b.colors[1]?.[3]).toBeGreaterThan(0);
    }
    // 두 띠는 정지 위치가 서로 다르다 (렌더러가 그렇게 낸다)
    expect(g?.bands[0]?.pos).toEqual([0, 0.32, 0.7, 1]);
    expect(g?.bands[1]?.pos).toEqual([0, 0.4, 0.78, 1]);
  });

  it('transitionFlashes 가 단색 덮개와 글리치를 나눠 준다', () => {
    const t = transitionFlashes(
      activeTransitionOverlays(500, 2000, { type: 'glitch', duration: 1000 }) as {
        key: string; style: Record<string, unknown>;
      }[],
    );
    expect(t.flashes).toEqual([]);
    expect(t.glitch).not.toBeNull();
    expect(t.approx).toEqual([]);
  });
});

// ── 9. 블러 (SVG 사양의 상자 3연쇄) ────────────────────────────────────────

describe('가우시안 → 상자 3연쇄', () => {
  it('σ 가 작으면 상자가 없다 (사양의 d <= 1)', () => {
    expect(boxBlurPlan(0)).toEqual([]);
    expect(boxBlurPlan(0.4)).toEqual([]);
  });

  it('d 가 홀수면 같은 크기 상자 3개를 가운데 정렬한다', () => {
    // σ=8 → d = floor(8*3*√(2π)/4 + 0.5) = 15
    const p = boxBlurPlan(8);
    expect(p.map((b) => b.size)).toEqual([15, 15, 15]);
    expect(p.map((b) => b.start)).toEqual([-7, -7, -7]);
  });

  it('d 가 짝수면 반 칸씩 어긋난 상자 2개 + 한 칸 큰 상자 1개다', () => {
    // σ=4.25 → d = floor(4.25*1.8800 + 0.5) = 8
    const p = boxBlurPlan(4.25);
    expect(p.map((b) => b.size)).toEqual([8, 8, 9]);
    expect(p.map((b) => b.start)).toEqual([-4, -3, -4]);
  });

  // 상자 3연쇄는 **가우시안의 근사**라 σ 가 정확히 재현되지 않는다(사양이 그렇다).
  // 브라우저도 같은 근사를 쓰므로 «진짜 가우시안»을 그리면 오히려 렌더러와 갈린다.
  it('합이 σ 를 7% 안쪽으로 재현한다 (사양의 근사 오차)', () => {
    for (const sigma of [3, 8, 12, 20]) {
      const p = boxBlurPlan(sigma);
      const v = p.reduce((a, b) => a + (b.size * b.size - 1) / 12, 0);
      expect(Math.abs(Math.sqrt(v) - sigma) / sigma, `σ=${sigma}`).toBeLessThan(0.07);
    }
  });
});

// ── 스테이지 계획 ─────────────────────────────────────────────────────────

describe('클립 스테이지 계획', () => {
  it('blur 의 자리가 유지된다 (앞뒤로 다른 색 연산이 붙는다)', () => {
    const items = parseCssChain('brightness(1.2) blur(4px) contrast(0.8)');
    expect(items.map((i) => i.kind)).toEqual(['op', 'blur', 'op']);
  });

  it('렌더러 체인 순서 그대로 스테이지가 늘어선다', () => {
    const L = layoutOf({
      curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      effects: [
        fx('brightness', { amount: 1.2 }),
        fx('blur', { px: 5 }),
        fx('temperature', { amount: 0.5 }),
        fx('sharpen', { amount: 1 }),
        fx('glow', { amount: 0.5, radius: 10 }),
        fx('chromaShift', { px: 3 }),
      ],
    });
    const plan = planClipStages(L);
    expect(plan.stages.map((s) => s.kind)).toEqual([
      'table', 'ops', 'blur', 'matrix', 'sharpen', 'glow', 'shift',
    ]);
    expect(plan.needsPasses).toBe(true);
    expect(plan.approx).toEqual([]);
  });

  it('색만 있는 클립은 패스를 안 쓴다 (단일 패스 성능 유지)', () => {
    const plan = planClipStages(layoutOf({ effects: [fx('brightness', { amount: 1.1 })] }));
    expect(plan.needsPasses).toBe(false);
    expect(plan.stages.map((s) => s.kind)).toEqual(['ops']);
  });

  it('접을 수 없는 색 순서(행렬 → 테이블)면 패스로 간다 — 예전의 「색보정 순서(근사)」', () => {
    const plan = planClipStages(
      layoutOf({ effects: [fx('temperature', { amount: 1 }), fx('highlights', { amount: 0.5 })] }),
    );
    expect(plan.stages.map((s) => s.kind)).toEqual(['matrix', 'table']);
    expect(plan.needsPasses).toBe(true);
  });

  it('크로마키는 스테이지가 아니라 따로 나온다 (언제나 체인 끝)', () => {
    const clip: VideoClip = {
      id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 4000,
      in: 0, out: 4000, speed: 1, volume: 1,
      chromaKey: { color: '#00b140', similarity: 0.4, smoothness: 0.1 },
      effects: [fx('sharpen', { amount: 1 })],
    };
    const L = computeVisualLayout({ clip, asset: ASSET, canvasW: W, canvasH: H, tMs: 0 });
    const plan = planClipStages(L);
    expect(plan.stages.map((s) => s.kind)).toEqual(['sharpen']);
    expect(plan.chroma).not.toBeNull();
  });
});

// ── 패스 표면 ─────────────────────────────────────────────────────────────

describe('패스 표면', () => {
  it('여유는 좌우·상하 대칭이고 변은 4의 배수다', () => {
    const s = passSurface(480, 270, 1);
    expect(s.width % 4).toBe(0);
    expect(s.height % 4).toBe(0);
    expect(s.width).toBe(480 + 2 * s.padLeft);
    expect(s.height).toBe(270 + 2 * s.padTop);
    expect(s.padLeft).toBeGreaterThanOrEqual(1);
    expect(s.padTop).toBeGreaterThanOrEqual(1);
  });

  it('여유 0 이면 미디어 크기 그대로', () => {
    const s = passSurface(1920, 1080, 0);
    expect([s.width, s.height, s.padLeft, s.padTop]).toEqual([1920, 1080, 0, 0]);
  });

  it('여유는 스테이지가 번지는 거리만큼 잡는다', () => {
    expect(passPadding([{ kind: 'blur', sigma: 8 }])).toBe(24);
    expect(passPadding([{ kind: 'shift', px: 6 }])).toBe(6);
    expect(passPadding([{ kind: 'sharpen', kernel: [], divisor: 1 }])).toBe(1);
    expect(passPadding([{ kind: 'blur', sigma: 100 }])).toBe(96); // 상한
    expect(passPadding([], 4)).toBe(12);
  });
});

// ── 배지 (「못 그림」 → 「이만큼 다름」) ────────────────────────────────────

describe('배지 — 실측 차이', () => {
  it('그린 효과들의 표 키를 뽑는다', () => {
    const L = layoutOf({
      mask: { shape: 'rect', feather: 0.2, x: 0, y: 0, w: 1, h: 1 },
      effects: [fx('blur', { px: 4 }), fx('glow', { amount: 0.5, radius: 8 }), fx('grain', { amount: 0.4 })],
    });
    expect(parityKeys(L).sort()).toEqual(['blur', 'glow', 'grain', 'mask']);
    expect(parityKeys(layoutOf({}), true)).toEqual(['glitch']);
  });

  it('차이가 1 이하면 배지를 안 띄운다', () => {
    expect(parityNote(['mask'])).toBeNull();
    expect(parityNote(['chromaShift', 'sharpen'])).toBeNull();
    expect(parityNote([])).toBeNull();
  });

  it('차이가 크면 실측 숫자를 문장으로 낸다', () => {
    const note = parityNote(['grain', 'blur']);
    expect(note).toContain('그레인');
    expect(note).toContain('최대 28');
    expect(note).toContain('노이즈 무늬');
  });

  it('자유 곡선·여러 장은 마스크와 다른 표 키로 잰다 (W8 F17)', () => {
    const D = 'M 0.1,0.1 L 0.9,0.1 L 0.5,0.9 Z';
    const soft = layoutOf({ mask: { shape: 'path', feather: 0.3, x: 0, y: 0, w: 1, h: 1, d: D } });
    expect(parityKeys(soft)).toEqual(['maskPath']);
    // 페더가 0 이거나 σ 가 1px 아래면 하드 엣지 — AA 가 갈리는 쪽이라 따로 잰다
    const hard = layoutOf({ mask: { shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1, d: D } });
    expect(parityKeys(hard)).toEqual(['maskPathHard']);
    const many = layoutOf({
      masks: [
        { shape: 'circle', feather: 0.2, x: 0, y: 0, w: 1, h: 1 },
        { shape: 'circle', feather: 0.2, x: 0.2, y: 0, w: 0.6, h: 1, op: 'subtract' },
      ],
    });
    expect(parityKeys(many)).toEqual(['maskPath']);
  });

  it('실측표는 그레인과 «페더 0 자유 곡선»만 임계를 못 맞춘다', () => {
    const over = Object.entries(PARITY_MEASURED).filter(
      ([, d]) => d.mean > PARITY_THRESHOLD.mean || d.max > PARITY_THRESHOLD.max,
    );
    expect(over.map(([k]) => k).sort()).toEqual(['grain', 'maskPathHard']);
    expect(PARITY_MEASURED.grain?.why).toBeTruthy();
    expect(PARITY_MEASURED.maskPathHard?.why).toBeTruthy();
    // 평균은 임계 안이다 — 갈리는 것은 윤곽선뿐이라는 뜻이다
    expect(PARITY_MEASURED.maskPathHard?.mean).toBeLessThan(PARITY_THRESHOLD.mean);
  });
});

// ── 셰이더 소스 ───────────────────────────────────────────────────────────

describe('셰이더 소스', () => {
  const all = [PREVIEW_FRAG_SRC, GLITCH_FRAG_SRC, ...Object.values(PASS_SHADER_SRC)];

  it('전부 GLSL ES 3.00 골격이다', () => {
    for (const src of all) {
      expect(src.startsWith('#version 300 es\n')).toBe(true);
      expect(src).not.toContain('texture2D(');
      expect(src).not.toContain('gl_FragColor');
      expect(src.split('{').length).toBe(src.split('}').length);
      expect(src.split('(').length).toBe(src.split(')').length);
    }
  });

  it('선언한 유니폼은 전부 본문에서 쓰인다', () => {
    for (const src of all) {
      for (const m of src.matchAll(/uniform\s+\w+\s+(u\w+)[;[]/g)) {
        const name = m[1] as string;
        expect(src.split(name).length - 1, `${name} 가 선언만 되고 안 쓰인다`).toBeGreaterThan(1);
      }
    }
  });

  it('알파로 나눌 때 0 을 막는다 (삼항으로 피하면 SwiftShader 에서 NaN 이 샌다)', () => {
    for (const src of all) {
      expect(src).not.toMatch(/\.a\s*>\s*0\.0\s*\?[^:]*\/\s*\w+\.a/);
    }
    expect(PASS_SHADER_SRC.sharpen).toContain('max(s.a, 1.0 / 255.0)');
    expect(PREVIEW_FRAG_SRC).toContain('max(texel.a, 1.0 / 255.0)');
  });

  it('메인 셰이더에 마스크·오버레이 유니폼이 있고 순서가 렌더러와 같다', () => {
    const at = (n: string): number => {
      const i = PREVIEW_FRAG_SRC.indexOf(n);
      expect(i, `${n} 없음`).toBeGreaterThan(-1);
      return i;
    };
    expect(PREVIEW_FRAG_SRC).toContain('uniform int uMaskKind;');
    expect(PREVIEW_FRAG_SRC).toContain('uniform int uOvKind[3];');
    // 크로마키 → 비네트 → 오버레이 → 마스크 (렌더러 clips.tsx 의 겹침 순서)
    expect(at('uChromaOn == 1')).toBeLessThan(at('uVignette > 0.0'));
    expect(at('uVignette > 0.0')).toBeLessThan(at('i >= uOvCount'));
    expect(at('i >= uOvCount')).toBeLessThan(at('uMaskKind > 0'));
  });

  it('패스 셰이더는 프리멀티플라이드로 오간다', () => {
    expect(PASS_SHADER_SRC.copy).toContain('clamp(s.rgb, 0.0, 1.0) * a');
    expect(PASS_SHADER_SRC.color).toContain('fragColor = vec4(c * a, a);');
    expect(PASS_SHADER_SRC.screen).toContain('a + b - a * b');
  });

  it('블러 패스는 이중선형 쌍 샘플로 tap 을 반으로 줄인다', () => {
    expect(PASS_SHADER_SRC.blur).toContain('int pairs = uSize / 2;');
    expect(PASS_SHADER_SRC.blur).toContain('+ 0.5)');
  });
});

// ── F16 신규 효과와의 접점 ────────────────────────────────────────────────

describe('신규 효과(F16) 와의 접점', () => {
  it('배지 이름은 카탈로그에서 온다 — 영문 id 가 새어 나오지 않는다', () => {
    for (const kind of ['bloom', 'pixelate', 'emboss', 'crt', 'vhs', 'dust', 'tiltShift']) {
      expect(stageLabel(kind)).toBe(effectDef(kind)?.name);
      expect(stageLabel(kind)).not.toBe(kind);
    }
    // 효과가 아닌 «안쪽» 스테이지도 한국어다
    for (const kind of ['dirBlur', 'blurMix', 'displace', 'edge', 'discrete', 'linearTransfer']) {
      expect(stageLabel(kind)).toMatch(/[가-힣]/);
    }
  });

  it('대기가 0 이다 — W8 #8 이 WebGL 6종을 그린다 (자세한 검사는 preview-gl-effects.test.ts)', () => {
    expect(PENDING_EFFECT_TYPES).toEqual([]);
    for (const id of ['vibrance', 'bokeh', 'radialBlur', 'mirror', 'kaleidoscope', 'halftone']) {
      const L = layoutOf({ effects: [fx(id, { amount: 0.8, radius: 10, px: 10, size: 8, segments: 6 })] });
      expect(L.svgFilters, id).toEqual([]);
      expect(L.overlays, id).toEqual([]);
      expect(L.cssFilter, id).toBe('');
      const plan = planClipStages(L);
      expect(plan.stages.map((s) => s.kind), id).toEqual(['gl']);
      expect(plan.needsPasses, id).toBe(true);
      expect(plan.approx, id).toEqual([]);
    }
  });

  it('카탈로그 50종 어느 것을 걸어도 배지 문구에 영문 id 가 안 나온다', () => {
    for (const def of EFFECT_CATALOG) {
      const L = layoutOf({ effects: [fx(def.id, { amount: 0.6, px: 4, radius: 10, lines: 400 })] });
      const plan = planClipStages(L);
      for (const why of plan.approx) {
        expect(why, `${def.id} → ${why}`).toMatch(/^[^A-Za-z]+\(미지원\)$/);
      }
    }
  });
});
