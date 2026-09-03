# F7. 베지어·스프링 이징 (고해성사 #7) — S2 의 구현편

## 무엇을 하나

**키프레임 사이를 잇는 「움직임의 성격」을 4종에서 무한대로 넓힌다.** 지금은 「일정하게 ·
점점 빠르게 · 점점 느리게 · 부드럽게」 넷뿐이라, 광고에서 값을 하는 「탁 튀어나왔다가 살짝
되돌아오는」 움직임이 아예 안 나온다. 이 문서는 (a) 임의의 큐빅 베지어 곡선과 (b) 스프링(용수철)
물리 두 가지를 이징 종류로 추가하고, **engine·renderer·ui 세 곳이 같은 함수를 쓰도록 구현을
한 파일로 합치는** 일이다.

이게 W8 에서 **가장 먼저 해야 하는 작업**이다(S2). 이징은 키프레임을 쓰는 모든 기능
— 자막 등장, 마스크 이동, 트래킹 결과, 더킹 곡선 — 의 «움직임 품질»을 한꺼번에 결정한다.
나중에 하면 그 사이에 만든 것들을 전부 다시 손대야 한다.

---

## 왜 「몇 줄이면 된다」인가 — 이미 있는 것

**큐빅 베지어 구현이 이미 두 곳에 있다.** 그것도 **완전히 같은 코드**다.

| 파일 | 줄 | 내용 |
|---|---|---|
| `packages/engine/src/apply.ts` | **163–182** | `cubicBezier(p1x,p1y,p2x,p2y)` — Newton-Raphson 8회 |
| `packages/renderer/src/composition/keyframes.ts` | **7–27** | 위와 **문자 그대로 같은 함수** |

그리고 지금의 4종은 **그 함수의 특정 인자값일 뿐**이다. 두 파일에 똑같이 적혀 있다:

```ts
const EASINGS = {
  linear:    (t) => t,
  easeIn:    cubicBezier(0.42, 0, 1,    1),
  easeOut:   cubicBezier(0,    0, 0.58, 1),
  easeInOut: cubicBezier(0.42, 0, 0.58, 1),
};
```

**즉 임의의 베지어를 받는 데 필요한 새 수학은 0줄이다.** 필요한 건 「문자열이면 표를 찾고,
객체면 그 자리에서 만든다」는 분기 하나뿐이다. 실제 변경은 이렇다:

```ts
// renderer/src/composition/keyframes.ts:59  (지금)
const e = EASINGS[from.easing](u);
// →
const e = easingFn(from.easing)(u);

// engine/src/apply.ts:203  (지금)
return from.value + (to.value - from.value) * EASINGS[from.easing](u);
// →
return from.value + (to.value - from.value) * easingFn(from.easing)(u);
```

**호출부 2줄 교체 + 두 파일에서 중복 구현 약 45줄 삭제 + 공유 모듈 신설.**
전체 코드 양은 스프링을 넣고도 **줄어든다.**

---

## 스프링은 왜 따로 짜야 하나

Remotion 코어에 `spring()` 이 있다(W7 조사 §6 에서 존재 확인). 렌더러는 remotion 에 의존하니
그냥 쓸 수 있다. **그런데 엔진은 못 쓴다.**

```
packages/engine/package.json  dependencies: { "@kitkat/schema": "*" }   ← 그게 전부
packages/schema/package.json  dependencies: { "zod", "nanoid" }
```

엔진은 **remotion(그리고 React·브라우저)에 전혀 의존하지 않는 순수 노드 패키지**다.
그런데 엔진도 이징 값을 계산해야 한다 — `splitClip`·`trimClip` 이 잘린 지점의 값을
**보간해서 경계 키프레임으로 심기** 때문이다(`apply.ts:214-231`). 엔진이 remotion 을 끌어오면
MCP 서버·명령 처리기까지 브라우저 런타임을 끌고 들어온다.

**→ 스프링 적분기를 `packages/schema/src/easing.ts` 에 직접 구현하고 셋이 공유한다.**
schema 는 engine·renderer·ui **셋 다 이미 의존**하는 유일한 공통 패키지다.

### 어떤 물리인가

Remotion 의 `spring()` 과 같은 **감쇠 조화 진동**(용수철에 매달린 추가 마찰을 받으며 흔들리다
멈추는 운동)의 해석해를 쓴다. 파라미터는 Remotion 과 같은 이름·같은 기본값으로 맞춘다:

```
질량 m (mass, 기본 1) · 감쇠 c (damping, 기본 10) · 강성 k (stiffness, 기본 100)

ω₀ = √(k/m)                 고유 진동수 (rad/s)
ζ  = c / (2√(k·m))          감쇠비 — 1 미만이면 튕긴다(오버슈트), 1 이상이면 안 튕긴다

ζ < 1 (부족감쇠):  x(t) = 1 − e^(−ζω₀t) · [ cos(ω_d t) + (ζω₀/ω_d)·sin(ω_d t) ],  ω_d = ω₀√(1−ζ²)
ζ = 1 (임계감쇠):  x(t) = 1 − e^(−ω₀t) · (1 + ω₀t)
ζ > 1 (과감쇠):    두 지수항의 합 (표준 해)
```

기본값 `{mass:1, damping:10, stiffness:100}` → ω₀=10, ζ=0.5 → **부족감쇠, 약 8% 오버슈트.**

### ⚠️ 여기가 판단이 필요했던 지점 — 「초」를 어떻게 「0..1」로 바꾸나

물리 스프링은 **절대 시간(초)** 위에서 정의된다. 그런데 키프레임 이징은
`u = (t − 앞키프레임시각) / (뒤키프레임시각 − 앞키프레임시각)` 이라는 **0..1 진행도**를 받는다.
둘을 잇는 방법이 두 가지고, 결과가 다르다.

| | (A) 진행도 정규화 — **채택** | (B) 실제 초 사용 |
|---|---|---|
| 방식 | `f(u) = x(u · T)`, T = 그 설정의 정착 시간 | `f(u) = x(u · 구간길이초)` |
| 200ms 구간과 2000ms 구간 | **모양이 같다**(빠르게/느리게 재생될 뿐) | 모양이 다르다 |
| 2000ms 구간 | 튕김이 구간 전체에 퍼진다 | 앞 0.5초에 다 끝나고 1.5초가 정지 |
| Remotion `spring()` | ✗ (Remotion 은 B) | ✓ |

**(A)를 쓴다.** 이징은 「두 값 사이를 어떤 성격으로 건너가나」를 말하는 것이고, 그 성격은
구간 길이에 따라 변하면 안 된다. 나머지 3종(linear·easeIn 등)도 전부 (A)다 — 스프링만 (B)면
드롭다운에서 종류만 바꿨는데 움직임의 «길이»가 달라진다.

**정착 시간 T** 는 진폭 포락선 `e^(−ζω₀t)` 가 1e-4 아래로 떨어지는 시각으로 계산한다:
`T = 9.21 / (ζω₀)`. 기본값이면 T=1.84초, 「탄력」(damping 8)이면 ζ=0.4 → T=2.30초.
`overshootClamping:true` 면 처음 1에 닿는 시각을 T 로 한다.

**끝점은 계산이 아니라 규약으로 못 박는다** — `u ≤ 0 → 0`, `u ≥ 1 → 1`.
지금의 `cubicBezier` 도 정확히 그렇게 하고 있다(`keyframes.ts:15-16`). 이렇게 하면 정착이
1e-4 만큼 덜 됐어도 키프레임 경계에서 값이 튀지 않는다.

---

## 스키마 변경 (전부 하위호환 — 기존 문서 그대로 유효)

### `packages/schema/src/index.ts`

```ts
export type SpringConfig = {
  damping?: number;            // 1..200,  기본 10   — 클수록 안 튕긴다
  mass?: number;               // 0.1..10, 기본 1
  stiffness?: number;          // 1..500,  기본 100  — 클수록 빠르다
  overshootClamping?: boolean; // 기본 false — true 면 1을 넘지 않는다
};

export type Easing =
  | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'      // 기존 4종 — 값·의미 불변
  | { bezier: [number, number, number, number] }       // [p1x, p1y, p2x, p2y]
  | { spring: SpringConfig };

export type Keyframe = {
  time: number;
  prop: string;        // ← S1 에서 넓어진다. 이 문서와 독립.
  value: number;
  easing: Easing;      // ← 여기만 바뀐다
};
```

### Zod

```ts
const EasingNameSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);

const BezierEasingSchema = z.object({
  bezier: z.tuple([
    z.number().min(0).max(1),   // p1x — CSS 규격상 0..1
    finiteNum,                  // p1y — 제한 없음 (오버슈트 허용)
    z.number().min(0).max(1),   // p2x
    finiteNum,                  // p2y
  ]),
}).strict();

const SpringEasingSchema = z.object({
  spring: z.object({
    damping:  z.number().min(1).max(200).optional(),
    mass:     z.number().min(0.1).max(10).optional(),
    stiffness:z.number().min(1).max(500).optional(),
    overshootClamping: z.boolean().optional(),
  }).strict(),
}).strict();

const EasingSchema = z.union([EasingNameSchema, BezierEasingSchema, SpringEasingSchema]);
```

**`p1x`·`p2x` 는 조용히 클램프하지 않고 «거부»한다.** 클램프하면 문서에 적힌 값과 실제
움직임이 달라진다 — 나중에 「왜 내가 넣은 값이 안 먹지」의 원인이 된다. UI 가 드래그 중에
0..1 로 막고, 그래도 벗어난 값이 오면 `BAD_KEYFRAME` 으로 튕긴다.

`.strict()` 를 붙이는 이유: `{ bezier: [...], spring: {...} }` 처럼 둘 다 들어간 이상한 값을
막는다. `z.union` 은 앞에서부터 맞는 것을 고르므로 기존 4종 문자열은 **첫 번째 분기에서
그대로** 통과한다 — 기존 문서의 파싱 경로가 한 글자도 안 바뀐다.

---

## 구현

### 1. 신규 — `packages/schema/src/easing.ts`

```ts
export function easingFn(e: Easing): (t: number) => number;
export function easingKey(e: Easing): string;            // 캐시·비교용 정규화 문자열
export function springSettleTimeSec(c: SpringConfig): number;
export const EASING_PRESETS: readonly EasingPreset[];
export type EasingPreset = { id: string; name: string; easing: Easing; note?: string };
```

`index.ts` 에서 재수출한다(schema 의 `exports` 는 `.` 하나뿐이다).

**캐시가 필수다.** 지금 `EASINGS` 는 모듈 수준 상수 표라서 호출당 비용이 0이다.
`easingFn` 이 매번 새 클로저를 만들면 **성능이 퇴행한다.**

```ts
const cache = new Map<string, (t: number) => number>();
export function easingFn(e: Easing): (t: number) => number {
  const key = easingKey(e);                    // 'linear' | 'b:0.42,0,0.58,1' | 's:10,1,100,0'
  let f = cache.get(key);
  if (!f) { f = build(e); cache.set(key, f); }
  return f;
}
```

호출량 감각: 30fps × 30초 × 키프레임 걸린 속성 20개 = **18,000회/렌더**, 미리보기는 60fps.
Map 조회 1회는 무시할 수 있지만 클로저 생성 18,000회는 아니다.

`easingKey` 는 스프링의 생략된 필드를 기본값으로 채워 정규화한다 — `{spring:{}}` 과
`{spring:{damping:10}}` 이 같은 캐시 항목을 쓰게.

### 2. 삭제 — 중복 구현 두 벌

| 파일 | 지울 것 |
|---|---|
| `packages/engine/src/apply.ts` | `cubicBezier`(163–182), `EASINGS`(184–189) |
| `packages/renderer/src/composition/keyframes.ts` | `cubicBezier`(7–27), `EASINGS`(29–33), `type EasingName`(4) |

**이게 「engine 과 renderer 가 갈리지 않게 하는」 진짜 장치다.** 두 벌을 남겨 두고
「대조 테스트로 맞추겠다」고 하면 언젠가 갈린다 — W6 에서 색조정 커브 순서가 갈린 것과
같은 일이다. **구현을 하나로 만들면 갈릴 수가 없다.**

### 3. 호출부 교체 — 3곳

| 파일 | 줄 | 변경 |
|---|---|---|
| `packages/engine/src/apply.ts` | 203 | `EASINGS[from.easing](u)` → `easingFn(from.easing)(u)` |
| `packages/renderer/src/composition/keyframes.ts` | 59 | 같음 |
| `packages/ui/.../inspector-utils.ts` | 171 | `EASING_OPTIONS` 4종 → `EASING_PRESETS` 12종 |

빠른 미리보기(WebGL)는 별도 작업이 **없다** — `packages/ui/src/preview/timing.ts:90` 과
`TextOverlay.tsx:80-84` 가 렌더러의 `interpolateKeyframes` 를 그대로 import 해서 쓰기 때문이다.
한 곳을 고치면 미리보기도 따라온다.

### 4. 대조 테스트 (구현 통합의 «보험»)

구현이 하나여도, 누가 나중에 로컬 사본을 다시 만들 수 있다. 그걸 잡는 테스트를 둔다 —
**이징 함수를 직접 비교하지 않고, 두 패키지의 «입구»를 비교한다.**

```
packages/renderer/test/easing-parity.test.ts
  같은 keyframes 배열에 대해
    engine 쪽 경로  : splitClip 이 경계에 심는 값 (= interpolatePropAt)
    renderer 쪽 경로: interpolateKeyframes(kfs, prop, t, fallback)
  를 t = 0..duration 을 1ms 씩 훑으며 비교 → 전부 `===` (부동소수 오차 허용 없음)
```

---

## 프리셋 12종 — 정확한 값

| id | 이름(UI) | easing | 어디에 쓰나 |
|---|---|---|---|
| `linear` | 일정하게 | `'linear'` | 카메라 팬, 자막 스크롤 |
| `easeIn` | 점점 빠르게 | `'easeIn'` = `(0.42, 0, 1, 1)` | 화면 밖으로 나가기 |
| `easeOut` | 점점 느리게 | `'easeOut'` = `(0, 0, 0.58, 1)` | 화면 안으로 들어오기 |
| `easeInOut` | 부드럽게 | `'easeInOut'` = `(0.42, 0, 0.58, 1)` | 기본값 |
| `material` | 표준(머티리얼) | `{bezier:[0.4, 0, 0.2, 1]}` | UI 성격 움직임 |
| `ios` | 표준(iOS) | `{bezier:[0.25, 0.1, 0.25, 1]}` | 부드러운 전환 |
| `expoOut` | 강한 감속 | `{bezier:[0.19, 1, 0.22, 1]}` | 「탁」 멈추는 등장 |
| `hardStop` | 가속 후 정지 | `{bezier:[0.55, 0, 1, 0.45]}` | 임팩트 컷 |
| `backSoft` | 살짝 튕김 | `{bezier:[0.34, 1.56, 0.64, 1]}` | 자막 팝인 |
| `backHard` | 세게 튕김 | `{bezier:[0.68, -0.6, 0.32, 1.6]}` | 강조 로고 |
| `springSoft` | 스프링(부드럽게) | `{spring:{damping:20}}` | 마스크 따라가기 |
| `springBouncy` | 스프링(탄력) | `{spring:{damping:8}}` | 키네틱 타이포(F8) |

**`backHard` 의 `p1y=-0.6` 은 값이 «반대로 먼저 갔다가» 온다** — 목표가 위쪽이면 아래로 살짝
내려갔다 올라간다. 의도된 값이다(anticipation). `p1x`·`p2x` 만 0..1 이고 y 는 제한이 없다.

---

## UI

### 재사용 — W6 커브 에디터

`packages/ui/src/components/sections/CurvesSection.tsx` 의 SVG 격자 편집기를 그대로 쓴다.
그대로 가져다 쓰는 부분:

| CurvesSection 의 것 | 이징 에디터에서 |
|---|---|
| `toCurve(e)` 화면좌표→커브좌표 (48–56) | y 범위만 바꿔 그대로 |
| `hitTest(c)` 반경 7 안의 점 찾기 (58–70) | 그대로 |
| `setPointerCapture` 드래그 (72–105) | 그대로 |
| CSS 클래스 `insp-curve*` (격자·대각선·점) | 그대로 |
| `useDebouncedCommit` 200ms | 그대로 |

**다른 부분:** 커브 에디터는 점 N개를 지나는 스플라인이고, 이징 에디터는 **끝점 두 개가
(0,0)·(1,1)로 고정된 큐빅 베지어 한 개**다. 그래서

- 드래그 가능한 점은 **정확히 2개**(P1·P2)
- (0,0)→P1, (1,1)→P2 를 잇는 **핸들 선**을 그린다 (표준 cubic-bezier 편집기 모양)
- 곡선 path 는 스플라인이 아니라 `M 0,H C p1 p2 W,0` 한 줄
- **y 축을 −0.5 ~ 1.5 로 넓힌다** — 스프링과 `back*` 프리셋은 곡선이 1을 넘고 0 아래로 내려간다.
  지금 CurvesSection 은 `viewBox="-6 -6 112 112"` 로 0..1 만 담는다. 이징은
  `viewBox="-6 -56 112 212"`(y 를 2배로) + **y=0·y=1 에 기준선 2줄**을 그려 「어디가 목표값인지」를
  보이게 한다.

### 스프링에는 드래그할 점이 없다

스프링은 제어점이 아니라 물리 파라미터다. 그래서:

- 슬라이더 3개 — **감쇠**(damping 1..200, 「튕김 정도」) · **무게**(mass 0.1..10) ·
  **세기**(stiffness 1..500) + **오버슈트 막기** 체크박스
- **같은 SVG 가 곡선을 그린다.** 종류와 무관하게 `easingFn(e)` 를 u=0..1 로 100번 샘플해
  polyline 을 그린다. 베지어면 제어점이 보이고, 스프링이면 슬라이더가 보이고, **그림은 한 곳에서
  같은 방식으로** 나온다.

### 배치

`KeyframesSection` 의 행마다 있는 `<select>`(이징) 을 유지하되 — 12종 프리셋 + 「직접 편집…」 —
「직접 편집…」을 고르면 그 행 아래에 커브 에디터가 펼쳐진다. 프리셋을 고른 뒤 점을 움직이면
자동으로 `{bezier:[...]}` 로 바뀐다(프리셋은 «출발점»이다).

**구간 이징은 «앞» 키프레임에 달린다** — `EASINGS[from.easing]`(양쪽 파일 모두). 그래서 UI 는
「이 키프레임부터 다음 키프레임까지의 성격」이라고 라벨을 단다. 마지막 키프레임의 이징 칸은
비활성(뒤에 구간이 없다)으로 표시한다. **지금은 이게 표시되지 않아 오해를 부른다.**

---

## 검증 — 숫자로 낸다

**1. 회귀 — 기존 4종이 한 자리도 안 변하는지**
`u = 0, 0.001, 0.002, …, 1.000` (1001점)을 기존 구현과 새 구현으로 각각 계산해
**1001/1001 이 `===`(비트 동일)** 이어야 한다. 「오차 1e-9 이내」가 아니라 **완전 일치**다 —
같은 함수를 옮기기만 한 것이므로 한 자리라도 다르면 옮기다 틀린 것이다.

**2. 베지어 등가성**
`{bezier:[0.42,0,0.58,1]}` 이 `'easeInOut'` 과 1001점 전부 `===`.
`{bezier:[0.42,0,1,1]}` = `'easeIn'`, `{bezier:[0,0,0.58,1]}` = `'easeOut'` 도 같이.

**3. 스프링**
- `f(0) === 0`, `f(1) === 1` (규약)
- 기본값(damping 10)에서 `max f(u) > 1` — 오버슈트가 **실제로 있는지**. 예상 최댓값 **약 1.08**
  (ζ=0.5 의 이론 오버슈트 = e^(−πζ/√(1−ζ²)) = 0.163 → 1.163 이 첫 정점이지만 정규화 시간축에서
  샘플링되므로 실측값을 기록한다)
- `{spring:{damping:8}}` 의 최댓값 > 기본값의 최댓값 (탄력 프리셋이 더 튕기는지)
- `overshootClamping:true` 면 `max f(u) ≤ 1`
- `damping:200` (과감쇠)이면 **단조 증가** — 1001점에서 `f(u[i+1]) ≥ f(u[i])` 전부

**4. engine ↔ renderer 일치**
위 §구현 4의 대조 테스트. 12종 프리셋 × 키프레임 5개 × 1ms 단위 전 구간 = 약 **6만 점 전부 `===`**.
**한 점이라도 다르면 실패**다(미리보기와 렌더가 어긋난다는 뜻이므로).

**5. 성능 — 퇴행 금지**
`interpolateKeyframes` 를 100만 회 호출한 시간을 변경 전/후로 잰다.
**5% 이상 느려지면 실패**로 보고 캐시를 고친다. 측정 방법: 키프레임 10개짜리 배열,
`performance.now()` 로 감싸 3회 중앙값.

**6. 문서 왕복**
스프링 이징이 든 문서를 저장 → 로드 → 파싱이 통과하고 값이 동일.
`{bezier:[1.2, 0, 0.5, 1]}` (p1x 범위 밖)은 **거부되고 한국어 메시지**가 나오는지.
`{ bezier:[...], spring:{} }` (둘 다)도 거부되는지.

**7. 눈으로**
12종 프리셋 각각으로 같은 클립(x: 0 → 0.5, 800ms)을 렌더해 **한 장의 비교 GIF**를 만든다.
곡선 그림만 보고 고르는 것과 실제로 움직이는 것을 보고 고르는 것은 다르다.

---

## 하지 않을 것

- **remotion 의 `spring()` 을 엔진에서 import 하지 않는다.** 의존성 방향이 뒤집힌다.
  「일단 렌더러만 스프링을 지원하고 엔진은 나중에」도 안 된다 — 그 순간 `splitClip` 이
  스프링 구간을 잘못 자른다.
- **두 벌 구현을 남기고 「테스트로 맞추겠다」고 하지 않는다.** 삭제한다.
- **기존 4종의 베지어 값을 「더 좋은 값」으로 바꾸지 않는다.** 지금 문서들의 움직임이 조용히
  변한다. 새 값이 좋으면 **새 프리셋으로 추가**한다.
- **오버슈트를 막으려고 이징 결과를 0..1 로 클램프하지 않는다.** 튕김이 사라진다.
  물리적으로 0..1 이어야 하는 값(`opacity`)은 **쓰는 쪽에서** 이미 클램프하고 있다
  (`layout/index.ts:74`, `text.tsx:72` 의 `clamp01`). `scale`·`x`·`y` 는 넘어야 정상이다.
  `volume` 은 `clips.tsx:56` 이 `Math.max(0, v)` 로 음수만 막고 상한은 렌더에서 열려 있다 —
  그대로 둔다.
- **「스프링은 어려우니 베지어만」 하지 않는다.** 스프링 없이는 F8(키네틱 타이포)이
  손으로 만든 `easeOutBack`(`text.tsx:12-16`)에 계속 묶인다.
- **프리셋을 늘려서 「직접 편집」을 대신하지 않는다.** 둘 다 있어야 한다.
