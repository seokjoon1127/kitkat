// W8 #8 — 「대기」였던 WebGL 효과 6종 (vibrance·bokeh·radialBlur·mirror·kaleidoscope·halftone).
//
// 브라우저 없이 확인할 수 있는 것만 본다:
//   (1) 효과 배열 → 스테이지 (카탈로그 파라미터가 한 번만 정규화되는가, 항등이면 안 만드는가)
//   (2) 스테이지 → 유니폼 (수식이 한 곳에 있고 셰이더 유니폼 목록과 이름이 맞는가)
//   (3) GLSL 문자열의 골격 (여섯 셰이더가 같은 머리를 쓰고, 표본 상한이 셰이더 루프와 같은가)
//   (4) 레이아웃 접점 (glStages 가 체인 «앞»이고 나머지 경로에는 안 새는가)
//   (5) Remotion createEffect 디스크립터 (6종 팩토리·키·검증)
// 픽셀이 실제로 같은지는 헤드리스 Chrome 이 필요해서 `packages/ui/test/preview-parity.mjs` 가 따로 잰다.
import { describe, expect, it } from 'vitest';
import { EFFECT_CATALOG, PENDING_EFFECT_TYPES, effectDef } from '@kitkat/schema';
import type { Asset, Effect, EffectType, ImageClip } from '@kitkat/schema';
import {
  BOKEH_MAX_K,
  GL_COMMON_UNIFORMS,
  GL_EFFECT_FRAG,
  GL_EFFECT_UNIFORM_NAMES,
  GL_EFFECT_VERT,
  GL_FULL_MEDIA,
  GL_STAGE_KINDS,
  GL_STAGE_LABEL,
  RADIAL_MAX_SAMPLES,
  bokehStep,
  effectGlStages,
  glStageUniforms,
  radialSamples,
  type GlStageData,
} from '../src/composition/gl-effects.js';
import { GL_EFFECT_FACTORY, glStageDescriptors } from '../src/composition/webgl-effects.js';
import { computeVisualLayout, layoutMediaFilter } from '../src/layout/index.js';
import { effectOverlays, effectSvgStages, effectsToFilter } from '../src/composition/effects.js';

const fx = (type: string, params: Record<string, number>): Effect =>
  ({ id: `e-${type}`, type, params }) as Effect;

const ASSET: Asset = { id: 'a', kind: 'image', src: 'a.png', name: 'a', duration: 1000, width: 1920, height: 1080 };
function layoutOf(effects: Effect[]) {
  const clip = { id: 'c1', kind: 'image', assetId: 'a', start: 0, duration: 1000, effects } as ImageClip;
  return computeVisualLayout({ clip, asset: ASSET, canvasW: 1920, canvasH: 1080, tMs: 0 });
}

// ── (1) 효과 → 스테이지 ─────────────────────────────────────────────────

describe('effectGlStages — 카탈로그 webgl 6종이 전부 스테이지를 만든다', () => {
  it('카탈로그의 impl:webgl 이 정확히 6종이고 «대기»는 0 이다', () => {
    const webgl = EFFECT_CATALOG.filter((d) => d.impl === 'webgl').map((d) => d.id).sort();
    expect(webgl).toEqual([...GL_STAGE_KINDS].sort());
    expect(PENDING_EFFECT_TYPES).toEqual([]);
    for (const id of webgl) expect(effectDef(id)?.pending).toBeUndefined();
  });

  it.each(GL_STAGE_KINDS)('%s: 기본값으로 스테이지 하나 (kind 가 효과 id 와 같다)', (kind) => {
    const def = effectDef(kind)!;
    const params = Object.fromEntries(def.params.map((p) => [p.key, p.def]));
    const st = effectGlStages([fx(kind, params)]);
    expect(st).toHaveLength(1);
    expect(st[0]!.kind).toBe(kind);
  });

  it('6종을 한꺼번에 걸면 배열 순서 그대로 6개', () => {
    const effects = GL_STAGE_KINDS.map((k) =>
      fx(k, Object.fromEntries(effectDef(k)!.params.map((p) => [p.key, p.def]))),
    );
    expect(effectGlStages(effects).map((s) => s.kind)).toEqual([...GL_STAGE_KINDS]);
  });

  it('webgl 이 아닌 효과는 무시한다 (blur·glow·grain 이 섞여도 gl 스테이지는 안 생긴다)', () => {
    expect(effectGlStages([fx('blur', { px: 4 }), fx('glow', { amount: 1, radius: 8 }), fx('grain', { amount: 1 })]))
      .toEqual([]);
    expect(effectGlStages(undefined)).toEqual([]);
    expect(effectGlStages([])).toEqual([]);
  });

  it('항등 값은 스테이지를 안 만든다 — vibrance 0 · bokeh 반경 0/강도 0 · radialBlur 0px', () => {
    expect(effectGlStages([fx('vibrance', { amount: 0 })])).toEqual([]);
    expect(effectGlStages([fx('bokeh', { radius: 0, amount: 1 })])).toEqual([]);
    expect(effectGlStages([fx('bokeh', { radius: 20, amount: 0 })])).toEqual([]);
    expect(effectGlStages([fx('radialBlur', { px: 0 })])).toEqual([]);
  });

  it('mirror·kaleidoscope·halftone 은 항등이 없다 — 어떤 값이든 그린다', () => {
    expect(effectGlStages([fx('mirror', { axis: 0, side: 0, pos: 0.5 })])).toHaveLength(1);
    expect(effectGlStages([fx('kaleidoscope', { segments: 3, angle: 0 })])).toHaveLength(1);
    expect(effectGlStages([fx('halftone', { size: 2, angle: 0 })])).toHaveLength(1);
  });

  it('파라미터를 카탈로그 범위로 자른다 (문서를 손으로 고쳐도 셰이더에 엉뚱한 값이 안 간다)', () => {
    const v = effectGlStages([fx('vibrance', { amount: 5 })])[0]!;
    expect(v.kind === 'vibrance' && v.data.amount).toBe(1);
    const b = effectGlStages([fx('bokeh', { radius: 999, amount: 3 })])[0]!;
    expect(b.kind === 'bokeh' && b.data.radius).toBe(60);
    expect(b.kind === 'bokeh' && b.data.amount).toBe(1);
    const r = effectGlStages([fx('radialBlur', { px: 100, cx: 2, cy: -1 })])[0]!;
    expect(r.kind === 'radialBlur' && [r.data.px, r.data.cx, r.data.cy]).toEqual([60, 1, 0]);
    const m = effectGlStages([fx('mirror', { axis: 7, side: 3, pos: 1 })])[0]!;
    expect(m.kind === 'mirror' && [m.data.axis, m.data.side, m.data.pos]).toEqual([2, 1, 0.99]);
    const k = effectGlStages([fx('kaleidoscope', { segments: 100, angle: -30 })])[0]!;
    expect(k.kind === 'kaleidoscope' && [k.data.segments, k.data.angleDeg]).toEqual([16, 330]);
    const h = effectGlStages([fx('halftone', { size: 0.5, angle: 200 })])[0]!;
    expect(h.kind === 'halftone' && [h.data.size, h.data.angleDeg]).toEqual([2, 90]);
  });

  it('파라미터가 통째로 없어도 카탈로그 기본값으로 간다', () => {
    for (const kind of GL_STAGE_KINDS) {
      const st = effectGlStages([{ id: 'x', type: kind, params: {} } as Effect]);
      expect(st, kind).toHaveLength(1);
      expect(JSON.stringify(st), kind).not.toContain('NaN');
    }
    const b = effectGlStages([{ id: 'x', type: 'bokeh', params: {} } as Effect])[0]!;
    expect(b.kind === 'bokeh' && b.data.radius).toBe(effectDef('bokeh')!.params[0]!.def);
  });

  it('보케 표본 간격 — 반경이 K(=12) 이하면 1(정확한 원반), 넘으면 성기게', () => {
    expect(bokehStep(1)).toBe(1);
    expect(bokehStep(BOKEH_MAX_K)).toBe(1);
    expect(bokehStep(BOKEH_MAX_K + 1)).toBe(2);
    expect(bokehStep(24)).toBe(2);
    expect(bokehStep(60)).toBe(5);
    // 어떤 반경이든 표본 반칸 수가 K 를 안 넘는다 (셰이더 루프 상한)
    for (let r = 0; r <= 60; r++) expect(Math.ceil(r / bokehStep(r)), `r=${r}`).toBeLessThanOrEqual(BOKEH_MAX_K);
  });

  it('방사형 표본 수 — 1px 당 하나, 8..32 (셰이더 루프 상한과 같다)', () => {
    expect(radialSamples(1)).toBe(8);
    expect(radialSamples(20)).toBe(20);
    expect(radialSamples(60)).toBe(RADIAL_MAX_SAMPLES);
  });
});

// ── (2) 스테이지 → 유니폼 ───────────────────────────────────────────────

describe('glStageUniforms — 유니폼 이름이 셰이더 목록과 맞는다', () => {
  const media = GL_FULL_MEDIA(640, 360);
  const sample: Record<string, GlStageData> = {
    vibrance: { kind: 'vibrance', data: { amount: 0.4 } },
    bokeh: { kind: 'bokeh', data: { radius: 24, amount: 0.6, step: 2 } },
    radialBlur: { kind: 'radialBlur', data: { px: 20, cx: 0.3, cy: 0.7, samples: 20 } },
    mirror: { kind: 'mirror', data: { axis: 2, side: 1, pos: 0.4 } },
    kaleidoscope: { kind: 'kaleidoscope', data: { segments: 6, angleDeg: 90 } },
    halftone: { kind: 'halftone', data: { size: 8, angleDeg: 45 } },
  };

  it.each(GL_STAGE_KINDS)('%s: 유니폼 이름이 전부 GL_EFFECT_UNIFORM_NAMES 안에 있고, 공통 2개를 포함한다', (kind) => {
    const us = glStageUniforms(sample[kind]!, media);
    const names = new Set(GL_EFFECT_UNIFORM_NAMES[kind]);
    for (const u of us) expect(names.has(u.name), `${kind}.${u.name}`).toBe(true);
    // 공통: uMedia·uMediaPx (uSrc·uFlipY 는 실행기가 정한다)
    expect(us.map((u) => u.name)).toContain('uMedia');
    expect(us.map((u) => u.name)).toContain('uMediaPx');
    // 셰이더가 선언한 효과별 유니폼은 전부 값을 받는다
    const provided = new Set(us.map((u) => u.name));
    for (const n of GL_EFFECT_UNIFORM_NAMES[kind]) {
      if (n === 'uSrc' || n === 'uFlipY') continue;
      expect(provided.has(n), `${kind} 가 ${n} 값을 안 준다`).toBe(true);
    }
  });

  it('각도는 도 → 라디안으로 바꿔 준다 (셰이더는 라디안만 받는다)', () => {
    const k = glStageUniforms(sample.kaleidoscope!, media).find((u) => u.name === 'uAngle')!;
    expect(k.value[0]).toBeCloseTo(Math.PI / 2, 6);
    const h = glStageUniforms(sample.halftone!, media).find((u) => u.name === 'uAngle')!;
    expect(h.value[0]).toBeCloseTo(Math.PI / 4, 6);
  });

  it('미디어 자리 — 전체 캔버스는 (0,0,1,1), 여유 있는 표면은 그 안의 자리', () => {
    const full = glStageUniforms(sample.mirror!, media).find((u) => u.name === 'uMedia')!;
    expect(full.value).toEqual([0, 0, 1, 1]);
    const px = glStageUniforms(sample.mirror!, media).find((u) => u.name === 'uMediaPx')!;
    expect(px.value).toEqual([640, 360]);
    const padded = glStageUniforms(sample.mirror!, { x: 0.1, y: 0.05, w: 0.8, h: 0.9, pxW: 480, pxH: 270 })
      .find((u) => u.name === 'uMedia')!;
    expect(padded.value).toEqual([0.1, 0.05, 0.8, 0.9]);
  });

  it('정수 유니폼(uSamples·uAxis·uSide)은 1i 로, 표본 수는 상한을 안 넘는다', () => {
    const r = glStageUniforms({ kind: 'radialBlur', data: { px: 60, cx: 0.5, cy: 0.5, samples: 999 } }, media);
    const smp = r.find((u) => u.name === 'uSamples')!;
    expect(smp.type).toBe('1i');
    expect(smp.value[0]).toBe(RADIAL_MAX_SAMPLES);
    const m = glStageUniforms(sample.mirror!, media);
    expect(m.find((u) => u.name === 'uAxis')!.type).toBe('1i');
    expect(m.find((u) => u.name === 'uSide')!.type).toBe('1i');
  });

  it('0 크기 미디어에도 0 으로 나누지 않는다 (uMediaPx ≥ 1)', () => {
    const u = glStageUniforms(sample.vibrance!, GL_FULL_MEDIA(0, 0)).find((x) => x.name === 'uMediaPx')!;
    expect(u.value).toEqual([1, 1]);
  });
});

// ── (3) GLSL 골격 ────────────────────────────────────────────────────────

describe('GLSL — 여섯 셰이더가 같은 규약을 쓴다', () => {
  it.each(GL_STAGE_KINDS)('%s: GLSL ES 3.0, 공통 유니폼 선언, 미디어 밖은 투명', (kind) => {
    const src = GL_EFFECT_FRAG[kind];
    expect(src.startsWith('#version 300 es')).toBe(true);
    for (const n of ['uSrc', 'uMedia', 'uMediaPx']) expect(src, `${kind} ${n}`).toContain(`uniform`);
    expect(src).toContain('uniform sampler2D uSrc;');
    expect(src).toContain('uniform vec4 uMedia;');
    expect(src).toContain('uniform vec2 uMediaPx;');
    expect(src).toContain('if (outsideM(m)) { fragColor = vec4(0.0); return; }');
    // 픽셀 중심 스냅 — 두 경로(렌더 캔버스 / 미리보기 표면)가 같은 좌표를 계산하게 한다
    expect(src).toContain('vec2 m = mediaCoord();');
    // 효과별 유니폼이 실제로 선언돼 있다
    for (const n of GL_EFFECT_UNIFORM_NAMES[kind]) {
      if ((GL_COMMON_UNIFORMS as readonly string[]).includes(n)) continue;
      expect(src, `${kind} 에 ${n} 선언이 없다`).toMatch(new RegExp(`uniform \\w+ ${n};`));
    }
  });

  it('정점 셰이더의 uFlipY 로만 위아래를 맞춘다 (프래그먼트에는 없다)', () => {
    expect(GL_EFFECT_VERT).toContain('uniform float uFlipY;');
    for (const kind of GL_STAGE_KINDS) expect(GL_EFFECT_FRAG[kind]).not.toContain('uFlipY');
  });

  it('보케 루프 상한과 방사형 루프 상한이 TS 상수와 같다', () => {
    expect(GL_EFFECT_FRAG.bokeh).toContain(`const int MAXK = ${BOKEH_MAX_K};`);
    expect(GL_EFFECT_FRAG.radialBlur).toContain(`const int MAXN = ${RADIAL_MAX_SAMPLES};`);
  });

  it('보케는 «원반» 판정(i²+j² ≤ r²)이고 가우시안 가중치가 없다', () => {
    expect(GL_EFFECT_FRAG.bokeh).toContain('float(i * i + j * j) > rr');
    expect(GL_EFFECT_FRAG.bokeh).not.toMatch(/exp\(/);
  });

  it('방사형 블러는 중심 거리에 비례해 늘어난다 (중심은 안 흐려진다)', () => {
    expect(GL_EFFECT_FRAG.radialBlur).toContain('uPx * dist / (length(uMediaPx) * 0.5)');
    expect(GL_EFFECT_FRAG.radialBlur).toContain('if (len < 0.5) { fragColor = texture(uSrc, vUv); return; }');
  });

  it('생동감은 채도 낮은 색만 올린다: gain = amount·(1−sat)', () => {
    expect(GL_EFFECT_FRAG.vibrance).toContain('float gain = uAmount * (1.0 - sat);');
  });

  it('망점은 밝기 비례 반지름 + smoothstep 안티에일리어싱', () => {
    expect(GL_EFFECT_FRAG.halftone).toContain('sqrt(clamp(1.0 - l, 0.0, 1.0))');
    expect(GL_EFFECT_FRAG.halftone).toContain('smoothstep(rd - 0.75, rd + 0.75, dd)');
  });

  it('거울·만화경은 접힌 좌표가 0..1 을 벗어나도 거울 반복으로 채운다 (구멍 없음)', () => {
    expect(GL_EFFECT_FRAG.mirror).toContain('tapM(mirrorRepeat(q))');
    expect(GL_EFFECT_FRAG.kaleidoscope).toContain('tapM(mirrorRepeat(q))');
  });

  it('여섯 소스가 전부 다르다 (복제본 없음)', () => {
    expect(new Set(GL_STAGE_KINDS.map((k) => GL_EFFECT_FRAG[k])).size).toBe(6);
  });

  it('배지 이름이 카탈로그 이름과 같다', () => {
    for (const k of GL_STAGE_KINDS) expect(GL_STAGE_LABEL[k]).toBe(effectDef(k)!.name);
  });
});

// ── (4) 레이아웃 접점 ───────────────────────────────────────────────────

describe('computeVisualLayout — glStages', () => {
  it('webgl 6종은 glStages 로만 나가고 CSS·SVG·오버레이에는 안 샌다', () => {
    for (const kind of GL_STAGE_KINDS) {
      const def = effectDef(kind)!;
      const params = Object.fromEntries(def.params.map((p) => [p.key, p.def === p.max ? p.min : p.max]));
      const e = fx(kind, params);
      const L = layoutOf([e]);
      expect(L.glStages.map((s) => s.kind), kind).toEqual([kind]);
      expect(L.svgFilters, kind).toEqual([]);
      expect(L.overlays, kind).toEqual([]);
      expect(L.cssFilter, kind).toBe('');
      expect(layoutMediaFilter(L), kind).toBe('');
      expect(effectsToFilter([e]), kind).toBe('');
      expect(effectSvgStages([e]), kind).toEqual([]);
      expect(effectOverlays([e]), kind).toEqual([]);
    }
  });

  it('gl 스테이지 id 는 클립 id 를 따른다 (필터 id 와 충돌하지 않는다)', () => {
    const L = layoutOf([fx('mirror', { axis: 0, side: 0, pos: 0.5 }), fx('halftone', { size: 8, angle: 45 })]);
    expect(L.glStages.map((s) => s.id)).toEqual(['fx-c1g0', 'fx-c1g1']);
  });

  it('WebGL 효과와 CSS·SVG 효과가 섞여도 서로의 경로를 안 건드린다', () => {
    const L = layoutOf([
      fx('blur', { px: 4 }),
      fx('kaleidoscope', { segments: 6, angle: 0 }),
      fx('temperature', { amount: 0.5 }),
    ]);
    expect(L.glStages.map((s) => s.kind)).toEqual(['kaleidoscope']);
    expect(L.cssFilter).toBe('blur(4px)');
    expect(L.effectFilters.map((s) => s.kind)).toEqual(['colorMatrix']);
    expect(layoutMediaFilter(L)).toBe('blur(4px) url(#fx-c1)');
  });

  it('효과가 없으면 glStages 는 빈 배열 (예전 경로 그대로)', () => {
    expect(layoutOf([]).glStages).toEqual([]);
    expect(layoutOf([fx('sepia', { amount: 1 })]).glStages).toEqual([]);
  });

  it('키프레임이 걸린 파라미터도 glStages 로 들어간다 (applyKeyframes 한 곳을 거친다)', () => {
    const clip = {
      id: 'c1', kind: 'image', assetId: 'a', start: 0, duration: 1000,
      effects: [{ id: 'v', type: 'vibrance', params: { amount: 0 } }],
      keyframes: [
        { time: 0, prop: 'effects#v.params.amount', value: 0, easing: 'linear' },
        { time: 1000, prop: 'effects#v.params.amount', value: 1, easing: 'linear' },
      ],
    } as unknown as ImageClip;
    const at = (tMs: number) =>
      computeVisualLayout({ clip, asset: ASSET, canvasW: 1920, canvasH: 1080, tMs }).glStages;
    expect(at(0)).toEqual([]); // amount 0 = 항등 → 스테이지 없음
    const mid = at(500)[0]!;
    expect(mid.kind === 'vibrance' && mid.data.amount).toBeCloseTo(0.5, 6);
  });
});

// ── (5) Remotion createEffect ───────────────────────────────────────────

describe('Remotion createEffect 디스크립터', () => {
  it('6종 팩토리가 전부 있고 backend 가 webgl2 다', () => {
    for (const k of GL_STAGE_KINDS) {
      const d = GL_EFFECT_FACTORY[k]({ amount: 0.5, radius: 10, step: 1, px: 10, cx: 0.5, cy: 0.5, samples: 10,
        axis: 0, side: 0, pos: 0.5, segments: 6, angleDeg: 0, size: 8 });
      expect(d.definition.backend, k).toBe('webgl2');
      expect(d.definition.type, k).toBe(`kitkat.${k}`);
      expect(d.definition.label, k).toBe(effectDef(k)!.name);
      expect(d.memoized).toBe(false);
    }
  });

  it('glStageDescriptors — 레이아웃 스테이지 순서대로, 파라미터가 그대로 실린다', () => {
    const L = layoutOf([fx('halftone', { size: 12, angle: 30 }), fx('mirror', { axis: 1, side: 1, pos: 0.3 })]);
    const ds = glStageDescriptors(L.glStages);
    expect(ds.map((d) => d.definition.type)).toEqual(['kitkat.halftone', 'kitkat.mirror']);
    expect(ds[0]!.params).toEqual({ size: 12, angleDeg: 30 });
    expect(ds[1]!.params).toEqual({ axis: 1, side: 1, pos: 0.3 });
  });

  it('effectKey 는 파라미터 값으로 정해진다 (같은 값 = 같은 키, 다른 값 = 다른 키)', () => {
    const a = GL_EFFECT_FACTORY.vibrance({ amount: 0.3 }).effectKey;
    const b = GL_EFFECT_FACTORY.vibrance({ amount: 0.3 }).effectKey;
    const c = GL_EFFECT_FACTORY.vibrance({ amount: 0.4 }).effectKey;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('숫자가 아닌 파라미터는 만들 때 던진다 (렌더 중에 조용히 NaN 이 되지 않는다)', () => {
    expect(() => GL_EFFECT_FACTORY.halftone({ size: Number.NaN, angleDeg: 0 })).toThrow(/숫자/);
    expect(() => GL_EFFECT_FACTORY.mirror({ axis: 'x' as unknown as number, side: 0, pos: 0.5 })).toThrow();
  });
});
