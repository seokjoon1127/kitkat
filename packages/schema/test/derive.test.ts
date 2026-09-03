import { describe, expect, it } from 'vitest';
import {
  SPEED_RAMP_PRESETS,
  curvesToTables,
  rampDurationMs,
  rampSegments,
  sourceKey,
  type AudioClip,
  type SpeedPoint,
  type VideoClip,
} from '../src/index.js';

function vclip(partial?: Partial<VideoClip>): VideoClip {
  return {
    id: 'c1', kind: 'video', assetId: 'a1',
    start: 0, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1,
    ...partial,
  };
}

function aclip(partial?: Partial<AudioClip>): AudioClip {
  return {
    id: 'ac1', kind: 'audio', assetId: 'au1',
    start: 0, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1,
    ...partial,
  };
}

describe('sourceKey', () => {
  it('source 없으면 null', () => {
    expect(sourceKey(vclip())).toBeNull();
  });

  it('빈 source({})면 null', () => {
    expect(sourceKey(vclip({ source: {} }))).toBeNull();
  });

  it('같은 스펙 → 같은 키, 형식은 s+hex8', () => {
    const a = vclip({ source: { lut: { assetId: 'L1', intensity: 0.8 }, denoise: { amount: 0.3 } } });
    const b = vclip({ source: { lut: { assetId: 'L1', intensity: 0.8 }, denoise: { amount: 0.3 } } });
    const k = sourceKey(a);
    expect(k).toMatch(/^s[0-9a-f]{8}$/);
    expect(sourceKey(b)).toBe(k);
  });

  it('객체 프로퍼티 순서가 달라도 같은 키', () => {
    const a = vclip();
    a.source = { lut: { assetId: 'L1', intensity: 0.5 }, denoise: { amount: 0.3 } };
    const b = vclip();
    b.source = { denoise: { amount: 0.3 }, lut: { intensity: 0.5, assetId: 'L1' } };
    expect(sourceKey(a)).toBe(sourceKey(b));
  });

  it('미세 부동소수 차이(0.3 vs 0.30000001) 흡수', () => {
    const a = vclip({ source: { denoise: { amount: 0.3 } } });
    const b = vclip({ source: { denoise: { amount: 0.30000001 } } });
    expect(sourceKey(a)).toBe(sourceKey(b));
  });

  it('값이 다르면 키도 다르다', () => {
    const a = vclip({ source: { lut: { assetId: 'L1', intensity: 0.5 } } });
    const b = vclip({ source: { lut: { assetId: 'L1', intensity: 0.6 } } });
    const c = vclip({ source: { lut: { assetId: 'L2', intensity: 0.5 } } });
    expect(sourceKey(a)).not.toBe(sourceKey(b));
    expect(sourceKey(a)).not.toBe(sourceKey(c));
  });

  it('reversed면 |rev가 반영돼 키가 갈린다', () => {
    const a = vclip({ source: { stabilize: { smoothing: 10 } } });
    const b = vclip({ source: { stabilize: { smoothing: 10 } }, reversed: true });
    expect(sourceKey(a)).not.toBe(sourceKey(b));
  });

  it('오디오 클립 source(denoise/pitch)도 안정 키', () => {
    const a = aclip({ source: { denoise: { amount: 0.5 }, pitch: { semitones: -2 } } });
    const b = aclip({ source: { pitch: { semitones: -2 }, denoise: { amount: 0.5 } } });
    const k = sourceKey(a);
    expect(k).toMatch(/^s[0-9a-f]{8}$/);
    expect(sourceKey(b)).toBe(k);
    expect(sourceKey(aclip())).toBeNull();
  });
});

describe('rampDurationMs', () => {
  it('speedRamp 없으면 round((out-in)/speed)', () => {
    expect(rampDurationMs(vclip({ in: 0, out: 3000, speed: 2 }))).toBe(1500);
    expect(rampDurationMs(vclip({ in: 100, out: 1100, speed: 3 }))).toBe(333);
  });

  it('등속 램프면 (out-in)/speed 와 일치', () => {
    const clip = vclip({
      in: 0, out: 3000, speed: 1,
      speedRamp: { points: [{ u: 0, speed: 2 }, { u: 1, speed: 2 }] },
    });
    expect(rampDurationMs(clip)).toBe(Math.round(3000 / 2));
  });

  it('몽타주 램프: 전체 최고속(4)보다 길고 최저속(1)보다 짧다', () => {
    const clip = vclip({
      in: 0, out: 4000, speed: 1,
      speedRamp: { points: [{ u: 0, speed: 1 }, { u: 0.5, speed: 4 }, { u: 1, speed: 1 }] },
    });
    const d = rampDurationMs(clip);
    expect(d).toBeGreaterThan(4000 / 4);
    expect(d).toBeLessThan(4000 / 1);
    // 선형 보간 적분 해석값: 2 × 2000·ln4/3 ≈ 1848
    expect(d).toBe(Math.round(4000 * (Math.log(4) / 3)));
  });
});

describe('rampSegments', () => {
  const rampPoints = (pts: SpeedPoint[]) => ({ points: pts });

  it('세그먼트 durationMs 합 === rampDurationMs (프리셋 6종 전부)', () => {
    for (const preset of SPEED_RAMP_PRESETS) {
      const clip = vclip({ in: 500, out: 3500, speed: 1, speedRamp: rampPoints(preset.points) });
      clip.duration = rampDurationMs(clip);
      const segs = rampSegments(clip);
      const sum = segs.reduce((s, x) => s + x.durationMs, 0);
      expect(sum).toBe(rampDurationMs(clip));
    }
  });

  it('모든 경계가 정수이고 타임라인·소스 모두 빈틈없이 이어진다', () => {
    const clip = vclip({
      in: 250, out: 3250, speed: 1,
      speedRamp: rampPoints([{ u: 0, speed: 1 }, { u: 0.45, speed: 0.2 }, { u: 0.55, speed: 0.2 }, { u: 1, speed: 1 }]),
    });
    const segs = rampSegments(clip);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs[0]!.startMs).toBe(0);
    expect(segs[0]!.inMs).toBe(250);
    expect(segs[segs.length - 1]!.outMs).toBe(3250);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      expect(Number.isInteger(s.startMs)).toBe(true);
      expect(Number.isInteger(s.durationMs)).toBe(true);
      expect(Number.isInteger(s.inMs)).toBe(true);
      expect(Number.isInteger(s.outMs)).toBe(true);
      expect(s.outMs).toBeGreaterThan(s.inMs);
      if (i > 0) {
        expect(s.startMs).toBe(segs[i - 1]!.startMs + segs[i - 1]!.durationMs);
        expect(s.inMs).toBe(segs[i - 1]!.outMs);
      }
    }
  });

  it('maxSegments 상한을 지킨다 (기본 40)', () => {
    const clip = vclip({
      in: 0, out: 10000, speed: 1,
      speedRamp: rampPoints([{ u: 0, speed: 1 }, { u: 1, speed: 4 }]),
    });
    expect(rampSegments(clip).length).toBeLessThanOrEqual(40);
    expect(rampSegments(clip, 10).length).toBeLessThanOrEqual(10);
    expect(rampSegments(clip, 10).length).toBeGreaterThan(1);
  });

  it('램프 없으면 클립 전체가 단일 세그먼트', () => {
    const clip = vclip({ in: 100, out: 2100, speed: 2 });
    expect(rampSegments(clip)).toEqual([
      { startMs: 0, durationMs: 1000, inMs: 100, outMs: 2100, speed: 2 },
    ]);
  });

  it('세그먼트 speed ≈ 소스길이/표시길이', () => {
    const clip = vclip({
      in: 0, out: 4000, speed: 1,
      speedRamp: rampPoints([{ u: 0, speed: 2 }, { u: 0.4, speed: 0.4 }, { u: 1, speed: 2 }]),
    });
    for (const s of rampSegments(clip)) {
      expect(s.speed).toBeCloseTo((s.outMs - s.inMs) / s.durationMs, 10);
      expect(s.speed).toBeGreaterThan(0);
    }
  });

  it('짧은 소스(span 20ms)도 정수 경계·합계 불변식 유지', () => {
    const clip = vclip({
      in: 40, out: 60, speed: 1,
      speedRamp: rampPoints([{ u: 0, speed: 0.5 }, { u: 1, speed: 2 }]),
    });
    const segs = rampSegments(clip);
    const sum = segs.reduce((s, x) => s + x.durationMs, 0);
    expect(sum).toBe(rampDurationMs(clip));
    expect(segs.length).toBeLessThanOrEqual(20);
    expect(segs[segs.length - 1]!.outMs).toBe(60);
    for (const s of segs) {
      expect(Number.isInteger(s.startMs) && Number.isInteger(s.durationMs)).toBe(true);
      expect(Number.isInteger(s.inMs) && Number.isInteger(s.outMs)).toBe(true);
    }
  });
});

describe('curvesToTables', () => {
  it('커브가 하나도 없으면 null', () => {
    expect(curvesToTables({})).toBeNull();
  });

  it('항등 커브면 채널당 33개, 0..1 선형', () => {
    const t = curvesToTables({ rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(t).not.toBeNull();
    for (const ch of ['r', 'g', 'b'] as const) {
      expect(t![ch]).toHaveLength(33);
      for (let i = 0; i <= 32; i++) expect(t![ch][i]).toBeCloseTo(i / 32, 10);
    }
  });

  it('단조 데이터(플래토 포함)는 단조 증가 테이블 — 오버슈트 없음', () => {
    const t = curvesToTables({
      rgb: [{ x: 0, y: 0 }, { x: 0.3, y: 0.9 }, { x: 0.7, y: 0.9 }, { x: 1, y: 1 }],
    });
    const arr = t!.r;
    // 부동소수 마지막 비트 잡음(1e-16)만 허용 — 실제 오버슈트는 잡는다
    for (let i = 1; i < arr.length; i++) expect(arr[i]).toBeGreaterThanOrEqual(arr[i - 1]! - 1e-9);
    for (const v of arr) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(arr[0]).toBeCloseTo(0, 10);
    expect(arr[32]).toBeCloseTo(1, 10);
  });

  it('채널 커브는 자기 채널에만 적용된다', () => {
    const t = curvesToTables({ r: [{ x: 0, y: 1 }, { x: 1, y: 1 }] }); // r 을 전부 1로
    for (let i = 0; i <= 32; i++) {
      expect(t!.r[i]).toBeCloseTo(1, 10);
      expect(t!.g[i]).toBeCloseTo(i / 32, 10); // g/b 는 항등 유지
      expect(t!.b[i]).toBeCloseTo(i / 32, 10);
    }
  });

  it('마스터(rgb) 먼저, 채널 커브가 그 결과를 받는다: table[i] = curveR(curveRgb(i/32))', () => {
    const invert = [{ x: 0, y: 1 }, { x: 1, y: 0 }];
    const t = curvesToTables({ rgb: invert, r: invert });
    for (let i = 0; i <= 32; i++) {
      expect(t!.r[i]).toBeCloseTo(i / 32, 6);      // 반전의 반전 = 항등
      expect(t!.g[i]).toBeCloseTo(1 - i / 32, 6);  // 마스터 반전만
    }
  });
});
