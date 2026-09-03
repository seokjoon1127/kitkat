// W8 F3 모션 블러 — B(트랜스폼 겹쳐 그리기) · C(전환 방향성 블러) 순수 계산 단위테스트.
// A(소스 파생)는 ffmpeg 쪽이라 media 패키지가 잰다.
import { describe, expect, it } from 'vitest';
import { TRANSITION_TYPES } from '@kitkat/schema';
import type { TransitionType } from '@kitkat/schema';
import {
  DEFAULT_TRANSFORM_BLUR,
  TRANSFORM_BLUR_GROUP_STYLE,
  transformBlurLayerStyle,
  transformBlurOffsets,
} from '../src/composition/transform-blur.js';
import {
  activeTransitionBlurs,
  activeTransitionStyles,
  transitionBlurAxis,
  transitionBlurStrength,
  transitionStyle,
} from '../src/composition/transitions.js';
import { buildFilterNodes } from '../src/composition/svg-filters.js';

const FPS = 30;
const FRAME_MS = 1000 / FPS;

describe('F3-B 트랜스폼 모션 블러 — 샘플 시각', () => {
  it('블러가 없으면 빈 배열 (겹쳐 그리기 자체를 안 한다 = 기존 렌더와 같다)', () => {
    expect(transformBlurOffsets(undefined, FPS)).toEqual([]);
  });

  it('셔터 각도 0 이면 빈 배열', () => {
    expect(transformBlurOffsets({ shutterAngle: 0, samples: 12 }, FPS)).toEqual([]);
  });

  it('샘플이 2장 미만이면 빈 배열 (한 장은 겹쳐도 그대로다)', () => {
    expect(transformBlurOffsets({ shutterAngle: 180, samples: 1 }, FPS)).toEqual([]);
    expect(transformBlurOffsets({ shutterAngle: 180, samples: 0 }, FPS)).toEqual([]);
  });

  it('fps 가 0 이하면 빈 배열 (0으로 나누지 않는다)', () => {
    expect(transformBlurOffsets(DEFAULT_TRANSFORM_BLUR, 0)).toEqual([]);
  });

  it('180° · 12장 · 30fps → 12개, 폭은 프레임 간격의 절반, 중앙 정렬', () => {
    const offs = transformBlurOffsets({ shutterAngle: 180, samples: 12 }, FPS);
    expect(offs).toHaveLength(12);
    const width = offs[offs.length - 1]! - offs[0]!;
    expect(width).toBeCloseTo(FRAME_MS / 2, 9);          // 180/360 = 0.5 프레임
    // 평균 0 — 블러를 켜고 끌 때 그림이 앞뒤로 밀리지 않아야 한다
    expect(offs.reduce((a, b) => a + b, 0) / offs.length).toBeCloseTo(0, 9);
    expect(offs[0]).toBeCloseTo(-FRAME_MS / 4, 9);
    expect(offs[11]).toBeCloseTo(FRAME_MS / 4, 9);
  });

  it('셔터 각도에 **비례**해 구간이 넓어진다 (90 : 180 : 360 = 1 : 2 : 4)', () => {
    const span = (angle: number): number => {
      const o = transformBlurOffsets({ shutterAngle: angle, samples: 8 }, FPS);
      return o[o.length - 1]! - o[0]!;
    };
    expect(span(90)).toBeCloseTo(FRAME_MS / 4, 9);
    expect(span(180)).toBeCloseTo(FRAME_MS / 2, 9);
    expect(span(360)).toBeCloseTo(FRAME_MS, 9);
    expect(span(180) / span(90)).toBeCloseTo(2, 9);
    expect(span(360) / span(90)).toBeCloseTo(4, 9);
  });

  it('samples 는 32 로 클램프된다 (한 프레임을 무한정 다시 그리지 않는다)', () => {
    expect(transformBlurOffsets({ shutterAngle: 180, samples: 999 }, FPS)).toHaveLength(32);
  });

  it('fps 가 높을수록 셔터 구간이 짧다 (같은 각도라도 프레임 간격이 짧다)', () => {
    const s30 = transformBlurOffsets({ shutterAngle: 180, samples: 4 }, 30);
    const s60 = transformBlurOffsets({ shutterAngle: 180, samples: 4 }, 60);
    expect(s30[3]! - s30[0]!).toBeCloseTo(2 * (s60[3]! - s60[0]!), 9);
  });

  it('겹쳐 그리는 한 장은 opacity 1/N + plus-lighter (더하면 정확히 평균)', () => {
    expect(transformBlurLayerStyle(12)).toEqual({ opacity: 1 / 12, mixBlendMode: 'plus-lighter' });
    expect(transformBlurLayerStyle(4).opacity).toBeCloseTo(0.25, 9);
    // 격리막이 없으면 첫 장이 아래 클립과 더해져 화면이 하얘진다
    expect(TRANSFORM_BLUR_GROUP_STYLE.isolation).toBe('isolate');
  });

  it('기본값은 180° · 12장', () => {
    expect(DEFAULT_TRANSFORM_BLUR).toEqual({ shutterAngle: 180, samples: 12 });
  });
});

describe('F3-C 전환 방향성 블러 — 방향과 세기', () => {
  it('슬라이드 4방향은 **이동 축으로만** 번진다', () => {
    expect(transitionBlurAxis('slideLeft')!.y).toBe(0);
    expect(transitionBlurAxis('slideRight')!.y).toBe(0);
    expect(transitionBlurAxis('slideLeft')!.x).toBeGreaterThan(0);
    expect(transitionBlurAxis('slideUp')!.x).toBe(0);
    expect(transitionBlurAxis('slideDown')!.x).toBe(0);
    expect(transitionBlurAxis('slideUp')!.y).toBeGreaterThan(0);
  });

  it('줌은 등방 «근사» — 방사형이 맞지만 SVG 로는 안 된다', () => {
    const z = transitionBlurAxis('zoomIn')!;
    expect(z.x).toBe(z.y);
    expect(z.x).toBeGreaterThan(0);
    expect(transitionBlurAxis('zoomOut')).toEqual(z);
  });

  it('휩팬은 슬라이드보다 4배 이상 세다 (그게 «휙» 으로 읽히는 조건)', () => {
    expect(transitionBlurAxis('whipPanLeft')!.x).toBeGreaterThanOrEqual(
      transitionBlurAxis('slideLeft')!.x * 4,
    );
    expect(transitionBlurAxis('whipPanLeft')!.y).toBe(0);
    expect(transitionBlurAxis('whipPanRight')!.y).toBe(0);
    expect(transitionBlurAxis('whipPanUp')!.x).toBe(0);
    expect(transitionBlurAxis('whipPanUp')!.y).toBeGreaterThan(0);
  });

  it('화면이 안 움직이는 전환(와이프·원형·페이드)에는 블러가 없다', () => {
    for (const t of ['fade', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown',
                     'circleOpen', 'circleClose', 'blurFade', 'glitch'] as TransitionType[]) {
      expect(transitionBlurAxis(t), t).toBeNull();
    }
  });

  it('세기 곡선은 전환 «중앙»에서 1, 양끝에서 0, 좌우 대칭', () => {
    expect(transitionBlurStrength(0.5)).toBeCloseTo(1, 9);
    expect(transitionBlurStrength(0)).toBe(0);
    expect(transitionBlurStrength(1)).toBe(0);
    expect(transitionBlurStrength(0.25)).toBeCloseTo(transitionBlurStrength(0.75), 9);
    expect(transitionBlurStrength(-5)).toBe(0);   // 클램프
    expect(transitionBlurStrength(9)).toBe(0);
  });
});

describe('F3-C activeTransitionBlurs — 래퍼와 짝이 맞는가', () => {
  const IN = { type: 'slideLeft' as const, duration: 1000 };
  const OUT = { type: 'whipPanUp' as const, duration: 1000 };

  it('activeTransitionStyles 와 길이·순서가 같다 (래퍼 i ↔ blurs[i])', () => {
    for (const t of [0, 250, 500, 900, 2000, 4600, 5000]) {
      const styles = activeTransitionStyles(t, 5000, IN, OUT);
      const blurs = activeTransitionBlurs(t, 5000, 'c1', 1, IN, OUT);
      expect(blurs.length, `t=${t}`).toBe(styles.length);
    }
  });

  it('전환 중앙에서 제일 세고 in/out 이 서로 다른 id 를 쓴다', () => {
    const mid = activeTransitionBlurs(500, 5000, 'c1', 1, IN, OUT);
    expect(mid).toHaveLength(1);
    expect(mid[0]!.id).toBe('tb-c1-in');
    expect(mid[0]!.x).toBeCloseTo(14, 9);   // slideLeft 최대 14px
    expect(mid[0]!.y).toBe(0);

    const outMid = activeTransitionBlurs(4500, 5000, 'c1', 1, IN, OUT);
    expect(outMid).toHaveLength(1);
    expect(outMid[0]!.id).toBe('tb-c1-out');
    expect(outMid[0]!.x).toBe(0);
    expect(outMid[0]!.y).toBeCloseTo(60, 9);   // whipPanUp
  });

  it('in·out 이 겹치는 짧은 클립에서도 둘 다 나온다 (래퍼 2개 ↔ 블러 2개)', () => {
    // 길이 600ms 인데 앞뒤 전환이 각각 500ms — 300ms 지점은 둘 다 활성이다
    const styles = activeTransitionStyles(300, 600, { type: 'slideLeft', duration: 500 },
      { type: 'whipPanUp', duration: 500 });
    const blurs = activeTransitionBlurs(300, 600, 'c1', 1, { type: 'slideLeft', duration: 500 },
      { type: 'whipPanUp', duration: 500 });
    expect(styles).toHaveLength(2);
    expect(blurs).toHaveLength(2);
    expect(blurs[0]!.id).toBe('tb-c1-in');
    expect(blurs[1]!.id).toBe('tb-c1-out');
    expect(blurs[0]!.y).toBe(0);   // 가로
    expect(blurs[1]!.x).toBe(0);   // 세로
  });

  it('전환 양끝에서는 <filter> 를 아예 안 만든다 (null)', () => {
    expect(activeTransitionBlurs(0, 5000, 'c1', 1, IN, OUT)[0]).toBeNull();
    expect(activeTransitionBlurs(5000, 5000, 'c1', 1, IN, OUT).at(-1)).toBeNull();
  });

  it('캔버스 높이에 비례한다 (720p 와 4K 에서 같은 세기로 보인다)', () => {
    const h1080 = activeTransitionBlurs(500, 5000, 'c1', 1, IN)[0]!;
    const h2160 = activeTransitionBlurs(500, 5000, 'c1', 2, IN)[0]!;
    expect(h2160.x).toBeCloseTo(h1080.x * 2, 9);
  });

  it('블러 없는 전환(와이프)은 null 이지만 자리는 지킨다', () => {
    const styles = activeTransitionStyles(500, 5000, { type: 'wipeLeft', duration: 1000 });
    const blurs = activeTransitionBlurs(500, 5000, 'c1', 1, { type: 'wipeLeft', duration: 1000 });
    expect(styles).toHaveLength(1);
    expect(blurs).toEqual([null]);
  });
});

describe('F3-C 휩팬 3종', () => {
  it('TRANSITION_TYPES 뒤에 3종이 붙었고 앞 20종 순서는 그대로다', () => {
    // W8 F16 이 뒤에 28종을 더 붙였다 — 휩팬 3종의 «자리»(20..22)는 그대로여야 한다.
    expect(TRANSITION_TYPES.length).toBeGreaterThanOrEqual(23);
    expect(TRANSITION_TYPES.slice(20, 23)).toEqual(['whipPanLeft', 'whipPanRight', 'whipPanUp']);
    expect(TRANSITION_TYPES[0]).toBe('fade');
    expect(TRANSITION_TYPES[19]).toBe('glitch');
  });

  it('도착하면(visibility 1) 제자리 — 전환이 끝나고 그림이 밀려 있으면 안 된다', () => {
    for (const t of ['whipPanLeft', 'whipPanRight', 'whipPanUp'] as const) {
      expect(transitionStyle(t, 1)).toEqual({
        transform: t === 'whipPanUp' ? 'translateY(0%)' : 'translateX(0%)',
      });
    }
  });

  it('슬라이드보다 «시작이 급하다» — 같은 진행도에서 더 멀리 있다', () => {
    const num = (s: unknown): number => parseFloat(/(-?[\d.]+)%/.exec(String(s))![1]!);
    // v=0 (막 시작): 휩팬 130% vs 슬라이드 100%
    expect(num(transitionStyle('whipPanLeft', 0).transform)).toBeCloseTo(130, 6);
    expect(num(transitionStyle('slideLeft', 0).transform)).toBeCloseTo(100, 6);
    // v=0.75 (거의 도착): gone² 이라 슬라이드보다 훨씬 가까이 와 있다
    expect(num(transitionStyle('whipPanLeft', 0.75).transform)).toBeCloseTo(130 * 0.0625, 6);
    expect(num(transitionStyle('slideLeft', 0.75).transform)).toBeCloseTo(25, 6);
  });

  it('좌우가 반대 방향이고 위는 Y 축이다', () => {
    expect(transitionStyle('whipPanLeft', 0.5).transform).toBe('translateX(32.5%)');
    expect(transitionStyle('whipPanRight', 0.5).transform).toBe('translateX(-32.5%)');
    expect(transitionStyle('whipPanUp', 0.5).transform).toBe('translateY(32.5%)');
  });
});

describe('F3-C dirBlur SVG 스테이지', () => {
  const node = (x: number, y: number): Record<string, unknown> => {
    const nodes = buildFilterNodes([{ kind: 'dirBlur', id: 'b0', data: { x, y } }]);
    expect(nodes).toHaveLength(1);
    return (nodes[0] as { props: Record<string, unknown> }).props;
  };

  it('가로 블러는 stdDeviation="N 0" — 세로로는 안 번진다', () => {
    expect(node(20, 0).stdDeviation).toBe('20 0');
  });

  it('세로 블러는 stdDeviation="0 N"', () => {
    expect(node(0, 12.5).stdDeviation).toBe('0 12.5');
  });

  it('등방(줌 근사)은 두 값이 같다', () => {
    expect(node(8, 8).stdDeviation).toBe('8 8');
  });

  it('소수는 4자리로 자르고 음수는 0 으로 막는다', () => {
    expect(node(1 / 3, -5).stdDeviation).toBe('0.3333 0');
  });

  it('이전 스테이지를 입력으로 이어받는다 (체인 안에서도 쓸 수 있다)', () => {
    expect(node(4, 0).in).toBe('SourceGraphic');
    expect(node(4, 0).result).toBe('b0');
  });
});
