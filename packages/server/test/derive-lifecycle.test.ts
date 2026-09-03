// 파생 미디어 수명 관리 (FIX-2) — 회수(prune) · 버려진 잡 취소 · 영구 실패 기억.
// deriveMedia 목이 mediaDir 에 진짜 파일을 만들기 때문에 "디스크에서 사라졌는지"를 실제로 확인한다.
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sourceKey, type ClipSource, type ProjectDoc } from '@kitkat/schema';

/** 목 안팎에서 함께 쓰는 상태 — vi.mock 팩토리는 호이스팅되므로 vi.hoisted 로 만든다. */
const h = vi.hoisted(() => ({
  /** key → 이 promise 가 풀릴 때까지 deriveMedia 가 멈춘다 (running 상태를 붙잡아 두기 위해).
   *  키별로 걸어야 앞 테스트가 남긴 잡이 다음 테스트의 문에 걸려 큐가 굳지 않는다. */
  gates: new Map<string, Promise<void>>(),
  /** 실제로 구운 sourceKey 순서 — 취소된 잡은 여기에 안 남는다. */
  baked: [] as string[],
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
  // 진짜 파일을 굽는다 — 회수가 디스크까지 지우는지 확인해야 하므로.
  deriveMedia: vi.fn(async (_abs: string, mediaDir: string, assetId: string, key: string) => {
    h.baked.push(key);
    const gate = h.gates.get(key);
    if (gate) await gate;
    const p = await import('node:path');
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(p.join(mediaDir, 'derived'), { recursive: true });
    const src = `derived/${assetId}.${key}.mp4`;
    const proxySrc = `derived/${assetId}.${key}.p.mp4`;
    await fsp.writeFile(p.join(mediaDir, src), 'baked');
    await fsp.writeFile(p.join(mediaDir, proxySrc), 'baked-proxy');
    return { src, proxySrc };
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

import { deriveMedia } from '@kitkat/media';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let tmpRoot: string;
let mediaRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-derive-life-'));
  mediaRoot = path.join(tmpRoot, 'media');
  app = await buildApp({ dataDir: path.join(tmpRoot, 'data', 'projects'), mediaDir: mediaRoot });
  await app.ready();
});

afterAll(async () => {
  h.gates.clear();
  await app.close();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  h.baked.length = 0;
  vi.mocked(deriveMedia).mockClear();
});

/** 열어 둔 문을 전부 풀어 다음 테스트의 잡 큐가 굳지 않게 한다. */
afterEach(() => {
  for (const open of openGates) open();
  openGates.length = 0;
  h.gates.clear();
});

const openGates: (() => void)[] = [];

/** 이 key 의 deriveMedia 를 멈춰 세우고, 푸는 함수를 돌려준다. */
function gate(key: string): () => void {
  let release!: () => void;
  h.gates.set(
    key,
    new Promise<void>((r) => {
      release = r;
    }),
  );
  openGates.push(release);
  return release;
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

let seq = 0;

async function createProject(name: string): Promise<{ doc: ProjectDoc; vt: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
  expect(res.statusCode).toBe(200);
  const doc = res.json().doc as ProjectDoc;
  return { doc, vt: doc.tracks.find((t) => t.kind === 'video')!.id };
}

async function send(projectId: string, commands: unknown[]): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/commands`,
    payload: { commands },
  });
  expect(res.statusCode).toBe(200);
}

async function getDoc(id: string): Promise<ProjectDoc> {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json().doc as ProjectDoc;
}

async function derivedKeys(projectId: string, assetId: string): Promise<string[]> {
  return Object.keys((await getDoc(projectId)).assets[assetId]?.derived ?? {}).sort();
}

async function waitFor(cond: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`조건이 제한 시간 안에 충족되지 않음: ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 이 클립 모양에서 나오는 sourceKey (서버와 같은 함수). */
function keyOf(source: ClipSource): string {
  return sourceKey({
    id: 'k', kind: 'video', assetId: 'a', start: 0, duration: 1000,
    in: 0, out: 1000, speed: 1, volume: 1, source,
  })!;
}

function videoAsset(id: string) {
  return { id, kind: 'video', src: `assets/${id}.mp4`, name: `${id}.mp4`, duration: 10000 };
}

function videoClip(id: string, assetId: string, source?: ClipSource) {
  return {
    id, kind: 'video', assetId, start: 0, duration: 4000,
    in: 0, out: 4000, speed: 1, volume: 1, ...(source ? { source } : {}),
  };
}

/** 프로젝트 하나 + 에셋 하나 + source 붙은 클립 하나를 만들고 첫 파생이 끝날 때까지 기다린다. */
async function withBakedClip(source: ClipSource) {
  const n = ++seq;
  const assetId = `dl${n}`;
  const { doc, vt } = await createProject(`파생수명${n}`);
  await send(doc.id, [
    { type: 'addAsset', asset: videoAsset(assetId) },
    { type: 'addClip', trackId: vt, clip: videoClip('c1', assetId, source) },
  ]);
  const key = keyOf(source);
  await waitFor(async () => (await derivedKeys(doc.id, assetId)).includes(key), `첫 파생(${key})`);
  return { projectId: doc.id, assetId, key, vt };
}

function abs(rel: string): string {
  return path.join(mediaRoot, rel);
}

/** WS 로 브로드캐스트를 모은다. */
type Collected = {
  jobs: { id: string; type: string; status: string; key?: string; result?: Record<string, unknown> }[];
  commands: { revision: number; commands: { type: string; patch?: Record<string, unknown> }[] }[];
  close(): void;
};
async function collect(projectId: string): Promise<Collected> {
  const jobs: Collected['jobs'] = [];
  const commands: Collected['commands'] = [];
  const ws = await app.injectWS(`/ws/projects/${projectId}`, {}, {
    onInit: (sock: { on(ev: string, cb: (data: Buffer) => void): void }) => {
      sock.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'job') jobs.push(msg.job as Collected['jobs'][number]);
        if (msg.type === 'commands') commands.push(msg as unknown as Collected['commands'][number]);
      });
    },
  } as never);
  return { jobs, commands, close: () => ws.terminate() };
}

// ── 버그 A: 회수 ──────────────────────────────────────────────────────────

describe('버그 A — 죽은 파생 미디어 회수', () => {
  it('클립의 source 를 바꾸면 이전 키가 문서에서 사라지고 파일도 디스크에서 사라진다', async () => {
    const s1: ClipSource = { stabilize: { smoothing: 10 } };
    const { projectId, assetId, key } = await withBakedClip(s1);

    const doc = await getDoc(projectId);
    const old = doc.assets[assetId]!.derived![key]!;
    expect(existsSync(abs(old.src))).toBe(true);
    expect(existsSync(abs(old.proxySrc!))).toBe(true);

    const s2: ClipSource = { stabilize: { smoothing: 20 } };
    await send(projectId, [{ type: 'updateClip', clipId: 'c1', patch: { source: s2 } }]);

    await waitFor(async () => !(await derivedKeys(projectId, assetId)).includes(key), '옛 키 회수');
    await waitFor(async () => !existsSync(abs(old.src)), '옛 파일 삭제');
    // 회수는 파일을 하나씩 지운다 — src 가 사라졌다고 proxySrc 도 이미 사라진 것은 아니다
    await waitFor(async () => !existsSync(abs(old.proxySrc!)), '옛 프록시 삭제');

    // 새 키는 정상적으로 구워진다
    await waitFor(async () => (await derivedKeys(projectId, assetId)).includes(keyOf(s2)), '새 파생');
    expect(existsSync(abs(`derived/${assetId}.${keyOf(s2)}.mp4`))).toBe(true);
  });

  it('source 를 통째로 지우면 파생 키가 하나도 남지 않는다', async () => {
    const { projectId, assetId, key } = await withBakedClip({ denoise: { amount: 0.4 } });
    const old = (await getDoc(projectId)).assets[assetId]!.derived![key]!;

    await send(projectId, [{ type: 'updateClip', clipId: 'c1', patch: { source: null } }]);

    await waitFor(async () => (await derivedKeys(projectId, assetId)).length === 0, '전부 회수');
    await waitFor(async () => !existsSync(abs(old.src)), '파일 삭제');
  });

  it('클립을 지우면 그 클립이 쓰던 파생도 회수된다', async () => {
    const { projectId, assetId, key } = await withBakedClip({ denoise: { amount: 0.6 } });
    const old = (await getDoc(projectId)).assets[assetId]!.derived![key]!;

    await send(projectId, [{ type: 'removeClip', clipId: 'c1' }]);

    await waitFor(async () => (await derivedKeys(projectId, assetId)).length === 0, '클립 삭제 후 회수');
    await waitFor(async () => !existsSync(abs(old.src)), '파일 삭제');
  });

  it('아직 쓰이는 키는 회수하지 않는다 — 같은 에셋의 다른 클립 것도 남긴다', async () => {
    const sA: ClipSource = { denoise: { amount: 0.2 } };
    const sB: ClipSource = { denoise: { amount: 0.3 } };
    const { projectId, assetId, vt, key: kA } = await withBakedClip(sA);
    const kB = keyOf(sB);

    await send(projectId, [
      { type: 'addClip', trackId: vt, clip: { ...videoClip('c2', assetId, sB), start: 5000 } },
    ]);
    await waitFor(async () => (await derivedKeys(projectId, assetId)).includes(kB), 'c2 파생');

    // c1 만 바꾼다 → kA 만 죽고 kB 는 살아 있어야 한다
    const sC: ClipSource = { denoise: { amount: 0.9 } };
    await send(projectId, [{ type: 'updateClip', clipId: 'c1', patch: { source: sC } }]);

    await waitFor(async () => {
      const keys = await derivedKeys(projectId, assetId);
      return !keys.includes(kA) && keys.includes(keyOf(sC));
    }, 'kA 회수 · kC 생성');
    expect(await derivedKeys(projectId, assetId)).toContain(kB);
    expect(existsSync(abs(`derived/${assetId}.${kB}.mp4`))).toBe(true);
  });

  it('회수는 updateAsset 명령으로만 문서를 고치고 revision 을 1 씩만 올린다', async () => {
    const s1: ClipSource = { stabilize: { smoothing: 33 } };
    const { projectId, assetId, key } = await withBakedClip(s1);
    const before = (await getDoc(projectId)).revision;
    const seen = await collect(projectId);
    try {
      await send(projectId, [{ type: 'updateClip', clipId: 'c1', patch: { source: null } }]);
      await waitFor(async () => (await derivedKeys(projectId, assetId)).length === 0, '회수');

      const prune = seen.commands.find((m) =>
        m.commands.some((c) => c.type === 'updateAsset' && c.patch?.['derived'] !== undefined),
      );
      expect(prune).toBeDefined();
      expect(prune!.commands.every((c) => c.type === 'updateAsset')).toBe(true);
      // 브로드캐스트 revision 은 연속이어야 한다 (UI 가 revision+1 만 이어붙인다)
      const revs = seen.commands.map((m) => m.revision);
      for (let i = 1; i < revs.length; i++) expect(revs[i]).toBe(revs[i - 1]! + 1);
      expect(revs[0]).toBe(before + 1);
      expect(key).toBeTruthy();
    } finally {
      seen.close();
    }
  });

  it('아직 running 인 키는 회수되지 않는다', async () => {
    const s1: ClipSource = { stabilize: { smoothing: 41 } };
    const k1 = keyOf(s1);
    const release = gate(k1);

    const n = ++seq;
    const assetId = `dl${n}`;
    const { doc, vt } = await createProject(`러닝보호${n}`);
    try {
      await send(doc.id, [
        { type: 'addAsset', asset: videoAsset(assetId) },
        { type: 'addClip', trackId: vt, clip: videoClip('c1', assetId, s1) },
      ]);
      // 잡이 deriveMedia 안에서 멈춰 있다 = running
      await waitFor(async () => h.baked.includes(k1), 'k1 잡 시작');

      // 이 키의 파생이 이미 문서에 있는 상태를 만든다 (잡은 아직 running)
      await mkdir(abs('derived'), { recursive: true });
      await writeFile(abs(`derived/${assetId}.${k1}.mp4`), 'inflight');
      await send(doc.id, [
        {
          type: 'updateAsset',
          assetId,
          patch: { derived: { [k1]: { src: `derived/${assetId}.${k1}.mp4` } } },
        },
      ]);

      // 참조를 끊는다 — 그래도 running 인 동안은 지우면 안 된다 (곧 그 잡이 다시 써넣는다)
      await send(doc.id, [
        { type: 'updateClip', clipId: 'c1', patch: { source: { stabilize: { smoothing: 42 } } } },
      ]);
      await sleep(200);

      expect(await derivedKeys(doc.id, assetId)).toContain(k1);
      expect(existsSync(abs(`derived/${assetId}.${k1}.mp4`))).toBe(true);
    } finally {
      release();
    }
  }, 20000);
});

// ── 버그 A-2: 버려진 잡 취소 ──────────────────────────────────────────────

describe('버그 A-2 — 참조가 사라진 대기 중 derive 잡 취소', () => {
  it('큐에서 기다리는 사이 참조가 사라진 키는 굽지 않고 done + cancelled 로 끝난다', async () => {
    const s1: ClipSource = { stabilize: { smoothing: 51 } };
    const s2: ClipSource = { stabilize: { smoothing: 52 } }; // 버려질 값
    const s3: ClipSource = { stabilize: { smoothing: 53 } };
    const [k1, k2, k3] = [keyOf(s1), keyOf(s2), keyOf(s3)];
    const release = gate(k1!);

    const n = ++seq;
    const assetId = `dl${n}`;
    const { doc, vt } = await createProject(`취소${n}`);
    const seen = await collect(doc.id);
    try {
      await send(doc.id, [
        { type: 'addAsset', asset: videoAsset(assetId) },
        { type: 'addClip', trackId: vt, clip: videoClip('c1', assetId, s1) },
      ]);
      await waitFor(async () => h.baked.includes(k1), 'k1 실행 중');

      // k1 이 굽는 동안 값을 두 번 더 바꾼다 → k2 는 큐에서 기다리다 버려진다
      await send(doc.id, [{ type: 'updateClip', clipId: 'c1', patch: { source: s2 } }]);
      await send(doc.id, [{ type: 'updateClip', clipId: 'c1', patch: { source: s3 } }]);

      release();
      await waitFor(async () => (await derivedKeys(doc.id, assetId)).includes(k3), 'k3 파생');
      await sleep(100);

      expect(h.baked).toContain(k1);
      expect(h.baked).toContain(k3);
      expect(h.baked).not.toContain(k2); // 버려진 값은 아예 굽지 않았다
      const cancelled = seen.jobs.filter((j) => j.type === 'derive' && j.result?.['cancelled'] === true);
      expect(cancelled.length).toBeGreaterThanOrEqual(1);
      expect(cancelled.every((j) => j.status === 'done')).toBe(true); // error 가 아니라 조용히 done
      expect(seen.jobs.some((j) => j.type === 'derive' && j.status === 'error')).toBe(false);
    } finally {
      release();
      seen.close();
    }
  }, 20000);

  it('취소된 잡은 큐에서 빠져 실행 순서를 기다리지 않는다 (해제 전에 이미 done)', async () => {
    const s1: ClipSource = { stabilize: { smoothing: 61 } };
    const s2: ClipSource = { stabilize: { smoothing: 62 } }; // 버려질 값
    const s3: ClipSource = { stabilize: { smoothing: 63 } };
    const k1 = keyOf(s1);
    const release = gate(k1);

    const n = ++seq;
    const assetId = `dl${n}`;
    const { doc, vt } = await createProject(`큐제거${n}`);
    const seen = await collect(doc.id);
    try {
      await send(doc.id, [
        { type: 'addAsset', asset: videoAsset(assetId) },
        { type: 'addClip', trackId: vt, clip: videoClip('c1', assetId, s1) },
      ]);
      await waitFor(async () => h.baked.includes(k1), 'k1 실행 중');

      await send(doc.id, [{ type: 'updateClip', clipId: 'c1', patch: { source: s2 } }]);
      await send(doc.id, [{ type: 'updateClip', clipId: 'c1', patch: { source: s3 } }]);

      // k1 이 아직 굽는 중인데도(= 큐가 안 돌고 있는데도) k2 잡은 이미 취소돼 있어야 한다
      await waitFor(
        async () => seen.jobs.some((j) => j.type === 'derive' && j.result?.['cancelled'] === true),
        '대기 잡 취소',
      );
      const cancelled = seen.jobs.find((j) => j.result?.['cancelled'] === true)!;
      expect(cancelled.status).toBe('done');
      expect(cancelled.key).toBe(`${assetId}:${keyOf(s2)}`);
      expect(h.baked).not.toContain(keyOf(s2));
    } finally {
      release();
      seen.close();
    }
  }, 20000);
});

// ── 버그 B: 영구 실패 기억 ────────────────────────────────────────────────

describe('버그 B — 실패한 derive 키는 다시 등록되지 않는다', () => {
  it('LUT 이 없어 실패한 뒤에는 어떤 배치(빈 배치·클립 이동 포함)도 잡을 다시 만들지 않는다', async () => {
    const n = ++seq;
    const assetId = `dl${n}`;
    const { doc, vt } = await createProject(`실패기억${n}`);
    const seen = await collect(doc.id);
    try {
      await send(doc.id, [
        { type: 'addAsset', asset: videoAsset(assetId) },
        {
          type: 'addClip',
          trackId: vt,
          clip: videoClip('c1', assetId, { lut: { assetId: '없는LUT', intensity: 1 } }),
        },
      ]);
      await waitFor(
        async () => seen.jobs.some((j) => j.type === 'derive' && j.status === 'error'),
        'derive 실패',
      );
      const firstJobId = seen.jobs.find((j) => j.type === 'derive')!.id;

      // 편집을 계속한다 — 예전에는 이 배치마다 같은 잡이 하나씩 새로 생겼다
      await send(doc.id, []);
      await send(doc.id, [{ type: 'renameProject', name: '실패기억2' }]);
      await send(doc.id, [{ type: 'moveClip', clipId: 'c1', trackId: vt, start: 1000 }]);
      await send(doc.id, []);
      await sleep(150);

      const deriveIds = new Set(seen.jobs.filter((j) => j.type === 'derive').map((j) => j.id));
      expect(deriveIds.size).toBe(1);
      expect([...deriveIds][0]).toBe(firstJobId);
      // 이 에셋은 한 번도 굽지 않았다 (다른 테스트가 남긴 잡이 섞일 수 있어 assetId 로 좁힌다)
      expect(vi.mocked(deriveMedia).mock.calls.filter((c) => c[2] === assetId)).toHaveLength(0);
    } finally {
      seen.close();
    }
  });

  it('실패한 키만 막고, 같은 에셋의 다른 source 키는 정상적으로 굽는다', async () => {
    const n = ++seq;
    const assetId = `dl${n}`;
    const { doc, vt } = await createProject(`실패격리${n}`);
    const seen = await collect(doc.id);
    try {
      await send(doc.id, [
        { type: 'addAsset', asset: videoAsset(assetId) },
        {
          type: 'addClip',
          trackId: vt,
          clip: videoClip('c1', assetId, { lut: { assetId: '또없는LUT', intensity: 1 } }),
        },
      ]);
      await waitFor(
        async () => seen.jobs.some((j) => j.type === 'derive' && j.status === 'error'),
        'derive 실패',
      );

      const ok: ClipSource = { denoise: { amount: 0.7 } };
      await send(doc.id, [{ type: 'updateClip', clipId: 'c1', patch: { source: ok } }]);
      await waitFor(async () => (await derivedKeys(doc.id, assetId)).includes(keyOf(ok)), '정상 파생');
      expect(h.baked).toEqual([keyOf(ok)]);
    } finally {
      seen.close();
    }
  });
});

// ── 버그 C: LUT 참조 보호 (서버 경로) ─────────────────────────────────────

describe('버그 C — removeAsset 이 LUT 참조를 막는다', () => {
  it('LUT 을 쓰는 클립이 있으면 400 ASSET_IN_USE, 참조를 끊으면 지워진다', async () => {
    const n = ++seq;
    const assetId = `dl${n}`;
    const { doc, vt } = await createProject(`LUT보호${n}`);
    await send(doc.id, [
      { type: 'addAsset', asset: videoAsset(assetId) },
      { type: 'addAsset', asset: { id: `lut${n}`, kind: 'lut', src: `assets/lut${n}.cube`, name: 'l.cube' } },
      {
        type: 'addClip',
        trackId: vt,
        clip: videoClip('c1', assetId, { lut: { assetId: `lut${n}`, intensity: 0.5 } }),
      },
    ]);

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'removeAsset', assetId: `lut${n}` }] },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toContain('ASSET_IN_USE');
    expect(blocked.json().error).toContain('c1');
    expect((await getDoc(doc.id)).assets[`lut${n}`]).toBeDefined();

    await send(doc.id, [{ type: 'updateClip', clipId: 'c1', patch: { source: null } }]);
    await send(doc.id, [{ type: 'removeAsset', assetId: `lut${n}` }]);
    expect((await getDoc(doc.id)).assets[`lut${n}`]).toBeUndefined();
  });
});
