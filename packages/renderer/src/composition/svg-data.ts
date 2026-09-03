// SVG 필터 데이터 빌더 (순수 — remotion·react 무의존, 단위테스트 대상)
// 여기서 만든 값들이 svg-filters.tsx 의 <filter> 자식 노드 속성으로 그대로 들어간다.
import type { ChromaKey } from '@kitkat/schema';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 소수 4자리로 잘라 문자열화 — SVG 속성 문자열이 부동소수 잡음으로 길어지는 것 방지. */
export function n4(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

/** 0..1 배열 → feFunc* 의 tableValues 문자열. */
export function tableValuesString(values: number[]): string {
  return values.map((v) => n4(clamp01(v))).join(' ');
}

/** 채널별 게인만 있는 4x5 feColorMatrix values (알파 보존). */
export function channelGainMatrix(r: number, g: number, b: number): string {
  return `${n4(r)} 0 0 0 0 0 ${n4(g)} 0 0 0 0 0 ${n4(b)} 0 0 0 0 0 1 0`;
}

/** temperature amount -1(차갑게)..1(따뜻하게) → R 게인↑ / B 게인↓. */
export function temperatureMatrix(amount: number): string {
  const a = clamp(amount, -1, 1);
  return channelGainMatrix(1 + 0.3 * a, 1, 1 - 0.3 * a);
}

/** tint amount -1(초록)..1(자홍) → G 게인↓ / R·B 게인↑. */
export function tintMatrix(amount: number): string {
  const a = clamp(amount, -1, 1);
  return channelGainMatrix(1 + 0.15 * a, 1 - 0.25 * a, 1 + 0.15 * a);
}

// ── 크로마키 (계획 W6 T1 / D14) ────────────────────────────────────────────
// v1 은 RGB 벡터를 키 색 방향에 그대로 투영해서 **밝을수록 지워졌다**(흰옷·밝은 피부가 사라짐).
// 여기서는 픽셀에서 **휘도를 먼저 뺀 색차**를 키 색 방향에 투영한다 → 밝기와 무관해진다.
//
//   luma(c)   = 0.299R + 0.587G + 0.114B
//   chroma(c) = c - luma(c)·(1,1,1)
//   ĉ_key     = normalize(chroma(keyColor))
//   m(pixel)  = chroma(pixel)·ĉ_key      ← R·G·B 의 **선형 결합** (feColorMatrix 한 줄)
//   mKey      = |chroma(keyColor)|       ← 키 색 자신의 점수 (m 의 최댓값 기준)

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/** ChromaKey.spill 이 없을 때 쓰는 기본 디스필 강도 (계획 T1). */
export const DEFAULT_CHROMA_SPILL = 0.5;

/** 렌더러 SVG 체인과 프리뷰 셰이더가 **같이 쓰는** 크로마키 상수들. */
export type ChromaKeyParams = {
  /** m = c[0]·R + c[1]·G + c[2]·B. 세 계수의 합은 항상 0 → 무채색은 m=0 */
  c: [number, number, number];
  /** 키 색 자신의 점수 |chroma(key)| */
  mKey: number;
  /** 임계 t = mKey·(1 - similarity·0.9). m 이 t 를 넘으면 지운다 */
  t: number;
  /** 알파 램프 폭 w = max(0.01, smoothness·mKey·0.5) */
  w: number;
  /** 디스필 벡터 v = -spill·ĉ_key. rgb' = rgb + max(0, m-t)·v (휘도는 보존) */
  v: [number, number, number];
  /** 디스필을 걸어야 하는가 (spill 0 이면 false) */
  despill: boolean;
  /** 키 색에 색차가 없어(무채색) 지울 수 없는 상태 — 아무것도 지우지 않는다 */
  disabled: boolean;
};

/** '#rrggbb'(# 없어도 됨) → 0..1 RGB. 못 읽으면 순수 초록. */
function parseHexRgb(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return [0, 1, 0];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/** ChromaKey 설정 → 판정·디스필 상수. 렌더러와 프리뷰가 이 함수 하나만 쓴다. */
export function chromaKeyParams(chromaKey: ChromaKey): ChromaKeyParams {
  const [kr, kg, kb] = parseHexRgb(chromaKey.color);
  const kl = LUMA_R * kr + LUMA_G * kg + LUMA_B * kb;
  const cx = kr - kl;
  const cy = kg - kl;
  const cz = kb - kl;
  const mKey = Math.hypot(cx, cy, cz);
  const similarity = clamp01(chromaKey.similarity);
  const smoothness = clamp01(chromaKey.smoothness);
  const spill = clamp01(chromaKey.spill ?? DEFAULT_CHROMA_SPILL);
  if (!(mKey > 1e-6)) {
    // 무채색(회색·흰색·검정) 키는 색차가 0 이라 색으로 구분할 수 없다.
    // 화면 전체를 지우는 대신 **아무것도 지우지 않는다** (t 를 도달 불가능한 값으로).
    return { c: [0, 0, 0], mKey: 0, t: 1, w: 0.01, v: [0, 0, 0], despill: false, disabled: true };
  }
  // ĉ_key
  const nr = cx / mKey;
  const ng = cy / mKey;
  const nb = cz / mKey;
  // m = (p - luma(p))·ĉ = p·ĉ - luma(p)·Σĉ → R·G·B 계수로 접는다
  const s = nr + ng + nb;
  const c: [number, number, number] = [nr - LUMA_R * s, ng - LUMA_G * s, nb - LUMA_B * s];
  return {
    c,
    mKey,
    // similarity 가 클수록 임계가 낮아져 더 많이 지운다(v1 과 방향 동일).
    // 0.9 는 similarity=1 에서도 임계가 0 이 되지 않게 하는 하한.
    t: mKey * (1 - similarity * 0.9),
    w: Math.max(0.01, smoothness * mKey * 0.5),
    v: [-spill * nr, -spill * ng, -spill * nb],
    despill: spill > 0,
    disabled: false,
  };
}

/** 픽셀(0..1 sRGB)의 판정 점수 m. */
export function chromaKeyScore(p: ChromaKeyParams, r: number, g: number, b: number): number {
  return p.c[0] * r + p.c[1] * g + p.c[2] * b;
}

/** 픽셀의 알파 배율 0..1 — m ≤ t-w/2 면 1(그대로), m ≥ t+w/2 면 0(투명). */
export function chromaKeyAlphaFactor(
  p: ChromaKeyParams,
  r: number,
  g: number,
  b: number,
): number {
  return clamp01((p.t + p.w / 2 - chromaKeyScore(p, r, g, b)) / p.w);
}

/** 디스필 적용 후 RGB — 임계를 넘은 만큼만 색차 방향으로 뺀다. */
export function chromaKeyDespill(
  p: ChromaKeyParams,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  if (!p.despill) return [r, g, b];
  const q = Math.max(0, chromaKeyScore(p, r, g, b) - p.t);
  return [clamp01(r + q * p.v[0]), clamp01(g + q * p.v[1]), clamp01(b + q * p.v[2])];
}

const SAMPLES = 33; // curvesToTables 와 같은 해상도

function smoothstep01(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/**
 * highlights amount -1(밝은 곳 누르기)..1(올리기) → 33개 톤 테이블.
 * 밝은 영역만 가중(0.35 위부터), 흰색/검정에 붙지 않도록 남은 여유에 비례해 민다 → 클리핑 없음.
 * 세기 계수는 곡선이 단조(계조 역전 없음)로 남는 최대치로 잡았다.
 */
export function highlightsTable(amount: number): number[] {
  const a = clamp(amount, -1, 1);
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const x = i / (SAMPLES - 1);
    const w = smoothstep01((x - 0.35) / 0.65);
    out.push(clamp01(a >= 0 ? x + a * 0.45 * w * (1 - x) : x + a * 0.35 * w * x));
  }
  return out;
}

/** shadows amount -1(어두운 곳 누르기)..1(올리기) → 33개 톤 테이블. 어두운 영역만 가중(0.5 아래). */
export function shadowsTable(amount: number): number[] {
  const a = clamp(amount, -1, 1);
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const x = i / (SAMPLES - 1);
    const w = smoothstep01((0.5 - x) / 0.5);
    out.push(clamp01(a >= 0 ? x + a * 0.28 * w * (1 - x) : x + a * 0.3 * w * x));
  }
  return out;
}

/** sharpen amount 0..2 → 3x3 언샤프 커널 (feConvolveMatrix). */
export function sharpenKernel(amount: number): { order: string; kernelMatrix: string; divisor: number } {
  const a = clamp(amount, 0, 2) * 0.5;
  return {
    order: '3 3',
    kernelMatrix: `0 ${n4(-a)} 0 ${n4(-a)} ${n4(1 + 4 * a)} ${n4(-a)} 0 ${n4(-a)} 0`,
    divisor: 1,
  };
}

/** glow: 하이라이트만 남기는 선형 전이 계수 (threshold 위를 0..1로 펼친다). */
export const GLOW_THRESHOLD = 0.65;
export function glowThreshold(): { slope: number; intercept: number } {
  return thresholdTransfer(GLOW_THRESHOLD);
}

// ═══ W8 F16 — 신규 효과의 데이터 빌더 ═══════════════════════════════════════
//
// 여기 있는 것은 전부 **순수 계산**이다. 실제 <filter> 자식 노드는 svg-filters.tsx 가 만든다.
// 새 효과를 넣을 때 손대는 곳은 catalog.ts(정의) → 여기(수식) → effects.ts(스테이지 선택)
// → svg-filters.tsx(노드) 넷이고, 카탈로그와 구현이 어긋나면 catalog-impl.test.ts 가 잡는다.

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** 임계 t 위쪽만 0..1 로 펼치는 선형 전이 (t=1 근처에서 나눗셈이 터지지 않게 0.95 로 막는다). */
export function thresholdTransfer(t: number): { slope: number; intercept: number } {
  const c = clamp(t, 0, 0.95);
  const slope = 1 / (1 - c);
  return { slope: round4(slope), intercept: round4(-c * slope) };
}

/** feColorMatrix 4x5 항등. */
export const IDENTITY_MATRIX: readonly number[] = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

export function matrixString(m: readonly number[]): string {
  return m.map((v) => n4(v)).join(' ');
}

/** 항등과 섞는다 — 모든 «룩» 효과의 강도 슬라이더가 이걸로 0 에서 항등이 된다. */
export function mixWithIdentity(m: readonly number[], amount: number): number[] {
  const a = clamp01(amount);
  return m.map((v, i) => (IDENTITY_MATRIX[i] as number) * (1 - a) + v * a);
}

/** 표준 saturate 행렬 (SVG feColorMatrix type="saturate" 와 같은 계수). */
export function saturateMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** 33개 톤 테이블을 만든다 — 커브 스테이지가 그대로 먹는 형식. */
function toneTable(f: (x: number) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) out.push(clamp01(f(i / (SAMPLES - 1))));
  return out;
}

/** 감마 — out = x^(1/γ). γ>1 이면 밝아지고 γ=1 이면 항등이다. */
export function gammaTable(gamma: number): number[] {
  const g = clamp(gamma, 0.2, 3);
  return toneTable((x) => Math.pow(x, 1 / g));
}

/** S 커브 — k 가 클수록 대비가 세다. k=0 이면 항등. */
function sCurve(x: number, k: number): number {
  return x + k * (smoothstep01(x) - x);
}

// ── 화이트 밸런스 (색온도 K + 자홍끼) ─────────────────────────────────────
//
// **`temperature` 효과와 다른 물건이다.** temperature 는 -1..1 을 R·B 게인에 «선형으로» 꽂는
// 노브고, 여기는 켈빈 값을 흑체 복사 근사(Tanner Helland)로 RGB 로 바꾼 뒤 6500K 대비 게인을
// 잡는다 — 그래서 3200K(백열등)·5600K(주광) 같은 **실제 조명 값**을 그대로 넣을 수 있다.

const WB_REF_KELVIN = 6500;

function kelvinRgb(kelvin: number): [number, number, number] {
  const t = clamp(kelvin, 1000, 40000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66
    ? 99.4708025861 * Math.log(t) - 161.1195681661
    : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp01(r / 255), clamp01(g / 255), clamp01(b / 255)];
}

/**
 * 켈빈이 높을수록 «따뜻하게»(빨갛게) 간다 — 기존 `temperature` 슬라이더와 방향이 같다.
 * 초록 게인을 1 로 정규화해 전체 밝기가 안 변하고, 게인은 0.4..2.5 로 막는다
 * (2000K 에서 파랑이 0 이 되면 하늘이 통째로 검게 죽는다).
 */
export function whiteBalanceMatrix(kelvin: number, tint: number): string {
  const target = kelvinRgb(kelvin);
  const ref = kelvinRgb(WB_REF_KELVIN);
  const raw = [0, 1, 2].map((i) => (target[i] as number) / Math.max(1e-6, ref[i] as number));
  const norm = Math.max(1e-6, raw[1] as number);
  const t = clamp(tint, -1, 1);
  const gain = raw.map((v) => clamp(v / norm, 0.4, 2.5));
  return channelGainMatrix(
    (gain[0] as number) * (1 + 0.15 * t),
    (gain[1] as number) * (1 - 0.25 * t),
    (gain[2] as number) * (1 + 0.15 * t),
  );
}

// ── 룩 프리셋들 ───────────────────────────────────────────────────────────

/** 블리치 바이패스 — 은잔상 공정. 채도를 깎고 대비를 세게 올린다(1단계: 행렬, 2단계: 커브). */
export function bleachBypassMatrix(amount: number): string {
  return matrixString(mixWithIdentity(saturateMatrix(0.25), amount));
}
export function bleachBypassTable(amount: number): number[] {
  const a = clamp01(amount);
  return toneTable((x) => sCurve(x, a * 0.85));
}

/**
 * 크로스 프로세스 — 필름을 «다른 약품»에 현상한 색. 채널마다 곡선이 **다르다**:
 * R 은 밝은 쪽이 뜨고, G 는 S 자, B 는 어두운 쪽이 들린다(청록 그림자 + 노란 하이라이트).
 */
export function crossProcessTables(amount: number): { r: number[]; g: number[]; b: number[] } {
  const a = clamp01(amount);
  return {
    r: toneTable((x) => x + a * 0.22 * Math.sin(Math.PI * x) * (0.5 + x)),
    g: toneTable((x) => sCurve(x, a * 0.55)),
    b: toneTable((x) => x + a * (0.14 * (1 - x) * (1 - x) - 0.1 * x * x)),
  };
}

/** 틸 & 오렌지 — 그림자는 청록으로, 하이라이트는 주황으로. 광고 색보정의 기본형. */
export function tealOrangeTables(amount: number): { r: number[]; g: number[]; b: number[] } {
  const a = clamp01(amount);
  const low = (x: number) => (1 - x) * (1 - x);
  const high = (x: number) => x * x;
  return {
    r: toneTable((x) => x + a * (0.16 * high(x) - 0.07 * low(x))),
    g: toneTable((x) => x + a * (0.05 * high(x) + 0.02 * low(x))),
    b: toneTable((x) => x + a * (0.17 * low(x) - 0.13 * high(x))),
  };
}

/** 바랜 느낌 — 검정이 들리고(matte) 흰색이 눌린다. 대비가 죽는 게 핵심이라 커브 하나면 된다. */
export function fadedTable(amount: number): number[] {
  const a = clamp01(amount);
  const lift = a * 0.16;
  const roll = a * 0.1;
  return toneTable((x) => lift + x * (1 - lift - roll));
}
export function fadedMatrix(amount: number): string {
  return matrixString(mixWithIdentity(saturateMatrix(0.78), amount));
}

/** hsl(0..360, s, l) → 0..1 RGB. */
export function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * l - 1)) * clamp01(s);
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = l - c / 2;
  const t: [number, number, number] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x]
    : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [clamp01(t[0] + m), clamp01(t[1] + m), clamp01(t[2] + m)];
}

/**
 * 듀오톤 — 휘도를 두 색 사이로 «곧게» 펴 놓는다.
 * out = A + (B-A)·luma 이므로 feColorMatrix 한 줄로 정확히 표현된다(근사가 아니다).
 */
export function duotoneMatrix(hueA: number, hueB: number, amount: number): string {
  const a = hslRgb(hueA, 0.72, 0.24);   // 어두운 쪽
  const b = hslRgb(hueB, 0.85, 0.66);   // 밝은 쪽
  const row = (i: number): number[] => {
    const d = (b[i] as number) - (a[i] as number);
    return [d * LUMA_R, d * LUMA_G, d * LUMA_B, 0, a[i] as number];
  };
  return matrixString(mixWithIdentity([...row(0), ...row(1), ...row(2), 0, 0, 0, 1, 0], amount));
}

// ── 스타일 ────────────────────────────────────────────────────────────────

/** 포스터라이즈 — feFunc type="discrete" 의 tableValues (n 단계). */
export function posterizeLevels(levels: number): number[] {
  const n = Math.max(2, Math.min(16, Math.round(levels)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i / (n - 1));
  return out;
}

/**
 * 이치화 — 기준 밝기에서 딱 잘린다. slope 를 아주 크게 준 선형 전이가 곧 계단이다
 * (feFunc 의 discrete 는 «구간을 균등 분할»해서 기준 위치를 못 정한다).
 */
export function thresholdTransferSteep(level: number): { slope: number; intercept: number } {
  const t = clamp(level, 0, 1);
  const slope = 255;
  return { slope, intercept: round4(-slope * t + 0.5) };
}

/** 윤곽선 — 3x3 라플라시안. 결과가 0 근처라 bias 대신 divisor 로 세기를 준다. */
export function edgeKernel(amount: number): { order: string; kernelMatrix: string; divisor: number } {
  const a = clamp(amount, 0, 2);
  return {
    order: '3 3',
    kernelMatrix: `0 ${n4(-a)} 0 ${n4(-a)} ${n4(4 * a)} ${n4(-a)} 0 ${n4(-a)} 0`,
    divisor: 1,
  };
}

// ── 왜곡 ──────────────────────────────────────────────────────────────────

/** 픽셀화 — 셀 크기(px)와 «셀 안에서 한 점만 남기고 부풀릴» 반경. */
export function pixelateSpec(size: number): { cell: number; radius: number } {
  const cell = Math.max(2, Math.round(clamp(size, 2, 200)));
  return { cell, radius: Math.max(1, Math.round(cell / 2)) };
}

/** 물결 — feTurbulence 의 baseFrequency 와 feDisplacementMap 의 scale. */
export function waveSpec(amount: number, scale: number): { scale: number; freq: number } {
  return { scale: clamp(amount, 0, 60), freq: clamp(scale, 0.001, 0.2) };
}
