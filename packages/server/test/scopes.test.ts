// F6-B 정밀 스코프 라우트 — 스틸 렌더·ffmpeg 는 가짜로 두고 **캐시와 검증**을 본다.
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProjectDoc } from '@kitkat/schema';

// vi.mock 은 파일 맨 위로 끌어올려지므로 가짜 함수도 vi.hoisted 로 같이 올린다.
const mocks = vi.hoisted(() => ({
  /** 굽는 시늉만 — 파일은 실제로 만든다(캐시 판정이 파일 존재를 본다). */
  renderScopeImages: vi.fn(
    async (
      _src: string,
      outDir: string,
      fileFor: (k: string) => string,
      kinds: readonly string[],
    ) => {
      const { promises: fs } = await import('node:fs');
      const p = await import('node:path');
      await fs.mkdir(outDir, { recursive: true });
      const made: Record<string, string> = {};
      for (const k of kinds) {
        const abs = p.default.join(outDir, fileFor(k));
        await fs.writeFile(abs, `png:${k}`);
        made[k] = abs;
      }
      return made;
    },
  ),
  measureStillStats: vi.fn(async () => ({
    width: 256,
    height: 455,
    pixels: 256 * 455,
    mean: [10, 20, 30] as [number, number, number],
    meanY: 18.4,
    meanCb: 5.6,
    meanCr: -6.7,
  })),
  renderCover: vi.fn(async (_doc: unknown, opts: { outPath: string }) => {
    const { promises: fs } = await import('node:fs');
    const p = await import('node:path');
    await fs.mkdir(p.default.dirname(opts.outPath), { recursive: true });
    await fs.writeFile(opts.outPath, 'jpg');
    return { outPath: opts.outPath };
  }),
}));

const { renderScopeImages, measureStillStats, renderCover } = mocks;

vi.mock('@kitkat/media', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  renderScopeImages: mocks.renderScopeImages,
  measureStillStats: mocks.measureStillStats,
}));

vi.mock('@kitkat/renderer', () => ({
  renderProject: vi.fn(async (_d: unknown, o: { outPath: string }) => ({
    outPath: o.outPath,
    durationMs: 1000,
  })),
  renderAudioStem: vi.fn(async (_d: unknown, o: { outPath: string }) => ({
    outPath: o.outPath,
    durationMs: 1000,
  })),
  renderCover: mocks.renderCover,
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
let mediaDir: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-scopes-srv-'));
  mediaDir = path.join(tmpRoot, 'media');
  app = await buildApp({ dataDir: path.join(tmpRoot, 'data', 'projects'), mediaDir });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  renderCover.mockClear();
  renderScopeImages.mockClear();
  measureStillStats.mockClear();
});

async function newProject(name = '스코프'): Promise<ProjectDoc> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
  expect(res.statusCode).toBe(200);
  return res.json().doc as ProjectDoc;
}

async function waitJob(jobId: string): Promise<{
  status: string;
  error?: string;
  result?: Record<string, unknown>;
}> {
  for (let i = 0; i < 400; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    const job = res.json() as { status: string };
    if (job.status === 'done' || job.status === 'error') {
      return job as { status: string; error?: string; result?: Record<string, unknown> };
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('잡이 제한 시간 안에 안 끝남');
}

async function ask(
  id: string,
  payload: Record<string, unknown>,
): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${id}/scopes`,
    payload,
  });
  return { code: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('POST /api/projects/:id/scopes — 입력 검증', () => {
  it('없는 프로젝트면 404', async () => {
    const r = await ask('없는id', { timeMs: 0 });
    expect(r.code).toBe(404);
  });

  it('timeMs 가 없거나 음수면 400', async () => {
    const doc = await newProject();
    expect((await ask(doc.id, {})).code).toBe(400);
    expect((await ask(doc.id, { timeMs: -1 })).code).toBe(400);
    expect((await ask(doc.id, { timeMs: 'x' })).code).toBe(400);
  });

  it('모르는 종류면 400 이고 아는 이름들을 알려 준다', async () => {
    const doc = await newProject();
    const r = await ask(doc.id, { timeMs: 0, kinds: ['waveform', 'rgb퍼레이드'] });
    expect(r.code).toBe(400);
    expect(String(r.body.error)).toContain('rgb퍼레이드');
    expect(String(r.body.error)).toContain('vectorscope');
  });

  it('kinds 가 빈 배열이면 400', async () => {
    const doc = await newProject();
    expect((await ask(doc.id, { timeMs: 0, kinds: [] })).code).toBe(400);
  });
});

describe('POST /api/projects/:id/scopes — 결과', () => {
  it('세 종류 PNG 를 굽고 /media/scopes/ URL 을 준다', async () => {
    const doc = await newProject();
    const r = await ask(doc.id, { timeMs: 1234 });
    expect(r.code).toBe(200);
    expect(r.body.revision).toBe(doc.revision);
    expect(r.body.timeMs).toBe(1234);

    const job = await waitJob(r.body.jobId as string);
    expect(job.status).toBe('done');
    const urls = job.result?.urls as Record<string, string>;
    expect(Object.keys(urls).sort()).toEqual(['histogram', 'vectorscope', 'waveform']);
    for (const u of Object.values(urls)) {
      expect(u.startsWith('/media/scopes/')).toBe(true);
      expect(u.endsWith('.png')).toBe(true);
      expect(u).toContain(`-r${doc.revision}-t1234-`);
    }
    expect(job.result?.cached).toBe(false);
    // 최종 픽셀 평균 — UI 가 실시간 스코프와 빼서 「얼마나 다른지」를 보여 준다
    const stats = job.result?.stats as { mean: number[]; meanY: number };
    expect(stats.mean).toEqual([10, 20, 30]);
    expect(stats.meanY).toBeCloseTo(18.4, 5);
    // 스틸은 중간 산출물이라 남기지 않는다
    const files = await fsp.readdir(path.join(mediaDir, 'scopes'));
    expect(files.some((f) => f.endsWith('.jpg'))).toBe(false);
  });

  it('실제로 파일이 media/scopes 에 생긴다', async () => {
    const doc = await newProject();
    const r = await ask(doc.id, { timeMs: 500, kinds: ['waveform'] });
    const job = await waitJob(r.body.jobId as string);
    const url = (job.result?.urls as Record<string, string>).waveform as string;
    const abs = path.join(mediaDir, url.replace('/media/', ''));
    expect((await fsp.stat(abs)).size).toBeGreaterThan(0);
  });

  it('같은 (revision, timeMs) 면 다시 굽지 않는다 — 캐시', async () => {
    const doc = await newProject();
    const first = await ask(doc.id, { timeMs: 700 });
    const j1 = await waitJob(first.body.jobId as string);
    expect(j1.result?.cached).toBe(false);
    expect(renderCover).toHaveBeenCalledTimes(1);

    renderCover.mockClear();
    const second = await ask(doc.id, { timeMs: 700 });
    const j2 = await waitJob(second.body.jobId as string);
    expect(j2.result?.cached).toBe(true);
    expect(renderCover).not.toHaveBeenCalled();
    expect(j2.result?.urls).toEqual(j1.result?.urls);
    // 캐시에 맞아도 통계는 같이 돌려준다 (옆에 남겨 둔 json 에서 읽는다)
    expect(j2.result?.stats).toEqual(j1.result?.stats);
  });

  it('리비전이 오르면 캐시가 무효가 된다', async () => {
    const doc = await newProject();
    const j1 = await waitJob((await ask(doc.id, { timeMs: 900 })).body.jobId as string);
    expect(renderCover).toHaveBeenCalledTimes(1);

    // 문서를 한 번 고쳐 revision 을 올린다
    const upd = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'setSettings', settings: { fps: 24 } }] },
    });
    expect(upd.statusCode).toBe(200);

    renderCover.mockClear();
    const r2 = await ask(doc.id, { timeMs: 900 });
    expect(r2.body.revision).not.toBe(doc.revision);
    const j2 = await waitJob(r2.body.jobId as string);
    expect(j2.result?.cached).toBe(false);
    expect(renderCover).toHaveBeenCalledTimes(1);
    expect(j2.result?.urls).not.toEqual(j1.result?.urls);
  });

  it('kinds 를 좁히면 그것만 굽고 그것만 돌려준다', async () => {
    const doc = await newProject();
    const r = await ask(doc.id, { timeMs: 10, kinds: ['vectorscope', 'vectorscope'] });
    const job = await waitJob(r.body.jobId as string);
    expect(Object.keys(job.result?.urls as object)).toEqual(['vectorscope']);
    expect(renderScopeImages).toHaveBeenCalledTimes(1);
    expect(renderScopeImages.mock.calls[0]?.[3]).toEqual(['vectorscope']);
  });

  it('proxy:true 는 스틸을 프록시로 굽고 이름을 따로 쓴다', async () => {
    const doc = await newProject();
    const r = await ask(doc.id, { timeMs: 42, kinds: ['histogram'], proxy: true });
    const job = await waitJob(r.body.jobId as string);
    expect(job.result?.proxy).toBe(true);
    expect((job.result?.urls as Record<string, string>).histogram).toContain('-t42-p-histogram');
    expect(renderCover.mock.calls[0]?.[1]).toMatchObject({ proxy: true, timeMs: 42 });
  });

  it('스틸 렌더가 터지면 잡이 error 로 끝난다 (편집은 안 막힌다)', async () => {
    const doc = await newProject();
    renderCover.mockRejectedValueOnce(new Error('크로미움 없음'));
    const r = await ask(doc.id, { timeMs: 3333 });
    const job = await waitJob(r.body.jobId as string);
    expect(job.status).toBe('error');
    expect(job.error).toContain('크로미움 없음');
  });
});
