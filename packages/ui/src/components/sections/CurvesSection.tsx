// 색조정 커브 섹션 (W5 M1) — RGB/R/G/B 탭 + SVG 격자 위 점 드래그.
// 빈 곳 클릭 = 점 추가, 우클릭·더블클릭 = 점 삭제, [초기화] = 그 채널 삭제.
// 드래그 중에는 200ms 디바운스로 updateClip {curves} 를 보낸다(기존 슬라이더 규칙과 같게).
import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ColorCurves, CurvePoint } from '@kitkat/schema';
import {
  addCurvePoint,
  curvePath,
  CURVE_CHANNELS,
  CURVE_CHANNEL_LABELS,
  DEFAULT_CURVE,
  moveCurvePoint,
  normalizeCurve,
  removeCurvePoint,
  setCurveChannel,
} from './inspector-utils.js';
import type { CurveChannel } from './inspector-utils.js';
import { Section, useDebouncedCommit } from './fields.js';

type Props = {
  curves: ColorCurves | undefined;
  patch: (p: Record<string, unknown>) => void;
};

const PAD = 6; // 점이 잘리지 않게 SVG 안쪽 여백
const W = 100;
const H = 100;
const HIT = 7; // 점 집기 반경 (SVG 좌표계)

const CHANNEL_STROKE: Record<CurveChannel, string> = {
  rgb: '#c9c9d6',
  r: '#f87171',
  g: '#4ade80',
  b: '#60a5fa',
};

export function CurvesSection({ curves, patch }: Props) {
  const [channel, setChannel] = useState<CurveChannel>('rgb');
  const stored = curves?.[channel];
  const [points, setPoints] = useDebouncedCommit<CurvePoint[]>(
    (stored ?? DEFAULT_CURVE) as CurvePoint[],
    (next) => patch({ curves: setCurveChannel(curves, channel, next) }),
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragIndex = useRef<number | null>(null);

  /** 화면 좌표 → 커브 좌표(0..1). y 는 위가 1. */
  const toCurve = (e: { clientX: number; clientY: number }): CurvePoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const sx = ((e.clientX - rect.left) / rect.width) * (W + PAD * 2) - PAD;
    const sy = ((e.clientY - rect.top) / rect.height) * (H + PAD * 2) - PAD;
    return { x: sx / W, y: 1 - sy / H };
  };

  const hitTest = (c: CurvePoint): number => {
    let best = -1;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const dx = (p.x - c.x) * W;
      const dy = (p.y - c.y) * H;
      const d = Math.hypot(dx, dy);
      if (d < HIT && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button === 2) return; // 우클릭은 contextmenu 에서 삭제로 처리
    const c = toCurve(e);
    const idx = hitTest(c);
    if (idx >= 0) {
      dragIndex.current = idx;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (c.x < 0 || c.x > 1 || c.y < 0 || c.y > 1) return;
    const next = addCurvePoint(points, c.x, c.y);
    setPoints(next);
    const newIdx = next.findIndex((p) => Math.abs(p.x - c.x) < 1e-9);
    if (newIdx >= 0) {
      dragIndex.current = newIdx;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const idx = dragIndex.current;
    if (idx === null) return;
    const c = toCurve(e);
    setPoints(moveCurvePoint(points, idx, c.x, c.y));
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragIndex.current === null) return;
    dragIndex.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 이미 해제됨 — 무시
    }
    setPoints(normalizeCurve(points));
  };

  const deleteAt = (index: number) => {
    dragIndex.current = null;
    setPoints(removeCurvePoint(points, index));
  };

  const stroke = CHANNEL_STROKE[channel];
  const active = stored !== undefined;

  return (
    <Section title="색조정 커브">
      <div className="insp-tabs">
        {CURVE_CHANNELS.map((c) => (
          <button
            key={c}
            type="button"
            className={`insp-tab${c === channel ? ' is-active' : ''}${curves?.[c] ? ' has-data' : ''}`}
            onClick={() => setChannel(c)}
          >
            {CURVE_CHANNEL_LABELS[c]}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        className="insp-curve"
        viewBox={`${-PAD} ${-PAD} ${W + PAD * 2} ${H + PAD * 2}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => {
          e.preventDefault();
          const idx = hitTest(toCurve(e));
          if (idx > 0 && idx < points.length - 1) deleteAt(idx);
        }}
        onDoubleClick={(e) => {
          const idx = hitTest(toCurve(e));
          if (idx > 0 && idx < points.length - 1) deleteAt(idx);
        }}
      >
        <rect x={0} y={0} width={W} height={H} className="insp-curve-bg" />
        {[1, 2, 3].map((i) => (
          <g key={i} className="insp-curve-grid">
            <line x1={(W * i) / 4} y1={0} x2={(W * i) / 4} y2={H} />
            <line x1={0} y1={(H * i) / 4} x2={W} y2={(H * i) / 4} />
          </g>
        ))}
        <line className="insp-curve-diag" x1={0} y1={H} x2={W} y2={0} />
        <path className="insp-curve-line" d={curvePath(points, W, H)} style={{ stroke }} />
        {points.map((p, i) => (
          <circle
            key={i}
            className="insp-curve-dot"
            cx={p.x * W}
            cy={(1 - p.y) * H}
            r={3.2}
            style={{ fill: stroke }}
          />
        ))}
      </svg>
      <p className="insp-note">
        빈 곳을 누르면 점 추가, 점을 우클릭·더블클릭하면 삭제됩니다. 양 끝점은 좌우로 움직일 수 없습니다.
      </p>
      {/* W8 F13 — 커브에는 키프레임 버튼이 붙지 않는다(값이 숫자가 아니라 점 배열이다). */}
      <p className="insp-note">
        커브에는 키프레임을 걸 수 없습니다 — 값이 숫자 하나가 아니라 점 여러 개라서입니다. 시간에
        따라 색을 바꾸려면 「효과」의 밝기·대비·채도에 키프레임을 거세요.
      </p>
      <div className="insp-add-row">
        {/* 문서에서 채널을 지우면 로컬 값은 외부 동기화로 항등 커브가 된다 — 중복 커밋 없음 */}
        <button
          type="button"
          className="insp-btn"
          disabled={!active}
          onClick={() => patch({ curves: setCurveChannel(curves, channel, null) })}
        >
          {CURVE_CHANNEL_LABELS[channel]} 초기화
        </button>
        <button
          type="button"
          className="insp-btn insp-del"
          disabled={!curves}
          onClick={() => patch({ curves: null })}
        >
          전체 해제
        </button>
      </div>
    </Section>
  );
}
