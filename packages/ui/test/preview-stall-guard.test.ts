// F14 — 디코드 채우기의 «멈춤 감시» (워커·메인 폴백 공통 규칙, pool.ts).
//
// 샘플이 8초 동안 하나도 안 오면 그 채우기를 버리고 세대 번호를 올린다. 안 그러면 루프가
// «채우는 중» 인 채로 영원히 멈춰 이후 모든 힌트가 무시된다 (편집기 실측: 뒤로 끌기 79% 끊김).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iterateWithStallGuard } from '../src/preview/pool.js';

class FakeSample {
  closed = false;
  constructor(readonly ts: number) {}
  close(): void {
    this.closed = true;
  }
}

/** 샘플을 `items` 장 주고 나서 영원히 안 주는 가짜 소스 (네트워크가 멈춘 디코더). */
function hangingSource(items: number): AsyncIterable<FakeSample> & { yielded: FakeSample[] } {
  const yielded: FakeSample[] = [];
  return {
    yielded,
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < items; i++) {
        const s = new FakeSample(i * 33);
        yielded.push(s);
        yield s;
      }
      await new Promise<never>(() => {
        /* 영원히 */
      });
    },
  };
}

describe('iterateWithStallGuard — 샘플이 안 오면 채우기를 버린다', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('8초 동안 샘플이 없으면 aborted+stalled 로 돌아오고 onStall 로 세대를 올린다', async () => {
    let gen = 1;
    const seen: number[] = [];
    const p = iterateWithStallGuard(hangingSource(2), {
      stallMs: 8000,
      alive: () => gen === 1,
      onItem: (s) => seen.push(s.ts),
      onStall: () => {
        gen++;
      },
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(seen).toEqual([0, 33]); // 두 장은 받았고 아직 기다리는 중
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ aborted: true, count: 2, stalled: true });
    expect(gen).toBe(2); // 매달린 이터레이터는 다음 샘플에서 alive() 가 거짓이라 스스로 접는다
  });

  it('버린 뒤 «다음 힌트» 는 새 채우기를 정상적으로 시작·완료한다', async () => {
    let gen = 1;
    const first = iterateWithStallGuard(hangingSource(1), {
      stallMs: 8000,
      alive: () => gen === 1,
      onItem: () => {},
      onStall: () => {
        gen++;
      },
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect((await first).stalled).toBe(true);

    const ok: AsyncIterable<FakeSample> = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 3; i++) yield new FakeSample(i);
      },
    };
    const got: number[] = [];
    const second = iterateWithStallGuard(ok, {
      stallMs: 8000,
      alive: () => gen === 2,
      onItem: (s) => got.push(s.ts),
      onStall: () => {
        gen++;
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await second).toEqual({ aborted: false, count: 3, stalled: false });
    expect(got).toEqual([0, 1, 2]);
  });

  it('샘플이 계속 오는 동안은 타이머가 되감겨 버리지 않는다 (느린 디코더 ≠ 멈춤)', async () => {
    const slow: AsyncIterable<FakeSample> = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          yield new FakeSample(i);
        }
      },
    };
    const p = iterateWithStallGuard(slow, {
      stallMs: 8000,
      alive: () => true,
      onItem: () => {},
      onStall: () => {
        throw new Error('느린 것을 멈춤으로 오해했다');
      },
    });
    await vi.advanceTimersByTimeAsync(4 * 5000 + 10);
    expect(await p).toEqual({ aborted: false, count: 4, stalled: false });
  });

  it('세대가 바뀐 뒤에 온 샘플은 닫고 접는다 (누수 없음)', async () => {
    let gen = 1;
    const src = hangingSource(3);
    const p = iterateWithStallGuard(src, {
      stallMs: 8000,
      alive: () => gen === 1,
      onItem: () => {
        gen = 2; // 첫 샘플을 받은 직후 세대가 바뀌었다고 치자
      },
      onStall: () => {},
    });
    await vi.advanceTimersByTimeAsync(10);
    const r = await p;
    expect(r).toEqual({ aborted: true, count: 1, stalled: false });
    expect(src.yielded[1]?.closed).toBe(true);
  });
});
