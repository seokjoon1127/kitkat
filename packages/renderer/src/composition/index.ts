// 브라우저 안전 export (C4 — subpath "@kitkat/renderer/composition")
export { TimelineVideo, type TimelineVideoProps } from './TimelineVideo.js';
export {
  applyKeyframes,
  docDurationMs,
  groupKeyframes,
  interpolateKeyframes,
  interpolateSorted,
  msToFrames,
} from './keyframes.js';
export {
  effectsToFilter,
  vignetteAmount,
  effectSvgStages,
  effectOverlays,
  needsWideFilterRegion,
  scanlinesCss,
  lightLeakCss,
  grainSeed,
  // W8 F16 신규 오버레이 CSS
  tiltShiftMaskCss,
  vhsBandCss,
  crtPhosphorCss,
  mosaicGroutCss,
  filmScratchLines,
  type SvgStageData,
  type EffectOverlay,
} from './effects.js';
export {
  transitionProgress,
  transitionStyle,
  activeTransitionStyles,
  transitionOverlays,
  activeTransitionOverlays,
  transitionBlurAxis,
  transitionSplitPx,
  transitionBlurStrength,
  activeTransitionBlurs,
  type TransitionOverlay,
  type TransitionBlurSpec,
} from './transitions.js';
export {
  transformBlurOffsets,
  transformBlurLayerStyle,
  DEFAULT_TRANSFORM_BLUR,
  TRANSFORM_BLUR_GROUP_STYLE,
} from './transform-blur.js';
export {
  resolveMediaSrc,
  resolveMediaWindow,
  resolveAudioSrc,
} from './media-src.js';
export { hasSpeedRamp, loopDurationInFrames, rampSequences, type RampSequence } from './ramp.js';
export {
  buildFilterNodes,
  ClipFilterDefs,
  TransitionBlurDefs,
  type DirBlurData,
} from './svg-filters.js';
// W8 #8 — WebGL 효과 6종. 순수 모듈(GLSL·유니폼 수식)은 미리보기가 그대로 import 한다.
export {
  effectGlStages,
  glStageUniforms,
  setGlUniforms,
  linkGlEffect,
  bokehStep,
  radialSamples,
  GL_EFFECT_VERT,
  GL_EFFECT_FRAG,
  GL_EFFECT_UNIFORM_NAMES,
  GL_COMMON_UNIFORMS,
  GL_STAGE_KINDS,
  GL_STAGE_LABEL,
  GL_FULL_MEDIA,
  BOKEH_MAX_K,
  RADIAL_MAX_SAMPLES,
  type GlStageData,
  type GlStageKind,
  type GlMediaRect,
  type GlUniform,
} from './gl-effects.js';
export {
  GL_EFFECT_FACTORY,
  glStageDescriptors,
  GlImageMedia,
  GlVideoEffects,
  type GlVideoFrameSource,
} from './webgl-effects.js';
export {
  chromaKeyParams,
  chromaKeyScore,
  chromaKeyAlphaFactor,
  chromaKeyDespill,
  DEFAULT_CHROMA_SPILL,
  type ChromaKeyParams,
} from './svg-data.js';
export {
  computeVisualLayout,
  layoutMediaFilter,
  maskCanvasFromLocal,
  maskLocalFromCanvas,
  type VisualLayout,
  type VisualOverlay,
  type VisualSvgFilter,
  type VisualGlStage,
  type LayoutBox,
} from '../layout/index.js';
// W8 F9 — 자유 마스크의 좌표·모양 계산 (펜 툴 UI 가 «렌더와 같은 함수»를 쓰게 한다)
export {
  circleShape,
  fitMaskBox,
  insertVertex,
  lerpMaskPathD,
  maskPathBounds,
  maskPathToPx,
  nearestOnPath,
  parseMaskShape,
  resolveMaskD,
  segmentPoint,
  serializeMaskShape,
  CIRCLE_K,
  type MaskShapeModel,
  type MaskVertex,
  type Pt,
} from '../layout/mask-path.js';
export { maskLayerCss, maskSigma, MaskDefs, type MaskCss, type SvgMaskSpec } from './clips.js';
// W8 F8 — 키네틱 타이포. **렌더러와 미리보기가 이 한 벌을 같이 쓴다.**
export {
  animOpts,
  animUnitStyle,
  breakChunks,
  computeTextLayout,
  glyphStrokeAt,
  legacyEaseOutBack,
  strokePaint,
  measureTextWidth,
  setTextMeasurer,
  splitLines,
  splitUnits,
  staggerOrder,
  staggerTiming,
  textAnimEasing,
  textAnimStaggerMs,
  textAnimUnitOf,
  textCss,
  textCssFont,
  TextLayoutContent,
  type AnimOpts,
  type GlyphStrokeView,
  type SplitPiece,
  type StaggerTiming,
  type TextLayout,
  type TextLayoutArgs,
  type TextLineView,
  type TextMeasurer,
  type TextUnitView,
  type TextWordView,
} from './text-layout.js';
// W8 F8 — 번들 ttf 에서 글리프 윤곽선을 읽는다 (drawStroke 전용)
export {
  ensureFontFile,
  ensureGlyphFont,
  fontFileFor,
  glyphOutline,
  glyphPath,
  loadedFont,
  parseTtf,
  registerFontBytes,
  resetGlyphCache,
  type GlyphOutline,
  type TtfFont,
} from './glyph-path.js';
export {
  BUNDLED_FONTS,
  fontUrl,
  fontFaceCss,
  usedFontFamilies,
  fontLoadSpecs,
  ensureFontsLoaded,
  type BundledFont,
} from './fonts.js';
