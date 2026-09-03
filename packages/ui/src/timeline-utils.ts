// 타임라인 순수 유틸 — ms↔px 변환·스냅·겹침·트림 범위·비트 마커 계산 (React 무관, 단위테스트 대상)
import type { Asset, AudioClip, Clip, ProjectDoc, Track, VideoClip } from '@kitkat/schema';

/** 스냅 판정 임계값 (px) */
export const SNAP_THRESHOLD_PX = 8;
/** 타임라인 최소 표시 길이 (ms) */
export const MIN_TIMELINE_MS = 10_000;
/** 클립 최소 길이 (ms) — 트림 시 이보다 짧아지지 않게 */
export const MIN_CLIP_MS = 50;

/** ms → px. zoom = 초당 픽셀 수 */
export function msToPx(ms: number, zoom: number): number {
  return (ms / 1000) * zoom;
}

/** px → ms (정수 ms 반올림). zoom = 초당 픽셀 수 */
export function pxToMs(px: number, zoom: number): number {
  return Math.round((px / zoom) * 1000);
}

/** ms를 [min, max]로 클램프 (정수 반올림) */
export function clampMs(ms: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.min(max, Math.max(min, ms)));
}

/** "m:ss" 또는 십분초가 있으면 "m:ss.t" */
export function formatTime(ms: number): string {
  const t = Math.max(0, Math.round(ms / 100)); // 십분초 단위
  const tenths = t % 10;
  const totalSec = Math.floor(t / 10);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const base = `${m}:${String(s).padStart(2, '0')}`;
  return tenths === 0 ? base : `${base}.${tenths}`;
}

const STEP_CANDIDATES = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000];

/** 눈금 간격(ms) — major 눈금이 화면상 70px 이상 벌어지는 최소 간격, minor = major/5 */
export function rulerStep(zoom: number): { major: number; minor: number } {
  for (const step of STEP_CANDIDATES) {
    if (msToPx(step, zoom) >= 70) return { major: step, minor: step / 5 };
  }
  const last = STEP_CANDIDATES[STEP_CANDIDATES.length - 1]!;
  return { major: last, minor: last / 5 };
}

/** 문서 전체 길이(ms) = 모든 클립 끝의 최대값, 최소 MIN_TIMELINE_MS */
export function timelineDurationMs(doc: Pick<ProjectDoc, 'tracks'> | null): number {
  let max = 0;
  if (doc) {
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        const end = clip.start + clip.duration;
        if (end > max) max = end;
      }
    }
  }
  return Math.max(MIN_TIMELINE_MS, max);
}

/**
 * 에셋 절대 ms → 타임라인 절대 ms.
 * 에셋 절대 → 클립 상대(in 기준, speed 로 나눔) → 타임라인 절대(start 더함).
 * reversed video 는 타임라인 t=0 이 소스 out 이므로 반대 끝에서 센다.
 * 소스 구간 [in, out] 이나 클립 표시 구간 밖이면 null.
 */
export function assetMsToTimelineMs(clip: VideoClip | AudioClip, assetMs: number): number | null {
  if (assetMs < clip.in || assetMs > clip.out) return null;
  const speed = clip.speed > 0 ? clip.speed : 1;
  const mirrored = clip.kind === 'video' && clip.reversed === true;
  const rel = mirrored ? clip.out - assetMs : assetMs - clip.in;
  const t = Math.round(clip.start + rel / speed);
  if (t < clip.start || t > clip.start + clip.duration) return null;
  return t;
}

/** 클립이 참조하는 에셋의 beats 를 타임라인 시각(오름차순)으로 변환. 범위 밖 비트는 버린다. */
export function clipBeatTimes(clip: Clip, asset: Asset | undefined): number[] {
  if (clip.kind !== 'video' && clip.kind !== 'audio') return [];
  const beats = asset?.beats;
  if (!beats || beats.length === 0) return [];
  const out: number[] = [];
  for (const b of beats) {
    const t = assetMsToTimelineMs(clip, b);
    if (t !== null) out.push(t);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * 타임라인에 그릴 비트 마커 — 선택된 클립이 참조하는 에셋의 비트 + 오디오 트랙 클립들의 비트.
 * 결과는 중복 제거된 타임라인 ms 오름차순.
 */
export function collectBeatMarkers(
  doc: Pick<ProjectDoc, 'tracks' | 'assets'> | null,
  opts: { selectedClipId?: string | null } = {},
): number[] {
  if (!doc) return [];
  const points = new Set<number>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (track.kind !== 'audio' && clip.id !== opts.selectedClipId) continue;
      const asset = 'assetId' in clip ? doc.assets[clip.assetId] : undefined;
      for (const t of clipBeatTimes(clip, asset)) points.add(t);
    }
  }
  return [...points].sort((a, b) => a - b);
}

/** 스냅 후보 시각 수집: 0초·재생헤드·(제외 클립 뺀) 모든 클립 경계·비트 마커 */
export function collectSnapPoints(
  doc: Pick<ProjectDoc, 'tracks'> | null,
  opts: { excludeClipId?: string; playheadMs?: number; beats?: readonly number[] } = {},
): number[] {
  const points = new Set<number>([0]);
  if (opts.playheadMs !== undefined) points.add(Math.round(opts.playheadMs));
  for (const b of opts.beats ?? []) points.add(Math.round(b));
  if (doc) {
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.id === opts.excludeClipId) continue;
        points.add(clip.start);
        points.add(clip.start + clip.duration);
      }
    }
  }
  return [...points];
}

/** ms가 후보 중 하나와 화면상 thresholdPx 이내면 그 값으로 스냅 */
export function snapValue(
  ms: number,
  points: number[],
  zoom: number,
  thresholdPx = SNAP_THRESHOLD_PX,
): { ms: number; snapped: boolean } {
  const thresholdMs = pxToMs(thresholdPx, zoom);
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const d = Math.abs(p - ms);
    if (d <= thresholdMs && d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best === null ? { ms: Math.round(ms), snapped: false } : { ms: best, snapped: true };
}

/** 클립 이동 스냅: 시작·끝 양쪽 중 더 가까운 쪽을 스냅해 보정된 start를 돌려준다 */
export function snapMove(
  start: number,
  duration: number,
  points: number[],
  zoom: number,
  thresholdPx = SNAP_THRESHOLD_PX,
): number {
  const thresholdMs = pxToMs(thresholdPx, zoom);
  let bestStart = Math.round(start);
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const dStart = Math.abs(p - start);
    if (dStart <= thresholdMs && dStart < bestDist) {
      bestDist = dStart;
      bestStart = p;
    }
    const dEnd = Math.abs(p - (start + duration));
    if (dEnd <= thresholdMs && dEnd < bestDist) {
      bestDist = dEnd;
      bestStart = p - duration;
    }
  }
  return bestStart;
}

type ClipSpan = { id: string; start: number; duration: number };

/** [start, start+duration)이 트랙 내 다른 클립과 겹치는가 (경계 접촉은 겹침 아님) */
export function hasOverlap(
  clips: readonly ClipSpan[],
  start: number,
  duration: number,
  excludeId?: string,
): boolean {
  const end = start + duration;
  for (const c of clips) {
    if (c.id === excludeId) continue;
    if (start < c.start + c.duration && c.start < end) return true;
  }
  return false;
}

/** desiredStart부터 겹치지 않는 가장 이른 시작 위치 (겹치면 겹친 클립 끝으로 밀어가며 탐색) */
export function findFreeStart(
  clips: readonly ClipSpan[],
  desiredStart: number,
  duration: number,
  excludeId?: string,
): number {
  let start = Math.max(0, Math.round(desiredStart));
  const sorted = [...clips]
    .filter((c) => c.id !== excludeId)
    .sort((a, b) => a.start - b.start);
  let moved = true;
  while (moved) {
    moved = false;
    for (const c of sorted) {
      if (start < c.start + c.duration && c.start < start + duration) {
        start = c.start + c.duration;
        moved = true;
      }
    }
  }
  return start;
}

/**
 * 트림 가능한 타임라인 시각 범위 [min, max].
 * - 이웃 클립을 넘지 않는다.
 * - video/audio는 소스 범위(in/out·speed·에셋 길이)를 넘지 않는다.
 *   reversed video는 타임라인 t=0 ↔ 소스 out 이므로 소스 여유를 반대 끝에서 계산한다.
 * - MIN_CLIP_MS 미만으로 짧아지지 않는다.
 */
export function trimRange(
  track: Pick<Track, 'clips'>,
  clip: Clip,
  edge: 'start' | 'end',
  assetDurationMs?: number,
): { min: number; max: number } {
  const end = clip.start + clip.duration;
  const hasSource = clip.kind === 'video' || clip.kind === 'audio';
  const mirrored = clip.kind === 'video' && clip.reversed === true;
  if (edge === 'start') {
    let min = 0;
    for (const c of track.clips) {
      if (c.id === clip.id) continue;
      const cEnd = c.start + c.duration;
      if (cEnd <= clip.start && cEnd > min) min = cEnd;
    }
    if (hasSource) {
      // 왼쪽으로 늘릴 수 있는 소스 여유: 정방향은 in 앞쪽, reversed는 out 뒤쪽(에셋 끝까지)
      const headroom = mirrored
        ? assetDurationMs !== undefined
          ? (assetDurationMs - clip.out) / clip.speed
          : Number.POSITIVE_INFINITY
        : clip.in / clip.speed;
      const sourceMin = clip.start - headroom;
      if (sourceMin > min) min = sourceMin;
    }
    return { min: Math.round(min), max: Math.round(end - MIN_CLIP_MS) };
  }
  let max = Number.POSITIVE_INFINITY;
  for (const c of track.clips) {
    if (c.id === clip.id) continue;
    if (c.start >= end && c.start < max) max = c.start;
  }
  if (hasSource) {
    // 오른쪽으로 늘릴 수 있는 소스 여유: 정방향은 out 뒤쪽(에셋 끝까지), reversed는 in 앞쪽
    const tailroom = mirrored
      ? clip.in / clip.speed
      : assetDurationMs !== undefined
        ? (assetDurationMs - clip.out) / clip.speed
        : Number.POSITIVE_INFINITY;
    const sourceMax = end + tailroom;
    if (sourceMax < max) max = sourceMax;
  }
  if (!Number.isFinite(max)) max = end + 60 * 60 * 1000; // 이웃·소스 제약 없으면 1시간 여유
  return { min: Math.round(clip.start + MIN_CLIP_MS), max: Math.round(max) };
}
