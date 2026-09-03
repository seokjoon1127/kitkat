// W8 S5 — chromiumOptions(gl) 전달과 renderAudioStem 의 트랙 솔로 처리.
// Chrome 을 띄우지 않고 @remotion/* 호출 인자만 본다 (실렌더 검증은 별도 실측).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDoc } from '@kitkat/schema';

const mocks = vi.hoisted(() => ({
  renderMedia: vi.fn(),
  renderStill: vi.fn(),
  selectComposition: vi.fn(),
  bundle: vi.fn(),
  startStaticServer: vi.fn(),
}));

vi.mock('@remotion/renderer', () => ({
  // 리뷰 #12 — render.ts 가 잡 취소 신호를 Remotion 취소 신호로 잇는다. 모의에도 있어야 한다.
  makeCancelSignal: () => ({ cancelSignal: undefined, cancel: () => {} }),
  renderMedia: mocks.renderMedia,
  renderStill: mocks.renderStill,
  selectComposition: mocks.selectComposition,
}));
vi.mock('@remotion/bundler', () => ({ bundle: mocks.bundle }));
vi.mock('../src/static-server.js', () => ({ startStaticServer: mocks.startStaticServer }));

const { renderAudioStem, renderCover, renderProject } = await import('../src/render.js');

const close = vi.fn();

function doc(): ProjectDoc {
  return {
    schemaVersion: 1,
    id: 'p1',
    name: 't',
    revision: 0,
    settings: { width: 1080, height: 1920, fps: 30, background: { kind: 'color', color: '#000000' } },
    assets: {
      a1: { id: 'a1', kind: 'audio', src: 'samples/bgm.wav', name: 'bgm', duration: 12_000 },
    },
    tracks: [
      { id: 'tv', kind: 'video', name: '비디오', clips: [] },
      {
        id: 'tm',
        kind: 'audio',
        name: '음악',
        clips: [
          { id: 'm1', kind: 'audio', assetId: 'a1', start: 0, duration: 5000, in: 0, out: 5000, speed: 1, volume: 1 },
        ],
      },
      { id: 'tn', kind: 'audio', name: '나레이션', muted: true, clips: [] },
    ],
  };
}

const lastMedia = () => mocks.renderMedia.mock.calls.at(-1)![0] as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  close.mockResolvedValue(undefined);
  mocks.bundle.mockResolvedValue('serve-url');
  mocks.startStaticServer.mockResolvedValue({ url: 'http://127.0.0.1:1/', close });
  mocks.selectComposition.mockResolvedValue({ id: 'timeline', durationInFrames: 150, fps: 30 });
  mocks.renderMedia.mockResolvedValue(undefined);
  mocks.renderStill.mockResolvedValue(undefined);
});

describe('chromiumOptions (S5-a)', () => {
  it('renderProject 기본값은 null (Chrome 자율 — 실측상 이미 SwiftShader, swangle 은 6.57배 느림)', async () => {
    await renderProject(doc(), { mediaDir: 'm', outPath: 'o.mp4' });
    expect(lastMedia().chromiumOptions).toEqual({ gl: null });
    expect(lastMedia().codec).toBe('h264');
  });

  it('transparent 경로에도 붙는다', async () => {
    await renderProject(doc(), { mediaDir: 'm', outPath: 'o.mov', transparent: true });
    expect(lastMedia().codec).toBe('prores');
    expect(lastMedia().chromiumOptions).toEqual({ gl: null });
  });

  it('명시한 백엔드를 그대로 넘긴다 (null 포함)', async () => {
    await renderProject(doc(), { mediaDir: 'm', outPath: 'o.mp4', gl: 'angle' });
    expect(lastMedia().chromiumOptions).toEqual({ gl: 'angle' });
    await renderProject(doc(), { mediaDir: 'm', outPath: 'o.mp4', gl: null });
    expect(lastMedia().chromiumOptions).toEqual({ gl: null });
  });

  it('renderCover 에도 붙는다', async () => {
    await renderCover(doc(), { mediaDir: 'm', outPath: 'o.jpg', timeMs: 0 });
    expect((mocks.renderStill.mock.calls.at(-1)![0] as any).chromiumOptions).toEqual({ gl: null });
    await renderCover(doc(), { mediaDir: 'm', outPath: 'o.jpg', timeMs: 0, gl: 'swiftshader' });
    expect((mocks.renderStill.mock.calls.at(-1)![0] as any).chromiumOptions).toEqual({ gl: 'swiftshader' });
  });
});

describe('audioCodec (F17 V5-6 — 스템 뺄셈용 무손실 전체 믹스)', () => {
  it('미지정이면 아예 안 넘긴다 — Remotion 기본값(h264 → aac)이 그대로 간다', async () => {
    await renderProject(doc(), { mediaDir: 'm', outPath: 'o.mp4' });
    expect('audioCodec' in lastMedia()).toBe(false);
  });

  it("'pcm-16' 을 그대로 넘긴다 (h264 는 aac·pcm-16·mp3 를 받는다)", async () => {
    await renderProject(doc(), { mediaDir: 'm', outPath: 'o.mp4', audioCodec: 'pcm-16' });
    expect(lastMedia().codec).toBe('h264');
    expect(lastMedia().audioCodec).toBe('pcm-16');
  });

  it('transparent(prores) 경로에도 붙는다', async () => {
    await renderProject(doc(), {
      mediaDir: 'm', outPath: 'o.mov', transparent: true, audioCodec: 'pcm-16',
    });
    expect(lastMedia().codec).toBe('prores');
    expect(lastMedia().audioCodec).toBe('pcm-16');
  });

  it('취소 신호 배선을 깨지 않는다 — cancelSignal 은 계속 넘어간다', async () => {
    await renderProject(doc(), { mediaDir: 'm', outPath: 'o.mp4', audioCodec: 'pcm-16' });
    expect('cancelSignal' in lastMedia()).toBe(true);
  });

  it('renderAudioStem 은 audioCodec 을 안 받는다 — wav 는 이미 무손실이다', async () => {
    await renderAudioStem(doc(), { mediaDir: 'm', outPath: 'stem.wav', soloTrackIds: ['tm'] });
    expect(lastMedia().codec).toBe('wav');
    expect('audioCodec' in lastMedia()).toBe(false);
  });
});

describe('renderAudioStem (S5-b)', () => {
  it('wav 코덱으로 렌더하고 지정 트랙만 살린다', async () => {
    const d = doc();
    const before = JSON.stringify(d);
    const res = await renderAudioStem(d, { mediaDir: 'm', outPath: 'stem.wav', soloTrackIds: ['tm'] });

    const call = lastMedia();
    expect(call.codec).toBe('wav');
    expect(call.outputLocation).toBe('stem.wav');
    expect(call.inputProps.doc.tracks.map((t: any) => [t.id, t.muted])).toEqual([
      ['tv', true],
      ['tm', false],
      ['tn', true],
    ]);
    // 스템은 프록시(96k aac) 음원을 쓰지 않는다
    expect(call.inputProps.proxy).toBe(false);
    expect(res).toEqual({ outPath: 'stem.wav', durationMs: 5000 });
    // 원본 doc 은 변형되지 않는다
    expect(JSON.stringify(d)).toBe(before);
  });

  it('빈 배열이면 전부 muted — 오류가 아니라 무음 스템', async () => {
    await renderAudioStem(doc(), { mediaDir: 'm', outPath: 'silent.wav', soloTrackIds: [] });
    expect(lastMedia().inputProps.doc.tracks.every((t: any) => t.muted === true)).toBe(true);
  });

  it('원래 muted 였어도 솔로로 지정하면 살아난다', async () => {
    await renderAudioStem(doc(), { mediaDir: 'm', outPath: 'stem.wav', soloTrackIds: ['tn'] });
    const tracks = lastMedia().inputProps.doc.tracks;
    expect(tracks.find((t: any) => t.id === 'tn').muted).toBe(false);
  });

  it('문서에 없는 트랙 id 는 한국어로 거부한다', async () => {
    await expect(
      renderAudioStem(doc(), { mediaDir: 'm', outPath: 'x.wav', soloTrackIds: ['tm', 'nope'] }),
    ).rejects.toThrow(/스템 렌더: 문서에 없는 트랙 id 입니다 — nope/);
    expect(mocks.renderMedia).not.toHaveBeenCalled();
  });

  it('range 를 프레임 구간으로 바꾼다', async () => {
    const res = await renderAudioStem(doc(), {
      mediaDir: 'm',
      outPath: 'stem.wav',
      soloTrackIds: ['tm'],
      range: { start: 1000, end: 3000 },
    });
    expect(lastMedia().frameRange).toEqual([30, 89]);
    expect(res.durationMs).toBe(2000);
  });

  it('정적 서버를 반드시 닫는다 (렌더가 실패해도)', async () => {
    mocks.renderMedia.mockRejectedValueOnce(new Error('boom'));
    await expect(
      renderAudioStem(doc(), { mediaDir: 'm', outPath: 'x.wav', soloTrackIds: [] }),
    ).rejects.toThrow('boom');
    expect(close).toHaveBeenCalled();
  });
});
