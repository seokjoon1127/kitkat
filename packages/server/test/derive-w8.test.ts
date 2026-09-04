// W8 S3 — scheduleDeriveJobs 가 새 ClipSource 필드를 DeriveSpec 으로 넘기는 배선.
// deriveMedia 를 목으로 잡아 «어떤 스펙이 실제로 갔는지» 를 본다.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sourceKey, type ClipSource, type MatchLevels, type ProjectDoc } from '@kitkat/schema';

const h = vi.hoisted(() => ({
  /** deriveMedia 가 받은 (key, spec) 기록. */
  calls: [] as { key: string; spec: Record<string, unknown> }[],
  /** voiceIrPath 가 돌려줄 경로 — 테스트가 바꾼다. */
  irPath: '',
}));

vi.mock('@kitkat/media', async () => ({
  // 진짜 모듈을 통째로 깔고 스텁만 덮는다 — 서버 코어가 media 에서 새로 쓰는 것(runWithJobSignal 등)이
  // 생겨도 모의가 «함수가 아닙니다» 로 죽지 않는다. isCurrentProxy 도 진짜다.
  ...(await vi.importActual<typeof import('@kitkat/media')>('@kitkat/media')),
  probeAsset: vi.fn(async () => ({ kind: 'video', duration: 5000, width: 1080, height: 1920, hasAudio: true })),
  makeProxy: vi.fn(async (_a: string, _m: string, id: string) => `proxies/${id}.mp4`),
  makeWaveform: vi.fn(async (_a: string, _m: string, id: string) => `waveforms/${id}.json`),
  makeThumb: vi.fn(async (_a: string, _m: string, id: string) => `thumbs/${id}.jpg`),
  preprocessReverse: vi.fn(async (_a: string, _m: string, id: string) => `derived/${id}.rev.mp4`),
  extractAudio: vi.fn(async () => {}),
  toGif: vi.fn(async () => {}),
  detectEncoder: vi.fn(async () => 'libx264'),
  detectBeats: vi.fn(async () => [0, 500]),
  gifToWebm: vi.fn(async () => {}),
  // W8 F1·F2 — 옵션 객체 API. 어떤 엔진으로 처리했는지 돌려준다.
  upscaleVideo: vi.fn(async () => ({ engine: 'lanczos', seconds: 0 })),
  interpolateFps: vi.fn(async () => ({ engine: 'minterpolate', seconds: 0 })),
  isUpscaleAiReady: vi.fn(async () => ({ ok: true })),
  isInterpolateAiReady: vi.fn(async () => ({ ok: true })),
  UPSCALE_MODELS: ['realesrgan-x4plus', 'realesr-animevideov3', 'realesrgan-x4plus-anime'],
  INTERPOLATE_MODELS: ['rife-v4.6', 'rife-v4', 'rife-v3.1', 'rife-v3.0', 'rife-v2.4', 'rife-v2.3', 'rife-anime', 'rife-HD', 'rife-UHD'],
  parseCubeLut: vi.fn(async () => ({ size: 2 })),
  // 실제 구현과 같은 계산 — 배선이 값을 제대로 옮기는지 보려면 이 함수도 진짜여야 한다
  estimateMotionBlurSeconds: vi.fn(
    (mb: { shutterAngle: number; quality: 'fast' | 'precise' }, info: { durationMs?: number; width?: number; height?: number }) => {
      const frames = mb.quality === 'precise'
        ? Math.round((8 * mb.shutterAngle) / 360)
        : Math.round((3 * mb.shutterAngle) / 180);
      if (frames < 2) return 0;
      const px = (info.width ?? 1080) * (info.height ?? 1920);
      return Math.round(((info.durationMs ?? 0) / 1000) * (mb.quality === 'precise' ? 77 : 0.8) * (px / (1080 * 1920)));
    },
  ),
  voiceIrPath: vi.fn(() => h.irPath),
  deriveMedia: vi.fn(async (_abs: string, mediaDir: string, assetId: string, key: string, spec: Record<string, unknown>) => {
    h.calls.push({ key, spec: structuredClone(spec) });
    const fsp = await import('node:fs/promises');
    const p = await import('node:path');
    await fsp.mkdir(p.join(mediaDir, 'derived'), { recursive: true });
    const src = `derived/${assetId}.${key}.mp4`;
    await fsp.writeFile(p.join(mediaDir, src), 'baked');
    return { src, loudnorm: { normalization_type: 'linear', input_i: '-21.8', output_i: '-14.0' } };
  }),
}));

vi.mock('@kitkat/renderer', () => ({
  renderProject: vi.fn(async (_d: unknown, o: { outPath: string }) => ({ outPath: o.outPath, durationMs: 1000 })),
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

import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let tmpRoot: string;
let mediaRoot: string;
let seq = 0;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-w8-'));
  mediaRoot = path.join(tmpRoot, 'media');
  await mkdir(mediaRoot, { recursive: true });
  app = await buildApp({ dataDir: path.join(tmpRoot, 'data', 'projects'), mediaDir: mediaRoot });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  h.calls.length = 0;
  h.irPath = path.join(tmpRoot, 'no-such-ir.wav');
});

afterEach(async () => {
  for (const close of openSockets) close();
  openSockets.length = 0;
  await new Promise((r) => setTimeout(r, 20));
});

const stat = (mean: number, std: number) => ({ mean, std });
const LEVELS: MatchLevels = {
  sampledAtMs: [100, 300, 500],
  refSourceKey: 'sdeadbeef',
  ref: [stat(0.47, 0.46), stat(0.52, 0.47), stat(0.5, 0.5)],
  target: [stat(0.41, 0.4), stat(0.37, 0.35), stat(0.28, 0.26)],
};

function keyOf(source: ClipSource): string {
  return sourceKey({
    id: 'k', kind: 'video', assetId: 'a', start: 0, duration: 1000,
    in: 0, out: 1000, speed: 1, volume: 1, source,
  })!;
}

async function waitFor(cond: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`조건이 제한 시간 안에 충족되지 않음: ${label}`);
}

type SeenJob = { id: string; type: string; status: string; error?: string; result?: Record<string, unknown> };

/** 잡 상태는 WS 로만 나온다 — 명령을 보내기 «전» 에 붙어야 놓치지 않는다. */
async function collect(projectId: string): Promise<{ jobs: SeenJob[]; close(): void }> {
  const jobs: SeenJob[] = [];
  const ws = await app.injectWS(`/ws/projects/${projectId}`, {}, {
    onInit: (sock: { on(ev: string, cb: (data: Buffer) => void): void }) => {
      sock.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'job') jobs.push(msg.job as SeenJob);
      });
    },
  } as never);
  return { jobs, close: () => ws.terminate() };
}

const openSockets: (() => void)[] = [];

/** 프로젝트 + video 에셋 + source 붙은 클립 하나. */
async function setup(source: ClipSource): Promise<{ projectId: string; assetId: string; key: string; jobs: SeenJob[] }> {
  const n = ++seq;
  const assetId = `w8a${n}`;
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: `w8-${n}` } });
  const doc = res.json().doc as ProjectDoc;
  const vt = doc.tracks.find((t) => t.kind === 'video')!.id;
  const seen = await collect(doc.id);
  openSockets.push(seen.close);
  const send = await app.inject({
    method: 'POST',
    url: `/api/projects/${doc.id}/commands`,
    payload: {
      commands: [
        { type: 'addAsset', asset: { id: assetId, kind: 'video', src: `assets/${assetId}.mp4`, name: 'a.mp4', duration: 30000, width: 1080, height: 1920 } },
        { type: 'addClip', trackId: vt, clip: { id: `c${n}`, kind: 'video', assetId, start: 0, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1, source } },
      ],
    },
  });
  expect(send.statusCode).toBe(200);
  return { projectId: doc.id, assetId, key: keyOf(source), jobs: seen.jobs };
}

describe('scheduleDeriveJobs — W8 S3 배선', () => {
  it('hueSat·hsl·motionBlur 가 DeriveSpec 으로 그대로 간다', async () => {
    const source: ClipSource = {
      hueSat: [{ id: 'h', bands: ['r', 'y'], hue: 12, saturation: -0.15, intensity: 0 }],
      hsl: [{ id: 's', family: 'reds', cyan: 0.06, magenta: -0.05, yellow: 0, black: 0 }],
      motionBlur: { shutterAngle: 180, quality: 'precise' },
    };
    const { key } = await setup(source);
    await waitFor(() => h.calls.some((c) => c.key === key), 'derive 호출');
    const spec = h.calls.find((c) => c.key === key)!.spec;
    expect(spec.hueSat).toEqual(source.hueSat);
    expect(spec.hsl).toEqual(source.hsl);
    expect(spec.motionBlur).toEqual(source.motionBlur);
  });

  it('voice 는 loudness.targetLufs 기본 -14 를 별개 필드로 채워서 넘긴다', async () => {
    const { key } = await setup({ voice: { preset: 'broadcast' } });
    await waitFor(() => h.calls.some((c) => c.key === key), 'derive 호출');
    const spec = h.calls.find((c) => c.key === key)!.spec;
    expect(spec.voice).toEqual({ preset: 'broadcast' });
    expect(spec.loudness).toEqual({ targetLufs: -14 });
  });

  it('voice.targetLufs 를 적으면 그 값이 loudness 로 간다 (몰래 바꾸지 않는다)', async () => {
    const { key } = await setup({ voice: { preset: 'podcast', targetLufs: -20 } });
    await waitFor(() => h.calls.some((c) => c.key === key), 'derive 호출');
    const spec = h.calls.find((c) => c.key === key)!.spec;
    expect(spec.voice).toEqual({ preset: 'podcast' });
    expect(spec.loudness).toEqual({ targetLufs: -20 });
  });

  it("voice preset:'off' 는 스펙에 안 들어간다 (loudness 도 없으면 안 채워진다)", async () => {
    const { key } = await setup({ voice: { preset: 'off' }, denoise: { amount: 0.3 } });
    await waitFor(() => h.calls.some((c) => c.key === key), 'derive 호출');
    const spec = h.calls.find((c) => c.key === key)!.spec;
    expect(spec.voice).toBeUndefined();
    expect(spec.loudness).toBeUndefined();
    expect(spec.denoise).toEqual({ amount: 0.3 });
  });

  it("voice preset:'off' 여도 loudness 가 있으면 음악 음량만 맞춘다", async () => {
    const { key } = await setup({ voice: { preset: 'off' }, loudness: { targetLufs: -24 } });
    await waitFor(() => h.calls.some((c) => c.key === key), 'derive 호출');
    const spec = h.calls.find((c) => c.key === key)!.spec;
    expect(spec.voice).toBeUndefined();
    expect(spec.loudness).toEqual({ targetLufs: -24 });
  });

  it('matchTo 에 levels 가 «없으면» 잡을 등록하지 않는다 (측정은 F4 담당)', async () => {
    const { key, jobs } = await setup({ matchTo: { clipId: 'ref1', strength: 1 } });
    // 키는 생기지만(설정이 바뀌었으니) 굽지는 않는다
    expect(key).toMatch(/^s[0-9a-f]{8}$/);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.calls.some((c) => c.key === key)).toBe(false);
    expect(jobs.filter((j) => j.type === 'derive')).toHaveLength(0);
  });

  it('levels 가 들어오면 그때 굽는다 — strength 와 levels 가 그대로 간다', async () => {
    const source: ClipSource = { matchTo: { clipId: 'ref1', strength: 0.8, levels: LEVELS } };
    const { key } = await setup(source);
    await waitFor(() => h.calls.some((c) => c.key === key), 'derive 호출');
    expect(h.calls.find((c) => c.key === key)!.spec.matchTo).toEqual({ levels: LEVELS, strength: 0.8 });
  });

  it('matchTo 를 «측정 전 → 측정 후» 로 바꾸면 키가 갈리고 그때 한 번만 굽는다', async () => {
    const before: ClipSource = { matchTo: { clipId: 'r', strength: 1 } };
    const after: ClipSource = { matchTo: { clipId: 'r', strength: 1, levels: LEVELS } };
    expect(keyOf(before)).not.toBe(keyOf(after));
    const { projectId } = await setup(before);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.calls).toHaveLength(0);

    const doc = (await (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).json()).doc as ProjectDoc;
    const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'video')!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/commands`,
      payload: { commands: [{ type: 'updateClip', clipId: clip.id, patch: { source: after } }] },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => h.calls.some((c) => c.key === keyOf(after)), '측정 후 파생');
    expect(h.calls.filter((c) => c.key === keyOf(before))).toHaveLength(0);
  });

  it('모션 블러 예상 시간을 잡 결과에 담는다 (1080×1920 30초 precise ≈ 2310초)', async () => {
    const { key, jobs } = await setup({ motionBlur: { shutterAngle: 180, quality: 'precise' } });
    await waitFor(() => jobs.some((j) => j.type === 'derive' && j.status === 'done'), 'derive 완료');
    const job = jobs.find((j) => j.type === 'derive' && j.status === 'done')!;
    expect(job.result?.key).toBe(key);
    expect(job.result?.estimateSec).toBe(2310);
  });

  it('voice 의 loudnorm 측정 결과를 잡 결과에 담는다 (dynamic 으로 떨어진 것을 숨기지 않기 위해)', async () => {
    const { jobs } = await setup({ voice: { preset: 'warm' } });
    await waitFor(() => jobs.some((j) => j.type === 'derive' && j.status === 'done'), 'derive 완료');
    const job = jobs.find((j) => j.type === 'derive' && j.status === 'done')!;
    expect((job.result?.loudnorm as { normalization_type?: string })?.normalization_type).toBe('linear');
  });

  it('reverb IR 파일이 없으면 «조용히 건너뛰지 않고» 잡을 실패시킨다', async () => {
    const { jobs } = await setup({ voice: { preset: 'broadcast', reverb: { irId: 'voxengo/hall-medium', wet: 0.3 } } });
    await waitFor(() => jobs.some((j) => j.type === 'derive' && j.status === 'error'), 'derive 실패');
    const job = jobs.find((j) => j.type === 'derive' && j.status === 'error')!;
    expect(job.error).toContain('IR 파일을 찾을 수 없습니다');
    expect(job.error).toContain('voxengo/hall-medium');
  });

  it('reverb IR 이 있으면 절대경로로 변환해 넘긴다', async () => {
    h.irPath = path.join(tmpRoot, 'ir.wav');
    await writeFile(h.irPath, 'fake-ir');
    const { key } = await setup({ voice: { preset: 'broadcast', reverb: { irId: 'voxengo/room-small', wet: 0.4 } } });
    await waitFor(() => h.calls.some((c) => c.key === key), 'derive 호출');
    expect(h.calls.find((c) => c.key === key)!.spec.voice).toEqual({
      preset: 'broadcast', reverb: { irAbs: h.irPath, wet: 0.4 },
    });
  });

  it('derived 에는 파일 경로만 저장한다 (loudnorm 통계가 문서에 새지 않는다)', async () => {
    const { projectId, assetId, key } = await setup({ voice: { preset: 'bright' } });
    await waitFor(async () => {
      const doc = (await (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).json()).doc as ProjectDoc;
      return doc.assets[assetId]?.derived?.[key] != null;
    }, '문서 반영');
    const doc = (await (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).json()).doc as ProjectDoc;
    expect(Object.keys(doc.assets[assetId]!.derived![key]!)).toEqual(['src']);
  });

  it('기존 W5 필드만 든 클립의 배선은 그대로다 (회귀)', async () => {
    const { key } = await setup({ denoise: { amount: 0.4 }, pitch: { semitones: 2 } });
    await waitFor(() => h.calls.some((c) => c.key === key), 'derive 호출');
    const spec = h.calls.find((c) => c.key === key)!.spec;
    expect(spec).toEqual({ denoise: { amount: 0.4 }, pitch: { semitones: 2 } });
  });
});
