// W8 S5-c — 단계 가중치 진행률 (deriveMedia 의 passProgress/endPass 와 같은 형태)
import { describe, expect, it } from 'vitest';
import { stageProgress } from '../src/jobs.js';

function collect(weights: number[]) {
  const seen: number[] = [];
  // 부동소수 잡티(0.9500000000000001)를 잘라서 비교한다
  const { passProgress, endPass } = stageProgress(weights, (p) => seen.push(Number(p.toFixed(6))));
  return { seen, passProgress, endPass };
}

describe('stageProgress', () => {
  it('단계 1개면 그대로 통과한다 (지금 render 잡의 동작)', () => {
    const { seen, passProgress, endPass } = collect([1]);
    passProgress(0);
    passProgress(0.5);
    passProgress(1);
    endPass();
    expect(seen).toEqual([0, 0.5, 1, 1]);
  });

  it('가중치대로 구간을 나눈다', () => {
    const { seen, passProgress, endPass } = collect([0.9, 0.1]);
    passProgress(0.5); // 0.45
    endPass(); // 0.9
    passProgress(0.5); // 0.95
    endPass(); // 1
    expect(seen).toEqual([0.45, 0.9, 0.95, 1]);
  });

  it('F12 4단계 가중치 — 누적이 단조 증가하고 1에서 끝난다', () => {
    const { seen, passProgress, endPass } = collect([0.26, 0.26, 0.46, 0.02]);
    for (let i = 0; i < 4; i++) {
      passProgress(0.5);
      endPass();
    }
    expect(seen).toEqual([0.13, 0.26, 0.39, 0.52, 0.75, 0.98, 0.99, 1]);
  });

  it('합이 1이 아니어도 정규화한다', () => {
    const { seen, passProgress } = collect([3, 1]);
    passProgress(1);
    expect(seen).toEqual([0.75]);
  });

  it('단계 안의 진행률은 0..1 로 클램프한다', () => {
    const { seen, passProgress } = collect([1]);
    passProgress(-5);
    passProgress(9);
    expect(seen).toEqual([0, 1]);
  });

  it('단계를 넘겨서 더 부르면 1을 넘지 않는다', () => {
    const { seen, passProgress, endPass } = collect([1]);
    endPass();
    passProgress(1);
    endPass();
    expect(Math.max(...seen)).toBe(1);
  });
});
