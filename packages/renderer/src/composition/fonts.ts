// 번들 폰트 로딩 (T2 / D15) — media/fonts/ 의 OFL 한글 폰트를 @font-face 로 주입한다.
// URL 은 mediaBase 기준이라 미리보기(/media)와 렌더(임시 정적 서버)가 같은 파일을 쓴다.
// 폰트 파일이 없으면 @font-face 가 그냥 실패하고 CSS 스택의 시스템 폰트로 폴백된다 — 렌더는 죽지 않는다.
import type { ProjectDoc } from '@kitkat/schema';

export type BundledFont = {
  family: string;
  /** media/fonts/ 안의 파일 이름 */
  file: string;
  /** @font-face 의 font-weight (범위 표기 가능) */
  weight: string;
};

/**
 * media/fonts/ 에 있는 파일 그대로. weight 범위는 «굵게» 체크(font-weight:700)가
 * Black/ExtraBold 파일을 고르도록 잡았다. Regular 하나뿐인 폰트는 브라우저 합성 굵게가 적용된다.
 */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  // 가변 폰트 1개가 100~900 전부를 담는다
  { family: 'Noto Sans KR', file: 'NotoSansKR-VF.ttf', weight: '100 900' },
  { family: 'Gothic A1', file: 'GothicA1-Regular.ttf', weight: '400' },
  { family: 'Gothic A1', file: 'GothicA1-Black.ttf', weight: '700 900' },
  { family: 'Black Han Sans', file: 'BlackHanSans-Regular.ttf', weight: '400' },
  { family: 'Do Hyeon', file: 'DoHyeon-Regular.ttf', weight: '400' },
  { family: 'Jua', file: 'Jua-Regular.ttf', weight: '400' },
  { family: 'Gaegu', file: 'Gaegu-Regular.ttf', weight: '400' },
  { family: 'Gaegu', file: 'Gaegu-Bold.ttf', weight: '700' },
  { family: 'Nanum Pen Script', file: 'NanumPenScript-Regular.ttf', weight: '400' },
  { family: 'Song Myung', file: 'SongMyung-Regular.ttf', weight: '400' },
  { family: 'Nanum Myeongjo', file: 'NanumMyeongjo-Regular.ttf', weight: '400' },
  { family: 'Nanum Myeongjo', file: 'NanumMyeongjo-ExtraBold.ttf', weight: '700 800' },
];

/** media/fonts 안의 파일 URL. mediaBase 가 ''(상대) 여도 동작한다. */
export function fontUrl(mediaBase: string, file: string): string {
  const base = mediaBase.endsWith('/') ? mediaBase.slice(0, -1) : mediaBase;
  return `${base}/fonts/${file}`;
}

/**
 * @font-face 규칙 전체. font-display:block 으로 폴백 글꼴이 먼저 그려지는 걸 막는다
 * (렌더는 delayRender 로 어차피 기다리지만, 미리보기에서 글꼴이 바뀌며 깜빡이는 걸 없앤다).
 */
export function fontFaceCss(mediaBase: string): string {
  return BUNDLED_FONTS.map(
    (f) =>
      `@font-face{font-family:'${f.family}';src:url('${fontUrl(mediaBase, f.file)}') format('truetype');` +
      `font-weight:${f.weight};font-style:normal;font-display:block;}`,
  ).join('\n');
}

/** 문서의 텍스트 클립들이 쓰는 fontFamily 문자열 (중복 제거). */
export function usedFontFamilies(doc: ProjectDoc): string[] {
  const out = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'text') out.add(clip.style.fontFamily);
    }
  }
  return [...out];
}

/**
 * 실제로 내려받아야 하는 폰트만 고른다 — 35MB 를 매 렌더마다 받지 않기 위해서다.
 * fontFamily 문자열(스택)에 번들 폰트 이름이 들어 있으면 그 폰트가 대상.
 * 반환값은 document.fonts.load 에 넣을 CSS 축약형(`<weight> 100px "<family>"`).
 */
export function fontLoadSpecs(families: string[]): string[] {
  const out = new Set<string>();
  for (const f of BUNDLED_FONTS) {
    if (!families.some((fam) => fam.includes(f.family))) continue;
    // weight 범위("700 900")면 양 끝만 요청하면 그 파일 하나가 걸린다
    for (const w of f.weight.split(' ')) out.add(`${w} 100px "${f.family}"`);
  }
  return [...out];
}

/**
 * 문서가 쓰는 번들 폰트를 실제로 내려받고 레이아웃이 끝나길 기다린다.
 * 폰트가 없거나(404) document.fonts 가 없어도 절대 throw 하지 않는다.
 */
export async function ensureFontsLoaded(doc: ProjectDoc): Promise<void> {
  const fonts = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
  if (!fonts) return;
  const specs = fontLoadSpecs(usedFontFamilies(doc));
  await Promise.all(specs.map((s) => fonts.load(s).catch(() => [])));
  await fonts.ready.catch(() => undefined);
}
