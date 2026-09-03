// 프리뷰 엔진 v2 (X9) 공개 표면.
export { FastPreview } from './FastPreview.js';
export { GlCompositor, blurToLod, type GlLayer, type GlCoverLayer } from './gl.js';
export { FrameProvider, webCodecsEnabled, type FrameRequest, type FrameResult } from './decoder.js';
// F14 WebCodecs 프레임 공급기
export {
  createWebCodecsSource, webCodecsSupported,
  type FrameSource, type WebCodecsSourceOptions,
} from './webcodecs.js';
export { AudioMixer, PlaybackClock, type AudioTarget } from './clock.js';
export { FrameRing, LruCache, frameCacheKey, quantizeMs, type Closeable } from './cache.js';
export { Semaphore, assignSlot, makeSlots, type PoolSlot } from './pool.js';
export {
  activeClipsAt,
  advanceClock,
  clipVolume,
  fadeFactor,
  isClipActive,
  isStillClip,
  mediaTimeAt,
  needsResync,
  playbackRateFor,
  sourceTimeAt,
  videoHasAudio,
} from './timing.js';
export {
  blendModeCode,
  composeSvgChain,
  layerColorParams,
  parseCssFilter,
  transitionFlashes,
  transitionParams,
} from './gl-params.js';
// W8 F15 — 「못 그리던 9종」의 파라미터 변환 + 다중 패스 + 실측 차이표
export {
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
  sharpenShaderParams,
  stageLabel,
  type ClipPlan,
  type ClipStage,
  type GlitchOverlay,
  type MaskParams,
  type OverlayParams,
} from './gl-params.js';
export { PassChain, passSurface, type PassSurface } from './gl-passes.js';
// W8 F17 — 자유 곡선(펜)·여러 장 마스크를 Canvas2D 로 구운 알파 한 장
export {
  MaskRasterizer,
  bakeMaskAlpha,
  canRasterMask,
  maskRasterPlan,
  MASK_TEX_UNIT,
  type MaskRasterPlan,
  type RasterLayerSpec,
  type RasterOp,
} from './mask-raster.js';
export {
  PARITY_MEASURED, PARITY_THRESHOLD, parityFailures, parityKeys, parityNote,
  type ParityDelta,
} from './gl-parity.js';
// F6 스코프 — 실시간(브라우저) 경로의 공개 표면
export {
  FpsMeter, ScopeReader, previewFps, scopeBus, scopeSampleSize,
  SCOPE_PIXEL_BUDGET, SCOPE_SAMPLE_EVERY,
  type ScopeGl, type ScopeSample,
} from './scope-source.js';
export {
  computeScopes, drawHistogramGraticule, drawVectorGraticule, drawWaveformGraticule,
  histogramBins, renderHistogram, renderVectorscope, renderWaveform, scopeStats,
  skinLineEnd, statsDelta, toCb, toCr, toY, vectorPlot, vectorTargets, vectorscopeBins,
  waveformColumns, SCOPE_KINDS, SCOPE_LABEL, SKIN_TONE_ANGLE_DEG,
  type ImageLike, type ScopeKind, type ScopeStats,
} from './scopes.js';
