// W8 F4 — 컷별 색 맞추기. 기준 컷을 고르고 강도·비교 영역을 정한 뒤 「색 재기」를 누른다.
//
// 측정은 서버 잡(matchStats)이 한다. 측정이 끝나 levels 가 문서에 들어가면 sourceKey 가 바뀌고
// 기존 파생 스케줄러가 알아서 굽는다 — 여기서 굽기를 직접 부르지 않는다.
import { useState } from 'react';
import type { Asset, Clip, ClipSource, Crop, ProjectDoc, VideoClip } from '@kitkat/schema';
import { findClip } from '@kitkat/engine';
import { measureMatch, type JobInfo, type MatchReport } from '../../api.js';
import { useEditor } from '../../state.js';
import { Row, SliderField } from './fields.js';
import { FramePicker } from './FramePicker.js';
import {
  matchCandidates,
  matchState,
  MATCH_STATE_LABELS,
  normalizeClipSource,
  type MatchState,
} from './inspector-utils.js';

type Props = {
  clip: VideoClip;
  patch: (p: Record<string, unknown>) => void;
};

const NONE = '__none__';

/** 파생 인코딩 실측 대략치 — 1080×1920 30초 클립 하나에 25초 (W5 파생 잡 측정값). */
const BAKE_SEC_PER_CLIP = 25;

/** 이 클립의 측정 잡 하나 (가장 최근 것). */
function matchJobOf(jobs: Record<string, JobInfo>, clipId: string): JobInfo | undefined {
  let found: JobInfo | undefined;
  for (const job of Object.values(jobs)) {
    if (job.type !== 'matchStats' || job.key !== `${clipId}:match`) continue;
    found = job;
  }
  return found;
}

function badgeClass(state: MatchState): string {
  return state === 'ready' ? 'insp-note' : 'insp-badge';
}

export function MatchSection({ clip, patch }: Props) {
  const doc = useEditor((s) => s.doc);
  const projectId = useEditor((s) => s.projectId);
  const jobs = useEditor((s) => s.jobs);
  const dispatch = useEditor((s) => s.dispatch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<Record<string, boolean>>({});
  const [batchNote, setBatchNote] = useState<string | null>(null);

  const source = (clip.source ?? {}) as ClipSource;
  const match = source.matchTo;
  const candidates = doc ? matchCandidates(doc, clip.id) : [];
  const refClip: Clip | undefined = doc && match ? findClip(doc, match.clipId)?.clip : undefined;
  const state = matchState(clip, refClip, doc?.assets ?? {});
  const job = matchJobOf(jobs, clip.id);
  const measuring = busy || job?.status === 'queued' || job?.status === 'running';
  const report = job?.status === 'done' ? (job.result as unknown as MatchReport | undefined) : undefined;

  const setSource = (next: ClipSource) => patch({ source: normalizeClipSource(next) });

  const setRef = (clipId: string) => {
    setError(null);
    if (clipId === NONE) {
      const { matchTo: _drop, ...rest } = source;
      setSource(rest);
      return;
    }
    setSource({ ...source, matchTo: { clipId, strength: match?.strength ?? 1 } });
  };

  /** 측정 요청. 서버가 「이미 잰 값이 유효하다」고 하면 잡 없이 끝난다. */
  const measure = async (targetClipId: string, body: Parameters<typeof measureMatch>[2]) => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      await measureMatch(projectId, targetClipId, body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runMeasure = () => {
    if (!match) return;
    void measure(clip.id, {
      refClipId: match.clipId,
      strength: match.strength,
      ...(match.region ? { region: match.region } : {}),
      ...(match.refRegion ? { refRegion: match.refRegion } : {}),
    });
  };

  /** 다른 컷들을 «이 컷의 기준» 에 함께 맞춘다. 굽는 시간을 먼저 알리고 묻는다. */
  const applyToSelected = async () => {
    if (!match || !projectId || !doc) return;
    const ids = Object.entries(batch).filter(([, on]) => on).map(([id]) => id);
    if (ids.length === 0) return;
    const sec = ids.length * BAKE_SEC_PER_CLIP;
    const mins = Math.max(1, Math.round(sec / 60));
    const ok = window.confirm(
      `${ids.length}개 컷을 다시 굽습니다 — 약 ${mins}분 걸립니다.\n계속할까요?`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    let failed = 0;
    for (const id of ids) {
      try {
        // 먼저 문서에 matchTo 를 걸어 두면(levels 없이) 인스펙터가 「측정 중」을 바로 보여준다.
        const target = findClip(doc, id)?.clip;
        if (target && target.kind === 'video') {
          const next = normalizeClipSource({
            ...((target.source ?? {}) as ClipSource),
            matchTo: {
              clipId: match.clipId,
              strength: match.strength,
              ...(match.refRegion ? { refRegion: match.refRegion } : {}),
            },
          });
          await dispatch([{ type: 'updateClip', clipId: id, patch: { source: next } }]);
        }
        await measureMatch(projectId, id, {
          refClipId: match.clipId,
          strength: match.strength,
          ...(match.refRegion ? { refRegion: match.refRegion } : {}),
        });
      } catch {
        failed++;
      }
    }
    setBusy(false);
    setBatch({});
    setBatchNote(
      failed === 0
        ? `${ids.length}개 컷에 걸었습니다 — 측정이 끝나는 대로 하나씩 구워집니다.`
        : `${ids.length - failed}개는 걸었고 ${failed}개는 실패했습니다.`,
    );
  };

  // 기준은 video·image 클립뿐이라 assetId 가 있다 (matchCandidates 가 그렇게 거른다).
  const refAsset: Asset | undefined =
    refClip && (refClip.kind === 'video' || refClip.kind === 'image')
      ? doc?.assets[refClip.assetId]
      : undefined;
  const targetAsset = doc?.assets[clip.assetId];

  const setRegion = (key: 'region' | 'refRegion') => (r: Crop | undefined) => {
    if (!match) return;
    const next = { ...match };
    if (r) next[key] = r;
    else delete next[key];
    setSource({ ...source, matchTo: next });
  };

  return (
    <>
      <Row label="기준 컷">
        <select
          className="insp-select"
          value={match?.clipId ?? NONE}
          onChange={(e) => setRef(e.target.value)}
        >
          <option value={NONE}>맞추지 않음</option>
          {candidates.map((c) => (
            <option key={c.clip.id} value={c.clip.id}>
              {c.label}
            </option>
          ))}
        </select>
      </Row>
      {candidates.length === 0 ? (
        <p className="insp-note">맞출 기준이 되려면 다른 비디오·이미지 클립이 하나 더 있어야 합니다.</p>
      ) : null}

      {match ? (
        <>
          <SliderField
            label="강도"
            value={match.strength}
            min={0}
            max={1}
            onCommit={(v) => setSource({ ...source, matchTo: { ...match, strength: v } })}
          />
          <p className="insp-note">
            강도 0.5 는 «정확히 절반만» 맞춥니다 (아핀 사상이라 보간이 선형입니다).
          </p>

          <div className="insp-frame-row">
            <FramePicker
              label="대상 영역"
              asset={targetAsset}
              {...(match.region ? { region: match.region } : {})}
              onRegion={setRegion('region')}
            />
            <FramePicker
              label="기준 영역"
              asset={refAsset}
              {...(match.refRegion ? { region: match.refRegion } : {})}
              onRegion={setRegion('refRegion')}
            />
          </div>
          <p className="insp-note">
            드래그해서 비교할 영역을 지정합니다(피부는 두 컷에서 다른 자리에 있으니 따로 그립니다).
            짧게 클릭하면 화면 전체로 되돌아갑니다. 지정 안 하면 클립의 crop, 그것도 없으면 전체를 잽니다.
          </p>

          <div className="insp-add-row">
            <button className="insp-btn" type="button" disabled={measuring} onClick={runMeasure}>
              {measuring ? '재는 중…' : state === 'stale' ? '다시 재기' : '색 재기'}
            </button>
            {match.levels ? (
              <span className="insp-static">
                {match.levels.sampledAtMs.length}장 측정 · 기준 {match.levels.refSourceKey === 'raw' ? '원본' : '보정본'}
              </span>
            ) : null}
          </div>

          {source.stabilize ? (
            <p className="insp-note">
              손떨림 보정이 함께 걸려 있습니다 — 색은 «보정된 화면»에서 잽니다. 보정 강도를 바꾸면
              화면이 달라지니 색도 다시 재세요.
            </p>
          ) : null}
          {state !== 'off' && state !== 'ready' ? (
            <p className={badgeClass(state)}>{MATCH_STATE_LABELS[state]}</p>
          ) : null}
          {state === 'ready' ? <p className="insp-note">{MATCH_STATE_LABELS.ready}</p> : null}

          {job?.status === 'error' ? (
            <>
              <p className="insp-badge">{job.error}</p>
              {/* 「강도를 N% 이하로 낮추면 표현됩니다」 → 그 값으로 바꿔 다시 재는 버튼.
                  숫자를 읽고 사용자가 직접 슬라이더를 맞추게 두지 않는다. */}
              {(() => {
                const pct = /강도를 (\d+)% 이하로/.exec(job.error ?? '')?.[1];
                if (!pct) return null;
                const s = Number(pct) / 100;
                return (
                  <button
                    className="insp-btn"
                    type="button"
                    disabled={measuring}
                    onClick={() => {
                      setSource({ ...source, matchTo: { ...match, strength: s } });
                      void measure(clip.id, {
                        refClipId: match.clipId,
                        strength: s,
                        ...(match.region ? { region: match.region } : {}),
                        ...(match.refRegion ? { refRegion: match.refRegion } : {}),
                      });
                    }}
                  >
                    강도 {pct}% 로 낮추고 다시 재기
                  </button>
                );
              })()}
            </>
          ) : null}
          {error ? <p className="insp-badge">{error}</p> : null}

          {report ? (
            <>
              <p className="insp-note">
                마지막 측정:{' '}
                {['R', 'G', 'B'].map((ch, i) => (
                  <span key={ch}>
                    {i > 0 ? ' · ' : ''}
                    {ch} {report.channels[i]?.before.toFixed(1)}→{report.channels[i]?.after.toFixed(1)}
                  </span>
                ))}{' '}
                (합계 {report.deltaBefore.toFixed(1)}→{report.deltaAfter.toFixed(1)},{' '}
                {(report.reduction * 100).toFixed(0)}% 감소)
              </p>
              {report.clippedAfter.low + report.clippedAfter.high -
                (report.clippedBefore.low + report.clippedBefore.high) >
              0.05 ? (
                <p className="insp-badge">
                  밝은 곳 {((report.clippedAfter.high - report.clippedBefore.high) * 100).toFixed(1)}% ·
                  어두운 곳 {((report.clippedAfter.low - report.clippedBefore.low) * 100).toFixed(1)}%가
                  뭉갰습니다 — 강도를 낮추거나 영역을 지정하세요.
                </p>
              ) : null}
            </>
          ) : null}

          {candidates.length > 0 ? (
            <>
              <p className="insp-label" style={{ marginTop: 6 }}>
                같은 기준에 맞출 다른 컷
              </p>
              <div className="insp-batch">
                {candidates
                  .filter((c) => c.clip.id !== match.clipId && c.clip.kind === 'video')
                  .map((c) => (
                    <label key={c.clip.id} className="insp-batch-row">
                      <input
                        type="checkbox"
                        className="insp-check"
                        checked={batch[c.clip.id] === true}
                        onChange={(e) => setBatch({ ...batch, [c.clip.id]: e.target.checked })}
                      />
                      <span>{c.label}</span>
                    </label>
                  ))}
              </div>
              <button
                className="insp-btn"
                type="button"
                disabled={busy || Object.values(batch).every((v) => !v)}
                onClick={() => void applyToSelected()}
              >
                선택한 컷들에 적용
              </button>
              {batchNote ? <p className="insp-note">{batchNote}</p> : null}
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
