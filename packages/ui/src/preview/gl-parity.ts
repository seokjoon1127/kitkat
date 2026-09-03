// 프리뷰 v2 — **최종 렌더와 얼마나 다른가**를 숫자로 들고 있는 표 (W8 F15).
//
// 예전 배지는 「못 그립니다」였다. 이제는 전부 그리므로 남은 정직은 「이만큼 다릅니다」다.
// 여기 값들은 **추정이 아니라 실측**이다 — `packages/ui/test/preview-parity.mjs` 가
// 헤드리스 Chrome(SwiftShader)에서 렌더러 DOM 과 WebGL 캔버스를 픽셀로 빼서 잰 값이고,
// 표 아래 주석에 잰 조건을 적어 뒀다. 효과를 고치면 그 스크립트를 다시 돌려 값을 갱신한다.

import type { VisualLayout } from '@kitkat/renderer/layout';

/** 대조 테스트가 쓰는 임계 — 채널당 평균 3, 최대 12. */
export const PARITY_THRESHOLD = { mean: 3, max: 12 } as const;

export type ParityDelta = {
  label: string;
  /** 채널당 평균 절대 차이 (0..255) */
  mean: number;
  /** 채널당 최대 절대 차이 (0..255) */
  max: number;
  /** 임계를 못 맞춘 이유 (맞췄으면 없음) */
  why?: string;
};

/**
 * 2026-09-02 실측. 480x270, 소스는 그라디언트+하드엣지+하이라이트 한 장,
 * 기준은 렌더러가 만든 DOM(SVG `<filter>` · CSS mask · 오버레이 div)을 Chrome 이 그린 것.
 */
export const PARITY_MEASURED: Record<string, ParityDelta> = {
  mask: { label: '마스크', mean: 0.04, max: 1 },
  // ── W8 F17 (2026-09-03 실측) — 자유 곡선(펜)·여러 장 겹침. 셰이더가 베지어를 직접 그리지 않고
  //    Canvas2D(Path2D · blur)로 구운 알파 한 장을 곱한다 — 렌더러와 **같은 Chromium 래스터라이저**다.
  //    페더 있는 자유 곡선 · 2장 add/subtract/intersect · 3장 접힘 · dKeys 중간 프레임에서
  //    평균 0.00~0.09 · 최대 2 (13개 케이스).
  maskPath: { label: '자유 곡선·여러 장 마스크', mean: 0.09, max: 2 },
  // 페더가 거의 없는(σ < 1px) 자유 곡선만 여기 온다. **곡선 윤곽 1px 줄에서만** 갈린다 —
  // DOM 경로 AA 와 Canvas2D 경로 AA 가 세로로 약 0.1px 어긋나기 때문이다(직선 변은 안 갈린다:
  // 가로 변 기준자 케이스가 평균 0.00 · 최대 1). 화면 전체 평균은 0.06, 12 를 넘는 픽셀은 0.24%.
  maskPathHard: {
    label: '자유 곡선 마스크(페더 0)',
    mean: 0.06,
    max: 57,
    why: '곡선 윤곽 1px 줄이 0.1px 어긋납니다 (안쪽은 같습니다)',
  },
  sharpen: { label: '샤픈', mean: 0.1, max: 1 },
  glow: { label: '글로우', mean: 0.14, max: 2 },
  chromaShift: { label: '색수차', mean: 0, max: 0 },
  grain: {
    label: '그레인',
    mean: 3.99,
    max: 28,
    // feTurbulence(펄린 노이즈)를 셰이더 해시 노이즈로 바꿨다. **무늬가 다르다** —
    // 픽셀 대조는 뜻이 없고, 세기는 맞춰 놨다(가로 이웃 차이 평균 기준 5.39 vs 5.20).
    why: '노이즈 무늬가 달라 픽셀은 다르지만 세기는 같습니다',
  },
  scanlines: { label: '스캔라인', mean: 0.07, max: 1 },
  lightLeak: { label: '라이트리크', mean: 0.14, max: 1 },
  glitch: { label: '글리치 덮개', mean: 0.11, max: 2 },
  blur: { label: '블러', mean: 0.05, max: 2 },
  // ── W8 #8 (2026-09-03 실측) — 기준은 Remotion `createEffect` 체인(`Internals.runEffectChain`)이
  //    같은 GLSL 로 그린 캔버스. 미리보기(gl-passes)도 같은 문자열을 컴파일하므로 대부분 비트 일치다.
  vibrance: { label: '생동감(바이브런스)', mean: 0, max: 1 },
  bokeh: { label: '보케', mean: 0, max: 1 },
  radialBlur: { label: '방사형 블러', mean: 0, max: 1 },
  mirror: { label: '거울(반사)', mean: 0, max: 0 },
  kaleidoscope: { label: '만화경', mean: 0, max: 1 },
  halftone: { label: '망점(하프톤)', mean: 0, max: 2 },
};

/** 임계를 못 맞춘 항목들 (배지가 아니라 **보고**를 위한 것). */
export function parityFailures(): string[] {
  return Object.entries(PARITY_MEASURED)
    .filter(([, d]) => d.mean > PARITY_THRESHOLD.mean || d.max > PARITY_THRESHOLD.max)
    .map(([k]) => k);
}

/** 이 클립에서 «셰이더가 그린» 효과들의 표 키. */
export function parityKeys(layout: VisualLayout, hasGlitchOverlay = false): string[] {
  const keys: string[] = [];
  const add = (k: string): void => {
    if (!keys.includes(k)) keys.push(k);
  };
  const masks = layout.maskLayers ?? [];
  // 자유 곡선·여러 장은 구운 알파 텍스처 경로다 — 램프 3종과 따로 잰다.
  // 페더 0 인 자유 곡선(=하드 엣지)은 브라우저 두 래스터라이저의 AA 가 갈려서 또 따로 잰다.
  const paths = masks.filter((m) => m.shape === 'path');
  // σ = feather·min(상자변)/2 (렌더러 maskSigma). 1px 아래면 사실상 하드 엣지다.
  const sigma = (m: (typeof masks)[number]): number =>
    (Math.min(1, Math.max(0, m.feather)) * Math.min(layout.box.width, layout.box.height)) / 2;
  if (paths.some((m) => sigma(m) < 1)) add('maskPathHard');
  else if (masks.length > 1 || paths.length > 0) add('maskPath');
  else if (masks.length > 0) add('mask');
  for (const o of layout.overlays) {
    if (o.kind === 'grain' || o.kind === 'scanlines' || o.kind === 'lightLeak') add(o.kind);
  }
  for (const s of layout.effectFilters) {
    if (s.kind === 'sharpen' || s.kind === 'glow' || s.kind === 'chromaShift') add(s.kind);
  }
  // W8 #8 — WebGL 6종 (렌더는 Remotion createEffect, 미리보기는 gl-passes — 같은 GLSL)
  for (const g of layout.glStages ?? []) add(g.kind);
  if (/(^|\s)blur\(/.test(layout.cssFilter)) add('blur');
  if (hasGlitchOverlay) add('glitch');
  return keys;
}

/**
 * 배지 문구. 「못 그림」이 아니라 **얼마나 다른가**를 말한다.
 * 차이가 1 이하면(=눈에 안 보이면) 아무 말도 안 한다 — 배지가 늘 떠 있으면 아무도 안 본다.
 */
export function parityNote(keys: string[]): string | null {
  const rows = keys.map((k) => PARITY_MEASURED[k]).filter((d): d is ParityDelta => !!d);
  if (rows.length === 0) return null;
  const worst = rows.reduce((a, b) => (b.max > a.max ? b : a));
  if (worst.max <= 1) return null;
  const names = rows.filter((d) => d.max > 1).map((d) => d.label).join('·');
  const tail = worst.why ? ` — ${worst.why}` : '';
  return `${names}: 최종 렌더와 최대 ${worst.max} 다릅니다${tail}`;
}
