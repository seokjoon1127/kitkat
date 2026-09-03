// W8 F10 — 궤적 간소화(RDP). 순수 함수라 ffmpeg 없이 돈다.
import { describe, expect, it } from 'vitest';
import { maxTrackDeviation, rdpIndices, simplifyBoxTrack, type BoxSample } from '../src/rdp.js';

const line = (n: number): BoxSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 33, x: i * 10, y: i * 5, w: 100, h: 100 }));

describe('rdpIndices', () => {
  it('점이 2개 이하면 전부 남긴다', () => {
    expect(rdpIndices([], 1)).toEqual([]);
    expect(rdpIndices([{ t: 0, a: 0, b: 0 }], 1)).toEqual([0]);
    expect(rdpIndices([{ t: 0, a: 0, b: 0 }, { t: 1, a: 5, b: 5 }], 1)).toEqual([0, 1]);
  });

  it('완전한 직선은 끝점 2개로 줄어든다', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ t: i, a: i * 3, b: i * 7 }));
    expect(rdpIndices(pts, 0.5)).toEqual([0, 49]);
  });

  it('가운데가 튄 점은 허용 오차보다 크면 남는다', () => {
    const pts = [
      { t: 0, a: 0, b: 0 },
      { t: 1, a: 1, b: 10 },
      { t: 2, a: 2, b: 0 },
    ];
    expect(rdpIndices(pts, 1)).toEqual([0, 1, 2]);
    expect(rdpIndices(pts, 20)).toEqual([0, 2]);
  });

  it('«수직 거리»가 아니라 «시각 보간 오차»로 잰다', () => {
    // (a,b) 평면에서는 세 점이 한 직선 위라 수직 거리가 0 이지만,
    // 시각이 고르지 않아 시각으로 보간하면 가운데가 크게 어긋난다.
    const pts = [
      { t: 0, a: 0, b: 0 },
      { t: 90, a: 10, b: 0 },
      { t: 100, a: 100, b: 0 },
    ];
    expect(rdpIndices(pts, 1)).toEqual([0, 1, 2]); // 보간 오차 = 80
  });

  it('허용 오차가 클수록 점이 줄어든다 (단조)', () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({
      t: i,
      a: Math.sin(i / 9) * 50,
      b: Math.cos(i / 7) * 50,
    }));
    const counts = [0.5, 1, 2, 5, 10].map((tol) => rdpIndices(pts, tol).length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    expect(counts[0]!).toBeGreaterThan(counts[4]!);
  });

  it('첫 점과 끝 점은 항상 남고 오름차순이다', () => {
    const pts = Array.from({ length: 80 }, (_, i) => ({ t: i, a: Math.random() * 100, b: Math.random() * 100 }));
    const idx = rdpIndices(pts, 3);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(79);
    for (let i = 1; i < idx.length; i++) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
  });
});

describe('simplifyBoxTrack', () => {
  it('직선 등속 궤적은 상자 2개로 줄어든다 (100% 가까운 감소)', () => {
    const r = simplifyBoxTrack(line(100), 0.5);
    expect(r.before).toBe(100);
    expect(r.after).toBe(2);
    expect(r.maxDeviation).toBeLessThanOrEqual(0.5);
  });

  it('«허용 오차를 실제로 지킨다» — 흔들리는 궤적 여러 허용치에서', () => {
    const samples: BoxSample[] = Array.from({ length: 300 }, (_, i) => ({
      t: i * 33,
      x: Math.sin(i / 11) * 200 + (i % 3) - 1, // ±1px 지터 = 실제 추적기 출력 성질
      y: Math.cos(i / 13) * 120 + ((i * 7) % 3) - 1,
      w: 100 + Math.sin(i / 21) * 40,
      h: 100 + Math.cos(i / 19) * 40,
    }));
    for (const tol of [0.5, 1, 2, 4, 6, 10]) {
      const r = simplifyBoxTrack(samples, tol);
      // 오차 계산이 부동소수라 아주 작은 여유만 준다
      expect(r.maxDeviation).toBeLessThanOrEqual(tol + 1e-6);
    }
  });

  it('네 채널이 «같은 시각»을 갖는다 — 남긴 시각 목록이 하나뿐이다', () => {
    // x 만 흔들리고 w 는 고른 궤적이라도, 시각은 하나의 목록으로 나온다.
    const samples: BoxSample[] = Array.from({ length: 60 }, (_, i) => ({
      t: i * 33,
      x: Math.sin(i / 3) * 50,
      y: 0,
      w: 100 + i,
      h: 100,
    }));
    const r = simplifyBoxTrack(samples, 2);
    expect(new Set(r.times).size).toBe(r.times.length);
    expect(r.times).toEqual([...r.times].sort((a, b) => a - b));
    expect(r.after).toBe(r.times.length);
  });

  it('크기만 변해도 (w,h) 가 자를 잡는다', () => {
    const samples: BoxSample[] = Array.from({ length: 100 }, (_, i) => ({
      t: i * 33,
      x: 0,
      y: 0,
      w: 100 + Math.sin(i / 5) * 30,
      h: 100,
    }));
    expect(simplifyBoxTrack(samples, 0.5).after).toBeGreaterThan(20);
    expect(simplifyBoxTrack(samples, 30).after).toBeLessThan(10);
  });

  it('빈 입력·1개·2개는 그대로 통과한다', () => {
    expect(simplifyBoxTrack([], 1)).toEqual({ times: [], before: 0, after: 0, maxDeviation: 0 });
    const two = line(2);
    expect(simplifyBoxTrack(two, 1).times).toEqual([0, 33]);
  });
});

describe('maxTrackDeviation', () => {
  it('전부 남기면 편차가 0 이다', () => {
    const s = line(20);
    expect(maxTrackDeviation(s, s.map((_, i) => i))).toBe(0);
  });

  it('마지막 구간의 점도 «실제로» 재진다', () => {
    // 마지막 구간을 빼먹는 흔한 off-by-one 을 잡는다: 끝 부근에서만 크게 튀게 만든다.
    const s: BoxSample[] = [
      { t: 0, x: 0, y: 0, w: 10, h: 10 },
      { t: 10, x: 10, y: 0, w: 10, h: 10 },
      { t: 20, x: 20, y: 0, w: 10, h: 10 },
      { t: 30, x: 30, y: 999, w: 10, h: 10 }, // 튀는 점
      { t: 40, x: 40, y: 0, w: 10, h: 10 },
    ];
    expect(maxTrackDeviation(s, [0, 2, 4])).toBeGreaterThan(900);
  });
});
