// 프리뷰 v2 — 클럭/활성 클립/소스 시각/볼륨 순수 로직.
// 볼륨은 렌더러(clips.tsx)의 fadeFactor 와 **같은 수식**이어야 한다 — 빌드된 렌더러에서 직접 불러 비교한다.
import { describe, expect, it } from 'vitest';
import type { Asset, AudioClip, ProjectDoc, TextClip, Track, VideoClip } from '@kitkat/schema';
import { sourceKey } from '@kitkat/schema';
/* eslint-disable import/no-relative-packages */
import { fadeFactor as rendererFadeFactor } from '../../renderer/dist/composition/clips.js';
import { resolveMediaWindow as rendererWindow } from '../../renderer/dist/composition/media-src.js';
import {
  loopDurationInFrames,
  mediaTrimFrames,
  rampSequences,
} from '../../renderer/dist/composition/ramp.js';
import { msToFrames } from '../../renderer/dist/composition/keyframes.js';
/* eslint-enable import/no-relative-packages */
import {
  activeClipsAt,
  advanceClock,
  clipVolume,
  fadeFactor,
  isClipActive,
  mediaTimeAt,
  needsResync,
  playbackRateFor,
  sourceTimeAt,
  videoHasAudio,
} from '../src/preview/timing.js';

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'a1',
  kind: 'video',
  src: 'assets/a1.mp4',
  name: 'a1.mp4',
  duration: 10_000,
  width: 1920,
  height: 1080,
  ...over,
});

const video = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: 'v1',
  kind: 'video',
  assetId: 'a1',
  start: 0,
  duration: 2000,
  in: 1000,
  out: 3000,
  speed: 1,
  volume: 1,
  ...over,
});

const audio = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'au1',
  kind: 'audio',
  assetId: 'a2',
  start: 0,
  duration: 2000,
  in: 0,
  out: 2000,
  speed: 1,
  volume: 1,
  ...over,
});

const text = (over: Partial<TextClip> = {}): TextClip => ({
  id: 't1',
  kind: 'text',
  start: 0,
  duration: 2000,
  text: '안녕',
  style: { fontFamily: 'sans-serif', fontSize: 64, color: '#fff', align: 'center' },
  ...over,
});

function docWith(tracks: Track[]): ProjectDoc {
  return {
    schemaVersion: 1,
    id: 'p',
    name: 'p',
    revision: 0,
    settings: { width: 1920, height: 1080, fps: 30, background: { kind: 'color', color: '#000000' } },
    assets: { a1: asset(), a2: asset({ id: 'a2', kind: 'audio', src: 'assets/a2.m4a' }) },
    tracks,
  };
}

describe('활성 클립 선정', () => {
  it('[start, start+duration) 반열린 구간이다', () => {
    expect(isClipActive(100, 50, 100)).toBe(true);
    expect(isClipActive(100, 50, 149.9)).toBe(true);
    expect(isClipActive(100, 50, 150)).toBe(false);
    expect(isClipActive(100, 50, 99)).toBe(false);
  });

  it('트랙 순서(아래→위)를 그대로 유지하고 hidden 트랙은 통째로 건너뛴다', () => {
    const d = docWith([
      { id: 'tr0', kind: 'video', name: '아래', clips: [video({ id: 'lo' })] },
      { id: 'tr1', kind: 'overlay', name: '숨김', hidden: true, clips: [video({ id: 'hid' })] },
      { id: 'tr2', kind: 'overlay', name: '위', clips: [video({ id: 'hi' })] },
      { id: 'tr3', kind: 'text', name: '자막', clips: [text()] },
    ]);
    const a = activeClipsAt(d, 500);
    expect(a.visual.map((v) => v.clip.id)).toEqual(['lo', 'hi']);
    expect(a.text.map((t) => t.clip.id)).toEqual(['t1']);
    expect(a.visual[0]?.localMs).toBe(500);
  });

  it('소리 나는 비디오 클립은 audio 목록에도 들어가고, freeze·램프 클립은 빠진다', () => {
    const d = docWith([
      { id: 'tr0', kind: 'video', name: 'v', clips: [video({ id: 'plain' })] },
      {
        id: 'tr1',
        kind: 'overlay',
        name: 'f',
        clips: [video({ id: 'frz', freeze: true, in: 500, out: 501 })],
      },
      { id: 'tr2', kind: 'audio', name: 'a', clips: [audio()] },
    ]);
    const a = activeClipsAt(d, 500);
    expect(a.audio.map((x) => x.clip.id).sort()).toEqual(['au1', 'plain']);
    expect(videoHasAudio(video({ speedRamp: { points: [{ u: 0, speed: 1 }, { u: 1, speed: 2 }] } }))).toBe(
      false,
    );
  });
});

describe('볼륨 (렌더러와 같은 수식)', () => {
  const track: Track = { id: 'tr', kind: 'audio', name: 'a', clips: [] };

  it('fadeFactor 가 렌더러 구현과 정확히 같다', () => {
    const cases: [number, number, number | undefined, number | undefined][] = [
      [0, 2000, 500, 500],
      [250, 2000, 500, 500],
      [1000, 2000, 500, 500],
      [1750, 2000, 500, 500],
      [2000, 2000, 500, 500],
      [100, 1000, undefined, 400],
      [900, 1000, 400, undefined],
      [0, 1000, undefined, undefined],
    ];
    for (const [t, dur, fi, fo] of cases) {
      expect(fadeFactor(t, dur, fi, fo)).toBeCloseTo(rendererFadeFactor(t, dur, fi, fo), 12);
    }
  });

  it('클립×트랙×페이드를 곱하고 1 로 클램프한다', () => {
    const clip = audio({ volume: 2, fadeIn: 1000 });
    // 페이드 절반(0.5) × 클립 2 × 트랙 0.5 = 0.5
    expect(clipVolume(clip, { ...track, volume: 0.5 }, 500)).toBeCloseTo(0.5, 6);
    // 클램프 — 원래 값 2 를 1 로 자른다 (Player 와 같음, C4)
    expect(clipVolume(audio({ volume: 2 }), track, 1000)).toBe(1);
  });

  it('트랙 muted 면 0, volume 키프레임을 반영한다', () => {
    expect(clipVolume(audio(), { ...track, muted: true }, 500)).toBe(0);
    const kf = audio({
      volume: 1,
      keyframes: [
        { time: 0, prop: 'volume', value: 0, easing: 'linear' },
        { time: 1000, prop: 'volume', value: 1, easing: 'linear' },
      ],
    });
    expect(clipVolume(kf, track, 500)).toBeCloseTo(0.5, 6);
  });
});

describe('소스 시각', () => {
  it('등속이면 in + t*speed, out 을 넘지 않는다', () => {
    const c = video({ speed: 2, in: 1000, out: 3000, duration: 1000 });
    expect(sourceTimeAt(c, 0)).toBe(1000);
    expect(sourceTimeAt(c, 500)).toBe(2000);
    expect(sourceTimeAt(c, 5000)).toBe(3000);
  });

  it('freeze 는 항상 in 프레임이다', () => {
    const c = video({ freeze: true, in: 1234, out: 1235, duration: 3000 });
    expect(sourceTimeAt(c, 0)).toBe(1234);
    expect(sourceTimeAt(c, 2999)).toBe(1234);
  });

  it('loop 는 소스 구간을 되풀이한다', () => {
    const c = video({ loop: true, in: 0, out: 1000, speed: 1, duration: 2500 });
    expect(sourceTimeAt(c, 0)).toBe(0);
    expect(sourceTimeAt(c, 1200)).toBeCloseTo(200, 6);
    expect(sourceTimeAt(c, 2400)).toBeCloseTo(400, 6);
  });

  it('speedRamp 는 세그먼트를 따라가고 단조 증가한다', () => {
    const c = video({
      in: 0,
      out: 4000,
      speed: 1,
      duration: 2000,
      speedRamp: { points: [{ u: 0, speed: 1 }, { u: 1, speed: 4 }] },
    });
    let prev = -1;
    for (let t = 0; t <= c.duration; t += 100) {
      const s = sourceTimeAt(c, t);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(4000);
      prev = s;
    }
    expect(sourceTimeAt(c, 0)).toBeCloseTo(0, 6);
  });

  it('램프 클립의 배속은 평균값을 쓴다', () => {
    const c = video({
      in: 0,
      out: 4000,
      speed: 1,
      duration: 2000,
      speedRamp: { points: [{ u: 0, speed: 1 }, { u: 1, speed: 4 }] },
    });
    expect(playbackRateFor(c)).toBeCloseTo(2, 6);
    expect(playbackRateFor(video({ speed: 0.5 }))).toBe(0.5);
  });

  it('reversed 클립은 미러링된 창의 **처음부터 앞으로** 간다 (renderer resolveMediaWindow 규칙)', () => {
    const a = asset({ reversedSrc: 'derived/a1.rev.mp4', duration: 10_000 });
    const c = video({ reversed: true, in: 1000, out: 3000, speed: 1, duration: 2000 });
    const m0 = mediaTimeAt(c, a, '/media', false, 0);
    expect(m0.mirrored).toBe(true);
    expect(m0.src).toBe('/media/derived/a1.rev.mp4');
    // 렌더러 창 = [D-out, D-in] = [7000, 9000] 이고 그 안을 앞으로 재생한다.
    expect(m0.srcMs).toBe(10_000 - 3000);
    expect(mediaTimeAt(c, a, '/media', false, 2000).srcMs).toBe(10_000 - 1000);
  });

  it('역재생본이 없으면 원본을 그대로 쓴다 (미러링 없음)', () => {
    const c = video({ reversed: true, in: 1000, out: 3000, duration: 2000 });
    const m = mediaTimeAt(c, asset(), '/media', false, 500);
    expect(m.mirrored).toBe(false);
    expect(m.srcMs).toBe(1500);
  });
});

// ── 역재생: 빌드된 렌더러와 시각 대조 ────────────────────────────────────────
//
// 판단 기준은 하나 — "렌더러가 그 시각에 소스의 어디를 보여주는가".
// 아래 헬퍼는 빌드된 렌더러 함수(resolveMediaWindow / mediaTrimFrames / rampSequences /
// loopDurationInFrames / msToFrames)만으로 그 값을 재구성한다. 프리뷰가 이 값을 따라가야 한다.

const FPS = 25; // 프레임 = 40ms 정수 → 프레임 반올림 오차 없이 비교된다

/** 렌더러가 클립 로컬 tMs 에 재생 중인 파일 안 시각(ms). */
function rendererSrcMs(clip: VideoClip, a: Asset, fps: number, tMs: number): number {
  const w = rendererWindow(clip, a, '/media', false);
  const frame = msToFrames(tMs, fps);
  const toMs = (f: number): number => (f * 1000) / fps;
  if ((clip.speedRamp?.points?.length ?? 0) >= 2) {
    // clips.tsx: rampSequences(clip, fps, inMs - clip.in) → 세그먼트마다 trimBefore + 프레임×playbackRate
    const seqs = rampSequences(clip, fps, w.inMs - clip.in);
    let s = seqs[0]!;
    for (const q of seqs) if (frame >= q.from) s = q;
    return toMs(s.trimBefore + (frame - s.from) * s.playbackRate);
  }
  if (clip.freeze === true) {
    // clips.tsx: <Freeze frame={msToFrames(inMs, fps)}>
    return toMs(msToFrames(w.inMs, fps));
  }
  const displayMs =
    clip.loop === true ? Math.round((clip.out - clip.in) / clip.speed) : clip.duration;
  const trim = mediaTrimFrames(w.inMs, w.outMs, displayMs, fps);
  const f = clip.loop === true ? frame % loopDurationInFrames(clip, fps) : frame;
  return toMs(trim.trimBefore + f * clip.speed);
}

/** 프리뷰가 그 시각에 파일 안 어디를 가리키는가. */
const previewSrcMs = (clip: VideoClip, a: Asset, tMs: number): number =>
  mediaTimeAt(clip, a, '/media', false, tMs).srcMs;

const revAsset = asset({ reversedSrc: 'derived/a1.rev.mp4', duration: 10_000 });

describe('역재생 소스 시각이 빌드된 렌더러와 같다', () => {
  it('등속 reversed — 창 [D-out, D-in] 안을 앞으로 (t 여러 지점)', () => {
    const c = video({ reversed: true, in: 1000, out: 3000, speed: 1, duration: 2000 });
    for (const t of [0, 40, 400, 1000, 1520, 1960, 2000]) {
      expect(previewSrcMs(c, revAsset, t)).toBeCloseTo(rendererSrcMs(c, revAsset, FPS, t), 9);
    }
    // 정방향으로 흐른다 (고치기 전에는 9000 → 7001 로 거꾸로 갔다)
    expect(previewSrcMs(c, revAsset, 0)).toBe(7000);
    expect(previewSrcMs(c, revAsset, 2000)).toBe(9000);
  });

  it('등속 reversed + speed 2 — 배속만큼 앞으로 간다', () => {
    const c = video({ reversed: true, in: 1000, out: 3000, speed: 2, duration: 1000 });
    for (const t of [0, 120, 400, 760, 1000]) {
      expect(previewSrcMs(c, revAsset, t)).toBeCloseTo(rendererSrcMs(c, revAsset, FPS, t), 9);
    }
  });

  it('reversed 클립의 소스 시각은 t 에 대해 단조 증가한다', () => {
    const c = video({ reversed: true, in: 1000, out: 3000, speed: 1, duration: 2000 });
    let prev = -1;
    for (let t = 0; t <= 2000; t += 40) {
      const s = previewSrcMs(c, revAsset, t);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(7000);
      expect(s).toBeLessThanOrEqual(9000);
      prev = s;
    }
  });

  it('reversed + speedRamp — 세그먼트 시각이 렌더러와 같다', () => {
    const c = video({
      reversed: true,
      in: 0,
      out: 4000,
      speed: 1,
      duration: 1848, // rampDurationMs(1→4 램프, span 4000)
      speedRamp: { points: [{ u: 0, speed: 1 }, { u: 1, speed: 4 }] },
    });
    for (let t = 0; t <= 1800; t += 120) {
      const p = previewSrcMs(c, revAsset, t);
      const r = rendererSrcMs(c, revAsset, FPS, t);
      // 세그먼트 경계 반올림(≤ 반 프레임 × 배속 4) 만큼만 벌어진다
      expect(Math.abs(p - r)).toBeLessThanOrEqual(80); // 2프레임(25fps) — 실측 최대 64.7ms
    }
    // 방향: 렌더러와 같은 쪽으로 흐른다 (고치기 전에는 10000 → 6001 로 반대였다)
    expect(previewSrcMs(c, revAsset, 0)).toBeCloseTo(6000, 6);
    expect(previewSrcMs(c, revAsset, 1848)).toBeGreaterThan(previewSrcMs(c, revAsset, 0));
  });

  it('reversed + freeze — 렌더러가 얼리는 프레임과 같다 (D-out)', () => {
    const c = video({ reversed: true, freeze: true, in: 2000, out: 2040, duration: 3000 });
    for (const t of [0, 40, 1000, 2960]) {
      expect(previewSrcMs(c, revAsset, t)).toBeCloseTo(rendererSrcMs(c, revAsset, FPS, t), 9);
    }
    expect(previewSrcMs(c, revAsset, 0)).toBe(10_000 - 2040);
  });

  it('reversed + loop — 되풀이 위치가 렌더러와 같다', () => {
    const c = video({ reversed: true, loop: true, in: 1000, out: 3000, speed: 1, duration: 5000 });
    for (const t of [0, 400, 1960, 2400, 3960, 4400]) {
      expect(previewSrcMs(c, revAsset, t)).toBeCloseTo(rendererSrcMs(c, revAsset, FPS, t), 9);
    }
  });

  it('파생(derived) + reversed — 파생 파일도 미러링된 창을 앞으로 재생한다', () => {
    const c = video({
      reversed: true,
      in: 1000,
      out: 3000,
      speed: 1,
      duration: 2000,
      source: { stabilize: { smoothing: 10 } },
    });
    const k = sourceKey(c)!;
    const a = asset({
      reversedSrc: 'derived/a1.rev.mp4',
      duration: 10_000,
      derived: { [k]: { src: `derived/a1.${k}.mp4` } },
    });
    const m = mediaTimeAt(c, a, '/media', false, 0);
    expect(m.src).toBe(`/media/derived/a1.${k}.mp4`); // 파생이 reversedSrc 보다 우선 (X5-b)
    expect(m.mirrored).toBe(true);
    for (const t of [0, 400, 1000, 1960, 2000]) {
      expect(previewSrcMs(c, a, t)).toBeCloseTo(rendererSrcMs(c, a, FPS, t), 9);
    }
  });

  it('정방향(비 reversed)은 그대로 — 등속·loop·freeze·램프 모두 렌더러와 같다', () => {
    const plain = asset();
    const cases: VideoClip[] = [
      video({ in: 1000, out: 3000, speed: 1, duration: 2000 }),
      video({ loop: true, in: 0, out: 1000, speed: 1, duration: 2500 }),
      video({ freeze: true, in: 2000, out: 2040, duration: 3000 }),
      video({
        in: 0,
        out: 4000,
        speed: 1,
        duration: 1848,
        speedRamp: { points: [{ u: 0, speed: 1 }, { u: 1, speed: 4 }] },
      }),
    ];
    for (const c of cases) {
      const ramp = (c.speedRamp?.points?.length ?? 0) >= 2;
      for (const t of [0, 400, 1000, 1800]) {
        const p = previewSrcMs(c, plain, t);
        const r = rendererSrcMs(c, plain, FPS, t);
        if (ramp) expect(Math.abs(p - r)).toBeLessThanOrEqual(120);
        else expect(p).toBeCloseTo(r, 9);
      }
      expect(mediaTimeAt(c, plain, '/media', false, 0).mirrored).toBe(false);
    }
  });
});

describe('클럭', () => {
  it('드리프트가 임계값을 넘으면 재동기화한다 (기본 100ms)', () => {
    expect(needsResync(1000, 1050)).toBe(false);
    expect(needsResync(1000, 1100)).toBe(false);
    expect(needsResync(1000, 1101)).toBe(true);
    expect(needsResync(1000, 800)).toBe(true);
    expect(needsResync(1000, 1050, 20)).toBe(true);
    expect(needsResync(Number.NaN, 1000)).toBe(true);
  });

  it('문서 끝에 닿으면 멈춘다', () => {
    expect(advanceClock(0, 16, 1000)).toEqual({ ms: 16, ended: false });
    expect(advanceClock(990, 16, 1000)).toEqual({ ms: 1000, ended: true });
    expect(advanceClock(0, -50, 1000)).toEqual({ ms: 0, ended: false });
  });
});
