import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertDiskSpace,
  estimateChunkBytes,
  outputTrim,
  planChunks,
  processInChunks,
} from '../src/frames.js';
import { ffprobeJson } from '../src/ffmpeg.js';

/** 겹친 프레임을 버리고 남은 총합 (원본 프레임 수와 같아야 한다). */
const keptTotal = (plans: ReturnType<typeof planChunks>): number =>
  plans.reduce((n, p) => n + p.frameCount - p.overlapBefore - p.overlapAfter, 0);

describe('planChunks', () => {
  it('겹침 0 · 딱 나눠떨어짐', () => {
    const plans = planChunks(240, 120, 0);
    expect(plans).toEqual([
      { index: 0, startFrame: 0, frameCount: 120, overlapBefore: 0, overlapAfter: 0 },
      { index: 1, startFrame: 120, frameCount: 120, overlapBefore: 0, overlapAfter: 0 },
    ]);
    expect(keptTotal(plans)).toBe(240);
  });

  it('겹침 0 · 안 나눠떨어짐 — 마지막 청크가 짧다', () => {
    const plans = planChunks(250, 120, 0);
    expect(plans).toHaveLength(3);
    expect(plans[2]).toEqual({ index: 2, startFrame: 240, frameCount: 10, overlapBefore: 0, overlapAfter: 0 });
    expect(keptTotal(plans)).toBe(250);
  });

  it('겹침 1 (RIFE) — 가장자리에서는 겹칠 것이 없어 잘린다', () => {
    const plans = planChunks(250, 120, 1);
    expect(plans[0]).toEqual({ index: 0, startFrame: 0, frameCount: 121, overlapBefore: 0, overlapAfter: 1 });
    expect(plans[1]).toEqual({ index: 1, startFrame: 119, frameCount: 122, overlapBefore: 1, overlapAfter: 1 });
    expect(plans[2]).toEqual({ index: 2, startFrame: 239, frameCount: 11, overlapBefore: 1, overlapAfter: 0 });
    expect(keptTotal(plans)).toBe(250);
  });

  it('겹침 2', () => {
    const plans = planChunks(250, 120, 2);
    expect(plans[0]).toMatchObject({ startFrame: 0, frameCount: 122, overlapBefore: 0, overlapAfter: 2 });
    expect(plans[1]).toMatchObject({ startFrame: 118, frameCount: 124, overlapBefore: 2, overlapAfter: 2 });
    expect(plans[2]).toMatchObject({ startFrame: 238, frameCount: 12, overlapBefore: 2, overlapAfter: 0 });
    expect(keptTotal(plans)).toBe(250);
  });

  it('겹침을 버리면 총합이 언제나 원본과 같고, 구간이 빈틈없이 이어진다', () => {
    for (const total of [1, 7, 119, 120, 121, 250, 899, 900, 901]) {
      for (const size of [1, 5, 120, 1000]) {
        for (const overlap of [0, 1, 2, 5]) {
          const plans = planChunks(total, size, overlap);
          expect(keptTotal(plans)).toBe(total);
          // 자기 몫의 시작 = 앞 청크 자기 몫의 끝
          let cursor = 0;
          for (const p of plans) {
            expect(p.startFrame + p.overlapBefore).toBe(cursor);
            cursor += p.frameCount - p.overlapBefore - p.overlapAfter;
            expect(p.startFrame).toBeGreaterThanOrEqual(0);
            expect(p.startFrame + p.frameCount).toBeLessThanOrEqual(total);
          }
          expect(cursor).toBe(total);
        }
      }
    }
  });

  it('청크가 원본보다 크면 한 덩어리', () => {
    expect(planChunks(30, 120, 1)).toEqual([
      { index: 0, startFrame: 0, frameCount: 30, overlapBefore: 0, overlapAfter: 0 },
    ]);
  });

  it('프레임이 0이면 빈 계획', () => {
    expect(planChunks(0, 120, 1)).toEqual([]);
  });

  it('말이 안 되는 입력은 거부한다', () => {
    expect(() => planChunks(-1, 120, 0)).toThrow(/totalFrames/);
    expect(() => planChunks(100, 0, 0)).toThrow(/chunkSize/);
    expect(() => planChunks(100, 120, -1)).toThrow(/overlap/);
    expect(() => planChunks(100.5, 120, 0)).toThrow(/totalFrames/);
  });
});

describe('outputTrim', () => {
  it('업스케일(1:1)이면 겹침 수를 그대로 버린다', () => {
    const plan = { index: 1, startFrame: 119, frameCount: 122, overlapBefore: 1, overlapAfter: 1 };
    expect(outputTrim(plan, 122)).toEqual({ dropFront: 1, dropBack: 1 });
  });

  it('보간(2배)이면 늘어난 비율만큼 환산해 버린다', () => {
    const plan = { index: 1, startFrame: 119, frameCount: 122, overlapBefore: 1, overlapAfter: 1 };
    expect(outputTrim(plan, 244)).toEqual({ dropFront: 2, dropBack: 2 });
  });

  it('겹침이 없으면 아무것도 안 버린다', () => {
    const plan = { index: 0, startFrame: 0, frameCount: 120, overlapBefore: 0, overlapAfter: 0 };
    expect(outputTrim(plan, 120)).toEqual({ dropFront: 0, dropBack: 0 });
  });

  it('결과가 아주 적어도 최소 한 장은 남긴다', () => {
    const plan = { index: 0, startFrame: 0, frameCount: 3, overlapBefore: 1, overlapAfter: 1 };
    const t = outputTrim(plan, 1);
    expect(t.dropFront + t.dropBack).toBe(0);
    expect(outputTrim(plan, 0)).toEqual({ dropFront: 0, dropBack: 0 });
  });
});

describe('디스크 여유 검사', () => {
  it('추정치 = 프레임수 × 픽셀수 × 4바이트 × 2', () => {
    expect(estimateChunkBytes(120, 1080, 1920)).toBe(120 * 1080 * 1920 * 4 * 2);
  });

  it('여유가 추정치×1.5 에 못 미치면 한국어로 실패한다', () => {
    const need = estimateChunkBytes(120, 1080, 1920); // 약 1.86GB → 필요 2.78GB
    expect(() => assertDiskSpace(need * 1.4, need, 'C:/Temp')).toThrow(/임시 디스크 공간이 부족합니다/);
    expect(() => assertDiskSpace(need * 1.4, need, 'C:/Temp')).toThrow(/C:\/Temp/);
    expect(() => assertDiskSpace(need * 1.4, need, 'C:/Temp')).toThrow(/chunkFrames/);
  });

  it('여유가 추정치×1.5 이상이면 통과한다', () => {
    const need = estimateChunkBytes(120, 1080, 1920);
    expect(() => assertDiskSpace(need * 1.5, need, 'C:/Temp')).not.toThrow();
    expect(() => assertDiskSpace(need * 10, need, 'C:/Temp')).not.toThrow();
  });
});

// --- 실제 왕복 (GPU 없음 — onChunk 는 프레임을 그대로 복사만 한다) ---

const T = 180_000;
let dir: string;
let src4s: string; // 4초 30fps 320x180 = 120프레임 + 오디오

/** 실제로 디코드되는 프레임 수를 센다. */
async function countFrames(abs: string): Promise<number> {
  const { stdout } = await execa('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', abs,
  ]);
  return Number(String(stdout).trim());
}

const copyFrames = async (inDir: string, outDir: string): Promise<void> => {
  for (const f of await readdir(inDir)) await copyFile(path.join(inDir, f), path.join(outDir, f));
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kitkat-frames-test-'));
  src4s = path.join(dir, 'src.mp4');
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest',
    src4s,
  ]);
  expect(await countFrames(src4s)).toBe(120);
}, T);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('processInChunks (실제 왕복)', () => {
  it('겹침 0 · 3청크 — 프레임 수와 오디오가 보존된다', async () => {
    const out = path.join(dir, 'out-nooverlap.mp4');
    const seen: number[] = [];
    await processInChunks(src4s, out, {
      chunkFrames: 50,
      onChunk: async (inDir, outDir, plan) => {
        seen.push(plan.frameCount);
        await copyFrames(inDir, outDir);
      },
    });
    expect(seen).toEqual([50, 50, 20]);
    expect(await countFrames(out)).toBe(120);
    const info = await ffprobeJson(out);
    expect((info.streams ?? []).some((s) => s.codec_type === 'audio')).toBe(true);
  }, T);

  it('겹침 1 (RIFE) — 더 뽑고 버려서 총 프레임은 그대로다', async () => {
    const out = path.join(dir, 'out-overlap1.mp4');
    const seen: number[] = [];
    await processInChunks(src4s, out, {
      chunkFrames: 50,
      overlapFrames: 1,
      onChunk: async (inDir, outDir, plan) => {
        seen.push(plan.frameCount);
        await copyFrames(inDir, outDir);
      },
    });
    expect(seen).toEqual([51, 52, 21]); // 겹침 포함해서 더 뽑는다
    expect(await countFrames(out)).toBe(120); // 버리고 나면 원본과 같다
  }, T);

  it('keepAudio:false 면 오디오를 붙이지 않는다', async () => {
    const out = path.join(dir, 'out-noaudio.mp4');
    await processInChunks(src4s, out, {
      chunkFrames: 120,
      keepAudio: false,
      onChunk: copyFrames,
    });
    const info = await ffprobeJson(out);
    expect((info.streams ?? []).some((s) => s.codec_type === 'audio')).toBe(false);
  }, T);

  it('진행률은 0 초과 1 이하로 단조 증가하고 마지막이 1이다', async () => {
    const out = path.join(dir, 'out-progress.mp4');
    const ps: number[] = [];
    await processInChunks(src4s, out, {
      chunkFrames: 40,
      onChunk: copyFrames,
      onProgress: (p) => ps.push(p),
    });
    expect(ps).toHaveLength(3);
    expect(ps[ps.length - 1]).toBe(1);
    for (let i = 1; i < ps.length; i++) expect(ps[i]!).toBeGreaterThan(ps[i - 1]!);
  }, T);

  it('onChunk 가 아무것도 안 만들면 명확히 실패한다 (조용히 프레임을 버리지 않는다)', async () => {
    const out = path.join(dir, 'out-empty.mp4');
    await expect(
      processInChunks(src4s, out, { chunkFrames: 120, onChunk: async () => {} }),
    ).rejects.toThrow(/처리 결과가 비었습니다/);
  }, T);
});
