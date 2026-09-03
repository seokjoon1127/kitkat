import { describe, expect, it } from 'vitest';
import {
  assetMsToTimelineMs,
  clampMs,
  clipBeatTimes,
  collectBeatMarkers,
  collectSnapPoints,
  findFreeStart,
  formatTime,
  hasOverlap,
  MIN_CLIP_MS,
  MIN_TIMELINE_MS,
  msToPx,
  pxToMs,
  rulerStep,
  snapMove,
  snapValue,
  timelineDurationMs,
  trimRange,
} from '../src/timeline-utils.js';
import type { Asset, AudioClip, Clip, VideoClip } from '@kitkat/schema';

// zoom 60 = 60px/초

describe('ms↔px 변환', () => {
  it('msToPx: zoom 60에서 1000ms = 60px', () => {
    expect(msToPx(1000, 60)).toBe(60);
    expect(msToPx(500, 60)).toBe(30);
    expect(msToPx(0, 60)).toBe(0);
  });

  it('pxToMs: 정수 ms로 반올림한다', () => {
    expect(pxToMs(60, 60)).toBe(1000);
    expect(pxToMs(1, 60)).toBe(17); // 16.66… → 17
    expect(pxToMs(-30, 60)).toBe(-500);
  });

  it('왕복 변환이 일치한다 (정수 px)', () => {
    expect(pxToMs(msToPx(4000, 120), 120)).toBe(4000);
  });
});

describe('clampMs / formatTime', () => {
  it('clampMs는 범위로 자르고 정수 반올림', () => {
    expect(clampMs(-5)).toBe(0);
    expect(clampMs(1500.4, 0, 1200)).toBe(1200);
    expect(clampMs(700.6, 0, 1200)).toBe(701);
  });

  it('formatTime', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(4500)).toBe('0:04.5');
    expect(formatTime(61000)).toBe('1:01');
    expect(formatTime(60000)).toBe('1:00');
  });
});

describe('rulerStep', () => {
  it('zoom 60이면 major 2000ms(=120px), minor 400ms', () => {
    expect(rulerStep(60)).toEqual({ major: 2000, minor: 400 });
  });
  it('zoom 700이면 major 100ms(=70px)', () => {
    expect(rulerStep(700)).toEqual({ major: 100, minor: 20 });
  });
  it('아주 축소해도 최대 후보로 폴백', () => {
    expect(rulerStep(0.5).major).toBe(60000);
  });
});

describe('timelineDurationMs', () => {
  it('최소 길이를 보장한다', () => {
    expect(timelineDurationMs(null)).toBe(MIN_TIMELINE_MS);
    expect(timelineDurationMs({ tracks: [] })).toBe(MIN_TIMELINE_MS);
  });
  it('가장 늦게 끝나는 클립의 끝을 쓴다', () => {
    const doc = {
      tracks: [
        { clips: [{ start: 0, duration: 4000 }] },
        { clips: [{ start: 10000, duration: 5000 }] },
      ],
    } as never;
    expect(timelineDurationMs(doc)).toBe(15000);
  });
});

describe('스냅', () => {
  it('snapValue: 8px(zoom 60 → 133ms) 이내면 스냅', () => {
    expect(snapValue(1100, [1000], 60)).toEqual({ ms: 1000, snapped: true });
  });
  it('snapValue: 임계 밖이면 원값(반올림) 유지', () => {
    expect(snapValue(1200.4, [1000], 60)).toEqual({ ms: 1200, snapped: false });
  });
  it('snapValue: 가장 가까운 후보를 고른다', () => {
    expect(snapValue(1060, [1000, 1100], 60).ms).toBe(1100);
  });
  it('snapMove: 끝 경계도 스냅해 start를 보정한다', () => {
    // start 800, dur 1000 → end 1800. 후보 1900은 100ms(6px) 거리 → end 스냅 → start 900
    expect(snapMove(800, 1000, [1900], 60)).toBe(900);
  });
  it('snapMove: 시작·끝 중 더 가까운 쪽을 택한다', () => {
    // start 1080(후보 1000과 80ms) vs end 2080(후보 2100과 20ms) → end 스냅 → start 1100
    expect(snapMove(1080, 1000, [1000, 2100], 60)).toBe(1100);
  });
  it('snapMove: 후보가 멀면 그대로', () => {
    expect(snapMove(5000, 1000, [0], 60)).toBe(5000);
  });
  it('collectSnapPoints: 0·재생헤드·클립 경계 포함, 제외 클립은 뺀다', () => {
    const doc = {
      tracks: [
        { clips: [{ id: 'a', start: 1000, duration: 2000 }, { id: 'b', start: 5000, duration: 1000 }] },
      ],
    } as never;
    const pts = collectSnapPoints(doc, { excludeClipId: 'b', playheadMs: 4444 });
    expect(pts).toContain(0);
    expect(pts).toContain(4444);
    expect(pts).toContain(1000);
    expect(pts).toContain(3000);
    expect(pts).not.toContain(5000);
    expect(pts).not.toContain(6000);
  });
});

describe('겹침·빈자리', () => {
  const clips = [
    { id: 'a', start: 0, duration: 1000 },
    { id: 'b', start: 2000, duration: 1000 },
  ];
  it('hasOverlap: 겹치면 true, 경계 접촉은 false', () => {
    expect(hasOverlap(clips, 500, 1000)).toBe(true);
    expect(hasOverlap(clips, 1000, 1000)).toBe(false); // a 끝~b 시작 딱 맞음
    expect(hasOverlap(clips, 1500, 1000)).toBe(true); // b와 겹침
  });
  it('hasOverlap: excludeId는 무시한다', () => {
    expect(hasOverlap(clips, 100, 500, 'a')).toBe(false);
  });
  it('findFreeStart: 비어 있으면 그대로, 겹치면 뒤로 민다', () => {
    expect(findFreeStart(clips, 1000, 1000)).toBe(1000);
    expect(findFreeStart(clips, 500, 1000)).toBe(1000); // a에 걸림→a 끝(1000), 거기는 b와 안 겹침
    expect(findFreeStart(clips, 500, 1500)).toBe(3000); // a에 걸림→1000, [1000,2500)은 b에 걸림→3000
    expect(findFreeStart([], 700, 1000)).toBe(700);
    expect(findFreeStart(clips, -50, 500)).toBe(1000); // 음수 방지→0, a[0..1000)와 겹침→1000
  });
});

describe('trimRange', () => {
  const video = (over: Partial<VideoClip> = {}): Clip => ({
    id: 'v1',
    kind: 'video',
    assetId: 'as1',
    start: 1000,
    duration: 4000,
    in: 500,
    out: 4500,
    speed: 1,
    volume: 1,
    ...over,
  });

  it('video 시작 트림: 소스 in 한계까지만 왼쪽으로', () => {
    const clip = video();
    const r = trimRange({ clips: [clip] }, clip, 'start', 10000);
    expect(r.min).toBe(500); // start 1000 - in 500
    expect(r.max).toBe(1000 + 4000 - MIN_CLIP_MS);
  });

  it('video 끝 트림: 에셋 길이·이웃 클립 한계', () => {
    const clip = video();
    const solo = trimRange({ clips: [clip] }, clip, 'end', 10000);
    expect(solo.max).toBe(5000 + (10000 - 4500)); // 10500
    const next = { id: 'n', kind: 'video', assetId: 'as1', start: 6000, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1 } as Clip;
    const withNext = trimRange({ clips: [clip, next] }, clip, 'end', 10000);
    expect(withNext.max).toBe(6000);
    expect(withNext.min).toBe(1000 + MIN_CLIP_MS);
  });

  it('speed 반영: 2배속이면 소스 여유가 절반의 타임라인 시간', () => {
    const clip = video({ speed: 2, duration: 2000, in: 0, out: 4000 });
    const r = trimRange({ clips: [clip] }, clip, 'end', 10000);
    // end 3000 + (10000-4000)/2 = 6000
    expect(r.max).toBe(6000);
  });

  it('reversed 클립: 소스 여유를 반대 끝에서 계산한다', () => {
    // 타임라인 t=0 ↔ 소스 out — 왼쪽 연장 여유는 (에셋길이-out), 오른쪽 연장 여유는 in
    const clip = video({ start: 1000, duration: 3500, in: 1000, out: 4500, reversed: true });
    const rs = trimRange({ clips: [clip] }, clip, 'start', 5000);
    expect(rs.min).toBe(500); // 1000 - (5000-4500)
    const re = trimRange({ clips: [clip] }, clip, 'end', 5000);
    expect(re.max).toBe(5500); // (1000+3500) + 1000(in)
    // 같은 값의 정방향 클립과 다르다는 것을 확인 (회귀 방지)
    const fwd = video({ start: 1000, duration: 3500, in: 1000, out: 4500 });
    expect(trimRange({ clips: [fwd] }, fwd, 'start', 5000).min).toBe(0); // 1000 - 1000(in)
    expect(trimRange({ clips: [fwd] }, fwd, 'end', 5000).max).toBe(5000); // 4500 + (5000-4500)
  });

  it('text 클립: 소스 제약 없이 이웃·0초만 제한', () => {
    const text = {
      id: 't1',
      kind: 'text',
      start: 2000,
      duration: 3000,
      text: '안녕',
      style: { fontFamily: 'x', fontSize: 48, color: '#fff', align: 'center' },
    } as Clip;
    const prev = { id: 'p', kind: 'text', start: 0, duration: 1000, text: 'a', style: { fontFamily: 'x', fontSize: 48, color: '#fff', align: 'center' } } as Clip;
    const rs = trimRange({ clips: [prev, text] }, text, 'start');
    expect(rs.min).toBe(1000); // 이전 클립 끝
    const re = trimRange({ clips: [prev, text] }, text, 'end');
    expect(re.min).toBe(2000 + MIN_CLIP_MS);
    expect(re.max).toBeGreaterThan(5000); // 이웃 없음 → 여유
  });
});

// ── W5: 비트 마커·비트 스냅 ────────────────────────────────────────────────

describe('비트 시각 변환 (에셋 ms → 타임라인 ms)', () => {
  const vclip = (over: Partial<VideoClip> = {}): VideoClip => ({
    id: 'v1',
    kind: 'video',
    assetId: 'as1',
    start: 2000,
    duration: 4000,
    in: 1000,
    out: 5000,
    speed: 1,
    volume: 1,
    ...over,
  });

  it('등속 1x: 에셋 절대 → 클립 상대 → 타임라인 절대', () => {
    const clip = vclip();
    expect(assetMsToTimelineMs(clip, 1000)).toBe(2000); // in → 클립 시작
    expect(assetMsToTimelineMs(clip, 3000)).toBe(4000); // in+2000 → start+2000
    expect(assetMsToTimelineMs(clip, 5000)).toBe(6000); // out → 클립 끝
  });

  it('speed 2배면 소스 시간이 절반의 타임라인 시간이 된다', () => {
    const clip = vclip({ speed: 2, duration: 2000, in: 1000, out: 5000 });
    expect(assetMsToTimelineMs(clip, 1000)).toBe(2000);
    expect(assetMsToTimelineMs(clip, 3000)).toBe(3000); // (3000-1000)/2 = 1000
    expect(assetMsToTimelineMs(clip, 5000)).toBe(4000);
  });

  it('소스 구간 [in, out] 밖의 비트는 null', () => {
    const clip = vclip();
    expect(assetMsToTimelineMs(clip, 999)).toBeNull();
    expect(assetMsToTimelineMs(clip, 5001)).toBeNull();
  });

  it('reversed 클립은 타임라인 t=0 이 소스 out 이므로 반대 끝에서 센다', () => {
    const clip = vclip({ reversed: true });
    expect(assetMsToTimelineMs(clip, 5000)).toBe(2000); // out → 클립 시작
    expect(assetMsToTimelineMs(clip, 1000)).toBe(6000); // in → 클립 끝
    expect(assetMsToTimelineMs(clip, 4000)).toBe(3000);
  });

  it('audio 클립도 같은 규칙 (reversed 개념 없음)', () => {
    const audio: AudioClip = {
      id: 'a1',
      kind: 'audio',
      assetId: 'as2',
      start: 500,
      duration: 3000,
      in: 0,
      out: 3000,
      speed: 1,
      volume: 1,
    };
    expect(assetMsToTimelineMs(audio, 0)).toBe(500);
    expect(assetMsToTimelineMs(audio, 1500)).toBe(2000);
  });

  it('clipBeatTimes: 범위 밖 비트를 버리고 오름차순으로 돌려준다', () => {
    const clip = vclip();
    const asset = { id: 'as1', kind: 'video', src: 'a.mp4', name: 'a', beats: [0, 1000, 3000, 5000, 9000] } as Asset;
    expect(clipBeatTimes(clip, asset)).toEqual([2000, 4000, 6000]);
  });

  it('clipBeatTimes: reversed 여도 오름차순으로 정렬된다', () => {
    const clip = vclip({ reversed: true });
    const asset = { id: 'as1', kind: 'video', src: 'a.mp4', name: 'a', beats: [1000, 3000, 5000] } as Asset;
    expect(clipBeatTimes(clip, asset)).toEqual([2000, 4000, 6000]);
  });

  it('clipBeatTimes: beats 없거나 text 클립이면 빈 배열', () => {
    const clip = vclip();
    expect(clipBeatTimes(clip, undefined)).toEqual([]);
    expect(clipBeatTimes(clip, { id: 'as1', kind: 'video', src: 'a.mp4', name: 'a' } as Asset)).toEqual([]);
    const text = { id: 't1', kind: 'text', start: 0, duration: 1000, text: 'x', style: {} } as unknown as Clip;
    expect(clipBeatTimes(text, { id: 'as1', kind: 'audio', src: 'a.m4a', name: 'a', beats: [0, 500] } as Asset)).toEqual([]);
  });
});

describe('collectBeatMarkers', () => {
  const asset = (id: string, beats: number[]): Asset =>
    ({ id, kind: 'audio', src: `${id}.m4a`, name: id, duration: 10000, beats }) as Asset;

  const doc = {
    assets: {
      music: asset('music', [0, 500, 1000]),
      clipvid: { id: 'clipvid', kind: 'video', src: 'v.mp4', name: 'v', beats: [200, 400] } as Asset,
      plain: { id: 'plain', kind: 'video', src: 'p.mp4', name: 'p' } as Asset,
    },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'v1', kind: 'video', assetId: 'clipvid', start: 1000, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1 },
          { id: 'v2', kind: 'video', assetId: 'plain', start: 3000, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1 },
        ],
      },
      {
        kind: 'audio',
        clips: [
          { id: 'a1', kind: 'audio', assetId: 'music', start: 100, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1 },
        ],
      },
    ],
  } as never;

  it('오디오 트랙 클립의 비트는 선택과 무관하게 나온다', () => {
    expect(collectBeatMarkers(doc)).toEqual([100, 600, 1100]);
  });

  it('선택된 video 클립의 에셋 비트가 더해진다', () => {
    expect(collectBeatMarkers(doc, { selectedClipId: 'v1' })).toEqual([100, 600, 1100, 1200, 1400]);
  });

  it('비트가 없는 에셋을 고르면 오디오 트랙 비트만 남는다', () => {
    expect(collectBeatMarkers(doc, { selectedClipId: 'v2' })).toEqual([100, 600, 1100]);
  });

  it('doc 이 null 이면 빈 배열', () => {
    expect(collectBeatMarkers(null)).toEqual([]);
  });
});

describe('비트 스냅', () => {
  it('collectSnapPoints 에 비트 후보가 더해진다', () => {
    const doc = { tracks: [{ clips: [{ id: 'a', start: 1000, duration: 2000 }] }] } as never;
    const pts = collectSnapPoints(doc, { playheadMs: 500, beats: [750, 1750] });
    expect(pts).toContain(750);
    expect(pts).toContain(1750);
    expect(pts).toContain(0);
    expect(pts).toContain(1000);
  });

  it('비트 후보에도 8px 규칙 그대로 스냅된다 (zoom 60 → 133ms)', () => {
    const pts = collectSnapPoints(null, { beats: [2000] });
    expect(snapValue(2100, pts, 60)).toEqual({ ms: 2000, snapped: true });
    expect(snapValue(2200, pts, 60).snapped).toBe(false); // 200ms > 133ms
  });

  it('드래그 이동도 비트에 붙는다 (끝 경계 스냅)', () => {
    // start 900, dur 1000 → end 1900. 비트 2000 은 100ms(6px) → end 스냅 → start 1000
    expect(snapMove(900, 1000, collectSnapPoints(null, { beats: [2000] }), 60)).toBe(1000);
  });
});
