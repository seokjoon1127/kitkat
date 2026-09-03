import { describe, expect, it } from 'vitest';
import type { Asset, Effect, ImageClip, VideoClip } from '@kitkat/schema';
import { computeVisualLayout, layoutMediaFilter } from '../src/layout/index.js';
import { interpolateKeyframes } from '../src/composition/keyframes.js';
import { effectsToFilter, vignetteAmount } from '../src/composition/effects.js';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 리팩터 전 VisualClipView(v1) 의 수식을 그대로 옮겨 놓은 참조 구현.
 * computeVisualLayout 이 여기서 한 발짝도 벗어나지 않아야 한다 (픽셀 동일성 회귀 방지).
 */
function v1Reference(
  clip: VideoClip | ImageClip,
  asset: Asset,
  canvasW: number,
  canvasH: number,
  tMs: number,
) {
  const tr = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
  const x = interpolateKeyframes(clip.keyframes, 'x', tMs, tr.x);
  const y = interpolateKeyframes(clip.keyframes, 'y', tMs, tr.y);
  const scale = interpolateKeyframes(clip.keyframes, 'scale', tMs, tr.scale);
  const rotation = interpolateKeyframes(clip.keyframes, 'rotation', tMs, tr.rotation);
  const opacity = clamp01(interpolateKeyframes(clip.keyframes, 'opacity', tMs, clip.opacity ?? 1));
  const aw = asset.width && asset.width > 0 ? asset.width : canvasW;
  const ah = asset.height && asset.height > 0 ? asset.height : canvasH;
  const fit = Math.min(canvasW / aw, canvasH / ah);
  const fitW = aw * fit;
  const fitH = ah * fit;
  const crop = clip.crop;
  const boxW = crop ? fitW * crop.w : fitW;
  const boxH = crop ? fitH * crop.h : fitH;
  return {
    left: (canvasW - boxW) / 2 + x * canvasW,
    top: (canvasH - boxH) / 2 + y * canvasH,
    width: boxW,
    height: boxH,
    innerLeft: crop ? -crop.x * fitW : 0,
    innerTop: crop ? -crop.y * fitH : 0,
    fitW,
    fitH,
    sx: scale * (tr.flipH ? -1 : 1),
    sy: scale * (tr.flipV ? -1 : 1),
    rotation,
    opacity,
    filter: effectsToFilter(clip.effects),
    vignette: vignetteAmount(clip.effects),
  };
}

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'a1',
  kind: 'video',
  src: 'assets/a1.mp4',
  name: 'a1',
  duration: 10000,
  width: 1920,
  height: 1080,
  ...over,
});

const vclip = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: 'c1',
  kind: 'video',
  assetId: 'a1',
  start: 0,
  duration: 4000,
  in: 0,
  out: 4000,
  speed: 1,
  volume: 1,
  ...over,
});

const eff = (type: Effect['type'], params: Effect['params']): Effect => ({ id: `e-${type}`, type, params });

function expectMatchesV1(clip: VideoClip | ImageClip, a: Asset, w: number, h: number, tMs: number): void {
  const ref = v1Reference(clip, a, w, h, tMs);
  const l = computeVisualLayout({ clip, asset: a, canvasW: w, canvasH: h, tMs });
  expect(l.box.left).toBeCloseTo(ref.left, 10);
  expect(l.box.top).toBeCloseTo(ref.top, 10);
  expect(l.box.width).toBeCloseTo(ref.width, 10);
  expect(l.box.height).toBeCloseTo(ref.height, 10);
  expect(l.inner.left).toBeCloseTo(ref.innerLeft, 10);
  expect(l.inner.top).toBeCloseTo(ref.innerTop, 10);
  expect(l.inner.width).toBeCloseTo(ref.fitW, 10);
  expect(l.inner.height).toBeCloseTo(ref.fitH, 10);
  expect(l.scaleX).toBeCloseTo(ref.sx, 10);
  expect(l.scaleY).toBeCloseTo(ref.sy, 10);
  expect(l.rotationDeg).toBeCloseTo(ref.rotation, 10);
  expect(l.opacity).toBeCloseTo(ref.opacity, 10);
  expect(l.cssFilter).toBe(ref.filter);
  expect(l.vignette).toBeCloseTo(ref.vignette, 10);
}

describe('computeVisualLayout — v1 VisualClipView 수식과 일치', () => {
  it('기본 클립 (transform·crop 없음)', () => {
    expectMatchesV1(vclip(), asset(), 1080, 1920, 0);
    const l = computeVisualLayout({ clip: vclip(), asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    // 1920x1080 소스를 1080x1920 캔버스에 contain-fit
    expect(l.inner.width).toBeCloseTo(1080, 6);
    expect(l.inner.height).toBeCloseTo(607.5, 6);
    expect(l.box.left).toBeCloseTo(0, 6);
    expect(l.box.top).toBeCloseTo(656.25, 6);
  });

  it('transform (x/y/scale/rotation/flip)', () => {
    const clip = vclip({ transform: { x: 0.1, y: -0.05, scale: 1.2, rotation: 15, flipH: true } });
    expectMatchesV1(clip, asset(), 1080, 1920, 0);
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.box.left).toBeCloseTo(108, 6);
    expect(l.box.top).toBeCloseTo(560.25, 6);
    expect(l.scaleX).toBeCloseTo(-1.2, 6);
    expect(l.scaleY).toBeCloseTo(1.2, 6);
    expect(l.rotationDeg).toBe(15);
  });

  it('crop 은 상자를 줄이고 미디어를 안에서 민다', () => {
    const clip = vclip({ crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 } });
    expectMatchesV1(clip, asset(), 1080, 1920, 0);
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.box.width).toBeCloseTo(540, 6);
    expect(l.box.height).toBeCloseTo(486, 6);
    expect(l.box.left).toBeCloseTo(270, 6);
    expect(l.box.top).toBeCloseTo(717, 6);
    expect(l.inner.left).toBeCloseTo(-270, 6);
    expect(l.inner.top).toBeCloseTo(-60.75, 6);
  });

  it('키프레임 보간이 transform 을 덮어쓴다', () => {
    const clip = vclip({
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      keyframes: [
        { time: 0, prop: 'scale', value: 1, easing: 'linear' },
        { time: 2000, prop: 'scale', value: 2, easing: 'linear' },
        { time: 0, prop: 'opacity', value: 1, easing: 'linear' },
        { time: 2000, prop: 'opacity', value: 0, easing: 'linear' },
      ],
    });
    for (const t of [0, 500, 1000, 1999]) expectMatchesV1(clip, asset(), 1080, 1920, t);
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 1000 });
    expect(l.scaleX).toBeCloseTo(1.5, 6);
    expect(l.opacity).toBeCloseTo(0.5, 6);
  });

  it('에셋 크기가 없으면 캔버스 크기로 폴백', () => {
    const a = asset();
    delete a.width;
    delete a.height;
    expectMatchesV1(vclip(), a, 1080, 1920, 0);
    const l = computeVisualLayout({ clip: vclip(), asset: a, canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.inner.width).toBe(1080);
    expect(l.inner.height).toBe(1920);
  });

  it('v1 효과 조합도 그대로 (cssFilter + vignette)', () => {
    const clip = vclip({
      effects: [eff('brightness', { amount: 1.2 }), eff('vignette', { amount: 0.6 }), eff('blur', { px: 3 })],
      blendMode: 'screen',
      opacity: 0.8,
    });
    expectMatchesV1(clip, asset(), 1080, 1920, 0);
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.cssFilter).toBe('brightness(1.2) blur(3px)');
    expect(l.vignette).toBe(0.6);
    expect(l.blendMode).toBe('screen');
  });
});

describe('computeVisualLayout — 새 필드가 없으면 새 경로가 안 켜진다', () => {
  it('평범한 클립은 SVG 필터도 오버레이도 없다', () => {
    const l = computeVisualLayout({ clip: vclip(), asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.svgFilters).toEqual([]);
    expect(l.overlays).toEqual([]);
    expect(l.filterId).toBeNull();
    expect(l.wideFilterRegion).toBe(false);
    expect(l.blendMode).toBeUndefined();
    expect(l.mask).toBeUndefined();
    expect(layoutMediaFilter(l)).toBe('');
  });

  it('blendMode normal 은 없는 것과 같다', () => {
    const l = computeVisualLayout({
      clip: vclip({ blendMode: 'normal' }),
      asset: asset(),
      canvasW: 1080,
      canvasH: 1920,
      tMs: 0,
    });
    expect(l.blendMode).toBeUndefined();
  });

  it('크로마키만 있으면 스테이지 1개 (v1 과 같은 필터 1개)', () => {
    const clip = vclip({ chromaKey: { color: '#00ff00', similarity: 0.4, smoothness: 0.1 } });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.svgFilters).toHaveLength(1);
    expect(l.svgFilters[0]!.kind).toBe('chromaKey');
    expect(l.filterId).toBe('fx-c1');
    expect(layoutMediaFilter(l)).toBe('url(#fx-c1)');
  });
});

describe('computeVisualLayout — W5 합성', () => {
  it('필터 체인 순서: 커브 → 효과 → 크로마키 (필터 id 하나)', () => {
    const clip = vclip({
      curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      effects: [eff('temperature', { amount: 0.5 }), eff('glow', { amount: 0.5, radius: 20 })],
      chromaKey: { color: '#0000ff', similarity: 0.5, smoothness: 0.2 },
    });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.svgFilters.map((s) => s.kind)).toEqual(['curves', 'colorMatrix', 'glow', 'chromaKey']);
    expect(l.svgFilters.map((s) => s.id)).toEqual(['fx-c1s0', 'fx-c1s1', 'fx-c1s2', 'fx-c1s3']);
    expect(l.filterId).toBe('fx-c1');
    expect(l.wideFilterRegion).toBe(true);
    expect((l.svgFilters[0]!.data as { r: number[] }).r).toHaveLength(33);
  });

  it('CSS 효과가 있으면 CSS 먼저, SVG 체인이 나중', () => {
    const clip = vclip({
      effects: [eff('brightness', { amount: 1.1 }), eff('sharpen', { amount: 1 })],
    });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(layoutMediaFilter(l)).toBe('brightness(1.1) url(#fx-c1)');
  });

  it('scanlines period 는 캔버스 높이 ÷ lines', () => {
    const clip = vclip({ effects: [eff('scanlines', { amount: 0.4, lines: 480 })] });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.overlays).toHaveLength(1);
    expect(l.overlays[0]!.kind).toBe('scanlines');
    expect(l.overlays[0]!.params.period).toBeCloseTo(4, 6);
  });

  it('마스크는 레이아웃에 실려 나온다', () => {
    const mask = { shape: 'circle' as const, feather: 0.2, x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    const l = computeVisualLayout({ clip: vclip({ mask }), asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.mask).toEqual(mask);
  });

  it('커브는 CSS 효과보다 먼저 — 최종 filter 가 url(#curves-…) 로 시작한다', () => {
    // 커브로 그림자를 들어 올리면서 invert 를 쓰는 조합. CSS 효과가 먼저 걸리면
    // "원본의 그림자"가 아니라 "반전된 영상의 그림자"가 올라간다.
    const clip = vclip({
      curves: { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }] },
      effects: [
        eff('invert', { amount: 1 }),
        eff('brightness', { amount: 1.5 }),
        eff('sharpen', { amount: 1 }),
      ],
    });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    const f = layoutMediaFilter(l);
    expect(f.startsWith('url(#curves-c1)')).toBe(true);
    expect(f).toBe('url(#curves-c1) invert(1) brightness(1.5) url(#fx-c1)');
  });

  it('커브는 효과 <filter> 에서 빠지고 전용 필터로 간다', () => {
    const clip = vclip({
      curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      effects: [eff('temperature', { amount: 0.5 }), eff('glow', { amount: 0.5, radius: 20 })],
      chromaKey: { color: '#0000ff', similarity: 0.5, smoothness: 0.2 },
    });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.curvesFilters.map((s) => s.kind)).toEqual(['curves']);
    expect(l.effectFilters.map((s) => s.kind)).toEqual(['colorMatrix', 'glow', 'chromaKey']);
    // svgFilters(전체 색 연산 순서)는 둘을 이어 붙인 것
    expect(l.svgFilters).toEqual([...l.curvesFilters, ...l.effectFilters]);
    expect(l.curvesFilterId).toBe('curves-c1');
    expect((l.curvesFilters[0]!.data as { r: number[] }).r).toHaveLength(33);
  });

  it('커브만 있으면 빈 fx 필터를 만들지 않는다', () => {
    const clip = vclip({ curves: { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }] } });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.effectFilters).toEqual([]);
    expect(l.filterId).toBeNull();
    expect(layoutMediaFilter(l)).toBe('url(#curves-c1)');
  });

  it('커브가 없으면 filter 문자열이 v1 그대로다 (회귀)', () => {
    const clip = vclip({
      effects: [eff('brightness', { amount: 1.1 }), eff('sharpen', { amount: 1 })],
    });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.curvesFilterId).toBeNull();
    expect(l.curvesFilters).toEqual([]);
    expect(layoutMediaFilter(l)).toBe('brightness(1.1) url(#fx-c1)');
  });

  it('크로마키 클립의 filter 문자열은 변하지 않았다 (회귀)', () => {
    const key = { color: '#00ff00', similarity: 0.4, smoothness: 0.1 };
    const only = computeVisualLayout({
      clip: vclip({ chromaKey: key }),
      asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0,
    });
    expect(layoutMediaFilter(only)).toBe('url(#fx-c1)');
    expect(only.effectFilters.map((s) => s.kind)).toEqual(['chromaKey']);
    const withCss = computeVisualLayout({
      clip: vclip({ chromaKey: key, effects: [eff('invert', { amount: 1 })] }),
      asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0,
    });
    expect(layoutMediaFilter(withCss)).toBe('invert(1) url(#fx-c1)');
    // 커브까지 있으면 크로마키는 그대로 끝에 남고 커브만 앞으로 나온다
    const withCurves = computeVisualLayout({
      clip: vclip({ chromaKey: key, curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }),
      asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0,
    });
    expect(layoutMediaFilter(withCurves)).toBe('url(#curves-c1) url(#fx-c1)');
    expect(withCurves.effectFilters.map((s) => s.kind)).toEqual(['chromaKey']);
  });

  it('highlights/shadows 가 만드는 커브 스테이지는 효과 순서 자리에 남는다', () => {
    const clip = vclip({
      effects: [eff('brightness', { amount: 1.2 }), eff('highlights', { amount: 0.5 })],
    });
    const l = computeVisualLayout({ clip, asset: asset(), canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.curvesFilterId).toBeNull();
    expect(l.effectFilters.map((s) => s.kind)).toEqual(['curves']);
    expect(layoutMediaFilter(l)).toBe('brightness(1.2) url(#fx-c1)');
  });

  it('이미지 클립도 같은 수식 (크로마키/속도 없음)', () => {
    const img: ImageClip = {
      id: 'i1', kind: 'image', assetId: 'a1', start: 0, duration: 3000,
      crop: { x: 0, y: 0.2, w: 1, h: 0.6 },
    };
    const a = asset({ kind: 'image', width: 1000, height: 1000 });
    expectMatchesV1(img, a, 1080, 1920, 0);
    const l = computeVisualLayout({ clip: img, asset: a, canvasW: 1080, canvasH: 1920, tMs: 0 });
    expect(l.svgFilters).toEqual([]);
  });
});
