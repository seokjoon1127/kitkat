import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TARGET_LUFS,
  LOUDNESS_TARGETS,
  VoiceSchema,
  loudnessTarget,
  loudnessTargetOf,
  normalizeLoudness,
} from '../src/index.js';

describe('LOUDNESS_TARGETS', () => {
  it('모든 프리셋이 스키마가 받는 범위(-30..-9) 안에 있다', () => {
    for (const t of LOUDNESS_TARGETS) {
      const parsed = VoiceSchema.safeParse({ preset: 'broadcast', targetLufs: t.lufs });
      expect(parsed.success, `${t.id} (${t.lufs} LUFS) 가 스키마를 통과 못 함`).toBe(true);
    }
  });

  it('id 가 겹치지 않는다', () => {
    const ids = LOUDNESS_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('기본값 -14 는 목록의 맨 앞(유튜브)이다', () => {
    expect(LOUDNESS_TARGETS[0]!.id).toBe('youtube');
    expect(LOUDNESS_TARGETS[0]!.lufs).toBe(DEFAULT_TARGET_LUFS);
  });

  it('유튜브 -14 는 «공식 아님»으로 표시된다 (구글 문서에 없다 — 2026-09-02 확인)', () => {
    expect(loudnessTarget('youtube')!.official).toBe(false);
  });

  it('구글 광고는 -24 이고 공식 규격이다 — -14 로 내면 10dB 초과', () => {
    const ads = loudnessTarget('google-ads')!;
    expect(ads.lufs).toBe(-24);
    expect(ads.official).toBe(true);
    expect(DEFAULT_TARGET_LUFS - ads.lufs).toBe(10);
  });

  it('공식이라고 표시한 것에는 1차 출처가 적혀 있다', () => {
    for (const t of LOUDNESS_TARGETS) {
      if (!t.official) continue;
      expect(t.source, `${t.id} 에 출처가 없다`).toMatch(/[a-z]+\.[a-z]+/);
      expect(t.source.length).toBeGreaterThan(20);
    }
  });

  it('트루피크가 지금 고정값(-1.0)으로 못 맞추는 것은 hint 에 적혀 있다', () => {
    for (const t of LOUDNESS_TARGETS) {
      if (t.truePeakDb >= -1) continue;
      // -1.0 보다 낮은 트루피크를 요구하는 프리셋 — 지금 설정으로는 못 맞춘다
      if (t.id === 'google-ads') continue; // IAB 는 트루피크를 강제하지 않는다
      expect(t.hint, `${t.id} 의 트루피크 한계가 hint 에 없다`).toMatch(/트루피크/);
    }
  });

  it('loudnessTarget / loudnessTargetOf', () => {
    expect(loudnessTarget('google-ads')!.lufs).toBe(-24);
    expect(loudnessTarget('없는거')).toBeUndefined();
    expect(loudnessTargetOf(-24)!.id).toBe('google-ads');
    // -14 가 둘(유튜브·스포티파이)이면 먼저 나오는 유튜브
    expect(loudnessTargetOf(-14)!.id).toBe('youtube');
    expect(loudnessTargetOf(-13)).toBeUndefined();
  });
});

describe('normalizeLoudness — voice.targetLufs 를 쓰던 옛 문서 호환', () => {
  it('loudness 가 있으면 그대로 쓴다', () => {
    expect(normalizeLoudness({ loudness: { targetLufs: -24 } })).toEqual({ targetLufs: -24 });
  });

  it('loudness 가 없고 voice 가 켜져 있으면 voice.targetLufs 를 옮겨 온다', () => {
    expect(normalizeLoudness({ voice: { preset: 'broadcast', targetLufs: -16 } }))
      .toEqual({ targetLufs: -16 });
  });

  it('voice 만 있고 targetLufs 를 안 적었으면 기본값 -14', () => {
    expect(normalizeLoudness({ voice: { preset: 'warm' } }))
      .toEqual({ targetLufs: DEFAULT_TARGET_LUFS });
  });

  it("preset:'off' 는 음량도 안 맞춘다 — 옛 동작 그대로", () => {
    expect(normalizeLoudness({ voice: { preset: 'off', targetLufs: -24 } })).toBeUndefined();
  });

  it("preset:'off' 여도 loudness 가 있으면 맞춘다 — 이것이 이번에 고치는 것", () => {
    expect(normalizeLoudness({ voice: { preset: 'off' }, loudness: { targetLufs: -24 } }))
      .toEqual({ targetLufs: -24 });
  });

  it('둘 다 있으면 loudness 가 이긴다', () => {
    expect(normalizeLoudness({ voice: { preset: 'broadcast', targetLufs: -16 }, loudness: { targetLufs: -24 } }))
      .toEqual({ targetLufs: -24 });
  });

  it('아무것도 없으면 undefined', () => {
    expect(normalizeLoudness({})).toBeUndefined();
  });
});
