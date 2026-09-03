// F6 스코프 패널 — 웨이브폼·벡터스코프·히스토그램을 **두 기준**으로 본다.
//
//  · 「미리보기 기준」: 빠른 미리보기 캔버스를 5프레임마다 축소해 읽어 워커에서 계산한다.
//    **재생 중에도 살아 있다.** 컷이 넘어갈 때 웨이브폼이 어떻게 튀는지가 컷별 색 맞추기의 핵심이다.
//  · 「최종 렌더 기준」: 서버가 그 시각의 스틸을 굽고 ffmpeg 스코프를 건다. 1~2초 걸린다.
//
// 어느 쪽을 보고 있는지 모르면 위험하므로 **배지를 항상 띄운다.**
// 두 기준의 평균 색 차이도 숫자로 보여 준다 — 프록시·근사 때문에 다를 수밖에 없고,
// 얼마나 다른지는 사용자가 알아야 한다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../state.js';
import { requestScopes, type ScopesResult } from '../api.js';
import { activeClipsAt } from '../preview/timing.js';
import { previewFps, scopeBus, type ScopeSample } from '../preview/scope-source.js';
import {
  SCOPE_KINDS,
  SCOPE_LABEL,
  drawHistogramGraticule,
  drawVectorGraticule,
  drawWaveformGraticule,
  statsDelta,
  type Ctx2D,
  type ImageLike,
  type ScopeKind,
  type ScopeStats,
} from '../preview/scopes.js';
import type { ScopeWorkerRequest, ScopeWorkerResponse } from '../preview/scopes.worker.js';

/** 라이브 한 줄 + 고정 두 줄. 고정은 컷별 색 맞추기(F4)의 짝이다. */
type RowKey = 'live' | 'a' | 'b';
const PIN_KEYS: RowKey[] = ['a', 'b'];

type Row = {
  label: string;
  timeMs: number;
  stats: ScopeStats | null;
  /** 고정할 때 붙잡아 둔 픽셀 — 종류를 바꾸면 이걸로 다시 계산한다. */
  sample: ScopeSample | null;
};

type CanvasMap = Partial<Record<ScopeKind, HTMLCanvasElement | null>>;

function paint(canvas: HTMLCanvasElement, kind: ScopeKind, img: ImageBitmap | ImageLike): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (canvas.width !== img.width) canvas.width = img.width;
  if (canvas.height !== img.height) canvas.height = img.height;
  ctx.clearRect(0, 0, img.width, img.height);
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    ctx.drawImage(img, 0, 0);
    img.close();
    return;
  }
  // 워커가 OffscreenCanvas 를 못 써서 원시 그림을 보냈다 — 격자를 여기서 얹는다
  const raw = img as ImageLike;
  const id = ctx.createImageData(raw.width, raw.height);
  id.data.set(raw.data);
  ctx.putImageData(id, 0, 0);
  const c2 = ctx as unknown as Ctx2D;
  if (kind === 'vectorscope') drawVectorGraticule(c2, raw.width);
  else if (kind === 'waveform') drawWaveformGraticule(c2, Math.round(raw.width / 3));
  else drawHistogramGraticule(c2, raw.width, raw.height);
}

/**
 * 워커 한 개를 돌리는 얇은 껍데기.
 * **줄마다 한 번에 하나만** 보낸다 — 계산이 밀리면 큐가 쌓여 지연만 커진다(스코프는 최신이 전부).
 */
class ScopeWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, RowKey>();
  private readonly busy = new Set<RowKey>();
  private readonly onResult: (row: RowKey, res: ScopeWorkerResponse) => void;
  /** 워커를 못 만들었을 때 메인 스레드에서 도는 대비책 (스코프가 사라지지는 않게). */
  private fallback: ((req: ScopeWorkerRequest) => void) | null = null;

  constructor(onResult: (row: RowKey, res: ScopeWorkerResponse) => void) {
    this.onResult = onResult;
    try {
      this.worker = new Worker(new URL('../preview/scopes.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (e: MessageEvent) => {
        const res = e.data as ScopeWorkerResponse;
        const row = this.pending.get(res.id);
        if (row === undefined) return;
        this.pending.delete(res.id);
        this.busy.delete(row);
        this.onResult(row, res);
      };
      this.worker.onerror = () => {
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  post(row: RowKey, sample: ScopeSample, kinds: ScopeKind[], log: boolean): void {
    if (this.busy.has(row) || kinds.length === 0) return;
    const id = this.nextId++;
    // 픽셀은 transfer 로 넘긴다(복사 없음) — 그래서 **사본**을 만들어 보낸다.
    const copy = sample.data.slice();
    const req: ScopeWorkerRequest = {
      id,
      buffer: copy.buffer as ArrayBuffer,
      width: sample.width,
      height: sample.height,
      kinds,
      log,
      timeMs: sample.timeMs,
    };
    this.pending.set(id, row);
    this.busy.add(row);
    if (this.worker) {
      this.worker.postMessage(req, [req.buffer]);
      return;
    }
    if (!this.fallback) {
      void import('../preview/scopes.worker.js').then((m) => {
        this.fallback = (r) => {
          const { response } = m.handleScopeRequest(r);
          const key = this.pending.get(response.id);
          this.pending.delete(response.id);
          if (key !== undefined) {
            this.busy.delete(key);
            this.onResult(key, response);
          }
        };
        this.fallback(req);
      });
      return;
    }
    this.fallback(req);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.busy.clear();
  }
}

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export function ScopesPanel(): JSX.Element | null {
  const doc = useEditor((s) => s.doc);
  const projectId = useEditor((s) => s.projectId);
  const playheadMs = useEditor((s) => s.playheadMs);
  const selectedClipId = useEditor((s) => s.selection.clipId);
  const previewEngine = useEditor((s) => s.previewEngine);
  const setPreviewEngine = useEditor((s) => s.setPreviewEngine);
  const jobs = useEditor((s) => s.jobs);

  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<ScopeKind[]>([...SCOPE_KINDS]);
  const [log, setLog] = useState(true);
  const [fps, setFps] = useState(0);
  const [computeMs, setComputeMs] = useState(0);
  const [workerOk, setWorkerOk] = useState(true);
  const [rows, setRows] = useState<Record<RowKey, Row | null>>({
    live: { label: '재생 중', timeMs: 0, stats: null, sample: null },
    a: null,
    b: null,
  });

  // 정밀(서버) 쪽
  const [preciseJobId, setPreciseJobId] = useState<string | null>(null);
  const [precise, setPrecise] = useState<ScopesResult | null>(null);
  const [preciseError, setPreciseError] = useState<string | null>(null);
  /** 정밀을 요청한 순간의 실시간 통계 — 결과가 오면 이것과 빼서 차이를 낸다. */
  const [preciseBase, setPreciseBase] = useState<{ stats: ScopeStats; timeMs: number } | null>(null);

  const canvases = useRef<Record<RowKey, CanvasMap>>({ live: {}, a: {}, b: {} });
  const clientRef = useRef<ScopeWorkerClient | null>(null);
  const kindsRef = useRef(kinds);
  const logRef = useRef(log);
  const liveSample = useRef<ScopeSample | null>(null);
  kindsRef.current = kinds;
  logRef.current = log;

  const setCanvas = useCallback(
    (row: RowKey, kind: ScopeKind) => (el: HTMLCanvasElement | null) => {
      canvases.current[row][kind] = el;
    },
    [],
  );

  // ── 워커 + 실시간 표본 구독 ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const client = new ScopeWorkerClient((row, res) => {
      const map = canvases.current[row];
      for (const kind of SCOPE_KINDS) {
        const img = res.images[kind];
        const el = map[kind];
        if (img && el) paint(el, kind, img);
      }
      if (row === 'live') {
        setComputeMs(res.computeMs);
        setRows((prev) =>
          prev.live
            ? { ...prev, live: { ...prev.live, stats: res.stats, timeMs: res.timeMs } }
            : prev,
        );
      } else {
        setRows((prev) => {
          const r = prev[row];
          return r ? { ...prev, [row]: { ...r, stats: res.stats } } : prev;
        });
      }
    });
    clientRef.current = client;
    setWorkerOk(client.usingWorker);

    const off = scopeBus.subscribe((sample) => {
      liveSample.current = sample;
      client.post('live', sample, kindsRef.current, logRef.current);
    });
    // 이미 흘러간 표본이 있으면 바로 한 장 그린다 (패널을 늦게 열었을 때)
    const last = scopeBus.latest;
    if (last) {
      liveSample.current = last;
      client.post('live', last, kindsRef.current, logRef.current);
    }
    return () => {
      off();
      client.dispose();
      clientRef.current = null;
    };
  }, [open]);

  // 고정된 줄은 종류·로그 설정이 바뀔 때만 다시 계산한다 (픽셀은 그대로다)
  useEffect(() => {
    const c = clientRef.current;
    if (!c) return;
    for (const key of PIN_KEYS) {
      const r = rows[key];
      if (r?.sample) c.post(key, r.sample, kinds, log);
    }
    // rows 를 의존성에 넣으면 결과가 올 때마다 다시 돈다 — 설정이 바뀔 때만이면 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds, log]);

  // fps 표시 — 스코프를 켰을 때 얼마나 떨어지는지 눈으로 확인하는 숫자다
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setFps(previewFps.fps), 500);
    return () => clearInterval(t);
  }, [open]);

  // 정밀 잡 결과 수신
  useEffect(() => {
    if (!preciseJobId) return;
    const job = jobs[preciseJobId];
    if (!job) return;
    if (job.status === 'done' && job.result) {
      setPrecise(job.result as unknown as ScopesResult);
      setPreciseJobId(null);
    } else if (job.status === 'error') {
      setPreciseError(job.error ?? '정밀 스코프 실패');
      setPreciseJobId(null);
    }
  }, [jobs, preciseJobId]);

  const clipLabelAt = useCallback(
    (tMs: number): string => {
      if (!doc) return '—';
      const vis = activeClipsAt(doc, tMs).visual;
      const picked = vis.find((v) => v.clip.id === selectedClipId) ?? vis[0];
      if (!picked) return '빈 구간';
      const asset = doc.assets[picked.clip.assetId];
      return asset?.name ?? picked.clip.id.slice(0, 6);
    },
    [doc, selectedClipId],
  );

  const pin = (key: RowKey): void => {
    const s = liveSample.current;
    if (!s) return;
    // 픽셀을 복사해 둬야 이후 표본에 덮이지 않는다
    const held: ScopeSample = { ...s, data: s.data.slice() };
    setRows((prev) => ({
      ...prev,
      [key]: {
        label: `${clipLabelAt(s.timeMs)} @ ${(s.timeMs / 1000).toFixed(2)}s`,
        timeMs: s.timeMs,
        stats: null,
        sample: held,
      },
    }));
    clientRef.current?.post(key, held, kindsRef.current, logRef.current);
  };

  const unpin = (key: RowKey): void => {
    setRows((prev) => ({ ...prev, [key]: null }));
  };

  const askPrecise = (): void => {
    if (!projectId) return;
    setPreciseError(null);
    setPrecise(null);
    const base = rows.live?.stats;
    setPreciseBase(base ? { stats: base, timeMs: playheadMs } : null);
    requestScopes(projectId, Math.round(playheadMs), { kinds })
      .then((r) => setPreciseJobId(r.jobId))
      .catch((e) => setPreciseError(e instanceof Error ? e.message : String(e)));
  };

  const toggleKind = (k: ScopeKind): void => {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return SCOPE_KINDS.filter((x) => next.has(x)); // 늘 웨이브폼·벡터스코프·히스토그램 순서
    });
  };

  const delta = useMemo(() => {
    if (!precise?.stats || !preciseBase) return null;
    const p: ScopeStats = {
      pixels: precise.stats.pixels,
      mean: precise.stats.mean,
      meanY: precise.stats.meanY,
      meanCb: precise.stats.meanCb,
      meanCr: precise.stats.meanCr,
    };
    return statsDelta(preciseBase.stats, p);
  }, [precise, preciseBase]);

  if (!doc) return null;

  const preciseBusy = preciseJobId !== null;
  const live = previewEngine === 'fast';

  const rowList: { key: RowKey; row: Row }[] = [];
  if (rows.live) rowList.push({ key: 'live', row: rows.live });
  for (const k of PIN_KEYS) {
    const r = rows[k];
    if (r) rowList.push({ key: k, row: r });
  }

  return (
    <div className={`scopes-panel${open ? ' open' : ''}`}>
      <div className="scopes-head">
        <button className="btn scopes-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? '▾' : '▸'} 스코프
        </button>
        <span className={`scope-badge ${live ? 'live' : 'off'}`}>
          {live ? '미리보기 기준' : '실시간 꺼짐'}
        </span>
        {precise ? <span className="scope-badge final">최종 렌더 기준</span> : null}
        {open ? (
          <>
            <span className="scopes-sep" />
            {SCOPE_KINDS.map((k) => (
              <button
                key={k}
                className={`btn tiny${kinds.includes(k) ? ' on' : ''}`}
                onClick={() => toggleKind(k)}
                title={`${SCOPE_LABEL[k]} 보이기/숨기기`}
              >
                {SCOPE_LABEL[k]}
              </button>
            ))}
            <button
              className={`btn tiny${log ? ' on' : ''}`}
              onClick={() => setLog((v) => !v)}
              title="히스토그램 로그 스케일"
            >
              log
            </button>
            <span className="scopes-sep" />
            {PIN_KEYS.map((k) => (
              <button
                key={k}
                className="btn tiny"
                onClick={() => (rows[k] ? unpin(k) : pin(k))}
                disabled={!rows[k] && !live}
                title="지금 화면의 스코프를 아래에 고정해 두 컷을 비교한다"
              >
                {rows[k] ? `해제 ${k.toUpperCase()}` : `비교 고정 ${k.toUpperCase()}`}
              </button>
            ))}
            <span className="scopes-sep" />
            <button className="btn tiny" onClick={askPrecise} disabled={preciseBusy}>
              {preciseBusy ? '정밀 계산 중…' : '정밀(최종 렌더 기준)'}
            </button>
            <span className="scopes-meta">
              {fps > 0 ? `${fmt(fps)} fps` : '정지'}
              {computeMs > 0 ? ` · 계산 ${fmt(computeMs)}ms` : ''}
              {workerOk ? '' : ' · 워커 없음(메인 스레드)'}
            </span>
          </>
        ) : null}
      </div>

      {open ? (
        <div className="scopes-body">
          {!live ? (
            <div className="scopes-note">
              실시간 스코프는 <b>빠른 미리보기</b>의 WebGL 화면을 읽습니다.
              <button className="btn tiny" onClick={() => setPreviewEngine('fast')}>
                빠른 미리보기로 전환
              </button>
            </div>
          ) : null}

          {rowList.map(({ key, row }) => (
            <div className="scope-row" key={key}>
              <div className="scope-row-label">
                <span>{key === 'live' ? '실시간' : `고정 ${key.toUpperCase()}`}</span>
                <span className="dim">{key === 'live' ? clipLabelAt(playheadMs) : row.label}</span>
                {row.stats ? (
                  <span className="dim scope-nums">
                    Y {fmt(row.stats.meanY)} · R {fmt(row.stats.mean[0])} G {fmt(row.stats.mean[1])} B{' '}
                    {fmt(row.stats.mean[2])}
                  </span>
                ) : null}
              </div>
              <div className="scope-canvases">
                {kinds.map((k) => (
                  <figure className="scope-fig" key={k}>
                    <canvas ref={setCanvas(key, k)} className={`scope-canvas scope-${k}`} />
                    <figcaption>{SCOPE_LABEL[k]}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))}

          {precise ? (
            <div className="scope-row precise">
              <div className="scope-row-label">
                <span>정밀</span>
                <span className="scope-badge final">최종 렌더 기준</span>
                <span className="dim">
                  {(precise.timeMs / 1000).toFixed(2)}s · rev {precise.revision}
                  {precise.cached ? ' · 캐시' : ''}
                </span>
                {delta ? (
                  <span className={`scope-nums ${delta.max > 8 ? 'warn' : 'dim'}`}>
                    미리보기와 차이 ΔY {fmt(delta.dY)} · ΔR {fmt(delta.dR)} ΔG {fmt(delta.dG)} ΔB{' '}
                    {fmt(delta.dB)} (0~255 눈금)
                  </span>
                ) : null}
              </div>
              <div className="scope-canvases">
                {SCOPE_KINDS.filter((k) => precise.urls[k]).map((k) => (
                  <figure className="scope-fig" key={k}>
                    <img className={`scope-canvas scope-${k}`} src={precise.urls[k]} alt={SCOPE_LABEL[k]} />
                    <figcaption>{SCOPE_LABEL[k]}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ) : null}

          {preciseError ? <div className="error-text">{preciseError}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
