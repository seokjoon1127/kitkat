// 전환 51종 (v1 8 + W5 12 + W8 F3-C 휩팬 3 + W8 F16 신규 28):
// 클립 시작/끝 구간의 스타일 + 덮개 오버레이 + 전환 래퍼에 거는 SVG 필터 (순수 계산)
//
// **목록의 원천은 `@kitkat/schema` 의 catalog.ts 다.** 여기 있는 것은 «그리는 법»뿐이고,
// 카탈로그에 있는데 여기 구현이 없으면 `catalog-impl.test.ts` 가 실패한다.
import type React from 'react';
import type { Transition, TransitionType } from '@kitkat/schema';

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 소수 4자리 반올림 — 스타일 문자열이 부동소수 잡음으로 길어지는 것 방지. */
function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function easeOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

/** 결정적 의사난수 0..1 — 같은 진행도면 항상 같은 값(프레임 간 지터가 재현된다). */
function hash01(x: number): number {
  const n = Math.sin(x * 127.1) * 43758.5453;
  return n - Math.floor(n);
}

/** circle() 반지름 %가 사각형을 완전히 덮는 값 (대각선/2 ÷ 기준길이 = √2/2). */
export const CIRCLE_FULL_PCT = 70.72;

/** dissolve 의 점 격자 한 칸(px). 1080 높이에서 세로 32칸 — 점이 보이면서 자잘하지 않은 크기. */
export const DISSOLVE_CELL_PX = 60;

/**
 * 전환 진행도. tMs = 클립 시작 기준 ms.
 * - in: 0(클립 시작) → 1(transitionIn 완료). transitionIn 없으면 1.
 * - out: 0(transitionOut 시작 전) → 1(클립 끝). transitionOut 없으면 0.
 */
export function transitionProgress(
  tMs: number,
  clipDurationMs: number,
  transitionIn?: Transition,
  transitionOut?: Transition,
): { in: number; out: number } {
  let pIn = 1;
  if (transitionIn && transitionIn.duration > 0) {
    pIn = clamp01(tMs / transitionIn.duration);
  }
  let pOut = 0;
  if (transitionOut && transitionOut.duration > 0) {
    const begin = clipDurationMs - transitionOut.duration;
    pOut = clamp01((tMs - begin) / transitionOut.duration);
  }
  return { in: pIn, out: pOut };
}

/**
 * 전환 타입 → 스타일. visibility 1 = 완전히 보임, 0 = 완전히 사라짐.
 * translate %는 감싸는 풀사이즈 래퍼 기준.
 */
export function transitionStyle(type: TransitionType, visibility: number): React.CSSProperties {
  const v = clamp01(visibility);
  const gone = 1 - v;
  switch (type) {
    // ── v1 8종 (수식 변경 없음) ──
    case 'fade':
      return { opacity: v };
    case 'slideLeft':
      return { transform: `translateX(${gone * 100}%)` };
    case 'slideRight':
      return { transform: `translateX(${-gone * 100}%)` };
    case 'slideUp':
      return { transform: `translateY(${gone * 100}%)` };
    case 'slideDown':
      return { transform: `translateY(${-gone * 100}%)` };
    case 'wipeLeft':
      return { clipPath: `inset(0 ${gone * 100}% 0 0)` };
    case 'zoomIn':
      return { opacity: v, transform: `scale(${1 - 0.4 * gone})` };
    case 'zoomOut':
      return { opacity: v, transform: `scale(${1 + 0.6 * gone})` };

    // ── W5 12종 ──
    case 'wipeRight':
      return { clipPath: `inset(0 0 0 ${gone * 100}%)` };
    case 'wipeUp':
      return { clipPath: `inset(0 0 ${gone * 100}% 0)` };
    case 'wipeDown':
      return { clipPath: `inset(${gone * 100}% 0 0 0)` };
    case 'circleOpen':
      // 중앙에서 원이 열리며 드러난다
      return { clipPath: `circle(${v * CIRCLE_FULL_PCT}% at 50% 50%)` };
    case 'circleClose': {
      // 바깥에서 원이 조여들며 드러난다 (원 안쪽이 가려진 상태에서 시작)
      const g = `radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${gone * 100}%, #fff ${gone * 100}%)`;
      return { WebkitMaskImage: g, maskImage: g };
    }
    case 'blurFade':
      return { opacity: v, filter: `blur(${gone * 24}px)` };
    case 'whiteFlash':
    case 'blackFlash':
      // 화면은 덮개(activeTransitionOverlays)가 채운다 — 클립 자체는 빠르게 제자리로
      return { opacity: Math.min(1, v * 4) };
    case 'spin':
      return { opacity: v, transform: `rotate(${gone * 180}deg) scale(${1 - 0.6 * gone})` };
    case 'bounce':
      // easeOutBack: 목표를 지나쳤다 되돌아오는 튕김
      return {
        opacity: Math.min(1, v * 3),
        transform: `translateY(${(1 - easeOutBack(v)) * 60}%)`,
      };
    case 'shake': {
      // 진행할수록 잦아드는 좌우 흔들림
      const amp = gone * 8;
      return {
        opacity: Math.min(1, v * 2),
        transform: `translateX(${Math.sin(gone * Math.PI * 6) * amp}%)`,
      };
    }
    case 'glitch': {
      const j = hash01(Math.round(v * 60)) * 2 - 1;
      return {
        opacity: Math.min(1, v * 2.2),
        transform: `translateX(${j * gone * 6}%)`,
        filter: `hue-rotate(${j * gone * 120}deg) saturate(${1 + gone * 2})`,
      };
    }

    // ── W8 F3-C 휩팬 3종 ──
    // 슬라이드보다 **더 멀리서 더 빨리** 들어온다: gone² 이라 시작이 급하고 끝이 부드럽다.
    // 강한 방향성 블러(transitionBlurAxis)가 같이 걸려야 «휩팬» 이 된다 — 블러 없이는
    // 그냥 빠른 슬라이드고, 그게 광고 전환이 싸구려로 보이는 이유다.
    case 'whipPanLeft':
      return { transform: `translateX(${gone * gone * 130}%)` };
    case 'whipPanRight':
      return { transform: `translateX(${-gone * gone * 130}%)` };
    case 'whipPanUp':
      return { transform: `translateY(${gone * gone * 130}%)` };

    // ═══ W8 F16 신규 28종 ═══════════════════════════════════════════════

    // ── 기본 3 ──
    case 'dissolve': {
      // 화면을 정사각 격자로 나눠 **칸마다 원이 자란다.** 페이드(전체 투명도)와 달리 점점이 드러난다.
      // 원의 100% 는 «칸의 가장 먼 모서리»라서 v=1 이면 칸이 완전히 채워진다(빈틈 없음).
      //
      // 칸을 **px 로** 잡는 이유: `mask-size: 5% 5%` 로 하면 9:16 캔버스에서 칸이 27×48 로
      // 길쭉해져 점이 가로로만 붙고 세로로는 구멍이 남는다 — 실제 렌더에서 확인했다
      // (media/w8-f16 컨택트 시트). 정사각 칸이라야 점이 고르게 퍼진다.
      const g =
        `radial-gradient(circle at 50% 50%, #fff ${r4(v * 100)}%, rgba(0,0,0,0) ${r4(v * 100)}%)`;
      return {
        WebkitMaskImage: g, maskImage: g,
        WebkitMaskSize: `${DISSOLVE_CELL_PX}px ${DISSOLVE_CELL_PX}px`,
        maskSize: `${DISSOLVE_CELL_PX}px ${DISSOLVE_CELL_PX}px`,
        WebkitMaskRepeat: 'repeat', maskRepeat: 'repeat',
      };
    }
    case 'dipToBlack':
    case 'dipToWhite':
      // 플래시와 «덮개 곡선»이 다르다: 플래시는 선형으로 금방 걷히고, 디졸브는 덮개가
      // 앞쪽 절반 동안 버틴다(transitionOverlays 의 1.8 배). 그래서 화면이 실제로 한 번 캄캄해진다.
      return { opacity: r4(v) };

    // ── 슬라이드 대각 4 ── (기존 slide 와 같은 규약: 양수 오프셋 = 그 방향에서 들어온다)
    case 'slideUpLeft':
      return { transform: `translate(${r4(gone * 100)}%, ${r4(gone * 100)}%)` };
    case 'slideUpRight':
      return { transform: `translate(${r4(-gone * 100)}%, ${r4(gone * 100)}%)` };
    case 'slideDownLeft':
      return { transform: `translate(${r4(gone * 100)}%, ${r4(-gone * 100)}%)` };
    case 'slideDownRight':
      return { transform: `translate(${r4(-gone * 100)}%, ${r4(-gone * 100)}%)` };

    // ── 스퀴즈 4 ── 와이프처럼 «잘리는» 게 아니라 그림이 눌린다(왜곡된다).
    case 'squeezeLeft':
      return { transform: `scaleX(${r4(v)})`, transformOrigin: '0% 50%' };
    case 'squeezeRight':
      return { transform: `scaleX(${r4(v)})`, transformOrigin: '100% 50%' };
    case 'squeezeUp':
      return { transform: `scaleY(${r4(v)})`, transformOrigin: '50% 0%' };
    case 'squeezeDown':
      return { transform: `scaleY(${r4(v)})`, transformOrigin: '50% 100%' };

    // ── 대각 와이프 4 ── 삼각형 clip-path 가 모서리에서 자란다.
    // 202(=200 아님)인 이유: 200 이면 v=1 에서 반대쪽 모서리가 **정확히 경계선 위**에 놓여
    // 안티에일리어싱 한 줄이 남을 수 있다. 2% 여유를 준다.
    case 'wipeDiagTL': {
      const k = r4(v * 202);
      return { clipPath: `polygon(0% 0%, ${k}% 0%, 0% ${k}%)` };
    }
    case 'wipeDiagTR': {
      const k = r4(v * 202);
      return { clipPath: `polygon(100% 0%, ${r4(100 - k)}% 0%, 100% ${k}%)` };
    }
    case 'wipeDiagBL': {
      const k = r4(v * 202);
      return { clipPath: `polygon(0% 100%, ${k}% 100%, 0% ${r4(100 - k)}%)` };
    }
    case 'wipeDiagBR': {
      const k = r4(v * 202);
      return { clipPath: `polygon(100% 100%, ${r4(100 - k)}% 100%, 100% ${r4(100 - k)}%)` };
    }
    case 'clockWipe': {
      // 시계바늘이 한 바퀴 돈다. 두 번째 정지점의 0deg 는 «앞 정지점까지 당겨진다»(CSS 규격)
      // → v=1 이면 투명 구간의 폭이 0 이라 화면이 통째로 보인다.
      const g = `conic-gradient(from 0deg at 50% 50%, #fff ${r4(v * 360)}deg, rgba(0,0,0,0) 0deg)`;
      return { WebkitMaskImage: g, maskImage: g };
    }

    // ── 줌 4 ── zoomIn/Out 보다 «훨씬 크게» 움직인다 + 블러가 3배 세다(transitionBlurAxis).
    case 'zoomBlurIn':
      return { opacity: r4(Math.min(1, v * 1.5)), transform: `scale(${r4(1 - 0.75 * gone)})` };
    case 'zoomBlurOut':
      return { opacity: r4(Math.min(1, v * 1.5)), transform: `scale(${r4(1 + 1.6 * gone)})` };
    case 'whipZoom':
      // 투명도를 안 건드린다 — «휙» 당겨지는 느낌은 gone² 곡선과 강한 블러에서만 나온다.
      return { transform: `scale(${r4(1 + 3 * gone * gone)})` };
    case 'punchIn':
      // 목표(1배)를 살짝 지나쳤다 되돌아온다 — 블러 없이 «딱» 꽂히는 컷.
      return {
        opacity: r4(Math.min(1, v * 6)),
        transform: `scale(${r4(1 + 0.35 * (1 - easeOutBack(v)))})`,
      };

    // ── 회전 4 ──
    case 'rotateWipe':
      // 왼쪽 아래 모서리를 축으로 문이 열리듯 들어온다 (spin 은 화면 중앙에서 돈다).
      return {
        opacity: r4(Math.min(1, v * 3)),
        transform: `rotate(${r4(-gone * 90)}deg)`,
        transformOrigin: '0% 100%',
      };
    case 'flipHorizontal':
      return {
        transform: `perspective(1200px) rotateY(${r4(gone * 90)}deg)`,
        backfaceVisibility: 'hidden',
      };
    case 'flipVertical':
      return {
        transform: `perspective(1200px) rotateX(${r4(gone * 90)}deg)`,
        backfaceVisibility: 'hidden',
      };
    case 'roll':
      return {
        transform: `translateX(${r4(gone * 100)}%) rotate(${r4(gone * 360)}deg)`,
      };

    // ── 충격 4 ──
    case 'colorFlash':
      // 흰/검정 플래시의 «색만 바꾼 복제»가 아니다: 덮개가 screen 합성이고 클립 자체의
      // 채도·색상이 같이 돈다 — 화면이 하얗게 날아가는 대신 색이 타오른다.
      return {
        opacity: r4(Math.min(1, v * 4)),
        filter: `saturate(${r4(1 + gone * 3)}) hue-rotate(${r4(gone * 60)}deg)`,
      };
    case 'rgbSplit':
      // 그림은 SVG 필터(채널 분리)가 만든다 — transitionSplitPx 참고.
      return { opacity: r4(Math.min(1, v * 3)) };
    case 'filmBurn':
      return {
        opacity: r4(Math.min(1, v * 2.5)),
        filter:
          `sepia(${r4(gone * 0.7)}) brightness(${r4(1 + gone * 0.5)}) contrast(${r4(1 + gone * 0.4)})`,
      };
    case 'strobe':
      // 12등분한 구간마다 켜졌다 꺼진다. 진행도만으로 정해지므로 프레임이 재현된다.
      return { opacity: strobeOn(v) ? 1 : 0.08 };

    default:
      return {};
  }
}

/** strobe 의 «켜짐» 구간 — 진행도를 12등분해 번갈아 켠다 (v=1 은 항상 켜짐). */
function strobeOn(v: number): boolean {
  return Math.floor(clamp01(v) * 12) % 2 === 0;
}

// ── 전환 방향성 블러 (W8 F3-C) ────────────────────────────────────────────

/**
 * 전환 타입 → 블러 방향과 최대 세기. 값은 **캔버스 높이 1080 기준 px 표준편차**로,
 * 실제로는 캔버스 높이에 비례해 늘어난다(같은 전환이 720p·4K 에서 같은 세기로 보이게).
 *
 * `null` 이면 블러 없음 — wipe·circle 처럼 **화면이 안 움직이는** 전환에 방향성 블러를 걸면
 * 움직이지도 않는 그림이 뭉개져서 그냥 초점이 나간 것처럼 보인다.
 */
export function transitionBlurAxis(type: TransitionType): { x: number; y: number } | null {
  switch (type) {
    // 슬라이드 4방향 — 이동 축으로만 번진다
    case 'slideLeft':
    case 'slideRight':
      return { x: 14, y: 0 };
    case 'slideUp':
    case 'slideDown':
      return { x: 0, y: 14 };
    // 줌 — **방사형이 맞지만 SVG 로는 안 된다.** 등방 블러로 근사한다 (계획 03: F15 에서 다시 온다).
    case 'zoomIn':
    case 'zoomOut':
      return { x: 8, y: 8 };
    // 휩팬 — 세기가 슬라이드의 4배 이상이어야 «휙» 지나간 것으로 읽힌다
    case 'whipPanLeft':
    case 'whipPanRight':
      return { x: 60, y: 0 };
    case 'whipPanUp':
      return { x: 0, y: 60 };

    // ── W8 F16 ──
    // 대각 슬라이드 — **근사다.** 45° 로 번져야 맞지만 feGaussianBlur 는 축에 나란한 것만 되고,
    // 각도를 주려면 바깥 래퍼를 rotate(θ)/안쪽을 rotate(-θ) 로 감싸야 하는데 그 래퍼는
    // clips.tsx 소관이다(F8·F9 가 쓰는 파일). 등방 블러로 대신한다 — 줌과 같은 처지다.
    case 'slideUpLeft':
    case 'slideUpRight':
    case 'slideDownLeft':
    case 'slideDownRight':
      return { x: 10, y: 10 };
    // 스퀴즈 — 눌리는 축으로만 번진다
    case 'squeezeLeft':
    case 'squeezeRight':
      return { x: 10, y: 0 };
    case 'squeezeUp':
    case 'squeezeDown':
      return { x: 0, y: 10 };
    // 줌 블러 — zoomIn/Out(8)의 약 3배. 등방 근사인 것은 줌과 같다.
    case 'zoomBlurIn':
    case 'zoomBlurOut':
      return { x: 22, y: 22 };
    case 'whipZoom':
      return { x: 45, y: 45 };
    // 굴러 들어오기 — 가로 이동이 지배적이라 가로로만 번진다
    case 'roll':
      return { x: 18, y: 0 };
    default:
      return null;
  }
}

/**
 * 전환 타입 → **RGB 채널 분리 폭**(캔버스 높이 1080 기준 px). null 이면 안 쓴다.
 * 방향성 블러와 «같은 자리»(전환 래퍼의 `filter: url(#…)`)를 쓰므로 둘은 배타적이다.
 */
export function transitionSplitPx(type: TransitionType): number | null {
  return type === 'rgbSplit' ? 26 : null;
}

/**
 * 블러 강도 곡선 — **전환 중앙에서 1, 양끝에서 0.**
 * 양끝이 0 이어야 한다: 전환이 끝난 순간에도 블러가 남아 있으면 «왜 이 컷만 흐리지» 가 된다.
 */
export function transitionBlurStrength(visibility: number): number {
  const v = clamp01(visibility);
  return 4 * v * (1 - v);
}

/**
 * 전환 래퍼 하나에 걸 SVG 필터. `id` 는 <filter> 의 id 이자 `url(#id)` 참조다.
 * - `kind` 없음/`'dirBlur'` = 방향성 블러. `x`·`y` 는 표준편차(px).
 * - `'rgbSplit'` = R·B 채널을 좌우로 민다. `x` 가 이동 폭(px)이고 `y` 는 안 쓴다.
 */
export type TransitionBlurSpec = { id: string; x: number; y: number; kind?: 'dirBlur' | 'rgbSplit' };

/** σ 가 이보다 작으면 눈에 안 보인다 — <filter> 를 만들지 않는다(항등 필터도 합성 비용이다). */
const MIN_BLUR_PX = 0.2;

/**
 * 현재 시각의 전환 블러 목록. **`activeTransitionStyles` 와 길이·순서가 같다**
 * (같은 조건으로 in → out 순서로 넣는다) — 래퍼 i 에 blurs[i] 를 걸면 짝이 맞는다.
 * 블러가 없는 래퍼 자리에는 `null` 이 들어간다.
 *
 * `scale` = canvasH / 1080.
 */
export function activeTransitionBlurs(
  tMs: number,
  clipDurationMs: number,
  idBase: string,
  scale: number,
  transitionIn?: Transition,
  transitionOut?: Transition,
): (TransitionBlurSpec | null)[] {
  const p = transitionProgress(tMs, clipDurationMs, transitionIn, transitionOut);
  const out: (TransitionBlurSpec | null)[] = [];
  const one = (t: Transition, visibility: number, side: 'in' | 'out'): TransitionBlurSpec | null => {
    const s = transitionBlurStrength(visibility) * Math.max(0, scale);
    const split = transitionSplitPx(t.type);
    if (split !== null) {
      const px = split * s;
      if (px < MIN_BLUR_PX) return null;
      return { id: `tb-${idBase}-${side}`, x: px, y: 0, kind: 'rgbSplit' };
    }
    const axis = transitionBlurAxis(t.type);
    if (!axis) return null;
    const x = axis.x * s;
    const y = axis.y * s;
    if (x < MIN_BLUR_PX && y < MIN_BLUR_PX) return null;
    return { id: `tb-${idBase}-${side}`, x, y };
  };
  if (transitionIn && p.in < 1) out.push(one(transitionIn, p.in, 'in'));
  if (transitionOut && p.out > 0) out.push(one(transitionOut, 1 - p.out, 'out'));
  return out;
}

/** 현재 시각에 적용할 전환 스타일 목록(in/out 각각, 활성 구간일 때만). */
export function activeTransitionStyles(
  tMs: number,
  clipDurationMs: number,
  transitionIn?: Transition,
  transitionOut?: Transition,
): React.CSSProperties[] {
  const p = transitionProgress(tMs, clipDurationMs, transitionIn, transitionOut);
  const styles: React.CSSProperties[] = [];
  if (transitionIn && p.in < 1) styles.push(transitionStyle(transitionIn.type, p.in));
  if (transitionOut && p.out > 0) styles.push(transitionStyle(transitionOut.type, 1 - p.out));
  return styles;
}

// ── 덮개가 필요한 전환 (whiteFlash · blackFlash · glitch) ──────────────────

export type TransitionOverlay = { key: string; style: React.CSSProperties };

const FULL: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' };

/**
 * 전환 덮개 노드. 스타일만으로는 표현이 안 되는 전환(전체 플래시, 글리치 찢김)을
 * 클립 위에 얹는 별도 레이어로 돌려준다. visibility 1 = 전환 끝(덮개 없음).
 */
export function transitionOverlays(type: TransitionType, visibility: number): TransitionOverlay[] {
  const v = clamp01(visibility);
  const gone = 1 - v;
  if (gone <= 0) return [];
  switch (type) {
    case 'whiteFlash':
      return [{ key: 'flash', style: { ...FULL, backgroundColor: '#ffffff', opacity: gone } }];
    case 'blackFlash':
      return [{ key: 'flash', style: { ...FULL, backgroundColor: '#000000', opacity: gone } }];
    case 'glitch': {
      const seed = Math.round(v * 40);
      const b1 = hash01(seed + 11);
      const b2 = hash01(seed + 37);
      const d1 = hash01(seed + 53) * 2 - 1;
      const d2 = hash01(seed + 71) * 2 - 1;
      return [
        {
          key: 'scan',
          style: {
            ...FULL,
            mixBlendMode: 'multiply',
            opacity: gone * 0.55,
            background:
              'repeating-linear-gradient(to bottom, rgba(0,0,0,0.5) 0px, rgba(0,0,0,0.5) 2px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 5px)',
          },
        },
        {
          key: 'tear1',
          style: {
            position: 'absolute',
            left: 0,
            right: 0,
            top: `${b1 * 86}%`,
            height: `${3 + b1 * 5}%`,
            pointerEvents: 'none',
            mixBlendMode: 'screen',
            opacity: gone,
            transform: `translateX(${d1 * 9}%)`,
            background:
              'linear-gradient(90deg, rgba(0,246,255,0) 0%, rgba(0,246,255,0.75) 32%, rgba(0,246,255,0.18) 70%, rgba(0,246,255,0) 100%)',
          },
        },
        {
          key: 'tear2',
          style: {
            position: 'absolute',
            left: 0,
            right: 0,
            top: `${b2 * 86}%`,
            height: `${2 + b2 * 4}%`,
            pointerEvents: 'none',
            mixBlendMode: 'screen',
            opacity: gone,
            transform: `translateX(${d2 * 12}%)`,
            background:
              'linear-gradient(90deg, rgba(255,0,128,0) 0%, rgba(255,0,128,0.7) 40%, rgba(255,0,128,0.15) 78%, rgba(255,0,128,0) 100%)',
          },
        },
      ];
    }

    // ═══ W8 F16 ═══
    case 'dipToBlack':
    case 'dipToWhite': {
      // **플래시와 다른 점은 여기다.** 덮개가 1.8 배 곡선이라 전환 앞쪽 절반 동안 1 에 붙어 있고
      // (=화면이 실제로 캄캄해진다) 뒤쪽 절반에만 걷힌다. whiteFlash 의 덮개는 선형이다.
      const color = type === 'dipToBlack' ? '#000000' : '#ffffff';
      return [{ key: 'dip', style: { ...FULL, backgroundColor: color, opacity: Math.min(1, gone * 1.8) } }];
    }
    case 'colorFlash':
      return [
        {
          key: 'flash',
          style: {
            ...FULL,
            mixBlendMode: 'screen',
            opacity: gone * 0.9,
            background:
              'linear-gradient(120deg, rgba(255,0,140,0.95) 0%, rgba(120,0,255,0.85) 42%, rgba(0,220,255,0.95) 100%)',
          },
        },
      ];
    case 'filmBurn': {
      // 가운데가 하얗게 타들어 가고 가장자리가 주황으로 그을린다.
      const spread = 12 + gone * 78;
      return [
        {
          key: 'burn',
          style: {
            ...FULL,
            mixBlendMode: 'screen',
            opacity: Math.min(1, gone * 1.25),
            background:
              `radial-gradient(circle at 52% 46%, rgba(255,252,235,0.98) 0%, ` +
              `rgba(255,176,64,0.9) ${(spread * 0.45).toFixed(2)}%, ` +
              `rgba(196,58,10,0.55) ${spread.toFixed(2)}%, rgba(0,0,0,0) ${(spread * 1.5).toFixed(2)}%)`,
          },
        },
      ];
    }
    case 'strobe':
      // 꺼진 구간에만 흰 판이 번쩍인다 — 켜진 구간에는 덮개가 없다.
      return strobeOn(v)
        ? []
        : [{ key: 'strobe', style: { ...FULL, backgroundColor: '#ffffff', opacity: gone * 0.9 } }];

    default:
      return [];
  }
}

/** 현재 시각에 얹을 덮개 목록(in/out 각각, 활성 구간일 때만). */
export function activeTransitionOverlays(
  tMs: number,
  clipDurationMs: number,
  transitionIn?: Transition,
  transitionOut?: Transition,
): TransitionOverlay[] {
  const p = transitionProgress(tMs, clipDurationMs, transitionIn, transitionOut);
  const out: TransitionOverlay[] = [];
  if (transitionIn && p.in < 1) {
    for (const o of transitionOverlays(transitionIn.type, p.in)) {
      out.push({ key: `in-${o.key}`, style: o.style });
    }
  }
  if (transitionOut && p.out > 0) {
    for (const o of transitionOverlays(transitionOut.type, 1 - p.out)) {
      out.push({ key: `out-${o.key}`, style: o.style });
    }
  }
  return out;
}
