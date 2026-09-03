// 프리뷰 v2 — 디코더 엘리먼트 풀 배정 · 동시 디코드 제한
import { describe, expect, it } from 'vitest';
import { Semaphore, assignSlot, makeSlots } from '../src/preview/pool.js';

describe('풀 배정', () => {
  it('빈 자리부터 앞에서 채운다', () => {
    const slots = makeSlots(3);
    expect(assignSlot(slots, 'a', 1)).toEqual({ index: 0, reused: false, evicted: null });
    expect(assignSlot(slots, 'b', 2)).toEqual({ index: 1, reused: false, evicted: null });
    expect(slots.map((s) => s.key)).toEqual(['a', 'b', null]);
  });

  it('같은 키는 같은 자리를 재사용한다', () => {
    const slots = makeSlots(3);
    assignSlot(slots, 'a', 1);
    assignSlot(slots, 'b', 2);
    const again = assignSlot(slots, 'a', 3);
    expect(again).toEqual({ index: 0, reused: true, evicted: null });
    expect(slots[0]?.lastUsed).toBe(3);
  });

  it('자리가 다 차면 가장 오래 안 쓴 자리를 뺏는다', () => {
    const slots = makeSlots(2);
    assignSlot(slots, 'a', 1);
    assignSlot(slots, 'b', 2);
    assignSlot(slots, 'a', 3); // a 를 최신으로
    const r = assignSlot(slots, 'c', 4);
    expect(r.evicted).toBe('b');
    expect(r.index).toBe(1);
    expect(slots.map((s) => s.key)).toEqual(['a', 'c']);
  });

  it('풀 크기 1 이면 매번 뺏는다', () => {
    const slots = makeSlots(1);
    assignSlot(slots, 'a', 1);
    const r = assignSlot(slots, 'b', 2);
    expect(r).toEqual({ index: 0, reused: false, evicted: 'a' });
  });
});

describe('동시 디코드 제한', () => {
  it('최대 개수까지만 즉시 통과하고 나머지는 대기한다', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);
    let third = false;
    void sem.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(sem.pending).toBe(1);
    r1();
    await Promise.resolve();
    await Promise.resolve();
    expect(third).toBe(true);
    expect(sem.pending).toBe(0);
  });

  it('전부 해제하면 active 가 0 으로 돌아온다', async () => {
    const sem = new Semaphore(4);
    const rs = [await sem.acquire(), await sem.acquire()];
    expect(sem.active).toBe(2);
    for (const r of rs) r();
    expect(sem.active).toBe(0);
  });
});
