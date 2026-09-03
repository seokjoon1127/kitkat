// W8 F3-B — 트랜스폼 모션 블러 (자체 구현, 의존성 0).
//
// 한 프레임을 그릴 때 셔터가 열려 있는 구간을 N등분해 **그 시각들의 레이아웃을 계산하고
// N장을 겹쳐 그린다.** `@remotion/motion-blur` 가 하는 일과 같지만 두 가지가 다르다:
//  1) remotion 사본이 둘로 갈라지지 않는다 (@remotion/motion-blur 는 remotion 을 정확히 핀한다).
//  2) 비디오 프레임은 **같은 시각의 것 하나**만 쓴다 — 소스 프레임 추출이 N배가 되지 않는다.
//     (그래서 이 블러는 소스 영상 «속» 피사체는 못 흐린다. 그건 F3-A 의 ffmpeg 파생이 한다.)
//
// remotion·react 무의존 순수 모듈 — 프리뷰 엔진도 같은 수식을 쓸 수 있다.
import type { TransformBlur } from '@kitkat/schema';

/** 인스펙터·에이전트가 켤 때 쓰는 기본값. 180° = 표준 영화 셔터. */
export const DEFAULT_TRANSFORM_BLUR: TransformBlur = { shutterAngle: 180, samples: 12 };

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * 셔터 구간을 samples 등분한 **샘플 시각 오프셋(ms)**. 블러가 꺼져 있으면 빈 배열이다
 * (빈 배열 = 겹쳐 그리지 않는다 = 기존 렌더 결과와 한 픽셀도 다르지 않다).
 *
 * 구간은 tMs 를 가운데 두고 [-s/2, +s/2] 로 **중앙 정렬**한다. 셔터를 프레임 시작에서 여는
 * 실제 카메라와 달리 평균 위치가 tMs 그대로라, 블러를 켜고 끌 때 그림이 앞뒤로 밀리지 않는다.
 */
export function transformBlurOffsets(
  tb: TransformBlur | undefined,
  fps: number,
): number[] {
  if (!tb || !(fps > 0)) return [];
  const angle = clamp(tb.shutterAngle, 0, 360);
  const n = Math.round(clamp(tb.samples, 0, 32));
  if (angle <= 0 || n < 2) return [];
  const shutterMs = (angle / 360) * (1000 / fps);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((i / (n - 1) - 0.5) * shutterMs);
  return out;
}

/**
 * 겹쳐 그리는 한 장의 스타일. `plus-lighter` 는 **더하기** 합성이라
 * 불투명도 1/N 짜리 N장을 더하면 정확히 «평균»이 된다 (opacity 만으로 겹치면 뒷장이
 * 앞장을 가려서 마지막 장이 제일 진해진다 — 그러면 블러가 아니라 잔상이 된다).
 *
 * 부모에 `isolation:'isolate'` 가 있어야 한다 — 없으면 첫 장이 **아래 클립과** 더해져
 * 화면이 하얘진다. `transformBlurGroupStyle` 이 그 격리막이다.
 */
export function transformBlurLayerStyle(count: number): {
  opacity: number;
  mixBlendMode: 'plus-lighter';
} {
  return { opacity: 1 / Math.max(1, count), mixBlendMode: 'plus-lighter' };
}

/** 겹쳐 그린 N장을 담는 격리막. 이 안에서만 plus-lighter 가 합쳐진다. */
export const TRANSFORM_BLUR_GROUP_STYLE = {
  position: 'absolute',
  inset: 0,
  isolation: 'isolate',
} as const;
