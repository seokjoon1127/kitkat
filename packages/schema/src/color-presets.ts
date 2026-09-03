// F5 HSL 세컨더리 — 색 계열 프리셋과 «어느 계열에 속하는가» 판정 (계획 05).
//
// 값은 전부 «전형적 출발점» 이지 표준이 아니다. 피부색은 인종·조명·카메라마다 다르다.
// UI 가 프리셋 칩 아래에 그렇게 적는다 — 벡터스코프를 보고 다듬으라고.
import type { HslFamily, HslSecondary, HueSatBand, HueSatBandName } from './index.js';

/** id 는 적용할 때 생성한다 — 프리셋 자체는 값만 갖는다. */
export type PresetHsl = Omit<HslSecondary, 'id'>;
export type PresetHueSat = Omit<HueSatBand, 'id'>;

export type ColorPreset = {
  id: string;
  name: string;
  /** 무엇을 고치는가 — UI 에 그대로 뜬다. */
  note: string;
  hsl?: readonly PresetHsl[];
  hueSat?: readonly PresetHueSat[];
};

const ink = (
  family: HslFamily,
  cyan: number,
  magenta: number,
  yellow: number,
  black: number,
): PresetHsl => ({ family, cyan, magenta, yellow, black });

const band = (
  bands: HueSatBandName[],
  saturation: number,
  hue = 0,
  intensity = 0,
): PresetHueSat => ({ bands, hue, saturation, intensity });

/**
 * 계획 05 의 표 그대로. 주 용도가 피부톤이라 피부 프리셋을 앞에 둔다.
 *
 * selectivecolor 의 CMYK 는 «잉크» 다 — K(검정)를 빼면 밝아지고, C(시안)를 더하면 빨강이 죽는다.
 * 채도·색상 회전은 selectivecolor 로 안 되므로 그런 프리셋은 huesaturation 을 쓴다.
 */
export const COLOR_PRESETS: readonly ColorPreset[] = [
  {
    id: 'skin-brighten',
    name: '피부 밝게',
    note: 'K(검정 잉크)를 빼면 밝아집니다',
    hsl: [ink('reds', 0, 0, 0, -0.08), ink('yellows', 0, 0, 0, -0.06)],
  },
  {
    id: 'skin-less-red',
    name: '붉은기 빼기',
    note: '시안↑ 자홍↓ — 얼굴이 벌건 것',
    hsl: [ink('reds', 0.06, -0.05, 0, 0)],
  },
  {
    id: 'skin-less-yellow',
    name: '노란기 빼기',
    note: '노랑↓ — 조명이 텅스텐일 때',
    hsl: [ink('yellows', 0, 0, -0.1, 0)],
  },
  {
    id: 'skin-warmth',
    name: '혈색 살리기',
    note: '창백한 얼굴',
    hsl: [ink('reds', -0.04, 0.03, 0.02, 0)],
  },
  {
    id: 'skin-desaturate',
    name: '피부 채도 낮추기',
    note: 'AI 영상의 과채도 — 빨강·노랑 구간만',
    hueSat: [band(['r', 'y'], -0.15)],
  },
  {
    id: 'sky-deepen',
    name: '하늘 진하게',
    note: '배경 하늘만',
    hsl: [ink('blues', 0.1, 0.04, 0, 0.05)],
  },
  {
    id: 'green-natural',
    name: '초록 자연스럽게',
    note: '형광 초록 잔디',
    hsl: [ink('greens', 0, 0, 0.08, 0)],
    hueSat: [band(['g'], -0.1)],
  },
] as const;

// ── 스포이드 — 픽셀 하나가 어느 계열인가 ──────────────────────────────────
//
// **추측이 아니라 ffmpeg 소스에서 그대로 옮긴 규칙이다.**
// libavfilter/vf_selectivecolor.c 의 DECLARE_SELECTIVE_COLOR_FUNC 매크로 (2026-09-02 확인):
//
//   min_color = FFMIN3(r,g,b) · max_color = FFMAX3(r,g,b) · mid = 128 · max = 255   (8비트)
//   is_white   = (r > mid && g > mid && b > mid)
//   is_neutral = (r || g || b) && (r != max || g != max || b != max)
//   is_black   = (r < mid && g < mid && b < mid)
//   range_flag = (r == max_color)<<REDS   | (r == min_color)<<CYANS
//              | (g == max_color)<<GREENS | (g == min_color)<<MAGENTAS
//              | (b == max_color)<<BLUES  | (b == min_color)<<YELLOWS
//              | is_white<<WHITES | is_neutral<<NEUTRALS | is_black<<BLACKS
//
// 그리고 계열마다 «세기» 가 있다. 계열에 속해도 세기가 0이면 그 픽셀은 **안 변한다**:
//   reds/greens/blues     : max_color − mid_pred(r,g,b)
//   cyans/magentas/yellows: mid_pred(r,g,b) − min_color
//   whites                : 2·min_color − 255
//   blacks                : 255 − 2·max_color
//   neutrals              : (510 − |2·max_color−255| − |2·min_color−255| + 1) >> 1
//   → 적용 조건은 `if (scale > 0)`
//
// 그래서 회색 픽셀(r=g=b)은 reds·greens·blues·cyans·magentas·yellows 6개 «전부» 에
// 속하지만 세기가 0이라 어느 쪽으로도 안 변한다 — 회색은 whites/neutrals/blacks 로만 만진다.
// 이 규칙이 실제 ffmpeg 과 같은지는 server/test/color-family.test.ts 가 픽셀로 검사한다.

/** 한 픽셀이 속하는 계열과 그 세기(0..255). 세기가 0인 계열은 «안 변하므로» 빼고 준다. */
export type FamilyMatch = { family: HslFamily; scale: number };

const mid3 = (r: number, g: number, b: number): number =>
  Math.max(Math.min(r, g), Math.min(Math.max(r, g), b));

const to255 = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));

/**
 * 픽셀 → selectivecolor 가 실제로 만지는 계열들 (세기 내림차순).
 *
 * 회색(r=g=b)은 색 6계열의 세기가 전부 0이라 목록에서 빠지고 밝기 계열만 남는다.
 * 순수 흰색은 whites, 순수 검정은 blacks 로만 잡힌다(둘 다 is_neutral 조건에서 빠진다).
 * 목록이 빈 픽셀은 없다 — 어떤 색이든 밝기 계열 하나에는 걸린다.
 */
export function hslFamiliesOfRgb(r0: number, g0: number, b0: number): FamilyMatch[] {
  const r = to255(r0);
  const g = to255(g0);
  const b = to255(b0);
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  const mid = mid3(r, g, b);
  const rgbScale = max - mid;
  const cmyScale = mid - min;
  const isWhite = r > 128 && g > 128 && b > 128;
  const isNeutral = (r > 0 || g > 0 || b > 0) && !(r === 255 && g === 255 && b === 255);
  const isBlack = r < 128 && g < 128 && b < 128;

  const out: FamilyMatch[] = [];
  const push = (family: HslFamily, member: boolean, scale: number): void => {
    if (member && scale > 0) out.push({ family, scale });
  };
  push('reds', r === max, rgbScale);
  push('greens', g === max, rgbScale);
  push('blues', b === max, rgbScale);
  push('cyans', r === min, cmyScale);
  push('magentas', g === min, cmyScale);
  push('yellows', b === min, cmyScale);
  push('whites', isWhite, 2 * min - 255);
  push('blacks', isBlack, 255 - 2 * max);
  push('neutrals', isNeutral, (510 - Math.abs(2 * max - 255) - Math.abs(2 * min - 255) + 1) >> 1);
  return out.sort((a, z) => z.scale - a.scale);
}

/** 스포이드가 켤 칩 하나 — 색 계열(reds..magentas)을 밝기 계열보다 우선한다. */
export function hslFamilyOfRgb(r: number, g: number, b: number): HslFamily | null {
  const matches = hslFamiliesOfRgb(r, g, b);
  const hue = matches.find(
    (m) =>
      m.family !== 'whites' && m.family !== 'neutrals' && m.family !== 'blacks',
  );
  return hue?.family ?? matches[0]?.family ?? null;
}

/**
 * 픽셀을 «실제로 움직이는» huesaturation 6구간 (세기 내림차순).
 *
 * 이것도 추측이 아니다 — libavfilter/vf_huesaturation.c 의 HUESATURATION 매크로(2026-09-02 확인).
 * 소속 판정은 selectivecolor 와 같은 규칙이고, 그 위에 구간별 «섞는 양» f 가 곱해진다:
 *   RED f = r − max(g,b) · YELLOW f = min(r,g) − b · GREEN f = g − max(r,b)
 *   CYAN f = min(g,b) − r · BLUE f = b − max(r,g) · MAGENTA f = min(r,b) − g
 *   → 결과 = lerp(원본, 변환값, min(f·strength, 255)/255)
 * f 가 0이면 그 구간을 켜도 픽셀이 «안 변한다». 회색(max==min)은 6구간 전부 f=0 이다 —
 * huesaturation 으로는 무채색을 못 만진다(그건 selectivecolor 의 whites/neutrals/blacks 몫).
 */
export function hueSatBandsOfRgb(r0: number, g0: number, b0: number): HueSatBandName[] {
  const r = to255(r0);
  const g = to255(g0);
  const b = to255(b0);
  const f: { band: HueSatBandName; f: number }[] = [
    { band: 'r', f: r - Math.max(g, b) },
    { band: 'y', f: Math.min(r, g) - b },
    { band: 'g', f: g - Math.max(r, b) },
    { band: 'c', f: Math.min(g, b) - r },
    { band: 'b', f: b - Math.max(r, g) },
    { band: 'm', f: Math.min(r, b) - g },
  ];
  return f
    .filter((x) => x.f > 0)
    .sort((a, z) => z.f - a.f)
    .map((x) => x.band);
}
