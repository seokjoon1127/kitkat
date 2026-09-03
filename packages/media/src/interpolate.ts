import { readdir } from 'node:fs/promises';
import { interpolateFps as minterpolateFps } from './derive.js';
import { ffprobeJson } from './ffmpeg.js';
import { planChunks, processInChunks } from './frames.js';
import { ncnnInfo, ncnnRun } from './ncnn.js';
import type { FrameProgress } from './upscale.js';

/**
 * W8 F2 — RIFE(ncnn-vulkan) 프레임 보간.
 *
 * `derive.ts` 의 minterpolate 판은 **폴백으로 그대로 남아 있다**(`engine:'minterpolate'`).
 * `engine:'auto'` 는 실행 파일이 있으면 AI, 없으면 minterpolate.
 * `engine:'ai'` 인데 실행 파일이 없으면 **throw** 한다 — 서버가 501 로 바꾼다.
 *
 * ⚠️ RIFE 에는 `-t tile-size` 가 **없다**. 넘기면 usage 를 뱉고 죽는다 (`ncnn.ts` 가 막고 있다).
 */

export type InterpEngine = 'auto' | 'ai' | 'minterpolate';

export type InterpolateOpts = {
  /** 목표 fps. */
  fps: number;
  engine?: InterpEngine;
  model?: string;
  /** 미지정이면 짧은 변이 1440 이상일 때 자동 true. */
  uhd?: boolean;
  gpuId?: number;
  chunkFrames?: number;
  onProgress?: (p: number, frames?: FrameProgress) => void;
  /** 잡 큐 시간 초과 → GPU 실행 파일·ffmpeg 을 같이 죽인다 (리뷰 #12) */
  signal?: AbortSignal;
};

export type InterpolateResult = { engine: 'ai' | 'minterpolate'; seconds: number };

/**
 * 동봉 모델.
 *
 * **`-n`(임의 배율)은 v4 계열만 받는다.** 구형 모델에 넘기면
 * `only rife-v4 model support custom numframe and timestep` 을 찍고 아무것도 만들지 않는다(실측).
 * 그래서 구형 모델은 **정확히 2배(30→60fps 같은)일 때만** 쓸 수 있고, 그때는 `-n` 을 빼고 부른다.
 *
 * 기본은 `rife-v4.6` — 임의 배율이 되고 구형 대비 2~3배 빠르다.
 *
 * **2026-09-02 「빼놓고 맞히기」 실측 (30fps→15fps→30fps, 홀수 29장 PSNR-Y dB):**
 * ```
 *                     가림    빠른움직임   카메라팬   합성패턴(testsrc2)
 *   앞 프레임 복사     36.10     28.28      21.09        30.27
 *   minterpolate      38.79     28.85      26.45        38.12
 *   rife-v4.6         42.47     29.84      29.75        35.70   ← 기본
 *   rife-v4           42.75     30.00      29.51        36.71
 *   rife-v3.1(2배 전용) 42.98    28.97      30.54        38.28
 * ```
 * 실사 성격의 움직임(가림·팬)에서 RIFE 가 minterpolate 를 3~4dB 앞선다.
 * **합성 테스트 패턴에서는 minterpolate 가 이긴다** — 딱딱한 인공 패턴의 강체 이동은
 * 블록 매칭이 더 잘 맞고, RIFE 는 자연 영상으로 학습됐기 때문이다. 숨기지 않고 적어 둔다.
 */
export const INTERPOLATE_MODELS: readonly string[] = [
  'rife-v4.6',
  'rife-v4',
  'rife-v3.1',
  'rife-v3.0',
  'rife-v2.4',
  'rife-v2.3',
  'rife-anime',
  'rife-HD',
  'rife-UHD',
];

export const DEFAULT_INTERPOLATE_MODEL = 'rife-v4.6';

/** 임의 배율(`-n`)을 받는 모델인가. */
export function supportsArbitraryRatio(model: string): boolean {
  return /^rife-v4/.test(model);
}

/** 짧은 변이 이 이상이면 `-u`(UHD 모드) 를 켠다. */
const UHD_MIN_SIDE = 1440;
const DEFAULT_CHUNK_FRAMES = 120;
/** 청크 경계에서 보간이 끊기지 않도록 앞뒤로 한 장씩 더 뽑는다. */
const OVERLAP_FRAMES = 1;

const IMAGE_RE = /\.(png|jpg|jpeg|webp)$/i;

type SrcInfo = { width: number; height: number; fps: number; totalFrames: number };

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
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  if (fps <= 0) throw new Error(`프레임레이트를 읽지 못했습니다: ${absSrc}`);
  const sec = Number(info.format?.duration ?? v.duration ?? NaN);
  const nb = Number((v as { nb_frames?: string }).nb_frames ?? NaN);
  const totalFrames =
    Number.isFinite(nb) && nb > 0
      ? Math.round(nb)
      : Number.isFinite(sec) && sec > 0
        ? Math.round(sec * fps)
        : 0;
  if (totalFrames <= 0) throw new Error(`프레임 수를 셀 수 없습니다: ${absSrc}`);
  return { width: v.width, height: v.height, fps, totalFrames };
}

/**
 * 청크마다 RIFE 에 넘길 `-n`(출력 프레임 수) — 순수 함수.
 *
 * 청크는 겹침 몫까지 포함해 `frameCount` 장을 받는다. 늘어난 비율(`fps/원본fps`)을 그대로 곱하면
 * `frames.ts` 의 `outputTrim` 이 같은 비율로 겹침을 버려서 **버리고 난 총합이 목표 프레임 수와 맞는다.**
 * RIFE 는 최소 2장을 내야 하므로 하한을 둔다.
 */
export function chunkTargets(
  totalFrames: number,
  chunkFrames: number,
  ratio: number,
): number[] {
  return planChunks(totalFrames, chunkFrames, OVERLAP_FRAMES).map((p) =>
    Math.max(2, Math.round(p.frameCount * ratio)),
  );
}

/** AI 보간을 쓸 수 있는가. */
export async function isInterpolateAiReady(): Promise<{ ok: boolean; hint?: string }> {
  const info = await ncnnInfo('rife');
  return { ok: info.ok, ...(info.hint ? { hint: info.hint } : {}) };
}

/**
 * 프레임 보간.
 *
 * ```
 * 1) ffprobe 로 원본 fps·프레임 수 확정
 * 2) 청크 루프(겹침 1장): PNG 추출 → rife-ncnn-vulkan -n <청크목표> → 겹친 몫 버리기 → 청크 mp4
 * 3) concat + 원본 오디오(길이 동일)
 * ```
 */
export async function interpolateFps(
  absSrc: string,
  outAbs: string,
  opts: InterpolateOpts,
): Promise<InterpolateResult> {
  const started = Date.now();
  const engine = opts.engine ?? 'auto';
  const seconds = () => (Date.now() - started) / 1000;
  const fallback = async () => {
    await minterpolateFps(absSrc, outAbs, opts.fps, opts.onProgress ? (p) => opts.onProgress!(p) : undefined);
    return { engine: 'minterpolate' as const, seconds: seconds() };
  };

  if (engine === 'minterpolate') return fallback();

  const ready = await isInterpolateAiReady();
  if (!ready.ok) {
    if (engine === 'ai') throw new Error(ready.hint || 'AI 프레임 보간 엔진을 쓸 수 없습니다');
    return fallback();
  }

  await aiInterpolate(absSrc, outAbs, opts);
  return { engine: 'ai', seconds: seconds() };
}

async function countImages(dir: string): Promise<number> {
  const files = await readdir(dir).catch(() => []);
  return files.filter((f) => IMAGE_RE.test(f)).length;
}

async function aiInterpolate(absSrc: string, outAbs: string, opts: InterpolateOpts): Promise<void> {
  const src = await probeSrc(absSrc);
  const ratio = opts.fps / src.fps;
  if (ratio <= 1) {
    throw new Error(
      `목표 fps(${opts.fps})가 원본 fps(${src.fps.toFixed(3)})보다 높아야 합니다. ` +
        `RIFE 는 프레임을 «늘리는» 도구라 같거나 낮은 fps 는 만들지 못합니다.`,
    );
  }

  const model = opts.model ?? DEFAULT_INTERPOLATE_MODEL;
  const arbitrary = supportsArbitraryRatio(model);
  if (!arbitrary && Math.abs(ratio - 2) > 1e-6) {
    throw new Error(
      `${model} 은(는) 정확히 2배(${(src.fps * 2).toFixed(0)}fps)만 만들 수 있습니다. ` +
        `${opts.fps}fps 처럼 다른 배율은 rife-v4 계열(기본 ${DEFAULT_INTERPOLATE_MODEL})을 쓰세요.`,
    );
  }
  const uhd = opts.uhd ?? Math.min(src.width, src.height) >= UHD_MIN_SIDE;
  const chunkFrames = opts.chunkFrames ?? DEFAULT_CHUNK_FRAMES;
  const targets = chunkTargets(src.totalFrames, chunkFrames, ratio);
  const totalOut = targets.reduce((a, b) => a + b, 0);

  const onProgress = opts.onProgress;
  let base = 0;

  await processInChunks(absSrc, outAbs, {
    chunkFrames,
    overlapFrames: OVERLAP_FRAMES,
    fps: opts.fps,
    onChunk: async (inDir, outDir, plan) => {
      const target = targets[plan.index] ?? Math.max(2, Math.round(plan.frameCount * ratio));
      // ncnnRun 의 진행률은 «입력 장수» 기준이라 프레임이 늘어나는 보간에는 맞지 않는다.
      // 출력 폴더를 직접 세어 알린다.
      const timer = onProgress
        ? setInterval(() => {
            void countImages(outDir).then((done) => {
              const doneAll = base + Math.min(done, target);
              onProgress(Math.min(1, doneAll / totalOut), { done: doneAll, total: totalOut });
            });
          }, 500)
        : null;
      try {
        await ncnnRun('rife', {
          signal: opts.signal,
          inDir,
          outDir,
          // 구형 모델은 `-n` 자체를 거부한다 — 2배 고정이라 안 넘겨도 결과가 같다.
          args: [
            '-m', model,
            ...(arbitrary ? ['-n', String(target)] : []),
            ...(uhd ? ['-u'] : []),
          ],
          ...(opts.gpuId !== undefined ? { gpuId: opts.gpuId } : {}),
        });
      } finally {
        if (timer) clearInterval(timer);
      }
      base += target;
      onProgress?.(Math.min(1, base / totalOut), { done: base, total: totalOut });
    },
  });
}
