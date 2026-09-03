// C3 HTTP API typed fetch — 서버와 같은 오리진(/api, /media)으로 호출한다.
import type { Asset, Crop, ProjectDoc, TextStyle } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';

export type ProjectSummary = { id: string; name: string; revision: number };

export type JobType =
  | 'proxy'
  | 'waveform'
  | 'thumb'
  | 'render'
  | 'captions'
  | 'reverse'
  // ── W5 (X6) ──
  | 'derive'
  | 'beats'
  | 'separate'
  | 'upscale'
  | 'interpolate'
  | 'cover'
  // ── W8 (F4) ──
  | 'matchStats'
  // ── W8 (F10) ──
  | 'track';

export type JobInfo = {
  id: string;
  type: JobType;
  projectId?: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number; // 0..1
  /** 진행 상황 한 줄 (예: "312/900 프레임") — 긴 잡(AI 업스케일·보간)만 채운다 (W8 F1·F2) */
  detail?: string;
  /** 중복 방지용 키 (파생은 `<assetId>:<sourceKey>`, 색 측정은 `<clipId>:match`) */
  key?: string;
  result?: { url?: string; path?: string } & Record<string, unknown>;
  error?: string;
};

export type RenderRequest = {
  range?: { start: number; end: number };
  proxy?: boolean;
  format?: 'mp4' | 'gif' | 'mov';
  transparent?: boolean; // mov(ProRes 4444) 알파 내보내기 (W5)
  width?: number;
  height?: number;
  fps?: number;
  outName?: string;
};

/** GET /api/capabilities 응답 (X6) — 서버가 실제로 지원하는 상수 목록 */
export type Capabilities = {
  transitions: string[];
  effects: string[];
  textAnims: string[];
  textTemplates: { id: string; name: string }[];
  speedRampPresets: { id: string; name: string }[];
  blendModes: string[];
  version: number;
};

export class ApiError extends Error {
  status: number;
  data?: { error?: string; doc?: ProjectDoc };
  constructor(status: number, message: string, data?: { error?: string; doc?: ProjectDoc }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, '서버에 연결할 수 없습니다');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const payload = data as { error?: string; doc?: ProjectDoc } | undefined;
    throw new ApiError(res.status, payload?.error ?? `HTTP ${res.status}`, payload);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function createProject(opts: {
  name: string;
  width?: number;
  height?: number;
  fps?: number;
}): Promise<{ doc: ProjectDoc }> {
  return req('/api/projects', json(opts));
}

export function listProjects(): Promise<{ projects: ProjectSummary[] }> {
  return req('/api/projects');
}

export function getProject(id: string): Promise<{ doc: ProjectDoc }> {
  return req(`/api/projects/${id}`);
}

export function deleteProject(id: string): Promise<{ ok: true }> {
  return req(`/api/projects/${id}`, { method: 'DELETE' });
}

export function postCommands(
  id: string,
  body: { commands: Command[]; baseRevision?: number; clientId?: string },
): Promise<{ revision: number }> {
  return req(`/api/projects/${id}/commands`, json(body));
}

export function importAssetPath(id: string, path: string): Promise<{ asset: Asset; jobId: string }> {
  return req(`/api/projects/${id}/assets`, json({ path }));
}

export function importAssetFile(id: string, file: File): Promise<{ asset: Asset; jobId: string }> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  return req(`/api/projects/${id}/assets`, { method: 'POST', body: fd });
}

export function extractAudio(id: string, assetId: string): Promise<{ asset: Asset }> {
  return req(`/api/projects/${id}/assets/${assetId}/extract-audio`, { method: 'POST' });
}

export function startRender(id: string, body: RenderRequest): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/render`, json(body));
}

export function getJob(jobId: string): Promise<JobInfo> {
  return req(`/api/jobs/${jobId}`);
}

export function requestCaptions(
  id: string,
  body: { assetId: string; trackId?: string; style?: Partial<TextStyle>; language?: string },
): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/captions`, json(body));
}

// ── W5 (X6) 새 엔드포인트 ─────────────────────────────────────────────────

/** 비트(박자) 감지 — 완료되면 서버가 asset.beats 를 채운다 */
export function detectBeats(id: string, assetId: string): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/assets/${assetId}/beats`, { method: 'POST' });
}

/**
 * 옛 판 프록시 다시 굽기 — 완료되면 asset.proxySrc 가 새 이름으로 바뀐다.
 * 이미 최신 판이면 400.
 */
export function reproxyAsset(id: string, assetId: string): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/assets/${assetId}/reproxy`, { method: 'POST' });
}

/** 옛 판 프록시를 원본·파생 가리지 않고 한 잡으로 전부 다시 굽는다. 없으면 400. */
export function reproxyAllAssets(id: string): Promise<{ jobId: string; total: number }> {
  return req(`/api/projects/${id}/assets/reproxy-all`, { method: 'POST' });
}

/** 보컬 분리 — 완료되면 audio 에셋 2개가 추가된다. 엔진이 없으면 501 */
export function separateStems(id: string, assetId: string): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/assets/${assetId}/separate`, { method: 'POST' });
}

// ── W8 F1·F2 — AI 업스케일(Real-ESRGAN) · AI 프레임 보간(RIFE) ──────────────
export type UpscaleEngine = 'auto' | 'ai' | 'lanczos';
export type InterpEngine = 'auto' | 'ai' | 'minterpolate';

/**
 * 업스케일 2x/3x/4x — 완료되면 video 에셋이 추가된다.
 * `engine:'ai'` 인데 서버에 실행 파일이 없으면 501.
 */
export function upscale(
  id: string,
  assetId: string,
  scale: 2 | 3 | 4 = 2,
  opts?: { engine?: UpscaleEngine; model?: string },
): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/assets/${assetId}/upscale`, json({ scale, ...opts }));
}

/** 프레임 보간 — 완료되면 video 에셋이 추가된다. `engine:'ai'` + 미설치면 501. */
export function interpolateFps(
  id: string,
  assetId: string,
  fps = 60,
  opts?: { engine?: InterpEngine; model?: string },
): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/assets/${assetId}/interpolate`, json({ fps, ...opts }));
}

/** 커버(대표 이미지) 지정 — 그 시각의 스틸을 굽고 settings.coverMs 를 남긴다 */
export function renderCover(id: string, timeMs: number): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/cover`, json({ timeMs }));
}

/** 서버가 지원하는 전환·효과·템플릿 목록 */
export function getCapabilities(): Promise<Capabilities> {
  return req('/api/capabilities');
}

// ── W8 F4 컷별 색 맞추기 ──────────────────────────────────────────────────

export type MatchRequestBody = {
  refClipId: string;
  strength?: number;
  region?: Crop;
  refRegion?: Crop;
};

/**
 * 잡 결과(`JobInfo.result`)로 오는 측정 보고 — 「맞추기 전/후」 색차(0..255)와 뭉갠 비율.
 * `deltaAfter` 는 사상을 통계에 먹인 «예측» 이다(실제 파일은 굽고 나서 다시 잴 수 있다).
 */
export type MatchReport = {
  clipId: string;
  refClipId: string;
  sampledAtMs: number[];
  channels: { before: number; after: number }[];
  deltaBefore: number;
  deltaAfter: number;
  reduction: number;
  clippedBefore: { low: number; high: number };
  clippedAfter: { low: number; high: number };
};

/**
 * 색 통계 측정 요청.
 * - `measured: true` → 잡이 돈다(`jobId`). 끝나면 서버가 `source.matchTo.levels` 를 채운다.
 * - `measured: false` → 이미 잰 값이 그대로 유효해서 다시 재지 않았다.
 */
export function measureMatch(
  id: string,
  clipId: string,
  body: MatchRequestBody,
): Promise<{ jobId?: string; measured: boolean; updated?: boolean }> {
  return req(`/api/projects/${id}/clips/${clipId}/match`, json(body));
}

// ── W8 F6 정밀 스코프 ──────────────────────────────────────────────────────

export type ServerScopeKind = 'waveform' | 'vectorscope' | 'histogram';

/** 잡 결과(`JobInfo.result`)로 오는 정밀 스코프 — 최종 렌더와 같은 픽셀에서 잰 것. */
export type ScopesResult = {
  urls: Partial<Record<ServerScopeKind, string>>;
  revision: number;
  timeMs: number;
  proxy: boolean;
  /** 캐시(같은 revision·시각)에 맞아서 다시 굽지 않았다 */
  cached: boolean;
  /** 최종 픽셀의 평균 (0..255) — 실시간 스코프의 같은 숫자와 빼서 차이를 낸다 */
  stats?: {
    width: number;
    height: number;
    pixels: number;
    mean: [number, number, number];
    meanY: number;
    meanCb: number;
    meanCr: number;
  };
};

/**
 * 그 시각의 스틸을 굽고 ffmpeg 스코프 3종을 PNG 로 만든다.
 * 같은 (revision, timeMs, kind) 는 캐시를 그대로 쓴다.
 */
export function requestScopes(
  id: string,
  timeMs: number,
  opts: { kinds?: ServerScopeKind[]; proxy?: boolean } = {},
): Promise<{ jobId: string; revision: number; timeMs: number; kinds: ServerScopeKind[] }> {
  return req(`/api/projects/${id}/scopes`, json({ timeMs, ...opts }));
}

// ── W8 F10 마스크 모션 트래킹 ─────────────────────────────────────────────

export type TrackRequestBody = {
  /** 시작 상자 — 클립 상자 대비 0..1 (= mask 와 같은 단위). 없으면 현재 마스크 상자. */
  box?: { x: number; y: number; w: number; h: number };
  /** 기준 프레임 — 클립 시작 기준 ms. 기본 0. */
  startMs?: number;
  /** 앞으로 갈 때의 끝 — 클립 시작 기준 ms. 기본 클립 끝. */
  endMs?: number;
  /** 뒤로 갈 때의 끝 — 클립 시작 기준 ms. 기본 0(클립 처음). `direction` 이 뒤로 갈 때만 쓴다. */
  backEndMs?: number;
  /**
   * 기준 프레임에서 어느 쪽으로 갈까. **기본 `forward`** — 기존 두 버튼의 뜻이 바뀌지
   * 않게 한 것이다(「여기서 다시 추적」은 앞쪽 키프레임을 보존한다고 약속한다).
   * `both` 는 클립 «중간»에서 대상을 찾았을 때 쓰는 것으로, 앞뒤를 한 번에 덮는다.
   */
  direction?: 'forward' | 'backward' | 'both';
  /** 키프레임 간소화 허용 오차(소스 픽셀). 기본 4 — 「정밀 ↔ 가벼움」 슬라이더. */
  tolerancePx?: number;
  /** 실패 판정 점수. 기본 0.45. 아주 빠른 움직임에서 거짓 실패가 잦으면 낮춘다. */
  scoreThreshold?: number;
};

/** 잡 결과(`JobInfo.result`)로 오는 추적 보고. */
export type TrackReport = {
  clipId: string;
  /** 실제로 돈 방향 (요청한 그대로). */
  direction?: 'forward' | 'backward' | 'both';
  /** 이번에 넣은 키프레임 수 (= 상자 수 × 4) */
  keyframes: number;
  /** 병합 뒤 클립 전체의 키프레임 수 */
  totalKeyframes: number;
  frames: number;
  tracked: number;
  /** 간소화 전/후 «상자» 개수 */
  before: number;
  after: number;
  reduction: number;
  maxDeviationPx: number;
  /** 추적 실패 구간 — 클립 기준 ms */
  gaps: { startMs: number; endMs: number }[];
  fps: number;
  /** 추적 띠용 점수 (최대 200점으로 솎은 것) */
  scores: { t: number; s: number; ok: boolean }[];
};

/**
 * 마스크 모션 트래킹 — 끝나면 서버가 mask.x/y/w/h 키프레임을 넣는다.
 * 엔진(OpenCV TrackerVit)이 없으면 501.
 */
export function trackMask(
  id: string,
  clipId: string,
  body: TrackRequestBody = {},
): Promise<{ jobId: string }> {
  return req(`/api/projects/${id}/clips/${clipId}/track`, json(body));
}
