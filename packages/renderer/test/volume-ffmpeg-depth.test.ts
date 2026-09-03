import { describe, expect, it } from 'vitest';
import type { Keyframe } from '@kitkat/schema';
import {
  MAX_FFMPEG_VOLUME_STEPS,
  quantizeVolume,
  volumePeak,
} from '../src/composition/volume.js';

// remotion 4.0.519 의 roundVolumeToAvoidStackOverflow 를 그대로 옮긴 것.
// (node_modules/@remotion/renderer/dist/assets/round-volume-to-avoid-stack-overflow.js)
// 이게 바뀌면 이 테스트가 깨져서 알려 준다.
const remotionRound = (v: number): number =>
  Number((Math.round(v * 97) / 97).toFixed(3));

/** ffmpeg 식 중첩 한계. 값 99개까지 OK, 100개부터 렌더 실패 — 이 컴퓨터에서 실측. */
const FFMPEG_LIMIT = 99;

/** 페이드인이 걸린 볼륨 곡선이 실제로 만드는 «서로 다른 값» 개수 */
function distinctValues(opts: {
  peak: number;
  fadeInMs: number;
  durMs: number;
  fps: number;
  quantize: boolean;
}): number {
  const n = Math.round((opts.durMs / 1000) * opts.fps);
  const set = new Set<number>();
  for (let f = 0; f < n; f++) {
    const tMs = (f / opts.fps) * 1000;
    const fade = opts.fadeInMs > 0 ? Math.min(1, tMs / opts.fadeInMs) : 1;
    const raw = opts.peak * fade;
    set.add(remotionRound(opts.quantize ? quantizeVolume(raw, opts.peak) : raw));
  }
  return set.size;
}

describe('volumePeak', () => {
  it('클립 볼륨 × 트랙 배율', () => {
    expect(volumePeak(1, 1)).toBe(1);
    expect(volumePeak(2, 2)).toBe(4);
    expect(volumePeak(0.5, 1)).toBe(0.5);
  });

  it('트랙이 음소거면 0', () => {
    expect(volumePeak(2, 0)).toBe(0);
  });

  it("'volume' 키프레임 중 제일 큰 값을 쓴다", () => {
    const kf: Keyframe[] = [
      { time: 0, prop: 'volume', value: 0.2, easing: 'linear' },
      { time: 500, prop: 'volume', value: 1.8, easing: 'linear' },
      { time: 900, prop: 'x', value: 99, easing: 'linear' }, // 다른 prop 은 무시
    ];
    expect(volumePeak(1, 1, kf)).toBeCloseTo(1.8, 10);
  });

  it('키프레임이 클립 볼륨보다 작으면 클립 볼륨이 최대치', () => {
    const kf: Keyframe[] = [{ time: 0, prop: 'volume', value: 0.3, easing: 'linear' }];
    expect(volumePeak(1.5, 1, kf)).toBeCloseTo(1.5, 10);
  });
});

describe('quantizeVolume', () => {
  it('최대치가 1 이하면 한 비트도 안 바꾼다 (보통 설정에서 회귀 0)', () => {
    for (const v of [0, 0.001, 0.3333, 0.5, 0.99999, 1]) {
      expect(quantizeVolume(v, 1)).toBe(v);
      expect(quantizeVolume(v, 0.7)).toBe(v);
    }
  });

  it('최대치가 1을 넘으면 peak/97 격자에 스냅한다', () => {
    const peak = 2;
    const step = peak / 97;
    for (let k = 0; k <= 97; k++) {
      // 격자 위의 값은 그대로 남는다
      expect(quantizeVolume(k * step, peak)).toBeCloseTo(k * step, 10);
    }
    // 격자 사이 값은 가장 가까운 격자로 간다
    expect(quantizeVolume(step * 3.4, peak)).toBeCloseTo(step * 3, 10);
    expect(quantizeVolume(step * 3.6, peak)).toBeCloseTo(step * 4, 10);
  });

  it('0 과 최대치는 정확히 보존된다 (페이드 끝점이 안 틀어진다)', () => {
    expect(quantizeVolume(0, 4)).toBe(0);
    expect(quantizeVolume(4, 4)).toBeCloseTo(4, 10);
    expect(quantizeVolume(2, 2)).toBeCloseTo(2, 10);
  });

  it('스냅해도 소리 차이는 램프 계단 하나 크기를 안 넘는다', () => {
    for (const peak of [1.2, 2, 4]) {
      for (let i = 0; i <= 1000; i++) {
        const raw = (i / 1000) * peak;
        expect(Math.abs(quantizeVolume(raw, peak) - raw)).toBeLessThanOrEqual(peak / 97 / 2 + 1e-9);
      }
    }
  });
});

describe('ffmpeg if() 중첩 한계 (렌더가 통째로 실패하는 지점)', () => {
  it('고치기 전: 볼륨을 1보다 조금만 키워도 한계를 넘는다', () => {
    // 볼륨 1.2 · 페이드인 5초 — 아주 평범한 설정
    expect(distinctValues({ peak: 1.2, fadeInMs: 5000, durMs: 10000, fps: 30, quantize: false }))
      .toBeGreaterThan(FFMPEG_LIMIT);
    // 클립 2.0 × 트랙 2.0 · 페이드인 10초
    expect(distinctValues({ peak: 4, fadeInMs: 10000, durMs: 20000, fps: 30, quantize: false }))
      .toBeGreaterThan(FFMPEG_LIMIT);
  });

  it('고친 뒤: 어떤 조합도 한계를 안 넘는다', () => {
    for (const peak of [1.05, 1.2, 1.5, 2, 3, 4]) {
      for (const fps of [24, 30, 60]) {
        for (const fadeInMs of [2000, 5000, 10000, 30000]) {
          const d = distinctValues({ peak, fadeInMs, durMs: fadeInMs + 5000, fps, quantize: true });
          expect(d).toBeLessThanOrEqual(MAX_FFMPEG_VOLUME_STEPS);
          expect(d).toBeLessThanOrEqual(FFMPEG_LIMIT);
        }
      }
    }
  });

  it('최대치가 1 이하인 곡선은 remotion 자신의 격자로도 이미 안전하다', () => {
    for (const fps of [24, 30, 60]) {
      const d = distinctValues({ peak: 1, fadeInMs: 30000, durMs: 40000, fps, quantize: false });
      expect(d).toBeLessThanOrEqual(FFMPEG_LIMIT);
    }
  });

  it('remotion 의 반올림 상수가 바뀌면 알아챈다', () => {
    // 0..1 을 97등분 → 값 98가지. 여기에 if() 한 겹이 더해져 깊이 98 → 한계 100 안.
    const all = new Set<number>();
    for (let i = 0; i <= 10000; i++) all.add(remotionRound(i / 10000));
    expect(all.size).toBe(MAX_FFMPEG_VOLUME_STEPS);
  });
});

// ── remotion 의 «진짜» 식 생성기로 확인한다 ──────────────────────────────────
// 위 테스트들은 remotion 의 반올림을 옮겨 적은 것이라, 옮겨 적기를 틀렸으면 같이 틀린다.
// 그래서 설치된 remotion 의 실제 함수를 직접 불러 중첩 깊이를 센다.
import { createRequire } from 'node:module';
import path from 'node:path';

type VolumeExpr = { eval: string; value: string };
// ⚠️ CWD 로 찾으면 안 된다 — 패키지 하나만 골라 돌리면(`vitest --root packages/renderer`)
//    CWD 가 달라져 파일을 못 찾는다. 이 테스트 파일 위치에서 패키지를 «해결» 해서 찾는다.
const requireCjs = createRequire(import.meta.url);
const rendererEntry = requireCjs.resolve('@remotion/renderer');
/** …/@remotion/renderer/dist/index.js → …/@remotion/renderer/dist */
const rendererDist = path.dirname(rendererEntry);
const ffmpegVolumeExpression = requireCjs(
  path.join(rendererDist, 'assets', 'ffmpeg-volume-expression.js'),
).ffmpegVolumeExpression as (o: { volume: number[]; fps: number; trimLeft: number }) => VolumeExpr;

/** 괄호 최대 중첩 깊이. ffmpeg 식 파서의 한계는 100이다. */
function parenDepth(s: string): number {
  let d = 0;
  let max = 0;
  for (const c of s) {
    if (c === '(') max = Math.max(max, ++d);
    else if (c === ')') d--;
  }
  return max;
}

function fadeCurve(peak: number, fadeInMs: number, durMs: number, fps: number, fix: boolean): number[] {
  const n = Math.round((durMs / 1000) * fps);
  const out: number[] = [];
  for (let f = 0; f < n; f++) {
    const raw = peak * Math.min(1, ((f / fps) * 1000) / fadeInMs);
    out.push(fix ? quantizeVolume(raw, peak) : raw);
  }
  return out;
}

describe('remotion 실제 식 생성기로 낸 중첩 깊이', () => {
  const cases: [string, number, number, number, number][] = [
    ['볼륨 1.2 · 페이드 5초', 1.2, 5000, 10000, 30],
    ['볼륨 2.0 · 페이드 4초', 2, 4000, 10000, 30],
    ['클립2.0 × 트랙2.0 · 페이드 10초', 4, 10000, 20000, 30],
    ['볼륨 2.0 · 페이드 30초 · 60fps', 2, 30000, 40000, 60],
  ];

  it.each(cases)('%s — 고치기 전에는 한계(100)를 넘는다', (_n, peak, fade, dur, fps) => {
    const e = ffmpegVolumeExpression({ volume: fadeCurve(peak, fade, dur, fps, false), fps, trimLeft: 0 });
    expect(parenDepth(e.value)).toBeGreaterThanOrEqual(100);
  });

  it.each(cases)('%s — 고친 뒤에는 98을 안 넘는다', (_n, peak, fade, dur, fps) => {
    const e = ffmpegVolumeExpression({ volume: fadeCurve(peak, fade, dur, fps, true), fps, trimLeft: 0 });
    expect(parenDepth(e.value)).toBeLessThanOrEqual(98);
  });

  it('볼륨 1.0 짜리 보통 곡선은 고치기 전후가 «완전히 같은 식»이다 (회귀 0)', () => {
    const before = ffmpegVolumeExpression({ volume: fadeCurve(1, 10000, 20000, 30, false), fps: 30, trimLeft: 0 });
    const after = ffmpegVolumeExpression({ volume: fadeCurve(1, 10000, 20000, 30, true), fps: 30, trimLeft: 0 });
    expect(after.value).toBe(before.value);
    expect(parenDepth(after.value)).toBeLessThanOrEqual(98);
  });
});
