// 이징 — engine·renderer·ui 가 «같은 한 벌»을 쓴다 (W8 S2).
//
// 이 파일이 존재하는 이유: 전에는 `cubicBezier`+`EASINGS` 가 engine 과 renderer 에
// **똑같이 두 벌** 있었다. 두 벌을 남기면 언젠가 갈리고(W6 에서 색조정 순서가 갈렸다),
// 갈리는 순간 «미리보기와 렌더가 다르게 나온다». 구현을 하나로 만들면 갈릴 수가 없다.
//
// schema 는 engine·renderer·ui 셋 다 이미 의존하는 유일한 공통 패키지이고,
// zod/nanoid 말고는 아무것도 안 끌어온다 — 엔진(노드 전용 순수 패키지)에서도 안전하다.

export type SpringConfig = {
  damping?: number; // 1..200,  기본 10   — 클수록 안 튕긴다
  mass?: number; // 0.1..10, 기본 1
  stiffness?: number; // 1..500,  기본 100  — 클수록 빠르다
  overshootClamping?: boolean; // 기본 false — true 면 1을 넘지 않는다
};

/** 구간 이징. 기존 4종 문자열은 값·의미가 한 자리도 안 바뀐다(하위호환). */
export type Easing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | { bezier: [number, number, number, number] } // [p1x, p1y, p2x, p2y]
  | { spring: SpringConfig };

export type EasingName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export const EASING_NAMES = ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const;

export const SPRING_DEFAULTS = { damping: 10, mass: 1, stiffness: 100, overshootClamping: false } as const;

// ── 큐빅 베지어 ───────────────────────────────────────────────────────────
// CSS cubic-bezier 와 동일한 방식(Newton-Raphson 8회). engine/renderer 에 있던 코드를
// **한 글자도 바꾸지 않고** 옮겼다 — 기존 4종의 결과값이 변하면 안 되기 때문이다.
export function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
  const a = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
  const b = (a1: number, a2: number) => 3 * a2 - 6 * a1;
  const c = (a1: number) => 3 * a1;
  const calc = (t: number, a1: number, a2: number) => ((a(a1, a2) * t + b(a1, a2)) * t + c(a1)) * t;
  const slope = (t: number, a1: number, a2: number) => 3 * a(a1, a2) * t * t + 2 * b(a1, a2) * t + c(a1);
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const s = slope(t, p1x, p2x);
      if (s === 0) break;
      const err = calc(t, p1x, p2x) - x;
      t -= err / s;
    }
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return calc(t, p1y, p2y);
  };
}

/** 기존 4종의 베지어 제어점 — 이 값은 절대 바꾸지 않는다(문서의 움직임이 조용히 변한다). */
const NAMED_BEZIER: Record<Exclude<EasingName, 'linear'>, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

// ── 스프링 (감쇠 조화 진동) ────────────────────────────────────────────────
// remotion 의 spring() 과 같은 물리를 쓰되 remotion 에 의존하지 않는다(엔진이 못 쓴다).
// 파라미터 이름·기본값은 remotion 과 같다.
//
//   ω₀ = √(k/m)            고유 진동수 (rad/s)
//   ζ  = c / (2√(k·m))     감쇠비 — 1 미만이면 튕긴다(오버슈트)
//
// 시간축은 «진행도 정규화»(A안)다: f(u) = x(u · T), T = 그 설정의 정착 시간.
// 구간 길이가 200ms 든 2000ms 든 «모양»이 같아야 이징 종류를 바꿨을 때 길이가 안 변한다.

function springParams(c: SpringConfig): { w0: number; zeta: number; clamp: boolean } {
  const damping = c.damping ?? SPRING_DEFAULTS.damping;
  const mass = c.mass ?? SPRING_DEFAULTS.mass;
  const stiffness = c.stiffness ?? SPRING_DEFAULTS.stiffness;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  return { w0, zeta, clamp: c.overshootClamping === true };
}

/** x(0)=0, x'(0)=0, x(∞)=1 인 스텝 응답. t 는 «초». */
function springX(t: number, w0: number, zeta: number): number {
  if (t <= 0) return 0;
  if (Math.abs(zeta - 1) < 1e-9) {
    // 임계감쇠 (ζ=1 근처는 아래 식들이 0/0 이 되므로 여기서 처리한다)
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  // 과감쇠 — 두 지수항의 합
  const a = zeta * w0;
  const b = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -a + b;
  const r2 = -a - b;
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/**
 * 정착 시간 T(초) — 진폭 포락선 e^(−ζω₀t) 가 1e-4 아래로 떨어지는 시각 `9.21/(ζω₀)`.
 * overshootClamping 이면 «처음 1에 닿는 시각»을 T 로 잡아 1을 안 넘게 한다.
 */
export function springSettleTimeSec(c: SpringConfig): number {
  const { w0, zeta, clamp } = springParams(c);
  if (clamp && zeta < 1 - 1e-9) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    // cos(θ) + (ζω₀/ω_d)·sin(θ) = 0 의 첫 양의 해 θ = π − atan(ω_d/(ζω₀))
    return (Math.PI - Math.atan(wd / (zeta * w0))) / wd;
  }
  return 9.21 / (zeta * w0);
}

function buildSpring(c: SpringConfig): (t: number) => number {
  const { w0, zeta } = springParams(c);
  const settle = springSettleTimeSec(c);
  return (u: number): number => {
    // 끝점은 «계산이 아니라 규약»이다 — 정착이 덜 됐어도 키프레임 경계에서 값이 튀면 안 된다.
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    return springX(u * settle, w0, zeta);
  };
}

// ── 정규화 키 · 캐시 ──────────────────────────────────────────────────────
// EASINGS 는 모듈 상수 표라서 호출당 비용이 0이었다. easingFn 이 매번 클로저를 만들면
// 30fps × 30초 × 속성 20개 = 18,000회/렌더 만큼 퇴행한다. 그래서 캐시가 «필수»다.

const clampX = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** 캐시·비교용 정규화 문자열. `{spring:{}}` 과 `{spring:{damping:10}}` 은 같은 키다. */
export function easingKey(e: Easing): string {
  if (typeof e === 'string') {
    // 이름 4종을 베지어 키로 정규화한다 → `'easeInOut'` 과 `{bezier:[0.42,0,0.58,1]}` 이
    // «같은 캐시 항목·같은 함수 객체»를 쓰게 되어 갈릴 수가 없다.
    if (e === 'linear') return 'linear';
    const p = NAMED_BEZIER[e];
    return p ? `b:${p[0]},${p[1]},${p[2]},${p[3]}` : 'linear';
  }
  if ('bezier' in e) {
    const [p1x, p1y, p2x, p2y] = e.bezier;
    return `b:${clampX(p1x)},${p1y},${clampX(p2x)},${p2y}`;
  }
  const s = e.spring;
  return `s:${s.damping ?? SPRING_DEFAULTS.damping},${s.mass ?? SPRING_DEFAULTS.mass},${
    s.stiffness ?? SPRING_DEFAULTS.stiffness
  },${s.overshootClamping === true ? 1 : 0}`;
}

function build(e: Easing): (t: number) => number {
  if (typeof e === 'string') {
    if (e === 'linear') return (t) => t;
    const p = NAMED_BEZIER[e];
    return p ? cubicBezier(p[0], p[1], p[2], p[3]) : (t) => t;
  }
  if ('bezier' in e) {
    const [p1x, p1y, p2x, p2y] = e.bezier;
    // x 는 CSS 규격대로 0..1 (문서 단계에서 이미 거부되지만, 직접 호출도 NaN 을 내면 안 된다).
    // y 는 제한하지 않는다 — 오버슈트(back 계열)가 사라진다.
    return cubicBezier(clampX(p1x), p1y, clampX(p2x), p2y);
  }
  return buildSpring(e.spring);
}

const cache = new Map<string, (t: number) => number>();

/** 이징 → `(t:0..1) => 값`. 순수하고 캐시된다(같은 설정이면 같은 함수 객체). */
export function easingFn(e: Easing): (t: number) => number {
  const key = easingKey(e);
  let f = cache.get(key);
  if (!f) {
    f = build(e);
    cache.set(key, f);
  }
  return f;
}

// ── 프리셋 12종 (UI 드롭다운) ─────────────────────────────────────────────

export type EasingPreset = { id: string; name: string; easing: Easing; note?: string };

export const EASING_PRESETS: readonly EasingPreset[] = [
  { id: 'linear', name: '일정하게', easing: 'linear', note: '카메라 팬, 자막 스크롤' },
  { id: 'easeIn', name: '점점 빠르게', easing: 'easeIn', note: '화면 밖으로 나가기' },
  { id: 'easeOut', name: '점점 느리게', easing: 'easeOut', note: '화면 안으로 들어오기' },
  { id: 'easeInOut', name: '부드럽게', easing: 'easeInOut', note: '기본값' },
  { id: 'material', name: '표준(머티리얼)', easing: { bezier: [0.4, 0, 0.2, 1] }, note: 'UI 성격 움직임' },
  { id: 'ios', name: '표준(iOS)', easing: { bezier: [0.25, 0.1, 0.25, 1] }, note: '부드러운 전환' },
  { id: 'expoOut', name: '강한 감속', easing: { bezier: [0.19, 1, 0.22, 1] }, note: '「탁」 멈추는 등장' },
  { id: 'hardStop', name: '가속 후 정지', easing: { bezier: [0.55, 0, 1, 0.45] }, note: '임팩트 컷' },
  { id: 'backSoft', name: '살짝 튕김', easing: { bezier: [0.34, 1.56, 0.64, 1] }, note: '자막 팝인' },
  { id: 'backHard', name: '세게 튕김', easing: { bezier: [0.68, -0.6, 0.32, 1.6] }, note: '강조 로고' },
  { id: 'springSoft', name: '스프링(부드럽게)', easing: { spring: { damping: 20 } }, note: '마스크 따라가기' },
  { id: 'springBouncy', name: '스프링(탄력)', easing: { spring: { damping: 8 } }, note: '키네틱 타이포' },
] as const;
