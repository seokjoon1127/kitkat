// 키프레임 보간 + 타임라인 시간 계산 (순수 로직 — 브라우저/노드 겸용)
//
// 이징 구현은 @kitkat/schema 의 easingFn «한 벌»뿐이다 (W8 S2).
// 여기에 cubicBezier/EASINGS 사본을 다시 만들지 마라 — 두 벌이 되는 순간
// 미리보기와 렌더가 갈린다(W6 에서 색조정 순서가 갈린 것과 같은 일).
import type { Clip, Keyframe, ProjectDoc } from '@kitkat/schema';
import { easingFn, readPath, writePath } from '@kitkat/schema';

// ── 경로별 묶음 캐시 ──────────────────────────────────────────────────────
// 예전 구현은 호출마다 `kfs.filter(...).sort(...)` 를 돌렸다. 키프레임 10개면 무해하지만
// 마스크 트래킹(F10)은 30초 클립에 3,600개(900프레임 × 4경로)를 만든다 —
// 그러면 프레임마다 3,600개를 필터·정렬하게 되어 30초 렌더에서 약 1,300만 번의 비교가 된다.
// clip.keyframes 배열 참조는 한 렌더 동안 불변이므로 WeakMap 키로 완벽하다.

const groupCache = new WeakMap<readonly Keyframe[], Map<string, Keyframe[]>>();

/** 키프레임 배열을 prop(경로)별 time 오름차순 목록으로 묶는다. 배열이 같으면 결과를 재사용한다. */
export function groupKeyframes(kfs: readonly Keyframe[]): Map<string, Keyframe[]> {
  let g = groupCache.get(kfs);
  if (g) return g;
  g = new Map<string, Keyframe[]>();
  for (const k of kfs) {
    const list = g.get(k.prop);
    if (list) list.push(k);
    else g.set(k.prop, [k]);
  }
  // Array.prototype.sort 는 안정 정렬이므로 filter().sort() 와 결과가 같다(회귀 없음).
  for (const list of g.values()) list.sort((x, y) => x.time - y.time);
  groupCache.set(kfs, g);
  return g;
}

/**
 * time 오름차순으로 정렬된 «같은 경로» 키프레임 목록에서 tMs 시점 값.
 * 구간 이징은 앞(시작) 키프레임의 easing 을 따른다.
 */
export function interpolateSorted(sorted: readonly Keyframe[], tMs: number, fallback: number): number {
  if (sorted.length === 0) return fallback;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (tMs <= first.time) return first.value;
  if (tMs >= last.time) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    if (tMs >= from.time && tMs <= to.time) {
      if (to.time === from.time) return to.value;
      const u = (tMs - from.time) / (to.time - from.time);
      const e = easingFn(from.easing)(u);
      return from.value + (to.value - from.value) * e;
    }
  }
  return fallback;
}

/**
 * 키프레임 보간 (C4). tMs는 클립 시작 기준 ms.
 * 구간 이징은 앞(시작) 키프레임의 easing을 따른다.
 */
export function interpolateKeyframes(
  kfs: Keyframe[] | undefined,
  prop: string,
  tMs: number,
  fallback: number,
): number {
  if (!kfs || kfs.length === 0) return fallback;
  const list = groupKeyframes(kfs).get(prop);
  if (!list) return fallback;
  return interpolateSorted(list, tMs, fallback);
}

/**
 * tMs 시점의 값들이 이미 반영된 클립을 돌려준다 (W8 S1).
 *
 * 「키프레임이 무엇을 하는가」를 아는 코드를 **여기 한 곳**에 모은다. 그래야 새 경로를
 * 추가할 때 고칠 곳이 화이트리스트(KEYFRAME_PATHS) 한 줄뿐이다.
 * 키프레임이 없으면 **같은 객체**를 그대로 돌려준다(할당 0).
 * 대상이 사라진 경로(마스크를 껐다 등)는 조용히 건너뛴다 — 문서에는 남아 있고 무동작이다.
 */
export function applyKeyframes<T extends Clip>(clip: T, tMs: number): T {
  const kfs = clip.keyframes;
  if (!kfs || kfs.length === 0) return clip;
  let out = clip;
  for (const [prop, list] of groupKeyframes(kfs)) {
    const cur = readPath(out, prop);
    if (cur === undefined) continue;
    const v = interpolateSorted(list, tMs, cur);
    if (v !== cur) out = writePath(out, prop, v);
  }
  return out;
}

/** 문서 전체 길이(ms) = max(clip.start + clip.duration), 최소 1000 (C4). */
export function docDurationMs(doc: ProjectDoc): number {
  let max = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const end = clip.start + clip.duration;
      if (end > max) max = end;
    }
  }
  return Math.max(1000, max);
}

/** ms → 프레임 변환. 프레임 변환은 렌더러에서만 한다 (Global Constraints). */
export function msToFrames(ms: number, fps: number): number {
  return Math.round((ms * fps) / 1000);
}
