// ═══ 전환·효과 카탈로그 (W8 F16) ═══════════════════════════════════════════
//
// **왜 이 파일이 있나.** 전환·효과를 하나 늘리려면 예전에는 파일 다섯 곳을 손으로 고쳐야 했다:
// schema 의 상수 배열 → 렌더러 구현 → UI 드롭다운 라벨 → 파라미터 슬라이더 메타 → 테스트.
// 다섯 군데 중 하나만 빠뜨려도 «목록에는 있는데 안 그려지는» 항목이 생긴다. 그래서 개수가
// 안 늘었다. 이제 **정의는 여기 한 곳**이고, `TRANSITION_TYPES`·`EFFECT_TYPES` 와 UI 라벨·
// 파라미터 메타는 전부 이 배열에서 파생된다. 새 항목을 넣을 때 손으로 고칠 곳은 두 곳이다 —
// 이 파일과 렌더러 구현. **둘이 어긋나면 테스트가 실패한다**(catalog.test.ts / catalog-impl.test.ts).
//
// **배열 순서를 바꾸지 마라.** `TRANSITION_TYPES`·`EFFECT_TYPES` 가 이 순서 그대로다.
// v1·W5·W8 앞머리(전환 23 · 효과 20)는 한 칸도 움직이면 안 되고, 새 항목은 **뒤에 붙인다.**
// 화면에 보여 줄 때의 «갈래별 묶음»은 배열 순서가 아니라 `group` 으로 만든다.

// ── 전환 ──────────────────────────────────────────────────────────────────

export const TRANSITION_GROUPS = ['basic', 'slide', 'wipe', 'zoom', 'rotate', 'impact', 'whip'] as const;
export type TransitionGroup = (typeof TRANSITION_GROUPS)[number];

export const TRANSITION_GROUP_LABELS: Record<TransitionGroup, string> = {
  basic: '기본',
  slide: '슬라이드·눌림',
  wipe: '와이프',
  zoom: '줌',
  rotate: '회전·왜곡',
  impact: '충격·플래시',
  whip: '휩팬',
};

/**
 * 전환 하나의 정의.
 * - `needs` = 이 전환이 **렌더러의 어떤 선행 기능에 기대는가**. 계획 16 의 타입은
 *   `('dirBlur'|'webgl')[]` 였는데, 전환 SVG 필터 자리에 방향성 블러 말고 RGB 분리도
 *   들어가게 돼서 `'rgbSplit'` 을 하나 늘렸다. 목록에만 있고 필터가 없으면 테스트가 잡는다.
 */
export type TransitionDef = {
  id: string;
  name: string;
  group: TransitionGroup;
  needs?: readonly ('dirBlur' | 'rgbSplit' | 'webgl')[];
};

/**
 * **계획 16 이 이름을 적었는데 «타입»으로 넣지 않은 것 — 조용히 뺀 게 아니라 여기 적어 둔다.**
 *
 * | 계획의 이름 | 왜 타입을 안 만들었나 |
 * |---|---|
 * | push 4방향 | 우리 모델에서 전환은 **클립 하나**에 걸린다. 「뒤 클립이 밀어낸다」는 앞 클립의 `transitionOut` 과 뒤 클립의 `transitionIn` 에 **같은 slide 를 거는 사용법**이지 새 그림이 아니다. `pushLeft` 를 만들면 `slideLeft` 와 **픽셀이 같다** — 「색만 바꾼 복제본 금지」에 정면으로 걸린다. |
 * | cover 4방향 | 위와 같다. cover = `transitionIn` 에만 slide 를 건 상태. |
 * | reveal 4방향 | 위와 같다. reveal = `transitionOut` 에만 slide 를 건 상태. |
 * | iris(원형 조리개) | `circleOpen`·`circleClose` 가 이미 원형 조리개다. 이름만 다른 같은 그림을 하나 더 넣지 않았다. |
 *
 * 그래서 슬라이드 갈래는 push/cover/reveal 대신 **대각 슬라이드 4 + 스퀴즈 4**로 채웠다
 * (둘 다 기존 slide 와 픽셀이 다르다). 와이프 갈래는 **대각 와이프 4 + 시계 와이프**로 채웠다.
 */
export const TRANSITION_OMISSIONS = [
  { name: 'push 4방향', reason: 'slide 를 양쪽 클립에 거는 «사용법»이라 새 타입이면 slide 와 픽셀이 같다' },
  { name: 'cover 4방향', reason: 'slide 를 transitionIn 에만 건 상태 — 같은 이유' },
  { name: 'reveal 4방향', reason: 'slide 를 transitionOut 에만 건 상태 — 같은 이유' },
  { name: 'iris(원형 조리개)', reason: 'circleOpen·circleClose 가 이미 원형 조리개다' },
] as const;

const TRANSITION_CATALOG_RAW = [
  // ── v1 8종 (순서 고정) ──
  { id: 'fade', name: '페이드', group: 'basic' },
  { id: 'slideLeft', name: '왼쪽 슬라이드', group: 'slide', needs: ['dirBlur'] },
  { id: 'slideRight', name: '오른쪽 슬라이드', group: 'slide', needs: ['dirBlur'] },
  { id: 'slideUp', name: '위로 슬라이드', group: 'slide', needs: ['dirBlur'] },
  { id: 'slideDown', name: '아래로 슬라이드', group: 'slide', needs: ['dirBlur'] },
  { id: 'wipeLeft', name: '왼쪽 와이프', group: 'wipe' },
  { id: 'zoomIn', name: '줌 인', group: 'zoom', needs: ['dirBlur'] },
  { id: 'zoomOut', name: '줌 아웃', group: 'zoom', needs: ['dirBlur'] },
  // ── W5 12종 (순서 고정) ──
  { id: 'wipeRight', name: '오른쪽 와이프', group: 'wipe' },
  { id: 'wipeUp', name: '위로 와이프', group: 'wipe' },
  { id: 'wipeDown', name: '아래로 와이프', group: 'wipe' },
  { id: 'circleOpen', name: '원형 열기', group: 'wipe' },
  { id: 'circleClose', name: '원형 닫기', group: 'wipe' },
  { id: 'blurFade', name: '블러 페이드', group: 'basic' },
  { id: 'whiteFlash', name: '화이트 플래시', group: 'impact' },
  { id: 'blackFlash', name: '블랙 플래시', group: 'impact' },
  { id: 'spin', name: '회전', group: 'rotate' },
  { id: 'bounce', name: '바운스', group: 'impact' },
  { id: 'shake', name: '흔들기', group: 'impact' },
  { id: 'glitch', name: '글리치', group: 'impact' },
  // ── W8 F3-C 휩팬 3종 (순서 고정) ──
  { id: 'whipPanLeft', name: '휩팬 (왼쪽)', group: 'whip', needs: ['dirBlur'] },
  { id: 'whipPanRight', name: '휩팬 (오른쪽)', group: 'whip', needs: ['dirBlur'] },
  { id: 'whipPanUp', name: '휩팬 (위)', group: 'whip', needs: ['dirBlur'] },

  // ═══ W8 F16 신규 28종 — 여기부터 뒤에 붙인 것 ═══
  // 기본 +3
  { id: 'dissolve', name: '디졸브 (점)', group: 'basic' },
  { id: 'dipToBlack', name: '검정 디졸브', group: 'basic' },
  { id: 'dipToWhite', name: '흰색 디졸브', group: 'basic' },
  // 슬라이드 +8 (대각 4 + 스퀴즈 4)
  { id: 'slideUpLeft', name: '대각 슬라이드 (↖)', group: 'slide', needs: ['dirBlur'] },
  { id: 'slideUpRight', name: '대각 슬라이드 (↗)', group: 'slide', needs: ['dirBlur'] },
  { id: 'slideDownLeft', name: '대각 슬라이드 (↙)', group: 'slide', needs: ['dirBlur'] },
  { id: 'slideDownRight', name: '대각 슬라이드 (↘)', group: 'slide', needs: ['dirBlur'] },
  { id: 'squeezeLeft', name: '왼쪽으로 눌림', group: 'slide', needs: ['dirBlur'] },
  { id: 'squeezeRight', name: '오른쪽으로 눌림', group: 'slide', needs: ['dirBlur'] },
  { id: 'squeezeUp', name: '위로 눌림', group: 'slide', needs: ['dirBlur'] },
  { id: 'squeezeDown', name: '아래로 눌림', group: 'slide', needs: ['dirBlur'] },
  // 와이프 +5 (대각 4 + 시계)
  { id: 'wipeDiagTL', name: '대각 와이프 (↖에서)', group: 'wipe' },
  { id: 'wipeDiagTR', name: '대각 와이프 (↗에서)', group: 'wipe' },
  { id: 'wipeDiagBL', name: '대각 와이프 (↙에서)', group: 'wipe' },
  { id: 'wipeDiagBR', name: '대각 와이프 (↘에서)', group: 'wipe' },
  { id: 'clockWipe', name: '시계 와이프', group: 'wipe' },
  // 줌 +4
  { id: 'zoomBlurIn', name: '줌 블러 인', group: 'zoom', needs: ['dirBlur'] },
  { id: 'zoomBlurOut', name: '줌 블러 아웃', group: 'zoom', needs: ['dirBlur'] },
  { id: 'whipZoom', name: '휩 줌', group: 'zoom', needs: ['dirBlur'] },
  { id: 'punchIn', name: '펀치 인', group: 'zoom' },
  // 회전 +4
  { id: 'rotateWipe', name: '문 열리듯 회전', group: 'rotate' },
  { id: 'flipHorizontal', name: '3D 플립 (가로)', group: 'rotate' },
  { id: 'flipVertical', name: '3D 플립 (세로)', group: 'rotate' },
  { id: 'roll', name: '굴러 들어오기', group: 'rotate', needs: ['dirBlur'] },
  // 충격 +4
  { id: 'colorFlash', name: '컬러 플래시', group: 'impact' },
  { id: 'rgbSplit', name: 'RGB 분리', group: 'impact', needs: ['rgbSplit'] },
  { id: 'filmBurn', name: '필름 번', group: 'impact' },
  { id: 'strobe', name: '스트로브', group: 'impact' },
] as const satisfies readonly TransitionDef[];

export const TRANSITION_CATALOG: readonly TransitionDef[] = TRANSITION_CATALOG_RAW;

export type TransitionType = (typeof TRANSITION_CATALOG_RAW)[number]['id'];

/** 하위호환: v1·W5·W8 앞머리 23종의 순서가 그대로다. 새 전환은 항상 뒤에 붙는다. */
export const TRANSITION_TYPES: readonly TransitionType[] = TRANSITION_CATALOG_RAW.map((d) => d.id);

const TRANSITION_BY_ID = new Map<string, TransitionDef>(TRANSITION_CATALOG.map((d) => [d.id, d]));

export function transitionDef(id: string): TransitionDef | undefined {
  return TRANSITION_BY_ID.get(id);
}

// ── 효과 ──────────────────────────────────────────────────────────────────

export const EFFECT_GROUPS = ['color', 'look', 'focus', 'texture', 'distort', 'style'] as const;
export type EffectGroup = (typeof EFFECT_GROUPS)[number];

export const EFFECT_GROUP_LABELS: Record<EffectGroup, string> = {
  color: '기본 색',
  look: '색감·룩',
  focus: '흐림·선명',
  texture: '질감',
  distort: '왜곡',
  style: '스타일',
};

/**
 * 효과 파라미터 한 개. `step` 은 슬라이더 눈금 — 없으면 UI 가 (max-min)/100 으로 잡는다.
 * (계획 16 의 타입에는 `step` 이 없었는데, 없으면 「줄 수 100..2000」 같은 슬라이더가
 * 0.01 눈금으로 나와서 못 쓴다.)
 */
export type EffectParamSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
  step?: number;
};

/**
 * 효과 하나의 정의.
 * - `impl` = **무엇으로 그리는가.** css(CSS filter) / svg(SVG <filter> 스테이지) /
 *   overlay(미디어 위에 얹는 레이어) / webgl(셰이더 — 렌더는 Remotion `createEffect`,
 *   미리보기는 gl-passes. W8 #8 부터 6종 전부 «구현됨»이다).
 * - `pending` = 아직 안 그려지는 항목이 **왜 안 되는지.** 이 값이 있으면 UI 가 드롭다운에서
 *   고를 수 없게 막고 `/api/capabilities` 의 `pendingEffects` 에 실린다 — 「고를 수 있는데
 *   안 그려지는 것」이 제일 나쁘다. **지금은 하나도 없다**(빈 배열이어야 테스트가 통과한다).
 *   목록에서 빼는 대신 이유를 적는 자리로 남겨 둔다.
 */
export type EffectDef = {
  id: string;
  name: string;
  group: EffectGroup;
  impl: 'css' | 'svg' | 'overlay' | 'webgl';
  params: readonly EffectParamSpec[];
  pending?: string;
};

const amount02 = { key: 'amount', label: '강도', min: 0, max: 2, def: 1, step: 0.01 } as const;
const amount01 = { key: 'amount', label: '강도', min: 0, max: 1, def: 1, step: 0.01 } as const;
/** -1..1 양방향 강도 (기본 0) */
const bipolar0 = { key: 'amount', label: '강도', min: -1, max: 1, def: 0, step: 0.01 } as const;
/** 0..1 강도, 기본 «걸면 보이는» 값 — 신규 룩 효과 공용 */
const strength = (def: number) => ({ key: 'amount', label: '강도', min: 0, max: 1, def, step: 0.01 }) as const;

const EFFECT_CATALOG_RAW = [
  // ── v1 9종 (순서 고정) ──
  { id: 'brightness', name: '밝기', group: 'color', impl: 'css', params: [amount02] },
  { id: 'contrast', name: '대비', group: 'color', impl: 'css', params: [amount02] },
  { id: 'saturation', name: '채도', group: 'color', impl: 'css', params: [amount02] },
  { id: 'hue', name: '색조', group: 'color', impl: 'css',
    params: [{ key: 'deg', label: '각도(°)', min: -180, max: 180, def: 0, step: 1 }] },
  { id: 'blur', name: '흐림', group: 'focus', impl: 'css',
    params: [{ key: 'px', label: '흐림(px)', min: 0, max: 50, def: 8, step: 1 }] },
  { id: 'vignette', name: '비네트', group: 'texture', impl: 'overlay',
    params: [{ key: 'amount', label: '강도', min: 0, max: 1, def: 0.5, step: 0.01 }] },
  { id: 'grayscale', name: '흑백', group: 'look', impl: 'css', params: [amount01] },
  { id: 'sepia', name: '세피아', group: 'look', impl: 'css', params: [amount01] },
  { id: 'invert', name: '반전', group: 'look', impl: 'css', params: [amount01] },
  // ── W5 11종 (순서 고정) ──
  { id: 'temperature', name: '색온도', group: 'look', impl: 'svg',
    params: [{ ...bipolar0, label: '따뜻함' }] },
  { id: 'tint', name: '틴트', group: 'look', impl: 'svg', params: [{ ...bipolar0, label: '자홍끼' }] },
  { id: 'exposure', name: '노출', group: 'color', impl: 'css',
    params: [{ key: 'stops', label: '노출(EV)', min: -2, max: 2, def: 0, step: 0.05 }] },
  { id: 'highlights', name: '밝은 영역', group: 'color', impl: 'svg', params: [bipolar0] },
  { id: 'shadows', name: '어두운 영역', group: 'color', impl: 'svg', params: [bipolar0] },
  { id: 'sharpen', name: '선명하게', group: 'focus', impl: 'svg',
    params: [{ key: 'amount', label: '강도', min: 0, max: 2, def: 0, step: 0.01 }] },
  { id: 'glow', name: '글로우', group: 'focus', impl: 'svg', params: [
    { key: 'amount', label: '강도', min: 0, max: 1, def: 0.5, step: 0.01 },
    { key: 'radius', label: '반경(px)', min: 0, max: 40, def: 16, step: 1 },
  ] },
  { id: 'grain', name: '필름 그레인', group: 'texture', impl: 'overlay',
    params: [{ key: 'amount', label: '강도', min: 0, max: 1, def: 0.3, step: 0.01 }] },
  { id: 'scanlines', name: '스캔라인', group: 'texture', impl: 'overlay', params: [
    { key: 'amount', label: '강도', min: 0, max: 1, def: 0.3, step: 0.01 },
    { key: 'lines', label: '줄 수', min: 100, max: 2000, def: 600, step: 10 },
  ] },
  // 계획 16 은 chromaAberration 으로 «개명» 하라고 했는데 **id 는 안 바꿨다** —
  // 저장된 문서의 `type: 'chromaShift'` 가 전부 깨진다. 뜻은 이미 색수차(chromatic aberration)다.
  { id: 'chromaShift', name: '색수차', group: 'distort', impl: 'svg',
    params: [{ key: 'px', label: '이동(px)', min: 0, max: 20, def: 4, step: 0.5 }] },
  { id: 'lightLeak', name: '빛 번짐', group: 'texture', impl: 'overlay', params: [
    { key: 'amount', label: '강도', min: 0, max: 1, def: 0.4, step: 0.01 },
    { key: 'hue', label: '색상(°)', min: 0, max: 360, def: 30, step: 1 },
  ] },

  // ═══ W8 F16 신규 30종 — 여기부터 뒤에 붙인 것 ═══

  // ── 기본 색 +3 ──
  { id: 'gamma', name: '감마', group: 'color', impl: 'svg',
    params: [{ key: 'gamma', label: '감마', min: 0.2, max: 3, def: 1, step: 0.01 }] },
  { id: 'whiteBalance', name: '화이트 밸런스', group: 'color', impl: 'svg', params: [
    { key: 'kelvin', label: '색온도(K)', min: 2000, max: 12000, def: 6500, step: 50 },
    { key: 'tint', label: '자홍끼', min: -1, max: 1, def: 0, step: 0.01 },
  ] },
  // WebGL(#8) — 채도가 «낮은 색만» 골라 올린다. feColorMatrix 로는 픽셀마다 조건을 못 써서 셰이더다.
  { id: 'vibrance', name: '생동감(바이브런스)', group: 'color', impl: 'webgl',
    params: [{ key: 'amount', label: '강도', min: -1, max: 1, def: 0.3, step: 0.01 }] },

  // ── 색감·룩 +5 ──
  { id: 'bleachBypass', name: '블리치 바이패스', group: 'look', impl: 'svg', params: [strength(0.6)] },
  { id: 'crossProcess', name: '크로스 프로세스', group: 'look', impl: 'svg', params: [strength(0.6)] },
  { id: 'tealOrange', name: '틸 & 오렌지', group: 'look', impl: 'svg', params: [strength(0.6)] },
  { id: 'duotone', name: '듀오톤', group: 'look', impl: 'svg', params: [
    strength(0.8),
    { key: 'hueA', label: '어두운 쪽 색(°)', min: 0, max: 360, def: 220, step: 1 },
    { key: 'hueB', label: '밝은 쪽 색(°)', min: 0, max: 360, def: 40, step: 1 },
  ] },
  { id: 'faded', name: '바랜 느낌', group: 'look', impl: 'svg', params: [strength(0.5)] },

  // ── 흐림·선명 +6 ──
  { id: 'dirBlur', name: '방향성 블러', group: 'focus', impl: 'svg', params: [
    { key: 'x', label: '가로 번짐(px)', min: 0, max: 60, def: 20, step: 1 },
    { key: 'y', label: '세로 번짐(px)', min: 0, max: 60, def: 0, step: 1 },
  ] },
  { id: 'tiltShift', name: '틸트 시프트', group: 'focus', impl: 'overlay', params: [
    { key: 'px', label: '흐림(px)', min: 0, max: 40, def: 14, step: 1 },
    { key: 'band', label: '선명한 띠 높이', min: 0.05, max: 1, def: 0.35, step: 0.01 },
    { key: 'center', label: '띠 위치', min: 0, max: 1, def: 0.5, step: 0.01 },
  ] },
  { id: 'clarity', name: '선명도(로컬 대비)', group: 'focus', impl: 'svg', params: [
    strength(0.5),
    { key: 'radius', label: '반경(px)', min: 2, max: 60, def: 20, step: 1 },
  ] },
  { id: 'softFocus', name: '소프트 포커스', group: 'focus', impl: 'svg', params: [
    strength(0.5),
    { key: 'radius', label: '반경(px)', min: 2, max: 60, def: 20, step: 1 },
  ] },
  // WebGL(#8) — «원반» 커널. feGaussianBlur 는 가우시안이고 feConvolveMatrix 는 9×9 가 한계라 셰이더다.
  { id: 'bokeh', name: '보케', group: 'focus', impl: 'webgl',
    params: [
      { key: 'radius', label: '반경(px)', min: 0, max: 60, def: 24, step: 1 },
      strength(0.6),
    ] },
  // WebGL(#8) — 중심에서 «바깥쪽으로» 늘어난다. SVG 는 축에 나란한 블러만 돼서 셰이더다.
  { id: 'radialBlur', name: '방사형 블러', group: 'focus', impl: 'webgl', params: [
    { key: 'px', label: '번짐(px)', min: 0, max: 60, def: 20, step: 1 },
    { key: 'cx', label: '중심 가로(0..1)', min: 0, max: 1, def: 0.5, step: 0.01 },
    { key: 'cy', label: '중심 세로(0..1)', min: 0, max: 1, def: 0.5, step: 0.01 },
  ] },

  // ── 질감 +5 ──
  { id: 'halation', name: '할레이션', group: 'texture', impl: 'svg', params: [
    strength(0.5),
    { key: 'radius', label: '반경(px)', min: 0, max: 60, def: 24, step: 1 },
    { key: 'hue', label: '색상(°)', min: 0, max: 360, def: 12, step: 1 },
  ] },
  { id: 'dust', name: '먼지·티끌', group: 'texture', impl: 'overlay', params: [
    strength(0.4),
    { key: 'density', label: '밀도', min: 0, max: 1, def: 0.5, step: 0.01 },
  ] },
  { id: 'vhs', name: 'VHS', group: 'texture', impl: 'overlay', params: [strength(0.6)] },
  { id: 'filmScratch', name: '필름 스크래치', group: 'texture', impl: 'overlay', params: [
    strength(0.5),
    { key: 'count', label: '줄 수', min: 1, max: 12, def: 4, step: 1 },
  ] },
  { id: 'bloom', name: '블룸', group: 'texture', impl: 'svg', params: [
    strength(0.5),
    { key: 'radius', label: '반경(px)', min: 0, max: 120, def: 48, step: 2 },
    { key: 'threshold', label: '기준 밝기', min: 0, max: 1, def: 0.5, step: 0.01 },
  ] },

  // ── 왜곡 +6 ──
  { id: 'pixelate', name: '픽셀화(모자이크)', group: 'distort', impl: 'svg',
    params: [{ key: 'size', label: '블록 크기(px)', min: 2, max: 80, def: 16, step: 1 }] },
  { id: 'mosaic', name: '타일 모자이크', group: 'distort', impl: 'svg', params: [
    { key: 'size', label: '타일 크기(px)', min: 4, max: 120, def: 28, step: 1 },
    { key: 'grout', label: '격자선 굵기', min: 0, max: 0.4, def: 0.12, step: 0.01 },
  ] },
  { id: 'wave', name: '물결 왜곡', group: 'distort', impl: 'svg', params: [
    { key: 'amount', label: '세기(px)', min: 0, max: 60, def: 18, step: 1 },
    { key: 'scale', label: '무늬 잘기', min: 0.002, max: 0.06, def: 0.012, step: 0.001 },
  ] },
  { id: 'crt', name: 'CRT 브라운관', group: 'distort', impl: 'overlay', params: [
    strength(0.6),
    { key: 'lines', label: '줄 수', min: 100, max: 2000, def: 900, step: 10 },
  ] },
  // WebGL(#8) — 같은 그림을 «두 번» 그려 한쪽을 뒤집는다. SVG 필터는 좌표를 못 뒤집어서 셰이더다.
  { id: 'mirror', name: '거울(반사)', group: 'distort', impl: 'webgl',
    params: [
      { key: 'axis', label: '축 (0 좌우 · 1 상하 · 2 사분면)', min: 0, max: 2, def: 0, step: 1 },
      { key: 'side', label: '남길 쪽 (0 앞 · 1 뒤)', min: 0, max: 1, def: 0, step: 1 },
      { key: 'pos', label: '경계 위치(0..1)', min: 0.01, max: 0.99, def: 0.5, step: 0.01 },
    ] },
  // WebGL(#8) — 한 조각을 각도만큼 돌려 가며 반사 복사한다. SVG 필터는 좌표를 못 돌려서 셰이더다.
  { id: 'kaleidoscope', name: '만화경', group: 'distort', impl: 'webgl',
    params: [
      { key: 'segments', label: '조각 수', min: 3, max: 16, def: 6, step: 1 },
      { key: 'angle', label: '각도(°)', min: 0, max: 360, def: 0, step: 1 },
    ] },

  // ── 스타일 +5 ──
  { id: 'posterize', name: '포스터라이즈', group: 'style', impl: 'svg',
    params: [{ key: 'levels', label: '단계 수', min: 2, max: 16, def: 6, step: 1 }] },
  { id: 'threshold', name: '흑백 이치화', group: 'style', impl: 'svg',
    params: [{ key: 'level', label: '기준 밝기', min: 0, max: 1, def: 0.5, step: 0.01 }] },
  { id: 'edgeDetect', name: '윤곽선', group: 'style', impl: 'svg',
    params: [{ key: 'amount', label: '강도', min: 0, max: 2, def: 1, step: 0.01 }] },
  { id: 'emboss', name: '엠보스', group: 'style', impl: 'svg', params: [
    { key: 'amount', label: '강도', min: 0, max: 2, def: 1, step: 0.01 },
    { key: 'px', label: '두께(px)', min: 1, max: 8, def: 2, step: 1 },
  ] },
  // WebGL(#8) — 셀마다 «밝기에 비례하는 점». SVG 필터에는 주기적 무늬를 만들 수단이 없어서 셰이더다.
  { id: 'halftone', name: '망점(하프톤)', group: 'style', impl: 'webgl',
    params: [
      { key: 'size', label: '망점 간격(px)', min: 2, max: 40, def: 8, step: 1 },
      { key: 'angle', label: '각도(°)', min: 0, max: 90, def: 45, step: 1 },
    ] },
] as const satisfies readonly EffectDef[];

export const EFFECT_CATALOG: readonly EffectDef[] = EFFECT_CATALOG_RAW;

export type EffectType = (typeof EFFECT_CATALOG_RAW)[number]['id'];

/** 하위호환: v1·W5 앞머리 20종의 순서가 그대로다. 새 효과는 항상 뒤에 붙는다. */
export const EFFECT_TYPES: readonly EffectType[] = EFFECT_CATALOG_RAW.map((d) => d.id);

const EFFECT_BY_ID = new Map<string, EffectDef>(EFFECT_CATALOG.map((d) => [d.id, d]));

export function effectDef(id: string): EffectDef | undefined {
  return EFFECT_BY_ID.get(id);
}

/**
 * 「대기」 효과 — 목록에는 있지만 아직 안 그려지는 것. `pending` 사유가 적힌 항목만이다.
 * UI 는 이 목록을 보고 드롭다운에서 **고를 수 없게** 만든다. W8 #8 에서 WebGL 6종이 구현돼
 * **지금은 빈 배열**이다 — `impl:'webgl'` 은 더 이상 «대기»의 뜻이 아니다.
 */
export const PENDING_EFFECT_TYPES: readonly EffectType[] = EFFECT_CATALOG_RAW
  .filter((d) => 'pending' in d && typeof d.pending === 'string')
  .map((d) => d.id);

export function isPendingEffect(id: string): boolean {
  return typeof effectDef(id)?.pending === 'string';
}

/** 효과 기본 파라미터 — 카탈로그의 `def` 를 그대로 편다. */
export function defaultEffectParams(type: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of effectDef(type)?.params ?? []) out[p.key] = p.def;
  return out;
}

/** 슬라이더 눈금 — 카탈로그에 없으면 범위의 1/100. */
export function effectParamStep(p: EffectParamSpec): number {
  return p.step ?? (p.max - p.min) / 100;
}
