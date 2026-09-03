// 궤적 간소화 (W8 F10) — Ramer–Douglas–Peucker. 순수 함수, 외부 의존 없음.
//
// 왜 필요한가: 30초 30fps 를 매 프레임 추적하면 900프레임 × 4경로(mask.x/y/w/h) =
// **3,600 키프레임**이다. 키프레임 1개가 JSON 약 60바이트니 클립 하나에 216KB,
// 컷 10개면 2MB 짜리 프로젝트 파일이 된다.
//
// **채널을 따로 줄이면 안 된다.** x 와 y 가 서로 다른 시각에 키프레임을 가지면 그 사이에서
// 사각형이 미묘하게 흔들린다. 그래서 (x,y) 를 2차원 궤적으로, (w,h) 를 2차원 궤적으로
// 각각 RDP 한 뒤 **남은 시각의 합집합**에 네 값을 모두 심는다.

/** 시각 t 에서의 2차원 점. */
export type Pt2 = { t: number; a: number; b: number };

/**
 * 두 키프레임 p·q 사이를 **시각으로** 선형보간했을 때, 같은 시각의 r 과 얼마나 벌어지는가.
 *
 * 교과서 RDP 는 (a,b) 평면에서의 «수직» 거리를 쓴다. 그건 여기서 틀린 자를 대는 것이다 —
 * 렌더러는 키프레임 사이를 **시각으로** 보간하지 궤적 위의 최단점으로 보간하지 않는다.
 * 수직 거리로 자르면 「허용 오차 0.5px」로 줄인 궤적이 실제로는 1.5px 어긋난다(실측).
 * 그래서 «보간이 실제로 하는 계산»과 같은 자를 쓴다.
 */
function timeInterpError(p: Pt2, q: Pt2, r: Pt2): number {
  const span = q.t - p.t;
  const u = span === 0 ? 0 : (r.t - p.t) / span;
  return Math.hypot(p.a + (q.a - p.a) * u - r.a, p.b + (q.b - p.b) * u - r.b);
}

/** 오차 자 — 구간 끝점 두 개(lo·hi)와 그 사이 점 i 의 「보간했을 때의 벌어짐」. */
type ErrFn = (lo: number, hi: number, i: number) => number;

/** 공통 RDP 골격. 인덱스만 다루고 오차 계산은 `err` 에 맡긴다. */
function rdpCore(n: number, tolerance: number, err: ErrFn): number[] {
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const tol = Math.max(0, tolerance);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // 재귀 대신 명시 스택 — 900프레임이면 최악의 경우 재귀 깊이가 900이다.
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    let far = -1;
    let maxD = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = err(lo, hi, i);
      if (d > maxD) {
        maxD = d;
        far = i;
      }
    }
    if (maxD > tol && far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * RDP — 남긴 점만 **시각으로** 선형보간했을 때 원래 궤적에서 `tolerance` 이상 벗어나지 않는
 * 최소 점 집합의 **인덱스**를 돌려준다. 항상 첫 점과 끝 점을 포함하고 오름차순이다.
 * 입력은 시각 오름차순이어야 한다.
 */
export function rdpIndices(points: readonly Pt2[], tolerance: number): number[] {
  return rdpCore(points.length, tolerance, (lo, hi, i) =>
    timeInterpError(points[lo]!, points[hi]!, points[i]!),
  );
}

/** 추적 결과 한 프레임 — 간소화는 좌표계를 모른다(픽셀이든 정규화든 같은 단위면 된다). */
export type BoxSample = { t: number; x: number; y: number; w: number; h: number };

export type SimplifyReport = {
  /** 남긴 시각 (오름차순) */
  times: number[];
  /** 간소화 전 점 개수 */
  before: number;
  /** 간소화 후 점 개수 */
  after: number;
  /** 남긴 점만 선형보간했을 때 원래 궤적과의 최대 편차 (x·y·w·h 중 최댓값, 같은 단위) */
  maxDeviation: number;
};

/**
 * 상자 궤적을 간소화한다. 입력은 시각 오름차순이어야 한다(추적 결과가 그렇다).
 *
 * **네 채널이 «같은 시각»을 갖게 한다.** x 와 y 가 서로 다른 시각에 키프레임을 가지면 그
 * 사이에서 사각형이 흔들린다. 그래서 (x,y) 와 (w,h) 를 각각 2차원으로 보고, 두 오차의
 * **큰 쪽**을 자로 삼아 **한 번에** RDP 한다.
 *
 * (두 번 RDP 해서 시각을 합집합하는 방법도 있지만 그건 허용 오차를 «보장하지 못한다» —
 *  받아들여진 구간을 나중에 다른 점에서 쪼개면 그 안의 오차가 다시 커질 수 있다. 실측으로
 *  허용 0.5px 이 1.5px 로 벌어졌다. 한 번에 하면 RDP 의 보장이 그대로 남는다.)
 */
export function simplifyBoxTrack(samples: readonly BoxSample[], tolerance: number): SimplifyReport {
  if (samples.length === 0) return { times: [], before: 0, after: 0, maxDeviation: 0 };
  if (samples.length <= 2) {
    return {
      times: samples.map((s) => s.t),
      before: samples.length,
      after: samples.length,
      maxDeviation: 0,
    };
  }

  const err = (lo: number, hi: number, i: number): number => {
    const a = samples[lo]!;
    const b = samples[hi]!;
    const p = samples[i]!;
    const span = b.t - a.t;
    const u = span === 0 ? 0 : (p.t - a.t) / span;
    const at = (k: keyof BoxSample): number => a[k] + (b[k] - a[k]) * u - p[k];
    return Math.max(Math.hypot(at('x'), at('y')), Math.hypot(at('w'), at('h')));
  };

  const idx = rdpCore(samples.length, tolerance, err);
  return {
    times: idx.map((i) => samples[i]!.t),
    before: samples.length,
    after: idx.length,
    maxDeviation: maxTrackDeviation(samples, idx),
  };
}

/**
 * 남긴 인덱스만으로 선형보간했을 때 원래 궤적과의 **최대 편차**.
 * 「0.5px 로 줄였다」는 말이 실제로 0.5px 인지 재는 데 쓴다.
 */
export function maxTrackDeviation(samples: readonly BoxSample[], keptIdx: readonly number[]): number {
  if (keptIdx.length < 2) return 0;
  let worst = 0;
  let seg = 0;
  for (let i = 0; i < samples.length; i++) {
    while (seg + 1 < keptIdx.length - 1 && keptIdx[seg + 1]! < i) seg++;
    const lo = samples[keptIdx[seg]!]!;
    const hi = samples[keptIdx[seg + 1]!]!;
    const span = hi.t - lo.t;
    const u = span === 0 ? 0 : (samples[i]!.t - lo.t) / span;
    const s = samples[i]!;
    worst = Math.max(
      worst,
      Math.abs(lo.x + (hi.x - lo.x) * u - s.x),
      Math.abs(lo.y + (hi.y - lo.y) * u - s.y),
      Math.abs(lo.w + (hi.w - lo.w) * u - s.w),
      Math.abs(lo.h + (hi.h - lo.h) * u - s.h),
    );
  }
  return worst;
}
