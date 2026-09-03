import { describe, expect, it } from 'vitest';
import {
  EASING_PRESETS,
  EasingSchema,
  ProjectDocSchema,
  createEmptyProject,
  cubicBezier,
  easingFn,
  easingKey,
  springSettleTimeSec,
  type Easing,
  type ProjectDoc,
  type VideoClip,
} from '../src/index.js';

// ── 회귀 기준: W8 이전 구현 (engine/apply.ts, renderer/keyframes.ts 에 «두 벌» 있던 것) ──
// 이 사본은 «옮기다 틀리지 않았는지»를 재는 자 역할만 한다. 여기 말고 다른 곳에 사본을 만들지 마라.
function legacyCubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
  const a = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
  const b = (a1: number, a2: number) => 3 * a2 - 6 * a1;
  const c = (a1: number) => 3 * a1;
  const calc = (t: number, a1: number, a2: number) => ((a(a1, a2) * t + b(a1, a2)) * t + c(a1)) * t;
  const slope = (t: number, a1: number, a2: number) => 3 * a(a1, a2) * t * t + 2 * b(a1, a2) * t + c(a1);
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const s = slope(t, p1x, p2x);
      if (s === 0) break;
      t -= (calc(t, p1x, p2x) - x) / s;
    }
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return calc(t, p1y, p2y);
  };
}
const LEGACY: Record<string, (t: number) => number> = {
  linear: (t) => t,
  easeIn: legacyCubicBezier(0.42, 0, 1, 1),
  easeOut: legacyCubicBezier(0, 0, 0.58, 1),
  easeInOut: legacyCubicBezier(0.42, 0, 0.58, 1),
};

/** u = 0, 0.001, …, 1.000 (1001점) */
const GRID = Array.from({ length: 1001 }, (_, i) => i / 1000);

describe('easingFn — 기존 4종 회귀 (한 자리도 변하면 안 된다)', () => {
  for (const name of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
    it(`${name}: 1001점 전부 비트 동일`, () => {
      const f = easingFn(name);
      const g = LEGACY[name]!;
      let same = 0;
      for (const u of GRID) if (f(u) === g(u)) same++;
      expect(same).toBe(GRID.length);
    });
  }
});

describe('easingFn — 베지어 등가성', () => {
  const pairs: [Easing, Easing][] = [
    ['easeIn', { bezier: [0.42, 0, 1, 1] }],
    ['easeOut', { bezier: [0, 0, 0.58, 1] }],
    ['easeInOut', { bezier: [0.42, 0, 0.58, 1] }],
  ];
  for (const [name, bez] of pairs) {
    it(`${String(name)} === ${JSON.stringify(bez)} (1001점 전부)`, () => {
      const f = easingFn(name);
      const g = easingFn(bez);
      let same = 0;
      for (const u of GRID) if (f(u) === g(u)) same++;
      expect(same).toBe(GRID.length);
    });
  }

  it('이름 4종과 같은 값의 베지어는 «같은 함수 객체»를 쓴다 (갈릴 수가 없다)', () => {
    expect(easingFn('easeInOut')).toBe(easingFn({ bezier: [0.42, 0, 0.58, 1] }));
    expect(easingKey('easeInOut')).toBe(easingKey({ bezier: [0.42, 0, 0.58, 1] }));
  });

  it('cubicBezier 를 직접 써도 같은 값 (구현이 하나라는 확인)', () => {
    const direct = cubicBezier(0.42, 0, 0.58, 1);
    for (const u of GRID) expect(direct(u)).toBe(easingFn('easeInOut')(u));
  });

  it('오버슈트 베지어(backSoft/backHard)는 y 가 1을 넘거나 0 아래로 간다', () => {
    const soft = easingFn({ bezier: [0.34, 1.56, 0.64, 1] });
    const hard = easingFn({ bezier: [0.68, -0.6, 0.32, 1.6] });
    expect(Math.max(...GRID.map(soft))).toBeGreaterThan(1);
    expect(Math.min(...GRID.map(hard))).toBeLessThan(0);
    expect(Math.max(...GRID.map(hard))).toBeGreaterThan(1);
  });

  it('x 가 0..1 을 벗어난 베지어는 클램프해서 NaN 을 내지 않는다 (문서는 zod 가 먼저 거부한다)', () => {
    const f = easingFn({ bezier: [1.5, 0, -0.3, 1] });
    for (const u of GRID) expect(Number.isFinite(f(u))).toBe(true);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
  });

  it('easingFn 은 캐시된다 — 같은 설정이면 같은 함수 객체', () => {
    expect(easingFn({ spring: {} })).toBe(easingFn({ spring: { damping: 10 } }));
    expect(easingFn({ bezier: [0.4, 0, 0.2, 1] })).toBe(easingFn({ bezier: [0.4, 0, 0.2, 1] }));
  });
});

describe('easingFn — 스프링', () => {
  it('끝점은 규약이다: 12종 프리셋 전부 f(0)===0, f(1)===1', () => {
    for (const p of EASING_PRESETS) {
      const f = easingFn(p.easing);
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
    }
  });

  it('구간 밖 입력도 0/1 로 잘린다 (linear 는 기존대로 항등 — 값이 변하면 안 된다)', () => {
    for (const p of EASING_PRESETS) {
      if (p.id === 'linear') continue;
      const f = easingFn(p.easing);
      expect(f(-1)).toBe(0);
      expect(f(2)).toBe(1);
    }
    expect(easingFn('linear')(-1)).toBe(-1); // 회귀: 예전 구현과 같다
  });

  it('기본값(damping 10, ζ=0.5)은 실제로 오버슈트한다 — 최댓값 약 1.16', () => {
    const f = easingFn({ spring: {} });
    const max = Math.max(...GRID.map(f));
    expect(max).toBeGreaterThan(1);
    expect(max).toBeGreaterThan(1.15);
    expect(max).toBeLessThan(1.17);
  });

  it('탄력(damping 8)이 기본값보다 더 튕긴다', () => {
    const bouncy = Math.max(...GRID.map(easingFn({ spring: { damping: 8 } })));
    const base = Math.max(...GRID.map(easingFn({ spring: {} })));
    expect(bouncy).toBeGreaterThan(base);
  });

  it('overshootClamping:true 면 1을 넘지 않는다', () => {
    const f = easingFn({ spring: { overshootClamping: true } });
    for (const u of GRID) expect(f(u)).toBeLessThanOrEqual(1);
    expect(Math.max(...GRID.map(f))).toBe(1); // f(1) 규약
  });

  it('과감쇠(damping 200)는 단조 증가 — 1001점 전부', () => {
    const f = easingFn({ spring: { damping: 200 } });
    let bad = 0;
    for (let i = 1; i < GRID.length; i++) if (f(GRID[i]!) < f(GRID[i - 1]!)) bad++;
    expect(bad).toBe(0);
  });

  it('임계감쇠(ζ=1, damping 20)도 단조 증가하고 오버슈트가 없다', () => {
    const f = easingFn({ spring: { damping: 20 } }); // ζ = 20/(2√100) = 1
    let bad = 0;
    for (let i = 1; i < GRID.length; i++) if (f(GRID[i]!) < f(GRID[i - 1]!)) bad++;
    expect(bad).toBe(0);
    expect(Math.max(...GRID.map(f))).toBe(1);
  });

  it('정착 시간: 기본값 T ≈ 1.84초, damping 8 이면 ≈ 2.30초', () => {
    expect(springSettleTimeSec({})).toBeCloseTo(1.842, 3);
    expect(springSettleTimeSec({ damping: 8 })).toBeCloseTo(2.3025, 3);
  });

  it('구간 길이와 무관하게 «모양»이 같다 (진행도 정규화 A안)', () => {
    // f 는 u 만 받는다 — 200ms 구간이든 2000ms 구간이든 같은 u 에서 같은 값이다.
    const f = easingFn({ spring: { damping: 8 } });
    expect(f(0.25)).toBe(f(0.25));
    expect(Number.isFinite(f(0.5))).toBe(true);
  });

  it('easingKey 는 생략된 필드를 기본값으로 채워 정규화한다', () => {
    expect(easingKey({ spring: {} })).toBe('s:10,1,100,0');
    expect(easingKey({ spring: { damping: 10, mass: 1, stiffness: 100 } })).toBe('s:10,1,100,0');
    expect(easingKey({ spring: { overshootClamping: true } })).toBe('s:10,1,100,1');
  });
});

describe('EASING_PRESETS', () => {
  it('12종이고 id 가 중복되지 않는다', () => {
    expect(EASING_PRESETS.length).toBe(12);
    expect(new Set(EASING_PRESETS.map((p) => p.id)).size).toBe(12);
  });

  it('전부 유효한 이징이고 스키마를 통과한다', () => {
    for (const p of EASING_PRESETS) {
      expect(EasingSchema.safeParse(p.easing).success).toBe(true);
    }
  });
});

describe('Easing zod — 문서 왕복', () => {
  function docWith(easing: unknown): unknown {
    const doc = createEmptyProject({ name: '이징' }) as ProjectDoc;
    const clip: VideoClip = {
      id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 1000,
      in: 0, out: 1000, speed: 1, volume: 1,
      keyframes: [
        { time: 0, prop: 'x', value: 0, easing: easing as Easing },
        { time: 1000, prop: 'x', value: 0.5, easing: 'linear' },
      ],
    };
    doc.assets['a1'] = { id: 'a1', kind: 'video', src: 'media/a.mp4', name: 'a.mp4', duration: 5000 };
    doc.tracks[0]!.clips.push(clip);
    return JSON.parse(JSON.stringify(doc));
  }

  it('스프링 이징이 든 문서: 저장 → 로드 → 값 동일', () => {
    const raw = docWith({ spring: { damping: 8, overshootClamping: false } });
    const parsed = ProjectDocSchema.parse(raw);
    expect(parsed.tracks[0]!.clips[0]!.keyframes![0]!.easing).toEqual({
      spring: { damping: 8, overshootClamping: false },
    });
  });

  it('기존 4종 문자열 문서는 그대로 통과 (하위호환)', () => {
    expect(ProjectDocSchema.safeParse(docWith('easeInOut')).success).toBe(true);
  });

  it('p1x 범위 밖 베지어는 거부 (조용히 클램프하지 않는다)', () => {
    const r = ProjectDocSchema.safeParse(docWith({ bezier: [1.2, 0, 0.5, 1] }));
    expect(r.success).toBe(false);
  });

  it('bezier 와 spring 이 둘 다 든 값은 거부 (.strict)', () => {
    expect(ProjectDocSchema.safeParse(docWith({ bezier: [0.4, 0, 0.2, 1], spring: {} })).success).toBe(false);
  });

  it('알 수 없는 이징 이름은 거부', () => {
    expect(ProjectDocSchema.safeParse(docWith('easeInOutQuint')).success).toBe(false);
  });

  it('spring 파라미터 범위 밖(damping 0)은 거부', () => {
    expect(ProjectDocSchema.safeParse(docWith({ spring: { damping: 0 } })).success).toBe(false);
  });
});
