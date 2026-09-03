// W8 F17 — 볼륨 곡선을 ffmpeg 이 감당할 수 있는 «값 가짓수» 안으로 눌러 담는다.
//
// ## 왜 필요한가 (실측)
// remotion 은 `<Audio volume={프레임함수}>` 를 ffmpeg `volume='…':eval=frame` 식으로 바꾸는데,
// **서로 다른 볼륨 값 하나마다 `if()` 를 한 겹씩 중첩**한다. ffmpeg 식 파서의 최대 깊이는 100이라
// 값이 100가지가 되는 순간 렌더가 **통째로 실패**한다(exit −22 EINVAL).
//
// 이 컴퓨터에서 직접 재 본 경계:
//   값 99개 (깊이 98) → OK
//   값 100개(깊이 99) → 실패: "Missing ')' or too many args"
//
// remotion 자신도 이걸 알아서 `roundVolumeToAvoidStackOverflow` 로 값을 1/97 격자에 스냅한다.
// **그런데 그 함수는 볼륨이 0..1 이라고 가정한다.** kitkat 의 볼륨은 클립 0..2 × 트랙 0..2 = **0..4** 라
// 격자 칸이 최대 389개가 되어 한계를 넘는다. 실측한 실패 조합:
//
//   볼륨 1.2 · 페이드인 5초  → 117개  ❌   ← 아주 평범한 설정이다
//   볼륨 2.0 · 페이드인 4초  → 121개  ❌
//   클립 2.0 × 트랙 2.0 · 페이드인 10초 → 301개 ❌
//
// ## 고침
// 최대치(peak)가 1을 넘을 때만, 값을 **peak 를 97등분한 격자**에 먼저 스냅한다.
// 그러면 remotion 의 1/97 격자를 거쳐도 가짓수가 98을 못 넘는다(함수는 가짓수를 늘리지 못한다).
// peak ≤ 1 이면 아무것도 하지 않는다 — **보통 설정에서는 한 비트도 안 바뀐다.**
//
// 대가(실측, 페이드 구간에서 −20dB 위): peak 2.0 에서 최대 0.63dB, peak 4.0 에서 최대 1.31dB.
// 이건 «레벨 점프»가 아니라 «완만한 램프의 계단 크기»라 들리지 않는다.

/** ffmpeg 식 중첩 한계에서 온 최대 값 가짓수. 100개부터 렌더가 실패한다(실측). */
export const MAX_FFMPEG_VOLUME_STEPS = 98;

/**
 * 볼륨 곡선의 최대치. 클립 볼륨과 'volume' 키프레임 중 큰 쪽 × 트랙 배율.
 * 페이드는 ≤1 배율이라 최대치를 못 올린다.
 */
export function volumePeak(
  clipVolume: number,
  trackVolume: number,
  keyframes?: readonly { prop: string; value: unknown }[],
): number {
  let top = clipVolume;
  if (keyframes) {
    for (const k of keyframes) {
      if (k.prop !== 'volume') continue;
      const v = typeof k.value === 'number' ? k.value : Number(k.value);
      if (Number.isFinite(v) && v > top) top = v;
    }
  }
  return Math.max(0, top) * Math.max(0, trackVolume);
}

/**
 * peak 가 1을 넘으면 peak/97 격자에 스냅한다. 넘지 않으면 그대로 돌려준다
 * (remotion 이 이미 안전하게 처리하는 구간이라 손대면 손해다).
 */
export function quantizeVolume(v: number, peak: number): number {
  if (!(peak > 1) || !Number.isFinite(v)) return v;
  const steps = MAX_FFMPEG_VOLUME_STEPS - 1; // 97
  return (Math.round((v / peak) * steps) / steps) * peak;
}
