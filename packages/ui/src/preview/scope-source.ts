// F6 실시간 스코프의 «픽셀 공급» — 합성 결과를 작게 줄여 **비동기로** 읽어 온다.
//
// 세 가지를 지킨다 (안 지키면 재생이 느려진다):
//  1. `gl.readPixels` 를 동기로 부르면 GPU 가 멈춘다 → PIXEL_PACK_BUFFER(PBO)에 걸고
//     `fenceSync` 가 떨어진 **다음 프레임**에 `getBufferSubData` 로 꺼낸다. WebGL2 라서 된다.
//  2. 매 프레임 읽지 않는다 — 기본 5프레임에 1회(30fps 재생이면 6fps).
//  3. 축소는 GPU 가 한다 — `blitFramebuffer` 한 번으로 1080×1920 → 256×455.
//     보간은 **NEAREST**: 평균을 내면 원본에 없던 중간색이 생겨 벡터스코프 점이 번진다.
//     스코프는 「있는 픽셀의 분포」를 봐야 하므로 솎아내기가 맞다.

/** 스코프에 쓸 픽셀 한 장 (RGBA, 아래→위 행 순서 — 세 스코프 모두 행 순서를 안 쓴다). */
export type ScopeSample = {
  data: Uint8Array;
  width: number;
  height: number;
  /** 이 픽셀이 어느 시각의 화면인가 */
  timeMs: number;
};

/** 기본 표본 크기 — 9:16 에서 256×455 ≈ 11.6만 픽셀. */
export const SCOPE_PIXEL_BUDGET = 256 * 455;
export const SCOPE_SAMPLE_EVERY = 5;

/**
 * 캔버스 크기 → 표본 크기. 넓이를 예산에 맞추고 가로세로비를 지킨다.
 * 1080×1920 → 256×455, 1920×1080 → 455×256.
 */
export function scopeSampleSize(
  canvasW: number,
  canvasH: number,
  budget = SCOPE_PIXEL_BUDGET,
): { width: number; height: number } {
  if (!(canvasW > 0) || !(canvasH > 0)) return { width: 1, height: 1 };
  const area = canvasW * canvasH;
  const scale = area > budget ? Math.sqrt(budget / area) : 1;
  return {
    width: Math.max(1, Math.round(canvasW * scale)),
    height: Math.max(1, Math.round(canvasH * scale)),
  };
}

/** ScopeReader 가 쓰는 WebGL2 표면만 추린 것 — 테스트에서 가짜로 바꿔 끼운다. */
export type ScopeGl = Pick<
  WebGL2RenderingContext,
  | 'createTexture' | 'deleteTexture' | 'bindTexture' | 'texImage2D' | 'texParameteri'
  | 'createFramebuffer' | 'deleteFramebuffer' | 'bindFramebuffer' | 'framebufferTexture2D'
  | 'checkFramebufferStatus' | 'blitFramebuffer'
  | 'createBuffer' | 'deleteBuffer' | 'bindBuffer' | 'bufferData' | 'getBufferSubData'
  | 'readPixels' | 'fenceSync' | 'clientWaitSync' | 'deleteSync' | 'flush'
> & {
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  TEXTURE_2D: number; RGBA: number; RGBA8: number; UNSIGNED_BYTE: number;
  TEXTURE_MIN_FILTER: number; TEXTURE_MAG_FILTER: number; NEAREST: number;
  TEXTURE_WRAP_S: number; TEXTURE_WRAP_T: number; CLAMP_TO_EDGE: number;
  FRAMEBUFFER: number; READ_FRAMEBUFFER: number; DRAW_FRAMEBUFFER: number;
  COLOR_ATTACHMENT0: number; COLOR_BUFFER_BIT: number; FRAMEBUFFER_COMPLETE: number;
  PIXEL_PACK_BUFFER: number; STREAM_READ: number;
  SYNC_GPU_COMMANDS_COMPLETE: number; ALREADY_SIGNALED: number; CONDITION_SATISFIED: number;
  WAIT_FAILED: number;
};

type Slot = {
  pbo: WebGLBuffer;
  sync: WebGLSync | null;
  timeMs: number;
  /** fence 가 몇 프레임째 안 떨어졌나 — 너무 오래면 버린다(컨텍스트가 이상해진 경우). */
  age: number;
};

const MAX_SLOT_AGE = 60;

export type ScopeReaderOpts = {
  /** 몇 프레임에 한 번 읽을지. 기본 5 */
  every?: number;
  /** 표본 픽셀 예산. 기본 256×455 */
  budget?: number;
  /** PBO 슬롯 수 (2 = 더블 버퍼). */
  slots?: number;
};

/**
 * 합성 결과를 축소해 비동기로 읽는 읽개.
 *
 * **오류가 나면 스스로 꺼진다**(`broken`). 스코프 때문에 미리보기가 죽는 일은 없어야 한다.
 */
export class ScopeReader {
  private readonly gl: ScopeGl;
  private readonly every: number;
  private readonly budget: number;
  private readonly slots: Slot[] = [];
  private tex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private size = { width: 0, height: 0 };
  private frame = 0;
  private disposed = false;
  private failed: string | null = null;

  constructor(gl: ScopeGl, opts: ScopeReaderOpts = {}) {
    this.gl = gl;
    this.every = Math.max(1, Math.round(opts.every ?? SCOPE_SAMPLE_EVERY));
    this.budget = opts.budget ?? SCOPE_PIXEL_BUDGET;
    const n = Math.max(1, Math.min(4, opts.slots ?? 2));
    try {
      for (let i = 0; i < n; i++) {
        const pbo = gl.createBuffer();
        if (!pbo) throw new Error('PBO 생성 실패');
        this.slots.push({ pbo, sync: null, timeMs: 0, age: 0 });
      }
    } catch (e) {
      this.failed = e instanceof Error ? e.message : String(e);
    }
  }

  /** 꺼진 이유 (정상이면 null). UI 배지에 그대로 쓴다. */
  get broken(): string | null {
    return this.failed;
  }

  get sampleSize(): { width: number; height: number } {
    return { ...this.size };
  }

  /** 아직 GPU 를 기다리는 읽기가 있나. */
  get pending(): boolean {
    return this.slots.some((s) => s.sync !== null);
  }

  /**
   * **합성 직후**에 부른다 — 이번 화면을 읽어 달라고 걸어 두기만 하고 기다리지 않는다.
   * `force` 면 주기를 무시한다(정지 중에는 그린 프레임이 곧 «바뀐 프레임»이라 매번 읽는다).
   */
  sample(timeMs: number, force = false): void {
    if (this.disposed || this.failed) return;
    try {
      if (force || this.frame % this.every === 0) this.request(timeMs);
      this.frame++;
    } catch (e) {
      this.failed = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * **매 rAF** 에 부른다 — 익은 표본이 있으면 준다(없으면 null).
   * 그리기와 떼어 놨기 때문에 정지 중에도(다시 그리지 않아도) 결과가 도착한다.
   */
  poll(): ScopeSample | null {
    if (this.disposed || this.failed) return null;
    try {
      return this.collect();
    } catch (e) {
      this.failed = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    try {
      for (const s of this.slots) {
        if (s.sync) gl.deleteSync(s.sync);
        gl.deleteBuffer(s.pbo);
      }
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.tex) gl.deleteTexture(this.tex);
    } catch {
      // 컨텍스트가 이미 날아갔으면 할 게 없다
    }
    this.slots.length = 0;
    this.fbo = null;
    this.tex = null;
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  /** 다 익은 PBO 를 꺼낸다. 여럿이면 **가장 최근 것**만 쓴다(스코프는 밀린 프레임이 쓸모없다). */
  private collect(): ScopeSample | null {
    const gl = this.gl;
    let best: ScopeSample | null = null;
    const { width, height } = this.size;
    for (const s of this.slots) {
      if (!s.sync) continue;
      const st = gl.clientWaitSync(s.sync, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
        const data = new Uint8Array(width * height * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(s.sync);
        s.sync = null;
        s.age = 0;
        if (!best || s.timeMs >= best.timeMs) best = { data, width, height, timeMs: s.timeMs };
      } else if (st === gl.WAIT_FAILED || ++s.age > MAX_SLOT_AGE) {
        gl.deleteSync(s.sync);
        s.sync = null;
        s.age = 0;
      }
    }
    return best;
  }

  /** 축소 blit → PBO 로 readPixels → fence. 빈 슬롯이 없으면 이번 차례는 거른다. */
  private request(timeMs: number): void {
    const gl = this.gl;
    const slot = this.slots.find((s) => s.sync === null);
    if (!slot) return;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    if (!(W > 0) || !(H > 0)) return;
    const want = scopeSampleSize(W, H, this.budget);
    if (want.width !== this.size.width || want.height !== this.size.height) {
      this.allocate(want.width, want.height);
    }
    const { width, height } = this.size;
    if (!this.fbo || width <= 0 || height <= 0) return;

    // 기본 프레임버퍼(합성 결과) → 작은 FBO. NEAREST 로 솎아낸다.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    // 작은 FBO → PBO (offset 을 주면 «비동기» 읽기다 — ArrayBuffer 를 주면 동기라 GPU 가 멈춘다)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    slot.timeMs = timeMs;
    slot.age = 0;
    // fence 를 걸었으면 밀어 넣어야 다음 프레임에 실제로 떨어진다
    gl.flush();
  }

  private allocate(width: number, height: number): void {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.tex) gl.deleteTexture(this.tex);
    this.fbo = null;
    this.tex = null;
    this.size = { width, height };

    const tex = gl.createTexture();
    if (!tex) throw new Error('스코프 텍스처 생성 실패');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('스코프 프레임버퍼 생성 실패');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw new Error(`스코프 프레임버퍼 불완전 (0x${status.toString(16)})`);
    }

    const bytes = width * height * 4;
    for (const s of this.slots) {
      if (s.sync) {
        gl.deleteSync(s.sync);
        s.sync = null;
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.tex = tex;
    this.fbo = fbo;
  }
}

// ── 미리보기 ↔ 스코프 패널을 잇는 통로 ──────────────────────────────────────
//
// FastPreview 는 스코프 패널을 몰라도 되고, 패널은 미리보기 수명을 몰라도 된다.
// **듣는 사람이 없으면 미리보기는 읽기를 아예 안 한다** (`wanted === false`) — 성능 규칙 1번.

type Listener = (s: ScopeSample) => void;

class ScopeBus {
  private readonly listeners = new Set<Listener>();
  private last: ScopeSample | null = null;
  /**
   * 첫 청취자가 붙었을 때 미리보기를 한 번 다시 그리게 하는 고리 (FastPreview 가 채운다).
   * 정지 중에 패널을 열면 그릴 일이 없어서 스코프가 영영 안 뜨는 것을 막는다.
   */
  onWake: (() => void) | null = null;

  /** 누가 보고 있나. false 면 미리보기는 PBO 읽기를 건너뛴다. */
  get wanted(): boolean {
    return this.listeners.size > 0;
  }

  /** 마지막으로 흘러간 표본 (패널이 늦게 붙었을 때 바로 그릴 수 있게). */
  get latest(): ScopeSample | null {
    return this.last;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.onWake?.();
    return () => {
      this.listeners.delete(fn);
    };
  }

  publish(sample: ScopeSample): void {
    this.last = sample;
    for (const fn of this.listeners) {
      try {
        fn(sample);
      } catch {
        // 듣는 쪽이 터져도 재생은 계속 간다
      }
    }
  }

  /** 테스트용 초기화. */
  reset(): void {
    this.listeners.clear();
    this.last = null;
    this.onWake = null;
  }
}

export const scopeBus: ScopeBus = new ScopeBus();

/**
 * 재생 루프의 실측 fps.
 *
 * 스코프를 켜서 **10% 이상 떨어지면 실패**라는 기준이 있는데, 개발자 도구를 열지 않고도
 * 판정할 수 있어야 한다. 그래서 미리보기가 매 rAF 마다 여기에 찍고 패널이 그 숫자를 보여 준다.
 * 정지 중에는 그리지 않으므로 0 을 낸다(그때의 rAF 속도는 아무 의미가 없다).
 */
export class FpsMeter {
  private lastMs = 0;
  private ema = 0;
  private samples = 0;

  /** 매 프레임. 재생 중이 아니면 계측을 접는다. */
  push(nowMs: number, playing: boolean): void {
    if (!playing) {
      this.lastMs = 0;
      this.ema = 0;
      this.samples = 0;
      return;
    }
    if (this.lastMs > 0) {
      const dt = nowMs - this.lastMs;
      if (dt > 0 && dt < 1000) {
        const inst = 1000 / dt;
        this.ema = this.samples === 0 ? inst : this.ema * 0.9 + inst * 0.1;
        this.samples++;
      }
    }
    this.lastMs = nowMs;
  }

  /** 재생 중이 아니거나 아직 표본이 모자라면 0. */
  get fps(): number {
    return this.samples >= 5 ? this.ema : 0;
  }
}

export const previewFps: FpsMeter = new FpsMeter();
