// F14 — WebCodecs 프레임 공급기 (메인 스레드 쪽).
//
// **왜 있나.** `<video>` 의 `currentTime = t` 시크는 키프레임까지 되감고 거기서부터 다시
// 디코딩하므로 한 프레임에 수십~수백 ms 가 걸린다. 타임라인을 끌면 그래서 끊긴다.
// `VideoDecoder`(WebCodecs)는 디코드된 프레임을 직접 받아 큐에 쌓을 수 있어서
// 스크럽·역방향·프레임 이동이 즉시 반응한다.
//
// **컨테이너 분해(demux)** 는 브라우저에 없으므로 `mediabunny` 를 쓴다.
// (mp4box.js 와 실측 비교: mp4box 는 webm 을 아예 못 연다 — 스티커가 webm 이라 탈락.)
//
// **분해·디코드는 워커(`webcodecs.worker.ts`)에서 돈다.** 편집기는 화면 주기마다 WebGL 합성과
// React 타임라인을 메인 스레드에서 그리는데, 디코드 루프까지 메인에 있으면 그 틈에 못 끼어들어
// 초당 한 프레임도 못 냈다(실측). 워커가 `VideoFrame` 을 복사 없이(transfer) 넘겨주고,
// 여기서는 링버퍼(`FrameRing`)에 넣고 꺼내고 닫기만 한다. 워커를 못 만드는 환경이면
// 같은 루프를 메인 스레드에서 도는 `MediabunnySource` 로 물러난다.
//
// **VideoFrame 누수.** `VideoFrame` 은 명시적 `close()` 없이는 GPU 메모리가 안 풀리고
// 몇십 장 쌓이면 브라우저가 디코더를 멈춘다. 링버퍼에서 밀려나는 즉시 닫는다.
import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  UrlSource,
  VideoSampleSink,
  type InputVideoTrack,
} from 'mediabunny';
import { FrameRing } from './cache.js';
import { iterateWithStallGuard } from './pool.js';
import type { WorkerIn, WorkerOut } from './webcodecs.worker.js';

/** 이 브라우저가 WebCodecs 를 갖고 있는가. */
export const webCodecsSupported: boolean =
  typeof globalThis !== 'undefined' && 'VideoDecoder' in globalThis;

export type FrameSourceStats = {
  queued: number;
  decoded: number;
  closed: number;
  fills: number;
  aborts: number;
  error: string | null;
  /** 워커에서 도는가 (false = 메인 스레드 폴백) */
  worker: boolean;
  /** 보낸 힌트 수 (워커 경로만) */
  hints?: number;
};

export type FrameSource = {
  /** 소스 시각(ms)의 프레임. **큐에 있을 때만** 즉시 돌려준다(동기). 없으면 null. */
  peek(srcMs: number): VideoFrame | null;
  /** `peek` 가 돌려줄 프레임의 실제 시각(ms). 같은 값이면 같은 그림 — 텍스처 업로드를 건너뛴다. */
  peekTs(srcMs: number): number | null;
  /**
   * 맞는 프레임이 아직 없을 때 **대신 보여줄** 가장 가까운 프레임 (오차 무시).
   * 이게 없으면 미리보기가 한 프레임 까맣게 깜빡인다 — 합성기는 매 프레임 화면을 지운다.
   */
  peekNearest(srcMs: number): { frame: VideoFrame; tsMs: number } | null;
  /** 지정 소스 시각(ms)의 프레임. 큐에 있으면 즉시, 없으면 디코드한다. */
  frameAt(srcMs: number): Promise<VideoFrame | null>;
  /** 재생 방향·속도를 알려 주면 미리 디코드해 둔다. */
  hint(srcMs: number, direction: 1 | -1, rate: number): void;
  /** 프레임 간격(ms). 소스에서 읽은 실제 값. */
  readonly frameIntervalMs: number;
  /** 디버그·테스트용 계수 (fills/aborts/error 는 디코드 루프가 왜 멈췄는지 볼 때 쓴다) */
  stats(): FrameSourceStats;
  close(): void;
};

export type WebCodecsSourceOptions = {
  /** 앞으로 미리 디코드해 둘 프레임 수 (기본 60) */
  lookahead?: number;
  /** 새 프레임이 큐에 들어왔을 때 부른다 (정지 중에 다시 그릴 계기) */
  onFrameReady?: () => void;
  /** 워커를 쓸지 (기본 true). false 면 메인 스레드에서 돈다 — 비교 측정용. */
  worker?: boolean;
};

/** 같은 프레임으로 쳐 주는 시각 오차 — 프레임 간격의 절반. */
const TOLERANCE_RATIO = 0.5;
/** 프레임 간격을 못 읽었을 때의 기본값 (30fps). */
const DEFAULT_FRAME_MS = 1000 / 30;
/** 디코드 루프가 안 끝나도 이만큼 지나면 입력을 닫는다 (네트워크가 멈춘 경우). */
const DISPOSE_GRACE_MS = 5000;
/** 샘플이 이만큼 안 오면 그 채우기를 버린다 — 워커(`webcodecs.worker.ts`)와 같은 값 */
const FILL_STALL_MS = 8000;

/**
 * `url` 의 영상을 WebCodecs 로 여는 프레임 공급기를 만든다.
 * 열 수 없거나(컨테이너 해석 실패) 디코드할 수 없으면(코덱 미지원) **null** —
 * 부르는 쪽은 `<video>` 경로로 물러난다.
 */
export async function createWebCodecsSource(
  url: string,
  opts: WebCodecsSourceOptions = {},
): Promise<FrameSource | null> {
  if (!webCodecsSupported) return null;
  if (opts.worker !== false && typeof Worker !== 'undefined') {
    try {
      return await WorkerFrameSource.open(url, opts);
    } catch {
      /* 워커를 못 띄우는 환경 — 메인 스레드로 물러난다 */
    }
  }
  return MediabunnySource.open(url, opts);
}

// ── 공통: 링버퍼 + 대기자 (메인 스레드) ──────────────────────────────────

abstract class RingSource implements FrameSource {
  protected frameMs = DEFAULT_FRAME_MS;
  protected durationMs = Infinity;
  protected readonly ring: FrameRing<VideoFrame>;
  protected readonly lookahead: number;
  protected readonly onFrameReady?: () => void;
  protected direction: 1 | -1 = 1;
  protected pumping = false;
  protected decoded = 0;
  protected disposed = false;
  private waiters: (() => void)[] = [];

  constructor(opts: WebCodecsSourceOptions) {
    this.lookahead = Math.max(4, Math.floor(opts.lookahead ?? 60));
    if (opts.onFrameReady) this.onFrameReady = opts.onFrameReady;
    this.ring = new FrameRing<VideoFrame>(this.lookahead);
  }

  get frameIntervalMs(): number {
    return this.frameMs;
  }

  protected get tolMs(): number {
    return this.frameMs * TOLERANCE_RATIO;
  }

  /**
   * 파일 끝을 넘겨 달라는 요청을 마지막 프레임으로 당긴다.
   * `<video>` 는 끝을 넘겨 시크하면 마지막 프레임을 보여주는데 디코더는 «없음» 을 준다 —
   * 클립 길이 반올림 때문에 한두 ms 넘어가는 일이 실제로 생긴다.
   */
  protected clamp(ms: number): number {
    const t = Math.max(0, ms);
    if (!Number.isFinite(this.durationMs)) return t;
    return Math.min(t, Math.max(0, this.durationMs - this.frameMs * 0.5));
  }

  peek(srcMs: number): VideoFrame | null {
    if (this.disposed) return null;
    return this.ring.get(this.clamp(srcMs), this.tolMs);
  }

  peekTs(srcMs: number): number | null {
    if (this.disposed) return null;
    return this.ring.nearestKey(this.clamp(srcMs), this.tolMs);
  }

  peekNearest(srcMs: number): { frame: VideoFrame; tsMs: number } | null {
    if (this.disposed) return null;
    const ms = this.clamp(srcMs);
    const tsMs = this.ring.nearestKey(ms, Infinity);
    if (tsMs === null) return null;
    const frame = this.ring.get(ms, Infinity);
    return frame ? { frame, tsMs } : null;
  }

  abstract hint(srcMs: number, direction: 1 | -1, rate: number): void;
  abstract stats(): FrameSourceStats;
  abstract close(): void;

  async frameAt(srcMs: number): Promise<VideoFrame | null> {
    if (this.disposed) return null;
    const hit = this.peek(srcMs);
    if (hit) return hit;
    this.hint(srcMs, this.direction, 1);
    // 큐에 목표 프레임이 들어올 때까지 기다린다 (디코드 루프가 깨워 준다)
    for (let i = 0; i < 200 && !this.disposed; i++) {
      await this.nextPush();
      const f = this.peek(srcMs);
      if (f) return f;
      if (!this.pumping) break; // 루프가 끝났는데도 없으면 그 시각에는 프레임이 없다
    }
    return this.peek(srcMs);
  }

  /** 디코드된 프레임 한 장을 링에 넣는다 (워커에서 왔든 메인에서 만들었든). */
  protected push(tsMs: number, frame: VideoFrame): void {
    if (this.disposed) {
      frame.close();
      return;
    }
    this.decoded++;
    this.ring.set(tsMs, frame);
    this.wake();
    this.onFrameReady?.();
  }

  private nextPush(): Promise<void> {
    return new Promise<void>((resolve) => {
      // 디코드가 아예 안 도는 상황에서 영원히 매달리지 않게 한다
      const timer = setTimeout(resolve, 250);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  protected wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

// ── 워커 경로 (기본) ───────────────────────────────────────────────────────

class WorkerFrameSource extends RingSource {
  private readonly worker: Worker;
  private hintSeq = 0;
  private fills = 0;
  private aborts = 0;
  private lastError: string | null = null;

  static open(url: string, opts: WebCodecsSourceOptions): Promise<FrameSource | null> {
    const worker = new Worker(new URL('./webcodecs.worker.ts', import.meta.url), { type: 'module' });
    return new Promise<FrameSource | null>((resolve, reject) => {
      const src = new WorkerFrameSource(worker, opts);
      const onFirst = (ev: MessageEvent<WorkerOut>): void => {
        const m = ev.data;
        if (m.type === 'opened') {
          worker.removeEventListener('message', onFirst);
          src.frameMs = m.frameMs;
          src.durationMs = m.durationMs;
          resolve(src);
        } else if (m.type === 'failed') {
          worker.removeEventListener('message', onFirst);
          worker.terminate();
          resolve(null);
        }
      };
      worker.addEventListener('message', onFirst);
      worker.addEventListener('error', (e) => {
        worker.terminate();
        reject(e);
      }, { once: true });
      src.post({ type: 'open', url, lookahead: src.lookahead });
    });
  }

  private constructor(worker: Worker, opts: WebCodecsSourceOptions) {
    super(opts);
    this.worker = worker;
    worker.addEventListener('message', (ev: MessageEvent<WorkerOut>) => this.onMessage(ev.data));
  }

  private post(msg: WorkerIn): void {
    this.worker.postMessage(msg);
  }

  private onMessage(m: WorkerOut): void {
    switch (m.type) {
      case 'frame':
        this.push(m.tsMs, m.frame);
        break;
      case 'idle':
        // 옛 힌트에 대한 idle 은 무시한다 — 새 힌트를 보낸 직후에 도착하면 «끝났다» 로 오해한다
        if (m.seq === this.hintSeq) {
          this.pumping = false;
          this.wake();
        }
        break;
      case 'stats':
        this.fills = m.fills;
        this.aborts = m.aborts;
        this.lastError = m.error;
        break;
      case 'closed':
        this.worker.terminate();
        break;
      default:
        break;
    }
  }

  hint(srcMs: number, direction: 1 | -1, _rate: number): void {
    if (this.disposed) return;
    const ms = this.clamp(srcMs);
    // 목표 프레임 자체(오차 안)는 «지나온 것» 으로 치지 않는다 — 안 그러면 창이 꽉 찼을 때
    // 정작 보여줄 프레임을 먼저 버린다(임의 점프 50회 중 1회 실패의 원인이었다).
    this.ring.focus(ms, direction, this.tolMs);
    this.direction = direction;
    this.pumping = true; // 워커가 창을 다 채우면 idle(seq) 로 알려 준다
    this.post({ type: 'hint', ms, direction, seq: ++this.hintSeq });
  }

  stats(): FrameSourceStats {
    return {
      queued: this.ring.size, decoded: this.decoded, closed: this.ring.closed,
      fills: this.fills, aborts: this.aborts, error: this.lastError, worker: true, hints: this.hintSeq,
    };
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ring.clear();
    this.wake();
    this.post({ type: 'close' });
    // 워커가 스스로 정리하고 'closed' 를 보내면 그때 죽인다. 안 오면 유예 뒤 강제로.
    setTimeout(() => this.worker.terminate(), DISPOSE_GRACE_MS + 1000);
  }
}

// ── 메인 스레드 폴백 (워커를 못 쓰는 환경) ───────────────────────────────────

class MediabunnySource extends RingSource {
  private readonly input: Input;
  private readonly track: InputVideoTrack;
  private readonly sink: VideoSampleSink;
  private readonly packets: EncodedPacketSink;
  private gen = 0;
  private pumpDone: Promise<void> = Promise.resolve();
  private targetMs = 0;
  private filledLo = Infinity;
  private filledHi = -Infinity;
  private planLo = Infinity;
  private planHi = -Infinity;
  private fills = 0;
  private aborts = 0;
  private lastError: string | null = null;

  static async open(url: string, opts: WebCodecsSourceOptions): Promise<FrameSource | null> {
    let input: Input | null = null;
    try {
      input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('비디오 트랙 없음');
      // 회전 메타데이터가 붙은 원본은 넘긴다. 생 VideoFrame 에는 회전이 반영되지 않는다.
      if (track.rotation !== 0) throw new Error(`회전 ${track.rotation}° 는 미지원`);
      if (!(await track.canDecode())) throw new Error(`디코드 불가 코덱: ${track.codec ?? '알 수 없음'}`);
      const src = new MediabunnySource(input, track, opts);
      await src.measure();
      return src;
    } catch {
      input?.dispose();
      return null;
    }
  }

  private constructor(input: Input, track: InputVideoTrack, opts: WebCodecsSourceOptions) {
    super(opts);
    this.input = input;
    this.track = track;
    this.sink = new VideoSampleSink(track, { optimizeForLatency: true });
    this.packets = new EncodedPacketSink(track);
  }

  private async measure(): Promise<void> {
    try {
      const stats = await this.track.computePacketStats(60);
      if (stats.averagePacketRate > 0) this.frameMs = 1000 / stats.averagePacketRate;
    } catch {
      /* 기본값 유지 */
    }
    try {
      const sec = await this.track.getDurationFromMetadata();
      if (sec !== null && sec > 0) this.durationMs = sec * 1000;
    } catch {
      /* 길이를 모르면 클램프를 안 한다 */
    }
  }

  private get spanMs(): number {
    return (this.lookahead - 2) * this.frameMs;
  }

  hint(srcMs: number, direction: 1 | -1, _rate: number): void {
    if (this.disposed) return;
    const ms = this.clamp(srcMs);
    this.ring.focus(ms, direction, this.tolMs);
    const tol = this.tolMs;
    const sameDir = direction === this.direction;
    this.targetMs = ms;
    const inPlan = sameDir && ms >= this.planLo - tol && ms <= this.planHi + tol;
    const covered = sameDir && ms >= this.filledLo - tol && ms <= this.filledHi + tol;
    if ((inPlan || covered) && this.pumping) return;
    if (covered) {
      const half = this.spanMs * 0.5;
      const enough = direction > 0
        ? this.filledHi + tol >= Math.min(ms + half, this.clamp(Infinity))
        : this.filledLo - tol <= Math.max(0, ms - half);
      if (enough) return;
    } else {
      this.filledLo = Infinity;
      this.filledHi = -Infinity;
    }
    this.direction = direction;
    this.gen++;
    if (!this.pumping) this.pumpDone = this.pump();
  }

  stats(): FrameSourceStats {
    return {
      queued: this.ring.size, decoded: this.decoded, closed: this.ring.closed,
      fills: this.fills, aborts: this.aborts, error: this.lastError, worker: false,
    };
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gen++;
    this.ring.clear();
    this.wake();
    // 디코드 루프가 스스로 빠져나온 **뒤에** 입력을 닫는다 — 도는 중에 닫으면 디코더가
    // 뒤늦게 뱉은 VideoSample 을 아무도 안 닫는다(mediabunny 콘솔 경고).
    let done = false;
    const dispose = (): void => {
      if (done) return;
      done = true;
      this.input.dispose();
    };
    void this.pumpDone.then(dispose, dispose);
    setTimeout(dispose, DISPOSE_GRACE_MS);
  }

  /** 워커 쪽(`webcodecs.worker.ts` pump)과 같은 논리 — 설명은 그쪽에. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed) {
        const gen = this.gen;
        const target = this.targetMs;
        const dir = this.direction;
        const tol = this.tolMs;
        let aborted = false;
        if (dir > 0) {
          const cont = this.filledHi > -Infinity && target <= this.filledHi + tol && target >= this.filledLo - tol;
          const lo = cont ? this.filledHi + this.frameMs * 0.5 : target;
          const hi = target + this.spanMs;
          this.planLo = cont ? this.filledLo : target;
          this.planHi = hi;
          if (hi > lo) {
            const r = await this.fill(lo, hi + this.frameMs * 0.5, gen);
            aborted = r.aborted;
            if (!aborted) {
              this.filledHi = hi;
              if (!cont) this.filledLo = target;
            }
          }
        } else {
          const cont = this.filledLo < Infinity && target >= this.filledLo - tol && target <= this.filledHi + tol;
          let hiMs = cont ? this.filledLo : target;
          let first = !cont;
          const loBound = Math.max(0, target - this.spanMs);
          this.planHi = cont ? this.filledHi : target;
          this.planLo = loBound;
          if (!cont) this.filledHi = target;
          while (!aborted && hiMs > loBound && hiMs > 0) {
            const probeSec = (first ? hiMs : hiMs - this.frameMs * 0.5) / 1000;
            let lo = (await this.keyTimeSec(probeSec)) * 1000;
            if (lo >= hiMs) lo = Math.max(0, hiMs - this.frameMs);
            const r = await this.fill(lo, first ? hiMs + this.frameMs * 0.5 : hiMs, gen);
            aborted = r.aborted;
            if (aborted) break;
            this.filledLo = lo;
            first = false;
            if (lo <= 0) break;
            hiMs = lo;
          }
        }
        if (!aborted && gen === this.gen && target === this.targetMs) return;
      }
    } catch (e) {
      this.lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    } finally {
      this.pumping = false;
      this.wake();
    }
  }

  /** 워커 쪽 fill 과 같은 규칙 — 멈춤 감시 포함 (`iterateWithStallGuard`). */
  private async fill(loMs: number, hiMs: number, gen: number): Promise<{ aborted: boolean; count: number }> {
    if (!(hiMs > loMs)) return { aborted: false, count: 0 };
    this.fills++;
    const r = await iterateWithStallGuard(this.sink.samples(loMs / 1000, hiMs / 1000), {
      stallMs: FILL_STALL_MS,
      alive: () => !this.disposed && gen === this.gen,
      onItem: (sample) => {
        const tsMs = sample.timestamp * 1000;
        const frame = sample.toVideoFrame();
        sample.close();
        this.push(tsMs, frame);
      },
      onStall: () => {
        this.gen++;
        this.lastError = `채우기 멈춤 ${FILL_STALL_MS}ms (${Math.round(loMs)}~${Math.round(hiMs)}ms)`;
      },
    });
    if (r.aborted) this.aborts++;
    return { aborted: r.aborted, count: r.count };
  }

  private async keyTimeSec(sec: number): Promise<number> {
    try {
      const key = await this.packets.getKeyPacket(Math.max(0, sec), { metadataOnly: true });
      return key ? key.timestamp : 0;
    } catch {
      return 0;
    }
  }
}
