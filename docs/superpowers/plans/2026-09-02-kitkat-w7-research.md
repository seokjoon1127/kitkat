# kitkat W7 — 「AI 광고에 진짜 필요한 것」 구현 방법 조사 (2026-09-02)

**목적:** 시중 편집기 대비 없는 기능 7가지를 **실제로 어떻게 넣는지** 조사한다.
구현 계획이 아니라 **방법과 대가의 조사 기록**이다.

**조사 방식:** ① 이 컴퓨터에서 실제로 돌려 잰 것 ② Remotion/OpenCV/ffmpeg 1차 문서·원본 소스 대조.
**추측은 「확신 못 하는 것」으로 따로 표시했다.**

---

## 먼저 — 전제 정정 3건

1. **텍스트 템플릿은 10종이 아니라 35종이다** (2026-09-01 W6 에서 확장). 폰트도 시스템 3종이 아니라
   **번들 OFL 한글 9종**이다.
2. **`@remotion/motion-blur` 는 비디오 내용의 움직임을 흐리지 못한다.** 뒤에서 설명한다.
3. **지금의 더킹 방식(볼륨 키프레임)은 「가짜」가 아니다.** Adobe Premiere Pro 의 Auto Ducking 이
   정확히 같은 방식이다(`Generate Keyframes` 버튼). 진짜 사이드체인을 쓰는 건 DaVinci Fairlight 쪽이다.
   문제는 「방식」이 아니라 「해상도」다.

나머지 지적(모션 블러 0건 · 이징 4종 · 키프레임 6종 · 마스크 3종 · HSL 세컨더리 없음 · 스코프 없음 ·
오디오 4종)은 **코드로 확인한 결과 전부 정확하다.**

---

## 요약표 — 무엇을 어떻게, 얼마에

| # | 기능 | 방법 | 증거 | 새 의존성 | 난이도 |
|---|---|---|---|---|---|
| 1 | **컷별 색 맞추기** | ffmpeg `colorlevels` (통계 측정 → 선형 사상), M2 파생에 태움 | **실측: 색차 110 → 6 (94%↓)** | 없음 | 낮음 |
| 2 | **HSL 세컨더리** | ffmpeg `selectivecolor`·`huesaturation`, M2 파생 | **실측: 빨강만 109 변화, 나머지 5색 정확히 0** | 없음 | 낮음 |
| 3 | **스코프** | ffmpeg `waveform`·`vectorscope`·`histogram` → 서버가 이미지 생성 | **실측: 3종 정상 생성** | 없음 | 낮음 |
| 4 | **베지어 이징** | `Keyframe.easing` 을 4종 열거 → 4점 배열 허용 | **`cubicBezier` 구현이 engine·renderer 양쪽에 이미 있음** | 없음 | **매우 낮음** |
| 5 | **모션 블러(영상)** | ffmpeg `tmix`, M2 파생 | **실측: 0.8초/1초. 최고품질은 77초/1초 — 실용 불가** | 없음 | 낮음 |
| 5b | **모션 블러(전환·트랜스폼)** | SVG `feGaussianBlur stdDeviation="N 0"` + 이중 rotate | 문서 확인(MDN) | 없음 | 낮음 |
| 6 | **키네틱 타이포** | 코어 `spring()` + 글자별 `<span>` 스태거, `clip-path`/`mask-image` 와이프 | `spring` 코어 존재 확인 | 없음 | 중간 |
| 7 | **자유 마스크** | `clip-path: path()` (하드) + SVG `<mask>`+`feGaussianBlur` (페더) | 문서 확인(MDN) | 없음 | 중간 |
| 8 | **나레이션 EQ·컴프** | ffmpeg 체인 + 2패스 `loudnorm`, M2 파생 | **실측: 0.21초, −21.8 → −15.9 LUFS** | 없음 | 낮음 |
| 9 | **더킹 개선** | 파형 포락선 기반 키프레임 (Premiere 방식) | 기존 `makeWaveform` 재사용 | 없음 | 낮음 |
| 10 | **마스크 트래킹** | OpenCV `TrackerVit` (기본 패키지) | 공식 벤치 4ms/프레임 | opencv 44MB + 모델 0.7MB | 중간 |
| 11 | **색·블러 키프레임** | `Keyframe.prop` 을 경로 문자열로 확장 | — | 없음 | 중간 |
| 12 | **진짜 사이드체인** | 스템 오디오 렌더 2장 + `sidechaincompress` 믹스 | **실측: 실제로 동작함. 렌더 2.2배** | 없음 | 중간 |

---

## 1. 컷별 색 맞추기 — 가장 아프다고 한 것, 가장 쉽게 된다

### 실측 (이 컴퓨터)
같은 장면을 「따뜻·밝음」과 「차갑·어두움」으로 갈라 놓고 자동으로 맞춰 봤다.

```
채널   기준 컷        대상 컷        →  맞춘 뒤 기준과의 차이
R    119.3±117.5   103.7±102.0   →  15.7 → 0.4
G    131.9±120.3    93.0± 89.2   →  38.9 → 4.3
B    126.8±126.3    71.3± 66.1   →  55.5 → 1.6
                          합계 110.1 → 6.3  (94% 감소)
```
눈으로도 확인했다 — 맞춘 결과가 기준 컷과 거의 구분되지 않는다.

### 방법
1. 두 프레임의 **RGB 채널별 평균·표준편차**를 잰다.
2. `out = (in − 대상평균)·(기준표준편차/대상표준편차) + 기준평균` 을 `colorlevels` 의
   `imin/imax` 로 역산한다.
3. ffmpeg 한 패스로 굽는다 — **M2 파생 미디어(LUT·손떨림과 같은 자리)** 에 그대로 들어간다.

```
colorlevels=rimin=..:rimax=..:gimin=..:gimax=..:bimin=..:bimax=..
```

### 한계 (정직하게)
**내용이 다른 두 컷**에서는 80% 감소에 그쳤고, **과보정 위험**이 있다. 내용이 다르면 색 통계가
다른 게 정상인데 억지로 맞추기 때문이다. 그래서 반드시:
- **강도 슬라이더**(0~100%)를 둘 것 — 100%가 항상 정답이 아니다.
- 가능하면 **기준 영역 지정**(피부·회색카드 등 사각형)으로 그 영역만 비교할 것. 실무 콜리스트가
  하는 방식이다.

### 스키마
`ClipSource` 에 `matchTo?: { clipId: string; strength: number; region?: Crop }` 를 더한다.
`sourceKey` 가 이걸 포함하면 기존 파생 파이프라인이 그대로 굴러간다.

---

## 2. HSL 세컨더리 — 완벽하게 된다

### 실측
`selectivecolor=reds=0.35 0 -0.25 0` 를 컬러바에 걸었더니:

| 색 | 변화량 |
|---|---|
| 빨강 | **109** |
| 초록·파랑·청록·자홍·노랑 | **전부 정확히 0** |

색상 계열별로 정확히 분리된다. 「2번 컷의 피부톤만 3번 컷에 맞추기」가 이걸로 된다.

### 방법 — 두 필터를 함께
- **`selectivecolor`** — 포토샵의 「선택 색상」 그대로. `reds/yellows/greens/cyans/blues/magentas/whites/neutrals/blacks` 9개 계열마다 CMYK 조정. 피부톤은 `reds`+`yellows`.
- **`huesaturation`** — 색상 구간을 켜고 끄며(`r,y,g,c,b,m`) 색상·채도·강도를 민다.
- 둘 다 M2 파생 한 패스에 들어간다.

### Remotion 합성 단계에서 하는 방법 (대안, 더 어렵다)
Remotion 4.0.519 **코어에 `createEffect` 가 이미 있다**(WebGL2/WebGPU/2D 백엔드). 하지만:
- **`renderMedia` 에 `chromiumOptions: { gl: ... }` 를 안 넘기면 "Failed to acquire WebGL2 context" 로 죽는다.** 지금 `render.ts` 는 안 넘긴다.
- **`<OffthreadVideo>` 에는 `effects` prop 이 없다.** `@remotion/media` 의 `<Video>` 로 이사해야 하는데, speedRamp·reverse·preservePitch 제약이 별도 검증 대상이다.
- 이 컴퓨터는 GPU 부하로 5번 다운된 적이 있으므로, 하려면 `gl: 'swangle'`(소프트웨어, GPU 미사용)로 먼저 확인해야 한다.

**→ 지금은 ffmpeg 굽기가 압도적으로 싸고 확실하다.** WebGL 경로는 「굽는 시간 없이 슬라이더가 즉시 반응해야 할 때」 나중에 검토한다.

---

## 3. 스코프 — 서버가 이미지로 만들어 준다

### 실측
`waveform`(RGB 퍼레이드) · `vectorscope`(스킨톤 라인·색 타깃 포함) · `histogram`(RGB 3단) 3종을
전부 생성 확인했다. 콜리스트가 실제로 보는 그림 그대로 나온다.

```
waveform=intensity=0.2:mirror=1:components=7:display=overlay
vectorscope=mode=color3:graticule=green:flags=name
histogram=display_mode=stack:levels_mode=logarithmic
```

### 붙이는 자리
스코프는 **렌더가 아니라 측정**이다. `POST /api/projects/:id/scopes { timeMs, kind }` 로
① 현재 시각의 스틸을 뽑고(이미 있는 `renderCover` 경로) ② 위 필터로 스코프 이미지를 만들어
③ 인스펙터 옆에 띄운다. **최종 렌더와 정확히 같은 그림을 측정**하는 게 핵심이다.

재생 중에는 못 쓴다(스틸 렌더가 1~2초). 색보정은 멈춰서 하는 작업이라 문제없다.

---

## 4. 베지어 이징 — 몇 줄이면 된다

**확인 결과: `cubicBezier(p1x,p1y,p2x,p2y)` 구현이 이미 두 곳에 있다.**
- `packages/engine/src/apply.ts:163`
- `packages/renderer/src/composition/keyframes.ts:7`

지금 4종은 그 함수의 특정 값일 뿐이다:
```ts
easeInOut: cubicBezier(0.42, 0, 0.58, 1)
```

### 방법
`Keyframe.easing` 을 `'linear'|'easeIn'|'easeOut'|'easeInOut' | [number,number,number,number]` 로
넓히고, 배열이면 그대로 `cubicBezier(...)` 에 넘긴다. **두 파일에서 각각 한 분기씩.**

UI 는 **이미 만들어 둔 색조정 커브 에디터를 재사용**한다(점 드래그·SVG 격자). 프리셋도 함께:
Material `(0.4,0,0.2,1)` · iOS `(0.25,0.1,0.25,1)` · 강한 감속 `(0.19,1,0.22,1)` ·
살짝 튕김 `(0.34,1.56,0.64,1)`.

**주의:** 스프링·탄성처럼 되돌아오는 움직임은 큐빅 베지어 하나로 표현 못 한다(단조가 아니라서).
그건 Remotion 코어의 `spring()`(존재 확인함)을 별도 이징 종류로 두는 게 맞다.

---

## 5. 모션 블러 — 속도가 전부다

### 실측 (1080×1920, 1초 클립)

| 방법 | 시간 | 화질 |
|---|---|---|
| `minterpolate=fps=240:mi_mode=mci` + `tmix=8` | **77초** | 매끈함 (진짜 셔터 블러) |
| `minterpolate=fps=120` + `tmix=4` | 36초 | 거의 같음 |
| `minterpolate=mi_mode=blend` + `tmix=8` | 1.9초 | **계단 보임** |
| **`tmix=frames=3` 만** | **0.8초** | 빠른 움직임에선 계단, **현실적 움직임에선 거의 같음** |
| `dblur=angle=90:radius=30` (방향성) | 1.5초 | 전환용으로 적합 |

**결정적 발견:** 초당 1600px(프레임당 53px)처럼 극단적으로 빠른 움직임에서는 `tmix` 가
계단처럼 끊긴 잔상을 만들지만, **초당 250px(프레임당 8px) 같은 현실적 움직임에서는
77초짜리와 눈으로 거의 구분되지 않는다.** 계단이 2단만 보인다.

→ **기본은 `tmix`(0.8초/초), 「최고 품질」 옵션으로 `minterpolate`.** 30초 광고면 각각 24초 vs 38분.

### `@remotion/motion-blur` 는 왜 답이 아닌가 (중요)
원본 소스를 확인한 결과:
- `<CameraMotionBlur>` 는 `<Freeze>` 로 **서브프레임 N장을 그려 합산**한다.
- 30fps 컴포지션 + 30fps 소스면 **10개 샘플이 전부 같은 소스 프레임**으로 떨어진다 →
  **비디오 안 피사체는 하나도 안 흐려진다.** 흐려지는 건 `useCurrentFrame()` 으로 계산되는
  pan/zoom/rotation 뿐이다.
- 게다가 샘플마다 URL 이 달라 **프레임 추출이 N배**, 공식 문서도 "destructive to colors" 경고.
- **버전 함정**: `@remotion/motion-blur@4.0.520` 은 `remotion: '4.0.520'` 을 정확히 핀한다(peer 아님).
  지금 4.0.519 위에 깔면 **remotion 사본이 둘**이 되어 React 컨텍스트가 갈린다.
  → 붙이려면 remotion 관련 패키지를 **전부 4.0.520 으로 같이** 올려야 한다.

### 트랜스폼·전환 블러는 SVG 로 (권장)
`stdDeviation` 은 X/Y 를 따로 준다 — MDN 원문대로 **한쪽이 0이면 그 방향으로만 번진다.**
```
<feGaussianBlur stdDeviation="20 0"/>   ← 가로로만
```
각도는 엘리먼트를 `rotate(θ)` 로 감싸고 안쪽을 `rotate(-θ)` 로 되돌리면 된다.
**kitkat 의 `svg-filters.tsx` 가 이미 필터 스테이지를 이어 붙이는 구조라 스테이지 하나 추가면 끝이고,
프레임을 더 뽑지 않으므로 렌더 시간이 늘지 않는다.**

---

## 6. 키네틱 타이포그래피 — 의존성 0으로 된다

### 방법 (Remotion 표준 패턴)
```tsx
const frame = useCurrentFrame();
chars.map((ch, i) => {
  const p = spring({ frame: frame - i * STAGGER, fps, config: { damping: 200 } });
  return <span style={{ display:'inline-block', opacity:p,
                        transform:`translateY(${(1-p)*40}px)` }}>{ch}</span>;
});
```
- **`spring()` 은 remotion 코어에 있다**(확인함). `frame` 을 직접 넣는 순수 함수라 되감기·건너뛰기에 안전.
- 지금 `text.tsx` 가 손으로 구현한 `easeOutBack`(popIn) 을 그대로 대체한다.
- **⚠️ `fps` 가 필수 인자**라 프로젝트 fps 가 바뀌면 모양이 변한다 → 템플릿에는 `durationInFrames` 로 고정하는 편이 안전.

### 마스크 와이프
- 하드: `clipPath: inset(0 ${(1-p)*100}% 0 0)` — 가장 싸고 안전
- 부드럽게: `maskImage: linear-gradient(90deg, #000 ${p*100-15}%, transparent ${p*100}%)`
  — **기존 `maskStyle()` 이 이미 쓰는 문법이라 새 개념이 아니다**
- 글자 획이 그려지는 효과: 텍스트를 SVG path 로 → `@remotion/paths` 의 `evolvePath`

### 있으면 좋은 것
`@remotion/layout-utils`(MIT) 의 `measureText`·`fitText` — 글자별 애니메이션을 넣으면 줄바꿈 예측이
필요해진다. 지금은 `maxWidth:'90%'` 로 브라우저에 맡기고 있다.
**⚠️ 폰트 로드 전에 재면 값이 틀린다** — `ensureFontsLoaded` 게이트 뒤에서 재야 한다.
(단 이것도 4.0.520 이라 버전 일괄 상향이 선행돼야 한다.)

---

## 7. 자유 마스크 + 트래킹

### 자유 형태 마스크 — 순수 CSS 로 된다
- **하드 엣지**: `clip-path: path("M …")` — Chromium 확실. **단위가 px 뿐**이지만 kitkat 은
  `layout.box.width/height` 가 이미 px 이라 오히려 잘 맞는다. `path(evenodd, …)` 로 구멍도 뚫린다.
- **페더**: `clip-path` 로는 안 된다(안티에일리어싱만 있고 페더 없음). 표준은
  **SVG `<mask>` + `feGaussianBlur`** — 검은 배경에 흰 path 를 그리고 블러를 먹인다.
  기존 `maskStyle()` 의 `WebkitMaskImage`/`maskImage` 슬롯에 그대로 들어간다.
- 스키마: `Mask.shape` 에 `'path'` 추가 + `d: string`.
- `@remotion/paths`(MIT) 가 `getPointAtLength`·`getBoundingBox`·**`interpolatePath`**(모양 자체를
  키프레임 애니메이션) 를 준다 — 순수 계산이라 UI 쪽에서만 써도 된다.

### 트래킹 — 생각보다 쉽다
**`TrackerVit` 를 쓴다.**

| 항목 | 값 |
|---|---|
| 패키지 | **`opencv-python-headless` 기본에 포함** (contrib 불필요), 휠 43.8MB |
| 모델 | `object_tracking_vittrack_2023sep.onnx` **0.71MB** (Apache-2.0) |
| 속도 | 공식 벤치 **4.01ms/프레임** (1280×720, Intel 12700K) ≈ 실시간의 8배 |
| 30초 1080p30 | 트래킹 3.6초 + 디코딩 2초 |

**`TrackerNano` 대신 ViT 인 이유**(OpenCV 공식 README): Nano 는 **어떤 상황에서도 0.9 점수만
돌려줘서 추적 실패를 알 수 없다.** 편집기는 「여기서부터 놓쳤습니다」를 보여줘야 한다.

**CSRT 를 안 쓰는 이유**: contrib(53.8MB) 필요 + 25fps(ViT 의 1/10).

**ffmpeg 으로는 안 된다** — `vidstabdetect` 의 `.trf` 는 프레임 전체의 카메라 이동이지 물체 위치가
아니다(바이너리 열어 확인). `mestimate` 는 모션 벡터를 내보낼 방법이 없다.

**CoTracker3/SAM2 는 과하다** — CPU 로 실용 속도가 안 나오고, PyTorch 가 이미 있다는 사실은
선택을 바꾸지 않는다(OpenCV 트래커는 torch 가 아니라 자체 DNN+ONNX 를 쓴다).

**붙이는 자리**: `packages/ai/` 에 파이썬 스크립트(whisper·demucs 와 같은 자리).
**PyAV 18.1.0 이 이미 venv 에 있어 디코딩용 새 의존성도 없다.** 렌더 쪽은 `maskStyle()` 이 이미
프레임마다 다른 값을 받을 수 있어 **ffmpeg 재인코딩이 전혀 필요 없다.**
막히는 건 **스키마** — `Mask` 가 고정값이고 `Keyframe.prop` 이 6종뿐이다(→ 11번 항목).

---

## 8. 나레이션 오디오 — 사실상 공짜다

### 실측 (이 컴퓨터)
| 처리 | 60초 오디오 기준 |
|---|---|
| 디코드만(기준선) | 224ms |
| 나레이션 체인 전체 | **556ms** |
| `loudnorm` 1패스 | 3,042ms (트루피크 검출로 192kHz 업샘플) |
| `sidechaincompress` | 412ms |

speech.wav 로 실제 체인을 돌린 결과: **−21.8 → −15.9 LUFS**, 다이내믹 3.9 → 3.0 LU,
트루피크 −5.2 → −0.8 dBTP. 방송 체인이 하는 일 그대로다.

### 체인 (순서가 중요)
```
highpass=f=80,                          # 저역 잡음
deesser=i=0.35:m=0.5:f=0.5,             # 치찰음 (컴프 앞에! 안 그러면 컴프를 헛되이 때린다)
equalizer=f=200:t=q:w=1.0:g=-3,         # 웅웅거림
equalizer=f=400:t=q:w=1.5:g=-2,         # 박스 울림
equalizer=f=3500:t=q:w=1.2:g=3,         # 발음 명료도
equalizer=f=10000:t=h:w=0.7:g=2,        # 공기감
acompressor=threshold=0.0891:ratio=3:attack=5:release=120:makeup=2:knee=6:detection=rms,
alimiter=limit=0.891:attack=5:release=50
```
- `threshold=0.0891` = **−21 dBFS 선형값**(dB 아님. `10^(dB/20)`)
- **`adeesser` 는 이 빌드에 없다. `deesser` 를 쓴다.** 다만 파라미터가 0~1 정규화라 「6kHz 를 6dB」
  같은 지정이 안 된다 — 정밀하게 하려면 `adynamicequalizer`.

### 라우드니스 — 2패스
1패스로 `loudnorm=print_format=json` 측정 → 2패스에 `measured_*` 를 넣어 적용.
**검증 결과 정확히 −14.0 LUFS 착지.**
- **⚠️ `-ar 48000` 을 반드시 명시** (내부적으로 192kHz 업샘플하므로)
- **⚠️ 소스 LRA 가 목표보다 작으면 `linear=true` 여도 조용히 dynamic 모드로 떨어진다** —
  출력 JSON 의 `normalization_type` 을 확인해야 한다

**플랫폼 목표**: YouTube/Spotify −14 LUFS 가 널리 쓰이나 **구글 공식 문서는 찾지 못했다.**
TikTok·Instagram·Facebook 은 **공표하지 않는다**(온라인 수치는 전부 추정).
→ **광고 나레이션은 −14 LUFS / −1.0 dBTP 하나로 고정**하는 게 안전하다.

### 리버브
ffmpeg 에 전용 리버브가 없다. 둘 중 하나:
- **`aecho` 다중 탭** — `aecho=0.8:0.85:29|37|47|59:0.18|0.14|0.10|0.07`. 살짝 공간감 주는 정도.
- **`afir` 컨볼루션** — 진짜 리버브. 임펄스 응답(IR) 파일 필요.

**IR 출처 (2026-09-02 직접 확인):**
| 출처 | 상태 | 라이선스 |
|---|---|---|
| OpenAIR (york.ac.uk) | **죽었다** (Account Suspended) | 접근 불가 |
| **Voxengo IM Reverbs** | 살아 있음, 6.9MB, 41개 | **"royalty-free for any purpose, including commercial usage"** ← 추천 |
| EchoThief | 살아 있음 | **사이트에 라이선스 문구 없음** |
| MIT IR Survey | 271개 | 출처마다 엇갈림 — 확인 필요 |

Voxengo 에 「파일 자체를 팔거나 배포로 수익 금지」 조항이 있다 — 에이전트 도구로 쓰는 건 무방하나
**kitkat 을 팔 계획이 생기면 재확인**해야 한다.

### 붙이는 자리
`AudioClip.source` 에 `voice?: { preset, targetLufs }` 한 칸. `audioFilterChain()` 확장.
**단 2패스 loudnorm 은 지금 함수 구조에 안 맞는다** — `deriveMedia` 가 `stabilize` 를 vidstab
2패스로 처리하는 방식을 그대로 흉내내면 된다.

---

## 9. 더킹 — 방식이 아니라 해상도가 문제다

### 실측 — 진짜 사이드체인은 잘 된다
목소리가 2~6초에만 있는 12초 음악:
```
0~2초  (목소리 없음)  −9.1 dB → −9.1 dB   (손 안 댐)
3~5초  (목소리 있음)  −9.1 dB → −19.4 dB  (10.3dB 눌림)
8~10초 (목소리 없음)  −9.1 dB → −9.1 dB   (다시 열림)
```
처리 0.12초. 광고용 추천값:
```
sidechaincompress=threshold=0.05:ratio=4:attack=20:release=400:makeup=1:knee=6:detection=rms
```

### ⚠️ 결정적 함정 — 실측
**같은 인자인데 나레이션 녹음 레벨만 바꾸면:**
| 목소리 진폭 | 더킹 깊이 |
|---|---|
| 0.10 | **−0.1 dB (사실상 안 눌림)** |
| 0.50 | −7.9 dB |
| 1.00 | −12.3 dB |

**녹음이 조용하면 더킹이 아예 안 걸린다.** 사용자가 「8dB 더킹」을 골랐는데 0dB 가 된다.
→ **사이드체인 앞에 나레이션을 `loudnorm` 으로 정규화**해야 한다(8번 체인이 이걸 자동 해결).

### kitkat 구조에 들어간다 — 실제로 해봤다

**처음에 「구조적으로 안 맞는다」고 적었는데 틀렸다.** 확인하지 않은 것(「Remotion 이 렌더 시
오디오를 어떻게 섞는지」)을 근거로 판단했다. 확인해 보니:

**Remotion 은 오디오를 자체 ffmpeg 파이프라인으로 섞는다.**
`node_modules/@remotion/renderer/dist/` 에 `preprocess-audio-track.js` · `merge-audio-track.js` ·
`combine-audio.js` · `mux-video-and-audio.js` 가 있고, `preprocess-audio-track` 이 거는 필터는
**`volume` 하나뿐**이다. 그리고 **`wav`·`mp3`·`aac` 가 유효 코덱**이라 오디오 전용 렌더가 된다.

### 실제로 돌려서 증명함

`Track.muted` 를 번갈아 켜서 스템 2장을 렌더하고 `sidechaincompress` 로 섞었다.
목소리는 3~7초에만 있는 10초 프로젝트:

```
0~2초  (목소리 없음)  음악만 -12.2dB → 최종 -12.2dB   손 안 댐
4~6초  (목소리 있음)  음악만 -12.1dB → 최종 -15.6dB   눌림
8~10초 (목소리 없음)  음악만 -12.1dB → 최종 -12.1dB   다시 열림
```

필터그래프(목소리 정규화까지 포함 — 조용한 녹음에서 더킹이 안 걸리는 함정 회피):
```
[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[v];
[v]asplit=2[vsc][vout];
[0:a][vsc]sidechaincompress=threshold=0.05:ratio=4:attack=20:release=400:makeup=1:knee=6:detection=rms[mduck];
[mduck][vout]amix=inputs=2:duration=longest:normalize=0[out]
```

### 비용 — 실측 (1080×1920, 5초)

| 렌더 종류 | 시간 |
|---|---|
| 영상+오디오 (지금) | **22.24초** |
| **오디오 전용 (wav)** | **12.71초** |
| 사이드체인 믹스 | 0.72초 |

→ 스템 2장 + 믹스 = `22.24 + 12.71×2 + 0.7` ≈ **48초. 지금의 2.2배.**

오디오 전용이 영상의 절반밖에 안 싼 이유: Remotion 은 오디오만 뽑을 때도 **프레임마다 컴포지션을
평가**한다(볼륨 함수를 부르려면 필요). 래스터화·인코딩만 건너뛴다.

### 미리보기 불일치는 원칙 위반이 아니다 — 이것도 내가 틀렸다

처음에 「미리보기와 렌더가 달라져서 kitkat 원칙이 깨진다」고 적었는데, PRD 의 **P3 는
「결과물 무타협, 미리보기는 프록시」** 다. 미리보기가 근사인 것은 **원칙 그 자체**이지 위반이 아니다.
이미 미리보기는 배속 16 클램프·볼륨 1 클램프로 근사하고 있다.

→ **렌더는 진짜 사이드체인, 미리보기는 볼륨 키프레임 근사.** P3 에 정확히 맞는다.

### 설계

`Track` 에 더킹 그룹을 둔다:
```ts
// Track 확장
duckedBy?: string;   // 이 트랙을 눌러야 하는 «트리거» 트랙 id
duck?: { amount: number; attackMs: number; releaseMs: number };
```
렌더 시 `duckedBy` 가 있으면:
1. 트리거 트랙만 살린 오디오 렌더 (wav)
2. 눌릴 트랙만 살린 오디오 렌더 (wav)
3. 나머지 트랙 + 영상 렌더
4. `loudnorm` → `sidechaincompress` → `amix` → 먹싱

미리보기는 지금처럼 `duckTrack` 키프레임을 쓴다(아래 개선안 적용).

### 더 줄일 여지 (미검증)
전체 믹스에서 목소리 스템을 **표본 단위로 빼면** 음악 스템을 얻을 수 있다 — Remotion 의 믹싱이
볼륨 배율 후 덧셈뿐이므로 성립할 것으로 보인다. 그러면 오디오 렌더가 2장 → 1장이 된다.
**검증하지 않았다.**

### 권장 — 먼저 지금 방식을 개선한다
**Premiere 도 볼륨 키프레임 방식이다.** 차이는 알고리즘이 아니라 **입력 해상도**다.

지금은 「목소리 클립이 있느냐」로만 판단한다. 대신 **파형 포락선**으로 판단하게 바꾼다 —
`makeWaveform` 이 이미 에셋마다 파형 JSON 을 만든다. Premiere 처럼 세 값을 노출한다:
**Sensitivity**(대사 사이 간격을 얼마나 인정할지) · **Duck Amount**(기본 −12dB) ·
**Fade Duration**(250~500ms).

**스키마 변경 없음, 렌더 변경 없음, 미리보기/렌더 일치 유지.**

파형 해상도가 문제라면: 지금 **1000버킷 고정**이라 60초 클립은 버킷당 60ms 다(음절이 100~200ms 이니
아슬아슬). **버킷당 고정 시간(20ms) + RMS** 로 바꾸면 된다 — 20줄 안쪽 수정.

### 진짜 컴프와 티가 나는 경우
1. **말 사이 짧은 틈** — 잘못 고르면 단어마다 음악이 펄떡인다(Premiere 의 Sensitivity 가 있는 이유)
2. **말 시작 순간** — 이징이 4종뿐이라 컴프의 지수 곡선과 다르다 (→ 4번 베지어 이징이 이것도 개선한다)
3. **음악이 이미 조용한 구간** — 진짜 컴프는 threshold 아래면 안 건드리는데 키프레임은 무조건 내린다

**티가 안 나는 경우 = 전형적인 15~30초 광고.** Premiere 가 키프레임으로 처리하는 바로 그 케이스다.

---

## 10. 색·블러 키프레임 — 스키마 확장

지금 `Keyframe.prop` 은 `'x'|'y'|'scale'|'rotation'|'opacity'|'volume'` 6종이다.

### 방법
`prop` 을 **경로 문자열**로 넓힌다: `effects[0].params.amount` · `crop.x` · `mask.x` ·
`chromaKey.similarity` · `curves.rgb` 등. 렌더러의 `interpolateKeyframes(kfs, prop, t, fallback)` 이
그 경로를 읽도록 고치고, 클립 종류별 허용 경로 목록을 `KEYFRAME_PROPS` 에서 검증한다.

**이게 7번(트래킹)의 선행 조건이기도 하다** — 마스크 위치를 프레임마다 바꾸려면 마스크에
키프레임을 걸 수 있어야 한다.

---

## 권장 순서

**1군 — 싸고 효과 확실 (의존성 0)**
1. **베지어 이징** — 구현이 이미 있다. 가장 싸고 「비싸 보이는 움직임」에 직결
2. **나레이션 EQ·컴프·라우드니스** — 0.2초, M2 파생에 그대로
3. **컷별 색 맞추기 + HSL 세컨더리** — 실측 94% / 5색 0. AI 광고의 최대 문제
4. **스코프** — 위 3번을 눈이 아니라 계기로 하게 해준다
5. **더킹 개선**(파형 포락선) + **모션 블러**(tmix + SVG 방향성)

**2군 — 중간**
6. **키프레임 대상 확장** — 7번의 선행 조건
7. **키네틱 타이포** — 의존성 0이지만 디자인 작업량이 있다
8. **자유 마스크**(펜 툴) — 렌더는 쉽고 UI 가 어렵다

**3군 — 크다**
9. **마스크 트래킹** — opencv 44MB + 스키마 선행
10. **진짜 사이드체인** — 실제로 되는 것을 증명함. 렌더 2.2배(옵션). 미리보기는 근사 = P3 그대로
11. **WebGL createEffect 경로** — `chromiumOptions` + `<Video>` 이사 검증이 선행

---

## 확신 못 하는 것 (전부 모아서)

- **모션 블러**: `@remotion/motion-blur` 가 비디오를 못 흐린다는 건 **소스 코드 추론**이다. 실제 렌더로
  검증하지 않았다(GPU 부하 회피).
- **트래킹 속도** 4.01ms 는 OpenCV 공식 벤치(Intel 12700K)이고 **이 컴퓨터에서 직접 재지 않았다.**
  ViT 가 사각형 크기 변화(스케일)를 얼마나 잘 따라가는지도 확인 못 했다.
- **YouTube −14 LUFS** 를 구글 1차 문서로 확인하지 못했다.
- **EQ 수치**(200Hz −3, 3.5kHz +3 등)는 「전형적 출발점」이지 표준이 아니다. 목소리마다 달라야 한다.
- **더킹 깊이 표**는 핑크 노이즈로 잰 값이다. 실제 음성은 다르게 나온다.
- ~~Remotion 이 오디오를 어떻게 섞는지 확인하지 않았다~~ → **확인 완료. 자체 ffmpeg 파이프라인이고,
  스템 렌더로 진짜 사이드체인이 된다는 것을 실제로 증명했다.**
- `mask: url(#id)` 가 `mixBlendMode`·부모 `transform` 과 겹칠 때 Chromium 좌표계가 어긋나는
  케이스가 있는지 확인 못 했다.
- `createEffect` 의 `runEffectChain` 이 `Promise` 를 돌려주는데 렌더가 `delayRender` 로 기다리는지
  끝까지 추적하지 못했다. **이펙트가 늦으면 프레임이 이펙트 없이 캡처될 위험.**
