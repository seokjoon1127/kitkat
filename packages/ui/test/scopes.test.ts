// F6 실시간 스코프 — **알려진 신호**로 대조한다.
//  · 0~100% 그레이 램프 → 웨이브폼이 직선
//  · 100% 컬러바        → 벡터스코프 6개 점이 격자 타깃 «안»
//  · 순수 흰색/검정      → 히스토그램 양 끝 스파이크
// 그리고 PBO 비동기 읽기 상태기계·워커 격리·버스를 가짜 GL 로 확인한다.
import { describe, expect, it, beforeEach } from 'vitest';
import {
  SKIN_TONE_ANGLE_DEG,
  drawHistogramGraticule,
  drawVectorGraticule,
  drawWaveformGraticule,
  histogramBins,
  hueFromChroma,
  renderHistogram,
  renderVectorscope,
  renderWaveform,
  scopeStats,
  skinLineEnd,
  statsDelta,
  toCb,
  toCr,
  vectorPlot,
  vectorTargets,
  vectorscopeBins,
  waveformColumns,
  WAVEFORM_COL_W,
  type Ctx2D,
} from '../src/preview/scopes.js';
import {
  FpsMeter,
  ScopeReader,
  scopeBus,
  scopeSampleSize,
  type ScopeGl,
} from '../src/preview/scope-source.js';
import { handleScopeRequest } from '../src/preview/scopes.worker.js';

// ── 알려진 신호 만들기 ────────────────────────────────────────────────────

/** 가로 0→255 그레이 램프 (세로는 전부 같은 값). */
function grayRamp(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x * 255) / (w - 1));
      const o = (y * w + x) * 4;
      px[o] = v;
      px[o + 1] = v;
      px[o + 2] = v;
      px[o + 3] = 255;
    }
  }
  return px;
}

const BAR_100: [number, number, number][] = [
  [255, 255, 255],
  [255, 255, 0],
  [0, 255, 255],
  [0, 255, 0],
  [255, 0, 255],
  [255, 0, 0],
  [0, 0, 255],
  [0, 0, 0],
];

/** 100% 컬러바 (흰·노랑·시안·초록·마젠타·빨강·파랑·검정). */
function colorBars100(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bar = BAR_100[Math.min(BAR_100.length - 1, Math.floor((x * BAR_100.length) / w))]!;
      const o = (y * w + x) * 4;
      px[o] = bar[0];
      px[o + 1] = bar[1];
      px[o + 2] = bar[2];
      px[o + 3] = 255;
    }
  }
  return px;
}

function solid(w: number, h: number, c: [number, number, number]): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = c[0];
    px[i * 4 + 1] = c[1];
    px[i * 4 + 2] = c[2];
    px[i * 4 + 3] = 255;
  }
  return px;
}

describe('웨이브폼 — 그레이 램프는 직선', () => {
  const W = 256;
  const H = 128;
  const px = grayRamp(W, H);

  it('칸마다 값이 하나뿐이고(세로 한 줄), 그 값이 가로에 대해 선형이다', () => {
    const counts = waveformColumns(px, W, H);
    const cols = WAVEFORM_COL_W;
    const trace: number[] = [];
    for (let col = 0; col < cols; col++) {
      const lit: number[] = [];
      for (let v = 0; v < 256; v++) if (counts[col * 256 + v]! > 0) lit.push(v);
      // 램프는 한 칸(2 소스 픽셀)에 값이 1~2개만 들어온다 — 굵기 2 이하 = "선"
      expect(lit.length).toBeLessThanOrEqual(2);
      trace.push(lit.reduce((a, b) => a + b, 0) / lit.length);
    }
    // 최소제곱 직선 적합 — 기울기 255/(cols-1), 잔차 1LSB 미만이면 직선이다
    const n = cols;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += trace[i]!;
      sxx += i * i;
      sxy += i * trace[i]!;
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    let maxResid = 0;
    for (let i = 0; i < n; i++) {
      maxResid = Math.max(maxResid, Math.abs(trace[i]! - (slope * i + intercept)));
    }
    expect(slope).toBeCloseTo(255 / (cols - 1), 1);
    expect(maxResid).toBeLessThan(1.5);
  });

  it('R·G·B 세 칸이 똑같다 (무채색 신호)', () => {
    const counts = waveformColumns(px, W, H);
    const n = WAVEFORM_COL_W * 256;
    expect(counts.subarray(n, 2 * n)).toEqual(counts.subarray(0, n));
    expect(counts.subarray(2 * n, 3 * n)).toEqual(counts.subarray(0, n));
  });

  it('그림은 가로 3등분(384×256)이고 채널마다 자기 색으로만 켜진다', () => {
    const img = renderWaveform(waveformColumns(px, W, H), WAVEFORM_COL_W, { sampleH: H });
    expect(img.width).toBe(WAVEFORM_COL_W * 3);
    expect(img.height).toBe(256);
    const lit = { r: 0, g: 0, b: 0 };
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        if (img.data[o]! > 0) lit.r++;
        if (img.data[o + 1]! > 0) lit.g++;
        if (img.data[o + 2]! > 0) lit.b++;
      }
    }
    expect(lit.r).toBeGreaterThan(0);
    expect(lit.r).toBe(lit.g);
    expect(lit.g).toBe(lit.b);
  });

  it('세로 표본 수가 달라도 밝기가 비슷하다 (sampleH 정규화)', () => {
    const a = renderWaveform(waveformColumns(grayRamp(256, 64), 256, 64), WAVEFORM_COL_W, {
      sampleH: 64,
    });
    const b = renderWaveform(waveformColumns(grayRamp(256, 455), 256, 455), WAVEFORM_COL_W, {
      sampleH: 455,
    });
    const sum = (img: { data: Uint8ClampedArray }): number =>
      img.data.reduce((acc, v, i) => (i % 4 === 3 ? acc : acc + v), 0);
    const ratio = sum(a) / sum(b);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.4);
  });
});

describe('벡터스코프 — 100% 컬러바의 6개 점이 격자 타깃 안', () => {
  const W = 256;
  const H = 256;
  const size = 256;

  it('R·Yl·G·Cy·B·Mg 가 각자 타깃 상자 안에 든다', () => {
    const bins = vectorscopeBins(colorBars100(W, H), W, H, size);
    const targets = vectorTargets(size);
    const box = Math.max(6, Math.round(size * 0.045)); // drawVectorGraticule 과 같은 크기
    for (const t of targets) {
      // 타깃 상자 안에 점이 있나 (상자는 중심 ±box/2)
      let hits = 0;
      for (let y = Math.floor(t.y - box / 2); y <= Math.ceil(t.y + box / 2); y++) {
        for (let x = Math.floor(t.x - box / 2); x <= Math.ceil(t.x + box / 2); x++) {
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          hits += bins[y * size + x]!;
        }
      }
      expect(hits, `${t.name} 타깃이 비었다`).toBeGreaterThan(0);
    }
  });

  it('찍힌 점 무리는 정확히 7곳 — 6색 + 무채색(흰·검정은 같은 중심)', () => {
    const bins = vectorscopeBins(colorBars100(W, H), W, H, size);
    const filled: [number, number][] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (bins[y * size + x]! > 0) filled.push([x, y]);
    }
    expect(filled.length).toBe(7);
  });

  it('무채색은 정확히 한가운데', () => {
    const bins = vectorscopeBins(solid(64, 64, [128, 128, 128]), 64, 64, size);
    const c = vectorPlot(0, 0, size);
    expect(bins[Math.floor(c.y) * size + Math.floor(c.x)]).toBe(64 * 64);
  });

  it('타깃은 전부 바깥 원 안에 있다 (VECTOR_FULL_SCALE 이 넉넉하다)', () => {
    const targets = vectorTargets(size);
    const R = size / 2 - 1;
    for (const t of targets) {
      const d = Math.hypot(t.x - size / 2, t.y - size / 2);
      expect(d, t.name).toBeLessThan(R);
      expect(d, t.name).toBeGreaterThan(R * 0.7);
    }
  });

  it('스킨톤 라인은 +Cr 축에서 33°, 실제 살색이 그 선 가까이 온다', () => {
    const e = skinLineEnd(size);
    const c = size / 2;
    const deg = (Math.atan2(c - e.y, e.x - c) * 180) / Math.PI;
    expect(deg).toBeCloseTo(90 + SKIN_TONE_ANGLE_DEG, 5);

    // 사람 살색 몇 가지의 각도가 라인에서 ±10° 안이어야 «스킨톤 라인» 이라 부를 수 있다
    const skins: [number, number, number][] = [
      [222, 166, 135],
      [194, 145, 120],
      [141, 92, 66],
      [255, 219, 195],
    ];
    for (const [r, g, b] of skins) {
      const a = (Math.atan2(toCr(r, g, b), toCb(r, g, b)) * 180) / Math.PI;
      expect(Math.abs(a - (90 + SKIN_TONE_ANGLE_DEG)), `${r},${g},${b}`).toBeLessThan(10);
    }
  });

  it('점 색은 그 자리의 색상 — 빨강 타깃 자리는 붉게 칠해진다', () => {
    const bins = vectorscopeBins(solid(32, 32, [255, 0, 0]), 32, 32, size);
    const img = renderVectorscope(bins, size);
    const t = vectorTargets(size).find((x) => x.name === 'R')!;
    const o = (Math.floor(t.y) * size + Math.floor(t.x)) * 4;
    expect(img.data[o]).toBeGreaterThan(img.data[o + 1]!);
    expect(img.data[o]).toBeGreaterThan(img.data[o + 2]!);
  });

  it('hueFromChroma 는 무채색에서 흰색', () => {
    expect(hueFromChroma(0, 0)).toEqual([1, 1, 1]);
  });
});

describe('히스토그램 — 순수 흰색/검정은 양 끝 스파이크', () => {
  it('흰색은 255빈에만, 검정은 0빈에만', () => {
    const n = 40 * 30;
    const white = histogramBins(solid(40, 30, [255, 255, 255]), 40, 30);
    const black = histogramBins(solid(40, 30, [0, 0, 0]), 40, 30);
    for (const ch of white) {
      expect(ch[255]).toBe(n);
      expect(ch.reduce((a, b) => a + b, 0)).toBe(n);
    }
    for (const ch of black) {
      expect(ch[0]).toBe(n);
      expect(ch.reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it('그림에서도 양 끝 열만 켜진다', () => {
    const img = renderHistogram(histogramBins(solid(40, 30, [255, 255, 255]), 40, 30));
    const colLit = (x: number): number => {
      let n = 0;
      for (let y = 0; y < img.height; y++) if (img.data[(y * img.width + x) * 4 + 3]! > 0) n++;
      return n;
    };
    expect(colLit(255)).toBe(img.height);
    expect(colLit(0)).toBe(0);
    expect(colLit(128)).toBe(0);
  });

  it('로그 스케일은 작은 빈도를 끌어올린다', () => {
    // 큰 봉우리 하나 + 작은 봉우리 하나
    const px = new Uint8Array(1000 * 4);
    for (let i = 0; i < 1000; i++) {
      const v = i < 990 ? 10 : 200;
      px[i * 4] = v;
      px[i * 4 + 1] = v;
      px[i * 4 + 2] = v;
    }
    const bins = histogramBins(px, 1000, 1);
    const lin = renderHistogram(bins, { log: false });
    const logImg = renderHistogram(bins, { log: true });
    const heightAt = (img: { data: Uint8ClampedArray; width: number; height: number }, x: number) => {
      let n = 0;
      for (let y = 0; y < img.height; y++) if (img.data[(y * img.width + x) * 4 + 3]! > 0) n++;
      return n;
    };
    expect(heightAt(logImg, 200)).toBeGreaterThan(heightAt(lin, 200));
  });
});

describe('통계 — 두 경로를 숫자로 견준다', () => {
  it('단색의 평균은 그 색 그대로', () => {
    const s = scopeStats(solid(16, 16, [10, 20, 30]), 16, 16);
    expect(s.pixels).toBe(256);
    expect(s.mean).toEqual([10, 20, 30]);
    expect(s.meanY).toBeCloseTo(0.299 * 10 + 0.587 * 20 + 0.114 * 30, 6);
  });

  it('차이는 채널별로 나오고 max 는 그중 제일 큰 절댓값', () => {
    const a = scopeStats(solid(4, 4, [100, 100, 100]), 4, 4);
    const b = scopeStats(solid(4, 4, [90, 105, 100]), 4, 4);
    const d = statsDelta(a, b);
    expect(d.dR).toBeCloseTo(10, 6);
    expect(d.dG).toBeCloseTo(-5, 6);
    expect(d.max).toBeCloseTo(10, 6);
  });
});

describe('격자 — 점만 찍고 끝내지 않는다', () => {
  function stub(): { ctx: Ctx2D; calls: string[]; texts: string[] } {
    const calls: string[] = [];
    const texts: string[] = [];
    const ctx = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      beginPath: () => calls.push('beginPath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      arc: () => calls.push('arc'),
      rect: () => calls.push('rect'),
      stroke: () => calls.push('stroke'),
      fillText: (t: string) => {
        calls.push('fillText');
        texts.push(t);
      },
      setLineDash: () => calls.push('setLineDash'),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      font: '',
    } as unknown as Ctx2D;
    return { ctx, calls, texts };
  }

  it('벡터스코프 격자에 원·6색 타깃 상자·라벨·스킨톤 라인이 다 있다', () => {
    const { ctx, calls, texts } = stub();
    drawVectorGraticule(ctx, 256);
    expect(calls.filter((c) => c === 'arc').length).toBeGreaterThanOrEqual(2); // 바깥 원 + 안쪽 원
    expect(calls.filter((c) => c === 'rect').length).toBe(6); // 6색 타깃
    expect(texts).toEqual(['R', 'Yl', 'G', 'Cy', 'B', 'Mg']);
    expect(calls.filter((c) => c === 'setLineDash').length).toBeGreaterThanOrEqual(2); // 스킨톤 파선
  });

  it('웨이브폼·히스토그램 격자도 눈금과 라벨을 그린다', () => {
    const w = stub();
    drawWaveformGraticule(w.ctx, WAVEFORM_COL_W);
    expect(w.texts).toContain('R');
    expect(w.texts).toContain('G');
    expect(w.texts).toContain('B');
    const h = stub();
    drawHistogramGraticule(h.ctx, 256, 160);
    expect(h.texts).toContain('0');
    expect(h.texts).toContain('255');
  });
});

describe('표본 크기', () => {
  it('9:16 은 256×455, 16:9 는 455×256 (넓이 예산을 지킨다)', () => {
    expect(scopeSampleSize(1080, 1920)).toEqual({ width: 256, height: 455 });
    expect(scopeSampleSize(1920, 1080)).toEqual({ width: 455, height: 256 });
  });
  it('예산보다 작은 캔버스는 그대로 둔다', () => {
    expect(scopeSampleSize(100, 100)).toEqual({ width: 100, height: 100 });
  });
  it('말이 안 되는 크기는 1×1', () => {
    expect(scopeSampleSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

// ── PBO 비동기 읽기 (가짜 GL) ──────────────────────────────────────────────

type FakeGl = ScopeGl & {
  log: string[];
  buffers: Map<object, Uint8Array>;
  signalAll(): void;
  syncs: { obj: object; signaled: boolean }[];
  readSync: boolean;
};

function fakeGl(W = 1080, H = 1920, fill = 128): FakeGl {
  const buffers = new Map<object, Uint8Array>();
  const syncs: { obj: object; signaled: boolean }[] = [];
  const log: string[] = [];
  let current: object | null = null;
  const gl = {
    drawingBufferWidth: W,
    drawingBufferHeight: H,
    log,
    buffers,
    syncs,
    readSync: false,
    TEXTURE_2D: 1, RGBA: 2, RGBA8: 3, UNSIGNED_BYTE: 4,
    TEXTURE_MIN_FILTER: 5, TEXTURE_MAG_FILTER: 6, NEAREST: 7,
    TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9, CLAMP_TO_EDGE: 10,
    FRAMEBUFFER: 11, READ_FRAMEBUFFER: 12, DRAW_FRAMEBUFFER: 13,
    COLOR_ATTACHMENT0: 14, COLOR_BUFFER_BIT: 15, FRAMEBUFFER_COMPLETE: 16,
    PIXEL_PACK_BUFFER: 17, STREAM_READ: 18,
    SYNC_GPU_COMMANDS_COMPLETE: 19, ALREADY_SIGNALED: 20, CONDITION_SATISFIED: 21,
    WAIT_FAILED: 22,
    createTexture: () => ({}) as WebGLTexture,
    deleteTexture: () => log.push('deleteTexture'),
    bindTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    createFramebuffer: () => ({}) as WebGLFramebuffer,
    deleteFramebuffer: () => log.push('deleteFramebuffer'),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 16,
    blitFramebuffer: () => log.push('blit'),
    createBuffer: () => ({}) as WebGLBuffer,
    deleteBuffer: () => log.push('deleteBuffer'),
    bindBuffer: (_t: number, b: WebGLBuffer | null) => {
      current = b as unknown as object | null;
    },
    bufferData: (_t: number, size: number) => {
      if (current) buffers.set(current, new Uint8Array(size as number));
    },
    getBufferSubData: (_t: number, _o: number, dst: ArrayBufferView) => {
      const src = current ? buffers.get(current) : undefined;
      if (src) (dst as Uint8Array).set(src.subarray(0, (dst as Uint8Array).length));
    },
    readPixels: () => {
      log.push('readPixels');
      // 실제 GPU 처럼 «나중에» 채워진다고 보고, PBO 를 지금 채워 둔다
      if (current) {
        const buf = buffers.get(current);
        if (buf) buf.fill(fill);
      }
    },
    fenceSync: () => {
      const obj = {};
      syncs.push({ obj, signaled: false });
      return obj as WebGLSync;
    },
    clientWaitSync: (s: WebGLSync) => {
      const e = syncs.find((x) => x.obj === (s as unknown as object));
      return e && e.signaled ? 20 : 0;
    },
    deleteSync: () => log.push('deleteSync'),
    flush: () => log.push('flush'),
    signalAll: () => {
      for (const s of syncs) s.signaled = true;
    },
  } as unknown as FakeGl;
  return gl;
}

describe('ScopeReader — PBO 비동기 읽기', () => {
  it('sample() 은 기다리지 않고, poll() 이 fence 가 떨어진 뒤에만 준다', () => {
    const gl = fakeGl();
    const r = new ScopeReader(gl);
    r.sample(100, true);
    expect(gl.log).toContain('readPixels');
    expect(r.pending).toBe(true);
    // 아직 GPU 가 안 끝났다 → null
    expect(r.poll()).toBeNull();
    gl.signalAll();
    const s = r.poll();
    expect(s).not.toBeNull();
    expect(s!.width).toBe(256);
    expect(s!.height).toBe(455);
    expect(s!.data.length).toBe(256 * 455 * 4);
    expect(s!.timeMs).toBe(100);
    expect(r.pending).toBe(false);
    r.dispose();
  });

  it('readPixels 는 «오프셋 0» 으로 부른다 — ArrayBuffer 를 주면 동기라 GPU 가 멈춘다', () => {
    const gl = fakeGl();
    const seen: unknown[] = [];
    const orig = gl.readPixels;
    (gl as unknown as { readPixels: (...a: unknown[]) => void }).readPixels = (...a: unknown[]) => {
      seen.push(a[6]);
      (orig as unknown as (...x: unknown[]) => void)(...a);
    };
    const r = new ScopeReader(gl);
    r.sample(0, true);
    expect(seen).toEqual([0]);
    r.dispose();
  });

  it('기본은 5프레임에 1회 — 매 프레임 읽지 않는다', () => {
    const gl = fakeGl();
    const r = new ScopeReader(gl, { slots: 4 });
    for (let i = 0; i < 20; i++) {
      r.sample(i, false);
      gl.signalAll();
      r.poll();
    }
    expect(gl.log.filter((x) => x === 'readPixels').length).toBe(4); // 0,5,10,15
    r.dispose();
  });

  it('force 면 주기를 건너뛴다 (정지 중에는 그린 프레임이 곧 바뀐 프레임)', () => {
    const gl = fakeGl();
    const r = new ScopeReader(gl);
    for (let i = 0; i < 4; i++) {
      r.sample(i, true);
      gl.signalAll();
      r.poll();
    }
    expect(gl.log.filter((x) => x === 'readPixels').length).toBe(4);
    r.dispose();
  });

  it('빈 슬롯이 없으면 읽기를 거른다 (큐가 쌓이지 않는다)', () => {
    const gl = fakeGl();
    const r = new ScopeReader(gl, { slots: 2 });
    r.sample(1, true);
    r.sample(2, true);
    r.sample(3, true); // 슬롯 2개가 다 물려 있다
    expect(gl.log.filter((x) => x === 'readPixels').length).toBe(2);
    r.dispose();
  });

  it('여럿이 동시에 익으면 가장 최근 것만 준다', () => {
    const gl = fakeGl();
    const r = new ScopeReader(gl, { slots: 2 });
    r.sample(10, true);
    r.sample(20, true);
    gl.signalAll();
    const s = r.poll();
    expect(s!.timeMs).toBe(20);
    r.dispose();
  });

  it('GL 이 터져도 예외를 밖으로 내지 않고 스스로 꺼진다', () => {
    const gl = fakeGl();
    (gl as unknown as { createFramebuffer: () => null }).createFramebuffer = () => null;
    const r = new ScopeReader(gl);
    expect(() => r.sample(0, true)).not.toThrow();
    expect(r.broken).toMatch(/프레임버퍼/);
    expect(r.poll()).toBeNull();
    r.dispose();
  });

  it('dispose 는 버퍼·FBO·텍스처를 다 지운다', () => {
    const gl = fakeGl();
    const r = new ScopeReader(gl, { slots: 2 });
    r.sample(0, true);
    r.dispose();
    expect(gl.log.filter((x) => x === 'deleteBuffer').length).toBe(2);
    expect(gl.log).toContain('deleteFramebuffer');
    expect(gl.log).toContain('deleteTexture');
  });
});

describe('scopeBus — 보는 사람이 없으면 아무 일도 안 한다', () => {
  beforeEach(() => scopeBus.reset());

  it('구독자가 없으면 wanted=false', () => {
    expect(scopeBus.wanted).toBe(false);
  });

  it('첫 구독에서 onWake 가 한 번 불린다 (정지 중에 패널을 열어도 한 장 그린다)', () => {
    let woke = 0;
    scopeBus.onWake = () => woke++;
    const off1 = scopeBus.subscribe(() => {});
    const off2 = scopeBus.subscribe(() => {});
    expect(woke).toBe(1);
    off1();
    off2();
  });

  it('publish 는 모든 구독자에게 가고 latest 에 남는다', () => {
    const got: number[] = [];
    const off = scopeBus.subscribe((s) => got.push(s.timeMs));
    scopeBus.publish({ data: new Uint8Array(4), width: 1, height: 1, timeMs: 42 });
    expect(got).toEqual([42]);
    expect(scopeBus.latest?.timeMs).toBe(42);
    off();
    expect(scopeBus.wanted).toBe(false);
  });

  it('구독자가 터져도 다음 구독자는 받는다 (재생이 안 멈춘다)', () => {
    let ok = 0;
    const o1 = scopeBus.subscribe(() => {
      throw new Error('boom');
    });
    const o2 = scopeBus.subscribe(() => ok++);
    expect(() =>
      scopeBus.publish({ data: new Uint8Array(4), width: 1, height: 1, timeMs: 0 }),
    ).not.toThrow();
    expect(ok).toBe(1);
    o1();
    o2();
  });
});

describe('워커 요청 처리 — 메인 스레드에서도 같은 결과', () => {
  it('요청한 종류만 만들고 통계도 같이 준다', () => {
    const px = colorBars100(64, 64);
    const { response } = handleScopeRequest({
      id: 7,
      buffer: px.buffer as ArrayBuffer,
      width: 64,
      height: 64,
      kinds: ['vectorscope', 'histogram'],
      timeMs: 123,
    });
    expect(response.id).toBe(7);
    expect(response.timeMs).toBe(123);
    expect(response.images.vectorscope).toBeTruthy();
    expect(response.images.histogram).toBeTruthy();
    expect(response.images.waveform).toBeUndefined();
    expect(response.stats.pixels).toBe(64 * 64);
    expect(response.computeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('FpsMeter', () => {
  it('정지 중에는 0', () => {
    const m = new FpsMeter();
    for (let i = 0; i < 20; i++) m.push(i * 16.7, false);
    expect(m.fps).toBe(0);
  });
  it('16.7ms 간격이면 60fps 근처', () => {
    const m = new FpsMeter();
    for (let i = 0; i < 60; i++) m.push(i * 16.7, true);
    expect(m.fps).toBeGreaterThan(55);
    expect(m.fps).toBeLessThan(65);
  });
});
