// 비디오/이미지/오디오 클립 렌더링: transform/crop/mask/커브/effects/전환/키프레임/볼륨
// + W5: freeze · loop · speedRamp · 파생 미디어. 합성 수식은 @kitkat/renderer/layout 이 소유한다.
// + W8 F3-B: 트랜스폼 모션 블러(셔터 구간 N등분 겹쳐 그리기) · F3-C: 전환 방향성 블러.
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Freeze,
  Img,
  Loop,
  OffthreadVideo,
  Sequence,
  getRemotionEnvironment,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { Asset, AudioClip, ImageClip, Mask, Track, VideoClip } from '@kitkat/schema';
import { computeVisualLayout, layoutMediaFilter, type VisualLayout } from '../layout/index.js';
import { maskPathToPx } from '../layout/mask-path.js';
import { interpolateKeyframes, msToFrames } from './keyframes.js';
import {
  activeTransitionBlurs,
  activeTransitionOverlays,
  activeTransitionStyles,
  type TransitionBlurSpec,
  type TransitionOverlay,
} from './transitions.js';
import { resolveAudioSrc, resolveMediaSrc, resolveMediaWindow } from './media-src.js';
import { ClipFilterDefs, TransitionBlurDefs } from './svg-filters.js';
import { EffectOverlayViews } from './overlays.js';
import { GlImageMedia, GlVideoEffects, type GlVideoFrameSource } from './webgl-effects.js';
import {
  TRANSFORM_BLUR_GROUP_STYLE,
  transformBlurLayerStyle,
  transformBlurOffsets,
} from './transform-blur.js';
import { quantizeVolume, volumePeak } from './volume.js';
import {
  hasSpeedRamp,
  loopDurationInFrames,
  mediaTrimFrames,
  rampAudioSequences,
  rampSegmentFade,
  rampSequences,
} from './ramp.js';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 오디오 페이드 배율 (선형). tMs = 클립 시작 기준 ms. */
export function fadeFactor(tMs: number, durationMs: number, fadeIn?: number, fadeOut?: number): number {
  let f = 1;
  if (fadeIn && fadeIn > 0) f *= clamp01(tMs / fadeIn);
  if (fadeOut && fadeOut > 0) f *= clamp01((durationMs - tMs) / fadeOut);
  return f;
}

/**
 * 클립×트랙×키프레임×페이드 볼륨. Player에서는 ≤1 클램프 (C4).
 *
 * `at(f)` 가 프레임별 값이고, `settle(v)` 는 «곱셈이 더 붙은 뒤» 한 번 더 부르는 마감이다
 * (속도 램프의 세그먼트 크로스페이드처럼). 최대치(peak)는 여기서 한 번만 계산한다 —
 * 호출부가 같은 식을 다시 적으면 두 곳이 갈린다.
 */
function makeVolumeFn(
  clip: VideoClip | AudioClip,
  track: Track,
  fps: number,
  isRendering: boolean,
): { at: (f: number) => number; settle: (v: number) => number } {
  const trackVolume = track.muted ? 0 : track.volume ?? 1;
  // 렌더에서는 볼륨이 1을 넘을 수 있는데(클립 0..2 × 트랙 0..2), 그러면 remotion 이 만드는
  // ffmpeg if() 중첩이 100겹을 넘어 렌더가 통째로 실패한다. volume.ts 참고.
  const peak = volumePeak(clip.volume, trackVolume, clip.keyframes);
  const settle = (v: number): number => (isRendering ? quantizeVolume(v, peak) : Math.min(1, v));
  const at = (f: number): number => {
    const tMs = (f / fps) * 1000;
    let v = interpolateKeyframes(clip.keyframes, 'volume', tMs, clip.volume);
    v *= trackVolume;
    v *= fadeFactor(tMs, clip.duration, clip.fadeIn, clip.fadeOut);
    return settle(Math.max(0, v));
  };
  return { at, settle };
}

function maskStyle(mask: Mask): React.CSSProperties {
  const on = mask.invert ? 'transparent' : '#fff';
  const off = mask.invert ? '#fff' : 'transparent';
  const cx = (mask.x + mask.w / 2) * 100;
  const cy = (mask.y + mask.h / 2) * 100;
  const feather = clamp01(mask.feather);
  if (mask.shape === 'circle') {
    const solid = Math.max(0, (1 - feather) * 100);
    const image = `radial-gradient(ellipse ${(mask.w / 2) * 100}% ${(mask.h / 2) * 100}% at ${cx}% ${cy}%, ${on} ${solid}%, ${off} 100%)`;
    return { WebkitMaskImage: image, maskImage: image };
  }
  if (mask.shape === 'linear') {
    const image = `linear-gradient(to bottom, ${off} ${mask.y * 100}%, ${on} ${(mask.y + mask.h * feather) * 100}%, ${on} ${(mask.y + mask.h * (1 - feather)) * 100}%, ${off} ${(mask.y + mask.h) * 100}%)`;
    return { WebkitMaskImage: image, maskImage: image };
  }
  // rect: 가로/세로 그라디언트 2장 교차(intersect)
  const fx = (feather * mask.w) / 2;
  const fy = (feather * mask.h) / 2;
  const h = `linear-gradient(to right, ${off} ${mask.x * 100}%, ${on} ${(mask.x + fx) * 100}%, ${on} ${(mask.x + mask.w - fx) * 100}%, ${off} ${(mask.x + mask.w) * 100}%)`;
  const v = `linear-gradient(to bottom, ${off} ${mask.y * 100}%, ${on} ${(mask.y + fy) * 100}%, ${on} ${(mask.y + mask.h - fy) * 100}%, ${off} ${(mask.y + mask.h) * 100}%)`;
  return {
    WebkitMaskImage: `${h}, ${v}`,
    maskImage: `${h}, ${v}`,
    WebkitMaskComposite: 'source-in',
    maskComposite: 'intersect',
  };
}

// ── W8 F9 — 자유 마스크 (path) · 여러 장 겹치기 · 반전 ────────────────────
//
// 두 갈래다:
//   feather === 0 이고 한 장이면  →  `clip-path: path(...)`  (가장 싸다. 단위가 px 뿐인데
//                                    layout.box 가 이미 px 라 마침 딱 맞는다)
//   그 밖                        →  SVG `<mask mask-type="alpha">` + `feGaussianBlur`
//
// **alpha 마스크를 쓴다.** 기존 3종이 `linear-gradient(#fff → transparent)` = 알파 방식이라
// luminance 를 섞으면 같은 feather 가 모양에 따라 다른 두께로 보인다. 그리고 luminance 는
// 흰 도형을 흐릴 때 «투명한 검정»으로 번져 프리멀티플라이 때문에 경계가 어두워진다.

/** 페더 → 가우시안 σ (클립 상자 px). 계획 09 의 `feather · min(boxW,boxH) / 2`. */
export function maskSigma(feather: number, boxW: number, boxH: number): number {
  return (clamp01(feather) * Math.min(boxW, boxH)) / 2;
}

export type SvgMaskSpec = {
  id: string;
  /** 마스크·필터 영역 (클립 상자 기준 px). 번진 가장자리가 잘리지 않게 넓힌다 */
  region: { x: number; y: number; width: number; height: number };
  sigma: number;
  invert: boolean;
  /** px 로 옮긴 자유 곡선 */
  d?: string;
  /** 사각 마스크 */
  rect?: { x: number; y: number; width: number; height: number };
};

function svgMaskSpec(mask: Mask, boxW: number, boxH: number, id: string): SvgMaskSpec | null {
  const sigma = maskSigma(mask.feather, boxW, boxH);
  const pad = Math.max(2, sigma * 3);
  const region = { x: -pad, y: -pad, width: boxW + pad * 2, height: boxH + pad * 2 };
  const invert = mask.invert === true;
  if (mask.shape === 'path') {
    const d = mask.d ? maskPathToPx(mask.d, mask, boxW, boxH) : null;
    if (!d) return null;
    return { id, region, sigma, invert, d };
  }
  if (mask.shape === 'rect') {
    return {
      id, region, sigma, invert,
      rect: { x: mask.x * boxW, y: mask.y * boxH, width: mask.w * boxW, height: mask.h * boxH },
    };
  }
  return null;
}

/** 반전한 하드 마스크 — 바깥 사각형을 앞에 두고 evenodd 로 «구멍»을 낸다. */
function invertedPath(d: string, boxW: number, boxH: number): string {
  return `M0,0 L${boxW},0 L${boxW},${boxH} L0,${boxH} Z ${d}`;
}

/** 그라디언트 한 장으로 되는 모양(circle·linear) — 기존 maskStyle 과 **같은 문자열**이다. */
function gradientImage(mask: Mask): string | null {
  const on = mask.invert ? 'transparent' : '#fff';
  const off = mask.invert ? '#fff' : 'transparent';
  const feather = clamp01(mask.feather);
  if (mask.shape === 'circle') {
    const cx = (mask.x + mask.w / 2) * 100;
    const cy = (mask.y + mask.h / 2) * 100;
    const solid = Math.max(0, (1 - feather) * 100);
    return `radial-gradient(ellipse ${(mask.w / 2) * 100}% ${(mask.h / 2) * 100}% at ${cx}% ${cy}%, ${on} ${solid}%, ${off} 100%)`;
  }
  if (mask.shape === 'linear') {
    return `linear-gradient(to bottom, ${off} ${mask.y * 100}%, ${on} ${(mask.y + mask.h * feather) * 100}%, ${on} ${(mask.y + mask.h * (1 - feather)) * 100}%, ${off} ${(mask.y + mask.h) * 100}%)`;
  }
  return null;
}

const COMPOSITE_STD = { add: 'add', subtract: 'subtract', intersect: 'intersect' } as const;
const COMPOSITE_WK = { add: 'source-over', subtract: 'source-out', intersect: 'source-in' } as const;

export type MaskCss = { style: React.CSSProperties; defs: SvgMaskSpec[] };

/**
 * 마스크 레이어들 → CSS + 필요한 SVG `<mask>` 목록.
 *
 * - 한 장 · path 아님 → **v1 `maskStyle` 그대로**(픽셀 완전 일치)
 * - 한 장 · path · feather 0 → `clip-path: path()` (반전은 evenodd 로 구멍)
 * - 그 밖 → SVG `<mask>` 참조
 *
 * 여러 장일 때 CSS 는 **아래 레이어부터 접는다**: `m0 op1 (m1 op2 (m2 …))`.
 * 두 장(검증 §4 가 재는 경우)에서는 「m0 을 m1 로 판다/교차한다」와 정확히 같다.
 */
export function maskLayerCss(masks: Mask[], boxW: number, boxH: number, idBase: string): MaskCss {
  if (masks.length === 0) return { style: {}, defs: [] };
  if (masks.length === 1) {
    const m = masks[0]!;
    if (m.shape !== 'path') return { style: maskStyle(m), defs: [] };
    const pxD = m.d ? maskPathToPx(m.d, m, boxW, boxH) : null;
    if (!pxD) return { style: {}, defs: [] };
    if (clamp01(m.feather) === 0) {
      const path = m.invert
        ? `path(evenodd, "${invertedPath(pxD, boxW, boxH)}")`
        : `path("${pxD}")`;
      return { style: { clipPath: path, WebkitClipPath: path } as React.CSSProperties, defs: [] };
    }
    const spec = svgMaskSpec(m, boxW, boxH, `${idBase}m0`);
    if (!spec) return { style: {}, defs: [] };
    const url = `url(#${spec.id})`;
    return { style: { WebkitMaskImage: url, maskImage: url }, defs: [spec] };
  }

  const images: string[] = [];
  const std: string[] = [];
  const wk: string[] = [];
  const defs: SvgMaskSpec[] = [];
  masks.forEach((m, i) => {
    let image = gradientImage(m);
    if (image === null) {
      const spec = svgMaskSpec(m, boxW, boxH, `${idBase}m${i}`);
      if (!spec) return;
      defs.push(spec);
      image = `url(#${spec.id})`;
    }
    // i 번 레이어의 합성 방식은 «그 아래 결과»와 어떻게 합칠지 = masks[i+1] 의 op 다.
    const op = masks[i + 1]?.op ?? 'add';
    images.push(image);
    std.push(i === masks.length - 1 ? 'add' : COMPOSITE_STD[op]);
    wk.push(i === masks.length - 1 ? 'source-over' : COMPOSITE_WK[op]);
  });
  if (images.length === 0) return { style: {}, defs: [] };
  return {
    style: {
      WebkitMaskImage: images.join(', '),
      maskImage: images.join(', '),
      WebkitMaskComposite: wk.join(', '),
      maskComposite: std.join(', '),
    } as React.CSSProperties,
    defs,
  };
}

/**
 * SVG `<mask>` 정의들. **`mask-type="alpha"` · `maskUnits="userSpaceOnUse"` · 명시적 x/y/w/h**
 * 를 빠뜨리면 안 된다 — 기본값은 objectBoundingBox 의 −10%..110% 인데 이 컨테이너가
 * `<svg width="0" height="0">` 라 좌표계가 0 이어서 아무것도 안 보이거나 전부 보인다.
 * `color-interpolation-filters="sRGB"` 도 필수 — 기본값 linearRGB 면 페더의 감쇠 곡선이 달라진다.
 * 반전은 «흰 사각형에 구멍»이 아니라 **알파를 뒤집어서**(feFuncA table 1 0) 한다 — 번진 뒤에
 * 뒤집어야 경계가 대칭이 된다.
 */
export const MaskDefs: React.FC<{ defs: SvgMaskSpec[] }> = ({ defs }) => {
  if (defs.length === 0) return null;
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        {defs.map((m) => {
          const needsFilter = m.sigma > 0 || m.invert;
          const fid = `${m.id}f`;
          return (
            <React.Fragment key={m.id}>
              {needsFilter ? (
                <filter
                  id={fid}
                  filterUnits="userSpaceOnUse"
                  x={m.region.x}
                  y={m.region.y}
                  width={m.region.width}
                  height={m.region.height}
                  colorInterpolationFilters="sRGB"
                >
                  {m.sigma > 0 ? <feGaussianBlur stdDeviation={m.sigma} /> : null}
                  {m.invert ? (
                    <feComponentTransfer>
                      <feFuncA type="table" tableValues="1 0" />
                    </feComponentTransfer>
                  ) : null}
                </filter>
              ) : null}
              <mask
                id={m.id}
                maskUnits="userSpaceOnUse"
                x={m.region.x}
                y={m.region.y}
                width={m.region.width}
                height={m.region.height}
                style={{ maskType: 'alpha' }}
              >
                {m.d ? (
                  <path d={m.d} fill="#fff" {...(needsFilter ? { filter: `url(#${fid})` } : {})} />
                ) : m.rect ? (
                  <rect
                    x={m.rect.x}
                    y={m.rect.y}
                    width={m.rect.width}
                    height={m.rect.height}
                    fill="#fff"
                    {...(needsFilter ? { filter: `url(#${fid})` } : {})}
                  />
                ) : null}
              </mask>
            </React.Fragment>
          );
        })}
      </defs>
    </svg>
  );
};

const Vignette: React.FC<{ amount: number }> = ({ amount }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      background: `radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,${clamp01(amount)}) 100%)`,
    }}
  />
);

/**
 * 전환 스타일들을 풀사이즈 래퍼로 겹겹이 감싼다 (transform 충돌 방지).
 *
 * `blurs[i]` 가 있으면 같은 래퍼에 `filter: url(#…)` 를 건다 (W8 F3-C). 같은 엘리먼트에 filter 와
 * transform 이 같이 있으면 **filter 가 내용에 먼저 걸리고 그 결과에 transform 이 걸린다** —
 * 즉 블러는 «움직이기 전» 좌표계에서 번지므로, 이동만 하는 전환에서는 가로 블러가 화면에서도
 * 가로로 남는다. 전환 스타일이 이미 `filter` 를 갖고 있으면(blurFade·glitch) 뒤에 이어 붙인다.
 */
export const TransitionWrappers: React.FC<{
  styles: React.CSSProperties[];
  blurs?: (TransitionBlurSpec | null)[];
  children: React.ReactNode;
}> = ({ styles, blurs, children }) => {
  let node = children;
  for (let i = styles.length - 1; i >= 0; i--) {
    const b = blurs?.[i];
    const own = styles[i]!.filter;
    node = (
      <div
        style={{
          width: '100%',
          height: '100%',
          ...styles[i],
          ...(b ? { filter: own ? `${own} url(#${b.id})` : `url(#${b.id})` } : {}),
        }}
      >
        {node}
      </div>
    );
  }
  return <>{node}</>;
};

/** 전환 덮개(whiteFlash/blackFlash/glitch) — 클립 위 전체 화면 레이어. */
export const TransitionOverlayViews: React.FC<{ overlays: TransitionOverlay[] }> = ({ overlays }) => {
  if (overlays.length === 0) return null;
  return (
    <>
      {overlays.map((o) => (
        <div key={o.key} style={o.style} />
      ))}
    </>
  );
};

export const VisualClipView: React.FC<{
  clip: VideoClip | ImageClip;
  track: Track;
  asset: Asset | undefined;
  mediaBase: string;
  proxy: boolean;
}> = ({ clip, track, asset, mediaBase, proxy }) => {
  const frame = useCurrentFrame();
  const { fps, width: canvasW, height: canvasH } = useVideoConfig();
  const { isRendering } = getRemotionEnvironment();
  if (!asset) return null;

  const tMs = (frame / fps) * 1000;
  const layout = computeVisualLayout({ clip, asset, canvasW, canvasH, tMs });

  // ── W8 F3-B 트랜스폼 모션 블러 ──
  // 셔터 구간의 시각들에서 레이아웃을 다시 계산한다. 빈 배열이면(=블러 꺼짐) 아래 경로가
  // v1 과 한 픽셀도 다르지 않다 — 겹쳐 그리기 자체를 하지 않는다.
  const blurOffsets = transformBlurOffsets(clip.transformBlur, fps);
  const layouts: VisualLayout[] =
    blurOffsets.length > 0
      ? blurOffsets.map((off) =>
          computeVisualLayout({ clip, asset, canvasW, canvasH, tMs: tMs + off }),
        )
      : [layout];

  // 마스크는 상자와 **같은 요소**에 건다. 규격상의 순서가 「그리기 → 필터 → 클립/마스크 →
  // 불투명도 → 블렌드」라 마스크가 먼저, 블렌드가 나중이고, transform 은 마스크까지 포함한
  // 결과 전체에 걸린다(= 마스크가 클립과 함께 돈다). 실제 프레임으로 확인했다 —
  // scripts/w8-f8f9-render-check.mjs 의 `mask` 검사(회전 0°/30° × 블렌드 유무 8조합).
  const maskCss = maskLayerCss(layout.maskLayers, layout.box.width, layout.box.height, clip.id);
  const boxStyleOf = (l: VisualLayout): React.CSSProperties => ({
    position: 'absolute',
    left: l.box.left,
    top: l.box.top,
    width: l.box.width,
    height: l.box.height,
    overflow: 'hidden',
    transform: `scale(${l.scaleX}, ${l.scaleY}) rotate(${l.rotationDeg}deg)`,
    opacity: l.opacity,
    ...(l.blendMode ? { mixBlendMode: l.blendMode as React.CSSProperties['mixBlendMode'] } : {}),
    ...maskLayerCss(l.maskLayers, l.box.width, l.box.height, clip.id).style,
  });
  const boxStyle = boxStyleOf(layout);

  // 색 체인(<filter> id)은 **가운데 시각 것 하나**만 만든다. 샘플마다 id 가 같아서 defs 를
  // N개 그리면 첫 번째만 살아남는다 — 애초에 이 블러는 «움직임» 을 흐리는 것이지 색을 바꾸는
  // 것이 아니므로, 샘플 사이에서 달라지는 것은 상자 기하(위치·크기·회전)뿐이다.
  const mediaFilter = layoutMediaFilter(layout);
  const mediaStyleOf = (l: VisualLayout): React.CSSProperties => ({
    position: 'absolute',
    left: l.inner.left,
    top: l.inner.top,
    width: l.inner.width,
    height: l.inner.height,
    ...(mediaFilter ? { filter: mediaFilter } : {}),
  });
  const mediaStyle = mediaStyleOf(layout);

  /**
   * 미디어 노드. `silent` 면 소리를 뺀다 — 블러로 N장을 겹쳐 그릴 때 소리까지 N개면
   * 믹스가 N배로 커진다. 첫 장만 소리를 낸다.
   */
  const buildMedia = (mediaStyle: React.CSSProperties, silent: boolean): React.ReactNode => {
    // ── W8 #8 WebGL 효과 — 미디어를 셰이더에 태워 캔버스로 바꿔 그린다 ──
    // 원래 미디어 요소는 «숨긴 채» 그대로 둔다(영상의 소리·타이밍·프레임 추출은 그 요소가 한다).
    // CSS filter(커브·CSS·SVG 체인)는 결과 캔버스 쪽에 걸린다 → WebGL 효과가 언제나 체인 앞이다.
    const glOn = layout.glStages.length > 0;
    const { filter: _mediaFilter, ...noFilter } = mediaStyle;
    const rawStyle: React.CSSProperties = glOn ? { ...noFilter, visibility: 'hidden' } : mediaStyle;
    const glVideoProps = (cb: ((img: GlVideoFrameSource) => void) | null) =>
      cb ? { onVideoFrame: cb, crossOrigin: 'anonymous' as const } : {};

    if (clip.kind === 'image') {
      const src = resolveMediaSrc(clip, asset, mediaBase, proxy).src;
      if (!glOn) return <Img src={src} style={mediaStyle} />;
      return (
        <GlImageMedia
          src={src}
          width={layout.inner.width}
          height={layout.inner.height}
          stages={layout.glStages}
          style={mediaStyle}
        />
      );
    }

    const buildVideo = (
      mediaStyle: React.CSSProperties,
      onVideoFrame: ((img: GlVideoFrameSource) => void) | null,
    ): React.ReactNode => {
      let media: React.ReactNode;
      const { src, inMs, outMs } = resolveMediaWindow(clip, asset, mediaBase, proxy);
      const rate = (r: number): number => (isRendering ? r : Math.min(16, r));
      if (hasSpeedRamp(clip)) {
        // 속도 램프: 등속 세그먼트마다 OffthreadVideo 하나.
        const srcOffsetMs = inMs - clip.in; // reversed 파일 보정 (정방향/파생이면 0)
        // 세그먼트 크로스페이드가 곱해지면 at() 안에서 한 격자 스냅이 풀린다.
        // 그래서 «곱한 뒤에» settle() 로 한 번 더 스냅한다 (volume.ts 의 ffmpeg if() 100겹 한계).
        const { at: clipVolume, settle } = makeVolumeFn(clip, track, fps, isRendering);
        const framePeriodMs = 1000 / fps;
        // 그림은 세그먼트를 빈틈없이 이어 붙여야 하고(겹치면 두 번 그린다), 소리는 반대로 겹쳐야
        // 경계 클릭음이 사라진다 — 그래서 소리는 <Audio> 로 따로 깐다.
        media = (
          <>
            {rampSequences(clip, fps, srcOffsetMs).map((s) => (
              <Sequence key={s.key} from={s.from} durationInFrames={s.durationInFrames} layout="none">
                <OffthreadVideo
                  src={src}
                  trimBefore={s.trimBefore}
                  trimAfter={s.trimAfter}
                  playbackRate={rate(s.playbackRate)}
                  muted
                  style={mediaStyle}
                  {...glVideoProps(onVideoFrame)}
                />
              </Sequence>
            ))}
            {(silent ? [] : rampAudioSequences(clip, fps, srcOffsetMs)).map((a, i, all) => (
              <Sequence key={a.key} from={a.from} durationInFrames={a.durationInFrames} layout="none">
                <Audio
                  src={src}
                  trimBefore={a.trimBefore}
                  trimAfter={a.trimAfter}
                  playbackRate={rate(a.playbackRate)}
                  muted={track.muted === true}
                  // 프레임 **가운데** 시각으로 잰다 — 시작 시각으로 재면 첫 프레임이 통째로 0 이 된다.
                  volume={(f) =>
                    settle(
                      clipVolume(a.from + f) *
                        rampSegmentFade(
                          (f + 0.5) * framePeriodMs,
                          a.durationInFrames * framePeriodMs,
                          i,
                          all.length,
                          a.fadeMs,
                        ),
                    )
                  }
                  allowAmplificationDuringRender
                />
              </Sequence>
            ))}
          </>
        );
      } else if (clip.freeze === true) {
        // 정지화면: in 시점의 한 프레임을 duration 내내 보여준다
        const f = msToFrames(inMs, fps);
        media = (
          <Freeze frame={f}>
            <OffthreadVideo
              src={src}
              trimBefore={0}
              trimAfter={f + 1}
              playbackRate={1}
              muted
              style={mediaStyle}
              {...glVideoProps(onVideoFrame)}
            />
          </Freeze>
        );
      } else {
        // loop 이면 미디어가 보여야 하는 길이는 클립 전체가 아니라 소스 1회분
        const displayMs =
          clip.loop === true ? Math.round((clip.out - clip.in) / clip.speed) : clip.duration;
        const trim = mediaTrimFrames(inMs, outMs, displayMs, fps);
        const video = (
          <OffthreadVideo
            src={src}
            trimBefore={trim.trimBefore}
            trimAfter={trim.trimAfter}
            playbackRate={rate(clip.speed)}
            muted={silent || track.muted === true}
            {...(silent ? {} : { volume: makeVolumeFn(clip, track, fps, isRendering).at })}
            allowAmplificationDuringRender
            style={mediaStyle}
            {...glVideoProps(onVideoFrame)}
          />
        );
        media =
          clip.loop === true ? (
            <Loop durationInFrames={loopDurationInFrames(clip, fps)}>{video}</Loop>
          ) : (
            video
          );
      }
      return media;
    };

    if (!glOn) return buildVideo(mediaStyle, null);
    return (
      <GlVideoEffects
        width={layout.inner.width}
        height={layout.inner.height}
        stages={layout.glStages}
        style={mediaStyle}
      >
        {(cb) => buildVideo(rawStyle, cb)}
      </GlVideoEffects>
    );
  };

  const transitionStyles = activeTransitionStyles(tMs, clip.duration, clip.transitionIn, clip.transitionOut);
  const transitionBlurs = activeTransitionBlurs(
    tMs,
    clip.duration,
    clip.id,
    canvasH / 1080,
    clip.transitionIn,
    clip.transitionOut,
  );
  const overlays = activeTransitionOverlays(tMs, clip.duration, clip.transitionIn, clip.transitionOut);
  const blurDefs = transitionBlurs.filter((b): b is TransitionBlurSpec => b !== null);

  // 비네트·그레인·스캔라인은 «화면에 붙은 질감»이라 같이 흐리면 안 된다 (특히 그레인 —
  // 프레임마다 다른 노이즈를 겹쳐 그리면 노이즈가 뭉개져 사라진다). 겹쳐 그리는 상자 밖에
  // 가운데 시각의 상자를 한 장 더 놓고 거기에만 얹는다.
  const decor =
    layout.vignette > 0 || layout.overlays.length > 0 ? (
      <>
        {layout.vignette > 0 ? <Vignette amount={layout.vignette} /> : null}
        <EffectOverlayViews idBase={clip.id} overlays={layout.overlays} />
      </>
    ) : null;

  const stack =
    blurOffsets.length > 0 ? (
      <>
        {/* isolation:isolate 가 없으면 첫 장이 «아래 클립»과 더해져 화면이 하얘진다 */}
        <div style={TRANSFORM_BLUR_GROUP_STYLE}>
          {layouts.map((l, i) => (
            <div
              key={i}
              style={{ position: 'absolute', inset: 0, ...transformBlurLayerStyle(layouts.length) }}
            >
              <div style={boxStyleOf(l)}>{buildMedia(mediaStyleOf(l), i > 0)}</div>
            </div>
          ))}
        </div>
        {decor ? <div style={boxStyle}>{decor}</div> : null}
      </>
    ) : (
      <div style={boxStyle}>
        {buildMedia(mediaStyle, false)}
        {decor}
      </div>
    );

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {layout.curvesFilterId ? (
        // 커브는 CSS 효과 **앞**에 걸려야 해서 별도 <filter> 다 (layoutMediaFilter 가 순서를 만든다)
        <ClipFilterDefs id={layout.curvesFilterId} stages={layout.curvesFilters} wideRegion={false} />
      ) : null}
      {layout.filterId ? (
        <ClipFilterDefs
          id={layout.filterId}
          stages={layout.effectFilters}
          wideRegion={layout.wideFilterRegion}
        />
      ) : null}
      <TransitionBlurDefs blurs={blurDefs} />
      <MaskDefs defs={maskCss.defs} />
      <TransitionWrappers styles={transitionStyles} blurs={transitionBlurs}>
        {stack}
      </TransitionWrappers>
      <TransitionOverlayViews overlays={overlays} />
    </AbsoluteFill>
  );
};

export const AudioClipView: React.FC<{
  clip: AudioClip;
  track: Track;
  asset: Asset | undefined;
  mediaBase: string;
}> = ({ clip, track, asset, mediaBase }) => {
  const { fps } = useVideoConfig();
  const { isRendering } = getRemotionEnvironment();
  if (!asset) return null;
  const playbackRate = isRendering ? clip.speed : Math.min(16, clip.speed);
  return (
    <Audio
      src={resolveAudioSrc(clip, asset, mediaBase)}
      {...mediaTrimFrames(clip.in, clip.out, clip.duration, fps)}
      playbackRate={playbackRate}
      muted={track.muted === true}
      volume={makeVolumeFn(clip, track, fps, isRendering).at}
      allowAmplificationDuringRender
    />
  );
};
