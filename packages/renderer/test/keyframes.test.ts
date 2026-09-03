import { describe, expect, it } from 'vitest';
import type { Keyframe } from '@kitkat/schema';
import { interpolateKeyframes } from '../src/composition/keyframes.js';

const kf = (time: number, value: number, easing: Keyframe['easing'] = 'linear', prop: Keyframe['prop'] = 'opacity'): Keyframe => ({
  time,
  prop,
  value,
  easing,
});

describe('interpolateKeyframes', () => {
  it('키프레임이 없으면 fallback', () => {
    expect(interpolateKeyframes(undefined, 'opacity', 500, 0.7)).toBe(0.7);
    expect(interpolateKeyframes([], 'opacity', 500, 0.7)).toBe(0.7);
  });

  it('다른 prop 키프레임만 있으면 fallback', () => {
    expect(interpolateKeyframes([kf(0, 5, 'linear', 'scale')], 'opacity', 500, 0.7)).toBe(0.7);
  });

  it('첫 키프레임 이전 → 첫 값, 마지막 이후 → 마지막 값', () => {
    const kfs = [kf(1000, 0.2), kf(2000, 0.8)];
    expect(interpolateKeyframes(kfs, 'opacity', 0, 1)).toBe(0.2);
    expect(interpolateKeyframes(kfs, 'opacity', 1000, 1)).toBe(0.2);
    expect(interpolateKeyframes(kfs, 'opacity', 2000, 1)).toBe(0.8);
    expect(interpolateKeyframes(kfs, 'opacity', 9999, 1)).toBe(0.8);
  });

  it('linear 중간값은 산술 보간', () => {
    const kfs = [kf(0, 0), kf(1000, 100)];
    expect(interpolateKeyframes(kfs, 'opacity', 500, 0)).toBeCloseTo(50, 5);
    expect(interpolateKeyframes(kfs, 'opacity', 250, 0)).toBeCloseTo(25, 5);
  });

  it('정렬 안 된 입력도 시간순으로 처리', () => {
    const kfs = [kf(1000, 100), kf(0, 0)];
    expect(interpolateKeyframes(kfs, 'opacity', 500, 0)).toBeCloseTo(50, 5);
  });

  it('easeIn 중간값 < linear, easeOut 중간값 > linear', () => {
    const easeIn = [kf(0, 0, 'easeIn'), kf(1000, 100)];
    const easeOut = [kf(0, 0, 'easeOut'), kf(1000, 100)];
    const vIn = interpolateKeyframes(easeIn, 'opacity', 500, 0);
    const vOut = interpolateKeyframes(easeOut, 'opacity', 500, 0);
    expect(vIn).toBeLessThan(50);
    expect(vOut).toBeGreaterThan(50);
  });

  it('easeInOut은 양끝 정확, 중간 대략 절반', () => {
    const kfs = [kf(0, 0, 'easeInOut'), kf(1000, 100)];
    expect(interpolateKeyframes(kfs, 'opacity', 0, 0)).toBe(0);
    expect(interpolateKeyframes(kfs, 'opacity', 1000, 0)).toBe(100);
    expect(interpolateKeyframes(kfs, 'opacity', 500, 0)).toBeCloseTo(50, 1);
  });

  it('이징은 단조 증가', () => {
    const kfs = [kf(0, 0, 'easeInOut'), kf(1000, 100)];
    let prev = -1;
    for (let t = 0; t <= 1000; t += 50) {
      const v = interpolateKeyframes(kfs, 'opacity', t, 0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('구간별 이징: 구간 시작 키프레임의 easing을 따른다', () => {
    // 0→1000 linear, 1000→2000 easeIn
    const kfs = [kf(0, 0, 'linear'), kf(1000, 100, 'easeIn'), kf(2000, 200)];
    expect(interpolateKeyframes(kfs, 'opacity', 500, 0)).toBeCloseTo(50, 5);
    const mid2 = interpolateKeyframes(kfs, 'opacity', 1500, 0);
    expect(mid2).toBeGreaterThan(100);
    expect(mid2).toBeLessThan(150); // easeIn이라 절반보다 덜 진행
  });

  it('같은 prop만 골라 보간', () => {
    const kfs = [kf(0, 0), kf(1000, 100), kf(0, 2, 'linear', 'scale'), kf(1000, 4, 'linear', 'scale')];
    expect(interpolateKeyframes(kfs, 'scale', 500, 1)).toBeCloseTo(3, 5);
    expect(interpolateKeyframes(kfs, 'opacity', 500, 1)).toBeCloseTo(50, 5);
  });
});
