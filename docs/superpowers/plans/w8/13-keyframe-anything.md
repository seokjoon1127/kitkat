# F13. 색·블러 키프레임 — S1 의 구현편

## 무엇을 하나

**「무엇에 애니메이션을 걸 수 있나」를 6가지에서 클립의 거의 모든 수치로 넓힌다.**
지금 키프레임을 걸 수 있는 것은 `x · y · scale · rotation · opacity · volume` 여섯뿐이라,
「컷 중간에 서서히 밝아지기」·「블러가 점점 풀리며 초점이 맞기」·「마스크가 대상을 따라가기」가
**전부 불가능하다.** `Keyframe.prop` 을 열거형에서 **경로 문자열**(`effects[…].params.amount`
같은)로 바꾸고, 클립 종류별 허용 목록으로 검증한다.

이것이 **F10(마스크 모션 트래킹)의 선행 조건**이다 — 트래킹 결과는 결국
`mask.x`/`mask.y`/`mask.w`/`mask.h` 키프레임으로 들어간다.

---

## 스키마 변경 (전부 하위호환)

### `packages/schema/src/index.ts`

```ts
export type Keyframe = {
  time: number;      // 클립 시작 기준 ms (불변)
  prop: string;      // ← 'x' | 'opacity' | 'effects#e3.params.amount' | 'mask.x' | ...
  value: number;     // (불변)
  easing: Easing;    // ← S2
};
```

Zod: `prop: z.enum([...6종])` → `prop: z.string().min(1).max(120).regex(PATH_RE)`.
**문법에 맞는지는 스키마가, 이 클립에 허용된 경로인지는 엔진이 본다.** 스키마가 클립 종류를
모르기 때문이다(`KeyframeSchema` 는 `clipBaseFields` 안에서 재사용된다).

```ts
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|#[A-Za-z0-9_-]+)*$/;
```

기존 6종(`'x'` 등)은 이 정규식을 그대로 통과한다 — **기존 문서는 한 글자도 안 고친다.**

### 신규 — `packages/schema/src/keyframe-paths.ts`

```ts
export type KeyframePathDef = {
  path: string;          // 'effects#*.params.*' 처럼 * 와일드카드 허용
  label: string;         // UI 한국어
  min?: number; max?: number;
  unit?: 'ratio' | 'px' | 'deg' | 'x';   // UI 표시용
};
export const KEYFRAME_PATHS: Record<Clip['kind'], readonly KeyframePathDef[]>;

export function isKeyframablePath(kind: Clip['kind'], path: string): boolean;
export function keyframePathLabel(kind: Clip['kind'], path: string): string;
export function readPath(obj: unknown, path: string): number | undefined;
export function writePath<T>(obj: T, path: string, value: number): T;   // 구조 공유 복제
```

---

## 허용 경로 화이트리스트 (S1 초안의 완성본)

**아무 경로나 받으면 문서가 깨진다.** 아래가 전부다. 여기 없는 경로는 `BAD_KEYFRAME` 이다.

### 공통 — video · image · text

| 경로 | 라벨 | 범위 | 근거 |
|---|---|---|---|
| `x` | X 위치 | −2..2 | 캔버스 폭 비율. 기존 |
| `y` | Y 위치 | −2..2 | 기존 |
| `scale` | 크기 | 0..10 | 기존 |
| `rotation` | 회전 | 제한 없음 | 도(deg). 여러 바퀴 허용이므로 상한 없음 |
| `opacity` | 불투명도 | 0..1 | 기존 |
| `effects#<id>.params.<name>` | 효과별 | 효과 정의를 따름 | `EFFECT_TYPES` 20종의 숫자 파라미터 전부 |

### video 추가

| 경로 | 라벨 | 범위 |
|---|---|---|
| `volume` | 볼륨 | 0..2 |
| `crop.x` `crop.y` `crop.w` `crop.h` | 크롭 좌/상/너비/높이 | 0..1 |
| `mask.x` `mask.y` `mask.w` `mask.h` | 마스크 위치·크기 | 0..1 |
| `mask.feather` | 마스크 흐림 | 0..1 |
| `chromaKey.similarity` | 크로마키 허용치 | 0..1 |
| `chromaKey.smoothness` | 크로마키 경계 | 0..1 |
| `chromaKey.spill` | 크로마키 물듦 제거 | 0..1 |

### image 추가

`crop.*` · `mask.*` (video 와 동일). `volume` · `chromaKey.*` 없음.

### text 추가

| 경로 | 라벨 | 범위 |
|---|---|---|
| `style.fontSize` | 글자 크기 | 1..500 |
| `style.letterSpacing` | 자간 | −50..200 |
| `style.strokeWidth` | 외곽선 두께 | 0..50 |
| `style.lineHeight` | 줄 간격 | 0.5..3 |

`crop.*` 는 **넣지 않는다** — `TextClip` 이 `ClipBase` 를 상속해서 타입엔 있지만
`computeVisualLayout` 을 타지 않아 텍스트에선 아무 효과가 없다. 걸 수 있는데 아무 일도
안 일어나는 것이 제일 나쁘다.

### audio

`volume` 하나. (기존과 같음)

### 뺀 것과 이유 — 「나중에 추가」가 아니라 「지금 막는다」

| 경로 | 왜 안 되나 |
|---|---|
| `source.*` | **아래 별도 절.** 파일을 굽는 스펙이다 |
| `curves.rgb` 등 | 값이 숫자가 아니라 **점 배열**이다. `Keyframe.value: number` 로 표현 불가 |
| `speed` · `speedRamp.*` | 스키마 불변식 `duration === (out−in)/speed` 를 프레임마다 깬다(`index.ts:405-423`) |
| `start` · `duration` · `in` · `out` | 타임라인 구조. 키프레임 시각 자체의 기준이라 자기참조가 된다 |
| `fadeIn` · `fadeOut` · `transitionIn.duration` | 길이(ms)지 값이 아니다 |
| `blendMode` · `align` · `color` · `mask.invert` · `flipH` | 숫자가 아니다 |

---

## `source.*` 는 왜 금지인가

`ClipSource`(`index.ts:122-127`)는 **ffmpeg 로 클립 전용 파일을 굽는 스펙**이다.
`sourceKey(source)` 가 스펙을 문자열로 정규화하고, 그 키마다 파생 파일이 하나씩 생긴다
(`asset.derived: Record<sourceKey, DerivedMedia>`).

**여기에 키프레임을 걸면 프레임마다 sourceKey 가 달라진다.**
30fps 30초 = **900개의 파생 파일**. 하나에 수십 MB 인 파일이다. C 드라이브 여유가 7GB 대인
이 컴퓨터에서는 첫 클립에서 디스크가 찬다.

**막는 자리 3곳:**
1. `KEYFRAME_PATHS` 에 `source.*` 가 아예 없다 → `isKeyframablePath` 가 false
2. `doSetKeyframes` 가 `source.` 로 시작하는 경로에 **전용 메시지**를 낸다:
   `'source.lut.intensity 는 키프레임을 걸 수 없습니다 — 이 값은 영상 파일을 새로 굽는 설정이라
    프레임마다 바뀌면 파일이 수백 개 생깁니다. 대신 effects 의 색 파라미터에 거세요.'`
3. UI 의 `SourceSection` 필드에는 **키프레임 버튼이 아예 붙지 않고**, 섹션 아래
   한 줄 안내를 둔다 — 「이 설정들은 영상 파일을 다시 만드는 설정이라 시간에 따라 바꿀 수
   없습니다」.

**「나중에 완화」의 여지를 남기지 않는다.** 완화하려면 파생 파일 캐시 자체를 다시 설계해야 한다.

---

## 판단이 필요했던 지점 — `effects[N]` 이 아니라 `effects#<id>`

**S1 초안은 `effects[N].params.*` 였다. 이걸 바꿔야 한다.**

`packages/ui/src/components/sections/EffectsSection.tsx:2` 에 이렇게 적혀 있다:

> 전부 updateClip으로 effects 배열을 통째로 patch한다 (개별 addEffect 명령은 없음).

**즉 효과 하나를 지우면 뒤의 효과들의 인덱스가 전부 하나씩 당겨진다.**
`effects[1].params.amount` 에 걸어 둔 「점점 흐려지기」가 `effects[0]` 을 지운 순간
**말없이 다른 효과에 붙는다.** 밝기 키프레임이 갑자기 채도를 흔든다.

| | `effects[N]` (S1 초안) | **`effects#<id>` (권장)** |
|---|---|---|
| 효과 삭제·재배열 | **조용히 다른 효과를 가리킨다** | 안전 |
| 대상 효과 삭제 시 | 다른 효과로 잘못 붙음 | 가리키는 게 없어져 **무동작**(UI 가 「대상 없음」 표시) |
| 파서 | `[0-9]+` | `#[A-Za-z0-9_-]+` 토큰 하나 추가 |
| 대안 | `doUpdateClip` 이 배열 패치마다 경로를 다시 써준다 (~20줄, 놓치기 쉽다) | 필요 없음 |

`Effect.id` 는 이미 스키마에 있다(`{ id: string; type; params }`, `index.ts:54`).
**S1 을 바꾸는 것이므로 승인이 필요하다.** 승인 전이면 `effects[N]` 로 진행하되
경로 재작성 코드를 반드시 함께 넣는다 — 둘 중 하나는 해야 한다.

문법:

```
path := seg ( '.' seg | '[' 정수 ']' | '#' id )*
seg  := [A-Za-z_][A-Za-z0-9_]*
id   := [A-Za-z0-9_-]+          ← 배열 원소를 그 원소의 .id 필드로 고른다
```

`[정수]` 는 지금 화이트리스트에 쓰이는 곳이 없지만 문법에는 남긴다(파서 15줄).

---

## 구현

### 1. 경로 읽기·쓰기 — `packages/schema/src/keyframe-paths.ts`

**토크나이저** — 정규식 하나로 훑는다. 문자열 대괄호·따옴표·중첩은 없다(문법에 없다).

```ts
type Token = { kind: 'key'; v: string } | { kind: 'idx'; v: number } | { kind: 'id'; v: string };
function tokenize(path: string): Token[] | null;   // 문법 위반이면 null
```

**`readPath(obj, path)`** — 토큰을 따라 내려가며 없으면 `undefined`.
마지막 값이 `typeof v === 'number' && Number.isFinite(v)` 가 아니면 `undefined`.

**`writePath(obj, path, value)`** — **구조 공유 복제**. 경로에 걸린 객체만 얕은 복제하고
나머지는 원래 참조를 그대로 쓴다. `effects` 배열에 쓰면 배열 1개 + 해당 Effect 1개 +
`params` 1개만 새로 만들어진다.

**부모가 없으면 어떻게 하나 — 규칙을 못 박는다:**

| 경우 | 동작 |
|---|---|
| `transform` 이 없는데 `x` 키프레임 | `{x:0, y:0, scale:1, rotation:0}` 을 **만들어서** 쓴다 (기본값이 명확) |
| `mask` 가 없는데 `mask.x` 키프레임 | **아무것도 안 한다.** 마스크가 없으면 위치도 없다 |
| `chromaKey` · `crop` · `effects#<없는 id>` | 같음 — 무동작 |

부모를 만들어 주는 것은 **`transform` 하나뿐**이다. 표로 3줄이면 되고, 예외를 늘리지 않는다.
가리키는 대상이 사라진 키프레임은 **문서에 남아 있되 무동작**이고, UI 가 회색으로
「대상 없음」이라고 표시한다. (마스크를 잠시 껐다 켜면 키프레임이 살아 돌아온다.)

### 2. 한 곳에서 전부 통과시키기 — `applyKeyframes`

**지금은 5개 파일에서 17번 개별 호출한다:**

| 파일 | 줄 | 호출 |
|---|---|---|
| `packages/renderer/src/layout/index.ts` | 70–74 | x · y · scale · rotation · opacity |
| `packages/renderer/src/composition/text.tsx` | 68–72 | x · y · scale · rotation · opacity |
| `packages/ui/src/preview/TextOverlay.tsx` | 80–84 | x · y · scale · rotation · opacity |
| `packages/renderer/src/composition/clips.tsx` | 52 | volume |
| `packages/ui/src/preview/timing.ts` | 90 | volume |

경로가 40개로 늘면 이 방식은 **40 × 5 = 200줄**이 된다. 그리고 한 군데를 빠뜨리면
미리보기와 렌더가 갈린다.

**→ 세 소비자 «밑»에 함수 하나를 둔다.**

```ts
// packages/renderer/src/composition/keyframes.ts (기존 파일에 추가)
/** tMs 시점의 값들이 이미 반영된 클립을 돌려준다. 키프레임이 없으면 «같은 객체»를 그대로 돌려준다. */
export function applyKeyframes<T extends Clip>(clip: T, tMs: number): T;
```

```ts
// layout/index.ts — 70~74줄이 이렇게 바뀐다
const c = applyKeyframes(clip, tMs);
const tr = c.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
const { x, y, scale, rotation } = tr;
const opacity = clamp01(c.opacity ?? 1);
// ...이하 전부 c.mask / c.crop / c.effects / c.chromaKey 를 «그냥 읽는다»
```

**「한 곳」의 정확한 의미:** 호출 지점은 여전히 셋이다(시각 클립 · 텍스트 · 오디오 볼륨 —
이건 구조상 합칠 수 없다). 합쳐지는 것은 **「키프레임이 무엇을 하는가」를 아는 코드**다.
그게 한 함수에 있으면, 새 경로를 추가할 때 고칠 곳이 **화이트리스트 한 줄**뿐이다.

**성능 규칙 2가지 (안 지키면 퇴행한다):**

1. **키프레임이 없으면 할당 0.** `if (!clip.keyframes?.length) return clip;` 이 첫 줄이다.
   대다수 클립이 여기서 끝난다.
2. **경로별 묶음을 캐시한다.** 지금 `interpolateKeyframes` 는 호출마다
   `kfs.filter(...).sort(...)` 를 돌린다(`keyframes.ts:47`). 키프레임 10개면 무시할 수 있지만,
   **F10 트래킹은 30초 클립에 3,600개**(900프레임 × 4경로)를 만든다.
   그러면 프레임당 `3600×4` 필터 + 정렬 → 30초 렌더에서 **약 1,300만 번의 비교**.

   ```ts
   const grouped = new WeakMap<Keyframe[], Map<string, Keyframe[]>>();
   ```
   `clip.keyframes` 배열 참조는 한 렌더 동안 불변이므로 WeakMap 키로 완벽하다.
   묶기는 클립당 1회. **필수다.**

`interpolateKeyframes(kfs, prop, tMs, fallback)` 자체는 **그대로 둔다** — 이미 `prop` 을
문자열로만 비교하므로 경로 문자열에서 그대로 동작한다. `applyKeyframes` 가 이걸 경로마다 부른다.

### 3. 엔진 — 검증만 교체

```ts
// apply.ts:526 (지금)
const allowed = KEYFRAME_PROPS[clip.kind];
if (!allowed.includes(kf.prop)) fail('BAD_KEYFRAME', ...);
// →
if (!isKeyframablePath(clip.kind, kf.prop)) fail('BAD_KEYFRAME', <경로별 안내>);
```

추가로 **설정 시점에 대상이 실재하는지도 본다** — `readPath(clip, kf.prop) === undefined` 면
거부한다. 오타(`mask.wdith`)와 「마스크를 안 켜고 마스크 키프레임을 걸기」를 잡는다.
(나중에 마스크를 지워서 무동작이 되는 것은 §1 규칙대로 허용한다 — 그걸 막으면
마스크를 끄는 순간 문서가 무효가 된다.)

`KEYFRAME_PROPS` 는 **UI 가 import 하고 있으므로**(`KeyframesSection.tsx:5`) 바로 지우지 말고
`KEYFRAME_PATHS` 로 대체한 뒤 제거한다.

### 4. `splitClip` · `trimClip` — 수정 불필요 (근거)

**코드를 읽어 확인했다. `prop` 을 문자열로만 다룬다.**

| 함수 | 줄 | `prop` 을 어떻게 쓰나 |
|---|---|---|
| `splitKeyframes` | `apply.ts:214` | `new Set(kfs.map(k => k.prop))` — 값이 뭐든 **구별만** 한다 |
| | `apply.ts:215` | `kfs.filter(k => k.prop === prop)` — **문자열 동등 비교** |
| | `apply.ts:219-221` | 경계값을 `interpolatePropAt` 로 구해 `{time, prop, value, easing}` 로 심는다 |
| `rebaseKeyframes` | `apply.ts:237-241` | `time` 만 더하고 뺀다. `prop` 은 손대지 않는다 |
| `interpolatePropAt` | `apply.ts:191-206` | `prop` 을 아예 안 본다(이미 걸러진 배열을 받는다) |

**열거형에 의존하는 코드가 한 줄도 없다.** 그래서 `effects#e3.params.amount` 에 대해서도
「분할점에 경계 키프레임을 심어 진행 중이던 램프를 보존하는」 동작이 그대로 성립한다.

단 하나 확인할 것: 경계 삽입 루프가 **구별되는 prop 수만큼** 배열을 훑는다
(`apply.ts:214-224`). 경로 40개면 40회. 분할은 사용자 조작당 1회이므로 문제없다.
**이걸 §검증 4에서 무작위 테스트로 못 박는다.**

---

## UI

### 어떤 값 옆에 「키프레임 추가」가 붙나

`packages/ui/src/components/sections/fields.tsx` 의 `NumberField`·`SliderField` 에
**선택 속성 하나**를 더한다:

```tsx
<SliderField label="밝기" value={...} kfPath={`effects#${fx.id}.params.amount`} />
```

`kfPath` 가 있으면 필드 오른쪽에 **작은 마름모 버튼(◆)** 이 붙는다. Premiere·After Effects 와
같은 관습이다. 상태 3가지:

| 모양 | 뜻 | 누르면 |
|---|---|---|
| ◇ 빈 마름모 | 이 값에 키프레임 없음 | 재생헤드 위치에 **현재 값으로** 첫 키프레임 추가 |
| ◆ 채운 마름모 | 재생헤드에 키프레임 **있음** | 그 키프레임 삭제 |
| ◈ 테두리만 | 키프레임은 있지만 재생헤드엔 없음 | 재생헤드 위치에 현재 보간값으로 추가 |

버튼이 붙는 곳 (전수):

| 섹션 | 필드 |
|---|---|
| `CommonSection` | X · Y · 크기 · 회전 · 불투명도 · 크롭 4개 |
| `EffectsSection` | **효과마다 숫자 파라미터 전부** (20종 × 1~2개) |
| `VideoSection` | 볼륨 · 마스크 X/Y/너비/높이/흐림 · 크로마키 허용치/경계/물듦 |
| `TextSection` | 글자 크기 · 자간 · 외곽선 두께 · 줄 간격 |
| `AudioSection` | 볼륨 |
| `SourceSection` | **없음** (위 §source 참조) — 섹션 하단에 이유 한 줄 |
| `CurvesSection` | **없음** — 값이 숫자가 아니라 점 배열이라서. 같은 안내 한 줄 |

### `KeyframesSection` 확장

지금(`KeyframesSection.tsx`)은 **평평한 행 목록**이고 각 행에 prop `<select>` 가 붙어 있다.
경로가 40개가 되면 그대로는 못 쓴다. 세 가지를 바꾼다.

1. **경로별로 접힌 그룹.** 한 그룹 = 한 경로. 헤더에 한국어 라벨(`keyframePathLabel`),
   키프레임 개수, 「전부 삭제」. 지금의 `<select>` 는 **그룹 헤더로 승격**된다
   (행마다 prop 을 바꾸는 것은 실수를 부른다 — 값의 의미가 달라지는데 값은 그대로 남는다).
2. **그룹마다 미니 타임라인 한 줄.** 클립 길이를 가로로 펴고 키프레임을 마름모로 찍는다.
   드래그로 시간 이동, 더블클릭으로 삭제. 숫자 입력은 그대로 두되 **보조**로 내린다.
   트래킹 결과(수백 개)를 표로 보여 주는 것은 무의미하다.
3. **「추가」 드롭다운을 `KEYFRAME_PATHS[kind]` 에서 만든다.** `<optgroup>` 으로 묶는다 —
   위치·모양 / 효과 / 마스크 / 크로마키 / 텍스트 / 오디오. 이미 그 클립에 있는 효과만
   `effects#…` 항목으로 펼친다(없는 효과는 안 보인다).

`currentPropValue(clip, prop)`(`inspector-utils.ts:200-217`)의 switch 문 6개는
**`readPath(clip, path) ?? 0` 한 줄로 없어진다.**

---

## 검증 — 숫자로 낸다

**1. 회귀 — 기존 6종이 그대로인지**
기존 프로젝트 문서(6종 prop 사용)를 로드 → 저장 → **바이트 동일**.
그 문서를 렌더한 프레임들이 변경 전과 **픽셀 완전 일치**(PSNR = ∞). 하나라도 다르면 실패.

**2. 색 키프레임이 «실제로 렌더에 나오는지» — 픽셀로 잰다**
- 균일한 중간회색(RGB 128) 1초짜리 소스에 `brightness` 효과를 걸고
  `effects#<id>.params.amount` 를 **0.5 → 1.5, linear, 0→1000ms** 키프레임
- 30fps 로 렌더 → 프레임마다 ffmpeg `signalstats` 의 `YAVG` 를 잰다
- 기대: 프레임 0 → **64**, 프레임 15(500ms) → **128**, 프레임 29(967ms) → **188**
- **합격 기준: 각 프레임 |실측 − 기대| ≤ 3** (8비트 반올림 여유)
- **단조 증가**여야 한다 — 30프레임 전부 `Y[i+1] ≥ Y[i]`

**3. 블러 키프레임**
`effects#<id>.params.px` 를 `0 → 20` 으로. 첫 프레임과 끝 프레임의
**가로 방향 고주파 에너지**(Sobel 평균)를 비교 → 끝 프레임이 **80% 이상 감소**해야 한다.

**4. 마스크 키프레임**
`mask.x` 를 `0 → 0.5`. 흰 배경 위 검은 소스에서 **보이는 영역의 왼쪽 경계 x 좌표**를
프레임마다 잰다. 기대 위치와 **±2px** 이내.

**5. 분할·트림 무작위 테스트 (핵심)**
```
경로 40개 중 무작위 5개 × 무작위 키프레임 3~8개 × 무작위 이징 → 클립 생성
무작위 지점에서 splitClip
→ 원래 클립의 t 시점 값과, 분할된 두 조각에서 같은 절대 시각의 값이 같은가?
  t 를 1ms 씩 전 구간 훑어 |차이| < 1e-9
1000회 반복, 실패 0회
```
`trimClip` 도 `edge: 'start'|'end'` 각각 같은 방식으로.

**6. 화이트리스트 거부**
| 입력 | 기대 |
|---|---|
| `mask.wdith` (오타) | `BAD_KEYFRAME` |
| `source.lut.intensity` | `BAD_KEYFRAME` + **source 전용 안내 문구** |
| `curves.rgb` | `BAD_KEYFRAME` |
| `speed` | `BAD_KEYFRAME` |
| `effects#없는id.params.amount` | `BAD_KEYFRAME` (설정 시점 실재 검사) |
| text 클립의 `volume` | `BAD_KEYFRAME` |
| `__proto__.x` · `constructor.prototype.x` | 정규식에서 통과하지만 **화이트리스트 밖** → 거부. `writePath` 도 `__proto__`·`constructor`·`prototype` 키를 **하드코딩으로 거부**한다(프로토타입 오염 방지) |

**7. 성능 — 퇴행 금지**
- **키프레임 없는 클립**: 30초 프로젝트 렌더 시간이 변경 전 대비 **±2% 이내**
- **키프레임 3,600개 클립**(F10 대비): `applyKeyframes` 900프레임 호출 총 시간을 잰다.
  묶음 캐시 **있을 때/없을 때**를 둘 다 재서 문서에 적는다 — 캐시가 왜 필수인지의 근거

**8. 미리보기 ↔ 렌더 일치**
같은 클립을 (a) 서버 렌더 (b) 빠른 미리보기로 뽑아 **평균 채널 차이 ≤ 3, 최대 ≤ 12**
(15-preview-parity.md 와 같은 임계). 새 경로 40개 중 미리보기가 그리는 것 전부에 대해.

---

## 하지 않을 것

- **「일단 색만, 마스크는 F10 할 때」로 쪼개지 않는다.** 화이트리스트 전체를 한 번에 넣는다.
  경로 하나를 추가하는 비용은 표 한 줄이고, 나눠 하면 UI 를 두 번 만들게 된다.
- **`source.*` 를 「나중에 완화」로 남기지 않는다.** 지금 세 곳에서 막는다.
- **`interpolateKeyframes` 를 「그대로 두면 되니까」 손 안 대고 넘어가지 않는다.**
  묶음 캐시 없이 F10 을 얹으면 렌더가 멈춘 것처럼 느려진다.
- **`effects[N]` 인덱스 경로를 아무 대책 없이 채택하지 않는다.** `#id` 로 가거나,
  못 가면 `doUpdateClip` 의 경로 재작성을 반드시 함께 넣는다.
- **대상이 없어진 키프레임을 조용히 지우지 않는다.** 마스크를 잠깐 껐다 켜면 돌아와야 한다.
  안 보이면 사용자는 「사라졌다」고 생각한다.
- **UI 를 표만 늘려서 끝내지 않는다.** 트래킹이 만든 수백 개의 키프레임은 표로는 못 다룬다.
  미니 타임라인이 이 작업의 절반이다.
