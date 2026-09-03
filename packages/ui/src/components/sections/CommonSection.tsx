// 공통 섹션: 시작·길이 표시 + 위치/크기/회전/반전/크롭/불투명도 (오디오는 시작·길이만)
// + W5: video 클립에 정지화면(freezeFrame) 버튼 — 플레이헤드 위치에서 정지 클립을 끼운다.
import { useState } from 'react';
import type { Clip, Crop, Transform } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import { DEFAULT_CROP, DEFAULT_TRANSFORM, formatMs } from './inspector-utils.js';
import { BareNumber, CheckField, NumberField, Row, Section, SliderField } from './fields.js';

type Props = {
  clip: Clip;
  patch: (p: Record<string, unknown>) => void;
  playheadMs?: number;
  dispatch?: (cmds: Command[]) => Promise<void>;
};

const DEFAULT_FREEZE_MS = 1000;

export function CommonSection({ clip, patch, playheadMs, dispatch }: Props) {
  const timeInfo = (
    <>
      <Row label="시작">
        <span className="insp-static">{formatMs(clip.start)}</span>
      </Row>
      <Row label="길이">
        <span className="insp-static">{formatMs(clip.duration)}</span>
      </Row>
    </>
  );

  if (clip.kind === 'audio') {
    return <Section title="기본">{timeInfo}</Section>;
  }

  const tr: Transform = clip.transform ?? DEFAULT_TRANSFORM;
  const crop: Crop = clip.crop ?? DEFAULT_CROP;
  const setTr = <K extends keyof Transform>(k: K, v: Transform[K]) =>
    patch({ transform: { ...tr, [k]: v } });
  const setCrop = <K extends keyof Crop>(k: K, v: Crop[K]) => patch({ crop: { ...crop, [k]: v } });

  return (
    <Section title="기본">
      {timeInfo}
      {clip.kind === 'video' && (clip.freeze === true || clip.loop === true) ? (
        <Row label="종류">
          <span className="insp-badge insp-badge-inline">
            {clip.freeze === true ? '정지화면 클립' : '반복(루프) 클립'}
          </span>
        </Row>
      ) : null}
      {clip.kind === 'video' && clip.freeze !== true && clip.loop !== true && dispatch ? (
        <FreezeRow
          clipId={clip.id}
          start={clip.start}
          end={clip.start + clip.duration}
          hasRamp={!!clip.speedRamp}
          playheadMs={playheadMs ?? 0}
          dispatch={dispatch}
        />
      ) : null}
      <SliderField label="X 위치" value={tr.x} min={-1} max={1} kfPath="x" onCommit={(v) => setTr('x', v)} />
      <SliderField label="Y 위치" value={tr.y} min={-1} max={1} kfPath="y" onCommit={(v) => setTr('y', v)} />
      <SliderField
        label="크기"
        value={tr.scale}
        min={0}
        max={4}
        kfPath="scale"
        onCommit={(v) => setTr('scale', v)}
      />
      <SliderField
        label="회전"
        value={tr.rotation}
        min={-180}
        max={180}
        step={1}
        digits={0}
        kfPath="rotation"
        onCommit={(v) => setTr('rotation', v)}
      />
      <CheckField
        label="좌우 반전"
        checked={tr.flipH ?? false}
        onCommit={(v) => setTr('flipH', v)}
      />
      <CheckField
        label="상하 반전"
        checked={tr.flipV ?? false}
        onCommit={(v) => setTr('flipV', v)}
      />
      <SliderField
        label="불투명도"
        value={clip.opacity ?? 1}
        min={0}
        max={1}
        kfPath="opacity"
        onCommit={(v) => patch({ opacity: v })}
      />
      {/* 크롭은 text 클립에선 키프레임 대상이 아니다(그려지지 않는다) — ◆ 가 회색으로 이유를 말해 준다 */}
      <NumberField label="크롭 X" value={crop.x} min={0} max={1} step={0.01} kfPath="crop.x" onCommit={(v) => setCrop('x', v)} />
      <NumberField label="크롭 Y" value={crop.y} min={0} max={1} step={0.01} kfPath="crop.y" onCommit={(v) => setCrop('y', v)} />
      <NumberField label="크롭 너비" value={crop.w} min={0.01} max={1} step={0.01} kfPath="crop.w" onCommit={(v) => setCrop('w', v)} />
      <NumberField label="크롭 높이" value={crop.h} min={0.01} max={1} step={0.01} kfPath="crop.h" onCommit={(v) => setCrop('h', v)} />
    </Section>
  );
}

/** 정지화면 — 플레이헤드가 클립 내부에 있어야 한다(엔진도 같은 조건으로 거부한다). */
function FreezeRow({
  clipId,
  start,
  end,
  hasRamp,
  playheadMs,
  dispatch,
}: {
  clipId: string;
  start: number;
  end: number;
  hasRamp: boolean;
  playheadMs: number;
  dispatch: (cmds: Command[]) => Promise<void>;
}) {
  const [ms, setMs] = useState(DEFAULT_FREEZE_MS);
  const at = Math.round(playheadMs);
  const inside = at > start && at < end;
  const disabled = !inside || hasRamp || ms <= 0;
  const why = hasRamp
    ? '속도 램프가 걸린 클립에는 정지화면을 만들 수 없습니다'
    : !inside
      ? '재생 위치를 이 클립 안으로 옮기세요'
      : `${formatMs(at)} 에서 정지화면 ${ms}ms 를 끼웁니다`;

  // 버튼이 들어가므로 <label>(Row) 대신 div — 라벨 클릭이 버튼으로 전달되지 않게 한다
  return (
    <div className="insp-row">
      <span className="insp-label">정지화면</span>
      <span className="insp-control">
        <BareNumber value={ms} min={1} max={60000} step={100} onCommit={setMs} title="정지 길이(ms)" />
        <span className="insp-suffix">ms</span>
        <button
          type="button"
          className="insp-btn"
          disabled={disabled}
          title={why}
          onClick={() => {
            void dispatch([{ type: 'freezeFrame', clipId, at, duration: Math.round(ms) }]);
          }}
        >
          만들기
        </button>
      </span>
    </div>
  );
}
