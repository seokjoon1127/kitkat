// F6 스코프 — 픽셀 → 스코프 그림의 **순수 계산**.
//
// 이 파일은 브라우저 API 를 하나도 쓰지 않는다. 웹워커(scopes.worker.ts)와 노드 테스트가
// **같은 코드**를 돌려서, 「화면에 보이는 것」과 「테스트가 재는 것」이 갈라지지 않게 한다.
// 격자·라벨만 2D 컨텍스트를 받아 그리는데, 그것도 구조적 타입(Ctx2D)이라 스텁으로 검사할 수 있다.
//
// **행 순서는 신경 쓰지 않는다.** GL 의 readPixels 는 아래→위로 주는데, 세 스코프 모두
// 가로 위치(웨이브폼)와 값 분포만 쓰므로 세로 뒤집힘이 결과를 바꾸지 않는다.

export type RgbaLike = Uint8Array | Uint8ClampedArray;

export type ScopeKind = 'waveform' | 'vectorscope' | 'histogram';
export const SCOPE_KINDS: readonly ScopeKind[] = ['waveform', 'vectorscope', 'histogram'];

export const SCOPE_LABEL: Record<ScopeKind, string> = {
  waveform: '웨이브폼',
  vectorscope: '벡터스코프',
  histogram: '히스토그램',
};

/** 만들어 낼 그림 한 장 (ImageData 와 같은 모양 — 브라우저 타입에 의존하지 않는다). */
export type ImageLike = { width: number; height: number; data: Uint8ClampedArray };

export function blankImage(width: number, height: number): ImageLike {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

// ── BT.601 색차 ───────────────────────────────────────────────────────────

/** Cb = -0.169R -0.331G +0.500B (R·G·B 는 0..1). 범위 대략 ±0.5. */
export function toCb(r: number, g: number, b: number): number {
  return -0.169 * r - 0.331 * g + 0.5 * b;
}
/** Cr = 0.500R -0.419G -0.081B (R·G·B 는 0..1). */
export function toCr(r: number, g: number, b: number): number {
  return 0.5 * r - 0.419 * g - 0.081 * b;
}
/** 휘도 Y = 0.299R +0.587G +0.114B (0..1). */
export function toY(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// ── 웨이브폼 (RGB 퍼레이드) ────────────────────────────────────────────────

/** 채널 한 칸의 가로폭. 셋을 나란히 놓아 전체 384 가 된다. */
export const WAVEFORM_COL_W = 128;
export const WAVEFORM_SIZE = { width: WAVEFORM_COL_W * 3, height: 256 } as const;

/**
 * 채널별 (가로칸, 값) 누적 카운트.
 * 길이 = 3 * cols * 256, 색인 = (ch * cols + col) * 256 + v.
 */
export function waveformColumns(
  px: RgbaLike,
  w: number,
  h: number,
  cols: number = WAVEFORM_COL_W,
): Uint32Array {
  const out = new Uint32Array(3 * cols * 256);
  if (w <= 0 || h <= 0 || cols <= 0) return out;
  // 가로 좌표 → 칸 매핑을 미리 접어 둔다 (안쪽 루프에서 나눗셈을 없앤다)
  const colOf = new Int32Array(w);
  for (let x = 0; x < w; x++) colOf[x] = Math.min(cols - 1, Math.floor((x * cols) / w));
  const base1 = cols * 256;
  const base2 = 2 * cols * 256;
  for (let y = 0; y < h; y++) {
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const c = colOf[x] * 256;
      out[c + px[i]]++;
      out[base1 + c + px[i + 1]]++;
      out[base2 + c + px[i + 2]]++;
    }
  }
  return out;
}

export type WaveformOpts = {
  /** 한 점이 더하는 밝기 (ffmpeg waveform 의 intensity 와 같은 뜻). 기본 0.2 */
  intensity?: number;
  /** 샘플 세로 픽셀 수 — 세로 해상도가 달라도 밝기가 같게 정규화한다. */
  sampleH?: number;
  /** 감마 (클수록 어두운 자국이 잘 보인다). 기본 1.8 */
  gamma?: number;
};

/**
 * 카운트 → 퍼레이드 그림. 위가 255, 아래가 0 (방송 웨이브폼과 같은 방향).
 * 밝기 = clamp(count * intensity * 256/sampleH) 를 1/gamma 로 편 값.
 */
export function renderWaveform(
  counts: Uint32Array,
  cols: number = WAVEFORM_COL_W,
  opts: WaveformOpts = {},
): ImageLike {
  const intensity = opts.intensity ?? 0.2;
  const sampleH = opts.sampleH && opts.sampleH > 0 ? opts.sampleH : 256;
  const invGamma = 1 / (opts.gamma ?? 1.8);
  const gain = (intensity * 256) / sampleH;
  const img = blankImage(cols * 3, 256);
  const d = img.data;
  const W = img.width;
  for (let ch = 0; ch < 3; ch++) {
    const chBase = ch * cols * 256;
    for (let col = 0; col < cols; col++) {
      const cb = chBase + col * 256;
      const x = ch * cols + col;
      for (let v = 0; v < 256; v++) {
        const n = counts[cb + v];
        if (n === 0) continue;
        const a = Math.min(1, n * gain);
        const lit = Math.round(255 * Math.pow(a, invGamma));
        const o = ((255 - v) * W + x) * 4;
        d[o + ch] = lit;
        d[o + 3] = 255;
      }
    }
  }
  return img;
}

// ── 벡터스코프 ────────────────────────────────────────────────────────────

export const VECTORSCOPE_SIZE = 256;
/** 이 색차 크기가 바깥 원(반지름 R)에 닿는다. 100% 순색(최대 0.534)이 안쪽에 남도록 잡았다. */
export const VECTOR_FULL_SCALE = 0.625;
/**
 * 스킨톤(I) 라인 각도 — **+Cr(세로)축에서 시계 반대로 33°**.
 * 화면 좌표(가로 +Cb, 세로 +Cr 위)로는 90+33 = 123°. 사람 살색의 색차가 이 선 근처에 모인다.
 */
export const SKIN_TONE_ANGLE_DEG = 33;

export type VectorPoint = { name: string; cb: number; cr: number; x: number; y: number };

/** 100% 순색 6개(R/Yl/G/Cy/B/Mg)의 색차와 화면 좌표. 격자 타깃이자 검증 기준점이다. */
export function vectorTargets(size: number = VECTORSCOPE_SIZE): VectorPoint[] {
  const rgb: [string, [number, number, number]][] = [
    ['R', [1, 0, 0]],
    ['Yl', [1, 1, 0]],
    ['G', [0, 1, 0]],
    ['Cy', [0, 1, 1]],
    ['B', [0, 0, 1]],
    ['Mg', [1, 0, 1]],
  ];
  return rgb.map(([name, [r, g, b]]) => {
    const cb = toCb(r, g, b);
    const cr = toCr(r, g, b);
    const p = vectorPlot(cb, cr, size);
    return { name, cb, cr, x: p.x, y: p.y };
  });
}

/** 색차 → 화면 좌표 (가운데가 무채색, 위가 +Cr, 오른쪽이 +Cb). */
export function vectorPlot(cb: number, cr: number, size: number = VECTORSCOPE_SIZE): { x: number; y: number } {
  const c = size / 2;
  const R = size / 2 - 1;
  return {
    x: c + (cb / VECTOR_FULL_SCALE) * R,
    y: c - (cr / VECTOR_FULL_SCALE) * R,
  };
}

/** 스킨톤 라인의 바깥 끝점 (중심 → 이 점). */
export function skinLineEnd(size: number = VECTORSCOPE_SIZE): { x: number; y: number } {
  const c = size / 2;
  const R = size / 2 - 1;
  const a = ((90 + SKIN_TONE_ANGLE_DEG) * Math.PI) / 180;
  return { x: c + Math.cos(a) * R, y: c - Math.sin(a) * R };
}

/** 각 칸에 몇 점이 찍혔는지 (size×size). */
export function vectorscopeBins(px: RgbaLike, w: number, h: number, size: number = VECTORSCOPE_SIZE): Uint32Array {
  const bins = new Uint32Array(size * size);
  if (w <= 0 || h <= 0) return bins;
  const c = size / 2;
  const R = size / 2 - 1;
  const k = R / VECTOR_FULL_SCALE / 255; // 0..255 정수에서 바로 좌표로
  const n = w * h * 4;
  for (let i = 0; i < n; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const cb = -0.169 * r - 0.331 * g + 0.5 * b;
    const cr = 0.5 * r - 0.419 * g - 0.081 * b;
    const x = (c + cb * k) | 0;
    const y = (c - cr * k) | 0;
    if (x < 0 || x >= size || y < 0 || y >= size) continue;
    bins[y * size + x]++;
  }
  return bins;
}

export type VectorscopeOpts = { intensity?: number; gamma?: number };

/**
 * 칸 카운트 → 그림. 색은 **그 칸의 위치가 뜻하는 색상**으로 칠한다(ffmpeg mode=color3 와 같은 생각).
 * 그래서 살색 뭉치는 살색으로, 하늘은 파랗게 보인다.
 */
export function renderVectorscope(
  bins: Uint32Array,
  size: number = VECTORSCOPE_SIZE,
  opts: VectorscopeOpts = {},
): ImageLike {
  const intensity = opts.intensity ?? 0.06;
  const invGamma = 1 / (opts.gamma ?? 2.0);
  const img = blankImage(size, size);
  const d = img.data;
  const c = size / 2;
  const R = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = bins[y * size + x];
      if (n === 0) continue;
      const a = Math.pow(Math.min(1, n * intensity), invGamma);
      const cb = ((x + 0.5 - c) / R) * VECTOR_FULL_SCALE;
      const cr = ((c - y - 0.5) / R) * VECTOR_FULL_SCALE;
      const hue = hueFromChroma(cb, cr);
      const o = (y * size + x) * 4;
      d[o] = Math.round(hue[0] * 255 * a);
      d[o + 1] = Math.round(hue[1] * 255 * a);
      d[o + 2] = Math.round(hue[2] * 255 * a);
      d[o + 3] = 255;
    }
  }
  return img;
}

/** (Cb,Cr) 방향의 색을 최대 채도로 편 것 — 벡터스코프 점 색칠용. */
export function hueFromChroma(cb: number, cr: number): [number, number, number] {
  // Y 를 0.5 로 두고 BT.601 역변환 → 0..1 로 정규화
  let r = 0.5 + 1.402 * cr;
  let g = 0.5 - 0.344136 * cb - 0.714136 * cr;
  let b = 0.5 + 1.772 * cb;
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b);
  if (hi - lo < 1e-6) return [1, 1, 1];
  r = (r - lo) / (hi - lo);
  g = (g - lo) / (hi - lo);
  b = (b - lo) / (hi - lo);
  return [r, g, b];
}

// ── 히스토그램 ────────────────────────────────────────────────────────────

export const HISTOGRAM_SIZE = { width: 256, height: 160 } as const;

/** R·G·B 각 256빈 카운트. */
export function histogramBins(px: RgbaLike, w: number, h: number): [Uint32Array, Uint32Array, Uint32Array] {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const n = Math.max(0, w * h * 4);
  for (let i = 0; i < n; i += 4) {
    r[px[i]]++;
    g[px[i + 1]]++;
    b[px[i + 2]]++;
  }
  return [r, g, b];
}

export type HistogramOpts = { log?: boolean; height?: number };

/** 세 채널을 겹쳐 그린다(가산). log 를 켜면 작은 빈도 차이가 보인다. */
export function renderHistogram(
  bins: [Uint32Array, Uint32Array, Uint32Array],
  opts: HistogramOpts = {},
): ImageLike {
  const H = opts.height ?? HISTOGRAM_SIZE.height;
  const W = 256;
  const img = blankImage(W, H);
  const d = img.data;
  let max = 0;
  for (const ch of bins) for (let i = 0; i < 256; i++) if (ch[i] > max) max = ch[i];
  if (max <= 0) return img;
  const scale = opts.log ? 1 / Math.log1p(max) : 1 / max;
  for (let ch = 0; ch < 3; ch++) {
    const arr = bins[ch] as Uint32Array;
    for (let x = 0; x < W; x++) {
      const v = arr[x];
      if (v === 0) continue;
      const norm = opts.log ? Math.log1p(v) * scale : v * scale;
      const top = H - Math.max(1, Math.min(H, Math.round(norm * H)));
      for (let y = top; y < H; y++) {
        const o = (y * W + x) * 4;
        d[o + ch] = 255;
        d[o + 3] = 255;
      }
    }
  }
  return img;
}

// ── 통계 (실시간 ↔ 정밀 대조용) ────────────────────────────────────────────

export type ScopeStats = {
  pixels: number;
  /** 0..255 평균 */
  mean: [number, number, number];
  meanY: number;
  /** ±0.5 * 255 규모(정수 스케일 그대로) */
  meanCb: number;
  meanCr: number;
};

export function scopeStats(px: RgbaLike, w: number, h: number): ScopeStats {
  const n = Math.max(0, w * h);
  if (n === 0) return { pixels: 0, mean: [0, 0, 0], meanY: 0, meanCb: 0, meanCr: 0 };
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < n * 4; i += 4) {
    sr += px[i];
    sg += px[i + 1];
    sb += px[i + 2];
  }
  const mr = sr / n;
  const mg = sg / n;
  const mb = sb / n;
  return {
    pixels: n,
    mean: [mr, mg, mb],
    meanY: toY(mr, mg, mb),
    meanCb: toCb(mr, mg, mb),
    meanCr: toCr(mr, mg, mb),
  };
}

export type StatsDelta = {
  dR: number;
  dG: number;
  dB: number;
  dY: number;
  dCb: number;
  dCr: number;
  /** 위 여섯 중 제일 큰 절댓값 — 「얼마나 다른지」 한 숫자로. */
  max: number;
};

/** 두 경로의 차이(0..255 눈금). 사용자에게 그대로 보여 줄 숫자다. */
export function statsDelta(a: ScopeStats, b: ScopeStats): StatsDelta {
  const dR = a.mean[0] - b.mean[0];
  const dG = a.mean[1] - b.mean[1];
  const dB = a.mean[2] - b.mean[2];
  const dY = a.meanY - b.meanY;
  const dCb = a.meanCb - b.meanCb;
  const dCr = a.meanCr - b.meanCr;
  return {
    dR,
    dG,
    dB,
    dY,
    dCb,
    dCr,
    max: Math.max(...[dR, dG, dB, dY, dCb, dCr].map(Math.abs)),
  };
}

// ── 격자 (2D 컨텍스트를 받아 그린다) ────────────────────────────────────────

/** 격자를 그리는 데 필요한 것만 뽑은 구조적 타입 — 테스트에서 스텁으로 바꿀 수 있다. */
export type Ctx2D = {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  fillText(t: string, x: number, y: number): void;
  setLineDash(d: number[]): void;
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  font: string;
};

const GRID = 'rgba(120,200,140,0.55)';
const GRID_DIM = 'rgba(120,200,140,0.22)';
const SKIN = 'rgba(255,170,120,0.85)';

/** 벡터스코프 격자 — 바깥 원·십자·6색 타깃 상자·라벨·스킨톤 라인. 이게 없으면 점은 쓸모가 없다. */
export function drawVectorGraticule(ctx: Ctx2D, size: number = VECTORSCOPE_SIZE): void {
  const c = size / 2;
  const R = size / 2 - 1;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = GRID_DIM;
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.arc(c, c, R * 0.5, 0, Math.PI * 2);
  ctx.moveTo(c - R, c);
  ctx.lineTo(c + R, c);
  ctx.moveTo(c, c - R);
  ctx.lineTo(c, c + R);
  ctx.stroke();

  // 6색 타깃 — 100% 순색이 들어와야 할 자리
  ctx.strokeStyle = GRID;
  ctx.fillStyle = GRID;
  ctx.font = '9px sans-serif';
  const box = Math.max(6, Math.round(size * 0.045));
  for (const t of vectorTargets(size)) {
    ctx.beginPath();
    ctx.rect(t.x - box / 2, t.y - box / 2, box, box);
    ctx.stroke();
    ctx.fillText(t.name, t.x + box / 2 + 2, t.y + 3);
  }

  // 스킨톤(I) 라인
  const e = skinLineEnd(size);
  ctx.strokeStyle = SKIN;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(e.x, e.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** 웨이브폼 눈금 — 0/25/50/75/100 IRE 가로선 + 채널 칸 경계 + R·G·B 라벨. */
export function drawWaveformGraticule(ctx: Ctx2D, cols: number = WAVEFORM_COL_W): void {
  const W = cols * 3;
  const H = 256;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = GRID_DIM;
  ctx.beginPath();
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const y = Math.round((1 - p) * (H - 1)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(i * cols + 0.5, 0);
    ctx.lineTo(i * cols + 0.5, H);
  }
  ctx.stroke();
  ctx.font = '9px sans-serif';
  const names = ['R', 'G', 'B'];
  const colors = ['rgba(255,120,120,0.9)', 'rgba(120,255,140,0.9)', 'rgba(130,160,255,0.9)'];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = colors[i] as string;
    ctx.fillText(names[i] as string, i * cols + 4, 11);
  }
  ctx.fillStyle = GRID;
  ctx.fillText('100', W - 20, 10);
  ctx.fillText('0', W - 20, H - 3);
  ctx.restore();
}

/** 히스토그램 눈금 — 0/64/128/192/255 세로선. */
export function drawHistogramGraticule(ctx: Ctx2D, w = 256, h: number = HISTOGRAM_SIZE.height): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = GRID_DIM;
  ctx.beginPath();
  for (const v of [0, 64, 128, 192, 255]) {
    const x = Math.round((v / 255) * (w - 1)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.stroke();
  ctx.fillStyle = GRID;
  ctx.font = '9px sans-serif';
  ctx.fillText('0', 2, h - 3);
  ctx.fillText('255', w - 18, h - 3);
  ctx.restore();
}

// ── 한 방에 다 만들기 (워커·테스트 공용) ────────────────────────────────────

export type ScopeComputeOpts = {
  waveform?: WaveformOpts;
  vectorscope?: VectorscopeOpts;
  histogram?: HistogramOpts;
};

/** 픽셀 한 장 → 요청한 종류들의 그림. 격자는 여기서 안 그린다(2D 컨텍스트가 필요하므로). */
export function computeScopes(
  px: RgbaLike,
  w: number,
  h: number,
  kinds: readonly ScopeKind[],
  opts: ScopeComputeOpts = {},
): Partial<Record<ScopeKind, ImageLike>> {
  const out: Partial<Record<ScopeKind, ImageLike>> = {};
  for (const k of kinds) {
    if (k === 'waveform') {
      out.waveform = renderWaveform(waveformColumns(px, w, h), WAVEFORM_COL_W, {
        sampleH: h,
        ...opts.waveform,
      });
    } else if (k === 'vectorscope') {
      out.vectorscope = renderVectorscope(
        vectorscopeBins(px, w, h),
        VECTORSCOPE_SIZE,
        opts.vectorscope,
      );
    } else {
      out.histogram = renderHistogram(histogramBins(px, w, h), opts.histogram);
    }
  }
  return out;
}
