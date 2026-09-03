// 프리뷰 v2 — 레이아웃/전환 → WebGL 유니폼 변환 (순수)
import { describe, expect, it } from 'vitest';
import type { Effect } from '@kitkat/schema';
import { curvesToTables } from '@kitkat/schema';
import {
  activeTransitionOverlays,
  activeTransitionStyles,
  chromaKeyParams,
  effectSvgStages,
  effectsToFilter,
} from '@kitkat/renderer/composition';
import {
  CLIP_CIRCLE_IN,
  CLIP_CIRCLE_OUT,
  CLIP_INSET,
  OP_BRIGHTNESS,
  OP_HUE,
  OP_SATURATE,
  blendModeCode,
  composeColorMatrix,
  composeSvgChain,
  parseColorMatrix,
  parseCssFilter,
  parseTransform,
  sampleTable,
  transitionFlashes,
  transitionParams,
} from '../src/preview/gl-params.js';

type StyleLike = Record<string, unknown>;

describe('CSS filter 파싱', () => {
  it('effectsToFilter 가 만든 문자열을 순서 그대로 연산으로 바꾼다', () => {
    const effects: Effect[] = [
      { id: 'e1', type: 'brightness', params: { amount: 1.2 } },
      { id: 'e2', type: 'hue', params: { deg: 30 } },
      { id: 'e3', type: 'saturation', params: { amount: 0.5 } },
    ];
    const { ops, blurPx } = parseCssFilter(effectsToFilter(effects));
    expect(ops.map((o) => o.op)).toEqual([OP_BRIGHTNESS, OP_HUE, OP_SATURATE]);
    expect(ops.map((o) => o.arg)).toEqual([1.2, 30, 0.5]);
    expect(blurPx).toBe(0);
  });

  it('blur 는 따로 빼서 합산한다 (셰이더에서 밉맵 근사)', () => {
    const { ops, blurPx } = parseCssFilter('blur(4px) brightness(0.8) blur(2px)');
    expect(blurPx).toBe(6);
    expect(ops).toHaveLength(1);
  });

  it('빈 문자열은 연산이 없다', () => {
    expect(parseCssFilter('')).toEqual({ ops: [], blurPx: 0 });
  });
});

describe('SVG 필터 체인 접기', () => {
  it('커브 테이블을 하나로 합성한다 (항등 커브면 값이 보존된다)', () => {
    const t = curvesToTables({ rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(t).not.toBeNull();
    const chain = composeSvgChain([
      { kind: 'curves', id: 's0', data: t },
      { kind: 'curves', id: 's1', data: t },
    ]);
    expect(chain.tables).not.toBeNull();
    expect(chain.tables?.r).toHaveLength(33);
    expect(chain.tables?.r[0]).toBeCloseTo(0, 5);
    expect(chain.tables?.r[32]).toBeCloseTo(1, 5);
    expect(chain.tables?.r[16]).toBeCloseTo(0.5, 3);
    expect(chain.unsupported).toEqual([]);
  });

  it('temperature/tint 색행렬은 곱해서 하나로 만든다', () => {
    const stages = effectSvgStages([
      { id: 'e1', type: 'temperature', params: { amount: 1 } },
      { id: 'e2', type: 'tint', params: { amount: 1 } },
    ]).map((s, i) => ({ kind: s.kind, id: `s${i}`, data: s.data }));
    const chain = composeSvgChain(stages);
    expect(chain.matrix).not.toBeNull();
    // R 게인 1.3 × 1.15, B 게인 0.7 × 1.15
    expect(chain.matrix?.[0]).toBeCloseTo(1.3 * 1.15, 5);
    expect(chain.matrix?.[12]).toBeCloseTo(0.7 * 1.15, 5);
  });

  it('못 그리는 스테이지는 목록으로 돌려준다 (크로마키는 이제 그린다)', () => {
    const chain = composeSvgChain([
      { kind: 'glow', id: 's0', data: { amount: 1, radius: 16 } },
      { kind: 'sharpen', id: 's1', data: { amount: 1 } },
      {
        kind: 'chromaKey',
        id: 's2',
        data: chromaKeyParams({ color: '#00b140', similarity: 0.4, smoothness: 0.1 }),
      },
      { kind: 'chromaShift', id: 's3', data: { px: 4 } },
    ]);
    // W8 F15 이후: 글로우·샤픈·색수차도 셰이더가 그린다 → 「못 그림」 목록이 비었다
    expect(chain.unsupported).toEqual([]);
    expect(chain.chroma).not.toBeNull();
    expect(chain.tables).toBeNull();
  });

  it('색행렬이 커브보다 앞서면 순서 근사라고 표시한다', () => {
    const t = curvesToTables({ rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    const chain = composeSvgChain([
      { kind: 'colorMatrix', id: 's0', data: { values: parseColorMatrixFixture() } },
      { kind: 'curves', id: 's1', data: t },
    ]);
    expect(chain.orderApprox).toBe(true);
  });

  it('색행렬 합성은 결합이 맞다 (게인 2 → 게인 3 = 게인 6)', () => {
    const g2 = parseColorMatrix('2 0 0 0 0 0 2 0 0 0 0 0 2 0 0 0 0 0 1 0');
    const g3 = parseColorMatrix('3 0 0 0 0 0 3 0 0 0 0 0 3 0 0 0 0 0 1 0');
    expect(g2).not.toBeNull();
    const m = composeColorMatrix(g2 as number[], g3 as number[]);
    expect(m[0]).toBe(6);
    expect(m[6]).toBe(6);
  });

  it('sampleTable 은 33개 테이블을 선형 보간한다', () => {
    const t = Array.from({ length: 33 }, (_, i) => i / 32);
    expect(sampleTable(t, 0)).toBeCloseTo(0, 6);
    expect(sampleTable(t, 0.5)).toBeCloseTo(0.5, 6);
    expect(sampleTable(t, 1)).toBeCloseTo(1, 6);
    expect(sampleTable(t, 2)).toBeCloseTo(1, 6);
  });
});

function parseColorMatrixFixture(): string {
  return '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0';
}

describe('블렌드 모드 코드', () => {
  it('normal 과 미지정은 0, 나머지는 서로 다른 코드다', () => {
    expect(blendModeCode()).toBe(0);
    expect(blendModeCode('normal')).toBe(0);
    const codes = [
      'multiply', 'screen', 'overlay', 'darken', 'lighten',
      'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
    ].map((m) => blendModeCode(m));
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => c > 0)).toBe(true);
  });
});

describe('전환 → 유니폼', () => {
  it('fade 는 불투명도만 바꾼다 (정확)', () => {
    const styles = activeTransitionStyles(250, 2000, { type: 'fade', duration: 1000 }) as StyleLike[];
    const p = transitionParams(styles, 1920, 1080);
    expect(p.opacity).toBeCloseTo(0.25, 6);
    expect(p.affine).toEqual([1, 0, 0, 1, 0, 0]);
    expect(p.approx).toEqual([]);
  });

  it('slideLeft 의 %는 캔버스 px 로 옮겨진다 (정확)', () => {
    const styles = activeTransitionStyles(500, 2000, {
      type: 'slideLeft',
      duration: 1000,
    }) as StyleLike[];
    const p = transitionParams(styles, 1920, 1080);
    // gone 0.5 → translateX(50%) → 960px
    expect(p.affine[4]).toBeCloseTo(960, 6);
    expect(p.affine[5]).toBeCloseTo(0, 6);
    expect(p.approx).toEqual([]);
  });

  it('zoomIn 의 scale 은 캔버스 중심을 기준으로 한다', () => {
    const styles = activeTransitionStyles(0, 2000, { type: 'zoomIn', duration: 1000 }) as StyleLike[];
    const p = transitionParams(styles, 1000, 1000);
    // scale(0.6) about (500,500) → e = f = 500*(1-0.6) = 200
    expect(p.affine[0]).toBeCloseTo(0.6, 6);
    expect(p.affine[4]).toBeCloseTo(200, 6);
    expect(p.affine[5]).toBeCloseTo(200, 6);
  });

  it('wipeLeft 는 inset 클립, circleOpen 은 원 안쪽 클립이 된다', () => {
    const wipe = transitionParams(
      activeTransitionStyles(500, 2000, { type: 'wipeLeft', duration: 1000 }) as StyleLike[],
      1920,
      1080,
    );
    expect(wipe.clips[0]?.kind).toBe(CLIP_INSET);
    expect(wipe.clips[0]?.p[1]).toBeCloseTo(0.5, 6);

    const circle = transitionParams(
      activeTransitionStyles(500, 2000, { type: 'circleOpen', duration: 1000 }) as StyleLike[],
      1920,
      1080,
    );
    expect(circle.clips[0]?.kind).toBe(CLIP_CIRCLE_IN);
    expect(circle.clips[0]?.p[1]).toBeCloseTo(960, 6);
  });

  it('circleClose 의 마스크는 원 바깥 클립으로 바뀐다', () => {
    const p = transitionParams(
      activeTransitionStyles(500, 2000, { type: 'circleClose', duration: 1000 }) as StyleLike[],
      1920,
      1080,
    );
    expect(p.clips[0]?.kind).toBe(CLIP_CIRCLE_OUT);
    expect(p.approx).toEqual([]);
  });

  it('blurFade 는 블러를 근사한다고 표시한다', () => {
    const p = transitionParams(
      activeTransitionStyles(500, 2000, { type: 'blurFade', duration: 1000 }) as StyleLike[],
      1920,
      1080,
    );
    expect(p.blurPx).toBeCloseTo(12, 6);
    expect(p.approx).toContain('전환 블러(근사)');
  });

  it('rotate 는 CSS 와 같은 방향(시계)이다', () => {
    const m = parseTransform('rotate(90deg)', 100, 100);
    // (1,0) → (0,1) : y 아래 방향 화면 좌표에서 시계 방향
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[1]).toBeCloseTo(1, 6);
    expect(m[2]).toBeCloseTo(-1, 6);
  });
});

describe('전환 덮개', () => {
  it('whiteFlash/blackFlash 는 단색 덮개로 그린다', () => {
    const w = transitionFlashes(
      activeTransitionOverlays(500, 2000, { type: 'whiteFlash', duration: 1000 }) as {
        key: string;
        style: StyleLike;
      }[],
    );
    expect(w.flashes[0]?.color).toEqual([1, 1, 1]);
    expect(w.flashes[0]?.opacity).toBeCloseTo(0.5, 6);
    expect(w.approx).toEqual([]);

    const b = transitionFlashes(
      activeTransitionOverlays(500, 2000, { type: 'blackFlash', duration: 1000 }) as {
        key: string;
        style: StyleLike;
      }[],
    );
    expect(b.flashes[0]?.color).toEqual([0, 0, 0]);
  });

  it('glitch 의 찢김 레이어를 셰이더 유니폼으로 풀어낸다 (예전엔 「미지원」이었다)', () => {
    const g = transitionFlashes(
      activeTransitionOverlays(500, 2000, { type: 'glitch', duration: 1000 }) as {
        key: string;
        style: StyleLike;
      }[],
    );
    expect(g.approx).toEqual([]);
    expect(g.glitch).not.toBeNull();
    expect(g.glitch?.bands).toHaveLength(2);
    expect(g.glitch?.scan?.period).toBe(5);
  });
});
