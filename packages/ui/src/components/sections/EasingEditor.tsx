// 이징 편집기 (W8 F7) — 프리셋 12종 칩 + 곡선 편집 + 스프링 물리 슬라이더.
//
// W6 색조정 커브 편집기(CurvesSection)와 «같은 조작감»이다: 같은 SVG 격자, 같은
// setPointerCapture 드래그, 같은 200ms 디바운스 커밋, 같은 insp-curve* CSS.
// 다른 점은 두 가지뿐이다.
//   1) 점이 N개가 아니라 **정확히 2개**(P1·P2). 양 끝은 (0,0)·(1,1)로 고정이고
//      끝점→제어점 핸들 선을 그린다(표준 cubic-bezier 편집기 모양).
//   2) **y 축이 −0.5..1.5** 다. 스프링과 back 계열은 곡선이 1을 넘고 0 아래로 내려가는데,
//      0..1 로 자르면 «튕김»이 그림에서 사라진다. y=0·y=1 에 기준선을 그어 어디가 목표값인지 보인다.
//
// 스프링은 제어점이 없다(물리 파라미터다). 그래서 슬라이더가 나오지만, **곡선은 같은 SVG 가
// 같은 방식(easingFn 샘플링)으로** 그린다 — 종류를 바꿔도 그림이 갈리지 않는다.
import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { EASING_PRESETS } from '@kitkat/schema';
import type { Easing } from '@kitkat/schema';
import {
  EASE_VIEW,
  easeFromSvgY,
  easeToSvgY,
  easingControlPoints,
  easingCurvePath,
  easingKind,
  easingLabel,
  easingPeak,
  easingPresetId,
  moveEasingPoint,
  SPRING_PARAM_KEYS,
  SPRING_RANGES,
  springConfigOf,
  springParamValue,
  springSettleLabel,
  withOvershootClamping,
  withSpringParam,
} from './inspector-utils.js';
import { useDebouncedCommit } from './fields.js';

const { W, H, PAD } = EASE_VIEW;
const HIT = 9; // 점 집기 반경 (SVG 좌표계) — 커브 에디터(7)보다 조금 넉넉하게

type Props = {
  easing: Easing;
  onCommit: (e: Easing) => void;
  onClose?: () => void;
};

export function EasingEditor({ easing, onCommit, onClose }: Props) {
  const [local, setLocal] = useDebouncedCommit<Easing>(easing, onCommit);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragPoint = useRef<0 | 1 | null>(null);

  const kind = easingKind(local);
  const points = easingControlPoints(local);
  const spring = springConfigOf(local);
  const presetId = easingPresetId(local);
  const peak = easingPeak(local);

  /** 화면 좌표 → 커브 좌표. x 는 0..1, y 는 −0.5..1.5. */
  const toCurve = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const sx = ((e.clientX - rect.left) / rect.width) * (W + PAD * 2) - PAD;
    const sy = ((e.clientY - rect.top) / rect.height) * (H + PAD * 2) - PAD;
    return { x: sx / W, y: easeFromSvgY(sy) };
  };

  const hitTest = (c: { x: number; y: number }): 0 | 1 | null => {
    if (!points) return null;
    const sx = c.x * W;
    const sy = easeToSvgY(c.y);
    let best: 0 | 1 | null = null;
    let bestD = Infinity;
    ([0, 1] as const).forEach((i) => {
      const d = Math.hypot(points[i * 2]! * W - sx, easeToSvgY(points[i * 2 + 1]!) - sy);
      if (d < HIT && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!points || e.button === 2) return;
    const idx = hitTest(toCurve(e));
    if (idx === null) return;
    dragPoint.current = idx;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const idx = dragPoint.current;
    if (idx === null) return;
    const c = toCurve(e);
    setLocal(moveEasingPoint(local, idx, c.x, c.y));
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragPoint.current === null) return;
    dragPoint.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 이미 해제됨 — 무시
    }
  };

  const zeroY = easeToSvgY(0);
  const oneY = easeToSvgY(1);

  return (
    <div className="insp-ease">
      <div className="insp-ease-head">
        <span className="insp-ease-name">{easingLabel(local)}</span>
        {onClose ? (
          <button type="button" className="insp-btn insp-del" onClick={onClose} title="닫기">
            ✕
          </button>
        ) : null}
      </div>

      <div className="insp-ease-chips">
        {EASING_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`insp-chip${p.id === presetId ? ' is-active' : ''}`}
            title={p.note ?? p.name}
            onClick={() => setLocal(p.easing)}
          >
            {p.name}
          </button>
        ))}
      </div>

      <svg
        ref={svgRef}
        className="insp-curve insp-ease-curve"
        viewBox={`${-PAD} ${-PAD} ${W + PAD * 2} ${H + PAD * 2}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <rect x={0} y={0} width={W} height={H} className="insp-curve-bg" />
        {[1, 2, 3].map((i) => (
          <line key={i} className="insp-curve-grid-line" x1={(W * i) / 4} y1={0} x2={(W * i) / 4} y2={H} />
        ))}
        {/* 목표값 기준선 — 이 두 줄이 없으면 「1 을 넘었다」가 눈에 안 보인다 */}
        <line className="insp-ease-base" x1={0} y1={zeroY} x2={W} y2={zeroY} />
        <line className="insp-ease-base" x1={0} y1={oneY} x2={W} y2={oneY} />
        <text className="insp-ease-tick" x={-6} y={oneY + 3}>
          1
        </text>
        <text className="insp-ease-tick" x={-6} y={zeroY + 3}>
          0
        </text>
        <line className="insp-curve-diag" x1={0} y1={zeroY} x2={W} y2={oneY} />
        <path className="insp-curve-line insp-ease-line" d={easingCurvePath(local)} />
        {points ? (
          <>
            <line className="insp-ease-handle" x1={0} y1={zeroY} x2={points[0] * W} y2={easeToSvgY(points[1])} />
            <line className="insp-ease-handle" x1={W} y1={oneY} x2={points[2] * W} y2={easeToSvgY(points[3])} />
            {([0, 1] as const).map((i) => (
              <circle
                key={i}
                className="insp-curve-dot insp-ease-dot"
                cx={points[i * 2]! * W}
                cy={easeToSvgY(points[i * 2 + 1]!)}
                r={4}
              />
            ))}
          </>
        ) : null}
      </svg>

      {kind === 'spring' && spring ? (
        <>
          {SPRING_PARAM_KEYS.map((key) => {
            const r = SPRING_RANGES[key];
            const v = springParamValue(spring, key);
            return (
              <div className="insp-row" key={key}>
                <span className="insp-label" title={r.hint}>
                  {r.label}
                </span>
                <span className="insp-control">
                  <input
                    className="insp-range"
                    type="range"
                    min={r.min}
                    max={r.max}
                    step={r.step}
                    value={v}
                    onChange={(e) => setLocal(withSpringParam(local, key, Number(e.target.value)))}
                  />
                  <span className="insp-value">{v.toFixed(r.digits)}</span>
                </span>
              </div>
            );
          })}
          <div className="insp-row">
            <span className="insp-label" title="1 을 넘지 않게 자른다(튕김 없음)">
              오버슈트 막기
            </span>
            <span className="insp-control">
              <input
                className="insp-check"
                type="checkbox"
                checked={spring.overshootClamping === true}
                onChange={(e) => setLocal(withOvershootClamping(local, e.target.checked))}
              />
            </span>
          </div>
          <p className="insp-note">
            {springSettleLabel(spring)} · 구간 길이에 맞춰 이 시간이 0..1 로 눌려 들어간다 —
            200ms 구간이든 2초 구간이든 «모양»은 같다.
          </p>
        </>
      ) : (
        <p className="insp-note">점 두 개를 끌어 곡선을 바꿉니다. 가로는 0..1 로 막혀 있습니다(CSS 규격).</p>
      )}

      <p className="insp-note">
        {kind === 'bezier' && points
          ? `cubic-bezier(${points.map((v) => v.toFixed(2)).join(', ')})`
          : kind === 'name'
            ? '프리셋 — 점을 움직이면 사용자 지정 곡선이 됩니다'
            : '스프링(감쇠 조화 진동)'}
        {peak > 1.001 ? ` · 최대 ${peak.toFixed(2)} (목표를 지나쳤다 돌아온다)` : ''}
      </p>
    </div>
  );
}
