// W8 F16 — **카탈로그 ↔ 렌더러 구현 일대일 대응.**
//
// 이 파일이 막는 사고는 하나다: 「목록에는 올려 놓고 그리는 코드를 안 짜는 것」.
// W5 에서도 W8 에서도 그게 반복됐다 — 드롭다운에는 나오는데 걸면 아무 일도 안 일어난다.
// 반대 방향(구현은 있는데 목록에 없다)도 같이 본다: 그러면 아무도 그 효과를 못 고른다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EFFECT_CATALOG, TRANSITION_CATALOG } from '@kitkat/schema';
import type { Effect, EffectType, TransitionType } from '@kitkat/schema';
import {
  effectOverlays,
  effectSvgStages,
  effectsToFilter,
  vignetteAmount,
} from '../src/composition/effects.js';
import { effectGlStages } from '../src/composition/gl-effects.js';
import {
  transitionBlurAxis,
  transitionOverlays,
  transitionSplitPx,
  transitionStyle,
} from '../src/composition/transitions.js';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/composition/${rel}`, import.meta.url)), 'utf8');

/** 소스에서 `case 'xxx':` 라벨을 전부 긁는다 — 「구현은 있는데 목록에 없는 것」을 잡는 용도. */
function caseLabels(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/case '([A-Za-z][A-Za-z0-9]*)':/g)) out.add(m[1] as string);
  return out;
}

/**
 * 그 효과가 «실제로 뭔가 하는» 파라미터. 기본값이 항등인 효과(gamma 1·색온도 6500K·sharpen 0)를
 * 기본값으로 시험하면 「구현이 없다」와 「기본값이 항등이다」를 구별할 수 없다.
 */
function activeParams(type: EffectType): Record<string, number> {
  const def = EFFECT_CATALOG.find((d) => d.id === type)!;
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.key] = p.def === p.max ? p.min : p.max;
  return out;
}

const eff = (type: EffectType): Effect => ({ id: `e-${type}`, type, params: activeParams(type) });

describe('전환 51종 — 카탈로그에 있는 것은 전부 그려진다', () => {
  it('모든 전환이 «중간»에서 빈 스타일이 아니다 (목록에만 있고 구현이 없으면 여기서 걸린다)', () => {
    for (const d of TRANSITION_CATALOG) {
      const s = transitionStyle(d.id as TransitionType, 0.5);
      expect(Object.keys(s).length, `${d.id} 가 빈 스타일 — 구현이 없다`).toBeGreaterThan(0);
      expect(JSON.stringify(s), d.id).not.toContain('NaN');
      expect(JSON.stringify(s), d.id).not.toContain('undefined');
    }
  });

  it('모든 전환이 «끝»에서 원래대로 돌아온다 (전환이 끝났는데 그림이 밀려 있으면 안 된다)', () => {
    // 항등인 항 하나. 함수 목록을 늘어놓는 대신 «인자가 항등인가»를 본다 —
    // 새 전환이 어떤 조합을 쓰든 이 검사는 그대로 유효하다.
    const IDENTITY_TERM =
      /^(translate\(0%,0%\)|translateX?Y?\(0%\)|translate[XY]\(0%\)|scale[XY]?\(1\)|rotate[XY]?\(0deg\)|perspective\([\d.]+px\)|blur\(0px\)|saturate\(1\)|hue-rotate\(0deg\)|sepia\(0\)|brightness\(1\)|contrast\(1\)|grayscale\(0\)|invert\(0\)|opacity\(1\))$/;
    const allIdentity = (s: string): boolean =>
      s.replace(/,\s+/g, ',').trim().split(/\s+/).every((term) => IDENTITY_TERM.test(term));

    for (const d of TRANSITION_CATALOG) {
      const s = transitionStyle(d.id as TransitionType, 1);
      expect(s.opacity ?? 1, `${d.id} opacity`).toBe(1);
      if (s.transform) expect(allIdentity(String(s.transform)), `${d.id} → ${s.transform}`).toBe(true);
      if (s.filter) expect(allIdentity(String(s.filter)), `${d.id} → ${s.filter}`).toBe(true);
      expect(transitionOverlays(d.id as TransitionType, 1), `${d.id} 덮개`).toEqual([]);
    }
  });

  it('모든 전환이 «시작»에서 NaN 을 안 낸다', () => {
    for (const d of TRANSITION_CATALOG) {
      expect(JSON.stringify(transitionStyle(d.id as TransitionType, 0)), d.id).not.toContain('NaN');
      expect(JSON.stringify(transitionOverlays(d.id as TransitionType, 0)), d.id).not.toContain('NaN');
    }
  });

  it('needs:dirBlur 를 적은 전환에만 방향성 블러가 있다 (양방향)', () => {
    for (const d of TRANSITION_CATALOG) {
      const declared = (d.needs ?? []).includes('dirBlur');
      const actual = transitionBlurAxis(d.id as TransitionType) !== null;
      expect(actual, `${d.id}: 카탈로그 ${declared} / 구현 ${actual}`).toBe(declared);
    }
  });

  it('needs:rgbSplit 을 적은 전환에만 채널 분리가 있다 (양방향)', () => {
    for (const d of TRANSITION_CATALOG) {
      const declared = (d.needs ?? []).includes('rgbSplit');
      expect(transitionSplitPx(d.id as TransitionType) !== null, d.id).toBe(declared);
    }
  });

  it('블러와 채널 분리는 같은 자리를 쓰므로 둘 다 걸린 전환은 없다', () => {
    for (const d of TRANSITION_CATALOG) {
      const t = d.id as TransitionType;
      expect(transitionBlurAxis(t) !== null && transitionSplitPx(t) !== null, d.id).toBe(false);
    }
  });

  it('transitions.tsx 가 «목록에 없는» 전환을 그리지 않는다 (잉여 0)', () => {
    const ids = new Set(TRANSITION_CATALOG.map((d) => d.id));
    // 스타일 switch 밖에도 case 가 있으므로(블러 축) 두 곳을 합쳐서 본다
    for (const label of caseLabels(src('transitions.tsx'))) {
      expect(ids.has(label), `transitions.tsx 의 '${label}' 이 카탈로그에 없다`).toBe(true);
    }
  });

  it('카탈로그에 없는 전환 이름을 주면 빈 스타일이다 (조용한 기본 그림이 없다)', () => {
    expect(transitionStyle('없는전환' as TransitionType, 0.5)).toEqual({});
  });
});

describe('효과 50종 — impl 이 적힌 경로에 실제 구현이 있다', () => {
  it.each(EFFECT_CATALOG.filter((d) => d.impl === 'css').map((d) => d.id))(
    "css: %s 는 CSS filter 문자열을 만든다",
    (id) => {
      expect(effectsToFilter([eff(id as EffectType)])).not.toBe('');
    },
  );

  it.each(EFFECT_CATALOG.filter((d) => d.impl === 'svg').map((d) => d.id))(
    'svg: %s 는 SVG 필터 스테이지를 만든다',
    (id) => {
      expect(effectSvgStages([eff(id as EffectType)]).length).toBeGreaterThan(0);
    },
  );

  it.each(EFFECT_CATALOG.filter((d) => d.impl === 'overlay').map((d) => d.id))(
    'overlay: %s 는 오버레이를 만든다',
    (id) => {
      const e = eff(id as EffectType);
      // vignette 만 예외 — 오버레이지만 v1 부터 `vignetteAmount` 라는 별도 경로로 나간다.
      const made = effectOverlays([e]).length > 0 || vignetteAmount([e]) > 0;
      expect(made).toBe(true);
    },
  );

  // W8 #8 — 「대기」가 없어졌다. webgl 6종은 **셰이더 스테이지 하나**로 나가고, 다른 세 경로에는
  // 아무것도 안 만든다(반쯤 두 곳에서 그리면 더 헷갈린다).
  it.each(EFFECT_CATALOG.filter((d) => d.impl === 'webgl').map((d) => d.id))(
    'webgl: %s 는 WebGL 스테이지를 만들고, CSS·SVG·오버레이에는 아무것도 안 만든다',
    (id) => {
      const e = eff(id as EffectType);
      expect(effectGlStages([e]).length).toBeGreaterThan(0);
      expect(effectsToFilter([e])).toBe('');
      expect(effectSvgStages([e])).toEqual([]);
      expect(effectOverlays([e])).toEqual([]);
      expect(vignetteAmount([e])).toBe(0);
    },
  );

  it('대기(pending) 효과가 하나도 없다 — 50종 전부 그려진다', () => {
    expect(EFFECT_CATALOG.filter((d) => d.pending)).toEqual([]);
  });

  it('effects.ts 가 «목록에 없는» 효과를 그리지 않는다 (잉여 0)', () => {
    const ids = new Set<string>(EFFECT_CATALOG.map((d) => d.id));
    for (const label of caseLabels(src('effects.ts'))) {
      expect(ids.has(label), `effects.ts 의 '${label}' 이 카탈로그에 없다`).toBe(true);
    }
  });

  it('webgl 6종의 case 는 gl-effects.ts 에만 있고 effects.ts 에는 없다 (구현 자리가 한 곳이다)', () => {
    const svgSide = caseLabels(src('effects.ts'));
    const glSide = caseLabels(src('gl-effects.ts'));
    for (const d of EFFECT_CATALOG.filter((x) => x.impl === 'webgl')) {
      expect(svgSide.has(d.id), `${d.id} 가 webgl 인데 effects.ts 에 case 가 있다`).toBe(false);
      expect(glSide.has(d.id), `${d.id} 가 webgl 인데 gl-effects.ts 에 case 가 없다`).toBe(true);
    }
  });

  it('gl-effects.ts 가 «목록에 없는» 효과를 그리지 않는다 (잉여 0)', () => {
    const ids = new Set<string>(EFFECT_CATALOG.filter((d) => d.impl === 'webgl').map((d) => d.id));
    for (const label of caseLabels(src('gl-effects.ts'))) {
      expect(ids.has(label), `gl-effects.ts 의 '${label}' 이 webgl 카탈로그에 없다`).toBe(true);
    }
  });

  it('만들어진 스테이지·오버레이에 NaN 이 없다 (50종 × 기본값 · 최대값)', () => {
    for (const d of EFFECT_CATALOG) {
      for (const params of [
        Object.fromEntries(d.params.map((p) => [p.key, p.def])),
        activeParams(d.id as EffectType),
        Object.fromEntries(d.params.map((p) => [p.key, p.min])),
      ]) {
        const e: Effect = { id: 'x', type: d.id as EffectType, params };
        const dump = JSON.stringify([
          effectsToFilter([e]), effectSvgStages([e]), effectOverlays([e]), effectGlStages([e]),
        ]);
        expect(dump, `${d.id} ${JSON.stringify(params)}`).not.toContain('NaN');
        expect(dump, d.id).not.toContain('Infinity');
      }
    }
  });

  it('파라미터가 통째로 없어도 죽지 않는다 (손으로 고친 문서 방어)', () => {
    for (const d of EFFECT_CATALOG) {
      const e = { id: 'x', type: d.id as EffectType, params: {} } as Effect;
      expect(() => [effectsToFilter([e]), effectSvgStages([e]), effectOverlays([e]), effectGlStages([e])], d.id)
        .not.toThrow();
    }
  });
});
