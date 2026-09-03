// 비디오 섹션: 속도·역재생·볼륨·페이드·블렌드·크로마키·마스크
// + W8 F9 자유 마스크 — 모양 'path' · 여러 장 겹치기 · 반전 · 펜 툴 열기
// + W8 F10 마스크 모션 트래킹 — 「추적」 · 실패 구간 띠 · 「여기서 다시 추적」
import { useState } from 'react';
import type { ChromaKey, Mask, VideoClip } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import { ApiError, trackMask, type JobInfo, type TrackReport } from '../../api.js';
import { useEditor } from '../../state.js';
import {
  BLEND_OPTIONS,
  clipMasks,
  defaultChromaKey,
  defaultMask,
  defaultPathMask,
  MASK_OP_OPTIONS,
  MASK_SHAPE_OPTIONS,
  masksPatch,
  maskShapeLocked,
} from './inspector-utils.js';
import type { BlendMode } from './inspector-utils.js';
import { openMaskEditor } from './MaskEditor.js';
import { CheckField, ColorField, NumberField, Row, Section, SelectField, SliderField } from './fields.js';

type Props = {
  clip: VideoClip;
  patch: (p: Record<string, unknown>) => void;
  dispatch: (cmds: Command[]) => Promise<void>;
};

export function VideoSection({ clip, patch, dispatch }: Props) {
  const chromaKey = clip.chromaKey;
  const masks = clipMasks(clip);

  return (
    <Section title="비디오">
      {/* 속도에는 키프레임을 걸 수 없다 — ◆ 가 회색으로 이유를 말해 준다(길이 불변식을 깬다).
          시간에 따라 속도를 바꾸려면 아래 「속도 램프」를 쓴다. */}
      <NumberField
        label="속도"
        value={clip.speed}
        min={0.1}
        max={100}
        step={0.1}
        suffix="배"
        kfPath="speed"
        onCommit={(v) => {
          void dispatch([{ type: 'setClipSpeed', clipId: clip.id, speed: v }]);
        }}
      />
      <CheckField
        label="역재생"
        checked={clip.reversed ?? false}
        onCommit={(v) => {
          void dispatch([{ type: 'setReversed', clipId: clip.id, reversed: v }]);
        }}
      />
      <SliderField
        label="볼륨"
        value={clip.volume}
        min={0}
        max={2}
        kfPath="volume"
        onCommit={(v) => patch({ volume: v })}
      />
      <NumberField
        label="페이드 인"
        value={clip.fadeIn ?? 0}
        min={0}
        step={100}
        suffix="ms"
        onCommit={(v) => patch({ fadeIn: v > 0 ? v : null })}
      />
      <NumberField
        label="페이드 아웃"
        value={clip.fadeOut ?? 0}
        min={0}
        step={100}
        suffix="ms"
        onCommit={(v) => patch({ fadeOut: v > 0 ? v : null })}
      />
      <SelectField
        label="블렌드"
        value={clip.blendMode ?? 'normal'}
        options={BLEND_OPTIONS}
        onCommit={(v) => patch({ blendMode: v === 'normal' ? null : (v as BlendMode) })}
      />
      <CheckField
        label="크로마키 사용"
        checked={!!chromaKey}
        onCommit={(v) => patch({ chromaKey: v ? defaultChromaKey() : null })}
      />
      {chromaKey ? (
        <ChromaKeyFields ck={chromaKey} onPatch={(ck) => patch({ chromaKey: ck })} />
      ) : null}
      <CheckField
        label="마스크 사용"
        checked={masks.length > 0}
        onCommit={(v) => patch(masksPatch(v ? [defaultMask()] : []))}
      />
      {masks.map((m, i) => (
        <MaskFields
          key={i}
          mask={m}
          index={i}
          count={masks.length}
          clipId={clip.id}
          onPatch={(next) => patch(masksPatch(masks.map((x, k) => (k === i ? next : x))))}
          onRemove={() => patch(masksPatch(masks.filter((_, k) => k !== i)))}
        />
      ))}
      {masks.length === 1 ? <MaskTracking clip={clip} mask={masks[0]!} /> : null}
      {masks.length > 0 && masks.length < 8 ? (
        <Row label="마스크 추가">
          <button
            type="button"
            className="btn"
            onClick={() => patch(masksPatch([...masks, defaultPathMask()]))}
          >
            + 자유 곡선
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => patch(masksPatch([...masks, defaultMask()]))}
          >
            + 사각형
          </button>
        </Row>
      ) : null}
    </Section>
  );
}

// ── F10 마스크 모션 트래킹 ────────────────────────────────────────────────

/** 이 클립의 추적 잡 하나 (가장 최근 것). */
export function trackJobOf(jobs: Record<string, JobInfo>, clipId: string): JobInfo | undefined {
  let found: JobInfo | undefined;
  for (const job of Object.values(jobs)) {
    if (job.type === 'track' && job.key === `${clipId}:track`) found = job;
  }
  return found;
}

/** 클립 기준 ms 가 실패 구간 안에 있으면 그 구간. */
export function gapAt(
  gaps: readonly { startMs: number; endMs: number }[] | undefined,
  tMs: number,
): { startMs: number; endMs: number } | undefined {
  return gaps?.find((g) => tMs >= g.startMs && tMs <= g.endMs);
}

export type TrackAction = {
  key: 'fromStart' | 'fromHere' | 'bothWays';
  label: string;
  title: string;
  /** 기준 프레임 — 클립 기준 ms */
  startMs: number;
  direction: 'forward' | 'both';
  /** 재생헤드 위치 때문에 지금 누를 수 없는가 (추적 중인지는 별개다) */
  disabled: boolean;
};

/**
 * 추적 버튼 세 개.
 *
 * **기존 두 개의 뜻은 바꾸지 않고 세 번째를 더했다.** 「여기서 다시 추적」은
 * 「앞쪽 키프레임은 그대로 둡니다」라고 약속한다 — 그 버튼을 조용히 양방향으로 바꾸면
 * 이미 만들어 둔 앞쪽 결과를 지운다. 사용자가 클립 «중간»에서 대상을 찾는 일이 흔하므로
 * (그 지점에서 대상이 제일 잘 보인다) 양방향은 눈에 보이는 버튼으로 따로 낸다.
 *
 * 재생헤드가 클립 처음(0)이면 뒤의 둘은 눌러 봐야 「처음부터 추적」과 같으므로 잠근다.
 */
export function trackActions(atMs: number): TrackAction[] {
  return [
    {
      key: 'fromStart',
      label: '처음부터 추적',
      title: '클립 처음을 기준으로 끝까지 추적합니다.',
      startMs: 0,
      direction: 'forward',
      disabled: false,
    },
    {
      key: 'fromHere',
      label: '여기서 다시 추적',
      title:
        '지금 마스크를 놓은 자리를 새 기준으로 삼아 이 시각 «이후만» 다시 추적합니다. 앞쪽 키프레임은 그대로 둡니다.',
      startMs: atMs,
      direction: 'forward',
      disabled: atMs <= 0,
    },
    {
      key: 'bothWays',
      label: '여기서 앞뒤로 추적',
      title:
        '지금 마스크를 놓은 자리를 기준으로 «앞쪽과 뒤쪽을 한 번에» 추적합니다. 대상이 제일 잘 보이는 프레임에서 누르세요 — 이 구간의 앞쪽 키프레임도 새로 만듭니다.',
      startMs: atMs,
      direction: 'both',
      disabled: atMs <= 0,
    },
  ];
}

/** 「정밀 ↔ 가벼움」 슬라이더 눈금 — 실측표(track.ts DEFAULT_TOLERANCE_PX 주석)에서 뽑았다. */
const TOLERANCE_STEPS = [1, 2, 4, 6, 10] as const;

/**
 * 추적 결과 띠. 초록 = 추적됨(진하기 = 점수), 빨강 = 놓침. 누르면 그 시각으로 재생헤드가 간다.
 *
 * **실패 구간은 비워 둔다.** 앞뒤를 이어 보간하면 마스크가 대상을 스르르 지나가면서
 * 「추적된 것처럼」 보인다 — 그러면 사용자는 렌더를 다 돌린 뒤에야 안다.
 */
function TrackBand({
  report,
  durationMs,
  clipStart,
  onSeek,
}: {
  report: TrackReport;
  durationMs: number;
  clipStart: number;
  onSeek: (absMs: number) => void;
}) {
  if (durationMs <= 0 || report.scores.length === 0) return null;
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / durationMs) * 100))}%`;
  return (
    <div
      style={{ position: 'relative', height: 14, borderRadius: 3, overflow: 'hidden', background: '#2a2a2a', cursor: 'pointer' }}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(clipStart + ((e.clientX - r.left) / Math.max(1, r.width)) * durationMs);
      }}
    >
      {report.scores.map((s, i) => {
        const next = report.scores[i + 1];
        const w = (next ? next.t : durationMs) - s.t;
        // 진하기 = 점수 (0.3~1.0 을 밝기로) — 「위태로운 구간」이 눈에 보인다
        const lum = Math.round(28 + Math.max(0, Math.min(1, (s.s - 0.3) / 0.7)) * 42);
        return (
          <div
            key={s.t}
            style={{
              position: 'absolute',
              left: pct(s.t),
              width: pct(Math.max(1, w)),
              top: 0,
              bottom: 0,
              background: s.ok ? `hsl(140 55% ${lum}%)` : '#c0392b',
            }}
          />
        );
      })}
    </div>
  );
}

function MaskTracking({ clip, mask }: { clip: VideoClip; mask: Mask }) {
  const projectId = useEditor((s) => s.projectId);
  const jobs = useEditor((s) => s.jobs);
  const playheadMs = useEditor((s) => s.playheadMs);
  const seek = useEditor((s) => s.seek);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tolerancePx, setTolerancePx] = useState<number>(4);

  const job = trackJobOf(jobs, clip.id);
  const running = busy || job?.status === 'queued' || job?.status === 'running';
  const report = job?.status === 'done' ? (job.result as unknown as TrackReport | undefined) : undefined;
  // 재생헤드의 클립 기준 위치. 클립 밖이면 처음부터.
  const atMs = Math.max(0, Math.min(clip.duration, Math.round(playheadMs - clip.start)));
  const inGap = gapAt(report?.gaps, atMs);

  const run = async (startMs: number, direction: 'forward' | 'both' = 'forward') => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      // 시작 상자는 **지금 마스크가 놓인 자리**다 — 사용자가 눈으로 맞춘 위치가 곧 기준이다.
      await trackMask(projectId, clip.id, {
        box: { x: mask.x, y: mask.y, w: mask.w, h: mask.h },
        startMs,
        direction,
        tolerancePx,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row label="마스크 추적">
        {trackActions(atMs).map((a) => (
          <button
            key={a.key}
            type="button"
            className="btn"
            disabled={running || a.disabled}
            title={a.title}
            onClick={() => void run(a.startMs, a.direction)}
          >
            {running && a.key === 'fromStart' ? '추적 중…' : a.label}
          </button>
        ))}
      </Row>
      <Row label="키프레임 정밀도">
        <input
          type="range"
          min={0}
          max={TOLERANCE_STEPS.length - 1}
          step={1}
          value={TOLERANCE_STEPS.indexOf(tolerancePx as (typeof TOLERANCE_STEPS)[number])}
          onChange={(e) => setTolerancePx(TOLERANCE_STEPS[Number(e.target.value)]!)}
        />
        <span className="insp-value">{tolerancePx}px — {tolerancePx <= 2 ? '정밀' : tolerancePx >= 6 ? '가벼움' : '기본'}</span>
      </Row>
      {running ? (
        <Row label="진행">
          <span className="insp-value">
            {job?.detail ?? `${Math.round((job?.progress ?? 0) * 100)}%`}
          </span>
        </Row>
      ) : null}
      {error ? (
        <Row label="">
          <span className="insp-badge">{error}</span>
        </Row>
      ) : null}
      {job?.status === 'error' ? (
        <Row label="">
          <span className="insp-badge">{job.error}</span>
        </Row>
      ) : null}
      {report ? (
        <>
          <Row label="결과">
            <span className="insp-note">
              {report.tracked}/{report.frames} 프레임 추적 · 키프레임 {report.before * 4}개를{' '}
              {report.keyframes}개로 줄였습니다 ({Math.round(report.reduction * 100)}% 감소, 최대 편차{' '}
              {report.maxDeviationPx}px)
            </span>
          </Row>
          <Row label="추적 띠">
            <TrackBand
              report={report}
              durationMs={clip.duration}
              clipStart={clip.start}
              onSeek={seek}
            />
          </Row>
          {report.gaps.length > 0 ? (
            <Row label="놓친 구간">
              <span className="insp-badge" style={{ background: '#c0392b' }}>
                {report.gaps.length}곳
              </span>
              {report.gaps.slice(0, 4).map((g) => (
                <button
                  key={g.startMs}
                  type="button"
                  className="btn"
                  title={`${Math.round((g.startMs / 1000) * report.fps)}번째 프레임부터 대상을 놓쳤습니다`}
                  onClick={() => seek(clip.start + g.startMs)}
                >
                  {(g.startMs / 1000).toFixed(1)}s
                </button>
              ))}
            </Row>
          ) : null}
          {inGap ? (
            <Row label="">
              <span className="insp-note" style={{ color: '#ffd45e' }}>
                여기는 놓친 구간입니다 — 마스크를 대상 위로 옮긴 뒤 「여기서 다시 추적」을 누르세요.
              </span>
            </Row>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function ChromaKeyFields({ ck, onPatch }: { ck: ChromaKey; onPatch: (ck: ChromaKey) => void }) {
  return (
    <>
      <ColorField label="키 색상" value={ck.color} onCommit={(v) => onPatch({ ...ck, color: v })} />
      <SliderField
        label="유사도"
        value={ck.similarity}
        min={0}
        max={1}
        kfPath="chromaKey.similarity"
        onCommit={(v) => onPatch({ ...ck, similarity: v })}
      />
      <SliderField
        label="부드러움"
        value={ck.smoothness}
        min={0}
        max={1}
        kfPath="chromaKey.smoothness"
        onCommit={(v) => onPatch({ ...ck, smoothness: v })}
      />
      <SliderField
        label="물듦 제거"
        value={ck.spill ?? 0.5}
        min={0}
        max={1}
        kfPath="chromaKey.spill"
        onCommit={(v) => onPatch({ ...ck, spill: v })}
      />
    </>
  );
}

/**
 * 마스크 한 장. 여러 장일 때는 키프레임 ◆ 를 붙이지 않는다 — `mask.x` 경로는 «한 장짜리»
 * 를 가리키는 이름이라, 두 장째부터는 걸 수 있는 것처럼 보이면 안 된다(엔진이 거부한다).
 * 트래킹(F10)이 붙는 자리도 이 x/y/w/h 다 — 자유 곡선이어도 «모양은 d, 위치는 상자» 라서
 * 여기 키프레임을 걸면 그린 모양이 대상을 따라 움직인다.
 */
export function MaskFields({
  mask,
  index,
  count,
  clipId,
  onPatch,
  onRemove,
}: {
  mask: Mask;
  index: number;
  count: number;
  clipId: string;
  onPatch: (m: Mask) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof Mask>(k: K, v: Mask[K]) => onPatch({ ...mask, [k]: v });
  const kf = (path: string): string | undefined => (count === 1 ? path : undefined);
  const locked = maskShapeLocked(mask);
  return (
    <>
      {count > 1 ? (
        <Row label={`마스크 ${index + 1}`}>
          {index > 0 ? (
            <SelectField
              label=""
              value={mask.op ?? 'add'}
              options={MASK_OP_OPTIONS}
              onCommit={(v) => set('op', v as Mask['op'])}
            />
          ) : (
            <span className="insp-value">기준</span>
          )}
          <button type="button" className="btn" onClick={onRemove}>
            삭제
          </button>
        </Row>
      ) : null}
      <SelectField
        label="마스크 모양"
        value={mask.shape}
        options={MASK_SHAPE_OPTIONS}
        onCommit={(v) => {
          const shape = v as Mask['shape'];
          // 'path' 로 바꾸면 그릴 것이 있어야 한다 — 기본 원을 넣어 준다.
          if (shape === 'path' && !mask.d) onPatch({ ...defaultPathMask(), ...mask, shape });
          else onPatch({ ...mask, shape });
        }}
      />
      {mask.shape === 'path' ? (
        <Row label="모양">
          <button type="button" className="btn" onClick={() => openMaskEditor(clipId, index)}>
            모양 그리기 (펜)
          </button>
          {locked ? (
            <span className="insp-value" style={{ color: '#ffd45e' }}>
              모양 키프레임 {mask.dKeys?.length}개 — 점 추가·삭제 잠김
            </span>
          ) : null}
        </Row>
      ) : null}
      <SliderField
        label="가장자리"
        value={mask.feather}
        min={0}
        max={1}
        kfPath={kf('mask.feather')}
        onCommit={(v) => set('feather', v)}
      />
      <CheckField label="마스크 반전" checked={mask.invert ?? false} onCommit={(v) => set('invert', v)} />
      <NumberField label="마스크 X" value={mask.x} min={0} max={1} step={0.01} kfPath={kf('mask.x')} onCommit={(v) => set('x', v)} />
      <NumberField label="마스크 Y" value={mask.y} min={0} max={1} step={0.01} kfPath={kf('mask.y')} onCommit={(v) => set('y', v)} />
      <NumberField label="마스크 너비" value={mask.w} min={0.01} max={1} step={0.01} kfPath={kf('mask.w')} onCommit={(v) => set('w', v)} />
      <NumberField label="마스크 높이" value={mask.h} min={0.01} max={1} step={0.01} kfPath={kf('mask.h')} onCommit={(v) => set('h', v)} />
    </>
  );
}
