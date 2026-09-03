// 시각 클립 합성 수식 (계획 X5-a) — remotion·react 무의존 순수 모듈.
// Remotion 합성(VisualClipView)과 프리뷰 엔진 v2(WebGL)가 **같은 함수**를 써서
// 두 경로의 수식이 갈리지 않게 하는 장치다.
import type { Asset, ImageClip, Mask, VideoClip } from '@kitkat/schema';
import { curvesToTables } from '@kitkat/schema';
import { resolveMaskD } from './mask-path.js';
import { applyKeyframes } from '../composition/keyframes.js';
import {
  effectOverlays,
  effectSvgStages,
  effectsToFilter,
  needsWideFilterRegion,
  vignetteAmount,
  type EffectOverlay,
  type SvgStageData,
} from '../composition/effects.js';
import { chromaKeyParams } from '../composition/svg-data.js';
import { effectGlStages, type GlStageData } from '../composition/gl-effects.js';

export type LayoutBox = { left: number; top: number; width: number; height: number };

export type VisualOverlay = {
  // W8 F16 에서 tiltShift·dust·vhs·filmScratch·crt·mosaicGrout 가 늘었다 (effects.ts EffectOverlay).
  kind:
    | 'grain' | 'scanlines' | 'lightLeak' | 'flash'
    | 'tiltShift' | 'dust' | 'vhs' | 'filmScratch' | 'crt' | 'mosaicGrout';
  params: Record<string, number | string>;
};

export type VisualSvgFilter = {
  // dirBlur = 방향성 블러 (W8 F3-C 전환용 + F16 효과용).
  // W8 F16 에서 discrete·linearTransfer·bloom·blurMix·pixelate·displace·edge·emboss 가 늘었다.
  kind:
    | 'curves' | 'chromaKey' | 'sharpen' | 'glow' | 'chromaShift' | 'colorMatrix' | 'dirBlur'
    | 'discrete' | 'linearTransfer' | 'bloom' | 'blurMix' | 'pixelate' | 'displace' | 'edge' | 'emboss';
  id: string; // <filter> 안에서 이 스테이지의 result 이름
  data: unknown;
};

/**
 * WebGL 효과 스테이지 (W8 #8 — vibrance·bokeh·radialBlur·mirror·kaleidoscope·halftone).
 * **소스 픽셀에 가장 먼저** 걸린다(커브·CSS·SVG 보다 앞). 렌더는 Remotion `createEffect` 로,
 * 미리보기는 gl-passes 로 **같은 GLSL** 을 돌린다. 수치는 `effectGlStages` 가 한 번만 정규화한다.
 */
export type VisualGlStage = GlStageData & { id: string };

export type VisualLayout = {
  box: LayoutBox; // 캔버스 px — 클립 상자(크롭 후 크기)
  inner: LayoutBox; // box 안 미디어 위치(크롭 오프셋 반영)
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  opacity: number;
  cssFilter: string; // 효과 중 CSS filter 로 되는 부분
  blendMode?: string;
  vignette: number;
  overlays: VisualOverlay[];
  svgFilters: VisualSvgFilter[]; // 색 연산 순서 전체 = curvesFilters + effectFilters
  // ── 계획서 타입에서 늘린 필드 ──
  /** 색조정 커브 전용 <filter> 스테이지 (0개 또는 1개). CSS 효과보다 **먼저** 적용된다. */
  curvesFilters: VisualSvgFilter[];
  /** 효과 SVG + 크로마키 <filter> 스테이지. CSS 효과보다 **나중에** 적용된다. */
  effectFilters: VisualSvgFilter[];
  curvesFilterId: string | null; // curvesFilters 를 담은 <filter> 의 id (없으면 null)
  filterId: string | null; // effectFilters 를 담은 <filter> 의 id (없으면 null)
  wideFilterRegion: boolean; // glow/chromaShift 로 필터 영역을 넓혀야 하는가
  /** WebGL 효과 스테이지 — 비어 있으면 미디어는 예전 그대로(<Img>/<OffthreadVideo>) 그린다. */
  glStages: VisualGlStage[];
  /**
   * 클립 마스크 — **정규화된 진실**. `clip.masks` 가 있으면 그것, 없으면 `clip.mask` 한 장,
   * 둘 다 없으면 빈 배열이다. `dKeys`(모양 키프레임)는 이 시각의 `d` 로 이미 풀려 있다.
   */
  maskLayers: Mask[];
  /** 첫 레이어의 별칭(하위호환 — 「마스크가 걸려 있나」를 보는 코드용). box 에 적용된다. */
  mask?: Mask;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 클립 한 개의 합성 레이아웃을 계산한다. tMs = 클립 시작 기준 ms.
 * contain-fit: scale 1 = 캔버스에 맞춤 (Global Constraints).
 */
export function computeVisualLayout(args: {
  clip: VideoClip | ImageClip;
  asset: Asset;
  canvasW: number;
  canvasH: number;
  tMs: number;
}): VisualLayout {
  const { clip, asset, canvasW, canvasH, tMs } = args;

  // 키프레임은 **여기 한 곳에서** 통과시킨다 (W8 S1). 이 아래는 c 를 «그냥 읽는다» —
  // 새 경로(effects#…/mask/crop/chromaKey)를 추가해도 이 함수는 안 고친다.
  const c = applyKeyframes(clip, tMs);

  const tr = c.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
  const { x, y, scale, rotation } = tr;
  const opacity = clamp01(c.opacity ?? 1);

  const aw = asset.width && asset.width > 0 ? asset.width : canvasW;
  const ah = asset.height && asset.height > 0 ? asset.height : canvasH;
  const fit = Math.min(canvasW / aw, canvasH / ah);
  const fitW = aw * fit;
  const fitH = ah * fit;

  const crop = c.crop;
  const boxW = crop ? fitW * crop.w : fitW;
  const boxH = crop ? fitH * crop.h : fitH;
  const innerLeft = crop ? -crop.x * fitW : 0;
  const innerTop = crop ? -crop.y * fitH : 0;

  // ── 적용 순서: WebGL 효과 → 커브 → CSS 효과 → 효과 SVG → 크로마키 ──
  // 커브(색보정)는 CSS 효과보다 **먼저** 와야 한다. CSS `filter` 는 왼쪽부터 차례로 적용되므로
  // 커브를 하나의 <filter> 로 따로 떼어 CSS 효과 **앞**에 붙인다(layoutMediaFilter 참고).
  // 커브를 효과와 같은 <filter> 에 넣으면 CSS 효과가 먼저 걸려버린다(반전 영상의 그림자가 올라간다).
  // 크로마키는 v1 렌더 결과를 지키려고 지금 자리(효과 뒤 SVG 체인 끝)에 그대로 둔다.
  const filterId = `fx-${clip.id}`;
  const curveStages: SvgStageData[] = [];
  const tables = c.curves ? curvesToTables(c.curves) : null;
  if (tables) curveStages.push({ kind: 'curves', data: tables });
  const effectStages: SvgStageData[] = [...effectSvgStages(c.effects)];
  // 영상뿐 아니라 «이미지»에도 건다 — 초록 배경 제품 컷아웃·AI 생성 이미지가 흔하다.
  // (스키마가 받고 저장하는데 렌더가 무시하면 「걸었는데 아무 일도 안 일어난다」가 된다.)
  if ((c.kind === 'video' || c.kind === 'image') && c.chromaKey) {
    effectStages.push({ kind: 'chromaKey', data: chromaKeyParams(c.chromaKey) });
  }
  const stages: SvgStageData[] = [...curveStages, ...effectStages];
  // result 이름(id)은 체인 전체 기준 번호를 유지한다 — 두 <filter> 로 나뉘어도 v1 과 같은 이름.
  const svgFilters: VisualSvgFilter[] = stages.map((s, i) => ({
    kind: s.kind,
    id: `${filterId}s${i}`,
    data: s.data,
  }));
  const curvesFilters = svgFilters.slice(0, curveStages.length);
  const effectFilters = svgFilters.slice(curveStages.length);

  // WebGL 효과 — 커브·CSS·SVG 체인 «앞»에서 소스 픽셀에 걸린다 (gl-effects.ts 머리 주석).
  const glStages: VisualGlStage[] = effectGlStages(c.effects).map((s, i) => ({
    ...s,
    id: `${filterId}g${i}`,
  }));

  const overlaySpecs: EffectOverlay[] = effectOverlays(c.effects);
  const overlays: VisualOverlay[] = overlaySpecs.map((o) => {
    if (o.kind === 'scanlines' || o.kind === 'crt') {
      // 줄 간격은 캔버스 높이 기준 — 소스 해상도가 달라도 같은 밀도로 보인다 (W8 F16: crt 도 같다)
      return {
        kind: o.kind,
        params: { ...o.params, period: canvasH / o.params.lines },
      };
    }
    return { kind: o.kind, params: { ...o.params } };
  });

  // 마스크 정규화 — `masks` 가 있으면 `mask` 는 무시된다(계획 09 §스키마 변경).
  // `dKeys` 는 여기서 이 시각의 `d` 로 푼다. 아래 렌더 코드는 «그냥 읽는다».
  const rawMasks: Mask[] = c.masks && c.masks.length > 0 ? c.masks : c.mask ? [c.mask] : [];
  const maskLayers: Mask[] = rawMasks.map((m) => {
    if (m.shape !== 'path' || !m.dKeys || m.dKeys.length === 0) return m;
    const d = resolveMaskD(m, tMs);
    return d === m.d ? m : { ...m, d };
  });

  return {
    box: {
      left: (canvasW - boxW) / 2 + x * canvasW,
      top: (canvasH - boxH) / 2 + y * canvasH,
      width: boxW,
      height: boxH,
    },
    inner: { left: innerLeft, top: innerTop, width: fitW, height: fitH },
    scaleX: scale * (tr.flipH ? -1 : 1),
    scaleY: scale * (tr.flipV ? -1 : 1),
    rotationDeg: rotation,
    opacity,
    cssFilter: effectsToFilter(c.effects),
    ...(c.blendMode && c.blendMode !== 'normal' ? { blendMode: c.blendMode } : {}),
    vignette: vignetteAmount(c.effects),
    overlays,
    svgFilters,
    curvesFilters,
    effectFilters,
    curvesFilterId: curvesFilters.length > 0 ? `curves-${clip.id}` : null,
    filterId: effectFilters.length > 0 ? filterId : null,
    wideFilterRegion: needsWideFilterRegion(stages),
    glStages,
    maskLayers,
    ...(maskLayers.length > 0 ? { mask: maskLayers[0] } : {}),
  };
}

// ── 마스크 좌표 변환 (펜 툴이 쓰는 «정답 조건») ───────────────────────────
//
// 포인터는 **캔버스 px** 에 있고 마스크는 **마스크 상자 0..1** 에 산다. 그 사이에 클립의
// `transform: scale(...) rotate(...)` 가 끼어 있다(clips.tsx 의 boxStyle). CSS 변환 목록은
// 왼쪽부터 곱해지므로 화면점 = 중심 + S·R·(로컬점 − 중심) 이고, 역변환은 S⁻¹ 다음 R⁻¹ 다.
// **UI 가 자기 식으로 다시 계산하면 갈린다** — 정변환과 나란히 여기 둔다.

type XY = { x: number; y: number };

/** 마스크 상자 0..1 → 캔버스 px (정변환). */
export function maskCanvasFromLocal(layout: VisualLayout, mask: Mask, u: number, v: number): XY {
  const bw = layout.box.width;
  const bh = layout.box.height;
  const lx = (mask.x + u * mask.w) * bw;
  const ly = (mask.y + v * mask.h) * bh;
  const dx = lx - bw / 2;
  const dy = ly - bh / 2;
  const th = (layout.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return {
    x: layout.box.left + bw / 2 + rx * layout.scaleX,
    y: layout.box.top + bh / 2 + ry * layout.scaleY,
  };
}

/** 캔버스 px → 마스크 상자 0..1 (역변환). 회전·배율·뒤집기를 전부 되돌린다. */
export function maskLocalFromCanvas(layout: VisualLayout, mask: Mask, px: number, py: number): XY {
  const bw = layout.box.width;
  const bh = layout.box.height;
  const sx = layout.scaleX === 0 ? 1e-6 : layout.scaleX;
  const sy = layout.scaleY === 0 ? 1e-6 : layout.scaleY;
  const dx = (px - (layout.box.left + bw / 2)) / sx;
  const dy = (py - (layout.box.top + bh / 2)) / sy;
  const th = (-layout.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  const lx = rx + bw / 2;
  const ly = ry + bh / 2;
  const cx = bw === 0 ? 0 : lx / bw;
  const cy = bh === 0 ? 0 : ly / bh;
  return {
    x: mask.w === 0 ? 0 : (cx - mask.x) / mask.w,
    y: mask.h === 0 ? 0 : (cy - mask.y) / mask.h,
  };
}

/**
 * 레이아웃 → 미디어에 걸 최종 CSS filter 문자열.
 * 순서: **커브 → CSS 효과 → 효과 SVG 체인**. CSS `filter` 리스트는 왼쪽부터 적용되고
 * `url()` 은 그 안에 자유롭게 섞을 수 있다. 커브가 없으면 `url(#curves-…)` 를 넣지 않으므로
 * 커브 없는 클립의 문자열은 v1 과 완전히 같다.
 */
export function layoutMediaFilter(layout: VisualLayout): string {
  const parts: string[] = [];
  if (layout.curvesFilterId) parts.push(`url(#${layout.curvesFilterId})`);
  if (layout.cssFilter) parts.push(layout.cssFilter);
  if (layout.filterId) parts.push(`url(#${layout.filterId})`);
  return parts.join(' ');
}
