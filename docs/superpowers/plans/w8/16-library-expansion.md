# F16. 전환·효과·템플릿 확장 (고해성사 #7)

## 무엇을 잘못했나

전환 20종·효과 20종·템플릿 10종(→35종). **이 숫자들에 근거가 없다.** 내가 「이 정도면 되겠지」
하고 계획서에 적은 값이다. CapCut 은 수백 개다.

PRD 의 **P5 「개수보다 시스템」** 을 방패로 썼는데, 그 원칙의 원문은 이렇다:

> 전환 500개가 목표가 아니라, 전환·효과·자막 스타일을 **쉽게 추가할 수 있는 구조**가 목표.
> **개수는 나중에 채운다.**

**「나중에 채운다」의 나중이 지금이다.** 구조는 이미 있다 — 전환은 `transitions.tsx` 의
스타일 함수, 효과는 `effects.ts`+`svg-data.ts`, 템플릿은 `templates.ts` 의 데이터 배열.
**추가 비용이 낮은 구조를 만들어 놓고 개수를 안 채운 것**이 지금 상태다.

## 목표 수와 근거

숫자를 또 임의로 정하지 않기 위해, **광고·쇼츠에서 실제로 쓰는 것**을 갈래로 나누고
갈래마다 필요한 만큼을 채운다.

### 전환 20 → 48

| 갈래 | 지금 | 목표 | 채울 것 |
|---|---|---|---|
| 기본 | fade, blurFade | 4 | + dissolve(디졸브), dipToBlack/White |
| 슬라이드·푸시 | slide 4방향 | 12 | + push 4방향(뒤 클립이 밀어냄), cover/reveal 4방향 |
| 와이프 | wipe 4방향 | 10 | + 대각 4방향, clock(시계), iris(원형 조리개) |
| 줌 | zoomIn/Out | 6 | + zoomBlurIn/Out, whipZoom, punchIn |
| 회전·왜곡 | spin | 5 | + rotateWipe, flip3D(가로/세로), roll |
| 충격·플래시 | whiteFlash, blackFlash, shake, bounce, glitch | 8 | + colorFlash(임의색), rgbSplit, filmBurn, strobe |
| **휩팬** | 없음 | 3 | **whipPanLeft/Right/Up** — 광고 전환의 기본기 (F3-C 의 방향성 블러 필요) |

**전부 CSS transform + clip-path + SVG 필터로 표현 가능한 것만 넣는다.**
표현 불가한 것(파티클·3D 메시)은 넣지 않고 **왜 안 넣었는지 문서에 적는다.**

### 효과 20 → 44

| 갈래 | 지금 | 목표 | 채울 것 |
|---|---|---|---|
| 기본 색 | brightness, contrast, saturation, hue, exposure | 8 | + gamma, shadows/highlights 분리(이미 있음), vibrance, whiteBalance |
| 색감·룩 | temperature, tint, sepia, grayscale, invert | 10 | + bleachBypass, crossProcess, teal&orange, duotone, faded |
| 흐림·선명 | blur, sharpen, glow | 6 | + tiltShift, bokeh, radialBlur, dirBlur(F3-C 재사용) |
| 질감 | grain, scanlines, vignette, lightLeak | 9 | + halation, dust, vhs, chromaAberration(=chromaShift 개명), filmScratch, bloom |
| 왜곡 | chromaShift | 6 | + pixelate, mosaic, mirror, kaleidoscope, wave, crt |
| 스타일 | — | 5 | + posterize, threshold, edgeDetect, emboss, halftone |

**구현 수단별로 분류해 둔다** — CSS filter / SVG 필터 / 오버레이 / WebGL(F15 이후).
**WebGL 이 필요한 것은 F15 완료 후로 미루되, 목록에는 남기고 「대기」로 표시한다.** 빼지 않는다.

### 텍스트 템플릿 35 → 90

지금 8갈래 35종. **갈래마다 「같은 갈래 안에서도 확실히 다른」 변형**을 채운다.

| 갈래 | 지금 | 목표 |
|---|---|---|
| 기본 자막 | 5 | 10 |
| 예능·강조 | 6 | 16 |
| 광고 헤드라인 | 5 | 16 |
| 감성·인용 | 5 | 12 |
| 손글씨 | 4 | 8 |
| 뉴스·정보 | 4 | 10 |
| 카운트·숫자 | 3 | 8 |
| 미니멀 | 3 | 6 |
| **키네틱**(신규, F8 이후) | 0 | 4 |

**F8(키네틱 타이포)이 들어오면 템플릿이 「스타일」에서 「스타일+움직임」으로 넓어진다.**
그래서 F8 을 먼저 하고 템플릿을 채우는 편이 낭비가 없다.

## 품질 규칙 — 개수를 채우면서 지킬 것

1. **색만 바꾼 복제본 금지.** W6 에서 이미 적용한 규칙(중복 검사 테스트)을 유지·강화한다.
2. **전부 렌더해서 눈으로 본다.** 갈래별 컨택트 시트를 만들어 실제로 구분되는지 확인한다.
   W6 에서 이 과정에서 **예능 자막이 새까맣게 나오는 결함**을 찾았다. 안 봤으면 못 찾았다.
3. **전환은 「양쪽 클립」으로 시험한다.** 한 클립만으로는 전환이 어떻게 보이는지 모른다.
4. **효과는 실사·그래픽 두 종류 소스에 각각 걸어본다.** 컬러바에서만 좋아 보이는 효과가 있다.

## 자동화 — 「쉽게 추가할 수 있는 구조」를 실제로 그렇게 만든다

지금은 전환·효과를 추가할 때 **여러 파일을 손으로 고쳐야 한다**
(schema 상수 → renderer 구현 → UI 라벨 → 파라미터 메타 → 테스트).
→ **정의를 한 곳에 모은다:**

```ts
// packages/schema/src/catalog.ts (신규)
export type TransitionDef = {
  id: string; name: string; group: TransitionGroup;
  needs?: ('dirBlur' | 'webgl')[];        // 선행 기능
};
export type EffectDef = {
  id: string; name: string; group: EffectGroup;
  impl: 'css' | 'svg' | 'overlay' | 'webgl';
  params: { key: string; label: string; min: number; max: number; def: number }[];
};
export const TRANSITION_CATALOG: readonly TransitionDef[];
export const EFFECT_CATALOG: readonly EffectDef[];
```
`TRANSITION_TYPES`·`EFFECT_TYPES` 는 이 카탈로그에서 파생시킨다(하위호환 유지).
UI 라벨·파라미터 메타가 **자동으로** 따라오고, 렌더러만 구현하면 된다.

**테스트**: 카탈로그의 모든 항목에 대해 렌더러 구현이 존재하는지 검사 —
빠뜨린 채 목록에만 올리는 것을 막는다.

## 검증
- 카탈로그 ↔ 구현 일대일 대응 테스트(빠짐·잉여 0)
- 전환 48종 각각을 **두 클립 사이에** 걸어 중앙 프레임 렌더 → 컨택트 시트 육안 확인
- 효과 44종을 실사·그래픽 두 소스에 걸어 컨택트 시트 2장
- 템플릿 90종 컨택트 시트 + style 중복 검사
- **「대기」로 표시한 항목(WebGL 필요)이 UI 에서 선택 불가 상태로 나오는지** — 고를 수 있는데
  안 그려지면 안 된다

## 하지 않을 것
- **「구조가 중요하지 개수는 중요하지 않다」로 다시 도망가지 않는다.** PRD 원문이
  「개수는 나중에 채운다」이고 그 나중이 지금이다.
- 표현이 어려운 것을 목록에서 **조용히 빼지 않는다.** 「대기」로 남기고 이유를 적는다.
