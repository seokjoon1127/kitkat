// 프리뷰 v2 — **다중 패스** (W8 F15). 오프스크린 프레임버퍼를 번갈아 쓰며 «이웃 픽셀이 필요한»
// 효과(블러·샤픈·글로우·색수차)를 렌더러와 같은 순서로 그린다.
//
// **패스 표면은 프리멀티플라이드다.** SVG 필터 표면이 그렇고(그래서 번짐이 가장자리에서
// 어두워지지 않는다), feColorMatrix·feComponentTransfer 는 «풀어서 계산하고 다시 곱한다».
// 여기서도 똑같이 한다 — 안 맞추면 반투명 가장자리에서 색이 갈린다.
//
// **패스가 필요 없는 클립은 이 파일을 아예 안 건드린다.** PassChain 은 처음 필요할 때
// 만들어지고(프로그램 6개 컴파일), 단일 패스 클립의 그리기 경로는 예전 그대로다.
import type { ColorOp } from './gl-params.js';
// W8 #8 — WebGL 효과 6종. **GLSL 과 유니폼 수식은 렌더러 것을 그대로 쓴다** (Remotion createEffect 와 같은 문자열).
import {
  glStageUniforms,
  linkGlEffect,
  setGlUniforms,
  type GlStageData,
  type GlStageKind,
} from '@kitkat/renderer/composition';

const PASS_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

/** 색 연산 헬퍼 — **메인 셰이더(gl.ts)와 패스 셰이더가 같은 문자열을 쓴다.** */
export const GLSL_COLOR_FNS = `
vec3 satMat(float s, vec3 c) {
  return vec3(
    (0.213 + 0.787 * s) * c.r + (0.715 - 0.715 * s) * c.g + (0.072 - 0.072 * s) * c.b,
    (0.213 - 0.213 * s) * c.r + (0.715 + 0.285 * s) * c.g + (0.072 - 0.072 * s) * c.b,
    (0.213 - 0.213 * s) * c.r + (0.715 - 0.715 * s) * c.g + (0.072 + 0.928 * s) * c.b);
}
vec3 hueMat(float deg, vec3 c) {
  float r = radians(deg);
  float cs = cos(r), sn = sin(r);
  return vec3(
    (0.213 + cs * 0.787 - sn * 0.213) * c.r + (0.715 - cs * 0.715 - sn * 0.715) * c.g + (0.072 - cs * 0.072 + sn * 0.928) * c.b,
    (0.213 - cs * 0.213 + sn * 0.143) * c.r + (0.715 + cs * 0.285 + sn * 0.140) * c.g + (0.072 - cs * 0.072 - sn * 0.283) * c.b,
    (0.213 - cs * 0.213 - sn * 0.787) * c.r + (0.715 - cs * 0.715 + sn * 0.715) * c.g + (0.072 + cs * 0.928 + sn * 0.072) * c.b);
}
vec3 sepiaMix(vec3 c, float a) {
  vec3 s = vec3(
    0.393 * c.r + 0.769 * c.g + 0.189 * c.b,
    0.349 * c.r + 0.686 * c.g + 0.168 * c.b,
    0.272 * c.r + 0.534 * c.g + 0.131 * c.b);
  return mix(c, s, a);
}
float lut(float v, int ch) {
  vec4 t = texture(uTable, vec2((clamp(v, 0.0, 1.0) * 32.0 + 0.5) / 33.0, 0.5));
  return ch == 0 ? t.r : (ch == 1 ? t.g : t.b);
}
// 색조정 커브 — CSS 효과보다 먼저 걸리므로 테이블을 따로 둔다 (렌더러의 url(#curves-…))
float preLut(float v, int ch) {
  vec4 t = texture(uPreTable, vec2((clamp(v, 0.0, 1.0) * 32.0 + 0.5) / 33.0, 0.5));
  return ch == 0 ? t.r : (ch == 1 ? t.g : t.b);
}`;

/** 색 체인 유니폼 선언 — 메인·패스 두 셰이더가 같이 쓴다. */
export const GLSL_COLOR_UNIFORMS = `uniform sampler2D uPreTable;
uniform sampler2D uTable;
uniform int uOpCount;
uniform int uOps[12];
uniform float uArgs[12];
uniform int uUsePreTable;
uniform int uUseTable;
uniform int uUseMat;
uniform mat4 uMat;
uniform vec4 uMatOff;`;

/**
 * 색 체인 **본문**. `c` 라는 vec3 를 제자리에서 고친다.
 * 함수로 빼지 않는 이유: 메인 셰이더에서 「텍셀 → 커브 → ops → 테이블 → 행렬」 순서가
 * 소스 순서 그대로 보여야 테스트(preview-color-order)가 순서를 읽을 수 있다.
 */
export const GLSL_COLOR_CHAIN = `  if (uUsePreTable == 1) c = vec3(preLut(c.r, 0), preLut(c.g, 1), preLut(c.b, 2));

  for (int i = 0; i < 12; i++) {
    if (i >= uOpCount) break;
    int op = uOps[i];
    float a = uArgs[i];
    if (op == 1) c = c * a;
    else if (op == 2) c = (c - 0.5) * a + 0.5;
    else if (op == 3) c = satMat(a, c);
    else if (op == 4) c = hueMat(a, c);
    else if (op == 5) c = satMat(1.0 - a, c);
    else if (op == 6) c = sepiaMix(c, a);
    else if (op == 7) c = mix(c, 1.0 - c, a);
    c = clamp(c, 0.0, 1.0);
  }
  if (uUseTable == 1) c = vec3(lut(c.r, 0), lut(c.g, 1), lut(c.b, 2));
  if (uUseMat == 1) {
    vec4 m = uMat * vec4(c, 1.0) + uMatOff;
    c = clamp(m.rgb, 0.0, 1.0);
  }`;

/**
 * 소스 텍스처(비-프리멀티플라이드) → 패스 표면(프리멀티플라이드). **바깥은 투명 검정.**
 * 표면은 미디어보다 `pad` 만큼 넓다 — 번짐이 잘려서 가장자리가 어두워지는 것을 막는다
 * (렌더러의 필터 영역도 미디어보다 넓다).
 */
const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uSrcScale;
uniform vec2 uSrcOffset;
out vec4 fragColor;
void main() {
  vec2 uv = vUv * uSrcScale + uSrcOffset;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { fragColor = vec4(0.0); return; }
  vec4 s = texture(uSrc, uv);
  float a = clamp(s.a, 0.0, 1.0);
  fragColor = vec4(clamp(s.rgb, 0.0, 1.0) * a, a);
}`;

/**
 * 분리형 상자 블러 한 번. 이웃 두 칸을 **한 번의 이중선형 샘플**로 받아 tap 수를 반으로 줄인다
 * (정확히 두 텍셀의 평균이라 근사가 아니다).
 */
const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform float uBase;
uniform int uSize;
out vec4 fragColor;
vec4 tap(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uSrc, uv);
}
void main() {
  int pairs = uSize / 2;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 128; i++) {
    if (i >= pairs) break;
    acc += 2.0 * tap(vUv + uStep * (uBase + float(i * 2) + 0.5));
  }
  if (uSize - pairs * 2 == 1) acc += tap(vUv + uStep * (uBase + float(pairs * 2)));
  fragColor = acc / float(uSize);
}`;

const COLOR_FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform sampler2D uSrc;
${GLSL_COLOR_UNIFORMS}
out vec4 fragColor;
${GLSL_COLOR_FNS}
void main() {
  vec4 s = texture(uSrc, vUv);
  float a = clamp(s.a, 0.0, 1.0);
  // 0 으로 나누지 않는다 (SHARPEN_FRAG 의 straight 와 같은 이유 — 삼항으로 피하면 NaN 이 샌다)
  vec3 c = clamp(s.rgb / max(a, 1.0 / 255.0), 0.0, 1.0);
${GLSL_COLOR_CHAIN}
  fragColor = vec4(c * a, a);
}`;

/**
 * 3x3 컨볼루션 — `feConvolveMatrix` 사양대로 커널을 180° 돌려 적용하고,
 * `preserveAlpha="true"` 이므로 **알파를 푼 색**에 걸고 알파는 그대로 둔다.
 * `edgeMode="duplicate"` = 가장자리 텍셀을 늘린다(uv 를 0..1 로 조인다).
 */
const SHARPEN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform float uK[9];
uniform float uDiv;
out vec4 fragColor;
vec3 straight(vec2 uv) {
  // 필터 영역이 소스보다 넓으므로 소스 «바깥»은 투명 검정이다 (edgeMode=duplicate 가 늘리는 것은
  // 필터 영역의 가장자리이지 소스의 가장자리가 아니다). 표면 밖도 투명으로 읽는다.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  vec4 s = texture(uSrc, uv);
  // 0 으로 나누지 않는다 — 삼항 연산자로 피하면 SwiftShader 가 «양쪽을 다 계산해 고르는» 코드로
  // 바꾸면서 NaN 이 새어 나온다(실측: 투명한 여백을 읽어야 할 자리가 가운데 값으로 나왔다).
  return s.rgb / max(s.a, 1.0 / 255.0);
}
void main() {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      vec2 off = vec2(float(j - 1), float(i - 1)) * uStep;
      acc += straight(vUv + off) * uK[8 - (j + 3 * i)];
    }
  }
  float a = clamp(texture(uSrc, vUv).a, 0.0, 1.0);
  fragColor = vec4(clamp(acc / uDiv, 0.0, 1.0) * a, a);
}`;

/**
 * 색수차 — R 은 왼쪽, B 는 오른쪽에서 뽑고 screen 으로 다시 합친다.
 * 채널이 겹치지 않아 screen 이 곧 재조합이라 프리멀티플라이드 값을 그대로 골라 담으면 된다.
 */
const SHIFT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform float uOff;
out vec4 fragColor;
vec4 tap(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uSrc, uv);
}
void main() {
  // feOffset dx=-px 는 그림을 **왼쪽으로** 민다 → 그 자리의 값은 소스의 오른쪽(uv + off) 것이다
  vec4 r = tap(vUv + vec2(uOff, 0.0));
  vec4 g = tap(vUv);
  vec4 b = tap(vUv - vec2(uOff, 0.0));
  float a = r.a + g.a - r.a * g.a;
  a = a + b.a - a * b.a;
  fragColor = vec4(r.r, g.g, b.b, a);
}`;

/** feBlend mode="screen" — 프리멀티플라이드에서는 알파까지 같은 식이다. */
const SCREEN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
out vec4 fragColor;
void main() {
  vec4 a = texture(uA, vUv);
  vec4 b = texture(uB, vUv);
  fragColor = a + b - a * b;
}`;

export type ColorPassParams = {
  preTable: WebGLTexture | null;
  table: WebGLTexture | null;
  ops: ColorOp[];
  /** 4x5 색행렬 (feColorMatrix values 순서) */
  matrix: number[] | null;
};

export type GlowPassParams = { slope: number; intercept: number; sigma: number; amount: number };

/**
 * 패스 표면의 크기와 미디어가 놓이는 자리.
 *
 * **가로·세로를 4의 배수로 맞춘다.** SwiftShader 에서 4의 배수가 아닌 표면은 가장자리 한 줄이
 * 어긋난다(실측: 482x272 는 왼쪽 한 줄, 484x274 는 위 한 줄이 최대 84 차이). 여유(pad)를
 * 축마다 따로 두면 480x270 처럼 가로·세로가 4로 나눈 나머지가 다른 경우도 맞출 수 있다.
 */
export type PassSurface = {
  width: number;
  height: number;
  mediaW: number;
  mediaH: number;
  padLeft: number;
  padTop: number;
};

/**
 * 미디어 크기 + 원하는 여유 → 표면.
 *
 * 두 가지를 지킨다 (둘 다 실측으로 잡은 조건이다):
 *  1. **여유는 좌우·상하 대칭.** 한쪽만 넓히면 그 반대쪽 한 줄이 어긋난다.
 *  2. **표면 변은 4의 배수.** 아니면 가장자리 한 줄이 어긋난다(SwiftShader).
 * 축마다 여유를 따로 키워 둘을 같이 만족시킨다 — 480x270 처럼 4로 나눈 나머지가 다르면
 * 가로 여유는 짝수, 세로 여유는 홀수가 된다. 변의 길이가 홀수면 4의 배수를 만들 수 없어
 * 대칭만 지킨다.
 */
export function passSurface(mediaW: number, mediaH: number, pad: number): PassSurface {
  const mw = Math.max(1, Math.round(mediaW));
  const mh = Math.max(1, Math.round(mediaH));
  const p = Math.max(0, Math.round(pad));
  const fit = (m: number): number => {
    if (m % 2 !== 0) return p;
    for (let k = p; k <= p + 2; k++) if ((m + 2 * k) % 4 === 0) return k;
    return p;
  };
  const padLeft = fit(mw);
  const padTop = fit(mh);
  return {
    width: Math.min(4096, mw + 2 * padLeft),
    height: Math.min(4096, mh + 2 * padTop),
    mediaW: mw,
    mediaH: mh,
    padLeft,
    padTop,
  };
}

type Target = { fb: WebGLFramebuffer; tex: WebGLTexture };

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

/** 블러 한 방향이 감당하는 최대 상자 크기 (셰이더 루프 상한 128쌍). */
export const MAX_BOX = 256;

export class PassChain {
  private readonly gl: WebGL2RenderingContext;
  private readonly quad: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly progs: Record<string, Prog>;
  /** WebGL 효과 6종의 프로그램 — **처음 쓸 때** 컴파일한다(안 쓰는 클립은 비용 0). */
  private readonly glProgs: Partial<Record<GlStageKind, Prog>> = {};
  /** 최대 3장 — 글로우가 「원본 · 번짐 · 합성 결과」를 동시에 들고 있어야 한다. */
  private readonly targets: (Target | null)[] = [null, null, null];
  private w = 0;
  private h = 0;
  private surf: PassSurface | null = null;
  private cur = -1;
  private pinned = -1;
  private ok = false;

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.quad = gl.createBuffer() as WebGLBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.progs = {
      copy: link(gl, COPY_FRAG, ['uSrc', 'uSrcScale', 'uSrcOffset']),
      blur: link(gl, BLUR_FRAG, ['uSrc', 'uStep', 'uBase', 'uSize']),
      color: link(gl, COLOR_FRAG, [
        'uSrc', 'uPreTable', 'uTable', 'uOpCount', 'uOps', 'uArgs',
        'uUsePreTable', 'uUseTable', 'uUseMat', 'uMat', 'uMatOff',
      ]),
      sharpen: link(gl, SHARPEN_FRAG, ['uSrc', 'uStep', 'uK', 'uDiv']),
      shift: link(gl, SHIFT_FRAG, ['uSrc', 'uOff']),
      screen: link(gl, SCREEN_FRAG, ['uA', 'uB']),
    };
  }

  /** 프로그램이 안 붙으면 null — 호출자가 단일 패스로 되돌린다. */
  static create(gl: WebGL2RenderingContext): PassChain | null {
    try {
      return new PassChain(gl);
    } catch {
      return null;
    }
  }

  /**
   * 패스 표면 크기를 잡고 소스 텍스처를 첫 표면에 올린다. false = 못 쓴다.
   * `pad` 는 미디어 바깥으로 남길 여유(px) — 번짐이 잘리지 않게 한다.
   */
  begin(src: WebGLTexture, s: PassSurface): boolean {
    const gl = this.gl;
    const mw = s.mediaW;
    const mh = s.mediaH;
    const W = Math.max(1, Math.min(4096, s.width));
    const H = Math.max(1, Math.min(4096, s.height));
    if (W !== this.w || H !== this.h) {
      for (let i = 0; i < this.targets.length; i++) {
        const t = this.targets[i];
        if (!t) continue;
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fb);
        this.targets[i] = null;
      }
      this.w = W;
      this.h = H;
    }
    this.cur = -1;
    this.pinned = -1;
    this.surf = s;
    this.ok = this.ensure(0) !== null && this.ensure(1) !== null;
    if (!this.ok) return false;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, W, H);
    this.pass('copy', [src], (p) => {
      gl.uniform1i(p.u.uSrc as WebGLUniformLocation, 0);
      gl.uniform2f(p.u.uSrcScale as WebGLUniformLocation, W / mw, H / mh);
      gl.uniform2f(p.u.uSrcOffset as WebGLUniformLocation, -s.padLeft / mw, -s.padTop / mh);
    });
    return true;
  }

  /** 색 체인 한 토막 (커브 → ops → 효과 테이블 → 색행렬). */
  color(params: ColorPassParams): void {
    if (!this.ok) return;
    const gl = this.gl;
    const src = this.currentTex();
    if (!src) return;
    const tex: (WebGLTexture | null)[] = [src, params.preTable, params.table];
    this.pass('color', tex, (p) => {
      gl.uniform1i(p.u.uSrc as WebGLUniformLocation, 0);
      gl.uniform1i(p.u.uPreTable as WebGLUniformLocation, 1);
      gl.uniform1i(p.u.uTable as WebGLUniformLocation, 2);
      gl.uniform1i(p.u.uUsePreTable as WebGLUniformLocation, params.preTable ? 1 : 0);
      gl.uniform1i(p.u.uUseTable as WebGLUniformLocation, params.table ? 1 : 0);
      const n = Math.min(12, params.ops.length);
      gl.uniform1i(p.u.uOpCount as WebGLUniformLocation, n);
      if (n > 0) {
        gl.uniform1iv(p.u.uOps as WebGLUniformLocation, params.ops.slice(0, n).map((o) => o.op));
        gl.uniform1fv(p.u.uArgs as WebGLUniformLocation, params.ops.slice(0, n).map((o) => o.arg));
      }
      gl.uniform1i(p.u.uUseMat as WebGLUniformLocation, params.matrix ? 1 : 0);
      if (params.matrix) {
        const m = params.matrix;
        gl.uniformMatrix4fv(p.u.uMat as WebGLUniformLocation, false, [
          m[0]!, m[5]!, m[10]!, m[15]!,
          m[1]!, m[6]!, m[11]!, m[16]!,
          m[2]!, m[7]!, m[12]!, m[17]!,
          0, 0, 0, 0,
        ]);
        gl.uniform4f(p.u.uMatOff as WebGLUniformLocation, m[4]!, m[9]!, m[14]!, 0);
      }
    });
  }

  /** 상자 3연쇄를 가로·세로로 (총 6패스). σ 가 작아 상자가 없으면 아무것도 안 한다. */
  blur(boxes: { size: number; start: number }[]): void {
    if (!this.ok || boxes.length === 0) return;
    const gl = this.gl;
    for (const dir of [0, 1]) {
      for (const b of boxes) {
        const size = Math.min(MAX_BOX, b.size);
        const src = this.currentTex();
        if (!src) return;
        this.pass('blur', [src], (p) => {
          gl.uniform1i(p.u.uSrc as WebGLUniformLocation, 0);
          gl.uniform2f(
            p.u.uStep as WebGLUniformLocation,
            dir === 0 ? 1 / this.w : 0,
            dir === 0 ? 0 : 1 / this.h,
          );
          gl.uniform1f(p.u.uBase as WebGLUniformLocation, b.start);
          gl.uniform1i(p.u.uSize as WebGLUniformLocation, size);
        });
      }
    }
  }

  sharpen(kernel: number[], divisor: number): void {
    if (!this.ok) return;
    const gl = this.gl;
    const src = this.currentTex();
    if (!src) return;
    this.pass('sharpen', [src], (p) => {
      gl.uniform1i(p.u.uSrc as WebGLUniformLocation, 0);
      gl.uniform2f(p.u.uStep as WebGLUniformLocation, 1 / this.w, 1 / this.h);
      gl.uniform1fv(p.u.uK as WebGLUniformLocation, kernel);
      gl.uniform1f(p.u.uDiv as WebGLUniformLocation, divisor || 1);
    });
  }

  /** 색수차 — px 는 필터 표면(=패스 표면) 좌표. */
  shift(px: number): void {
    if (!this.ok) return;
    const gl = this.gl;
    const src = this.currentTex();
    if (!src) return;
    this.pass('shift', [src], (p) => {
      gl.uniform1i(p.u.uSrc as WebGLUniformLocation, 0);
      gl.uniform1f(p.u.uOff as WebGLUniformLocation, px / this.w);
    });
  }

  /**
   * 글로우 — 임계 위만 남겨 흐린 뒤 원본에 screen 으로 되얹는다.
   * 원본을 세 번째 표면에 붙잡아 둬야(pin) 마지막 합성에서 읽을 수 있다.
   */
  glow(g: GlowPassParams, boxes: { size: number; start: number }[]): void {
    if (!this.ok) return;
    if (this.ensure(2) === null) return;
    const gl = this.gl;
    const orig = this.cur;
    this.pinned = orig;
    // 하이라이트만: feFuncR/G/B type="linear" → 대각 색행렬 + 오프셋
    this.color({
      preTable: null,
      table: null,
      ops: [],
      matrix: [
        g.slope, 0, 0, 0, g.intercept,
        0, g.slope, 0, 0, g.intercept,
        0, 0, g.slope, 0, g.intercept,
        0, 0, 0, 1, 0,
      ],
    });
    this.blur(boxes);
    this.color({
      preTable: null,
      table: null,
      ops: [],
      matrix: [g.amount, 0, 0, 0, 0, 0, g.amount, 0, 0, 0, 0, 0, g.amount, 0, 0, 0, 0, 0, 1, 0],
    });
    const glowTex = this.currentTex();
    const origTex = this.targets[orig]?.tex ?? null;
    this.pinned = -1;
    if (!glowTex || !origTex) return;
    const free = [0, 1, 2].find((i) => i !== orig && i !== this.cur);
    if (free === undefined) return;
    this.renderInto(free, 'screen', [origTex, glowTex], (p) => {
      gl.uniform1i(p.u.uA as WebGLUniformLocation, 0);
      gl.uniform1i(p.u.uB as WebGLUniformLocation, 1);
    });
  }

  /**
   * WebGL 효과 한 스테이지 (W8 #8). 렌더러의 `GL_EFFECT_FRAG[kind]` 를 그대로 컴파일하고
   * `glStageUniforms` 가 준 값을 넣는다 — 이 파일에는 효과 수식이 한 줄도 없다.
   * 미디어 자리(uMedia)는 표면 안 여유(pad)를 반영한다. 미디어 밖은 셰이더가 투명으로 쓴다.
   * 프로그램이 안 붙으면 false — 호출자가 배지에 남긴다.
   */
  glStage(stage: GlStageData): boolean {
    if (!this.ok || !this.surf) return false;
    const gl = this.gl;
    const src = this.currentTex();
    if (!src) return false;
    let prog = this.glProgs[stage.kind];
    if (!prog) {
      try {
        const { prog: p, loc } = linkGlEffect(gl, stage.kind);
        prog = { p, u: loc };
      } catch {
        return false;
      }
      this.glProgs[stage.kind] = prog;
    }
    const s = this.surf;
    const media = {
      x: s.padLeft / this.w,
      y: s.padTop / this.h,
      w: s.mediaW / this.w,
      h: s.mediaH / this.h,
      pxW: s.mediaW,
      pxH: s.mediaH,
    };
    const uniforms = glStageUniforms(stage, media);
    this.passWith(prog, [src], (p) => {
      gl.uniform1i(p.u.uSrc as WebGLUniformLocation, 0);
      // 패스 표면은 «v=0 이 위» 규약 — 안 뒤집는다 (Remotion 캔버스만 1)
      gl.uniform1f(p.u.uFlipY as WebGLUniformLocation, 0);
      setGlUniforms(gl, p.u, uniforms);
    });
    return true;
  }

  /** 마지막 패스 결과 (프리멀티플라이드). */
  result(): WebGLTexture | null {
    return this.currentTex();
  }

  /** 캔버스로 돌아간다 — 프레임버퍼 해제 + 뷰포트 복원. */
  finish(canvasW: number, canvasH: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.bindVertexArray(null);
  }

  /** 지금 잡고 있는 GPU 메모리 (바이트). RGBA8 이므로 픽셀당 4. */
  bytes(): number {
    let n = 0;
    for (const t of this.targets) if (t) n += this.w * this.h * 4;
    return n;
  }

  dispose(): void {
    const gl = this.gl;
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (!t) continue;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
      this.targets[i] = null;
    }
    for (const p of Object.values(this.progs)) gl.deleteProgram(p.p);
    for (const p of Object.values(this.glProgs)) if (p) gl.deleteProgram(p.p);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private currentTex(): WebGLTexture | null {
    return this.cur < 0 ? null : this.targets[this.cur]?.tex ?? null;
  }

  private ensure(i: number): Target | null {
    const gl = this.gl;
    const have = this.targets[i];
    if (have) return have;
    const tex = gl.createTexture();
    const fb = gl.createFramebuffer();
    if (!tex || !fb) return null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const done = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!done) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fb);
      return null;
    }
    const t: Target = { fb, tex };
    this.targets[i] = t;
    return t;
  }

  /** 지금 결과가 아닌(그리고 pin 되지 않은) 표면 하나를 골라 그린다. */
  private pass(
    name: string,
    tex: (WebGLTexture | null)[],
    setup: (p: Prog) => void,
  ): void {
    const prog = this.progs[name];
    if (prog) this.passWith(prog, tex, setup);
  }

  private passWith(prog: Prog, tex: (WebGLTexture | null)[], setup: (p: Prog) => void): void {
    const free = [0, 1, 2].find((i) => i !== this.cur && i !== this.pinned && this.targets[i]);
    const idx = free ?? [0, 1, 2].find((i) => i !== this.cur && i !== this.pinned);
    if (idx === undefined) return;
    this.renderInto(idx, prog, tex, setup);
  }

  private renderInto(
    idx: number,
    name: string | Prog,
    tex: (WebGLTexture | null)[],
    setup: (p: Prog) => void,
  ): void {
    const gl = this.gl;
    const target = this.ensure(idx);
    const prog = typeof name === 'string' ? this.progs[name] : name;
    if (!target || !prog) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.vao);
    for (let i = 0; i < tex.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex[i] ?? null);
    }
    setup(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.cur = idx;
  }
}

function link(
  gl: WebGL2RenderingContext,
  frag: string,
  names: string[],
): Prog {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (!sh) throw new Error('셰이더를 만들 수 없습니다');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? '';
      gl.deleteShader(sh);
      throw new Error(`패스 셰이더 컴파일 실패: ${log}`);
    }
    return sh;
  };
  const v = compile(gl.VERTEX_SHADER, PASS_VERT);
  const f = compile(gl.FRAGMENT_SHADER, frag);
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
    throw new Error(`패스 프로그램 링크 실패: ${log}`);
  }
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

/** 패스 셰이더 소스 — 테스트가 브라우저 없이 뜯어본다. */
export const PASS_SHADER_SRC = {
  vert: PASS_VERT,
  copy: COPY_FRAG,
  blur: BLUR_FRAG,
  color: COLOR_FRAG,
  sharpen: SHARPEN_FRAG,
  shift: SHIFT_FRAG,
  screen: SCREEN_FRAG,
};
