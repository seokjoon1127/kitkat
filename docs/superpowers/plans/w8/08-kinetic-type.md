# F8. 키네틱 타이포그래피

## 무엇을 하나

**글자가 하나씩·단어가 하나씩·줄이 하나씩 살아 움직이는 자막을 만든다.**
지금 텍스트 애니메이션은 5종(`fade` · `slideUp` · `popIn` · `typewriter` · `wordHighlight`)이고,
그중 넷은 **문장 전체가 통째로** 움직인다. 광고 자막에서 「비싸 보이는」 것은 거의 전부
**단위별 시차**(글자마다 30ms 씩 늦게 등장) + **스프링**(살짝 튕기며 자리 잡음) 두 가지의 조합인데,
지금은 둘 다 없다.

**새 npm 패키지 0개로 된다.** 필요한 것은 (a) 스프링 — S2 에서 이미 만든다,
(b) 글자별 `<span>` 스태거 — Remotion 표준 패턴, (c) 와이프 — 기존 `maskStyle()` 이 이미 쓰는 CSS 문법.
**단 하나 예외가 「글자 획이 그려지는 효과」**이고, 그것만 준비물이 따로 있다(아래 §획 그리기).

---

## 표준 패턴 — W7 조사 §6 인용

조사 문서가 확인한 Remotion 표준 패턴은 이렇다:

```tsx
const frame = useCurrentFrame();
chars.map((ch, i) => {
  const p = spring({ frame: frame - i * STAGGER, fps, config: { damping: 200 } });
  return <span style={{ display:'inline-block', opacity:p,
                        transform:`translateY(${(1-p)*40}px)` }}>{ch}</span>;
});
```

> - **`spring()` 은 remotion 코어에 있다**(확인함). `frame` 을 직접 넣는 순수 함수라 되감기·건너뛰기에 안전.
> - 지금 `text.tsx` 가 손으로 구현한 `easeOutBack`(popIn) 을 그대로 대체한다.
> - **⚠️ `fps` 가 필수 인자**라 프로젝트 fps 가 바뀌면 모양이 변한다 → 템플릿에는
>   `durationInFrames` 로 고정하는 편이 안전.

패턴 자체는 맞다. **하지만 이 코드를 그대로 쓰면 안 된다** — 두 가지를 바꾼다.

### 판단 1 — 스프링은 remotion 것이 아니라 S2 공유 모듈에서 온다

`packages/ui/src/preview/TextOverlay.tsx` 는 **일부러 remotion 훅을 안 쓰는 경량 판**이다
(파일 머리주석: *"렌더러 composition/text.tsx 와 같은 CSS 를 쓰고 remotion 훅만 props(tMs)로 바꾼"*).
`spring()` 은 훅이 아니라 순수 함수라 기술적으로는 부를 수 있지만, **그러면 스프링 구현이
두 벌**(remotion 것 + S2 의 `packages/schema/src/easing.ts`)이 된다.
같은 「탄력」이 자막에서와 마스크 이동에서 다르게 움직인다.

**→ 자막 애니메이션도 `easingFn({spring:{...}})` 을 쓴다.** 코드베이스 전체에 스프링이 하나뿐이다.

### 판단 2 — fps 함정은 「durationInFrames 로 고정」이 아니라 「프레임을 안 쓰기」로 푼다

조사 문서의 처방(`durationInFrames` 고정)은 **remotion 의 `spring()` 이 프레임 기반이라서**
나온 것이다. 하지만 kitkat 의 Global Constraints 는 이미 **「프레임 변환은 렌더러에서만 한다」**
이고, `TextClip.animationIn.duration` 은 **이미 ms** 다.

| | remotion `spring({frame, fps})` | **S2 `easingFn({spring})`** |
|---|---|---|
| 입력 | 프레임 번호 + fps | **진행도 `t ∈ [0,1]`** |
| 스태거 단위 | 프레임 (`i * STAGGER`) → 30fps 와 60fps 에서 **다른 시간** | **ms** (`i * staggerMs`) |
| 정착 | 절대 초 — 1초짜리 자막과 3초짜리 자막이 **다르게 보임** | 구간 정규화 — **같게 보임** |
| fps 를 바꾸면 | 모양이 변한다 | **변하지 않는다** |

**fps 가 계산에 아예 안 들어가면 함정이 사라진다.** 템플릿에 `durationInFrames` 를 박는
우회로도 필요 없다 — 템플릿은 지금처럼 ms 로 적는다.

**남는 fps 의존성은 하나뿐이다:** 30fps 에서 33ms 스태거는 프레임당 1글자, 60fps 에서는
2프레임당 1글자다. 이건 **표본화**의 문제이지 모양의 문제가 아니다. 다만
「스태거 30ms 인데 프로젝트가 24fps(=41.7ms/프레임)」이면 여러 글자가 같은 프레임에 나온다.
→ UI 가 `staggerMs < 1000/fps` 일 때 **경고 한 줄**을 띄운다(막지는 않는다).

---

## 애니메이션 설계 — 「단위 × 움직임」 두 축

지금 `TEXT_ANIM_TYPES` 5종은 **움직임 한 축뿐**이라 「글자별 슬라이드업」을 표현할 방법이 없다.
축을 하나 더 세운다.

### 축 1 — 단위 (무엇이 하나씩 움직이나)

| `unit` | 뜻 | 기본 스태거 |
|---|---|---|
| `'all'` | 문장 전체가 한 덩어리 (**기본값 = 지금 동작**) | 0 |
| `'line'` | 줄 단위 | 120ms |
| `'word'` | 단어(공백) 단위 | 60ms |
| `'char'` | 글자 단위 (공백 제외) | 30ms |

### 축 2 — 움직임 (어떻게 나타나나)

`TEXT_ANIM_TYPES` 를 5종 → **21종**으로. **기존 5개 문자열은 값·의미 그대로 둔다.**

| 묶음 | 값 | 설명 |
|---|---|---|
| v1(불변) | `fade` `slideUp` `popIn` `typewriter` `wordHighlight` | 기존 문서 호환 |
| 밀기 | `slideDown` `slideLeft` `slideRight` | `distance` px 만큼 밀려 들어옴 |
| 크기 | `scaleUp` `scaleDown` | 0.6→1 / 1.4→1 |
| 흐림 | `blurIn` | `blur(12px)` → 0. 초점이 맞는 느낌 |
| 회전 | `rotateIn` `flipX` `flipY` | Z 회전 / X·Y 축 3D 뒤집기(`rotateX`) |
| 와이프 | `wipeLeft` `wipeRight` `wipeUp` `wipeDown` | 아래 §와이프 |
| 탄력 | `bounceIn` `springUp` | 기본 이징이 `{spring:{damping:8}}` |
| 획 | `drawStroke` | 아래 §획 그리기 |

**조합은 21 × 4 = 84 가지지만 전부 유효하지는 않다.** 규칙:

| 움직임 | 허용 단위 | 이유 |
|---|---|---|
| `typewriter` | `'char'` 고정 | 정의상 글자 단위 |
| `wordHighlight` | `'word'` 고정 | `words` 타이밍을 쓴다 |
| `drawStroke` | `'char'` · `'all'` | 획은 글자 단위로만 의미가 있다 |
| 나머지 18종 | 4종 전부 | |

**유효 조합 = 18×4 + 3 = 75.** 어긋난 조합은 `BAD_COMMAND` 로 거부하고, UI 는 애초에
안 보여준다.

### 스태거와 duration 의 관계 — 여기가 미묘하다

`duration` 은 지금 **「등장이 끝나는 시각」**이다(`text.tsx:76`: `inVis = clamp01(tMs/duration)`).
스태거를 넣으면 마지막 글자가 `duration` 을 넘겨서 끝날 수 있다 — 그러면 애니메이션이 잘린다.

**→ `duration` 의 의미를 지킨다: 전체가 `duration` 안에 끝난다.**

```
n         = 단위 개수 (글자 수 등)
stagger'  = min(staggerMs, duration * 0.6 / max(1, n-1))     ← 필요하면 스태거를 줄인다
perUnit   = duration - (n-1) * stagger'                       ← 항상 duration 의 40% 이상
p_i       = easingFn(easing)( clamp01( (tMs - i*stagger') / perUnit ) )
```

「글자 40개 × 스태거 30ms = 1170ms」인데 `duration` 이 600ms 면 스태거가 자동으로
`600*0.6/39 = 9.2ms` 로 줄어든다. **자르지 않고 압축한다.** UI 는 실제 적용된 스태거를
회색으로 함께 보여준다.

---

## 스키마 변경 (전부 optional)

```ts
export const TEXT_ANIM_UNITS = ['all', 'line', 'word', 'char'] as const;
export type TextAnimUnit = typeof TEXT_ANIM_UNITS[number];

export type TextAnim = {
  type: TextAnimType;        // 21종
  duration: number;          // ms (의미 불변)
  unit?: TextAnimUnit;       // 기본 'all' — 없으면 지금과 정확히 같은 동작
  staggerMs?: number;        // 기본: 단위별 기본값 (all 0 / line 120 / word 60 / char 30)
  easing?: Easing;           // S2. 기본: 움직임별 기본 이징
  distance?: number;         // slide 계열 이동량 px (높이 1080 기준). 기본 40
  origin?: 'start' | 'end' | 'center' | 'random';  // 스태거 순서. 기본 'start'
};

export type TextClip = ClipBase & {
  kind: 'text'; text: string; style: TextStyle;
  animationIn?: TextAnim;    // ← 타입만 넓어짐
  animationOut?: TextAnim;
  words?: WordTiming[]; highlightColor?: string;
};
```

`{ type, duration }` 만 있는 기존 문서는 `unit:'all'` 로 해석되어 **지금과 완전히 같은 그림**이 나온다.

`origin:'random'` 의 순서는 **클립 id 를 시드로 한 결정적 셔플**이다 — 렌더할 때마다 다르면
미리보기와 렌더가 갈린다.

---

## 구현

### 0. 선행 — 텍스트 레이아웃을 순수 모듈로 뽑는다 (이게 절반이다)

**지금 텍스트 그리기 코드가 두 벌이고, 이미 갈라져 있다.**

| | `renderer/composition/text.tsx` | `ui/preview/TextOverlay.tsx` |
|---|---|---|
| 외곽선 | 31–36줄: `WebkitTextStroke` + **`paintOrder: 'stroke fill'`** | 30–32줄: `WebkitTextStroke` **만** |

`paintOrder` 가 없으면 두꺼운 외곽선의 **절반이 글자 안쪽을 덮어 글자가 뭉개진다**
(text.tsx 주석: *"예능 자막이 새까맣게 나왔다"*). **즉 빠른 미리보기는 지금도 두꺼운 외곽선
자막을 렌더와 다르게 그리고 있다.** 여기에 움직임 21종 × 단위 4종을 두 벌로 얹으면
갈라진 곳이 몇 개인지 셀 수도 없게 된다.

**→ `computeVisualLayout` 이 영상·이미지에 해 주는 일을 텍스트에도 만든다.**

```ts
// packages/renderer/src/layout/text.ts (신규)
export type TextUnitStyle = { key: string; text: string; style: React.CSSProperties };
export type TextLayout = {
  containerStyle: React.CSSProperties;   // translate/scale/rotate/opacity/filter
  textStyle: React.CSSProperties;        // textCss() 결과 — 한 벌만 존재
  wrapperStyles: React.CSSProperties[];  // 전환·애니메이션 래퍼(TransitionWrappers 용)
  units: TextUnitStyle[] | null;         // null = 통짜 텍스트(지금 경로)
  maskStyle?: React.CSSProperties;       // 와이프
};
export function computeTextLayout(args: {
  clip: TextClip; tMs: number; canvasW: number; canvasH: number;
}): TextLayout;
```

`text.tsx` 와 `TextOverlay.tsx` 는 **이걸 호출해서 DOM 으로 옮기기만** 한다.
15-preview-parity.md §"렌더러와 갈리지 않게 하는 장치" 1번(*"수치는 layout 에서만 나온다"*)과
같은 원칙이고, **덤으로 `paintOrder` 어긋남이 고쳐진다.**

### 1. 단위 쪼개기

```ts
// packages/renderer/src/layout/text-split.ts (신규)
export function splitUnits(text: string, unit: TextAnimUnit, lines: string[]): string[];
```

- `'char'`: `[...text]` — **코드포인트 단위**(`split('')` 은 이모지를 깬다). 공백은
  별도 단위로 세지 않되 **자리는 유지**해야 하므로 「보이는 글자」만 스태거 인덱스를 먹는다.
- `'word'`: 공백으로 나눈 뒤 공백을 뒤 단어에 붙여 둔다(줄바꿈 위치 보존).
- `'line'`: **줄 나누기가 필요하다 → 아래 §measureText.**

### 2. 왜 `measureText` 가 필요한가 — 그리고 언제 틀리나

지금 텍스트 상자는 `maxWidth: '90%'` 로 **줄바꿈을 브라우저에 맡긴다**(`text.tsx:139`).
글자별 애니메이션을 넣으면 각 글자가 `display:inline-block` 스팬이 되는데,
**`inline-block` 은 「쪼갤 수 없는 덩어리」라 줄바꿈 규칙이 달라진다.** 한국어 본문은 아무 데서나
꺾이지만 inline-block 사이에서는 그 규칙이 그대로 적용되지 않아, **애니메이션을 켰다는 이유만으로
자막이 다른 줄에서 꺾인다.**

그리고 `unit:'line'` 은 애초에 「어디서 꺾이는지」를 알아야 성립한다.

**→ `@remotion/layout-utils`(MIT)의 `measureText` 로 줄 나누기를 «우리가» 계산한다.**
`{ text, fontFamily, fontSize, fontWeight, letterSpacing }` 를 받는 **순수 함수**라
같은 입력이면 프레임마다·미리보기와 렌더에서 같은 답이 나온다. 그리디 줄바꿈을 직접 돌린다:

```
maxPx = canvasW * 0.90                       ← 지금 maxWidth:'90%' 와 같은 값
줄에 다음 글자를 붙였을 때 measureText(...).width > maxPx 면 줄을 끊는다
```

**⚠️ 폰트가 로드되기 전에 재면 값이 틀린다.** 폴백 폰트(맑은 고딕)의 폭으로 재고,
그 뒤 진짜 폰트가 오면 줄바꿈이 어긋난 채로 남는다.

| 경로 | 지금 상태 | 해야 할 것 |
|---|---|---|
| 렌더 | `TimelineVideo.tsx:24-34` 이 `delayRender('번들 폰트 로딩')` 로 **이미 막아 준다** | 그대로 — 측정은 이 게이트 뒤에서 일어난다 |
| 빠른 미리보기 | **게이트가 없다** (`fontFaceCss` 주입만) | `ensureFontsLoaded(doc)`(`fonts.ts:82`) 를 `await` 하는 상태 플래그를 두고, 준비 전에는 **텍스트 레이어를 그리지 않는다** |

미리보기에서 폰트 준비 전에 `unit:'all'` 로 낮춰 그리는 «부드러운 폴백»은 **안 한다** —
그러면 첫 0.3초 동안 렌더와 다른 그림이 나오고, 그게 정확히 W6 에서 문제가 된 종류의 어긋남이다.
안 그리고 기다린다.

### 3. 와이프 — 두 가지, 둘 다 넣는다

| | 하드 (`clip-path`) | 부드럽게 (`mask-image`) |
|---|---|---|
| CSS | `clipPath: inset(0 ${(1-p)*100}% 0 0)` | `maskImage: linear-gradient(90deg, #000 ${p*100-15}%, transparent ${p*100}%)` |
| 경계 | 칼로 자른 듯 | 15% 폭으로 서서히 |
| 비용 | 가장 쌈 | 쌈 |
| 새 개념인가 | 아니오 | **아니오 — `maskStyle()` 이 이미 이 문법을 쓴다** (`clips.tsx:61-87`) |

두 번째가 기본이다(광고 자막은 부드러운 쪽이 훨씬 많이 쓰인다). `TextAnim` 에 필드를 더
늘리지 않고, `wipeLeft` 계열이 `distance` 를 **그라디언트 폭 %**로 재해석한다(기본 15).

**적용 자리:** 텍스트 요소 자신이 아니라 **`TransitionWrappers` 가 만드는 전체 크기 래퍼**에
건다(`text.tsx:101-110`). 텍스트 요소에 직접 걸면 `transform`(translate/scale/rotate)과 같은
요소에 마스크가 붙어 좌표가 회전과 함께 돈다. 래퍼에 걸면 **화면 기준으로 닦인다** — 사람들이
기대하는 쪽이다. (이 문제 자체는 09-free-mask.md §확인 필요와 같은 뿌리다.)

### 4. 획 그리기(`drawStroke`) — 유일하게 준비물이 있는 것

**목표:** 붓글씨처럼 글자의 획이 그려져 나간다.

원리는 SVG 의 `stroke-dasharray`/`stroke-dashoffset` 이다. 점선 간격을 전체 길이만큼 크게 잡고
오프셋을 0까지 줄이면 선이 그려지는 것처럼 보인다. `@remotion/paths` 의 `evolvePath` 가
정확히 이 두 값을 계산해 준다. **문제는 「글자의 path 를 어디서 얻나」다** —
브라우저는 글리프 외곽선을 노출하지 않는다.

| 방법 | 새 의존성 | path 길이 측정 | 품질 | 판정 |
|---|---|---|---|---|
| a. SVG `<text>` + 직접 dasharray | **0** | **불가** — `getTotalLength()` 는 `SVGGeometryElement` 에만 있고 `<text>` 에는 없다. 길이를 어림해야 한다 | 획이 고르게 안 그려진다. 짧은 글자는 순식간에, 긴 글자는 느리게 | 대충 됨 |
| b. **opentype.js 로 글리프 → path** | **+1 (약 200KB, MIT)** | 정확 | 좋음 | **권장** |
| c. `@remotion/paths` 의 `evolvePath` | 버전 상향 선행 | b 가 준 path 위에서 정확 | 좋음 | **b 와 함께** |

**b + c 로 간다.** a 는 「의존성 0」이라는 이유만으로 품질을 낮추는 선택이라 쓰지 않는다.

- 번들 폰트는 `media/fonts/*.ttf` 11개(`fonts.ts:18-32`)로 **파일이 이미 우리 서버에 있다.**
  opentype.js 가 그 ttf 를 파싱해 `font.getPath(text, x, y, size)` 로 path 를 준다.
- **한글은 획이 많다** — 「값」 한 글자가 서브패스 여러 개다. 자연스러운 순서로 그리려면
  서브패스를 분리해 순서대로 그려야 한다. `@remotion/paths` 의 `getSubpaths` 가 그걸 준다.
- 파싱은 **클립당 1회**(폰트+텍스트가 같으면 캐시). 프레임마다 하면 안 된다.

### 5. ⚠️ 선행 조건 — remotion 패키지 일괄 상향

`@remotion/paths` 와 `@remotion/layout-utils` 는 **4.0.520** 이고,
**이 저장소의 remotion 은 4.0.519 다**(`node_modules/remotion/package.json` 확인).

조사 문서 §5 의 함정이 그대로 적용된다:

> `@remotion/motion-blur@4.0.520` 은 `remotion: '4.0.520'` 을 정확히 핀한다(peer 아님).
> 지금 4.0.519 위에 깔면 **remotion 사본이 둘**이 되어 React 컨텍스트가 갈린다.

`package.json` 들은 `"^4.0.0"` 이라 범위는 넓지만 **lock 이 4.0.519 에 고정**돼 있다.
→ 아래를 **한 번에** 올린다:

```
remotion · @remotion/renderer · @remotion/bundler · @remotion/player
  (packages/renderer/package.json:28-31, packages/ui/package.json:15-16)
+ @remotion/paths · @remotion/layout-utils        ← 신규
전부 같은 정확한 버전으로.
```

**상향 직후 회귀 렌더를 돌린다** — 기존 샘플 프로젝트를 렌더해 픽셀 동일 여부를 확인한다.
상향이 실패하면 `drawStroke` 와 `unit:'line'`(measureText 필요) **둘만** 보류하고
나머지 19종은 그대로 간다. 보류한 것은 문서에 「왜」와 함께 남긴다.

### 6. `easeOutBack` 제거

`text.tsx:12-16` 과 `TextOverlay.tsx:15-19` 에 손으로 짠 `easeOutBack` 이 **두 벌** 있다.
`popIn` 의 기본 이징을 `{bezier:[0.34, 1.56, 0.64, 1]}`(S2 프리셋 `backSoft`)로 바꾸면
**수식이 다르므로 기존 문서의 popIn 이 미세하게 달라진다.**
→ `easeOutBack` 과 **비트 동일한** 값을 내는 전용 이징을 S2 의 프리셋 표에
`legacyBack` 으로 남기고, `popIn` 은 그걸 기본값으로 쓴다. 새 템플릿만 `backSoft` 를 쓴다.
**기존 문서의 움직임은 한 프레임도 바뀌지 않는다.**

---

## UI

### `TextSection` — 두 축을 나란히

지금은 `animationIn.type` 드롭다운 하나다. 셋으로 늘린다:

```
등장    [움직임 21종 ▾]  [단위: 전체 / 줄 / 단어 / 글자 ▾]  [길이 800ms]
        시차 [30]ms   순서 [앞에서부터 ▾]   이징 [스프링(탄력) ▾ ◆]
        (실제 적용된 시차: 9ms — 글자가 많아 자동으로 줄었습니다)
```

- 단위가 `'all'` 이면 **시차·순서 줄이 접힌다**(의미 없는 값을 보여주지 않는다).
- 이징 칸은 F7 의 커브 에디터를 그대로 연다.
- `staggerMs < 1000/fps` 면 노란 경고 한 줄.

### 프리셋 12종 — 조합을 이름으로

75가지 조합을 드롭다운 두 개로 고르게 하면 아무도 안 쓴다. `TEXT_TEMPLATES`(35종, W6)와
같은 방식으로 **이름 붙은 조합**을 준다:

| 이름 | 조합 |
|---|---|
| 글자 튀어오르기 | `springUp` · char · 30ms · `{spring:{damping:8}}` |
| 글자 흘러들기 | `slideUp` · char · 25ms · `easeOut` · distance 24 |
| 단어 팝 | `popIn` · word · 70ms · `backSoft` |
| 줄 슬라이드 | `slideLeft` · line · 140ms · `expoOut` |
| 초점 맞추기 | `blurIn` · char · 20ms · `easeOut` |
| 카드 뒤집기 | `flipX` · word · 80ms · `easeInOut` |
| 좌→우 닦기 | `wipeLeft` · all · — · `easeInOut` |
| 아래서 닦아올리기 | `wipeUp` · line · 100ms · `easeOut` |
| 타자기 | `typewriter` · char (기존) |
| 노래방 | `wordHighlight` · word (기존) |
| 붓글씨 | `drawStroke` · char · 90ms · `linear` |
| 무작위 등장 | `scaleUp` · char · 35ms · origin `random` |

### 미리보기

`TextSection` 의 드롭다운 옆에 **작은 반복 재생 칩**(2초 루프)을 둔다. 21×4 를 타임라인에서
하나씩 확인하게 만들면 아무도 안 쓴다. 칩은 `computeTextLayout` 을 그대로 호출한다 —
**칩과 실제 자막이 같은 함수에서 나온다.**

---

## 검증 — 숫자로 낸다

**1. 기존 문서 불변**
기존 5종을 쓰는 프로젝트를 렌더 → 변경 전과 **픽셀 완전 일치**(PSNR = ∞).
특히 `popIn` — `easeOutBack` 대체가 값에 영향을 주지 않았는지 프레임 단위로.

**2. 미리보기 ↔ 렌더 일치 (이 작업의 핵심 위험)**
75가지 유효 조합 **전부**에 대해, 같은 시각의 프레임을 (a) `renderStill` (b) 빠른 미리보기
캔버스 캡처로 뽑아 비교.
**합격: 평균 채널 차이 ≤ 3, 최대 ≤ 12**(15-preview-parity.md 와 같은 임계).
넘는 조합은 **수치를 그대로 표에 적는다** — 조용히 목록에서 빼지 않는다.

**3. `paintOrder` 회귀 (이미 있던 버그)**
`strokeWidth: 12` 인 자막을 두 경로로 그려 비교. **지금은 실패해야 정상이고**(버그가 있으므로),
`computeTextLayout` 도입 후에는 통과해야 한다. 이 테스트를 먼저 쓴다.

**4. 스태거 수식**
- 글자 40개 · duration 600ms · stagger 30ms → **적용 스태거 9.2ms, perUnit 240ms**,
  마지막 글자가 정확히 600ms 에 끝나는지 (±1ms)
- 마지막 단위의 진행도가 `tMs = duration` 에서 정확히 **1.0**
- `n = 1`(글자 1개)일 때 0으로 나누지 않는지

**5. 줄 나누기 정확도**
`measureText` 로 계산한 줄바꿈 위치와, **브라우저가 실제로 꺾는 위치**를 비교.
한글 20자·40자·80자 × 폰트 9종 × fontSize 3종 = 81 케이스에서
**줄 수가 같고, 각 줄의 글자 수가 같아야 한다. 불일치 0건.**
불일치가 나오면 그리디 알고리즘의 규칙(공백 처리·금칙 문자)을 맞춰야 한다는 신호다.

**6. 폰트 로드 타이밍**
미리보기를 **캐시 비운 상태**로 열어 자막이 (a) 폴백 폰트로 잠깐 보이지 않고
(b) 줄바꿈이 나중에 바뀌지 않는지 — 첫 60프레임을 캡처해 **줄 수가 처음부터 끝까지 동일**한지.

**7. fps 무관성**
같은 프로젝트를 24 / 30 / 60fps 로 렌더해 **같은 절대 시각(예: 400ms)의 프레임**을 비교.
**평균 채널 차이 ≤ 2.** (표본화 차이만 남아야 한다.)

**8. 성능**
글자 60개 × `unit:'char'` 자막 3개가 동시에 있는 1초 구간의 렌더 시간을,
같은 자막을 `unit:'all'` 로 했을 때와 비교. **2배를 넘으면** 스팬 생성·측정 캐시를 고친다.
빠른 미리보기 쪽은 **재생 fps 가 10% 이상 떨어지면 실패**.

**9. `drawStroke`**
「값」·「Hello」 각각에 대해 진행도 0.0 / 0.5 / 1.0 프레임을 뽑아,
**칠해진 픽셀 수가 단조 증가**하고 1.0 에서 정적 텍스트와 **평균 차이 ≤ 3** 인지.

---

## 하지 않을 것

- **텍스트 그리기 코드를 두 벌 유지한 채 21종을 얹지 않는다.** `computeTextLayout` 을 먼저 만든다.
  이미 `paintOrder` 하나가 갈라져 있다.
- **remotion 의 `spring()` 을 자막에만 따로 쓰지 않는다.** 스프링은 코드베이스에 하나다.
- **`@remotion/paths` 를 단독으로 설치하지 않는다.** remotion 사본이 둘이 되어 렌더가
  이상하게 죽는다. 일괄 상향이거나, 아니면 그 기능만 보류다.
- **획 그리기를 「길이를 못 재니 대충 dasharray」로 때우지 않는다.** opentype.js 를 쓰거나,
  못 하면 보류하고 이유를 적는다.
- **폰트가 안 왔을 때 폴백 폰트로 그려 놓고 나중에 바꾸지 않는다.** 기다린다.
- **`unit:'char'` 를 기본값으로 하지 않는다.** 기본은 `'all'` — 기존 문서와 같은 그림이어야 한다.
- **조합 75개 중 어려운 것을 빼고 쉬운 것만 하지 않는다.** 못 하는 것이 생기면
  §검증 2 의 표에 수치와 함께 남긴다.
