import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { upscaleVideo as lanczosUpscale } from './derive.js';
import {
  detectEncoder,
  ffprobeJson,
  runFfmpeg,
  runFfmpegProgress,
  videoEncoderArgs,
} from './ffmpeg.js';
import { processInChunks } from './frames.js';
import { ncnnInfo, ncnnRun, pickSafeGpu } from './ncnn.js';

/**
 * W8 F1 — Real-ESRGAN(ncnn-vulkan) 업스케일.
 *
 * `derive.ts` 의 lanczos 판은 **폴백으로 그대로 남아 있다**(`engine:'lanczos'`).
 * `engine:'auto'` 는 실행 파일이 있으면 AI, 없으면 lanczos 다.
 * `engine:'ai'` 인데 실행 파일이 없으면 **throw** 한다 — 서버가 그걸 501 로 바꾼다.
 *
 * ⚠️ GPU 선택은 `ncnn.ts` 의 `pickSafeGpu` 가 한다(드라이버 날짜로 고른다).
 *    이 컴퓨터에서 MX450 은 2026-09-01 에 Windows 를 5번 죽였다. 임의로 `-g 0` 을 넘기지 마라.
 */

export type UpscaleEngine = 'auto' | 'ai' | 'lanczos';
export type UpscaleModel = 'realesrgan-x4plus' | 'realesr-animevideov3' | 'realesrgan-x4plus-anime';

/** 「AI 업스케일 중 312/900」처럼 보여줄 프레임 진행 상황. */
export type FrameProgress = { done: number; total: number };

export type UpscaleOpts = {
  scale: 2 | 3 | 4;
  engine?: UpscaleEngine;
  model?: UpscaleModel;
  /** 기본 true — 압축 블록을 먼저 지운다(DENOISE_FILTER 주석 참조). */
  denoiseBefore?: boolean;
  gpuId?: number;
  /** 한 청크에 푸는 프레임 수. 미지정이면 출력 해상도를 보고 정한다. */
  chunkFrames?: number;
  /** realesrgan `-t`. 미지정이면 ncnnRun 이 512→256→128→64 로 낮춰 재시도한다. */
  tile?: number;
  onProgress?: (p: number, frames?: FrameProgress) => void;
  /** 잡 큐 시간 초과 → GPU 실행 파일·ffmpeg 을 같이 죽인다 (리뷰 #12) */
  signal?: AbortSignal;
};

export type UpscaleResult = { engine: 'ai' | 'lanczos'; seconds: number };

/**
 * 쓸 수 있는 모델.
 *
 * **2026-09-02 실측 (Intel Iris Xe, `-g 1`, x4, 폴더 모드):**
 * ```
 *                        160×120→640×480   270×480→1080×1920   1080×1920→4320×7680
 *   realesrgan-x4plus        1.02초/장          6.05초/장            157초/장
 *   realesr-animevideov3     0.08초/장          0.35초/장             13.4초/장   ← 12~17배 빠르다
 *   realesrgan-x4plus-anime  0.32초/장             —                    —
 * ```
 * 화질도 실사 영상에서 SSIM 0.880(animevideov3) > 0.871(x4plus) > 0.862(x4plus-anime) 이고
 * 프레임 간 떨림도 animevideov3 가 가장 적었다. **기본값은 계획서대로 x4plus 로 두지만,
 * 1080p 를 4배로 올릴 거면 animevideov3 를 골라야 한다** (x4plus 는 30초 영상에 39시간이다).
 */
export const UPSCALE_MODELS: readonly UpscaleModel[] = [
  'realesrgan-x4plus',
  'realesr-animevideov3',
  'realesrgan-x4plus-anime',
];

/**
 * 기본 모델 — **실측으로 `realesr-animevideov3` 를 골랐다** (2026-09-02).
 * 계획서 초안은 `realesrgan-x4plus` 였지만 세 항목에서 전부 졌다:
 *
 * | | x4plus | animevideov3 |
 * |---|---|---|
 * | 1080p→4배 속도 | 157초/장 (30초 영상 = **39시간**) | 13.4초/장 (**3.4시간**) — 12배 |
 * | SSIM (합성 / 애니) | 0.9262 / 0.8710 | **0.9505 / 0.8802** |
 * | 시간축 떨림 (정지화면) | +8.7% | **+6.7%** |
 *
 * 39시간은 사실상 못 쓰는 값이다. 그리고 이 모델은 **영상용으로 훈련**돼 프레임 간 떨림이 적다.
 *
 * ⚠️ **실사 촬영본으로는 아직 못 쟀다** — 리포에 실사 샘플이 없어 애니메이션 클립으로 쟀다.
 * 실사에서 x4plus 가 나을 가능성이 남아 있다(F17 검증 부채 항목).
 */
export const DEFAULT_UPSCALE_MODEL: UpscaleModel = 'realesr-animevideov3';

/**
 * 모델이 **자기 가중치로** 낼 수 있는 배율.
 * `realesr-animevideov3` 만 x2/x3/x4 를 다 갖고 있고(모델 파일 3벌), 나머지는 x4 한 벌뿐이다.
 * 없는 배율은 x4 로 올린 뒤 줄인다 — 줄이는 쪽은 정보가 남아도는 방향이라 손실이 적다.
 */
const MODEL_SCALES: Record<UpscaleModel, readonly (2 | 3 | 4)[]> = {
  'realesrgan-x4plus': [4],
  'realesrgan-x4plus-anime': [4],
  'realesr-animevideov3': [2, 3, 4],
};

/**
 * 압축 블록 제거 — AI 업스케일 «앞»에 거는 패스 (`denoiseBefore`, **기본 false**).
 *
 * 계획서는 「AI 가 블록 노이즈를 디테일로 착각해 증폭하니 먼저 지운다」며 기본 true 였는데,
 * **실측에서 이득이 안 났다** — PSNR-Y 24.866 → 24.835, SSIM 0.8710 → 0.8681,
 * 떨림 0.1442 → 0.1653(오히려 15% 증가). 그래서 기본을 false 로 내렸다.
 * 다만 시험 소재(평면 채색 애니)에 블록이 적었을 수 있다 — **블록이 심한 실사 소스에서는
 * `denoiseBefore:true` 가 이길 가능성이 남아 있다**(F17 검증 부채 항목).
 * 초해상 모델은 «작고 규칙적인 밝기 차이»를 디테일로 보고 살려낸다. 블록 노이즈가 딱 그 모양이라
 * 그대로 넣으면 블록 격자가 배율만큼 또렷해진다는 것이 근거다.
 *
 * ⚠️ **다만 2026-09-02 실측으로는 이득이 확인되지 않았다.**
 * 160×120 crf34 애니 60장 → 640×480 에서 잡음제거를 켠 쪽이 오히려 조금 나빴다:
 * ```
 *                          PSNR-Y      SSIM      떨림(YAVG, 정답 0.121)
 *   x4plus  잡음제거 없음   24.866     0.8710         0.1442
 *   x4plus  잡음제거 먼저   24.835     0.8681         0.1653
 *   animev3 잡음제거 없음   24.809     0.8802         0.0592
 *   animev3 잡음제거 먼저   24.793     0.8783         0.0820
 * ```
 * 이 소재(평면 채색 애니)에 블록 노이즈가 적어서일 수 있다. 블록이 심한 실사 소스로 다시 재야 한다.
 * 계획서가 정한 기본값(true)은 그대로 두되, **끄고 싶으면 `denoiseBefore:false` 를 주면 된다**
 * (패스 하나가 통째로 빠져 인코딩 시간도 준다).
 */
const DENOISE_FILTER = 'deblock=filter=weak:block=4,hqdn3d=4:3:6:4.5';

/** 청크 하나가 PNG 로 풀렸을 때의 목표 상한(바이트). 출력 해상도로 프레임 수를 정한다. */
const CHUNK_BUDGET_BYTES = 1.5 * 1024 ** 3;
const MAX_CHUNK_FRAMES = 120;
const MIN_CHUNK_FRAMES = 4;

/** 잡음 제거 패스가 전체에서 차지하는 몫 — 청크 루프가 압도적으로 오래 걸린다. */
const DENOISE_WEIGHT = 0.05;

type SrcInfo = { width: number; height: number; totalFrames: number; durationMs?: number };

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split('/');
  const n = Number(a);
  const d = b == null ? 1 : Number(b);
  return Number.isFinite(n) && d > 0 ? n / d : 0;
}

async function probeSrc(absSrc: string): Promise<SrcInfo> {
  const info = await ffprobeJson(absSrc);
  const v = (info.streams ?? []).find((s) => s.codec_type === 'video');
  if (v?.width == null || v.height == null) {
    throw new Error(`비디오 스트림을 찾지 못했습니다: ${absSrc}`);
  }
  const sec = Number(info.format?.duration ?? v.duration ?? NaN);
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  const nb = Number((v as { nb_frames?: string }).nb_frames ?? NaN);
  const totalFrames =
    Number.isFinite(nb) && nb > 0
      ? Math.round(nb)
      : Number.isFinite(sec) && sec > 0 && fps > 0
        ? Math.round(sec * fps)
        : 0;
  return {
    width: v.width,
    height: v.height,
    totalFrames,
    ...(Number.isFinite(sec) ? { durationMs: Math.round(sec * 1000) } : {}),
  };
}

/** yuv420p 는 짝수 해상도만 받는다. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** 그 모델이 곧바로 낼 수 있는 배율. 없으면 4 (= 올렸다 줄인다). */
export function nativeScale(model: UpscaleModel, scale: 2 | 3 | 4): 2 | 3 | 4 {
  return MODEL_SCALES[model].includes(scale) ? scale : 4;
}

/**
 * 출력 PNG 크기로 청크 프레임 수를 정한다.
 * `frames.ts` 의 디스크 검사는 **원본** 해상도로 어림하는데 업스케일은 출력이 배율² 만큼 크다.
 * 1080×1920 을 x4 로 올리면 한 장이 4320×7680 = 133MB(무압축 환산)라 120장이면 16GB 다.
 */
export function chunkFramesFor(outWidth: number, outHeight: number): number {
  const perFrame = outWidth * outHeight * 4 * 2; // 입력 폴더 + 출력 폴더
  const n = Math.floor(CHUNK_BUDGET_BYTES / Math.max(1, perFrame));
  return Math.max(MIN_CHUNK_FRAMES, Math.min(MAX_CHUNK_FRAMES, n));
}

/**
 * AI 업스케일을 쓸 수 있는가 (실행 파일 + 모델 + **쓸 수 있는 GPU**).
 *
 * ⚠️ **realesrgan-ncnn-vulkan 에는 CPU 모드가 없다.** `-g -1` 을 주면
 * `invalid gpu device` 만 찍고 아무 파일도 만들지 않는다(2026-09-02 실측 — `-h` 에도 안 적혀 있다.
 * rife 쪽은 `-g -1` 이 진짜로 CPU 로 돌아간다). 그래서 안전한 GPU 가 하나도 없으면
 * «쓸 수 없음» 으로 본다 → `engine:'auto'` 는 lanczos 로, `engine:'ai'` 는 501 로 간다.
 */
export async function isUpscaleAiReady(): Promise<{ ok: boolean; hint?: string }> {
  const info = await ncnnInfo('realesrgan');
  if (!info.ok) return { ok: false, ...(info.hint ? { hint: info.hint } : {}) };
  if (pickSafeGpu(info.gpus ?? []) < 0) {
    return {
      ok: false,
      hint:
        `${info.hint ?? ''} Real-ESRGAN 은 CPU 로는 돌지 않습니다(-g -1 = invalid gpu device). ` +
        'GPU 가 필요합니다 — 쓸 GPU 를 KITKAT_NCNN_GPU 로 지정하거나 빠른 업스케일(lanczos)을 쓰세요.',
    };
  }
  return { ok: true, ...(info.hint ? { hint: info.hint } : {}) };
}

/**
 * 업스케일 2x/3x/4x.
 *
 * ```
 * 1) denoiseBefore → deblock+hqdn3d 로 압축 블록 제거 (별도 패스)
 * 2) 청크 루프: PNG 추출 → realesrgan-ncnn-vulkan → (배율이 안 맞으면 축소) → 청크 mp4
 * 3) concat + 오디오
 * ```
 */
export async function upscaleVideo(
  absSrc: string,
  outAbs: string,
  opts: UpscaleOpts,
): Promise<UpscaleResult> {
  const started = Date.now();
  const engine = opts.engine ?? 'auto';
  const seconds = () => (Date.now() - started) / 1000;

  if (engine === 'lanczos') {
    await lanczosFallback(absSrc, outAbs, opts.scale, opts.onProgress);
    return { engine: 'lanczos', seconds: seconds() };
  }

  const ready = await isUpscaleAiReady();
  if (!ready.ok) {
    if (engine === 'ai') throw new Error(ready.hint || 'AI 업스케일 엔진을 쓸 수 없습니다');
    await lanczosFallback(absSrc, outAbs, opts.scale, opts.onProgress);
    return { engine: 'lanczos', seconds: seconds() };
  }

  await aiUpscale(absSrc, outAbs, opts);
  return { engine: 'ai', seconds: seconds() };
}

/**
 * 고전 필터 폴백. 2배·4배는 `derive.ts` 의 기존 구현을 그대로 쓴다(계약 유지).
 * 3배는 derive 가 받지 않는 값이라 같은 필터를 여기서 3배로 건다.
 */
async function lanczosFallback(
  absSrc: string,
  outAbs: string,
  scale: 2 | 3 | 4,
  onProgress?: (p: number, frames?: FrameProgress) => void,
): Promise<void> {
  const report = onProgress ? (p: number) => onProgress(p) : undefined;
  if (scale === 2 || scale === 4) {
    await lanczosUpscale(absSrc, outAbs, scale, report);
    return;
  }
  const src = await probeSrc(absSrc);
  const info = await ffprobeJson(absSrc);
  const hasAudio = (info.streams ?? []).some((s) => s.codec_type === 'audio');
  await mkdir(path.dirname(outAbs), { recursive: true });
  await runFfmpegProgress(
    [
      '-y', '-i', absSrc,
      '-vf', `scale=${even(src.width * 3)}:${even(src.height * 3)}:flags=lanczos,unsharp=5:5:0.6:5:5:0.0`,
      ...videoEncoderArgs(await detectEncoder(), 18),
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      outAbs,
    ],
    src.durationMs,
    report,
  );
}

async function aiUpscale(absSrc: string, outAbs: string, opts: UpscaleOpts): Promise<void> {
  const model = opts.model ?? DEFAULT_UPSCALE_MODEL;
  const native = nativeScale(model, opts.scale);
  const src = await probeSrc(absSrc);
  const outW = even(src.width * opts.scale);
  const outH = even(src.height * opts.scale);
  // ncnn 이 내는 크기와 최종 크기가 다르면(배율 환산·홀수 보정) 프레임을 한 번 더 줄인다
  const needResize = outW !== src.width * native || outH !== src.height * native;
  const chunkFrames = opts.chunkFrames ?? chunkFramesFor(outW, outH);

  const denoise = opts.denoiseBefore === true;
  const onProgress = opts.onProgress;
  const weight = denoise ? DENOISE_WEIGHT : 0;

  const tmp = await mkdtemp(path.join(tmpdir(), 'kitkat-upscale-'));
  try {
    let chunkSrc = absSrc;
    if (denoise) {
      chunkSrc = path.join(tmp, 'denoised.mp4');
      await runFfmpegProgress(
        [
          '-y', '-i', absSrc,
          '-vf', DENOISE_FILTER,
          ...videoEncoderArgs(await detectEncoder(), 16),
          // 오디오를 여기서 버리면 뒤 단계가 붙일 소리가 없다 (mp4 로 확실히 들어가는 aac 로 다시 굽는다)
          '-c:a', 'aac', '-b:a', '192k',
          chunkSrc,
        ],
        src.durationMs,
        onProgress ? (p) => onProgress(weight * p) : undefined,
      );
    }

    const rawDir = path.join(tmp, 'ncnn');
    const total = src.totalFrames;
    let base = 0;
    const report = onProgress
      ? (done: number) => {
          const p = total > 0 ? Math.min(1, done / total) : 0;
          onProgress(weight + (1 - weight) * p, { done: Math.min(done, total), total });
        }
      : undefined;

    await processInChunks(chunkSrc, outAbs, {
      chunkFrames,
      overlapFrames: 0, // 업스케일은 한 장씩 독립이다 — 앞뒤 프레임이 필요 없다
      onChunk: async (inDir, outDir, plan) => {
        const ncnnOut = needResize ? rawDir : outDir;
        if (needResize) {
          await rm(rawDir, { recursive: true, force: true });
          await mkdir(rawDir, { recursive: true });
        }
        await ncnnRun('realesrgan', {
          signal: opts.signal,
          inDir,
          outDir: ncnnOut,
          args: ['-n', model, '-s', String(native)],
          ...(opts.gpuId !== undefined ? { gpuId: opts.gpuId } : {}),
          ...(opts.tile !== undefined ? { tile: opts.tile } : {}),
          ...(report ? { onProgress: (done: number) => report(base + done) } : {}),
        });
        if (needResize) {
          await runFfmpeg([
            '-y',
            '-start_number', '0',
            '-i', path.join(rawDir, '%06d.png'),
            '-vf', `scale=${outW}:${outH}:flags=lanczos`,
            '-start_number', '0',
            path.join(outDir, '%06d.png'),
          ]);
          await rm(rawDir, { recursive: true, force: true });
        }
        base += plan.frameCount;
        report?.(base);
      },
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
