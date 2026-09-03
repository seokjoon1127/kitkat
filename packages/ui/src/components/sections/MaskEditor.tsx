// 펜 툴 — 자유 마스크(F9) 편집 오버레이. 미리보기 화면 **위에** 그린다.
// 인스펙터의 숫자 필드로는 자유 곡선을 못 그리기 때문에 여기가 이 작업의 8할이다.
//
// 규칙 셋:
//  1. **문서에는 `d` 만 저장한다.** 정점 모델을 따로 저장하면 `d` 와 어긋날 수 있는 «두 번째
//     진실»이 생긴다. 열 때 `d` 를 파싱해 복원한다(parseMaskShape, 문법이 5개뿐이라 짧다).
//  2. **되돌리기는 두 층이다.** 드래그 한 번에 좌표가 수백 번 바뀌는데 그걸 전부 updateClip 으로
//     보내면 문서 되돌리기가 1px 씩 되돌아가 쓸모없어진다 → 편집기가 자기 스택(최대 100)을
//     갖고, 문서에는 200ms 디바운스로 나간다. **문서 되돌리기 1회 = 「마스크 모양 편집」 1건.**
//  3. **좌표 역변환은 렌더러의 `maskLocalFromCanvas` 를 쓴다.** UI 가 자기 식으로 다시 계산하면
//     회전·배율이 걸린 클립에서 조용히 갈린다.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Clip, ImageClip, Mask, VideoClip } from '@kitkat/schema';
import {
  computeVisualLayout,
  fitMaskBox,
  insertVertex,
  maskCanvasFromLocal,
  maskLocalFromCanvas,
  nearestOnPath,
  parseMaskShape,
  serializeMaskShape,
  type MaskShapeModel,
  type MaskVertex,
  type Pt,
} from '@kitkat/renderer/composition';
import { useEditor } from '../../state.js';
import { clipMasks, masksPatch, maskShapeLocked } from './inspector-utils.js';

// ── 「지금 어느 마스크를 그리고 있나」 (세션 상태, 문서가 아니다) ──────────
// state.ts(계약 C7)를 건드리지 않으려고 여기에 아주 작은 구독 저장소를 둔다.

export type MaskEditTarget = { clipId: string; index: number };

let target: MaskEditTarget | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((f) => f());

export function openMaskEditor(clipId: string, index: number): void {
  target = { clipId, index };
  useEditor.setState({ playing: false }); // 그리는 동안 재생을 멈춘다
  emit();
}
export function closeMaskEditor(): void {
  target = null;
  emit();
}
export function maskEditTarget(): MaskEditTarget | null {
  return target;
}
function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
export function useMaskEditTarget(): MaskEditTarget | null {
  return useSyncExternalStore(subscribe, maskEditTarget, maskEditTarget);
}

// ── 순수 편집 연산 (테스트 대상) ──────────────────────────────────────────

const cloneModel = (m: MaskShapeModel): MaskShapeModel => ({
  closed: m.closed,
  pts: m.pts.map((p) => ({
    x: p.x,
    y: p.y,
    ...(p.hIn ? { hIn: { ...p.hIn } } : {}),
    ...(p.hOut ? { hOut: { ...p.hOut } } : {}),
  })),
});

/** 점 이동. 핸들은 점과 함께 따라간다(핸들은 점 기준 상대 위치를 지킨다). */
export function moveVertex(model: MaskShapeModel, i: number, x: number, y: number): MaskShapeModel {
  const next = cloneModel(model);
  const p = next.pts[i];
  if (!p) return next;
  const dx = x - p.x;
  const dy = y - p.y;
  p.x = x;
  p.y = y;
  if (p.hIn) {
    p.hIn.x += dx;
    p.hIn.y += dy;
  }
  if (p.hOut) {
    p.hOut.x += dx;
    p.hOut.y += dy;
  }
  return next;
}

/**
 * 핸들 이동. 기본은 **좌우 대칭**(반대쪽 핸들이 점을 중심으로 반대 방향으로 같은 길이),
 * `break`(Alt) 면 대칭을 깨서 꺾인 점이 된다 — Illustrator·AE 관습이다.
 */
export function moveHandle(
  model: MaskShapeModel,
  i: number,
  which: 'hIn' | 'hOut',
  x: number,
  y: number,
  breakSymmetry: boolean,
): MaskShapeModel {
  const next = cloneModel(model);
  const p = next.pts[i];
  if (!p) return next;
  p[which] = { x, y };
  if (!breakSymmetry) {
    const other = which === 'hIn' ? 'hOut' : 'hIn';
    if (p[other]) p[other] = { x: 2 * p.x - x, y: 2 * p.y - y };
  }
  return next;
}

/** 점 삭제. 최소 2점은 남긴다(1점짜리 마스크는 그릴 것이 없다). */
export function deleteVertex(model: MaskShapeModel, i: number): MaskShapeModel {
  if (model.pts.length <= 2) return cloneModel(model);
  const next = cloneModel(model);
  next.pts.splice(i, 1);
  return next;
}

/** 더블클릭 — 곡선점 ↔ 꺾인점. 곡선으로 바꿀 때는 이웃 방향으로 핸들을 만들어 준다. */
export function toggleSmooth(model: MaskShapeModel, i: number): MaskShapeModel {
  const next = cloneModel(model);
  const p = next.pts[i];
  if (!p) return next;
  if (p.hIn || p.hOut) {
    delete p.hIn;
    delete p.hOut;
    return next;
  }
  const n = next.pts.length;
  const prev = next.pts[(i - 1 + n) % n]!;
  const after = next.pts[(i + 1) % n]!;
  const tx = (after.x - prev.x) / 6;
  const ty = (after.y - prev.y) / 6;
  p.hIn = { x: p.x - tx, y: p.y - ty };
  p.hOut = { x: p.x + tx, y: p.y + ty };
  return next;
}

/** 방향키 — 점(또는 전체)을 옮긴다. 값은 «마스크 상자 0..1» 단위의 증분이다. */
export function nudge(model: MaskShapeModel, i: number | null, dx: number, dy: number): MaskShapeModel {
  if (i === null) {
    const next = cloneModel(model);
    for (const p of next.pts) {
      p.x += dx;
      p.y += dy;
      if (p.hIn) {
        p.hIn.x += dx;
        p.hIn.y += dy;
      }
      if (p.hOut) {
        p.hOut.x += dx;
        p.hOut.y += dy;
      }
    }
    return next;
  }
  const p = model.pts[i];
  return p ? moveVertex(model, i, p.x + dx, p.y + dy) : cloneModel(model);
}

/** 편집기 안의 되돌리기 스택 (최대 100단계). 문서 스택과 **따로** 논다. */
export class ShapeHistory {
  private past: MaskShapeModel[] = [];
  private future: MaskShapeModel[] = [];
  constructor(private current: MaskShapeModel) {}
  get value(): MaskShapeModel {
    return this.current;
  }
  push(next: MaskShapeModel): void {
    this.past.push(this.current);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.current = next;
  }
  undo(): boolean {
    const p = this.past.pop();
    if (!p) return false;
    this.future.push(this.current);
    this.current = p;
    return true;
  }
  redo(): boolean {
    const f = this.future.pop();
    if (!f) return false;
    this.past.push(this.current);
    this.current = f;
    return true;
  }
  get depth(): number {
    return this.past.length;
  }
}

// ── 오버레이 ──────────────────────────────────────────────────────────────

type Drag =
  | { kind: 'point'; index: number }
  | { kind: 'handle'; index: number; which: 'hIn' | 'hOut' }
  | { kind: 'new'; index: number };

const HIT = 8; // 화면 px

function isVisual(c: Clip | undefined): c is VideoClip | ImageClip {
  return c !== undefined && (c.kind === 'video' || c.kind === 'image');
}

/**
 * 미리보기 위 편집 오버레이. PlayerPane 이 «재생 화면과 같은 상자»에 얹는다.
 * 표시 배율은 레터박스 규칙(폭·높이 중 작은 쪽에 맞춤)으로 직접 잰다 —
 * Remotion Player 도 빠른 미리보기도 같은 규칙이라 두 엔진에서 같은 자리를 가리킨다.
 */
export function MaskPenOverlay() {
  const t = useMaskEditTarget();
  const doc = useEditor((s) => s.doc);
  const playheadMs = useEditor((s) => s.playheadMs);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0, left: 0, top: 0 });
  const [model, setModel] = useState<MaskShapeModel | null>(null);
  const historyRef = useRef<ShapeHistory | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [snap, setSnap] = useState(true);
  const dragRef = useRef<Drag | null>(null);
  const commitTimer = useRef<number | null>(null);

  const clip = t && doc ? findClipById(doc, t.clipId) : undefined;
  const mask = isVisual(clip) && t ? clipMasks(clip)[t.index] : undefined;
  const asset = isVisual(clip) && doc ? doc.assets[clip.assetId] : undefined;

  // 문서의 d → 편집 모델 (열 때 한 번). 여기가 «d 하나만 저장한다»의 뒷면이다.
  const shapeKey = mask?.d ?? '';
  useEffect(() => {
    if (!t || !mask || mask.shape !== 'path' || !mask.d) {
      setModel(null);
      historyRef.current = null;
      return;
    }
    const parsed = parseMaskShape(mask.d);
    setModel(parsed);
    historyRef.current = parsed ? new ShapeHistory(parsed) : null;
    setSelected(null);
    // 편집을 «열 때»만 문서에서 읽는다 — 우리가 보낸 커밋이 되돌아와 편집 중인 모양을 덮으면 안 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.clipId, t?.index, shapeKey === '' ]);

  // 표시 상자 (레터박스)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !doc) return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // 오버레이는 `.player-stage` 의 **패딩 상자**에 붙지만 재생 화면은 **내용 상자** 안에 있다.
      // 패딩(16px)을 빼지 않으면 클릭 좌표가 통째로 밀린다.
      const parent = el.parentElement;
      const cs = parent ? getComputedStyle(parent) : null;
      const pl = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
      const pr = cs ? parseFloat(cs.paddingRight) || 0 : 0;
      const pt = cs ? parseFloat(cs.paddingTop) || 0 : 0;
      const pb = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
      const availW = r.width - pl - pr;
      const availH = r.height - pt - pb;
      if (availW <= 0 || availH <= 0) return;
      const aspect = doc.settings.width / doc.settings.height;
      const w = Math.min(availW, availH * aspect);
      const h = w / aspect;
      setBox({ w, h, left: pl + (availW - w) / 2, top: pt + (availH - h) / 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc?.settings.width, doc?.settings.height, t !== null]);

  const commit = useCallback(
    (m: MaskShapeModel, now = false) => {
      if (!t || !isVisual(clip) || !mask) return;
      const d = serializeMaskShape(m);
      const masks = clipMasks(clip).map((x, i) => (i === t.index ? { ...x, d } : x));
      const send = (): void => {
        void useEditor.getState().dispatch([
          { type: 'updateClip', clipId: t.clipId, patch: masksPatch(masks) },
        ]);
      };
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
      if (now) {
        commitTimer.current = null;
        send();
      } else {
        commitTimer.current = window.setTimeout(send, 200);
      }
    },
    [t, clip, mask],
  );

  const apply = useCallback(
    (next: MaskShapeModel, record = true) => {
      if (record) historyRef.current?.push(next);
      setModel(next);
      commit(next);
    },
    [commit],
  );

  // 키보드 — 편집기 안에서만 먹는다
  useEffect(() => {
    if (!t) return;
    const onKey = (e: KeyboardEvent): void => {
      const h = historyRef.current;
      if (!h) return;
      if (e.key === 'Escape') {
        closeMaskEditor();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        commit(h.value, true);
        closeMaskEditor();
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const ok = e.shiftKey ? h.redo() : h.undo();
        if (ok) {
          setModel(h.value);
          commit(h.value);
        }
        e.preventDefault();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
        apply(deleteVertex(h.value, selected));
        setSelected(null);
        e.preventDefault();
        return;
      }
      const step = (e.shiftKey ? 10 : 1) / Math.max(1, box.w); // 화면 1px ≈ 상자 1/폭
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const mv = d[e.key];
      if (mv) {
        apply(nudge(h.value, selected, mv[0], mv[1]));
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t, selected, apply, commit, box.w]);

  if (!t || !doc || !isVisual(clip) || !mask || mask.shape !== 'path') return null;

  const layout = asset
    ? computeVisualLayout({
        clip,
        asset,
        canvasW: doc.settings.width,
        canvasH: doc.settings.height,
        tMs: Math.max(0, playheadMs - clip.start),
      })
    : null;

  const scale = box.w > 0 ? box.w / doc.settings.width : 1;

  /** 화면 → 마스크 상자 0..1 (배율·레터박스·클립 회전/스케일을 전부 되돌린다). */
  const toLocal = (e: { clientX: number; clientY: number }): Pt | null => {
    const el = wrapRef.current;
    if (!el || !layout || scale === 0) return null;
    const r = el.getBoundingClientRect();
    let cx = (e.clientX - r.left - box.left) / scale;
    let cy = (e.clientY - r.top - box.top) / scale;
    if (snap) {
      const g = 20;
      cx = Math.round(cx / g) * g;
      cy = Math.round(cy / g) * g;
    }
    return maskLocalFromCanvas(layout, mask, cx, cy);
  };

  /** 마스크 상자 0..1 → 오버레이 화면 좌표 */
  const toScreen = (p: Pt): Pt => {
    if (!layout) return { x: 0, y: 0 };
    const c = maskCanvasFromLocal(layout, mask, p.x, p.y);
    return { x: box.left + c.x * scale, y: box.top + c.y * scale };
  };

  const locked = maskShapeLocked(mask);
  const pts = model?.pts ?? [];

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const h = historyRef.current;
    if (!h || !model) return;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    (e.target as Element).setPointerCapture?.(e.pointerId);

    // 1) 핸들 집기
    for (let i = 0; i < pts.length; i++) {
      for (const which of ['hIn', 'hOut'] as const) {
        const hp = pts[i]![which];
        if (!hp) continue;
        const s = toScreen(hp);
        if (Math.hypot(s.x - sx, s.y - sy) <= HIT) {
          dragRef.current = { kind: 'handle', index: i, which };
          setSelected(i);
          return;
        }
      }
    }
    // 2) 점 집기 — 열린 경로에서 첫 점을 누르면 «닫기»
    for (let i = 0; i < pts.length; i++) {
      const s = toScreen(pts[i]!);
      if (Math.hypot(s.x - sx, s.y - sy) <= HIT) {
        if (i === 0 && !model.closed && pts.length >= 3) {
          apply({ ...model, closed: true });
          setSelected(0);
          return;
        }
        dragRef.current = { kind: 'point', index: i };
        setSelected(i);
        return;
      }
    }
    if (locked) return; // 모양 키프레임이 있으면 점을 더하거나 뺄 수 없다
    // 3) 선 위 클릭 → 그 자리에 점 삽입
    const local = toLocal(e);
    if (!local) return;
    const near = nearestOnPath(model, local);
    if (near) {
      const s = toScreen(near.point);
      if (Math.hypot(s.x - sx, s.y - sy) <= HIT + 2) {
        apply(insertVertex(model, near.segment, near.t));
        setSelected(near.segment + 1);
        return;
      }
    }
    // 4) 빈 곳 → 꼭짓점 추가. 그대로 끌면 그 자리에서 베지어 핸들이 나온다.
    const next = cloneModel(model);
    next.pts.push({ x: local.x, y: local.y });
    apply(next);
    setSelected(next.pts.length - 1);
    dragRef.current = { kind: 'new', index: next.pts.length - 1 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const h = historyRef.current;
    if (!drag || !h || !model) return;
    const local = toLocal(e);
    if (!local) return;
    if (drag.kind === 'point') {
      apply(moveVertex(model, drag.index, local.x, local.y), false);
    } else if (drag.kind === 'handle') {
      apply(moveHandle(model, drag.index, drag.which, local.x, local.y, e.altKey), false);
    } else {
      // 빈 곳을 «클릭한 채 끌면» 그 자리에서 베지어 핸들이 나온다 (Illustrator 관습).
      // 양쪽을 대칭으로 만든다 — 곡선점으로 태어난다.
      const cur = model.pts[drag.index];
      if (!cur) return;
      const next = cloneModel(model);
      next.pts[drag.index]!.hOut = { x: local.x, y: local.y };
      next.pts[drag.index]!.hIn = { x: 2 * cur.x - local.x, y: 2 * cur.y - local.y };
      apply(next, false);
    }
  };

  const onPointerUp = (): void => {
    if (dragRef.current && model) historyRef.current?.push(model);
    dragRef.current = null;
  };

  const patchMask = (next: Mask): void => {
    const masks = clipMasks(clip).map((x, i) => (i === t.index ? next : x));
    void useEditor.getState().dispatch([
      { type: 'updateClip', clipId: t.clipId, patch: masksPatch(masks) },
    ]);
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => {
        const h = historyRef.current;
        if (h && selected !== null) apply(toggleSmooth(h.value, selected));
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        {model ? (
          <path
            d={screenPath(model, toScreen)}
            fill="rgba(90,160,255,0.12)"
            stroke="#5aa0ff"
            strokeWidth={1.5}
          />
        ) : null}
        {pts.map((p, i) => {
          const s = toScreen(p);
          return (
            <g key={i}>
              {(['hIn', 'hOut'] as const).map((w) => {
                const hp = p[w];
                if (!hp) return null;
                const hs = toScreen(hp);
                return (
                  <g key={w}>
                    <line x1={s.x} y1={s.y} x2={hs.x} y2={hs.y} stroke="#5aa0ff" strokeWidth={1} />
                    <circle cx={hs.x} cy={hs.y} r={4} fill="#0b0e14" stroke="#5aa0ff" strokeWidth={1.5} />
                  </g>
                );
              })}
              <rect
                x={s.x - 4}
                y={s.y - 4}
                width={8}
                height={8}
                fill={i === selected ? '#ffd45e' : '#ffffff'}
                stroke="#0b0e14"
                strokeWidth={1.5}
              />
            </g>
          );
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: 8,
          top: 8,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          padding: '4px 8px',
          borderRadius: 6,
          background: 'rgba(20,20,24,0.86)',
          fontSize: 11,
          color: '#e6e6ea',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span>{pts.length}점{model?.closed ? ' · 닫힘' : ' · 열림'}</span>
        {locked ? (
          <span style={{ color: '#ffd45e' }}>
            모양 키프레임이 있는 동안에는 점을 더하거나 뺄 수 없습니다
          </span>
        ) : null}
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
          격자
        </label>
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }} title="가장자리(페더)">
          페더
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={mask.feather}
            onChange={(e) => patchMask({ ...mask, feather: Number(e.target.value) })}
          />
        </label>
        <button
          type="button"
          className="btn"
          title="마스크 상자를 그린 모양에 꽉 맞춘다 — 트래킹이 잘 먹으려면 상자가 모양에 붙어 있어야 한다"
          onClick={() => {
            const fitted = fitMaskBox(mask);
            if (fitted) patchMask(fitted);
          }}
        >
          모양에 맞추기
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const h = historyRef.current;
            if (h) commit(h.value, true);
            closeMaskEditor();
          }}
        >
          적용
        </button>
        <button type="button" className="btn" onClick={closeMaskEditor}>
          닫기(Esc)
        </button>
      </div>
    </div>
  );
}

/** 편집 중인 모양을 «화면 좌표» path 로 (그리기 전용 — 문서에 저장되는 d 와 별개다). */
function screenPath(model: MaskShapeModel, toScreen: (p: Pt) => Pt): string {
  const { pts, closed } = model;
  if (pts.length === 0) return '';
  const s0 = toScreen(pts[0]!);
  const out = [`M${s0.x.toFixed(2)},${s0.y.toFixed(2)}`];
  const seg = (a: MaskVertex, b: MaskVertex): string => {
    const sb = toScreen(b);
    if (!a.hOut && !b.hIn) return `L${sb.x.toFixed(2)},${sb.y.toFixed(2)}`;
    const c1 = toScreen(a.hOut ?? { x: a.x, y: a.y });
    const c2 = toScreen(b.hIn ?? { x: b.x, y: b.y });
    return `C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ${sb.x.toFixed(2)},${sb.y.toFixed(2)}`;
  };
  for (let i = 1; i < pts.length; i++) out.push(seg(pts[i - 1]!, pts[i]!));
  if (closed && pts.length > 1) {
    out.push(seg(pts[pts.length - 1]!, pts[0]!));
    out.push('Z');
  }
  return out.join(' ');
}

function findClipById(
  doc: { tracks: { clips: Clip[] }[] },
  clipId: string,
): Clip | undefined {
  for (const t of doc.tracks) {
    for (const c of t.clips) if (c.id === clipId) return c;
  }
  return undefined;
}
