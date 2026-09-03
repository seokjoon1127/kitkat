// 텍스트 템플릿 90종 (W6 T3 의 35종 + W8 F16 의 55종) + 속도 램프 프리셋 6종 (계획 X1-d).
// **앞 35종의 id 와 순서를 바꾸지 마라** — 저장된 문서와 서버 capabilities 가 이 순서를 본다.
// fontSize 는 1080 기준 px. transform.x/y 는 캔버스 비율(0..1) 오프셋 — y 는 +가 아래쪽.
// 글꼴은 전부 media/fonts/ 에 번들된 OFL 한글 폰트다 (T2/D15) — 시스템 설치에 기대지 않는다.
// «굵게(bold)» 는 font-weight:700 이라 Gothic A1 은 Black, Nanum Myeongjo 는 ExtraBold,
// Gaegu 는 Bold 파일이 걸린다. 단일 굵기 폰트(Black Han Sans·Do Hyeon·Jua·Song Myung·
// Nanum Pen Script)에는 bold 를 켜지 않는다 — 브라우저 합성 굵게는 획이 뭉개진다.
//
// 외곽선: 렌더러 text.tsx 가 `paint-order: stroke fill` 을 주므로 획이 **바깥으로만** 자란다.
// 두꺼운 테두리(예능 자막 10%, 외침 12%)를 써도 글자 속이 먹히지 않는다. 인스펙터 칩도 같은 값이다.
// (2026-09-01 이전에는 paint-order 가 없어 두께 4~8% 가 상한이었다 — 지금은 해제됨.)
import type { SpeedPoint, TextAnim, TextTemplate } from './index.js';
import { FONT_FAMILIES } from './fonts.js';

const cssOf = (id: string): string => FONT_FAMILIES.find((f) => f.id === id)!.css;

const NOTO = cssOf('notosanskr');       // 본문 고딕 (가변 100~900)
const GOTHIC = cssOf('gothica1');       // 고딕 A1 — 굵게 → Black
const BLACK = cssOf('blackhansans');    // 검은고딕 — 초굵은 임팩트
const DOHYEON = cssOf('dohyeon');       // 도현 — 굵은 고딕
const JUA = cssOf('jua');               // 주아 — 둥글고 친근
const GAEGU = cssOf('gaegu');           // 개구 — 손글씨, 굵게 → Bold
const PEN = cssOf('nanumpenscript');    // 나눔 펜 — 펜글씨
const SONG = cssOf('songmyung');        // 송명 — 명조
const MYEONGJO = cssOf('nanummyeongjo');// 나눔명조 — 굵게 → ExtraBold

export const TEXT_TEMPLATES: readonly TextTemplate[] = [
  // ── 기본 자막 5 ──────────────────────────────────────────────────────────
  {
    // 깔끔한 표준 자막 — 흰 글자 + 가는 검정 외곽선 + 그림자, 하단 1/3
    id: 'basic',
    name: '기본 자막',
    style: {
      fontFamily: NOTO, fontSize: 58, color: '#ffffff', bold: true,
      strokeColor: '#000000', strokeWidth: 2, shadow: true,
      align: 'center', letterSpacing: 0, lineHeight: 1.35,
    },
    animationIn: { type: 'fade', duration: 150 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },
  {
    // 두꺼운 검정 외곽선 — 배경이 뭐든 읽히는 굵은 자막 (고딕 A1 Black)
    id: 'outline',
    name: '굵은 외곽선',
    style: {
      fontFamily: GOTHIC, fontSize: 68, color: '#ffffff', bold: true,
      strokeColor: '#000000', strokeWidth: 6,
      align: 'center', letterSpacing: -0.5, lineHeight: 1.3,
    },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },
  {
    // 반투명 검정 박스 위 흰 글자 — 어떤 배경에서도 안정
    id: 'boxed',
    name: '박스 배경',
    style: {
      fontFamily: NOTO, fontSize: 54, color: '#ffffff', bold: true,
      backgroundColor: 'rgba(17,17,17,0.82)',
      align: 'center', letterSpacing: 0, lineHeight: 1.4,
    },
    animationIn: { type: 'fade', duration: 150 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },
  {
    // 외곽선 없이 그림자만 — 밝은 영상에서 부드럽게 얹히는 자막
    id: 'softShadow',
    name: '그림자 자막',
    style: {
      fontFamily: GOTHIC, fontSize: 52, color: '#f5f5f5', shadow: true,
      align: 'center', letterSpacing: 0.5, lineHeight: 1.45,
    },
    animationIn: { type: 'slideUp', duration: 220 },
    transform: { x: 0, y: 0.32, scale: 1, rotation: 0 },
  },
  {
    // 둥근 주아체 + 갈색 외곽 — 브이로그·일상 채널용 말랑한 기본 자막
    id: 'round',
    name: '둥근 자막',
    style: {
      fontFamily: JUA, fontSize: 62, color: '#fffdf5',
      strokeColor: '#3b2f2f', strokeWidth: 2.5, shadow: true,
      align: 'center', letterSpacing: -0.5, lineHeight: 1.35,
    },
    animationIn: { type: 'popIn', duration: 200 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },

  // ── 예능/강조 6 ──────────────────────────────────────────────────────────
  {
    // 한국 예능식 — 샛노랑 도현체 + 두꺼운 검정 외곽 + 팝인
    id: 'variety',
    name: '예능 자막',
    style: {
      fontFamily: DOHYEON, fontSize: 78, color: '#ffd400',
      strokeColor: '#000000', strokeWidth: 10, shadow: true,
      align: 'center', letterSpacing: -1, lineHeight: 1.25,
    },
    animationIn: { type: 'popIn', duration: 250 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
    highlightColor: '#ff4d6d',
  },
  {
    // 팝인 강조 — 검은고딕 대문짝 + 마젠타 외곽, 화면 한가운데
    id: 'pop',
    name: '팝인 강조',
    style: {
      fontFamily: BLACK, fontSize: 92, color: '#ffffff',
      strokeColor: '#ff2d78', strokeWidth: 7, shadow: true,
      align: 'center', letterSpacing: -2, lineHeight: 1.15,
    },
    animationIn: { type: 'popIn', duration: 300 },
    highlightColor: '#ffd400',
  },
  {
    // 네온 사인 — 시안 코어 + 시안 외곽, 넓은 자간
    id: 'neon',
    name: '네온 글로우',
    style: {
      fontFamily: NOTO, fontSize: 72, color: '#e0fbff', bold: true,
      strokeColor: '#22d3ee', strokeWidth: 2, shadow: true,
      align: 'center', letterSpacing: 3, lineHeight: 1.4,
    },
    animationIn: { type: 'fade', duration: 300 },
    highlightColor: '#22d3ee',
  },
  {
    // 외침 — 기울어진 초대형 검은고딕, 화면을 꽉 채우는 리액션 자막
    id: 'shout',
    name: '외침',
    style: {
      fontFamily: BLACK, fontSize: 104, color: '#ffffff', italic: true,
      strokeColor: '#111111', strokeWidth: 12, shadow: true,
      align: 'center', letterSpacing: -3, lineHeight: 1.05,
    },
    animationIn: { type: 'popIn', duration: 220 },
    transform: { x: 0, y: -0.02, scale: 1, rotation: -4 },
    highlightColor: '#ff3b30',
  },
  {
    // 형광 박스 — 노란 바탕에 검정 주아체, 살짝 기울여 붙인 스티커 느낌
    id: 'highlightBar',
    name: '형광 박스',
    style: {
      fontFamily: JUA, fontSize: 74, color: '#1a1a1a',
      backgroundColor: '#ffe600',
      align: 'center', letterSpacing: -1, lineHeight: 1.25,
    },
    animationIn: { type: 'popIn', duration: 200 },
    transform: { x: 0, y: 0.26, scale: 1, rotation: -1.5 },
  },
  {
    // 노래방 강조 — 흐린 회백색 기본 글자에 현재 단어만 노랑으로 (words 필요)
    id: 'karaoke',
    name: '노래방 강조',
    style: {
      fontFamily: NOTO, fontSize: 64, color: '#cfd8e3', bold: true,
      strokeColor: '#000000', strokeWidth: 2, shadow: true,
      align: 'center', letterSpacing: 1, lineHeight: 1.3,
    },
    animationIn: { type: 'wordHighlight', duration: 2000 },
    transform: { x: 0, y: 0.34, scale: 1, rotation: 0 },
    highlightColor: '#ffd400',
  },

  // ── 광고 헤드라인 5 ──────────────────────────────────────────────────────
  {
    // 대문짝 — 검은고딕 130px, 장식 없이 크기로만 밀어붙인다
    id: 'adBig',
    name: '대문짝 헤드라인',
    style: {
      fontFamily: BLACK, fontSize: 130, color: '#ffffff', shadow: true,
      align: 'center', letterSpacing: -5, lineHeight: 1.0,
    },
    animationIn: { type: 'fade', duration: 200 },
    animationOut: { type: 'fade', duration: 250 },
    transform: { x: 0, y: -0.12, scale: 1, rotation: 0 },
  },
  {
    // 노랑 판때기에 검정 글씨 — 전단지식 최고 대비
    id: 'adYellow',
    name: '노랑 배경 헤드라인',
    style: {
      fontFamily: BLACK, fontSize: 96, color: '#111111',
      backgroundColor: '#ffe600',
      align: 'center', letterSpacing: -3, lineHeight: 1.1,
    },
    animationIn: { type: 'popIn', duration: 260 },
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
  },
  {
    // 세일 태그 — 노랑 글자 + 빨강 외곽, 비스듬히 붙인 가격표
    id: 'adSale',
    name: '세일 태그',
    style: {
      fontFamily: JUA, fontSize: 88, color: '#fff200',
      strokeColor: '#c1121f', strokeWidth: 3.5, shadow: true,
      align: 'center', letterSpacing: -1, lineHeight: 1.15,
    },
    animationIn: { type: 'popIn', duration: 280 },
    transform: { x: 0, y: -0.1, scale: 1, rotation: -6 },
    highlightColor: '#ffffff',
  },
  {
    // 럭셔리 — 나눔명조 ExtraBold + 아주 넓은 자간, 금빛 샴페인 색
    id: 'adLuxury',
    name: '럭셔리 헤드라인',
    style: {
      fontFamily: MYEONGJO, fontSize: 76, color: '#e8d7a8', bold: true,
      shadow: true, align: 'center', letterSpacing: 9, lineHeight: 1.45,
    },
    animationIn: { type: 'fade', duration: 500 },
    transform: { x: 0, y: -0.04, scale: 1, rotation: 0 },
  },
  {
    // 행동 유도 — 검정 버튼 모양 띠, 하단 고정
    id: 'adCta',
    name: '행동 유도 버튼',
    style: {
      fontFamily: DOHYEON, fontSize: 60, color: '#ffffff',
      backgroundColor: '#111111',
      align: 'center', letterSpacing: 2, lineHeight: 1.2,
    },
    animationIn: { type: 'slideUp', duration: 220 },
    transform: { x: 0, y: 0.34, scale: 1, rotation: 0 },
  },

  // ── 감성/인용 5 ──────────────────────────────────────────────────────────
  {
    // 인용구 — 송명 명조, 넉넉한 자간·행간, 화면 중앙
    id: 'quote',
    name: '인용구',
    style: {
      fontFamily: SONG, fontSize: 60, color: '#f8f5ef', shadow: true,
      align: 'center', letterSpacing: 5, lineHeight: 1.75,
    },
    animationIn: { type: 'fade', duration: 400 },
  },
  {
    // 감성 — 나눔명조 Regular, 극단적으로 넓은 자간과 행간, 아주 느린 페이드
    id: 'emotion',
    name: '감성 명조',
    style: {
      fontFamily: MYEONGJO, fontSize: 50, color: '#ffffff', shadow: true,
      align: 'center', letterSpacing: 11, lineHeight: 1.9,
    },
    animationIn: { type: 'fade', duration: 600 },
    transform: { x: 0, y: 0.22, scale: 1, rotation: 0 },
  },
  {
    // 영화 자막 — 작고 얌전한 회백색, 가는 외곽선, 화면 아래 끝
    id: 'filmSub',
    name: '영화 자막',
    style: {
      fontFamily: NOTO, fontSize: 44, color: '#e8e8e8',
      strokeColor: '#000000', strokeWidth: 1.5,
      align: 'center', letterSpacing: 1, lineHeight: 1.5,
    },
    animationIn: { type: 'fade', duration: 250 },
    transform: { x: 0, y: 0.38, scale: 1, rotation: 0 },
  },
  {
    // 가사 — 나눔명조 ExtraBold, 연분홍 흰빛, 아래에서 천천히 올라온다
    id: 'lyric',
    name: '가사',
    style: {
      fontFamily: MYEONGJO, fontSize: 66, color: '#fff1f2', bold: true,
      shadow: true, align: 'center', letterSpacing: 2, lineHeight: 1.8,
    },
    animationIn: { type: 'slideUp', duration: 500 },
    transform: { x: 0, y: 0.06, scale: 1, rotation: 0 },
  },
  {
    // 무드 밴드 — 반투명 검정 띠 위 송명, 자간을 벌려 잡지 캡션처럼
    id: 'moodBand',
    name: '무드 밴드',
    style: {
      fontFamily: SONG, fontSize: 48, color: '#f3f4f6',
      backgroundColor: 'rgba(0,0,0,0.45)',
      align: 'center', letterSpacing: 6, lineHeight: 1.7,
    },
    animationIn: { type: 'fade', duration: 500 },
    animationOut: { type: 'fade', duration: 400 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },

  // ── 손글씨 4 ─────────────────────────────────────────────────────────────
  {
    // 펜 메모 — 나눔 펜글씨 흰 글자 + 검정 외곽, 살짝 기울여 손으로 쓴 티
    id: 'penNote',
    name: '펜 메모',
    style: {
      fontFamily: PEN, fontSize: 80, color: '#ffffff',
      strokeColor: '#000000', strokeWidth: 2.5, shadow: true,
      align: 'center', letterSpacing: 0, lineHeight: 1.4,
    },
    animationIn: { type: 'fade', duration: 200 },
    transform: { x: 0, y: 0.28, scale: 1, rotation: -2 },
  },
  {
    // 형광 펜글씨 — 포스트잇 노랑 바탕에 진회색 펜글씨, 반대로 기울임
    id: 'penSticky',
    name: '형광 펜글씨',
    style: {
      fontFamily: PEN, fontSize: 88, color: '#1f2937',
      backgroundColor: '#fff59d',
      align: 'center', letterSpacing: 0, lineHeight: 1.3,
    },
    animationIn: { type: 'popIn', duration: 240 },
    transform: { x: 0, y: -0.06, scale: 1, rotation: 3 },
  },
  {
    // 개구 손글씨 — 분홍 글자에 흰 외곽선, 아기자기한 반응 자막
    id: 'gaeguCute',
    name: '개구 손글씨',
    style: {
      fontFamily: GAEGU, fontSize: 76, color: '#ff5a7a', bold: true,
      strokeColor: '#ffffff', strokeWidth: 3, shadow: true,
      align: 'center', letterSpacing: 0, lineHeight: 1.35,
    },
    animationIn: { type: 'popIn', duration: 220 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },
  {
    // 낙서 노트 — 미색 종이 위 검정 개구체가 한 글자씩 써진다
    id: 'gaeguDoodle',
    name: '낙서 노트',
    style: {
      fontFamily: GAEGU, fontSize: 60, color: '#111111',
      backgroundColor: '#fffdf7',
      align: 'left', letterSpacing: 1, lineHeight: 1.5,
    },
    animationIn: { type: 'typewriter', duration: 1000 },
    transform: { x: 0, y: 0.12, scale: 1, rotation: -4 },
  },

  // ── 뉴스/정보 4 ──────────────────────────────────────────────────────────
  {
    // 뉴스 하단바 — 붉은 바탕 바, 왼쪽 정렬, 슬라이드 업
    id: 'news',
    name: '뉴스 하단바',
    style: {
      fontFamily: GOTHIC, fontSize: 46, color: '#ffffff', bold: true,
      backgroundColor: '#b91c1c',
      align: 'left', letterSpacing: 0.5, lineHeight: 1.3,
    },
    animationIn: { type: 'slideUp', duration: 250 },
    transform: { x: 0, y: 0.38, scale: 1, rotation: 0 },
  },
  {
    // 타자기 — 터미널풍 연녹색 글자 + 짙은 박스, 글자 타이핑
    id: 'typing',
    name: '타자기',
    style: {
      fontFamily: NOTO, fontSize: 50, color: '#a5f3b4',
      backgroundColor: 'rgba(8,12,8,0.85)',
      align: 'left', letterSpacing: 1, lineHeight: 1.5,
    },
    animationIn: { type: 'typewriter', duration: 1200 },
  },
  {
    // 속보 티커 — 노랑 바탕에 작고 촘촘한 검정 글씨, 화면 맨 아래
    id: 'ticker',
    name: '속보 티커',
    style: {
      fontFamily: GOTHIC, fontSize: 40, color: '#111827', bold: true,
      backgroundColor: '#facc15',
      align: 'left', letterSpacing: 2, lineHeight: 1.25,
    },
    animationIn: { type: 'slideUp', duration: 200 },
    transform: { x: 0, y: 0.42, scale: 1, rotation: 0 },
  },
  {
    // 정보 카드 — 흰 카드에 짙은 글씨, 행간을 넓혀 여러 줄 설명용
    id: 'infoCard',
    name: '정보 카드',
    style: {
      fontFamily: NOTO, fontSize: 44, color: '#0f172a',
      backgroundColor: '#f8fafc',
      align: 'left', letterSpacing: 0, lineHeight: 1.6,
    },
    animationIn: { type: 'fade', duration: 200 },
    transform: { x: 0, y: 0.18, scale: 1, rotation: 0 },
  },

  // ── 카운트/숫자 3 ────────────────────────────────────────────────────────
  {
    // 카운트다운 — 화면을 채우는 220px 숫자, 팝인 후 페이드 아웃
    id: 'countdown',
    name: '카운트다운',
    style: {
      fontFamily: BLACK, fontSize: 220, color: '#ffffff',
      strokeColor: '#000000', strokeWidth: 12, shadow: true,
      align: 'center', letterSpacing: -8, lineHeight: 1.0,
    },
    animationIn: { type: 'popIn', duration: 200 },
    animationOut: { type: 'fade', duration: 150 },
  },
  {
    // 숫자 강조 — 노란 고딕 A1 Black + 진갈색 외곽, 화면 위쪽
    id: 'bigNumber',
    name: '숫자 강조',
    style: {
      fontFamily: GOTHIC, fontSize: 160, color: '#ffd400', bold: true,
      strokeColor: '#7c2d12', strokeWidth: 6, shadow: true,
      align: 'center', letterSpacing: -4, lineHeight: 1.05,
    },
    animationIn: { type: 'popIn', duration: 260 },
    transform: { x: 0, y: -0.14, scale: 1, rotation: 0 },
  },
  {
    // 가격 강조 — 둥근 주아체 진분홍 + 흰 외곽, 가격·할인율용
    id: 'price',
    name: '가격 강조',
    style: {
      fontFamily: JUA, fontSize: 120, color: '#ff2d55',
      strokeColor: '#ffffff', strokeWidth: 4.5, shadow: true,
      align: 'center', letterSpacing: -2, lineHeight: 1.1,
    },
    animationIn: { type: 'popIn', duration: 250 },
    transform: { x: 0, y: 0.1, scale: 1, rotation: 0 },
  },

  // ── 미니멀 3 ─────────────────────────────────────────────────────────────
  {
    // 미니멀 — 얇은 흰 글자, 넓은 자간, 장식 없음
    id: 'minimal',
    name: '미니멀 얇은 흰색',
    style: {
      fontFamily: NOTO, fontSize: 46, color: '#ffffff',
      align: 'center', letterSpacing: 6, lineHeight: 1.5,
    },
    animationIn: { type: 'fade', duration: 250 },
  },
  {
    // 미니멀 넓은 자간 — 아주 작은 글자를 극단적으로 벌려 화면 위쪽에
    id: 'minimalWide',
    name: '미니멀 넓은 자간',
    style: {
      fontFamily: NOTO, fontSize: 34, color: '#ffffff',
      align: 'center', letterSpacing: 16, lineHeight: 2.0,
    },
    animationIn: { type: 'fade', duration: 400 },
    transform: { x: 0, y: -0.3, scale: 1, rotation: 0 },
  },
  {
    // 미니멀 밝은 띠 — 반투명 흰 띠에 얇은 검정 글씨 (밝은 화면 반전판)
    id: 'minimalDark',
    name: '미니멀 밝은 띠',
    style: {
      fontFamily: GOTHIC, fontSize: 40, color: '#111111',
      backgroundColor: 'rgba(255,255,255,0.9)',
      align: 'center', letterSpacing: 4, lineHeight: 1.6,
    },
    animationIn: { type: 'fade', duration: 300 },
    transform: { x: 0, y: 0.35, scale: 1, rotation: 0 },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // W8 F16 — 35 → 90. **뒤에 붙인다** (앞 35종의 id·순서는 저장된 문서가 본다).
  //
  // F8 이 「단위 × 움직임」(unit·staggerMs·origin·easing)을 넣으면서 템플릿이
  // 「스타일」에서 **「스타일 + 움직임」**으로 넓어졌다 — 아래 신규 55종은 그걸 쓴다.
  //
  // 갈래마다 **최소 세 축이 다르게** 만들었다 (글꼴 / 색·배경 / 크기·자간 / 위치·기울기 /
  // 등장 움직임). 색만 바꾼 복제본은 schema.test.ts 의 중복 검사가 막는다.
  // ═══════════════════════════════════════════════════════════════════════

  // ── 기본 자막 +5 (5 → 10) ────────────────────────────────────────────────
  {
    // 명조 기본 자막 — 고딕 일색인 기본 갈래에 «세리프» 한 벌. 다큐·인터뷰용
    id: 'basicSerif',
    name: '명조 기본 자막',
    style: {
      fontFamily: SONG, fontSize: 52, color: '#f2f0ea',
      strokeColor: '#1a1a1a', strokeWidth: 1.5, shadow: true,
      align: 'center', letterSpacing: 2, lineHeight: 1.5,
    },
    animationIn: { type: 'fade', duration: 250 },
    transform: { x: 0, y: 0.32, scale: 1, rotation: 0 },
  },
  {
    // 남색 외곽 — 검정 외곽이 무거운 밝은 화면용. 외곽선이 차가운 남색이라 덜 답답하다
    id: 'basicNavy',
    name: '남색 외곽 자막',
    style: {
      fontFamily: GOTHIC, fontSize: 56, color: '#ffffff', bold: true,
      strokeColor: '#10233f', strokeWidth: 5,
      align: 'center', letterSpacing: 0, lineHeight: 1.35,
    },
    animationIn: { type: 'slideUp', duration: 200, unit: 'all', distance: 20 },
    transform: { x: 0, y: 0.31, scale: 1, rotation: 0 },
  },
  {
    // 흰 알약 — 밝은 배경 위 검정 글씨. 박스 배경(어두운 판)의 반대판
    id: 'basicPill',
    name: '흰 알약 자막',
    style: {
      fontFamily: JUA, fontSize: 50, color: '#1b1b1b',
      backgroundColor: 'rgba(255,255,255,0.92)',
      align: 'center', letterSpacing: 0.5, lineHeight: 1.45,
    },
    animationIn: { type: 'scaleUp', duration: 220 },
    transform: { x: 0, y: 0.33, scale: 1, rotation: 0 },
  },
  {
    // 좌측 하단 — 중앙 정렬 일색인 기본 갈래에 «왼쪽 정렬» 한 벌. 브이로그 나레이션용
    id: 'basicLeft',
    name: '왼쪽 정렬 자막',
    style: {
      fontFamily: NOTO, fontSize: 46, color: '#ffffff',
      strokeColor: '#000000', strokeWidth: 2, shadow: true,
      align: 'left', letterSpacing: 0, lineHeight: 1.55,
    },
    animationIn: { type: 'slideRight', duration: 240, distance: 40 },
    transform: { x: 0, y: 0.36, scale: 1, rotation: 0 },
  },
  {
    // 닦으며 등장 — 같은 흰 자막이라도 «움직임»이 다르면 다른 자막이다 (F8 이후)
    id: 'basicWipe',
    name: '닦으며 등장',
    style: {
      fontFamily: GOTHIC, fontSize: 58, color: '#ffffff', bold: true,
      strokeColor: '#000000', strokeWidth: 2.5,
      align: 'center', letterSpacing: 1, lineHeight: 1.4,
    },
    animationIn: { type: 'wipeLeft', duration: 450, unit: 'all', distance: 18, easing: 'easeInOut' },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },

  // ── 예능·강조 +10 (6 → 16) ───────────────────────────────────────────────
  {
    // 말풍선 — 흰 판에 검정 주아체, 살짝 기울여 붙인 대사 풍선
    id: 'varietyBubble',
    name: '말풍선 자막',
    style: {
      fontFamily: JUA, fontSize: 68, color: '#16181d',
      backgroundColor: '#ffffff',
      align: 'center', letterSpacing: -0.5, lineHeight: 1.3,
    },
    animationIn: { type: 'popIn', duration: 420, unit: 'word', staggerMs: 60 },
    transform: { x: 0, y: 0.26, scale: 1, rotation: 2 },
    highlightColor: '#ff2d78',
  },
  {
    // 펀치 — 노랑 글자에 빨강 외곽, 글자가 하나씩 커지며 박힌다
    id: 'varietyPunch',
    name: '펀치 강조',
    style: {
      fontFamily: BLACK, fontSize: 96, color: '#fff200',
      strokeColor: '#d90429', strokeWidth: 8, shadow: true,
      align: 'center', letterSpacing: -3, lineHeight: 1.1,
    },
    animationIn: { type: 'scaleUp', duration: 600, unit: 'char', staggerMs: 35, easing: { bezier: [0.34, 1.56, 0.64, 1] } },
    transform: { x: 0, y: -0.05, scale: 1, rotation: 0 },
  },
  {
    // 충격 — 흰 도현체가 튀어 들어온다. 외침(기울인 검은고딕)과 글꼴·움직임이 다르다
    id: 'varietyShock',
    name: '충격 리액션',
    style: {
      fontFamily: DOHYEON, fontSize: 88, color: '#ffffff',
      strokeColor: '#1b1b1b', strokeWidth: 9, shadow: true,
      align: 'center', letterSpacing: -2, lineHeight: 1.15,
    },
    animationIn: { type: 'bounceIn', duration: 520 },
    transform: { x: 0, y: 0.05, scale: 1, rotation: 3 },
    highlightColor: '#38bdf8',
  },
  {
    // 소곤소곤 — 예능 갈래에서 유일하게 «작고 조용한» 자막. 속마음·독백
    id: 'varietyWhisper',
    name: '소곤소곤',
    style: {
      fontFamily: GAEGU, fontSize: 58, color: '#dbeafe', bold: true,
      strokeColor: '#1e3a8a', strokeWidth: 2,
      align: 'center', letterSpacing: 2, lineHeight: 1.5,
    },
    animationIn: { type: 'blurIn', duration: 600, unit: 'char', staggerMs: 20 },
    transform: { x: 0, y: 0.34, scale: 1, rotation: -1 },
  },
  {
    // 민트 — 파스텔 배경 + 진한 글자. 노랑·빨강 일색인 예능 갈래의 «차분한» 쪽
    id: 'varietyMint',
    name: '민트 강조',
    style: {
      fontFamily: DOHYEON, fontSize: 76, color: '#0f766e',
      backgroundColor: '#ccfbf1',
      align: 'center', letterSpacing: -1, lineHeight: 1.25,
    },
    animationIn: { type: 'popIn', duration: 240 },
    transform: { x: 0, y: 0.24, scale: 1, rotation: -2 },
  },
  {
    // 도장 — 비스듬히 «쾅» 찍히듯 돌면서 들어온다
    id: 'varietyStamp',
    name: '도장 찍기',
    style: {
      fontFamily: BLACK, fontSize: 82, color: '#ffffff',
      strokeColor: '#ff2d55', strokeWidth: 6, shadow: true,
      align: 'center', letterSpacing: -2, lineHeight: 1.1,
    },
    animationIn: { type: 'rotateIn', duration: 400, easing: { bezier: [0.34, 1.4, 0.64, 1] } },
    transform: { x: 0, y: -0.08, scale: 1, rotation: -8 },
  },
  {
    // 카드 뒤집기 — 단어가 하나씩 뒤집히며 나온다 (F8 의 flipY × word)
    id: 'varietyFlip',
    name: '카드 뒤집기',
    style: {
      fontFamily: GOTHIC, fontSize: 80, color: '#f8fafc', bold: true,
      strokeColor: '#7c3aed', strokeWidth: 6, shadow: true,
      align: 'center', letterSpacing: -1, lineHeight: 1.2,
    },
    animationIn: { type: 'flipY', duration: 800, unit: 'word', staggerMs: 90, easing: 'easeInOut' },
    transform: { x: 0, y: 0.1, scale: 1, rotation: 0 },
  },
  {
    // 글자 차례로 — 노랑 임팩트가 글자 단위로 올라온다
    id: 'varietyChase',
    name: '글자 차례로',
    style: {
      fontFamily: BLACK, fontSize: 84, color: '#ffe600',
      strokeColor: '#111111', strokeWidth: 8, shadow: true,
      align: 'center', letterSpacing: -2, lineHeight: 1.15,
    },
    animationIn: { type: 'slideUp', duration: 700, unit: 'char', staggerMs: 28, easing: 'easeOut', distance: 30 },
    transform: { x: 0, y: 0.28, scale: 1, rotation: 0 },
  },
  {
    // 퀴즈 — 파란 판, 화면 위쪽. 질문·자막 퀴즈용
    id: 'varietyQuiz',
    name: '퀴즈 자막',
    style: {
      fontFamily: JUA, fontSize: 66, color: '#ffffff',
      backgroundColor: '#2563eb',
      align: 'center', letterSpacing: 0, lineHeight: 1.4,
    },
    animationIn: { type: 'slideDown', duration: 400, unit: 'line', staggerMs: 120, distance: 60 },
    transform: { x: 0, y: -0.22, scale: 1, rotation: 0 },
    highlightColor: '#fde047',
  },
  {
    // 빨강 경고 — 화면 한가운데를 때리는 굵은 경고. 크기가 줄며 «쿵» 내려앉는다
    id: 'varietyAlert',
    name: '빨강 경고',
    style: {
      fontFamily: DOHYEON, fontSize: 90, color: '#ffffff',
      strokeColor: '#b91c1c', strokeWidth: 10, shadow: true,
      align: 'center', letterSpacing: -2, lineHeight: 1.1,
    },
    animationIn: { type: 'scaleDown', duration: 320, easing: 'easeOut' },
    animationOut: { type: 'fade', duration: 200 },
  },

  // ── 광고 헤드라인 +11 (5 → 16) ───────────────────────────────────────────
  {
    // 흰 바탕 대문짝 — 어두운 영상 위에 흰 판을 깔고 검정으로. adBig 의 반전판
    id: 'adWhite',
    name: '흰 판 헤드라인',
    style: {
      fontFamily: BLACK, fontSize: 110, color: '#111111',
      backgroundColor: '#ffffff',
      align: 'center', letterSpacing: -4, lineHeight: 1.05,
    },
    animationIn: { type: 'wipeUp', duration: 500, unit: 'line', staggerMs: 110, easing: 'easeInOut' },
    transform: { x: 0, y: -0.15, scale: 1, rotation: 0 },
  },
  {
    // 네온 광고 — 자홍 코어에 보라 외곽, 자간을 벌려 사인처럼
    id: 'adNeon',
    name: '네온 광고',
    style: {
      fontFamily: GOTHIC, fontSize: 84, color: '#f0abfc', bold: true,
      strokeColor: '#a21caf', strokeWidth: 3, shadow: true,
      align: 'center', letterSpacing: 4, lineHeight: 1.3,
    },
    animationIn: { type: 'blurIn', duration: 700, unit: 'all' },
    transform: { x: 0, y: -0.05, scale: 1, rotation: 0 },
  },
  {
    // 미니멀 럭셔리 — 미색 판에 검정 명조, 자간 12. 화장품·주얼리
    id: 'adMinimalLux',
    name: '미니멀 럭셔리',
    style: {
      fontFamily: SONG, fontSize: 58, color: '#111111',
      backgroundColor: '#f5f0e6',
      align: 'center', letterSpacing: 12, lineHeight: 1.9,
    },
    animationIn: { type: 'fade', duration: 700 },
    animationOut: { type: 'fade', duration: 500 },
  },
  {
    // 마감 임박 — 빨간 판에 흰 도현체. 초읽기·한정 수량
    id: 'adUrgent',
    name: '마감 임박',
    style: {
      fontFamily: DOHYEON, fontSize: 92, color: '#ffffff',
      backgroundColor: '#dc2626',
      align: 'center', letterSpacing: -1, lineHeight: 1.15,
    },
    animationIn: { type: 'popIn', duration: 260 },
    transform: { x: 0, y: -0.1, scale: 1, rotation: 0 },
    highlightColor: '#fde047',
  },
  {
    // 뱃지 — 화면 위쪽 구석에 붙는 작은 초록 표찰 («신제품»·«무료배송»)
    id: 'adBadge',
    name: '뱃지 표찰',
    style: {
      fontFamily: JUA, fontSize: 54, color: '#ffffff',
      backgroundColor: '#16a34a',
      align: 'center', letterSpacing: 1, lineHeight: 1.25,
    },
    animationIn: { type: 'rotateIn', duration: 350 },
    transform: { x: 0, y: -0.3, scale: 1, rotation: -3 },
  },
  {
    // 테크 — 차가운 회색 글자에 하늘색 외곽, 자간 8. IT·가전
    id: 'adTech',
    name: '테크 헤드라인',
    style: {
      fontFamily: NOTO, fontSize: 72, color: '#e5e7eb', bold: true,
      strokeColor: '#0ea5e9', strokeWidth: 2,
      align: 'center', letterSpacing: 8, lineHeight: 1.4,
    },
    animationIn: { type: 'wipeRight', duration: 600, unit: 'char', staggerMs: 18, easing: 'easeOut' },
    transform: { x: 0, y: -0.06, scale: 1, rotation: 0 },
  },
  {
    // 푸드 — 진갈색 손글씨에 크림색 외곽. 음식·카페
    id: 'adFood',
    name: '푸드 헤드라인',
    style: {
      fontFamily: GAEGU, fontSize: 90, color: '#7c2d12', bold: true,
      strokeColor: '#fff7ed', strokeWidth: 5, shadow: true,
      align: 'center', letterSpacing: -1, lineHeight: 1.25,
    },
    animationIn: { type: 'popIn', duration: 300 },
    transform: { x: 0, y: -0.02, scale: 1, rotation: -2 },
  },
  {
    // 뷰티 — 연분홍 명조, 아주 느리게 스며든다
    id: 'adBeauty',
    name: '뷰티 헤드라인',
    style: {
      fontFamily: MYEONGJO, fontSize: 68, color: '#fdf2f8', bold: true,
      shadow: true, align: 'center', letterSpacing: 10, lineHeight: 1.75,
    },
    animationIn: { type: 'fade', duration: 900 },
    animationOut: { type: 'fade', duration: 600 },
    transform: { x: 0, y: -0.05, scale: 1, rotation: 0 },
  },
  {
    // 스포츠 — 기울인 초대형 흰 글자가 옆에서 날아 들어온다
    id: 'adSports',
    name: '스포츠 헤드라인',
    style: {
      fontFamily: BLACK, fontSize: 100, color: '#ffffff', italic: true,
      strokeColor: '#0f172a', strokeWidth: 10, shadow: true,
      align: 'center', letterSpacing: -4, lineHeight: 1.05,
    },
    animationIn: { type: 'slideLeft', duration: 420, easing: { bezier: [0.19, 1, 0.22, 1] }, distance: 260 },
    transform: { x: 0, y: 0.02, scale: 1, rotation: -3 },
  },
  {
    // 키즈 — 노란 글자에 보라 외곽, 통통 튀며 등장
    id: 'adKids',
    name: '키즈 헤드라인',
    style: {
      fontFamily: JUA, fontSize: 82, color: '#fde047',
      strokeColor: '#7c3aed', strokeWidth: 6, shadow: true,
      align: 'center', letterSpacing: -1, lineHeight: 1.2,
    },
    animationIn: { type: 'bounceIn', duration: 700, unit: 'char', staggerMs: 45 },
    transform: { x: 0, y: -0.03, scale: 1, rotation: 2 },
  },
  {
    // 블랙 프라이데이 — 순검정 판에 흰 글자, 자간 6. 대형 세일
    id: 'adBlackFriday',
    name: '블랙 세일',
    style: {
      fontFamily: BLACK, fontSize: 92, color: '#ffffff',
      backgroundColor: '#000000',
      align: 'center', letterSpacing: 6, lineHeight: 1.2,
    },
    animationIn: { type: 'wipeLeft', duration: 400, easing: 'easeInOut', distance: 0 },
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    highlightColor: '#ff2d55',
  },

  // ── 감성·인용 +7 (5 → 12) ────────────────────────────────────────────────
  {
    // 인용 카드 — 반투명 검정 판 위 명조. quote(판 없음)와 달리 밝은 영상에서도 읽힌다
    id: 'quoteCard',
    name: '인용 카드',
    style: {
      fontFamily: SONG, fontSize: 66, color: '#ffffff',
      backgroundColor: 'rgba(0,0,0,0.25)',
      align: 'center', letterSpacing: 3, lineHeight: 1.8,
    },
    animationIn: { type: 'fade', duration: 600 },
    transform: { x: 0, y: -0.05, scale: 1, rotation: 0 },
  },
  {
    // 시 — 왼쪽 정렬, 행간 2.2. 여러 줄을 세로로 쌓는 유일한 감성 템플릿
    id: 'poem',
    name: '시',
    style: {
      fontFamily: MYEONGJO, fontSize: 46, color: '#e7e5e4',
      shadow: true, align: 'left', letterSpacing: 8, lineHeight: 2.2,
    },
    animationIn: { type: 'slideUp', duration: 900, unit: 'line', staggerMs: 220, easing: 'easeOut', distance: 24 },
    transform: { x: 0, y: 0.05, scale: 1, rotation: 0 },
  },
  {
    // 일기 — 미색 종이 위 손글씨가 단어 단위로 써진다
    id: 'diary',
    name: '일기',
    style: {
      fontFamily: GAEGU, fontSize: 52, color: '#3f3f46',
      backgroundColor: '#fffbeb',
      align: 'left', letterSpacing: 1, lineHeight: 1.7,
    },
    animationIn: { type: 'typewriter', duration: 1600, unit: 'char' },
    transform: { x: 0, y: 0.12, scale: 1, rotation: -1 },
  },
  {
    // 노을 — 살구빛 명조가 초점이 맞듯 또렷해진다
    id: 'sunset',
    name: '노을 감성',
    style: {
      fontFamily: SONG, fontSize: 54, color: '#ffe4c4',
      shadow: true, align: 'center', letterSpacing: 7, lineHeight: 1.85,
    },
    animationIn: { type: 'blurIn', duration: 800, unit: 'all' },
    transform: { x: 0, y: 0.25, scale: 1, rotation: 0 },
  },
  {
    // 영화 타이틀 — 자간 14 의 대문짝 명조. 오프닝·챕터 타이틀
    id: 'cinemaTitle',
    name: '영화 타이틀',
    style: {
      fontFamily: MYEONGJO, fontSize: 88, color: '#f5f5f4', bold: true,
      shadow: true, align: 'center', letterSpacing: 14, lineHeight: 1.5,
    },
    animationIn: { type: 'fade', duration: 1000 },
    animationOut: { type: 'fade', duration: 700 },
    transform: { x: 0, y: -0.1, scale: 1, rotation: 0 },
  },
  {
    // 편지 — 미색 종이에 펜글씨, 왼쪽 정렬
    id: 'letter',
    name: '편지',
    style: {
      fontFamily: PEN, fontSize: 66, color: '#374151',
      backgroundColor: '#fffdf7',
      align: 'left', letterSpacing: 0, lineHeight: 1.6,
    },
    animationIn: { type: 'fade', duration: 500 },
    transform: { x: 0, y: 0.05, scale: 1, rotation: -1 },
  },
  {
    // 이별 — 차가운 회청색이 위에서 내려앉는다. 감성 갈래의 «차가운» 쪽
    id: 'farewell',
    name: '이별',
    style: {
      fontFamily: SONG, fontSize: 50, color: '#cbd5e1',
      align: 'center', letterSpacing: 6, lineHeight: 2.0,
    },
    animationIn: { type: 'slideDown', duration: 800, easing: 'easeOut', distance: 40 },
    animationOut: { type: 'fade', duration: 600 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },

  // ── 손글씨 +4 (4 → 8) ────────────────────────────────────────────────────
  {
    // 마커 — 형광 초록 판에 진한 펜글씨. 밑줄 긋듯 큼직하게
    id: 'penMarker',
    name: '형광 마커',
    style: {
      fontFamily: PEN, fontSize: 96, color: '#111827',
      backgroundColor: '#a7f3d0',
      align: 'center', letterSpacing: 0, lineHeight: 1.25,
    },
    animationIn: { type: 'wipeLeft', duration: 400, easing: 'easeOut', distance: 30 },
    transform: { x: 0, y: 0.2, scale: 1, rotation: -3 },
  },
  {
    // 사인 — 크게 흘려 쓴 서명. 화면 가운데 위쪽에 비스듬히
    id: 'penSign',
    name: '사인',
    style: {
      fontFamily: PEN, fontSize: 110, color: '#ffffff',
      strokeColor: '#0f172a', strokeWidth: 3, shadow: true,
      align: 'center', letterSpacing: 2, lineHeight: 1.2,
    },
    animationIn: { type: 'wipeLeft', duration: 900, unit: 'char', staggerMs: 40, easing: 'easeInOut', distance: 20 },
    transform: { x: 0, y: -0.05, scale: 1, rotation: -8 },
  },
  {
    // 분필 — 칠판 위 흰 개구체. 손글씨 갈래에서 유일한 «어두운 판»
    id: 'gaeguChalk',
    name: '분필 칠판',
    style: {
      fontFamily: GAEGU, fontSize: 64, color: '#f8fafc', bold: true,
      backgroundColor: '#1f2937',
      align: 'left', letterSpacing: 2, lineHeight: 1.55,
    },
    animationIn: { type: 'typewriter', duration: 1400, unit: 'char' },
    transform: { x: 0, y: 0.15, scale: 1, rotation: 0 },
  },
  {
    // 낙서 강조 — 분홍 펜글씨에 흰 외곽, 반대로 기울여 튀어 오른다
    id: 'penScribble',
    name: '낙서 강조',
    style: {
      fontFamily: PEN, fontSize: 84, color: '#ff2d55',
      strokeColor: '#ffffff', strokeWidth: 4, shadow: true,
      align: 'center', letterSpacing: 1, lineHeight: 1.3,
    },
    animationIn: { type: 'bounceIn', duration: 520 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 5 },
    highlightColor: '#ffd400',
  },

  // ── 뉴스·정보 +6 (4 → 10) ────────────────────────────────────────────────
  {
    // 파랑 하단바 — 뉴스 하단바(빨강)의 시사·경제판. 옆에서 밀려 들어온다
    id: 'newsBlue',
    name: '파랑 하단바',
    style: {
      fontFamily: GOTHIC, fontSize: 44, color: '#ffffff', bold: true,
      backgroundColor: '#1d4ed8',
      align: 'left', letterSpacing: 1, lineHeight: 1.35,
    },
    animationIn: { type: 'slideRight', duration: 350, easing: 'easeOut', distance: 200 },
    transform: { x: 0, y: 0.4, scale: 1, rotation: 0 },
  },
  {
    // 이름 자막 — 인터뷰이 이름·직함. 작고 왼쪽 아래에 붙는다
    id: 'newsName',
    name: '이름 자막',
    style: {
      fontFamily: NOTO, fontSize: 42, color: '#ffffff', bold: true,
      backgroundColor: 'rgba(15,23,42,0.9)',
      align: 'left', letterSpacing: 0.5, lineHeight: 1.4,
    },
    animationIn: { type: 'wipeLeft', duration: 380, easing: 'easeOut', distance: 0 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },
  {
    // 수치 카드 — 옅은 회색 판에 짙은 글씨. 통계·비교표
    id: 'statCard',
    name: '수치 카드',
    style: {
      fontFamily: GOTHIC, fontSize: 52, color: '#0f172a', bold: true,
      backgroundColor: '#e2e8f0',
      align: 'left', letterSpacing: 0, lineHeight: 1.55,
    },
    animationIn: { type: 'wipeUp', duration: 500, unit: 'line', staggerMs: 120, easing: 'easeOut' },
    transform: { x: 0, y: 0.1, scale: 1, rotation: 0 },
  },
  {
    // 캡션 — 화면 맨 아래 붙는 작은 회색 주석. 출처·시각 표기
    id: 'caption',
    name: '작은 캡션',
    style: {
      fontFamily: NOTO, fontSize: 36, color: '#9ca3af',
      align: 'left', letterSpacing: 2, lineHeight: 1.4,
    },
    animationIn: { type: 'fade', duration: 200 },
    transform: { x: 0, y: 0.43, scale: 1, rotation: 0 },
  },
  {
    // 경고 — 노란 판에 검정 도현체, 화면 위쪽. 주의 문구
    id: 'warning',
    name: '주의 문구',
    style: {
      fontFamily: DOHYEON, fontSize: 54, color: '#111827',
      backgroundColor: '#fbbf24',
      align: 'center', letterSpacing: 1, lineHeight: 1.35,
    },
    animationIn: { type: 'slideDown', duration: 300, easing: 'easeOut', distance: 50 },
    transform: { x: 0, y: -0.3, scale: 1, rotation: 0 },
  },
  {
    // 챕터 — 판 없는 흰 고딕이 왼쪽에서 닦이며 나온다. 구간 제목
    id: 'chapter',
    name: '챕터 제목',
    style: {
      fontFamily: GOTHIC, fontSize: 64, color: '#ffffff', bold: true,
      shadow: true, align: 'left', letterSpacing: 5, lineHeight: 1.4,
    },
    animationIn: { type: 'wipeLeft', duration: 550, easing: 'easeInOut', distance: 25 },
    animationOut: { type: 'fade', duration: 300 },
    transform: { x: 0, y: -0.2, scale: 1, rotation: 0 },
  },

  // ── 카운트·숫자 +5 (3 → 8) ───────────────────────────────────────────────
  {
    // 타이머 — 반투명 검정 판 위 흰 숫자. 화면 위쪽 고정
    id: 'timer',
    name: '타이머',
    style: {
      fontFamily: NOTO, fontSize: 120, color: '#ffffff', bold: true,
      backgroundColor: 'rgba(0,0,0,0.55)',
      align: 'center', letterSpacing: 4, lineHeight: 1.1,
    },
    animationIn: { type: 'fade', duration: 150 },
    transform: { x: 0, y: -0.25, scale: 1, rotation: 0 },
  },
  {
    // 퍼센트 — 초록 숫자에 짙은 초록 외곽. 성장률·달성률
    id: 'percent',
    name: '퍼센트 강조',
    style: {
      fontFamily: BLACK, fontSize: 150, color: '#22c55e',
      strokeColor: '#052e16', strokeWidth: 8, shadow: true,
      align: 'center', letterSpacing: -6, lineHeight: 1.0,
    },
    animationIn: { type: 'scaleUp', duration: 420, easing: { bezier: [0.34, 1.56, 0.64, 1] } },
    transform: { x: 0, y: 0.05, scale: 1, rotation: 0 },
  },
  {
    // 순위 — 초대형 흰 숫자에 남보라 외곽. 위에서 «쿵» 내려앉는다
    id: 'rank',
    name: '순위 숫자',
    style: {
      fontFamily: GOTHIC, fontSize: 180, color: '#f8fafc', bold: true,
      strokeColor: '#4338ca', strokeWidth: 10, shadow: true,
      align: 'center', letterSpacing: -8, lineHeight: 1.0,
    },
    animationIn: { type: 'scaleDown', duration: 350, easing: 'easeOut' },
    transform: { x: 0, y: -0.05, scale: 1, rotation: 0 },
  },
  {
    // 점수 — 금빛 도현체, 화면 아래쪽. 게임·평점
    id: 'score',
    name: '점수',
    style: {
      fontFamily: DOHYEON, fontSize: 140, color: '#fbbf24',
      strokeColor: '#1c1917', strokeWidth: 8, shadow: true,
      align: 'center', letterSpacing: -4, lineHeight: 1.05,
    },
    animationIn: { type: 'popIn', duration: 300 },
    transform: { x: 0, y: 0.15, scale: 1, rotation: 0 },
  },
  {
    // 할인율 — 진분홍 판에 흰 숫자가 돌면서 박힌다
    id: 'discount',
    name: '할인율',
    style: {
      fontFamily: JUA, fontSize: 170, color: '#ffffff',
      backgroundColor: '#e11d48',
      align: 'center', letterSpacing: -6, lineHeight: 1.05,
    },
    animationIn: { type: 'rotateIn', duration: 420, easing: { bezier: [0.34, 1.4, 0.64, 1] } },
    transform: { x: 0, y: -0.02, scale: 1, rotation: -4 },
  },

  // ── 미니멀 +3 (3 → 6) ────────────────────────────────────────────────────
  {
    // 미니멀 명조 — 고딕 일색인 미니멀 갈래의 세리프판
    id: 'minimalSerif',
    name: '미니멀 명조',
    style: {
      fontFamily: SONG, fontSize: 42, color: '#f5f5f4',
      align: 'center', letterSpacing: 10, lineHeight: 1.9,
    },
    animationIn: { type: 'fade', duration: 500 },
    transform: { x: 0, y: 0.3, scale: 1, rotation: 0 },
  },
  {
    // 미니멀 좌측 상단 — 화면 위 왼쪽 구석에 얌전히. 로고 옆 태그라인
    id: 'minimalLeft',
    name: '미니멀 좌측',
    style: {
      fontFamily: NOTO, fontSize: 38, color: '#e5e7eb',
      align: 'left', letterSpacing: 3, lineHeight: 1.6,
    },
    animationIn: { type: 'slideRight', duration: 400, easing: 'easeOut', distance: 30 },
    transform: { x: 0, y: -0.35, scale: 1, rotation: 0 },
  },
  {
    // 미니멀 어두운 띠 — 반투명 검정 띠에 얇은 흰 글씨 (밝은 띠의 반대판)
    id: 'minimalBand',
    name: '미니멀 어두운 띠',
    style: {
      fontFamily: GOTHIC, fontSize: 36, color: '#ffffff',
      backgroundColor: 'rgba(0,0,0,0.35)',
      align: 'center', letterSpacing: 8, lineHeight: 1.7,
    },
    animationIn: { type: 'wipeRight', duration: 450, easing: 'easeInOut', distance: 20 },
    transform: { x: 0, y: 0.41, scale: 1, rotation: 0 },
  },

  // ── 키네틱 +4 (신규 갈래) ────────────────────────────────────────────────
  // F8 의 「단위 × 움직임」이 들어오면서 생긴 갈래다. 여기 넷은 **움직임이 곧 스타일**이라
  // 위 갈래들과 달리 `unit`·`staggerMs`·`easing` 이 정체성이다.
  {
    // 글자가 하나씩 튀어 오른다 (스프링) — KINETIC_PRESETS 의 charSpring 을 스타일과 묶은 것
    id: 'kineticSpring',
    name: '글자 튀어오르기',
    style: {
      fontFamily: BLACK, fontSize: 84, color: '#ffffff',
      strokeColor: '#111111', strokeWidth: 7, shadow: true,
      align: 'center', letterSpacing: -2, lineHeight: 1.2,
    },
    animationIn: { type: 'springUp', duration: 900, unit: 'char', staggerMs: 30, easing: { spring: { damping: 8 } } },
    transform: { x: 0, y: 0.08, scale: 1, rotation: 0 },
  },
  {
    // 단어가 하나씩 팝 — 예능 톤(노랑·검정)에 단어 시차 70ms
    id: 'kineticWordPop',
    name: '단어 팝',
    style: {
      fontFamily: DOHYEON, fontSize: 76, color: '#ffd400',
      strokeColor: '#1a1a1a', strokeWidth: 8, shadow: true,
      align: 'center', letterSpacing: -1, lineHeight: 1.3,
    },
    animationIn: { type: 'popIn', duration: 700, unit: 'word', staggerMs: 70, easing: { bezier: [0.34, 1.56, 0.64, 1] } },
    transform: { x: 0, y: 0.22, scale: 1, rotation: 0 },
  },
  {
    // 글자마다 초점이 맞는다 — 감성 톤(명조·넓은 자간)에 char 시차 20ms
    id: 'kineticFocus',
    name: '초점 맞추기',
    style: {
      fontFamily: MYEONGJO, fontSize: 70, color: '#f8fafc', bold: true,
      shadow: true, align: 'center', letterSpacing: 6, lineHeight: 1.6,
    },
    animationIn: { type: 'blurIn', duration: 900, unit: 'char', staggerMs: 20, easing: 'easeOut' },
    animationOut: { type: 'fade', duration: 400 },
    transform: { x: 0, y: -0.08, scale: 1, rotation: 0 },
  },
  {
    // 줄이 차례로 밀려 들어온다 — 여러 줄 대사·가사에 쓰는 유일한 line 단위 템플릿
    id: 'kineticLines',
    name: '줄 슬라이드',
    style: {
      fontFamily: GOTHIC, fontSize: 62, color: '#ffffff', bold: true,
      backgroundColor: 'rgba(17,17,17,0.75)',
      align: 'left', letterSpacing: 1, lineHeight: 1.6,
    },
    animationIn: { type: 'slideLeft', duration: 900, unit: 'line', staggerMs: 140, easing: { bezier: [0.19, 1, 0.22, 1] }, distance: 120 },
    transform: { x: 0, y: 0.14, scale: 1, rotation: 0 },
  },
];

/**
 * 갈래 묶음 (W8 F16) — 90개를 평평하게 늘어놓으면 아무도 못 찾는다.
 *
 * `TextTemplate` 에 `group` 필드를 넣지 않은 이유: 그러면 `TextTemplateSchema` 가 바뀌어
 * **저장된 문서·서버 capabilities 의 모양이 달라진다.** 갈래는 «보여 주는 방식»이지
 * 문서에 저장되는 값이 아니므로 여기 목록으로만 둔다.
 * 모든 템플릿이 정확히 한 갈래에 들어가는지는 schema.test.ts 가 검사한다.
 */
export const TEXT_TEMPLATE_GROUPS: readonly { id: string; name: string; templateIds: readonly string[] }[] = [
  { id: 'basic', name: '기본 자막', templateIds: [
    'basic', 'outline', 'boxed', 'softShadow', 'round',
    'basicSerif', 'basicNavy', 'basicPill', 'basicLeft', 'basicWipe'] },
  { id: 'variety', name: '예능·강조', templateIds: [
    'variety', 'pop', 'neon', 'shout', 'highlightBar', 'karaoke',
    'varietyBubble', 'varietyPunch', 'varietyShock', 'varietyWhisper', 'varietyMint',
    'varietyStamp', 'varietyFlip', 'varietyChase', 'varietyQuiz', 'varietyAlert'] },
  { id: 'ad', name: '광고 헤드라인', templateIds: [
    'adBig', 'adYellow', 'adSale', 'adLuxury', 'adCta',
    'adWhite', 'adNeon', 'adMinimalLux', 'adUrgent', 'adBadge', 'adTech', 'adFood',
    'adBeauty', 'adSports', 'adKids', 'adBlackFriday'] },
  { id: 'emotion', name: '감성·인용', templateIds: [
    'quote', 'emotion', 'filmSub', 'lyric', 'moodBand',
    'quoteCard', 'poem', 'diary', 'sunset', 'cinemaTitle', 'letter', 'farewell'] },
  { id: 'hand', name: '손글씨', templateIds: [
    'penNote', 'penSticky', 'gaeguCute', 'gaeguDoodle',
    'penMarker', 'penSign', 'gaeguChalk', 'penScribble'] },
  { id: 'news', name: '뉴스·정보', templateIds: [
    'news', 'typing', 'ticker', 'infoCard',
    'newsBlue', 'newsName', 'statCard', 'caption', 'warning', 'chapter'] },
  { id: 'number', name: '카운트·숫자', templateIds: [
    'countdown', 'bigNumber', 'price',
    'timer', 'percent', 'rank', 'score', 'discount'] },
  { id: 'minimal', name: '미니멀', templateIds: [
    'minimal', 'minimalWide', 'minimalDark',
    'minimalSerif', 'minimalLeft', 'minimalBand'] },
  { id: 'kinetic', name: '키네틱', templateIds: [
    'kineticSpring', 'kineticWordPop', 'kineticFocus', 'kineticLines'] },
];

// ── W8 F8 — 키네틱 타이포 프리셋 (계획 08 §프리셋) ────────────────────────
//
// 「움직임 21종 × 단위 4종」을 드롭다운 두 개로 고르게 하면 아무도 안 쓴다. 이름 붙인 조합을 준다.
// **duration 은 ms 다** — fps 가 계산에 안 들어가므로 24/30/60fps 에서 같은 모양이 나온다.
// 계획서의 12종 그대로다 — 「붓글씨」(`drawStroke`)는 remotion 이 4.0.520 으로 맞춰지면서 들어왔다.
export type KineticPreset = { id: string; name: string; anim: TextAnim };

export const KINETIC_PRESETS: readonly KineticPreset[] = [
  { id: 'charSpring', name: '글자 튀어오르기',
    anim: { type: 'springUp', duration: 900, unit: 'char', staggerMs: 30, easing: { spring: { damping: 8 } } } },
  { id: 'charFlow', name: '글자 흘러들기',
    anim: { type: 'slideUp', duration: 800, unit: 'char', staggerMs: 25, easing: 'easeOut', distance: 24 } },
  { id: 'wordPop', name: '단어 팝',
    anim: { type: 'popIn', duration: 700, unit: 'word', staggerMs: 70, easing: { bezier: [0.34, 1.56, 0.64, 1] } } },
  { id: 'lineSlide', name: '줄 슬라이드',
    anim: { type: 'slideLeft', duration: 900, unit: 'line', staggerMs: 140, easing: { bezier: [0.19, 1, 0.22, 1] } } },
  { id: 'charFocus', name: '초점 맞추기',
    anim: { type: 'blurIn', duration: 700, unit: 'char', staggerMs: 20, easing: 'easeOut' } },
  { id: 'wordFlip', name: '카드 뒤집기',
    anim: { type: 'flipX', duration: 900, unit: 'word', staggerMs: 80, easing: 'easeInOut' } },
  { id: 'wipeAcross', name: '좌→우 닦기',
    anim: { type: 'wipeLeft', duration: 700, unit: 'all', easing: 'easeInOut' } },
  { id: 'wipeLines', name: '줄마다 닦기',
    anim: { type: 'wipeUp', duration: 900, unit: 'line', staggerMs: 100, easing: 'easeOut' } },
  { id: 'typewriter', name: '타자기',
    anim: { type: 'typewriter', duration: 1200, unit: 'char' } },
  { id: 'karaoke', name: '노래방',
    anim: { type: 'wordHighlight', duration: 2000, unit: 'word' } },
  { id: 'brush', name: '붓글씨',
    anim: { type: 'drawStroke', duration: 1600, unit: 'char', staggerMs: 90, easing: 'linear' } },
  { id: 'randomPop', name: '무작위 등장',
    anim: { type: 'scaleUp', duration: 900, unit: 'char', staggerMs: 35, origin: 'random' } },
];

export const SPEED_RAMP_PRESETS: readonly { id: string; name: string; points: SpeedPoint[] }[] = [
  { id: 'montage', name: '몽타주', points: [{ u: 0, speed: 1 }, { u: 0.5, speed: 4 }, { u: 1, speed: 1 }] },
  { id: 'hero', name: '영웅 등장', points: [{ u: 0, speed: 2 }, { u: 0.4, speed: 0.4 }, { u: 1, speed: 2 }] },
  { id: 'bullet', name: '총알 시간', points: [{ u: 0, speed: 1 }, { u: 0.45, speed: 0.2 }, { u: 0.55, speed: 0.2 }, { u: 1, speed: 1 }] },
  { id: 'jumpIn', name: '점프 인', points: [{ u: 0, speed: 4 }, { u: 0.3, speed: 1 }, { u: 1, speed: 1 }] },
  { id: 'flashOut', name: '플래시 아웃', points: [{ u: 0, speed: 1 }, { u: 0.7, speed: 1 }, { u: 1, speed: 5 }] },
  { id: 'slowMo', name: '슬로우 모션', points: [{ u: 0, speed: 1 }, { u: 0.2, speed: 0.3 }, { u: 0.8, speed: 0.3 }, { u: 1, speed: 1 }] },
];
