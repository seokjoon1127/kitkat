# F14. WebCodecs 프리뷰 엔진 (고해성사 #3)

## 무엇을 잘못했나

W5 백로그 항목 이름이 **「WebCodecs+WebGL 프리뷰 엔진 v2」** 였다. 그런데 완성된 것에는
**WebCodecs 가 없다.** 담당의 보고:

> WebCodecs 는 실제 디코딩에 안 쓴다. `VideoDecoder` 는 mp4 demuxer 가 있어야 하는데
> 브라우저에 없고 **외부 라이브러리 금지**라, 항상 `HTMLVideoElement` 경로다.

**그 「외부 라이브러리 금지」는 내가 서브에이전트 제약에 써넣은 규칙이다. 사용자가 정한 게 아니다.**
즉 내가 만든 제약이 내가 만들어야 할 기능을 막았고, 나는 그 보고를 받고 그대로 넘어갔다.

**확인함(2026-09-02):** npm 에 `mp4box@2.4.1` · `mediabunny@1.55.5` 가 있다.

## 왜 이게 중요한가 (성능 근거)

지금 `packages/ui/src/preview/decoder.ts` 는 이렇게 동작한다:
- **재생 중**: `<video>` 엘리먼트를 그대로 텍스처로 올린다 (`requestVideoFrameCallback`)
- **정지·스크럽 중**: `video.currentTime = t` 로 **시크**하고 `createImageBitmap` → LRU 캐시

문제는 **시크**다. `<video>` 시크는 키프레임으로 되감고 거기서부터 디코딩하므로
**한 프레임에 수십~수백 ms** 가 걸린다. 타임라인을 드래그하면 그래서 끊긴다.
WebCodecs `VideoDecoder` 는 **디코드된 프레임을 직접 받아 큐에 쌓을 수 있어**
스크럽·역방향 재생·프레임 단위 이동이 즉시 반응한다. **이게 「프리뷰 엔진 v2」의 존재 이유였다.**

## 할 것

### 라이브러리 선택 — 둘 다 조사하고 정한다
| | mp4box.js (`mp4box`) | mediabunny |
|---|---|---|
| 역할 | MP4 분해(demux) 전용 | 분해 + WebCodecs 래핑 + 인코딩까지 |
| 크기 | 작음 | 큼 |
| WebM 지원 | ✕ (MP4 계열만) | ○ |
| 성숙도 | 오래됨, Remotion 등 다수 사용 | 새로움 |

**kitkat 에는 WebM 이 필요하다** — GIF 스티커를 `libvpx-vp9 yuva420p` webm 으로 변환해 쓴다(W5).
프록시는 mp4 지만 스티커는 webm 이다.
→ **결정 기준: mediabunny 로 둘 다 처리되면 mediabunny 하나. 안 되면 mp4box + webm 은 `<video>` 폴백.**
**이건 실제로 시험해 보고 정한다. 미리 단정하지 않는다.**

### 구조
```ts
// packages/ui/src/preview/webcodecs.ts (신규)
export type FrameSource = {
  /** 지정 소스 시각(ms)의 프레임. 큐에 있으면 즉시, 없으면 디코드. */
  frameAt(srcMs: number): Promise<VideoFrame | ImageBitmap | null>;
  /** 재생 방향·속도를 알려 주면 미리 디코드해 둔다 */
  hint(srcMs: number, direction: 1 | -1, rate: number): void;
  close(): void;
};
export function createWebCodecsSource(url: string): Promise<FrameSource | null>;  // 불가하면 null
export const webCodecsSupported: boolean;
```

`decoder.ts` 는 **3단 폴백**이 된다:
```
1. WebCodecs (mediabunny/mp4box) — 지원되고 컨테이너를 열 수 있으면
2. <video> + requestVideoFrameCallback — 재생 중
3. <video> 시크 + createImageBitmap — 정지 중 (지금 경로)
```
**기존 경로를 지우지 않는다.** WebCodecs 가 실패해도 지금 수준으로는 돌아야 한다.

### 디코드 큐 전략 (스크럽이 빨라지는 핵심)
- GOP(키프레임 간격) 단위로 **앞으로 N프레임 미리 디코드**해 링버퍼에 둔다(기본 60프레임).
- 재생 방향이 역방향이면 **GOP 를 통째로 디코드해 역순으로 보관**한다
  (역재생은 원래 이 방법밖에 없다).
- `VideoFrame` 은 **명시적으로 `close()` 해야 GPU 메모리가 풀린다.** 링버퍼에서 밀려나는 즉시 닫는다.
  → 안 닫으면 브라우저가 디코더를 멈춘다. **이 프로젝트에서 제일 흔한 실수 지점이라 테스트로 못 박는다.**

### 프록시 파일과의 관계
프록시는 `libx264 -crf 28 scale=-2:540`(W1-C)이다. **키프레임 간격이 기본값(약 250프레임)이라
스크럽에 최악이다.** → `makeProxy` 에 **`-g 15`(0.5초마다 키프레임)** 를 추가한다.
파일이 조금 커지지만 스크럽 응답이 결정적으로 좋아진다. **이건 프록시의 존재 이유(편집 반응성)에 맞는 변경이다.**

## 검증 — 숫자로 낸다

**1. 스크럽 지연** — 타임라인을 임의 지점 50곳으로 점프하며 「요청 → 화면 갱신」 시간을 잰다.
지금 경로 vs WebCodecs 경로. **이게 이 기능의 존재 이유이므로 이 수치가 안 좋으면 실패다.**

**2. 역재생** — 역방향 스크럽 30회의 평균 지연.

**3. 메모리** — 5분 스크럽 후 `performance.memory` 와 GPU 메모리. `VideoFrame` 누수 확인.

**4. 폴백** — WebCodecs 를 강제로 끄고(플래그) 지금 경로로 정상 동작하는지.

**5. 컨테이너 커버리지** — mp4(프록시)·webm(스티커)·원본(사용자 임포트 다양한 코덱)에서
각각 WebCodecs 가 열리는지, 안 열리면 폴백되는지.

**6. 프록시 `-g 15` 의 대가** — 파일 크기 증가율과 스크럽 개선폭을 함께 잰다.

## 브라우저 검증이 필수다
이 기능은 **브라우저에서만 동작을 확인할 수 있다.** 단위 테스트로는 큐 로직·LRU 만 검증된다.
→ Chrome 확장으로 실제 편집기를 열어 스크럽하고 위 수치를 재는 것까지가 이 태스크의 완료 조건이다.
(F17 검증 부채와 함께 처리)

## 하지 않을 것
- **「라이브러리 추가가 부담스러워서」 안 하지 않는다.** npm 패키지 하나다.
- WebCodecs 가 일부 컨테이너에서 안 열린다고 **기능 전체를 폴백으로 돌리지 않는다.**
  열리는 것은 WebCodecs 로 간다.
