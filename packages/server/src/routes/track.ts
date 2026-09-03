// F10 마스크 모션 트래킹 — HTTP + track 잡.
//
// 추적기(파이썬)는 **소스 픽셀**로 답하고 `Mask` 는 **클립 상자 대비 0..1** 을 받는다.
// 그 사이에 contain-fit 과 크롭과 시간축(speed·reversed·speedRamp·loop)이 있다.
// 그 변환이 이 파일의 절반이고, 사람이 제일 많이 틀리는 곳이다.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { findClip } from '@kitkat/engine';
import {
  rampSegments,
  type Asset,
  type Clip,
  type Keyframe,
  type ProjectDoc,
  type VideoClip,
} from '@kitkat/schema';
import { simplifyBoxTrack, type BoxSample } from '@kitkat/media';
import {
  classifyTrack,
  isTrackerReady,
  mergeTrackedFrames,
  trackBox,
  TrackerUnavailableError,
  DEFAULT_SCORE_THRESHOLD,
  type ClassifiedFrame,
} from '@kitkat/ai';
import { sendError, type AppContext } from '../app.js';

/** 마스크 상자를 이루는 네 경로 — 항상 «같은 시각»에 네 개가 함께 들어간다. */
export const MASK_BOX_PATHS = ['mask.x', 'mask.y', 'mask.w', 'mask.h'] as const;

/**
 * 키프레임 간소화 허용 오차 기본값 — **소스 픽셀**. **4px 는 재서 정한 값이다.**
 *
 * 계획서는 0.5px 을 기본으로 제안하며 「80% 이상 줄 것」으로 봤다. **둘 다 틀렸다.**
 * TrackerVit 은 상자를 «정수 픽셀»로 돌려주고 프레임마다 1~2px 씩 떨린다. 그 떨림이
 * 0.5px 보다 크므로 **0.5px 에서는 한 점도 줄지 않는다(감소율 0.0%).**
 *
 * 합성 영상 5종(직선 팬 / 사인파 왕복 / 1.0→2.0배 확대 / 빠른 왕복 720p / 세로 1080×1920):
 *
 * | tolerancePx | 감소율 | 정답 대비 중심오차 평균 변화 | 정답 대비 최대 오차 |
 * |---|---|---|---|
 * | 0.5 | 0.0%      | 0.00px | 그대로 |
 * | 2   | 4 ~ 13%   | ≤0.03px | 그대로 |
 * | **4** | **19 ~ 56%** | **≤0.07px** | **5종 모두 그대로** |
 * | 6   | 40 ~ 75%  | ≤0.09px | 1종만 7.18→8.54px |
 * | 10  | 77 ~ 94%  | ≤0.80px | 3종에서 커짐 |
 *
 * 4px 을 고른 이유: **추적기 자신의 오차(중심오차 평균 3.2~4.6px)보다 작으면서**
 * 5종 «전부» 정답 대비 최대 오차가 한 픽셀도 안 커지는 가장 큰 값이다.
 * 즉 「간소화 때문에 나빠졌다」가 실측으로 0 이다. 더 줄이고 싶으면 UI 슬라이더로 6~10 을 준다.
 */
export const DEFAULT_TOLERANCE_PX = 4;

const DEFAULT_CROP = { x: 0, y: 0, w: 1, h: 1 } as const;

export type NormBox = { x: number; y: number; w: number; h: number };

// ── 좌표 변환 ─────────────────────────────────────────────────────────────
//
// computeVisualLayout(renderer/layout/index.ts) 에서 그대로 유도된다:
//   fit = min(canvasW/aw, canvasH/ah);  boxW = aw·fit·crop.w
//   소스px sx → 상자로컬px = sx·fit − crop.x·fitW → 정규화 nx = (sx/aw − crop.x)/crop.w
//
// **캔버스 크기·scale·rotation 이 여기 안 들어가는 것이 핵심이다** — 그것들은 상자 «전체»에
// 걸리고 마스크는 상자 «안»에 산다. 그래서 클립을 나중에 확대·회전해도 추적 결과가 그대로 유효하다.

/** 소스 픽셀 상자 → 마스크 정규화 상자. `aw`·`ah` 는 추적한 파일의 실제 크기. */
export function maskNormFromSourcePx(
  px: NormBox,
  aw: number,
  ah: number,
  crop: { x: number; y: number; w: number; h: number } = DEFAULT_CROP,
): NormBox {
  return {
    x: (px.x / aw - crop.x) / crop.w,
    y: (px.y / ah - crop.y) / crop.h,
    w: px.w / aw / crop.w,
    h: px.h / ah / crop.h,
  };
}

/** 마스크 정규화 상자 → 소스 픽셀 상자 (위의 역함수). */
export function sourcePxFromMaskNorm(
  n: NormBox,
  aw: number,
  ah: number,
  crop: { x: number; y: number; w: number; h: number } = DEFAULT_CROP,
): NormBox {
  return {
    x: (n.x * crop.w + crop.x) * aw,
    y: (n.y * crop.h + crop.y) * ah,
    w: n.w * crop.w * aw,
    h: n.h * crop.h * ah,
  };
}

// ── 시간축 변환 ───────────────────────────────────────────────────────────

export type TimeMap = {
  /** 클립 시작 기준 ms → 디코드할 파일의 ms */
  fileMs: (clipMs: number) => number;
  /** 디코드할 파일의 ms → 클립 시작 기준 ms (구간 밖이면 null) */
  clipMs: (fileMs: number) => number | null;
  /** 한 바퀴 길이(ms) — loop 클립은 이 길이가 clip.duration 까지 반복된다 */
  passMs: number;
};

/**
 * 클립이 실제로 디코드할 파일과 그 안의 구간.
 *
 * 역재생 클립은 **역재생 파일이 곧 원본**이고 구간이 미러링된다
 * (renderer/composition/media-src.ts 의 resolveMediaWindow 와 같은 규칙).
 * 그래서 시간 계산에 `reversed` 특수 처리가 따로 필요 없다 — 미러링이 구간에 이미 들어 있다.
 *
 * 파생 파일(색보정·모션블러)은 **쓰지 않는다.** 해상도가 같고 물체 위치도 같으므로
 * 원본에서 추적한 결과가 그대로 맞는다.
 */
export function decodeWindow(
  clip: VideoClip,
  asset: Asset,
): { rel: string; inMs: number; outMs: number } {
  if (clip.reversed === true && asset.reversedSrc && asset.duration != null) {
    return { rel: asset.reversedSrc, inMs: asset.duration - clip.out, outMs: asset.duration - clip.in };
  }
  return { rel: asset.src, inMs: clip.in, outMs: clip.out };
}

/**
 * 클립 ms ↔ 파일 ms.
 * - 보통: `fileMs = winIn + clipMs · speed`
 * - `speedRamp`: `rampSegments` 가 주는 등속 구간별로 역산 (구간 이진탐색 + 선형보간)
 * - `loop`: 한 바퀴만 계산한다. 반복 복제는 호출부가 한다.
 */
export function clipTimeMap(clip: VideoClip, asset: Asset): TimeMap {
  const win = decodeWindow(clip, asset);
  const offset = win.inMs - clip.in; // 미러링 보정 (정방향이면 0)
  const segs = clip.speedRamp ? rampSegments(clip) : [];

  if (segs.length === 0) {
    const speed = clip.speed > 0 ? clip.speed : 1;
    const passMs = Math.max(1, Math.round((clip.out - clip.in) / speed));
    return {
      passMs,
      fileMs: (t) => clip.in + t * speed + offset,
      clipMs: (f) => {
        const t = (f - offset - clip.in) / speed;
        return t >= -0.5 && t <= passMs + 0.5 ? t : null;
      },
    };
  }

  const passMs = segs.reduce((a, s) => Math.max(a, s.startMs + s.durationMs), 0);
  return {
    passMs,
    fileMs: (t) => {
      const s = segs.find((g) => t < g.startMs + g.durationMs) ?? segs[segs.length - 1]!;
      const u = s.durationMs > 0 ? (t - s.startMs) / s.durationMs : 0;
      return s.inMs + (s.outMs - s.inMs) * u + offset;
    },
    clipMs: (f) => {
      const src = f - offset;
      const s = segs.find((g) => src < g.outMs) ?? segs[segs.length - 1]!;
      const span = s.outMs - s.inMs;
      const u = span > 0 ? (src - s.inMs) / span : 0;
      const t = s.startMs + s.durationMs * u;
      return t >= -0.5 && t <= passMs + 0.5 ? t : null;
    },
  };
}

// ── 요청 검증 ─────────────────────────────────────────────────────────────

/**
 * 어느 쪽으로 추적하나. **기본은 `forward` 다 — 바꾸지 않는 것이 결정이었다.**
 *
 * 사용자가 제일 원하는 것은 「클립 중간에서 대상을 찾아 앞뒤로 한 번에」(`both`)다.
 * 그런데 이걸 «기본»으로 두면 지금 있는 호출자가 조용히 다르게 동작한다:
 * 「여기서 다시 추적」은 **앞쪽 키프레임은 그대로 둔다**고 버튼 툴팁에 적혀 있는데,
 * 기본이 `both` 가 되면 그 약속을 어기고 앞쪽을 덮어쓴다. 기본값 하나로 이미 만든
 * 결과를 지우는 것은 되돌리기 한 번으로 끝나더라도 놀랄 일이다.
 * 그래서 **`both` 는 UI 가 명시적으로 켜는 것**이고 기본은 지금과 같은 `forward` 다.
 */
export type RequestDirection = 'forward' | 'backward' | 'both';

export type TrackRequest = {
  box: NormBox;
  /** 기준 상자의 시각 — 클립 기준 ms. 앞·뒤 두 패스가 여기서 갈라진다. */
  startMs: number;
  /** 앞으로(forward) 갈 때의 끝 — 클립 기준 ms. 기본 클립 끝. */
  endMs: number;
  /** 뒤로(backward) 갈 때의 끝 — 클립 기준 ms. 기본 0(클립 처음). */
  backEndMs: number;
  direction: RequestDirection;
  tolerancePx: number;
  scoreThreshold: number;
  stride: number;
};

type Validated =
  | { ok: true; req: TrackRequest; clip: VideoClip; asset: Asset }
  | { ok: false; code: number; error: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateTrackRequest(
  doc: ProjectDoc,
  clipId: string,
  body: Record<string, unknown>,
): Validated {
  const found = findClip(doc, clipId);
  if (!found) return { ok: false, code: 404, error: `클립 없음: ${clipId}` };
  const clip: Clip = found.clip;
  if (clip.kind !== 'video') {
    return { ok: false, code: 400, error: 'BAD_TRACK: 모션 트래킹은 비디오 클립에만 걸 수 있습니다' };
  }
  if (clip.freeze === true) {
    return {
      ok: false,
      code: 400,
      error: 'BAD_TRACK: 정지화면 클립은 추적할 것이 없습니다 (한 프레임이 계속 보입니다)',
    };
  }
  if (!clip.mask) {
    if (clip.masks && clip.masks.length > 1) {
      return {
        ok: false,
        code: 400,
        error:
          `BAD_TRACK: 마스크가 ${clip.masks.length}장이라 추적할 수 없습니다 — ` +
          '`mask.x` 는 한 장짜리 마스크를 가리키는 이름입니다. 한 장만 남기고 추적하세요.',
      };
    }
    return {
      ok: false,
      code: 400,
      error: 'BAD_TRACK: 먼저 마스크를 켜고 대상 위에 맞춘 뒤 추적하세요 — 그 상자가 추적 시작점입니다',
    };
  }
  const asset = doc.assets[clip.assetId];
  if (!asset) return { ok: false, code: 404, error: `에셋 없음: ${clip.assetId}` };
  if (!asset.width || !asset.height) {
    return { ok: false, code: 400, error: 'BAD_TRACK: 에셋의 해상도를 아직 모릅니다 (분석이 끝난 뒤 다시 시도하세요)' };
  }

  const raw = body.box;
  let box: NormBox;
  if (raw === undefined) {
    box = { x: clip.mask.x, y: clip.mask.y, w: clip.mask.w, h: clip.mask.h };
  } else {
    const b = raw as Record<string, unknown>;
    if (!(['x', 'y', 'w', 'h'] as const).every((k) => isNum(b[k]))) {
      return { ok: false, code: 400, error: 'BAD_TRACK: box 는 {x,y,w,h} 숫자여야 합니다' };
    }
    box = { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number };
  }
  if (!(box.w > 0) || !(box.h > 0)) {
    return { ok: false, code: 400, error: 'BAD_TRACK: box 의 크기가 0입니다 — 0픽셀은 추적할 수 없습니다' };
  }

  let startMs = 0;
  if (body.startMs !== undefined) {
    if (!isNum(body.startMs) || body.startMs < 0) {
      return { ok: false, code: 400, error: 'BAD_TRACK: startMs 는 0 이상이어야 합니다' };
    }
    startMs = Math.round(body.startMs);
  }
  let endMs = clip.duration;
  if (body.endMs !== undefined) {
    if (!isNum(body.endMs)) return { ok: false, code: 400, error: 'BAD_TRACK: endMs 가 숫자가 아닙니다' };
    endMs = Math.round(body.endMs);
  }
  endMs = Math.min(endMs, clip.duration);

  let backEndMs = 0;
  if (body.backEndMs !== undefined) {
    if (!isNum(body.backEndMs) || body.backEndMs < 0) {
      return { ok: false, code: 400, error: 'BAD_TRACK: backEndMs 는 0 이상이어야 합니다' };
    }
    backEndMs = Math.round(body.backEndMs);
  }
  backEndMs = Math.max(0, Math.min(backEndMs, startMs));

  let direction: RequestDirection = 'forward';
  if (body.direction !== undefined) {
    if (body.direction !== 'forward' && body.direction !== 'backward' && body.direction !== 'both') {
      return {
        ok: false,
        code: 400,
        error: "BAD_TRACK: direction 은 'forward' · 'backward' · 'both' 중 하나여야 합니다",
      };
    }
    direction = body.direction;
  }

  // 방향에 따라 «비어 있는가» 의 뜻이 다르다. both 는 한쪽만 있어도 된다
  // (클립 처음에서 both 를 눌러도 앞으로만 도는 것이 자연스럽다).
  const hasFwd = endMs > startMs;
  const hasBack = startMs > backEndMs;
  const need =
    direction === 'forward' ? hasFwd : direction === 'backward' ? hasBack : hasFwd || hasBack;
  if (!need) {
    const what =
      direction === 'backward'
        ? `뒤로 갈 구간이 없습니다 (${backEndMs}..${startMs}ms) — 기준이 클립 처음입니다`
        : direction === 'both'
          ? `앞뒤 어느 쪽도 갈 구간이 없습니다 (${backEndMs}..${startMs}..${endMs}ms)`
          : `추적 구간이 비어 있습니다 (${startMs}..${endMs}ms)`;
    return { ok: false, code: 400, error: `BAD_TRACK: ${what}` };
  }

  let tolerancePx = DEFAULT_TOLERANCE_PX;
  const tolRaw = body.tolerancePx ?? body.tolerance;
  if (tolRaw !== undefined) {
    if (!isNum(tolRaw) || tolRaw < 0 || tolRaw > 100) {
      return { ok: false, code: 400, error: 'BAD_TRACK: tolerancePx 는 0..100 이어야 합니다' };
    }
    tolerancePx = tolRaw;
  }

  let scoreThreshold = DEFAULT_SCORE_THRESHOLD;
  if (body.scoreThreshold !== undefined) {
    if (!isNum(body.scoreThreshold) || body.scoreThreshold < 0 || body.scoreThreshold > 1) {
      return { ok: false, code: 400, error: 'BAD_TRACK: scoreThreshold 는 0..1 이어야 합니다' };
    }
    scoreThreshold = body.scoreThreshold;
  }

  let stride = 1;
  if (body.stride !== undefined) {
    if (!isNum(body.stride) || !Number.isInteger(body.stride) || body.stride < 1 || body.stride > 30) {
      return { ok: false, code: 400, error: 'BAD_TRACK: stride 는 1..30 의 정수여야 합니다' };
    }
    stride = body.stride;
  }

  return {
    ok: true,
    req: { box, startMs, endMs, backEndMs, direction, tolerancePx, scoreThreshold, stride },
    clip,
    asset,
  };
}

// ── 결과 → 키프레임 ───────────────────────────────────────────────────────

export type TrackKeyframeResult = {
  keyframes: Keyframe[];
  /** 추적 실패 구간 — **클립 기준 ms** */
  gaps: { startMs: number; endMs: number }[];
  /** 간소화 전 «상자» 개수 (키프레임 개수는 그 4배) */
  before: number;
  after: number;
  /** 남긴 키프레임만 보간했을 때 원래 궤적과의 최대 편차 (소스 픽셀) */
  maxDeviationPx: number;
  /** 성공 프레임 수 / 전체 프레임 수 */
  tracked: number;
  total: number;
};

/**
 * 추적 결과(소스 픽셀·파일 ms) → mask.x/y/w/h 키프레임(클립 정규화·클립 ms).
 *
 * - **ok:false 프레임은 키프레임을 만들지 않는다.** 앞뒤를 이어 보간하면 마스크가 대상을
 *   스르르 지나가면서 「추적된 것처럼」 보인다. 비워 두고 UI 가 빨갛게 표시한다.
 * - 성공 구간마다 «따로» 간소화한다. 실패 구간을 사이에 두고 이어서 간소화하면
 *   RDP 가 그 구간을 가로지르는 직선 하나로 뭉갠다.
 */
export function trackToKeyframes(args: {
  frames: { ms: number; x: number; y: number; w: number; h: number; ok: boolean }[];
  clip: VideoClip;
  asset: Asset;
  fileW: number;
  fileH: number;
  tolerancePx: number;
}): TrackKeyframeResult {
  const { frames, clip, asset, fileW, fileH, tolerancePx } = args;
  const map = clipTimeMap(clip, asset);
  const crop = clip.crop ?? DEFAULT_CROP;

  // 파일 ms → 클립 ms 로 옮기고 클립 밖은 버린다
  type Row = { t: number; px: NormBox; ok: boolean };
  const rows: Row[] = [];
  for (const f of frames) {
    const t = map.clipMs(f.ms);
    if (t === null) continue;
    rows.push({ t, px: { x: f.x, y: f.y, w: f.w, h: f.h }, ok: f.ok });
  }
  rows.sort((a, b) => a.t - b.t);

  const total = rows.length;
  const tracked = rows.filter((r) => r.ok).length;

  // 성공 구간(run) 단위로 나눈다
  const runs: Row[][] = [];
  let cur: Row[] = [];
  for (const r of rows) {
    if (r.ok) cur.push(r);
    else if (cur.length > 0) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) runs.push(cur);

  const keyTimes: number[] = [];
  let before = 0;
  let after = 0;
  let maxDeviationPx = 0;
  for (const run of runs) {
    const samples: BoxSample[] = run.map((r) => ({ t: r.t, ...r.px }));
    const rep = simplifyBoxTrack(samples, tolerancePx);
    keyTimes.push(...rep.times);
    before += rep.before;
    after += rep.after;
    maxDeviationPx = Math.max(maxDeviationPx, rep.maxDeviation);
  }

  const byTime = new Map(rows.map((r) => [r.t, r]));
  const keyframes: Keyframe[] = [];
  // 키프레임 time 은 정수 ms 다. 배속이 아주 크거나 loop 이음매에서는 이웃한 두 프레임이
  // 같은 정수로 반올림될 수 있는데, 같은 시각·같은 경로의 키프레임 두 개는 «둘 중 어느 쪽이
  // 이기는지»가 보간 구현에 달린 값이 된다. 먼저 온 것만 남긴다.
  const emitted = new Set<number>();
  // loop 클립은 한 바퀴 결과를 duration 까지 반복 복제한다 (소스 구간이 되풀이되므로)
  const reps =
    clip.loop === true && map.passMs > 0 ? Math.ceil(clip.duration / map.passMs) : 1;
  for (let k = 0; k < reps; k++) {
    const shift = k * map.passMs;
    for (const t of keyTimes) {
      const row = byTime.get(t);
      if (!row) continue;
      const time = Math.round(t + shift);
      if (time < 0 || time > clip.duration) continue;
      if (emitted.has(time)) continue;
      emitted.add(time);
      const n = maskNormFromSourcePx(row.px, fileW, fileH, crop);
      keyframes.push(
        { time, prop: 'mask.x', value: n.x, easing: 'linear' },
        { time, prop: 'mask.y', value: n.y, easing: 'linear' },
        { time, prop: 'mask.w', value: n.w, easing: 'linear' },
        { time, prop: 'mask.h', value: n.h, easing: 'linear' },
      );
    }
  }

  // 실패 구간 (클립 ms). 시각 순서대로 ok:false 가 이어진 덩어리.
  const gaps: { startMs: number; endMs: number }[] = [];
  let gs: number | null = null;
  let ge = 0;
  for (const r of rows) {
    if (!r.ok) {
      gs ??= r.t;
      ge = r.t;
    } else if (gs !== null) {
      gaps.push({ startMs: Math.round(gs), endMs: Math.round(ge) });
      gs = null;
    }
  }
  if (gs !== null) gaps.push({ startMs: Math.round(gs), endMs: Math.round(ge) });

  return { keyframes, gaps, before, after, maxDeviationPx, tracked, total };
}

/**
 * 새 키프레임을 기존 것과 합친다.
 * 추적 구간 [startMs, endMs] 안의 **mask 상자 키프레임만** 갈아 끼우고 나머지는 그대로 둔다 —
 * 「여기서부터 다시 추적」이 앞쪽 결과를 지우지 않게 하는 규칙이다.
 */
export function mergeMaskKeyframes(
  existing: readonly Keyframe[],
  added: readonly Keyframe[],
  startMs: number,
  endMs: number,
): Keyframe[] {
  const boxProps = new Set<string>(MASK_BOX_PATHS);
  const kept = existing.filter(
    (k) => !(boxProps.has(k.prop) && k.time >= startMs && k.time <= endMs),
  );
  return [...kept, ...added].sort((a, b) => a.time - b.time);
}

/** 추적 띠용 점수 — 최대 `max` 점으로 솎는다. 실패 프레임은 «절대 버리지 않는다». */
export function sampleScores(
  frames: readonly { ms: number; score: number; ok: boolean }[],
  map: TimeMap,
  max = 200,
): { t: number; s: number; ok: boolean }[] {
  const step = Math.max(1, Math.ceil(frames.length / max));
  const out: { t: number; s: number; ok: boolean }[] = [];
  frames.forEach((f, i) => {
    if (i % step !== 0 && f.ok && (frames[i - 1]?.ok ?? true) && (frames[i + 1]?.ok ?? true)) return;
    const t = map.clipMs(f.ms);
    if (t === null) return;
    out.push({ t: Math.round(t), s: Math.round(f.score * 100) / 100, ok: f.ok });
  });
  return out;
}

// ── 라우트 ────────────────────────────────────────────────────────────────

export function registerTrackRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/projects/:id/clips/:clipId/track', async (req, reply) => {
    const { id, clipId } = req.params as { id: string; clipId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const doc = await ctx.store.get(id);
      const v = validateTrackRequest(doc, clipId, body);
      if (!v.ok) return reply.code(v.code).send({ error: v.error });

      // 미설치 → 501. **설치를 여기서 시도하지 않는다** — 43.8MB 휠을 요청 처리 중에
      // 기다리면 클라이언트가 먼저 타임아웃난다 (separate 라우트와 같은 이유).
      if (!(await isTrackerReady())) {
        return reply.code(501).send({
          error:
            '모션 트래킹 엔진(OpenCV TrackerVit)이 설치되어 있지 않습니다. ' +
            '`node scripts/prewarm.mjs tracker` 로 먼저 설치하세요 (약 90MB + 모델 0.7MB, 최초 1회).',
        });
      }

      const { req: treq } = v;
      const job = ctx.jobs.enqueue(
        'track',
        id,
        async (_job, report, signal) => {
          const docNow = await ctx.store.get(id);
          const nowV = validateTrackRequest(docNow, clipId, body);
          if (!nowV.ok) throw new Error(nowV.error);
          const { clip, asset } = nowV;

          const map = clipTimeMap(clip, asset);
          const win = decodeWindow(clip, asset);
          // loop 클립은 한 바퀴만 추적한다 (그 뒤는 같은 소스가 되풀이될 뿐이다)
          const endClipMs = Math.min(treq.endMs, clip.loop === true ? map.passMs : treq.endMs);
          const backClipMs = Math.max(0, Math.min(treq.backEndMs, treq.startMs));
          const anchorFileMs = Math.max(0, Math.round(map.fileMs(treq.startMs)));
          const fwdFileMs = Math.max(0, Math.round(map.fileMs(endClipMs)));
          const backFileMs = Math.max(0, Math.round(map.fileMs(backClipMs)));

          const crop = clip.crop ?? DEFAULT_CROP;
          const aw = asset.width!;
          const ah = asset.height!;
          const px = sourcePxFromMaskNorm(treq.box, aw, ah, crop);
          if (px.w < 2 || px.h < 2) {
            throw new Error(`추적 상자가 소스에서 ${px.w.toFixed(1)}×${px.h.toFixed(1)}px 로 너무 작습니다`);
          }

          // 돌릴 패스. 기준 시각에서 앞·뒤가 **각각 한 번의 파이썬 실행**이다.
          // (한 프로세스에서 둘을 하면 역방향이 끝난 뒤 트래커를 다시 init 해야 하는데,
          //  그러면 취소·진행률·실패 판정이 한 덩어리로 엉킨다. 두 번 도는 편이 싸다.)
          const passes: { direction: 'forward' | 'backward'; farMs: number; span: number }[] = [];
          if (treq.direction !== 'backward' && fwdFileMs - anchorFileMs >= 1) {
            passes.push({ direction: 'forward', farMs: fwdFileMs, span: fwdFileMs - anchorFileMs });
          }
          if (treq.direction !== 'forward' && anchorFileMs - backFileMs >= 1) {
            passes.push({ direction: 'backward', farMs: backFileMs, span: anchorFileMs - backFileMs });
          }
          if (passes.length === 0) throw new Error('추적 구간이 소스에서 1ms 미만입니다');

          // 진행률은 앞·뒤를 **합쳐 하나로** 낸다 — 구간 길이로 나눠 가진다.
          const spanAll = passes.reduce((a, p) => a + p.span, 0) || 1;
          let fileW = 0;
          let fileH = 0;
          let fps = 0;
          const perPass: ClassifiedFrame[][] = [];
          let base = 0;
          for (const pass of passes) {
            const weight = pass.span / spanAll;
            const at = base;
            const raw = await trackBox(path.join(ctx.mediaDir, win.rel), {
              box: px,
              startMs: anchorFileMs,
              endMs: pass.farMs,
              direction: pass.direction,
              stride: treq.stride,
              signal,
              // 프레임 수는 파이썬이 «실제로 센» 값이다 — fps 를 추측해 만든 숫자가 아니다.
              onProgress: (p, done, total) =>
                report(
                  at + p * weight,
                  (total > 0 ? `${done}/${total} 프레임` : `${done} 프레임`) +
                    (passes.length > 1 ? (pass.direction === 'forward' ? ' · 뒤쪽' : ' · 앞쪽') : ''),
                ),
            });
            base += weight;
            fps = raw.fps || fps;
            fileW = raw.width || fileW;
            fileH = raw.height || fileH;
            // **판정은 패스마다 따로 한다.** 「3연속 실패 뒤는 전부 실패」가 «추적 순서» 규칙이라
            // 두 방향을 시간순으로 먼저 이어 붙이면 역방향 쪽 규칙이 뒤집힌다.
            perPass.push(
              classifyTrack(raw.frames, {
                anchor: { w: px.w, h: px.h },
                frameW: raw.width || aw,
                frameH: raw.height || ah,
                scoreThreshold: treq.scoreThreshold,
              }),
            );
          }
          // 시간순 한 줄로 합친다 (기준 프레임은 한 벌만 남는다)
          const classified = mergeTrackedFrames(...perPass);

          const out = trackToKeyframes({
            frames: classified,
            clip,
            asset,
            fileW: fileW || aw,
            fileH: fileH || ah,
            tolerancePx: treq.tolerancePx,
          });
          if (out.keyframes.length === 0) {
            throw new Error(
              `추적에 성공한 프레임이 없습니다 (${out.total}프레임 전부 실패). ` +
                '마스크를 대상 위에 정확히 맞춘 뒤 다시 시도하세요.',
            );
          }

          // 갈아 끼울 구간 = **실제로 훑은 쪽만**. forward 만 돌았으면 앞쪽 키프레임은
          // 손대지 않는다(「여기서 다시 추적」의 약속). both 면 양쪽을 덮는다.
          const ranFwd = passes.some((p) => p.direction === 'forward');
          const ranBack = passes.some((p) => p.direction === 'backward');
          const coverLo = ranBack ? Math.min(backClipMs, treq.startMs) : treq.startMs;
          const coverHi = ranFwd ? Math.max(endClipMs, treq.startMs) : treq.startMs;
          const merged = mergeMaskKeyframes(
            clip.keyframes ?? [],
            out.keyframes,
            Math.min(coverLo, coverHi),
            Math.max(coverLo, coverHi),
          );
          await ctx.applyBatch(id, [{ type: 'setKeyframes', clipId, keyframes: merged }]);

          return {
            clipId,
            direction: treq.direction,
            keyframes: out.keyframes.length,
            totalKeyframes: merged.length,
            frames: out.total,
            tracked: out.tracked,
            before: out.before,
            after: out.after,
            reduction: out.before > 0 ? 1 - out.after / out.before : 0,
            maxDeviationPx: Math.round(out.maxDeviationPx * 100) / 100,
            gaps: out.gaps,
            fps,
            // 프레임별 점수 (클립 ms) — UI 가 추적 띠의 진하기로 「위태로운 구간」을 보여준다.
            // 900프레임이면 27KB 라 200점으로 솎는다(띠는 몇 백 픽셀 폭이다).
            scores: sampleScores(classified, map),
          };
        },
        { key: `${clipId}:track` },
      );
      return { jobId: job.id };
    } catch (err) {
      if (err instanceof TrackerUnavailableError) {
        return reply.code(501).send({ error: err.message });
      }
      return sendError(reply, err);
    }
  });
}
