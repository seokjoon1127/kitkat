# F2. 프레임 보간 — RIFE (고해성사 #2)

## 무엇을 잘못했나

F1 과 같은 D10 결정으로 RIFE 를 minterpolate 로 바꿨다. 그리고 **F1(업스케일)은 사용자가
지적해서 다시 봤지만, F2 는 아무도 안 물어봐서 그대로 남아 있었다.** 같은 잘못을 두 번 했고,
한 번은 스스로 못 찾았다.

**확인함(2026-09-02): `nihui/rife-ncnn-vulkan` 의 윈도우 릴리스가 실재한다** —
`rife-ncnn-vulkan-20221029-windows.zip`. realesrgan 과 **같은 저자·같은 ncnn 백엔드·같은 CLI 형태**다.
torch 불필요.

## 지금 상태

`interpolateFps()` = `minterpolate=fps=N:mi_mode=mci:mc_mode=aobmc:vsbmc=1`.

minterpolate 는 블록 매칭 기반이라 **가림(occlusion)·빠른 움직임에서 찢김·왜곡**이 생긴다.
RIFE 는 광학 흐름을 학습한 신경망이라 그 부분이 눈에 띄게 낫다 — 다만 **이 컴퓨터에서 실측해
증명해야 한다.**

## 할 것

S4 의 `ncnn.ts` 백엔드에 `rife` 를 추가한다.

### RIFE CLI 의 특성 (realesrgan 과 다른 점 — 주의)
- **입력이 「프레임 폴더」이고 출력도 「프레임 폴더」인 것은 같다.**
- `-m model-path` 로 모델 폴더 지정 (`rife-v4.6` 등 여러 개 동봉).
- **`-n frame-count`** 로 출력 프레임 수를 지정한다 — 즉 **임의 배율**이 된다
  (`-n` 없이 쓰면 2배). 30→60 도, 24→48 도, 30→120 도 가능.
- `-u` = UHD 모드(큰 해상도에서 정확도 보정), `-g gpu-id`, `-j load:proc:save`, `-x` = TTA(느리지만 정확).
- **모델별 특성이 다르다**: `rife-v4.6` 이 속도·품질 균형, `rife-v2.3`/`v3.1` 은 구형,
  `rife-anime` 계열은 애니메이션용. **실측으로 고른다.**

### API
```ts
// packages/media/src/interpolate.ts (신규)
export type InterpEngine = 'auto' | 'ai' | 'minterpolate';

export function interpolateFps(absSrc: string, outAbs: string, opts: {
  fps: number;                    // 목표 fps
  engine?: InterpEngine;          // 기본 'auto'
  model?: string;                 // 기본 'rife-v4.6'
  uhd?: boolean;                  // 1440p 이상이면 자동 true
  gpuId?: number;
  onProgress?: (p: number) => void;
}): Promise<{ engine: 'ai' | 'minterpolate'; seconds: number }>;
```

### 파이프라인
```
1) 원본 fps·프레임 수를 ffprobe 로 확정
2) 목표 프레임 수 = round(원본프레임수 × 목표fps / 원본fps)
3) 청크 루프 (S4, 기본 120프레임):
   a. ffmpeg: 구간 → PNG 시퀀스
   b. rife-ncnn-vulkan -i in -o out -m <model> -n <청크목표프레임수> -g <gpu> [-u]
   c. ffmpeg: out → 청크 mp4 (-r 목표fps)
   d. tmp 비우기
4) concat + 오디오 (오디오는 원본 그대로, 길이 동일)
```

**⚠️ 청크 경계 문제.** 프레임 보간은 «앞뒤 프레임»이 필요하다. 청크를 그냥 자르면 경계에서
보간이 끊긴다. → **청크마다 앞뒤로 1프레임씩 겹쳐서 추출하고, 결과에서 겹친 부분을 버린다.**
(S4 의 `ncnnRun` 에 `overlapFrames` 옵션을 둔다.)

### 서버 / UI
`POST .../interpolate` body 에 `engine?` · `model?` 추가. `engine:'ai'` + 미설치 → **501**.
UI 는 F1 과 같은 형태(드롭다운 + 프레임 진행률).

### prewarm
```
node scripts/prewarm.mjs rife
```
→ `vendor/rife/` 에 푼다. **F1 과 같은 경고**(GPU 드라이버 사고 이력)를 출력한다.

## 검증 — 숫자로 낸다

**1. 보간 정확도 — 「빼놓고 맞히기」 시험**
30fps 원본에서 **짝수 프레임만 남겨 15fps 소스**를 만들고, 그걸 30fps 로 보간한 뒤
**원래 홀수 프레임과 비교**한다(PSNR·SSIM). 정답이 있는 시험이라 minterpolate 와 RIFE 를
공정하게 비교할 수 있다. **이게 이 기능의 핵심 검증이다.**

**2. 가림·빠른 움직임** — 물체가 다른 물체 뒤로 지나가는 합성 영상을 만들어
찢김/왜곡을 육안·차분 이미지로 비교한다. minterpolate 가 특히 약한 지점이다.

**3. 속도** — 프레임당 초, 30초 30→60fps 환산. GPU/CPU.

**4. 모델 비교** — `rife-v4.6` vs 다른 동봉 모델을 1번 시험으로 비교해 기본값을 정한다.

**5. 안정성** — F1 과 동일. **Intel GPU 로 먼저, 짧게, 이벤트 로그 확인.**

## 하지 않을 것
- **RIFE 가 느리다고 minterpolate 를 기본으로 밀지 않는다.** `engine:'auto'` 는
  「AI 가 가능하면 AI」다. 느린 건 진행률로 보여주면 된다.
- 1번 시험 결과가 나쁘게 나오면 **그대로 보고한다.** 숨기고 minterpolate 로 돌리지 않는다.
