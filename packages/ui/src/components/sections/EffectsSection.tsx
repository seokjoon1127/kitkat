// 효과 섹션: EFFECT_TYPES 추가 드롭다운 + 파라미터 슬라이더 + 삭제
// 전부 updateClip으로 effects 배열을 통째로 patch한다 (개별 addEffect 명령은 없음).
// W8 F13: 파라미터마다 키프레임 버튼(◆)이 붙고, 효과를 지우면 그 효과의 키프레임도 같이 지운다.
import { useState } from 'react';
import type { Effect, EffectType } from '@kitkat/schema';
import {
  EFFECT_LABELS,
  EFFECT_PARAM_DEFS,
  effectOptionGroups,
  effectParamPath,
  effectPendingReason,
  keyframesWithoutEffect,
  makeEffect,
} from './inspector-utils.js';
import { Section, SliderField } from './fields.js';
import { useKeyframeCtx } from './keyframe-dot.js';

type Props = {
  effects: Effect[] | undefined;
  patch: (p: Record<string, unknown>) => void;
};

function numParam(v: number | string | boolean | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function EffectsSection({ effects, patch }: Props) {
  const list = effects ?? [];
  const [pick, setPick] = useState<EffectType>('brightness');
  const ctx = useKeyframeCtx();
  const commit = (next: Effect[]) => patch({ effects: next.length > 0 ? next : null });

  /**
   * 효과 삭제 — **그 효과의 키프레임도 같이 지운다.**
   * 안 그러면 `effects#<지운id>.params.amount` 가 문서에 남는다. 무동작이라 티가 안 나고,
   * 같은 효과를 다시 추가해도 id 가 달라서 안 붙는다. 두 명령을 한 번에 보내 실행취소도 한 칸이다.
   */
  const removeEffect = (id: string) => {
    const next = list.filter((x) => x.id !== id);
    const kfs = ctx?.clip.keyframes ?? [];
    const cleaned = keyframesWithoutEffect(kfs, id);
    if (ctx && cleaned.length !== kfs.length) {
      void ctx.dispatch([
        { type: 'updateClip', clipId: ctx.clip.id, patch: { effects: next.length > 0 ? next : null } },
        { type: 'setKeyframes', clipId: ctx.clip.id, keyframes: cleaned },
      ]);
      return;
    }
    commit(next);
  };

  return (
    <Section title="효과">
      {/*
        갈래별 optgroup — 50종을 평평하게 늘어놓으면 못 찾는다.
        「대기」 항목(카탈로그 `pending`)은 **고를 수 없다**: 목록에서 빼지는 않되
        고르면 안 그려지는 상태는 만들지 않는다. W8 #8 부터 대기가 0 이라 50종 전부 고를 수 있다 —
        옛 대기 6종(vibrance·bokeh·radialBlur·mirror·kaleidoscope·halftone)은 WebGL 로 그린다.
      */}
      <div className="insp-add-row">
        <select
          className="insp-select"
          value={pick}
          onChange={(e) => setPick(e.target.value as EffectType)}
        >
          {effectOptionGroups().map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className="insp-btn"
          disabled={effectPendingReason(pick) !== null}
          onClick={() => commit([...list, makeEffect(pick)])}
        >
          추가
        </button>
      </div>
      {list.map((ef) => (
        <div className="insp-effect" key={ef.id}>
          <div className="insp-effect-head">
            <span>{EFFECT_LABELS[ef.type]}</span>
            <button type="button" className="insp-btn insp-del" onClick={() => removeEffect(ef.id)}>
              삭제
            </button>
          </div>
          {/* 카탈로그에 대기(pending) 항목이 다시 생기면 왜 안 보이는지 적어 준다 (지금은 0 종). */}
          {effectPendingReason(ef.type) ? (
            <p className="insp-badge">아직 안 그려집니다 — {effectPendingReason(ef.type)}</p>
          ) : null}
          {(EFFECT_PARAM_DEFS[ef.type] ?? []).map((d) => (
            <SliderField
              key={d.key}
              label={d.label}
              value={numParam(ef.params[d.key], d.def)}
              min={d.min}
              max={d.max}
              step={d.step}
              digits={d.step >= 1 ? 0 : 2}
              kfPath={effectParamPath(ef.id, d.key)}
              onCommit={(v) =>
                commit(
                  list.map((x) => (x.id === ef.id ? { ...x, params: { ...x.params, [d.key]: v } } : x)),
                )
              }
            />
          ))}
        </div>
      ))}
      {list.length === 0 ? <p className="insp-empty">적용된 효과가 없습니다</p> : null}
    </Section>
  );
}
