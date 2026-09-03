// F4 — 측정 라우트(POST /api/projects/:id/clips/:clipId/match) 의 배선·검증·재측정 판정.
// measureChannelHistograms 를 목으로 잡아 «어떤 파일·어떤 시각·어떤 영역» 을 쟀는지 본다.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sourceKey, type ClipSource, type ProjectDoc, type VideoClip } from '@kitkat/schema';

const h = vi.hoisted(() => ({
  /** measureChannelHistograms 가 받은 인자 기록. */
  measured: [] as {
    src: string;
    atMs: number[];
    region?: { x: number; y: number; w: number; h: number };
    stabilize?: { smoothing: number };
  }[],
  /** 파일 경로 → 채널 μ(0..255). 히스토그램을 그 값 하나로 채워 만든다. */
  means: new Map<string, [number, number, number]>(),
  /** 파일 경로 → σ(0..255). 기본 20. 0 이면 단색 화면이 된다. */
  stds: new Map<string, number>(),
  deriveCalls: [] as { key: string; spec: Record<string, unknown> }[],
}));

vi.mock('@kitkat/media', async () => {
  const real = await vi.importActual<typeof import('@kitkat/media')>('@kitkat/media');
  return {
    ...real,
    probeAsset: vi.fn(async () => ({ kind: 'video', duration: 30000, width: 1080, height: 1920, hasAudio: true })),
    makeProxy: vi.fn(async (_a: string, _m: string, id: string) => `proxies/${id}.mp4`),
    makeWaveform: vi.fn(async (_a: string, _m: string, id: string) => `waveforms/${id}.json`),
    makeThumb: vi.fn(async (_a: string, _m: string, id: string) => `thumbs/${id}.jpg`),
    detectEncoder: vi.fn(async () => 'libx264'),
    measureChannelHistograms: vi.fn(
      async (
        src: string,
        opts: {
          atMs: number[];
          region?: { x: number; y: number; w: number; h: number };
          stabilize?: { smoothing: number };
        },
      ) => {
        h.measured.push({
          src: src.replaceAll('\\', '/'),
          atMs: opts.atMs,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.stabilize ? { stabilize: opts.stabilize } : {}),
        });
        // 파일마다 정해 둔 평균값을 가진 «가짜 히스토그램» — 두 값(μ±20)에 반씩 몰아
        // σ 가 20/255 로 고정되게 만든다.
        const key = [...h.means.keys()].find((k) => src.replaceAll('\\', '/').endsWith(k));
        const mean = h.means.get(key ?? '') ?? [128, 128, 128];
        const sd = h.stds.get(key ?? '') ?? 20;
        const hist = mean.map((m) => {
          const a = new Uint32Array(256);
          const lo = Math.max(0, Math.min(255, Math.round(m - sd)));
          const hi = Math.max(0, Math.min(255, Math.round(m + sd)));
          a[lo] = 1000;
          a[hi] = (a[hi] ?? 0) + 1000;
          return a;
        }) as [Uint32Array, Uint32Array, Uint32Array];
        return { hist, usedMs: opts.atMs, pixels: 2000 };
      },
    ),
    deriveMedia: vi.fn(async (_abs: string, mediaDir: string, assetId: string, key: string, spec: Record<string, unknown>) => {
      h.deriveCalls.push({ key, spec: structuredClone(spec) });
      const fsp = await import('node:fs/promises');
      const p = await import('node:path');
      await fsp.mkdir(p.join(mediaDir, 'derived'), { recursive: true });
      const src = `derived/${assetId}.${key}.mp4`;
      await fsp.writeFile(p.join(mediaDir, src), 'baked');
      return { src };
    }),
  };
});

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
let seq = 0;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-match-'));
  await mkdir(path.join(tmpRoot, 'media'), { recursive: true });
  app = await buildApp({ dataDir: path.join(tmpRoot, 'data', 'projects'), mediaDir: path.join(tmpRoot, 'media') });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  h.measured.length = 0;
  h.deriveCalls.length = 0;
  h.means.clear();
  h.stds.clear();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
});

type Ctx = { projectId: string; refId: string; tgtId: string; refAsset: string; tgtAsset: string };

/** 프로젝트 + 비디오 클립 2개(기준·대상). */
async function setup(opts?: { refSource?: ClipSource; tgtSource?: ClipSource }): Promise<Ctx> {
  const n = ++seq;
  const refAsset = `mref${n}`;
  const tgtAsset = `mtgt${n}`;
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: `match-${n}` } });
  const doc = res.json().doc as ProjectDoc;
  const vt = doc.tracks.find((t) => t.kind === 'video')!.id;
  const mkAsset = (id: string) => ({
    type: 'addAsset' as const,
    asset: { id, kind: 'video' as const, src: `assets/${id}.mp4`, name: `${id}.mp4`, duration: 30000, width: 1080, height: 1920 },
  });
  const send = await app.inject({
    method: 'POST',
    url: `/api/projects/${doc.id}/commands`,
    payload: {
      commands: [
        mkAsset(refAsset),
        mkAsset(tgtAsset),
        {
          type: 'addClip', trackId: vt,
          clip: {
            id: `ref${n}`, kind: 'video', assetId: refAsset, start: 0, duration: 2000,
            in: 1000, out: 3000, speed: 1, volume: 1,
            ...(opts?.refSource ? { source: opts.refSource } : {}),
          },
        },
        {
          type: 'addClip', trackId: vt,
          clip: {
            id: `tgt${n}`, kind: 'video', assetId: tgtAsset, start: 2000, duration: 4000,
            in: 0, out: 4000, speed: 1, volume: 1,
            ...(opts?.tgtSource ? { source: opts.tgtSource } : {}),
          },
        },
      ],
    },
  });
  expect(send.statusCode).toBe(200);
  return { projectId: doc.id, refId: `ref${n}`, tgtId: `tgt${n}`, refAsset, tgtAsset };
}

async function getDoc(projectId: string): Promise<ProjectDoc> {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}` });
  return res.json().doc as ProjectDoc;
}

function findVideoClip(doc: ProjectDoc, clipId: string): VideoClip {
  for (const t of doc.tracks) for (const c of t.clips) if (c.id === clipId && c.kind === 'video') return c;
  throw new Error(`클립 없음: ${clipId}`);
}

async function waitFor(cond: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`조건이 제한 시간 안에 충족되지 않음: ${label}`);
}

const post = (ctx: Ctx, body: Record<string, unknown>, clipId?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${ctx.projectId}/clips/${clipId ?? ctx.tgtId}/match`,
    payload: body,
  });

describe('요청 검증 — 잡을 등록하기 전에 막는다', () => {
  it('자기 자신을 기준으로 삼으면 400', async () => {
    const ctx = await setup();
    const res = await post(ctx, { refClipId: ctx.tgtId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('자기 자신');
  });

  it('순환(A→B→A)이면 400', async () => {
    const ctx = await setup();
    // 기준 클립이 이미 대상 클립을 기준으로 삼고 있게 만든다
    await app.inject({
      method: 'POST',
      url: `/api/projects/${ctx.projectId}/commands`,
      payload: {
        commands: [{ type: 'updateClip', clipId: ctx.refId, patch: { source: { matchTo: { clipId: ctx.tgtId, strength: 1 } } } }],
      },
    });
    const res = await post(ctx, { refClipId: ctx.refId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('순환');
  });

  it('strength 가 0..1 밖이면 400', async () => {
    const ctx = await setup();
    expect((await post(ctx, { refClipId: ctx.refId, strength: 1.5 })).statusCode).toBe(400);
    expect((await post(ctx, { refClipId: ctx.refId, strength: -0.1 })).statusCode).toBe(400);
  });

  it('영역의 w·h 가 0이면 400 — 0픽셀은 잴 수 없다', async () => {
    const ctx = await setup();
    const res = await post(ctx, { refClipId: ctx.refId, region: { x: 0.1, y: 0.1, w: 0, h: 0.5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('0픽셀');
  });

  it('없는 기준 클립이면 404', async () => {
    const ctx = await setup();
    expect((await post(ctx, { refClipId: 'nope' })).statusCode).toBe(404);
  });
});

describe('측정 잡', () => {
  it('두 클립을 재서 levels 를 문서에 넣고, 그 결과로 파생이 굽힌다', async () => {
    const ctx = await setup();
    h.means.set(`assets/${ctx.refAsset}.mp4`, [140, 130, 120]);
    h.means.set(`assets/${ctx.tgtAsset}.mp4`, [100, 100, 100]);

    const res = await post(ctx, { refClipId: ctx.refId, strength: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().measured).toBe(true);

    await waitFor(async () => findVideoClip(await getDoc(ctx.projectId), ctx.tgtId).source?.matchTo?.levels != null, 'levels 기록');
    const clip = findVideoClip(await getDoc(ctx.projectId), ctx.tgtId);
    const levels = clip.source!.matchTo!.levels!;

    expect(levels.refSourceKey).toBe('raw');
    expect(levels.ref[0]!.mean * 255).toBeCloseTo(140, 0);
    expect(levels.target[0]!.mean * 255).toBeCloseTo(100, 0);
    // 기준 클립은 in..out(1000..3000), 대상은 0..4000 — 각자의 구간에서 5장씩
    expect(h.measured).toHaveLength(2);
    expect(h.measured[0]!.src.endsWith(`assets/${ctx.refAsset}.mp4`)).toBe(true);
    expect(h.measured[0]!.atMs).toEqual([1100, 1550, 2000, 2450, 2900]);
    expect(h.measured[1]!.atMs).toEqual([200, 1100, 2000, 2900, 3800]);
    expect(levels.sampledAtMs).toEqual([200, 1100, 2000, 2900, 3800]);

    // levels 가 들어가면 sourceKey 가 생기고 파생 잡이 돈다
    await waitFor(() => h.deriveCalls.length > 0, '파생 잡');
    const spec = h.deriveCalls[0]!.spec as { matchTo?: { strength: number } };
    expect(spec.matchTo?.strength).toBe(1);
  });

  it('영역이 없으면 클립의 crop 을 쓴다', async () => {
    const ctx = await setup();
    await app.inject({
      method: 'POST',
      url: `/api/projects/${ctx.projectId}/commands`,
      payload: {
        commands: [
          { type: 'updateClip', clipId: ctx.tgtId, patch: { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } } },
          { type: 'updateClip', clipId: ctx.refId, patch: { crop: { x: 0, y: 0, w: 0.4, h: 0.4 } } },
        ],
      },
    });
    await post(ctx, { refClipId: ctx.refId });
    await waitFor(() => h.measured.length === 2, '측정 2회');
    expect(h.measured[0]!.region).toEqual({ x: 0, y: 0, w: 0.4, h: 0.4 });
    expect(h.measured[1]!.region).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
  });

  it('region·refRegion 을 주면 crop 보다 그것이 우선이다', async () => {
    const ctx = await setup();
    const region = { x: 0.5, y: 0.2, w: 0.16, h: 0.19 };
    const refRegion = { x: 0.31, y: 0.12, w: 0.18, h: 0.22 };
    await post(ctx, { refClipId: ctx.refId, region, refRegion });
    await waitFor(() => h.measured.length === 2, '측정 2회');
    expect(h.measured[0]!.region).toEqual(refRegion);
    expect(h.measured[1]!.region).toEqual(region);
  });

  it('대상에 손떨림 보정이 걸려 있으면 «보정 후» 프레임을 잰다', async () => {
    // 실측(media/test/measure.test.ts): 보정 전후로 채널 μ 가 1/255 넘게 어긋난다.
    // S3 의 필터 순서가 stabilize → matchTo 라 색 맞추기는 보정된 그림 위에서 계산된다.
    const ctx = await setup({ tgtSource: { stabilize: { smoothing: 14 } } });
    await post(ctx, { refClipId: ctx.refId });
    await waitFor(() => h.measured.length === 2, '측정 2회');
    expect(h.measured[0]!.stabilize).toBeUndefined(); // 기준 클립은 보정이 없다
    expect(h.measured[1]!.stabilize).toEqual({ smoothing: 14 });
  });

  it('기준 클립에 파생이 있으면 «파생 파일» 을 잰다 (사용자가 보는 색이 기준)', async () => {
    const refSource: ClipSource = { hsl: [{ id: 's1', family: 'reds', cyan: 0.06, magenta: -0.05, yellow: 0, black: 0 }] };
    const ctx = await setup({ refSource });
    const key = sourceKey({
      id: 'x', kind: 'video', assetId: ctx.refAsset, start: 0, duration: 1000,
      in: 0, out: 1000, speed: 1, volume: 1, source: refSource,
    })!;
    // 기준 클립의 파생이 다 구워질 때까지 기다린다
    await waitFor(async () => (await getDoc(ctx.projectId)).assets[ctx.refAsset]?.derived?.[key] != null, '기준 파생');
    h.measured.length = 0;

    await post(ctx, { refClipId: ctx.refId });
    await waitFor(() => h.measured.length === 2, '측정 2회');
    expect(h.measured[0]!.src).toContain(`derived/${ctx.refAsset}.${key}.mp4`);
    await waitFor(
      async () => findVideoClip(await getDoc(ctx.projectId), ctx.tgtId).source?.matchTo?.levels != null,
      'levels 기록',
    );
    const clip = findVideoClip(await getDoc(ctx.projectId), ctx.tgtId);
    expect(clip.source!.matchTo!.levels!.refSourceKey).toBe(key);
  });
});

describe('재측정 판정', () => {
  it('같은 요청을 두 번 하면 두 번째는 재지 않는다', async () => {
    const ctx = await setup();
    await post(ctx, { refClipId: ctx.refId, strength: 1 });
    await waitFor(async () => findVideoClip(await getDoc(ctx.projectId), ctx.tgtId).source?.matchTo?.levels != null, 'levels');
    h.measured.length = 0;

    const again = await post(ctx, { refClipId: ctx.refId, strength: 1 });
    expect(again.json()).toEqual({ measured: false, updated: false });
    expect(h.measured).toHaveLength(0);
  });

  it('강도만 바뀌면 재지 않고 문서만 고친다 (통계는 강도와 무관하다)', async () => {
    const ctx = await setup();
    await post(ctx, { refClipId: ctx.refId, strength: 1 });
    await waitFor(async () => findVideoClip(await getDoc(ctx.projectId), ctx.tgtId).source?.matchTo?.levels != null, 'levels');
    h.measured.length = 0;

    const res = await post(ctx, { refClipId: ctx.refId, strength: 0.5 });
    expect(res.json()).toEqual({ measured: false, updated: true });
    expect(h.measured).toHaveLength(0);
    const clip = findVideoClip(await getDoc(ctx.projectId), ctx.tgtId);
    expect(clip.source!.matchTo!.strength).toBe(0.5);
    expect(clip.source!.matchTo!.levels).toBeTruthy();
  });

  it('영역이 바뀌면 다시 잰다', async () => {
    const ctx = await setup();
    await post(ctx, { refClipId: ctx.refId });
    await waitFor(async () => findVideoClip(await getDoc(ctx.projectId), ctx.tgtId).source?.matchTo?.levels != null, 'levels');
    h.measured.length = 0;
    const res = await post(ctx, { refClipId: ctx.refId, region: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    expect(res.json().measured).toBe(true);
    await waitFor(() => h.measured.length === 2, '재측정');
  });

  it('기준 컷의 파생 설정이 바뀌면(refSourceKey 불일치) 다시 잰다', async () => {
    const ctx = await setup();
    await post(ctx, { refClipId: ctx.refId });
    await waitFor(async () => findVideoClip(await getDoc(ctx.projectId), ctx.tgtId).source?.matchTo?.levels != null, 'levels');
    expect(findVideoClip(await getDoc(ctx.projectId), ctx.tgtId).source!.matchTo!.levels!.refSourceKey).toBe('raw');
    h.measured.length = 0;

    // 기준 클립에 색보정을 걸고 파생이 구워질 때까지 기다린다
    const refSource: ClipSource = { hsl: [{ id: 's2', family: 'blues', cyan: 0.1, magenta: 0.04, yellow: 0, black: 0.05 }] };
    await app.inject({
      method: 'POST',
      url: `/api/projects/${ctx.projectId}/commands`,
      payload: { commands: [{ type: 'updateClip', clipId: ctx.refId, patch: { source: refSource } }] },
    });
    const key = sourceKey({
      id: 'x', kind: 'video', assetId: ctx.refAsset, start: 0, duration: 1000,
      in: 0, out: 1000, speed: 1, volume: 1, source: refSource,
    })!;
    await waitFor(async () => (await getDoc(ctx.projectId)).assets[ctx.refAsset]?.derived?.[key] != null, '기준 파생');
    h.measured.length = 0;

    const res = await post(ctx, { refClipId: ctx.refId });
    expect(res.json().measured).toBe(true);
    await waitFor(() => h.measured.length === 2, '재측정');
    await waitFor(
      async () => findVideoClip(await getDoc(ctx.projectId), ctx.tgtId).source!.matchTo!.levels!.refSourceKey === key,
      'refSourceKey 갱신',
    );
  });
});

describe('표현 불가', () => {
  it('colorlevels 로 못 담는 조합이면 잡이 실패하고 가능한 강도를 알려준다 — 문서는 안 건드린다', async () => {
    const ctx = await setup();
    // 기준 컷이 «단색»(σ=0)이면 강도 1의 사상은 상수함수라 직선으로 표현할 수 없다.
    // (고친 역산은 계획 04 가 걱정한 「대비가 2배 넘음」은 전부 표현한다 — 남는 것은 이런 퇴화뿐이다.)
    h.means.set(`assets/${ctx.refAsset}.mp4`, [120, 120, 120]);
    h.stds.set(`assets/${ctx.refAsset}.mp4`, 0);
    h.means.set(`assets/${ctx.tgtAsset}.mp4`, [200, 200, 200]);
    const res = await post(ctx, { refClipId: ctx.refId, strength: 1 });
    const jobId = res.json().jobId as string;
    await waitFor(async () => {
      const j = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
      return ['done', 'error'].includes(j.json().status);
    }, '잡 종료');
    const job = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json();
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/강도를 \d+% 이하로 낮추면/);
    // 실패했으면 levels 를 쓰지 않는다 — 「대충 비슷하게」 구운 파일이 남으면 안 된다
    const clip = findVideoClip(await getDoc(ctx.projectId), ctx.tgtId);
    expect(clip.source?.matchTo?.levels).toBeUndefined();
  });
});

describe('보고 숫자', () => {
  it('잡 결과에 «맞추기 전/후» 색차와 감소율이 담긴다', async () => {
    const ctx = await setup();
    h.means.set(`assets/${ctx.refAsset}.mp4`, [150, 140, 130]);
    h.means.set(`assets/${ctx.tgtAsset}.mp4`, [100, 100, 100]);
    const res = await post(ctx, { refClipId: ctx.refId });
    const jobId = res.json().jobId as string;
    await waitFor(async () => (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json().status === 'done', '잡 완료');
    const result = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json().result as {
      deltaBefore: number; deltaAfter: number; reduction: number; channels: { before: number; after: number }[];
    };
    // 50 + 40 + 30 = 120
    expect(result.deltaBefore).toBeCloseTo(120, 0);
    expect(result.deltaAfter).toBeLessThan(1);
    expect(result.reduction).toBeGreaterThan(0.99);
    expect(result.channels).toHaveLength(3);
  });
});
