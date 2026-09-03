// 자유 마스크(F9)의 «좌표 계산» — remotion·react 무의존 순수 모듈.
// 렌더러(clips.tsx)·펜 툴 UI(MaskEditor)·미리보기가 **같은 함수**를 쓴다.
//
// `@remotion/paths`(getBoundingBox·interpolatePath·getPointAtLength)는 **4.0.520** 이고
// 이 저장소의 remotion 은 4.0.519 다. 단독 설치하면 remotion 사본이 둘이 되어 렌더가 깨지므로
// (계획 08 §5 · 09), 우리 문법이 `M L C Q Z` 다섯 개뿐이라는 점을 이용해 여기서 직접 계산한다.
// remotion 패키지를 일괄 상향하면 이 파일을 그 라이브러리로 갈아 끼울 수 있다.
import { easingFn, parseMaskPathD, type Mask, type MaskShapeKey } from '@kitkat/schema';

export type Pt = { x: number; y: number };

/** `d` 의 좌표를 «마스크 상자 0..1» → 클립 상자 px 로 옮긴다. 명령 구성은 그대로 둔다. */
export function maskPathToPx(d: string, mask: Mask, boxW: number, boxH: number): string | null {
  const cmds = parseMaskPathD(d);
  if (!cmds) return null;
  const px = (v: number): number => (mask.x + v * mask.w) * boxW;
  const py = (v: number): number => (mask.y + v * mask.h) * boxH;
  const out: string[] = [];
  for (const c of cmds) {
    const up = c.cmd.toUpperCase();
    if (up === 'Z') {
      out.push('Z');
      continue;
    }
    const nums: string[] = [];
    for (let i = 0; i < c.nums.length; i += 2) {
      nums.push(`${round2(px(c.nums[i]!))},${round2(py(c.nums[i + 1]!))}`);
    }
    out.push(`${up} ${nums.join(' ')}`);
  }
  return out.join(' ');
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 두 모양의 «수치만» 선형 보간한다. 명령 구성이 다르면 null(= 스키마가 이미 막는다). */
export function lerpMaskPathD(a: string, b: string, u: number): string | null {
  const ca = parseMaskPathD(a);
  const cb = parseMaskPathD(b);
  if (!ca || !cb || ca.length !== cb.length) return null;
  const out: string[] = [];
  for (let i = 0; i < ca.length; i++) {
    const x = ca[i]!;
    const y = cb[i]!;
    if (x.cmd.toUpperCase() !== y.cmd.toUpperCase() || x.nums.length !== y.nums.length) return null;
    const up = x.cmd.toUpperCase();
    if (up === 'Z') {
      out.push('Z');
      continue;
    }
    const nums = x.nums.map((n, k) => round4(n + (y.nums[k]! - n) * u));
    const pairs: string[] = [];
    for (let k = 0; k < nums.length; k += 2) pairs.push(`${nums[k]},${nums[k + 1]}`);
    out.push(`${up} ${pairs.join(' ')}`);
  }
  return out.join(' ');
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * 그 시각의 모양. `dKeys` 가 없으면 `mask.d` 그대로.
 * 구간 이징은 키프레임과 같은 규칙 — **앞 키의 easing** 을 따른다.
 */
export function resolveMaskD(mask: Mask, tMs: number): string | undefined {
  const keys = mask.dKeys;
  if (!keys || keys.length === 0) return mask.d;
  if (keys.length === 1) return keys[0]!.d;
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (tMs <= first.time) return first.d;
  if (tMs >= last.time) return last.d;
  for (let i = 0; i < keys.length - 1; i++) {
    const from: MaskShapeKey = keys[i]!;
    const to: MaskShapeKey = keys[i + 1]!;
    if (tMs >= from.time && tMs <= to.time) {
      if (to.time === from.time) return to.d;
      const u = easingFn(from.easing ?? 'linear')((tMs - from.time) / (to.time - from.time));
      return lerpMaskPathD(from.d, to.d, u) ?? from.d;
    }
  }
  return mask.d;
}

/** 모양의 실제 범위(마스크 상자 0..1 좌표). 제어점까지 포함한 «넉넉한» 상자다. */
export function maskPathBounds(d: string): { x: number; y: number; w: number; h: number } | null {
  const cmds = parseMaskPathD(d);
  if (!cmds) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cmds) {
    for (let i = 0; i + 1 < c.nums.length; i += 2) {
      const x = c.nums[i]!;
      const y = c.nums[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * [모양에 맞추기] — 그린 모양이 마스크 상자를 꽉 채우도록 `x/y/w/h` 와 `d` 를 다시 잡는다.
 * 트래킹(F10)이 상자를 옮기므로 상자가 모양에 붙어 있어야 잘 먹는다.
 */
export function fitMaskBox(mask: Mask): Mask | null {
  if (mask.shape !== 'path' || !mask.d) return null;
  const b = maskPathBounds(mask.d);
  if (!b || b.w <= 0 || b.h <= 0) return null;
  const cmds = parseMaskPathD(mask.d);
  if (!cmds) return null;
  const out: string[] = [];
  for (const c of cmds) {
    const up = c.cmd.toUpperCase();
    if (up === 'Z') {
      out.push('Z');
      continue;
    }
    const pairs: string[] = [];
    for (let i = 0; i < c.nums.length; i += 2) {
      pairs.push(
        `${round4((c.nums[i]! - b.x) / b.w)},${round4((c.nums[i + 1]! - b.y) / b.h)}`,
      );
    }
    out.push(`${up} ${pairs.join(' ')}`);
  }
  return {
    ...mask,
    x: round4(mask.x + b.x * mask.w),
    y: round4(mask.y + b.y * mask.h),
    w: round4(b.w * mask.w),
    h: round4(b.h * mask.h),
    d: out.join(' '),
  };
}

// ── 펜 툴이 쓰는 정점 모델 ────────────────────────────────────────────────
//
// **문서에는 `d` 만 저장한다.** 정점 모델을 따로 저장하면 `d` 와 어긋날 수 있는
// 「두 번째 진실」이 생긴다. 다시 열 때는 `d` 를 파싱해 복원한다 — 문법이 5개뿐이라 짧다.

export type MaskVertex = {
  x: number; y: number;
  /** 들어오는 곡선의 제어점 (없으면 직선) */
  hIn?: Pt;
  /** 나가는 곡선의 제어점 */
  hOut?: Pt;
};
export type MaskShapeModel = { pts: MaskVertex[]; closed: boolean };

/** `d` → 정점·핸들. 여러 조각(subpath)이면 **첫 조각만** 편집 대상이다. */
export function parseMaskShape(d: string): MaskShapeModel | null {
  const cmds = parseMaskPathD(d);
  if (!cmds) return null;
  const pts: MaskVertex[] = [];
  let closed = false;
  for (const c of cmds) {
    const up = c.cmd.toUpperCase();
    if (up === 'M') {
      if (pts.length > 0) break; // 두 번째 조각은 편집기에서 다루지 않는다
      pts.push({ x: c.nums[0]!, y: c.nums[1]! });
    } else if (up === 'L') {
      pts.push({ x: c.nums[0]!, y: c.nums[1]! });
    } else if (up === 'C') {
      const prev = pts[pts.length - 1];
      if (!prev) return null;
      prev.hOut = { x: c.nums[0]!, y: c.nums[1]! };
      pts.push({ x: c.nums[4]!, y: c.nums[5]!, hIn: { x: c.nums[2]!, y: c.nums[3]! } });
    } else if (up === 'Q') {
      // 2차 → 3차로 승격 (우리 편집기는 3차만 다룬다). 모양은 정확히 같다.
      const prev = pts[pts.length - 1];
      if (!prev) return null;
      const qx = c.nums[0]!;
      const qy = c.nums[1]!;
      const ex = c.nums[2]!;
      const ey = c.nums[3]!;
      prev.hOut = { x: prev.x + (2 / 3) * (qx - prev.x), y: prev.y + (2 / 3) * (qy - prev.y) };
      pts.push({ x: ex, y: ey, hIn: { x: ex + (2 / 3) * (qx - ex), y: ey + (2 / 3) * (qy - ey) } });
    } else if (up === 'Z') {
      closed = true;
      break;
    }
  }
  if (pts.length === 0) return null;
  // 닫힌 경로는 마지막 점이 첫 점과 같게 적혀 있을 수 있다 — 핸들만 넘겨받고 지운다.
  if (closed && pts.length > 1) {
    const last = pts[pts.length - 1]!;
    const first = pts[0]!;
    if (Math.abs(last.x - first.x) < 1e-9 && Math.abs(last.y - first.y) < 1e-9) {
      if (last.hIn) first.hIn = last.hIn;
      pts.pop();
    }
  }
  return { pts, closed };
}

const n4 = (v: number): string => String(Math.round(v * 10000) / 10000);

/** 정점·핸들 → `d`. 핸들이 없는 구간은 `L`, 있으면 `C` 로 쓴다. */
export function serializeMaskShape(model: MaskShapeModel): string {
  const { pts, closed } = model;
  if (pts.length === 0) return '';
  const out: string[] = [`M ${n4(pts[0]!.x)},${n4(pts[0]!.y)}`];
  const seg = (a: MaskVertex, b: MaskVertex): string => {
    if (!a.hOut && !b.hIn) return `L ${n4(b.x)},${n4(b.y)}`;
    const c1 = a.hOut ?? { x: a.x, y: a.y };
    const c2 = b.hIn ?? { x: b.x, y: b.y };
    return `C ${n4(c1.x)},${n4(c1.y)} ${n4(c2.x)},${n4(c2.y)} ${n4(b.x)},${n4(b.y)}`;
  };
  for (let i = 1; i < pts.length; i++) out.push(seg(pts[i - 1]!, pts[i]!));
  if (closed && pts.length > 1) {
    const last = pts[pts.length - 1]!;
    const first = pts[0]!;
    // 닫는 구간이 직선이면 `Z` 만 쓴다 — `Z` 자체가 직선으로 닫는다. 굳이 `L` 을 앞에 쓰면
    // 같은 모양인데 명령 구성이 달라져 dKeys 보간이 «정점 수가 다르다»고 거절한다.
    if (last.hOut || first.hIn) out.push(seg(last, first));
    out.push('Z');
  }
  return out.join(' ');
}

/** 원을 `C` 4개로 근사한다 (오차 0.03%) — `A`(호) 명령을 문법에 넣지 않기 위한 것. */
export const CIRCLE_K = 0.5522847498307936;

export function circleShape(cx: number, cy: number, r: number): MaskShapeModel {
  const k = r * CIRCLE_K;
  return {
    closed: true,
    pts: [
      { x: cx, y: cy - r, hIn: { x: cx - k, y: cy - r }, hOut: { x: cx + k, y: cy - r } },
      { x: cx + r, y: cy, hIn: { x: cx + r, y: cy - k }, hOut: { x: cx + r, y: cy + k } },
      { x: cx, y: cy + r, hIn: { x: cx + k, y: cy + r }, hOut: { x: cx - k, y: cy + r } },
      { x: cx - r, y: cy, hIn: { x: cx - r, y: cy + k }, hOut: { x: cx - r, y: cy - k } },
    ],
  };
}

// ── 선 위의 점 (선 위 클릭 → 그 자리에 점 삽입) ──────────────────────────

function bezierAt(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
    y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
  };
}

/** 구간 i(=pts[i]→pts[i+1]) 위의 t 지점. 닫힌 마지막 구간은 i === pts.length-1. */
export function segmentPoint(model: MaskShapeModel, i: number, t: number): Pt | null {
  const { pts, closed } = model;
  const a = pts[i];
  const b = pts[(i + 1) % pts.length];
  if (!a || !b) return null;
  if (i === pts.length - 1 && !closed) return null;
  if (!a.hOut && !b.hIn) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  return bezierAt(a, a.hOut ?? a, b.hIn ?? b, b, t);
}

/** 클릭 지점에 가장 가까운 선 위의 자리. 없으면 null. */
export function nearestOnPath(
  model: MaskShapeModel,
  p: Pt,
  samples = 24,
): { segment: number; t: number; point: Pt; dist: number } | null {
  const segCount = model.closed ? model.pts.length : model.pts.length - 1;
  let best: { segment: number; t: number; point: Pt; dist: number } | null = null;
  for (let i = 0; i < segCount; i++) {
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const q = segmentPoint(model, i, t);
      if (!q) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.dist) best = { segment: i, t, point: q, dist: d };
    }
  }
  return best;
}

/**
 * 구간 i 의 t 자리에 점을 넣는다. 곡선 구간은 de Casteljau 로 **모양을 그대로 둔 채** 쪼갠다
 * (그냥 점만 끼우면 곡선이 눈에 띄게 튄다).
 */
export function insertVertex(model: MaskShapeModel, i: number, t: number): MaskShapeModel {
  const pts = model.pts.map((v) => ({ ...v, ...(v.hIn ? { hIn: { ...v.hIn } } : {}), ...(v.hOut ? { hOut: { ...v.hOut } } : {}) }));
  const a = pts[i];
  const bIdx = (i + 1) % pts.length;
  const b = pts[bIdx];
  if (!a || !b) return model;
  if (!a.hOut && !b.hIn) {
    const np: MaskVertex = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    pts.splice(i + 1, 0, np);
    return { ...model, pts };
  }
  const c1 = a.hOut ?? { x: a.x, y: a.y };
  const c2 = b.hIn ?? { x: b.x, y: b.y };
  const lerp = (p: Pt, q: Pt): Pt => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const p01 = lerp(a, c1);
  const p12 = lerp(c1, c2);
  const p23 = lerp(c2, b);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);
  a.hOut = p01;
  b.hIn = p23;
  pts.splice(i + 1, 0, { x: mid.x, y: mid.y, hIn: p012, hOut: p123 });
  return { ...model, pts };
}
