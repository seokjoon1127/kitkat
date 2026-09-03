// 프리뷰 v2 — WebGL2 합성기. 레이아웃 수식은 @kitkat/renderer/layout 의 computeVisualLayout 이
// 소유하고, 여기서는 그 결과를 쿼드 하나로 그린다(box/inner·scale·rotation·flip·crop·opacity·
// 블렌드·커브·기본 색효과·비네트·전환).
//
// **정확히 못 그리는 것**은 조용히 넘기지 않고 호출자에게 목록으로 돌려준다(FastPreview 배지).
import type { VisualLayout } from '@kitkat/renderer/layout';
import {
  blendModeCode,
  boxBlurPlan,
  layerColorParams,
  maskShaderParams,
  overlayShaderParams,
  planClipStages,
  stageLabel,
  GRAIN_NOISE_SIGMA,
  MASK_TEX,
  type ChannelTables,
  type ClipStage,
  type ColorOp,
  type GlitchOverlay,
  type MaskParams,
  type OverlayParams,
  type TransitionParams,
} from './gl-params.js';
import {
  canRasterMask,
  maskRasterPlan,
  MaskRasterizer,
  MASK_TEX_UNIT,
  type MaskRasterPlan,
} from './mask-raster.js';
import {
  GLSL_COLOR_CHAIN,
  GLSL_COLOR_FNS,
  GLSL_COLOR_UNIFORMS,
  PassChain,
  passSurface,
  type PassSurface,
} from './gl-passes.js';
import { GL_STAGE_LABEL } from '@kitkat/renderer/composition';

/** 셰이더 소스는 테스트에서 문자열로 뜯어보려고 내보낸다 (브라우저 없이 컴파일할 수 없어서). */
export const PREVIEW_VERT_SRC = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec2 uCanvas;
uniform vec2 uBoxOrigin;
uniform vec2 uBoxSize;
uniform vec2 uScale;
uniform float uRot;
uniform mat3 uWrap;
out vec2 vLocal;
out vec2 vPre;
out vec2 vPost;
void main() {
  vec2 local = aPos * uBoxSize;
  vLocal = local;
  vec2 c = uBoxSize * 0.5;
  vec2 q = local - c;
  float s = sin(uRot), co = cos(uRot);
  q = vec2(q.x * co - q.y * s, q.x * s + q.y * co);
  q *= uScale;
  vec2 world = uBoxOrigin + c + q;
  vPre = world;
  vec3 w = uWrap * vec3(world, 1.0);
  vPost = w.xy;
  gl_Position = vec4(w.x / uCanvas.x * 2.0 - 1.0, 1.0 - w.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

export const PREVIEW_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
in vec2 vLocal;
in vec2 vPre;
in vec2 vPost;
uniform sampler2D uTex;
uniform sampler2D uBackdrop;
${GLSL_COLOR_UNIFORMS}
uniform vec2 uCanvas;
uniform vec2 uBoxSize;
uniform vec2 uInnerOrigin;
uniform vec2 uInnerSize;
uniform float uOpacity;
uniform float uLod;
uniform float uVignette;
uniform int uClipCount;
uniform int uClipKind[2];
uniform vec4 uClipP[2];
uniform int uBlend;
// uTex 가 다중 패스 결과인가 — 그렇다면 프리멀티플라이드라 알파로 나눠 읽는다
uniform int uPremul;
// 크로마키 (렌더러 svg-filters.tsx 의 chromaKeyStage 와 **같은 수식**)
uniform int uChromaOn;
uniform vec3 uChromaC;   // m = dot(uChromaC, rgb) — 휘도를 뺀 색차를 키 색 방향에 투영
uniform float uChromaT;  // 임계
uniform float uChromaW;  // 램프 폭
uniform vec3 uChromaV;   // 디스필 벡터 (-spill·ĉ_key)
// 마스크 (렌더러 maskLayerCss 의 CSS 그라디언트를 4점 알파 램프로 옮긴 것)
uniform int uMaskKind;   // 0 없음 · 1 rect · 2 circle · 3 linear · 4 알파 텍스처
uniform vec4 uMaskEll;   // circle: (cx, cy, rx, ry) — 상자 대비
uniform vec4 uMaskHP;
uniform vec4 uMaskHA;
uniform vec4 uMaskVP;
uniform vec4 uMaskVA;
// 자유 곡선·여러 장 겹침 — Canvas2D(Path2D)로 구운 알파 한 장 (mask-raster.ts)
uniform sampler2D uMaskTex;
uniform vec4 uMaskUV;    // (pad/texW, pad/texH, boxW/texW, boxH/texH)
// 오버레이 3종 (grain · scanlines · lightLeak) — 상자 안, 비네트 뒤
uniform int uOvCount;
uniform int uOvKind[3];
uniform vec3 uGrain;     // (알파, 진폭, 프레임 seed)
uniform vec3 uScan;      // (알파, 어두운 띠 끝 px, 주기 px)
uniform vec2 uLeakDir;
uniform float uLeakLen;
uniform vec4 uLeakC[5];  // 프리멀티플라이드
uniform float uLeakP[5];
out vec4 fragColor;
${GLSL_COLOR_FNS}
float blendCh(int m, float b, float s) {
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return b <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (m == 4) return min(b, s);
  if (m == 5) return max(b, s);
  if (m == 6) return s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));
  if (m == 7) return s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s);
  if (m == 8) return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (m == 9) {
    float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
  }
  if (m == 10) return abs(b - s);
  return s;
}
/** 4점 알파 램프 — CSS 그라디언트의 정지 위치·알파를 그대로 옮긴 것. */
float ramp4(vec4 p, vec4 a, float t) {
  if (t <= p.x) return a.x;
  if (t < p.y) return mix(a.x, a.y, (t - p.x) / max(1e-6, p.y - p.x));
  if (t < p.z) return mix(a.y, a.z, (t - p.y) / max(1e-6, p.z - p.y));
  if (t < p.w) return mix(a.z, a.w, (t - p.z) / max(1e-6, p.w - p.z));
  return a.w;
}
/** 마스크 알파. m = 클립 상자 안 0..1 (회전·확대 **전** 좌표 — CSS mask 와 같은 자리). */
float maskAlpha(vec2 m) {
  if (uMaskKind == 1) return ramp4(uMaskHP, uMaskHA, m.x) * ramp4(uMaskVP, uMaskVA, m.y);
  if (uMaskKind == 2) {
    vec2 d = (m - uMaskEll.xy) / max(vec2(1e-6), uMaskEll.zw);
    return ramp4(uMaskVP, uMaskVA, length(d));
  }
  if (uMaskKind == 3) return ramp4(uMaskVP, uMaskVA, m.y);
  // 4 = 구운 알파 한 장. 캔버스는 상자보다 pad 만큼 넓다(번진 가장자리) — uv 를 그만큼 밀어 읽는다.
  if (uMaskKind == 4) return texture(uMaskTex, uMaskUV.xy + m * uMaskUV.zw).a;
  return 1.0;
}
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, vec3(q.y, q.z, q.x) + 33.33);
  return fract((q.x + q.y) * q.z);
}
/** 라이트리크 그라디언트 — 프리멀티플라이드 5정지 선형 보간 (CSS 와 같은 공간). */
vec4 leakAt(float t) {
  if (t <= uLeakP[0]) return uLeakC[0];
  for (int i = 1; i < 5; i++) {
    if (t <= uLeakP[i]) {
      return mix(uLeakC[i - 1], uLeakC[i], (t - uLeakP[i - 1]) / max(1e-6, uLeakP[i] - uLeakP[i - 1]));
    }
  }
  return uLeakC[4];
}

void main() {
  for (int i = 0; i < 2; i++) {
    if (i >= uClipCount) break;
    int k = uClipKind[i];
    vec4 p = uClipP[i];
    if (k == 1) {
      if (vPre.x < p.w * uCanvas.x || vPre.x > (1.0 - p.y) * uCanvas.x ||
          vPre.y < p.x * uCanvas.y || vPre.y > (1.0 - p.z) * uCanvas.y) discard;
    } else if (k == 2) {
      if (distance(vPre, vec2(p.y, p.z)) > p.x) discard;
    } else if (k == 3) {
      if (distance(vPre, vec2(p.y, p.z)) < p.x) discard;
    }
  }
  vec2 uv = (vLocal - uInnerOrigin) / uInnerSize;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  vec4 texel = uLod > 0.0 ? textureLod(uTex, uv, uLod) : texture(uTex, uv);
  // 다중 패스 결과는 프리멀티플라이드다 — 색 연산은 «푼» 값에 걸어야 렌더러와 같다
  // 0 으로 나누지 않는다 — 삼항은 SwiftShader 에서 «양쪽 다 계산»으로 접혀 NaN 이 샌다
  if (uPremul == 1) texel.rgb = texel.rgb / max(texel.a, 1.0 / 255.0);
  vec3 c = clamp(texel.rgb, 0.0, 1.0);

  // 순서: 커브 테이블 → CSS/전환 ops → 효과 테이블 → 효과 행렬 (렌더러와 같다)
${GLSL_COLOR_CHAIN}
  // 크로마키 — 색 연산 맨 뒤(렌더러도 SVG 체인 끝). 알파를 깎고 남은 키 색을 뺀다.
  float chromaA = 1.0;
  if (uChromaOn == 1) {
    float mk = dot(uChromaC, c);
    chromaA = clamp((uChromaT + uChromaW * 0.5 - mk) / uChromaW, 0.0, 1.0);
    c = clamp(c + max(0.0, mk - uChromaT) * uChromaV, 0.0, 1.0);
  }
  if (uVignette > 0.0) {
    vec2 hb = uBoxSize * 0.5;
    vec2 d = (vLocal - hb) / (hb * 1.41421356);
    c = mix(c, vec3(0.0), uVignette * clamp((length(d) - 0.55) / 0.45, 0.0, 1.0));
  }
  // 오버레이 — 렌더러 clips.tsx 의 순서대로 «비네트 다음, 상자 안»에 얹는다
  for (int i = 0; i < 3; i++) {
    if (i >= uOvCount) break;
    int k = uOvKind[i];
    if (k == 1) {
      float n = clamp(0.5 + (hash21(floor(vLocal) + uGrain.z) +
                             hash21(floor(vLocal) * 1.7 + uGrain.z * 3.1) - 1.0) * uGrain.y, 0.0, 1.0);
      vec3 ov = vec3(blendCh(3, c.r, n), blendCh(3, c.g, n), blendCh(3, c.b, n));
      c = mix(c, ov, uGrain.x);
    } else if (k == 2) {
      c *= 1.0 - (mod(vLocal.y, uScan.z) < uScan.y ? uScan.x : 0.0);
    } else if (k == 3) {
      vec4 g = leakAt(dot(vLocal - uBoxSize * 0.5, uLeakDir) / uLeakLen + 0.5);
      c = clamp(c + g.rgb * (1.0 - c), 0.0, 1.0);
    }
  }
  float a = clamp(texel.a, 0.0, 1.0) * uOpacity * chromaA;
  if (uMaskKind > 0) a *= clamp(maskAlpha(vLocal / uBoxSize), 0.0, 1.0);
  if (uBlend == 0) {
    fragColor = vec4(c, a);
  } else {
    vec3 bd = texture(uBackdrop, vec2(vPost.x / uCanvas.x, 1.0 - vPost.y / uCanvas.y)).rgb;
    vec3 bl = vec3(blendCh(uBlend, bd.r, c.r), blendCh(uBlend, bd.g, c.g), blendCh(uBlend, bd.b, c.b));
    fragColor = vec4(mix(bd, bl, a), 1.0);
  }
}`;

const SOLID_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`;

const SOLID_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }`;

/** 캔버스 전체를 덮는 쿼드 — vUv 는 **왼쪽 위가 (0,0)** (CSS 의 top/left 와 같은 방향). */
const OVERLAY_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x, 1.0 - aPos.y);
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * 글리치 전환 덮개 (렌더러 `transitionOverlays('glitch')`).
 * 두 번 그린다 — 스캔라인(multiply)과 찢김 띠 2장(screen). 두 합성 모두 **GL 블렌드 식**으로
 * 정확히 표현되므로 backdrop 을 복사하지 않는다:
 *   multiply(검정, α) → dst·(1−α)          = blendFunc(ZERO, ONE_MINUS_SRC_ALPHA)
 *   screen(프리멀티 C) → dst + C·(1−dst)   = blendFunc(ONE, ONE_MINUS_SRC_COLOR)
 */
export const GLITCH_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform int uMode;         // 0 = 스캔라인 · 1 = 찢김 띠
uniform vec2 uCanvas;
uniform vec3 uScan;        // (알파, 어두운 띠 끝 px, 주기 px)
uniform int uBandCount;
uniform vec4 uBandRect[2]; // (top, bottom, dx, 안 씀) — 캔버스 대비 0..1
uniform vec4 uBandC[8];    // 띠마다 프리멀티플라이드 정지 4개
uniform float uBandP[8];
out vec4 fragColor;
void main() {
  if (uMode == 0) {
    float y = vUv.y * uCanvas.y;
    fragColor = vec4(0.0, 0.0, 0.0, mod(y, uScan.z) < uScan.y ? uScan.x : 0.0);
    return;
  }
  vec4 acc = vec4(0.0);
  for (int b = 0; b < 2; b++) {
    if (b >= uBandCount) break;
    vec4 r = uBandRect[b];
    if (vUv.y < r.x || vUv.y > r.y) continue;
    float u = vUv.x - r.z;
    if (u < 0.0 || u > 1.0) continue;
    int o = b * 4;
    vec4 col = uBandC[o];
    for (int i = 1; i < 4; i++) {
      if (u <= uBandP[o + i]) {
        col = mix(uBandC[o + i - 1], uBandC[o + i],
                  (u - uBandP[o + i - 1]) / max(1e-6, uBandP[o + i] - uBandP[o + i - 1]));
        break;
      }
      col = uBandC[o + i];
    }
    if (u <= uBandP[o]) col = uBandC[o];
    // 띠 두 장이 겹치면 screen 을 두 번 — 한 번의 그리기로 합치려면 여기서 미리 겹친다
    acc = acc + col - acc * col;
  }
  fragColor = acc;
}`;

/**
 * WebCodecs 의 VideoFrame 을 TS lib 버전에 안 기대고 쓰기 위한 최소 구조.
 * WebGL2 의 texImage2D 는 VideoFrame 을 TexImageSource 로 그대로 받는다(복사 없음).
 */
export type GlVideoFrame = {
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
};

export type GlImage = HTMLVideoElement | HTMLImageElement | ImageBitmap | GlVideoFrame;

export type GlLayer = {
  /** 텍스처 캐시 키 (클립 id) */
  id: string;
  image: GlImage;
  /** 같은 값이면 텍스처를 다시 올리지 않는다. -1 = 항상 올림 */
  seq: number;
  layout: VisualLayout;
  transition: TransitionParams;
  /** 그레인 노이즈 seed (렌더러 `grainSeed(frame)` 과 같은 값). 없으면 0 */
  grainSeed?: number;
};

export type GlCoverLayer = {
  id: string;
  image: GlImage;
  seq: number;
  /** 소스 픽셀 크기 (cover 계산용) */
  srcW: number;
  srcH: number;
  blurPx: number;
  /** 배경 blur 는 1.15배 확대해서 여백을 채운다 (렌더러 background.tsx 와 같음) */
  zoom: number;
};

type TexEntry = { tex: WebGLTexture; seq: number; w: number; h: number; mip: boolean };

function imageSize(img: GlImage): { w: number; h: number } {
  if (typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement) {
    return { w: img.videoWidth, h: img.videoHeight };
  }
  const any = img as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
  };
  // VideoFrame 은 displayWidth/Height 가 회전·픽셀비를 반영한 «보이는» 크기다.
  if (typeof any.displayWidth === 'number' && typeof any.displayHeight === 'number') {
    return { w: any.displayWidth, h: any.displayHeight };
  }
  return { w: any.naturalWidth ?? any.width ?? 0, h: any.naturalHeight ?? any.height ?? 0 };
}

/**
 * 그레인 해시 노이즈의 진폭. 셰이더는 균등난수 두 개의 합(−1..1, 표준편차 0.4082)을 쓰므로
 * 이 값을 곱하면 표준편차가 `GRAIN_NOISE_SIGMA`(feTurbulence 실측)와 같아진다.
 */
export const GRAIN_AMPLITUDE = GRAIN_NOISE_SIGMA / 0.40825;

/** 패스로만 그릴 수 있는 스테이지 이름 (패스를 못 만들었을 때 배지에 쓴다). */
const PASS_STAGE_LABEL: Record<string, string> = {
  blur: '블러', sharpen: '샤픈', glow: '글로우', shift: '색수차',
};

function passStageLabel(st: ClipStage): string | null {
  if (st.kind === 'gl') return GL_STAGE_LABEL[st.stage.kind];
  return PASS_STAGE_LABEL[st.kind] ?? null;
}

/** 패스 표면에 남기는 최대 여유 px. 1080x1920 기준 표면 3장이 32MiB 를 넘지 않게 잡았다. */
export const PASS_PAD_MAX = 96;

/**
 * 패스 표면을 미디어보다 얼마나 넓게 잡을지. **안 넓히면 가장자리가 어두워진다** —
 * 상자 블러 3연쇄의 두 번째·세 번째 패스가 표면 밖을 «투명»으로 읽어 값을 깎아먹는다.
 * 렌더러의 필터 영역도 같은 이유로 미디어보다 넓다(-10%~120%, glow 는 -25%~150%).
 */
export function passPadding(stages: ClipStage[], transitionSigma = 0): number {
  let pad = 0;
  for (const s of stages) {
    if (s.kind === 'blur' || s.kind === 'glow') pad += Math.ceil(3 * s.sigma);
    else if (s.kind === 'shift') pad += Math.ceil(Math.abs(s.px));
    else if (s.kind === 'sharpen') pad += 1;
  }
  if (transitionSigma > 0) pad += Math.ceil(3 * transitionSigma);
  return Math.min(PASS_PAD_MAX, pad);
}

/**
 * 블러 px → 밉맵 LOD **근사**. CSS blur 는 가우시안인데 밉맵은 상자 필터를 연쇄한 것이라
 * 모양이 다르다. texelsPerPx = 텍스처 픽셀 / 캔버스 픽셀 (프록시가 작으면 1보다 작다).
 *
 * **W8 F15 부터 클립 블러는 이 근사를 안 쓴다** — 공간 패스가 상자 3연쇄로 정확히 그린다.
 * 여기 남은 쓰임은 배경 블러(drawCover)와 패스를 못 만들었을 때의 되돌림뿐이다.
 */
export function blurToLod(px: number, texelsPerPx = 1): number {
  if (!(px > 0)) return 0;
  const sigmaTexels = px * (texelsPerPx > 0 ? texelsPerPx : 1);
  return Math.max(0, Math.min(8, Math.log2(Math.max(1, sigmaTexels * 2))));
}

export class GlCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly prog: WebGLProgram;
  private readonly solidProg: WebGLProgram;
  private readonly glitchProg: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly solidVao: WebGLVertexArrayObject;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly ug: Record<string, WebGLUniformLocation | null> = {};
  private readonly uSolidColor: WebGLUniformLocation | null;
  private readonly textures = new Map<string, TexEntry>();
  private readonly tableTex: WebGLTexture;
  private readonly preTableTex: WebGLTexture;
  /** 마스크 텍스처가 없을 때 샘플러에 물리는 1x1 흰색 (불완전한 텍스처 방지) */
  private readonly whiteTex: WebGLTexture;
  /** 자유 곡선·여러 장 마스크의 알파 캔버스 캐시 — **처음 필요할 때** 만든다 */
  private maskRaster: MaskRasterizer | null = null;
  private backdropTex: WebGLTexture;
  private backdropSize = { w: 0, h: 0 };
  private disposed = false;
  /** 다중 패스 엔진 — **처음 필요할 때** 만든다(단일 패스 클립은 프로그램조차 안 만든다). */
  private passes: PassChain | null = null;
  private passesFailed = false;

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.prog = linkProgram(gl, PREVIEW_VERT_SRC, PREVIEW_FRAG_SRC);
    this.solidProg = linkProgram(gl, SOLID_VERT, SOLID_FRAG);
    this.glitchProg = linkProgram(gl, OVERLAY_VERT, GLITCH_FRAG_SRC);
    this.quad = gl.createBuffer() as WebGLBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.solidVao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(this.solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const names = [
      'uCanvas', 'uBoxOrigin', 'uBoxSize', 'uScale', 'uRot', 'uWrap',
      'uTex', 'uPreTable', 'uTable', 'uBackdrop', 'uInnerOrigin', 'uInnerSize', 'uOpacity', 'uLod',
      'uVignette', 'uOpCount', 'uOps', 'uArgs', 'uUsePreTable', 'uUseTable', 'uUseMat', 'uMat',
      'uMatOff', 'uClipCount', 'uClipKind', 'uClipP', 'uBlend', 'uPremul',
      'uChromaOn', 'uChromaC', 'uChromaT', 'uChromaW', 'uChromaV',
      'uMaskKind', 'uMaskEll', 'uMaskHP', 'uMaskHA', 'uMaskVP', 'uMaskVA', 'uMaskTex', 'uMaskUV',
      'uOvCount', 'uOvKind', 'uGrain', 'uScan', 'uLeakDir', 'uLeakLen', 'uLeakC', 'uLeakP',
    ];
    for (const n of names) this.u[n] = gl.getUniformLocation(this.prog, n);
    this.uSolidColor = gl.getUniformLocation(this.solidProg, 'uColor');
    for (const n of ['uMode', 'uCanvas', 'uScan', 'uBandCount', 'uBandRect', 'uBandC', 'uBandP']) {
      this.ug[n] = gl.getUniformLocation(this.glitchProg, n);
    }

    // 33x1 룩업 텍스처 2장 — 커브(ops 앞)와 효과 테이블(ops 뒤)
    this.tableTex = makeTableTexture(gl);
    this.preTableTex = makeTableTexture(gl);

    this.whiteTex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    );

    this.backdropTex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, this.backdropTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 아직 한 번도 안 뜬 backdrop 이 "불완전한 텍스처"로 샘플러에 물리지 않게 1x1 로 채워 둔다
    // (RGBA 4바이트 — RGB 3바이트는 기본 UNPACK_ALIGNMENT 4 와 어긋난다)
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );

    // **뒤집지 않는다.** 셰이더의 uv.y=0 은 미디어의 «위» 이고 WebGL 기본 업로드도 그림의
    // 첫 줄을 v=0 에 놓는다. FLIP_Y 를 켜면 그림이 위아래로 뒤집힌다 —
    // W8 F15 픽셀 대조에서 실제로 뒤집혀 있는 것이 잡혔다(평균 차이 50.5).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.disable(gl.DEPTH_TEST);

    // 0 으로 나누는 유니폼(주기·그라디언트 길이)에 안전한 기본값을 한 번 넣어 둔다
    gl.useProgram(this.prog);
    gl.uniform3f(this.u.uScan as WebGLUniformLocation, 0, 0, 1);
    gl.uniform1f(this.u.uLeakLen as WebGLUniformLocation, 1);
    gl.uniform3f(this.u.uGrain as WebGLUniformLocation, 0, 0, 0);
    gl.uniform1i(this.u.uOvCount as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uMaskKind as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uPremul as WebGLUniformLocation, 0);
    gl.useProgram(null);
  }

  /** WebGL2 를 못 얻거나 셰이더가 안 붙으면 null — 상위가 Remotion 으로 되돌린다. */
  static create(canvas: HTMLCanvasElement): GlCompositor | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        // alpha:false → 캔버스가 불투명. 블렌드 모드용 backdrop 복사도 RGB 로 뜬다.
        alpha: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      }) as WebGL2RenderingContext | null;
    } catch {
      return null;
    }
    if (!gl) return null;
    try {
      return new GlCompositor(canvas, gl);
    } catch {
      return null;
    }
  }

  resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  beginFrame(clear: [number, number, number]): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** 배경 blur/image — cover 로 맞춘 한 장. */
  drawCover(layer: GlCoverLayer): void {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const size = imageSize(layer.image);
    const sw = layer.srcW > 0 ? layer.srcW : size.w;
    const sh = layer.srcH > 0 ? layer.srcH : size.h;
    if (sw <= 0 || sh <= 0) return;
    const s = Math.max(W / sw, H / sh) * layer.zoom;
    const iw = sw * s;
    const ih = sh * s;
    const lod = blurToLod(layer.blurPx, iw > 0 ? size.w / iw : 1);
    const tex = this.uploadTexture(layer.id, layer.image, layer.seq, lod > 0);
    if (!tex) return;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    this.bindTex(0, tex, 'uTex');
    this.bindTex(1, this.tableTex, 'uTable');
    this.bindTex(2, this.backdropTex, 'uBackdrop');
    this.bindTex(3, this.preTableTex, 'uPreTable');
    this.bindTex(MASK_TEX_UNIT, this.whiteTex, 'uMaskTex');
    gl.uniform2f(this.u.uCanvas as WebGLUniformLocation, W, H);
    gl.uniform2f(this.u.uBoxOrigin as WebGLUniformLocation, 0, 0);
    gl.uniform2f(this.u.uBoxSize as WebGLUniformLocation, W, H);
    gl.uniform2f(this.u.uScale as WebGLUniformLocation, 1, 1);
    gl.uniform1f(this.u.uRot as WebGLUniformLocation, 0);
    gl.uniformMatrix3fv(this.u.uWrap as WebGLUniformLocation, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    gl.uniform2f(this.u.uInnerOrigin as WebGLUniformLocation, (W - iw) / 2, (H - ih) / 2);
    gl.uniform2f(this.u.uInnerSize as WebGLUniformLocation, iw, ih);
    gl.uniform1f(this.u.uOpacity as WebGLUniformLocation, 1);
    gl.uniform1f(this.u.uLod as WebGLUniformLocation, lod);
    gl.uniform1f(this.u.uVignette as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uOpCount as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uUsePreTable as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uUseTable as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uUseMat as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uClipCount as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uBlend as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uChromaOn as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uPremul as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uMaskKind as WebGLUniformLocation, 0);
    gl.uniform1i(this.u.uOvCount as WebGLUniformLocation, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /**
   * 시각 클립 한 장. 반환값은 **v2 가 이 클립에서 정확히 못 그린 것들**이다(빈 배열 = 정확).
   */
  drawLayer(layer: GlLayer): string[] {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const L = layer.layout;
    const approx: string[] = [...layer.transition.approx];

    // ── 마스크 (W8 F15 #1 · F17 자유 곡선/여러 장) ──
    const masks = L.maskLayers ?? (L.mask ? [L.mask] : []);
    const mask = maskShaderParams(masks, L.box.width, L.box.height);
    // 램프로 못 그리는 마스크는 Canvas2D 로 알파 한 장을 굽는다 (같은 Chromium 래스터라이저)
    let maskPlan: MaskRasterPlan | null = null;
    if (mask.needsRaster) {
      maskPlan = canRasterMask() ? maskRasterPlan(masks, L.box.width, L.box.height) : null;
      if (!maskPlan) approx.push('마스크(미지원)');
    }

    // ── 오버레이 3종 (W8 F15 #5·6·7) ──
    const overlays: OverlayParams[] = [];
    for (const o of L.overlays) {
      const p = overlayShaderParams(o, L.box.width, L.box.height);
      if (p && overlays.length < 3) overlays.push(p);
      else approx.push(`${overlayLabel(o.kind)}(미지원)`);
    }

    // ── 스테이지 계획 — 공간 효과(블러·샤픈·글로우·색수차)가 있으면 다중 패스 ──
    const plan = planClipStages(L);
    approx.push(...plan.approx);
    const srcSize = imageSize(layer.image);
    // 패스가 돌면 색 체인은 이미 텍스처에 구워져 있다 — 메인 패스에는 «전환 ops» 만 남는다
    const passed = plan.needsPasses ? this.runPasses(layer, plan.stages) : null;
    const passTex = passed ? passed.tex : null;
    const surf = passed ? passed.surf : null;
    const premul = passTex ? 1 : 0;
    const color = passTex ? null : layerColorParams(L);
    if (color) approx.push(...color.approx);
    // 패스가 필요한데 못 만들었다(FBO 실패) — **조용히 넘기지 않는다.** 접어서 그린 결과에는
    // 공간 효과가 통째로 빠져 있으므로 무엇이 빠졌는지 배지에 남긴다.
    if (plan.needsPasses && !passTex) {
      for (const st of plan.stages) {
        const label = passStageLabel(st);
        if (label) {
          const why = `${label}(미지원 — 패스 실패)`;
          if (!approx.includes(why)) approx.push(why);
        }
      }
    }
    // WebGL 효과 프로그램이 안 붙은 것 — 패스는 돌았지만 그 스테이지만 빠졌다
    if (passed) for (const why of passed.missing) if (!approx.includes(why)) approx.push(why);
    const ops: ColorOp[] = color
      ? [...color.ops, ...layer.transition.ops]
      : [...layer.transition.ops];
    const lod = color
      ? blurToLod(
          color.blurPx + layer.transition.blurPx,
          L.inner.width > 0 ? srcSize.w / L.inner.width : 1,
        )
      : 0;
    const tex = passTex ?? this.uploadTexture(layer.id, layer.image, layer.seq, lod > 0);
    if (!tex) return approx;

    const blend = blendModeCode(L.blendMode);
    if (blend !== 0) this.captureBackdrop();

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    if (blend === 0) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    this.bindTex(0, tex, 'uTex');
    this.bindTex(1, this.tableTex, 'uTable');
    this.bindTex(2, this.backdropTex, 'uBackdrop');
    this.bindTex(3, this.preTableTex, 'uPreTable');

    if (color?.preTable) this.uploadTable(this.preTableTex, 3, color.preTable);
    gl.uniform1i(this.u.uUsePreTable as WebGLUniformLocation, color?.preTable ? 1 : 0);
    if (color?.tables) this.uploadTable(this.tableTex, 1, color.tables);
    gl.uniform1i(this.u.uUseTable as WebGLUniformLocation, color?.tables ? 1 : 0);
    if (color?.matrix) {
      const m = color.matrix;
      // GLSL mat4 는 열 우선 — vec4(c,1) 에 곱해 RGB 만 쓴다
      gl.uniformMatrix4fv(this.u.uMat as WebGLUniformLocation, false, [
        m[0]!, m[5]!, m[10]!, m[15]!,
        m[1]!, m[6]!, m[11]!, m[16]!,
        m[2]!, m[7]!, m[12]!, m[17]!,
        0, 0, 0, 0,
      ]);
      gl.uniform4f(this.u.uMatOff as WebGLUniformLocation, m[4]!, m[9]!, m[14]!, 0);
    }
    gl.uniform1i(this.u.uUseMat as WebGLUniformLocation, color?.matrix ? 1 : 0);
    gl.uniform1i(this.u.uPremul as WebGLUniformLocation, premul);
    const maskWhy = this.setMaskUniforms(mask.params, maskPlan);
    if (maskWhy && !approx.includes(maskWhy)) approx.push(maskWhy);
    this.setOverlayUniforms(overlays, layer.grainSeed ?? 0);

    // 크로마키는 체인 맨 끝이라 패스를 쓰든 안 쓰든 여기서 건다
    const ck = color ? color.chroma : plan.chroma;
    gl.uniform1i(this.u.uChromaOn as WebGLUniformLocation, ck && !ck.disabled ? 1 : 0);
    if (ck && !ck.disabled) {
      gl.uniform3f(this.u.uChromaC as WebGLUniformLocation, ck.c[0], ck.c[1], ck.c[2]);
      gl.uniform1f(this.u.uChromaT as WebGLUniformLocation, ck.t);
      gl.uniform1f(this.u.uChromaW as WebGLUniformLocation, ck.w);
      const v = ck.despill ? ck.v : ([0, 0, 0] as const);
      gl.uniform3f(this.u.uChromaV as WebGLUniformLocation, v[0], v[1], v[2]);
    }

    const a = layer.transition.affine;
    gl.uniform2f(this.u.uCanvas as WebGLUniformLocation, W, H);
    gl.uniform2f(this.u.uBoxOrigin as WebGLUniformLocation, L.box.left, L.box.top);
    gl.uniform2f(this.u.uBoxSize as WebGLUniformLocation, L.box.width, L.box.height);
    gl.uniform2f(this.u.uScale as WebGLUniformLocation, L.scaleX, L.scaleY);
    gl.uniform1f(this.u.uRot as WebGLUniformLocation, (L.rotationDeg * Math.PI) / 180);
    gl.uniformMatrix3fv(this.u.uWrap as WebGLUniformLocation, false, [
      a[0], a[1], 0, a[2], a[3], 0, a[4], a[5], 1,
    ]);
    // 패스 표면은 미디어보다 넓다(여유 + 4의 배수 맞춤) — uv 매핑을 표면 크기로 늘려 잡는다
    gl.uniform2f(
      this.u.uInnerOrigin as WebGLUniformLocation,
      surf ? L.inner.left - surf.padLeft : L.inner.left,
      surf ? L.inner.top - surf.padTop : L.inner.top,
    );
    gl.uniform2f(
      this.u.uInnerSize as WebGLUniformLocation,
      surf ? surf.width : L.inner.width,
      surf ? surf.height : L.inner.height,
    );
    gl.uniform1f(this.u.uOpacity as WebGLUniformLocation, L.opacity * layer.transition.opacity);
    gl.uniform1f(this.u.uLod as WebGLUniformLocation, lod);
    gl.uniform1f(this.u.uVignette as WebGLUniformLocation, L.vignette);
    const n = Math.min(12, ops.length);
    gl.uniform1i(this.u.uOpCount as WebGLUniformLocation, n);
    if (n > 0) {
      gl.uniform1iv(this.u.uOps as WebGLUniformLocation, ops.slice(0, n).map((o) => o.op));
      gl.uniform1fv(this.u.uArgs as WebGLUniformLocation, ops.slice(0, n).map((o) => o.arg));
    }
    const clips = layer.transition.clips;
    gl.uniform1i(this.u.uClipCount as WebGLUniformLocation, Math.min(2, clips.length));
    if (clips.length > 0) {
      const kinds: number[] = [];
      const ps: number[] = [];
      for (let i = 0; i < Math.min(2, clips.length); i++) {
        kinds.push(clips[i]!.kind);
        ps.push(...clips[i]!.p);
      }
      gl.uniform1iv(this.u.uClipKind as WebGLUniformLocation, kinds);
      gl.uniform4fv(this.u.uClipP as WebGLUniformLocation, ps);
    }
    gl.uniform1i(this.u.uBlend as WebGLUniformLocation, blend);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    return approx;
  }

  /**
   * 글리치 전환 덮개 (W8 F15 #8) — 스캔라인 한 장 + 찢김 띠 두 장.
   * 두 합성이 GL 블렌드 식으로 정확히 되므로 backdrop 복사가 필요 없다.
   */
  drawGlitch(g: GlitchOverlay): void {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.useProgram(this.glitchProg);
    gl.bindVertexArray(this.solidVao);
    gl.uniform2f(this.ug.uCanvas as WebGLUniformLocation, W, H);
    if (g.scan && g.scan.alpha > 0 && g.scan.period > 0) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(this.ug.uMode as WebGLUniformLocation, 0);
      gl.uniform3f(this.ug.uScan as WebGLUniformLocation, g.scan.alpha, g.scan.edge, g.scan.period);
      gl.uniform1i(this.ug.uBandCount as WebGLUniformLocation, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    const bands = g.bands.slice(0, 2);
    if (bands.length > 0) {
      const rect: number[] = [];
      const cols: number[] = [];
      const pos: number[] = [];
      for (let i = 0; i < 2; i++) {
        const b = bands[i];
        rect.push(b ? b.top : 0, b ? b.bottom : 0, b ? b.dx : 0, 0);
        for (let k = 0; k < 4; k++) {
          const c = b?.colors[k] ?? [0, 0, 0, 0];
          cols.push(c[0], c[1], c[2], c[3]);
          pos.push(b?.pos[k] ?? 0);
        }
      }
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(this.ug.uMode as WebGLUniformLocation, 1);
      gl.uniform1i(this.ug.uBandCount as WebGLUniformLocation, bands.length);
      gl.uniform4fv(this.ug.uBandRect as WebGLUniformLocation, rect);
      gl.uniform4fv(this.ug.uBandC as WebGLUniformLocation, cols);
      gl.uniform1fv(this.ug.uBandP as WebGLUniformLocation, pos);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
  }

  /** 다중 패스가 잡고 있는 GPU 메모리 (바이트). 안 쓰면 0. */
  passBytes(): number {
    return this.passes ? this.passes.bytes() : 0;
  }

  /**
   * 구운 마스크 알파를 **다시 안 굽고 재사용한 비율**. `d` 가 매 프레임 바뀌는
   * `dKeys` 애니메이션이 아니면 1 에 가까워야 한다 (0 에 가까우면 fps 가 죽는다).
   */
  maskRasterStats(): { hits: number; misses: number; entries: number } {
    return this.maskRaster ? this.maskRaster.stats() : { hits: 0, misses: 0, entries: 0 };
  }

  /** 전체 화면 단색 덮개 (whiteFlash/blackFlash). */
  drawFlash(color: [number, number, number], opacity: number): void {
    const gl = this.gl;
    if (!(opacity > 0)) return;
    gl.useProgram(this.solidProg);
    gl.bindVertexArray(this.solidVao);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(this.uSolidColor as WebGLUniformLocation, color[0], color[1], color[2], Math.min(1, opacity));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /**
   * 쌓인 WebGL 오류를 하나 꺼낸다 (0 = 정상).
   * 첫 프레임 뒤에 확인해서 0 이 아니면 상위가 Remotion 으로 되돌린다 —
   * WebGL 은 예외를 던지지 않아서 이걸 안 보면 **까만 화면으로 조용히 실패한다**.
   */
  consumeError(): number {
    return this.gl.getError();
  }

  /**
   * 스코프(F6) 전용 **읽기 훅** — 합성 결과를 축소해 내려받으려면 컨텍스트가 필요하다.
   * 여기서 색·셰이더는 건드리지 않는다. `scope-source.ts` 의 ScopeReader 만 이걸 쓴다.
   */
  get context(): WebGL2RenderingContext {
    return this.gl;
  }

  /** 텍스처 캐시에서 이번 프레임에 안 쓴 것들을 버린다. */
  retain(ids: Set<string>): void {
    for (const [id, entry] of this.textures) {
      if (ids.has(id)) continue;
      this.gl.deleteTexture(entry.tex);
      this.textures.delete(id);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const e of this.textures.values()) gl.deleteTexture(e.tex);
    this.textures.clear();
    gl.deleteTexture(this.tableTex);
    gl.deleteTexture(this.preTableTex);
    gl.deleteTexture(this.whiteTex);
    gl.deleteTexture(this.backdropTex);
    this.maskRaster?.dispose();
    this.maskRaster = null;
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.solidVao);
    gl.deleteProgram(this.prog);
    gl.deleteProgram(this.solidProg);
    gl.deleteProgram(this.glitchProg);
    this.passes?.dispose();
    this.passes = null;
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  /**
   * 공간 효과가 있는 클립을 **오프스크린에서** 렌더러 순서 그대로 그린다.
   * 패스 표면은 `inner` 크기 — 렌더러의 SVG 필터 표면이 미디어 엘리먼트 크기라 1:1 로 맞는다.
   * 실패하면 null (호출자가 단일 패스로 되돌린다).
   */
  private runPasses(
    layer: GlLayer,
    stages: ClipStage[],
  ): { tex: WebGLTexture; surf: PassSurface; missing: string[] } | null {
    const missing: string[] = [];
    if (this.passesFailed) return null;
    if (!this.passes) {
      this.passes = PassChain.create(this.gl);
      if (!this.passes) {
        this.passesFailed = true;
        return null;
      }
    }
    const L = layer.layout;
    const src = this.uploadTexture(layer.id, layer.image, layer.seq, false);
    if (!src) return null;
    const chain = this.passes;
    const mw = Math.max(1, Math.round(L.inner.width));
    const mh = Math.max(1, Math.round(L.inner.height));
    const want = Math.min(
      PASS_PAD_MAX,
      Math.max(0, Math.floor((4096 - Math.max(mw, mh)) / 2)),
      passPadding(stages, layer.transition.blurPx / (Math.abs(L.scaleX) || 1)),
    );
    const surf = passSurface(mw, mh, want);
    if (!chain.begin(src, surf)) {
      this.passesFailed = true;
      return null;
    }
    for (const s of stages) {
      if (s.kind === 'gl') {
        // W8 #8 — 렌더러 GLSL 그대로. 안 붙으면 그 스테이지만 건너뛰고 배지에 남긴다.
        if (!chain.glStage(s.stage)) missing.push(`${GL_STAGE_LABEL[s.stage.kind]}(미지원 — 셰이더 실패)`);
      } else if (s.kind === 'table') {
        this.uploadTable(this.preTableTex, 3, s.t);
        chain.color({ preTable: this.preTableTex, table: null, ops: [], matrix: null });
      } else if (s.kind === 'ops') {
        chain.color({ preTable: null, table: null, ops: s.ops, matrix: null });
      } else if (s.kind === 'matrix') {
        chain.color({ preTable: null, table: null, ops: [], matrix: s.m });
      } else if (s.kind === 'blur') {
        chain.blur(boxBlurPlan(s.sigma));
      } else if (s.kind === 'sharpen') {
        chain.sharpen(s.kernel, s.divisor);
      } else if (s.kind === 'shift') {
        chain.shift(s.px);
      } else {
        chain.glow(s, boxBlurPlan(s.sigma));
      }
    }
    // 전환 블러는 캔버스 px 다 — 상자 배율로 나눠 미디어 공간으로 옮긴다.
    // 등방 확대·회전에서는 정확하고, 가로세로 배율이 다르면 근사다(배지가 남는다).
    if (layer.transition.blurPx > 0) {
      chain.blur(boxBlurPlan(layer.transition.blurPx / (Math.abs(L.scaleX) || 1)));
    }
    chain.finish(this.canvas.width, this.canvas.height);
    const tex = chain.result();
    return tex ? { tex, surf, missing } : null;
  }

  /**
   * 마스크 유니폼. 램프(1·2·3)와 구운 알파 텍스처(4) 중 하나다.
   * 텍스처를 못 만들면 마스크 없이 그리고 **그 사유를 돌려준다**(조용히 넘기지 않는다).
   */
  private setMaskUniforms(m: MaskParams | null, plan: MaskRasterPlan | null): string | null {
    const gl = this.gl;
    if (plan) {
      if (!this.maskRaster) this.maskRaster = new MaskRasterizer(gl);
      const tex = this.maskRaster.texture(plan);
      if (!tex) {
        gl.uniform1i(this.u.uMaskKind as WebGLUniformLocation, 0);
        this.bindTex(MASK_TEX_UNIT, this.whiteTex, 'uMaskTex');
        return '마스크(미지원 — 알파를 못 구웠다)';
      }
      this.bindTex(MASK_TEX_UNIT, tex, 'uMaskTex');
      gl.uniform1i(this.u.uMaskKind as WebGLUniformLocation, MASK_TEX);
      gl.uniform4f(
        this.u.uMaskUV as WebGLUniformLocation,
        plan.pad / plan.texW,
        plan.pad / plan.texH,
        plan.boxW / plan.texW,
        plan.boxH / plan.texH,
      );
      return null;
    }
    this.bindTex(MASK_TEX_UNIT, this.whiteTex, 'uMaskTex');
    gl.uniform1i(this.u.uMaskKind as WebGLUniformLocation, m ? m.kind : 0);
    if (!m) return null;
    gl.uniform4f(this.u.uMaskEll as WebGLUniformLocation, m.ell[0], m.ell[1], m.ell[2], m.ell[3]);
    gl.uniform4fv(this.u.uMaskHP as WebGLUniformLocation, m.h.pos);
    gl.uniform4fv(this.u.uMaskHA as WebGLUniformLocation, m.h.alpha);
    gl.uniform4fv(this.u.uMaskVP as WebGLUniformLocation, m.v.pos);
    gl.uniform4fv(this.u.uMaskVA as WebGLUniformLocation, m.v.alpha);
    return null;
  }

  private setOverlayUniforms(ovs: OverlayParams[], seed: number): void {
    const gl = this.gl;
    gl.uniform1i(this.u.uOvCount as WebGLUniformLocation, ovs.length);
    if (ovs.length === 0) return;
    const kinds = [0, 0, 0];
    for (let i = 0; i < ovs.length; i++) kinds[i] = (ovs[i] as OverlayParams).kind;
    gl.uniform1iv(this.u.uOvKind as WebGLUniformLocation, kinds);
    for (const o of ovs) {
      if (o.kind === 1) {
        gl.uniform3f(this.u.uGrain as WebGLUniformLocation, o.amount, GRAIN_AMPLITUDE, seed);
      } else if (o.kind === 2) {
        gl.uniform3f(
          this.u.uScan as WebGLUniformLocation,
          o.alpha, o.edge, Math.max(1e-3, o.period),
        );
      } else {
        const cols: number[] = [];
        for (let i = 0; i < 5; i++) {
          const c = o.colors[i] ?? [0, 0, 0, 0];
          cols.push(c[0], c[1], c[2], c[3]);
        }
        gl.uniform2f(this.u.uLeakDir as WebGLUniformLocation, o.dir[0], o.dir[1]);
        gl.uniform1f(this.u.uLeakLen as WebGLUniformLocation, Math.max(1e-3, o.len));
        gl.uniform4fv(this.u.uLeakC as WebGLUniformLocation, cols);
        gl.uniform1fv(this.u.uLeakP as WebGLUniformLocation, o.pos.slice(0, 5));
      }
    }
  }

  private bindTex(unit: number, tex: WebGLTexture, name: string): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u[name] as WebGLUniformLocation, unit);
  }

  private captureBackdrop(): void {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.backdropTex);
    if (this.backdropSize.w !== W || this.backdropSize.h !== H) {
      // 기본 프레임버퍼에 알파가 없으므로(alpha:false) RGB 로 뜬다 — RGBA 로 뜨면 INVALID_OPERATION
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB, 0, 0, W, H, 0);
      this.backdropSize = { w: W, h: H };
    } else {
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, W, H);
    }
  }

  private uploadTable(tex: WebGLTexture, unit: number, t: ChannelTables): void {
    const gl = this.gl;
    const px = new Uint8Array(33 * 4);
    for (let i = 0; i < 33; i++) {
      px[i * 4] = Math.round(Math.min(1, Math.max(0, t.r[i] ?? 0)) * 255);
      px[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, t.g[i] ?? 0)) * 255);
      px[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, t.b[i] ?? 0)) * 255);
      px[i * 4 + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // FLIP_Y 는 컨텍스트 전체에서 꺼져 있다 (생성자 참고) — 여기서 다시 끌 필요가 없다
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 33, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  private uploadTexture(
    id: string,
    image: GlImage,
    seq: number,
    wantMip: boolean,
  ): WebGLTexture | null {
    const gl = this.gl;
    const { w, h } = imageSize(image);
    if (w <= 0 || h <= 0) return null;
    let entry = this.textures.get(id);
    if (!entry) {
      const tex = gl.createTexture();
      if (!tex) return null;
      entry = { tex, seq: Number.NaN, w: 0, h: 0, mip: false };
      this.textures.set(id, entry);
    }
    const fresh = seq < 0 || entry.seq !== seq || entry.w !== w || entry.h !== h || entry.mip !== wantMip;
    if (!fresh) return entry.tex;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      wantMip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image as TexImageSource);
    } catch {
      return null;
    }
    if (wantMip) gl.generateMipmap(gl.TEXTURE_2D);
    entry.seq = seq;
    entry.w = w;
    entry.h = h;
    entry.mip = wantMip;
    return entry.tex;
  }
}

/** 33x1 룩업 텍스처 한 장 (LINEAR·CLAMP). 내용은 uploadTable 이 채운다. */
function makeTableTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 33, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return tex;
}

/** 오버레이 이름 — 카탈로그(효과 50종)에서 끌어온다. 손으로 적으면 영문 id 가 배지에 샌다. */
function overlayLabel(kind: string): string {
  if (kind === 'grain') return '그레인';
  if (kind === 'scanlines') return '스캔라인';
  if (kind === 'lightLeak') return '라이트리크';
  return stageLabel(kind);
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (!sh) throw new Error('셰이더를 만들 수 없습니다');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? '';
      gl.deleteShader(sh);
      throw new Error(`셰이더 컴파일 실패: ${log}`);
    }
    return sh;
  };
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram();
  if (!p) throw new Error('프로그램을 만들 수 없습니다');
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) ?? '';
    gl.deleteProgram(p);
    throw new Error(`프로그램 링크 실패: ${log}`);
  }
  return p;
}
