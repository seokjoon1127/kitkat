// engine ↔ renderer 이징 대조 (W8 S2 의 «보험»).
//
// 구현은 @kitkat/schema 의 easingFn 한 벌뿐이지만, 누가 나중에 로컬 사본을 다시 만들 수 있다.
// 그걸 잡으려고 «이징 함수를 직접 비교하지 않고 두 패키지의 입구를 비교한다»:
//   engine  쪽 경로 : splitClip 이 분할점에 심는 경계 키프레임 값 (= interpolatePropAt)
//   renderer 쪽 경로: interpolateKeyframes(kfs, prop, t, fallback)
// 한 점이라도 다르면 미리보기와 렌더가 어긋난다는 뜻이므로 실패다.
import { describe, expect, it } from 'vitest';
import {
  EASING_PRESETS,
  createEmptyProject,
  easingFn,
  type Asset,
  type Easing,
  type Keyframe,
  type ProjectDoc,
  type VideoClip,
} from '@kitkat/schema';
import { applyCommands, findClip } from '@kitkat/engine';
import { interpolateKeyframes } from '../src/composition/keyframes.js';

const vAsset: Asset = { id: 'av', kind: 'video', src: 'assets/av.mp4', name: 'av.mp4', duration: 10000 };

const DUR = 5000;
/** 키프레임 5개 — 구간 4개가 서로 다른 방향·길이를 갖게 한다 */
function kfs(easing: Easing): Keyframe[] {
  return [
    { time: 0, prop: 'x', value: 0, easing },
    { time: 1137, prop: 'x', value: 0.75, easing },
    { time: 2298, prop: 'x', value: -0.25, easing },
    { time: 3451, prop: 'x', value: 1.5, easing },
    { time: DUR, prop: 'x', value: 0.1, easing },
  ];
}

function docWith(easing: Easing): ProjectDoc {
  let doc = createEmptyProject({ name: 'parity' });
  const trackId = doc.tracks[0]!.id;
  const clip: VideoClip = {
    id: 'c1', kind: 'video', assetId: 'av', start: 0, duration: DUR,
    in: 0, out: DUR, speed: 1, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    keyframes: kfs(easing),
  };
  return applyCommands(doc, [{ type: 'addAsset', asset: vAsset }, { type: 'addClip', trackId, clip }]);
}

describe('engine ↔ renderer 이징 대조 — 입구끼리 비교', () => {
  it(`12종 프리셋 × 1ms 단위 전 구간(${(DUR - 1) * 12}점) 전부 === (부동소수 오차 허용 없음)`, () => {
    let compared = 0;
    let mismatches = 0;
    for (const preset of EASING_PRESETS) {
      const doc = docWith(preset.easing);
      const list = kfs(preset.easing);
      for (let at = 1; at < DUR; at++) {
        // engine: 분할점에 심긴 경계 키프레임 값
        const next = applyCommands(doc, [{ type: 'splitClip', clipId: 'c1', at, newClipId: 'c2' }]);
        const right = findClip(next, 'c2')!.clip;
        const boundary = right.keyframes!.find((k) => k.time === 0 && k.prop === 'x')!;
        // renderer: 같은 시각의 보간값
        const rendered = interpolateKeyframes(list, 'x', at, 0);
        compared++;
        if (boundary.value !== rendered) mismatches++;
      }
    }
    expect(compared).toBe((DUR - 1) * EASING_PRESETS.length);
    expect(mismatches).toBe(0);
  }, 120_000);

  it('12종 × 1001점: schema easingFn(엔진이 쓰는 것)과 renderer 보간이 비트 동일', () => {
    let mismatches = 0;
    for (const preset of EASING_PRESETS) {
      const f = easingFn(preset.easing);
      const ramp: Keyframe[] = [
        { time: 0, prop: 'x', value: 0, easing: preset.easing },
        { time: 1000, prop: 'x', value: 1, easing: 'linear' },
      ];
      for (let i = 0; i <= 1000; i++) {
        if (interpolateKeyframes(ramp, 'x', i, 0) !== f(i / 1000)) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it('renderer 와 engine 은 «같은 함수 객체»를 쓴다 (사본이 생기면 여기서 깨진다)', () => {
    // 두 패키지 모두 @kitkat/schema 의 easingFn 을 import 한다 — 모듈이 하나이므로 캐시도 하나다.
    expect(easingFn('easeInOut')).toBe(easingFn({ bezier: [0.42, 0, 0.58, 1] }));
  });
});
