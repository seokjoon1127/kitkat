// @kitkat/server API 테스트 — fastify.inject / injectWS, media·renderer·ai 는 vi.mock
import { promises as fsp } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  makeProxy: vi.fn(async (_a: string, _m: string, id: string) => `proxies/${id}.g15.mp4`),
  makeDerivedProxy: vi.fn(async (_a: string, _m: string, id: string, key: string) => `derived/${id}.${key}.p.g15.mp4`),
  makeWaveform: vi.fn(async (_a: string, _m: string, id: string) => `waveforms/${id}.json`),
  makeThumb: vi.fn(async (_a: string, _m: string, id: string) => `thumbs/${id}.jpg`),
  preprocessReverse: vi.fn(async (_a: string, _m: string, id: string) => `derived/${id}.rev.mp4`),
  extractAudio: vi.fn(async (_src: string, _out: string) => {}),
  toGif: vi.fn(async () => {}),
  detectEncoder: vi.fn(async () => 'libx264'),
  // W5
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
  renderCover: vi.fn(async (_doc: unknown, opts: { outPath: string }) => ({
    outPath: opts.outPath,
  })),
}));

vi.mock('@kitkat/ai', () => {
  class AiUnavailableError extends Error {}
  return {
    AiUnavailableError,
    ensurePython: vi.fn(async () => ({ ok: true })),
    transcribe: vi.fn(async () => []),
    // W5 — 산출물 wav 2개를 실제로 만들어 둔다(라우트가 assets/ 로 copyFile 한다)
    ensureDemucs: vi.fn(async () => ({ ok: true })),
    isDemucsReady: vi.fn(async () => true),
    separateStems: vi.fn(async (_src: string, outDir: string) => {
      const nodePath = await import('node:path');
      const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
      const dir = nodePath.join(outDir, 'htdemucs', 'src');
      await mk(dir, { recursive: true });
      await wf(nodePath.join(dir, 'vocals.wav'), 'v');
      await wf(nodePath.join(dir, 'no_vocals.wav'), 'a');
      return {
        vocals: nodePath.join(dir, 'vocals.wav'),
        accompaniment: nodePath.join(dir, 'no_vocals.wav'),
      };
    }),
  };
});

import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-server-test-'));
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

async function createProject(name = '테스트'): Promise<ProjectDoc> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } });
  expect(res.statusCode).toBe(200);
  return res.json().doc as ProjectDoc;
}

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    const job = res.json() as { status: string };
    if (job.status === 'done' || job.status === 'error') return job as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('잡이 제한 시간 안에 끝나지 않음');
}

describe('healthz', () => {
  it('ok:true 와 version 을 준다', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });
});

describe('프로젝트 CRUD', () => {
  it('생성 → 기본 1080×1920 30fps, 트랙 3개, revision 0', async () => {
    const doc = await createProject('내 쇼츠');
    expect(doc.name).toBe('내 쇼츠');
    expect(doc.revision).toBe(0);
    expect(doc.settings.width).toBe(1080);
    expect(doc.settings.height).toBe(1920);
    expect(doc.settings.fps).toBe(30);
    expect(doc.tracks.map((t) => t.kind).sort()).toEqual(['audio', 'text', 'video']);
  });

  it('name 없으면 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('목록에 나타난다', async () => {
    const doc = await createProject('목록용');
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().projects as { id: string; name: string; revision: number }[];
    expect(rows.some((p) => p.id === doc.id && p.name === '목록용')).toBe(true);
  });

  it('단건 조회 / 미존재 404', async () => {
    const doc = await createProject();
    const ok = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().doc.id).toBe(doc.id);

    const missing = await app.inject({ method: 'GET', url: '/api/projects/nope' });
    expect(missing.statusCode).toBe(404);
    expect(typeof missing.json().error).toBe('string');
  });

  it('삭제 → ok:true, 이후 404', async () => {
    const doc = await createProject('지울 것');
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${doc.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);
    const gone = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('진행 중인 저장과 겹친 삭제 후 프로젝트 파일이 되살아나지 않는다', async () => {
    const doc = await createProject('삭제경합');
    // 첫 writeFile(명령 저장의 tmp 쓰기)을 100ms 지연시켜, 저장 진행 중에 DELETE가 도착하는 상황을 재현
    const original = fsp.writeFile;
    const spy = vi.spyOn(fsp, 'writeFile');
    spy.mockImplementationOnce(async (file, data, options) => {
      await new Promise((r) => setTimeout(r, 100));
      return original.call(fsp, file, data, options as never);
    });
    try {
      const post = app.inject({
        method: 'POST',
        url: `/api/projects/${doc.id}/commands`,
        payload: { commands: [{ type: 'renameProject', name: '느린 저장' }] },
      });
      await new Promise((r) => setTimeout(r, 30)); // 명령이 save(지연된 writeFile) 안에 들어가도록
      const del = await app.inject({ method: 'DELETE', url: `/api/projects/${doc.id}` });
      expect(del.statusCode).toBe(200);
      await post;
    } finally {
      spy.mockRestore();
    }
    // 삭제가 뮤텍스 없이 돌면 rm 뒤에 tmp→rename이 파일을 되살려 200이 된다
    const gone = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe('save 실패 시 메모리·디스크 일관성 (캐시는 rename 성공 후에만 갱신)', () => {
  it('디스크 쓰기 실패(500) 후 revision이 오르지 않고, 같은 baseRevision 재시도가 성공한다', async () => {
    const doc = await createProject('저장실패');
    const spy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValue(Object.assign(new Error('EIO: 파일이 잠겨 있음'), { code: 'EIO' }));
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${doc.id}/commands`,
        payload: { commands: [{ type: 'renameProject', name: '실패할 편집' }], baseRevision: 0 },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    // 캐시가 먼저 갱신됐다면 revision 1·이름 반영으로 보이고, 같은 baseRevision 재시도가 409가 된다
    const after = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    const afterDoc = after.json().doc as ProjectDoc;
    expect(afterDoc.revision).toBe(0);
    expect(afterDoc.name).toBe('저장실패');

    const retry = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'renameProject', name: '재시도 성공' }], baseRevision: 0 },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().revision).toBe(1);
  });
});

describe('UI 정적 서빙 (/p/:id, /assets/*)', () => {
  it('서버 기동 후 UI를 빌드해도 재시작 없이 /assets/*가 서빙된다', async () => {
    const uiDist = path.join(tmpRoot, 'ui-dist');
    const app2 = await buildApp({
      dataDir: path.join(tmpRoot, 'data2', 'projects'),
      mediaDir: path.join(tmpRoot, 'media2'),
      uiDistDir: uiDist,
    });
    await app2.ready();
    try {
      // 미빌드 상태: /p/:id는 안내 HTML, /assets/*는 404
      const before = await app2.inject({ method: 'GET', url: '/p/abc' });
      expect(before.statusCode).toBe(200);
      expect(before.body).toContain('빌드');
      expect((await app2.inject({ method: 'GET', url: '/assets/index-x.js' })).statusCode).toBe(404);

      // 기동 후 빌드가 완료된 상황 재현
      await mkdir(path.join(uiDist, 'assets'), { recursive: true });
      await writeFile(path.join(uiDist, 'index.html'), '<script src="./assets/index-x.js"></script>');
      await writeFile(path.join(uiDist, 'assets', 'index-x.js'), 'console.log(1)');

      const page = await app2.inject({ method: 'GET', url: '/p/abc' });
      expect(page.body).toContain('"/assets/index-x.js"');
      const js = await app2.inject({ method: 'GET', url: '/assets/index-x.js' });
      expect(js.statusCode).toBe(200);
      expect(js.body).toBe('console.log(1)');
    } finally {
      await app2.close();
    }
  });
});

describe('명령 적용', () => {
  it('renameProject 성공 → revision 1', async () => {
    const doc = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'renameProject', name: '새 이름' }], baseRevision: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revision).toBe(1);
    const after = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(after.json().doc.name).toBe('새 이름');
  });

  it('baseRevision 불일치 → 409 + 최신 doc 동봉', async () => {
    const doc = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'renameProject', name: 'x' }], baseRevision: 99 },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(typeof body.error).toBe('string');
    expect(body.doc.id).toBe(doc.id);
    expect(body.doc.revision).toBe(0);
  });

  it('EngineError → 400, revision 은 오르지 않는다', async () => {
    const doc = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'removeClip', clipId: '없는클립' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('CLIP_NOT_FOUND');
    const after = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(after.json().doc.revision).toBe(0);
  });

  it('commands 배열 없으면 400', async () => {
    const doc = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('입력 검증 관문 (스키마 위반 문서가 저장되지 않는다)', () => {
  it('POST /api/projects: fps 0 · 비정수 width 는 400', async () => {
    const badFps = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '불량', fps: 0 },
    });
    expect(badFps.statusCode).toBe(400);
    const badWidth = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '불량', width: 1080.5 },
    });
    expect(badWidth.statusCode).toBe(400);
  });

  it('splitClip float at → 400, 문서는 그대로', async () => {
    const doc = await createProject('float분할');
    const videoTrack = doc.tracks.find((t) => t.kind === 'video')!;
    const setupRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [
          { type: 'addAsset', asset: { id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1', duration: 10000 } },
          { type: 'addClip', trackId: videoTrack.id, clip: { id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1 } },
        ],
      },
    });
    expect(setupRes.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'splitClip', clipId: 'c1', at: 1333.3333 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('BAD_SPLIT');
    const after = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect((after.json().doc as ProjectDoc).tracks.find((t) => t.id === videoTrack.id)!.clips).toHaveLength(1);
  });

  it('updateAsset patch {src:null} → 400 INVALID_DOC, 프로젝트는 계속 열린다', async () => {
    const doc = await createProject('src삭제');
    await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [
          { type: 'addAsset', asset: { id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1', duration: 10000 } },
        ],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'updateAsset', assetId: 'a1', patch: { src: null } }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('INVALID_DOC');
    const after = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect(after.statusCode).toBe(200);
    expect((after.json().doc as ProjectDoc).assets['a1']!.src).toBe('assets/a1.mp4');
  });

  it('필수 필드 없는 text addClip → 400, 200으로 저장되지 않는다', async () => {
    const doc = await createProject('불량자막');
    const textTrack = doc.tracks.find((t) => t.kind === 'text')!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [
          { type: 'addClip', trackId: textTrack.id, clip: { id: 'c1', kind: 'text', start: 0, duration: 1000 } },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const after = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect((after.json().doc as ProjectDoc).tracks.find((t) => t.id === textTrack.id)!.clips).toHaveLength(0);
  });
});

describe('splitClip 결정성 (newClipId)', () => {
  it('newClipId를 주면 그 id로 분할되고, 안 주면 서버가 채워 브로드캐스트한다', async () => {
    const doc = await createProject('분할용');
    const videoTrack = doc.tracks.find((t) => t.kind === 'video')!;
    await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [
          { type: 'addAsset', asset: { id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1', duration: 10000 } },
          { type: 'addClip', trackId: videoTrack.id, clip: { id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1 } },
        ],
      },
    });

    // 1) 클라이언트가 지정한 id를 그대로 쓴다
    const withId = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'splitClip', clipId: 'c1', at: 1000, newClipId: 'right-1' }] },
    });
    expect(withId.statusCode).toBe(200);
    let now = (await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).json().doc as ProjectDoc;
    expect(now.tracks.find((t) => t.id === videoTrack.id)!.clips.map((c) => c.id)).toEqual(['c1', 'right-1']);

    // 2) 미지정이면 서버가 채우고, 브로드캐스트 명령에도 같은 id가 실린다 (C3 재적용 결정성)
    const messages: { type: string; commands?: { type: string; newClipId?: string }[] }[] = [];
    const ws = await app.injectWS(`/ws/projects/${doc.id}`, {}, {
      onInit: (sock: { on(ev: string, cb: (data: Buffer) => void): void }) => {
        sock.on('message', (data: Buffer) => {
          messages.push(JSON.parse(data.toString()) as (typeof messages)[number]);
        });
      },
    } as never);
    try {
      const noId = await app.inject({
        method: 'POST',
        url: `/api/projects/${doc.id}/commands`,
        payload: { commands: [{ type: 'splitClip', clipId: 'right-1', at: 2000 }] },
      });
      expect(noId.statusCode).toBe(200);
      for (let i = 0; i < 300 && !messages.some((m) => m.type === 'commands'); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const broadcast = messages.find((m) => m.type === 'commands');
      expect(broadcast).toBeTruthy();
      const cmd = broadcast!.commands![0]!;
      expect(cmd.type).toBe('splitClip');
      expect(typeof cmd.newClipId).toBe('string');
      now = (await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).json().doc as ProjectDoc;
      const ids = now.tracks.find((t) => t.id === videoTrack.id)!.clips.map((c) => c.id);
      expect(ids).toEqual(['c1', 'right-1', cmd.newClipId]);
    } finally {
      ws.terminate();
    }
  });
});

describe('에셋 임포트 + 오디오 추출', () => {
  it('로컬 경로 임포트 → addAsset + 후처리 잡 → updateAsset', async () => {
    const doc = await createProject('에셋용');
    const srcFile = path.join(tmpRoot, 'input.mp4');
    await writeFile(srcFile, 'dummy');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets`,
      payload: { path: srcFile },
    });
    expect(res.statusCode).toBe(200);
    const { asset, jobId } = res.json() as {
      asset: { id: string; kind: string; src: string; duration?: number };
      jobId: string;
    };
    expect(asset.kind).toBe('video');
    expect(asset.duration).toBe(5000);
    expect(asset.src).toMatch(/^assets\/.+\.mp4$/); // forward slash 전용
    expect(asset.src).not.toContain('\\');

    const job = await waitJob(jobId);
    expect(job.status).toBe('done');
    // 후처리 잡이 전부 끝나길 기다린 뒤 proxySrc 반영 확인
    for (let i = 0; i < 100; i++) {
      const now = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
      const a = (now.json().doc as ProjectDoc).assets[asset.id]!;
      if (a.proxySrc && a.thumbSrc && a.waveformSrc) {
        // F14 에서 프록시 이름에 판 표시(.g15)가 붙었다 — makeProxy 가 실제로 그 이름을 낸다.
        expect(a.proxySrc).toBe(`proxies/${asset.id}.g15.mp4`);
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('후처리 updateAsset 이 반영되지 않음');
  });

  it('extract-audio → 새 audio 에셋 추가', async () => {
    const doc = await createProject('추출용');
    const srcFile = path.join(tmpRoot, 'input2.mp4');
    await writeFile(srcFile, 'dummy');
    const imp = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets`,
      payload: { path: srcFile },
    });
    const videoAsset = imp.json().asset as { id: string };

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${videoAsset.id}/extract-audio`,
    });
    expect(res.statusCode).toBe(200);
    const audio = res.json().asset as { id: string; kind: string; src: string };
    expect(audio.kind).toBe('audio');
    expect(audio.src).toMatch(/^assets\/.+\.wav$/);

    const now = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect((now.json().doc as ProjectDoc).assets[audio.id]).toBeTruthy();
  });

  it('미존재 에셋 extract-audio → 404', async () => {
    const doc = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/없는에셋/extract-audio`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('렌더 잡', () => {
  it('render → jobId, 완료 시 result.url', async () => {
    const doc = await createProject('렌더용');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/render`,
      payload: { format: 'mp4', outName: '결과물' },
    });
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json() as { jobId: string };
    const job = await waitJob(jobId);
    expect(job.status).toBe('done');
    expect((job.result as { url: string }).url).toBe('/media/renders/결과물.mp4');
  });
});

describe('WS', () => {
  it('접속 직후 {type:"doc", doc} 를 받는다', async () => {
    const doc = await createProject('WS용');
    // injectWS 는 open 후 listener 를 달면 최초 프레임을 놓칠 수 있어 onInit 으로 미리 단다
    let resolveFirst!: (v: string) => void;
    let rejectFirst!: (e: Error) => void;
    const firstMessage = new Promise<string>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    const timer = setTimeout(() => rejectFirst(new Error('WS 수신 타임아웃')), 3000);
    const ws = await app.injectWS(`/ws/projects/${doc.id}`, {}, {
      onInit: (sock: { on(ev: string, cb: (data: Buffer) => void): void }) => {
        sock.on('message', (data: Buffer) => {
          clearTimeout(timer);
          resolveFirst(data.toString());
        });
      },
    } as never);
    try {
      const msg = JSON.parse(await firstMessage) as { type: string; doc: ProjectDoc };
      expect(msg.type).toBe('doc');
      expect(msg.doc.id).toBe(doc.id);
    } finally {
      ws.terminate();
    }
  });
});

// W8 F17 — 옛 판 프록시 다시 굽기.
// F14 가 프록시 키프레임 간격을 0.5초로 바꾸면서 이름에 판 표시(.g15)를 붙였다.
// 이미 임포트해 둔 에셋은 옛 판을 그대로 써서 스크럽이 느린 채로 남는다 — 이 라우트가 고친다.
describe('프록시 갱신 (reproxy)', () => {
  const importVideo = async (projectId: string, file: string) => {
    const srcFile = path.join(tmpRoot, file);
    await writeFile(srcFile, 'dummy');
    const imp = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assets`,
      payload: { path: srcFile },
    });
    return (imp.json().asset as { id: string }).id;
  };

  /** 후처리 잡이 proxySrc 를 채울 때까지 기다린다 */
  const waitProxy = async (projectId: string, assetId: string): Promise<string> => {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}` });
      const src = (res.json().doc as ProjectDoc).assets[assetId]?.proxySrc;
      if (src) return src;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('proxySrc 가 안 채워짐');
  };

  it('옛 판이면 다시 굽고 proxySrc 를 새 이름으로 바꾼다', async () => {
    const doc = await createProject('프록시갱신');
    const assetId = await importVideo(doc.id, 'reproxy1.mp4');
    await waitProxy(doc.id, assetId);

    // 옛 판 상태를 만든다 (판 표시가 붙기 전에 임포트한 에셋)
    await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: {
        commands: [{ type: 'updateAsset', assetId, patch: { proxySrc: `proxies/${assetId}.mp4` } }],
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${assetId}/reproxy`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobId).toBeTruthy();

    // 잡이 끝나면 새 이름으로 바뀐다
    for (let i = 0; i < 200; i++) {
      const now = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
      const src = (now.json().doc as ProjectDoc).assets[assetId]?.proxySrc;
      if (src?.endsWith('.g15.mp4')) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('proxySrc 가 새 판으로 안 바뀜');
  });

  it('이미 최신 판이면 400 (헛일을 안 시킨다)', async () => {
    const doc = await createProject('이미최신');
    const assetId = await importVideo(doc.id, 'reproxy2.mp4');
    const src = await waitProxy(doc.id, assetId);
    expect(src.endsWith('.g15.mp4')).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/${assetId}/reproxy`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('이미 최신');
  });

  it('미존재 에셋 → 404', async () => {
    const doc = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/assets/없는에셋/reproxy`,
    });
    expect(res.statusCode).toBe(404);
  });
});

// W8 F17 리뷰 #1 — 없는 필드는 200 으로 저장되지 않고 400 으로 «어디가» 틀렸는지 알려 준다.
describe('없는 필드 거절 (에이전트가 오타를 내도 조용히 넘어가지 않는다)', () => {
  it('이미지 클립에 chromaKeyy(오타) → 400 + 경로', async () => {
    const doc = await createProject('오타');
    const srcFile = path.join(tmpRoot, 'typo.png');
    await writeFile(srcFile, 'dummy');
    const imp = await app.inject({ method: 'POST', url: `/api/projects/${doc.id}/assets`, payload: { path: srcFile } });
    const assetId = (imp.json().asset as { id: string }).id;
    const vt = (doc as ProjectDoc).tracks.find((t) => t.kind === 'video')!.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${doc.id}/commands`,
      payload: { commands: [{ type: 'addClip', trackId: vt, clip: {
        id: 'c1', kind: 'image', assetId, start: 0, duration: 1000,
        chromaKeyy: { color: '#00b140', similarity: 0.4, smoothness: 0.1 },
      } }] },
    });
    expect(res.statusCode).toBe(400);
    const msg = String(res.json().error);
    expect(msg).toMatch(/chromaKeyy/);
    expect(msg).toMatch(/스키마에 없는 필드/);
    // 문서에 아무것도 안 남는다
    const now = await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` });
    expect((now.json().doc as ProjectDoc).tracks.flatMap((t) => t.clips)).toHaveLength(0);
  });
});

// W8 F17 리뷰 #3 — 옛 판 프록시를 원본·파생 가리지 않고 한 번에.
describe('프록시 일괄 갱신 (reproxy-all)', () => {
  it('옛 판 원본 1 + 옛 판 파생 1 → 한 잡으로 둘 다 새 판, 파생 본체는 그대로', async () => {
    const doc = await createProject('일괄갱신');
    const srcFile = path.join(tmpRoot, 'bulk.mp4');
    await writeFile(srcFile, 'dummy');
    const imp = await app.inject({ method: 'POST', url: `/api/projects/${doc.id}/assets`, payload: { path: srcFile } });
    const assetId = (imp.json().asset as { id: string }).id;
    const vt = (doc as ProjectDoc).tracks.find((t) => t.kind === 'video')!.id;
    // 파생 항목은 «어느 클립이 쓰는 키»여야 살아남는다 — 안 쓰는 키는 파생 수명 관리가 지운다(derive-lifecycle).
    // 그래서 잡음 제거를 건 클립을 하나 두고, (모의) derive 잡이 옛 판 이름(.p.mp4)의 프록시를 만들게 한다.
    const added = await app.inject({ method: 'POST', url: `/api/projects/${doc.id}/commands`, payload: { commands: [
      { type: 'addClip', trackId: vt, clip: { id: 'c1', kind: 'video', assetId, start: 0, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1, source: { denoise: { amount: 0.5 } } } },
    ] } });
    expect(added.statusCode, added.body).toBe(200);
    let a: ProjectDoc['assets'][string] | undefined;
    for (let i = 0; i < 300; i++) {
      a = ((await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).json().doc as ProjectDoc).assets[assetId];
      if (a?.proxySrc && a.derived && Object.keys(a.derived).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const key = Object.keys(a!.derived!)[0]!;
    expect(a!.derived![key]!.proxySrc).toBe(`derived/${assetId}.${key}.p.mp4`); // 모의 derive 가 낸 «옛 판»
    // 원본 프록시도 옛 판으로
    await app.inject({ method: 'POST', url: `/api/projects/${doc.id}/commands`, payload: { commands: [
      { type: 'updateAsset', assetId, patch: { proxySrc: `proxies/${assetId}.mp4` } },
    ] } });

    const res = await app.inject({ method: 'POST', url: `/api/projects/${doc.id}/assets/reproxy-all` });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);

    for (let i = 0; i < 300; i++) {
      a = ((await app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).json().doc as ProjectDoc).assets[assetId];
      if (a?.proxySrc?.endsWith('.g15.mp4') && a.derived?.[key]?.proxySrc?.endsWith('.g15.mp4')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(a!.proxySrc).toBe(`proxies/${assetId}.g15.mp4`);
    expect(a!.derived![key]!.proxySrc).toBe(`derived/${assetId}.${key}.p.g15.mp4`);
    expect(a!.derived![key]!.src).toBe(`derived/${assetId}.${key}.mp4`); // 본체는 안 건드린다

    // 다시 누르면 «없다»
    const again = await app.inject({ method: 'POST', url: `/api/projects/${doc.id}/assets/reproxy-all` });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toContain('전부 최신');
  }, 20_000);
});
