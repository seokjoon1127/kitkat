// W8 F9 — 자유 마스크. 좌표계·CSS 생성·모양 키프레임·펜 툴 기하.
//
// 이 파일이 지키는 가장 중요한 것 둘:
//  1. **기존 3종(rect·circle·linear)의 CSS 문자열이 한 글자도 안 바뀐다** (픽셀 회귀 방지)
//  2. **`d` 는 「마스크 상자 0..1」이다** — 모양은 d, 위치·크기는 x/y/w/h.
//     그래야 F10 트래킹(= x/y/w/h 키프레임)이 자유 마스크에도 그대로 붙는다.
import { describe, expect, it } from 'vitest';
import type { Asset, ImageClip, Mask } from '@kitkat/schema';
import {
  computeVisualLayout,
  maskCanvasFromLocal,
  maskLocalFromCanvas,
} from '../src/layout/index.js';
import {
  circleShape,
  fitMaskBox,
  insertVertex,
  lerpMaskPathD,
  maskPathBounds,
  maskPathToPx,
  nearestOnPath,
  parseMaskShape,
  resolveMaskD,
  segmentPoint,
  serializeMaskShape,
} from '../src/layout/mask-path.js';
import { maskLayerCss, maskSigma } from '../src/composition/clips.js';

const ASSET: Asset = { id: 'a1', kind: 'image', src: 'a.png', name: 'a', width: 1080, height: 1920 };

/** CSS 마스크 «레이어» 수 — 그라디언트 안에도 쉼표가 있어 split(',') 로는 못 센다. */
const layerCount = (image: unknown): number =>
  (String(image).match(/gradient\(|url\(/g) ?? []).length;

function layoutOf(over: Partial<ImageClip> = {}, tMs = 0) {
  const clip: ImageClip = { id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 1000, ...over };
  return computeVisualLayout({ clip, asset: ASSET, canvasW: 1080, canvasH: 1920, tMs });
}

const TRI = 'M 0,0 L 1,0 L 0.5,1 Z';

// ── 1. 좌표계 ────────────────────────────────────────────────────────────

describe('`d` 의 좌표계 — 마스크 상자 안의 0..1', () => {
  it('최종 px = (x + dx·w)·boxW, (y + dy·h)·boxH', () => {
    const mask: Mask = { shape: 'path', feather: 0, x: 0.25, y: 0.5, w: 0.5, h: 0.25, d: TRI };
    // 상자가 1080×1920 이면 (0,0) → (270, 960), (1,0) → (810, 960), (0.5,1) → (540, 1440)
    expect(maskPathToPx(TRI, mask, 1080, 1920)).toBe('M 270,960 L 810,960 L 540,1440 Z');
  });

  it('모양은 그대로 두고 상자만 옮기면 그림이 통째로 옮겨진다 (트래킹이 공짜인 이유)', () => {
    const a: Mask = { shape: 'path', feather: 0, x: 0, y: 0, w: 0.5, h: 0.5, d: TRI };
    const b: Mask = { ...a, x: 0.5 };
    const pa = maskPathToPx(TRI, a, 1000, 1000)!;
    const pb = maskPathToPx(TRI, b, 1000, 1000)!;
    const nums = (s: string) => s.match(/-?[\d.]+/g)!.map(Number);
    const da = nums(pa);
    const db = nums(pb);
    for (let i = 0; i < da.length; i += 2) {
      expect(db[i]! - da[i]!).toBeCloseTo(500, 6); // x 만 500px 이동
      expect(db[i + 1]!).toBeCloseTo(da[i + 1]!, 6);
    }
  });

  it('문법이 틀린 d 는 null 을 낸다 (렌더가 조용히 이상해지지 않는다)', () => {
    const mask: Mask = { shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1, d: TRI };
    expect(maskPathToPx('M0,0 A 1 1 0 0 1 1,1', mask, 100, 100)).toBeNull();
  });
});

describe('펜 툴 역변환 — 편집기의 «유일한 정답 조건»', () => {
  const mask: Mask = { shape: 'path', feather: 0, x: 0.2, y: 0.1, w: 0.6, h: 0.7, d: TRI };

  it('회전 0/30/−45° × 배율 0.5/1/2 의 9조합에서 왕복이 제자리로 돌아온다', () => {
    for (const rotation of [0, 30, -45]) {
      for (const scale of [0.5, 1, 2]) {
        const l = layoutOf({ transform: { x: 0.05, y: -0.1, scale, rotation } });
        for (const [u, v] of [[0, 0], [1, 0], [0.5, 1], [0.37, 0.62]] as const) {
          const px = maskCanvasFromLocal(l, mask, u, v);
          const back = maskLocalFromCanvas(l, mask, px.x, px.y);
          expect(back.x).toBeCloseTo(u, 9);
          expect(back.y).toBeCloseTo(v, 9);
        }
      }
    }
  });

  it('회전 0·배율 1 이면 화면 좌표가 손으로 센 값과 같다', () => {
    const l = layoutOf();
    // 1080×1920 에셋이 1080×1920 캔버스에 꽉 차므로 box = (0,0,1080,1920)
    expect(l.box).toEqual({ left: 0, top: 0, width: 1080, height: 1920 });
    const p = maskCanvasFromLocal(l, mask, 0, 0);
    expect(p.x).toBeCloseTo(0.2 * 1080, 9);
    expect(p.y).toBeCloseTo(0.1 * 1920, 9);
  });

  it('뒤집기(flipH)도 되돌린다', () => {
    const l = layoutOf({ transform: { x: 0, y: 0, scale: 1, rotation: 20, flipH: true } });
    const px = maskCanvasFromLocal(l, mask, 0.3, 0.8);
    const back = maskLocalFromCanvas(l, mask, px.x, px.y);
    expect(back.x).toBeCloseTo(0.3, 9);
    expect(back.y).toBeCloseTo(0.8, 9);
  });
});

// ── 2. CSS 생성 ──────────────────────────────────────────────────────────

describe('maskLayerCss — 기존 3종은 한 글자도 안 바뀐다', () => {
  it('rect 는 v1 과 같은 두 장 그라디언트 + intersect', () => {
    const m: Mask = { shape: 'rect', feather: 0.2, x: 0.1, y: 0.2, w: 0.5, h: 0.6 };
    const { style, defs } = maskLayerCss([m], 1080, 1920, 'c1');
    expect(defs).toEqual([]);
    expect(style.maskComposite).toBe('intersect');
    expect(style.WebkitMaskComposite).toBe('source-in');
    expect(layerCount(style.maskImage)).toBe(2);
    expect(String(style.maskImage)).toContain('linear-gradient(to right, transparent 10%');
  });

  it('circle · linear 도 v1 문자열 그대로', () => {
    const c: Mask = { shape: 'circle', feather: 0.3, x: 0, y: 0, w: 1, h: 1 };
    expect(String(maskLayerCss([c], 100, 100, 'c1').style.maskImage))
      .toBe('radial-gradient(ellipse 50% 50% at 50% 50%, #fff 70%, transparent 100%)');
    const l: Mask = { shape: 'linear', feather: 0.25, x: 0, y: 0.2, w: 1, h: 0.6 };
    expect(String(maskLayerCss([l], 100, 100, 'c1').style.maskImage))
      .toBe('linear-gradient(to bottom, transparent 20%, #fff 35%, #fff 64.99999999999999%, transparent 80%)');
  });

  it('마스크가 없으면 빈 스타일', () => {
    expect(maskLayerCss([], 100, 100, 'c1')).toEqual({ style: {}, defs: [] });
  });
});

describe('maskLayerCss — 자유 곡선', () => {
  const base: Mask = { shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1, d: TRI };

  it('페더 0 · 한 장이면 clip-path: path() 다 (가장 싸다)', () => {
    const { style, defs } = maskLayerCss([base], 1080, 1920, 'c1');
    expect(defs).toEqual([]);
    expect(style.clipPath).toBe('path("M 0,0 L 1080,0 L 540,1920 Z")');
    expect(style.WebkitClipPath).toBe(style.clipPath);
  });

  it('반전은 바깥 사각형 + evenodd 로 «구멍»을 뚫는다', () => {
    const { style } = maskLayerCss([{ ...base, invert: true }], 1000, 500, 'c1');
    expect(style.clipPath).toBe(
      'path(evenodd, "M0,0 L1000,0 L1000,500 L0,500 Z M 0,0 L 1000,0 L 500,500 Z")',
    );
  });

  it('페더가 있으면 SVG <mask> 를 참조한다', () => {
    const { style, defs } = maskLayerCss([{ ...base, feather: 0.3 }], 1080, 1920, 'c1');
    expect(style.maskImage).toBe('url(#c1m0)');
    expect(style.WebkitMaskImage).toBe('url(#c1m0)');
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('c1m0');
    expect(defs[0]!.sigma).toBeCloseTo(maskSigma(0.3, 1080, 1920), 9);
    // 번진 가장자리가 잘리지 않게 영역을 3σ 만큼 넓힌다
    expect(defs[0]!.region.x).toBeCloseTo(-3 * defs[0]!.sigma, 6);
    expect(defs[0]!.region.width).toBeCloseTo(1080 + 6 * defs[0]!.sigma, 6);
  });

  it('σ = feather · min(boxW,boxH) / 2', () => {
    expect(maskSigma(0.3, 1080, 1920)).toBeCloseTo((0.3 * 1080) / 2, 9);
    expect(maskSigma(0, 1080, 1920)).toBe(0);
  });

  it('d 가 없거나 문법이 틀리면 아무것도 안 건다 (전체가 사라지지 않는다)', () => {
    expect(maskLayerCss([{ ...base, d: undefined }], 100, 100, 'c1')).toEqual({ style: {}, defs: [] });
  });
});

describe('maskLayerCss — 여러 장 겹치기', () => {
  const p: Mask = { shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1, d: TRI };
  const c: Mask = { shape: 'circle', feather: 0.2, x: 0, y: 0, w: 1, h: 1 };

  it('두 장이면 레이어 2개 + 합성 방식 2개', () => {
    const { style, defs } = maskLayerCss([c, { ...p, op: 'subtract' }], 100, 100, 'c1');
    expect(layerCount(style.maskImage)).toBe(2);
    // 위 레이어(m0)의 합성 방식 = 아래 레이어(m1)의 op
    expect(style.maskComposite).toBe('subtract, add');
    expect(style.WebkitMaskComposite).toBe('source-out, source-over');
    expect(defs).toHaveLength(1); // path 만 SVG, circle 은 그라디언트
  });

  it('op 3종이 표준·webkit 값으로 옮겨진다', () => {
    for (const [op, std, wk] of [
      ['add', 'add', 'source-over'],
      ['subtract', 'subtract', 'source-out'],
      ['intersect', 'intersect', 'source-in'],
    ] as const) {
      const { style } = maskLayerCss([c, { ...p, op }], 100, 100, 'c1');
      expect(style.maskComposite).toBe(`${std}, add`);
      expect(style.WebkitMaskComposite).toBe(`${wk}, source-over`);
    }
  });

  it('여러 장이면 rect 도 SVG <mask> 로 간다 (한 장에 한 레이어여야 op 가 맞는다)', () => {
    const r: Mask = { shape: 'rect', feather: 0.1, x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const { style, defs } = maskLayerCss([r, { ...p, op: 'intersect' }], 200, 100, 'c1');
    expect(layerCount(style.maskImage)).toBe(2);
    expect(defs).toHaveLength(2);
    expect(defs[0]!.rect).toEqual({ x: 20, y: 10, width: 100, height: 50 });
  });
});

// ── 3. 모양 키프레임 (dKeys) ─────────────────────────────────────────────

describe('dKeys — 모양 자체의 애니메이션', () => {
  const a = 'M 0,0 L 1,0 L 1,1 Z';
  const b = 'M 0.5,0.5 L 1,0.5 L 1,1 Z';
  const mask: Mask = {
    shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1, d: a,
    dKeys: [{ time: 0, d: a }, { time: 1000, d: b }],
  };

  it('t=0 · t=1000 은 각 키와 «정확히» 같다', () => {
    expect(resolveMaskD(mask, 0)).toBe(a);
    expect(resolveMaskD(mask, 1000)).toBe(b);
    expect(resolveMaskD(mask, -100)).toBe(a);
    expect(resolveMaskD(mask, 5000)).toBe(b);
  });

  it('가운데는 수치를 선형 보간한다', () => {
    expect(resolveMaskD(mask, 500)).toBe('M 0.25,0.25 L 1,0.25 L 1,1 Z');
  });

  it('구간 이징은 «앞 키»의 easing 을 따른다 (키프레임과 같은 규칙)', () => {
    const eased: Mask = { ...mask, dKeys: [{ time: 0, d: a, easing: 'easeInOut' }, { time: 1000, d: b }] };
    expect(resolveMaskD(eased, 500)).toBe(resolveMaskD(mask, 500)); // easeInOut(0.5) === 0.5
    expect(resolveMaskD(eased, 250)).not.toBe(resolveMaskD(mask, 250));
  });

  it('명령 구성이 다르면 보간하지 않는다 (스키마가 이미 막지만 여기서도 안 터진다)', () => {
    expect(lerpMaskPathD('M0,0 L1,1 Z', 'M0,0 C0,0 1,1 1,1 Z', 0.5)).toBeNull();
  });

  it('computeVisualLayout 이 그 시각의 d 를 풀어 준다', () => {
    const l = layoutOf({ mask }, 500);
    expect(l.maskLayers).toHaveLength(1);
    expect(l.maskLayers[0]!.d).toBe('M 0.25,0.25 L 1,0.25 L 1,1 Z');
    expect(l.mask).toBe(l.maskLayers[0]);
  });

  it('masks[] 가 있으면 mask 는 무시된다', () => {
    const one: Mask = { shape: 'rect', feather: 0, x: 0, y: 0, w: 1, h: 1 };
    const l = layoutOf({ mask: one, masks: [one, { ...one, op: 'subtract' }] });
    expect(l.maskLayers).toHaveLength(2);
  });

  it('마스크가 없으면 maskLayers 는 빈 배열이다', () => {
    const l = layoutOf();
    expect(l.maskLayers).toEqual([]);
    expect(l.mask).toBeUndefined();
  });
});

// ── 4. 펜 툴 기하 ────────────────────────────────────────────────────────

describe('정점 모델 — 문서에는 d 만 저장하고 열 때 파싱한다', () => {
  it('직선 왕복', () => {
    const d = 'M 0,0 L 1,0 L 1,1 Z';
    const m = parseMaskShape(d)!;
    expect(m.closed).toBe(true);
    expect(m.pts.map((p) => [p.x, p.y])).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(serializeMaskShape(m)).toBe(d);
  });

  it('곡선 왕복 — C 의 제어점이 hOut/hIn 으로 나뉜다', () => {
    const d = 'M 0,0 C 0.2,0 0.8,1 1,1';
    const m = parseMaskShape(d)!;
    expect(m.pts[0]!.hOut).toEqual({ x: 0.2, y: 0 });
    expect(m.pts[1]!.hIn).toEqual({ x: 0.8, y: 1 });
    expect(serializeMaskShape(m)).toBe(d);
  });

  it('Q 는 같은 모양의 C 로 승격된다', () => {
    const m = parseMaskShape('M 0,0 Q 0.5,1 1,0')!;
    expect(m.pts).toHaveLength(2);
    expect(m.pts[0]!.hOut!.y).toBeCloseTo((2 / 3) * 1, 9);
  });

  it('원은 C 4개로 근사한다 — 반지름 오차 0.03% 이하', () => {
    const m = circleShape(0.5, 0.5, 0.5);
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      for (let t = 0; t <= 1; t += 0.05) {
        const p = segmentPoint(m, i, t)!;
        worst = Math.max(worst, Math.abs(Math.hypot(p.x - 0.5, p.y - 0.5) - 0.5) / 0.5);
      }
    }
    expect(worst).toBeLessThan(0.0003);
  });
});

describe('선 위 클릭 → 점 삽입 (모양이 안 변한다)', () => {
  it('직선 구간 가운데에 점이 생긴다', () => {
    const m = parseMaskShape('M 0,0 L 1,0 L 1,1 Z')!;
    const n = insertVertex(m, 0, 0.5);
    expect(n.pts).toHaveLength(4);
    expect(n.pts[1]).toMatchObject({ x: 0.5, y: 0 });
  });

  it('곡선 구간은 de Casteljau 로 쪼개 «모양을 그대로» 둔다', () => {
    const m = parseMaskShape('M 0,0 C 0.2,1 0.8,1 1,0')!;
    const before = [0.1, 0.25, 0.5, 0.75, 0.9].map((t) => segmentPoint(m, 0, t)!);
    const n = insertVertex(m, 0, 0.5);
    // 쪼갠 뒤에도 같은 곡선 위의 점들이 (두 구간에 나뉘어) 그대로 있다
    for (const p of before) {
      const near = nearestOnPath(n, p, 400)!;
      expect(near.dist).toBeLessThan(1e-3);
    }
  });

  it('nearestOnPath 는 가장 가까운 구간·매개변수를 준다', () => {
    const m = parseMaskShape('M 0,0 L 1,0 L 1,1 Z')!;
    const near = nearestOnPath(m, { x: 0.5, y: 0.02 }, 100)!;
    expect(near.segment).toBe(0);
    expect(near.t).toBeCloseTo(0.5, 1);
  });
});

describe('[모양에 맞추기] — 상자를 모양에 붙인다', () => {
  it('bounds 를 재서 x/y/w/h 를 다시 잡고 d 를 0..1 로 편다', () => {
    const mask: Mask = {
      shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1,
      d: 'M 0.25,0.5 L 0.75,0.5 L 0.75,1 Z',
    };
    expect(maskPathBounds(mask.d!)).toEqual({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
    const fitted = fitMaskBox(mask)!;
    expect(fitted).toMatchObject({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
    expect(fitted.d).toBe('M 0,0 L 1,0 L 1,1 Z');
    // 화면 위 위치는 그대로다 — 상자와 d 가 같이 바뀌었기 때문
    expect(maskPathToPx(fitted.d!, fitted, 1000, 1000))
      .toBe(maskPathToPx(mask.d!, mask, 1000, 1000));
  });

  it('path 가 아니면 null', () => {
    expect(fitMaskBox({ shape: 'rect', feather: 0, x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});
