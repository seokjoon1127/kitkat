// C7 UI 상태 계약 — W3-B/C가 useEditor를 소비한다. 이름·시그니처를 바꾸지 말 것.
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { newId, type Asset, type ProjectDoc } from '@kitkat/schema';
import { applyCommands, findClip, type Command } from '@kitkat/engine';
import { ApiError, getProject, postCommands, type JobInfo } from './api.js';

const MAX_STACK = 50;
const MIN_ZOOM = 5; // px per second
const MAX_ZOOM = 1000;

export type EditorState = {
  doc: ProjectDoc | null;
  revision: number;
  clientId: string; // 접속 시 newId()로 1회 생성
  selection: { clipId: string | null };
  playheadMs: number;
  playing: boolean;
  zoom: number; // px per second, 기본 60
  undoStack: ProjectDoc[];
  redoStack: ProjectDoc[]; // 최대 50개
  previewEngine: PreviewEngine; // X8(W5) — 기본 'remotion'
  connect(projectId: string): void;
  dispatch(cmds: Command[]): Promise<void>;
  undo(): void;
  redo(): void;
  select(clipId: string | null): void;
  seek(ms: number): void;
  setZoom(z: number): void;
  setPreviewEngine(e: PreviewEngine): void;
};

/** 미리보기 합성기 선택 — 'remotion'(WYSIWYG 기준선) / 'fast'(실험용 빠른 미리보기) */
export type PreviewEngine = 'remotion' | 'fast';

/** 계약(C7) 외 추가 상태 — 셸 내부용(잡 진행·알림·접속 프로젝트) */
export type EditorExtras = {
  projectId: string | null;
  notice: string | null;
  jobs: Record<string, JobInfo>;
  /**
   * 로컬 문서가 서버 진실과 어긋났을 수 있음(낡은 롤백 스냅샷 채택·전송 실패 등).
   * true인 동안에는 revision 일치만으로 동기화를 신뢰하지 않고, 서버 doc를 받아야 해제된다.
   */
  desynced: boolean;
};

type EditorStore = EditorState & EditorExtras;

type WsMessage =
  | { type: 'doc'; doc: ProjectDoc }
  | { type: 'commands'; revision: number; commands: Command[]; clientId?: string }
  | { type: 'job'; job: JobInfo }
  | { type: 'resync' };

let ws: WebSocket | null = null;
let wsProjectId: string | null = null;

function openSocket(projectId: string): void {
  if (typeof WebSocket === 'undefined') return; // 테스트(node) 환경
  if (ws && wsProjectId === projectId && ws.readyState <= WebSocket.OPEN) return;
  try {
    ws?.close();
  } catch {
    // 무시
  }
  wsProjectId = projectId;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws/projects/${projectId}`);
  ws = socket;
  socket.onmessage = (ev) => {
    try {
      handleWsMessage(JSON.parse(String(ev.data)) as WsMessage);
    } catch {
      // 형식 오류 메시지는 무시
    }
  };
  socket.onclose = () => {
    if (ws !== socket || wsProjectId !== projectId) return;
    ws = null;
    setTimeout(() => {
      if (wsProjectId === projectId && !ws) openSocket(projectId);
    }, 2000);
  };
}

function requestResync(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resync' }));
  }
}

/** WS 수신 처리 (C3 프로토콜) — 테스트에서 직접 호출할 수 있게 export */
export function handleWsMessage(msg: WsMessage): void {
  const s = useEditor.getState();
  if (msg.type === 'doc') {
    // 진행 중인 낙관 편집(로컬 revision이 더 앞섬)을 지워버리는 낡은 스냅샷은 무시한다.
    // 단, desynced 상태에서는 서버 doc이 진실이므로 revision과 무관하게 채택해 복구한다.
    if (!s.doc || msg.doc.revision >= s.revision || s.desynced) {
      useEditor.setState({ doc: msg.doc, revision: msg.doc.revision, desynced: false });
    }
    return;
  }
  if (msg.type === 'commands') {
    if (s.desynced) {
      requestResync(); // 어긋났을 수 있는 로컬 위에 쌓지 않는다 — 문서 전체 재수신
      return;
    }
    if (msg.clientId && msg.clientId === s.clientId) {
      // 자기 것 — 이미 낙관 적용됨. 정상 파이프라인에서는 항상 s.revision >= msg.revision.
      // 에코가 더 앞선 revision을 들고 왔다면 그 사이 롤백(doc 채택)이 있었다는 뜻이므로,
      // revision만 맞추면 내용이 빠진 채 침묵 발산한다 → 문서 전체 재동기화.
      if (msg.revision > s.revision) requestResync();
      return;
    }
    if (s.doc && msg.revision === s.revision + 1) {
      try {
        const next = applyCommands(s.doc, msg.commands);
        useEditor.setState({ doc: { ...next, revision: msg.revision }, revision: msg.revision });
      } catch {
        requestResync();
      }
    } else {
      requestResync(); // revision 불연속 → 문서 전체 재수신
    }
    return;
  }
  if (msg.type === 'job') {
    useEditor.setState({ jobs: { ...s.jobs, [msg.job.id]: msg.job } });
  }
}

/**
 * 롤백/재동기화용 서버 문서 채택. 서버가 준 문서는 그 시점의 서버 진실이므로 그대로 채택하되,
 * 로컬 낙관 revision보다 낡았다면(다른 명령이 아직 비행 중) desynced로 표시하고 재수신을 요청한다.
 */
function adoptServerDoc(doc: ProjectDoc, extra?: Partial<EditorStore>): void {
  const stale = doc.revision < useEditor.getState().revision;
  useEditor.setState({ doc, revision: doc.revision, desynced: stale, ...(extra ?? {}) });
  if (stale) requestResync();
}

/**
 * 낙관 적용 + POST. stackPatch로 undo/redo 스택을 함께 갱신한다(스택 관리는 호출자 책임).
 * 409/400 이면 서버 문서로 재동기화하고 notice 를 남긴다.
 */
async function sendCommands(cmds: Command[], stackPatch?: Partial<EditorStore>): Promise<void> {
  const s = useEditor.getState();
  const { doc, projectId } = s;
  if (!doc || !projectId) return;

  let next: ProjectDoc;
  try {
    next = applyCommands(doc, cmds); // 낙관 적용 (실패 시 서버에 보내지 않음)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useEditor.setState({ notice: `적용할 수 없는 편집입니다: ${message}` });
    return;
  }
  useEditor.setState({ doc: next, revision: next.revision, ...(stackPatch ?? {}) });

  try {
    const res = await postCommands(projectId, {
      commands: cmds,
      baseRevision: doc.revision,
      clientId: s.clientId,
    });
    const cur = useEditor.getState();
    if (cur.doc && cur.revision < res.revision && cur.revision === next.revision) {
      useEditor.setState({
        doc: { ...cur.doc, revision: res.revision },
        revision: res.revision,
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.data?.doc) {
      // 리비전 충돌 — 서버 문서 채택 (낡았으면 desynced + 재수신)
      adoptServerDoc(err.data.doc, { notice: '다른 곳의 변경과 충돌해 최신 상태로 되돌렸습니다.' });
      return;
    }
    if (err instanceof ApiError && err.status === 400) {
      // 서버가 명령을 거부 — 서버 문서로 재동기화
      try {
        const { doc: fresh } = await getProject(projectId);
        adoptServerDoc(fresh, { notice: `편집이 거부되었습니다: ${err.message}` });
      } catch {
        useEditor.setState({ notice: `편집이 거부되었습니다: ${err.message}`, desynced: true });
        requestResync();
      }
      return;
    }
    // 전송 실패 — 낙관 적용은 남아 있는데 서버에는 안 갔다. 문서 전체 재수신으로 복구한다.
    const message = err instanceof Error ? err.message : String(err);
    useEditor.setState({ notice: `저장 실패: ${message}`, desynced: true });
    requestResync();
  }
}

const DERIVED_ASSET_FIELDS = ['proxySrc', 'waveformSrc', 'thumbSrc', 'reversedSrc'] as const;

/**
 * undo/redo 스냅샷 복원용 병합 — 스냅샷 이후 서버 잡이 써넣은 에셋 파생 필드
 * (proxySrc 등 — 임포트 시점에만 생성돼 지워지면 되살아날 계기가 없다)를 현재 문서에서 보존한다.
 */
function keepDerivedAssetFields(snapshot: ProjectDoc, current: ProjectDoc): ProjectDoc {
  let changed = false;
  const assets: Record<string, Asset> = { ...snapshot.assets };
  for (const [assetId, snapAsset] of Object.entries(snapshot.assets)) {
    const cur = current.assets[assetId];
    if (!cur) continue;
    let merged = snapAsset;
    for (const field of DERIVED_ASSET_FIELDS) {
      if (cur[field] !== undefined && merged[field] === undefined) {
        merged = { ...merged, [field]: cur[field] };
      }
    }
    if (merged !== snapAsset) {
      assets[assetId] = merged;
      changed = true;
    }
  }
  return changed ? { ...snapshot, assets } : snapshot;
}

/** 잠긴 트랙의 클립을 건드리는 명령이면 그 트랙 이름을 반환한다 (아니면 null). */
function lockedTrackName(doc: ProjectDoc, cmds: Command[]): string | null {
  const trackById = (trackId: string) => doc.tracks.find((t) => t.id === trackId);
  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'addClip': {
        const track = trackById(cmd.trackId);
        if (track?.locked) return track.name;
        break;
      }
      case 'moveClip': {
        const found = findClip(doc, cmd.clipId);
        if (found?.track.locked) return found.track.name;
        const target = cmd.trackId !== undefined ? trackById(cmd.trackId) : undefined;
        if (target?.locked) return target.name;
        break;
      }
      case 'removeClip':
      case 'splitClip':
      case 'trimClip':
      case 'setClipSpeed':
      case 'setReversed':
      case 'updateClip':
      case 'setKeyframes':
      // ── W5 (X2) — 클립을 건드리는 새 명령도 같은 방어를 받는다 ──
      case 'freezeFrame':
      case 'setSpeedRamp':
      case 'applyTextTemplate': {
        const found = findClip(doc, cmd.clipId);
        if (found?.track.locked) return found.track.name;
        break;
      }
      case 'duckTrack': {
        const music = trackById(cmd.musicTrackId);
        if (music?.locked) return music.name;
        break;
      }
      default:
        break;
    }
  }
  return null;
}

export const useEditor: UseBoundStore<StoreApi<EditorStore>> = create<EditorStore>()((set, get) => ({
  doc: null,
  revision: 0,
  clientId: newId(),
  selection: { clipId: null },
  playheadMs: 0,
  playing: false,
  zoom: 60,
  undoStack: [],
  redoStack: [],
  previewEngine: 'remotion',
  projectId: null,
  notice: null,
  jobs: {},
  desynced: false,

  connect(projectId) {
    set({ projectId });
    openSocket(projectId); // 접속 직후 서버가 {type:'doc'} 을 보내온다 (C3)
  },

  async dispatch(cmds) {
    const { doc, undoStack } = get();
    if (!doc) return;
    // 잠긴 트랙 방어 — 드래그 외 경로(Delete·Ctrl+D·분할·인스펙터 등)도 여기서 막는다
    const locked = lockedTrackName(doc, cmds);
    if (locked !== null) {
      set({ notice: `잠긴 트랙이라 편집할 수 없습니다: ${locked}` });
      return;
    }
    await sendCommands(cmds, {
      undoStack: [...undoStack, doc].slice(-MAX_STACK),
      redoStack: [],
    });
  },

  undo() {
    const { doc, undoStack, redoStack } = get();
    if (!doc || undoStack.length === 0) return;
    const prev = keepDerivedAssetFields(undoStack[undoStack.length - 1]!, doc);
    void sendCommands([{ type: 'restoreDoc', doc: prev }], {
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, doc].slice(-MAX_STACK),
    });
  },

  redo() {
    const { doc, undoStack, redoStack } = get();
    if (!doc || redoStack.length === 0) return;
    const nextDoc = keepDerivedAssetFields(redoStack[redoStack.length - 1]!, doc);
    void sendCommands([{ type: 'restoreDoc', doc: nextDoc }], {
      undoStack: [...undoStack, doc].slice(-MAX_STACK),
      redoStack: redoStack.slice(0, -1),
    });
  },

  select(clipId) {
    set({ selection: { clipId } });
  },

  seek(ms) {
    set({ playheadMs: Math.max(0, Math.round(ms)) });
  },

  setZoom(z) {
    set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) });
  },

  setPreviewEngine(e) {
    set({ previewEngine: e });
  },
}));
