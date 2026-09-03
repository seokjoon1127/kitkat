// W8 #8 — 「대기」였던 WebGL 효과 6종 (vibrance · bokeh · radialBlur · mirror · kaleidoscope · halftone).
//
// **순수 모듈이다** — react·remotion·DOM 무의존. 여기 있는 것은 셋뿐이다:
//   1. 효과 배열 → 스테이지 데이터 (`effectGlStages`) — 파라미터를 **한 번만** 정규화한다.
//   2. GLSL 문자열 — 렌더(Remotion `createEffect`)와 미리보기(`gl-passes`)가 **같은 문자열**을 쓴다.
//   3. 스테이지 데이터 → 유니폼 값 (`glStageUniforms`) — 수식이 두 군데서 갈리지 않게 한 곳에 둔다.
//
// **좌표 규약** — 셰이더의 `m` 은 «미디어 안 0..1, y 는 아래로» 다(CSS 와 같다). 표면(텍스처)이
// 미디어보다 넓을 수 있으므로(미리보기 패스 표면은 여유가 있다) `uMedia` 가 미디어의 자리를 준다.
// 미디어 **밖은 투명 검정**으로 읽고 쓴다 — SVG 필터 표면과 같은 규약이라 뒤따르는 패스가 두 경로에서
// 같은 입력을 받는다. 위아래 방향은 정점 셰이더의 `uFlipY` 로만 맞춘다(프래그먼트는 모른다).
//
// **적용 순서** — 이 6종은 소스 픽셀에 **가장 먼저** 걸린다(커브 → CSS → SVG 보다 앞). 렌더에서
// 미디어를 캔버스로 바꿔 그린 뒤 그 캔버스에 CSS filter 를 거는 구조라 그렇게밖에 안 된다. CSS 와
// SVG 효과도 배열 순서가 아니라 구현 갈래 순서로 걸리므로(effects.ts) 새 규칙은 아니다.
import type { Effect } from '@kitkat/schema';

export type GlStageData =
  | { kind: 'vibrance'; data: { amount: number } }
  /** 원반 커널 흐림. `step` = 표본 간격(px) — 반경이 크면 표본을 성기게 찍는다(아래 BOKEH_MAX_K). */
  | { kind: 'bokeh'; data: { radius: number; amount: number; step: number } }
  /** 중심(cx,cy 미디어 0..1)에서 바깥으로 늘어나는 줌 블러. `samples` = 선분 위 표본 수. */
  | { kind: 'radialBlur'; data: { px: number; cx: number; cy: number; samples: number } }
  /** axis 0 좌우 · 1 상하 · 2 사분면. side 0 = 앞(왼쪽/위)을 남긴다. pos = 경계(0..1). */
  | { kind: 'mirror'; data: { axis: 0 | 1 | 2; side: 0 | 1; pos: number } }
  | { kind: 'kaleidoscope'; data: { segments: number; angleDeg: number } }
  | { kind: 'halftone'; data: { size: number; angleDeg: number } };

export type GlStageKind = GlStageData['kind'];

export const GL_STAGE_KINDS: readonly GlStageKind[] = [
  'vibrance', 'bokeh', 'radialBlur', 'mirror', 'kaleidoscope', 'halftone',
];

/** 보케 격자 반칸 수 상한 — 표본 (2K+1)² 칸 중 원 안쪽만 읽는다(K=12 → 최대 약 450 표본). */
export const BOKEH_MAX_K = 12;
/** 방사형 블러 선분 표본 수 상한 (셰이더 루프 상한과 같다). */
export const RADIAL_MAX_SAMPLES = 32;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 보케 표본 간격(px) — 반경이 K 를 넘으면 그만큼 성기게. */
export function bokehStep(radius: number): number {
  return Math.max(1, Math.ceil(radius / BOKEH_MAX_K));
}

/** 방사형 블러 표본 수 — 번짐 1px 당 하나, 8..32. */
export function radialSamples(px: number): number {
  return clamp(Math.ceil(px), 8, RADIAL_MAX_SAMPLES);
}

/**
 * 효과 배열 → WebGL 스테이지 목록 (배열 순서 유지). 카탈로그 `impl:'webgl'` 6종만 본다.
 * 항등인 값(vibrance 0 · bokeh 반경 0/강도 0 · radialBlur 0px)은 스테이지를 안 만든다 —
 * 항등 패스도 텍스처 한 장을 더 그리는 비용이다.
 */
export function effectGlStages(effects?: Effect[]): GlStageData[] {
  if (!effects || effects.length === 0) return [];
  const out: GlStageData[] = [];
  for (const e of effects) {
    const p = e.params ?? {};
    switch (e.type) {
      case 'vibrance': {
        const amount = clamp(num(p.amount, 0.3), -1, 1);
        if (amount !== 0) out.push({ kind: 'vibrance', data: { amount } });
        break;
      }
      case 'bokeh': {
        const radius = clamp(Math.round(num(p.radius, 24)), 0, 60);
        const amount = clamp(num(p.amount, 0.6), 0, 1);
        if (radius > 0 && amount > 0) {
          out.push({ kind: 'bokeh', data: { radius, amount, step: bokehStep(radius) } });
        }
        break;
      }
      case 'radialBlur': {
        const px = clamp(num(p.px, 20), 0, 60);
        if (px > 0) {
          out.push({
            kind: 'radialBlur',
            data: {
              px,
              cx: clamp(num(p.cx, 0.5), 0, 1),
              cy: clamp(num(p.cy, 0.5), 0, 1),
              samples: radialSamples(px),
            },
          });
        }
        break;
      }
      case 'mirror': {
        const axis = clamp(Math.round(num(p.axis, 0)), 0, 2) as 0 | 1 | 2;
        const side = clamp(Math.round(num(p.side, 0)), 0, 1) as 0 | 1;
        // 경계가 0 이나 1 에 붙으면 남길 쪽이 없다 — 최소 1% 는 남긴다
        const pos = clamp(num(p.pos, 0.5), 0.01, 0.99);
        out.push({ kind: 'mirror', data: { axis, side, pos } });
        break;
      }
      case 'kaleidoscope': {
        const segments = clamp(Math.round(num(p.segments, 6)), 3, 16);
        const angleDeg = ((num(p.angle, 0) % 360) + 360) % 360;
        out.push({ kind: 'kaleidoscope', data: { segments, angleDeg } });
        break;
      }
      case 'halftone': {
        const size = clamp(num(p.size, 8), 2, 40);
        const angleDeg = clamp(num(p.angle, 45), 0, 90);
        out.push({ kind: 'halftone', data: { size, angleDeg } });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ── GLSL ──────────────────────────────────────────────────────────────────

/**
 * 정점 셰이더. `uFlipY` = 1 이면 위아래를 뒤집어 그린다 — Remotion 이펙트 캔버스는 화면 방향(위가 위)
 * 으로 그려야 하고, 미리보기 패스 표면은 «v=0 이 위» 규약이라 안 뒤집는다. 프래그먼트는 둘 다 같다.
 */
export const GL_EFFECT_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
uniform float uFlipY;
out vec2 vUv;
void main() {
  vUv = aPos;
  float y = aPos.y * 2.0 - 1.0;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, mix(y, -y, uFlipY), 0.0, 1.0);
}`;

/** 여섯 셰이더가 같이 쓰는 머리 — 미디어 좌표 변환·경계 처리·프리멀티플라이드 풀기. */
const GL_HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec4 uMedia;    // 표면 uv 안에서 미디어가 놓인 자리 (x, y, w, h)
uniform vec2 uMediaPx;  // 미디어 크기 (px)
out vec4 fragColor;
// 미디어 좌표(0..1, y 아래) → 표면 uv
vec2 surf(vec2 m) { return uMedia.xy + m * uMedia.zw; }
// 이 프래그먼트의 미디어 좌표 — **픽셀 중심에 스냅**한다. 표면 크기가 경로마다 다르면(미리보기
// 패스 표면은 4의 배수로 여유를 둔다) 같은 픽셀의 m 이 1e-7 만큼 어긋나고, 만화경·거울처럼
// «접는 자리»가 있는 효과는 그 오차로 이음매 한 줄이 반대쪽으로 뒤집힌다(실측 최대 112).
// 스냅하면 두 경로가 비트까지 같은 좌표를 계산한다.
vec2 mediaCoord() {
  vec2 m = (vUv - uMedia.xy) / uMedia.zw;
  return (floor(m * uMediaPx) + 0.5) / uMediaPx;
}
bool outsideM(vec2 m) { return m.x < 0.0 || m.x > 1.0 || m.y < 0.0 || m.y > 1.0; }
// 미디어 «안»에서 읽을 때는 텍셀 중심 범위로 조인다 — 경계(m=1.0)에서 이중선형 보간이 표면 여유
// (미리보기: 투명 검정)와 섞이면 렌더 캔버스(clamp-to-edge)와 갈린다(실측: 만화경 최대 112).
vec2 edgeM(vec2 m) { vec2 h = 0.5 / uMediaPx; return clamp(m, h, 1.0 - h); }
// 미디어 밖은 투명 검정 (SVG 필터 표면과 같은 규약)
vec4 tapM(vec2 m) { return outsideM(m) ? vec4(0.0) : texture(uSrc, surf(edgeM(m))); }
// 가장자리를 늘려 읽는다 (밝기 표본용 — 셀 중심이 밖으로 나가도 검게 안 읽힌다)
vec4 tapC(vec2 m) { return texture(uSrc, surf(edgeM(m))); }
// 거울 반복 — 0..1 밖으로 나간 좌표를 접어 넣는다 (구멍이 안 생긴다)
vec2 mirrorRepeat(vec2 m) { return 1.0 - abs(1.0 - mod(m, 2.0)); }
// 프리멀티플라이드 → 풀린 색. 0 으로 나누지 않는다 (삼항으로 피하면 SwiftShader 가 NaN 을 흘린다)
vec3 straight(vec4 s) { return clamp(s.rgb / max(s.a, 1.0 / 255.0), 0.0, 1.0); }
const vec3 LUMA = vec3(0.213, 0.715, 0.072);
`;

/**
 * 생동감 — 채도(s = max−min)가 «낮은» 색만 올린다: gain = amount·(1−s).
 * 채도 행렬은 CSS saturate 와 같은 휘도 가중치(0.213/0.715/0.072)로 푼다.
 */
const VIBRANCE_FRAG = `${GL_HEAD}
uniform float uAmount;
void main() {
  vec2 m = mediaCoord();
  if (outsideM(m)) { fragColor = vec4(0.0); return; }
  vec4 s = texture(uSrc, vUv);
  float a = clamp(s.a, 0.0, 1.0);
  vec3 c = straight(s);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float gain = uAmount * (1.0 - sat);
  float l = dot(c, LUMA);
  c = clamp(mix(vec3(l), c, 1.0 + gain), 0.0, 1.0);
  fragColor = vec4(c * a, a);
}`;

/**
 * 보케 — 반지름 uRadius 의 **원반** 안 표본을 균등 평균한다(가우시안이 아니다 — 밝은 점이 «원»으로 번진다).
 * 분리가 안 되는 2D 커널이라 표본 수 상한을 둔다: 격자 간격 uStep 으로 (2K+1)² 칸, K ≤ BOKEH_MAX_K.
 */
const BOKEH_FRAG = `${GL_HEAD}
const int MAXK = ${BOKEH_MAX_K};
uniform float uRadius;
uniform float uStep;
uniform float uAmount;
void main() {
  vec2 m = mediaCoord();
  if (outsideM(m)) { fragColor = vec4(0.0); return; }
  vec4 s = texture(uSrc, vUv);
  if (uRadius <= 0.0 || uAmount <= 0.0) { fragColor = s; return; }
  int k = int(ceil(uRadius / uStep));
  float rr = uRadius / uStep;
  rr *= rr;
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int j = -MAXK; j <= MAXK; j++) {
    if (j < -k || j > k) continue;
    for (int i = -MAXK; i <= MAXK; i++) {
      if (i < -k || i > k) continue;
      if (float(i * i + j * j) > rr) continue;
      acc += tapM(m + vec2(float(i), float(j)) * uStep / uMediaPx);
      n += 1.0;
    }
  }
  fragColor = mix(s, acc / max(n, 1.0), uAmount);
}`;

/**
 * 방사형(줌) 블러 — 픽셀에서 중심으로 향하는 선분 위를 표본한다. 선분 길이는
 * uPx · (중심 거리 / 반대각선) 이라 **중심에서는 0** 이고 모서리에서 uPx 다.
 */
const RADIAL_FRAG = `${GL_HEAD}
const int MAXN = ${RADIAL_MAX_SAMPLES};
uniform float uPx;
uniform vec2 uCenter;
uniform int uSamples;
void main() {
  vec2 m = mediaCoord();
  if (outsideM(m)) { fragColor = vec4(0.0); return; }
  vec2 d = (m - uCenter) * uMediaPx;
  float dist = length(d);
  float len = uPx * dist / (length(uMediaPx) * 0.5);
  if (len < 0.5) { fragColor = texture(uSrc, vUv); return; }
  vec2 dir = d / dist;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < MAXN; i++) {
    if (i >= uSamples) break;
    float t = (float(i) + 0.5) / float(uSamples) - 0.5;
    acc += tapM(m + dir * (len * t) / uMediaPx);
  }
  fragColor = acc / float(uSamples);
}`;

/** 거울 — 경계 uPos 에서 접는다. 접힌 좌표가 0..1 을 벗어나면 거울 반복으로 채운다. */
const MIRROR_FRAG = `${GL_HEAD}
uniform int uAxis;
uniform int uSide;
uniform float uPos;
float fold(float x) {
  if (uSide == 0) return x > uPos ? 2.0 * uPos - x : x;
  return x < uPos ? 2.0 * uPos - x : x;
}
void main() {
  vec2 m = mediaCoord();
  if (outsideM(m)) { fragColor = vec4(0.0); return; }
  vec2 q = m;
  if (uAxis == 0 || uAxis == 2) q.x = fold(m.x);
  if (uAxis == 1 || uAxis == 2) q.y = fold(m.y);
  fragColor = tapM(mirrorRepeat(q));
}`;

/**
 * 만화경 — 중심 기준 극좌표에서 각도를 2π/n 부채꼴 안으로 접고(반사), 같은 반지름으로 원본을 읽는다.
 * 씨앗 부채꼴은 [uAngle, uAngle + π/n] 이다.
 */
const KALEIDO_FRAG = `${GL_HEAD}
uniform float uSegments;
uniform float uAngle;
void main() {
  vec2 m = mediaCoord();
  if (outsideM(m)) { fragColor = vec4(0.0); return; }
  vec2 d = (m - 0.5) * uMediaPx;
  float r = length(d);
  float seg = 6.28318530718 / uSegments;
  float th = mod(atan(d.y, d.x) - uAngle, seg);
  th = abs(th - seg * 0.5) + uAngle;
  vec2 q = 0.5 + r * vec2(cos(th), sin(th)) / uMediaPx;
  fragColor = tapM(mirrorRepeat(q));
}`;

/**
 * 망점 — 각도 uAngle 로 돌린 격자의 셀마다 «어두울수록 큰» 검은 점을 찍는다.
 * 점 면적이 어둡기에 비례하도록 r = size/2 · √(1−밝기) · 1.08 (1.08 = 순검정이 셀을 꽉 채우게).
 * 셀 밝기는 중심 + 십자 4점 평균, 경계는 smoothstep 1.5px 로 안티에일리어싱.
 */
const HALFTONE_FRAG = `${GL_HEAD}
uniform float uSize;
uniform float uAngle;
void main() {
  vec2 m = mediaCoord();
  if (outsideM(m)) { fragColor = vec4(0.0); return; }
  float a = clamp(texture(uSrc, vUv).a, 0.0, 1.0);
  vec2 p = m * uMediaPx;
  float cs = cos(uAngle), sn = sin(uAngle);
  mat2 R = mat2(cs, sn, -sn, cs);
  mat2 Ri = mat2(cs, -sn, sn, cs);
  vec2 pr = R * p;
  vec2 cell = floor(pr / uSize) + 0.5;
  vec2 cm = (Ri * (cell * uSize)) / uMediaPx;
  vec2 e = vec2(uSize * 0.25) / uMediaPx;
  vec4 t = tapC(cm) + tapC(cm + vec2(e.x, 0.0)) + tapC(cm - vec2(e.x, 0.0))
         + tapC(cm + vec2(0.0, e.y)) + tapC(cm - vec2(0.0, e.y));
  float l = dot(straight(t / 5.0), LUMA);
  float rd = uSize * 0.5 * sqrt(clamp(1.0 - l, 0.0, 1.0)) * 1.08;
  float dd = length(pr - cell * uSize);
  float cov = 1.0 - smoothstep(rd - 0.75, rd + 0.75, dd);
  fragColor = vec4(vec3(1.0 - cov) * a, a);
}`;

/** 효과별 프래그먼트 셰이더 — **렌더와 미리보기가 이 문자열을 그대로 컴파일한다.** */
export const GL_EFFECT_FRAG: Record<GlStageKind, string> = {
  vibrance: VIBRANCE_FRAG,
  bokeh: BOKEH_FRAG,
  radialBlur: RADIAL_FRAG,
  mirror: MIRROR_FRAG,
  kaleidoscope: KALEIDO_FRAG,
  halftone: HALFTONE_FRAG,
};

/** 공통 유니폼 (정점 uFlipY 포함). */
export const GL_COMMON_UNIFORMS = ['uSrc', 'uMedia', 'uMediaPx', 'uFlipY'] as const;

/** 효과별 유니폼 이름 — 프로그램을 링크할 때 위치를 찾는 목록. */
export const GL_EFFECT_UNIFORM_NAMES: Record<GlStageKind, readonly string[]> = {
  vibrance: [...GL_COMMON_UNIFORMS, 'uAmount'],
  bokeh: [...GL_COMMON_UNIFORMS, 'uRadius', 'uStep', 'uAmount'],
  radialBlur: [...GL_COMMON_UNIFORMS, 'uPx', 'uCenter', 'uSamples'],
  mirror: [...GL_COMMON_UNIFORMS, 'uAxis', 'uSide', 'uPos'],
  kaleidoscope: [...GL_COMMON_UNIFORMS, 'uSegments', 'uAngle'],
  halftone: [...GL_COMMON_UNIFORMS, 'uSize', 'uAngle'],
};

// ── 유니폼 값 ─────────────────────────────────────────────────────────────

/** 텍스처(표면) 안에서 미디어가 놓인 자리 — uv 단위 + px 크기. Remotion 캔버스는 (0,0,1,1). */
export type GlMediaRect = { x: number; y: number; w: number; h: number; pxW: number; pxH: number };

export const GL_FULL_MEDIA = (pxW: number, pxH: number): GlMediaRect => ({
  x: 0, y: 0, w: 1, h: 1, pxW, pxH,
});

export type GlUniform = { name: string; type: '1f' | '1i' | '2f' | '4f'; value: number[] };

const DEG = Math.PI / 180;

/**
 * 스테이지 데이터 → 유니폼 값. **여기가 수식의 유일한 자리다** — 셰이더는 받기만 한다.
 * `uSrc`(텍스처 유닛)·`uFlipY` 는 실행기가 정한다(경로마다 다르다).
 */
export function glStageUniforms(stage: GlStageData, media: GlMediaRect): GlUniform[] {
  const common: GlUniform[] = [
    { name: 'uMedia', type: '4f', value: [media.x, media.y, media.w, media.h] },
    { name: 'uMediaPx', type: '2f', value: [Math.max(1, media.pxW), Math.max(1, media.pxH)] },
  ];
  switch (stage.kind) {
    case 'vibrance':
      return [...common, { name: 'uAmount', type: '1f', value: [stage.data.amount] }];
    case 'bokeh':
      return [
        ...common,
        { name: 'uRadius', type: '1f', value: [stage.data.radius] },
        { name: 'uStep', type: '1f', value: [stage.data.step] },
        { name: 'uAmount', type: '1f', value: [stage.data.amount] },
      ];
    case 'radialBlur':
      return [
        ...common,
        { name: 'uPx', type: '1f', value: [stage.data.px] },
        { name: 'uCenter', type: '2f', value: [stage.data.cx, stage.data.cy] },
        { name: 'uSamples', type: '1i', value: [Math.min(RADIAL_MAX_SAMPLES, stage.data.samples)] },
      ];
    case 'mirror':
      return [
        ...common,
        { name: 'uAxis', type: '1i', value: [stage.data.axis] },
        { name: 'uSide', type: '1i', value: [stage.data.side] },
        { name: 'uPos', type: '1f', value: [stage.data.pos] },
      ];
    case 'kaleidoscope':
      return [
        ...common,
        { name: 'uSegments', type: '1f', value: [stage.data.segments] },
        { name: 'uAngle', type: '1f', value: [stage.data.angleDeg * DEG] },
      ];
    case 'halftone':
      return [
        ...common,
        { name: 'uSize', type: '1f', value: [stage.data.size] },
        { name: 'uAngle', type: '1f', value: [stage.data.angleDeg * DEG] },
      ];
  }
}

/** 유니폼 값을 실제로 넣는다 — 두 실행기가 같은 함수를 쓴다. */
export function setGlUniforms(
  gl: WebGL2RenderingContext,
  loc: Record<string, WebGLUniformLocation | null>,
  uniforms: GlUniform[],
): void {
  for (const u of uniforms) {
    const l = loc[u.name];
    if (!l) continue;
    const v = u.value;
    if (u.type === '1f') gl.uniform1f(l, v[0] ?? 0);
    else if (u.type === '1i') gl.uniform1i(l, v[0] ?? 0);
    else if (u.type === '2f') gl.uniform2f(l, v[0] ?? 0, v[1] ?? 0);
    else gl.uniform4f(l, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
  }
}

/** 셰이더 컴파일·링크 — 두 실행기 공용. 실패하면 던진다(조용히 검은 화면이 되지 않게). */
export function linkGlEffect(
  gl: WebGL2RenderingContext,
  kind: GlStageKind,
): { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> } {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (!sh) throw new Error('셰이더를 만들 수 없습니다');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? '';
      gl.deleteShader(sh);
      throw new Error(`WebGL 효과(${kind}) 셰이더 컴파일 실패: ${log}`);
    }
    return sh;
  };
  const v = compile(gl.VERTEX_SHADER, GL_EFFECT_VERT);
  const f = compile(gl.FRAGMENT_SHADER, GL_EFFECT_FRAG[kind]);
  const prog = gl.createProgram();
  if (!prog) throw new Error('프로그램을 만들 수 없습니다');
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '';
    gl.deleteProgram(prog);
    throw new Error(`WebGL 효과(${kind}) 프로그램 링크 실패: ${log}`);
  }
  const loc: Record<string, WebGLUniformLocation | null> = {};
  for (const n of GL_EFFECT_UNIFORM_NAMES[kind]) loc[n] = gl.getUniformLocation(prog, n);
  return { prog, loc };
}

/** 사람이 읽는 이름 (배지·로그용). 카탈로그 이름과 같다. */
export const GL_STAGE_LABEL: Record<GlStageKind, string> = {
  vibrance: '생동감(바이브런스)',
  bokeh: '보케',
  radialBlur: '방사형 블러',
  mirror: '거울(반사)',
  kaleidoscope: '만화경',
  halftone: '망점(하프톤)',
};
