// 속도 램프 / freeze / loop 의 프레임 계산 (순수 로직 — remotion 무의존, 단위테스트 대상)
import type { VideoClip } from '@kitkat/schema';
import { rampSegments } from '@kitkat/schema';
import { msToFrames } from './keyframes.js';

export type RampSequence = {
  key: string;
  from: number; // 클립 시작 기준 프레임
  durationInFrames: number;
  trimBefore: number; // OffthreadVideo 소스 시작 프레임
  trimAfter: number;
  playbackRate: number;
};

/**
 * OffthreadVideo/Audio 의 trimBefore·trimAfter.
 *
 * Remotion 은 `trimBefore/trimAfter` 를 내부 `<Sequence from={-trimBefore} durationInFrames={trimAfter}>`
 * 로 바꾼다 — 즉 미디어가 **보이는 길이는 (trimAfter - trimBefore) 프레임**이고 playbackRate 는
 * 여기에 반영되지 않는다. 그래서 느린 재생(speed<1)이면 소스 구간만으로는 표시 길이가 모자라
 * 클립 뒷부분이 통째로 빈 화면이 된다. 표시 길이만큼 trimAfter 를 넓혀 그걸 막는다.
 *
 * speed >= 1 이라고 값이 항상 그대로인 것은 아니다 — in/out 이 프레임 경계에 안 맞으면
 * `trimBefore + displayFrames` 가 `msToFrames(outMs)` 를 1 넘어선다(정수 ms 조합의 약 13%).
 * 그 경우 v1 에서는 클립 **마지막 한 프레임이 비어 있었고**, 지금은 영상이 채운다.
 * 클립 길이만큼 그림이 나오는 것이 맞으므로 의도된 변경이다.
 *
 * ## 지켜야 하는 성질 — trimAfter >= msToFrames(outMs)   (W8 F17 에서 확인)
 *
 * OffthreadVideo 는 trimAfter 를 **타임라인 길이**로 읽지만, @remotion/media 의 Video 는
 * 같은 값을 **소스 위치 상한**으로 읽는다. 뜻이 다르다.
 * 위 Math.max 의 msToFrames(outMs, fps) 항 덕분에 지금은 두 해석이 우연히 일치한다.
 * 그 항을 빼면 「trim 0–10프레임 + 2배속」 같은 경우 Video 로 갈아탄 순간
 * **5프레임 뒤부터 조용히 빈 화면**이 된다 — 에러도 안 난다.
 * 최적화한다고 지우지 마라. ramp.test.ts 가 이 성질을 지킨다.
 */
export function mediaTrimFrames(
  inMs: number,
  outMs: number,
  displayMs: number,
  fps: number,
): { trimBefore: number; trimAfter: number } {
  const trimBefore = msToFrames(inMs, fps);
  const displayFrames = Math.max(1, msToFrames(displayMs, fps));
  return {
    trimBefore,
    trimAfter: Math.max(trimBefore + 1, msToFrames(outMs, fps), trimBefore + displayFrames),
  };
}

/** 램프가 실제로 적용되는가 (점 2개 이상). */
export function hasSpeedRamp(clip: VideoClip): boolean {
  return (clip.speedRamp?.points?.length ?? 0) >= 2;
}

/**
 * speedRamp → <Sequence> + <OffthreadVideo> 파라미터 목록.
 *
 * 세그먼트는 ms 단위라 프레임보다 짧아질 수 있다(빠른 구간). ms 를 각자 반올림하면
 * 세그먼트 사이에 **빈 프레임**이 생겨 화면이 깜빡인다 — 그래서 각 세그먼트의 길이를
 * "다음 세그먼트의 시작 프레임 − 내 시작 프레임"으로 잡아 프레임을 빈틈없이 이어 붙이고,
 * 한 프레임에도 못 미치는 세그먼트들은 앞 세그먼트에 흡수시킨다(소스 구간을 합친다).
 *
 * srcOffsetMs 는 reversed 파일을 쓸 때의 소스 좌표 보정 (정방향/파생이면 0).
 *
 * 기준 길이는 **clip.duration** 이다 — 클립 <Sequence> 가 `msToFrames(clip.duration)` 프레임이고,
 * 스키마는 `|duration - rampDurationMs| <= 2ms` 를 허용하므로 rampDurationMs 로 세면 둘이
 * 한 프레임 갈려 **마지막 프레임이 빈다**(검은 프레임 / 투명 내보내기면 구멍).
 */
export function rampSequences(clip: VideoClip, fps: number, srcOffsetMs = 0): RampSequence[] {
  return rampSpans(clip, fps, srcOffsetMs).map((s, i) => {
    const shownMs = (s.durationInFrames * 1000) / fps;
    return {
      key: `${clip.id}-r${i}`,
      from: s.from,
      durationInFrames: s.durationInFrames,
      ...mediaTrimFrames(s.inMs, s.outMs, shownMs, fps),
      playbackRate: shownMs > 0 ? (s.outMs - s.inMs) / shownMs : s.speed,
    };
  });
}

/** 프레임에 맞춘 등속 구간 — 타임라인 프레임 [from, from+durationInFrames) 이 소스 [inMs,outMs]. */
type RampSpan = {
  from: number;
  durationInFrames: number;
  inMs: number;
  outMs: number;
  speed: number;
};

function rampSpans(clip: VideoClip, fps: number, srcOffsetMs: number): RampSpan[] {
  const endFrame = Math.max(1, msToFrames(clip.duration, fps));
  const segs = rampSegments(clip, Math.max(1, Math.min(40, endFrame)));
  const out: RampSpan[] = [];
  let i = 0;
  while (i < segs.length) {
    const from = msToFrames(segs[i]!.startMs, fps);
    // 시작 프레임이 같은(=한 프레임 안에 들어가는) 뒤쪽 세그먼트, 그리고
    // 반올림 때문에 클립 끝을 넘겨버린 꼬리 세그먼트를 합친다
    let j = i + 1;
    while (j < segs.length) {
      const f = msToFrames(segs[j]!.startMs, fps);
      if (f <= from || f >= endFrame) {
        j++;
        continue;
      }
      break;
    }
    const nextFrom = j < segs.length ? msToFrames(segs[j]!.startMs, fps) : endFrame;
    out.push({
      from,
      durationInFrames: Math.max(1, nextFrom - from),
      inMs: segs[i]!.inMs + srcOffsetMs,
      outMs: segs[j - 1]!.outMs + srcOffsetMs,
      speed: segs[i]!.speed,
    });
    i = j;
  }
  return out;
}

/** 램프 세그먼트 경계 페이드의 목표 길이(ms) — 클릭음 제거용 짧은 페이드. */
export const RAMP_SEG_FADE_MS = 8;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 세그먼트 경계 페이드 길이(ms) = `min(8ms, 세그먼트 길이의 20%)`.
 *
 * `framePeriodMs` 를 주면 그 값까지 **늘린다**. Remotion 의 `volume` 은 한 프레임에 한 번만
 * 평가되므로(렌더에서는 ffmpeg `volume=…:eval=frame` 으로 나간다) 한 프레임보다 짧은 페이드는
 * 표현 자체가 안 된다 — 30fps 면 8ms 페이드는 그대로 «없는 것»이 된다(실측: 최대 인접 표본
 * 차이가 하나도 안 줄었다). 그래서 실제로 쓰는 길이는 항상 한 프레임이 된다.
 */
export function rampSegmentFadeMs(segmentDurationMs: number, framePeriodMs = 0): number {
  const wanted = Math.min(RAMP_SEG_FADE_MS, Math.max(0, segmentDurationMs) * 0.2);
  return Math.max(wanted, Math.max(0, framePeriodMs));
}

/**
 * 램프 세그먼트 경계의 클릭음을 죽이는 페이드 배율(0..1). 세그먼트 볼륨에 **곱한다**.
 *
 * - `tMs` 는 **세그먼트 시작 기준** 시각, `fadeMs` 는 앞뒤 페이드 길이.
 * - 클립 전체의 첫 세그먼트 «시작»과 마지막 세그먼트 «끝»에는 넣지 않는다
 *   (클립 자체의 fadeIn/fadeOut 과 겹치면 안 된다).
 * - 세그먼트가 하나뿐이면 항상 1 — 램프가 없는 클립은 영향을 받지 않는다.
 *
 * 이웃 세그먼트가 `fadeMs` 의 절반씩 겹쳐 있으면(→ `rampAudioSequences`) 두 배율의 합이
 * 항상 1 이 되어 소리에 구멍도, 볼륨 계단도 생기지 않는다.
 */
export function rampSegmentFade(
  tMs: number,
  segmentDurationMs: number,
  index: number,
  count: number,
  fadeMs: number,
): number {
  if (!(fadeMs > 0)) return 1;
  let v = 1;
  if (index > 0) v *= clamp01(tMs / fadeMs);
  if (index < count - 1) v *= clamp01((segmentDurationMs - tMs) / fadeMs);
  return v;
}

/** 램프 오디오 세그먼트 — 영상 세그먼트를 이웃 쪽으로 넓힌 것 + 겹친 구간의 페이드 길이. */
export type RampAudioSequence = RampSequence & { fadeMs: number };

/**
 * 램프 클립의 **소리**용 세그먼트.
 *
 * 영상 세그먼트를 그대로 쓰면 경계마다 파형이 튄다(실측: 인접 표본 차이 최대 1.13 — 매끈한
 * 신호의 상한 0.032 의 35배). 그렇다고 세그먼트마다 볼륨을 0 으로 떨궜다 올리면 **그 볼륨
 * 계단 자체가 또 클릭음**이다(실측: 0.87 까지밖에 안 내려가고 RMS 는 29% 깎였다).
 *
 * 그래서 세그먼트를 앞뒤로 한 프레임씩 넓혀 **이웃과 겹치게** 하고, 겹친 구간에서 서로 반대
 * 방향으로 페이드한다. 겹친 두 세그먼트는 소스의 거의 같은 구간을 재생하므로 배율의 합이
 * 1 로 유지되고(구멍 없음), 한쪽의 볼륨 계단은 다른 쪽이 정확히 메운다(계단 없음).
 *
 * 한 프레임씩인 이유: `volume` 은 프레임당 한 번만 평가되므로 이보다 짧게 겹칠 수 없다.
 */
export function rampAudioSequences(
  clip: VideoClip,
  fps: number,
  srcOffsetMs = 0,
): RampAudioSequence[] {
  const framePeriodMs = 1000 / fps;
  const spans = rampSpans(clip, fps, srcOffsetMs);
  const shortestMs = Math.min(...spans.map((s) => s.durationInFrames * framePeriodMs));
  // 페이드 길이를 프레임으로 환산한 값 = 겹치는 폭. 보통 딱 1프레임이다.
  // 억지로 2프레임까지 넓혀도 실측상 클릭음은 그대로(0.459 vs 0.465)면서 RMS 만 더 깎였다
  // (0.276 vs 0.300) — 세그먼트가 1~4프레임뿐이라 넓히면 한 세그먼트의 앞뒤 페이드가 서로
  // 겹쳐 배율 합이 1 을 못 지킨다.
  const overlap = Math.max(1, Math.round(rampSegmentFadeMs(shortestMs, framePeriodMs) / framePeriodMs));
  return spans.map((s, i) => {
    const rate = (s.outMs - s.inMs) / ((s.durationInFrames * 1000) / fps);
    const head = i > 0 ? overlap : 0;
    const tail = i < spans.length - 1 ? overlap : 0;
    const from = Math.max(0, s.from - head);
    const durationInFrames = s.durationInFrames + (s.from - from) + tail;
    const inMs = Math.max(0, s.inMs - (s.from - from) * framePeriodMs * rate);
    const outMs = s.outMs + tail * framePeriodMs * rate;
    const shownMs = (durationInFrames * 1000) / fps;
    return {
      key: `${clip.id}-ra${i}`,
      from,
      durationInFrames,
      ...mediaTrimFrames(inMs, outMs, shownMs, fps),
      playbackRate: shownMs > 0 ? (outMs - inMs) / shownMs : s.speed,
      fadeMs: spans.length > 1 ? 2 * overlap * framePeriodMs : 0,
    };
  });
}

/** loop 클립이 한 번 도는 길이(프레임) = (out-in)/speed. */
export function loopDurationInFrames(clip: VideoClip, fps: number): number {
  return Math.max(1, msToFrames(Math.round((clip.out - clip.in) / clip.speed), fps));
}
