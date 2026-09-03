import { describe, expect, it } from 'vitest';
import {
  createEmptyProject,
  sourceKey,
  type Asset,
  type AudioClip,
  type Effect,
  type VideoClip,
} from '@kitkat/schema';
import { docDurationMs, msToFrames } from '../src/composition/keyframes.js';
import { effectsToFilter, vignetteAmount } from '../src/composition/effects.js';
import { transitionProgress, transitionStyle } from '../src/composition/transitions.js';
import { resolveAudioSrc, resolveMediaSrc, resolveMediaWindow } from '../src/composition/media-src.js';

const eff = (type: Effect['type'], params: Effect['params']): Effect => ({ id: `e-${type}`, type, params });

function vclip(id: string, start: number, duration: number): VideoClip {
  return { id, kind: 'video', assetId: 'a1', start, duration, in: 0, out: duration, speed: 1, volume: 1 };
}

describe('docDurationMs', () => {
  it('빈 문서 → 최소 1000ms', () => {
    const doc = createEmptyProject({ name: 't' });
    expect(docDurationMs(doc)).toBe(1000);
  });

  it('max(start+duration)', () => {
    const doc = createEmptyProject({ name: 't' });
    const videoTrack = doc.tracks.find((t) => t.kind === 'video')!;
    videoTrack.clips.push(vclip('c1', 0, 4000), vclip('c2', 4000, 3500));
    expect(docDurationMs(doc)).toBe(7500);
  });

  it('짧은 클립만 있으면 최소 1000 유지', () => {
    const doc = createEmptyProject({ name: 't' });
    const videoTrack = doc.tracks.find((t) => t.kind === 'video')!;
    videoTrack.clips.push(vclip('c1', 0, 300));
    expect(docDurationMs(doc)).toBe(1000);
  });
});

describe('msToFrames', () => {
  it('Math.round(ms*fps/1000)', () => {
    expect(msToFrames(1000, 30)).toBe(30);
    expect(msToFrames(500, 30)).toBe(15);
    expect(msToFrames(33, 30)).toBe(1); // 0.99 → 1
    expect(msToFrames(16, 30)).toBe(0); // 0.48 → 0
  });
});

describe('effectsToFilter', () => {
  it('빈 배열/undefined → 빈 문자열', () => {
    expect(effectsToFilter(undefined)).toBe('');
    expect(effectsToFilter([])).toBe('');
  });

  it('EFFECT_TYPES → CSS filter 조합', () => {
    const filter = effectsToFilter([
      eff('brightness', { amount: 1.2 }),
      eff('contrast', { amount: 0.9 }),
      eff('saturation', { amount: 1.5 }),
      eff('hue', { deg: 30 }),
      eff('blur', { px: 5 }),
      eff('grayscale', { amount: 0.4 }),
      eff('sepia', { amount: 0.3 }),
      eff('invert', { amount: 1 }),
    ]);
    expect(filter).toBe(
      'brightness(1.2) contrast(0.9) saturate(1.5) hue-rotate(30deg) blur(5px) grayscale(0.4) sepia(0.3) invert(1)',
    );
  });

  it('vignette는 filter 문자열에서 제외, vignetteAmount로 노출', () => {
    const effects = [eff('vignette', { amount: 0.8 }), eff('blur', { px: 2 })];
    expect(effectsToFilter(effects)).toBe('blur(2px)');
    expect(vignetteAmount(effects)).toBe(0.8);
    expect(vignetteAmount([eff('blur', { px: 2 })])).toBe(0);
  });

  it('파라미터 없으면 기본값', () => {
    expect(effectsToFilter([eff('brightness', {})])).toBe('brightness(1)');
    expect(effectsToFilter([eff('hue', {})])).toBe('hue-rotate(0deg)');
  });
});

describe('transitionProgress', () => {
  it('전환 없음 → in 1, out 0', () => {
    expect(transitionProgress(500, 4000)).toEqual({ in: 1, out: 0 });
  });

  it('transitionIn 구간 진행도', () => {
    const tin = { type: 'fade' as const, duration: 600 };
    expect(transitionProgress(0, 4000, tin).in).toBe(0);
    expect(transitionProgress(300, 4000, tin).in).toBeCloseTo(0.5, 5);
    expect(transitionProgress(600, 4000, tin).in).toBe(1);
    expect(transitionProgress(2000, 4000, tin).in).toBe(1);
  });

  it('transitionOut 구간 진행도 (클립 끝 기준)', () => {
    const tout = { type: 'zoomIn' as const, duration: 600 };
    expect(transitionProgress(0, 4000, undefined, tout).out).toBe(0);
    expect(transitionProgress(3400, 4000, undefined, tout).out).toBe(0);
    expect(transitionProgress(3700, 4000, undefined, tout).out).toBeCloseTo(0.5, 5);
    expect(transitionProgress(4000, 4000, undefined, tout).out).toBe(1);
  });

  it('in/out 동시 지정도 각각 독립 계산', () => {
    const tin = { type: 'fade' as const, duration: 1000 };
    const tout = { type: 'fade' as const, duration: 1000 };
    const p = transitionProgress(500, 2000, tin, tout);
    expect(p.in).toBeCloseTo(0.5, 5);
    expect(p.out).toBe(0);
    const q = transitionProgress(1500, 2000, tin, tout);
    expect(q.in).toBe(1);
    expect(q.out).toBeCloseTo(0.5, 5);
  });
});

describe('resolveMediaSrc / resolveMediaWindow (배경·본 클립 공용)', () => {
  const asset: Asset = {
    id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1',
    duration: 10000, proxySrc: 'proxies/a1.mp4', reversedSrc: 'derived/a1.rev.mp4',
  };
  const base = (over: Partial<VideoClip> = {}): VideoClip => ({
    id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 4000,
    in: 1000, out: 5000, speed: 1, volume: 1, ...over,
  });

  it('정방향: proxy면 proxySrc, in/out 그대로', () => {
    const w = resolveMediaWindow(base(), asset, '/media', true);
    expect(w.src).toBe('/media/proxies/a1.mp4');
    expect(w.inMs).toBe(1000);
    expect(w.outMs).toBe(5000);
    expect(w.useReversed).toBe(false);
  });

  it('reversed: reversedSrc를 쓰고 소스 구간을 미러링한다 (proxy 무시)', () => {
    const w = resolveMediaWindow(base({ reversed: true }), asset, '/media', true);
    expect(w.src).toBe('/media/derived/a1.rev.mp4');
    expect(w.inMs).toBe(5000); // 10000 - out(5000)
    expect(w.outMs).toBe(9000); // 10000 - in(1000)
    expect(w.useReversed).toBe(true);
  });

  it('reversed인데 reversedSrc가 없으면 원본 폴백 + 정방향 구간', () => {
    const noRev: Asset = { ...asset };
    delete noRev.reversedSrc;
    const w = resolveMediaWindow(base({ reversed: true }), noRev, '/media', false);
    expect(w.src).toBe('/media/assets/a1.mp4');
    expect(w.inMs).toBe(1000);
    expect(w.outMs).toBe(5000);
    expect(w.useReversed).toBe(false);
    expect(resolveMediaSrc(base({ reversed: true }), noRev, '/media', true).src).toBe('/media/proxies/a1.mp4');
  });
});

describe('파생 미디어(M2) 우선순위', () => {
  const base = (over: Partial<VideoClip> = {}): VideoClip => ({
    id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 4000,
    in: 1000, out: 5000, speed: 1, volume: 1, ...over,
  });
  const src = { lut: { assetId: 'lut1', intensity: 0.8 } };

  const assetWithDerived = (clip: VideoClip | AudioClip, over: Partial<Asset> = {}): Asset => ({
    id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1',
    duration: 10000, proxySrc: 'proxies/a1.mp4', reversedSrc: 'derived/a1.rev.mp4',
    derived: {
      [sourceKey(clip)!]: { src: 'derived/a1.s1234.mp4', proxySrc: 'derived/a1.s1234.p.mp4' },
    },
    ...over,
  });

  it('파생이 있으면 파생 파일을 쓴다 (proxy면 proxySrc)', () => {
    const clip = base({ source: src });
    const a = assetWithDerived(clip);
    expect(resolveMediaSrc(clip, a, '/media', false).src).toBe('/media/derived/a1.s1234.mp4');
    expect(resolveMediaSrc(clip, a, '/media', true).src).toBe('/media/derived/a1.s1234.p.mp4');
    expect(resolveMediaSrc(clip, a, '/media', false).useDerived).toBe(true);
  });

  it('파생 프록시가 없으면 파생 원본으로 폴백', () => {
    const clip = base({ source: src });
    const a = assetWithDerived(clip);
    a.derived = { [sourceKey(clip)!]: { src: 'derived/a1.s1234.mp4' } };
    expect(resolveMediaSrc(clip, a, '/media', true).src).toBe('/media/derived/a1.s1234.mp4');
  });

  it('파생은 reversed 보다 우선이지만, reversed 파생은 소스 구간을 미러링한다', () => {
    // 서버는 reversed 클립의 파생을 reversedSrc 에서 굽는다(X6) — 길이가 원본과 같으므로
    // 미러링을 빼면 엉뚱한 구간이 재생된다.
    const clip = base({ source: src, reversed: true });
    const a = assetWithDerived(clip); // key 에 |rev 가 섞여 다른 키가 나온다
    const w = resolveMediaWindow(clip, a, '/media', false);
    expect(w.src).toBe('/media/derived/a1.s1234.mp4');
    expect(w.useReversed).toBe(false);
    expect(w.useDerived).toBe(true);
    expect(w.inMs).toBe(5000); // 10000 - out
    expect(w.outMs).toBe(9000); // 10000 - in
  });

  it('reversed 가 아닌 파생은 미러링하지 않는다', () => {
    const clip = base({ source: src });
    const a = assetWithDerived(clip);
    const w = resolveMediaWindow(clip, a, '/media', false);
    expect(w.inMs).toBe(1000);
    expect(w.outMs).toBe(5000);
  });

  it('source 가 있어도 파생 파일이 아직 없으면 v1 규칙 그대로', () => {
    const clip = base({ source: src, reversed: true });
    const a = assetWithDerived(clip);
    delete a.derived;
    const w = resolveMediaWindow(clip, a, '/media', false);
    expect(w.src).toBe('/media/derived/a1.rev.mp4');
    expect(w.useReversed).toBe(true);
    expect(w.useDerived).toBe(false);
    expect(w.inMs).toBe(5000);
  });

  it('키가 다른 파생만 있으면 무시한다', () => {
    const clip = base({ source: src });
    const a = assetWithDerived(clip);
    a.derived = { sdeadbeef: { src: 'derived/other.mp4' } };
    expect(resolveMediaSrc(clip, a, '/media', false).src).toBe('/media/assets/a1.mp4');
  });

  it('오디오 클립도 파생(잡음 제거·피치)을 쓴다, 없으면 원본', () => {
    const aclip: AudioClip = {
      id: 'ac1', kind: 'audio', assetId: 'm1', start: 0, duration: 3000,
      in: 0, out: 3000, speed: 1, volume: 1, source: { pitch: { semitones: 3 } },
    };
    const a: Asset = {
      id: 'm1', kind: 'audio', src: 'assets/m1.m4a', name: 'm1', duration: 30000,
      derived: { [sourceKey(aclip)!]: { src: 'derived/m1.sabc.m4a' } },
    };
    expect(resolveAudioSrc(aclip, a, '/media')).toBe('/media/derived/m1.sabc.m4a');
    const plain: AudioClip = { ...aclip };
    delete plain.source;
    expect(resolveAudioSrc(plain, a, '/media')).toBe('/media/assets/m1.m4a');
  });
});

describe('transitionStyle', () => {
  it('fade → opacity', () => {
    expect(transitionStyle('fade', 0.3)).toEqual({ opacity: 0.3 });
  });

  it('slide 계열 → translate %', () => {
    expect(transitionStyle('slideLeft', 0.75)).toEqual({ transform: 'translateX(25%)' });
    expect(transitionStyle('slideRight', 0.75)).toEqual({ transform: 'translateX(-25%)' });
    expect(transitionStyle('slideUp', 0)).toEqual({ transform: 'translateY(100%)' });
    expect(transitionStyle('slideDown', 1)).toEqual({ transform: 'translateY(0%)' });
  });

  it('wipeLeft → clip-path inset', () => {
    expect(transitionStyle('wipeLeft', 0.5)).toEqual({ clipPath: 'inset(0 50% 0 0)' });
  });

  it('zoom 계열 → scale + opacity, visibility 1이면 원래 크기', () => {
    expect(transitionStyle('zoomIn', 1)).toEqual({ opacity: 1, transform: 'scale(1)' });
    expect(transitionStyle('zoomOut', 1)).toEqual({ opacity: 1, transform: 'scale(1)' });
    const halfIn = transitionStyle('zoomIn', 0.5);
    expect(halfIn.opacity).toBe(0.5);
    const mIn = /scale\(([\d.]+)\)/.exec(String(halfIn.transform));
    expect(parseFloat(mIn![1]!)).toBeCloseTo(0.8, 5);
    const halfOut = transitionStyle('zoomOut', 0.5);
    const mOut = /scale\(([\d.]+)\)/.exec(String(halfOut.transform));
    expect(parseFloat(mOut![1]!)).toBeCloseTo(1.3, 5);
  });
});
