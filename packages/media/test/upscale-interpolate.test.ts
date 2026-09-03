// W8 F1·F2 — AI 업스케일(Real-ESRGAN) · AI 프레임 보간(RIFE)
// 순수 함수 + 폴백 경로는 항상 돌고, 진짜 AI 경로는 vendor/ 가 있을 때만 돈다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chunkFramesFor,
  chunkTargets,
  interpolateFps,
  isInterpolateAiReady,
  isUpscaleAiReady,
  nativeScale,
  outputTrim,
  planChunks,
  probeAsset,
  upscaleVideo,
  DEFAULT_INTERPOLATE_MODEL,
  DEFAULT_UPSCALE_MODEL,
  INTERPOLATE_MODELS,
  UPSCALE_MODELS,
} from '../src/index.js';
import { ffprobeJson } from '../src/ffmpeg.js';

const T = 300_000;
/** AI 한 번 돌리는 데 걸리는 시간 — Intel iGPU 기준 여유 있게. */
const T_AI = 600_000;

let dir: string;
let tiny: string; // 64x48 · 30fps · 6프레임

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kitkat-f1f2-'));
  tiny = path.join(dir, 'tiny.mp4');
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=30:duration=0.2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
    tiny,
  ]);
}, T);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('nativeScale — 모델이 곧바로 낼 수 있는 배율', () => {
  it('x4plus 계열은 가중치가 x4 한 벌뿐이라 언제나 4다 (2·3배는 올렸다 줄인다)', () => {
    expect(nativeScale('realesrgan-x4plus', 2)).toBe(4);
    expect(nativeScale('realesrgan-x4plus', 3)).toBe(4);
    expect(nativeScale('realesrgan-x4plus', 4)).toBe(4);
    expect(nativeScale('realesrgan-x4plus-anime', 2)).toBe(4);
  });

  it('animevideov3 는 x2/x3/x4 를 다 갖고 있어 요청 배율 그대로 돈다 (2배가 4배보다 빠르다)', () => {
    expect(nativeScale('realesr-animevideov3', 2)).toBe(2);
    expect(nativeScale('realesr-animevideov3', 3)).toBe(3);
    expect(nativeScale('realesr-animevideov3', 4)).toBe(4);
  });

  it('기본 모델·모델 목록', () => {
    expect(UPSCALE_MODELS).toContain(DEFAULT_UPSCALE_MODEL);
    expect(INTERPOLATE_MODELS).toContain(DEFAULT_INTERPOLATE_MODEL);
    expect(DEFAULT_INTERPOLATE_MODEL).toBe('rife-v4.6');
  });
});

describe('chunkFramesFor — 출력 해상도로 청크 크기를 줄인다', () => {
  it('1080×1920 을 x4 로 올리면(4320×7680) 청크가 120장에서 크게 줄어든다', () => {
    const n = chunkFramesFor(4320, 7680);
    expect(n).toBeLessThan(120);
    expect(n).toBeGreaterThanOrEqual(4);
    // 한 청크가 PNG 로 풀렸을 때 1.5GB 를 넘지 않아야 한다 (입력 폴더 + 출력 폴더)
    expect(n * 4320 * 7680 * 4 * 2).toBeLessThanOrEqual(1.5 * 1024 ** 3);
  });

  it('작은 출력은 상한(120장)에 걸린다', () => {
    expect(chunkFramesFor(320, 180)).toBe(120);
  });

  it('말도 안 되게 큰 출력에도 최소 4장은 낸다', () => {
    expect(chunkFramesFor(30000, 30000)).toBe(4);
  });
});

describe('chunkTargets — 청크마다 RIFE 에 넘길 -n', () => {
  /** 겹침을 버리고 남은 총 프레임 수 (frames.ts 의 outputTrim 과 같은 계산). */
  const keptTotal = (totalFrames: number, chunkFrames: number, ratio: number): number => {
    const plans = planChunks(totalFrames, chunkFrames, 1);
    const targets = chunkTargets(totalFrames, chunkFrames, ratio);
    return plans.reduce((sum, p, i) => {
      const out = targets[i]!;
      const { dropFront, dropBack } = outputTrim(p, out);
      return sum + (out - dropFront - dropBack);
    }, 0);
  };

  it('30fps 150프레임 → 60fps: 청크마다 2배씩, 겹침을 버리면 정확히 300장', () => {
    expect(chunkTargets(150, 120, 2)).toEqual([242, 62]);
    expect(keptTotal(150, 120, 2)).toBe(300);
  });

  it('정수배가 아닌 30→48fps 도 겹침을 버리면 목표(240장)와 맞는다', () => {
    expect(keptTotal(150, 120, 48 / 30)).toBe(240);
  });

  it('청크가 여러 개로 쪼개져도 총합이 유지된다 (청크 40장 × 4개)', () => {
    expect(keptTotal(150, 40, 2)).toBe(300);
  });

  it('아주 짧은 청크에도 RIFE 가 받을 수 있는 최소 2장은 준다', () => {
    expect(chunkTargets(1, 1, 1.001).every((n) => n >= 2)).toBe(true);
  });
});

describe('폴백(고전 필터) — AI 없이도 언제나 돈다', () => {
  it("engine:'lanczos' 2배 — derive.ts 의 기존 구현 그대로", async () => {
    const out = path.join(dir, 'lz2.mp4');
    const progress: number[] = [];
    const res = await upscaleVideo(tiny, out, {
      scale: 2,
      engine: 'lanczos',
      onProgress: (p) => progress.push(p),
    });
    expect(res.engine).toBe('lanczos');
    const p = await probeAsset(out);
    expect([p.width, p.height]).toEqual([128, 96]);
    expect(res.seconds).toBeGreaterThan(0);
  }, T);

  it("engine:'lanczos' 3배 — derive 가 받지 않는 배율이라 여기서 처리한다", async () => {
    const out = path.join(dir, 'lz3.mp4');
    const res = await upscaleVideo(tiny, out, { scale: 3, engine: 'lanczos' });
    expect(res.engine).toBe('lanczos');
    const p = await probeAsset(out);
    expect([p.width, p.height]).toEqual([192, 144]);
  }, T);

  it("engine:'minterpolate' — 기존 minterpolate 판 그대로", async () => {
    const out = path.join(dir, 'mint.mp4');
    const res = await interpolateFps(tiny, out, { fps: 60, engine: 'minterpolate' });
    expect(res.engine).toBe('minterpolate');
    const info = await ffprobeJson(out);
    expect((info.streams ?? []).find((s) => s.codec_type === 'video')?.avg_frame_rate).toBe('60/1');
  }, T);
});

// ── 진짜 AI 경로 — vendor/ 가 있을 때만 (CI·다른 머신에서는 건너뛴다) ──────
const aiUp = await isUpscaleAiReady();
const aiIp = await isInterpolateAiReady();

describe.runIf(aiUp.ok)('AI 업스케일 실제 실행', () => {
  it('64×48 → 128×96 (animevideov3 x2 네이티브)', async () => {
    const out = path.join(dir, 'ai2.mp4');
    const frames: { done: number; total: number }[] = [];
    const res = await upscaleVideo(tiny, out, {
      scale: 2,
      engine: 'ai',
      model: 'realesr-animevideov3',
      onProgress: (_p, f) => {
        if (f) frames.push(f);
      },
    });
    expect(res.engine).toBe('ai');
    const p = await probeAsset(out);
    expect([p.width, p.height]).toEqual([128, 96]);
    // 프레임 진행률이 실제로 올라온다 («312/900» UI 표시의 근거)
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)!.total).toBeGreaterThan(0);
  }, T_AI);

  it('x4plus 로 2배를 요청하면 x4 로 올렸다 줄여서 정확히 2배가 나온다', async () => {
    const out = path.join(dir, 'ai2b.mp4');
    const res = await upscaleVideo(tiny, out, {
      scale: 2,
      engine: 'ai',
      model: 'realesrgan-x4plus',
      denoiseBefore: false,
    });
    expect(res.engine).toBe('ai');
    const p = await probeAsset(out);
    expect([p.width, p.height]).toEqual([128, 96]);
  }, T_AI);
});

describe.runIf(aiIp.ok)('AI 프레임 보간 실제 실행', () => {
  it('30fps → 60fps (rife-v4.6), 프레임이 2배로 늘고 길이는 그대로', async () => {
    const out = path.join(dir, 'ai60.mp4');
    const res = await interpolateFps(tiny, out, { fps: 60, engine: 'ai' });
    expect(res.engine).toBe('ai');
    const v = (await ffprobeJson(out)).streams?.find((s) => s.codec_type === 'video') as
      | { avg_frame_rate?: string; nb_frames?: string }
      | undefined;
    // 청크 mp4 를 concat 하므로 컨테이너의 평균 fps 는 60 «근처» 다 (실측 60.0098).
    const [n, d] = (v?.avg_frame_rate ?? '0/1').split('/').map(Number);
    expect(Math.abs(n! / d! - 60)).toBeLessThan(0.5);
    const before = await probeAsset(tiny);
    const after = await probeAsset(out);
    expect(Math.abs((after.duration ?? 0) - (before.duration ?? 0))).toBeLessThanOrEqual(120);
  }, T_AI);

  it('목표 fps 가 원본보다 낮으면 조용히 넘어가지 않고 실패한다', async () => {
    const out = path.join(dir, 'ai15.mp4');
    await expect(interpolateFps(tiny, out, { fps: 15, engine: 'ai' })).rejects.toThrow(/높아야/);
  }, T);
});
