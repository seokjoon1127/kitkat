// @kitkat/server W5(X6) 확장 테스트 — 새 라우트 6개 · 임포트 확장 · 파생 잡 스케줄러 · MOV 렌더.
// media/renderer/ai 는 전부 vi.mock (실제 ffmpeg·remotion·python 실행 없음).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProjectDoc } from '@kitkat/schema';

vi.mock('@kitkat/media', async () => ({
  // 진짜 모듈을 통째로 깔고 스텁만 덮는다 — 서버 코어가 media 에서 새로 쓰는 것(runWithJobSignal 등)이
  // 생겨도 모의가 «함수가 아닙니다» 로 죽지 않는다. isCurrentProxy 도 진짜다.
  ...(await vi.importActual<typeof import('@kitkat/media')>('@kitkat/media')),
  probeAsset: vi.fn(async (abs: string) =>
    abs.endsWith('.wav')
      ? { kind: 'audio', duration: 5000, hasAudio: true }
      : { kind: 'video', duration: 5000, width: 1080, height: 1920, hasAudio: true },
  ),
  makeProxy: vi.fn(async (_a: string, _m: string, id: string) => `proxies/${id}.mp4`),
  makeWaveform: vi.fn(async (_a: string, _m: string, id: string) => `waveforms/${id}.json`),
  makeThumb: vi.fn(async (_a: string, _m: string, id: string) => `thumbs/${id}.jpg`),
  preprocessReverse: vi.fn(async (_a: string, _m: string, id: string) => `derived/${id}.rev.mp4`),
  extractAudio: vi.fn(async (_src: string, _out: string) => {}),
  toGif: vi.fn(async () => {}),
  detectEncoder: vi.fn(async () => 'libx264'),
  deriveMedia: vi.fn(async (_abs: string, _m: string, assetId: string, key: string) => ({
    src: `derived/${assetId}.${key}.mp4`,
    proxySrc: `derived/${assetId}.${key}.p.mp4`,
  })),
  detectBeats: vi.fn(async () => [0, 500, 1000]),
  gifToWebm: vi.fn(async () => {}),
  // W8 F1·F2 — 옵션 객체 API. 어떤 엔진으로 처리했는지 돌려준다.
  upscaleVideo: vi.fn(async () => ({ engine: 'lanczos', seconds: 0 })),
  interpolateFps: vi.fn(async () => ({ engine: 'minterpolate', seconds: 0 })),
  isUpscaleAiReady: vi.fn(async () => ({ ok: true })),
  isInterpolateAiReady: vi.fn(async () => ({ ok: true })),
  UPSCALE_MODELS: ['realesrgan-x4plus', 'realesr-animevideov3', 'realesrgan-x4plus-anime'],
  INTERPOLATE_MODELS: ['rife-v4.6', 'rife-v4', 'rife-v3.1', 'rife-v3.0', 'rife-v2.4', 'rife-v2.3', 'rife-anime', 'rife-HD', 'rife-UHD'],
  parseCubeLut: vi.fn(async () => ({ size: 2 })),
}));

vi.mock('@kitkat/renderer', () => ({
  renderProject: vi.fn(async (_doc: unknown, opts: { outPath: string }) => ({
    outPath: opts.outPath,
    durationMs: 1000,
  })),
  renderCover: vi.fn(async (_doc: unknown, opts: { outPath: string }) => ({ outPath: opts.outPath })),
}));

vi.mock('@kitkat/ai', () => {
  class AiUnavailableError extends Error {}
  return {
    AiUnavailableError,
    ensurePython: vi.fn(async () => ({ ok: true })),
    transcribe: vi.fn(async () => []),
    ensureDemucs: vi.fn(async () => ({ ok: true })),
    isDemucsReady: vi.fn(async () => true),
    // 산출물 wav 2개를 실제로 만들어 둔다 — 라우트가 assets/ 로 copyFile 한다
    separateStems: vi.fn(async (_src: string, outDir: string) => {
      const p = await import('node:path');
      const { mkdir, writeFile: wf } = await import('node:fs/promises');
      const dir = p.join(outDir, 'htdemucs', 'src');
      await mkdir(dir, { recursive: true });
      await wf(p.join(dir, 'vocals.wav'), 'v');
      await wf(p.join(dir, 'no_vocals.wav'), 'a');
      return { vocals: p.join(dir, 'vocals.wav'), accompaniment: p.join(dir, 'no_vocals.wav') };
    }),
  };
});

import { deriveMedia, gifToWebm, interpolateFps, parseCubeLut, upscaleVideo } from '@kitkat/media';
import { renderCover, renderProject } from '@kitkat/renderer';
import { isDemucsReady } from '@kitkat/ai';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-server-w5-'));
  app = await buildApp({
    dataDir: path.join(tmpRoot, 'data', 'projects'),
    mediaDir: path.join(tmpRoot, 'media'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

async function createProject(name = 'W5'): Promise<ProjectDoc> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
  expect(res.statusCode).toBe(200);
  return res.json().doc as ProjectDoc;
}

async function getDoc(id: string): Promise<ProjectDoc> {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json().doc as ProjectDoc;
}

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 500; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    const job = res.json() as { status: string };
    if (job.status === 'done' || job.status === 'error') return job as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('잡이 제한 시간 안에 끝나지 않음');
}

async function waitFor(cond: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`조건이 제한 시간 안에 충족되지 않음: ${label}`);
}

/** tmpRoot 에 파일을 만들고 로컬 경로로 임포트 */
async function importAsset(projectId: string, fileName: string, content = 'dummy') {
  const srcFile = path.join(tmpRoot, fileName);
  await writeFile(srcFile, content);
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/assets`,
    payload: { path: srcFile },
  });
}

describe('GET /api/capabilities', () => {
  it('전환 51 · 효과 50 · 텍스트 템플릿 90 · 속도 램프 프리셋 6 을 노출한다', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      transitions: string[];
      effects: string[];
      textAnims: string[];
      textTemplates: { id: string }[];
      speedRampPresets: { id: string }[];
      blendModes: string[];
      version: string;
    };
    // W8 F16 에서 전환 23→51 · 효과 20→50 · 템플릿 35→90 (개수는 schema 의 catalog.test.ts 가
    // 갈래별로 못 박는다 — 여기서는 «capabilities 가 그 목록을 그대로 흘려보내는가»만 본다)
    expect(body.transitions).toHaveLength(51);
    expect(body.effects).toHaveLength(50);
    expect(body.textTemplates).toHaveLength(90);
    expect(body.speedRampPresets).toHaveLength(6);
    expect(body.transitions).toContain('glitch');
    expect(body.effects).toContain('lightLeak');
    expect(body.textAnims).toContain('wordHighlight');
    expect(body.blendModes).toContain('screen');
    expect(typeof body.version).toBe('string');
  });

  // W8 F17 — id 배열만 주면 에이전트가 「대기(아직 안 그림)」 효과를 골라 놓고도 모른다.
  it('카탈로그와 대기 목록·라우드니스 프리셋까지 같이 준다', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    const body = res.json() as {
      effects: string[];
      transitions: string[];
      effectCatalog: { id: string; name: string; group: string; impl: string; pending?: string }[];
      transitionCatalog: { id: string; name: string; group: string }[];
      pendingEffects: string[];
      effectGroups: Record<string, string>;
      transitionGroups: Record<string, string>;
      loudnessTargets: { id: string; lufs: number; official: boolean }[];
    };
    // 카탈로그가 id 배열과 «같은 것»이어야 한다 — 둘이 갈리면 에이전트가 없는 효과를 고른다
    expect(body.effectCatalog.map((e) => e.id)).toEqual(body.effects);
    expect(body.transitionCatalog.map((t) => t.id)).toEqual(body.transitions);

    // 대기 6종은 목록에 있으면서 «고르면 안 되는 것»으로 표시된다
    // 리뷰 #8 — 「대기」였던 6종(vibrance·bokeh·radialBlur·mirror·kaleidoscope·halftone)을 전부 그리게
    // 만들어 대기 목록이 비었다. 목록 «형태»는 남는다 — 앞으로 다시 생기면 에이전트가 알 수 있게.
    expect(body.pendingEffects).toEqual([]);
    for (const id of ['vibrance', 'bokeh', 'radialBlur', 'mirror', 'kaleidoscope', 'halftone']) {
      expect(body.effects, id).toContain(id);
    }
    for (const id of body.pendingEffects) {
      const def = body.effectCatalog.find((e) => e.id === id)!;
      expect(def, id).toBeTruthy();
      expect(def.pending, `${id} 에 대기 사유가 없다`).toBeTruthy();
    }
    // 대기가 아닌 것에는 사유가 없다
    for (const e of body.effectCatalog) {
      if (body.pendingEffects.includes(e.id)) continue;
      expect(e.pending, `${e.id} 가 대기가 아닌데 사유가 붙어 있다`).toBeUndefined();
    }

    // 갈래 라벨이 카탈로그의 group 을 전부 덮는다 (UI 가 빈 묶음을 안 만든다)
    for (const e of body.effectCatalog) expect(body.effectGroups[e.group], e.group).toBeTruthy();
    for (const t of body.transitionCatalog) expect(body.transitionGroups[t.group], t.group).toBeTruthy();

    // 라우드니스 — 광고 규격을 에이전트가 알 수 있어야 한다
    const ads = body.loudnessTargets.find((t) => t.id === 'google-ads')!;
    expect(ads.lufs).toBe(-24);
    expect(ads.official).toBe(true);
    expect(body.loudnessTargets.find((t) => t.id === 'youtube')!.official).toBe(false);
  });
});

describe('LUT(.cube) · GIF 임포트', () => {
  it('.cube 는 kind:"lut" 로 등록되고 후처리 잡이 붙지 않는다', async () => {
    const doc = await createProject('LUT임포트');
    const res = await importAsset(doc.id, 'my.cube', 'LUT_3D_SIZE 2\n0 0 0\n');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { asset: { id: string; kind: string; name: string }; jobId?: string };
    expect(body.asset.kind).toBe('lut');
    expect(body.asset.name).toBe('my.cube');
    expect(body.jobId).toBeUndefined(); // 후처리 잡 없음
    expect((await getDoc(doc.id)).assets[body.asset.id]!.kind).toBe('lut');
  });

  it('.cube 형식이 아니면 400, 에셋이 생기지 않는다', async () => {
    const doc = await createProject('LUT불량');
    vi.mocked(parseCubeLut).mockRejectedValueOnce(new Error('.cube 형식이 아닙니다'));
    const res = await importAsset(doc.id, 'bad.cube', 'not a lut');
    expect(res.statusCode).toBe(400);
    expect(Object.keys((await getDoc(doc.id)).assets)).toHaveLength(0);
  });

  it('.gif 는 webm 으로 구워 그 파일을 src 로 삼고 이름은 원본을 유지한다', async () => {
    const doc = await createProject('GIF임포트');
    vi.mocked(gifToWebm).mockClear();
    const res = await importAsset(doc.id, 'sticker.gif');
    expect(res.statusCode).toBe(200);
    const asset = res.json().asset as { id: string; kind: string; src: string; name: string };
    expect(asset.src).toMatch(/^assets\/.+\.webm$/);
    expect(asset.name).toBe('sticker.gif');
    expect(asset.kind).toBe('video');
    expect(vi.mocked(gifToWebm)).toHaveBeenCalledTimes(1);
  });
});

describe('비트 감지 · 보컬 분리 · 업스케일 · 프레임 보간', () => {
  it('beats → 잡 완료 시 asset.beats 가 채워진다', async () => {
    const doc = await createProject('비트');
    const imported = (await importAsset(doc.id, 'beat.mp4')).json().asset as { id: string };
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${imported.id}/beats`,
    });
    expect(res.statusCode).toBe(200);
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status).toBe('done');
    await waitFor(
      async () => (await getDoc(doc.id)).assets[imported.id]!.beats !== undefined,
      'beats 반영',
    );
    expect((await getDoc(doc.id)).assets[imported.id]!.beats).toEqual([0, 500, 1000]);
  });

  it('beats — 미존재 에셋은 404', async () => {
    const doc = await createProject('비트404');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/없는에셋/beats`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('separate → 보컬·반주 audio 에셋 2개가 추가된다', async () => {
    const doc = await createProject('보컬분리');
    const audio = (await importAsset(doc.id, 'song.wav')).json().asset as {
      id: string;
      name: string;
    };
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${audio.id}/separate`,
    });
    expect(res.statusCode).toBe(200);
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status).toBe('done');

    const now = await getDoc(doc.id);
    const stems = Object.values(now.assets).filter((a) => a.id !== audio.id);
    expect(stems).toHaveLength(2);
    expect(stems.map((a) => a.name).sort()).toEqual(
      [`${audio.name} 반주`, `${audio.name} 보컬`].sort(),
    );
    expect(stems.every((a) => a.kind === 'audio' && a.src.endsWith('.wav'))).toBe(true);
    // 새 에셋도 기존 후처리 잡(파형)을 탄다
    await waitFor(
      async () =>
        Object.values((await getDoc(doc.id)).assets)
          .filter((a) => a.id !== audio.id)
          .every((a) => a.waveformSrc !== undefined),
      '스템 파형',
    );
  });

  it('separate — Demucs 미설치면 501, 잡을 등록하지 않는다', async () => {
    const doc = await createProject('보컬501');
    const audio = (await importAsset(doc.id, 'song2.wav')).json().asset as { id: string };
    vi.mocked(isDemucsReady).mockResolvedValueOnce(false);
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${audio.id}/separate`,
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toContain('demucs');
    expect(res.json().jobId).toBeUndefined();
  });

  it('separate — 비디오 에셋은 400, 미존재 에셋은 404', async () => {
    const doc = await createProject('보컬400');
    const video = (await importAsset(doc.id, 'clip.mp4')).json().asset as { id: string };
    const bad = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${video.id}/separate`,
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/없는에셋/separate`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('upscale → 새 video 에셋 추가(기본 2배), 잘못된 scale 은 400', async () => {
    const doc = await createProject('업스케일');
    const video = (await importAsset(doc.id, 'up.mp4')).json().asset as {
      id: string;
      name: string;
    };
    vi.mocked(upscaleVideo).mockClear();

    // W8 F1 이후 scale 3 은 «허용»된다 (x4 로 올린 뒤 0.75 로 줄인다). 5 는 여전히 400.
    const bad = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${video.id}/upscale`,
      payload: { scale: 5 },
    });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${video.id}/upscale`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status).toBe('done');
    expect(vi.mocked(upscaleVideo).mock.calls[0]![2]).toMatchObject({ scale: 2, engine: 'auto' });

    const newAssetId = (job.result as { assetId: string }).assetId;
    const created = (await getDoc(doc.id)).assets[newAssetId]!;
    expect(created.kind).toBe('video');
    expect(created.name).toBe(`${video.name} 2배 업스케일`);
    // 새 에셋도 기존 후처리 잡(프록시)을 탄다
    await waitFor(
      async () => (await getDoc(doc.id)).assets[newAssetId]!.proxySrc !== undefined,
      '업스케일 프록시',
    );
  });

  it('interpolate → 새 video 에셋 추가(기본 60fps), 미존재 에셋 404 · 잘못된 fps 400', async () => {
    const doc = await createProject('보간');
    const video = (await importAsset(doc.id, 'ip.mp4')).json().asset as {
      id: string;
      name: string;
    };
    vi.mocked(interpolateFps).mockClear();

    const missing = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/없는에셋/interpolate`,
    });
    expect(missing.statusCode).toBe(404);
    const badFps = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${video.id}/interpolate`,
      payload: { fps: 0 },
    });
    expect(badFps.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${video.id}/interpolate`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status).toBe('done');
    expect(vi.mocked(interpolateFps).mock.calls[0]![2]).toMatchObject({ fps: 60, engine: 'auto' });
    const created = (await getDoc(doc.id)).assets[(job.result as { assetId: string }).assetId]!;
    expect(created.kind).toBe('video');
    expect(created.name).toBe(`${video.name} 60fps`);
  });
});

describe('커버 지정 (POST /cover)', () => {
  it('renderCover 로 jpg 를 굽고 settings.coverMs 를 기록한다', async () => {
    const doc = await createProject('커버');
    vi.mocked(renderCover).mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/cover`,
      payload: { timeMs: 1200 },
    });
    expect(res.statusCode).toBe(200);
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status).toBe('done');
    expect((job.result as { url: string }).url).toBe(`/media/renders/${doc.id}-cover.jpg`);
    expect(vi.mocked(renderCover).mock.calls[0]![1].timeMs).toBe(1200);
    await waitFor(async () => (await getDoc(doc.id)).settings.coverMs === 1200, 'coverMs 반영');
  });

  it('timeMs 가 음수·소수면 400, 미존재 프로젝트는 404', async () => {
    const doc = await createProject('커버400');
    const neg = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/cover`,
      payload: { timeMs: -1 },
    });
    expect(neg.statusCode).toBe(400);
    const frac = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/cover`,
      payload: { timeMs: 12.5 },
    });
    expect(frac.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/projects/nope/cover', payload: {} });
    expect(missing.statusCode).toBe(404);
  });
});

describe('MOV(알파) 렌더', () => {
  it('format:"mov" 는 .mov 로 저장하고 renderProject 를 transparent:true 로 부른다', async () => {
    const doc = await createProject('알파렌더');
    vi.mocked(renderProject).mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/render`,
      payload: { format: 'mov', outName: '알파결과' },
    });
    expect(res.statusCode).toBe(200);
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status).toBe('done');
    expect((job.result as { url: string }).url).toBe('/media/renders/알파결과.mov');
    const opts = vi.mocked(renderProject).mock.calls[0]![1] as {
      outPath: string;
      transparent?: boolean;
    };
    expect(opts.transparent).toBe(true);
    expect(opts.outPath.endsWith('.mov')).toBe(true);
  });

  it('mp4 렌더에는 transparent 를 넘기지 않는다 (v1 경로 유지)', async () => {
    const doc = await createProject('mp4렌더');
    vi.mocked(renderProject).mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/render`,
      payload: { format: 'mp4', outName: 'mp4결과' },
    });
    expect(res.statusCode).toBe(200);
    await waitJob((res.json() as { jobId: string }).jobId);
    const opts = vi.mocked(renderProject).mock.calls[0]![1] as { transparent?: boolean };
    expect(opts.transparent).toBeUndefined();
  });
});

describe('파생 미디어 스케줄러 (scheduleDeriveJobs)', () => {
  it('source 붙은 클립을 적용하면 derive 잡이 등록되고, 두 번 등록되지 않는다', async () => {
    vi.mocked(deriveMedia).mockClear();
    const doc = await createProject('파생');
    const videoTrack = doc.tracks.find((t) => t.kind === 'video')!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [
          { type: 'addAsset', asset: { id: 'da1', kind: 'video', src: 'assets/da1.mp4', name: 'da1', duration: 10000 } },
          { type: 'addClip', trackId: videoTrack.id, clip: { id: 'dc1', kind: 'video', assetId: 'da1', start: 0, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1, source: { stabilize: { smoothing: 10 } } } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(
      async () => Object.keys((await getDoc(doc.id)).assets['da1']!.derived ?? {}).length === 1,
      'derived 반영',
    );
    expect(vi.mocked(deriveMedia)).toHaveBeenCalledTimes(1);
    // 원본에서 굽는다
    expect(String(vi.mocked(deriveMedia).mock.calls[0]![0])).toContain(
      path.join('assets', 'da1.mp4'),
    );
    const derived = (await getDoc(doc.id)).assets['da1']!.derived!;
    const key = Object.keys(derived)[0]!;
    expect(derived[key]!.src).toBe(`derived/da1.${key}.mp4`);

    // 스케줄러는 매 배치마다 문서 전체를 훑지만 derived 가 이미 있으면 새 잡이 붙지 않는다
    const again = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'renameProject', name: '파생2' }] },
    });
    expect(again.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(vi.mocked(deriveMedia)).toHaveBeenCalledTimes(1);
  });

  it('reversed 인데 reversedSrc 가 없으면 굽지 않고, 생기면 그때 reversedSrc 에서 굽는다', async () => {
    vi.mocked(deriveMedia).mockClear();
    const doc = await createProject('역파생');
    const videoTrack = doc.tracks.find((t) => t.kind === 'video')!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [
          { type: 'addAsset', asset: { id: 'ra1', kind: 'video', src: 'assets/ra1.mp4', name: 'ra1', duration: 10000 } },
          { type: 'addClip', trackId: videoTrack.id, clip: { id: 'rc1', kind: 'video', assetId: 'ra1', start: 0, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1, reversed: true, source: { stabilize: { smoothing: 20 } } } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(vi.mocked(deriveMedia)).toHaveBeenCalledTimes(0);
    expect((await getDoc(doc.id)).assets['ra1']!.derived).toBeUndefined();

    // 역재생 파일이 생기면 스케줄러가 다시 돌아 그때 굽는다
    const rev = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [
          { type: 'updateAsset', assetId: 'ra1', patch: { reversedSrc: 'derived/ra1.rev.mp4' } },
        ],
      },
    });
    expect(rev.statusCode).toBe(200);
    await waitFor(
      async () => Object.keys((await getDoc(doc.id)).assets['ra1']!.derived ?? {}).length === 1,
      'reversed 파생 반영',
    );
    expect(vi.mocked(deriveMedia)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(deriveMedia).mock.calls[0]![0])).toContain(
      path.join('derived', 'ra1.rev.mp4'),
    );
  });

  it('LUT 에셋이 없으면 derive 잡이 한국어 메시지로 실패한다', async () => {
    vi.mocked(deriveMedia).mockClear();
    const doc = await createProject('LUT없음');
    const videoTrack = doc.tracks.find((t) => t.kind === 'video')!;

    const jobMsgs: { type: string; job: { type: string; status: string; error?: string } }[] = [];
    const ws = await app.injectWS(`/ws/projects/${doc.id}`, {}, {
      onInit: (sock: { on(ev: string, cb: (data: Buffer) => void): void }) => {
        sock.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as (typeof jobMsgs)[number];
          if (msg.type === 'job') jobMsgs.push(msg);
        });
      },
    } as never);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${doc.id}/commands`,
        payload: {
          commands: [
            { type: 'addAsset', asset: { id: 'la1', kind: 'video', src: 'assets/la1.mp4', name: 'la1', duration: 10000 } },
            { type: 'addClip', trackId: videoTrack.id, clip: { id: 'lc1', kind: 'video', assetId: 'la1', start: 0, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1, source: { lut: { assetId: '없는LUT', intensity: 1 } } } },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      // 잡은 등록되고(굽기 전에 LUT 를 찾다가) 실패한다 — deriveMedia 는 호출되지 않는다
      await waitFor(
        async () => jobMsgs.some((m) => m.job.type === 'derive' && m.job.status === 'error'),
        'derive 잡 실패 브로드캐스트',
      );
      const failed = jobMsgs.find((m) => m.job.type === 'derive' && m.job.status === 'error')!;
      expect(failed.job.error).toContain('LUT 에셋을 찾을 수 없습니다');
      expect(vi.mocked(deriveMedia)).toHaveBeenCalledTimes(0);
      expect((await getDoc(doc.id)).assets['la1']!.derived).toBeUndefined();
    } finally {
      ws.terminate();
    }
  });

  it('audio 클립의 source 는 audioOnly 로 굽는다', async () => {
    vi.mocked(deriveMedia).mockClear();
    const doc = await createProject('오디오파생');
    const audioTrack = doc.tracks.find((t) => t.kind === 'audio')!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [
          { type: 'addAsset', asset: { id: 'aa1', kind: 'audio', src: 'assets/aa1.wav', name: 'aa1', duration: 10000 } },
          { type: 'addClip', trackId: audioTrack.id, clip: { id: 'ac1', kind: 'audio', assetId: 'aa1', start: 0, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1, source: { pitch: { semitones: 2 } } } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(
      async () => Object.keys((await getDoc(doc.id)).assets['aa1']!.derived ?? {}).length === 1,
      'audio derived 반영',
    );
    expect(vi.mocked(deriveMedia)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deriveMedia).mock.calls[0]!;
    expect((call[4] as { pitch?: { semitones: number } }).pitch).toEqual({ semitones: 2 });
    expect((call[5] as { audioOnly?: boolean }).audioOnly).toBe(true);
  });
});
