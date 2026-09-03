# F11. 나레이션 오디오 체인 (W7 조사 #8)

## 무엇을 하나

**나레이션을 방송에서 나오는 목소리처럼 만든다.** 저역 잡음을 자르고, 치찰음(「ㅅ·ㅊ」의 쏘는 소리)을
누르고, 웅웅거림을 빼고 발음을 또렷하게 하고, 크기 편차를 압축한 뒤, **정해진 라우드니스에 정확히
앉힌다.** 지금 kitkat 의 오디오는 잡음 제거·피치 2종뿐이라 목소리가 「집에서 녹음한 것」처럼 들린다.

**W7 실측 (2026-09-02, 이 컴퓨터)**

| 처리 | 60초 오디오 기준 |
|---|---|
| 디코드만(기준선) | 224ms |
| **나레이션 체인 전체** | **556ms** |
| `loudnorm` 1패스 | 3,042ms (트루피크 검출로 192kHz 업샘플) |

speech.wav 실측 결과: **−21.8 → −15.9 LUFS**, 다이내믹 3.9 → 3.0 LU, 트루피크 −5.2 → −0.8 dBTP.
**2패스 `loudnorm` 을 붙이면 정확히 −14.0 LUFS 에 착지한다.**

**사실상 공짜다.** 60초 나레이션에 1초도 안 걸린다.

---

## 스키마

S3 가 정의한 `ClipSource.voice` 를 그대로 쓴다. **다만 `AudioClipSourceSchema` 도 같이 넓혀야 한다** —
지금 오디오 클립의 `source` 는 `denoise`·`pitch` 두 칸뿐인데(`packages/schema/src/index.ts:96`),
**나레이션은 대부분 audio 클립이다.**

```ts
// ClipSource 와 AudioClip['source'] 양쪽에
voice?: {
  preset: VoicePreset;              // 'off'|'broadcast'|'warm'|'bright'|'podcast'
  targetLufs?: number;              // -30..-9, 기본 -14
  reverb?: { irId: string; wet: number };   // wet 0..1
};
export type VoicePreset = 'off' | 'broadcast' | 'warm' | 'bright' | 'podcast';
```

- **`preset: 'off'` 는 정규화 단계에서 `voice` 필드째 지운다** (`normalizeClipSource`,
  `packages/ui/src/components/sections/inspector-utils.ts` 가 이미 쓰는 패턴). 그래야 `sourceKey`
  가 깨끗해지고 필요 없는 파생이 안 생긴다.
- **트루피크 목표는 −1.0 dBTP 로 고정하고 노브를 열지 않는다.** 조사가 권한 값이고, 잘못 만지면
  플랫폼 인코딩에서 클리핑이 난다. 필요해지면 그때 연다.
- `sourceKey` 에 `preset` · `targetLufs` · `reverb.irId` · `reverb.wet` 을 **전부** 넣는다.

---

## 체인 — 순서가 중요하다

W7 조사가 실측한 체인 그대로다. **2026-09-02 이 빌드에서 실제로 돌려 통과를 확인했다.**

```
highpass=f=80,                          # 저역 잡음 (에어컨·발소리·핸들링)
deesser=i=0.35:m=0.5:f=0.5,             # 치찰음 — 컴프 «앞»에!
equalizer=f=200:t=q:w=1.0:g=-3,         # 웅웅거림
equalizer=f=400:t=q:w=1.5:g=-2,         # 박스 울림
equalizer=f=3500:t=q:w=1.2:g=3,         # 발음 명료도
equalizer=f=10000:t=h:w=0.7:g=2,        # 공기감 (하이셸프)
acompressor=threshold=0.0891:ratio=3:attack=5:release=120:makeup=2:knee=6:detection=rms,
alimiter=limit=0.891:attack=5:release=50:level=false:latency=true
```

- **디에서가 컴프 앞인 이유:** 치찰음은 순간 피크가 크다. 컴프 뒤에 두면 컴프가 그 피크에 반응해
  **문장 전체를 헛되이 눌렀다 놓는다**(펌핑).
- `threshold=0.0891` = **−21 dBFS 의 선형값**이다. dB 가 아니라 `10^(dB/20)`.
  `alimiter` 의 `limit=0.891` = **−1.0 dBFS**.
- **`makeup=2` 는 2배(=+6dB)** 다. `acompressor` 의 makeup 범위는 **1..64**(1이 무보정) —
  0을 넣으면 거부된다.

### ⚠️ 실측으로 찾은 함정 — `alimiter` 의 기본값 두 개 (2026-09-02, 이 빌드)

`ffmpeg -h filter=alimiter` 로 확인한 기본값: **`level=true`(자동 레벨링), `latency=false`.**

`level=true` 는 리미터에 **닿지도 않은 신호까지 끌어올린다.** 직접 재 봤다:

| | mean | max |
|---|---|---|
| 원본 (−38dB 사인) | −41.1 | −38.1 |
| `alimiter=limit=0.891` **기본값** | −40.1 | **−37.1** |
| `alimiter=...:level=false` | −41.1 | −38.1 |

**아무것도 안 눌렀는데 +1.0dB 가 붙는다.** 게인 조정은 `loudnorm` 이 할 일이지 리미터가 할 일이
아니다 → **반드시 `level=false`.**
`latency=true` 는 룩어헤드(attack 5ms) 지연을 보정하고 EOF 에서 버퍼를 비운다 → **파생 파일 길이가
소스와 어긋나지 않게** 켠다. (이 실험에서는 길이가 5.000000초로 양쪽 다 같았지만, 소스가 리미터에
실제로 걸릴 때도 같은지는 검증에서 확인한다.)

### 디에서 — `adeesser` 는 없고 `deesser` 는 정밀하지 않다

**`adeesser` 는 이 빌드에 없다.** `deesser` 가 있고 파라미터는 이렇다(확인함):
```
i : 강도       0..1
m : 최대 감쇠  0..1
f : 주파수     0..1   ← 「6kHz」 같은 지정이 불가능하다. 정규화된 위치일 뿐
s : 출력       i(입력)|o(출력)|e(치찰음만)
```
**「6.5kHz 를 6dB 누르기」를 표현할 수 없다.** 목소리마다 치찰음 대역이 다른데(여성 6~9kHz,
남성 5~7kHz) 그걸 맞출 방법이 없다.

**대안: `adynamicequalizer` 가 이 빌드에 있다** (확인함). 특정 주파수만 감지해서 그 주파수만 누르는
진짜 다이내믹 EQ 다:
```
adynamicequalizer=dfrequency=6500:dqfactor=1.5:tfrequency=6500:tqfactor=1.5
                 :tftype=bell:threshold=0.05:ratio=4:attack=1:release=50:mode=cutabove
```
- `dfrequency`/`tfrequency` 를 **목소리별로 지정할 수 있다** — 이게 `deesser` 와의 결정적 차이다.
- `mode` 는 `listen|cutbelow|cutabove|boostbelow|boostabove`, `auto` 로 적응형 임계도 된다.
- **⚠️ 확인 필요:** `cutabove` 와 `cutbelow` 중 어느 쪽이 「감지 신호가 임계를 넘을 때 누른다」인지
  **문서만 보고 확신할 수 없다.** 확인 방법: 치찰음이 많은 샘플에 두 모드를 각각 걸고
  **6~9kHz 대역 에너지를 재서** 줄어드는 쪽을 고른다. `mode=listen` 으로 감지 신호 자체를 뽑아
  치찰음 구간에서만 커지는지도 본다.

**둘 다 만들고 재서 정한다.** 「`deesser` 가 정밀하지 않으니 디에서를 뺀다」는 하지 않는다.
검증 4번에서 두 방법의 6~9kHz 감쇠량을 재고, 나은 쪽을 프리셋 기본값으로 박는다.

---

## 2패스 loudnorm — `audioFilterChain()` 구조에 안 맞는 것을 어떻게 푸나

### 왜 안 맞나
`audioFilterChain(spec)`(derive.ts:67)은 **필터 문자열 하나**를 돌려주고 `deriveMedia` 가 `-af` 로
넘긴다. 2패스는 **1패스에서 잰 값을 2패스 인자에 넣어야** 하므로 문자열 하나로 표현이 안 된다.

### `deriveMedia` 가 vidstab 을 처리하는 방식을 그대로 흉내낸다

지금 vidstab 은 이렇게 돈다(derive.ts:136-153):
1. `vidstabdetect=...:result=tr.trf` 로 `-f null -` 측정 패스 → **tmp 폴더에 `tr.trf` 파일**
2. `vidstabtransform=input=tr.trf` 로 적용 패스
3. **cwd 를 tmp 로 잡아 짧은 상대 이름**을 쓴다 (Windows 절대경로의 드라이브 콜론이 ffmpeg 필터
   인자를 깨는 것을 피하려고 — derive.ts:130 주석)

**`loudnorm` 도 파일로 결과를 낼 수 있다.** `stats_file` 옵션이 있고, 2026-09-02 이 빌드에서
**직접 돌려 확인했다**:
```
ffmpeg -i t.wav -af "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json:stats_file=ln.json" -f null -
```
```json
{ "input_i":"-41.75", "input_tp":"-38.05", "input_lra":"0.00", "input_thresh":"-51.75",
  "output_i":"-14.03", "output_tp":"-10.26", "output_lra":"0.00", "output_thresh":"-24.03",
  "normalization_type":"dynamic", "target_offset":"0.03" }
```

**stderr 를 파싱할 필요가 없다.** `runFfmpeg` 이 `-v error` 를 강제하고 stderr 를 안 돌려주는 문제도,
Windows 경로 문제도 **`stats_file` + `cwd=tmp` 로 한 번에 사라진다.** vidstab 의 `tr.trf` 와 완전히
같은 모양이다.

### 새 파일

```ts
// packages/media/src/voice.ts (신규)
export type VoicePresetId = 'broadcast' | 'warm' | 'bright' | 'podcast';
export type VoiceSpec = {
  preset: VoicePresetId;
  targetLufs: number;              // 기본 -14
  deEsser: 'deesser' | 'dyneq';    // 검증 4번에서 정한 기본값
  reverb?: { irAbs: string; wet: number };
};

/** loudnorm 앞까지의 필터 문자열 (highpass→deesser→EQ→comp→limiter). 리버브는 별도. */
export function voiceChain(spec: VoiceSpec): string;

export type LoudnormStats = {
  input_i: string; input_tp: string; input_lra: string; input_thresh: string;
  output_i: string; output_tp: string; output_lra: string; output_thresh: string;
  normalization_type: 'linear' | 'dynamic';
  target_offset: string;
};
/** 1패스: <chain>,loudnorm=...:print_format=json:stats_file=<name> 를 -f null 로. */
export function loudnormMeasureFilter(chain: string, target: {...}, statsName: string): string;
/** 2패스: measured_* 를 채운 loudnorm 인자. */
export function loudnormApplyFilter(chain: string, target: {...}, m: LoudnormStats): string;
```

### `deriveMedia` 변경 — 가변 패스 수

지금:
```ts
const passes = (useStab ? 2 : 0) + (needStageB ? 1 : 0) + (audioOnly ? 0 : 1);
```
바꿀 것:
```ts
const passes = (useStab ? 2 : 0) + (useVoice ? 1 : 0) + (needStageB ? 1 : 0) + (audioOnly ? 0 : 1);
//                                   ^ loudnorm 측정 패스
```
`endPass()`/`passProgress` 는 이미 「done/passes」로 계산하므로 **분모만 늘리면 끝이다.**
S3 가 요구한 「가변 패스 수 일반화」가 실질적으로 이 한 줄이다.

**측정 패스는 체인 «적용 후»의 오디오를 재야 한다** — 컴프와 리미터가 라우드니스를 바꾸니까.
그래서 1패스도 `<체인>,loudnorm=...` 로 체인을 통째로 한 번 더 돌린다. 오디오라 싸다(60초 0.56초).

### ⚠️ 반드시 지킬 함정 두 가지

**(1) `-ar 48000` 을 2패스 출력에 명시한다.**
`loudnorm` 은 트루피크 검출을 위해 **내부에서 192kHz 로 업샘플**한다. 출력 샘플레이트를 안 적으면
그대로 192kHz 로 인코딩되어 파일이 커지고 일부 플레이어가 못 읽는다.
지금 `deriveMedia` 의 오디오 경로(derive.ts:158)는 `-c:a aac -b:a 192k` 만 있다 → **`-ar 48000` 추가.**

**(2) 소스 LRA 가 목표보다 작으면 조용히 dynamic 모드로 떨어진다.**
`loudnorm` 의 `linear` 는 **기본값이 `true`** 인데, 소스의 다이내믹 폭(LRA)이 목표 LRA 보다 좁으면
linear 로 못 가고 **말없이 dynamic 으로 바뀐다.** 위 실측이 그 예다 — 순수 사인은 `input_lra: 0.00`
이라 `normalization_type: "dynamic"` 이 찍혔다.

dynamic 이 나쁜 건 아니다(시간에 따라 게인을 조절해 목표에 맞춘다). **문제는 사용자가 모르는 것이다.**
→ **2패스 출력의 `stats_file` 도 읽어서 `normalization_type` 을 잡 결과에 담는다.**
인스펙터에 숫자와 함께 표시한다:
> 목표 LRA 11 보다 원본 다이내믹(3.9)이 좁아 **dynamic 모드**로 처리했습니다.

**LRA 목표를 자동으로 낮추지 않는다.** 그건 목표를 몰래 바꾸는 것이다.

---

## 프리셋 5종 — 실제 인자 차이

| | `off` | `broadcast` | `warm` | `bright` | `podcast` |
|---|---|---|---|---|---|
| highpass f | — | 80 | 100 | 90 | 75 |
| deesser i / m | — | 0.35 / 0.5 | 0.30 / 0.5 | **0.45** / 0.6 | 0.35 / 0.5 |
| dyneq dfreq (대안 쓸 때) | — | 6500 | 6000 | **7000** | 6500 |
| EQ 200Hz (q, w=1.0) | — | **−3** | **+1.5** | **−4** | −2 |
| EQ 400Hz (q, w=1.5) | — | −2 | −1 | −3 | −2 |
| EQ 3.5kHz (q, w=1.2) | — | +3 | +1.5 | **+4.5** | +3 |
| EQ 10kHz (하이셸프, w=0.7) | — | +2 | **0** | **+3.5** | +1.5 |
| acompressor threshold | — | 0.0891 (−21dB) | 0.0891 | 0.0891 | **0.0631 (−24dB)** |
| ratio | — | 3 | 2.5 | 3 | **4** |
| attack / release (ms) | — | 5 / 120 | 10 / 200 | 3 / 100 | 5 / 150 |
| makeup | — | 2 | 2 | 2 | 2 |
| alimiter limit | — | 0.891 | 0.891 | 0.891 | 0.891 |
| loudnorm LRA 목표 | — | 11 | 11 | 11 | **7** |

**성격 차이를 한 줄로:**
- **broadcast** — 기준. 뉴스·광고 나레이션. W7 이 실측한 그 체인.
- **warm** — 200Hz 를 **깎지 않고 올린다**(+1.5). 고역을 안 올려 두툼하고 부드럽다. 저음 목소리·
  브랜드 영상용. highpass 를 100Hz 로 올려 웅웅거림만 자른다.
- **bright** — 고역을 크게 올리고(3.5k +4.5, 10k +3.5) 저역을 더 깎는다. 웅얼거리는 녹음을
  또렷하게. **고역을 올리면 치찰음도 같이 커지므로 디에서를 세게(0.45) 건다.**
- **podcast** — ratio 4, threshold 낮춤(−24dB)으로 **항상 압축**해 크기를 균일하게. LRA 7 로
  다이내믹을 좁힌다. 이어폰·차 안처럼 시끄러운 데서 듣는 상황용.
- **off** — 아무것도 안 건다. `loudnorm` 도 안 한다. UI 의 「없음」이 곧 off.

**⚠️ 이 EQ 수치는 「전형적 출발점」이지 표준이 아니다.** 목소리마다 달라야 한다. 프리셋으로
대부분을 덮되, 개별 EQ 노브는 **이번에 안 만든다** — 값의 뜻을 모르면 프리셋보다 나빠진다.
필요해지면 「고급」 접이식으로 나중에 연다.

---

## 리버브

ffmpeg 에 전용 리버브가 없다. 둘 다 만들고 UI 에서 고르게 한다.

### (a) `aecho` 다중 탭 — 가볍다
```
aecho=0.8:0.85:29|37|47|59:0.18|0.14|0.10|0.07
```
IR 파일이 필요 없고 `-af` 문자열 하나에 들어간다. **초기 반사만 흉내내고 꼬리가 없다** — 「살짝
공간감」 정도지 방 소리가 아니다. 「스튜디오 살짝」 프리셋으로 쓴다.

### (b) `afir` 컨볼루션 — 진짜 리버브
**2026-09-02 확인한 파라미터:** `dry` 0..10(기본 1) · `wet` 0..10(기본 1) · `gtype`(자동 게인,
기본 peak) · **`irfmt`: `mono`|`input`** · `maxir` 기본 30초 · `irgain` · `irnorm`.

**입력이 2개라 `-af` 로는 안 되고 `-filter_complex` 여야 한다.** `deriveMedia` 는 LUT intensity<1
경로에서 이미 `-filter_complex` 를 쓰고 있다(derive.ts:176) — 그 형태를 따른다.

```
-i <src> -i vendor/ir/<irId>.wav
-filter_complex "[0:a]<voiceChain>,aformat=channel_layouts=stereo[dry];
                 [dry][1:a]afir=dry=1:wet=<wet>:irfmt=input:gtype=peak[rv];
                 [rv]loudnorm=I=..:TP=-1.0:LRA=..:measured_i=..[out]"
-map 0:v? -map "[out]" -ar 48000
```
- **모노 나레이션 + 스테레오 IR 은 채널이 안 맞아 실패한다.** → **나레이션을 먼저 스테레오로
  올린다**(`aformat=channel_layouts=stereo`). 리버브의 공간감은 스테레오여야 의미가 있으므로
  IR 을 모노로 깎는 것보다 이쪽이 맞다.
  **⚠️ 확인 필요:** `irfmt=input` 이 이 조합에서 실제로 통과하는지. 안 되면 `irfmt=mono` 로 IR 을
  모노 취급하고 나레이션도 모노로 둔다.
- `wet` 은 0..10 인데 **UI 는 0..1** 로 받는다 → `wet = wet01`, `dry = 1` 고정. 레벨 변화는
  뒤의 `loudnorm` 이 잡는다.
- **IR 은 loudnorm 앞에 온다** — 리버브가 라우드니스를 바꾸므로 측정도 리버브 뒤에서 해야 한다.

### IR 을 어디서 가져오나 (2026-09-02 직접 확인)

| 출처 | 상태 | 라이선스 | 결정 |
|---|---|---|---|
| OpenAIR (york.ac.uk) | **죽었다** (Account Suspended) | 접근 불가 | 못 쓴다 |
| **Voxengo IM Reverbs** | 살아 있음, 6.9MB, 41개 | **"royalty-free for any purpose, including commercial usage"** | **이걸 쓴다** |
| EchoThief | 살아 있음 | **사이트에 라이선스 문구가 없다** | 안 쓴다 |
| MIT IR Survey | 271개 | 출처마다 엇갈림 | 안 쓴다 |

**Voxengo 에 「파일 자체를 팔거나 배포로 수익 금지」 조항이 있다.** 에이전트 도구로 쓰는 건
무방하지만 **kitkat 을 팔 계획이 생기면 재확인해야 한다** — 이 문장을 코드 주석에도 남긴다.

**설치:** `scripts/prewarm.mjs voice-ir` → `vendor/ir/voxengo/*.wav`.
**리포에 넣지 않는다** — `vendor/` 는 이미 `.gitignore` 에 있고 6.9MB 바이너리를 깃에 넣을 이유가 없다.
`irId` 는 번들 IR 의 id(`voxengo/hall-medium` 등). **사용자 IR 임포트는 이번에 안 한다** —
`Asset.kind` 에 `'ir'` 을 추가해야 하는 별도 작업이고, 41개면 광고 나레이션에는 충분하다.

---

## 라우드니스 목표 — 정직하게

- **YouTube/Spotify −14 LUFS 가 널리 쓰인다. 그런데 구글 1차 문서를 찾지 못했다** (2026-09-02).
- **TikTok·Instagram·Facebook 은 공표하지 않는다.** 온라인에 도는 수치는 전부 추정이다.
- → **기본값 −14 LUFS / −1.0 dBTP.** UI 에 이렇게 적는다:
  > −14 LUFS 는 널리 쓰이는 관행값입니다. 플랫폼 공식 문서로 확인된 값이 아닙니다.
- **확인 방법이 있다**: −14 / −18 / −20 LUFS 로 만든 같은 영상을 YouTube 에 올리고 플레이어의
  「Stats for nerds」에 나오는 **content loudness** 를 읽으면 실측된다. **F17(검증 부채)에 넣는다.**

---

## 붙이는 자리

| | 파일 | 무엇 |
|---|---|---|
| 스키마 | `packages/schema/src/index.ts` | `ClipSource.voice` · `AudioClipSourceSchema` 확장 |
| 키 | `packages/schema/src/derive.ts` | `sourceKey` 에 voice 4필드 |
| 체인 | `packages/media/src/voice.ts` (신규) | 프리셋 → 필터 문자열, loudnorm 측정/적용 |
| 굽기 | `packages/media/src/derive.ts` | `audioFilterChain` 확장, 측정 패스 추가, `-ar 48000` |
| 잡 | `packages/server/src/routes/commands.ts` | `scheduleDeriveJobs` 에서 `source.voice` → `DeriveSpec` |
| UI | `packages/ui/src/components/sections/SourceSection.tsx` | 「나레이션」 블록 |

### UI
```
나레이션      [ 방송용 ▾ ]        (없음 / 방송용 / 따뜻하게 / 또렷하게 / 팟캐스트)
목표 크기     [====●======] -14 LUFS
공간감        [ 없음 ▾ ]          (없음 / 스튜디오 살짝 / Voxengo IR 41종…)
              [==●========] 30%
──────────────────────────────
측정 결과     -21.8 → -14.0 LUFS · 트루피크 -0.8 dBTP · linear
```
- **측정 결과를 보여주는 것이 핵심이다.** 「좋아졌다」가 아니라 숫자로.
- `normalization_type` 이 `dynamic` 이면 노란 배지로 이유와 함께 표시.
- audio 클립에서도 이 블록이 나와야 한다 — 지금 `SourceSection` 은 LUT·손떨림만 video 전용으로
  가르고 있으므로 나레이션 블록은 **video·audio 양쪽**에 둔다.

---

## 검증 — 숫자로 낸다

**1. 라우드니스 착지** — 프리셋 4종 × 소스 3종(조용한 −30 LUFS / 보통 −22 / 큰 −12)에 대해
처리 후 LUFS·LRA·트루피크를 `loudnorm print_format=json` 1패스로 잰다.
**목표 −14.0 ± 0.5 LUFS, 트루피크 ≤ −1.0 dBTP 면 합격.** W7 의 −21.8 → −14.0 이 재현돼야 한다.

**2. `normalization_type`** — 위 12조합 각각에 대해 `linear` 인지 `dynamic` 인지 표로 남긴다.
dynamic 이 뜨는 조건(소스 LRA < 목표 LRA)이 예상과 맞는지 확인.

**3. `-ar` 검사** — 출력 파일의 샘플레이트가 **48000** 인지 `ffprobe` 로. `-ar` 을 뺀 버전도 돌려
**실제로 192000 이 나오는지** 확인한다(함정이 진짜인지 확인).

**4. 디에서 — `deesser` vs `adynamicequalizer` 대결** *(어느 쪽을 기본으로 할지 이걸로 정한다)*
치찰음이 많은 샘플에 각각 걸고 **6~9kHz 대역 에너지**를 비교:
```
ffmpeg -i out.wav -af "highpass=f=6000,lowpass=f=9000,volumedetect" -f null -
```
- **3dB 이상 줄어야** 디에서가 동작한 것으로 본다.
- 동시에 **1~4kHz(발음 대역) 에너지가 1dB 이상 줄면 안 된다** — 목소리까지 깎은 것이다.
- `deesser=s=e` 로 「치찰음만」 출력을 뽑으면 무엇을 잡았는지 직접 들을 수 있다.
- `adynamicequalizer` 의 `cutabove`/`cutbelow` 판정(위 「확인 필요」)도 여기서 끝낸다.

**5. `alimiter` 기본값 함정 재현** — `level=true`/`false` 로 각각 굽고 **max_volume 차이가 1.0dB**
인지(위 실측 재현). `latency=true`/`false` 로 굽고 **파일 길이가 소스와 같은지** — 리미터에 실제로
걸리는 큰 신호에서도 확인한다.

**6. 시간** — 60초 나레이션 기준. W7 실측 체인 0.556초 + loudnorm 2패스. 총 몇 초인지 실측해서
이 문서에 적는다. **30초 광고 나레이션이 5초를 넘으면** 어디가 느린지 나눠서 잰다.

**7. 리버브** — `afir` wet 0 / 0.3 / 0.6 으로 굽고 **RT60**(잔향이 −60dB 까지 떨어지는 시간)을
측정. wet 이 오를수록 길어져야 한다. 모노 나레이션 + 스테레오 IR 이 **실패하지 않는지** 확인.
`aecho` 다중 탭과 RT60·명료도를 비교해 각각 어디에 쓸지 문서에 적는다.

**8. `sourceKey` 빠뜨림 검사** — `preset`·`targetLufs`·`reverb.irId`·`reverb.wet` 각각을 바꿔
**전부 다른 키**가 나오는지.

**9. 파생 파일 길이** — 처리 전후 duration 이 **±10ms 이내**인지. 클립의 `in`/`out` 은 소스 ms
기준이라 길이가 바뀌면 편집이 어긋난다.

---

## 하지 않을 것

- **`deesser` 가 정밀하지 않다고 디에서를 빼지 않는다.** 두 방법을 다 재고 나은 쪽을 기본으로 한다.
- **2패스가 번거롭다고 1패스 `loudnorm` 으로 도망가지 않는다.** 1패스는 앞을 못 보고 실시간으로
  게인을 조절하므로 시작 부분이 틀리고 최종 통합 라우드니스가 목표에서 벗어난다. 2패스가
  **정확히 −14.0** 에 앉는 것이 실측으로 확인됐다.
- **`normalization_type: dynamic` 을 숨기지 않는다.** 내가 지정한 것과 다른 처리가 됐다는 사실을
  사용자가 알아야 한다. 그렇다고 LRA 목표를 몰래 낮추지도 않는다.
- **라이선스가 애매한 IR 을 쓰지 않는다.** EchoThief·MIT IR Survey 는 확인될 때까지 안 쓴다.
- **−14 LUFS 를 「YouTube 공식」이라고 쓰지 않는다.** 관행값이라고 쓰고, 확인 방법을 F17 에 남긴다.
- **`alimiter` 의 자동 레벨링을 켠 채 두지 않는다.** +1.0dB 가 몰래 붙는 것을 실측했다.
- **개별 EQ 노브를 「나중에」로 미루면서 프리셋 값을 대충 잡지 않는다.** 프리셋 4종의 성격 차이를
  위 표대로 명확히 만들고, 검증 1·4번으로 각각이 실제로 다르게 동작하는지 확인한다.
