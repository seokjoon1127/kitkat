// W8 #8 — WebGL 효과 6종의 **미리보기 쪽** 접점. 브라우저 없이 볼 수 있는 것만:
//   (1) 스테이지 계획 — gl 스테이지가 체인 «맨 앞»에 오고 다중 패스를 켠다
//   (2) 렌더러 GLSL 을 그대로 쓴다 (이 패키지에 효과 수식이 없다)
//   (3) 배지·대조표 접점 (parityKeys · PARITY_MEASURED)
// 픽셀은 preview-parity.mjs(헤드리스 Chrome/SwiftShader)가 잰다.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Asset, Effect, ImageClip } from '@kitkat/schema';
import { effectDef } from '@kitkat/schema';
import { computeVisualLayout } from '@kitkat/renderer/layout';
import { GL_STAGE_KINDS, GL_STAGE_LABEL } from '@kitkat/renderer/composition';
import { planClipStages, stageLabel } from '../src/preview/gl-params.js';
import { passPadding } from '../src/preview/gl.js';
import { PARITY_MEASURED, PARITY_THRESHOLD, parityKeys, parityNote } from '../src/preview/gl-parity.js';

const W = 1920;
const H = 1080;
const ASSET: Asset = { id: 'a1', kind: 'image', src: 'a1.png', name: 'a1', duration: 5000, width: W, height: H };

function layoutOf(effects: Effect[]) {
  const clip = { id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 4000, effects } as ImageClip;
  return computeVisualLayout({ clip, asset: ASSET, canvasW: W, canvasH: H, tMs: 0 });
}
const fx = (type: string, params: Record<string, number>): Effect =>
  ({ id: `e-${type}`, type, params }) as Effect;

const defaults = (id: string): Record<string, number> =>
  Object.fromEntries(effectDef(id)!.params.map((p) => [p.key, p.def]));

describe('planClipStages — WebGL 효과', () => {
  it.each(GL_STAGE_KINDS)('%s 하나 → gl 스테이지 하나, 다중 패스, 배지 없음', (kind) => {
    const plan = planClipStages(layoutOf([fx(kind, defaults(kind))]));
    expect(plan.stages.map((s) => s.kind)).toEqual(['gl']);
    const st = plan.stages[0]!;
    expect(st.kind === 'gl' && st.stage.kind).toBe(kind);
    expect(plan.needsPasses).toBe(true);
    expect(plan.approx).toEqual([]);
  });

  it('WebGL 효과는 체인 «맨 앞»이다 — 커브·CSS·SVG 보다 먼저 (렌더러가 캔버스로 바꾼 뒤 filter 를 건다)', () => {
    const clip = {
      id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 4000,
      curves: { r: [{ x: 0, y: 0 }, { x: 1, y: 0.9 }] },
      effects: [
        fx('blur', { px: 3 }),
        fx('halftone', { size: 8, angle: 45 }),
        fx('temperature', { amount: 0.5 }),
        fx('mirror', { axis: 0, side: 0, pos: 0.5 }),
      ],
    } as unknown as ImageClip;
    const L = computeVisualLayout({ clip, asset: ASSET, canvasW: W, canvasH: H, tMs: 0 });
    const plan = planClipStages(L);
    const kinds = plan.stages.map((s) => (s.kind === 'gl' ? `gl:${s.stage.kind}` : s.kind));
    // gl 두 개가 효과 배열 순서대로 맨 앞, 그 뒤 커브(table) → blur → 색행렬(matrix)
    expect(kinds).toEqual(['gl:halftone', 'gl:mirror', 'table', 'blur', 'matrix']);
    expect(plan.needsPasses).toBe(true);
  });

  it('gl 스테이지의 수치는 렌더러가 정규화한 값 그대로다 (여기서 다시 계산하지 않는다)', () => {
    const L = layoutOf([fx('bokeh', { radius: 999, amount: 0.5 })]);
    const st = planClipStages(L).stages[0]!;
    expect(st.kind === 'gl' && st.stage).toEqual({ kind: 'bokeh', data: { radius: 60, amount: 0.5, step: 5 } });
  });

  it('glStages 가 없는 옛 레이아웃 모양도 그대로 돈다 (단일 패스)', () => {
    const plan = planClipStages({ cssFilter: 'brightness(1.2)', curvesFilters: [], effectFilters: [] });
    expect(plan.needsPasses).toBe(false);
    expect(plan.stages.map((s) => s.kind)).toEqual(['ops']);
  });

  it('효과가 없는 클립은 gl 스테이지도 없고 단일 패스다 (fps 회귀 0 의 전제)', () => {
    const plan = planClipStages(layoutOf([]));
    expect(plan.stages).toEqual([]);
    expect(plan.needsPasses).toBe(false);
    expect(passPadding(plan.stages)).toBe(0);
  });

  it('gl 스테이지는 표면 여유(pad)를 늘리지 않는다 — 미디어 밖은 셰이더가 투명으로 쓴다', () => {
    const plan = planClipStages(layoutOf([fx('bokeh', { radius: 60, amount: 1 }), fx('radialBlur', { px: 60 })]));
    expect(passPadding(plan.stages)).toBe(0);
    // 다른 공간 효과가 섞이면 그쪽 여유만 잡힌다
    const mixed = planClipStages(layoutOf([fx('bokeh', { radius: 60, amount: 1 }), fx('chromaShift', { px: 6 })]));
    expect(passPadding(mixed.stages)).toBe(6);
  });
});

describe('셰이더 수식은 렌더러 한 곳에만 있다', () => {
  const here = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/preview/${rel}`, import.meta.url)), 'utf8');

  it('gl-passes.ts 는 렌더러의 linkGlEffect·glStageUniforms 를 쓰고, 효과 GLSL 을 직접 갖지 않는다', () => {
    const src = here('gl-passes.ts');
    expect(src).toContain('linkGlEffect');
    expect(src).toContain('glStageUniforms');
    expect(src).toContain('setGlUniforms');
    for (const word of ['mirrorRepeat', 'uSegments', 'uHalftone', 'uRadius', 'atan(']) {
      expect(src, `gl-passes.ts 에 효과 수식(${word})이 있다`).not.toContain(word);
    }
  });

  it('gl.ts 도 효과 수식이 없다 — 스테이지를 PassChain.glStage 로 넘길 뿐', () => {
    const src = here('gl.ts');
    expect(src).toContain('chain.glStage(s.stage)');
    expect(src).not.toContain('uSegments');
  });

  it('배지 이름은 카탈로그 한글 이름이다', () => {
    for (const k of GL_STAGE_KINDS) {
      expect(stageLabel(k)).toBe(effectDef(k)!.name);
      expect(GL_STAGE_LABEL[k]).toBe(effectDef(k)!.name);
      expect(stageLabel(k)).toMatch(/[가-힣]/);
    }
  });
});

describe('대조표 접점 (gl-parity)', () => {
  it('PARITY_MEASURED 에 WebGL 6종이 전부 있고 임계(평균 3 / 최대 12) 안이다', () => {
    for (const k of GL_STAGE_KINDS) {
      const d = PARITY_MEASURED[k];
      expect(d, k).toBeTruthy();
      expect(d!.mean, k).toBeLessThanOrEqual(PARITY_THRESHOLD.mean);
      expect(d!.max, k).toBeLessThanOrEqual(PARITY_THRESHOLD.max);
      expect(d!.label, k).toBe(effectDef(k)!.name);
    }
  });

  it('parityKeys 가 gl 스테이지를 표 키로 올린다 (중복 없이, 배열 순서대로)', () => {
    const L = layoutOf([fx('mirror', defaults('mirror')), fx('glow', { amount: 1, radius: 8 }),
      fx('halftone', defaults('halftone')), fx('mirror', { axis: 1, side: 0, pos: 0.5 })]);
    expect(parityKeys(L)).toEqual(['glow', 'mirror', 'halftone']);
  });

  it('차이가 1 이하인 효과는 배지를 안 띄운다 (mirror·bokeh 처럼 비트 일치)', () => {
    const quiet = GL_STAGE_KINDS.filter((k) => (PARITY_MEASURED[k]?.max ?? 99) <= 1);
    expect(quiet.length).toBeGreaterThan(0);
    expect(parityNote(quiet)).toBeNull();
  });
});
