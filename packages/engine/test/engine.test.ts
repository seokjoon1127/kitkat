import { describe, expect, it } from 'vitest';
import {
  createEmptyProject, rampDurationMs, validateDoc, SPEED_RAMP_PRESETS, TEXT_TEMPLATES,
  type Asset, type AudioClip, type ProjectDoc, type SpeedPoint, type TextClip, type VideoClip,
} from '@kitkat/schema';
import { EngineError, applyCommand, applyCommands, checkInvariants, findClip, type Command } from '../src/index.js';

// ── 픽스처 ────────────────────────────────────────────────────────────────

const vAsset: Asset = { id: 'av', kind: 'video', src: 'assets/av.mp4', name: 'av.mp4', duration: 10000 };
const aAsset: Asset = { id: 'aa', kind: 'audio', src: 'assets/aa.wav', name: 'aa.wav', duration: 12000 };
const iAsset: Asset = { id: 'ai', kind: 'image', src: 'assets/ai.jpg', name: 'ai.jpg' };

function vclip(id: string, start: number, duration: number, extra?: Partial<VideoClip>): VideoClip {
  return { id, kind: 'video', assetId: 'av', start, duration, in: 0, out: duration, speed: 1, volume: 1, ...extra };
}
function aclip(id: string, start: number, duration: number, extra?: Partial<AudioClip>): AudioClip {
  return { id, kind: 'audio', assetId: 'aa', start, duration, in: 0, out: duration, speed: 1, volume: 1, ...extra };
}
function tclip(id: string, start: number, duration: number, extra?: Partial<TextClip>): TextClip {
  return {
    id, kind: 'text', start, duration, text: '안녕',
    style: { fontFamily: "Pretendard, 'Malgun Gothic', sans-serif", fontSize: 64, color: '#ffffff', align: 'center' },
    ...extra,
  };
}

/** 에셋 3종이 들어간 빈 프로젝트 (revision 1) */
function setup(): { doc: ProjectDoc; vt: string; tt: string; at: string } {
  let doc = createEmptyProject({ name: '엔진 테스트' });
  doc = applyCommands(doc, [
    { type: 'addAsset', asset: vAsset },
    { type: 'addAsset', asset: aAsset },
    { type: 'addAsset', asset: iAsset },
  ]);
  return { doc, vt: doc.tracks[0]!.id, tt: doc.tracks[1]!.id, at: doc.tracks[2]!.id };
}

function expectEngineError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`EngineError(${code})가 던져지지 않았습니다`);
}

// ── 프로젝트·에셋 명령 ────────────────────────────────────────────────────

describe('renameProject / setSettings', () => {
  it('renameProject: 이름을 바꾸고 revision은 그대로 둔다 (applyCommand)', () => {
    const { doc } = setup();
    const next = applyCommand(doc, { type: 'renameProject', name: '새 이름' });
    expect(next.name).toBe('새 이름');
    expect(next.revision).toBe(doc.revision);
    expect(doc.name).toBe('엔진 테스트'); // 원본 불변
  });

  it('setSettings: 부분 병합 (width만 변경, 나머지 유지)', () => {
    const { doc } = setup();
    const next = applyCommand(doc, { type: 'setSettings', settings: { width: 720 } });
    expect(next.settings.width).toBe(720);
    expect(next.settings.height).toBe(1920);
    expect(next.settings.fps).toBe(30);
  });

  it('setSettings: 잘못된 값(width 음수)은 BAD_SETTINGS', () => {
    const { doc } = setup();
    expectEngineError(() => applyCommand(doc, { type: 'setSettings', settings: { width: -1 } }), 'BAD_SETTINGS');
  });
});

describe('addAsset / removeAsset / updateAsset', () => {
  it('addAsset: 에셋 추가, 중복 id는 DUPLICATE_ID', () => {
    const { doc } = setup();
    expect(doc.assets['av']).toEqual(vAsset);
    expectEngineError(() => applyCommand(doc, { type: 'addAsset', asset: vAsset }), 'DUPLICATE_ID');
  });

  it('addAsset: src에 백슬래시가 있으면 BAD_PATH', () => {
    const { doc } = setup();
    const bad: Asset = { id: 'x1', kind: 'image', src: 'assets\\x1.jpg', name: 'x1' };
    expectEngineError(() => applyCommand(doc, { type: 'addAsset', asset: bad }), 'BAD_PATH');
  });

  it('removeAsset: 미참조 에셋은 삭제, 없는 에셋은 ASSET_NOT_FOUND', () => {
    const { doc } = setup();
    const next = applyCommand(doc, { type: 'removeAsset', assetId: 'ai' });
    expect(next.assets['ai']).toBeUndefined();
    expectEngineError(() => applyCommand(doc, { type: 'removeAsset', assetId: 'nope' }), 'ASSET_NOT_FOUND');
  });

  it('removeAsset: 참조 클립이 있으면 ASSET_IN_USE', () => {
    const { doc, vt } = setup();
    const withClip = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000) });
    expectEngineError(() => applyCommand(withClip, { type: 'removeAsset', assetId: 'av' }), 'ASSET_IN_USE');
  });

  it('removeAsset: LUT으로 쓰는 클립이 있으면 ASSET_IN_USE (clip.source.lut.assetId)', () => {
    const { doc, vt } = setup();
    const lut: Asset = { id: 'lut1', kind: 'lut', src: 'assets/lut1.cube', name: 'lut1.cube' };
    const withLut = applyCommands(doc, [
      { type: 'addAsset', asset: lut },
      {
        type: 'addClip',
        trackId: vt,
        clip: vclip('c1', 0, 2000, { source: { lut: { assetId: 'lut1', intensity: 0.5 } } }),
      },
    ]);
    expectEngineError(() => applyCommand(withLut, { type: 'removeAsset', assetId: 'lut1' }), 'ASSET_IN_USE');
    try {
      applyCommand(withLut, { type: 'removeAsset', assetId: 'lut1' });
    } catch (e) {
      // 어느 클립이 쓰고 있는지 한국어로 알려준다
      expect((e as EngineError).message).toContain('c1');
      expect((e as EngineError).message).toContain('LUT');
    }
  });

  it('removeAsset: audio 클립이 LUT을 쓰는 경우에도 ASSET_IN_USE', () => {
    const { doc, at } = setup();
    const lut: Asset = { id: 'lut2', kind: 'lut', src: 'assets/lut2.cube', name: 'lut2.cube' };
    let d = applyCommands(doc, [
      { type: 'addAsset', asset: lut },
      { type: 'addClip', trackId: at, clip: aclip('ac1', 0, 2000) },
    ]);
    // audio 스키마는 source.lut 을 안 받으므로 문서에 직접 심어 방어선만 확인한다
    (d.tracks.find((t) => t.id === at)!.clips[0] as unknown as Record<string, unknown>)['source'] = {
      lut: { assetId: 'lut2', intensity: 1 },
    };
    expectEngineError(() => applyCommand(d, { type: 'removeAsset', assetId: 'lut2' }), 'ASSET_IN_USE');
  });

  it('removeAsset: 아무 클립도 LUT을 안 쓰면 그냥 지워진다', () => {
    const { doc, vt } = setup();
    const withLut = applyCommands(doc, [
      { type: 'addAsset', asset: { id: 'lut3', kind: 'lut', src: 'assets/lut3.cube', name: 'lut3.cube' } },
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000, { source: { denoise: { amount: 0.4 } } }) },
    ]);
    const next = applyCommand(withLut, { type: 'removeAsset', assetId: 'lut3' });
    expect(next.assets['lut3']).toBeUndefined();
    expect(findClip(next, 'c1')).toBeTruthy();
  });

  it('updateAsset: patch 병합, id 변경은 BAD_PATCH, 백슬래시는 BAD_PATH', () => {
    const { doc } = setup();
    const next = applyCommand(doc, { type: 'updateAsset', assetId: 'av', patch: { proxySrc: 'proxies/av.mp4' } });
    expect(next.assets['av']!.proxySrc).toBe('proxies/av.mp4');
    expect(next.assets['av']!.src).toBe('assets/av.mp4');
    expectEngineError(() => applyCommand(doc, { type: 'updateAsset', assetId: 'av', patch: { id: 'other' } }), 'BAD_PATCH');
    expectEngineError(
      () => applyCommand(doc, { type: 'updateAsset', assetId: 'av', patch: { proxySrc: 'proxies\\av.mp4' } }),
      'BAD_PATH',
    );
  });
});

// ── 트랙 명령 ─────────────────────────────────────────────────────────────

describe('addTrack / removeTrack / reorderTrack / setTrackProps', () => {
  it('addTrack: 기본은 맨 위(끝) 추가, index 지정 시 그 위치 삽입', () => {
    const { doc } = setup();
    const a = applyCommand(doc, { type: 'addTrack', track: { id: 'ov1', kind: 'overlay', name: '오버레이' } });
    expect(a.tracks[3]!.id).toBe('ov1');
    expect(a.tracks[3]!.clips).toEqual([]);
    const b = applyCommand(doc, { type: 'addTrack', track: { id: 'ov2', kind: 'overlay', name: '오버레이2' }, index: 0 });
    expect(b.tracks[0]!.id).toBe('ov2');
  });

  it('removeTrack: 삭제, 없는 트랙은 TRACK_NOT_FOUND', () => {
    const { doc, tt } = setup();
    const next = applyCommand(doc, { type: 'removeTrack', trackId: tt });
    expect(next.tracks).toHaveLength(2);
    expectEngineError(() => applyCommand(doc, { type: 'removeTrack', trackId: 'nope' }), 'TRACK_NOT_FOUND');
  });

  it('reorderTrack: 순서를 옮긴다', () => {
    const { doc, at } = setup();
    const next = applyCommand(doc, { type: 'reorderTrack', trackId: at, index: 0 });
    expect(next.tracks[0]!.id).toBe(at);
    expect(next.tracks).toHaveLength(3);
  });

  it('setTrackProps: 허용 필드 병합, volume 범위 밖은 BAD_PATCH', () => {
    const { doc, at } = setup();
    const next = applyCommand(doc, { type: 'setTrackProps', trackId: at, patch: { muted: true, volume: 0.5, name: '배경음' } });
    const track = next.tracks.find((t) => t.id === at)!;
    expect(track.muted).toBe(true);
    expect(track.volume).toBe(0.5);
    expect(track.name).toBe('배경음');
    expectEngineError(() => applyCommand(doc, { type: 'setTrackProps', trackId: at, patch: { volume: 3 } }), 'BAD_PATCH');
  });
});

// ── 클립 명령 ─────────────────────────────────────────────────────────────

describe('addClip / removeClip / moveClip', () => {
  it('addClip: 추가되고 start 오름차순으로 정렬된다', () => {
    const { doc, vt } = setup();
    const next = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c2', 3000, 2000) },
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000) },
    ]);
    expect(next.tracks[0]!.clips.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('addClip: 겹치면 OVERLAP (경계 맞닿음은 허용)', () => {
    const { doc, vt } = setup();
    const withOne = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000) });
    // 맞닿음(2000에서 시작)은 OK
    const touching = applyCommand(withOne, { type: 'addClip', trackId: vt, clip: vclip('c2', 2000, 1000) });
    expect(touching.tracks[0]!.clips).toHaveLength(2);
    // 겹침(1999에서 시작)은 에러
    expectEngineError(
      () => applyCommand(withOne, { type: 'addClip', trackId: vt, clip: vclip('c3', 1999, 1000) }),
      'OVERLAP',
    );
  });

  it('addClip: 트랙 kind 불일치는 TRACK_KIND_MISMATCH', () => {
    const { doc, at } = setup();
    expectEngineError(() => applyCommand(doc, { type: 'addClip', trackId: at, clip: vclip('c1', 0, 1000) }), 'TRACK_KIND_MISMATCH');
  });

  it('addClip: 없는 에셋 참조는 ASSET_NOT_FOUND, 없는 트랙은 TRACK_NOT_FOUND', () => {
    const { doc, vt } = setup();
    expectEngineError(
      () => applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000, { assetId: 'ghost' }) }),
      'ASSET_NOT_FOUND',
    );
    expectEngineError(() => applyCommand(doc, { type: 'addClip', trackId: 'nope', clip: vclip('c1', 0, 1000) }), 'TRACK_NOT_FOUND');
  });

  it('removeClip: 삭제, 없는 클립은 CLIP_NOT_FOUND', () => {
    const { doc, vt } = setup();
    const withClip = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000) });
    const next = applyCommand(withClip, { type: 'removeClip', clipId: 'c1' });
    expect(findClip(next, 'c1')).toBeNull();
    expectEngineError(() => applyCommand(doc, { type: 'removeClip', clipId: 'c1' }), 'CLIP_NOT_FOUND');
  });

  it('moveClip: 같은 트랙 내 이동 + 재정렬', () => {
    const { doc, vt } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) },
      { type: 'addClip', trackId: vt, clip: vclip('c2', 1000, 1000) },
    ]);
    const next = applyCommand(d1, { type: 'moveClip', clipId: 'c1', start: 5000 });
    expect(next.tracks[0]!.clips.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(findClip(next, 'c1')!.clip.start).toBe(5000);
  });

  it('moveClip: 겹치면 OVERLAP, 트랙 간 이동은 kind 호환 검사', () => {
    const { doc, vt, tt, at } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) },
      { type: 'addClip', trackId: vt, clip: vclip('c2', 2000, 1000) },
      { type: 'addClip', trackId: at, clip: aclip('c3', 0, 1000) },
    ]);
    expectEngineError(() => applyCommand(d1, { type: 'moveClip', clipId: 'c1', start: 2500 }), 'OVERLAP');
    expectEngineError(() => applyCommand(d1, { type: 'moveClip', clipId: 'c1', start: 0, trackId: tt }), 'TRACK_KIND_MISMATCH');
    // 호환되는 트랙 간 이동 (video → 새 video 트랙)
    const d2 = applyCommand(d1, { type: 'addTrack', track: { id: 'v2', kind: 'video', name: '비디오2' } });
    const moved = applyCommand(d2, { type: 'moveClip', clipId: 'c1', start: 100, trackId: 'v2' });
    expect(findClip(moved, 'c1')!.track.id).toBe('v2');
    expect(findClip(moved, 'c1')!.clip.start).toBe(100);
    expect(moved.tracks[0]!.clips.map((c) => c.id)).toEqual(['c2']);
  });
});

// ── splitClip ─────────────────────────────────────────────────────────────

describe('splitClip', () => {
  it('video 중간 분할: duration·in/out 재계산, 오른쪽은 새 id', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 1000, 4000, { in: 500, out: 4500 }),
    });
    const next = applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 2000 });
    const clips = next.tracks[0]!.clips;
    expect(clips).toHaveLength(2);
    const [left, right] = clips as [VideoClip, VideoClip];
    expect(left.id).toBe('c1');
    expect(left.start).toBe(1000);
    expect(left.duration).toBe(1000);
    expect(left.in).toBe(500);
    expect(left.out).toBe(1500);
    expect(right.id).not.toBe('c1');
    expect(right.start).toBe(2000);
    expect(right.duration).toBe(3000);
    expect(right.in).toBe(1500);
    expect(right.out).toBe(4500);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('speed 2 분할: 소스 분할점이 in + 타임라인경과×2', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 0, 2000, { in: 0, out: 4000, speed: 2 }),
    });
    const next = applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 500 });
    const [left, right] = next.tracks[0]!.clips as [VideoClip, VideoClip];
    expect(left.out).toBe(1000);   // 0 + 500*2
    expect(right.in).toBe(1000);
    expect(right.out).toBe(4000);
    expect(right.duration).toBe(1500);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('경계 분할(at=start, at=end, 바깥)은 BAD_SPLIT', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 1000, 2000) });
    expectEngineError(() => applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 1000 }), 'BAD_SPLIT');
    expectEngineError(() => applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 3000 }), 'BAD_SPLIT');
    expectEngineError(() => applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 500 }), 'BAD_SPLIT');
  });

  it('keyframes 좌/우 분배 + 분할점 보간값을 경계 키프레임으로 삽입 (진행 중 램프 보존)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 0, 4000, {
        out: 4000,
        keyframes: [
          { time: 0, prop: 'opacity', value: 0, easing: 'linear' },
          { time: 3000, prop: 'opacity', value: 1, easing: 'linear' },
        ],
      }),
    });
    const next = applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 1000 });
    const [left, right] = next.tracks[0]!.clips as [VideoClip, VideoClip];
    // 분할 전 t=1000 의 opacity = 1/3 — 왼쪽 끝·오른쪽 시작에 경계 키프레임으로 남는다
    expect(left.keyframes).toHaveLength(2);
    expect(left.keyframes![0]).toEqual({ time: 0, prop: 'opacity', value: 0, easing: 'linear' });
    expect(left.keyframes![1]!.time).toBe(1000);
    expect(left.keyframes![1]!.value).toBeCloseTo(1 / 3, 6);
    expect(right.keyframes).toHaveLength(2);
    expect(right.keyframes![0]!.time).toBe(0);
    expect(right.keyframes![0]!.value).toBeCloseTo(1 / 3, 6);
    expect(right.keyframes![1]).toEqual({ time: 2000, prop: 'opacity', value: 1, easing: 'linear' });
  });

  it('분할점에 키프레임이 정확히 있으면 경계 키프레임을 추가하지 않는다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 0, 4000, {
        out: 4000,
        keyframes: [
          { time: 0, prop: 'opacity', value: 0, easing: 'linear' },
          { time: 1000, prop: 'opacity', value: 0.5, easing: 'linear' },
          { time: 3000, prop: 'opacity', value: 1, easing: 'linear' },
        ],
      }),
    });
    const next = applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 1000 });
    const [left, right] = next.tracks[0]!.clips as [VideoClip, VideoClip];
    expect(left.keyframes).toEqual([
      { time: 0, prop: 'opacity', value: 0, easing: 'linear' },
      { time: 1000, prop: 'opacity', value: 0.5, easing: 'linear' },
    ]);
    expect(right.keyframes).toEqual([
      { time: 0, prop: 'opacity', value: 0.5, easing: 'linear' },
      { time: 2000, prop: 'opacity', value: 1, easing: 'linear' },
    ]);
  });

  it('newClipId를 주면 오른쪽 조각이 그 id를 갖는다 (결정적 재적용)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000) });
    const a = applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 1500, newClipId: 'right-1' });
    const b = applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 1500, newClipId: 'right-1' });
    expect(a.tracks[0]!.clips.map((c) => c.id)).toEqual(['c1', 'right-1']);
    expect(a).toEqual(b); // 같은 명령을 어디서 재적용해도 결과 동일
    // 이미 존재하는 id는 거부
    expectEngineError(
      () => applyCommand(a, { type: 'splitClip', clipId: 'c1', at: 700, newClipId: 'right-1' }),
      'DUPLICATE_ID',
    );
  });

  it('reversed 클립 분할: 소스 구간을 반대 끝에서 분배한다', () => {
    const { doc, vt } = setup();
    // 타임라인 t=0 ↔ 소스 out(4000), t=4000 ↔ 소스 in(0)
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 1000, 4000, { in: 0, out: 4000, reversed: true }),
    });
    const next = applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 3000 });
    const [left, right] = next.tracks[0]!.clips as [VideoClip, VideoClip];
    // 왼쪽(앞 2초)은 분할 전에 소스 4000→2000 을 보여줬다 → [2000..4000] 유지
    expect(left.in).toBe(2000);
    expect(left.out).toBe(4000);
    expect(left.duration).toBe(2000);
    // 오른쪽(뒤 2초)은 소스 2000→0 → [0..2000]
    expect(right.in).toBe(0);
    expect(right.out).toBe(2000);
    expect(right.duration).toBe(2000);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('splitClip: at이 정수 ms가 아니면 BAD_SPLIT (float 오염 차단)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000) });
    expectEngineError(() => applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 1333.3333 }), 'BAD_SPLIT');
  });

  it('text 분할: duration만 분할, words는 시간 기준 분배', () => {
    const { doc, tt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: tt,
      clip: tclip('t1', 0, 3000, {
        words: [
          { text: '가', start: 0, duration: 500 },
          { text: '나', start: 1500, duration: 500 },
          { text: '다', start: 2500, duration: 400 },
        ],
      }),
    });
    const next = applyCommand(d1, { type: 'splitClip', clipId: 't1', at: 1000 });
    const [left, right] = next.tracks[1]!.clips as [TextClip, TextClip];
    expect(left.duration).toBe(1000);
    expect(left.words).toEqual([{ text: '가', start: 0, duration: 500 }]);
    expect(right.start).toBe(1000);
    expect(right.duration).toBe(2000);
    expect(right.words).toEqual([
      { text: '나', start: 500, duration: 500 },
      { text: '다', start: 1500, duration: 400 },
    ]);
    // text 클립엔 in/out이 생기지 않는다
    expect('in' in left).toBe(false);
  });

  it('text 분할: animationOut은 오른쪽에만, animationIn은 왼쪽에만 남는다', () => {
    const { doc, tt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: tt,
      clip: tclip('t1', 0, 3000, {
        animationIn: { type: 'popIn', duration: 400 },
        animationOut: { type: 'fade', duration: 300 },
      }),
    });
    const next = applyCommand(d1, { type: 'splitClip', clipId: 't1', at: 1500 });
    const [left, right] = next.tracks[1]!.clips as [TextClip, TextClip];
    expect(left.animationIn).toEqual({ type: 'popIn', duration: 400 });
    expect(left.animationOut).toBeUndefined(); // 분할점 직전에 사라지는 애니 방지
    expect(right.animationOut).toEqual({ type: 'fade', duration: 300 });
    expect(right.animationIn).toBeUndefined(); // 문장 중간에 다시 팝인하는 애니 방지
  });

  it('transitionOut/fadeOut은 오른쪽에만, transitionIn/fadeIn은 왼쪽에만 남는다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 0, 2000, {
        transitionIn: { type: 'fade', duration: 300 },
        transitionOut: { type: 'zoomIn', duration: 600 },
        fadeIn: 100, fadeOut: 200,
      }),
    });
    const next = applyCommand(d1, { type: 'splitClip', clipId: 'c1', at: 1000 });
    const [left, right] = next.tracks[0]!.clips as [VideoClip, VideoClip];
    expect(left.transitionIn).toEqual({ type: 'fade', duration: 300 });
    expect(left.transitionOut).toBeUndefined();
    expect(left.fadeIn).toBe(100);
    expect(left.fadeOut).toBeUndefined();
    expect(right.transitionOut).toEqual({ type: 'zoomIn', duration: 600 });
    expect(right.transitionIn).toBeUndefined();
    expect(right.fadeOut).toBe(200);
    expect(right.fadeIn).toBeUndefined();
  });
});

// ── trimClip ──────────────────────────────────────────────────────────────

describe('trimClip', () => {
  it('video start 트림: in 재계산', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 1000, 3000, { in: 500, out: 3500 }) });
    const next = applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'start', to: 2000 });
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.start).toBe(2000);
    expect(clip.duration).toBe(2000);
    expect(clip.in).toBe(1500);
    expect(clip.out).toBe(3500);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('video end 트림 연장: out 재계산, 소스 길이 초과는 SOURCE_RANGE', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 3000, { in: 0, out: 3000 }) });
    const next = applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'end', to: 5000 });
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.duration).toBe(5000);
    expect(clip.out).toBe(5000);
    // vAsset.duration = 10000 → 12000까지 연장 불가
    expectEngineError(() => applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'end', to: 12000 }), 'SOURCE_RANGE');
  });

  it('video start를 왼쪽으로 연장할 때 소스 앞이 모자라면 SOURCE_RANGE', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 2000, 2000, { in: 0, out: 2000 }) });
    expectEngineError(() => applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'start', to: 1000 }), 'SOURCE_RANGE');
  });

  it('text/image 트림: start/duration만 조정 (in/out 없음)', () => {
    const { doc, tt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: tt, clip: tclip('t1', 1000, 3000) });
    const a = applyCommand(d1, { type: 'trimClip', clipId: 't1', edge: 'start', to: 2000 });
    expect(findClip(a, 't1')!.clip.start).toBe(2000);
    expect(findClip(a, 't1')!.clip.duration).toBe(2000);
    const b = applyCommand(d1, { type: 'trimClip', clipId: 't1', edge: 'end', to: 2500 });
    expect(findClip(b, 't1')!.clip.duration).toBe(1500);
  });

  it('reversed 클립 start 트림: out을 조정한다 (화면 앞부분 = 소스 out 쪽)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 1000, 4000, { in: 0, out: 4000, reversed: true }),
    });
    const next = applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'start', to: 2000 });
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    // 첫 1초(소스 4000→3000 구간)를 잘라냈으니 out이 3000으로 줄어야 한다
    expect(clip.start).toBe(2000);
    expect(clip.duration).toBe(3000);
    expect(clip.in).toBe(0);
    expect(clip.out).toBe(3000);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('reversed 클립 start 왼쪽 연장: 소스 끝(에셋 길이)을 넘으면 SOURCE_RANGE', () => {
    const { doc, vt } = setup();
    // vAsset.duration = 10000, out 9000 → start 쪽 여유는 1000ms 뿐
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 2000, 4000, { in: 5000, out: 9000, reversed: true }),
    });
    const ok = applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'start', to: 1000 });
    expect((findClip(ok, 'c1')!.clip as VideoClip).out).toBe(10000);
    expectEngineError(() => applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'start', to: 0 }), 'SOURCE_RANGE');
  });

  it('reversed 클립 end 트림: in을 조정하고, 소스 앞이 모자라면 SOURCE_RANGE', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 0, 4000, { in: 2000, out: 6000, reversed: true }),
    });
    const next = applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'end', to: 5000 });
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.duration).toBe(5000);
    expect(clip.in).toBe(1000); // 끝을 늘리면 소스 앞쪽(in)이 내려간다
    expect(clip.out).toBe(6000);
    expectEngineError(() => applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'end', to: 7000 }), 'SOURCE_RANGE');
  });

  it('start 트림 시 keyframes를 새 시작점 기준으로 재기준한다 (경계 보간 포함)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 0, 3000, {
        out: 3000,
        keyframes: [
          { time: 0, prop: 'scale', value: 0.5, easing: 'linear' },
          { time: 1000, prop: 'scale', value: 1, easing: 'linear' },
        ],
      }),
    });
    // 500ms 트림 → t=500의 보간값 0.75가 time 0 경계 키프레임으로, 1000 키프레임은 500으로
    const half = applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'start', to: 500 });
    const kfsHalf = findClip(half, 'c1')!.clip.keyframes!;
    expect(kfsHalf).toHaveLength(2);
    expect(kfsHalf[0]!.time).toBe(0);
    expect(kfsHalf[0]!.value).toBeCloseTo(0.75, 6);
    expect(kfsHalf[1]).toEqual({ time: 500, prop: 'scale', value: 1, easing: 'linear' });
    // 램프가 끝난 지점(1000) 이후로 트림하면 마지막 값 상수만 남는다 — 애니 재생 반복 방지
    const past = applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'start', to: 1000 });
    expect(findClip(past, 'c1')!.clip.keyframes).toEqual([
      { time: 0, prop: 'scale', value: 1, easing: 'linear' },
    ]);
  });

  it('text start 트림 시 words를 재기준한다 (하이라이트 싱크 유지)', () => {
    const { doc, tt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: tt,
      clip: tclip('t1', 2000, 3000, {
        words: [
          { text: '가', start: 0, duration: 400 },
          { text: '나', start: 1000, duration: 400 },
        ],
      }),
    });
    const next = applyCommand(d1, { type: 'trimClip', clipId: 't1', edge: 'start', to: 2500 });
    const clip = findClip(next, 't1')!.clip as TextClip;
    expect(clip.words).toEqual([{ text: '나', start: 500, duration: 400 }]);
    // 왼쪽으로 되돌리는 연장은 words를 뒤로 민다
    const back = applyCommand(next, { type: 'trimClip', clipId: 't1', edge: 'start', to: 2000 });
    expect((findClip(back, 't1')!.clip as TextClip).words).toEqual([{ text: '나', start: 1000, duration: 400 }]);
  });

  it('트림 지점이 정수 ms가 아니면 BAD_TRIM', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 3000) });
    expectEngineError(() => applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'end', to: 2500.5 }), 'BAD_TRIM');
  });

  it('duration이 0 이하가 되는 트림은 BAD_TRIM, 이웃과 겹치는 연장은 OVERLAP', () => {
    const { doc, vt } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000) },
      { type: 'addClip', trackId: vt, clip: vclip('c2', 3000, 1000) },
    ]);
    expectEngineError(() => applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'end', to: 0 }), 'BAD_TRIM');
    expectEngineError(() => applyCommand(d1, { type: 'trimClip', clipId: 'c1', edge: 'end', to: 3500 }), 'OVERLAP');
  });
});

// ── setClipSpeed / setReversed ────────────────────────────────────────────

describe('setClipSpeed / setReversed', () => {
  it('setClipSpeed: duration = (out-in)/speed 재계산', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    const next = applyCommand(d1, { type: 'setClipSpeed', clipId: 'c1', speed: 2 });
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.speed).toBe(2);
    expect(clip.duration).toBe(2000);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('setClipSpeed: 범위 밖 speed는 BAD_SPEED, text 클립은 BAD_COMMAND, 느려져 겹치면 OVERLAP', () => {
    const { doc, vt, tt } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000, { out: 2000 }) },
      { type: 'addClip', trackId: vt, clip: vclip('c2', 2000, 1000) },
      { type: 'addClip', trackId: tt, clip: tclip('t1', 0, 1000) },
    ]);
    expectEngineError(() => applyCommand(d1, { type: 'setClipSpeed', clipId: 'c1', speed: 0.05 }), 'BAD_SPEED');
    expectEngineError(() => applyCommand(d1, { type: 'setClipSpeed', clipId: 't1', speed: 2 }), 'BAD_COMMAND');
    expectEngineError(() => applyCommand(d1, { type: 'setClipSpeed', clipId: 'c1', speed: 0.5 }), 'OVERLAP');
  });

  it('setReversed: video는 토글, audio는 BAD_COMMAND', () => {
    const { doc, vt, at } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) },
      { type: 'addClip', trackId: at, clip: aclip('c2', 0, 1000) },
    ]);
    const on = applyCommand(d1, { type: 'setReversed', clipId: 'c1', reversed: true });
    expect((findClip(on, 'c1')!.clip as VideoClip).reversed).toBe(true);
    const off = applyCommand(on, { type: 'setReversed', clipId: 'c1', reversed: false });
    expect((findClip(off, 'c1')!.clip as VideoClip).reversed).toBeUndefined();
    expectEngineError(() => applyCommand(d1, { type: 'setReversed', clipId: 'c2', reversed: true }), 'BAD_COMMAND');
  });
});

// ── updateClip / setKeyframes ─────────────────────────────────────────────

describe('updateClip', () => {
  it('transform/opacity 등 patch 적용', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) });
    const next = applyCommand(d1, {
      type: 'updateClip', clipId: 'c1',
      patch: { transform: { x: 0.1, y: -0.2, scale: 1.5, rotation: 90 }, opacity: 0.5 },
    });
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.transform).toEqual({ x: 0.1, y: -0.2, scale: 1.5, rotation: 90 });
    expect(clip.opacity).toBe(0.5);
  });

  it('kind/start/duration/in/out/speed/reversed patch는 BAD_PATCH', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) });
    for (const key of ['kind', 'id', 'start', 'duration', 'in', 'out', 'speed', 'reversed']) {
      expectEngineError(() => applyCommand(d1, { type: 'updateClip', clipId: 'c1', patch: { [key]: 1 } }), 'BAD_PATCH');
    }
  });

  it('reversed:true patch는 BAD_PATCH — setReversed 경로(역재생 파일 생성 훅)를 우회할 수 없다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) });
    expectEngineError(
      () => applyCommand(d1, { type: 'updateClip', clipId: 'c1', patch: { reversed: true } }),
      'BAD_PATCH',
    );
  });

  it('스키마 위반 값(opacity 3)은 BAD_PATCH, null은 필드 제거', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000, { opacity: 0.5 }) });
    expectEngineError(() => applyCommand(d1, { type: 'updateClip', clipId: 'c1', patch: { opacity: 3 } }), 'BAD_PATCH');
    const cleared = applyCommand(d1, { type: 'updateClip', clipId: 'c1', patch: { opacity: null } });
    expect(findClip(cleared, 'c1')!.clip.opacity).toBeUndefined();
  });
});

describe('setKeyframes', () => {
  it('키프레임 통째 교체 + time 오름차순 정렬', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) });
    const next = applyCommand(d1, {
      type: 'setKeyframes', clipId: 'c1',
      keyframes: [
        { time: 500, prop: 'scale', value: 2, easing: 'easeOut' },
        { time: 0, prop: 'scale', value: 1, easing: 'linear' },
      ],
    });
    expect(findClip(next, 'c1')!.clip.keyframes!.map((k) => k.time)).toEqual([0, 500]);
  });

  it('audio 클립엔 volume만 허용 — 다른 prop은 BAD_KEYFRAME', () => {
    const { doc, at } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: at, clip: aclip('c1', 0, 1000) });
    const ok = applyCommand(d1, {
      type: 'setKeyframes', clipId: 'c1',
      keyframes: [{ time: 0, prop: 'volume', value: 0.5, easing: 'linear' }],
    });
    expect(findClip(ok, 'c1')!.clip.keyframes).toHaveLength(1);
    expectEngineError(
      () => applyCommand(d1, { type: 'setKeyframes', clipId: 'c1', keyframes: [{ time: 0, prop: 'x', value: 0, easing: 'linear' }] }),
      'BAD_KEYFRAME',
    );
  });
});

// ── 최종 검증 관문 (applyCommands가 스키마 위반 문서를 내보내지 않는다) ──

describe('applyCommands 최종 검증 관문', () => {
  it('updateAsset patch: {src:null} 로 필수 필드를 지우면 INVALID_DOC (문서 영구 손상 차단)', () => {
    const { doc } = setup();
    expectEngineError(
      () => applyCommands(doc, [{ type: 'updateAsset', assetId: 'av', patch: { src: null as unknown as string } }]),
      'INVALID_DOC',
    );
  });

  it('비정수 duration 클립(addClip)은 INVALID_DOC', () => {
    const { doc, tt } = setup();
    expectEngineError(
      () => applyCommands(doc, [{ type: 'addClip', trackId: tt, clip: tclip('t1', 0, 100.5) }]),
      'INVALID_DOC',
    );
  });

  it('addClip: duration ≠ (out-in)/speed 는 BAD_CLIP (렌더 프리즈 소스 차단)', () => {
    const { doc, vt } = setup();
    expectEngineError(
      () => applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000, { in: 0, out: 4000, speed: 1 }) }),
      'BAD_CLIP',
    );
    expectEngineError(
      () => applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000, { in: 3000, out: 1000 }) }),
      'BAD_CLIP',
    );
  });

  it('moveClip: 비정수 start는 BAD_MOVE', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) });
    expectEngineError(() => applyCommand(d1, { type: 'moveClip', clipId: 'c1', start: 1333.3333 }), 'BAD_MOVE');
  });
});

// ── restoreDoc / revision / 원자성 / 불변성 ──────────────────────────────

describe('restoreDoc', () => {
  it('문서를 교체하되 id는 유지하고 revision은 applyCommands가 관리', () => {
    const { doc } = setup();
    const snapshot = structuredClone(doc);
    const edited = applyCommands(doc, [{ type: 'renameProject', name: '편집됨' }]);
    const restored = applyCommands(edited, [{ type: 'restoreDoc', doc: snapshot }]);
    expect(restored.name).toBe('엔진 테스트');
    expect(restored.id).toBe(doc.id);
    expect(restored.revision).toBe(edited.revision + 1); // 되돌려도 revision은 전진
  });

  it('유효하지 않은 문서는 INVALID_DOC', () => {
    const { doc } = setup();
    const bad = structuredClone(doc) as Record<string, unknown>;
    bad['schemaVersion'] = 99;
    expectEngineError(() => applyCommand(doc, { type: 'restoreDoc', doc: bad as unknown as ProjectDoc }), 'INVALID_DOC');
  });
});

describe('revision·원자성·불변성', () => {
  it('applyCommand는 revision을 바꾸지 않고, applyCommands는 배치당 +1', () => {
    const { doc, vt } = setup();
    const single = applyCommand(doc, { type: 'renameProject', name: 'x' });
    expect(single.revision).toBe(doc.revision);
    const batch = applyCommands(doc, [
      { type: 'renameProject', name: 'x' },
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) },
      { type: 'setTrackProps', trackId: vt, patch: { muted: true } },
    ]);
    expect(batch.revision).toBe(doc.revision + 1);
  });

  it('원자성: 배치 중간에 실패하면 throw되고 원본 문서는 그대로다', () => {
    const { doc, vt } = setup();
    const before = structuredClone(doc);
    const cmds: Command[] = [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000) },
      { type: 'addClip', trackId: vt, clip: vclip('c2', 1000, 2000) }, // 겹침 → 실패
    ];
    expect(() => applyCommands(doc, cmds)).toThrowError(EngineError);
    expect(doc).toEqual(before); // 부분 적용 없음 + 원본 비변형
  });

  it('불변성: applyCommand는 원본을 변형하지 않는 새 문서를 돌려준다', () => {
    const { doc, vt } = setup();
    const before = structuredClone(doc);
    const next = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) });
    expect(next).not.toBe(doc);
    expect(doc).toEqual(before);
    expect(next.tracks[0]!.clips).toHaveLength(1);
    expect(doc.tracks[0]!.clips).toHaveLength(0);
  });
});

// ── findClip / checkInvariants ────────────────────────────────────────────

describe('findClip', () => {
  it('트랙·클립·인덱스를 찾고, 없으면 null', () => {
    const { doc, at } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: at, clip: aclip('c1', 0, 1000) },
      { type: 'addClip', trackId: at, clip: aclip('c2', 1000, 1000) },
    ]);
    const found = findClip(d1, 'c2')!;
    expect(found.track.id).toBe(at);
    expect(found.index).toBe(1);
    expect(found.clip.id).toBe('c2');
    expect(findClip(d1, 'ghost')).toBeNull();
  });
});

describe('checkInvariants', () => {
  it('정상 문서는 빈 배열', () => {
    const { doc, vt, at } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000) },
      { type: 'addClip', trackId: at, clip: aclip('c2', 500, 1000) },
    ]);
    expect(checkInvariants(d1)).toEqual([]);
  });

  it('겹침·죽은 assetId·duration/speed 불일치·잘못된 키프레임·백슬래시 경로를 잡아낸다', () => {
    const { doc, vt } = setup();
    const broken = structuredClone(doc);
    broken.tracks[0]!.clips = [
      vclip('c1', 0, 2000),
      vclip('c2', 1000, 2000, { assetId: 'ghost' }),                       // 겹침 + 죽은 에셋
      vclip('c3', 4000, 999, { in: 0, out: 2000, speed: 1 }),              // duration ≠ (out-in)/speed
      aclip('c4', 6000, 1000, { keyframes: [{ time: 0, prop: 'x', value: 0, easing: 'linear' }] }), // audio에 x 키프레임 + 트랙 kind 불일치
    ];
    broken.assets['bad'] = { id: 'bad', kind: 'image', src: 'assets\\bad.jpg', name: 'bad' };
    const problems = checkInvariants(broken);
    expect(problems.some((p) => p.includes('겹칩니다'))).toBe(true);
    expect(problems.some((p) => p.includes('ghost'))).toBe(true);
    expect(problems.some((p) => p.includes('duration'))).toBe(true);
    expect(problems.some((p) => p.includes("'x'"))).toBe(true);
    expect(problems.some((p) => p.includes('백슬래시'))).toBe(true);
    expect(problems.some((p) => p.includes('audio 클립'))).toBe(true);
  });
});

// ══ W5 확장 (X2) ══════════════════════════════════════════════════════════

// ── freezeFrame ───────────────────────────────────────────────────────────

describe('freezeFrame', () => {
  it('3조각으로 나눈다: 왼쪽 / 정지(freeze, out=in+1, speed=1) / 오른쪽(start = at + duration)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt, clip: vclip('c1', 1000, 4000, { in: 500, out: 4500 }),
    });
    const next = applyCommands(d1, [
      { type: 'freezeFrame', clipId: 'c1', at: 2000, duration: 1000, newClipIds: ['fz', 'rt'] },
    ]);
    const clips = next.tracks[0]!.clips as VideoClip[];
    expect(clips.map((c) => c.id)).toEqual(['c1', 'fz', 'rt']);
    const [left, still, right] = clips as [VideoClip, VideoClip, VideoClip];
    expect([left.start, left.duration, left.in, left.out]).toEqual([1000, 1000, 500, 1500]);
    expect([still.start, still.duration, still.in, still.out]).toEqual([2000, 1000, 1500, 1501]);
    expect(still.freeze).toBe(true);
    expect(still.speed).toBe(1);
    expect([right.start, right.duration, right.in, right.out]).toEqual([3000, 3000, 1500, 4500]);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('같은 트랙의 뒤쪽 클립을 duration만큼 민다 (다른 트랙은 그대로)', () => {
    const { doc, vt, at } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000) },
      { type: 'addClip', trackId: vt, clip: vclip('c2', 3000, 1000) },
      { type: 'addClip', trackId: at, clip: aclip('a1', 2500, 1000) },
    ]);
    const next = applyCommands(d1, [
      { type: 'freezeFrame', clipId: 'c1', at: 1000, duration: 500, newClipIds: ['fz', 'rt'] },
    ]);
    expect(findClip(next, 'c2')!.clip.start).toBe(3500);   // 뒤 클립은 밀린다
    expect(findClip(next, 'a1')!.clip.start).toBe(2500);   // 다른 트랙은 그대로
    expect(findClip(next, 'rt')!.clip.start).toBe(1500);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('reversed 클립은 splitClip과 같은 미러링 규칙을 따르고 정지 클립은 reversed를 버린다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { in: 0, out: 4000, reversed: true }),
    });
    const next = applyCommands(d1, [
      { type: 'freezeFrame', clipId: 'c1', at: 3000, duration: 500, newClipIds: ['fz', 'rt'] },
    ]);
    const [left, still, right] = next.tracks[0]!.clips as [VideoClip, VideoClip, VideoClip];
    expect([left.in, left.out, left.duration]).toEqual([1000, 4000, 3000]);
    expect([still.in, still.out, still.start]).toEqual([1000, 1001, 3000]);
    expect(still.reversed).toBeUndefined();
    expect([right.in, right.out, right.start, right.duration]).toEqual([0, 1000, 3500, 1000]);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('경계·비정수 at은 BAD_SPLIT, 0 이하·비정수 duration은 BAD_FREEZE', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 1000, 2000) });
    const cmd = (at: number, duration = 500): Command => ({ type: 'freezeFrame', clipId: 'c1', at, duration });
    expectEngineError(() => applyCommand(d1, cmd(1000)), 'BAD_SPLIT');
    expectEngineError(() => applyCommand(d1, cmd(3000)), 'BAD_SPLIT');
    expectEngineError(() => applyCommand(d1, cmd(1500.5)), 'BAD_SPLIT');
    expectEngineError(() => applyCommand(d1, cmd(1500, 0)), 'BAD_FREEZE');
    expectEngineError(() => applyCommand(d1, cmd(1500, 100.5)), 'BAD_FREEZE');
  });

  it('newClipIds를 주면 결정적이고, 이미 있는 id는 DUPLICATE_ID', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000) });
    const cmd: Command = { type: 'freezeFrame', clipId: 'c1', at: 2000, duration: 800, newClipIds: ['fz', 'rt'] };
    const a = applyCommand(d1, cmd);
    const b = applyCommand(d1, cmd);
    expect(a).toEqual(b);
    expectEngineError(
      () => applyCommand(a, { type: 'freezeFrame', clipId: 'c1', at: 1000, duration: 500, newClipIds: ['fz', 'x'] }),
      'DUPLICATE_ID',
    );
    // 미지정이면 새 id 2개를 채운다
    const auto = applyCommand(d1, { type: 'freezeFrame', clipId: 'c1', at: 2000, duration: 800 });
    expect(auto.tracks[0]!.clips).toHaveLength(3);
    expect(new Set(auto.tracks[0]!.clips.map((c) => c.id)).size).toBe(3);
  });

  it('video 이외 클립·정지/루프/램프 클립은 거부한다', () => {
    const { doc, vt, tt } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: tt, clip: tclip('t1', 0, 3000) },
      { type: 'addClip', trackId: vt, clip: vclip('f1', 0, 3000, { in: 0, out: 1, speed: 1, freeze: true }) },
    ]);
    expectEngineError(() => applyCommand(d1, { type: 'freezeFrame', clipId: 't1', at: 1000, duration: 500 }), 'BAD_COMMAND');
    expectEngineError(() => applyCommand(d1, { type: 'freezeFrame', clipId: 'f1', at: 1000, duration: 500 }), 'BAD_FREEZE');
  });

  it('키프레임은 splitClip과 같이 분배되고 정지 클립은 경계값을 상수로 갖는다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt,
      clip: vclip('c1', 0, 4000, {
        out: 4000,
        keyframes: [
          { time: 0, prop: 'opacity', value: 0, easing: 'linear' },
          { time: 3000, prop: 'opacity', value: 1, easing: 'linear' },
        ],
      }),
    });
    const next = applyCommands(d1, [
      { type: 'freezeFrame', clipId: 'c1', at: 1000, duration: 600, newClipIds: ['fz', 'rt'] },
    ]);
    const [left, still, right] = next.tracks[0]!.clips as [VideoClip, VideoClip, VideoClip];
    expect(left.keyframes!.map((k) => k.time)).toEqual([0, 1000]);
    expect(still.keyframes).toHaveLength(1);
    expect(still.keyframes![0]!.time).toBe(0);
    expect(still.keyframes![0]!.value).toBeCloseTo(1 / 3, 6);
    expect(right.keyframes!.map((k) => k.time)).toEqual([0, 2000]);
  });
});

// ── setSpeedRamp ──────────────────────────────────────────────────────────

const flat2 = (speed: number): SpeedPoint[] => [{ u: 0, speed }, { u: 1, speed }];

describe('setSpeedRamp', () => {
  it('duration = rampDurationMs (등속 램프는 (out-in)/speed와 같다)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    const next = applyCommands(d1, [{ type: 'setSpeedRamp', clipId: 'c1', points: flat2(2) }]);
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.speedRamp).toEqual({ points: flat2(2) });
    expect(clip.duration).toBe(2000);
    expect(clip.speed).toBe(1);          // speed 필드는 건드리지 않는다
    expect(checkInvariants(next)).toEqual([]);
  });

  it('프리셋(몽타주) 적용: duration이 rampDurationMs와 일치한다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 6000, { out: 6000 }) });
    const points = SPEED_RAMP_PRESETS.find((p) => p.id === 'montage')!.points;
    const next = applyCommands(d1, [{ type: 'setSpeedRamp', clipId: 'c1', points }]);
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.duration).toBe(rampDurationMs(clip));
    expect(clip.duration).toBeLessThan(6000);   // 중간이 빨라졌으니 짧아진다
    expect(checkInvariants(next)).toEqual([]);
  });

  it('points:null이면 램프를 지우고 duration을 (out-in)/speed로 복원한다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 6000, { out: 6000 }) });
    const ramped = applyCommands(d1, [{ type: 'setSpeedRamp', clipId: 'c1', points: flat2(3) }]);
    expect((findClip(ramped, 'c1')!.clip as VideoClip).duration).toBe(2000);
    const cleared = applyCommands(ramped, [{ type: 'setSpeedRamp', clipId: 'c1', points: null }]);
    const clip = findClip(cleared, 'c1')!.clip as VideoClip;
    expect(clip.speedRamp).toBeUndefined();
    expect(clip.duration).toBe(6000);
    expect(checkInvariants(cleared)).toEqual([]);
  });

  it('검증 실패 4종(최소 2점·첫 u≠0·마지막 u≠1·u 오름차순 아님)은 BAD_RAMP', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    const bad = (points: SpeedPoint[]): Command => ({ type: 'setSpeedRamp', clipId: 'c1', points });
    expectEngineError(() => applyCommand(d1, bad([{ u: 0, speed: 1 }])), 'BAD_RAMP');
    expectEngineError(() => applyCommand(d1, bad([{ u: 0.1, speed: 1 }, { u: 1, speed: 1 }])), 'BAD_RAMP');
    expectEngineError(() => applyCommand(d1, bad([{ u: 0, speed: 1 }, { u: 0.9, speed: 1 }])), 'BAD_RAMP');
    expectEngineError(
      () => applyCommand(d1, bad([{ u: 0, speed: 1 }, { u: 0.5, speed: 1 }, { u: 0.4, speed: 1 }, { u: 1, speed: 1 }])),
      'BAD_RAMP',
    );
  });

  it('램프 speed가 0.1..100 범위를 벗어나면 BAD_RAMP', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    expectEngineError(
      () => applyCommand(d1, { type: 'setSpeedRamp', clipId: 'c1', points: [{ u: 0, speed: 0.05 }, { u: 1, speed: 1 }] }),
      'BAD_RAMP',
    );
    expectEngineError(
      () => applyCommand(d1, { type: 'setSpeedRamp', clipId: 'c1', points: [{ u: 0, speed: 1 }, { u: 1, speed: 101 }] }),
      'BAD_RAMP',
    );
  });

  it('램프가 걸린 클립은 splitClip을 거부한다 (BAD_RAMP)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    const ramped = applyCommands(d1, [{ type: 'setSpeedRamp', clipId: 'c1', points: flat2(2) }]);
    expectEngineError(() => applyCommand(ramped, { type: 'splitClip', clipId: 'c1', at: 1000 }), 'BAD_RAMP');
  });

  it('램프가 걸린 클립은 trimClip을 거부한다 (BAD_RAMP)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    const ramped = applyCommands(d1, [{ type: 'setSpeedRamp', clipId: 'c1', points: flat2(2) }]);
    expectEngineError(() => applyCommand(ramped, { type: 'trimClip', clipId: 'c1', edge: 'end', to: 1500 }), 'BAD_RAMP');
    expectEngineError(() => applyCommand(ramped, { type: 'trimClip', clipId: 'c1', edge: 'start', to: 500 }), 'BAD_RAMP');
  });

  it('램프가 걸린 클립은 setClipSpeed를 거부한다 (BAD_RAMP)', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    // ① 비등속 램프: 막지 않으면 duration이 rampDurationMs와 어긋나 INVALID_DOC이 났다
    const curved = applyCommands(d1, [
      { type: 'setSpeedRamp', clipId: 'c1', points: [{ u: 0, speed: 1 }, { u: 0.5, speed: 4 }, { u: 1, speed: 1 }] },
    ]);
    expectEngineError(() => applyCommand(curved, { type: 'setClipSpeed', clipId: 'c1', speed: 2 }), 'BAD_RAMP');
    // ② 등속 램프: 막지 않으면 speed와 speedRamp가 동시에 남아 화면(램프)과 UI 배속 표시가 어긋났다
    const flat = applyCommands(d1, [{ type: 'setSpeedRamp', clipId: 'c1', points: flat2(2) }]);
    expect((findClip(flat, 'c1')!.clip as VideoClip).duration).toBe(2000);
    expectEngineError(() => applyCommand(flat, { type: 'setClipSpeed', clipId: 'c1', speed: 2 }), 'BAD_RAMP');
    expect((findClip(flat, 'c1')!.clip as VideoClip).speed).toBe(1);   // 원본은 그대로
  });

  it('램프를 해제하면 setClipSpeed가 다시 된다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    const ramped = applyCommands(d1, [{ type: 'setSpeedRamp', clipId: 'c1', points: flat2(2) }]);
    const cleared = applyCommands(ramped, [{ type: 'setSpeedRamp', clipId: 'c1', points: null }]);
    const next = applyCommand(cleared, { type: 'setClipSpeed', clipId: 'c1', speed: 4 });
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.speedRamp).toBeUndefined();
    expect([clip.speed, clip.duration]).toEqual([4, 1000]);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('램프를 해제하면 splitClip·trimClip이 다시 된다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 4000, { out: 4000 }) });
    const ramped = applyCommands(d1, [{ type: 'setSpeedRamp', clipId: 'c1', points: flat2(2) }]);
    const cleared = applyCommands(ramped, [{ type: 'setSpeedRamp', clipId: 'c1', points: null }]);
    const split = applyCommands(cleared, [{ type: 'splitClip', clipId: 'c1', at: 1000, newClipId: 'rt' }]);
    const [left, right] = split.tracks[0]!.clips as [VideoClip, VideoClip];
    expect([left.duration, left.in, left.out]).toEqual([1000, 0, 1000]);
    expect([right.duration, right.in, right.out]).toEqual([3000, 1000, 4000]);
    const trimmed = applyCommands(cleared, [{ type: 'trimClip', clipId: 'c1', edge: 'end', to: 1500 }]);
    const clip = findClip(trimmed, 'c1')!.clip as VideoClip;
    expect([clip.duration, clip.out]).toEqual([1500, 1500]);
    expect(checkInvariants(split)).toEqual([]);
    expect(checkInvariants(trimmed)).toEqual([]);
  });

  it('길어져서 이웃과 겹치면 OVERLAP, video가 아니면 BAD_COMMAND', () => {
    const { doc, vt, tt } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 2000, { out: 2000 }) },
      { type: 'addClip', trackId: vt, clip: vclip('c2', 2000, 1000) },
      { type: 'addClip', trackId: tt, clip: tclip('t1', 0, 1000) },
    ]);
    expectEngineError(() => applyCommand(d1, { type: 'setSpeedRamp', clipId: 'c1', points: flat2(0.5) }), 'OVERLAP');
    expectEngineError(() => applyCommand(d1, { type: 'setSpeedRamp', clipId: 't1', points: flat2(2) }), 'BAD_COMMAND');
  });
});

// ── duckTrack ─────────────────────────────────────────────────────────────

/** 음악 트랙(기본 오디오 트랙) + 목소리 트랙 'vo' 가 있는 문서 */
function duckSetup(): { doc: ProjectDoc; music: string; voice: string } {
  const { doc, at } = setup();
  const d1 = applyCommands(doc, [
    { type: 'addTrack', track: { id: 'vo', kind: 'audio', name: '목소리' } },
    { type: 'addClip', trackId: at, clip: aclip('m1', 0, 10000, { out: 10000 }) },
  ]);
  return { doc: d1, music: at, voice: 'vo' };
}

describe('duckTrack', () => {
  it('voice 구간에서 볼륨을 낮추는 키프레임을 만든다 (attack 전 · 구간 · release 후)', () => {
    const { doc, music, voice } = duckSetup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: voice, clip: aclip('v1', 3000, 2000) });
    const next = applyCommands(d1, [
      { type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.2, attackMs: 500, releaseMs: 800 },
    ]);
    const kfs = findClip(next, 'm1')!.clip.keyframes!;
    expect(kfs.map((k) => [k.time, k.value, k.prop])).toEqual([
      [2500, 1, 'volume'],
      [3000, 0.2, 'volume'],
      [5000, 0.2, 'volume'],
      [5800, 1, 'volume'],
    ]);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('목소리 클립들의 구간을 합집합으로 묶는다 (맞닿은 두 클립 사이에서 볼륨이 올라오지 않는다)', () => {
    const { doc, music, voice } = duckSetup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: voice, clip: aclip('v1', 3000, 2000) },
      { type: 'addClip', trackId: voice, clip: aclip('v2', 5000, 2000) },
    ]);
    const next = applyCommands(d1, [
      { type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.3, attackMs: 500, releaseMs: 800 },
    ]);
    expect(findClip(next, 'm1')!.clip.keyframes!.map((k) => k.time)).toEqual([2500, 3000, 7000, 7800]);
  });

  it('volume이 아닌 키프레임은 보존하고 volume 키프레임만 갈아 끼운다', () => {
    const { doc, vt } = setup();
    // 음악이 깔린 영상 클립을 music 트랙으로 쓰는 경우 — opacity 키프레임은 살아남아야 한다
    const d1 = applyCommands(doc, [
      { type: 'addTrack', track: { id: 'vo2', kind: 'audio', name: '목소리' } },
      {
        type: 'addClip', trackId: vt,
        clip: vclip('m1', 0, 10000, {
          out: 10000,
          keyframes: [
            { time: 0, prop: 'opacity', value: 0, easing: 'linear' },
            { time: 200, prop: 'volume', value: 0.4, easing: 'linear' },
          ],
        }),
      },
      { type: 'addClip', trackId: 'vo2', clip: aclip('v1', 4000, 1000) },
    ]);
    const next = applyCommands(d1, [
      { type: 'duckTrack', musicTrackId: vt, voiceTrackId: 'vo2', amount: 0.5, attackMs: 200, releaseMs: 200 },
    ]);
    const kfs = findClip(next, 'm1')!.clip.keyframes!;
    expect(kfs.filter((k) => k.prop === 'opacity')).toEqual([{ time: 0, prop: 'opacity', value: 0, easing: 'linear' }]);
    expect(kfs.filter((k) => k.prop === 'volume').map((k) => [k.time, k.value])).toEqual([
      [3800, 1], [4000, 0.5], [5000, 0.5], [5200, 1],
    ]);
    expect(kfs.map((k) => k.time)).toEqual([...kfs].sort((a, b) => a.time - b.time).map((k) => k.time));
  });

  it('겹치는 구간이 없는 클립은 volume 키프레임을 지운다', () => {
    const { doc, music, voice } = duckSetup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: voice, clip: aclip('v1', 30000, 1000) },
      {
        type: 'setKeyframes', clipId: 'm1',
        keyframes: [{ time: 0, prop: 'volume', value: 0.1, easing: 'linear' }],
      },
    ]);
    expect(findClip(d1, 'm1')!.clip.keyframes).toHaveLength(1);
    const next = applyCommands(d1, [
      { type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.2, attackMs: 300, releaseMs: 300 },
    ]);
    expect(findClip(next, 'm1')!.clip.keyframes).toBeUndefined();
  });

  it('amount·attackMs·releaseMs 범위 밖·같은 트랙은 BAD_DUCK, 없는 트랙은 TRACK_NOT_FOUND', () => {
    const { doc, music, voice } = duckSetup();
    const duck = (patch: Partial<{ amount: number; attackMs: number; releaseMs: number; musicTrackId: string; voiceTrackId: string }>): Command => ({
      type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.2, attackMs: 300, releaseMs: 300, ...patch,
    });
    expectEngineError(() => applyCommand(doc, duck({ amount: 1.5 })), 'BAD_DUCK');
    expectEngineError(() => applyCommand(doc, duck({ amount: -0.1 })), 'BAD_DUCK');
    expectEngineError(() => applyCommand(doc, duck({ attackMs: 6000 })), 'BAD_DUCK');
    expectEngineError(() => applyCommand(doc, duck({ releaseMs: -1 })), 'BAD_DUCK');
    expectEngineError(() => applyCommand(doc, duck({ voiceTrackId: music })), 'BAD_DUCK');
    expectEngineError(() => applyCommand(doc, duck({ musicTrackId: 'nope' })), 'TRACK_NOT_FOUND');
  });

  // ── W8 F12 — 포락선 구간 · 사이드체인 설정 (전부 optional, 위 테스트가 하위호환 증거다) ──

  it('intervals 를 주면 «클립 존재» 대신 그 구간을 쓴다 (말 사이 공백에서 음악이 올라온다)', () => {
    const { doc, music, voice } = duckSetup();
    // 목소리 클립은 3~7초 통짜지만, 실제로 말하는 것은 3~4.5 와 5.5~7 이다.
    const d1 = applyCommand(doc, { type: 'addClip', trackId: voice, clip: aclip('v1', 3000, 4000) });

    const old = applyCommand(d1, {
      type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.2, attackMs: 200, releaseMs: 200,
    });
    // 옛 방식: 3~7초 통째로 눌린다 → 딥 하나
    expect(old.tracks.find((t) => t.id === music)!.clips[0]!.keyframes!.map((k) => k.time))
      .toEqual([2800, 3000, 7000, 7200]);

    const next = applyCommand(d1, {
      type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.2, attackMs: 200, releaseMs: 200,
      intervals: [{ start: 3000, end: 4500 }, { start: 5500, end: 7000 }],
    });
    const kfs = next.tracks.find((t) => t.id === music)!.clips[0]!.keyframes!;
    // 공백(4.5~5.5초)에서 볼륨이 1 로 돌아온다
    expect(kfs.map((k) => [k.time, k.value])).toEqual([
      [2800, 1], [3000, 0.2], [4500, 0.2], [4700, 1],
      [5300, 1], [5500, 0.2], [7000, 0.2], [7200, 1],
    ]);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('망가진 intervals 는 BAD_DUCK', () => {
    const { doc, music, voice } = duckSetup();
    expectEngineError(
      () => applyCommand(doc, {
        type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.2, attackMs: 200, releaseMs: 200,
        intervals: [{ start: 5000, end: 1000 }],
      }),
      'BAD_DUCK',
    );
  });

  it('sidechain:true 는 Track.duckedBy·duck 을 설정하고 false 는 지운다', () => {
    const { doc, music, voice } = duckSetup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: voice, clip: aclip('v1', 3000, 2000) });
    const on = applyCommand(d1, {
      type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.25, attackMs: 400, releaseMs: 400,
      sidechain: true,
    });
    const track = on.tracks.find((t) => t.id === music)!;
    expect(track.duckedBy).toBe(voice);
    expect(track.duck).toEqual({ amount: 0.25, attackMs: 400, releaseMs: 400 });
    expect(validateDoc(on)).toBeTruthy();   // v1 스키마로도 유효하다

    const off = applyCommand(on, {
      type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.25, attackMs: 400, releaseMs: 400,
      sidechain: false,
    });
    expect(off.tracks.find((t) => t.id === music)!.duckedBy).toBeUndefined();
    expect(off.tracks.find((t) => t.id === music)!.duck).toBeUndefined();
  });

  it('sidechain 을 안 주면 duckedBy·duck 을 건드리지 않는다 (기존 명령 그대로)', () => {
    const { doc, music, voice } = duckSetup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: voice, clip: aclip('v1', 3000, 2000) },
      { type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.25, attackMs: 400, releaseMs: 400, sidechain: true },
    ]);
    const next = applyCommand(d1, {
      type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.5, attackMs: 200, releaseMs: 200,
    });
    expect(next.tracks.find((t) => t.id === music)!.duckedBy).toBe(voice);
  });

  it('트리거 트랙이 음소거면 BAD_DUCK — 켰는데 아무 일도 안 일어나는 것을 막는다', () => {
    const { doc, music, voice } = duckSetup();
    const d1 = applyCommand(doc, { type: 'setTrackProps', trackId: voice, patch: { muted: true } });
    expectEngineError(
      () => applyCommand(d1, {
        type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.25, attackMs: 400, releaseMs: 400,
        sidechain: true,
      }),
      'BAD_DUCK',
    );
  });

  it('더킹 관계가 순환하면 BAD_DUCK (A→B→A)', () => {
    const { doc, music, voice } = duckSetup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: voice, clip: aclip('v1', 3000, 2000) },
      // 목소리 트랙이 음악 트랙에 눌리도록 먼저 걸어 둔다
      { type: 'duckTrack', musicTrackId: voice, voiceTrackId: music, amount: 0.5, attackMs: 200, releaseMs: 200, sidechain: true },
    ]);
    expectEngineError(
      () => applyCommand(d1, {
        type: 'duckTrack', musicTrackId: music, voiceTrackId: voice, amount: 0.25, attackMs: 400, releaseMs: 400,
        sidechain: true,
      }),
      'BAD_DUCK',
    );
  });
});

// ── applyTextTemplate ─────────────────────────────────────────────────────

describe('applyTextTemplate', () => {
  it('style·animationIn/Out·transform·highlightColor를 템플릿으로 덮어쓴다', () => {
    const { doc, tt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: tt, clip: tclip('t1', 0, 3000) });
    const next = applyCommands(d1, [{ type: 'applyTextTemplate', clipId: 't1', templateId: 'variety' }]);
    const tpl = TEXT_TEMPLATES.find((t) => t.id === 'variety')!;
    const clip = findClip(next, 't1')!.clip as TextClip;
    expect(clip.style).toEqual(tpl.style);
    expect(clip.animationIn).toEqual(tpl.animationIn);
    expect(clip.transform).toEqual(tpl.transform);
    expect(clip.highlightColor).toBe(tpl.highlightColor);
  });

  it('템플릿에 없는 필드는 삭제한다', () => {
    const { doc, tt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: tt,
      clip: tclip('t1', 0, 3000, {
        animationIn: { type: 'popIn', duration: 400 },
        animationOut: { type: 'fade', duration: 300 },
        transform: { x: 0.5, y: 0.5, scale: 2, rotation: 45 },
        highlightColor: '#123456',
      }),
    });
    // 'minimal'은 style + animationIn 만 갖는다
    const next = applyCommands(d1, [{ type: 'applyTextTemplate', clipId: 't1', templateId: 'minimal' }]);
    const clip = findClip(next, 't1')!.clip as TextClip;
    expect(clip.animationIn).toEqual({ type: 'fade', duration: 250 });
    expect(clip.animationOut).toBeUndefined();
    expect(clip.transform).toBeUndefined();
    expect(clip.highlightColor).toBeUndefined();
  });

  it('text·words·start·duration은 건드리지 않는다', () => {
    const { doc, tt } = setup();
    const words = [{ text: '가', start: 0, duration: 400 }, { text: '나', start: 500, duration: 400 }];
    const d1 = applyCommand(doc, { type: 'addClip', trackId: tt, clip: tclip('t1', 1000, 3000, { text: '원문', words }) });
    const next = applyCommands(d1, [{ type: 'applyTextTemplate', clipId: 't1', templateId: 'news' }]);
    const clip = findClip(next, 't1')!.clip as TextClip;
    expect(clip.text).toBe('원문');
    expect(clip.words).toEqual(words);
    expect([clip.start, clip.duration]).toEqual([1000, 3000]);
  });

  it('없는 templateId는 TEMPLATE_NOT_FOUND, text가 아닌 클립은 BAD_COMMAND', () => {
    const { doc, vt, tt } = setup();
    const d1 = applyCommands(doc, [
      { type: 'addClip', trackId: tt, clip: tclip('t1', 0, 1000) },
      { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) },
    ]);
    expectEngineError(() => applyCommand(d1, { type: 'applyTextTemplate', clipId: 't1', templateId: 'ghost' }), 'TEMPLATE_NOT_FOUND');
    expectEngineError(() => applyCommand(d1, { type: 'applyTextTemplate', clipId: 'c1', templateId: 'basic' }), 'BAD_COMMAND');
  });
});

// ── freeze / loop / speedRamp 클립의 duration 규칙 ────────────────────────

describe('freeze·loop·speedRamp 클립의 duration 규칙', () => {
  it('addClip: freeze/loop는 duration 검사를 건너뛰고, speedRamp는 ±2ms로 검사한다', () => {
    const { doc, vt } = setup();
    const ok = applyCommands(doc, [
      { type: 'addClip', trackId: vt, clip: vclip('f1', 0, 2000, { in: 500, out: 501, speed: 1, freeze: true }) },
      { type: 'addClip', trackId: vt, clip: vclip('l1', 2000, 5000, { in: 0, out: 1000, speed: 1, loop: true }) },
      { type: 'addClip', trackId: vt, clip: vclip('r1', 7000, 2002, { in: 0, out: 4000, speed: 1, speedRamp: { points: flat2(2) } }) },
    ]);
    expect(ok.tracks[0]!.clips).toHaveLength(3);
    expect(checkInvariants(ok)).toEqual([]);
    // 램프 duration이 2ms 넘게 어긋나면 BAD_CLIP
    expectEngineError(
      () => applyCommand(doc, {
        type: 'addClip', trackId: vt,
        clip: vclip('r2', 0, 2010, { in: 0, out: 4000, speed: 1, speedRamp: { points: flat2(2) } }),
      }),
      'BAD_CLIP',
    );
  });

  it('trimClip: freeze 클립은 소스 구간을 건드리지 않고 start/duration만 바꾼다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt, clip: vclip('f1', 0, 2000, { in: 500, out: 501, speed: 1, freeze: true }),
    });
    const longer = applyCommands(d1, [{ type: 'trimClip', clipId: 'f1', edge: 'end', to: 3000 }]);
    const a = findClip(longer, 'f1')!.clip as VideoClip;
    expect([a.duration, a.in, a.out]).toEqual([3000, 500, 501]);
    const shifted = applyCommands(d1, [{ type: 'trimClip', clipId: 'f1', edge: 'start', to: 500 }]);
    const b = findClip(shifted, 'f1')!.clip as VideoClip;
    expect([b.start, b.duration, b.in, b.out]).toEqual([500, 1500, 500, 501]);
    expect(checkInvariants(shifted)).toEqual([]);
  });

  it('trimClip: loop 클립(스티커)은 소스 반복이므로 out이 늘어나지 않는다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, {
      type: 'addClip', trackId: vt, clip: vclip('l1', 0, 5000, { in: 0, out: 1000, speed: 1, loop: true }),
    });
    const next = applyCommands(d1, [{ type: 'trimClip', clipId: 'l1', edge: 'end', to: 8000 }]);
    const clip = findClip(next, 'l1')!.clip as VideoClip;
    expect([clip.duration, clip.in, clip.out]).toEqual([8000, 0, 1000]);
    expect(checkInvariants(next)).toEqual([]);
  });

  it('checkInvariants: freeze 규약 위반·램프 duration 불일치·derived 백슬래시·beats 역순을 잡아낸다', () => {
    const { doc } = setup();
    const broken = structuredClone(doc);
    broken.assets['av']!.derived = { s1234abcd: { src: 'derived\\av.s1.mp4', proxySrc: 'derived/av.s1.p.mp4' } };
    broken.assets['aa']!.beats = [100, 50, 900];
    broken.tracks[0]!.clips = [
      vclip('f1', 0, 1000, { in: 0, out: 5, speed: 1, freeze: true }),                                  // out !== in+1
      vclip('r1', 2000, 1000, { in: 0, out: 4000, speed: 1, speedRamp: { points: flat2(1) } }),         // 램프 길이 4000
    ];
    const problems = checkInvariants(broken);
    expect(problems.some((p) => p.includes('백슬래시'))).toBe(true);
    expect(problems.some((p) => p.includes('beats'))).toBe(true);
    expect(problems.some((p) => p.includes('freeze 클립'))).toBe(true);
    expect(problems.some((p) => p.includes('rampDurationMs'))).toBe(true);
  });
});

// ── FORBIDDEN_PATCH_KEYS 확장 ─────────────────────────────────────────────

describe('updateClip 금지 키 확장 (W5)', () => {
  it('freeze·loop·speedRamp patch는 BAD_PATCH — 전용 명령으로만 설정한다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) });
    for (const patch of [{ freeze: true }, { loop: true }, { speedRamp: { points: flat2(2) } }]) {
      expectEngineError(() => applyCommand(d1, { type: 'updateClip', clipId: 'c1', patch }), 'BAD_PATCH');
    }
  });

  it('source·curves는 updateClip으로 자유롭게 patch 한다', () => {
    const { doc, vt } = setup();
    const d1 = applyCommand(doc, { type: 'addClip', trackId: vt, clip: vclip('c1', 0, 1000) });
    const next = applyCommands(d1, [{
      type: 'updateClip', clipId: 'c1',
      patch: {
        source: { denoise: { amount: 0.5 }, stabilize: { smoothing: 12 } },
        curves: { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] },
      },
    }]);
    const clip = findClip(next, 'c1')!.clip as VideoClip;
    expect(clip.source).toEqual({ denoise: { amount: 0.5 }, stabilize: { smoothing: 12 } });
    expect(clip.curves!.rgb).toHaveLength(3);
    const cleared = applyCommands(next, [{ type: 'updateClip', clipId: 'c1', patch: { source: null } }]);
    expect((findClip(cleared, 'c1')!.clip as VideoClip).source).toBeUndefined();
  });
});
