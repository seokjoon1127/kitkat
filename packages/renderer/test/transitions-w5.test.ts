import { describe, expect, it } from 'vitest';
import { TRANSITION_TYPES } from '@kitkat/schema';
import {
  CIRCLE_FULL_PCT,
  activeTransitionOverlays,
  transitionOverlays,
  transitionStyle,
} from '../src/composition/transitions.js';

const num = (s: unknown, re: RegExp): number => {
  const m = re.exec(String(s));
  expect(m, `${String(s)} 가 ${re} 와 안 맞음`).not.toBeNull();
  return parseFloat(m![1]!);
};

describe('전환 51종 — 공통 불변식', () => {
  it('TRANSITION_TYPES 51종 전부 스타일을 돌려준다', () => {
    // W8 F16: 23 → 51 (카탈로그에서 파생된다). 개수는 catalog.test.ts 가 갈래별로 못 박는다.
    expect(TRANSITION_TYPES).toHaveLength(51);
    for (const t of TRANSITION_TYPES) {
      const s = transitionStyle(t, 0.5);
      expect(Object.keys(s).length, `${t} 가 빈 스타일`).toBeGreaterThan(0);
      expect(JSON.stringify(s)).not.toContain('NaN');
    }
  });

  it('visibility 1 이면 어떤 전환도 클립을 가리지 않는다 (opacity 1)', () => {
    for (const t of TRANSITION_TYPES) {
      const s = transitionStyle(t, 1);
      expect(s.opacity ?? 1, `${t}`).toBe(1);
      expect(JSON.stringify(s)).not.toContain('NaN');
      // 덮개도 없어야 한다
      expect(transitionOverlays(t, 1), `${t} 덮개`).toEqual([]);
    }
  });

  it('visibility 는 0..1 로 클램프된다', () => {
    expect(transitionStyle('fade', -3)).toEqual(transitionStyle('fade', 0));
    expect(transitionStyle('fade', 9)).toEqual(transitionStyle('fade', 1));
  });
});

describe('W5 전환 12종 — 스타일 계산', () => {
  it('wipe 4방향은 서로 다른 변에서 열린다', () => {
    expect(transitionStyle('wipeLeft', 0.25)).toEqual({ clipPath: 'inset(0 75% 0 0)' });
    expect(transitionStyle('wipeRight', 0.25)).toEqual({ clipPath: 'inset(0 0 0 75%)' });
    expect(transitionStyle('wipeUp', 0.25)).toEqual({ clipPath: 'inset(0 0 75% 0)' });
    expect(transitionStyle('wipeDown', 0.25)).toEqual({ clipPath: 'inset(75% 0 0 0)' });
    for (const t of ['wipeRight', 'wipeUp', 'wipeDown'] as const) {
      expect(transitionStyle(t, 1).clipPath).toBe(
        t === 'wipeRight' ? 'inset(0 0 0 0%)' : t === 'wipeUp' ? 'inset(0 0 0% 0)' : 'inset(0% 0 0 0)',
      );
    }
  });

  it('circleOpen 은 반지름이 0 → 화면을 덮는 값까지 자란다', () => {
    expect(transitionStyle('circleOpen', 0)).toEqual({ clipPath: 'circle(0% at 50% 50%)' });
    const half = num(transitionStyle('circleOpen', 0.5).clipPath, /circle\(([\d.]+)%/);
    expect(half).toBeCloseTo(CIRCLE_FULL_PCT / 2, 5);
    expect(num(transitionStyle('circleOpen', 1).clipPath, /circle\(([\d.]+)%/)).toBeCloseTo(70.72, 5);
    // 사각형 대각선을 덮으려면 √2/2 = 70.71% 이상이어야 한다
    expect(CIRCLE_FULL_PCT).toBeGreaterThanOrEqual(70.71);
  });

  it('circleClose 는 바깥에서 조여드는 마스크 (radial-gradient)', () => {
    const start = transitionStyle('circleClose', 0);
    expect(String(start.maskImage)).toContain('radial-gradient');
    expect(String(start.maskImage)).toContain('rgba(0,0,0,0) 100%');
    expect(start.WebkitMaskImage).toBe(start.maskImage);
    const end = transitionStyle('circleClose', 1);
    expect(String(end.maskImage)).toContain('#fff 0%');
  });

  it('blurFade 는 opacity + blur 를 같이 준다', () => {
    expect(transitionStyle('blurFade', 0.5)).toEqual({ opacity: 0.5, filter: 'blur(12px)' });
    expect(transitionStyle('blurFade', 1)).toEqual({ opacity: 1, filter: 'blur(0px)' });
  });

  it('spin 은 회전 + 축소, 진행하며 원래대로', () => {
    const s = transitionStyle('spin', 0);
    expect(s.opacity).toBe(0);
    expect(num(s.transform, /rotate\((-?[\d.]+)deg\)/)).toBeCloseTo(180, 5);
    expect(num(s.transform, /scale\(([\d.]+)\)/)).toBeCloseTo(0.4, 5);
    expect(transitionStyle('spin', 1).transform).toBe('rotate(0deg) scale(1)');
  });

  it('bounce 는 easeOutBack 이라 중간에 목표를 지나친다(오버슈트)', () => {
    expect(num(transitionStyle('bounce', 0).transform, /translateY\((-?[\d.]+)%\)/)).toBeCloseTo(60, 5);
    expect(num(transitionStyle('bounce', 1).transform, /translateY\((-?[\d.]+)%\)/)).toBeCloseTo(0, 5);
    const mid = num(transitionStyle('bounce', 0.8).transform, /translateY\((-?[\d.]+)%\)/);
    expect(mid).toBeLessThan(0); // 오버슈트 → 위로 지나쳤다가 돌아온다
  });

  it('shake 는 좌우로 흔들리고 진행할수록 잦아든다', () => {
    const amps: number[] = [];
    for (const v of [0.1, 0.4, 0.7, 0.95]) {
      const tx = num(transitionStyle('shake', v).transform, /translateX\((-?[\d.e-]+)%\)/);
      amps.push(Math.abs(tx));
      expect(Math.abs(tx)).toBeLessThanOrEqual(8);
    }
    expect(amps[0]!).toBeGreaterThan(amps[3]!);
    // 부호가 여러 번 바뀐다 (실제로 흔들린다)
    const signs = [0.05, 0.15, 0.25, 0.35, 0.45].map((v) =>
      Math.sign(num(transitionStyle('shake', v).transform, /translateX\((-?[\d.e-]+)%\)/)),
    );
    expect(new Set(signs).size).toBeGreaterThan(1);
  });

  it('glitch 는 지터 + 색틀어짐이고 같은 진행도면 항상 같다 (결정적)', () => {
    const a = transitionStyle('glitch', 0.3);
    const b = transitionStyle('glitch', 0.3);
    expect(a).toEqual(b);
    expect(String(a.filter)).toMatch(/hue-rotate\(-?[\d.]+deg\) saturate\([\d.]+\)/);
    expect(Math.abs(num(a.transform, /translateX\((-?[\d.]+)%\)/))).toBeLessThanOrEqual(6);
    expect(transitionStyle('glitch', 1).filter).toBe('hue-rotate(0deg) saturate(1)');
  });

  it('whiteFlash/blackFlash 는 클립을 빠르게 되돌리고 화면은 덮개가 채운다', () => {
    expect(transitionStyle('whiteFlash', 0)).toEqual({ opacity: 0 });
    expect(transitionStyle('whiteFlash', 0.25)).toEqual({ opacity: 1 });
    expect(transitionStyle('blackFlash', 0.5)).toEqual({ opacity: 1 });
  });
});

describe('activeTransitionOverlays — 덮개', () => {
  it('whiteFlash 덮개는 흰색이고 전환 시작에서 가장 진하다', () => {
    const o0 = transitionOverlays('whiteFlash', 0);
    expect(o0).toHaveLength(1);
    expect(o0[0]!.style.backgroundColor).toBe('#ffffff');
    expect(o0[0]!.style.opacity).toBe(1);
    expect(transitionOverlays('whiteFlash', 0.75)[0]!.style.opacity).toBeCloseTo(0.25, 5);
    expect(transitionOverlays('blackFlash', 0.5)[0]!.style.backgroundColor).toBe('#000000');
  });

  it('glitch 덮개는 스캔라인 + 찢김 띠 2개', () => {
    const o = transitionOverlays('glitch', 0.4);
    expect(o.map((x) => x.key)).toEqual(['scan', 'tear1', 'tear2']);
    expect(String(o[0]!.style.background)).toContain('repeating-linear-gradient');
    expect(o[1]!.style.mixBlendMode).toBe('screen');
    expect(String(o[1]!.style.top)).toMatch(/^[\d.]+%$/);
    expect(String(o[2]!.style.background)).toContain('255,0,128');
  });

  it('덮개가 필요 없는 전환은 빈 배열', () => {
    for (const t of ['fade', 'wipeLeft', 'circleOpen', 'spin', 'bounce'] as const) {
      expect(transitionOverlays(t, 0.5)).toEqual([]);
    }
  });

  it('in/out 구간에서만 나오고 key 에 접두사가 붙는다', () => {
    const tin = { type: 'whiteFlash' as const, duration: 500 };
    const tout = { type: 'glitch' as const, duration: 400 };
    expect(activeTransitionOverlays(0, 3000, tin, tout).map((o) => o.key)).toEqual(['in-flash']);
    expect(activeTransitionOverlays(1500, 3000, tin, tout)).toEqual([]);
    expect(activeTransitionOverlays(2800, 3000, tin, tout).map((o) => o.key)).toEqual([
      'out-scan',
      'out-tear1',
      'out-tear2',
    ]);
  });
});
