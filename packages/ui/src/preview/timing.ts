// 프리뷰 v2 — 클럭·활성 클립 선정·소스 시각·볼륨의 순수 로직 (DOM 무의존, 단위테스트 대상).
// 볼륨 수식은 렌더러 clips.tsx 의 makeVolumeFn/fadeFactor 와 **같아야 한다**.
import type {
  Asset,
  AudioClip,
  ImageClip,
  ProjectDoc,
  TextClip,
  Track,
  VideoClip,
} from '@kitkat/schema';
import { rampSegments } from '@kitkat/schema';
import { interpolateKeyframes, resolveMediaWindow } from '@kitkat/renderer/composition';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// ── 활성 클립 선정 ────────────────────────────────────────────────────────

export type ActiveVisual = { clip: VideoClip | ImageClip; track: Track; localMs: number };
export type ActiveText = { clip: TextClip; track: Track; localMs: number };
export type ActiveAudio = { clip: AudioClip | VideoClip; track: Track; localMs: number };

export type ActiveClips = {
  visual: ActiveVisual[]; // 트랙 순서 = 아래(0) → 위 (렌더러와 같음)
  text: ActiveText[];
  audio: ActiveAudio[];
};

/** 클립이 t(ms)에 살아 있는가 — [start, start+duration) 반열린 구간. */
export function isClipActive(start: number, duration: number, tMs: number): boolean {
  return tMs >= start && tMs < start + duration;
}

/**
 * 시각 t 에 그려야 할 클립들. hidden 트랙은 통째로 건너뛴다(렌더러 TimelineVideo 와 같음).
 * audio 에는 오디오 클립과 **소리를 내는 비디오 클립**이 함께 들어간다.
 */
export function activeClipsAt(doc: ProjectDoc, tMs: number): ActiveClips {
  const visual: ActiveVisual[] = [];
  const text: ActiveText[] = [];
  const audio: ActiveAudio[] = [];
  for (const track of doc.tracks) {
    if (track.hidden === true) continue;
    for (const clip of track.clips) {
      if (!isClipActive(clip.start, clip.duration, tMs)) continue;
      const localMs = tMs - clip.start;
      if (clip.kind === 'text') {
        text.push({ clip, track, localMs });
      } else if (clip.kind === 'audio') {
        audio.push({ clip, track, localMs });
      } else {
        visual.push({ clip, track, localMs });
        if (clip.kind === 'video' && videoHasAudio(clip)) {
          audio.push({ clip, track, localMs });
        }
      }
    }
  }
  return { visual, text, audio };
}

/** 비디오 클립이 소리를 내는가 — 램프·정지화면은 렌더러가 음소거한다. */
export function videoHasAudio(clip: VideoClip): boolean {
  if (clip.freeze === true) return false;
  if ((clip.speedRamp?.points?.length ?? 0) >= 2) return false;
  return true;
}

// ── 볼륨 (렌더러와 같은 수식) ─────────────────────────────────────────────

/** 오디오 페이드 배율 (선형). 렌더러 clips.tsx 의 fadeFactor 와 같은 식. */
export function fadeFactor(
  tMs: number,
  durationMs: number,
  fadeIn?: number,
  fadeOut?: number,
): number {
  let f = 1;
  if (fadeIn && fadeIn > 0) f *= clamp01(tMs / fadeIn);
  if (fadeOut && fadeOut > 0) f *= clamp01((durationMs - tMs) / fadeOut);
  return f;
}

/**
 * 클립×트랙×키프레임×페이드 볼륨. 미리보기는 렌더가 아니므로 1 로 클램프한다 (C4 — Player 와 같음).
 * HTMLMediaElement.volume 이 0..1 만 받는 것과도 맞는다.
 */
export function clipVolume(clip: VideoClip | AudioClip, track: Track, localMs: number): number {
  const trackVolume = track.muted === true ? 0 : track.volume ?? 1;
  let v = interpolateKeyframes(clip.keyframes, 'volume', localMs, clip.volume);
  v *= trackVolume;
  v *= fadeFactor(localMs, clip.duration, clip.fadeIn, clip.fadeOut);
  return Math.min(1, Math.max(0, v));
}

// ── 소스 시각 ─────────────────────────────────────────────────────────────

/**
 * 클립 로컬 시각(ms) → **클립 좌표(clip.in..clip.out) 기준 시각(ms)**.
 * freeze / loop / speedRamp / 등속 네 갈래. 역재생본을 쓸 때의 좌표 이동은 mediaTimeAt 이 얹는다.
 */
export function sourceTimeAt(clip: VideoClip, localMs: number): number {
  const span = clip.out - clip.in;
  if (clip.freeze === true || span <= 0) return clip.in;
  const t = Math.max(0, localMs);
  if ((clip.speedRamp?.points?.length ?? 0) >= 2) {
    const segs = rampSegments(clip);
    for (const s of segs) {
      if (t < s.startMs + s.durationMs || s === segs[segs.length - 1]) {
        const p = s.durationMs > 0 ? clamp01((t - s.startMs) / s.durationMs) : 0;
        return s.inMs + (s.outMs - s.inMs) * p;
      }
    }
    return clip.out;
  }
  if (clip.loop === true) {
    const oneMs = span / clip.speed;
    const w = oneMs > 0 ? t % oneMs : 0;
    return clip.in + w * clip.speed;
  }
  return Math.min(clip.out, clip.in + t * clip.speed);
}

/** 정지화면 클립은 재생하지 않고 한 프레임만 떠서 보여준다. */
export function isStillClip(clip: VideoClip): boolean {
  return clip.freeze === true;
}

/** 재생 중 video 엘리먼트에 줄 배속. 램프는 평균 배속으로 두고 드리프트 보정에 맡긴다. */
export function playbackRateFor(clip: VideoClip): number {
  if ((clip.speedRamp?.points?.length ?? 0) >= 2) {
    return clip.duration > 0 ? (clip.out - clip.in) / clip.duration : clip.speed;
  }
  return clip.speed;
}

export type MediaTime = {
  src: string;
  /** 실제로 재생할 파일 안에서의 시각 ms */
  srcMs: number;
  /** 역재생본/역재생 파생을 쓰고 있어 소스 구간이 미러링됐는가 */
  mirrored: boolean;
};

/**
 * 클립 로컬 시각 → 실제 파일과 그 안의 시각.
 * src 선택·미러링 규칙은 렌더러 `resolveMediaWindow` 를 그대로 쓴다 (두 경로가 갈리지 않게).
 *
 * 역재생본은 **뒤집힌 파일을 앞으로** 재생한다 — 렌더러(clips.tsx)가 하는 것과 똑같이
 * 소스 좌표를 `srcOffsetMs = w.inMs - clip.in` 만큼 밀기만 한다. 시각을 뒤집으면(= D - forward)
 * 렌더러와 정반대로 흘러 미리보기가 정방향으로 보인다.
 */
export function mediaTimeAt(
  clip: VideoClip,
  asset: Asset,
  mediaBase: string,
  proxy: boolean,
  localMs: number,
): MediaTime {
  const w = resolveMediaWindow(clip, asset, mediaBase, proxy);
  const mirrored = w.inMs !== clip.in || w.outMs !== clip.out;
  const srcOffsetMs = w.inMs - clip.in; // 정방향/파생이면 0
  return {
    src: w.src,
    srcMs: Math.max(0, sourceTimeAt(clip, localMs) + srcOffsetMs),
    mirrored,
  };
}

// ── 드리프트 ──────────────────────────────────────────────────────────────

/** 미디어 엘리먼트가 클럭에서 얼마나 벗어났으면 다시 맞춰야 하는가 (기본 100ms). */
export function needsResync(elementMs: number, targetMs: number, thresholdMs = 100): boolean {
  if (!Number.isFinite(elementMs) || !Number.isFinite(targetMs)) return true;
  return Math.abs(elementMs - targetMs) > thresholdMs;
}

/**
 * 클럭 진행. 재생 중이면 지난 실제 시간을 더하고 문서 길이에서 멈춘다(배속 없음, 1배 고정).
 * 반환 ended=true 면 끝에 닿아 재생을 멈춰야 한다.
 */
export function advanceClock(
  prevMs: number,
  elapsedMs: number,
  durationMs: number,
): { ms: number; ended: boolean } {
  const next = prevMs + Math.max(0, elapsedMs);
  if (next >= durationMs) return { ms: durationMs, ended: true };
  return { ms: next, ended: false };
}
