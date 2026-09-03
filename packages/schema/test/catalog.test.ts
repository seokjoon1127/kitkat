// W8 F16 — 전환·효과 카탈로그의 «계약». 개수·순서·중복·대기 사유를 여기서 못 박는다.
import { describe, expect, it } from 'vitest';
import {
  EFFECT_CATALOG,
  EFFECT_GROUPS,
  EFFECT_TYPES,
  PENDING_EFFECT_TYPES,
  TRANSITION_CATALOG,
  TRANSITION_GROUPS,
  TRANSITION_TYPES,
  defaultEffectParams,
  effectDef,
  effectParamStep,
  isPendingEffect,
  transitionDef,
} from '../src/index.js';
import type { EffectGroup, TransitionGroup } from '../src/index.js';

const countBy = <T extends string>(items: readonly { group: T }[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[i.group] = (out[i.group] ?? 0) + 1;
  return out;
};

describe('전환 카탈로그', () => {
  it('51종이고 TRANSITION_TYPES 와 개수·순서가 같다', () => {
    expect(TRANSITION_CATALOG).toHaveLength(51);
    expect(TRANSITION_TYPES).toEqual(TRANSITION_CATALOG.map((d) => d.id));
  });

  it('id 가 중복되지 않는다', () => {
    expect(new Set(TRANSITION_TYPES).size).toBe(TRANSITION_TYPES.length);
  });

  it('이름도 중복되지 않는다 — 드롭다운에 같은 글자가 두 번 나오면 못 고른다', () => {
    const names = TRANSITION_CATALOG.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('앞머리 23종의 순서가 그대로다 (저장된 문서의 type 이 살아 있어야 한다)', () => {
    expect(TRANSITION_TYPES.slice(0, 8)).toEqual([
      'fade', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'wipeLeft', 'zoomIn', 'zoomOut',
    ]);
    expect(TRANSITION_TYPES.slice(19, 23)).toEqual([
      'glitch', 'whipPanLeft', 'whipPanRight', 'whipPanUp',
    ]);
  });

  it('갈래별 분포 — 계획 16 의 표대로', () => {
    // 기본 5 / 슬라이드 12 / 와이프 11 / 줌 6 / 회전 5 / 충격 9 / 휩팬 3 = 51
    expect(countBy(TRANSITION_CATALOG)).toEqual({
      basic: 5, slide: 12, wipe: 11, zoom: 6, rotate: 5, impact: 9, whip: 3,
    });
  });

  it('모든 전환의 group 이 TRANSITION_GROUPS 안에 있다', () => {
    const set = new Set<TransitionGroup>(TRANSITION_GROUPS);
    for (const d of TRANSITION_CATALOG) expect(set.has(d.group), d.id).toBe(true);
  });

  it('needs 는 알려진 선행 기능만 적는다', () => {
    const known = new Set(['dirBlur', 'rgbSplit', 'webgl']);
    for (const d of TRANSITION_CATALOG) {
      for (const n of d.needs ?? []) expect(known.has(n), `${d.id} → ${n}`).toBe(true);
    }
  });

  it('전환에는 «대기» 가 없다 — 51종 전부 지금 그려진다', () => {
    for (const d of TRANSITION_CATALOG) {
      expect((d.needs ?? []).includes('webgl'), d.id).toBe(false);
    }
  });

  it('transitionDef 로 찾을 수 있고 없는 id 는 undefined', () => {
    expect(transitionDef('whipZoom')?.group).toBe('zoom');
    expect(transitionDef('없는것')).toBeUndefined();
  });
});

describe('효과 카탈로그', () => {
  it('50종이고 EFFECT_TYPES 와 개수·순서가 같다', () => {
    expect(EFFECT_CATALOG).toHaveLength(50);
    expect(EFFECT_TYPES).toEqual(EFFECT_CATALOG.map((d) => d.id));
  });

  it('id·이름이 중복되지 않는다', () => {
    expect(new Set(EFFECT_TYPES).size).toBe(EFFECT_TYPES.length);
    const names = EFFECT_CATALOG.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('앞머리 20종의 순서가 그대로다', () => {
    expect(EFFECT_TYPES.slice(0, 9)).toEqual([
      'brightness', 'contrast', 'saturation', 'hue', 'blur', 'vignette', 'grayscale', 'sepia', 'invert',
    ]);
    expect(EFFECT_TYPES[19]).toBe('lightLeak');
  });

  it('갈래별 분포 — 계획 16 의 표대로', () => {
    // 기본색 10 / 룩 10 / 흐림 9 / 질감 9 / 왜곡 7 / 스타일 5 = 50
    expect(countBy(EFFECT_CATALOG)).toEqual({
      color: 10, look: 10, focus: 9, texture: 9, distort: 7, style: 5,
    });
  });

  // W8 #8 — WebGL 6종(vibrance·bokeh·radialBlur·mirror·kaleidoscope·halftone)이 구현돼 «대기»가 0 이다.
  it('50종 전부 그려진다 — 대기 0, webgl 6', () => {
    expect(PENDING_EFFECT_TYPES).toEqual([]);
    expect(EFFECT_CATALOG.filter((d) => d.impl === 'webgl').map((d) => d.id).sort()).toEqual(
      ['bokeh', 'halftone', 'kaleidoscope', 'mirror', 'radialBlur', 'vibrance'].sort(),
    );
  });

  it('어느 항목에도 pending 이 없고 isPendingEffect 는 전부 false 다', () => {
    for (const d of EFFECT_CATALOG) {
      expect(d.pending, d.id).toBeUndefined();
      expect(isPendingEffect(d.id), d.id).toBe(false);
    }
    expect(isPendingEffect('없는효과')).toBe(false);
  });

  it('webgl 6종의 파라미터 — 기본값이 범위 안이고, 새로 보강한 키가 있다', () => {
    expect(effectDef('radialBlur')!.params.map((p) => p.key)).toEqual(['px', 'cx', 'cy']);
    expect(effectDef('mirror')!.params.map((p) => p.key)).toEqual(['axis', 'side', 'pos']);
    expect(effectDef('mirror')!.params[0]!.max).toBe(2); // 0 좌우 · 1 상하 · 2 사분면
    for (const d of EFFECT_CATALOG.filter((x) => x.impl === 'webgl')) {
      for (const p of d.params) {
        expect(p.def, `${d.id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
        expect(p.def, `${d.id}.${p.key}`).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it('모든 효과의 group·impl 이 알려진 값이다', () => {
    const groups = new Set<EffectGroup>(EFFECT_GROUPS);
    const impls = new Set(['css', 'svg', 'overlay', 'webgl']);
    for (const d of EFFECT_CATALOG) {
      expect(groups.has(d.group), d.id).toBe(true);
      expect(impls.has(d.impl), d.id).toBe(true);
    }
  });

  it('모든 효과에 파라미터가 최소 1개 있고 def 이 min..max 안이다', () => {
    for (const d of EFFECT_CATALOG) {
      expect(d.params.length, d.id).toBeGreaterThan(0);
      for (const p of d.params) {
        expect(p.min, `${d.id}.${p.key}`).toBeLessThan(p.max);
        expect(p.def, `${d.id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
        expect(p.def, `${d.id}.${p.key}`).toBeLessThanOrEqual(p.max);
        expect(effectParamStep(p), `${d.id}.${p.key}`).toBeGreaterThan(0);
        // 키프레임 경로(effects#id.params.<key>)에 들어가므로 식별자여야 한다
        expect(p.key, `${d.id}.${p.key}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }
      // 한 효과 안에서 파라미터 키가 겹치면 나중 것이 조용히 이긴다
      const keys = d.params.map((p) => p.key);
      expect(new Set(keys).size, d.id).toBe(keys.length);
    }
  });

  it('defaultEffectParams 는 카탈로그의 def 를 그대로 편다 (W5 계약값 유지)', () => {
    expect(defaultEffectParams('brightness')).toEqual({ amount: 1 });
    expect(defaultEffectParams('hue')).toEqual({ deg: 0 });
    expect(defaultEffectParams('glow')).toEqual({ amount: 0.5, radius: 16 });
    expect(defaultEffectParams('scanlines')).toEqual({ amount: 0.3, lines: 600 });
    expect(defaultEffectParams('lightLeak')).toEqual({ amount: 0.4, hue: 30 });
    // 신규
    expect(defaultEffectParams('gamma')).toEqual({ gamma: 1 });
    expect(defaultEffectParams('whiteBalance')).toEqual({ kelvin: 6500, tint: 0 });
    expect(defaultEffectParams('없는효과')).toEqual({});
  });

  it('«기본값이 곧 항등»인 효과는 걸어도 그림이 안 바뀐다 (실수로 세게 걸리지 않게)', () => {
    // gamma 1, whiteBalance 6500K, temperature/tint/highlights/shadows 0, sharpen 0
    expect(defaultEffectParams('gamma').gamma).toBe(1);
    expect(defaultEffectParams('whiteBalance').kelvin).toBe(6500);
    expect(defaultEffectParams('temperature').amount).toBe(0);
    expect(defaultEffectParams('sharpen').amount).toBe(0);
  });
});
