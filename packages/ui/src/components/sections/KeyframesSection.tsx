// 키프레임 섹션 (W8 F13 + F7) — **경로별로 묶어서** 보여 준다.
//
// 예전에는 평평한 행 목록이었고 행마다 prop <select> 가 붙어 있었다. 걸 수 있는 경로가
// 6개에서 40개로 늘면 그 방식은 못 쓴다. 세 가지를 바꿨다.
//  1) 한 그룹 = 한 경로. 헤더에 한국어 라벨·개수·「전부 삭제」. 행마다 prop 을 바꾸는 것은
//     실수를 부르므로(값의 «의미»가 달라지는데 값은 그대로 남는다) 없앴다.
//  2) 그룹마다 미니 타임라인 한 줄 — 드래그로 시간 이동, 더블클릭으로 삭제.
//     마스크 트래킹(F10)이 만들 수백 개의 키프레임은 표로는 다룰 수 없다.
//  3) 「추가」 드롭다운을 KEYFRAME_PATHS 에서 만든다(그 클립에 실제로 있는 효과만 펼친다).
import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { EASING_PRESETS, keyframePathDef } from '@kitkat/schema';
import type { Clip, Easing, Keyframe } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import {
  easingLabel,
  easingPresetId,
  formatMs,
  groupClipKeyframes,
  keyframeDotState,
  keyframePathChoices,
  keyframeRatio,
  keyframeTimeFromRatio,
  removeKeyframeAt,
  removeKeyframePath,
  replaceKeyframe,
  toggleKeyframeAt,
} from './inspector-utils.js';
import type { KeyframeGroup } from './inspector-utils.js';
import { BareNumber, Section } from './fields.js';
import { EasingEditor } from './EasingEditor.js';

type Props = {
  clip: Clip;
  playheadMs: number;
  dispatch: (cmds: Command[]) => Promise<void>;
};

/** 이 개수를 넘으면 표를 접어 둔다(트래킹 결과처럼 수백 개일 때 인스펙터가 무너지지 않게). */
const AUTO_COLLAPSE = 8;

export function KeyframesSection({ clip, playheadMs, dispatch }: Props) {
  const kfs = clip.keyframes ?? [];
  const groups = groupClipKeyframes(clip);
  const choices = keyframePathChoices(clip);
  const first = choices[0]?.options[0]?.value ?? '';
  const [pick, setPick] = useState('');
  const known = choices.some((g) => g.options.some((o) => o.value === pick));
  const path = known ? pick : first;

  const [openTable, setOpenTable] = useState<Record<string, boolean>>({});
  const [openEasing, setOpenEasing] = useState<string | null>(null); // `${path}:${index}`

  const commit = (next: Keyframe[]) => {
    void dispatch([{ type: 'setKeyframes', clipId: clip.id, keyframes: next }]);
  };

  // 재생헤드에 «이미» 있으면 추가 버튼은 막는다 — 토글로 지워 버리면 놀란다(그건 ◆ 버튼의 일이다).
  const dot = path ? keyframeDotState(clip, path, playheadMs) : null;
  const canAdd = dot !== null && (dot.status === 'off' || dot.status === 'other');

  const add = () => {
    if (!canAdd) return;
    const next = toggleKeyframeAt(clip, path, playheadMs);
    if (next) commit(next);
  };

  return (
    <Section title="키프레임">
      <div className="insp-add-row">
        <select className="insp-select" value={path} onChange={(e) => setPick(e.target.value)}>
          {choices.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className="insp-btn"
          disabled={!canAdd}
          title={dot?.title ?? '걸 수 있는 값이 없습니다'}
          onClick={add}
        >
          추가
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="insp-empty">키프레임이 없습니다 — 값 옆의 ◇ 를 누르면 여기에 생깁니다</p>
      ) : null}

      {groups.map((g) => {
        const open = openTable[g.path] ?? g.items.length <= AUTO_COLLAPSE;
        const def = keyframePathDef(clip.kind, g.path);
        return (
          <div className="insp-kf-group" key={g.path}>
            <div className="insp-kf-group-head">
              <button
                type="button"
                className="insp-kf-fold"
                title={open ? '표 접기' : '표 펴기'}
                onClick={() => setOpenTable({ ...openTable, [g.path]: !open })}
              >
                {open ? '▾' : '▸'}
              </button>
              <span className="insp-kf-name" title={g.path}>
                {g.label}
              </span>
              {g.rejection ? (
                <span className="insp-kf-tag is-bad" title={g.rejection}>
                  쓸 수 없는 경로
                </span>
              ) : g.missing ? (
                <span
                  className="insp-kf-tag"
                  title="가리키는 값이 지금 없습니다 — 무동작입니다. 마스크·효과를 다시 켜면 살아 돌아옵니다."
                >
                  대상 없음
                </span>
              ) : null}
              <span className="insp-kf-count">{g.items.length}</span>
              <button
                type="button"
                className="insp-btn insp-del"
                title="이 값의 키프레임 전부 삭제"
                onClick={() => commit(removeKeyframePath(kfs, g.path))}
              >
                전부
              </button>
            </div>

            <KeyframeStrip
              clip={clip}
              group={g}
              playheadMs={playheadMs}
              onMove={(index, time) => commit(replaceKeyframe(kfs, index, { ...kfs[index]!, time }))}
              onDelete={(index) => commit(removeKeyframeAt(kfs, index))}
            />

            {open
              ? g.items.map((it, i) => {
                  const last = i === g.items.length - 1;
                  const key = `${g.path}:${it.index}`;
                  return (
                    <div key={key}>
                      <div className="insp-kf-row">
                        <BareNumber
                          className="insp-number insp-kf-num"
                          value={it.kf.time}
                          min={0}
                          max={clip.duration}
                          step={10}
                          title="시간(ms, 클립 시작 기준)"
                          onCommit={(v) =>
                            commit(
                              replaceKeyframe(kfs, it.index, {
                                ...it.kf,
                                time: Math.max(0, Math.min(clip.duration, Math.round(v))),
                              }),
                            )
                          }
                        />
                        <BareNumber
                          className="insp-number insp-kf-num"
                          value={it.kf.value}
                          min={def?.min}
                          max={def?.max}
                          step={0.01}
                          title="값"
                          onCommit={(v) => commit(replaceKeyframe(kfs, it.index, { ...it.kf, value: v }))}
                        />
                        <EasingSelect
                          easing={it.kf.easing}
                          disabled={last}
                          onCommit={(e) => commit(replaceKeyframe(kfs, it.index, { ...it.kf, easing: e }))}
                        />
                        <button
                          type="button"
                          className="insp-btn insp-kf-icon"
                          disabled={last}
                          title={
                            last
                              ? '마지막 키프레임 — 뒤에 구간이 없어 이징이 쓰이지 않습니다'
                              : '곡선 편집(베지어·스프링)'
                          }
                          onClick={() => setOpenEasing(openEasing === key ? null : key)}
                        >
                          ∿
                        </button>
                        <button
                          type="button"
                          className="insp-btn insp-del insp-kf-icon"
                          title="키프레임 삭제"
                          onClick={() => commit(removeKeyframeAt(kfs, it.index))}
                        >
                          ✕
                        </button>
                      </div>
                      {openEasing === key && !last ? (
                        <EasingEditor
                          easing={it.kf.easing}
                          onCommit={(e) => commit(replaceKeyframe(kfs, it.index, { ...it.kf, easing: e }))}
                          onClose={() => setOpenEasing(null)}
                        />
                      ) : null}
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
    </Section>
  );
}

const CUSTOM = '__custom';

/** 프리셋 12종 + (프리셋이 아니면) 「사용자 지정」. 고르면 그 프리셋이 출발점이 된다. */
function EasingSelect({
  easing,
  disabled,
  onCommit,
}: {
  easing: Easing;
  disabled: boolean;
  onCommit: (e: Easing) => void;
}) {
  const id = easingPresetId(easing);
  return (
    <select
      className="insp-select"
      value={id ?? CUSTOM}
      disabled={disabled}
      title={
        disabled
          ? '마지막 키프레임 — 뒤에 구간이 없어 이징이 쓰이지 않습니다'
          : `이 키프레임부터 다음 키프레임까지의 성격: ${easingLabel(easing)}`
      }
      onChange={(e) => {
        const p = EASING_PRESETS.find((x) => x.id === e.target.value);
        if (p) onCommit(p.easing);
      }}
    >
      {id === null ? (
        <option value={CUSTOM} disabled>
          {easingLabel(easing)}
        </option>
      ) : null}
      {EASING_PRESETS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/**
 * 미니 타임라인 — 클립 길이를 가로로 펴고 키프레임을 마름모로 찍는다.
 * 드래그로 시간 이동, 더블클릭으로 삭제. 드래그 중에는 로컬 상태로만 그리고
 * **손을 뗄 때 한 번** 명령을 보낸다(움직일 때마다 보내면 실행취소 스택이 수십 칸 쌓인다).
 */
function KeyframeStrip({
  clip,
  group,
  playheadMs,
  onMove,
  onDelete,
}: {
  clip: Clip;
  group: KeyframeGroup;
  playheadMs: number;
  onMove: (index: number, time: number) => void;
  onDelete: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ index: number; time: number } | null>(null);

  const timeAt = (clientX: number): number => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return keyframeTimeFromRatio(clip, (clientX - rect.left) / rect.width);
  };

  /** 가장 가까운 마름모 (10px 안). */
  const pick = (clientX: number): number | null => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    let best: number | null = null;
    let bestD = Infinity;
    for (const it of group.items) {
      const d = Math.abs(rect.left + keyframeRatio(clip, it.kf.time) * rect.width - clientX);
      if (d < 10 && d < bestD) {
        best = it.index;
        bestD = d;
      }
    }
    return best;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    const index = pick(e.clientX);
    if (index === null) return;
    setDrag({ index, time: timeAt(e.clientX) });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag({ index: drag.index, time: timeAt(e.clientX) });
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const { index, time } = drag;
    setDrag(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 이미 해제됨 — 무시
    }
    const cur = group.items.find((it) => it.index === index)?.kf.time;
    if (cur !== undefined && cur !== time) onMove(index, time);
  };

  const head = playheadMs - clip.start;
  const headVisible = head >= 0 && head <= clip.duration;

  return (
    <div
      ref={ref}
      className="insp-kf-strip"
      title="드래그로 시간 이동 · 더블클릭으로 삭제"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(e) => {
        const index = pick(e.clientX);
        if (index !== null) onDelete(index);
      }}
    >
      {headVisible ? (
        <span className="insp-kf-head-line" style={{ left: `${keyframeRatio(clip, head) * 100}%` }} />
      ) : null}
      {group.items.map((it) => {
        const time = drag && drag.index === it.index ? drag.time : it.kf.time;
        return (
          <span
            key={it.index}
            className={`insp-kf-mark${drag && drag.index === it.index ? ' is-drag' : ''}`}
            style={{ left: `${keyframeRatio(clip, time) * 100}%` }}
            title={`${formatMs(time)} · ${it.kf.value}`}
          />
        );
      })}
    </div>
  );
}
