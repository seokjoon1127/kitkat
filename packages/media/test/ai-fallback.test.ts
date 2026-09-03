// W8 F1·F2 — AI 엔진이 «없을 때» 어떻게 되는가.
// ncnn 백엔드를 통째로 흉내내 실행 파일 없는 머신을 재현한다 (vendor/ 가 있어도 이 파일은 같은 결과).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ncnnInfo = vi.fn(async () => ({ ok: false, hint: '테스트: realesrgan 실행 파일이 없습니다' }));
const pickSafeGpu = vi.fn(() => 1);
const ncnnRun = vi.fn(async () => {
  throw new Error('엔진이 없는데 ncnnRun 이 불렸다');
});

vi.mock('../src/ncnn.js', () => ({ ncnnInfo, ncnnRun, pickSafeGpu }));

const { isUpscaleAiReady, upscaleVideo } = await import('../src/upscale.js');
const { interpolateFps, isInterpolateAiReady } = await import('../src/interpolate.js');
const { probeAsset } = await import('../src/index.js');

const T = 120_000;
let dir: string;
let src: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kitkat-nofb-'));
  src = path.join(dir, 'src.mp4');
  await execa('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=30:duration=0.2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
    src,
  ]);
}, T);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('엔진이 없을 때 (실행 파일 미설치)', () => {
  it("업스케일 engine:'auto' → 조용히 죽지 않고 lanczos 로 물러난다", async () => {
    ncnnInfo.mockResolvedValue({ ok: false, hint: '테스트: 실행 파일 없음' });
    const out = path.join(dir, 'a.mp4');
    const res = await upscaleVideo(src, out, { scale: 2, engine: 'auto' });
    expect(res.engine).toBe('lanczos');
    expect((await probeAsset(out)).width).toBe(128);
    expect(ncnnRun).not.toHaveBeenCalled();
  }, T);

  it("업스케일 engine:'ai' → 폴백하지 않고 실패한다 (서버가 501 로 바꾼다)", async () => {
    ncnnInfo.mockResolvedValue({ ok: false, hint: '테스트: 실행 파일 없음' });
    await expect(
      upscaleVideo(src, path.join(dir, 'b.mp4'), { scale: 2, engine: 'ai' }),
    ).rejects.toThrow(/실행 파일 없음/);
  }, T);

  it("보간 engine:'auto' → minterpolate 로 물러난다", async () => {
    ncnnInfo.mockResolvedValue({ ok: false, hint: '테스트: rife 없음' });
    const out = path.join(dir, 'c.mp4');
    const res = await interpolateFps(src, out, { fps: 60, engine: 'auto' });
    expect(res.engine).toBe('minterpolate');
  }, T);

  it("보간 engine:'ai' → 실패한다", async () => {
    ncnnInfo.mockResolvedValue({ ok: false, hint: '테스트: rife 없음' });
    await expect(
      interpolateFps(src, path.join(dir, 'd.mp4'), { fps: 60, engine: 'ai' }),
    ).rejects.toThrow(/rife 없음/);
  }, T);
});

describe('쓸 수 있는 GPU 가 없을 때', () => {
  it('업스케일은 «불가» 다 — realesrgan 에는 CPU 모드가 없다(-g -1 = invalid gpu device, 실측)', async () => {
    ncnnInfo.mockResolvedValue({ ok: true, hint: 'GPU 없음' } as never);
    pickSafeGpu.mockReturnValue(-1);
    const ready = await isUpscaleAiReady();
    expect(ready.ok).toBe(false);
    expect(ready.hint).toMatch(/CPU/);
    // auto 는 그래도 결과를 낸다 — lanczos 로
    const out = path.join(dir, 'e.mp4');
    expect((await upscaleVideo(src, out, { scale: 2, engine: 'auto' })).engine).toBe('lanczos');
    pickSafeGpu.mockReturnValue(1);
  }, T);

  it('보간은 GPU 가 없어도 «가능» 하다 — rife 는 -g -1 이 진짜 CPU 로 돈다(실측)', async () => {
    ncnnInfo.mockResolvedValue({ ok: true, hint: 'GPU 없음' } as never);
    pickSafeGpu.mockReturnValue(-1);
    expect((await isInterpolateAiReady()).ok).toBe(true);
    pickSafeGpu.mockReturnValue(1);
  }, T);
});
