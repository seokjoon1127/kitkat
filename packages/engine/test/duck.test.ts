import { describe, expect, it } from 'vitest';
import type { AudioClip, Keyframe, VideoClip } from '@kitkat/schema';
import {
  duckKeyframes,
  voiceIntervalsFromEnvelope,
  DUCK_COMP_EASING,
  type VoiceEnvelope,
} from '../src/index.js';

function music(start: number, duration: number, volume = 1): AudioClip {
  return {
    id: 'm', kind: 'audio', assetId: 'aa', start, duration,
    in: 0, out: duration, speed: 1, volume,
  };
}

/** [time, value] 쌍으로 줄여서 비교하기 쉽게 */
function shape(kfs: Keyframe[]): [number, number][] {
  return kfs.map((k) => [k.time, k.value]);
}

// ── 대조용: 「정의대로의」 엔벨로프를 duckKeyframes 와 따로 구현한다 ──────────
// 구간 하나가 t 에 만드는 감쇠: [s-A, s] 1→amount, [s, e] amount, [e, e+R] amount→1, 나머지 1.
// 여러 구간이면 그 최솟값. 키프레임은 이 함수를 「선형 보간으로 그대로 재현」해야 한다.
function factor(t: number, iv: { start: number; end: number }, amount: number, a: number, r: number): number {
  if (t >= iv.start && t <= iv.end) return amount;
  if (t <= iv.start - a || t >= iv.end + r) return 1;
  if (t < iv.start) return 1 + (amount - 1) * ((t - (iv.start - a)) / a);
  return amount + (1 - amount) * ((t - iv.end) / r);
}

function envelope(
  t: number, ivs: { start: number; end: number }[], base: number, amount: number, a: number, r: number,
): number {
  let f = 1;
  for (const iv of ivs) f = Math.min(f, factor(t, iv, amount, a, r));
  return base * f;
}

/** 키프레임 사이는 선형, 양 끝 바깥은 끝 값을 유지 (렌더러의 interpolateKeyframes 와 같은 규칙) */
function interpAt(kfs: Keyframe[], t: number): number {
  if (t <= kfs[0]!.time) return kfs[0]!.value;
  const last = kfs[kfs.length - 1]!;
  if (t >= last.time) return last.value;
  for (let i = 1; i < kfs.length; i++) {
    const p = kfs[i - 1]!, q = kfs[i]!;
    if (t <= q.time) return p.value + (q.value - p.value) * ((t - p.time) / (q.time - p.time));
  }
  return last.value;
}

/** 0..duration 의 모든 정수 ms 에서 「키프레임 보간 == 정의된 엔벨로프」인지 대조하고 최대 오차를 돌려준다. */
function maxEnvelopeError(
  duration: number, ivs: { start: number; end: number }[], amount: number, a: number, r: number, volume = 1,
): number {
  const kfs = duckKeyframes(music(0, duration, volume), ivs, amount, a, r);
  expect(kfs.length).toBeGreaterThan(0);
  let worst = 0;
  for (let t = 0; t <= duration; t++) {
    worst = Math.max(worst, Math.abs(interpAt(kfs, t) - envelope(t, ivs, volume, amount, a, r)));
  }
  return worst;
}

describe('duckKeyframes', () => {
  it('기본 모양: attack 전 원래 볼륨 → 구간 동안 amount → release 후 복귀', () => {
    const kfs = duckKeyframes(music(0, 10000), [{ start: 3000, end: 5000 }], 0.2, 500, 800);
    expect(kfs.every((k) => k.prop === 'volume' && k.easing === 'linear')).toBe(true);
    expect(shape(kfs)).toEqual([
      [2500, 1],
      [3000, 0.2],
      [5000, 0.2],
      [5800, 1],
    ]);
  });

  it('클립 시작 기준 상대 ms로 옮긴다 (music 클립이 타임라인 중간에 있을 때)', () => {
    const kfs = duckKeyframes(music(2000, 8000), [{ start: 3000, end: 5000 }], 0.3, 500, 500);
    expect(shape(kfs)).toEqual([
      [500, 1],
      [1000, 0.3],
      [3000, 0.3],
      [3500, 1],
    ]);
  });

  it('attack이 클립 시작 앞으로 넘치면 0에서 잘리고 그 지점의 보간값이 남는다', () => {
    // 구간 [200,1000], attack 1000 → 램프는 -800부터. t=0 은 램프의 80% 지점 → 1 + (0.2-1)*0.8 = 0.36
    const kfs = duckKeyframes(music(0, 5000), [{ start: 200, end: 1000 }], 0.2, 1000, 500);
    expect(kfs[0]!.time).toBe(0);
    expect(kfs[0]!.value).toBeCloseTo(0.36, 6);
    expect(shape(kfs).slice(1)).toEqual([
      [200, 0.2],
      [1000, 0.2],
      [1500, 1],
    ]);
  });

  it('release가 클립 끝을 넘치면 duration에서 잘린다', () => {
    // 구간 [1000,1800], release 1000 → 2800까지 올라가야 하지만 클립은 2000에서 끝난다.
    // t=2000 은 release의 20% 지점 → 0.2 + 0.8*0.2 = 0.36
    const kfs = duckKeyframes(music(0, 2000), [{ start: 1000, end: 1800 }], 0.2, 200, 1000);
    const last = kfs[kfs.length - 1]!;
    expect(last.time).toBe(2000);
    expect(last.value).toBeCloseTo(0.36, 6);
  });

  it('기준 볼륨은 클립의 volume — amount는 그 배수다', () => {
    const kfs = duckKeyframes(music(0, 5000, 0.5), [{ start: 1000, end: 2000 }], 0.2, 100, 100);
    expect(shape(kfs)).toEqual([
      [900, 0.5],
      [1000, 0.1],
      [2000, 0.1],
      [2100, 0.5],
    ]);
  });

  it('attack·release가 0이면 1ms 램프로 계단을 만든다 (전 구간 감쇠 방지)', () => {
    const kfs = duckKeyframes(music(0, 5000), [{ start: 1000, end: 2000 }], 0.2, 0, 0);
    expect(shape(kfs)).toEqual([
      [999, 1],
      [1000, 0.2],
      [2000, 0.2],
      [2001, 1],
    ]);
  });

  it('겹치거나 맞닿은 voice 구간은 합집합으로 묶인다 (중간에 볼륨이 올라오지 않는다)', () => {
    const kfs = duckKeyframes(
      music(0, 12000),
      [{ start: 3000, end: 5000 }, { start: 5000, end: 7000 }, { start: 4000, end: 4500 }],
      0.2, 500, 800,
    );
    expect(shape(kfs)).toEqual([
      [2500, 1],
      [3000, 0.2],
      [7000, 0.2],
      [7800, 1],
    ]);
  });

  it('떨어진 구간 2개는 딥 2개를 만든다', () => {
    const kfs = duckKeyframes(
      music(0, 10000),
      [{ start: 1000, end: 2000 }, { start: 6000, end: 7000 }],
      0.4, 200, 300,
    );
    expect(shape(kfs)).toEqual([
      [800, 1], [1000, 0.4], [2000, 0.4], [2300, 1],
      [5800, 1], [6000, 0.4], [7000, 0.4], [7300, 1],
    ]);
  });

  it('release와 attack이 겹치면 그 사이에서 음악이 정의대로 올라온다 (교점 키프레임)', () => {
    // 문장 사이 1초 공백. release 1000 과 attack 1000 이 통째로 겹쳐 t=2500 에서 두 램프가 만난다.
    const kfs = duckKeyframes(music(0, 8000), [{ start: 1000, end: 2000 }, { start: 3000, end: 4000 }], 0.2, 1000, 1000);
    expect(shape(kfs)).toEqual([
      [0, 1], [1000, 0.2], [2000, 0.2], [2500, 0.6], [3000, 0.2], [4000, 0.2], [5000, 1],
    ]);
    expect(interpAt(kfs, 2500)).toBeCloseTo(0.6, 6);   // 예전엔 0.2 로 눌린 채였다
  });

  it('교점이 정수가 아니면 양옆 정수를 넣어 정수 격자 위에서 정확하다', () => {
    // e=2000, s=3000, A=1000, R=500 → 교점 (2000·1000 + 3000·500)/1500 = 2333.33…
    const ivs = [{ start: 1000, end: 2000 }, { start: 3000, end: 4000 }];
    const kfs = duckKeyframes(music(0, 8000), ivs, 0.2, 1000, 500);
    const times = kfs.map((k) => k.time);
    expect(times).toContain(2333);
    expect(times).toContain(2334);
    expect(maxEnvelopeError(8000, ivs, 0.2, 1000, 500)).toBeLessThan(1e-5);
  });

  it('여러 구간 × 여러 attack/release 조합에서 키프레임 보간 == 정의된 엔벨로프', () => {
    const cases: [string, { start: number; end: number }[], number, number, number, number][] = [
      ['좁은 틈 3개 · 긴 램프', [{ start: 1000, end: 2000 }, { start: 3000, end: 4000 }, { start: 4500, end: 5000 }], 0.2, 1000, 1000, 1],
      ['램프 5000(최대) · 틈이 램프보다 훨씬 좁다', [{ start: 2000, end: 3000 }, { start: 4000, end: 5000 }, { start: 6000, end: 6500 }], 0.15, 5000, 5000, 1],
      ['비대칭 램프', [{ start: 1000, end: 1500 }, { start: 2000, end: 2500 }, { start: 5000, end: 6000 }], 0.3, 300, 2000, 1],
      ['attack 0', [{ start: 1000, end: 2000 }, { start: 2500, end: 3000 }, { start: 3200, end: 3500 }], 0.2, 0, 2000, 1],
      ['release 0', [{ start: 1000, end: 2000 }, { start: 2500, end: 3000 }, { start: 3200, end: 3500 }], 0.2, 2000, 0, 1],
      ['attack·release 0', [{ start: 1000, end: 2000 }, { start: 2500, end: 3000 }], 0.2, 0, 0, 1],
      ['클립 양 끝으로 넘치는 램프', [{ start: 200, end: 800 }, { start: 1200, end: 1600 }, { start: 7600, end: 7900 }], 0.25, 1500, 1500, 1],
      ['기준 볼륨 0.4', [{ start: 1000, end: 2000 }, { start: 3000, end: 4000 }], 0.2, 1200, 900, 0.4],
    ];
    for (const [name, ivs, amount, a, r, vol] of cases) {
      const err = maxEnvelopeError(8000, ivs, amount, a, r, vol);
      expect(err, `${name}: 최대 오차 ${err}`).toBeLessThan(1e-5);
    }
  });

  it('키프레임 개수는 구간 수에 비례한다 (격자 샘플링으로 폭증하지 않는다)', () => {
    const ivs = Array.from({ length: 20 }, (_, i) => ({ start: 1000 + i * 900, end: 1400 + i * 900 }));
    const kfs = duckKeyframes(music(0, 30000), ivs, 0.2, 1000, 1000);
    expect(kfs.length).toBeLessThanOrEqual(6 * ivs.length);   // 구간당 4시각 + 교점 최대 2
    expect(maxEnvelopeError(30000, ivs, 0.2, 1000, 1000)).toBeLessThan(1e-5);
  });

  it('구간이 하나면 키프레임은 네 개 그대로다 (교점이 생길 곳이 없다)', () => {
    const ivs = [{ start: 3000, end: 5000 }];
    const kfs = duckKeyframes(music(0, 10000), ivs, 0.2, 500, 800);
    expect(shape(kfs)).toEqual([[2500, 1], [3000, 0.2], [5000, 0.2], [5800, 1]]);
    expect(maxEnvelopeError(10000, ivs, 0.2, 500, 800)).toBeLessThan(1e-5);
  });

  it('램프가 겹치지 않으면 교점 키프레임을 넣지 않는다 (틈 == A+R 경계 포함)', () => {
    // 틈 2000 == attack 1000 + release 1000 → 두 램프가 딱 맞닿을 뿐 겹치지 않는다.
    const kfs = duckKeyframes(music(0, 10000), [{ start: 1000, end: 2000 }, { start: 4000, end: 5000 }], 0.2, 1000, 1000);
    expect(shape(kfs)).toEqual([
      [0, 1], [1000, 0.2], [2000, 0.2], [3000, 1], [4000, 0.2], [5000, 0.2], [6000, 1],
    ]);
  });

  it('클립과 겹치지 않는 구간·빈 구간·amount 1은 빈 배열', () => {
    expect(duckKeyframes(music(0, 5000), [{ start: 20000, end: 21000 }], 0.2, 500, 500)).toEqual([]);
    expect(duckKeyframes(music(0, 5000), [], 0.2, 500, 500)).toEqual([]);
    expect(duckKeyframes(music(0, 5000), [{ start: 1000, end: 1000 }], 0.2, 500, 500)).toEqual([]);
    expect(duckKeyframes(music(0, 5000), [{ start: 1000, end: 2000 }], 1, 500, 500)).toEqual([]);
  });
});

// ── W8 F12-B: 파형 포락선 → 목소리 구간 ───────────────────────────────────

/** 20ms 버킷 포락선을 만든다. `spans` 는 소리가 «있는» 소스 ms 구간들. */
function rmsEnvelope(durationMs: number, spans: [number, number][], level = 0.3): VoiceEnvelope {
  const bucketMs = 20;
  const rms = new Array(Math.ceil(durationMs / bucketMs)).fill(0);
  for (let b = 0; b < rms.length; b++) {
    const t = b * bucketMs;
    if (spans.some(([s, e]) => t >= s && t < e)) rms[b] = level;
  }
  return { bucketMs, rms };
}

function voiceClip(patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'v', kind: 'audio', assetId: 'narr', start: 0, duration: 10000,
    in: 0, out: 10000, speed: 1, volume: 1, ...patch,
  };
}

describe('voiceIntervalsFromEnvelope', () => {
  it('클립 한가운데 3초 무음이면 그 구간은 목소리로 잡지 않는다 (옛 방식은 10초 내내 눌렸다)', () => {
    const clips = [voiceClip()];
    const env = { narr: rmsEnvelope(10000, [[0, 3500], [6500, 10000]]) };

    // 옛 방식(포락선 없음) = 클립 전체
    const before = voiceIntervalsFromEnvelope(clips, {});
    expect(before).toEqual([{ start: 0, end: 10000 }]);

    const after = voiceIntervalsFromEnvelope(clips, env);
    expect(after.length).toBe(2);
    expect(after[0]!.start).toBe(0);
    expect(after[0]!.end).toBeCloseTo(3500, -1);
    expect(after[1]!.start).toBeCloseTo(6500, -1);
    // 무음 3초는 어느 구간에도 안 들어간다
    for (const iv of after) expect(iv.start >= 6500 || iv.end <= 3500).toBe(true);
  });

  it('적응형 임계 — 조용히 녹음해도(전체 1/50) 같은 구간을 잡는다', () => {
    const clips = [voiceClip()];
    const loud = voiceIntervalsFromEnvelope(clips, { narr: rmsEnvelope(10000, [[3000, 7000]], 0.5) });
    const quiet = voiceIntervalsFromEnvelope(clips, { narr: rmsEnvelope(10000, [[3000, 7000]], 0.01) });
    expect(quiet).toEqual(loud);
  });

  it('민감도 — 그보다 짧은 틈은 이어진 말로 본다', () => {
    const clips = [voiceClip()];
    const env = { narr: rmsEnvelope(10000, [[1000, 2000], [2200, 3000]]) };   // 200ms 틈
    expect(voiceIntervalsFromEnvelope(clips, env, { sensitivityMs: 300 }).length).toBe(1);
    expect(voiceIntervalsFromEnvelope(clips, env, { sensitivityMs: 100 }).length).toBe(2);
  });

  it('minSpeechMs — 그보다 짧은 소리(기침·클릭)는 버린다', () => {
    const clips = [voiceClip()];
    const env = { narr: rmsEnvelope(10000, [[1000, 1040], [5000, 6000]]) };   // 40ms 딸깍 + 1초 말
    const out = voiceIntervalsFromEnvelope(clips, env, { minSpeechMs: 120 });
    expect(out.length).toBe(1);
    expect(out[0]!.start).toBeCloseTo(5000, -1);
  });

  it('고정 임계를 주면 그 값을 쓴다', () => {
    const clips = [voiceClip()];
    const env = { narr: rmsEnvelope(10000, [[3000, 7000]], 0.02) };           // -34dBFS
    expect(voiceIntervalsFromEnvelope(clips, env, { thresholdDb: -20 })).toEqual([]);
    expect(voiceIntervalsFromEnvelope(clips, env, { thresholdDb: -40 }).length).toBe(1);
  });

  it('파형은 소스 기준, 구간은 타임라인 기준 — in·speed·start 를 반영한다', () => {
    const clips = [voiceClip({ start: 2000, in: 4000, out: 8000, duration: 2000, speed: 2 })];
    const env = { narr: rmsEnvelope(12000, [[5000, 6000]]) };
    const out = voiceIntervalsFromEnvelope(clips, env);
    // 소스 5000~6000 → (5000-4000)/2 = 500 .. 1000 → 타임라인 2500~3000
    expect(out.length).toBe(1);
    expect(out[0]!.start).toBeCloseTo(2500, -1);
    expect(out[0]!.end).toBeCloseTo(3000, -1);
  });

  it('역재생 클립은 시간축을 뒤집어 옮긴다', () => {
    const clip: VideoClip = {
      id: 'r', kind: 'video', assetId: 'narr', start: 0, duration: 10000,
      in: 0, out: 10000, speed: 1, volume: 1, reversed: true,
    };
    const env = { narr: rmsEnvelope(10000, [[1000, 2000]]) };
    const out = voiceIntervalsFromEnvelope([clip], env);
    // 소스 1000~2000 → 타임라인 8000~9000
    expect(out.length).toBe(1);
    expect(out[0]!.start).toBeCloseTo(8000, -1);
    expect(out[0]!.end).toBeCloseTo(9000, -1);
  });

  it('안 들리는 클립(volume 0)은 더킹을 일으키지 않는다', () => {
    const env = { narr: rmsEnvelope(10000, [[3000, 7000]]) };
    expect(voiceIntervalsFromEnvelope([voiceClip({ volume: 0 })], env)).toEqual([]);
  });

  it('포락선이 없는 클립만 «클립 전체» 로 물러선다 (조용히 빼지 않는다)', () => {
    const a = voiceClip({ id: 'a', assetId: 'narr', start: 0, duration: 4000, out: 4000 });
    const b = voiceClip({ id: 'b', assetId: 'other', start: 5000, duration: 3000, out: 3000 });
    const out = voiceIntervalsFromEnvelope([a, b], { narr: rmsEnvelope(4000, [[0, 1000]]) });
    expect(out.length).toBe(2);
    expect(out[1]).toEqual({ start: 5000, end: 8000 });
  });

  it('통째로 무음인 클립은 구간을 안 만든다', () => {
    expect(voiceIntervalsFromEnvelope([voiceClip()], { narr: rmsEnvelope(10000, []) })).toEqual([]);
  });
});

describe('duckKeyframes 램프 이징 (W8 F12-B)', () => {
  it("기본은 'linear' — 기존 문서의 소리가 조용히 변하지 않는다", () => {
    const kfs = duckKeyframes(music(0, 10000), [{ start: 3000, end: 5000 }], 0.2, 500, 800);
    expect(kfs.every((k) => k.easing === 'linear')).toBe(true);
  });

  it("'comp' 는 컴프의 지수 곡선에 가까운 베지어를 쓴다", () => {
    const kfs = duckKeyframes(music(0, 10000), [{ start: 3000, end: 5000 }], 0.2, 500, 800, 'comp');
    expect(kfs.every((k) => k.easing === DUCK_COMP_EASING)).toBe(true);
    // 값·시각은 이징과 무관하게 그대로다
    expect(kfs.map((k) => [k.time, k.value])).toEqual([[2500, 1], [3000, 0.2], [5000, 0.2], [5800, 1]]);
  });
});
