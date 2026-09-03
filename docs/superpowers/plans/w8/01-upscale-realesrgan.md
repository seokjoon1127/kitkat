# F1. 업스케일 — Real-ESRGAN (고해성사 #1)

## 무엇을 잘못했나

W5 계획서 D10 에 이렇게 썼다:

> **D10 업스케일·프레임 보간은 ffmpeg 으로 한다(Real-ESRGAN·RIFE 대신).** PRD 는 ML 모델을
> 적었지만 둘 다 torch(2.5GB+) 설치가 필요하고 이 머신에 없다.

**torch 가 필요 없는 독립 실행 파일이 존재한다.** 5분만 찾아봤으면 나왔다. 찾지 않고 결정했다.
PRD §5 ③군은 명시적으로 「업스케일(Real-ESRGAN)」이라고 적혀 있었다.

## 지금 상태

`packages/media/src/derive.ts` 의 `upscaleVideo()` = `scale=iw*N:ih*N:flags=lanczos,unsharp=...`.

**실측(2026-09-02):** 270×480 crf34 로 망가뜨린 소스를 1080×1920 으로 되돌려 원본과 비교 —

| 방식 | PSNR | SSIM |
|---|---|---|
| 그냥 늘리기(bicubic) | 29.48 | 0.921 |
| 현재(lanczos+unsharp) | 29.62 | 0.919 |
| deblock+denoise 추가 | 29.60 | 0.919 |

**고전 필터로는 더 짜낼 것이 없다.** 없는 디테일은 안 생긴다.

## 할 것

`vendor/realesrgan/realesrgan-ncnn-vulkan.exe` (**이미 받아져 있다**, 51MB) 를 실제로 붙인다.
S4 의 `ncnn.ts` 백엔드를 쓴다.

### 확인된 사실
- 실행 파일에 **`-g gpu-id`** 옵션이 있다(직접 확인). GPU 를 골라 쓸 수 있다.
- `-t tile-size` (0=auto), `-j load:proc:save` 스레드, `-n model-name`, `-s scale` 지원.
- 동봉 모델: `realesrgan-x4plus` · `realesrgan-x4plus-anime` · `realesrnet-x4plus` ·
  `realesr-animevideov3` (x2/x3/x4)

### API
```ts
// packages/media/src/upscale.ts (신규, derive.ts 에서 분리)
export type UpscaleEngine = 'auto' | 'ai' | 'lanczos';
export type UpscaleModel = 'realesrgan-x4plus' | 'realesr-animevideov3' | 'realesrgan-x4plus-anime';

export function upscaleVideo(absSrc: string, outAbs: string, opts: {
  scale: 2 | 3 | 4;
  engine?: UpscaleEngine;        // 기본 'auto' (AI 가능하면 AI)
  model?: UpscaleModel;          // 기본 'realesrgan-x4plus'
  denoiseBefore?: boolean;       // 기본 true — 압축 블록을 먼저 지운다
  gpuId?: number;
  onProgress?: (p: number) => void;
}): Promise<{ engine: 'ai' | 'lanczos'; seconds: number }>;
```

### 파이프라인 (청크 처리 — S4)
```
1) (denoiseBefore) ffmpeg: hqdn3d + deblock 로 압축 블록 제거
   ← AI 업스케일은 블록 노이즈도 «디테일»로 착각해 증폭한다. 반드시 먼저.
2) 청크 루프 (기본 120프레임 = 4초):
   a. ffmpeg: 해당 구간 → PNG 시퀀스 (tmp/in)
   b. realesrgan-ncnn-vulkan -i tmp/in -o tmp/out -n <model> -s <scale> -t <tile> -g <gpu>
   c. ffmpeg: tmp/out → 청크 mp4 (crf 16)
   d. tmp 비우기
3) concat + 원본 오디오 먹싱
```

- **scale 3 은 모델이 x4 뿐이므로** x4 로 올린 뒤 `scale=iw*0.75` 로 내린다(다운스케일은 손실 적음).
- **`realesr-animevideov3` 는 «비디오용»으로 훈련**돼 프레임 간 떨림이 적다. 실사에도 시도해 보고
  x4plus 와 비교 측정한다(아래 검증).

### 서버
`POST /api/projects/:id/assets/:assetId/upscale` body 에
`engine?: 'auto'|'ai'|'lanczos'` · `model?` · `scale?: 2|3|4` 추가.
`engine:'ai'` 인데 실행 파일이 없으면 **501** + `node scripts/prewarm.mjs realesrgan` 안내.

### UI
MediaPanel 의 `[업스케일]` 버튼을 **드롭다운**으로: 배율(2×/4×) · 엔진(자동/AI/빠름) · 모델.
잡 진행률에 「AI 업스케일 중 (프레임 312/900)」처럼 프레임 수를 보여준다 — 오래 걸리므로 필수다.

## 검증 — 숫자로 낸다

**1. 화질** — 위와 같은 실험(270×480 crf34 → 1080×1920)을 lanczos vs AI 로 돌려
PSNR·SSIM 을 낸다. **AI 가 PSNR 에서 지더라도 놀라지 말 것** — 초해상 모델은 픽셀 일치도보다
지각 품질을 올린다. 그래서 **육안 비교 이미지도 반드시 만든다.**

**2. 속도** — 프레임당 초, 30초 1080p 환산 총 시간. GPU/CPU 각각.

**3. 시간축 떨림** — `tblend=all_mode=difference` + `signalstats` 의 YAVG 를 lanczos 와 비교.
`realesrgan-x4plus` vs `realesr-animevideov3` 도 비교한다.

**4. 2GB VRAM 에서 1080p 가 되는지** — 어떤 타일 값에서 되는지. CPU 폴백 속도도.

**5. 안정성** — 이게 이 컴퓨터를 5번 죽였다. **반드시 Intel GPU(`-g` 로 지정)로 먼저,
사진 한 장으로, 30초 이내 시험한다.** 이벤트 로그(Kernel-Power 41)를 시험 전후로 확인한다.
Intel 로도 죽으면 CPU 폴백만 남기고 그 사실을 문서에 적는다.

## 하지 않을 것
- **결과가 나쁘다고 조용히 lanczos 로 돌리지 않는다.** 숫자를 내고 사용자가 정한다.
- **속도가 느리다고 「실용 불가」라고 쓰지 않는다.** 몇 분 걸리는지 적고 선택지로 남긴다.
