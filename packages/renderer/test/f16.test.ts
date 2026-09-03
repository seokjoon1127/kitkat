// W8 F16 — 신규 전환·효과의 «그림». 개수만 채우지 않았는지를 여기서 본다:
// ① 서로 다른 그림인가(중복 검사) ② 수식이 의도대로인가.
import { describe, expect, it } from 'vitest';
import { EFFECT_CATALOG, TRANSITION_CATALOG } from '@kitkat/schema';
import type { Effect, EffectType, TransitionType } from '@kitkat/schema';
import {
  activeTransitionBlurs,
  transitionBlurAxis,
  transitionOverlays,
  transitionSplitPx,
  transitionStyle,
} from '../src/composition/transitions.js';
import { effectGlStages } from '../src/composition/gl-effects.js';
import {
  effectOverlays,
  effectSvgStages,
  effectsToFilter,
  filmScratchLines,
  mosaicGroutCss,
  needsWideFilterRegion,
  tiltShiftMaskCss,
  vignetteAmount,
} from '../src/composition/effects.js';
import {
  duotoneMatrix,
  gammaTable,
  hslRgb,
  pixelateSpec,
  posterizeLevels,
  thresholdTransfer,
  whiteBalanceMatrix,
} from '../src/composition/svg-data.js';
import { buildFilterNodes } from '../src/composition/svg-filters.js';

const t = (id: string): TransitionType => id as TransitionType;

// ═══ 중복 검사 — 「색만 바꾼 복제본 금지」를 기계가 지킨다 ═══════════════════

describe('전환 51종이 서로 다른 그림이다', () => {
  it('진행도 4곳의 스타일·덮개·필터를 합친 «지문»이 51개 전부 다르다', () => {
    const seen = new Map<string, string>();
    for (const d of TRANSITION_CATALOG) {
      const id = t(d.id);
      const fingerprint = JSON.stringify([
        [0.15, 0.35, 0.6, 0.85].map((v) => [transitionStyle(id, v), transitionOverlays(id, v)]),
        transitionBlurAxis(id),
        transitionSplitPx(id),
      ]);
      const twin = seen.get(fingerprint);
      expect(twin, `${d.id} 와 ${twin} 이 같은 그림이다`).toBeUndefined();
      seen.set(fingerprint, d.id);
    }
    expect(seen.size).toBe(51);
  });

  it('같은 갈래 안에서도 다르다 — 방향만 바꾼 4벌이 같은 값이면 안 된다', () => {
    const dirs = ['slideUpLeft', 'slideUpRight', 'slideDownLeft', 'slideDownRight'];
    const styles = dirs.map((id) => JSON.stringify(transitionStyle(t(id), 0.4)));
    expect(new Set(styles).size).toBe(4);
    const sq = ['squeezeLeft', 'squeezeRight', 'squeezeUp', 'squeezeDown']
      .map((id) => JSON.stringify(transitionStyle(t(id), 0.4)));
    expect(new Set(sq).size).toBe(4);
    const wd = ['wipeDiagTL', 'wipeDiagTR', 'wipeDiagBL', 'wipeDiagBR']
      .map((id) => JSON.stringify(transitionStyle(t(id), 0.4)));
    expect(new Set(wd).size).toBe(4);
  });
});

describe('효과 50종이 서로 다른 그림이다 (W8 #8 부터 WebGL 6종 포함)', () => {
  it('CSS·SVG·오버레이·WebGL 을 합친 «지문»이 50개 전부 다르다', () => {
    const seen = new Map<string, string>();
    for (const d of EFFECT_CATALOG) {
      const params = Object.fromEntries(d.params.map((p) => [p.key, p.def === p.max ? p.min : p.max]));
      const e: Effect = { id: 'x', type: d.id as EffectType, params };
      const fingerprint = JSON.stringify([
        effectsToFilter([e]), effectSvgStages([e]), effectOverlays([e]), vignetteAmount([e]),
        effectGlStages([e]),
      ]);
      const twin = seen.get(fingerprint);
      expect(twin, `${d.id} 와 ${twin} 이 같은 그림이다`).toBeUndefined();
      seen.set(fingerprint, d.id);
    }
    expect(seen.size).toBe(50);
  });
});

// ═══ 신규 전환의 수식 ═══════════════════════════════════════════════════════

describe('기본 3종', () => {
  it('dissolve 는 «점 격자» 마스크가 자란다 — 페이드(투명도)와 다른 물건이다', () => {
    const mid = transitionStyle(t('dissolve'), 0.5);
    expect(String(mid.maskImage)).toContain('radial-gradient');
    expect(String(mid.maskImage)).toContain('50%');
    // 칸은 «정사각 px» 이어야 한다 — % 로 잡으면 9:16 캔버스에서 칸이 길쭉해져
    // 점이 가로로만 붙고 세로에 구멍이 남는다 (컨택트 시트에서 실제로 그렇게 나왔다).
    expect(mid.maskSize).toBe('60px 60px');
    expect(mid.opacity).toBeUndefined(); // 투명도로 하는 게 아니다
    expect(String(transitionStyle(t('dissolve'), 0).maskImage)).toContain('#fff 0%');
    expect(String(transitionStyle(t('dissolve'), 1).maskImage)).toContain('#fff 100%');
  });

  it('dip 은 앞쪽 절반 동안 화면이 캄캄하다 (플래시의 덮개는 선형이다)', () => {
    const dipMid = transitionOverlays(t('dipToBlack'), 0.4)[0]!;
    const flashMid = transitionOverlays(t('blackFlash'), 0.4)[0]!;
    expect(dipMid.style.opacity).toBeCloseTo(1, 6);      // 아직 완전히 검다
    expect(flashMid.style.opacity).toBeCloseTo(0.6, 6);  // 이미 걷히는 중
    // 클립 자체의 투명도도 다르다 — 플래시는 «이미 다 보이는» 상태다
    expect(transitionStyle(t('dipToBlack'), 0.4).opacity).toBeCloseTo(0.4, 6);
    expect(transitionStyle(t('blackFlash'), 0.4).opacity).toBe(1);
  });

  it('dipToBlack 과 dipToWhite 는 덮개 색만 다르고 곡선은 같다', () => {
    expect(transitionOverlays(t('dipToBlack'), 0.3)[0]!.style.backgroundColor).toBe('#000000');
    expect(transitionOverlays(t('dipToWhite'), 0.3)[0]!.style.backgroundColor).toBe('#ffffff');
    expect(transitionStyle(t('dipToBlack'), 0.3)).toEqual(transitionStyle(t('dipToWhite'), 0.3));
  });
});

describe('슬라이드·와이프 신규', () => {
  it('대각 슬라이드는 기존 slide 의 규약(양수 = 그 방향에서 들어온다)을 따른다', () => {
    // slideUp 이 +Y 에서 오므로 slideUpLeft 는 (+X, +Y) = 오른쪽 아래에서 온다
    expect(transitionStyle(t('slideUpLeft'), 0.5)).toEqual({ transform: 'translate(50%, 50%)' });
    expect(transitionStyle(t('slideDownRight'), 0.5)).toEqual({ transform: 'translate(-50%, -50%)' });
  });

  it('스퀴즈는 «잘리는» 게 아니라 눌린다 — clipPath 가 아니라 scale + origin', () => {
    expect(transitionStyle(t('squeezeLeft'), 0.25))
      .toEqual({ transform: 'scaleX(0.25)', transformOrigin: '0% 50%' });
    expect(transitionStyle(t('squeezeDown'), 0.25))
      .toEqual({ transform: 'scaleY(0.25)', transformOrigin: '50% 100%' });
    expect(transitionStyle(t('squeezeUp'), 0.25).clipPath).toBeUndefined();
  });

  it('대각 와이프는 모서리에서 자라는 삼각형이고, 끝에서 화면을 다 덮는다', () => {
    expect(transitionStyle(t('wipeDiagTL'), 0.5).clipPath).toBe('polygon(0% 0%, 101% 0%, 0% 101%)');
    // v=1 에서 반대쪽 모서리를 2% 넘겨 덮는다 (경계선에 딱 걸치면 안티에일리어싱 자국이 남는다)
    const end = String(transitionStyle(t('wipeDiagTL'), 1).clipPath);
    expect(end).toBe('polygon(0% 0%, 202% 0%, 0% 202%)');
    expect(String(transitionStyle(t('wipeDiagBR'), 1).clipPath)).toBe(
      'polygon(100% 100%, -102% 100%, 100% -102%)',
    );
  });

  it('시계 와이프는 conic-gradient 가 0 → 360도로 돈다', () => {
    expect(String(transitionStyle(t('clockWipe'), 0).maskImage)).toContain('#fff 0deg');
    expect(String(transitionStyle(t('clockWipe'), 0.25).maskImage)).toContain('#fff 90deg');
    expect(String(transitionStyle(t('clockWipe'), 1).maskImage)).toContain('#fff 360deg');
  });
});

describe('줌·회전 신규', () => {
  it('zoomBlur 는 zoomIn/Out 보다 크게 움직이고 블러도 세다', () => {
    const zoomIn = Number(/scale\(([\d.]+)\)/.exec(String(transitionStyle(t('zoomIn'), 0.5).transform))![1]);
    const blurIn = Number(/scale\(([\d.]+)\)/.exec(String(transitionStyle(t('zoomBlurIn'), 0.5).transform))![1]);
    expect(blurIn).toBeLessThan(zoomIn); // 더 작은 데서 커진다 = 더 크게 움직인다
    expect(transitionBlurAxis(t('zoomBlurIn'))!.x).toBeGreaterThan(transitionBlurAxis(t('zoomIn'))!.x * 2);
    expect(transitionBlurAxis(t('whipZoom'))!.x).toBeGreaterThan(transitionBlurAxis(t('zoomBlurIn'))!.x);
  });

  it('punchIn 은 목표를 지나쳤다 되돌아온다 (1배 아래로 내려간 적이 있다)', () => {
    const scales = [0, 0.2, 0.4, 0.6, 0.8, 0.95, 1].map((v) =>
      Number(/scale\(([\d.-]+)\)/.exec(String(transitionStyle(t('punchIn'), v).transform))![1]),
    );
    expect(scales[0]).toBeCloseTo(1.35, 4);
    expect(Math.min(...scales)).toBeLessThan(1);   // 오버슈트
    expect(scales.at(-1)).toBe(1);
    expect(transitionBlurAxis(t('punchIn'))).toBeNull(); // 블러 없이 «딱» 꽂힌다
  });

  it('3D 플립은 축이 다르고 뒷면이 안 보인다', () => {
    expect(String(transitionStyle(t('flipHorizontal'), 0.5).transform)).toBe(
      'perspective(1200px) rotateY(45deg)',
    );
    expect(String(transitionStyle(t('flipVertical'), 0.5).transform)).toBe(
      'perspective(1200px) rotateX(45deg)',
    );
    expect(transitionStyle(t('flipHorizontal'), 0.5).backfaceVisibility).toBe('hidden');
  });

  it('rotateWipe 는 모서리를 축으로, spin 은 가운데에서 돈다', () => {
    expect(transitionStyle(t('rotateWipe'), 0.5).transformOrigin).toBe('0% 100%');
    expect(transitionStyle(t('spin'), 0.5).transformOrigin).toBeUndefined();
  });

  it('roll 은 이동 + 한 바퀴 회전', () => {
    expect(String(transitionStyle(t('roll'), 0.5).transform)).toBe('translateX(50%) rotate(180deg)');
  });
});

describe('충격 신규', () => {
  it('colorFlash 는 흰 플래시의 «색만 바꾼 것»이 아니다 — screen 덮개 + 채도/색상 회전', () => {
    const s = transitionStyle(t('colorFlash'), 0.5);
    expect(String(s.filter)).toBe('saturate(2.5) hue-rotate(30deg)');
    const o = transitionOverlays(t('colorFlash'), 0.5)[0]!;
    expect(o.style.mixBlendMode).toBe('screen');
    expect(String(o.style.background)).toContain('linear-gradient');
    // whiteFlash 는 단색 판이다
    expect(transitionOverlays(t('whiteFlash'), 0.5)[0]!.style.backgroundColor).toBe('#ffffff');
  });

  it('rgbSplit 은 방향성 블러가 아니라 «채널 분리» 필터를 쓴다', () => {
    expect(transitionBlurAxis(t('rgbSplit'))).toBeNull();
    expect(transitionSplitPx(t('rgbSplit'))).toBe(26);
    const blurs = activeTransitionBlurs(500, 5000, 'c1', 1, { type: t('rgbSplit'), duration: 1000 });
    expect(blurs).toHaveLength(1);
    expect(blurs[0]!.kind).toBe('rgbSplit');
    expect(blurs[0]!.x).toBeCloseTo(26, 6); // 전환 중앙에서 최대
    expect(blurs[0]!.y).toBe(0);
  });

  it('strobe 는 진행도만으로 켜짐/꺼짐이 정해진다 (같은 프레임이면 같은 그림)', () => {
    const a = transitionStyle(t('strobe'), 0.3);
    const b = transitionStyle(t('strobe'), 0.3);
    expect(a).toEqual(b);
    const opacities = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((v) => transitionStyle(t('strobe'), v).opacity);
    expect(new Set(opacities).size).toBe(2); // 두 값만 오간다
    expect(transitionStyle(t('strobe'), 1).opacity).toBe(1);
  });

  it('filmBurn 은 가운데가 타들어 가며 번지는 자리가 커진다', () => {
    const early = String(transitionOverlays(t('filmBurn'), 0.1)[0]!.style.background);
    const late = String(transitionOverlays(t('filmBurn'), 0.9)[0]!.style.background);
    const pct = (s: string) => Number(/rgba\(196,58,10,0\.55\) ([\d.]+)%/.exec(s)![1]);
    expect(pct(early)).toBeGreaterThan(pct(late)); // 진행할수록 좁아진다(=걷힌다)
  });
});

// ═══ 신규 효과의 수식 ═══════════════════════════════════════════════════════

describe('신규 효과 — 기본 색', () => {
  it('gamma 1 은 항등이라 스테이지를 아예 안 만든다', () => {
    expect(effectSvgStages([{ id: 'e', type: 'gamma', params: { gamma: 1 } }])).toEqual([]);
    const t2 = gammaTable(1);
    expect(t2[0]).toBe(0);
    expect(t2.at(-1)).toBe(1);
    expect(t2[16]).toBeCloseTo(0.5, 6);
  });

  it('gamma > 1 은 중간톤을 올리고, < 1 은 내린다', () => {
    expect(gammaTable(2)[16]!).toBeGreaterThan(0.5);
    expect(gammaTable(0.5)[16]!).toBeLessThan(0.5);
  });

  it('whiteBalance 6500K·tint 0 은 정확히 항등 (기본값으로 걸어도 색이 안 변한다)', () => {
    expect(effectSvgStages([{ id: 'e', type: 'whiteBalance', params: { kelvin: 6500, tint: 0 } }]))
      .toEqual([]);
    const m = whiteBalanceMatrix(6500, 0).split(' ').map(Number);
    expect(m[0]).toBeCloseTo(1, 4);
    expect(m[6]).toBeCloseTo(1, 4);
    expect(m[12]).toBeCloseTo(1, 4);
  });

  it('낮은 K 는 따뜻하게(R↑ B↓), 높은 K 는 차갑게 — 초록은 1 로 고정', () => {
    const warm = whiteBalanceMatrix(2800, 0).split(' ').map(Number);
    const cool = whiteBalanceMatrix(11000, 0).split(' ').map(Number);
    expect(warm[0]!).toBeGreaterThan(1);
    expect(warm[12]!).toBeLessThan(1);
    expect(cool[0]!).toBeLessThan(1);
    expect(cool[12]!).toBeGreaterThan(1);
    expect(warm[6]).toBeCloseTo(1, 6);
    expect(cool[6]).toBeCloseTo(1, 6);
  });
});

describe('신규 효과 — 룩', () => {
  it('강도 0 이면 아무 스테이지도 안 생긴다 (룩 5종 공통)', () => {
    for (const type of ['bleachBypass', 'crossProcess', 'tealOrange', 'duotone', 'faded'] as const) {
      expect(effectSvgStages([{ id: 'e', type, params: { amount: 0 } }]), type).toEqual([]);
    }
  });

  it('crossProcess 는 채널마다 «다른» 곡선이다 (색만 밀면 크로스 프로세스가 아니다)', () => {
    const st = effectSvgStages([{ id: 'e', type: 'crossProcess', params: { amount: 1 } }]);
    expect(st).toHaveLength(1);
    const d = st[0]!.data as { r: number[]; g: number[]; b: number[] };
    expect(JSON.stringify(d.r)).not.toBe(JSON.stringify(d.g));
    expect(JSON.stringify(d.g)).not.toBe(JSON.stringify(d.b));
  });

  it('tealOrange 는 그림자를 청록으로, 하이라이트를 주황으로 민다', () => {
    const d = effectSvgStages([{ id: 'e', type: 'tealOrange', params: { amount: 1 } }])[0]!
      .data as { r: number[]; b: number[] };
    // 어두운 쪽(인덱스 4): B 가 R 보다 위 → 청록
    expect(d.b[4]!).toBeGreaterThan(d.r[4]!);
    // 밝은 쪽(인덱스 28): R 이 B 보다 위 → 주황
    expect(d.r[28]!).toBeGreaterThan(d.b[28]!);
  });

  it('duotone 은 휘도를 두 색 사이로 편다 — feColorMatrix 한 줄로 «정확히» 된다', () => {
    const m = duotoneMatrix(220, 40, 1).split(' ').map(Number);
    const dark = hslRgb(220, 0.72, 0.24);
    // 검정(휘도 0)이 어두운 쪽 색으로 간다 = 오프셋 열이 곧 그 색
    expect(m[4]).toBeCloseTo(dark[0], 3);
    expect(m[9]).toBeCloseTo(dark[1], 3);
    expect(m[14]).toBeCloseTo(dark[2], 3);
    // 강도 0 이면 항등
    const id = duotoneMatrix(220, 40, 0).split(' ').map(Number);
    expect(id[0]).toBeCloseTo(1, 6);
    expect(id[4]).toBeCloseTo(0, 6);
  });
});

describe('신규 효과 — 흐림·질감·왜곡·스타일', () => {
  it('dirBlur 는 전환이 쓰던 스테이지를 그대로 재사용한다 (가로/세로 따로)', () => {
    const st = effectSvgStages([{ id: 'e', type: 'dirBlur', params: { x: 30, y: 0 } }]);
    expect(st).toEqual([{ kind: 'dirBlur', data: { x: 30, y: 0 } }]);
    expect(effectSvgStages([{ id: 'e', type: 'dirBlur', params: { x: 0, y: 0 } }])).toEqual([]);
  });

  it('clarity(로컬 대비)와 softFocus 는 같은 «흐린 사본»을 다르게 쓴다', () => {
    const c = effectSvgStages([{ id: 'e', type: 'clarity', params: { amount: 0.5, radius: 20 } }])[0]!;
    const s = effectSvgStages([{ id: 'e', type: 'softFocus', params: { amount: 0.5, radius: 20 } }])[0]!;
    expect((c.data as { mode: string }).mode).toBe('unsharp');
    expect((s.data as { mode: string }).mode).toBe('screen');
  });

  it('halation 은 색이 있는 번짐, bloom 은 흰 번짐 — 임계도 다르다', () => {
    const h = effectSvgStages([{ id: 'e', type: 'halation', params: { amount: 0.6, radius: 20, hue: 12 } }])[0]!
      .data as { tint: number[]; threshold: number };
    const b = effectSvgStages([{ id: 'e', type: 'bloom', params: { amount: 0.6, radius: 40, threshold: 0.5 } }])[0]!
      .data as { tint: number[]; threshold: number };
    expect(h.tint[0]!).toBeGreaterThan(h.tint[2]!); // 붉다
    expect(b.tint).toEqual([1, 1, 1]);
    expect(h.threshold).toBeGreaterThan(b.threshold);
  });

  it('tiltShift 마스크는 «가운데가 투명»이다 (backdrop-filter 는 불투명한 곳에만 걸린다)', () => {
    const css = tiltShiftMaskCss(0.4, 0.5);
    expect(css).toContain('#fff 0%');
    expect(css).toContain('rgba(0,0,0,0) 30%');
    expect(css).toContain('rgba(0,0,0,0) 70%');
    expect(css).toContain('#fff 100%');
  });

  it('filmScratch 는 프레임마다 자리가 바뀌지만 같은 프레임이면 항상 같다', () => {
    const a = filmScratchLines(30, 5, 0.6);
    const b = filmScratchLines(30, 5, 0.6);
    expect(a).toEqual(b);
    const frames = [0, 12, 30, 61, 90].map((f) => JSON.stringify(filmScratchLines(f, 5, 0.6)));
    expect(new Set(frames).size).toBeGreaterThan(1);
    for (const l of a) {
      expect(l.leftPct).toBeGreaterThanOrEqual(0);
      expect(l.leftPct).toBeLessThanOrEqual(100);
    }
  });

  it('filmScratch 는 **어느 프레임에서도 최소 한 줄**이 나온다', () => {
    // 처음엔 줄마다 확률로 뽑았더니 프레임 15 에서 4줄이 전부 빠져 원본과 똑같은 그림이 나왔다
    // (media/w8-f16 컨택트 시트에서 발견). 「걸었는데 아무것도 안 보인다」를 막는 검사다.
    for (let f = 0; f < 300; f++) {
      for (const count of [1, 4, 12]) {
        expect(filmScratchLines(f, count, 0.5).length, `frame ${f} count ${count}`)
          .toBeGreaterThanOrEqual(1);
      }
    }
    // 그렇다고 항상 다 나오지도 않는다 — «가끔 튀는» 맛이 있어야 필름 같다
    const counts = new Set<number>();
    for (let f = 0; f < 200; f++) counts.add(filmScratchLines(f, 6, 0.5).length);
    expect(counts.size).toBeGreaterThan(1);
  });

  it('pixelate 는 셀 크기의 절반을 dilate 반경으로 쓴다 (칸이 정확히 메워진다)', () => {
    expect(pixelateSpec(16)).toEqual({ cell: 16, radius: 8 });
    expect(pixelateSpec(3)).toEqual({ cell: 3, radius: 2 }); // 반올림해도 칸을 덮는다
    expect(pixelateSpec(1)).toEqual({ cell: 2, radius: 1 }); // 하한
  });

  it('mosaic 은 pixelate + 격자선 — 검열 모자이크와 다른 그림이다', () => {
    const px = { id: 'a', type: 'pixelate' as EffectType, params: { size: 28 } };
    const mo = { id: 'b', type: 'mosaic' as EffectType, params: { size: 28, grout: 0.2 } };
    expect(effectSvgStages([px])).toEqual(effectSvgStages([mo])); // 같은 픽셀화 체인
    expect(effectOverlays([px])).toEqual([]);
    expect(effectOverlays([mo])).toEqual([{ kind: 'mosaicGrout', params: { size: 28, grout: 0.2 } }]);
    expect(mosaicGroutCss(28, 0.2)).toContain('repeating-linear-gradient');
  });

  it('posterize 단계 수만큼 값이 나오고 양 끝이 0·1 이다', () => {
    expect(posterizeLevels(2)).toEqual([0, 1]);
    expect(posterizeLevels(5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(posterizeLevels(999)).toHaveLength(16); // 상한
    expect(posterizeLevels(0)).toHaveLength(2);    // 하한
  });

  it('threshold 는 흑백으로 만든 뒤 잘라야 «색이 남지 않는다»', () => {
    const st = effectSvgStages([{ id: 'e', type: 'threshold', params: { level: 0.5 } }]);
    expect(st.map((s) => s.kind)).toEqual(['colorMatrix', 'linearTransfer']);
    const d = st[1]!.data as { slope: number; intercept: number };
    expect(d.slope).toBe(255);
    expect(d.intercept).toBeCloseTo(-127, 0); // 0.5 에서 잘린다
  });

  it('emboss 는 feConvolveMatrix 의 bias 를 안 쓴다 (브라우저마다 구현이 갈린다)', () => {
    const st = effectSvgStages([{ id: 'e', type: 'emboss', params: { amount: 1, px: 2 } }]);
    const nodes = buildFilterNodes(st.map((s, i) => ({ kind: s.kind, id: `s${i}`, data: s.data })));
    const types = nodes.map((n) => (n as { type: string }).type);
    expect(types).toContain('feOffset');
    expect(types).not.toContain('feConvolveMatrix');
    expect(JSON.stringify(nodes.map((n) => (n as { props: unknown }).props))).not.toContain('bias');
  });

  it('thresholdTransfer 는 1 근처에서도 안 터진다 (0.95 로 막는다)', () => {
    const a = thresholdTransfer(1);
    expect(Number.isFinite(a.slope)).toBe(true);
    expect(a.slope).toBe(20);
    expect(thresholdTransfer(0).slope).toBe(1);
  });

  it('박스 밖으로 번지는 스테이지는 필터 영역을 넓힌다', () => {
    for (const type of ['bloom', 'clarity', 'dirBlur', 'wave'] as const) {
      const params = Object.fromEntries(
        EFFECT_CATALOG.find((d) => d.id === type)!.params.map((p) => [p.key, p.max]),
      );
      expect(needsWideFilterRegion(effectSvgStages([{ id: 'e', type, params }])), type).toBe(true);
    }
    expect(needsWideFilterRegion(effectSvgStages([{ id: 'e', type: 'posterize', params: { levels: 4 } }])))
      .toBe(false);
  });

  it('신규 SVG 스테이지가 전부 <filter> 노드를 만든다 (buildFilterNodes 에 빠진 kind 가 없다)', () => {
    const kinds = new Set<string>();
    for (const d of EFFECT_CATALOG) {
      if (d.impl === 'webgl') continue;
      const params = Object.fromEntries(d.params.map((p) => [p.key, p.def === p.max ? p.min : p.max]));
      for (const s of effectSvgStages([{ id: 'e', type: d.id as EffectType, params }])) kinds.add(s.kind);
    }
    for (const kind of kinds) {
      const nodes = buildFilterNodes([{ kind, id: 's0', data: dataFor(kind) }]);
      expect(nodes.length, `${kind} 가 노드를 안 만든다`).toBeGreaterThan(0);
    }
    // 신규 kind 가 실제로 쓰이고 있는지도 같이 본다
    for (const k of ['bloom', 'blurMix', 'pixelate', 'displace', 'edge', 'emboss', 'discrete', 'linearTransfer', 'dirBlur']) {
      expect(kinds.has(k), `${k} 스테이지를 쓰는 효과가 없다`).toBe(true);
    }
  });
});

/** buildFilterNodes 에 넘길 최소 데이터 (kind 별). */
function dataFor(kind: string): unknown {
  switch (kind) {
    case 'curves': return { r: [0, 1], g: [0, 1], b: [0, 1] };
    case 'colorMatrix': return { values: '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0' };
    case 'sharpen': return { amount: 1 };
    case 'glow': return { amount: 0.5, radius: 10 };
    case 'chromaShift': return { px: 4 };
    case 'dirBlur': return { x: 4, y: 0 };
    case 'discrete': return { values: [0, 0.5, 1] };
    case 'linearTransfer': return { slope: 2, intercept: -0.5 };
    case 'bloom': return { amount: 0.5, radius: 20, threshold: 0.5, tint: [1, 1, 1] };
    case 'blurMix': return { amount: 0.5, radius: 20, mode: 'unsharp' };
    case 'pixelate': return { cell: 16, radius: 8 };
    case 'displace': return { scale: 10, freq: 0.01 };
    case 'edge': return { amount: 1 };
    case 'emboss': return { amount: 1, px: 2 };
    default: return {};
  }
}
