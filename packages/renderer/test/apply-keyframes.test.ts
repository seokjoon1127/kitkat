import { describe, expect, it } from 'vitest';
import type { Asset, ImageClip, Keyframe, TextClip, VideoClip } from '@kitkat/schema';
import { applyKeyframes, groupKeyframes, interpolateKeyframes } from '../src/composition/keyframes.js';
import { computeVisualLayout } from '../src/layout/index.js';

const asset: Asset = { id: 'a1', kind: 'video', src: 'a.mp4', name: 'a.mp4', duration: 5000, width: 1080, height: 1920 };

const vclip = (extra?: Partial<VideoClip>): VideoClip => ({
  id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 1000,
  in: 0, out: 1000, speed: 1, volume: 1, ...extra,
});

describe('applyKeyframes', () => {
  it('키프레임이 없으면 «같은 객체»를 돌려준다 (할당 0)', () => {
    const c = vclip();
    expect(applyKeyframes(c, 500)).toBe(c);
    const empty = vclip({ keyframes: [] });
    expect(applyKeyframes(empty, 500)).toBe(empty);
    // 값이 안 바뀌는 시각에도 새 객체를 만들지 않는다
    const flat = vclip({ transform: { x: 0.5, y: 0, scale: 1, rotation: 0 },
      keyframes: [{ time: 0, prop: 'x', value: 0.5, easing: 'linear' }] });
    expect(applyKeyframes(flat, 500)).toBe(flat);
  });

  it('기존 6종: transform 이 없어도 기본값에서 시작해 만들어 넣는다', () => {
    const c = vclip({ keyframes: [
      { time: 0, prop: 'x', value: 0, easing: 'linear' },
      { time: 1000, prop: 'x', value: 0.5, easing: 'linear' },
    ] });
    expect(applyKeyframes(c, 500).transform).toEqual({ x: 0.25, y: 0, scale: 1, rotation: 0 });
    expect(c.transform).toBeUndefined(); // 원본 불변
  });

  it('효과 파라미터 경로', () => {
    const c = vclip({
      effects: [{ id: 'e1', type: 'brightness', params: { amount: 1 } }],
      keyframes: [
        { time: 0, prop: 'effects#e1.params.amount', value: 0.5, easing: 'linear' },
        { time: 1000, prop: 'effects#e1.params.amount', value: 1.5, easing: 'linear' },
      ],
    });
    expect(applyKeyframes(c, 0).effects![0]!.params.amount).toBe(0.5);
    expect(applyKeyframes(c, 500).effects![0]!.params.amount).toBe(1);
    expect(applyKeyframes(c, 1000).effects![0]!.params.amount).toBe(1.5);
  });

  it('마스크·크로마키·크롭 경로', () => {
    const c = vclip({
      mask: { shape: 'rect', feather: 0, x: 0, y: 0, w: 1, h: 1 },
      chromaKey: { color: '#00ff00', similarity: 0.2, smoothness: 0.1, spill: 0.5 },
      crop: { x: 0, y: 0, w: 1, h: 1 },
      keyframes: [
        { time: 0, prop: 'mask.x', value: 0, easing: 'linear' },
        { time: 1000, prop: 'mask.x', value: 0.5, easing: 'linear' },
        { time: 0, prop: 'chromaKey.similarity', value: 0.2, easing: 'linear' },
        { time: 1000, prop: 'chromaKey.similarity', value: 0.6, easing: 'linear' },
        { time: 0, prop: 'crop.w', value: 1, easing: 'linear' },
        { time: 1000, prop: 'crop.w', value: 0.5, easing: 'linear' },
      ],
    });
    const c2 = applyKeyframes(c, 500);
    expect(c2.mask!.x).toBe(0.25);
    expect(c2.chromaKey!.similarity).toBeCloseTo(0.4, 12);
    expect(c2.crop!.w).toBe(0.75);
  });

  it('대상이 사라진 경로는 «무동작» — 문서에는 남아 있다', () => {
    const c = vclip({ keyframes: [
      { time: 0, prop: 'mask.x', value: 0, easing: 'linear' },
      { time: 1000, prop: 'mask.x', value: 0.5, easing: 'linear' },
    ] }); // mask 를 껐다
    const out = applyKeyframes(c, 500);
    expect(out.mask).toBeUndefined();
    expect(out.keyframes!.length).toBe(2);
  });

  it('여러 경로를 동시에 반영한다', () => {
    const c = vclip({
      effects: [{ id: 'e1', type: 'blur', params: { px: 0 } }],
      keyframes: [
        { time: 0, prop: 'x', value: 0, easing: 'linear' },
        { time: 1000, prop: 'x', value: 1, easing: 'linear' },
        { time: 0, prop: 'opacity', value: 1, easing: 'linear' },
        { time: 1000, prop: 'opacity', value: 0, easing: 'linear' },
        { time: 0, prop: 'effects#e1.params.px', value: 0, easing: 'linear' },
        { time: 1000, prop: 'effects#e1.params.px', value: 20, easing: 'linear' },
      ],
    });
    const out = applyKeyframes(c, 250);
    expect(out.transform!.x).toBe(0.25);
    expect(out.opacity).toBe(0.75);
    expect(out.effects![0]!.params.px).toBe(5);
  });

  it('image·text 클립에도 쓸 수 있다', () => {
    const img: ImageClip = { id: 'i1', kind: 'image', assetId: 'a1', start: 0, duration: 1000,
      keyframes: [{ time: 0, prop: 'scale', value: 2, easing: 'linear' }] };
    expect(applyKeyframes(img, 0).transform!.scale).toBe(2);

    const txt: TextClip = { id: 't1', kind: 'text', start: 0, duration: 1000, text: '안녕',
      style: { fontFamily: 'Pretendard', fontSize: 40, color: '#fff', align: 'center' },
      keyframes: [
        { time: 0, prop: 'style.fontSize', value: 40, easing: 'linear' },
        { time: 1000, prop: 'style.fontSize', value: 120, easing: 'linear' },
      ] };
    expect(applyKeyframes(txt, 500).style.fontSize).toBe(80);
    expect(txt.style.fontSize).toBe(40); // 원본 불변
  });
});

describe('computeVisualLayout — 키프레임을 한 곳에서 통과시킨다', () => {
  const base = { asset, canvasW: 1080, canvasH: 1920 };

  it('기존 x/y/scale/rotation/opacity 회귀 — 값이 그대로', () => {
    const c = vclip({
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      keyframes: [
        { time: 0, prop: 'x', value: 0, easing: 'easeInOut' },
        { time: 1000, prop: 'x', value: 0.5, easing: 'linear' },
        { time: 0, prop: 'opacity', value: 1, easing: 'linear' },
        { time: 1000, prop: 'opacity', value: 0, easing: 'linear' },
      ],
    });
    const l = computeVisualLayout({ ...base, clip: c, tMs: 400 });
    const x = interpolateKeyframes(c.keyframes, 'x', 400, 0);
    expect(l.box.left).toBe((1080 - 1080) / 2 + x * 1080);
    expect(l.opacity).toBe(0.6);
  });

  it('효과 파라미터 키프레임이 cssFilter 에 반영된다', () => {
    const c = vclip({
      effects: [{ id: 'e1', type: 'brightness', params: { amount: 1 } }],
      keyframes: [
        { time: 0, prop: 'effects#e1.params.amount', value: 0.5, easing: 'linear' },
        { time: 1000, prop: 'effects#e1.params.amount', value: 1.5, easing: 'linear' },
      ],
    });
    const f0 = computeVisualLayout({ ...base, clip: c, tMs: 0 }).cssFilter;
    const f5 = computeVisualLayout({ ...base, clip: c, tMs: 500 }).cssFilter;
    const f10 = computeVisualLayout({ ...base, clip: c, tMs: 1000 }).cssFilter;
    expect(f0).toContain('brightness(0.5)');
    expect(f5).toContain('brightness(1)');
    expect(f10).toContain('brightness(1.5)');
  });

  it('마스크·크롭 키프레임이 레이아웃에 반영된다', () => {
    const c = vclip({
      crop: { x: 0, y: 0, w: 1, h: 1 },
      mask: { shape: 'rect', feather: 0, x: 0, y: 0, w: 1, h: 1 },
      keyframes: [
        { time: 0, prop: 'mask.x', value: 0, easing: 'linear' },
        { time: 1000, prop: 'mask.x', value: 0.5, easing: 'linear' },
        { time: 0, prop: 'crop.w', value: 1, easing: 'linear' },
        { time: 1000, prop: 'crop.w', value: 0.5, easing: 'linear' },
      ],
    });
    const l = computeVisualLayout({ ...base, clip: c, tMs: 1000 });
    expect(l.mask!.x).toBe(0.5);
    expect(l.box.width).toBe(1080 * 0.5);
  });

  it('키프레임이 없는 클립의 레이아웃은 변경 전과 같다 (회귀)', () => {
    const c = vclip({ transform: { x: 0.1, y: -0.2, scale: 1.5, rotation: 30 }, opacity: 0.8 });
    const l = computeVisualLayout({ ...base, clip: c, tMs: 500 });
    expect(l.scaleX).toBe(1.5);
    expect(l.rotationDeg).toBe(30);
    expect(l.opacity).toBe(0.8);
    expect(l.box.left).toBeCloseTo(0.1 * 1080, 9);
  });
});

// ── 성능 (퇴행 방지) ──────────────────────────────────────────────────────
// F10(마스크 트래킹)은 30초 클립에 3,600개(900프레임 × 4경로)를 만든다.
// 묶음 캐시가 없으면 프레임마다 3,600개를 filter+sort 하게 되어 렌더가 멈춘 것처럼 느려진다.

describe('성능 — 키프레임 3,600개', () => {
  function trackingKeyframes(): Keyframe[] {
    const out: Keyframe[] = [];
    for (let f = 0; f < 900; f++) {
      const t = Math.round((f / 30) * 1000);
      for (const p of ['mask.x', 'mask.y', 'mask.w', 'mask.h']) {
        out.push({ time: t, prop: p, value: 0.2 + 0.001 * f, easing: 'linear' });
      }
    }
    return out;
  }

  it('900프레임 × applyKeyframes: 묶음 캐시가 있으면 프레임당 0.5ms 미만', () => {
    const clip = vclip({
      duration: 30000,
      mask: { shape: 'rect', feather: 0.1, x: 0, y: 0, w: 1, h: 1 },
      keyframes: trackingKeyframes(),
    });
    expect(clip.keyframes!.length).toBe(3600);

    applyKeyframes(clip, 0); // 워밍업(캐시 구축)
    const t0 = performance.now();
    for (let f = 0; f < 900; f++) applyKeyframes(clip, (f / 30) * 1000);
    const perFrame = (performance.now() - t0) / 900;
    expect(perFrame).toBeLessThan(0.5);
  });

  it('묶음 캐시가 «없을 때»보다 확실히 빠르다 (캐시가 필수인 근거)', () => {
    const kfs = trackingKeyframes();
    const naive = (prop: string, tMs: number): number => {
      const list = kfs.filter((k) => k.prop === prop).sort((a, b) => a.time - b.time);
      const last = list[list.length - 1]!;
      return tMs >= last.time ? last.value : list[0]!.value;
    };
    const props = ['mask.x', 'mask.y', 'mask.w', 'mask.h'];

    const t0 = performance.now();
    for (let f = 0; f < 300; f++) for (const p of props) naive(p, (f / 30) * 1000);
    const naiveMs = performance.now() - t0;

    interpolateKeyframes(kfs, 'mask.x', 0, 0); // 워밍업
    const t1 = performance.now();
    for (let f = 0; f < 300; f++) for (const p of props) interpolateKeyframes(kfs, p, (f / 30) * 1000, 0);
    const cachedMs = performance.now() - t1;

    // 로그로 근거를 남긴다 (실측값은 기계마다 다르다)
    console.log(`[3,600 키프레임 × 300프레임 × 4경로] 캐시 없음 ${naiveMs.toFixed(1)}ms · 캐시 ${cachedMs.toFixed(1)}ms`);
    expect(cachedMs).toBeLessThan(naiveMs / 5);
  });

  it('groupKeyframes 는 같은 배열이면 같은 Map 을 재사용한다', () => {
    const kfs = trackingKeyframes();
    expect(groupKeyframes(kfs)).toBe(groupKeyframes(kfs));
    expect(groupKeyframes(kfs).size).toBe(4);
    expect(groupKeyframes(kfs).get('mask.x')!.length).toBe(900);
  });

  it('묶음은 time 오름차순이다 (입력이 뒤섞여 있어도)', () => {
    const shuffled: Keyframe[] = [
      { time: 900, prop: 'x', value: 3, easing: 'linear' },
      { time: 100, prop: 'x', value: 1, easing: 'linear' },
      { time: 500, prop: 'x', value: 2, easing: 'linear' },
    ];
    expect(groupKeyframes(shuffled).get('x')!.map((k) => k.time)).toEqual([100, 500, 900]);
    expect(interpolateKeyframes(shuffled, 'x', 300, 0)).toBe(1.5);
  });
});
