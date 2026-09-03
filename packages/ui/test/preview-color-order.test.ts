// 프리뷰 v2 의 색 연산 순서 — 렌더러와 같아야 한다.
// 렌더러 최종 CSS: url(#curves-…) → CSS 효과 → url(#fx-…)
// 프리뷰 셰이더:   프리테이블  → ops       → 효과 테이블 → 효과 행렬
import { describe, expect, it } from 'vitest';
import type { Asset, ColorCurves, Effect, VideoClip } from '@kitkat/schema';
import { computeVisualLayout, layoutMediaFilter } from '@kitkat/renderer/layout';
import {
  OP_BRIGHTNESS,
  composeSvgChain,
  layerColorParams,
  planClipStages,
  sampleTable,
} from '../src/preview/gl-params.js';
import { PREVIEW_FRAG_SRC } from '../src/preview/gl.js';

const ASSET: Asset = {
  id: 'a1',
  kind: 'video',
  src: 'assets/a1.mp4',
  name: 'a1',
  duration: 10000,
  width: 1920,
  height: 1080,
};

/** 중간 톤을 0.5 → 0.8 로 들어 올리는 커브 (항등이 아니라 눈에 보인다) */
const LIFT: ColorCurves = {
  rgb: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.8 },
    { x: 1, y: 1 },
  ],
};

const BRIGHT: Effect = { id: 'e1', type: 'brightness', params: { amount: 1.2 } };
const TEMP: Effect = { id: 'e2', type: 'temperature', params: { amount: 1 } };
const HIGH: Effect = { id: 'e3', type: 'highlights', params: { amount: 0.5 } };

function layoutOf(over: Partial<VideoClip>): ReturnType<typeof computeVisualLayout> {
  const clip: VideoClip = {
    id: 'c1',
    kind: 'video',
    assetId: 'a1',
    start: 0,
    duration: 4000,
    in: 0,
    out: 4000,
    speed: 1,
    volume: 1,
    ...over,
  };
  return computeVisualLayout({ clip, asset: ASSET, canvasW: 1920, canvasH: 1080, tMs: 0 });
}

describe('색 파라미터 — 커브는 CSS 효과 앞', () => {
  it('커브 + CSS 효과 + 색행렬: 커브만 프리테이블, 효과 체인엔 effectFilters 만 들어간다', () => {
    const L = layoutOf({ curves: LIFT, effects: [BRIGHT, TEMP] });
    // 렌더러가 커브를 CSS 앞의 별도 <filter> 로 뺐다는 전제 확인
    expect(L.curvesFilters).toHaveLength(1);
    expect(L.effectFilters).toHaveLength(1);
    expect(layoutMediaFilter(L).startsWith('url(#curves-c1)')).toBe(true);

    const p = layerColorParams(L);
    // 커브는 ops **앞**의 프리테이블로
    expect(p.preTable).not.toBeNull();
    expect(sampleTable((p.preTable as { r: number[] }).r, 0.5)).toBeCloseTo(0.8, 2);
    // ops **뒤** 테이블은 없다 (효과 체인에 커브가 없으므로)
    expect(p.tables).toBeNull();
    expect(p.matrix).not.toBeNull();
    expect(p.ops.map((o) => o.op)).toEqual([OP_BRIGHTNESS]);
    expect(p.approx).toEqual([]);

    // 회귀 방지: 예전처럼 svgFilters 를 통째로 접으면 커브가 ops 뒤 테이블로 가버린다
    expect(composeSvgChain(L.svgFilters).tables).not.toBeNull();
  });

  it('커브만 있는 클립: 프리테이블만 채워지고 나머지는 비어 있다', () => {
    const p = layerColorParams(layoutOf({ curves: LIFT }));
    expect(p.preTable).not.toBeNull();
    expect(p.tables).toBeNull();
    expect(p.matrix).toBeNull();
    expect(p.ops).toEqual([]);
    expect(p.blurPx).toBe(0);
    expect(p.approx).toEqual([]);
  });

  it('효과만 있는 클립: 프리테이블이 없고 highlights 는 ops 뒤 테이블로 간다', () => {
    const p = layerColorParams(layoutOf({ effects: [BRIGHT, HIGH, TEMP] }));
    expect(p.preTable).toBeNull();
    expect(p.tables).not.toBeNull();
    expect(p.matrix).not.toBeNull();
    expect(p.ops.map((o) => o.op)).toEqual([OP_BRIGHTNESS]);
  });

  it('커브도 효과도 없는 클립: 전부 비어 있다', () => {
    const p = layerColorParams(layoutOf({}));
    expect(p.preTable).toBeNull();
    expect(p.tables).toBeNull();
    expect(p.matrix).toBeNull();
    expect(p.ops).toEqual([]);
    expect(p.approx).toEqual([]);
  });

  // W8 F15 이후: 블러·글로우는 **다중 패스로 정확히** 그린다. 접는 경로(layerColorParams)는
  // 여전히 블러를 근사로만 셀 수 있고, 그래서 planClipStages 가 「패스로 가라」고 답해야 한다.
  it('블러·글로우가 있으면 접지 않고 패스로 간다', () => {
    const L = layoutOf({
      curves: LIFT,
      effects: [
        { id: 'b', type: 'blur', params: { px: 4 } },
        { id: 'g', type: 'glow', params: { amount: 1, radius: 16 } },
      ],
    });
    const p = layerColorParams(L);
    expect(p.preTable).not.toBeNull();
    expect(p.blurPx).toBe(4);
    // 접는 경로에서는 블러가 밉맵 근사라 그대로 남는다
    expect(p.approx).toContain('블러(근사)');
    // 글로우는 더 이상 「미지원」이 아니다
    expect(p.approx.join(' ')).not.toContain('미지원');

    const plan = planClipStages(L);
    expect(plan.needsPasses).toBe(true);
    expect(plan.approx).toEqual([]);
    expect(plan.stages.map((s) => s.kind)).toEqual(['table', 'blur', 'glow']);
  });
});

describe('orderApprox 의 남은 의미', () => {
  it('커브 배열은 스테이지가 최대 1개라 orderApprox 가 켜질 수 없다', () => {
    const L = layoutOf({ curves: LIFT, effects: [TEMP] });
    expect(composeSvgChain(L.curvesFilters).orderApprox).toBe(false);
    expect(layerColorParams(L).approx).not.toContain('색보정 순서(근사)');
  });

  it('색조정 커브가 있어도 순서 근사 배지가 붙지 않는다 (예전엔 붙었다)', () => {
    const L = layoutOf({ curves: LIFT, effects: [TEMP, HIGH] });
    // 예전 경로(svgFilters 통째)에서는 커브+행렬+커브라 순서 근사가 켜졌다
    expect(composeSvgChain(L.svgFilters).orderApprox).toBe(true);
    // 이제 남는 건 temperature(행렬) vs highlights(테이블) 의 상대 순서뿐이다
    expect(composeSvgChain(L.effectFilters).orderApprox).toBe(true);
    // highlights 가 temperature 앞이면 근사가 아니다
    const ok = layoutOf({ curves: LIFT, effects: [HIGH, TEMP] });
    expect(composeSvgChain(ok.effectFilters).orderApprox).toBe(false);
    expect(layerColorParams(ok).approx).toEqual([]);
  });
});

describe('프래그먼트 셰이더 소스', () => {
  const src = PREVIEW_FRAG_SRC;

  it('GLSL ES 3.00 골격이 맞다', () => {
    expect(src.startsWith('#version 300 es\n')).toBe(true);
    expect(src).toContain('precision highp float;');
    expect(src).toContain('precision highp int;');
    expect(src).toContain('out vec4 fragColor;');
    // WebGL1 함수는 300 es 에서 없다
    expect(src).not.toContain('texture2D(');
    expect(src).not.toContain('gl_FragColor');
    expect(src.split('{').length).toBe(src.split('}').length);
    expect(src.split('(').length).toBe(src.split(')').length);
  });

  it('프리테이블 유니폼이 선언되고 실제로 쓰인다', () => {
    expect(src).toContain('uniform sampler2D uPreTable;');
    expect(src).toContain('uniform int uUsePreTable;');
    expect(src).toContain('float preLut(float v, int ch) {');
    expect(src).toContain('texture(uPreTable, vec2((clamp(v, 0.0, 1.0) * 32.0 + 0.5) / 33.0, 0.5))');
    // 선언된 유니폼은 모두 본문에서 한 번 이상 더 쓰인다
    for (const m of src.matchAll(/uniform\s+\w+\s+(u\w+)[;[]/g)) {
      const name = m[1] as string;
      expect(src.split(name).length - 1, `${name} 가 선언만 되고 안 쓰인다`).toBeGreaterThan(1);
    }
  });

  it('룩업 순서가 커브 → ops → 효과 테이블 → 효과 행렬 이다', () => {
    const at = (needle: string): number => {
      const i = src.indexOf(needle);
      expect(i, `${needle} 없음`).toBeGreaterThan(-1);
      return i;
    };
    const texel = at('vec3 c = clamp(texel.rgb, 0.0, 1.0);');
    const pre = at('if (uUsePreTable == 1) c = vec3(preLut(c.r, 0), preLut(c.g, 1), preLut(c.b, 2));');
    const ops = at('for (int i = 0; i < 12; i++)');
    const table = at('if (uUseTable == 1)');
    const mat = at('if (uUseMat == 1)');
    expect(texel).toBeLessThan(pre);
    expect(pre).toBeLessThan(ops);
    expect(ops).toBeLessThan(table);
    expect(table).toBeLessThan(mat);
  });
});
