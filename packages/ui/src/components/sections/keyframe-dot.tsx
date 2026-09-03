// 값 옆의 마름모 버튼(◆) — 「이 값에 시간 따라 변하는 애니메이션을 건다」 (W8 F13).
//
// 버튼 하나가 필요로 하는 것은 클립·재생헤드·dispatch 세 가지다. 필드마다 prop 3개를
// 실어 나르면 MaskFields·ChromaKeyFields 처럼 두세 겹 안쪽에 있는 슬라이더까지 전부
// 시그니처가 바뀐다. 그래서 인스펙터가 한 번만 내려보내고(Provider), 필드는 경로만 준다.
// Provider 밖(프로젝트 패널 등)에서는 버튼이 아예 붙지 않는다.
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Clip } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import { keyframeDotCommands, keyframeDotState } from './inspector-utils.js';

export type KeyframeCtx = {
  clip: Clip;
  playheadMs: number;
  dispatch: (cmds: Command[]) => Promise<void>;
};

const Ctx = createContext<KeyframeCtx | null>(null);

export function KeyframeProvider({ value, children }: { value: KeyframeCtx; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKeyframeCtx(): KeyframeCtx | null {
  return useContext(Ctx);
}

const GLYPH = { on: '◆', other: '◈', off: '◇', blocked: '◇' } as const;

/**
 * ◇ 없음 / ◆ 재생헤드에 있음(누르면 삭제) / ◈ 다른 시각에 있음(누르면 여기 추가) /
 * 회색 = 걸 수 없음 — **왜 안 되는지**가 툴팁에 나온다(`source.*` 는 전용 문구).
 *
 * `value` 는 그 필드가 «지금 화면에 보여 주는» 값이다. 문서에 아직 없는 값(자간을 한 번도
 * 건드리지 않았다 등)이면 이 값으로 문서에 적으면서 키프레임을 건다.
 */
export function KeyframeDot({ path, value }: { path: string; value?: number }) {
  const ctx = useKeyframeCtx();
  if (!ctx) return null;
  const { clip, playheadMs, dispatch } = ctx;
  const st = keyframeDotState(clip, path, playheadMs, value);
  return (
    <button
      type="button"
      className={`insp-kf-dot is-${st.status}`}
      title={st.title}
      aria-label={`키프레임 ${path}`}
      aria-pressed={st.status === 'on'}
      disabled={st.status === 'blocked'}
      onClick={() => {
        const cmds = keyframeDotCommands(clip, path, playheadMs, value);
        if (cmds.length > 0) void dispatch(cmds);
      }}
    >
      {GLYPH[st.status]}
    </button>
  );
}
