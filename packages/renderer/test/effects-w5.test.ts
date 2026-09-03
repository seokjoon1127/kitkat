import { describe, expect, it } from 'vitest';
import { curvesToTables, type Effect } from '@kitkat/schema';
import {
  effectOverlays,
  effectSvgStages,
  effectsToFilter,
  grainSeed,
  lightLeakCss,
  needsWideFilterRegion,
  scanlinesCss,
} from '../src/composition/effects.js';
import {
  chromaKeyParams,
  chromaKeyScore,
  highlightsTable,
  sharpenKernel,
  shadowsTable,
  tableValuesString,
  temperatureMatrix,
  tintMatrix,
} from '../src/composition/svg-data.js';
import { buildFilterNodes } from '../src/composition/svg-filters.js';

const eff = (type: Effect['type'], params: Effect['params']): Effect => ({ id: `e-${type}`, type, params });

describe('CSS filter — W5', () => {
  it('exposure 는 brightness(2^stops) 로 정확히 표현된다', () => {
    expect(effectsToFilter([eff('exposure', { stops: 0 })])).toBe('brightness(1)');
    expect(effectsToFilter([eff('exposure', { stops: 1 })])).toBe('brightness(2)');
    expect(effectsToFilter([eff('exposure', { stops: -1 })])).toBe('brightness(0.5)');
    expect(effectsToFilter([eff('exposure', { stops: 0.5 })])).toBe('brightness(1.4142)');
    // -2..2 클램프
    expect(effectsToFilter([eff('exposure', { stops: 9 })])).toBe('brightness(4)');
  });

  it('SVG/오버레이로 가는 효과는 CSS filter 문자열에 안 들어간다', () => {
    const svgOnly: Effect[] = [
      eff('temperature', { amount: 0.5 }),
      eff('tint', { amount: -0.4 }),
      eff('highlights', { amount: 0.6 }),
      eff('shadows', { amount: -0.3 }),
      eff('sharpen', { amount: 1 }),
      eff('glow', { amount: 0.6, radius: 20 }),
      eff('chromaShift', { px: 6 }),
      eff('grain', { amount: 0.4 }),
      eff('scanlines', { amount: 0.3, lines: 600 }),
      eff('lightLeak', { amount: 0.4, hue: 30 }),
    ];
    expect(effectsToFilter(svgOnly)).toBe('');
    // v1 효과와 섞여도 v1 부분만 남는다
    expect(effectsToFilter([...svgOnly, eff('blur', { px: 3 })])).toBe('blur(3px)');
  });
});

describe('SVG 필터 스테이지', () => {
  it('temperature/tint 는 채널 게인 행렬', () => {
    const s = effectSvgStages([eff('temperature', { amount: 1 })]);
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe('colorMatrix');
    expect((s[0]!.data as { values: string }).values).toBe(temperatureMatrix(1));
    expect(temperatureMatrix(1)).toBe('1.3 0 0 0 0 0 1 0 0 0 0 0 0.7 0 0 0 0 0 1 0');
    expect(temperatureMatrix(-1)).toBe('0.7 0 0 0 0 0 1 0 0 0 0 0 1.3 0 0 0 0 0 1 0');
    expect(tintMatrix(1)).toBe('1.15 0 0 0 0 0 0.75 0 0 0 0 0 1.15 0 0 0 0 0 1 0');
    // amount 0 이면 스테이지가 아예 안 생긴다 (기본값이 렌더 경로를 안 건드린다)
    expect(effectSvgStages([eff('temperature', { amount: 0 }), eff('tint', {})])).toEqual([]);
  });

  it('highlights/shadows 는 33개 단조 톤 테이블', () => {
    for (let a = -1; a <= 1.0001; a += 0.1) {
      for (const [name, table] of [
        [`highlights(${a.toFixed(1)})`, highlightsTable(a)],
        [`shadows(${a.toFixed(1)})`, shadowsTable(a)],
      ] as [string, number[]][]) {
        expect(table).toHaveLength(33);
        expect(table[0]).toBeGreaterThanOrEqual(0);
        expect(table[32]).toBeLessThanOrEqual(1);
        // 단조 — 계조가 뒤집히면 색이 깨져 보인다
        for (let i = 1; i < table.length; i++) {
          expect(table[i]!, `${name} i=${i}`).toBeGreaterThanOrEqual(table[i - 1]!);
        }
      }
    }
    // 하이라이트만 민다 — 어두운 쪽은 그대로
    const hi = highlightsTable(1);
    expect(hi[0]).toBeCloseTo(0, 6);
    expect(hi[4]).toBeCloseTo(4 / 32, 6); // x=0.125 는 가중치 0
    expect(hi[28]!).toBeGreaterThan(28 / 32);
    // 섀도만 민다 — 밝은 쪽은 그대로
    const sh = shadowsTable(1);
    expect(sh[32]).toBeCloseTo(1, 6);
    expect(sh[28]).toBeCloseTo(28 / 32, 6);
    expect(sh[2]!).toBeGreaterThan(2 / 32);
    // amount 0 은 항등
    expect(highlightsTable(0)[16]).toBeCloseTo(0.5, 6);
    expect(shadowsTable(0)[8]).toBeCloseTo(0.25, 6);
  });

  it('sharpen 은 3x3 언샤프 커널', () => {
    expect(sharpenKernel(2)).toEqual({ order: '3 3', kernelMatrix: '0 -1 0 -1 5 -1 0 -1 0', divisor: 1 });
    expect(sharpenKernel(1).kernelMatrix).toBe('0 -0.5 0 -0.5 3 -0.5 0 -0.5 0');
    expect(sharpenKernel(0).kernelMatrix).toBe('0 0 0 0 1 0 0 0 0'); // 항등
    expect(effectSvgStages([eff('sharpen', { amount: 0 })])).toEqual([]);
  });

  it('glow/chromaShift 는 필터 영역을 넓혀야 한다', () => {
    const stages = effectSvgStages([
      eff('glow', { amount: 0.7, radius: 24 }),
      eff('chromaShift', { px: 8 }),
    ]);
    expect(stages.map((s) => s.kind)).toEqual(['glow', 'chromaShift']);
    expect(stages[0]!.data).toEqual({ amount: 0.7, radius: 24 });
    expect(needsWideFilterRegion(stages)).toBe(true);
    expect(needsWideFilterRegion(effectSvgStages([eff('temperature', { amount: 1 })]))).toBe(false);
    // 파라미터가 0 이면 스테이지 없음
    expect(effectSvgStages([eff('glow', { amount: 0, radius: 20 }), eff('chromaShift', { px: 0 })])).toEqual([]);
  });

  it('효과 배열 순서가 스테이지 순서로 유지된다', () => {
    const stages = effectSvgStages([
      eff('sharpen', { amount: 1 }),
      eff('temperature', { amount: 0.3 }),
      eff('glow', { amount: 0.5, radius: 10 }),
    ]);
    expect(stages.map((s) => s.kind)).toEqual(['sharpen', 'colorMatrix', 'glow']);
  });

  it('chromaKeyParams 계수의 합은 0 — 무채색(회색·흰색)은 점수가 0 이다', () => {
    const p = chromaKeyParams({ color: '#00b140', similarity: 0.4, smoothness: 0.1 });
    expect(p.c[0] + p.c[1] + p.c[2]).toBeCloseTo(0, 10);
    expect(chromaKeyScore(p, 1, 1, 1)).toBeCloseTo(0, 10); // 흰색
    expect(chromaKeyScore(p, 0.5, 0.5, 0.5)).toBeCloseTo(0, 10); // 회색
    expect(chromaKeyScore(p, 0, 0, 0)).toBeCloseTo(0, 10); // 검정
    // 키 색 자신의 점수 = mKey (계획서 실계산 0.539)
    expect(chromaKeyScore(p, 0, 0xb1 / 255, 0x40 / 255)).toBeCloseTo(p.mKey, 6);
    expect(p.mKey).toBeCloseTo(0.5394, 3);
  });
});

describe('tableValues 문자열 (curvesToTables → feFunc*)', () => {
  it('항등 커브는 0..1 선형 33개', () => {
    const t = curvesToTables({ rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })!;
    const s = tableValuesString(t.r);
    const parts = s.split(' ');
    expect(parts).toHaveLength(33);
    expect(parts[0]).toBe('0');
    expect(parts[32]).toBe('1');
    expect(parseFloat(parts[16]!)).toBeCloseTo(0.5, 4);
    expect(s.startsWith('0 0.0313 0.0625 0.0938 0.125')).toBe(true);
  });

  it('S 커브는 어두운 쪽을 더 누르고 밝은 쪽을 더 올린다', () => {
    const t = curvesToTables({
      rgb: [{ x: 0, y: 0 }, { x: 0.25, y: 0.15 }, { x: 0.75, y: 0.85 }, { x: 1, y: 1 }],
    })!;
    expect(t.r[8]!).toBeLessThan(0.25);
    expect(t.r[24]!).toBeGreaterThan(0.75);
    const parts = tableValuesString(t.r).split(' ');
    expect(parts).toHaveLength(33);
    expect(parts.every((p) => Number.isFinite(parseFloat(p)))).toBe(true);
  });

  it('0..1 밖 값은 클램프되고 소수 4자리로 잘린다', () => {
    expect(tableValuesString([-1, 0.123456789, 2])).toBe('0 0.1235 1');
  });
});

describe('오버레이 효과', () => {
  it('grain/scanlines/lightLeak 만 오버레이로 나온다', () => {
    const o = effectOverlays([
      eff('blur', { px: 2 }),
      eff('grain', { amount: 0.4 }),
      eff('scanlines', { amount: 0.3, lines: 600 }),
      eff('lightLeak', { amount: 0.5, hue: 400 }),
    ]);
    expect(o.map((x) => x.kind)).toEqual(['grain', 'scanlines', 'lightLeak']);
    expect(o[1]!.params).toEqual({ amount: 0.3, lines: 600 });
    expect(o[2]!.params).toEqual({ amount: 0.5, hue: 40 }); // hue 400 → 40 정규화
    expect(effectOverlays([eff('grain', { amount: 0 })])).toEqual([]);
    expect(effectOverlays(undefined)).toEqual([]);
  });

  it('lines 는 100..2000 으로 클램프', () => {
    expect(effectOverlays([eff('scanlines', { amount: 1, lines: 5 })])[0]!.params).toEqual({
      amount: 1,
      lines: 100,
    });
    expect(effectOverlays([eff('scanlines', { amount: 1, lines: 99999 })])[0]!.params).toEqual({
      amount: 1,
      lines: 2000,
    });
  });

  it('grainSeed 는 항상 1 이상이고 프레임마다 다르다 (0 과 1 은 SVG 에서 같은 노이즈)', () => {
    const seeds = [0, 1, 2, 3, 976, 977, 978].map((f) => grainSeed(f));
    expect(seeds.every((s) => s >= 1)).toBe(true);
    expect(grainSeed(0)).not.toBe(grainSeed(1));
    expect(new Set([0, 1, 2, 3, 4, 5].map(grainSeed)).size).toBe(6);
  });

  it('scanlinesCss 는 period 주기로 절반만 어둡게', () => {
    expect(scanlinesCss(0.4, 6)).toBe(
      'repeating-linear-gradient(to bottom, rgba(0,0,0,0.3) 0px, rgba(0,0,0,0.3) 3px, rgba(0,0,0,0) 3px, rgba(0,0,0,0) 6px)',
    );
  });

  it('lightLeakCss 는 screen 합성용 대각 그라디언트 (양끝 투명)', () => {
    const css = lightLeakCss(0.4, 30);
    expect(css.startsWith('linear-gradient(115deg, rgba(0,0,0,0) 0%')).toBe(true);
    expect(css).toContain('hsla(30,100%,62%,0.34)');
    expect(css).toContain('hsla(52,100%,74%,0.4)');
    expect(css.endsWith('rgba(0,0,0,0) 84%)')).toBe(true);
  });
});

describe('buildFilterNodes — 하나의 <filter> 로 체인', () => {
  const stage = (kind: string, id: string, data: unknown) =>
    ({ kind, id, data }) as Parameters<typeof buildFilterNodes>[0][number];

  it('스테이지가 in → result 로 이어진다 (첫 in 은 SourceGraphic)', () => {
    const nodes = buildFilterNodes([
      stage('curves', 'f0', { r: [0, 1], g: [0, 1], b: [0, 1] }),
      stage('colorMatrix', 'f1', { values: '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0' }),
      stage('chromaKey', 'f2', chromaKeyParams({ color: '#00b140', similarity: 0.4, smoothness: 0.1 })),
    ]) as { props: Record<string, unknown> }[];
    // 크로마키는 여러 primitive 로 펼쳐지지만 **마지막 result 는 스테이지 id** 여야 한다
    expect(nodes[0]!.props.in).toBe('SourceGraphic');
    expect(nodes[0]!.props.result).toBe('f0');
    expect(nodes[1]!.props.in).toBe('f0');
    expect(nodes[2]!.props.in).toBe('f1'); // 크로마키 첫 primitive 의 입력
    expect(nodes[nodes.length - 1]!.props.result).toBe('f2');
  });

  it('glow 는 하이라이트 추출 → 블러 → screen 합성 4단계', () => {
    const nodes = buildFilterNodes([stage('glow', 'g', { amount: 0.5, radius: 20 })]) as {
      type: string;
      props: Record<string, unknown>;
    }[];
    expect(nodes).toHaveLength(4);
    expect(nodes[1]!.type).toBe('feGaussianBlur');
    expect(nodes[1]!.props.stdDeviation).toBe('10');
    expect(nodes[3]!.type).toBe('feBlend');
    expect(nodes[3]!.props.mode).toBe('screen');
    expect(nodes[3]!.props.in).toBe('SourceGraphic'); // 원본 위에 되얹는다
    expect(nodes[3]!.props.result).toBe('g');
  });

  it('chromaShift 는 R/B 를 반대로 밀고 screen 으로 재조합', () => {
    const nodes = buildFilterNodes([stage('chromaShift', 'c', { px: 6 })]) as {
      type: string;
      props: Record<string, unknown>;
    }[];
    expect(nodes).toHaveLength(7);
    expect(nodes[0]!.props.dx).toBe('-6');
    expect(nodes[2]!.props.dx).toBe('6');
    expect(nodes[6]!.props.result).toBe('c');
    expect(nodes[6]!.props.mode).toBe('screen');
  });
});
