# W8 — 포기 없는 재실행: 목록과 공통 계약 (2026-09-02)

**왜 이 문서가 있나.** W5·W6 을 하면서 **9번 「무거워 보여서 더 싼 방법으로 바꾸고 그걸 결정이라고
계획서에 적는」 짓을 했다.** 그 결과 기능 이름은 남았는데 알맹이가 다른 것들이 생겼다
(WebCodecs 없는 「WebCodecs 프리뷰」, Real-ESRGAN 없는 「AI 업스케일」 등).

이 문서와 뒤따르는 기능별 계획은 **그것들을 원래 요구대로 다시 하는 것**이다.

## 이번에 지킬 규칙

1. **「무거워서 X 대신 Y」 판단이 들면 대안을 실제로 찾아보고, 그래도 바꿔야 하면 계획서에
   결정으로 묻지 말고 사용자에게 먼저 묻는다.**
2. **제약을 새로 만들지 않는다.** (W5 의 「npm install 금지」는 내가 만든 규칙이었고, 그게
   WebCodecs 구현을 막았다.)
3. **성능·품질을 내 판단으로 낮추지 않는다.** 느린 방법은 「느리다」고 적고 선택지로 남긴다.
4. **「확인 못 했다」고 적은 것은 반드시 확인한다.** 미확인을 근거로 결론 내지 않는다.

---

## 전체 목록 (17개)

### 공통 계약 (먼저 해야 다른 게 안 깨진다)
| | 내용 | 이유 |
|---|---|---|
| **S1** | 키프레임 대상 확장 (`prop` → 경로 문자열) | F9·F10·F13 의 선행 조건 |
| **S2** | 이징 확장 (cubic-bezier + spring) | F7. 다른 기능의 움직임 품질에 전부 영향 |
| **S3** | `ClipSource` 확장 (색보정·모션블러·음성) | F3·F4·F5·F11 이 같은 자리를 쓴다 |
| **S4** | 외부 실행 파일 백엔드 (`vendor/`) | F1·F2 공용 |
| **S5** | 렌더 파이프라인 확장 (오디오 스템·`chromiumOptions`) | F12·F15 선행 |

### 기능
| | 기능 | 고해성사 # | 문서 |
|---|---|---|---|
| **F1** | 업스케일 — Real-ESRGAN | 1 | `01-upscale-realesrgan.md` |
| **F2** | 프레임 보간 — RIFE | 2 | `02-interpolate-rife.md` |
| **F3** | 모션 블러 (영상 + 트랜스폼/전환) | 5 | `03-motion-blur.md` |
| **F4** | 컷별 색 맞추기 | — (W7) | `04-shot-match.md` |
| **F5** | HSL 세컨더리 | — (W7) | `05-hsl-secondary.md` |
| **F6** | 스코프 (실시간 + 정밀) | 6 | `06-scopes.md` |
| **F7** | 베지어·스프링 이징 | 7 | `07-easing.md` |
| **F8** | 키네틱 타이포그래피 | — (W7) | `08-kinetic-type.md` |
| **F9** | 자유 마스크 (펜 툴) | — (W7) | `09-free-mask.md` |
| **F10** | 마스크 모션 트래킹 | — (W7) | `10-mask-tracking.md` |
| **F11** | 나레이션 오디오 체인 | — (W7) | `11-voice-chain.md` |
| **F12** | 진짜 사이드체인 더킹 | 7(보류철회) | `12-sidechain.md` |
| **F13** | 색·블러 키프레임 | — (W7) | `13-keyframe-anything.md` |
| **F14** | WebCodecs 프리뷰 엔진 | 3 | `14-webcodecs-preview.md` |
| **F15** | 프리뷰 v2 미지원 8종 | 8 | `15-preview-parity.md` |
| **F16** | 전환·효과·템플릿 확장 | 7 | `16-library-expansion.md` |
| **F17** | 검증 부채 청산 | 4·9 | `17-verification-debt.md` |

---

## S1. 키프레임 대상 확장 — `prop` 을 경로 문자열로

### 지금
```ts
prop: 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume'
```
`KEYFRAME_PROPS`(engine)가 클립 종류별로 허용 목록을 검사한다.
「컷 중간에 서서히 밝아지기」·「마스크가 대상을 따라가기」가 불가능하다.

### 바꿀 것
`prop` 을 **점·괄호 경로 문자열**로 넓힌다. 기존 6종은 그대로 유효하다(하위호환).

```ts
export type Keyframe = {
  time: number;
  prop: string;            // 'x' | 'opacity' | 'effects[0].params.amount' | 'mask.x' | 'chromaKey.similarity' | ...
  value: number;
  easing: Easing;          // S2
};
```

**허용 경로는 클립 종류별 화이트리스트로 검증한다** — 아무 경로나 받으면 문서가 깨진다.

```ts
// packages/schema/src/keyframe-paths.ts (신규)
export type KeyframePathDef = {
  path: string;            // 'effects[*].params.*' 처럼 * 와일드카드 허용
  min?: number; max?: number;
  label: string;           // UI 표시용 한국어
};
export const KEYFRAME_PATHS: Record<Clip['kind'], readonly KeyframePathDef[]>;
export function isKeyframablePath(kind: Clip['kind'], path: string): boolean;
export function readPath(clip: Clip, path: string): number | undefined;   // fallback 계산용
```

**허용 목록 (초안)**
| 클립 | 경로 |
|---|---|
| 공통(video·image·text) | `x` `y` `scale` `rotation` `opacity` · `crop.x/y/w/h` · `effects[N].params.*` · `curves` 는 제외(배열이라 별도) |
| video | 위 + `volume` · `mask.x/y/w/h` · `mask.feather` · `chromaKey.similarity/smoothness/spill` · `source.lut.intensity` ※ |
| image | 공통 + `mask.*` |
| text | 공통 + `style.fontSize` `style.letterSpacing` `style.strokeWidth` |
| audio | `volume` |

※ **`source.*` 는 키프레임 불가로 한다.** 파생 파일을 굽는 스펙이라 프레임마다 바뀌면 파일이
무한히 생긴다. UI 에서 명확히 막고 이유를 표시한다.

### 렌더러
`interpolateKeyframes(kfs, prop, tMs, fallback)` 는 그대로 두되(문자열 비교라 이미 동작),
**호출부를 늘린다** — 지금은 6곳만 부른다. 효과 파라미터·마스크·크로마키를 그릴 때
`interpolateKeyframes(clip.keyframes, 'effects[0].params.amount', tMs, 원래값)` 형태로 감싼다.

`computeVisualLayout`(layout/index.ts)이 이미 모든 값을 한 곳에서 계산하므로 **거기 한 군데만**
「경로별 키프레임 적용」을 통과시키면 된다.

### 엔진
`doSetKeyframes` 의 검증을 `KEYFRAME_PROPS` → `isKeyframablePath` 로 교체.
`splitKeyframes`·`rebaseKeyframes` 는 prop 값을 문자열로만 다루므로 **수정 불필요**.

### 검증
- 기존 문서(6종 prop)가 그대로 통과
- `effects[0].params.amount` 키프레임을 걸고 **실제로 렌더해서** 프레임별 밝기가 변하는지 픽셀로 측정
- 허용 목록 밖 경로는 `BAD_KEYFRAME` 으로 거부
- `source.*` 경로 거부

---

## S2. 이징 확장 — cubic-bezier + spring

### 지금
```ts
easing: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
```
**`cubicBezier(p1x,p1y,p2x,p2y)` 구현이 이미 두 곳에 있다** — `engine/src/apply.ts:163`,
`renderer/src/composition/keyframes.ts:7`. 지금 4종은 그 함수의 특정 값일 뿐이다.

### 바꿀 것
```ts
export type Easing =
  | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'          // 하위호환
  | { bezier: [number, number, number, number] }
  | { spring: { damping?: number; mass?: number; stiffness?: number; overshootClamping?: boolean } };
```

- **bezier**: 두 파일의 `EASINGS` 조회를 「문자열이면 표 조회, 객체면 `cubicBezier(...)` 호출」로 분기.
  `p1x`·`p2x` 는 0..1 로 클램프(CSS 규격), `p1y`·`p2y` 는 제한 없음(오버슈트 허용).
- **spring**: `remotion` 코어의 `spring()` 을 쓴다. **다만 엔진은 remotion 에 의존하면 안 된다**
  (노드 전용 순수 패키지). → **스프링 적분기를 `packages/schema/src/easing.ts` 에 직접 구현**하고
  engine·renderer·ui 가 공유한다. Remotion 의 `spring()` 과 같은 물리(감쇠 조화 진동)를 쓰되
  `t∈[0,1]` 정규화 입력으로 만든다.

```ts
// packages/schema/src/easing.ts (신규)
export function easingFn(e: Easing): (t: number) => number;   // 순수, 캐시
export const EASING_PRESETS: readonly { id: string; name: string; easing: Easing }[];
```

**프리셋** (UI 드롭다운):
`linear` · `easeIn` · `easeOut` · `easeInOut`(기존 4종) ·
Material 표준 `(0.4,0,0.2,1)` · iOS `(0.25,0.1,0.25,1)` · 강한 감속 `(0.19,1,0.22,1)` ·
가속 후 정지 `(0.55,0,1,0.45)` · 살짝 튕김 `(0.34,1.56,0.64,1)` · 세게 튕김 `(0.68,-0.6,0.32,1.6)` ·
스프링(부드럽게) `{spring:{damping:20}}` · 스프링(탄력) `{spring:{damping:8}}`

### UI
**W6 에서 만든 색조정 커브 에디터를 그대로 재사용**한다 — 점 2개(제어점)를 드래그하는 SVG 격자.
프리셋 칩을 위에 깔고, 곡선을 그려서 보여준다. 스프링은 곡선이 1을 넘으므로 y축을 -0.5~1.5 로 넓힌다.

### 검증
- 기존 4종의 결과값이 **한 자리도 안 변하는지** (회귀)
- bezier `(0.42,0,0.58,1)` 이 `easeInOut` 과 동일한 값을 내는지
- spring 이 `t=0 → 0`, `t=1 → 1`, 중간에 1을 넘는지(오버슈트)
- engine 과 renderer 가 **같은 t 에서 같은 값**을 내는지 (두 구현이 갈리면 미리보기와 렌더가 어긋난다)

---

## S3. `ClipSource` 확장 — 파생 스펙 한 자리

### 지금
```ts
export type ClipSource = {
  lut?: { assetId: string; intensity: number };
  stabilize?: { smoothing: number };
  denoise?: { amount: number };
  pitch?: { semitones: number };
};
```

### 바꿀 것 (추가만, 전부 optional)
```ts
export type ClipSource = {
  // 기존
  lut?: { assetId: string; intensity: number };
  stabilize?: { smoothing: number };
  denoise?: { amount: number };
  pitch?: { semitones: number };

  // F4 컷별 색 맞추기
  matchTo?: { clipId: string; strength: number; region?: Crop };
  // F5 HSL 세컨더리
  hsl?: HslSecondary[];
  // F3 모션 블러 (영상)
  motionBlur?: { mode: 'fast' | 'precise'; shutterAngle: number };
  // F11 나레이션 체인
  voice?: { preset: VoicePreset; targetLufs?: number; reverb?: { irId: string; wet: number } };
};

export type HslSecondary = {
  id: string;
  family: 'reds'|'yellows'|'greens'|'cyans'|'blues'|'magentas'|'whites'|'neutrals'|'blacks';
  cyan: number; magenta: number; yellow: number; black: number;   // -1..1 (selectivecolor 규격)
};
export type VoicePreset = 'off' | 'broadcast' | 'warm' | 'bright' | 'podcast';
```

### 파생 파이프라인에 미치는 영향
- `sourceKey`(schema/derive.ts)가 새 필드를 포함하도록 정규화 문자열에 추가한다.
  **키 계산에 빠뜨리면 다른 설정인데 같은 파일을 쓰게 된다 — 반드시 전부 넣는다.**
- `deriveMedia`(media/derive.ts)의 필터 조립 순서를 **고정**한다:
  ```
  1) stabilize   (vidstab 2패스, 별도)
  2) matchTo     (colorlevels)        ← 색 맞추기가 먼저
  3) hsl         (selectivecolor)     ← 그 다음 세컨더리
  4) lut         (lut3d)              ← 마무리 룩
  5) motionBlur  (tmix / minterpolate)
  6) 오디오: denoise → deesser → EQ → comp → limiter → pitch → loudnorm
  ```
  **이 순서에 근거가 있다:** 색 맞추기는 「기준에 맞추는」 보정이므로 룩(LUT)보다 먼저 와야 한다.
  룩을 먼저 먹이면 그 위에서 맞추게 되어 룩이 어긋난다.
- **2패스가 필요한 것이 둘**(vidstab, loudnorm) → `deriveMedia` 의 패스 카운터·진행률 계산을
  「가변 패스 수」로 일반화한다.

### 검증
- `sourceKey` 가 새 필드 각각에 대해 **다른 키**를 내는지 (빠뜨림 검사)
- 필터 순서가 바뀌면 결과가 달라지는 것을 픽셀로 확인 (순서 고정의 근거)

---

## S4. 외부 실행 파일 백엔드 — F1·F2 공용

Real-ESRGAN·RIFE 둘 다 **ncnn-vulkan 독립 실행 파일**(PyTorch 불필요, 같은 저자·같은 CLI 형태)이다.
따로 만들지 말고 **하나의 백엔드**로 묶는다.

```ts
// packages/media/src/ncnn.ts (신규)
export type NcnnTool = 'realesrgan' | 'rife';
export type NcnnInfo = { ok: boolean; exe?: string; models?: string[]; gpus?: NcnnGpu[]; hint?: string };
export type NcnnGpu = { id: number; name: string };

export function ncnnInfo(tool: NcnnTool): Promise<NcnnInfo>;
/** 프레임 폴더 → 프레임 폴더. 타일 실패 시 자동 축소 재시도, GPU 지정 가능. */
export function ncnnRun(tool: NcnnTool, opts: {
  inDir: string; outDir: string;
  args: string[];              // 도구별 인자 (-s 4, -n model, -m interval 등)
  gpuId?: number;              // 미지정이면 «가장 안전한 GPU» 자동 선택 (아래)
  tile?: number;               // 미지정이면 512 → 256 → 128 → 64 자동 하강
  onProgress?: (done: number, total: number) => void;
}): Promise<void>;
```

### GPU 선택 — 이 컴퓨터의 사고를 반영한다
2026-09-01 에 **NVIDIA MX450(드라이버 2020-10-19)** 으로 Real-ESRGAN 을 돌리다 시스템이
**5번 다운**됐다(BugCheck 0x116 VIDEO_TDR_ERROR). 같은 컴퓨터의 **Intel Iris Xe 드라이버는 2025-05-25** 다.

→ `ncnnInfo` 가 `-h`/`--help` 로 GPU 목록을 읽고, **드라이버가 오래된 GPU 를 피한다**:
```
1. 환경변수 KITKAT_NCNN_GPU 가 있으면 그것 (사용자 명시)
2. 없으면: Windows 에서 각 GPU 의 드라이버 날짜를 조회(Win32_VideoController)해
   «3년 이내» 인 것 중 첫 번째
3. 전부 오래됐으면: CPU 폴백(-g -1)으로 돌리고 «느립니다» 를 잡 메시지에 남긴다
```
**이건 「안 되니까 포기」가 아니라 「죽는 하드웨어를 피해서 되게 하는 것」이다.**

### 설치
`scripts/prewarm.mjs` 에 `realesrgan`(이미 있음)·`rife` 모드. `vendor/<tool>/` 에 푼다.
`.gitignore` 에 `vendor/` 추가(이미 있음).

### 프레임 왕복 — 디스크 폭발 방지
1080×1920 PNG 한 장이 약 3~6MB. 30초 30fps = 900장 = **3~5GB**. C 드라이브 여유가 7GB 대다.
→ **청크 처리**: 프레임을 N장(기본 120장 = 4초)씩 끊어 추출 → 처리 → 즉시 인코딩 → 삭제 →
마지막에 concat. 최대 디스크 점유를 **청크 2개분**으로 묶는다.
→ 시작 전에 `여유 공간 < 필요 추정치 × 1.5` 면 **명확한 한국어 메시지로 실패**한다.

### 검증
- `ncnnInfo` 가 GPU 목록과 드라이버 날짜를 정확히 읽는지
- 오래된 GPU 를 실제로 건너뛰는지
- 타일 자동 하강이 동작하는지
- 청크 처리 중 디스크 최대 점유가 상한을 안 넘는지 (실측)

---

## S5. 렌더 파이프라인 확장

### (a) `chromiumOptions` — **초안이 틀렸다. 실측으로 정정함 (2026-09-02)**

초안은 「4.0.x 의 기본 `gl` 이 `null` 이라 WebGL2 이펙트가 죽는다. GPU 사고 이력이 있으니
기본을 `'swangle'`(소프트웨어)로 하자」였다. **둘 다 이 컴퓨터에서 재현되지 않았다.**

gl 별로 Chromium 을 띄워 `canvas.getContext('webgl2')` 를 실제로 잡아 본 결과:

| gl | WebGL2 | 실제 렌더러 | 렌더 시간(효과 많은 1080×1920 5초) | 재현성 |
|---|---|---|---|---|
| **`null`** (지금 기본) | **된다** | ANGLE Vulkan **SwiftShader** — 이미 소프트웨어, **GPU 미사용** | **120.8초** | 6회 렌더 **md5 동일** |
| `'swangle'` | 된다 | 같은 SwiftShader | **793.2초 (6.57배)** | 2회가 **서로 다름** |
| `'angle'` | 된다 | Intel Iris Xe D3D11 — **진짜 GPU** | — | — |

- **WebGL2 는 `null` 로도 잡힌다** → F15 의 선행 조건이 아니었다.
- **GPU 회피도 `null` 이 이미 달성**하고 있다. GPU 를 켜는 건 `'angle'` 쪽이다.
- `'swangle'` 은 Chromium 의 **래스터·합성 경로 전체**를 소프트웨어로 돌려서, WebGL 이 아니라
  SVG 필터·CSS 로 그리는 지금 컴포지션에서는 이득 없이 6.57배 느려진다(glow 의 `feGaussianBlur`
  가 있으면 비용이 폭발).
- **재현성이 깨지는 것이 결정적이다** — v1 회귀 검증이 md5 동일성에 의존했다.

```ts
export type RenderProjectOptions = {
  /* 기존 */
  gl?: 'swangle' | 'angle' | 'swiftshader' | 'egl' | null;   // 기본 null
};
```
**기본값 `null`.** 옵션은 남긴다(필요할 때 명시적으로 고를 수 있게).
**`'angle'` 을 기본으로 두지 마라** — 이 컴퓨터를 5번 죽인 GPU 경로다.

### (b) 오디오 스템 렌더 — F12 의 선행 조건
```ts
export function renderAudioStem(doc: ProjectDoc, opts: {
  mediaDir: string; outPath: string;      // .wav
  soloTrackIds: string[];                 // 이 트랙만 살리고 나머지는 muted
  range?: { start: number; end: number };
  onProgress?: (p: number) => void;
}): Promise<{ outPath: string }>;
```
내부적으로 doc 사본의 `tracks[].muted` 를 조작하고 `renderMedia({ codec: 'wav' })`.
**실측: 1080×1920 5초 기준 오디오 전용 12.7초 vs 영상+오디오 22.2초.**

### (c) 렌더 잡의 다단계화
지금 render job 은 단일 `renderProject` 호출이다. F12 는 「영상 1 + 스템 2 + 믹스 + 먹싱」 4단계다.
→ job 진행률을 **단계 가중치**로 계산하도록 일반화(이미 `deriveMedia` 가 하는 방식과 동일).

### 검증
- `gl:'swangle'` 로 기존 렌더가 **깨지지 않는지**(회귀) 그리고 **느려지지 않는지** 실측
- `renderAudioStem` 이 지정한 트랙만 담는지 (다른 트랙 소리가 0인지 측정)

---

## 실행 순서

```
1군 (공통 계약)      S2 → S1 → S3 → S5 → S4
2군 (계약 위 기능)   F7(=S2 UI) · F13(=S1 UI) · F4 · F5 · F11 · F3 · F6
3군 (외부 도구)      F1 · F2 · F10
4군 (렌더 구조)      F12 · F15 · F14
5군 (양)             F16 · F8 · F9
6군                  F17 (검증 부채 청산)
```

**S2·S1 을 먼저 하는 이유:** 이징과 키프레임 대상은 다른 모든 기능의 «움직임 품질»과
«무엇에 애니메이션을 걸 수 있나»를 결정한다. 나중에 하면 앞서 만든 것들을 다시 손대야 한다.

---

# W8 완료 (2026-09-02)

**17개 전부 끝났다.** 「이 문서가 비면 W8 이 끝난 것」이라는 17번 문서의 규칙대로,
검증 부채도 남기지 않았다 — **단 하나, 「속도 커브 소리를 브라우저에서 들어보기」만 빼고.**
그건 이 컴퓨터의 크롬 창이 화면에 없어서(`document.visibilityState === 'hidden'`) 잴 방법이
없었고, 그 사실을 17번 문서에 그대로 적었다.

## 최종 수치

| | 값 |
|---|---|
| 테스트 | **1,693개 / 79파일 전부 통과** (W8 시작 시점 794개) |
| 전환 | 23 → **51** |
| 화면 효과 | 20 → **50** (구현 44 · 대기 6) |
| 텍스트 템플릿 | 35 → **90** |
| 글자 애니메이션 | 5 → **21** × 단위 4 × 시차 |
| MCP 도구 | 16 → **19** |
| remotion | 4.0.519 → **4.0.520**(20개 패키지 정확히 고정) |

## 조사가 틀렸던 것 (실측이 바로잡은 것)

| 내가 적었던 것 | 실제 |
|---|---|
| 추적 실패는 «점수»로 알 수 있다 | **틀렸다.** 대상을 놓친 뒤 ViT 가 화면 전체를 상자로 잡고 점수를 0.78 로 되돌린다 — 745프레임에서 놓친 실패 187건. 3중 판정으로 0건까지 내렸다 |
| RDP 허용 오차 0.5px | **감소율 정확히 0.0%.** 추적기가 정수 픽셀로 1~2px 떨린다. 4px 으로 바꿔 19~56% 감소, 정답 대비 오차는 안 늘었다 |
| `createEffect` 가 렌더를 안 기다릴 위험 (치명적) | **틀렸다.** 30/30 프레임 적용. 게다가 kitkat 은 `createEffect` 를 0건 쓴다 |
| 마스크 + 블렌드 + 회전에서 좌표가 어긋난다 | **틀렸다.** IoU 0.993~1.000, `mixBlendMode` 는 1px 도 안 바꿈 |
| `@remotion/motion-blur` 가 비디오를 못 흐린다 | **맞았다.** 픽셀 차이 **정확히 0**. 덤: 샘플 구간이 미래 쪽이라 물체가 29px 앞으로 밀린다 |
| 유튜브 −14 LUFS 는 관행값이다 | **맞았다.** 그리고 **구글 광고 공식 규격은 −24 LKFS** 라 −14 로 내면 10dB 초과다 |

## 하는 김에 잡은 «있던» 버그

| 버그 | 어떻게 드러났나 |
|---|---|
| **빠른 미리보기 전체가 위아래로 뒤집혀 있었다** | F15 의 픽셀 대조 — 평균 차이 50.45 → 0.00 |
| **볼륨을 1.2 로 올리고 5초 페이드를 걸면 렌더가 통째로 실패** | ffmpeg `if()` 중첩 100겹 한계. remotion 의 반올림이 볼륨 0..1 을 가정하는데 kitkat 은 0..4 |
| **이미지에 크로마키를 걸면 아무 일도 안 일어남** (200 으로 저장까지 된다) | V2 브라우저 확인 |
| **파생 미디어 프록시에만 `-g 15` 가 빠져 있었다** | F14 가 원본 프록시만 고쳤다 |
| `dissolve` 가 세로 캔버스에서 점 사이에 구멍을 남김 · `filmScratch` 가 어떤 프레임에 아무것도 안 그림 | F16 이 컨택트 시트를 **눈으로 보고** |

---

# W8 사후 리뷰 (2026-09-03) — 「지름길로 간 적이 있는가」

내 결과물을 내 손으로 다시 훑어 **12곳**을 찾았고, 전부 처리했다. 상세는 `17-verification-debt.md` 하단.

| # | 무엇 | 처리 |
|---|---|---|
| 1 | 없는 필드가 조용히 저장됨 (검증이 원본을 안 바꿈) | 쓰기 관문에서 거절 + 경로 명시. 저장된 문서에서 유령 필드 4개 발견(전부 에이전트가 넣은 것) |
| 2 | 「1.31dB 안 들린다」는 계산값 | 사인파 3종 실측 — 스냅 오차는 remotion 자체 격자와 구분 불가 |
| 3 | 프록시 갱신을 52번 눌러야 함 · 파생 프록시 판 표시 없음 | 한 번에 갱신(원본+파생) · 판정을 schema 한 곳으로 |
| 4 | 안내문 반말 | 고침 |
| 5 | `--full` 데모 안 돌림 | 23/23 (Real-ESRGAN·RIFE·Demucs 실제 잡 큐) |
| 6 | F14 수치를 재보지 않고 README 에 옮김 | **틀렸었다.** 재검증 → 원인(디코더 굶김) → 워커로 이전. 편집기 끊김 68~99% → **0.8%** |
| 7 | F8 의 자작 TrueType 파서를 검토 없이 받음 | 150,616 글리프 전수 대조 불일치 0, 숨은 버그 3개 수정. **덤:** F8 의 이전 「실렌더 획 그리기」가 대체 와이프였음을 F8 이 스스로 발견·정정. 펜 폭 자동 맞춤으로 p→1 점프 88~91% 감소 |
| 8 | 효과 6종 「대기」를 그대로 받음 | 렌더·미리보기 양쪽 WebGL 구현, 대조 6/6, `pendingEffects = []` |
| 9 | 최대치 계산 중복 | 한 곳으로 |
| 10 | 모의가 진짜 함수를 다시 적음 | 진짜 모듈 위에 스텁 |
| 11 | 데모 개수 검사가 «최소치» | id 배열 == 카탈로그 일치 검사 |
| 12 | 잡 시간 초과 때 자식 프로세스 생존 | 잡 컨텍스트에서 신호 물려받기(ffmpeg·ncnn·파이썬·Remotion) |

**이 리뷰에서 배운 것 두 줄:**
- «효과가 걸렸다» 의 증거는 «효과 없음과 다르다» 가 아니라 **그 효과만 낼 수 있는 흔적**이어야 한다 (#7 — 와이프도 잉크가 단조 증가한다).
- 남이 낸 숫자는 **제품에서** 다시 재기 전엔 사실이 아니다 (#6 — 합성 벤치 0% 가 편집기에선 95% 였다).
