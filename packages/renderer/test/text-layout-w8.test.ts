// W8 F8 — 키네틱 타이포. 「수치는 computeTextLayout 한 곳에서만 나온다」를 지키는 테스트.
//
// 여기서 가장 중요한 것은 **v1 불변**이다. 기존 5종을 쓰는 문서는 스타일 문자열까지
// 한 글자도 달라지면 안 된다 — 달라지면 기존 프로젝트의 자막 움직임이 조용히 바뀐다.
import { beforeAll, describe, expect, it } from 'vitest';
import type { TextClip, TextStyle } from '@kitkat/schema';
import {
  animOpts,
  animUnitStyle,
  breakChunks,
  computeTextLayout,
  legacyEaseOutBack,
  measureTextWidth,
  setTextMeasurer,
  splitLines,
  splitUnits,
  staggerOrder,
  staggerTiming,
  textAnimEasing,
  textCss,
} from '../src/composition/text-layout.js';

const STYLE: TextStyle = {
  fontFamily: 'sans-serif',
  fontSize: 60,
  color: '#ffffff',
  align: 'center',
};

function clip(over: Partial<TextClip> = {}): TextClip {
  return {
    id: 'tx1', kind: 'text', start: 0, duration: 3000,
    text: '안녕하세요', style: STYLE, ...over,
  } as TextClip;
}

/** 테스트용 결정적 측정기 — 한글 1em, 그 밖 0.5em. 캔버스 없는 노드에서도 같은 답이 나온다. */
beforeAll(() => {
  setTextMeasurer((text, font) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    let w = 0;
    for (const ch of text) w += /[가-힣ㄱ-ㅎ]/.test(ch) ? size : size * 0.5;
    return w;
  });
});

// ── 1. 스태거 수식 (계획 08 §검증 4) ─────────────────────────────────────

describe('스태거 — 자르지 않고 압축한다', () => {
  it('글자 40개 · duration 600ms · 시차 30ms → 시차 9.23ms · 단위당 240ms', () => {
    const t = staggerTiming(40, 600, 30);
    expect(t.stagger).toBeCloseTo(600 * 0.6 / 39, 10);
    expect(t.stagger).toBeCloseTo(9.2308, 4);
    expect(t.perUnit).toBeCloseTo(240, 10);
  });

  it('마지막 단위가 정확히 duration 에서 끝난다 (±1ms 가 아니라 정확히)', () => {
    for (const [n, dur, want] of [[40, 600, 30], [5, 800, 120], [12, 1000, 60]] as const) {
      const t = staggerTiming(n, dur, want);
      expect((n - 1) * t.stagger + t.perUnit).toBeCloseTo(dur, 9);
      // 마지막 단위의 진행도가 tMs = duration 에서 정확히 1.0
      const raw = (dur - (n - 1) * t.stagger) / t.perUnit;
      expect(raw).toBeCloseTo(1, 12);
    }
  });

  it('perUnit 은 항상 duration 의 40% 이상이다', () => {
    for (const n of [2, 5, 40, 200]) {
      const t = staggerTiming(n, 600, 10000);
      expect(t.perUnit).toBeGreaterThanOrEqual(600 * 0.4 - 1e-9);
    }
  });

  it('단위가 1개면 0으로 나누지 않는다', () => {
    expect(staggerTiming(1, 800, 30)).toEqual({ stagger: 0, perUnit: 800 });
    expect(staggerTiming(0, 800, 30)).toEqual({ stagger: 0, perUnit: 800 });
    expect(staggerTiming(5, 0, 30)).toEqual({ stagger: 0, perUnit: 0 });
  });

  it('요청한 시차가 여유 안이면 그대로 쓴다', () => {
    const t = staggerTiming(5, 2000, 60);
    expect(t.stagger).toBe(60);
    expect(t.perUnit).toBe(2000 - 4 * 60);
  });
});

describe('시차 순서 (origin)', () => {
  it('start / end / center', () => {
    expect(staggerOrder(4, 'start', 'x')).toEqual([0, 1, 2, 3]);
    expect(staggerOrder(4, 'end', 'x')).toEqual([3, 2, 1, 0]);
    // 가운데부터 — 가운데 두 글자가 먼저(0,1), 바깥이 나중
    expect(staggerOrder(4, 'center', 'x')).toEqual([2, 0, 1, 3]);
  });

  it('random 은 클립 id 시드로 «결정적»이다 — 렌더마다 다르면 미리보기와 갈린다', () => {
    const a = staggerOrder(12, 'random', 'clip-a');
    const b = staggerOrder(12, 'random', 'clip-a');
    const c = staggerOrder(12, 'random', 'clip-b');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect([...a].sort((x, y) => x - y)).toEqual([...Array(12).keys()]); // 순열이다
  });
});

// ── 2. v1 불변 (계획 08 §검증 1) ─────────────────────────────────────────

describe('v1 불변 — 기존 5종의 스타일 문자열이 한 글자도 안 바뀐다', () => {
  const v1Fade = (v: number) => ({ opacity: v });
  const v1SlideUp = (v: number) => ({ opacity: v, transform: `translateY(${(1 - v) * 40}px)` });
  const v1PopIn = (v: number) => ({
    opacity: Math.min(1, v * 2),
    transform: `scale(${Math.max(0.001, legacyEaseOutBack(v))})`,
  });

  it('fade · slideUp · popIn 이 v1 참조 구현과 같은 객체를 낸다', () => {
    for (const v of [0, 0.13, 0.37, 0.5, 0.9, 1]) {
      const o = animOpts({ type: 'fade', duration: 500 }, 1.7777);
      expect(animUnitStyle('fade', v, v, o)).toEqual(v1Fade(v));
      expect(animUnitStyle('slideUp', v, v, o)).toEqual(v1SlideUp(v));
      expect(animUnitStyle('popIn', v, legacyEaseOutBack(v), o)).toEqual(v1PopIn(v));
    }
  });

  it('distance 를 안 적으면 40px 을 «스케일하지 않는다» — 1080×1920 문서의 slideUp 이 안 변한다', () => {
    expect(animOpts({ type: 'slideUp', duration: 500 }, 1.7777).distance).toBe(40);
    // 적으면 그때부터는 1080 기준 px 이다
    expect(animOpts({ type: 'slideUp', duration: 500, distance: 24 }, 2).distance).toBe(48);
  });

  it('popIn 의 기본 이징은 v1 easeOutBack 과 비트 동일하다 (backSoft 로 바꾸지 않았다)', () => {
    const f = textAnimEasing({ type: 'popIn', duration: 500 });
    for (let i = 0; i <= 100; i++) expect(f(i / 100)).toBe(legacyEaseOutBack(i / 100));
  });

  it('fade·slideUp·typewriter·wordHighlight 의 기본 이징은 항등(linear)이다', () => {
    for (const type of ['fade', 'slideUp', 'typewriter', 'wordHighlight'] as const) {
      const f = textAnimEasing({ type, duration: 500 });
      for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(f(t)).toBe(t);
    }
  });

  it('unit 이 없으면 통짜 경로다 — DOM 이 v1 과 같다(lines === null)', () => {
    const l = computeTextLayout({
      clip: clip({ animationIn: { type: 'slideUp', duration: 500 } }),
      tMs: 250, canvasW: 1080, canvasH: 1920,
    });
    expect(l.lines).toBeNull();
    expect(l.wrapperStyles).toEqual([{ opacity: 0.5, transform: `translateY(${0.5 * 40}px)` }]);
  });

  it('타자기·단어 강조는 v1 그대로 (글자 수 올림 · 현재 단어만 강조)', () => {
    const c = clip({ text: 'ABCDEFGHIJ', animationIn: { type: 'typewriter', duration: 1000 } });
    expect(computeTextLayout({ clip: c, tMs: 300, canvasW: 1080, canvasH: 1920 }).text)
      .toBe('ABC');
    const w = clip({
      text: '하나 둘', animationIn: { type: 'wordHighlight', duration: 2000 },
      words: [{ text: '하나', start: 0, duration: 500 }, { text: '둘', start: 500, duration: 500 }],
      highlightColor: '#ff0000',
    });
    const l = computeTextLayout({ clip: w, tMs: 600, canvasW: 1080, canvasH: 1920 });
    expect(l.words?.map((x) => x.highlighted)).toEqual([false, true]);
    expect(l.words?.map((x) => x.text)).toEqual(['하나 ', '둘']);
  });
});

// ── 3. 미리보기 ↔ 렌더 일치의 뿌리 ───────────────────────────────────────

describe('paintOrder 회귀 — 두 경로가 같은 textCss 를 쓴다', () => {
  it('두꺼운 외곽선에 paintOrder:"stroke fill" 이 있다 (전에는 렌더에만 있었다)', () => {
    const css = textCss({ ...STYLE, strokeColor: '#000', strokeWidth: 12 }, 1);
    expect(css.paintOrder).toBe('stroke fill');
    expect(css.WebkitTextStroke).toBe('12px #000');
  });

  it('fontScale 에 비례해 외곽선 두께가 커진다', () => {
    expect(textCss({ ...STYLE, strokeColor: '#000', strokeWidth: 12 }, 0.5).WebkitTextStroke)
      .toBe('6px #000');
  });

  it('computeTextLayout 은 fps 를 받지 않는다 — 같은 절대 시각이면 같은 그림이다', () => {
    // 24/30/60fps 에서 400ms 는 프레임 번호가 9.6 / 12 / 24 로 다르지만 tMs 는 같다.
    const c = clip({ animationIn: { type: 'slideUp', duration: 500, unit: 'char', staggerMs: 30 } });
    const a = computeTextLayout({ clip: c, tMs: 400, canvasW: 1080, canvasH: 1920 });
    const b = computeTextLayout({ clip: c, tMs: 400, canvasW: 1080, canvasH: 1920 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('style.fontSize 키프레임이 미리보기 경로에서도 먹는다 (전에는 렌더에만 먹었다)', () => {
    const c = clip({
      keyframes: [
        { time: 0, prop: 'style.fontSize', value: 60, easing: 'linear' },
        { time: 1000, prop: 'style.fontSize', value: 120, easing: 'linear' },
      ],
    });
    const l = computeTextLayout({ clip: c, tMs: 500, canvasW: 1080, canvasH: 1080 });
    expect(l.boxStyle.fontSize).toBeCloseTo(90, 6);
  });
});

// ── 4. 줄 나누기 · 단위 쪼개기 ───────────────────────────────────────────

describe('줄 나누기와 단위', () => {
  it('한글은 아무 데서나, 라틴은 공백에서만 꺾인다', () => {
    expect(breakChunks('가나다')).toEqual(['가', '나', '다']);
    expect(breakChunks('hello world')).toEqual(['hello ', 'world']);
    expect(breakChunks('안녕 hi')).toEqual(['안', '녕 ', 'hi']);
  });

  it('그리디 줄바꿈 — 폭을 넘으면 끊는다', () => {
    // 한글 1글자 = 60px. 최대 200px → 3글자씩
    expect(splitLines('가나다라마바사', STYLE, 200)).toEqual(['가나다', '라마바', '사']);
  });

  it('명시적 줄바꿈(\\n)은 언제나 줄을 끊는다', () => {
    expect(splitLines('가나\n다', STYLE, 10000)).toEqual(['가나', '다']);
  });

  it('자간이 폭에 들어간다', () => {
    expect(measureTextWidth('가나', STYLE)).toBe(120);
    expect(measureTextWidth('가나', { ...STYLE, letterSpacing: 10 })).toBe(140);
  });

  it('char 단위는 코드포인트로 자른다 — 이모지가 깨지지 않는다', () => {
    expect(splitUnits('a🙂b', 'char').map((p) => p.text)).toEqual(['a', '🙂', 'b']);
  });

  it('공백은 자리를 지키되 «보이는 단위»로 세지 않는다', () => {
    const u = splitUnits('가 나', 'char');
    expect(u.map((p) => p.text)).toEqual(['가', ' ', '나']);
    expect(u.map((p) => p.visible)).toEqual([true, false, true]);
  });

  it('word 단위는 공백을 앞 단어에 붙인다 — inline-block 사이 자리가 유지된다', () => {
    expect(splitUnits('하나 둘 셋', 'word').map((p) => p.text)).toEqual(['하나 ', '둘 ', '셋']);
  });

  it('line 단위는 줄 하나가 단위다', () => {
    expect(splitUnits('가나다', 'line')).toEqual([{ text: '가나다', visible: true }]);
  });
});

// ── 5. 단위별 시차가 실제로 «다른 글자를 다르게» 만든다 ──────────────────

describe('단위별 시차 — 프레임마다 다른 글자가 보인다', () => {
  const c = clip({
    text: '가나다라마',
    animationIn: { type: 'fade', duration: 500, unit: 'char', staggerMs: 60 },
  });

  it('스팬이 글자 수만큼 생기고 불투명도가 «서로 다르다»', () => {
    const l = computeTextLayout({ clip: c, tMs: 120, canvasW: 1080, canvasH: 1080 });
    const units = l.lines!.flatMap((x) => x.units);
    expect(units.map((u) => u.text)).toEqual(['가', '나', '다', '라', '마']);
    const op = units.map((u) => Number(u.style.opacity ?? 1));
    expect(new Set(op.map((v) => v.toFixed(4))).size).toBeGreaterThan(1);
    // 앞 글자가 뒤 글자보다 진하다 (origin 'start')
    for (let i = 1; i < op.length; i++) expect(op[i - 1]!).toBeGreaterThanOrEqual(op[i]!);
  });

  it('duration 이 지나면 전부 1.0 (스태거가 잘리지 않는다)', () => {
    const l = computeTextLayout({ clip: c, tMs: 500, canvasW: 1080, canvasH: 1080 });
    const units = l.lines!.flatMap((x) => x.units);
    for (const u of units) expect(u.style.opacity ?? 1).toBeCloseTo(1, 9);
  });

  it('스팬은 inline-block · white-space:pre 다 (줄바꿈 규칙을 우리가 쥔다)', () => {
    const l = computeTextLayout({ clip: c, tMs: 100, canvasW: 1080, canvasH: 1080 });
    for (const u of l.lines!.flatMap((x) => x.units)) {
      expect(u.style.display).toBe('inline-block');
      expect(u.style.whiteSpace).toBe('pre');
    }
  });

  it('unit:"line" 은 줄이 단위다', () => {
    const l = computeTextLayout({
      clip: clip({ text: '가나\n다라', animationIn: { type: 'slideUp', duration: 500, unit: 'line' } }),
      tMs: 100, canvasW: 1080, canvasH: 1080,
    });
    expect(l.lines).toHaveLength(2);
    expect(l.lines!.map((x) => x.units.map((u) => u.text).join(''))).toEqual(['가나', '다라']);
  });
});

// ── 6. 와이프 ────────────────────────────────────────────────────────────

describe('와이프 — 부드럽게가 기본, distance 0 이면 칼로 자른다', () => {
  const o = (distance?: number) =>
    animOpts({ type: 'wipeLeft', duration: 500, ...(distance !== undefined ? { distance } : {}) }, 1);

  it('기본은 mask-image 그라디언트(폭 15%)', () => {
    const s = animUnitStyle('wipeLeft', 0.5, 0.5, o());
    expect(String(s.maskImage)).toBe('linear-gradient(to right, #000 35.000%, transparent 50.000%)');
    expect(s.WebkitMaskImage).toBe(s.maskImage);
  });

  it('distance 0 이면 clip-path inset — transitions.tsx 의 같은 이름과 같은 기하다', () => {
    expect(animUnitStyle('wipeLeft', 0.5, 0.5, o(0)).clipPath).toBe('inset(0 50% 0 0)');
    expect(animUnitStyle('wipeRight', 0.5, 0.5, o(0)).clipPath).toBe('inset(0 0 0 50%)');
    expect(animUnitStyle('wipeUp', 0.5, 0.5, o(0)).clipPath).toBe('inset(0 0 50% 0)');
    expect(animUnitStyle('wipeDown', 0.5, 0.5, o(0)).clipPath).toBe('inset(50% 0 0 0)');
  });

  it('진행도 1 이면 전부 보인다', () => {
    expect(animUnitStyle('wipeLeft', 1, 1, o(0)).clipPath).toBe('inset(0 0% 0 0)');
  });
});

describe('신규 움직임들이 실제로 스타일을 낸다', () => {
  it('20종 전부 빈 스타일이 아니다 (typewriter·wordHighlight 제외)', () => {
    const o = animOpts({ type: 'fade', duration: 500 }, 1);
    for (const type of [
      'fade', 'slideUp', 'popIn', 'slideDown', 'slideLeft', 'slideRight',
      'scaleUp', 'scaleDown', 'blurIn', 'rotateIn', 'flipX', 'flipY',
      'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'bounceIn', 'springUp',
    ] as const) {
      expect(Object.keys(animUnitStyle(type, 0.4, 0.4, o)).length).toBeGreaterThan(0);
    }
    expect(animUnitStyle('typewriter', 0.4, 0.4, o)).toEqual({});
    expect(animUnitStyle('wordHighlight', 0.4, 0.4, o)).toEqual({});
  });

  it('blurIn 은 진행할수록 흐림이 준다', () => {
    const o = animOpts({ type: 'blurIn', duration: 500 }, 1);
    expect(animUnitStyle('blurIn', 0, 0, o).filter).toBe('blur(12.000px)');
    expect(animUnitStyle('blurIn', 1, 1, o).filter).toBe('blur(0.000px)');
  });

  it('bounceIn·springUp 의 기본 이징이 스프링이다 (1을 넘었다 돌아온다)', () => {
    const f = textAnimEasing({ type: 'bounceIn', duration: 500 });
    let peak = 0;
    for (let i = 0; i <= 200; i++) peak = Math.max(peak, f(i / 200));
    expect(peak).toBeGreaterThan(1);
  });
});

describe('퇴장 애니메이션', () => {
  it('퇴장은 등장을 거꾸로 돌린 것이다 — v1 과 같은 값', () => {
    const c = clip({ duration: 1000, animationOut: { type: 'fade', duration: 400 } });
    // v1: outVis = (duration - t)/outDuration
    for (const t of [700, 800, 900, 1000]) {
      const l = computeTextLayout({ clip: c, tMs: t, canvasW: 1080, canvasH: 1080 });
      const expected = Math.min(1, Math.max(0, (1000 - t) / 400));
      if (expected < 1) expect(l.wrapperStyles[0]!.opacity).toBeCloseTo(expected, 12);
    }
  });

  it('퇴장에도 단위 시차가 걸린다', () => {
    const c = clip({
      text: '가나다라마', duration: 1000,
      animationOut: { type: 'fade', duration: 400, unit: 'char', staggerMs: 60 },
    });
    const l = computeTextLayout({ clip: c, tMs: 800, canvasW: 1080, canvasH: 1080 });
    const op = l.lines!.flatMap((x) => x.units).map((u) => Number(u.style.opacity ?? 1));
    expect(new Set(op.map((v) => v.toFixed(4))).size).toBeGreaterThan(1);
  });
});
