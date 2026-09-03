// W8 F1·F2 — /upscale · /interpolate 의 engine·model 확장과 501 판정.
// media 는 전부 vi.mock (실제 ffmpeg·ncnn 실행 없음).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProjectDoc } from '@kitkat/schema';

vi.mock('@kitkat/media', async () => ({
  // 진짜 모듈을 통째로 깔고 스텁만 덮는다 — 서버 코어가 media 에서 새로 쓰는 것(runWithJobSignal 등)이
  // 생겨도 모의가 «함수가 아닙니다» 로 죽지 않는다. isCurrentProxy 도 진짜다.
  ...(await vi.importActual<typeof import('@kitkat/media')>('@kitkat/media')),
  probeAsset: vi.fn(async () => ({
    kind: 'video', duration: 5000, width: 1080, height: 1920, hasAudio: true,
  })),
  makeProxy: vi.fn(async (_a: string, _m: string, id: string) => `proxies/${id}.mp4`),
  makeWaveform: vi.fn(async (_a: string, _m: string, id: string) => `waveforms/${id}.json`),
  makeThumb: vi.fn(async (_a: string, _m: string, id: string) => `thumbs/${id}.jpg`),
  preprocessReverse: vi.fn(async (_a: string, _m: string, id: string) => `derived/${id}.rev.mp4`),
  extractAudio: vi.fn(async () => {}),
  toGif: vi.fn(async () => {}),
  detectEncoder: vi.fn(async () => 'libx264'),
  deriveMedia: vi.fn(async () => ({ src: 'derived/x.mp4' })),
  detectBeats: vi.fn(async () => [0, 500]),
  gifToWebm: vi.fn(async () => {}),
  parseCubeLut: vi.fn(async () => ({ size: 2 })),
  upscaleVideo: vi.fn(async () => ({ engine: 'ai', seconds: 1 })),
  interpolateFps: vi.fn(async () => ({ engine: 'ai', seconds: 1 })),
  isUpscaleAiReady: vi.fn(async () => ({ ok: true })),
  isInterpolateAiReady: vi.fn(async () => ({ ok: true })),
  UPSCALE_MODELS: ['realesrgan-x4plus', 'realesr-animevideov3', 'realesrgan-x4plus-anime'],
  INTERPOLATE_MODELS: ['rife-v4.6', 'rife-v4', 'rife-v3.1', 'rife-anime'],
}));

vi.mock('@kitkat/renderer', () => ({
  renderProject: vi.fn(async (_d: unknown, o: { outPath: string }) => ({ outPath: o.outPath, durationMs: 1 })),
  renderCover: vi.fn(async (_d: unknown, o: { outPath: string }) => ({ outPath: o.outPath })),
}));

vi.mock('@kitkat/ai', () => {
  class AiUnavailableError extends Error {}
  return {
    AiUnavailableError,
    ensurePython: vi.fn(async () => ({ ok: true })),
    transcribe: vi.fn(async () => []),
    ensureDemucs: vi.fn(async () => ({ ok: true })),
    isDemucsReady: vi.fn(async () => true),
    separateStems: vi.fn(async () => ({ vocals: '', accompaniment: '' })),
  };
});

import { interpolateFps, isInterpolateAiReady, isUpscaleAiReady, upscaleVideo } from '@kitkat/media';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let tmpRoot: string;
let projectId: string;
let assetId: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-f1f2-srv-'));
  app = await buildApp({
    dataDir: path.join(tmpRoot, 'data', 'projects'),
    mediaDir: path.join(tmpRoot, 'media'),
  });
  await app.ready();
  const doc = (
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'F1F2' } })
  ).json().doc as ProjectDoc;
  projectId = doc.id;
  const srcFile = path.join(tmpRoot, 'v.mp4');
  await writeFile(srcFile, 'dummy');
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/assets`,
    payload: { path: srcFile },
  });
  if (res.statusCode !== 200) throw new Error(`임포트 실패 ${res.statusCode}: ${res.body}`);
  assetId = (res.json() as { asset: { id: string } }).asset.id;
});

afterAll(async () => {
  await app.close();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  vi.mocked(upscaleVideo).mockClear();
  vi.mocked(interpolateFps).mockClear();
  vi.mocked(isUpscaleAiReady).mockResolvedValue({ ok: true });
  vi.mocked(isInterpolateAiReady).mockResolvedValue({ ok: true });
});

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload });
const upUrl = () => `/api/projects/${projectId}/assets/${assetId}/upscale`;
const ipUrl = () => `/api/projects/${projectId}/assets/${assetId}/interpolate`;

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 800; i++) {
    const job = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json() as {
      status: string;
    };
    if (job.status === 'done' || job.status === 'error') return job as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('잡이 끝나지 않음');
}

describe('POST /upscale — W8 F1 확장', () => {
  it('scale 3 이 허용된다 (x4 로 올렸다 0.75 로 줄인다)', async () => {
    const res = await post(upUrl(), { scale: 3 });
    expect(res.statusCode).toBe(200);
    await waitJob((res.json() as { jobId: string }).jobId);
    expect(vi.mocked(upscaleVideo).mock.calls[0]![2]).toMatchObject({ scale: 3 });
  });

  it('scale 5 는 400', async () => {
    expect((await post(upUrl(), { scale: 5 })).statusCode).toBe(400);
  });

  it('engine·model 을 그대로 media 로 넘긴다', async () => {
    const res = await post(upUrl(), { scale: 4, engine: 'ai', model: 'realesr-animevideov3' });
    expect(res.statusCode).toBe(200);
    await waitJob((res.json() as { jobId: string }).jobId);
    expect(vi.mocked(upscaleVideo).mock.calls[0]![2]).toMatchObject({
      scale: 4,
      engine: 'ai',
      model: 'realesr-animevideov3',
    });
  });

  it('모르는 engine·model 은 400 (잡을 만들지 않는다)', async () => {
    expect((await post(upUrl(), { engine: 'magic' })).statusCode).toBe(400);
    expect((await post(upUrl(), { model: '없는모델' })).statusCode).toBe(400);
    expect(vi.mocked(upscaleVideo)).not.toHaveBeenCalled();
  });

  it("engine:'ai' 인데 실행 파일이 없으면 501 + prewarm 안내", async () => {
    vi.mocked(isUpscaleAiReady).mockResolvedValue({ ok: false, hint: 'GPU 가 없습니다' });
    const res = await post(upUrl(), { engine: 'ai' });
    expect(res.statusCode).toBe(501);
    const body = res.json() as { error: string };
    expect(body.error).toContain('prewarm.mjs realesrgan');
    expect(body.error).toContain('GPU 가 없습니다');
    expect(vi.mocked(upscaleVideo)).not.toHaveBeenCalled();
  });

  it("engine:'auto' 는 실행 파일이 없어도 501 이 아니다 (lanczos 로 물러난다)", async () => {
    vi.mocked(isUpscaleAiReady).mockResolvedValue({ ok: false, hint: '없음' });
    const res = await post(upUrl(), { engine: 'auto' });
    expect(res.statusCode).toBe(200);
    await waitJob((res.json() as { jobId: string }).jobId);
  });

  it('잡 결과에 실제로 쓴 엔진이 남는다', async () => {
    vi.mocked(upscaleVideo).mockResolvedValueOnce({ engine: 'lanczos', seconds: 3 } as never);
    const res = await post(upUrl(), {});
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect((job.result as { engine: string }).engine).toBe('lanczos');
  });

  it('프레임 진행률이 잡의 detail 로 흘러간다 (「312/900 프레임」)', async () => {
    vi.mocked(upscaleVideo).mockImplementationOnce((async (
      _s: string,
      _o: string,
      opts: { onProgress?: (p: number, f?: { done: number; total: number }) => void },
    ) => {
      opts.onProgress?.(0.34, { done: 312, total: 900 });
      await new Promise((r) => setTimeout(r, 30));
      return { engine: 'ai', seconds: 1 };
    }) as never);
    const res = await post(upUrl(), {});
    const jobId = (res.json() as { jobId: string }).jobId;
    let seen = '';
    for (let i = 0; i < 800 && !seen; i++) {
      const j = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json() as {
        detail?: string;
        status: string;
      };
      if (j.detail) seen = j.detail;
      if (j.status === 'done' || j.status === 'error') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(seen).toBe('312/900 프레임');
  });
});

describe('POST /interpolate — W8 F2 확장', () => {
  it('engine·model 을 그대로 넘긴다', async () => {
    const res = await post(ipUrl(), { fps: 120, engine: 'ai', model: 'rife-v4' });
    expect(res.statusCode).toBe(200);
    await waitJob((res.json() as { jobId: string }).jobId);
    expect(vi.mocked(interpolateFps).mock.calls[0]![2]).toMatchObject({
      fps: 120,
      engine: 'ai',
      model: 'rife-v4',
    });
  });

  it('모르는 engine·model 은 400', async () => {
    expect((await post(ipUrl(), { engine: 'lanczos' })).statusCode).toBe(400); // 업스케일 쪽 값
    expect((await post(ipUrl(), { model: 'rife-v9' })).statusCode).toBe(400);
    expect(vi.mocked(interpolateFps)).not.toHaveBeenCalled();
  });

  it("engine:'ai' 인데 rife 가 없으면 501", async () => {
    vi.mocked(isInterpolateAiReady).mockResolvedValue({ ok: false, hint: '없습니다' });
    const res = await post(ipUrl(), { engine: 'ai' });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { error: string }).error).toContain('prewarm.mjs rife');
  });

  it('잡 결과에 실제로 쓴 엔진이 남는다', async () => {
    vi.mocked(interpolateFps).mockResolvedValueOnce({ engine: 'minterpolate', seconds: 2 } as never);
    const res = await post(ipUrl(), {});
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect((job.result as { engine: string }).engine).toBe('minterpolate');
  });
});
