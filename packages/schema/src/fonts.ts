// 번들 한글 폰트 목록 (T2 / D15) — media/fonts/ 에 들어 있는 OFL 폰트들.
// TextStyle.fontFamily 는 여전히 자유 문자열이다. 이 목록은 인스펙터 드롭다운·템플릿용 «편의»일 뿐
// 제약이 아니다. css 문자열은 폰트 파일이 없을 때 시스템 한글 폰트로 폴백하도록 스택을 갖는다.

export type FontFamilyOption = {
  /** media/fonts 의 구글 폰트 slug (system 만 예외) */
  id: string;
  /** 인스펙터에 보일 한국어 이름 */
  name: string;
  /** CSS font-family 값 — TextStyle.fontFamily 에 그대로 넣는다 */
  css: string;
};

/** 폰트 파일이 없을 때 쓰이는 시스템 한글 폰트 스택. */
export const FONT_FALLBACK = "'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif";

export const FONT_FAMILIES: readonly FontFamilyOption[] = [
  { id: 'notosanskr', name: '노토 산스 KR', css: `'Noto Sans KR', ${FONT_FALLBACK}` },
  { id: 'gothica1', name: '고딕 A1', css: `'Gothic A1', ${FONT_FALLBACK}` },
  { id: 'blackhansans', name: '검은고딕 (임팩트)', css: `'Black Han Sans', ${FONT_FALLBACK}` },
  { id: 'dohyeon', name: '도현 (굵은 고딕)', css: `'Do Hyeon', ${FONT_FALLBACK}` },
  { id: 'jua', name: '주아 (둥근)', css: `'Jua', ${FONT_FALLBACK}` },
  { id: 'gaegu', name: '개구 (손글씨)', css: `'Gaegu', ${FONT_FALLBACK}` },
  { id: 'nanumpenscript', name: '나눔 펜 (펜 손글씨)', css: `'Nanum Pen Script', ${FONT_FALLBACK}` },
  { id: 'songmyung', name: '송명 (명조)', css: `'Song Myung', ${FONT_FALLBACK}` },
  { id: 'nanummyeongjo', name: '나눔명조', css: `'Nanum Myeongjo', ${FONT_FALLBACK}` },
  { id: 'system', name: '시스템 기본', css: FONT_FALLBACK },
] as const;

/** 자막·템플릿 기본 글꼴 — 실제로 번들된 폰트를 가리킨다(예전 기본값 Pretendard 는 미설치였다). */
export const DEFAULT_FONT_FAMILY: string = FONT_FAMILIES[0]!.css;
