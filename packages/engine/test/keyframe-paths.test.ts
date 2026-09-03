import { describe, expect, it } from 'vitest';
import {
  EASING_PRESETS,
  createEmptyProject,
  easingFn,
  type Asset,
  type Clip,
  type Easing,
  type Keyframe,
  type ProjectDoc,
  type VideoClip,
} from '@kitkat/schema';
import { EngineError, applyCommands, checkInvariants, findClip } from '../src/index.js';

const vAsset: Asset = { id: 'av', kind: 'video', src: 'assets/av.mp4', name: 'av.mp4', duration: 10000 };

function setup(clip: Partial<VideoClip> = {}): { doc: ProjectDoc; trackId: string } {
  let doc = createEmptyProject({ name: 'S1 경로' });
  const trackId = doc.tracks[0]!.id;
  doc = applyCommands(doc, [{ type: 'addAsset', asset: vAsset }]);
  const c: VideoClip = {
    id: 'c1', kind: 'video', assetId: 'av', start: 0, duration: 2000,
    in: 0, out: 2000, speed: 1, volume: 1, ...clip,
  };
  doc = applyCommands(doc, [{ type: 'addClip', trackId, clip: c }]);
  return { doc, trackId };
}

function expectBadKeyframe(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe('BAD_KEYFRAME');
    return e as EngineError;
  }
  throw new Error('BAD_KEYFRAME 이 던져지지 않았습니다');
}

const kf = (time: number, prop: string, value: number, easing: Easing = 'linear'): Keyframe =>
  ({ time, prop, value, easing });

// ── setKeyframes 검증 ─────────────────────────────────────────────────────

describe('setKeyframes — 화이트리스트 (W8 S1)', () => {
  it('기존 6종은 그대로 통과 (하위호환)', () => {
    const { doc } = setup();
    const next = applyCommands(doc, [
      { type: 'setKeyframes', clipId: 'c1', keyframes: [
        kf(0, 'x', 0), kf(500, 'y', 0.1), kf(1000, 'scale', 2),
        kf(1200, 'rotation', 90), kf(1500, 'opacity', 0.5), kf(2000, 'volume', 1.5),
      ] },
    ]);
    expect(next.tracks[0]!.clips[0]!.keyframes!.length).toBe(6);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('새 경로: 효과 파라미터·마스크·크로마키·크롭', () => {
    const { doc } = setup({
      effects: [{ id: 'e1', type: 'brightness', params: { amount: 1 } }],
      mask: { shape: 'rect', feather: 0.1, x: 0, y: 0, w: 1, h: 1 },
      chromaKey: { color: '#00ff00', similarity: 0.4, smoothness: 0.1, spill: 0.5 },
      crop: { x: 0, y: 0, w: 1, h: 1 },
    });
    const next = applyCommands(doc, [
      { type: 'setKeyframes', clipId: 'c1', keyframes: [
        kf(0, 'effects#e1.params.amount', 0.5), kf(1000, 'effects#e1.params.amount', 1.5),
        kf(0, 'mask.x', 0), kf(1000, 'mask.x', 0.5),
        kf(0, 'chromaKey.similarity', 0.2), kf(0, 'crop.w', 0.8),
      ] },
    ]);
    expect(next.tracks[0]!.clips[0]!.keyframes!.length).toBe(6);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('source.* 는 전용 안내와 함께 거부', () => {
    const { doc } = setup({ source: { lut: { assetId: 'av', intensity: 1 } } });
    const e = expectBadKeyframe(() =>
      applyCommands(doc, [{ type: 'setKeyframes', clipId: 'c1', keyframes: [kf(0, 'source.lut.intensity', 0.5)] }]),
    );
    expect(e.message).toContain('영상 파일을 새로 굽는 설정');
    expect(e.message).toContain('effects');
  });

  it('오타·허용 목록 밖·다른 클립 종류의 경로는 BAD_KEYFRAME', () => {
    const { doc } = setup({ mask: { shape: 'rect', feather: 0.1, x: 0, y: 0, w: 1, h: 1 } });
    for (const p of ['mask.wdith', 'curves.rgb', 'speed', 'start', 'style.fontSize',
                     '__proto__.x', 'constructor.prototype.x']) {
      expectBadKeyframe(() =>
        applyCommands(doc, [{ type: 'setKeyframes', clipId: 'c1', keyframes: [kf(0, p, 1)] }]),
      );
    }
  });

  it('effects[N] 인덱스 경로는 거부하고 «id 를 쓰라»고 말한다', () => {
    const { doc } = setup({ effects: [{ id: 'e1', type: 'brightness', params: { amount: 1 } }] });
    const e = expectBadKeyframe(() =>
      applyCommands(doc, [{ type: 'setKeyframes', clipId: 'c1', keyframes: [kf(0, 'effects[0].params.amount', 1)] }]),
    );
    expect(e.message).toContain('id 로 가리킵니다');
  });

  it('없는 효과 id 는 «대상 실재» 검사에 걸린다', () => {
    const { doc } = setup({ effects: [{ id: 'e1', type: 'brightness', params: { amount: 1 } }] });
    expectBadKeyframe(() =>
      applyCommands(doc, [{ type: 'setKeyframes', clipId: 'c1', keyframes: [kf(0, 'effects#없는id.params.amount', 1)] }]),
    );
  });

  it('마스크를 안 켜고 마스크 키프레임을 걸면 거부', () => {
    const { doc } = setup();
    expectBadKeyframe(() =>
      applyCommands(doc, [{ type: 'setKeyframes', clipId: 'c1', keyframes: [kf(0, 'mask.x', 0.5)] }]),
    );
  });

  it('text 클립에 volume, audio 클립에 x 는 거부', () => {
    let doc = createEmptyProject({ name: 't' });
    const tt = doc.tracks[1]!.id;
    doc = applyCommands(doc, [{ type: 'addClip', trackId: tt, clip: {
      id: 't1', kind: 'text', start: 0, duration: 1000, text: '자막',
      style: { fontFamily: 'Pretendard', fontSize: 64, color: '#ffffff', align: 'center' },
    } as Clip }]);
    expectBadKeyframe(() =>
      applyCommands(doc, [{ type: 'setKeyframes', clipId: 't1', keyframes: [kf(0, 'volume', 1)] }]),
    );
    // text 의 style.* 는 허용
    const ok = applyCommands(doc, [{ type: 'setKeyframes', clipId: 't1', keyframes: [
      kf(0, 'style.fontSize', 40), kf(1000, 'style.fontSize', 120),
    ] }]);
    expect(ok.tracks[1]!.clips[0]!.keyframes!.length).toBe(2);
  });

  it('스프링·베지어 이징이 든 키프레임도 저장된다', () => {
    const { doc } = setup();
    const next = applyCommands(doc, [{ type: 'setKeyframes', clipId: 'c1', keyframes: [
      kf(0, 'x', 0, { spring: { damping: 8 } }),
      kf(1000, 'x', 0.5, { bezier: [0.34, 1.56, 0.64, 1] }),
      kf(2000, 'x', 0, 'easeInOut'),
    ] }]);
    expect(next.tracks[0]!.clips[0]!.keyframes![0]!.easing).toEqual({ spring: { damping: 8 } });
  });
});

// ── splitClip · trimClip 이 새 경로를 올바로 재분배하는지 ─────────────────

/** 어떤 클립이든 t(클립 상대 ms) 시점의 경로 값 — 렌더러와 같은 규칙 */
function valueAt(clip: Clip, prop: string, t: number, fallback: number): number {
  const list = (clip.keyframes ?? []).filter((k) => k.prop === prop).sort((a, b) => a.time - b.time);
  if (list.length === 0) return fallback;
  const first = list[0]!;
  const last = list[list.length - 1]!;
  if (t <= first.time) return first.value;
  if (t >= last.time) return last.value;
  for (let i = 0; i < list.length - 1; i++) {
    const from = list[i]!;
    const to = list[i + 1]!;
    if (t >= from.time && t <= to.time) {
      if (to.time === from.time) return to.value;
      const u = (t - from.time) / (to.time - from.time);
      return from.value + (to.value - from.value) * easingFn(from.easing)(u);
    }
  }
  return last.value;
}

const PATHS = [
  'x', 'y', 'scale', 'rotation', 'opacity', 'volume',
  'crop.x', 'crop.w', 'mask.x', 'mask.y', 'mask.feather',
  'chromaKey.similarity', 'chromaKey.smoothness',
  'effects#e1.params.amount', 'effects#e2.params.px',
];

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomClip(rnd: () => number, duration: number, linearOnly = false): VideoClip {
  const props = [...PATHS].sort(() => rnd() - 0.5).slice(0, 5);
  const kfs: Keyframe[] = [];
  for (const prop of props) {
    const n = 3 + Math.floor(rnd() * 6); // 3..8
    const times = new Set<number>();
    while (times.size < n) times.add(Math.floor(rnd() * (duration + 1)));
    for (const time of [...times].sort((a, b) => a - b)) {
      const easing: Easing = linearOnly
        ? 'linear'
        : EASING_PRESETS[Math.floor(rnd() * EASING_PRESETS.length)]!.easing;
      kfs.push({ time, prop, value: Math.round(rnd() * 2000) / 1000, easing });
    }
  }
  kfs.sort((a, b) => a.time - b.time);
  return {
    id: 'c1', kind: 'video', assetId: 'av', start: 0, duration,
    in: 0, out: duration, speed: 1, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    mask: { shape: 'rect', feather: 0.1, x: 0, y: 0, w: 1, h: 1 },
    chromaKey: { color: '#00ff00', similarity: 0.4, smoothness: 0.1, spill: 0.5 },
    effects: [
      { id: 'e1', type: 'brightness', params: { amount: 1 } },
      { id: 'e2', type: 'blur', params: { px: 4 } },
    ],
    keyframes: kfs,
  };
}

describe('splitClip / trimClip — 새 경로 키프레임 재분배', () => {
  it('무작위 200회(linear): 분할 전후로 «같은 절대 시각의 값»이 1e-9 이내로 같다', () => {
    const rnd = mulberry(20260902);
    let fails = 0;
    for (let iter = 0; iter < 200; iter++) {
      const duration = 400 + Math.floor(rnd() * 600);
      const clip = randomClip(rnd, duration, true);
      let doc = createEmptyProject({ name: 'split' });
      const trackId = doc.tracks[0]!.id;
      doc = applyCommands(doc, [{ type: 'addAsset', asset: vAsset }, { type: 'addClip', trackId, clip }]);
      const at = 1 + Math.floor(rnd() * (duration - 2));
      const next = applyCommands(doc, [{ type: 'splitClip', clipId: 'c1', at, newClipId: 'c2' }]);
      const left = findClip(next, 'c1')!.clip;
      const right = findClip(next, 'c2')!.clip;
      const props = new Set((clip.keyframes ?? []).map((k) => k.prop));
      for (const prop of props) {
        for (let t = 0; t <= duration; t++) {
          const before = valueAt(clip, prop, t, 0);
          const after = t < at ? valueAt(left, prop, t, 0) : valueAt(right, prop, t - at, 0);
          if (Math.abs(before - after) >= 1e-9) fails++;
        }
      }
    }
    expect(fails).toBe(0);
  });

  it('trimClip(start, linear): 잘린 뒤의 값이 원래와 같다', () => {
    const rnd = mulberry(7);
    let fails = 0;
    for (let iter = 0; iter < 100; iter++) {
      const duration = 500 + Math.floor(rnd() * 500);
      const clip = randomClip(rnd, duration, true);
      let doc = createEmptyProject({ name: 'trim' });
      const trackId = doc.tracks[0]!.id;
      doc = applyCommands(doc, [{ type: 'addAsset', asset: vAsset }, { type: 'addClip', trackId, clip }]);
      const delta = 1 + Math.floor(rnd() * (duration / 2));
      const next = applyCommands(doc, [{ type: 'trimClip', clipId: 'c1', edge: 'start', to: delta }]);
      const trimmed = findClip(next, 'c1')!.clip;
      const props = new Set((clip.keyframes ?? []).map((k) => k.prop));
      for (const prop of props) {
        for (let t = delta; t <= duration; t++) {
          if (Math.abs(valueAt(clip, prop, t, 0) - valueAt(trimmed, prop, t - delta, 0)) >= 1e-9) fails++;
        }
      }
    }
    expect(fails).toBe(0);
  });

  it('trimClip(end): 남은 구간의 값이 원래와 같다 (이징 무작위)', () => {
    const rnd = mulberry(11);
    let fails = 0;
    for (let iter = 0; iter < 100; iter++) {
      const duration = 500 + Math.floor(rnd() * 500);
      const clip = randomClip(rnd, duration);
      let doc = createEmptyProject({ name: 'trim2' });
      const trackId = doc.tracks[0]!.id;
      doc = applyCommands(doc, [{ type: 'addAsset', asset: vAsset }, { type: 'addClip', trackId, clip }]);
      const to = Math.floor(duration / 2) + Math.floor(rnd() * (duration / 4));
      const next = applyCommands(doc, [{ type: 'trimClip', clipId: 'c1', edge: 'end', to }]);
      const trimmed = findClip(next, 'c1')!.clip;
      const props = new Set((clip.keyframes ?? []).map((k) => k.prop));
      for (const prop of props) {
        for (let t = 0; t <= to; t++) {
          if (Math.abs(valueAt(clip, prop, t, 0) - valueAt(trimmed, prop, t, 0)) >= 1e-9) fails++;
        }
      }
    }
    expect(fails).toBe(0);
  });

  // splitKeyframes/rebaseKeyframes 가 «수정 불필요»라는 것의 진짜 근거:
  // prop 을 문자열로만 다루므로, 경로 문자열을 넣든 기존 6종을 넣든 «똑같이» 동작한다.
  it('경로 무관성: 새 경로와 기존 prop 의 분할 결과가 (이름만 빼고) 완전히 같다 — 이징 무작위 100회', () => {
    const rnd = mulberry(4242);
    for (let iter = 0; iter < 100; iter++) {
      const duration = 400 + Math.floor(rnd() * 600);
      const base = randomClip(rnd, duration);
      // 같은 키프레임을 «한 경로»에 모아 두 벌 만든다: 새 경로 vs 기존 prop
      const times = [...new Set((base.keyframes ?? []).map((k) => k.time))].sort((a, b) => a - b);
      const src = times.map((time, i): Keyframe => ({
        time, prop: 'PLACEHOLDER',
        value: base.keyframes![i % base.keyframes!.length]!.value,
        easing: base.keyframes![i % base.keyframes!.length]!.easing,
      }));
      const make = (prop: string): VideoClip => ({ ...base, keyframes: src.map((k) => ({ ...k, prop })) });
      const at = 1 + Math.floor(rnd() * (duration - 2));

      const run = (clip: VideoClip): Keyframe[][] => {
        let doc = createEmptyProject({ name: 'agnostic' });
        const trackId = doc.tracks[0]!.id;
        doc = applyCommands(doc, [{ type: 'addAsset', asset: vAsset }, { type: 'addClip', trackId, clip }]);
        const next = applyCommands(doc, [{ type: 'splitClip', clipId: 'c1', at, newClipId: 'c2' }]);
        return [findClip(next, 'c1')!.clip.keyframes ?? [], findClip(next, 'c2')!.clip.keyframes ?? []];
      };

      const legacy = run(make('x'));
      const newPath = run(make('effects#e1.params.amount'));
      const strip = (kfs: Keyframe[]) => kfs.map(({ prop, ...rest }) => rest);
      expect(strip(newPath[0]!)).toEqual(strip(legacy[0]!));
      expect(strip(newPath[1]!)).toEqual(strip(legacy[1]!));
      expect(newPath[0]!.every((k) => k.prop === 'effects#e1.params.amount')).toBe(true);
    }
  });

  it('분할점의 값은 어떤 이징이든 정확히 보존된다 (경계 키프레임)', () => {
    const rnd = mulberry(99);
    for (let iter = 0; iter < 50; iter++) {
      const duration = 400 + Math.floor(rnd() * 600);
      const clip = randomClip(rnd, duration);
      let doc = createEmptyProject({ name: 'boundary-value' });
      const trackId = doc.tracks[0]!.id;
      doc = applyCommands(doc, [{ type: 'addAsset', asset: vAsset }, { type: 'addClip', trackId, clip }]);
      const at = 1 + Math.floor(rnd() * (duration - 2));
      const next = applyCommands(doc, [{ type: 'splitClip', clipId: 'c1', at, newClipId: 'c2' }]);
      const right = findClip(next, 'c2')!.clip;
      for (const prop of new Set((clip.keyframes ?? []).map((k) => k.prop))) {
        expect(valueAt(right, prop, 0, 0)).toBeCloseTo(valueAt(clip, prop, at, 0), 9);
      }
    }
  });

  it('경로가 섞여 있어도 prop 별로 «구별»만 한다 — 경계 키프레임이 경로마다 하나씩 생긴다', () => {
    const clip = randomClip(mulberry(3), 1000);
    let doc = createEmptyProject({ name: 'boundary' });
    const trackId = doc.tracks[0]!.id;
    doc = applyCommands(doc, [{ type: 'addAsset', asset: vAsset }, { type: 'addClip', trackId, clip }]);
    const next = applyCommands(doc, [{ type: 'splitClip', clipId: 'c1', at: 500, newClipId: 'c2' }]);
    const right = findClip(next, 'c2')!.clip;
    const props = new Set((clip.keyframes ?? []).map((k) => k.prop));
    for (const prop of props) {
      const atZero = (right.keyframes ?? []).filter((k) => k.prop === prop && k.time === 0);
      expect(atZero.length, prop).toBeGreaterThanOrEqual(1);
    }
  });
});
