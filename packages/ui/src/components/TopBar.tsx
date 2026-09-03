// 상단 바 — 프로젝트 이름 편집 · 실행취소/다시하기 · 더킹 · 커버 지정 · 프리뷰 엔진 토글
//            · 내보내기(렌더 잡 + WS 진행바, MP4/GIF/MOV(알파))
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../state.js';
import { renderCover, startRender, type RenderRequest } from '../api.js';
import { DuckDialog } from './DuckDialog.js';

const FORMATS = [
  { key: 'mp4', label: 'MP4 영상' },
  { key: 'gif', label: 'GIF' },
  { key: 'mov', label: 'MOV (알파 배경 투명)' },
] as const;

type ExportFormat = (typeof FORMATS)[number]['key'];

const SCALES = [
  { key: '1', label: '원본', factor: 1 },
  { key: '0.75', label: '75%', factor: 0.75 },
  { key: '0.5', label: '50%', factor: 0.5 },
] as const;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

function ExportPanel({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const projectId = useEditor((s) => s.projectId);
  const jobs = useEditor((s) => s.jobs);
  const [format, setFormat] = useState<ExportFormat>('mp4');
  const [scaleKey, setScaleKey] = useState<string>('1');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!doc || !projectId) return null;
  const job = jobId ? jobs[jobId] : undefined;
  const busy = job !== undefined && (job.status === 'queued' || job.status === 'running');

  const begin = async () => {
    setError(null);
    const scale = SCALES.find((s) => s.key === scaleKey)?.factor ?? 1;
    const body: RenderRequest = { format };
    if (format === 'mov') body.transparent = true; // ProRes 4444 — 배경을 그리지 않는다
    if (scale !== 1) {
      body.width = even(doc.settings.width * scale);
      body.height = even(doc.settings.height * scale);
    }
    try {
      const { jobId: id } = await startRender(projectId, body);
      setJobId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="export-panel">
      <div className="export-row">
        <label>형식</label>
        <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
          {FORMATS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="export-row">
        <label>해상도</label>
        <select value={scaleKey} onChange={(e) => setScaleKey(e.target.value)}>
          {SCALES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label} ({even(doc.settings.width * s.factor)}×{even(doc.settings.height * s.factor)})
            </option>
          ))}
        </select>
      </div>

      {job && (
        <div className="export-status">
          {busy && (
            <>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
              <span className="dim">
                {job.status === 'queued' ? '대기 중…' : `렌더 중 ${Math.round(job.progress * 100)}%`}
              </span>
            </>
          )}
          {job.status === 'done' && typeof job.result?.url === 'string' && (
            <a className="export-link" href={job.result.url} target="_blank" rel="noreferrer">
              완료 — 결과 열기
            </a>
          )}
          {job.status === 'error' && <span className="error-text">실패: {job.error}</span>}
        </div>
      )}
      {error && <span className="error-text">{error}</span>}

      <div className="export-actions">
        <button className="btn" onClick={onClose}>
          닫기
        </button>
        <button className="btn primary" onClick={begin} disabled={busy}>
          {busy ? '렌더 중…' : '렌더 시작'}
        </button>
      </div>
    </div>
  );
}

export function TopBar() {
  const doc = useEditor((s) => s.doc);
  const projectId = useEditor((s) => s.projectId);
  const playheadMs = useEditor((s) => s.playheadMs);
  const jobs = useEditor((s) => s.jobs);
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const dispatch = useEditor((s) => s.dispatch);
  const previewEngine = useEditor((s) => s.previewEngine);
  const setPreviewEngine = useEditor((s) => s.setPreviewEngine);

  const [name, setName] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [duckOpen, setDuckOpen] = useState(false);
  const [coverJobId, setCoverJobId] = useState<string | null>(null);
  const editingRef = useRef(false);

  const coverJob = coverJobId ? jobs[coverJobId] : undefined;
  const coverBusy = coverJob?.status === 'queued' || coverJob?.status === 'running';
  const coverUrl =
    coverJob?.status === 'done' && typeof coverJob.result?.url === 'string'
      ? coverJob.result.url
      : null;

  const setCover = async () => {
    if (!projectId) return;
    try {
      const { jobId } = await renderCover(projectId, playheadMs);
      setCoverJobId(jobId);
    } catch (err) {
      useEditor.setState({
        notice: `커버 지정 실패: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  useEffect(() => {
    if (!editingRef.current) setName(doc?.name ?? '');
  }, [doc?.name]);

  const commitName = () => {
    editingRef.current = false;
    const trimmed = name.trim();
    if (!doc) return;
    if (trimmed === '' || trimmed === doc.name) {
      setName(doc.name);
      return;
    }
    void dispatch([{ type: 'renameProject', name: trimmed }]);
  };

  return (
    <header className="topbar">
      <span className="logo">kitkat</span>
      <input
        className="project-name"
        value={name}
        placeholder="프로젝트 이름"
        disabled={!doc}
        onFocus={() => {
          editingRef.current = true;
        }}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setName(doc?.name ?? '');
            editingRef.current = false;
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <div className="topbar-spacer" />
      <label className="topbar-toggle" title="Remotion 대신 실험용 빠른 합성기로 미리본다">
        <input
          type="checkbox"
          checked={previewEngine === 'fast'}
          onChange={(e) => setPreviewEngine(e.target.checked ? 'fast' : 'remotion')}
        />
        빠른 미리보기(실험)
      </label>
      <button className="btn" onClick={undo} disabled={!canUndo} title="실행취소 (Ctrl+Z)">
        실행취소
      </button>
      <button className="btn" onClick={redo} disabled={!canRedo} title="다시하기 (Ctrl+Shift+Z)">
        다시하기
      </button>
      <button
        className="btn"
        disabled={!doc}
        title="목소리가 나올 때 음악 볼륨을 자동으로 낮춥니다"
        onClick={() => setDuckOpen(true)}
      >
        더킹
      </button>
      <button
        className="btn"
        disabled={!doc || coverBusy}
        title="지금 재생헤드 위치를 대표 이미지(커버)로 지정합니다"
        onClick={() => void setCover()}
      >
        {coverBusy ? '커버 굽는 중…' : '커버 지정'}
      </button>
      {coverUrl && (
        <a className="cover-thumb" href={coverUrl} target="_blank" rel="noreferrer" title="커버 열기">
          <img src={coverUrl} alt="커버" />
        </a>
      )}
      {coverJob?.status === 'error' && (
        <span className="error-text">커버 실패: {coverJob.error}</span>
      )}
      <div className="export-anchor">
        <button className="btn primary" disabled={!doc} onClick={() => setExportOpen((v) => !v)}>
          내보내기
        </button>
        {exportOpen && <ExportPanel onClose={() => setExportOpen(false)} />}
      </div>
      {duckOpen && <DuckDialog onClose={() => setDuckOpen(false)} />}
    </header>
  );
}
