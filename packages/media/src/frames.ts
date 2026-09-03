import { mkdir, mkdtemp, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffprobeJson, runFfmpeg, toFwdSlash } from './ffmpeg.js';

/**
 * 청크 단위 프레임 왕복 — 영상 → PNG 폴더 → (외부 도구) → PNG 폴더 → 영상.
 *
 * 왜 청크로 끊나: 1080×1920 PNG 한 장이 3~6MB 다. 30초 30fps = 900장 = 3~5GB.
 * 통짜로 풀면 디스크가 터진다. N장씩 끊어 «추출 → 처리 → 인코딩 → 즉시 삭제» 를 반복하면
 * 최대 점유가 청크 한 개분(입력 폴더 + 출력 폴더)으로 묶인다.
 */

export type ChunkPlan = {
  index: number;
  /** 실제로 추출할 첫 프레임 번호(0부터). 겹침 몫이 이미 반영돼 있다. */
  startFrame: number;
  /** 추출할 총 프레임 수(겹침 포함). */
  frameCount: number;
  /** 결과에서 앞쪽으로 버릴 프레임 수. */
  overlapBefore: number;
  /** 결과에서 뒤쪽으로 버릴 프레임 수. */
  overlapAfter: number;
};

const IMAGE_RE = /\.(png|jpg|jpeg|webp)$/i;

/**
 * 청크 나누기 — 순수 함수.
 *
 * 각 청크는 «자기 몫»(최대 chunkSize 장)에 더해 앞뒤로 overlap 장씩 더 추출한다.
 * 프레임 보간은 앞뒤 프레임이 있어야 경계에서 끊기지 않기 때문이다(RIFE 는 overlap 1).
 * 더 뽑은 몫은 처리 뒤 버린다 → **버리고 난 총합은 언제나 totalFrames 와 같다.**
 */
export function planChunks(totalFrames: number, chunkSize: number, overlap: number): ChunkPlan[] {
  if (!Number.isInteger(totalFrames) || totalFrames < 0) {
    throw new Error(`totalFrames 는 0 이상의 정수여야 합니다: ${totalFrames}`);
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`chunkSize 는 1 이상의 정수여야 합니다: ${chunkSize}`);
  }
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new Error(`overlap 은 0 이상의 정수여야 합니다: ${overlap}`);
  }

  const plans: ChunkPlan[] = [];
  for (let core = 0, index = 0; core < totalFrames; core += chunkSize, index++) {
    const coreCount = Math.min(chunkSize, totalFrames - core);
    const overlapBefore = Math.min(overlap, core);
    const overlapAfter = Math.min(overlap, totalFrames - core - coreCount);
    plans.push({
      index,
      startFrame: core - overlapBefore,
      frameCount: overlapBefore + coreCount + overlapAfter,
      overlapBefore,
      overlapAfter,
    });
  }
  return plans;
}

/**
 * 처리 결과에서 앞뒤로 몇 장을 버릴지 — 순수 함수.
 *
 * 업스케일은 입출력 프레임 수가 같아 겹침 수를 그대로 버리면 되지만, 보간은 프레임이 늘어난다.
 * 그래서 «늘어난 비율» 만큼 환산해서 버린다. 최소 한 장은 남긴다.
 */
export function outputTrim(plan: ChunkPlan, outCount: number): { dropFront: number; dropBack: number } {
  if (outCount <= 0) return { dropFront: 0, dropBack: 0 };
  const ratio = plan.frameCount > 0 ? outCount / plan.frameCount : 0;
  const front = Math.max(0, Math.min(Math.round(plan.overlapBefore * ratio), outCount - 1));
  const back = Math.max(0, Math.min(Math.round(plan.overlapAfter * ratio), outCount - 1 - front));
  return { dropFront: front, dropBack: back };
}

/** 청크 하나를 PNG 로 푸는 데 필요한 임시 공간 추정 = 프레임수 × 픽셀수 × 4바이트 × 2(입·출력 폴더). */
export function estimateChunkBytes(chunkFrames: number, width: number, height: number): number {
  return chunkFrames * width * height * 4 * 2;
}

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

/** 여유 공간이 추정치의 1.5배에 못 미치면 실패시킨다. */
export function assertDiskSpace(freeBytes: number, needBytes: number, where: string): void {
  const required = needBytes * 1.5;
  if (freeBytes < required) {
    throw new Error(
      `임시 디스크 공간이 부족합니다. ${where} 의 여유 ${fmtGb(freeBytes)}, ` +
        `필요 ${fmtGb(required)} (청크 한 개를 PNG 로 푸는 데 ${fmtGb(needBytes)} × 1.5). ` +
        `chunkFrames 를 줄이거나 디스크를 비우세요.`,
    );
  }
}

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split('/');
  const n = Number(a);
  const d = b == null ? 1 : Number(b);
  return Number.isFinite(n) && d > 0 ? n / d : 0;
}

type SrcInfo = { width: number; height: number; fps: number; totalFrames: number; hasAudio: boolean };

async function probeVideo(absSrc: string): Promise<SrcInfo> {
  const info = await ffprobeJson(absSrc);
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (v?.width == null || v.height == null) {
    throw new Error(`비디오 스트림을 찾지 못했습니다: ${absSrc}`);
  }
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  if (fps <= 0) throw new Error(`프레임레이트를 읽지 못했습니다: ${absSrc}`);

  const nb = Number((v as { nb_frames?: string }).nb_frames ?? NaN);
  const durationSec = Number(info.format?.duration ?? v.duration ?? NaN);
  const totalFrames =
    Number.isFinite(nb) && nb > 0
      ? Math.round(nb)
      : Number.isFinite(durationSec) && durationSec > 0
        ? Math.round(durationSec * fps)
        : 0;

  return {
    width: v.width,
    height: v.height,
    fps,
    totalFrames,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

async function emptyDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

/**
 * 겹친 프레임을 버리고 남은 것을 `k-%06d.<ext>` 연속 번호로 정리한다.
 * **복사가 아니라 이름 바꾸기**라 디스크가 늘지 않는다.
 */
async function keepFrames(outDir: string, plan: ChunkPlan): Promise<{ count: number; ext: string }> {
  const files = (await readdir(outDir)).filter((f) => IMAGE_RE.test(f)).sort();
  const { dropFront, dropBack } = outputTrim(plan, files.length);
  const keepEnd = files.length - dropBack;
  let count = 0;
  let ext = '.png';
  for (let i = 0; i < files.length; i++) {
    const from = path.join(outDir, files[i]!);
    if (i < dropFront || i >= keepEnd) {
      await rm(from, { force: true });
      continue;
    }
    ext = path.extname(files[i]!) || '.png';
    await rename(from, path.join(outDir, `k-${String(count).padStart(6, '0')}${ext}`));
    count++;
  }
  return { count, ext };
}

/**
 * 영상을 청크로 끊어 프레임 왕복 처리한다.
 *
 * 청크마다: ffmpeg 로 PNG 추출 → `onChunk` → 겹침 버리기 → 청크 mp4 → tmp 즉시 삭제.
 * 마지막에 concat 하고 원본 오디오를 그대로 붙인다.
 */
export async function processInChunks(
  absSrc: string,
  outAbs: string,
  opts: {
    chunkFrames?: number;
    overlapFrames?: number;
    /** 출력 fps (보간 시 원본과 달라진다). 미지정이면 원본 fps. */
    fps?: number;
    /** 기본 true — 원본 오디오를 그대로 붙인다. */
    keepAudio?: boolean;
    onChunk: (inDir: string, outDir: string, plan: ChunkPlan) => Promise<void>;
    onProgress?: (p: number) => void;
  },
): Promise<void> {
  const chunkFrames = opts.chunkFrames ?? 120;
  const overlapFrames = opts.overlapFrames ?? 0;
  const keepAudio = opts.keepAudio !== false;

  const src = await probeVideo(absSrc);
  if (src.totalFrames <= 0) throw new Error(`프레임 수를 셀 수 없습니다: ${absSrc}`);
  const outFps = opts.fps ?? src.fps;
  const plans = planChunks(src.totalFrames, chunkFrames, overlapFrames);

  // 시작 전에 디스크 여유를 본다 — 중간에 터지면 반쯤 처리한 것이 다 버려진다
  const tmpBase = tmpdir();
  const need = estimateChunkBytes(chunkFrames + 2 * overlapFrames, src.width, src.height);
  const fs = await statfs(tmpBase);
  assertDiskSpace(Number(fs.bsize) * Number(fs.bavail), need, tmpBase);

  await mkdir(path.dirname(outAbs), { recursive: true });
  const tmp = await mkdtemp(path.join(tmpBase, 'kitkat-chunk-'));
  try {
    const inDir = path.join(tmp, 'in');
    const outDir = path.join(tmp, 'out');
    const chunkFiles: string[] = [];

    for (const plan of plans) {
      await emptyDir(inDir);
      await emptyDir(outDir);

      // 입력 쪽 -ss 는 정확 탐색이면서 앞부분을 건너뛴다(청크마다 처음부터 디코드하지 않는다)
      await runFfmpeg([
        '-y',
        '-ss', (plan.startFrame / src.fps).toFixed(6),
        '-i', absSrc,
        '-frames:v', String(plan.frameCount),
        '-fps_mode', 'passthrough',
        '-start_number', '0',
        path.join(inDir, '%06d.png'),
      ]);

      await opts.onChunk(inDir, outDir, plan);

      const kept = await keepFrames(outDir, plan);
      if (kept.count === 0) throw new Error(`청크 ${plan.index} 의 처리 결과가 비었습니다`);

      const chunkFile = path.join(tmp, `chunk-${String(plan.index).padStart(4, '0')}.mp4`);
      await runFfmpeg([
        '-y',
        '-framerate', String(outFps),
        '-start_number', '0',
        '-i', path.join(outDir, `k-%06d${kept.ext}`),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
        chunkFile,
      ]);
      chunkFiles.push(chunkFile);

      // 다음 청크 전에 비운다 — 최대 점유를 청크 한 개분으로 묶는 지점
      await emptyDir(inDir);
      await emptyDir(outDir);
      opts.onProgress?.((plan.index + 1) / plans.length);
    }

    const listFile = path.join(tmp, 'concat.txt');
    await writeFile(listFile, chunkFiles.map((f) => `file '${toFwdSlash(f)}'`).join('\n') + '\n');

    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
    if (keepAudio && src.hasAudio) {
      args.push(
        '-i', absSrc,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      );
    } else {
      args.push('-map', '0:v:0', '-c:v', 'copy', '-an');
    }
    args.push('-movflags', '+faststart', outAbs);
    await runFfmpeg(args);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
