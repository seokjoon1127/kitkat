// F14 — WebCodecs 디코드 큐(FrameRing)의 순수 로직.
//
// **여기서 못 박는 것: `VideoFrame` 누수.** `VideoFrame` 은 명시적 `close()` 없이는
// GPU 메모리가 안 풀리고, 몇십 장 쌓이면 브라우저가 디코더를 통째로 멈춘다.
// 그래서 «만든 개수 == 닫힌 개수 + 아직 들고 있는 개수» 를 테스트로 고정한다.
import { describe, expect, it } from 'vitest';
import { FrameRing } from '../src/preview/cache.js';

/** VideoFrame 대역 — 닫혔는지만 기억한다. */
class FakeFrame {
  static created = 0;
  static closedCount = 0;
  closed = false;
  constructor(readonly ts: number) {
    FakeFrame.created++;
  }
  close(): void {
    // 두 번 닫으면 브라우저가 예외를 던진다 — 우리도 그렇게 취급한다
    if (this.closed) throw new Error(`이미 닫힌 프레임을 또 닫았다: ${this.ts}`);
    this.closed = true;
    FakeFrame.closedCount++;
  }
}

function freshCounters(): void {
  FakeFrame.created = 0;
  FakeFrame.closedCount = 0;
}

describe('FrameRing — 버리는 규칙', () => {
  it('이미 지나온 프레임을 먼저 버린다 (앞으로 갈 때)', () => {
    const ring = new FrameRing<FakeFrame>(3);
    ring.focus(200, 1); // 200ms 에서 앞으로 간다 → 0·100 은 이미 지나왔다
    for (const ts of [0, 100, 200]) ring.set(ts, new FakeFrame(ts));
    ring.set(300, new FakeFrame(300));
    expect(ring.timestamps()).toEqual([100, 200, 300]);
  });

  it('역방향이면 «지나온 쪽» 이 반대다 — 큰 ts 를 먼저 버린다', () => {
    const ring = new FrameRing<FakeFrame>(3);
    ring.focus(100, -1); // 100ms 에서 뒤로 간다 → 200·300 은 이미 지나왔다
    for (const ts of [300, 200, 100]) ring.set(ts, new FakeFrame(ts));
    ring.set(0, new FakeFrame(0));
    expect(ring.timestamps()).toEqual([0, 100, 200]);
  });

  it('지나온 것이 없으면 제일 먼 미래를 버린다 (가까운 앞쪽부터 쓴다)', () => {
    const ring = new FrameRing<FakeFrame>(3);
    ring.focus(0, 1);
    for (const ts of [0, 100, 200]) ring.set(ts, new FakeFrame(ts));
    ring.set(300, new FakeFrame(300));
    expect(ring.timestamps()).toEqual([0, 100, 200]);
  });

  it('목표 프레임(오차 안)은 «지나온 것» 으로 치지 않는다 — 창이 꽉 차도 남는다', () => {
    // 60fps 요청 1234ms, 실제 프레임은 1233.33ms. 오차 8.3ms 안이므로 이게 «보여줄 프레임» 이다.
    // 예전엔 focus(1234) 보다 앞(작은 ts)이라 «지나온 것» 으로 제일 먼저 버려졌다 → 점프 실패.
    const ring = new FrameRing<FakeFrame>(3);
    ring.focus(1234, 1, 8.3);
    ring.set(1233, new FakeFrame(1233));
    ring.set(1250, new FakeFrame(1250));
    ring.set(1267, new FakeFrame(1267));
    ring.set(1283, new FakeFrame(1283));
    expect(ring.timestamps()).toContain(1233);
    expect(ring.get(1234, 8.3)?.ts).toBe(1233);
  });

  it('뒤쪽 한 장이 앞쪽 여러 장보다 먼저 나간다', () => {
    const ring = new FrameRing<FakeFrame>(2);
    ring.focus(1000, 1);
    ring.set(900, new FakeFrame(900)); // 이미 지나온 것
    ring.set(1300, new FakeFrame(1300)); // 멀지만 앞쪽
    ring.set(1010, new FakeFrame(1010));
    expect(ring.timestamps()).toEqual([1010, 1300]);
  });
});

describe('FrameRing — 찾기', () => {
  it('오차 안에 있는 가장 가까운 프레임을 준다', () => {
    const ring = new FrameRing<FakeFrame>(10);
    for (const ts of [0, 33, 67, 100]) ring.set(ts, new FakeFrame(ts));
    expect(ring.get(34, 8)?.ts).toBe(33);
    expect(ring.nearestKey(34, 8)).toBe(33);
  });

  it('오차를 벗어나면 null (엉뚱한 프레임을 그리지 않는다)', () => {
    const ring = new FrameRing<FakeFrame>(10);
    ring.set(0, new FakeFrame(0));
    expect(ring.get(500, 8)).toBeNull();
    expect(ring.has(500, 8)).toBe(false);
  });
});

describe('FrameRing — VideoFrame 누수', () => {
  it('밀려난 프레임은 즉시 닫힌다', () => {
    freshCounters();
    const ring = new FrameRing<FakeFrame>(5);
    ring.focus(0, 1);
    for (let i = 0; i < 50; i++) {
      ring.focus(i * 10, 1);
      ring.set(i * 10, new FakeFrame(i * 10));
    }
    expect(FakeFrame.created).toBe(50);
    expect(ring.size).toBe(5);
    // 만든 것 = 닫힌 것 + 아직 들고 있는 것
    expect(FakeFrame.closedCount + ring.size).toBe(FakeFrame.created);
    expect(ring.closed).toBe(FakeFrame.closedCount);
  });

  it('clear 는 남은 것을 전부 닫는다 — 닫힌 개수 == 만든 개수', () => {
    freshCounters();
    const ring = new FrameRing<FakeFrame>(8);
    for (let i = 0; i < 200; i++) {
      ring.focus(i * 16, i % 2 === 0 ? 1 : -1);
      ring.set(i * 16, new FakeFrame(i * 16));
    }
    ring.clear();
    expect(FakeFrame.closedCount).toBe(FakeFrame.created);
    expect(ring.closed).toBe(FakeFrame.created);
    expect(ring.size).toBe(0);
  });

  it('같은 시각을 다시 디코드하면 새로 만든 쪽을 닫는다 (두 번 닫지 않는다)', () => {
    freshCounters();
    const ring = new FrameRing<FakeFrame>(4);
    const first = new FakeFrame(100);
    ring.set(100, first);
    const second = new FakeFrame(100);
    ring.set(100, second);
    expect(second.closed).toBe(true);
    expect(first.closed).toBe(false); // 이미 텍스처로 올라갔을 수 있다
    expect(ring.get(100, 8)).toBe(first);
    ring.clear();
    expect(FakeFrame.closedCount).toBe(FakeFrame.created);
  });

  it('여러 번 clear 해도 두 번 닫지 않는다', () => {
    freshCounters();
    const ring = new FrameRing<FakeFrame>(4);
    ring.set(0, new FakeFrame(0));
    ring.clear();
    expect(() => ring.clear()).not.toThrow();
    expect(FakeFrame.closedCount).toBe(1);
  });
});
