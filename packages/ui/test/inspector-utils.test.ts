// W3-C 인스펙터 순수 헬퍼 단위 테스트 (+ W5 X3-A 확장)
import { describe, expect, it } from 'vitest';
import { EFFECT_TYPES, sourceKey, TRANSITION_TYPES } from '@kitkat/schema';
import type { Asset, AudioClip, TextClip, VideoClip } from '@kitkat/schema';
import {
  addCurvePoint,
  currentPropValue,
  curvePath,
  defaultChromaKey,
  defaultEffectParams,
  defaultMask,
  derivePending,
  EFFECT_LABELS,
  EFFECT_PARAM_DEFS,
  formatMs,
  insertRampPoint,
  isIdentityCurve,
  makeEffect,
  moveCurvePoint,
  normalizeClipSource,
  normalizeCurve,
  normalizeRampPoints,
  removeCurvePoint,
  removeRampPoint,
  setCurveChannel,
  TRANSITION_LABELS,
} from '../src/components/sections/inspector-utils';

describe('formatMs', () => {
  it('0 → 0:00.000', () => {
    expect(formatMs(0)).toBe('0:00.000');
  });
  it('3250 → 0:03.250', () => {
    expect(formatMs(3250)).toBe('0:03.250');
  });
  it('65005 → 1:05.005', () => {
    expect(formatMs(65005)).toBe('1:05.005');
  });
  it('음수는 0으로 클램프', () => {
    expect(formatMs(-42)).toBe('0:00.000');
  });
  it('소수 ms는 반올림', () => {
    expect(formatMs(999.6)).toBe('0:01.000');
  });
});

describe('효과 파라미터 정의', () => {
  it('EFFECT_TYPES 전부 정의·라벨이 있다', () => {
    for (const t of EFFECT_TYPES) {
      expect(EFFECT_PARAM_DEFS[t].length).toBeGreaterThan(0);
      expect(EFFECT_LABELS[t].length).toBeGreaterThan(0);
    }
  });
  it('기본값은 min..max 범위 안', () => {
    for (const t of EFFECT_TYPES) {
      for (const d of EFFECT_PARAM_DEFS[t]) {
        expect(d.def).toBeGreaterThanOrEqual(d.min);
        expect(d.def).toBeLessThanOrEqual(d.max);
      }
    }
  });
  it('계약 키: brightness→amount 1, hue→deg 0, blur→px', () => {
    expect(defaultEffectParams('brightness')).toEqual({ amount: 1 });
    expect(defaultEffectParams('hue')).toEqual({ deg: 0 });
    expect(Object.keys(defaultEffectParams('blur'))).toEqual(['px']);
  });
  it('makeEffect: 고유 id + 타입/기본 파라미터', () => {
    const a = makeEffect('sepia');
    const b = makeEffect('sepia');
    expect(a.id).not.toBe(b.id);
    expect(a.type).toBe('sepia');
    expect(a.params).toEqual({ amount: 1 });
  });
});

describe('기본 객체', () => {
  it('defaultMask는 전체 사각형', () => {
    expect(defaultMask()).toEqual({ shape: 'rect', feather: 0.1, x: 0, y: 0, w: 1, h: 1 });
  });
  it('defaultChromaKey는 녹색', () => {
    expect(defaultChromaKey().color).toBe('#00ff00');
  });
});

describe('currentPropValue', () => {
  const video: VideoClip = {
    id: 'v1',
    kind: 'video',
    assetId: 'a1',
    start: 0,
    duration: 2000,
    in: 0,
    out: 2000,
    speed: 1,
    volume: 0.7,
    transform: { x: 0.25, y: -0.1, scale: 1.5, rotation: 30 },
    opacity: 0.8,
  };
  const audio: AudioClip = {
    id: 'a1',
    kind: 'audio',
    assetId: 'a2',
    start: 0,
    duration: 1000,
    in: 0,
    out: 1000,
    speed: 1,
    volume: 1.2,
  };
  const text: TextClip = {
    id: 't1',
    kind: 'text',
    start: 0,
    duration: 1000,
    text: '안녕',
    style: { fontFamily: 'Pretendard', fontSize: 64, color: '#ffffff', align: 'center' },
  };

  it('transform 값을 그대로 가져온다', () => {
    expect(currentPropValue(video, 'x')).toBe(0.25);
    expect(currentPropValue(video, 'scale')).toBe(1.5);
    expect(currentPropValue(video, 'rotation')).toBe(30);
    expect(currentPropValue(video, 'opacity')).toBe(0.8);
    expect(currentPropValue(video, 'volume')).toBe(0.7);
  });
  it('transform 없으면 기본값(x 0, scale 1)', () => {
    expect(currentPropValue(text, 'x')).toBe(0);
    expect(currentPropValue(text, 'scale')).toBe(1);
    expect(currentPropValue(text, 'opacity')).toBe(1);
  });
  it('오디오는 volume만 실제 값', () => {
    expect(currentPropValue(audio, 'volume')).toBe(1.2);
    expect(currentPropValue(audio, 'opacity')).toBe(1);
  });
  it('text의 volume은 1 고정', () => {
    expect(currentPropValue(text, 'volume')).toBe(1);
  });
});

// ── W5 (X3-A) ─────────────────────────────────────────────────────────────

describe('W5 효과 파라미터 메타', () => {
  it('신규 11종이 모두 EFFECT_TYPES 에 있고 메타가 있다', () => {
    const w5 = [
      'temperature', 'tint', 'exposure', 'highlights', 'shadows', 'sharpen',
      'glow', 'grain', 'scanlines', 'chromaShift', 'lightLeak',
    ] as const;
    // W8 F16 이 뒤에 30종을 더 붙였다 — 앞 20종은 그대로다.
    expect(EFFECT_TYPES.length).toBeGreaterThanOrEqual(20);
    for (const t of w5) {
      expect(EFFECT_TYPES).toContain(t);
      expect(EFFECT_PARAM_DEFS[t].length).toBeGreaterThan(0);
      expect(EFFECT_LABELS[t].length).toBeGreaterThan(0);
    }
  });

  it('계획 X1 의 기본값·범위 그대로', () => {
    expect(defaultEffectParams('temperature')).toEqual({ amount: 0 });
    expect(defaultEffectParams('tint')).toEqual({ amount: 0 });
    expect(defaultEffectParams('exposure')).toEqual({ stops: 0 });
    expect(defaultEffectParams('highlights')).toEqual({ amount: 0 });
    expect(defaultEffectParams('shadows')).toEqual({ amount: 0 });
    expect(defaultEffectParams('sharpen')).toEqual({ amount: 0 });
    expect(defaultEffectParams('glow')).toEqual({ amount: 0.5, radius: 16 });
    expect(defaultEffectParams('grain')).toEqual({ amount: 0.3 });
    expect(defaultEffectParams('scanlines')).toEqual({ amount: 0.3, lines: 600 });
    expect(defaultEffectParams('chromaShift')).toEqual({ px: 4 });
    expect(defaultEffectParams('lightLeak')).toEqual({ amount: 0.4, hue: 30 });
  });

  it('양방향 효과의 min 은 -1, exposure 는 -2..2, lines 는 100..2000', () => {
    for (const t of ['temperature', 'tint', 'highlights', 'shadows'] as const) {
      const d = EFFECT_PARAM_DEFS[t][0]!;
      expect([d.min, d.max]).toEqual([-1, 1]);
    }
    const stops = EFFECT_PARAM_DEFS.exposure[0]!;
    expect([stops.key, stops.min, stops.max]).toEqual(['stops', -2, 2]);
    const lines = EFFECT_PARAM_DEFS.scanlines.find((d) => d.key === 'lines')!;
    expect([lines.min, lines.max]).toEqual([100, 2000]);
    const hue = EFFECT_PARAM_DEFS.lightLeak.find((d) => d.key === 'hue')!;
    expect([hue.min, hue.max]).toEqual([0, 360]);
  });

  it('전환 51종 전부 한국어 라벨이 있다', () => {
    expect(TRANSITION_TYPES.length).toBe(51);
    for (const t of TRANSITION_TYPES) {
      expect(TRANSITION_LABELS[t]).toBeTruthy();
      expect(TRANSITION_LABELS[t]).not.toBe(t);
    }
  });
});

describe('색조정 커브 편집', () => {
  it('normalizeCurve: x 오름차순 정렬 + 0..1 클램프', () => {
    expect(normalizeCurve([{ x: 1, y: 1 }, { x: 0.5, y: 1.4 }, { x: -0.2, y: -3 }])).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it('normalizeCurve: x 가 겹치는 점은 하나만 남는다', () => {
    const out = normalizeCurve([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.9 },
      { x: 0.5001, y: 0.1 },
      { x: 1, y: 1 },
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.x)).toEqual([0, 0.5, 1]);
    for (let i = 1; i < out.length; i++) expect(out[i]!.x).toBeGreaterThan(out[i - 1]!.x);
  });

  it('moveCurvePoint: 양 끝점은 x 가 고정되고 y 만 바뀐다', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    expect(moveCurvePoint(pts, 0, 0.7, 0.25)).toEqual([
      { x: 0, y: 0.25 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ]);
    expect(moveCurvePoint(pts, 2, 0.2, 0.6)[2]).toEqual({ x: 1, y: 0.6 });
  });

  it('moveCurvePoint: 가운데 점은 이웃을 넘지 못한다', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.3, y: 0.4 }, { x: 0.6, y: 0.7 }, { x: 1, y: 1 }];
    const pushedLeft = moveCurvePoint(pts, 2, -5, 0.5);
    expect(pushedLeft[2]!.x).toBeGreaterThan(pushedLeft[1]!.x);
    const pushedRight = moveCurvePoint(pts, 1, 5, 0.5);
    expect(pushedRight[1]!.x).toBeLessThan(pushedRight[2]!.x);
    expect(pushedRight[1]!.y).toBe(0.5);
  });

  it('addCurvePoint: 추가 후에도 오름차순, 너무 가까우면 무시', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const added = addCurvePoint(pts, 0.4, 0.8);
    expect(added).toHaveLength(3);
    expect(added[1]).toEqual({ x: 0.4, y: 0.8 });
    expect(addCurvePoint(added, 0.401, 0.2)).toHaveLength(3); // 간격 미달 → 그대로
  });

  it('removeCurvePoint: 가운데만 지워지고 양 끝점은 남는다', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.4, y: 0.8 }, { x: 1, y: 1 }];
    expect(removeCurvePoint(pts, 1)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(removeCurvePoint(pts, 0)).toHaveLength(3);
    expect(removeCurvePoint(pts, 2)).toHaveLength(3);
  });

  it('setCurveChannel: 항등 커브는 채널을 지우고, 마지막 채널이 사라지면 null', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }];
    expect(isIdentityCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(true);
    expect(isIdentityCurve(pts)).toBe(false);

    const withRgb = setCurveChannel(undefined, 'rgb', pts);
    expect(withRgb).toEqual({ rgb: pts });
    const withBoth = setCurveChannel(withRgb ?? undefined, 'r', pts);
    expect(Object.keys(withBoth ?? {}).sort()).toEqual(['r', 'rgb']);
    expect(setCurveChannel(withBoth ?? undefined, 'r', null)).toEqual({ rgb: pts });
    // 항등 커브는 채널 삭제와 같다
    expect(setCurveChannel(withRgb ?? undefined, 'rgb', [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    expect(setCurveChannel(withRgb ?? undefined, 'rgb', null)).toBeNull();
  });

  it('curvePath: 항등 커브는 좌하단→우상단 직선', () => {
    const d = curvePath([{ x: 0, y: 0 }, { x: 1, y: 1 }], 100, 100);
    expect(d.startsWith('M0.00,100.00')).toBe(true);
    expect(d.endsWith('L100.00,0.00')).toBe(true);
    // 중간 지점도 대각선 위 (33개 샘플)
    expect(d).toContain('L50.00,50.00');
  });
});

describe('파생 미디어 대기 판정', () => {
  const base: VideoClip = {
    id: 'v1', kind: 'video', assetId: 'a1',
    start: 0, duration: 2000, in: 0, out: 2000, speed: 1, volume: 1,
  };
  const asset = (derived?: Record<string, { src: string }>): Asset => ({
    id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1', ...(derived ? { derived } : {}),
  });

  it('source 가 없으면 대기 아님', () => {
    expect(derivePending(base, asset())).toBe(false);
  });

  it('source 는 있는데 derived 가 없으면 대기', () => {
    const clip: VideoClip = { ...base, source: { denoise: { amount: 0.5 } } };
    expect(derivePending(clip, asset())).toBe(true);
    expect(derivePending(clip, undefined)).toBe(true);
  });

  it('derived[sourceKey] 가 생기면 대기 해제 — 다른 키는 소용없다', () => {
    const clip: VideoClip = { ...base, source: { denoise: { amount: 0.5 } } };
    const key = sourceKey(clip)!;
    expect(key).toMatch(/^s[0-9a-f]{8}$/);
    expect(derivePending(clip, asset({ [key]: { src: `derived/a1.${key}.mp4` } }))).toBe(false);
    expect(derivePending(clip, asset({ sdeadbeef: { src: 'derived/x.mp4' } }))).toBe(true);
  });

  it('스펙을 바꾸면 다시 대기 상태가 된다', () => {
    const clip: VideoClip = { ...base, source: { denoise: { amount: 0.5 } } };
    const a = asset({ [sourceKey(clip)!]: { src: 'derived/a1.k.mp4' } });
    const changed: VideoClip = { ...base, source: { denoise: { amount: 0.6 } } };
    expect(derivePending(clip, a)).toBe(false);
    expect(derivePending(changed, a)).toBe(true);
  });

  it('normalizeClipSource: 빈 스펙은 null, smoothing 은 1..100 정수', () => {
    expect(normalizeClipSource({})).toBeNull();
    expect(normalizeClipSource({ stabilize: { smoothing: 12.7 } })).toEqual({ stabilize: { smoothing: 13 } });
    expect(normalizeClipSource({ stabilize: { smoothing: 500 } })).toEqual({ stabilize: { smoothing: 100 } });
    expect(normalizeClipSource({ denoise: { amount: 1.5 }, pitch: { semitones: -40 } })).toEqual({
      denoise: { amount: 1 },
      pitch: { semitones: -12 },
    });
  });

  // ── W8 F11 나레이션 체인 ──
  it("normalizeClipSource: voice 를 보존하고 preset 'off' 는 필드째 지운다", () => {
    expect(normalizeClipSource({ voice: { preset: 'broadcast' } })).toEqual({
      voice: { preset: 'broadcast' },
    });
    // 'off' 만 남으면 스펙이 비어 null — 필요 없는 파생을 안 만든다
    expect(normalizeClipSource({ voice: { preset: 'off' } })).toBeNull();
    expect(normalizeClipSource({ denoise: { amount: 0.5 }, voice: { preset: 'off' } })).toEqual({
      denoise: { amount: 0.5 },
    });
  });

  it('normalizeClipSource: targetLufs 는 -30..-9, reverb.wet 은 0..1 로 클램프', () => {
    expect(
      normalizeClipSource({
        voice: { preset: 'podcast', targetLufs: -50, reverb: { irId: 'voxengo/ruby-room', wet: 2 } },
      }),
    ).toEqual({
      voice: { preset: 'podcast', targetLufs: -30, reverb: { irId: 'voxengo/ruby-room', wet: 1 } },
    });
    expect(normalizeClipSource({ voice: { preset: 'warm', targetLufs: 0 } })).toEqual({
      voice: { preset: 'warm', targetLufs: -9 },
    });
  });

  // ── W8 F11-분리 음량 맞춤(loudness) — voice 와 별개 필드 ──
  it('normalizeClipSource: loudness 는 그대로 살아남는다', () => {
    expect(normalizeClipSource({ loudness: { targetLufs: -24 } })).toEqual({
      loudness: { targetLufs: -24 },
    });
  });

  it('normalizeClipSource: loudness 는 다른 필드가 섞여 있어도 안 사라진다', () => {
    expect(
      normalizeClipSource({
        loudness: { targetLufs: -24 },
        voice: { preset: 'podcast' },
        denoise: { amount: 0.5 },
      }),
    ).toEqual({
      loudness: { targetLufs: -24 },
      voice: { preset: 'podcast' },
      denoise: { amount: 0.5 },
    });
  });

  it('normalizeClipSource: loudness.targetLufs 도 -30..-9 로 클램프', () => {
    expect(normalizeClipSource({ loudness: { targetLufs: -50 } })).toEqual({
      loudness: { targetLufs: -30 },
    });
    expect(normalizeClipSource({ loudness: { targetLufs: 0 } })).toEqual({
      loudness: { targetLufs: -9 },
    });
  });

  it('normalizeClipSource: loudness 가 없으면 생기지 않는다', () => {
    expect(normalizeClipSource({ denoise: { amount: 0.5 } })).toEqual({
      denoise: { amount: 0.5 },
    });
  });
});

describe('속도 램프 포인트 편집', () => {
  it('normalizeRampPoints: u 오름차순 + 첫 0 · 마지막 1 + speed 클램프', () => {
    expect(normalizeRampPoints([
      { u: 1, speed: 200 },
      { u: 0.5, speed: 0.01 },
      { u: 0.2, speed: 2 },
    ])).toEqual([
      { u: 0, speed: 2 },
      { u: 0.5, speed: 0.1 },
      { u: 1, speed: 100 },
    ]);
  });

  it('insertRampPoint: 가장 넓은 간격 한가운데에 넣는다', () => {
    const out = insertRampPoint([{ u: 0, speed: 1 }, { u: 0.2, speed: 2 }, { u: 1, speed: 1 }]);
    expect(out).toHaveLength(4);
    expect(out[2]).toEqual({ u: 0.6, speed: 1.5 });
    for (let i = 1; i < out.length; i++) expect(out[i]!.u).toBeGreaterThan(out[i - 1]!.u);
  });

  it('removeRampPoint: 양 끝점은 지울 수 없다', () => {
    const pts = [{ u: 0, speed: 1 }, { u: 0.5, speed: 4 }, { u: 1, speed: 1 }];
    expect(removeRampPoint(pts, 1)).toEqual([{ u: 0, speed: 1 }, { u: 1, speed: 1 }]);
    expect(removeRampPoint(pts, 0)).toHaveLength(3);
    expect(removeRampPoint(pts, 2)).toHaveLength(3);
  });
});
