// 미디어 패널 — 에셋 목록·업로드·소리 추출·보이스오버 녹음·더블클릭 배치
//                + W5: LUT(.cube) 임포트 · 비트 감지 · 보컬 분리 · 업스케일 · 프레임 보간
import { useRef, useState } from 'react';
import { newId, type Asset, type Clip, type ProjectDoc, type Track } from '@kitkat/schema';
import { TRACK_ACCEPTS } from '@kitkat/engine';
import { useEditor } from '../state.js';
import {
  ApiError,
  detectBeats,
  extractAudio,
  importAssetFile,
  interpolateFps,
  separateStems,
  upscale,
  type InterpEngine,
  type JobInfo,
  type UpscaleEngine,
  reproxyAsset,
  reproxyAllAssets,
} from '../api.js';
import { isCurrentProxy, staleProxyCount } from './sections/inspector-utils.js';

const KIND_LABEL: Record<Asset['kind'], string> = {
  video: '영상',
  audio: '소리',
  image: '사진',
  lut: 'LUT',
};
const DEFAULT_IMAGE_MS = 3000;

// ── W8 F1·F2 — AI 업스케일·보간 선택지 ────────────────────────────────────
// 엔진 «자동» 은 서버에 AI 실행 파일이 있으면 AI, 없으면 고전 필터로 물러난다.
// «AI» 를 고르면 없을 때 501 이 오고, 아래 runJob 이 그 사실을 그대로 알린다.

export const UPSCALE_ENGINE_LABELS: [UpscaleEngine, string][] = [
  ['auto', '자동'],
  ['ai', 'AI (Real-ESRGAN)'],
  ['lanczos', '빠름 (lanczos)'],
];
export const INTERP_ENGINE_LABELS: [InterpEngine, string][] = [
  ['auto', '자동'],
  ['ai', 'AI (RIFE)'],
  ['minterpolate', '빠름 (minterpolate)'],
];
/** 실측(2026-09-02) 기준 순서 — animevideov3 가 이 머신에서 17배 빠르고 떨림도 적다. */
export const UPSCALE_MODEL_LABELS: [string, string][] = [
  ['realesrgan-x4plus', '실사 (x4plus)'],
  ['realesr-animevideov3', '영상용 (animevideov3)'],
  ['realesrgan-x4plus-anime', '애니 (x4plus-anime)'],
];
export const INTERP_MODEL_LABELS: [string, string][] = [
  ['rife-v4.6', 'rife-v4.6 (권장)'],
  ['rife-v4', 'rife-v4'],
  ['rife-v3.1', 'rife-v3.1'],
  ['rife-anime', 'rife-anime'],
];

export type MediaOpOpts = {
  scale: 2 | 3 | 4;
  upEngine: UpscaleEngine;
  upModel: string;
  fps: number;
  ipEngine: InterpEngine;
  ipModel: string;
};

export const DEFAULT_OP_OPTS: MediaOpOpts = {
  scale: 2,
  upEngine: 'auto',
  upModel: 'realesrgan-x4plus',
  fps: 60,
  ipEngine: 'auto',
  ipModel: 'rife-v4.6',
};

/**
 * 잡 진행 상황 한 줄. AI 업스케일·보간은 몇 분~몇 시간이 걸려 퍼센트만으로는 감이 안 온다.
 * 서버가 보내는 `detail`(「312/900 프레임」)을 퍼센트 앞에 붙인다.
 */
export function jobProgressText(job: Pick<JobInfo, 'status' | 'progress' | 'detail'>): string {
  if (job.status === 'queued') return '대기 중…';
  const pct = `${Math.round(job.progress * 100)}%`;
  return job.detail ? `${job.detail} (${pct})` : pct;
}

/** 501(엔진 미설치) 안내 문구. */
export function engineMissingNotice(op: string, serverMessage?: string): string {
  if (op === 'separate') return '보컬 분리 엔진이 없습니다. 서버에 Demucs 를 설치해야 합니다.';
  return serverMessage && serverMessage.length > 0 ? serverMessage : `${op} 엔진이 없습니다.`;
}

/** 에셋별로 진행 중인 후처리 잡 — 키는 `<assetId>:<작업>` */
type AssetJob = { assetId: string; jobId: string; label: string };

function fmtDuration(ms?: number): string {
  if (ms === undefined) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function overlaps(track: Track, start: number, duration: number): boolean {
  return track.clips.some((c) => c.start < start + duration && start < c.start + c.duration);
}

/** 에셋으로 클립을 만들어 재생헤드 위치·첫 호환 트랙에 배치할 명령을 계산 */
function buildAddClip(
  doc: ProjectDoc,
  asset: Asset,
  playheadMs: number,
): { trackId: string; clip: Clip } | null {
  if (asset.kind === 'lut') return null; // LUT 은 타임라인에 놓는 것이 아니라 클립에 거는 필터다
  const clipKind = asset.kind;
  const duration = asset.kind === 'image' ? DEFAULT_IMAGE_MS : (asset.duration ?? DEFAULT_IMAGE_MS);
  const start = playheadMs;
  const track = doc.tracks.find(
    (t) => !t.locked && TRACK_ACCEPTS[t.kind].includes(clipKind) && !overlaps(t, start, duration),
  );
  if (!track) return null;

  const base = { id: newId(), start, duration };
  let clip: Clip;
  if (asset.kind === 'video') {
    clip = { ...base, kind: 'video', assetId: asset.id, in: 0, out: duration, speed: 1, volume: 1 };
  } else if (asset.kind === 'audio') {
    clip = { ...base, kind: 'audio', assetId: asset.id, in: 0, out: duration, speed: 1, volume: 1 };
  } else {
    clip = { ...base, kind: 'image', assetId: asset.id };
  }
  return { trackId: track.id, clip };
}

export function MediaPanel() {
  const doc = useEditor((s) => s.doc);
  const projectId = useEditor((s) => s.projectId);
  const playheadMs = useEditor((s) => s.playheadMs);
  const dispatch = useEditor((s) => s.dispatch);
  const jobs = useEditor((s) => s.jobs);
  // 옛 판 프록시 개수 — 0 이면 버튼이 안 뜬다 (원본 + 파생)
  const stale = doc ? staleProxyCount(doc) : 0;

  const fileRef = useRef<HTMLInputElement>(null);
  const lutRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [uploading, setUploading] = useState(0);
  const [recording, setRecording] = useState(false);
  const [assetJobs, setAssetJobs] = useState<Record<string, AssetJob>>({});
  const [opOpts, setOpOpts] = useState<Record<string, MediaOpOpts>>({});

  if (!doc || !projectId) {
    return <div className="media-panel dim">프로젝트 불러오는 중…</div>;
  }
  const allAssets = Object.values(doc.assets);
  const mediaAssets = allAssets.filter((a) => a.kind !== 'lut');
  const lutAssets = allAssets.filter((a) => a.kind === 'lut');

  const notice = (text: string) => useEditor.setState({ notice: text });

  const uploadFiles = async (files: File[]) => {
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        await importAssetFile(projectId, file); // addAsset 은 WS 브로드캐스트로 반영된다
      } catch (err) {
        notice(`업로드 실패 (${file.name}): ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const onPick = (list: FileList | null, input: HTMLInputElement | null) => {
    if (list && list.length > 0) void uploadFiles(Array.from(list));
    if (input) input.value = '';
  };

  const toggleRecord = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        setRecording(false);
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        void uploadFiles([new File([blob], `녹음-${stamp}.webm`, { type: blob.type })]);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      notice('마이크를 사용할 수 없습니다. 브라우저 권한을 확인하세요.');
    }
  };

  const onExtractAudio = async (asset: Asset) => {
    try {
      await extractAudio(projectId, asset.id); // 새 audio 에셋은 WS 로 반영
      notice(`'${asset.name}'의 소리를 추출했습니다.`);
    } catch (err) {
      notice(`소리 추출 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 후처리 잡을 걸고 진행 상태를 에셋 줄 밑에 보여준다 (진행률은 WS job 이벤트로 온다) */
  const runJob = async (
    asset: Asset,
    op: string,
    label: string,
    start: () => Promise<{ jobId: string }>,
  ) => {
    const key = `${asset.id}:${op}`;
    try {
      const { jobId } = await start();
      setAssetJobs((m) => ({ ...m, [key]: { assetId: asset.id, jobId, label } }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        notice(engineMissingNotice(op === 'separate' ? 'separate' : label, err.message));
        return;
      }
      notice(`${label} 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const optsFor = (assetId: string): MediaOpOpts => opOpts[assetId] ?? DEFAULT_OP_OPTS;
  const setOpt = (assetId: string, patch: Partial<MediaOpOpts>) =>
    setOpOpts((m) => ({ ...m, [assetId]: { ...optsFor(assetId), ...patch } }));

  const onPlace = (asset: Asset) => {
    if (asset.kind === 'lut') {
      notice('LUT 은 인스펙터의 [소스 보정]에서 클립에 겁니다.');
      return;
    }
    const placed = buildAddClip(doc, asset, playheadMs);
    if (!placed) {
      notice('재생헤드 위치에 배치할 수 있는 빈 트랙이 없습니다.');
      return;
    }
    void dispatch([{ type: 'addClip', trackId: placed.trackId, clip: placed.clip }]);
  };

  /** 이 에셋에 걸린 잡들의 진행 상태 줄 */
  const jobLines = (assetId: string) =>
    Object.entries(assetJobs)
      .filter(([, j]) => j.assetId === assetId)
      .map(([key, j]) => {
        const job = jobs[j.jobId];
        if (!job) return null;
        if (job.status === 'error') {
          return (
            <span key={key} className="error-text media-job">
              {j.label} 실패: {job.error ?? '알 수 없는 오류'}
            </span>
          );
        }
        if (job.status === 'done') {
          return (
            <span key={key} className="dim media-job">
              {j.label} 완료
            </span>
          );
        }
        return (
          <span key={key} className="dim media-job">
            {j.label} {jobProgressText(job)}
          </span>
        );
      });

  const renderAsset = (asset: Asset) => (
    <div
      key={asset.id}
      className={`media-item${asset.kind === 'lut' ? ' media-item-lut' : ''}`}
      title={asset.kind === 'lut' ? 'LUT 파일 — 인스펙터에서 클립에 겁니다' : '더블클릭하면 재생헤드 위치에 배치'}
      onDoubleClick={() => onPlace(asset)}
    >
      <div className="media-thumb">
        {asset.thumbSrc ? (
          <img src={`/media/${asset.thumbSrc}`} alt="" loading="lazy" />
        ) : (
          <span className={`media-kind kind-${asset.kind}`}>{KIND_LABEL[asset.kind]}</span>
        )}
      </div>
      <div className="media-meta">
        <span className="media-name" title={asset.name}>
          {asset.name}
        </span>
        <span className="dim media-sub">
          {KIND_LABEL[asset.kind]}
          {asset.duration !== undefined ? ` · ${fmtDuration(asset.duration)}` : ''}
          {asset.beats ? ` · 비트 ${asset.beats.length}개` : ''}
        </span>
        {asset.kind !== 'lut' && (
          <div className="media-ops">
            {asset.kind === 'video' && (
              <button className="btn mini" onClick={() => void onExtractAudio(asset)}>
                소리 추출
              </button>
            )}
            {asset.kind === 'video' && asset.proxySrc && !isCurrentProxy(asset.proxySrc) && (
              <button
                className="btn mini"
                title="이 영상의 편집용 사본이 옛 판이라 타임라인을 끌 때 느립니다. 다시 구우면 빨라집니다(파일이 26~62% 커집니다)."
                onClick={() =>
                  void runJob(asset, 'proxy', '프록시 다시 굽기', () =>
                    reproxyAsset(projectId, asset.id),
                  )
                }
              >
                프록시 갱신
              </button>
            )}
            {asset.kind === 'audio' && (
              <button
                className="btn mini"
                onClick={() =>
                  void runJob(asset, 'beats', '비트 감지', () => detectBeats(projectId, asset.id))
                }
              >
                비트 감지
              </button>
            )}
            {asset.kind === 'audio' && (
              <button
                className="btn mini"
                onClick={() =>
                  void runJob(asset, 'separate', '보컬 분리', () =>
                    separateStems(projectId, asset.id),
                  )
                }
              >
                보컬 분리
              </button>
            )}
            {asset.kind === 'video' && (
              <span className="media-op-group">
                <select
                  className="mini"
                  title="배율"
                  value={optsFor(asset.id).scale}
                  onChange={(e) => setOpt(asset.id, { scale: Number(e.target.value) as 2 | 3 | 4 })}
                >
                  <option value={2}>2배</option>
                  <option value={3}>3배</option>
                  <option value={4}>4배</option>
                </select>
                <select
                  className="mini"
                  title="엔진"
                  value={optsFor(asset.id).upEngine}
                  onChange={(e) => setOpt(asset.id, { upEngine: e.target.value as UpscaleEngine })}
                >
                  {UPSCALE_ENGINE_LABELS.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
                {optsFor(asset.id).upEngine !== 'lanczos' && (
                  <select
                    className="mini"
                    title="AI 모델"
                    value={optsFor(asset.id).upModel}
                    onChange={(e) => setOpt(asset.id, { upModel: e.target.value })}
                  >
                    {UPSCALE_MODEL_LABELS.map(([v, label]) => (
                      <option key={v} value={v}>{label}</option>
                    ))}
                  </select>
                )}
                <button
                  className="btn mini"
                  onClick={() => {
                    const o = optsFor(asset.id);
                    void runJob(asset, 'upscale', '업스케일', () =>
                      upscale(projectId, asset.id, o.scale, { engine: o.upEngine, model: o.upModel }),
                    );
                  }}
                >
                  업스케일
                </button>
              </span>
            )}
            {asset.kind === 'video' && (
              <span className="media-op-group">
                <select
                  className="mini"
                  title="목표 fps"
                  value={optsFor(asset.id).fps}
                  onChange={(e) => setOpt(asset.id, { fps: Number(e.target.value) })}
                >
                  <option value={48}>48fps</option>
                  <option value={60}>60fps</option>
                  <option value={120}>120fps</option>
                </select>
                <select
                  className="mini"
                  title="엔진"
                  value={optsFor(asset.id).ipEngine}
                  onChange={(e) => setOpt(asset.id, { ipEngine: e.target.value as InterpEngine })}
                >
                  {INTERP_ENGINE_LABELS.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
                {optsFor(asset.id).ipEngine !== 'minterpolate' && (
                  <select
                    className="mini"
                    title="AI 모델"
                    value={optsFor(asset.id).ipModel}
                    onChange={(e) => setOpt(asset.id, { ipModel: e.target.value })}
                  >
                    {INTERP_MODEL_LABELS.map(([v, label]) => (
                      <option key={v} value={v}>{label}</option>
                    ))}
                  </select>
                )}
                <button
                  className="btn mini"
                  onClick={() => {
                    const o = optsFor(asset.id);
                    void runJob(asset, 'interpolate', '프레임 보간', () =>
                      interpolateFps(projectId, asset.id, o.fps, {
                        engine: o.ipEngine,
                        model: o.ipModel,
                      }),
                    );
                  }}
                >
                  프레임 보간
                </button>
              </span>
            )}
          </div>
        )}
        {jobLines(asset.id)}
      </div>
    </div>
  );

  return (
    <div className="media-panel">
      <div className="media-actions">
        <button className="btn primary" onClick={() => fileRef.current?.click()}>
          {uploading > 0 ? `업로드 중… (${uploading})` : '가져오기'}
        </button>
        <button className={`btn${recording ? ' recording' : ''}`} onClick={() => void toggleRecord()}>
          {recording ? '녹음 중지' : '녹음'}
        </button>
        <button className="btn" title="색 보정 LUT(.cube) 파일" onClick={() => lutRef.current?.click()}>
          LUT
        </button>
        {stale > 0 ? (
          <button
            className="btn"
            title="옛 판 편집용 사본(프록시)을 원본·파생 가리지 않고 한 번에 다시 굽습니다. 타임라인 끌기가 빨라집니다."
            onClick={() => {
              void reproxyAllAssets(projectId).then((r) => notice(`옛 프록시 ${r.total}개 갱신 시작`)).catch((e: unknown) => notice(String((e as Error).message ?? e)));
            }}
          >
            옛 프록시 {stale}개 갱신
          </button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          hidden
          onChange={(e) => onPick(e.target.files, fileRef.current)}
        />
        <input
          ref={lutRef}
          type="file"
          multiple
          accept=".cube,.3dl"
          hidden
          onChange={(e) => onPick(e.target.files, lutRef.current)}
        />
      </div>

      <div className="media-list">
        {allAssets.length === 0 && (
          <p className="dim media-empty">
            미디어가 없습니다.
            <br />
            [가져오기]로 영상·소리·사진을 추가한 뒤, 더블클릭해 타임라인에 배치하세요.
          </p>
        )}
        {mediaAssets.map(renderAsset)}
        {lutAssets.length > 0 && (
          <>
            <div className="media-group-label dim">LUT (색 보정)</div>
            {lutAssets.map(renderAsset)}
          </>
        )}
      </div>
    </div>
  );
}
