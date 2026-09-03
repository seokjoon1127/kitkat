// 프리뷰 v2 — 프레임 캐시의 순수 로직 (DOM 무의존, 단위테스트 대상).
// 디코드한 프레임(ImageBitmap)을 LRU 로 들고 있고, 캐시 키는 "src + 양자화된 소스 시각"이다.

/** 가장 오래 안 쓴 것부터 버리는 캐시. Map 의 삽입 순서를 재사용 순서로 쓴다. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.onEvict = onEvict;
  }

  get size(): number {
    return this.map.size;
  }

  /** 오래된 것 → 최근 것 순서의 키 목록 (테스트·디버그용). */
  keys(): K[] {
    return [...this.map.keys()];
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** 값을 꺼내면서 "가장 최근 사용"으로 올린다. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** 순서를 건드리지 않고 들여다본다. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    const prev = this.map.get(key);
    if (prev !== undefined) {
      this.map.delete(key);
      if (prev !== value) this.onEvict?.(key, prev);
    }
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      const k = oldest.value;
      const v = this.map.get(k) as V;
      this.map.delete(k);
      this.onEvict?.(k, v);
    }
  }

  delete(key: K): boolean {
    const v = this.map.get(key);
    if (v === undefined && !this.map.has(key)) return false;
    this.map.delete(key);
    this.onEvict?.(key, v as V);
    return true;
  }

  clear(): void {
    for (const [k, v] of this.map) this.onEvict?.(k, v);
    this.map.clear();
  }
}

/**
 * 소스 시각(ms)을 프레임 간격으로 내림 양자화한다.
 * 같은 프레임을 소수점 차이 때문에 여러 번 디코드하는 것을 막는다.
 * stepMs 가 0 이하면 정수 ms 로만 반올림한다.
 */
export function quantizeMs(ms: number, stepMs: number): number {
  const t = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (!(stepMs > 0)) return Math.round(t);
  const idx = Math.floor(t / stepMs + 1e-9);
  return Math.round(idx * stepMs);
}

/** 캐시 키 = src + 양자화된 소스 시각. */
export function frameCacheKey(src: string, srcMs: number, stepMs: number): string {
  return `${src}@${quantizeMs(srcMs, stepMs)}`;
}

// ── F14 WebCodecs 디코드 큐용 링버퍼 ─────────────────────────────────────────

/** `close()` 를 반드시 불러 줘야 자원이 풀리는 것 (VideoFrame 이 그렇다). */
export type Closeable = { close(): void };

/**
 * **디코드해 둔 프레임을 시각(ms)으로 찾는 링버퍼.**
 *
 * 왜 LruCache 를 안 쓰나: LRU 는 «최근에 꺼내 쓴 것» 을 남긴다. 그런데 미리 디코드해 둔
 * 앞쪽 프레임은 아직 한 번도 안 꺼냈으므로 LRU 에서는 제일 먼저 버려진다 — 정반대다.
 * 그래서 여기서는 **재생 위치(focus)에서 얼마나 먼가**로 버린다.
 *
 * **`VideoFrame` 은 `close()` 없이는 GPU 메모리가 안 풀린다.** 밀려나는 즉시 닫는다.
 */
export class FrameRing<T extends Closeable> {
  private readonly map = new Map<number, T>();
  private readonly capacity: number;
  private focusMs = 0;
  private direction: 1 | -1 = 1;
  /** focus 에서 이만큼 안쪽은 «지금 보여줄 프레임» — 지나온 것으로 치지 않는다 */
  private focusTolMs = 0;
  /** 지금까지 닫은 개수 (누수 테스트용) */
  closed = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this.map.size;
  }

  /** 갖고 있는 프레임 시각들 (오름차순). */
  timestamps(): number[] {
    return [...this.map.keys()].sort((a, b) => a - b);
  }

  /**
   * 어느 지점을 중심으로 어느 방향으로 가는지 — 버릴 것을 고르는 기준.
   * `tolMs` 안에 있는 프레임(= 지금 보여줄 프레임)은 «지나온 것» 으로 치지 않는다.
   */
  focus(tsMs: number, direction: 1 | -1, tolMs = 0): void {
    this.focusMs = tsMs;
    this.direction = direction;
    this.focusTolMs = Math.max(0, tolMs);
  }

  set(tsMs: number, value: T): void {
    const key = Math.round(tsMs);
    const prev = this.map.get(key);
    if (prev !== undefined) {
      // 같은 시각을 다시 디코드했다 — 새 것을 버린다(옛 것은 이미 텍스처로 올라갔을 수 있다)
      value.close();
      this.closed++;
      return;
    }
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const victim = this.victimKey();
      if (victim === null) break;
      const v = this.map.get(victim) as T;
      this.map.delete(victim);
      v.close();
      this.closed++;
    }
  }

  /** `tsMs` 에서 `tolMs` 안에 있는 가장 가까운 프레임. 없으면 null. */
  get(tsMs: number, tolMs: number): T | null {
    const key = this.nearestKey(tsMs, tolMs);
    return key === null ? null : (this.map.get(key) as T);
  }

  /** `get` 이 돌려줄 프레임의 실제 시각 (텍스처 업로드 스킵 판정에 쓴다). */
  nearestKey(tsMs: number, tolMs: number): number | null {
    const exact = Math.round(tsMs);
    if (this.map.has(exact)) return exact;
    let best: number | null = null;
    let bestD = Infinity;
    for (const k of this.map.keys()) {
      const d = Math.abs(k - tsMs);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best !== null && bestD <= tolMs ? best : null;
  }

  has(tsMs: number, tolMs: number): boolean {
    return this.nearestKey(tsMs, tolMs) !== null;
  }

  /** 전부 닫고 비운다. */
  clear(): void {
    for (const v of this.map.values()) {
      v.close();
      this.closed++;
    }
    this.map.clear();
  }

  /**
   * 버릴 프레임 — 진행 방향 기준으로 제일 «쓸모없는» 것.
   *
   * 1) **이미 지나온 프레임**(진행 방향 뒤쪽)이 있으면 그중 제일 먼 것. 곧 다시 안 쓴다.
   * 2) 전부 앞쪽이면 제일 먼 미래를 버린다 — 가까운 앞쪽부터 순서대로 쓸 것이므로.
   */
  private victimKey(): number | null {
    let behind: number | null = null;
    let behindDist = -Infinity;
    let ahead: number | null = null;
    let aheadDist = -Infinity;
    for (const k of this.map.keys()) {
      const signed = (k - this.focusMs) * this.direction;
      if (signed < -this.focusTolMs) {
        if (-signed > behindDist) {
          behindDist = -signed;
          behind = k;
        }
      } else if (signed > aheadDist) {
        aheadDist = signed;
        ahead = k;
      }
    }
    return behind ?? ahead;
  }
}
