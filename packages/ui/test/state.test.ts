// C7 상태 스토어 단위 테스트 — fetch는 mock, WS는 handleWsMessage를 직접 호출
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, type ProjectDoc } from '@kitkat/schema';
import { handleWsMessage, useEditor } from '../src/state.js';
import * as api from '../src/api.js';
import type { JobInfo } from '../src/api.js';

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetchOnce(status: number, body: unknown): FetchMock {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function seedDoc(name = '테스트'): ProjectDoc {
  const doc = createEmptyProject({ name });
  useEditor.setState({ doc, revision: doc.revision, projectId: doc.id });
  return doc;
}

beforeEach(() => {
  useEditor.setState(useEditor.getInitialState(), true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('초기 상태 (C7 기본값)', () => {
  it('zoom 60 · playing false · 선택 없음 · clientId 생성됨', () => {
    const s = useEditor.getState();
    expect(s.doc).toBeNull();
    expect(s.zoom).toBe(60);
    expect(s.playing).toBe(false);
    expect(s.playheadMs).toBe(0);
    expect(s.selection.clipId).toBeNull();
    expect(s.clientId.length).toBeGreaterThan(0);
    expect(s.undoStack).toHaveLength(0);
    expect(s.redoStack).toHaveLength(0);
  });
});

describe('dispatch', () => {
  it('낙관 적용 + undoStack 푸시 + clientId/baseRevision 포함 POST', async () => {
    const doc = seedDoc();
    const fetchMock = mockFetchOnce(200, { revision: doc.revision + 1 });

    await useEditor.getState().dispatch([{ type: 'renameProject', name: '바뀐 이름' }]);

    const s = useEditor.getState();
    expect(s.doc?.name).toBe('바뀐 이름');
    expect(s.revision).toBe(doc.revision + 1);
    expect(s.undoStack).toHaveLength(1);
    expect(s.undoStack[0]?.name).toBe('테스트');
    expect(s.redoStack).toHaveLength(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${doc.id}/commands`);
    const body = JSON.parse(String(init.body)) as {
      commands: unknown[];
      baseRevision: number;
      clientId: string;
    };
    expect(body.baseRevision).toBe(doc.revision);
    expect(body.clientId).toBe(s.clientId);
    expect(body.commands).toHaveLength(1);
  });

  it('로컬 EngineError면 서버에 보내지 않고 notice만 남긴다', async () => {
    const doc = seedDoc();
    const fetchMock = mockFetchOnce(200, { revision: 999 });

    await useEditor.getState().dispatch([{ type: 'removeClip', clipId: '없는클립' }]);

    const s = useEditor.getState();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.doc).toEqual(doc); // 문서 불변
    expect(s.undoStack).toHaveLength(0);
    expect(s.notice).toContain('적용할 수 없는');
  });

  it('409면 서버 문서를 채택하고 알림을 남긴다', async () => {
    seedDoc();
    const serverDoc = createEmptyProject({ name: '서버쪽 문서' });
    serverDoc.revision = 7;
    mockFetchOnce(409, { error: 'revision conflict', doc: serverDoc });

    await useEditor.getState().dispatch([{ type: 'renameProject', name: '충돌 이름' }]);

    const s = useEditor.getState();
    expect(s.doc?.name).toBe('서버쪽 문서');
    expect(s.revision).toBe(7);
    expect(s.notice).toContain('충돌');
  });
});

describe('undo / redo (restoreDoc 명령으로 dispatch)', () => {
  it('undo는 이전 문서 복원 + redoStack 적재, redo는 되돌린다', async () => {
    const doc = seedDoc('처음');
    mockFetchOnce(200, { revision: doc.revision + 1 });
    await useEditor.getState().dispatch([{ type: 'renameProject', name: '수정됨' }]);
    expect(useEditor.getState().doc?.name).toBe('수정됨');

    const fetchUndo = mockFetchOnce(200, { revision: useEditor.getState().revision + 1 });
    useEditor.getState().undo();
    await vi.waitFor(() => expect(fetchUndo).toHaveBeenCalledTimes(1));

    let s = useEditor.getState();
    expect(s.doc?.name).toBe('처음');
    expect(s.undoStack).toHaveLength(0);
    expect(s.redoStack).toHaveLength(1);
    const undoBody = JSON.parse(String((fetchUndo.mock.calls[0] as [string, RequestInit])[1].body)) as {
      commands: { type: string }[];
    };
    expect(undoBody.commands[0]?.type).toBe('restoreDoc');

    const fetchRedo = mockFetchOnce(200, { revision: useEditor.getState().revision + 1 });
    useEditor.getState().redo();
    await vi.waitFor(() => expect(fetchRedo).toHaveBeenCalledTimes(1));

    s = useEditor.getState();
    expect(s.doc?.name).toBe('수정됨');
    expect(s.undoStack).toHaveLength(1);
    expect(s.redoStack).toHaveLength(0);
  });

  it('undoStack이 비어 있으면 undo는 아무것도 하지 않는다', () => {
    seedDoc();
    const fetchMock = mockFetchOnce(200, {});
    useEditor.getState().undo();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('undo가 스냅샷 이후 서버 잡이 써넣은 에셋 파생 필드(proxySrc 등)를 지우지 않는다', async () => {
    const doc = seedDoc('파생보존');
    doc.assets['a1'] = { id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1', duration: 5000 };
    useEditor.setState({ doc: { ...doc } });

    // 편집 1건 → undoStack 스냅샷에는 proxySrc 없음
    mockFetchOnce(200, { revision: doc.revision + 1 });
    await useEditor.getState().dispatch([{ type: 'renameProject', name: '편집됨' }]);

    // 프록시 잡 완료가 브로드캐스트로 반영됨 (다른 주체의 updateAsset)
    handleWsMessage({
      type: 'commands',
      revision: doc.revision + 2,
      commands: [{ type: 'updateAsset', assetId: 'a1', patch: { proxySrc: 'proxies/a1.mp4' } }],
    });
    expect(useEditor.getState().doc?.assets['a1']?.proxySrc).toBe('proxies/a1.mp4');

    const fetchUndo = mockFetchOnce(200, { revision: useEditor.getState().revision + 1 });
    useEditor.getState().undo();
    await vi.waitFor(() => expect(fetchUndo).toHaveBeenCalledTimes(1));

    const s = useEditor.getState();
    expect(s.doc?.name).toBe('파생보존'); // 편집은 되돌리되
    expect(s.doc?.assets['a1']?.proxySrc).toBe('proxies/a1.mp4'); // 파생 필드는 보존
    // 서버로 보낸 restoreDoc 문서에도 proxySrc가 실려 있어야 한다
    const body = JSON.parse(String((fetchUndo.mock.calls[0] as [string, RequestInit])[1].body)) as {
      commands: { type: string; doc?: ProjectDoc }[];
    };
    expect(body.commands[0]?.type).toBe('restoreDoc');
    expect(body.commands[0]?.doc?.assets['a1']?.proxySrc).toBe('proxies/a1.mp4');
  });
});

describe('잠긴 트랙 방어 (dispatch)', () => {
  function seedLockedDoc() {
    const doc = seedDoc('잠금');
    doc.assets['a1'] = { id: 'a1', kind: 'image', src: 'assets/a1.png', name: 'a1' };
    const video = doc.tracks.find((t) => t.kind === 'video')!;
    video.clips.push({ id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 1000 });
    video.locked = true;
    useEditor.setState({ doc: { ...doc } });
    return { doc, video };
  }

  it('잠긴 트랙 클립의 removeClip·updateClip은 서버에 보내지 않고 notice만 남긴다', async () => {
    const { video } = seedLockedDoc();
    const fetchMock = mockFetchOnce(200, { revision: 1 });

    await useEditor.getState().dispatch([{ type: 'removeClip', clipId: 'c1' }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      useEditor.getState().doc?.tracks.find((t) => t.id === video.id)?.clips,
    ).toHaveLength(1);
    expect(useEditor.getState().notice).toContain('잠긴 트랙');

    await useEditor.getState().dispatch([
      { type: 'updateClip', clipId: 'c1', patch: { opacity: 0.5 } },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('잠긴 트랙으로의 addClip(복제 등)도 차단한다', async () => {
    const { video } = seedLockedDoc();
    const fetchMock = mockFetchOnce(200, { revision: 1 });
    await useEditor.getState().dispatch([
      {
        type: 'addClip',
        trackId: video.id,
        clip: { id: 'c2', kind: 'image', assetId: 'a1', start: 2000, duration: 1000 },
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useEditor.getState().notice).toContain('잠긴 트랙');
  });

  it('잠금 해제(setTrackProps)는 잠긴 트랙에도 허용된다', async () => {
    const { video } = seedLockedDoc();
    const fetchMock = mockFetchOnce(200, { revision: 1 });
    await useEditor.getState().dispatch([
      { type: 'setTrackProps', trackId: video.id, patch: { locked: false } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useEditor.getState().doc?.tracks.find((t) => t.id === video.id)?.locked).toBe(false);
  });
});

describe('WS 수신 (C3 프로토콜)', () => {
  it('남의 commands가 revision 연속이면 로컬 적용한다', () => {
    const doc = seedDoc();
    handleWsMessage({
      type: 'commands',
      revision: doc.revision + 1,
      commands: [{ type: 'renameProject', name: '남이 바꾼 이름' }],
      clientId: '다른클라이언트',
    });
    const s = useEditor.getState();
    expect(s.doc?.name).toBe('남이 바꾼 이름');
    expect(s.revision).toBe(doc.revision + 1);
  });

  it('자기 clientId의 브로드캐스트는 재적용하지 않는다 (낙관 적용 후 에코 = 변화 없음)', async () => {
    const doc = seedDoc();
    mockFetchOnce(200, { revision: doc.revision + 1 });
    await useEditor.getState().dispatch([{ type: 'renameProject', name: '낙관 적용됨' }]);
    const { clientId } = useEditor.getState();
    handleWsMessage({
      type: 'commands',
      revision: doc.revision + 1,
      commands: [{ type: 'renameProject', name: '낙관 적용됨' }],
      clientId,
    });
    const s = useEditor.getState();
    expect(s.doc?.name).toBe('낙관 적용됨'); // 재적용 안 함
    expect(s.revision).toBe(doc.revision + 1);
  });

  it('자기 에코가 로컬 revision보다 앞서면(그 사이 롤백) revision을 채택하지 않는다 — 침묵 발산 방지', () => {
    const doc = seedDoc();
    const { clientId } = useEditor.getState();
    // 로컬에는 낙관 적용이 없는데(롤백됨) 에코가 +1 revision을 들고 온 상황
    handleWsMessage({
      type: 'commands',
      revision: doc.revision + 1,
      commands: [{ type: 'renameProject', name: '로컬에 없는 편집' }],
      clientId,
    });
    const s = useEditor.getState();
    expect(s.doc?.name).toBe('테스트');
    // revision만 맞추면 내용이 빠진 채 서버와 일치한 척하게 된다 — 그대로 두고 resync를 요청해야 한다
    expect(s.revision).toBe(doc.revision);
  });

  it('낡은 doc 스냅샷(재접속 등)은 진행 중인 낙관 편집을 지우지 않는다', async () => {
    const doc = seedDoc();
    mockFetchOnce(200, { revision: doc.revision + 1 });
    await useEditor.getState().dispatch([{ type: 'renameProject', name: '드래그 중 편집' }]);
    expect(useEditor.getState().revision).toBe(doc.revision + 1);

    // 재접속 직후 서버가 보낸 옛 스냅샷(rev N)이 늦게 도착
    handleWsMessage({ type: 'doc', doc: structuredClone(doc) });
    const s = useEditor.getState();
    expect(s.doc?.name).toBe('드래그 중 편집'); // 덮어쓰지 않음
    expect(s.revision).toBe(doc.revision + 1);
  });

  it('desynced 상태에서는 낡아 보이는 doc도 채택해 복구하고 desynced를 해제한다', () => {
    const doc = seedDoc();
    useEditor.setState({ revision: doc.revision + 5, desynced: true });
    const serverDoc = createEmptyProject({ name: '서버 진실' });
    serverDoc.revision = doc.revision + 2;
    handleWsMessage({ type: 'doc', doc: serverDoc });
    const s = useEditor.getState();
    expect(s.doc?.name).toBe('서버 진실');
    expect(s.revision).toBe(doc.revision + 2);
    expect(s.desynced).toBe(false);
  });

  it('409 롤백 doc이 로컬 낙관 revision보다 낡으면 desynced로 표시한다', async () => {
    const doc = seedDoc();
    // 다른 명령이 비행 중이라 로컬 revision이 서버 doc보다 앞선 상황을 흉내
    useEditor.setState({ doc: { ...doc, revision: 5 }, revision: 5 });
    const serverDoc = createEmptyProject({ name: '서버쪽 문서' });
    serverDoc.revision = 3;
    mockFetchOnce(409, { error: 'revision conflict', doc: serverDoc });

    await useEditor.getState().dispatch([{ type: 'renameProject', name: '충돌 이름' }]);

    const s = useEditor.getState();
    expect(s.doc?.name).toBe('서버쪽 문서'); // 그 시점의 서버 진실은 채택하되
    expect(s.revision).toBe(3);
    expect(s.desynced).toBe(true); // revision 일치 신뢰를 끊고 재수신을 기다린다
  });

  it('doc 메시지는 문서 전체를 교체한다 / job 메시지는 jobs에 쌓인다', () => {
    const doc = createEmptyProject({ name: '수신 문서' });
    handleWsMessage({ type: 'doc', doc });
    expect(useEditor.getState().doc?.name).toBe('수신 문서');

    const job: JobInfo = { id: 'j1', type: 'render', status: 'running', progress: 0.5 };
    handleWsMessage({ type: 'job', job });
    expect(useEditor.getState().jobs['j1']?.progress).toBe(0.5);
  });
});

describe('seek / select / setZoom', () => {
  it('seek는 음수를 0으로 클램프, setZoom은 범위를 클램프, select는 선택을 바꾼다', () => {
    const s = useEditor.getState();
    s.seek(-100);
    expect(useEditor.getState().playheadMs).toBe(0);
    s.seek(1234.6);
    expect(useEditor.getState().playheadMs).toBe(1235);
    s.setZoom(100000);
    expect(useEditor.getState().zoom).toBe(1000);
    s.setZoom(0.001);
    expect(useEditor.getState().zoom).toBe(5);
    s.select('클립1');
    expect(useEditor.getState().selection.clipId).toBe('클립1');
    s.select(null);
    expect(useEditor.getState().selection.clipId).toBeNull();
  });
});

// ── W5 (X8) ────────────────────────────────────────────────────────────────

describe('previewEngine (X8)', () => {
  it('기본값은 remotion', () => {
    expect(useEditor.getState().previewEngine).toBe('remotion');
  });

  it('setPreviewEngine 으로 fast/remotion 을 오간다', () => {
    useEditor.getState().setPreviewEngine('fast');
    expect(useEditor.getState().previewEngine).toBe('fast');
    useEditor.getState().setPreviewEngine('remotion');
    expect(useEditor.getState().previewEngine).toBe('remotion');
  });

  it('기존 C7 상태는 그대로 남는다 (회귀 방지)', () => {
    const s = useEditor.getState();
    expect(s.zoom).toBe(60);
    expect(s.revision).toBe(0);
    expect(typeof s.connect).toBe('function');
    expect(typeof s.dispatch).toBe('function');
    expect(typeof s.undo).toBe('function');
    expect(typeof s.redo).toBe('function');
  });
});

describe('api — W5 새 엔드포인트 (X6)', () => {
  const call = (fn: FetchMock): [string, RequestInit | undefined] =>
    fn.mock.calls[0] as [string, RequestInit | undefined];
  const bodyOf = (fn: FetchMock): Record<string, unknown> =>
    JSON.parse(String(call(fn)[1]?.body)) as Record<string, unknown>;

  it('detectBeats: POST /assets/:assetId/beats (본문 없음)', async () => {
    const fetchMock = mockFetchOnce(200, { jobId: 'j1' });
    const res = await api.detectBeats('p1', 'a1');
    expect(res.jobId).toBe('j1');
    const [url, init] = call(fetchMock);
    expect(url).toBe('/api/projects/p1/assets/a1/beats');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('separateStems: POST /assets/:assetId/separate', async () => {
    const fetchMock = mockFetchOnce(200, { jobId: 'j2' });
    await api.separateStems('p1', 'a1');
    const [url, init] = call(fetchMock);
    expect(url).toBe('/api/projects/p1/assets/a1/separate');
    expect(init?.method).toBe('POST');
  });

  it('separateStems: Demucs 없으면 501 ApiError 로 올라온다', async () => {
    mockFetchOnce(501, { error: '보컬 분리 엔진이 없습니다' });
    await expect(api.separateStems('p1', 'a1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 501,
    });
  });

  it('upscale: body 에 scale 을 싣는다 (기본 2배)', async () => {
    const fetchMock = mockFetchOnce(200, { jobId: 'j3' });
    await api.upscale('p1', 'a1', 4);
    expect(call(fetchMock)[0]).toBe('/api/projects/p1/assets/a1/upscale');
    expect(bodyOf(fetchMock)).toEqual({ scale: 4 });

    const dflt = mockFetchOnce(200, { jobId: 'j3' });
    await api.upscale('p1', 'a1');
    expect(bodyOf(dflt)).toEqual({ scale: 2 });
  });

  it('interpolateFps: body 에 fps 를 싣는다 (기본 60)', async () => {
    const fetchMock = mockFetchOnce(200, { jobId: 'j4' });
    await api.interpolateFps('p1', 'a1', 120);
    expect(call(fetchMock)[0]).toBe('/api/projects/p1/assets/a1/interpolate');
    expect(bodyOf(fetchMock)).toEqual({ fps: 120 });

    const dflt = mockFetchOnce(200, { jobId: 'j4' });
    await api.interpolateFps('p1', 'a1');
    expect(bodyOf(dflt)).toEqual({ fps: 60 });
  });

  it('renderCover: POST /cover 에 timeMs', async () => {
    const fetchMock = mockFetchOnce(200, { jobId: 'j5' });
    await api.renderCover('p1', 4321);
    expect(call(fetchMock)[0]).toBe('/api/projects/p1/cover');
    expect(bodyOf(fetchMock)).toEqual({ timeMs: 4321 });
  });

  it('getCapabilities: GET /api/capabilities', async () => {
    const fetchMock = mockFetchOnce(200, {
      transitions: ['fade'],
      effects: ['blur'],
      textAnims: ['fade'],
      textTemplates: [{ id: 'basic', name: '기본 자막' }],
      speedRampPresets: [{ id: 'montage', name: '몽타주' }],
      blendModes: ['normal'],
      version: 1,
    });
    const caps = await api.getCapabilities();
    const [url, init] = call(fetchMock);
    expect(url).toBe('/api/capabilities');
    expect(init).toBeUndefined();
    expect(caps.textTemplates[0]?.id).toBe('basic');
  });

  it('startRender: MOV(알파)는 format mov + transparent true 로 나간다', async () => {
    const fetchMock = mockFetchOnce(200, { jobId: 'j6' });
    await api.startRender('p1', { format: 'mov', transparent: true });
    expect(call(fetchMock)[0]).toBe('/api/projects/p1/render');
    expect(bodyOf(fetchMock)).toEqual({ format: 'mov', transparent: true });
  });

  it('startRender: 기존 mp4 경로는 그대로 (회귀 방지)', async () => {
    const fetchMock = mockFetchOnce(200, { jobId: 'j7' });
    await api.startRender('p1', { format: 'mp4', width: 640, height: 360 });
    expect(bodyOf(fetchMock)).toEqual({ format: 'mp4', width: 640, height: 360 });
  });
});

describe('잠긴 트랙 방어 — W5 새 명령', () => {
  it('잠긴 트랙 클립의 freezeFrame 은 서버에 보내지 않는다', async () => {
    const doc = createEmptyProject({ name: '잠금2' });
    doc.assets['a1'] = { id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1', duration: 5000 };
    const video = doc.tracks.find((t) => t.kind === 'video')!;
    video.clips.push({
      id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 2000,
      in: 0, out: 2000, speed: 1, volume: 1,
    });
    video.locked = true;
    useEditor.setState({ doc, revision: doc.revision, projectId: doc.id });

    const fetchMock = mockFetchOnce(200, { revision: 1 });
    await useEditor.getState().dispatch([
      { type: 'freezeFrame', clipId: 'c1', at: 1000, duration: 1000 },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useEditor.getState().notice).toContain('잠긴 트랙');
  });
});
