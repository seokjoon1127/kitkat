// W8 F15 대조 테스트의 **브라우저 쪽** — esbuild 로 한 파일로 묶여 헤드리스 Chrome 에서 돈다.
//
// 한 페이지에 두 가지를 같이 만든다:
//   (a) 기준 — 렌더러가 실제로 그리는 DOM (SVG <filter> · CSS mask · 오버레이 div).
//       서버 렌더(Remotion)도 결국 같은 Chrome 이 이 DOM 을 래스터화한다.
//   (b) 프리뷰 — **진짜 `GlCompositor`** 로 그린 WebGL 캔버스.
// 그리고 (a) 를 스크린샷으로 받아 (b) 와 픽셀을 뺀다.
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Internals } from 'remotion';
import type { Asset, Effect, ImageClip, Mask } from '@kitkat/schema';
import { computeVisualLayout, layoutMediaFilter, type VisualLayout } from '@kitkat/renderer/layout';
import {
  ClipFilterDefs,
  MaskDefs,
  glStageDescriptors,
  grainSeed,
  lightLeakCss,
  maskLayerCss,
  scanlinesCss,
  transitionOverlays,
} from '@kitkat/renderer/composition';
import { GlCompositor, passPadding } from '../src/preview/gl.js';
import { passSurface } from '../src/preview/gl-passes.js';
import { glitchOverlayParams, planClipStages, transitionParams } from '../src/preview/gl-params.js';
import { bakeMaskAlpha, maskRasterPlan } from '../src/preview/mask-raster.js';

export type ParityCase = {
  name: string;
  effects?: Effect[];
  mask?: Mask;
  /** W8 F17 — 여러 장 겹치기 (`masks` 가 있으면 `mask` 는 무시된다) */
  masks?: Mask[];
  /** 글리치 전환 덮개 — 진행도 v (1 = 전환 끝) */
  glitch?: number;
  frame?: number;
  /** `dKeys`(모양 키프레임) 를 푸는 시각 — 클립 시작 기준 ms */
  tMs?: number;
};

const W = 480;
const H = 270;

const ASSET: Asset = {
  id: 'a1', kind: 'image', src: 'a1.png', name: 'a1', duration: 5000, width: W, height: H,
};

declare global {
  interface Window {
    kkReady: () => Promise<void>;
    kkBuildRef: (c: ParityCase) => Promise<void>;
    kkDrawPreview: (c: ParityCase) => { ok: boolean; err: number; why: string[]; bytes: number; surf?: string };
    kkCompare: (dataUrl: string) => Promise<Stats>;
    kkBench: (c: ParityCase, frames: number) => number;
    kkBenchAt: (c: ParityCase, w: number, h: number, frames: number) => { fps: number; bytes: number };
    kkFreshBytes: () => number;
    kkBenchRepeat: (c: ParityCase, frames: number, reps: number) => number[];
    kkNoiseRef: () => void;
    kkStatsOf: (dataUrl: string) => Promise<{ mean: number; sigma: number }>;
    /** 효과 있음 vs 없음 — 미리보기 픽셀 차이 (0 이면 안 걸린 것) */
    kkEffectDelta: (c: ParityCase) => { mean: number; max: number };
    /** 보케 «원반» 증거 — 검은 바탕 한 점을 흐린 뒤 가로 단면 */
    kkProbeDisc: (radius: number, gaussianPx: number) => { disc: number[]; gauss: number[] };
    kkRenderer: () => string;
    /**
     * W8 F17 — 마스크 알파 캔버스 **재사용 적중률**. `animate` 면 프레임마다 tMs 를 옮겨
     * `dKeys` 를 다시 풀게 한다(= 모양이 매 프레임 바뀐다).
     */
    kkMaskReuse: (
      c: ParityCase,
      frames: number,
      animate?: boolean,
    ) => { hits: number; misses: number; entries: number; fps: number };
    /** 구운 마스크 알파를 그대로 읽는다 (셰이더를 거치기 전 값 — 어디서 갈리는지 가른다) */
    kkMaskProbe: (
      c: ParityCase,
      y: number,
      x0: number,
      x1: number,
    ) => { pad: number; texW: number; texH: number; alpha: number[] };
    kkSize: { w: number; h: number };
  }
}

export type Stats = {
  /** 채널당 평균 절대 차이 (0..255) */
  mean: number;
  /** 채널당 최대 절대 차이 */
  max: number;
  /** 차이가 큰 픽셀 비율 (>12) */
  overThreshold: number;
  /** 두 그림의 평균 밝기 — 한쪽이 비어 있으면 여기서 바로 드러난다 */
  refMean: number;
  previewMean: number;
  /** 가장자리 8px 를 뺀 안쪽 통계 */
  innerMean: number;
  innerMax: number;
  /** 가로 이웃 차이의 평균 — 노이즈 세기 비교용 */
  hfRef: number;
  hfGl: number;
  /** 차이가 큰 픽셀 좌표 몇 개 (디버그) — 앞 12개와 뒤 12개 */
  hot: string[];
  hotLast: string[];
  edge: { L: number; R: number; T: number; B: number; mid: number };
  probe: string[];
  /** 프리뷰 캔버스 · 차이(8배 증폭)를 PNG 로 (디버그용) */
  previewPng: string;
  diffPng: string;
};

let srcUrl = '';
let srcImg: HTMLImageElement | null = null;
let gl: GlCompositor | null = null;
let previewPixels: Uint8Array | null = null;
let refRoot: Root | null = null;

/** 테스트용 소스 그림 — 그라디언트·하드 엣지·하이라이트·채도 높은 색을 한 장에 담는다. */
function makeSource(): string {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#101820');
  grad.addColorStop(0.5, '#6a8fa8');
  grad.addColorStop(1, '#e8d8b0');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // 하이라이트 (글로우 임계 0.65 위)
  g.fillStyle = '#ffffff';
  g.fillRect(40, 30, 60, 60);
  g.fillStyle = '#fff2c0';
  g.beginPath();
  g.arc(300, 80, 34, 0, Math.PI * 2);
  g.fill();
  // 채도 높은 색 (색수차)
  g.fillStyle = '#ff2040';
  g.fillRect(150, 150, 70, 70);
  g.fillStyle = '#20c0ff';
  g.fillRect(240, 170, 70, 50);
  g.fillStyle = '#20ff60';
  g.fillRect(370, 40, 60, 90);
  // 체커 (샤픈이 반응하는 하드 엣지)
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 10; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? '#202020' : '#d0d0d0';
      g.fillRect(20 + x * 10, 200 + y * 10, 10, 10);
    }
  }
  return c.toDataURL('image/png');
}

function clipOf(c: ParityCase): ImageClip {
  return {
    id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 4000,
    ...(c.effects ? { effects: c.effects } : {}),
    ...(c.mask ? { mask: c.mask } : {}),
    ...(c.masks ? { masks: c.masks } : {}),
  } as ImageClip;
}

function layoutOf(c: ParityCase): VisualLayout {
  return computeVisualLayout({
    clip: clipOf(c), asset: ASSET, canvasW: W, canvasH: H, tMs: c.tMs ?? 0,
  });
}

const px = (v: number): string => `${v}px`;

/** 렌더러 `clips.tsx` 의 상자 스타일 + 마스크. */
function boxStyle(L: VisualLayout): Record<string, string> {
  const mask = maskLayerCss(L.maskLayers, L.box.width, L.box.height, 'c1').style as Record<
    string,
    string
  >;
  const s: Record<string, string> = {
    position: 'absolute',
    left: px(L.box.left),
    top: px(L.box.top),
    width: px(L.box.width),
    height: px(L.box.height),
    overflow: 'hidden',
    transform: `scale(${L.scaleX}, ${L.scaleY}) rotate(${L.rotationDeg}deg)`,
    opacity: String(L.opacity),
  };
  for (const [k, v] of Object.entries(mask)) if (typeof v === 'string') s[k] = v;
  return s;
}

function apply(el: HTMLElement, style: Record<string, string>): void {
  for (const [k, v] of Object.entries(style)) {
    (el.style as unknown as Record<string, string>)[k] = v;
  }
}

/** 렌더러 `overlays.tsx` 의 오버레이 3종을 같은 구조로 만든다. */
function overlayNodes(L: VisualLayout, frame: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  L.overlays.forEach((o, i) => {
    const num = (v: unknown, f: number): number => (typeof v === 'number' ? v : f);
    if (o.kind === 'grain') {
      const fid = `c1-ov${i}-turb`;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('style',
        `position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:overlay;` +
        `opacity:${num(o.params.amount, 0.3) * 0.6}`);
      svg.innerHTML =
        `<defs><filter id="${fid}" x="0%" y="0%" width="100%" height="100%" ` +
        `color-interpolation-filters="sRGB">` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" ` +
        `seed="${grainSeed(frame)}" stitchTiles="stitch"/>` +
        `<feColorMatrix type="saturate" values="0"/>` +
        `<feComponentTransfer><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>` +
        `</filter></defs><rect width="100%" height="100%" filter="url(#${fid})"/>`;
      out.push(svg as unknown as HTMLElement);
      return;
    }
    const d = document.createElement('div');
    if (o.kind === 'scanlines') {
      apply(d, {
        position: 'absolute', inset: '0', mixBlendMode: 'multiply',
        background: scanlinesCss(num(o.params.amount, 0.3), num(o.params.period, 2)),
      });
    } else {
      apply(d, {
        position: 'absolute', inset: '0', mixBlendMode: 'screen',
        background: lightLeakCss(num(o.params.amount, 0.4), num(o.params.hue, 30)),
      });
    }
    out.push(d);
  });
  return out;
}

window.kkSize = { w: W, h: H };

window.kkReady = async (): Promise<void> => {
  srcUrl = makeSource();
  srcImg = new Image();
  await new Promise<void>((res, rej) => {
    srcImg!.onload = () => res();
    srcImg!.onerror = () => rej(new Error('소스 그림을 못 읽었다'));
    srcImg!.src = srcUrl;
  });
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  gl = GlCompositor.create(canvas);
  if (!gl) throw new Error('WebGL2 를 못 얻었다');
};

/** 어떤 래스터라이저로 도는지 — 「SwiftShader 만 썼다」를 증명하려고 찍는다. */
window.kkRenderer = (): string => {
  if (!gl) return '(없음)';
  const ctx = gl.context;
  const ext = ctx.getExtension('WEBGL_debug_renderer_info');
  const r = ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER);
  return String(r);
};

window.kkBuildRef = async (c: ParityCase): Promise<void> => {
  const L = layoutOf(c);
  const host = document.getElementById('ref') as HTMLDivElement;
  host.innerHTML = '';
  const defs = document.createElement('div');
  host.appendChild(defs);
  const box = document.createElement('div');
  apply(box, boxStyle(L));
  const img = document.createElement('img');
  apply(img, {
    position: 'absolute',
    left: px(L.inner.left),
    top: px(L.inner.top),
    width: px(L.inner.width),
    height: px(L.inner.height),
  });
  const f = layoutMediaFilter(L);
  if (f) img.style.filter = f;
  img.src = srcUrl;
  if (L.glStages.length > 0) {
    // 렌더러의 실제 경로 — Remotion `createEffect` 정의(webgl-effects.tsx)를 `runEffectChain` 으로
    // 돌린 캔버스에 같은 CSS filter 를 건다. <CanvasImage>·<GlVideoEffects> 가 하는 일 그대로다.
    const mw = Math.max(1, Math.round(L.inner.width));
    const mh = Math.max(1, Math.round(L.inner.height));
    const source = document.createElement('canvas');
    source.width = mw;
    source.height = mh;
    (source.getContext('2d', { colorSpace: 'srgb' }) as CanvasRenderingContext2D)
      .drawImage(srcImg as HTMLImageElement, 0, 0, mw, mh);
    const out = document.createElement('canvas');
    out.width = mw;
    out.height = mh;
    apply(out, {
      position: 'absolute',
      left: px(L.inner.left),
      top: px(L.inner.top),
      width: px(L.inner.width),
      height: px(L.inner.height),
    });
    if (f) out.style.filter = f;
    const effects = glStageDescriptors(L.glStages).map((d) => ({ ...d, memoized: true as const }));
    const state = Internals.createEffectChainState(mw, mh);
    const ok = await Internals.runEffectChain({
      state, source, effects, output: out, width: mw, height: mh,
    });
    Internals.cleanupEffectChainState(state);
    if (!ok) throw new Error('createEffect 체인이 끝나지 않았다');
    box.appendChild(out);
  } else {
    box.appendChild(img);
  }
  for (const n of overlayNodes(L, c.frame ?? 0)) box.appendChild(n);
  host.appendChild(box);

  if (c.glitch !== undefined) {
    for (const o of transitionOverlays('glitch', c.glitch)) {
      const d = document.createElement('div');
      apply(d, o.style as unknown as Record<string, string>);
      host.appendChild(d);
    }
  }

  // <filter>·<mask> 정의는 **렌더러 컴포넌트 그대로** 만든다 (문자열을 손으로 안 쓴다)
  const maskCss = maskLayerCss(L.maskLayers, L.box.width, L.box.height, 'c1');
  refRoot?.unmount();
  refRoot = createRoot(defs);
  flushSync(() => {
    refRoot!.render(
      React.createElement(
        React.Fragment,
        null,
        L.curvesFilterId
          ? React.createElement(ClipFilterDefs, {
              id: L.curvesFilterId, stages: L.curvesFilters, wideRegion: false,
            })
          : null,
        L.filterId
          ? React.createElement(ClipFilterDefs, {
              id: L.filterId, stages: L.effectFilters, wideRegion: L.wideFilterRegion,
            })
          : null,
        React.createElement(MaskDefs, { defs: maskCss.defs }),
      ),
    );
  });
  // 그림이 실제로 붙기 전에 찍으면 «검은 화면 vs 프리뷰» 를 비교하게 된다
  await img.decode().catch(() => undefined);
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
};

window.kkDrawPreview = (c: ParityCase) => {
  const L = layoutOf(c);
  if (!gl || !srcImg) return { ok: false, err: -1, why: ['준비 안 됨'], bytes: 0, surf: '' };
  gl.resize(W, H);
  gl.beginFrame([0, 0, 0]);
  const why = gl.drawLayer({
    id: 'c1',
    image: srcImg,
    seq: 0,
    layout: L,
    transition: transitionParams([], W, H),
    grainSeed: grainSeed(c.frame ?? 0),
  });
  if (c.glitch !== undefined) {
    const g = glitchOverlayParams(
      transitionOverlays('glitch', c.glitch).map((o) => o.style as Record<string, unknown>),
    );
    if (g) gl.drawGlitch(g);
  }
  const ctx = gl.context;
  const buf = new Uint8Array(W * H * 4);
  ctx.readPixels(0, 0, W, H, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
  previewPixels = buf;
  return { ok: true, err: gl.consumeError(), why, bytes: gl.passBytes(), surf: JSON.stringify(
      passSurface(
        Math.round(L.inner.width),
        Math.round(L.inner.height),
        passPadding(planClipStages(L).stages),
      ),
    ) };
};

window.kkCompare = async (dataUrl: string): Promise<Stats> => {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('스크린샷을 못 읽었다'));
    img.src = dataUrl;
  });
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  g.drawImage(img, 0, 0, W, H);
  const ref = g.getImageData(0, 0, W, H).data;
  const pv = previewPixels;
  if (!pv) throw new Error('프리뷰 픽셀이 없다');
  let sum = 0;
  let max = 0;
  let over = 0;
  let refSum = 0;
  let pvSum = 0;
  const out = g.createImageData(W, H);
  const diff = g.createImageData(W, H);
  let inSum = 0;
  let inMax = 0;
  let inN = 0;
  const hot: string[] = [];
  const hotLast: string[] = [];
  const edge = { L: 0, R: 0, T: 0, B: 0, mid: 0 };
  for (let y = 0; y < H; y++) {
    // readPixels 는 아래에서 위로 — 기준 이미지와 줄을 맞춘다
    const src = (H - 1 - y) * W * 4;
    const dst = y * W * 4;
    for (let x = 0; x < W; x++) {
      let worst = 0;
      for (let k = 0; k < 3; k++) {
        const a = pv[src + x * 4 + k] as number;
        const b = ref[dst + x * 4 + k] as number;
        const d = Math.abs(a - b);
        sum += d;
        pvSum += a;
        refSum += b;
        if (d > worst) worst = d;
        out.data[dst + x * 4 + k] = a;
        diff.data[dst + x * 4 + k] = Math.min(255, d * 8);
      }
      out.data[dst + x * 4 + 3] = 255;
      diff.data[dst + x * 4 + 3] = 255;
      if (worst > max) max = worst;
      if (worst > 12) {
        over++;
        if (x === 0) edge.L++;
        else if (x === W - 1) edge.R++;
        else if (y === 0) edge.T++;
        else if (y === H - 1) edge.B++;
        else edge.mid++;
        const at = `${x},${y}=${worst}(gl ${pv[src + x * 4]} ref ${ref[dst + x * 4]})`;
        if (hot.length < 12) hot.push(at);
        // 마지막 12개도 남긴다 — 위쪽만 보면 «위로 밀렸나»와 «부풀었나»를 못 가른다
        hotLast.push(at);
        if (hotLast.length > 12) hotLast.shift();
      }
      // 가장자리 8px 를 뺀 «안쪽» 통계 — 필터 영역 경계 효과와 진짜 수식 차이를 가른다
      if (x >= 8 && x < W - 8 && y >= 8 && y < H - 8) {
        inSum += worst;
        inN++;
        if (worst > inMax) inMax = worst;
      }
    }
  }
  // 고주파 에너지 — 그레인처럼 «픽셀마다 다른» 성분의 세기. 노이즈는 픽셀 대조가 뜻이 없어서
  // 이 값으로 «같은 세기인가»를 본다.
  let hfRef = 0;
  let hfGl = 0;
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4;
    const dst = y * W * 4;
    for (let x = 1; x < W; x++) {
      hfGl += Math.abs((pv[src + x * 4] as number) - (pv[src + (x - 1) * 4] as number));
      hfRef += Math.abs((ref[dst + x * 4] as number) - (ref[dst + (x - 1) * 4] as number));
    }
  }
  const hfN = H * (W - 1);
  g.putImageData(out, 0, 0);
  const prev = c.toDataURL('image/png');
  g.putImageData(diff, 0, 0);
  return {
    mean: sum / (W * H * 3),
    max,
    overThreshold: over / (W * H),
    refMean: refSum / (W * H * 3),
    previewMean: pvSum / (W * H * 3),
    innerMean: inSum / Math.max(1, inN),
    innerMax: inMax,
    hfRef: hfRef / hfN,
    hfGl: hfGl / hfN,
    hot,
    hotLast,
    edge,
    probe: [0, 1, 2, 3, 477, 478, 479].map((x) => {
      const d = (H - 1 - 100) * W * 4 + x * 4;
      const r = 100 * W * 4 + x * 4;
      return `x${x} gl(${pv[d]},${pv[d + 1]},${pv[d + 2]}) ref(${ref[r]},${ref[r + 1]},${ref[r + 2]})`;
    }),
    previewPng: prev,
    diffPng: c.toDataURL('image/png'),
  };
};

function readPreview(): Uint8Array {
  const ctx = (gl as GlCompositor).context;
  const buf = new Uint8Array(W * H * 4);
  ctx.readPixels(0, 0, W, H, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
  return buf;
}

function drawOnce(L: VisualLayout, image: HTMLImageElement, id: string): void {
  (gl as GlCompositor).resize(W, H);
  (gl as GlCompositor).beginFrame([0, 0, 0]);
  (gl as GlCompositor).drawLayer({
    id, image, seq: -1, layout: L, transition: transitionParams([], W, H),
  });
}

/** «걸렸다» 증거 — 같은 소스를 효과 없이/있이 그려 픽셀 차이를 잰다. 0 이면 아무 일도 안 한 것. */
window.kkEffectDelta = (c: ParityCase) => {
  if (!gl || !srcImg) return { mean: -1, max: -1 };
  drawOnce(layoutOf({ name: 'plain' }), srcImg, 'c1');
  const a = readPreview();
  drawOnce(layoutOf(c), srcImg, 'c1');
  const b = readPreview();
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = Math.abs((a[i] as number) - (b[i] as number));
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / (W * H * 3), max };
};

/**
 * 보케가 «원반»인지 — 검은 바탕 가운데 흰 점(9x9) 하나를 반지름 r 로 흐린 뒤 가로 단면을 읽는다.
 * 원반이면 중심에서 r 까지 값이 평평하다가 r 에서 뚝 떨어지고, 가우시안(blur)이면 중심이 높고
 * 바깥으로 갈수록 미끄러진다. 두 단면을 같이 돌려 준다 — 판정은 Node 쪽이 한다.
 */
window.kkProbeDisc = (radius: number, gaussianPx: number) => {
  if (!gl) return { disc: [], gauss: [] };
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  g.fillRect(W / 2 - 4, H / 2 - 4, 9, 9);
  // 캔버스를 그대로 텍스처로 올린다 (GlImage 는 width/height 만 읽는다)
  const asImage = c as unknown as HTMLImageElement;
  const row = (L: VisualLayout): number[] => {
    drawOnce(L, asImage, 'dot');
    const px = readPreview();
    const y = H - 1 - H / 2; // readPixels 는 아래에서 위로
    const out: number[] = [];
    for (let x = 0; x < W; x++) out.push(px[(y * W + x) * 4] as number);
    return out;
  };
  const disc = row(layoutOf({
    name: 'disc', effects: [{ id: 'b', type: 'bokeh', params: { radius, amount: 1 } }],
  }));
  const gauss = row(layoutOf({
    name: 'gauss', effects: [{ id: 'g', type: 'blur', params: { px: gaussianPx } }],
  }));
  return { disc, gauss };
};

/** 8종을 전부 켠 클립을 N 프레임 그려 초당 프레임 수를 잰다. */
window.kkBench = (c: ParityCase, frames: number): number => {
  if (!gl || !srcImg) return 0;
  const L = layoutOf(c);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    gl.resize(W, H);
    gl.beginFrame([0, 0, 0]);
    gl.drawLayer({
      id: 'c1', image: srcImg, seq: 0, layout: L,
      transition: transitionParams([], W, H),
      grainSeed: grainSeed(i),
    });
  }
  const ctx = gl.context;
  const one = new Uint8Array(4);
  ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, one); // GPU 를 실제로 기다린다
  return (frames * 1000) / (performance.now() - t0);
};

/**
 * 세로 영상(1080x1920) 기준 성능·메모리. 대조는 480x270 로 하지만 **재생 성능은 실제 크기**로
 * 재야 뜻이 있다. SwiftShader(소프트웨어)라 절대값은 낮다 — 비교는 «패스 대 단일 패스» 비율로.
 */
window.kkBenchAt = (c: ParityCase, w: number, h: number, frames: number) => {
  if (!gl || !srcImg) return { fps: 0, bytes: 0 };
  const asset: Asset = { ...ASSET, width: w, height: h };
  const clip = clipOf(c);
  const L = computeVisualLayout({ clip, asset, canvasW: w, canvasH: h, tMs: c.tMs ?? 0 });
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    gl.resize(w, h);
    gl.beginFrame([0, 0, 0]);
    gl.drawLayer({
      id: 'big', image: srcImg, seq: 0, layout: L,
      transition: transitionParams([], w, h),
      grainSeed: grainSeed(i),
    });
  }
  const ctx = gl.context;
  const one = new Uint8Array(4);
  ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, one);
  const fps = (frames * 1000) / (performance.now() - t0);
  gl.resize(W, H);
  return { fps, bytes: gl.passBytes() };
};

/**
 * **회귀 확인** — 새 합성기로 «패스가 필요 없는 클립»만 그리면 프레임버퍼를 한 장도 안 만든다.
 * 0 이 아니면 단일 패스 클립이 다중 패스 비용을 물고 있다는 뜻이다.
 */
window.kkFreshBytes = (): number => {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g2 = GlCompositor.create(c);
  if (!g2 || !srcImg) return -1;
  const L = layoutOf({ name: 'plain' });
  g2.resize(W, H);
  g2.beginFrame([0, 0, 0]);
  g2.drawLayer({ id: 'p', image: srcImg, seq: 0, layout: L, transition: transitionParams([], W, H) });
  const n = g2.passBytes();
  g2.dispose();
  return n;
};

/**
 * W8 F17 — 마스크 알파를 **몇 번이나 다시 굽는가**. 합성기를 새로 만들어 재므로 앞 케이스의
 * 캐시가 섞이지 않는다. `animate` 면 프레임마다 시각을 옮겨 `dKeys` 로 모양을 바꾼다.
 */
window.kkMaskReuse = (c: ParityCase, frames: number, animate = false) => {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g2 = GlCompositor.create(canvas);
  if (!g2 || !srcImg) return { hits: -1, misses: -1, entries: -1, fps: 0 };
  const layouts: VisualLayout[] = [];
  for (let i = 0; i < frames; i++) {
    layouts.push(layoutOf(animate ? { ...c, tMs: (i / Math.max(1, frames - 1)) * 1000 } : c));
  }
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    g2.resize(W, H);
    g2.beginFrame([0, 0, 0]);
    g2.drawLayer({
      id: 'c1', image: srcImg, seq: 0, layout: layouts[i] as VisualLayout,
      transition: transitionParams([], W, H),
    });
  }
  const ctx = g2.context;
  const one = new Uint8Array(4);
  ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, one);
  const fps = (frames * 1000) / (performance.now() - t0);
  const s = g2.maskRasterStats();
  g2.dispose();
  return { ...s, fps };
};

window.kkMaskProbe = (c: ParityCase, y: number, x0: number, x1: number) => {
  const L = layoutOf(c);
  const plan = maskRasterPlan(L.maskLayers, L.box.width, L.box.height);
  if (!plan) return { pad: -1, texW: 0, texH: 0, alpha: [] };
  const canvas = bakeMaskAlpha(plan, document.createElement('canvas'), document.createElement('canvas'));
  if (!canvas) return { pad: -2, texW: 0, texH: 0, alpha: [] };
  const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const row = g.getImageData(0, plan.pad + y, plan.texW, 1).data;
  const alpha: number[] = [];
  for (let x = x0; x <= x1; x++) alpha.push(row[(plan.pad + x) * 4 + 3] as number);
  return { pad: plan.pad, texW: plan.texW, texH: plan.texH, alpha };
};

/** 같은 벤치를 여러 번 — SwiftShader 는 편차가 커서 한 번 재면 못 믿는다. */
window.kkBenchRepeat = (c: ParityCase, frames: number, reps: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < reps; i++) out.push(window.kkBench(c, frames));
  return out;
};

/** feTurbulence 그레인만 있는 화면을 만든다 (Node 가 찍어서 `kkStatsOf` 로 분포를 잰다). */
window.kkNoiseRef = (): void => {
  const host = document.getElementById('ref') as HTMLDivElement;
  host.innerHTML = '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%');
  svg.innerHTML =
    `<defs><filter id="nz" x="0%" y="0%" width="100%" height="100%" ` +
    `color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="1" ` +
    `stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>` +
    `</filter></defs><rect width="100%" height="100%" filter="url(#nz)"/>`;
  host.appendChild(svg as unknown as HTMLElement);
};

/** 스크린샷의 회색값 평균·표준편차 (0..1). */
window.kkStatsOf = async (dataUrl: string): Promise<{ mean: number; sigma: number }> => {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('스크린샷을 못 읽었다'));
    img.src = dataUrl;
  });
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  let sum = 0;
  let sq = 0;
  const n = W * H;
  for (let i = 0; i < n; i++) {
    const v = (d[i * 4] as number) / 255;
    sum += v;
    sq += v * v;
  }
  const mean = sum / n;
  return { mean, sigma: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
};
