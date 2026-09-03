// 속도 램프 섹션 (W5 M6) — 프리셋 6종 + 포인트 표 편집 + 해제.
// setSpeedRamp 명령으로만 보낸다(duration 과 연동되므로 updateClip 금지 — FORBIDDEN_PATCH_KEYS).
import { SPEED_RAMP_PRESETS } from '@kitkat/schema';
import type { SpeedPoint, VideoClip } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import { insertRampPoint, normalizeRampPoints, removeRampPoint } from './inspector-utils.js';
import { BareNumber, Section } from './fields.js';

type Props = {
  clip: VideoClip;
  dispatch: (cmds: Command[]) => Promise<void>;
};

export function SpeedRampSection({ clip, dispatch }: Props) {
  const points = clip.speedRamp?.points;
  const send = (next: SpeedPoint[] | null) => {
    void dispatch([{ type: 'setSpeedRamp', clipId: clip.id, points: next }]);
  };

  if (clip.freeze === true || clip.loop === true) {
    return (
      <Section title="속도 램프">
        <p className="insp-empty">정지·반복 클립에는 속도 램프를 쓸 수 없습니다</p>
      </Section>
    );
  }

  return (
    <Section title="속도 램프">
      <div className="insp-preset-grid">
        {SPEED_RAMP_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="insp-btn insp-preset"
            onClick={() => send(normalizeRampPoints(p.points))}
          >
            {p.name}
          </button>
        ))}
      </div>
      {points ? (
        <>
          <div className="insp-ramp-head">
            <span>지점(0~1)</span>
            <span>속도(배)</span>
            <span />
          </div>
          {points.map((pt, i) => {
            const isEnd = i === 0 || i === points.length - 1;
            return (
              <div className="insp-ramp-row" key={i}>
                {isEnd ? (
                  <span className="insp-static">{pt.u}</span>
                ) : (
                  <BareNumber
                    className="insp-number insp-kf-num"
                    value={pt.u}
                    min={0}
                    max={1}
                    step={0.01}
                    onCommit={(v) =>
                      send(normalizeRampPoints(points.map((q, j) => (j === i ? { ...q, u: v } : q))))
                    }
                  />
                )}
                <BareNumber
                  className="insp-number insp-kf-num"
                  value={pt.speed}
                  min={0.1}
                  max={100}
                  step={0.1}
                  onCommit={(v) =>
                    send(normalizeRampPoints(points.map((q, j) => (j === i ? { ...q, speed: v } : q))))
                  }
                />
                <button
                  type="button"
                  className="insp-btn insp-del"
                  disabled={isEnd}
                  title={isEnd ? '양 끝 지점은 지울 수 없습니다' : '지점 삭제'}
                  onClick={() => send(removeRampPoint(points, i))}
                >
                  ×
                </button>
              </div>
            );
          })}
          <div className="insp-add-row">
            <button type="button" className="insp-btn" onClick={() => send(insertRampPoint(points))}>
              지점 추가
            </button>
            <button type="button" className="insp-btn insp-del" onClick={() => send(null)}>
              해제
            </button>
          </div>
          <p className="insp-note">
            속도 램프가 걸린 클립은 분할·트림이 되지 않습니다 — 먼저 [해제]하세요.
          </p>
        </>
      ) : (
        <p className="insp-empty">램프 없음 — 프리셋을 고르면 시작합니다</p>
      )}
    </Section>
  );
}
