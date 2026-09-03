// W8 F16 — 인스펙터가 카탈로그를 제대로 따라가는지.
// 「대기」 항목은 고를 수 없어야 한다 — 고를 수 있는데 안 그려지면 최악이다.
// W8 #8 부터 대기가 0 이라, 반대로 **50종 전부 고를 수 있는지**를 본다.
import { describe, expect, it } from 'vitest';
import { EFFECT_CATALOG, EFFECT_TYPES, PENDING_EFFECT_TYPES, TRANSITION_TYPES } from '@kitkat/schema';
import type { EffectType } from '@kitkat/schema';
import {
  EFFECT_LABELS,
  EFFECT_PARAM_DEFS,
  TRANSITION_LABELS,
  defaultEffectParams,
  effectOptionGroups,
  effectPendingReason,
  makeEffect,
  transitionOptionGroups,
} from '../src/components/sections/inspector-utils.js';

describe('효과 드롭다운', () => {
  it('갈래별로 묶여 있고, 50종이 하나도 빠짐없이 나온다', () => {
    const groups = effectOptionGroups();
    expect(groups.length).toBe(6);
    const values = groups.flatMap((g) => g.options.map((o) => o.value));
    expect(values.sort()).toEqual([...EFFECT_TYPES].sort());
    expect(values).toHaveLength(50);
  });

  it('갈래 이름이 한국어다 (영문 group 키가 새어 나오지 않는다)', () => {
    for (const g of effectOptionGroups()) {
      expect(g.group).not.toMatch(/^[a-z]+$/);
      expect(g.options.length).toBeGreaterThan(0);
    }
  });

  it('대기 항목이 있으면 disabled + (대기) 표시, 지금은 하나도 없다 (W8 #8)', () => {
    expect(PENDING_EFFECT_TYPES).toEqual([]);
    const options = effectOptionGroups().flatMap((g) => g.options);
    for (const o of options) {
      expect(o.disabled, o.value).toBeUndefined();
      expect(o.label, o.value).not.toContain('(대기)');
    }
  });

  it('50종 전부 고를 수 있다 — WebGL 6종(vibrance·bokeh·radialBlur·mirror·kaleidoscope·halftone) 포함', () => {
    const enabled = effectOptionGroups()
      .flatMap((g) => g.options)
      .filter((o) => !o.disabled)
      .map((o) => o.value);
    expect(enabled).toHaveLength(50);
    for (const id of ['vibrance', 'bokeh', 'radialBlur', 'mirror', 'kaleidoscope', 'halftone']) {
      expect(enabled, id).toContain(id);
    }
  });

  it('effectPendingReason 은 대기 항목에만 «왜»를 돌려준다 — 지금은 전부 null', () => {
    for (const id of EFFECT_TYPES) expect(effectPendingReason(id), id).toBeNull();
  });

  it('WebGL 6종의 슬라이더 메타가 카탈로그 파라미터를 전부 담는다 (보강한 cx·cy·pos 포함)', () => {
    expect(EFFECT_PARAM_DEFS.radialBlur.map((d) => d.key)).toEqual(['px', 'cx', 'cy']);
    expect(EFFECT_PARAM_DEFS.mirror.map((d) => d.key)).toEqual(['axis', 'side', 'pos']);
    expect(makeEffect('mirror').params).toEqual({ axis: 0, side: 0, pos: 0.5 });
    expect(makeEffect('radialBlur').params).toEqual({ px: 20, cx: 0.5, cy: 0.5 });
  });
});

describe('전환 드롭다운', () => {
  it('갈래별로 묶여 있고 51종 전부 나온다', () => {
    const groups = transitionOptionGroups();
    expect(groups.length).toBe(7);
    const values = groups.flatMap((g) => g.options.map((o) => o.value));
    expect(values.sort()).toEqual([...TRANSITION_TYPES].sort());
  });

  it('전환에는 고를 수 없는 항목이 없다', () => {
    for (const o of transitionOptionGroups().flatMap((g) => g.options)) {
      expect(o.disabled, o.value).toBeFalsy();
    }
  });
});

describe('라벨·파라미터 메타가 카탈로그에서 파생된다', () => {
  it('효과 50종·전환 51종 전부 한국어 라벨이 있다 (id 가 그대로 새어 나오지 않는다)', () => {
    for (const id of EFFECT_TYPES) {
      expect(EFFECT_LABELS[id], id).toBeTruthy();
      expect(EFFECT_LABELS[id], id).not.toBe(id);
    }
    for (const id of TRANSITION_TYPES) {
      expect(TRANSITION_LABELS[id], id).toBeTruthy();
      expect(TRANSITION_LABELS[id], id).not.toBe(id);
    }
  });

  it('카탈로그의 name·params 를 그대로 옮긴다 (손으로 적은 표가 없다)', () => {
    for (const d of EFFECT_CATALOG) {
      const id = d.id as EffectType;
      expect(EFFECT_LABELS[id]).toBe(d.name);
      expect(EFFECT_PARAM_DEFS[id].map((p) => p.key)).toEqual(d.params.map((p) => p.key));
      for (const [i, p] of EFFECT_PARAM_DEFS[id].entries()) {
        expect(p.min).toBe(d.params[i]!.min);
        expect(p.max).toBe(d.params[i]!.max);
        expect(p.def).toBe(d.params[i]!.def);
        expect(p.step).toBeGreaterThan(0);
      }
    }
  });

  it('슬라이더 눈금이 범위에 비해 터무니없지 않다 (「줄 수 100..2000」이 0.01 눈금이면 못 쓴다)', () => {
    for (const id of EFFECT_TYPES) {
      for (const p of EFFECT_PARAM_DEFS[id]) {
        const steps = (p.max - p.min) / p.step;
        expect(steps, `${id}.${p.key}`).toBeGreaterThanOrEqual(1);
        expect(steps, `${id}.${p.key}`).toBeLessThanOrEqual(400);
      }
    }
  });

  it('makeEffect 는 50종 전부에 대해 카탈로그 기본값으로 만든다', () => {
    for (const id of EFFECT_TYPES) {
      const e = makeEffect(id);
      expect(e.type).toBe(id);
      expect(e.params).toEqual(defaultEffectParams(id));
      expect(Object.keys(e.params).length, id).toBeGreaterThan(0);
    }
  });
});
