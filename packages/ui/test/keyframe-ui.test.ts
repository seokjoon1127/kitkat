// W8 F7(이징 편집기) · F13(아무 값에나 키프레임) — 인스펙터 쪽 순수 로직 테스트.
//
// 여기서 검증하는 것은 «UI 가 만드는 값»이다. 이징 계산 자체(easingFn)와 경로 검증
// (isKeyframablePath)은 schema 의 테스트가 본다. UI 테스트가 확인할 것은
// 「사용자가 누른 것이 문서에 무엇으로 들어가는가」다 — 엔진이 거부하지 않는 값인가까지.
import { describe, expect, it } from 'vitest';
import { createEmptyProject, easingFn, easingKey, EASING_PRESETS } from '@kitkat/schema';
import type { AudioClip, Easing, Keyframe, TextClip, VideoClip } from '@kitkat/schema';
import { applyCommands, findClip } from '@kitkat/engine';
import type { ProjectDoc } from '@kitkat/schema';
import {
  clipLocalMs,
  EASE_VIEW,
  easeFromSvgY,
  easeToSvgY,
  easingControlPoints,
  easingCurvePath,
  easingLabel,
  easingPeak,
  easingPresetId,
  effectParamPath,
  effectPathParts,
  groupClipKeyframes,
  keyframeDotCommands,
  keyframeDotState,
  keyframeLabel,
  keyframePathChoices,
  keyframeRatio,
  keyframesWithoutEffect,
  keyframeTimeFromRatio,
  keyframeValueAt,
  materializePatch,
  moveEasingPoint,
  removeKeyframePath,
  springParamValue,
  springSettleLabel,
  toggleKeyframeAt,
  withOvershootClamping,
  withSpringParam,
} from '../src/components/sections/inspector-utils';

// ── 픽스처 ────────────────────────────────────────────────────────────────

function video(over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: 'v1',
    kind: 'video',
    assetId: 'a1',
    start: 1000,
    duration: 2000,
    in: 0,
    out: 2000,
    speed: 1,
    volume: 0.8,
    transform: { x: 0.25, y: 0, scale: 1.5, rotation: 0 },
    opacity: 0.9,
    effects: [
      { id: 'fx1', type: 'brightness', params: { amount: 1 } },
      { id: 'fx2', type: 'blur', params: { px: 8 } },
    ],
    ...over,
  };
}

const text: TextClip = {
  id: 't1',
  kind: 'text',
  start: 0,
  duration: 1000,
  text: '안녕',
  style: { fontFamily: 'Pretendard', fontSize: 64, color: '#ffffff', align: 'center' },
};

const audio: AudioClip = {
  id: 'au1',
  kind: 'audio',
  assetId: 'a2',
  start: 0,
  duration: 1000,
  in: 0,
  out: 1000,
  speed: 1,
  volume: 1,
};

/** 실제 엔진에 통과시켜 본다 — UI 가 만든 명령이 BAD_KEYFRAME 으로 튕기면 실패. */
function runCommands(clip: VideoClip | TextClip, cmds: Parameters<typeof applyCommands>[1]): ProjectDoc {
  const doc = createEmptyProject({ name: 't' });
  doc.assets.a1 = { id: 'a1', kind: 'video', src: 'a.mp4', name: 'a.mp4', duration: 5000 };
  const track = doc.tracks.find((t) => (clip.kind === 'text' ? t.kind === 'text' : t.kind === 'video'))!;
  track.clips = [clip];
  return applyCommands(doc, cmds);
}

/** 명령을 돌린 뒤의 클립. */
function outClip(clip: VideoClip | TextClip, cmds: Parameters<typeof applyCommands>[1]) {
  return findClip(runCommands(clip, cmds), clip.id)!.clip;
}

// ═══ F7 이징 ═════════════════════════════════════════════════════════════

describe('F7 이징 프리셋', () => {
  it('프리셋 12종이 그대로 있다', () => {
    expect(EASING_PRESETS).toHaveLength(12);
  });

  it('프리셋을 고르면 그 프리셋이 다시 선택된 것으로 보인다(왕복)', () => {
    for (const p of EASING_PRESETS) expect(easingPresetId(p.easing)).toBe(p.id);
  });

  it('이름 4종과 같은 값의 베지어는 같은 프리셋으로 잡힌다', () => {
    expect(easingPresetId({ bezier: [0.42, 0, 0.58, 1] })).toBe('easeInOut');
    expect(easingPresetId({ bezier: [0.42, 0, 1, 1] })).toBe('easeIn');
    expect(easingPresetId({ bezier: [0, 0, 0.58, 1] })).toBe('easeOut');
  });

  it('프리셋이 아닌 값은 「사용자 지정」', () => {
    expect(easingPresetId({ bezier: [0.1, 0.9, 0.2, 0.3] })).toBeNull();
    expect(easingLabel({ bezier: [0.1, 0.9, 0.2, 0.3] })).toBe('사용자 지정 곡선');
    expect(easingLabel({ spring: { damping: 13 } })).toBe('사용자 지정 스프링');
    expect(easingLabel('easeInOut')).toBe('부드럽게');
  });

  it('이름 4종의 제어점은 schema 와 같은 값이고, 스프링은 제어점이 없다', () => {
    expect(easingControlPoints('easeInOut')).toEqual([0.42, 0, 0.58, 1]);
    expect(easingControlPoints('linear')).toEqual([0, 0, 1, 1]);
    // linear 의 제어점으로 만든 베지어는 실제로도 직선이다
    const f = easingFn({ bezier: [0, 0, 1, 1] });
    for (const u of [0.1, 0.25, 0.5, 0.75, 0.9]) expect(f(u)).toBeCloseTo(u, 6);
    expect(easingControlPoints({ spring: {} })).toBeNull();
  });
});

describe('F7 곡선 편집(드래그)', () => {
  it('가로는 0..1 로 막는다 — 스키마가 «클램프 없이 거부»하는 값이라 드래그로 문서를 깨면 안 된다', () => {
    const e = moveEasingPoint('easeInOut', 0, 1.8, 0.5) as { bezier: number[] };
    expect(e.bezier[0]).toBe(1);
    const e2 = moveEasingPoint('easeInOut', 1, -3, 0.5) as { bezier: number[] };
    expect(e2.bezier[2]).toBe(0);
  });

  it('세로는 편집기 범위(−0.5..1.5)까지 — 오버슈트를 살린다', () => {
    const up = moveEasingPoint('easeInOut', 1, 0.5, 9) as { bezier: number[] };
    expect(up.bezier[3]).toBe(EASE_VIEW.Y_MAX);
    const down = moveEasingPoint('easeInOut', 0, 0.5, -9) as { bezier: number[] };
    expect(down.bezier[1]).toBe(EASE_VIEW.Y_MIN);
    // 1 을 넘는 y 를 허용하므로 실제로 오버슈트하는 곡선이 만들어진다
    expect(easingPeak({ bezier: [0.5, 0, 0.5, 1.5] })).toBeGreaterThan(1);
  });

  it('프리셋에서 점을 하나 움직이면 나머지 세 좌표는 그대로다(프리셋이 출발점)', () => {
    const e = moveEasingPoint('easeOut', 1, 0.8, 0.2) as { bezier: number[] };
    expect(e.bezier).toEqual([0, 0, 0.8, 0.2]);
  });

  it('화면좌표 ↔ 이징값 변환이 서로 역함수다 (y=1 이 위 기준선, y=0 이 아래 기준선)', () => {
    expect(easeToSvgY(1)).toBe(25);
    expect(easeToSvgY(0)).toBe(75);
    for (const y of [-0.5, 0, 0.37, 1, 1.5]) expect(easeFromSvgY(easeToSvgY(y))).toBeCloseTo(y, 9);
  });
});

describe('F7 스프링', () => {
  it('슬라이더 값이 스키마 범위로 클램프된다 (damping 1..200, mass 0.1..10, stiffness 1..500)', () => {
    expect(withSpringParam({ spring: {} }, 'damping', 999)).toEqual({ spring: { damping: 200 } });
    expect(withSpringParam({ spring: {} }, 'damping', 0)).toEqual({ spring: { damping: 1 } });
    expect(withSpringParam({ spring: {} }, 'mass', 99)).toEqual({ spring: { mass: 10 } });
    expect(withSpringParam({ spring: {} }, 'stiffness', 0)).toEqual({ spring: { stiffness: 1 } });
  });

  it('베지어에서 스프링으로 바꾸면 기본값에서 시작한다', () => {
    const e = withSpringParam('easeInOut', 'damping', 8);
    expect(e).toEqual({ spring: { damping: 8 } });
    expect(easingPresetId(e)).toBe('springBouncy');
  });

  it('생략된 값은 remotion 과 같은 기본값(damping 10 · mass 1 · stiffness 100)', () => {
    expect(springParamValue({}, 'damping')).toBe(10);
    expect(springParamValue({}, 'mass')).toBe(1);
    expect(springParamValue({}, 'stiffness')).toBe(100);
    expect(springParamValue({ damping: 8 }, 'damping')).toBe(8);
  });

  it('「정착까지 N초」 — 기본값 1.84초, 탄력(damping 8)은 더 오래 흔들린다', () => {
    expect(springSettleLabel({})).toBe('정착까지 1.84초');
    expect(springSettleLabel({ damping: 8 })).toBe('정착까지 2.30초');
  });

  it('오버슈트 막기를 켜면 곡선이 1 을 안 넘고, 끄면 다시 넘는다', () => {
    const on = withOvershootClamping({ spring: { damping: 8 } }, true);
    expect(easingPeak(on)).toBeLessThanOrEqual(1);
    const off = withOvershootClamping(on, false);
    expect(easingPeak(off)).toBeGreaterThan(1);
    expect(off).toEqual({ spring: { damping: 8 } });
  });

  it('스프링 곡선은 실제로 1 을 넘는다 — 이게 안 되면 y축을 넓힌 의미가 없다', () => {
    const peakDefault = easingPeak({ spring: {} });
    const peakBouncy = easingPeak({ spring: { damping: 8 } });
    expect(peakDefault).toBeGreaterThan(1);
    expect(peakBouncy).toBeGreaterThan(peakDefault); // 탄력 프리셋이 더 튕긴다
  });
});

describe('F7 곡선 그리기', () => {
  it('종류와 무관하게 같은 방식으로 그린다 — 끝점은 규약대로 (0,0)·(1,1)', () => {
    for (const e of [EASING_PRESETS[0]!.easing, EASING_PRESETS[10]!.easing, { bezier: [0.3, 1.4, 0.6, 1] } as Easing]) {
      const d = easingCurvePath(e, 20);
      expect(d.startsWith(`M0.00,${easeToSvgY(0).toFixed(2)}`)).toBe(true);
      expect(d.endsWith(`L100.00,${easeToSvgY(1).toFixed(2)}`)).toBe(true);
      expect(d.split('L')).toHaveLength(21);
    }
  });

  it('스프링 곡선은 위쪽 기준선(y=1)보다 «위»로 나가는 점을 실제로 그린다', () => {
    const d = easingCurvePath({ spring: { damping: 8 } }, 60);
    const ys = d
      .split(/[ML]/)
      .filter(Boolean)
      .map((p) => Number(p.split(',')[1]));
    expect(Math.min(...ys)).toBeLessThan(easeToSvgY(1)); // SVG 는 y 가 작을수록 위
  });
});

// ═══ F13 키프레임 ════════════════════════════════════════════════════════

describe('F13 ◆ 버튼 상태', () => {
  const clip = video();

  it('키프레임이 없으면 ◇(off), 재생헤드에 있으면 ◆(on), 다른 곳에 있으면 ◈(other)', () => {
    expect(keyframeDotState(clip, 'opacity', 1500).status).toBe('off');
    const withKf = video({ keyframes: [{ time: 500, prop: 'opacity', value: 1, easing: 'linear' }] });
    expect(keyframeDotState(withKf, 'opacity', 1500).status).toBe('on'); // 1500 − start 1000 = 500
    expect(keyframeDotState(withKf, 'opacity', 1800).status).toBe('other');
  });

  it('재생헤드는 클립 기준 정수 ms 로 변환된다(클립 밖은 양 끝으로 붙는다)', () => {
    expect(clipLocalMs(clip, 1500.4)).toBe(500);
    expect(clipLocalMs(clip, 0)).toBe(0);
    expect(clipLocalMs(clip, 99999)).toBe(2000);
  });

  it('source.* 는 막히고, 「파일을 새로 굽는 설정」이라는 이유가 툴팁에 나온다', () => {
    const st = keyframeDotState(clip, 'source.lut.intensity', 1500);
    expect(st.status).toBe('blocked');
    expect(st.blocked).toBe('rejected');
    expect(st.title).toContain('영상 파일을 새로 굽는 설정');
    expect(keyframeDotCommands(clip, 'source.lut.intensity', 1500)).toEqual([]);
  });

  it('speed·curves 도 이유와 함께 막힌다', () => {
    expect(keyframeDotState(clip, 'speed', 1500).title).toContain('duration 불변식');
    expect(keyframeDotState(clip, 'curves.rgb', 1500).title).toContain('점 배열');
  });

  it('text 클립의 crop·volume 은 막힌다 (걸 수 있는데 아무 일도 안 일어나는 게 제일 나쁘다)', () => {
    expect(keyframeDotState(text, 'crop.x', 0).status).toBe('blocked');
    expect(keyframeDotState(text, 'volume', 0).title).toContain('text 클립에는');
    expect(keyframeDotState(audio, 'opacity', 0).status).toBe('blocked');
  });

  it('마스크가 꺼져 있으면 mask.x 는 「먼저 그 값을 켜고」로 막힌다 (엔진과 같은 문구)', () => {
    const st = keyframeDotState(clip, 'mask.x', 1500);
    expect(st.status).toBe('blocked');
    expect(st.blocked).toBe('missing');
    expect(st.title).toContain('먼저 그 값을 켜고');
  });
});

describe('F13 ◆ 토글', () => {
  it('누르면 재생헤드 시각에 현재 값으로 추가된다', () => {
    const clip = video();
    const next = toggleKeyframeAt(clip, 'opacity', 1750)!;
    expect(next).toEqual([{ time: 750, prop: 'opacity', value: 0.9, easing: 'linear' }]);
  });

  it('한 번 더 누르면 그 키프레임만 지워진다(토글)', () => {
    const kfs: Keyframe[] = [
      { time: 750, prop: 'opacity', value: 0.9, easing: 'linear' },
      { time: 750, prop: 'x', value: 0.25, easing: 'linear' },
      { time: 0, prop: 'opacity', value: 0.2, easing: 'linear' },
    ];
    const clip = video({ keyframes: kfs });
    const next = toggleKeyframeAt(clip, 'opacity', 1750)!;
    expect(next).toEqual([kfs[1], kfs[2]]); // 같은 시각의 x 도, 다른 시각의 opacity 도 남는다
  });

  it('이미 키프레임이 있으면 «그 시점의 보간값»으로 추가한다(값이 튀지 않게)', () => {
    const clip = video({
      keyframes: [
        { time: 0, prop: 'opacity', value: 0, easing: 'linear' },
        { time: 1000, prop: 'opacity', value: 1, easing: 'linear' },
      ],
    });
    expect(keyframeValueAt(clip, 'opacity', 500)).toBeCloseTo(0.5, 9);
    const next = toggleKeyframeAt(clip, 'opacity', 1500)!;
    expect(next[2]).toEqual({ time: 500, prop: 'opacity', value: 0.5, easing: 'linear' });
  });

  it('새 키프레임은 앞 키프레임의 이징을 이어받는다', () => {
    const clip = video({
      keyframes: [{ time: 0, prop: 'opacity', value: 0, easing: { spring: { damping: 8 } } }],
    });
    const next = toggleKeyframeAt(clip, 'opacity', 1500)!;
    expect(next[1]!.easing).toEqual({ spring: { damping: 8 } });
  });

  it('효과 파라미터에 걸면 엔진이 받아 준다 (effects#<id> 경로)', () => {
    const clip = video();
    const path = effectParamPath('fx2', 'px');
    const cmds = keyframeDotCommands(clip, path, 2000);
    expect(outClip(clip, cmds).keyframes).toEqual([
      { time: 1000, prop: 'effects#fx2.params.px', value: 8, easing: 'linear' },
    ]);
  });

  it('문서에 아직 없는 값(자간)은 «보이던 값»을 적으면서 키프레임을 건다 — 엔진 검증 통과', () => {
    expect(keyframeDotState(text, 'style.letterSpacing', 0).status).toBe('blocked');
    const st = keyframeDotState(text, 'style.letterSpacing', 0, 0);
    expect(st.status).toBe('off');
    expect(st.materialize).toEqual({ style: { ...text.style, letterSpacing: 0 } });
    const out = outClip(text, keyframeDotCommands(text, 'style.letterSpacing', 0, 0)) as TextClip;
    expect(out.style.letterSpacing).toBe(0);
    expect(out.keyframes).toEqual([{ time: 0, prop: 'style.letterSpacing', value: 0, easing: 'linear' }]);
  });

  it('crop 이 통째로 없으면 기본 크롭을 만들어 준다 (mask 는 만들지 않는다)', () => {
    const clip = video();
    expect(materializePatch(clip, 'crop.w', 0.5)).toEqual({ crop: { x: 0, y: 0, w: 0.5, h: 1 } });
    expect(materializePatch(clip, 'mask.x', 0.5)).toBeNull();
  });
});

describe('F13 경로별 묶기', () => {
  const clip = video({
    keyframes: [
      { time: 900, prop: 'opacity', value: 1, easing: 'linear' },
      { time: 0, prop: 'effects#fx1.params.amount', value: 1, easing: 'linear' },
      { time: 100, prop: 'opacity', value: 0, easing: 'easeIn' },
      { time: 500, prop: 'effects#fx1.params.amount', value: 2, easing: 'linear' },
      { time: 0, prop: 'mask.x', value: 0.3, easing: 'linear' },
    ],
  });

  it('평평한 목록이 경로별 그룹이 된다 (그룹 안은 시간 오름차순)', () => {
    const gs = groupClipKeyframes(clip);
    expect(gs.map((g) => g.path)).toEqual(['opacity', 'effects#fx1.params.amount', 'mask.x']);
    expect(gs[0]!.items.map((i) => i.kf.time)).toEqual([100, 900]);
    expect(gs[0]!.items.map((i) => i.index)).toEqual([2, 0]); // 원본 배열 인덱스를 유지한다
  });

  it('라벨은 한국어 — 효과는 그 클립의 실제 효과 종류·파라미터 이름으로 풀어 쓴다', () => {
    const gs = groupClipKeyframes(clip);
    expect(gs[0]!.label).toBe('불투명도');
    expect(gs[1]!.label).toBe('밝기 · 강도');
    expect(gs[2]!.label).toBe('마스크 X');
    expect(keyframeLabel(clip, 'effects#fx2.params.px')).toBe('흐림 · 흐림(px)');
  });

  it('대상이 없어진 경로는 지우지 않고 「대상 없음」으로 남긴다 (마스크를 껐다 켜면 살아 돌아온다)', () => {
    const gs = groupClipKeyframes(clip);
    expect(gs[2]!.missing).toBe(true); // 이 클립엔 mask 가 없다
    expect(gs[0]!.missing).toBe(false);
    expect(gs[1]!.rejection).toBeNull();
  });

  it('경로 하나를 통째로 지운다', () => {
    const next = removeKeyframePath(clip.keyframes!, 'opacity');
    expect(next).toHaveLength(3);
    expect(next.every((k) => k.prop !== 'opacity')).toBe(true);
  });
});

describe('F13 「추가」 드롭다운', () => {
  it('그 클립에 실제로 있는 효과만 펼쳐진다 (없는 효과는 안 보인다)', () => {
    const groups = keyframePathChoices(video());
    const fx = groups.find((g) => g.group === '효과')!;
    expect(fx.options.map((o) => o.value)).toEqual([
      'effects#fx1.params.amount',
      'effects#fx2.params.px',
    ]);
    expect(fx.options[0]!.label).toBe('밝기 · 강도');
  });

  it('대상이 없는 값(마스크 꺼짐·크롭 없음)은 목록에 안 나온다 — 골라도 엔진이 거부하니까', () => {
    const groups = keyframePathChoices(video());
    const paths = groups.flatMap((g) => g.options.map((o) => o.value));
    expect(paths).toContain('opacity');
    expect(paths).toContain('volume');
    expect(paths.some((p) => p.startsWith('mask.'))).toBe(false);
    expect(paths.some((p) => p.startsWith('crop.'))).toBe(false);
  });

  it('마스크를 켜면 마스크 경로 5개가 나타난다', () => {
    const clip = video({ mask: { shape: 'rect', feather: 0.1, x: 0, y: 0, w: 1, h: 1 } });
    const groups = keyframePathChoices(clip);
    const mask = groups.find((g) => g.group === '마스크')!;
    expect(mask.options.map((o) => o.value)).toEqual([
      'mask.x',
      'mask.y',
      'mask.w',
      'mask.h',
      'mask.feather',
    ]);
  });

  it('오디오 클립은 볼륨 하나뿐', () => {
    const groups = keyframePathChoices(audio);
    expect(groups).toEqual([{ group: '오디오', options: [{ value: 'volume', label: '볼륨' }] }]);
  });
});

describe('F13 효과 삭제 → 키프레임 정리', () => {
  const kfs: Keyframe[] = [
    { time: 0, prop: 'effects#fx1.params.amount', value: 1, easing: 'linear' },
    { time: 500, prop: 'effects#fx1.params.amount', value: 2, easing: 'linear' },
    { time: 0, prop: 'effects#fx2.params.px', value: 0, easing: 'linear' },
    { time: 0, prop: 'opacity', value: 1, easing: 'linear' },
  ];

  it('지운 효과의 키프레임만 사라지고 다른 효과·다른 값은 남는다', () => {
    const next = keyframesWithoutEffect(kfs, 'fx1');
    expect(next).toEqual([kfs[2], kfs[3]]);
  });

  it('id 가 앞부분만 같은 다른 효과는 지우지 않는다', () => {
    const tricky: Keyframe[] = [{ time: 0, prop: 'effects#fx10.params.px', value: 1, easing: 'linear' }];
    expect(keyframesWithoutEffect(tricky, 'fx1')).toEqual(tricky);
  });

  it('효과 삭제 + 키프레임 정리를 한 번에 보내면 엔진이 받아 준다', () => {
    const clip = video({ keyframes: kfs });
    const out = outClip(clip, [
      {
        type: 'updateClip',
        clipId: 'v1',
        patch: { effects: [{ id: 'fx2', type: 'blur', params: { px: 8 } }] },
      },
      { type: 'setKeyframes', clipId: 'v1', keyframes: keyframesWithoutEffect(kfs, 'fx1') },
    ]);
    expect(out.effects).toHaveLength(1);
    expect(out.keyframes!.map((k) => k.prop)).toEqual(['effects#fx2.params.px', 'opacity']);
  });

  it('정리하지 않으면 엔진이 «죽은 경로»를 거부한다 — 그래서 같이 지워야 한다', () => {
    const clip = video({ keyframes: kfs });
    expect(() =>
      runCommands(clip, [
        { type: 'updateClip', clipId: 'v1', patch: { effects: [{ id: 'fx2', type: 'blur', params: { px: 8 } }] } },
        { type: 'setKeyframes', clipId: 'v1', keyframes: kfs },
      ]),
    ).toThrow(/effects#fx1/);
  });
});

describe('F13 미니 타임라인', () => {
  const clip = video(); // duration 2000

  it('시간 ↔ 가로 비율', () => {
    expect(keyframeRatio(clip, 500)).toBe(0.25);
    expect(keyframeRatio(clip, 9999)).toBe(1);
    expect(keyframeTimeFromRatio(clip, 0.25)).toBe(500);
    expect(keyframeTimeFromRatio(clip, -1)).toBe(0);
    expect(keyframeTimeFromRatio(clip, 2)).toBe(2000);
  });

  it('드래그가 만든 시간은 늘 정수 ms — 엔진이 정수만 받는다', () => {
    for (const r of [0.123, 0.3337, 0.71828, 0.9999]) {
      expect(Number.isInteger(keyframeTimeFromRatio(clip, r))).toBe(true);
    }
  });
});

describe('경로 도우미', () => {
  it('effects#<id>.params.<key> 를 분해·조립한다', () => {
    expect(effectPathParts('effects#fx1.params.amount')).toEqual({ id: 'fx1', key: 'amount' });
    expect(effectPathParts('opacity')).toBeNull();
    expect(effectPathParts('effects[0].params.amount')).toBeNull(); // 인덱스 경로는 안 쓴다
    expect(effectParamPath('a-b_1', 'px')).toBe('effects#a-b_1.params.px');
  });

  it('이징 키가 같으면 같은 함수 객체를 쓴다(캐시) — 편집기 곡선과 렌더가 갈릴 수 없다', () => {
    expect(easingKey({ spring: {} })).toBe(easingKey({ spring: { damping: 10, mass: 1, stiffness: 100 } }));
    expect(easingFn('easeInOut')).toBe(easingFn({ bezier: [0.42, 0, 0.58, 1] }));
  });
});
