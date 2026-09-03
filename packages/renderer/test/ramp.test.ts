import { describe, expect, it } from 'vitest';
import { rampDurationMs, SPEED_RAMP_PRESETS, type VideoClip } from '@kitkat/schema';
import {
  hasSpeedRamp,
  loopDurationInFrames,
  mediaTrimFrames,
  rampAudioSequences,
  rampSegmentFade,
  rampSegmentFadeMs,
  rampSequences,
} from '../src/composition/ramp.js';
import { msToFrames } from '../src/composition/keyframes.js';
import { fadeFactor } from '../src/composition/clips.js';

const vclip = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: 'c1',
  kind: 'video',
  assetId: 'a1',
  start: 0,
  duration: 4000,
  in: 1000,
  out: 5000,
  speed: 1,
  volume: 1,
  ...over,
});

describe('hasSpeedRamp', () => {
  it('점이 2개 이상일 때만 램프 경로를 탄다', () => {
    expect(hasSpeedRamp(vclip())).toBe(false);
    expect(hasSpeedRamp(vclip({ speedRamp: { points: [{ u: 0, speed: 1 }] } }))).toBe(false);
    expect(
      hasSpeedRamp(vclip({ speedRamp: { points: [{ u: 0, speed: 1 }, { u: 1, speed: 2 }] } })),
    ).toBe(true);
  });
});

describe('rampSequences — 세그먼트를 Sequence 파라미터로', () => {
  const ramped = (points: { u: number; speed: number }[]): VideoClip => {
    const c = vclip({ speedRamp: { points } });
    c.duration = rampDurationMs(c);
    return c;
  };

  it('세그먼트가 프레임을 빈틈없이·겹침없이 덮는다 (빈 프레임 = 깜빡임 버그)', () => {
    for (const preset of SPEED_RAMP_PRESETS) {
      for (const fps of [24, 30, 60]) {
        const clip = ramped(preset.points);
        const seqs = rampSequences(clip, fps);
        const total = msToFrames(clip.duration, fps);
        expect(seqs.length, `${preset.id}@${fps}`).toBeGreaterThan(0);
        expect(seqs[0]!.from, `${preset.id}@${fps}`).toBe(0);
        for (let i = 1; i < seqs.length; i++) {
          // 앞 세그먼트가 끝나는 프레임에서 정확히 다음 세그먼트가 시작한다
          expect(seqs[i]!.from, `${preset.id}@${fps} i=${i}`).toBe(
            seqs[i - 1]!.from + seqs[i - 1]!.durationInFrames,
          );
        }
        const last = seqs[seqs.length - 1]!;
        expect(last.from + last.durationInFrames, `${preset.id}@${fps} 끝`).toBe(Math.max(1, total));
      }
    }
  });

  it('한 프레임보다 짧은 세그먼트는 앞 세그먼트에 흡수된다 (소스 구간 유지)', () => {
    // 매우 빠른 끝부분 → ms 세그먼트가 프레임보다 짧아진다
    const clip = ramped([{ u: 0, speed: 1 }, { u: 0.7, speed: 1 }, { u: 1, speed: 20 }]);
    const seqs = rampSequences(clip, 24);
    for (const s of seqs) expect(s.durationInFrames).toBeGreaterThanOrEqual(1);
    expect(seqs[seqs.length - 1]!.trimAfter).toBe(msToFrames(clip.out, 24));
    // 흡수된 만큼 재생 배율이 올라간다
    expect(seqs[seqs.length - 1]!.playbackRate).toBeGreaterThan(seqs[0]!.playbackRate);
  });

  it('세그먼트가 소스 구간 [in,out] 을 빈틈없이 덮는다', () => {
    const clip = ramped(SPEED_RAMP_PRESETS.find((p) => p.id === 'bullet')!.points);
    const fps = 30;
    const seqs = rampSequences(clip, fps);
    expect(seqs[0]!.trimBefore).toBe(msToFrames(clip.in, fps));
    expect(seqs[seqs.length - 1]!.trimAfter).toBe(msToFrames(clip.out, fps));
    for (const s of seqs) {
      expect(s.trimAfter).toBeGreaterThan(s.trimBefore);
      expect(s.durationInFrames).toBeGreaterThanOrEqual(1);
      expect(s.playbackRate).toBeGreaterThan(0);
    }
  });

  it('느린 구간의 playbackRate 가 빠른 구간보다 작다', () => {
    const clip = ramped([{ u: 0, speed: 4 }, { u: 1, speed: 0.25 }]);
    const seqs = rampSequences(clip, 30);
    expect(seqs[0]!.playbackRate).toBeGreaterThan(seqs[seqs.length - 1]!.playbackRate);
    expect(seqs[0]!.playbackRate).toBeGreaterThan(2);
    expect(seqs[seqs.length - 1]!.playbackRate).toBeLessThan(0.5);
  });

  it('램프가 없으면 세그먼트 1개 = v1 경로와 같은 값', () => {
    const clip = vclip({ speed: 2, duration: 2000 });
    const seqs = rampSequences(clip, 30);
    expect(seqs).toHaveLength(1);
    expect(seqs[0]!).toMatchObject({
      from: 0,
      trimBefore: msToFrames(1000, 30),
      trimAfter: msToFrames(5000, 30),
      playbackRate: 2,
    });
  });

  it('srcOffsetMs 는 reversed 파일 좌표 보정에 그대로 더해진다', () => {
    const clip = ramped([{ u: 0, speed: 1 }, { u: 1, speed: 2 }]);
    const base = rampSequences(clip, 30);
    const shifted = rampSequences(clip, 30, 2000);
    expect(shifted).toHaveLength(base.length);
    for (let i = 0; i < base.length; i++) {
      expect(shifted[i]!.trimBefore - base[i]!.trimBefore).toBe(msToFrames(2000, 30));
      expect(shifted[i]!.trimAfter - base[i]!.trimAfter).toBe(msToFrames(2000, 30));
      expect(shifted[i]!.from).toBe(base[i]!.from);
    }
  });

  it('키가 클립 id 기준이라 세그먼트마다 다르다', () => {
    const clip = ramped([{ u: 0, speed: 1 }, { u: 1, speed: 3 }]);
    const keys = rampSequences(clip, 30).map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe('c1-r0');
  });
});

describe('rampSequences — duration 이 rampDurationMs 와 어긋나도 프레임이 안 빈다', () => {
  /** 프레임마다 덮은 세그먼트 수 (0 = 검은 프레임, 2 이상 = 겹침). */
  const coverage = (seqs: { from: number; durationInFrames: number }[], total: number): number[] => {
    const hits = new Array<number>(total).fill(0);
    for (const s of seqs) {
      for (let f = s.from; f < s.from + s.durationInFrames; f++) {
        if (f >= 0 && f < total) hits[f] = (hits[f] as number) + 1;
      }
      // 클립 밖으로 삐져나온 프레임도 잡는다
      expect(s.from + s.durationInFrames).toBeLessThanOrEqual(total);
    }
    return hits;
  };

  it('재현 케이스(in 0 · out 936 · duration 938)에서 마지막 프레임이 비지 않는다', () => {
    // 스키마가 |duration - rampDurationMs| <= 2ms 를 허용해서 받아준 문서.
    // fps 24 에서 클립 Sequence 는 23프레임인데 rampDurationMs(936) 기준이면 22프레임뿐이다.
    const clip = vclip({
      in: 0,
      out: 936,
      speed: 1,
      duration: 938,
      speedRamp: { points: [{ u: 0, speed: 1 }, { u: 1, speed: 1 }] },
    });
    expect(rampDurationMs(clip)).toBe(936);
    for (const fps of [24, 30, 60]) {
      const total = msToFrames(clip.duration, fps);
      const seqs = rampSequences(clip, fps);
      expect(seqs[0]!.from, `fps=${fps}`).toBe(0);
      expect(coverage(seqs, total), `fps=${fps}`).toEqual(new Array<number>(total).fill(1));
      const last = seqs[seqs.length - 1]!;
      expect(last.from + last.durationInFrames, `fps=${fps}`).toBe(total);
      expect(last.trimAfter).toBeGreaterThan(last.trimBefore);
    }
  });

  it('duration 이 ±2ms 어긋난 프리셋 6종 × fps 3종 모두 구멍·겹침 없음', () => {
    for (const preset of SPEED_RAMP_PRESETS) {
      for (const delta of [-2, -1, 1, 2]) {
        for (const fps of [24, 30, 60]) {
          const clip = vclip({ speedRamp: { points: preset.points } });
          clip.duration = rampDurationMs(clip) + delta;
          const total = msToFrames(clip.duration, fps);
          const seqs = rampSequences(clip, fps);
          const tag = `${preset.id}@${fps}${delta > 0 ? '+' : ''}${delta}`;
          expect(seqs.length, tag).toBeGreaterThan(0);
          expect(seqs[0]!.from, tag).toBe(0);
          expect(coverage(seqs, total), tag).toEqual(new Array<number>(total).fill(1));
          for (const s of seqs) {
            expect(s.durationInFrames, tag).toBeGreaterThanOrEqual(1);
            expect(s.playbackRate, tag).toBeGreaterThan(0);
            expect(s.trimAfter, tag).toBeGreaterThan(s.trimBefore);
          }
        }
      }
    }
  });

  it('정상 램프(프리셋 6종 × fps 3종)에도 여전히 구멍·겹침이 없다', () => {
    for (const preset of SPEED_RAMP_PRESETS) {
      for (const fps of [24, 30, 60]) {
        const clip = vclip({ speedRamp: { points: preset.points } });
        clip.duration = rampDurationMs(clip);
        const total = msToFrames(clip.duration, fps);
        const seqs = rampSequences(clip, fps);
        const tag = `${preset.id}@${fps}`;
        expect(coverage(seqs, total), tag).toEqual(new Array<number>(total).fill(1));
        // 소스 구간도 [in,out] 을 그대로 덮는다
        expect(seqs[0]!.trimBefore, tag).toBe(msToFrames(clip.in, fps));
      }
    }
  });
});

describe('mediaTrimFrames — 느린 재생에서 뒤가 비지 않게', () => {
  it('speed >= 1 이면 v1 값 그대로 (소스 구간이 표시 길이보다 길다)', () => {
    // in 1000, out 5000, speed 1 → duration 4000
    expect(mediaTrimFrames(1000, 5000, 4000, 30)).toEqual({ trimBefore: 30, trimAfter: 150 });
    // speed 2 → duration 2000
    expect(mediaTrimFrames(1000, 5000, 2000, 30)).toEqual({ trimBefore: 30, trimAfter: 150 });
  });

  it('speed < 1 이면 표시 길이만큼 trimAfter 를 넓힌다', () => {
    // in 0, out 1000, speed 0.5 → duration 2000 (표시 48프레임 필요, 소스는 24프레임뿐)
    expect(mediaTrimFrames(0, 1000, 2000, 24)).toEqual({ trimBefore: 0, trimAfter: 48 });
    expect(mediaTrimFrames(1000, 2000, 4000, 24)).toEqual({ trimBefore: 24, trimAfter: 120 });
  });

  it('표시 길이가 0 이어도 최소 1프레임', () => {
    expect(mediaTrimFrames(0, 1, 0, 30)).toEqual({ trimBefore: 0, trimAfter: 1 });
  });
});

describe('loopDurationInFrames', () => {
  it('소스 1회 길이 = (out-in)/speed', () => {
    expect(loopDurationInFrames(vclip({ in: 0, out: 2000, speed: 1, loop: true }), 30)).toBe(60);
    expect(loopDurationInFrames(vclip({ in: 0, out: 2000, speed: 2, loop: true }), 30)).toBe(30);
    expect(loopDurationInFrames(vclip({ in: 500, out: 1500, speed: 1, loop: true }), 60)).toBe(60);
  });

  it('0 프레임이 되지 않는다', () => {
    expect(loopDurationInFrames(vclip({ in: 0, out: 1, speed: 1 }), 30)).toBe(1);
  });
});

describe('rampSegmentFadeMs — 경계 페이드 길이', () => {
  it('긴 세그먼트는 8ms 로 고정된다', () => {
    expect(rampSegmentFadeMs(1000)).toBe(8);
    expect(rampSegmentFadeMs(40)).toBe(8); // 20% = 8 — 딱 경계
  });

  it('짧은 세그먼트는 길이의 20% 로 줄어든다 (상한 규칙)', () => {
    expect(rampSegmentFadeMs(30)).toBeCloseTo(6, 10);
    expect(rampSegmentFadeMs(10)).toBeCloseTo(2, 10);
    expect(rampSegmentFadeMs(0)).toBe(0);
    expect(rampSegmentFadeMs(-5)).toBe(0); // 음수 길이는 0 취급
  });

  it('framePeriodMs 를 주면 그 아래로는 안 내려간다 (volume 은 프레임당 한 번만 바뀐다)', () => {
    const fp30 = 1000 / 30;
    expect(rampSegmentFadeMs(1000, fp30)).toBeCloseTo(fp30, 10);
    expect(rampSegmentFadeMs(10, fp30)).toBeCloseTo(fp30, 10);
    expect(rampSegmentFadeMs(1000, 1000 / 60)).toBeCloseTo(1000 / 60, 10);
  });
});

describe('rampSegmentFade — 경계 페이드 배율', () => {
  it('가운데 세그먼트는 앞뒤 모두 페이드한다', () => {
    // 길이 100ms, 페이드 20ms, 가운데(index 1 / 3개)
    expect(rampSegmentFade(0, 100, 1, 3, 20)).toBe(0);
    expect(rampSegmentFade(10, 100, 1, 3, 20)).toBeCloseTo(0.5, 10);
    expect(rampSegmentFade(50, 100, 1, 3, 20)).toBe(1);
    expect(rampSegmentFade(90, 100, 1, 3, 20)).toBeCloseTo(0.5, 10);
    expect(rampSegmentFade(100, 100, 1, 3, 20)).toBe(0);
  });

  it('클립 첫 세그먼트의 시작·마지막 세그먼트의 끝에는 안 넣는다 (클립 fadeIn/Out 과 중복 금지)', () => {
    expect(rampSegmentFade(0, 100, 0, 3, 20)).toBe(1); // 첫 세그먼트 시작 — 페이드 없음
    expect(rampSegmentFade(100, 100, 0, 3, 20)).toBe(0); // 첫 세그먼트 끝 — 페이드 있음
    expect(rampSegmentFade(100, 100, 2, 3, 20)).toBe(1); // 마지막 세그먼트 끝 — 페이드 없음
    expect(rampSegmentFade(0, 100, 2, 3, 20)).toBe(0); // 마지막 세그먼트 시작 — 페이드 있음
  });

  it('세그먼트가 하나뿐이거나 페이드 길이가 0 이면 항상 1', () => {
    for (const t of [0, 25, 50, 100]) {
      expect(rampSegmentFade(t, 100, 0, 1, 20)).toBe(1);
      expect(rampSegmentFade(t, 100, 1, 3, 0)).toBe(1);
    }
  });

  it('기존 클립 페이드(fadeFactor)와 곱해진다 — 어느 쪽도 상대를 덮어쓰지 않는다', () => {
    // 클립 4000ms, fadeIn 400ms. 클립 시작 200ms 지점 = 클립 페이드 0.5
    const clipAt200 = fadeFactor(200, 4000, 400, 0);
    expect(clipAt200).toBeCloseTo(0.5, 10);
    // 그 시각이 어떤 세그먼트의 시작 10ms 지점(세그먼트 페이드 0.5)이라면 곱은 0.25
    const seg = rampSegmentFade(10, 100, 1, 3, 20);
    expect(seg).toBeCloseTo(0.5, 10);
    expect(clipAt200 * seg).toBeCloseTo(0.25, 10);
    // 세그먼트 페이드가 1 인 구간에서는 클립 페이드 값이 그대로 남는다
    expect(clipAt200 * rampSegmentFade(50, 100, 1, 3, 20)).toBeCloseTo(clipAt200, 10);
  });
});

describe('rampAudioSequences — 겹쳐서 크로스페이드하는 소리 세그먼트', () => {
  const ramped = (points: { u: number; speed: number }[]): VideoClip => {
    const c = vclip({ speedRamp: { points } });
    c.duration = rampDurationMs(c);
    return c;
  };

  it('영상 세그먼트와 개수·소스 구간이 같고, 이웃 쪽으로만 넓어진다', () => {
    for (const preset of SPEED_RAMP_PRESETS) {
      for (const fps of [24, 30, 60]) {
        const clip = ramped(preset.points);
        const v = rampSequences(clip, fps);
        const a = rampAudioSequences(clip, fps);
        const tag = `${preset.id}@${fps}`;
        expect(a.length, tag).toBe(v.length);
        for (let i = 0; i < a.length; i++) {
          // 넓어졌을 뿐 원래 구간을 반드시 포함한다
          expect(a[i]!.from, `${tag} i=${i}`).toBeLessThanOrEqual(v[i]!.from);
          expect(a[i]!.from + a[i]!.durationInFrames, `${tag} i=${i}`).toBeGreaterThanOrEqual(
            v[i]!.from + v[i]!.durationInFrames,
          );
          expect(a[i]!.trimAfter, `${tag} i=${i}`).toBeGreaterThan(a[i]!.trimBefore);
          expect(a[i]!.playbackRate, `${tag} i=${i}`).toBeGreaterThan(0);
        }
        // 첫 세그먼트는 앞으로, 마지막 세그먼트는 뒤로 넓히지 않는다 (클립 밖으로 새면 안 된다)
        expect(a[0]!.from, tag).toBe(0);
        const last = a[a.length - 1]!;
        expect(last.from + last.durationInFrames, tag).toBe(msToFrames(clip.duration, fps));
      }
    }
  });

  it('프레임마다 세그먼트 배율의 합이 1 근처다 (구멍도 볼륨 계단도 없다)', () => {
    for (const preset of SPEED_RAMP_PRESETS) {
      for (const fps of [24, 30, 60]) {
        const clip = ramped(preset.points);
        const a = rampAudioSequences(clip, fps);
        const framePeriodMs = 1000 / fps;
        const total = msToFrames(clip.duration, fps);
        const sum = new Array<number>(total).fill(0);
        a.forEach((s, i) => {
          for (let f = 0; f < s.durationInFrames; f++) {
            const t = s.from + f;
            if (t < total) {
              sum[t] =
                (sum[t] as number) +
                rampSegmentFade(
                  (f + 0.5) * framePeriodMs,
                  s.durationInFrames * framePeriodMs,
                  i,
                  a.length,
                  s.fadeMs,
                );
            }
          }
        });
        const tag = `${preset.id}@${fps}`;
        for (let f = 0; f < total; f++) {
          expect(sum[f], `${tag} frame=${f}`).toBeGreaterThanOrEqual(0.99);
          expect(sum[f], `${tag} frame=${f}`).toBeLessThanOrEqual(1.1);
        }
      }
    }
  });

  it('겹치는 폭은 한 프레임 — volume 이 프레임당 한 번만 평가되므로 더 짧게는 못 겹친다', () => {
    const clip = ramped([{ u: 0, speed: 1 }, { u: 1, speed: 2 }]);
    for (const fps of [24, 30, 60]) {
      const v = rampSequences(clip, fps);
      const a = rampAudioSequences(clip, fps);
      expect(a[0]!.fadeMs, `fps=${fps}`).toBeCloseTo(2000 / fps, 10);
      for (let i = 1; i < a.length - 1; i++) {
        expect(v[i]!.from - a[i]!.from, `fps=${fps} i=${i}`).toBe(1);
        expect(
          a[i]!.from + a[i]!.durationInFrames - (v[i]!.from + v[i]!.durationInFrames),
          `fps=${fps} i=${i}`,
        ).toBe(1);
      }
    }
  });

  it('램프가 없으면 세그먼트 1개 · 페이드 0 — v1 경로와 값이 같다 (회귀)', () => {
    const clip = vclip({ speed: 2, duration: 2000 });
    const a = rampAudioSequences(clip, 30);
    const v = rampSequences(clip, 30);
    expect(a).toHaveLength(1);
    expect(a[0]!.fadeMs).toBe(0);
    expect(rampSegmentFade(0, 2000, 0, 1, a[0]!.fadeMs)).toBe(1);
    expect({ ...a[0]!, key: '', fadeMs: 0 }).toEqual({ ...v[0]!, key: '', fadeMs: 0 });
  });

  it('reversed 파일 좌표 보정(srcOffsetMs)이 소스 구간에 그대로 더해진다', () => {
    const clip = ramped([{ u: 0, speed: 1 }, { u: 1, speed: 2 }]);
    const base = rampAudioSequences(clip, 30);
    const shifted = rampAudioSequences(clip, 30, 2000);
    expect(shifted).toHaveLength(base.length);
    for (let i = 1; i < base.length; i++) {
      expect(shifted[i]!.trimBefore - base[i]!.trimBefore).toBe(msToFrames(2000, 30));
      expect(shifted[i]!.from).toBe(base[i]!.from);
      expect(shifted[i]!.durationInFrames).toBe(base[i]!.durationInFrames);
    }
  });
});

// W8 F17 — 두 미디어 컴포넌트의 trimAfter 해석 차이를 견디는 성질.
// OffthreadVideo 는 trimAfter = 타임라인 길이, @remotion/media 의 Video 는 = 소스 위치 상한.
// trimAfter >= msToFrames(outMs) 가 깨지면 Video 로 갈아탄 순간 클립 뒷부분이 조용히 빈 화면이 된다.
describe('mediaTrimFrames — @remotion/media Video 로 갈아타도 안 깨지는 성질', () => {
  const f = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

  it('trimAfter 는 소스 out 프레임 아래로 절대 안 내려간다', () => {
    const fps = 30;
    for (const inMs of [0, 33, 100, 517, 1000, 4321]) {
      for (const lenMs of [1, 17, 33, 200, 1000, 3333]) {
        const outMs = inMs + lenMs;
        for (const speed of [0.25, 0.5, 1, 1.5, 2, 4]) {
          const displayMs = lenMs / speed;
          const { trimBefore, trimAfter } = mediaTrimFrames(inMs, outMs, displayMs, fps);
          // ① 소스 위치 상한으로 읽어도 필요한 소스 구간을 다 덮는다
          expect(trimAfter).toBeGreaterThanOrEqual(f(outMs, fps));
          // ② 타임라인 길이로 읽어도 보여야 할 프레임 수를 다 덮는다
          expect(trimAfter - trimBefore).toBeGreaterThanOrEqual(Math.max(1, f(displayMs, fps)));
        }
      }
    }
  });

  it('빠른 재생에서 제일 아슬아슬하다 — trim 0–10프레임 + 2배속', () => {
    // 표시는 5프레임이지만 소스는 10프레임을 읽어야 한다.
    // 소스 상한을 5로 잡으면 Video 에서 뒷부분 절반이 사라진다.
    const fps = 30;
    const { trimBefore, trimAfter } = mediaTrimFrames(0, (10 / fps) * 1000, (5 / fps) * 1000, fps);
    expect(trimBefore).toBe(0);
    expect(trimAfter).toBe(10);
  });
});
