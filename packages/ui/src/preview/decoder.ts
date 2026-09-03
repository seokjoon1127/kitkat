// 프리뷰 v2 — 프레임 공급기 (DOM). 순수 로직은 cache.ts / pool.ts 에 있다.
//
// **3단 폴백** (F14):
//  1. **WebCodecs** (`webcodecs.ts`, mediabunny 로 컨테이너 분해) — 정지·스크럽 중.
//     디코드해 둔 `VideoFrame` 을 링버퍼에서 바로 꺼내므로 시크 비용이 없다.
//  2. **`<video>` + `requestVideoFrameCallback`** — 재생 중. 소리가 이 엘리먼트에서 나므로
//     재생은 계속 이 경로다(WebCodecs 는 영상만 준다).
//  3. **`<video>` 시크 + `createImageBitmap`** — 1번이 안 되는 파일(코덱 미지원·회전 메타데이터
//     ·컨테이너 해석 실패)과 1번이 아직 아무 프레임도 못 낸 «시동 구간».
//
// 1번을 끄고 3번만 쓰게 하려면 주소에 `?nowebcodecs=1` 을 붙이거나
// `localStorage.kitkatWebCodecs = 'off'` 로 둔다.
import { LruCache, frameCacheKey, quantizeMs } from './cache.js';
import { Semaphore, assignSlot, makeSlots, type PoolSlot } from './pool.js';
import { createWebCodecsSource, webCodecsSupported, type FrameSource } from './webcodecs.js';

export type FrameRequest = {
  /** 엘리먼트 풀 배정 단위 — 클립 id */
  key: string;
  src: string;
  /** 소스 파일 안에서의 시각 ms */
  srcMs: number;
  /** 프레임 간격 ms (캐시 키 양자화 단위) */
  frameIntervalMs: number;
  playing: boolean;
  /** 재생 배속 (0.0625..16 로 클램프) */
  rate: number;
  muted: boolean;
  volume: number;
};

export type FrameResult = {
  /** 텍스처로 올릴 것. 아직 아무것도 없으면 null */
  image: HTMLVideoElement | ImageBitmap | VideoFrame | null;
  /** 같은 값이면 지난 프레임과 같은 그림 — 텍스처 업로드를 건너뛸 수 있다 */
  seq: number;
  /** 요청한 시각의 프레임을 실제로 보여주고 있는가 (false = 임시로 이웃 프레임) */
  exact: boolean;
};

type VideoSlot = {
  el: HTMLVideoElement;
  src: string | null;
  seq: number;
  rvfcHandle: number | null;
};

const MIN_RATE = 0.0625;
const MAX_RATE = 16;

/** WebCodecs 경로를 쓸 소스 하나의 상태. */
type WcEntry = {
  source: FrameSource | null;
  /** 여는 중 (중복 생성 방지) */
  opening: boolean;
  /** 못 여는 파일 — 다시 시도하지 않는다 */
  failed: boolean;
  /** 직전 요청 시각 — 진행 방향 판정용 */
  lastMs: number;
  direction: 1 | -1;
  /** 열리자마자 이 시각부터 한 창을 채워 둔다 (prewarm) */
  warmMs?: number;
  /** LRU (소스 개수를 묶는다) */
  lastUsed: number;
};

/**
 * WebCodecs 경로를 쓸지. 끄는 법:
 *  - 주소에 `?nowebcodecs=1`
 *  - `localStorage.kitkatWebCodecs = 'off'`
 */
export function webCodecsEnabled(): boolean {
  if (!webCodecsSupported) return false;
  try {
    if (typeof location !== 'undefined' && /[?&]nowebcodecs=1/.test(location.search)) return false;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kitkatWebCodecs') === 'off') {
      return false;
    }
  } catch {
    /* 스토리지 접근 불가(샌드박스) — 켜 둔다 */
  }
  return true;
}

export type FrameProviderOptions = {
  /** LRU 캐시 장수 (기본 120) */
  cacheSize?: number;
  /** 동시에 들고 있는 video 엘리먼트 수 (기본 6) */
  elements?: number;
  /** 동시 디코드(시크) 수 (기본 4) */
  concurrency?: number;
  /** 새 프레임이 준비돼 다시 그려야 할 때 부른다 */
  onFrameReady?: () => void;
  /** WebCodecs 경로 강제 on/off (기본: `webCodecsEnabled()`) */
  webCodecs?: boolean;
  /** 소스 하나가 미리 디코드해 둘 프레임 수 (기본 60) */
  lookahead?: number;
};

export class FrameProvider {
  readonly webCodecsAvailable: boolean = webCodecsSupported;
  /** 이 인스턴스가 실제로 WebCodecs 경로를 쓰는가 (플래그로 끌 수 있다) */
  readonly webCodecs: boolean;

  private readonly cache: LruCache<string, ImageBitmap>;
  private readonly slots: PoolSlot[];
  private readonly videos: VideoSlot[] = [];
  private readonly gate: Semaphore;
  private readonly images = new Map<string, HTMLImageElement>();
  /** src → 최근에 뜬 비트맵의 캐시 키 (디코드 중 대신 보여줄 임시 그림) */
  private readonly placeholders = new Map<string, string>();
  private readonly pinned = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly onFrameReady?: () => void;
  /** src → WebCodecs 소스 상태 */
  private readonly wc = new Map<string, WcEntry>();
  private readonly wcMax: number;
  private readonly lookahead: number;
  private tick = 0;
  /** 전역 단조 증가 프레임 번호 — 슬롯이 재배정돼도 seq 가 되풀이되지 않게 한다 */
  private frameCounter = 1;
  private disposed = false;

  constructor(opts: FrameProviderOptions = {}) {
    const elements = Math.max(1, opts.elements ?? 6);
    this.cache = new LruCache<string, ImageBitmap>(opts.cacheSize ?? 120, (key, bmp) => {
      if (!this.pinned.has(key)) bmp.close();
    });
    this.slots = makeSlots(elements);
    this.gate = new Semaphore(opts.concurrency ?? 4);
    this.webCodecs = opts.webCodecs ?? webCodecsEnabled();
    this.wcMax = elements;
    this.lookahead = Math.max(2, Math.floor(opts.lookahead ?? 60));
    if (opts.onFrameReady) this.onFrameReady = opts.onFrameReady;
    for (let i = 0; i < elements; i++) {
      this.videos.push({ el: this.makeVideoEl(), src: null, seq: 0, rvfcHandle: null });
    }
  }

  private makeVideoEl(): HTMLVideoElement {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.playsInline = true;
    el.muted = true;
    el.crossOrigin = 'anonymous';
    // 아직 못 읽어서 실패한 디코드를 다시 시도하게 만든다 (정지 중에는 다시 그릴 계기가 없다)
    const wake = (): void => this.onFrameReady?.();
    el.addEventListener('loadeddata', wake);
    el.addEventListener('canplay', wake);
    return el;
  }

  /** 정지 이미지 (image 클립·배경). 아직 안 떴으면 null. */
  image(src: string): HTMLImageElement | null {
    let el = this.images.get(src);
    if (!el) {
      el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => this.onFrameReady?.();
      el.src = src;
      this.images.set(src, el);
    }
    return el.complete && el.naturalWidth > 0 ? el : null;
  }

  frame(req: FrameRequest): FrameResult {
    if (this.disposed) return { image: null, seq: 0, exact: false };
    return req.playing ? this.playingFrame(req) : this.stillFrame(req);
  }

  // ── 재생 중: 엘리먼트를 직접 텍스처로 ──────────────────────────────────
  private playingFrame(req: FrameRequest): FrameResult {
    const slot = this.slotFor(req.key, req.src);
    const el = slot.el;
    el.muted = req.muted;
    el.volume = Math.min(1, Math.max(0, req.volume));
    el.playbackRate = Math.min(MAX_RATE, Math.max(MIN_RATE, req.rate));
    const targetSec = Math.max(0, req.srcMs) / 1000;
    const driftMs = Math.abs(el.currentTime * 1000 - req.srcMs);
    if (el.paused) {
      el.currentTime = targetSec;
      void el.play().catch(() => {
        /* 자동재생 제한 — 조용히 무시하고 정지 프레임으로 보인다 */
      });
    } else if (driftMs > 100) {
      el.currentTime = targetSec;
    }
    if (el.readyState < 2) return { image: null, seq: slot.seq, exact: false };
    return { image: el, seq: slot.seq, exact: driftMs <= 100 };
  }

  // ── 정지/스크럽: ① WebCodecs 큐 → ③ 시크 + createImageBitmap + LRU ──────
  private stillFrame(req: FrameRequest): FrameResult {
    const wcResult = this.webCodecsFrame(req);
    if (wcResult) return wcResult;

    const key = frameCacheKey(req.src, req.srcMs, req.frameIntervalMs);
    const hit = this.cache.get(key);
    if (hit) return { image: hit, seq: hashSeq(key), exact: true };

    void this.decode(req, key);

    const placeholderKey = this.placeholders.get(req.src);
    if (placeholderKey) {
      const bmp = this.cache.peek(placeholderKey);
      if (bmp) return { image: bmp, seq: hashSeq(placeholderKey), exact: false };
    }
    return { image: null, seq: 0, exact: false };
  }

  private async decode(req: FrameRequest, key: string): Promise<void> {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    const release = await this.gate.acquire();
    try {
      if (this.disposed || this.cache.has(key)) return;
      const slot = this.slotFor(req.key, req.src);
      const el = slot.el;
      if (!el.paused) el.pause();
      const targetSec = quantizeMs(req.srcMs, req.frameIntervalMs) / 1000;
      await seekTo(el, targetSec);
      if (this.disposed) return;
      let bmp: ImageBitmap | null = null;
      if (typeof createImageBitmap === 'function' && el.videoWidth > 0) {
        bmp = await createImageBitmap(el);
      }
      if (!bmp || this.disposed) {
        bmp?.close();
        return;
      }
      this.setPlaceholder(req.src, key);
      this.cache.set(key, bmp);
      this.onFrameReady?.();
    } catch {
      /* 시크 실패(로딩 중·범위 밖)는 다음 프레임에 다시 시도한다 */
    } finally {
      this.inflight.delete(key);
      release();
    }
  }

  // ── ① WebCodecs 경로 ───────────────────────────────────────────────────

  /**
   * WebCodecs 큐에서 프레임을 꺼낸다. 아직 아무것도 없으면 **null** 을 돌려주고
   * 부르는 쪽은 `<video>` 경로(③)로 물러난다 — 시동 구간에 까만 화면이 되지 않게.
   */
  private webCodecsFrame(req: FrameRequest): FrameResult | null {
    const entry = this.wcEntry(req.src);
    const src = entry?.source;
    if (!entry || !src) return null;

    // 진행 방향 — 한 창(lookahead) 넘게 튄 것은 «점프» 라 방향을 말해 주지 않는다
    // (루프 스티커가 끝→처음으로 감길 때 역방향으로 오해해 GOP 를 거꾸로 굽던 문제).
    const delta = req.srcMs - entry.lastMs;
    if (Math.abs(delta) <= this.lookahead * req.frameIntervalMs && delta !== 0) {
      entry.direction = delta > 0 ? 1 : -1;
    }
    entry.lastMs = req.srcMs;
    src.hint(req.srcMs, entry.direction, req.rate);

    const ts = src.peekTs(req.srcMs);
    if (ts !== null) {
      const frame = src.peek(req.srcMs);
      if (frame) return { image: frame, seq: hashSeq(`${req.src}@wc${ts}`), exact: true };
    }
    // 아직 그 시각의 프레임이 없다 → 가까운 것이 있으면 **대신 보여준다.**
    // 여기서 null 을 주면 합성기가 이 레이어를 안 그려서 한 프레임 까맣게 깜빡인다.
    const near = src.peekNearest(req.srcMs);
    const nearEnough = near !== null && Math.abs(near.tsMs - req.srcMs) <= this.lookahead * req.frameIntervalMs;
    if (near && nearEnough) {
      return { image: near.frame, seq: hashSeq(`${req.src}@wc${near.tsMs}`), exact: false };
    }
    // 큐가 비었거나(시동 중) 창 밖으로 **점프**했다 → <video> 경로(③)도 같이 시작한다.
    // 점프는 양쪽 다 키프레임부터 다시 디코드해야 해서 WebCodecs 가 더 빠를 게 없다
    // (실측 <video> 63ms vs WebCodecs 115ms). 먼저 프레임을 낸 쪽이 그려진다.
    return null;
  }

  /** src 의 WebCodecs 소스 (없으면 만들기 시작하고 이번에는 null). */
  private wcEntry(src: string): WcEntry | null {
    if (!this.webCodecs || this.disposed) return null;
    let entry = this.wc.get(src);
    if (!entry) {
      entry = { source: null, opening: true, failed: false, lastMs: 0, direction: 1, lastUsed: ++this.tick };
      this.wc.set(src, entry);
      this.evictWcSources();
      const e = entry;
      void createWebCodecsSource(src, {
        lookahead: this.lookahead,
        onFrameReady: () => this.onFrameReady?.(),
      }).then((source) => {
        e.opening = false;
        if (!source) {
          e.failed = true;
          return;
        }
        if (this.disposed || this.wc.get(src) !== e) {
          source.close();
          return;
        }
        e.source = source;
        if (e.warmMs !== undefined) {
          e.lastMs = e.warmMs;
          source.hint(e.warmMs, 1, 1); // 미리 열기 — 클립 시작부터 첫 창을 채워 둔다
        }
        this.onFrameReady?.();
      });
      return null;
    }
    entry.lastUsed = ++this.tick;
    return entry.failed ? null : entry;
  }

  /**
   * 문서의 영상 파일들을 **미리 열어 둔다.** 소스를 여는 데(워커 띄우기 + 컨테이너 해석)
   * 수백 ms~수 초가 걸리는데, 재생헤드가 그 클립에 닿고 나서 열기 시작하면 그동안 화면이
   * 이웃 프레임에 머문다(실측: 스티커가 나타나는 지점부터 47화면 연속 끊김).
   * 앞에 오는 것부터, 들고 있을 수 있는 수(엘리먼트 수)까지만.
   */
  prewarm(items: { src: string; srcMs?: number }[]): void {
    if (!this.webCodecs || this.disposed) return;
    for (const it of items.slice(0, this.wcMax)) {
      const before = this.wc.get(it.src);
      this.wcEntry(it.src);
      // 처음 여는 것이면, 열리는 즉시 클립 시작 시각부터 한 창을 채워 두게 한다.
      // 열어만 두면 재생헤드가 닿았을 때 첫 채우기 동안 3~5화면이 이웃 프레임에 머문다(실측).
      const entry = this.wc.get(it.src);
      if (!before && entry && it.srcMs !== undefined) entry.warmMs = it.srcMs;
    }
  }

  /** 소스는 디코더를 하나씩 쥐고 있다 — 엘리먼트 수만큼만 들고 있는다. */
  private evictWcSources(): void {
    while (this.wc.size > this.wcMax) {
      let victimKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.wc) {
        if (v.lastUsed < oldest) {
          oldest = v.lastUsed;
          victimKey = k;
        }
      }
      if (victimKey === null) break;
      this.wc.get(victimKey)?.source?.close();
      this.wc.delete(victimKey);
    }
  }

  /** 디버그·검증용 — 소스별 큐/디코드/닫힘 계수. */
  debugStats(): Record<string, { queued: number; decoded: number; closed: number }> {
    const out: Record<string, { queued: number; decoded: number; closed: number }> = {};
    for (const [k, v] of this.wc) {
      if (v.source) out[k] = v.source.stats();
    }
    return out;
  }

  private setPlaceholder(src: string, key: string): void {
    const prev = this.placeholders.get(src);
    if (prev && prev !== key) this.pinned.delete(prev);
    this.placeholders.set(src, key);
    this.pinned.add(key);
  }

  private slotFor(key: string, src: string): VideoSlot {
    const a = assignSlot(this.slots, key, ++this.tick);
    const slot = this.videos[a.index] as VideoSlot;
    if (slot.src !== src) {
      if (slot.rvfcHandle !== null) {
        cancelVideoFrameCallback(slot.el, slot.rvfcHandle);
        slot.rvfcHandle = null;
      }
      slot.el.pause();
      slot.el.src = src;
      slot.src = src;
      slot.seq = ++this.frameCounter;
      slot.el.load();
      this.watchFrames(slot);
    } else if (slot.rvfcHandle === null) {
      this.watchFrames(slot);
    }
    return slot;
  }

  /** requestVideoFrameCallback 으로 "새 프레임이 왔다"를 센다 — 불필요한 텍스처 업로드 방지. */
  private watchFrames(slot: VideoSlot): void {
    const el = slot.el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (typeof el.requestVideoFrameCallback !== 'function') {
      slot.seq = -1; // 지원 안 함 → 매 프레임 업로드
      return;
    }
    const step = (): void => {
      if (this.disposed || slot.el !== el) return;
      slot.seq = ++this.frameCounter;
      slot.rvfcHandle = el.requestVideoFrameCallback!(step);
    };
    slot.rvfcHandle = el.requestVideoFrameCallback(step);
  }

  /** 이번 프레임에 안 쓰인 엘리먼트는 재생을 멈춘다 (소리·디코드 낭비 방지). */
  pauseUnused(activeKeys: Set<string>): void {
    for (let i = 0; i < this.slots.length; i++) {
      const k = this.slots[i]!.key;
      if (k === null || activeKeys.has(k)) continue;
      const slot = this.videos[i] as VideoSlot;
      if (!slot.el.paused) slot.el.pause();
    }
  }

  /** 재생 중인 모든 엘리먼트를 멈춘다. */
  pauseAll(): void {
    for (const slot of this.videos) {
      if (!slot.el.paused) slot.el.pause();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.wc.values()) e.source?.close();
    this.wc.clear();
    for (const slot of this.videos) {
      if (slot.rvfcHandle !== null) cancelVideoFrameCallback(slot.el, slot.rvfcHandle);
      slot.el.pause();
      slot.el.removeAttribute('src');
      slot.el.load();
    }
    this.pinned.clear();
    this.cache.clear();
    this.images.clear();
  }
}

function cancelVideoFrameCallback(el: HTMLVideoElement, handle: number): void {
  const v = el as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
  if (typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(handle);
}

/** 캐시 키 → 안정적인 정수 (텍스처 업로드 스킵 판정용). */
function hashSeq(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 시크 완료(또는 8프레임 안에 안 오면 포기)를 기다린다. */
function seekTo(el: HTMLVideoElement, sec: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('error', onError);
      clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error('seek 실패'));
    };
    const onSeeked = (): void => finish(true);
    const onError = (): void => finish(false);
    const timer = setTimeout(() => finish(false), 2000);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('error', onError);
    if (Math.abs(el.currentTime - sec) < 1e-4 && el.readyState >= 2) {
      finish(true);
      return;
    }
    try {
      el.currentTime = sec;
    } catch {
      finish(false);
    }
  });
}
