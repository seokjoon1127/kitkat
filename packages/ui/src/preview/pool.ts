// 프리뷰 v2 — 엘리먼트 풀 배정과 동시 디코드 제한의 순수 로직 (DOM 무의존).

export type PoolSlot = { key: string | null; lastUsed: number };

export function makeSlots(count: number): PoolSlot[] {
  const n = Math.max(1, Math.floor(count));
  const slots: PoolSlot[] = [];
  for (let i = 0; i < n; i++) slots.push({ key: null, lastUsed: -1 });
  return slots;
}

export type SlotAssignment = {
  index: number;
  /** 같은 키가 이미 그 자리에 있어 그대로 쓴 경우 */
  reused: boolean;
  /** 자리를 뺏긴 키 (없으면 null) */
  evicted: string | null;
};

/**
 * 키에 슬롯을 배정한다.
 * 1) 같은 키가 이미 있으면 그 자리 재사용
 * 2) 빈 자리가 있으면 그 자리
 * 3) 없으면 가장 오래 안 쓴 자리를 뺏는다
 * `now` 는 단조 증가하는 아무 수(호출 카운터·performance.now 둘 다 가능).
 */
export function assignSlot(slots: PoolSlot[], key: string, now: number): SlotAssignment {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]!.key === key) {
      slots[i]!.lastUsed = now;
      return { index: i, reused: true, evicted: null };
    }
  }
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]!.key === null) {
      slots[i]!.key = key;
      slots[i]!.lastUsed = now;
      return { index: i, reused: false, evicted: null };
    }
  }
  let victim = 0;
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]!.lastUsed < slots[victim]!.lastUsed) victim = i;
  }
  const evicted = slots[victim]!.key;
  slots[victim]!.key = key;
  slots[victim]!.lastUsed = now;
  return { index: victim, reused: false, evicted };
}

/** 동시에 진행하는 디코드 수를 제한하는 세마포어. */
export class Semaphore {
  private readonly max: number;
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  get active(): number {
    return this.running;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** 자리가 날 때까지 기다렸다가 해제 함수를 준다. */
  acquire(): Promise<() => void> {
    const release = (): void => {
      const next = this.queue.shift();
      if (next) {
        next();
        return;
      }
      this.running = Math.max(0, this.running - 1);
    };
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(release));
    });
  }
}


// ── F14: 멈춤 감시 이터레이션 (워커·메인 폴백 공통) ──────────────────────────

export type StallGuardOptions<T> = {
  /** 아이템이 이만큼(ms) 안 오면 이 채우기를 버린다 */
  stallMs: number;
  /** 아이템마다 «아직 이 채우기가 유효한가» — 거짓이면 아이템을 닫고 접는다 */
  alive: () => boolean;
  onItem: (item: T) => void;
  /** 멈춤으로 버릴 때 — 부르는 쪽이 세대 번호를 올려 매달린 이터레이터가 다음 아이템에서 스스로 접게 한다 */
  onStall: () => void;
};

/**
 * 비동기 이터레이터를 돌리되, 아이템이 `stallMs` 동안 하나도 안 오면 **기다리기를 그만두고**
 * 돌아온다(aborted+stalled). 안 그러면 디코드 루프가 «채우는 중» 인 채로 영원히 멈춰 이후
 * 모든 힌트가 무시된다(편집기 실측: 뒤로 끌기 79% 끊김). 버려진 이터레이션은 계속 돌다가
 * 다음 아이템에서 `alive()` 가 거짓이라 아이템을 닫고 끝난다.
 */
export function iterateWithStallGuard<T extends { close(): void }>(
  iter: AsyncIterable<T>,
  opts: StallGuardOptions<T>,
): Promise<{ aborted: boolean; count: number; stalled: boolean }> {
  return new Promise((resolve) => {
    let count = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: { aborted: boolean; count: number; stalled: boolean }): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      resolve(r);
    };
    const arm = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (done) return;
        opts.onStall();
        finish({ aborted: true, count, stalled: true });
      }, opts.stallMs);
    };
    arm();
    (async () => {
      for await (const item of iter) {
        if (done || !opts.alive()) {
          item.close();
          finish({ aborted: true, count, stalled: false });
          return;
        }
        count++;
        arm();
        opts.onItem(item);
      }
      finish({ aborted: false, count, stalled: false });
    })().catch(() => finish({ aborted: true, count, stalled: false }));
  });
}
