// W8 F17 V5-6 — /render 이 스템 뺄셈 경로를 «실제로» 타는지, 조건을 못 맞추면 3패스로 가는지.
//
// Chrome 은 안 띄운다. `@kitkat/renderer` 를 모의해 **Remotion 이 하는 일을 ffmpeg 으로 흉내**낸다:
//   renderAudioStem(solo:[나레이션]) → trigger.wav      (미리 구운 고정 신호)
//   renderAudioStem(solo:[음악])     → music.wav
//   renderProject(두 트랙 살아있음)  → 영상 + amix(trigger, music)   ← 「전체 믹스」
//   renderProject(두 트랙 muted)     → 영상만 (오디오 스트림 없음)
// 「전체 = 트리거 + 음악」이 정수 덧셈으로 성립하는 상태를 만든 것이다(Remotion 과 같은 성질).
//
// ffmpeg 은 진짜로 돈다 — 뺄셈·포화 세기·sidechaincompress 믹스가 전부 실제 코드다.
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProjectDoc } from '@kitkat/schema';

const exec = promisify(execFile);

/** 모의가 참조하는 고정 신호 파일 경로 — beforeAll 에서 채운다. */
const SIG = vi.hoisted(() => ({ trigger: '', music: '', videoSec: 3 }));

vi.mock('@kitkat/media', async () => ({
  ...(await vi.importActual<typeof import('@kitkat/media')>('@kitkat/media')),
  probeAsset: vi.fn(async () => ({ kind: 'audio', duration: 5000, hasAudio: true })),
  makeProxy: vi.fn(async () => 'proxies/x.g15.mp4'),
  makeWaveform: vi.fn(async () => 'waveforms/x.json'),
  makeThumb: vi.fn(async () => 'thumbs/x.jpg'),
  toGif: vi.fn(async () => {}),
}));

vi.mock('@kitkat/ai', () => {
  class AiUnavailableError extends Error {}
  return {
    AiUnavailableError,
    ensurePython: vi.fn(async () => ({ ok: true })),
    transcribe: vi.fn(async () => []),
  };
});

vi.mock('@kitkat/renderer', () => {
  const run = async (args: string[]): Promise<void> => {
    const { execFile: ef } = await import('node:child_process');
    const { promisify: p } = await import('node:util');
    await p(ef)('ffmpeg', ['-hide_banner', '-nostats', '-v', 'error', '-y', ...args], {
      maxBuffer: 1 << 24,
    });
  };
  return {
    renderCover: vi.fn(async (_d: unknown, o: { outPath: string }) => ({ outPath: o.outPath })),
    renderAudioStem: vi.fn(
      async (_doc: unknown, o: { outPath: string; soloTrackIds: string[] }) => {
        const { copyFile } = await import('node:fs/promises');
        const src = o.soloTrackIds.includes('narr') ? SIG.trigger : SIG.music;
        await copyFile(src, o.outPath);
        return { outPath: o.outPath, durationMs: SIG.videoSec * 1000 };
      },
    ),
    renderProject: vi.fn(
      async (
        doc: ProjectDoc,
        o: { outPath: string; audioCodec?: string },
      ) => {
        // 모의가 소리를 아는 트랙은 둘뿐이다 — 살아 있는 게 둘이면 「전체 믹스」, 없으면 무음 영상.
        const live = doc.tracks.filter(
          (t) => (t.id === 'music' || t.id === 'narr') && t.muted !== true,
        );
        const video = [
          '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=30:d=${SIG.videoSec}`,
        ];
        if (live.length < 2) {
          // 두 트랙 muted — 3패스의 영상 단계. 오디오 스트림이 아예 없다.
          await run([...video, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', o.outPath]);
        } else {
          // 「전체 믹스」 — 트리거 + 음악을 정수 덧셈으로 섞는다 (Remotion 과 같은 성질).
          await run([
            ...video, '-i', SIG.trigger, '-i', SIG.music,
            '-filter_complex', '[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[a]',
            '-map', '0:v', '-map', '[a]',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', o.audioCodec === 'pcm-16' ? 'pcm_s16le' : 'aac',
            o.outPath,
          ]);
        }
        return { outPath: o.outPath, durationMs: SIG.videoSec * 1000 };
      },
    ),
  };
});

const { buildApp } = await import('../src/app.js');
const { countFullScaleSamples, extractPcmAudio, pcmShape, pcmShapesMatch } = await import(
  '../src/sidechain.js'
);
const { subtractStem } = await import('../src/sidechain.js');

let app: FastifyInstance;
let tmpRoot: string;

/**
 * 두 신호를 굽는다. 잡음원은 seed 를 박아 **매 실행 같은 파형**이 나온다.
 *
 * 게인은 실측으로 잡았다 (이 ffmpeg 빌드, 3초·48kHz·스테레오):
 *
 * | 게인 | 트리거 포화 | 음악 포화 | 합 포화 |
 * |---|---|---|---|
 * | 0.5 | 0 | 0 | **0** |
 * | 1.6 | 0 | 0 | **374 / 288,000 (0.13%)** |
 *
 * `loud` 는 **스템 각각은 안 잘리는데 합만 잘리는** 자리다 — 뺄셈이 깨지는 바로 그 조건.
 */
async function bakeSignals(dir: string, loud: boolean): Promise<void> {
  const gain = loud ? 1.6 : 0.5;
  const tag = loud ? 'loud' : 'ok';
  SIG.trigger = path.join(dir, `trigger-${tag}.wav`);
  SIG.music = path.join(dir, `music-${tag}.wav`);
  const bake = (out: string, color: string, seed: number) =>
    exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `anoisesrc=c=${color}:r=48000:a=1:d=${SIG.videoSec}:seed=${seed}`,
      '-af', `aformat=sample_fmts=flt,volume=${gain},aformat=channel_layouts=stereo`,
      '-c:a', 'pcm_s16le', out]);
  await bake(SIG.trigger, 'pink', 7);
  await bake(SIG.music, 'brown', 3);
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-f17sub-'));
  await fsp.mkdir(path.join(tmpRoot, 'media', 'assets'), { recursive: true });
  await bakeSignals(tmpRoot, false);
  app = await buildApp({
    dataDir: path.join(tmpRoot, 'data', 'projects'),
    mediaDir: path.join(tmpRoot, 'media'),
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

const audioClip = (id: string) => ({
  id, kind: 'audio' as const, assetId: 'a1', start: 0, duration: SIG.videoSec * 1000,
  in: 0, out: SIG.videoSec * 1000, speed: 1, volume: 1,
});

/** 영상(빈 트랙) + 음악(눌릴) + 나레이션(트리거). extra 를 켜면 셋째 오디오 트랙이 붙는다. */
function makeDoc(over: { extraAudio?: boolean; soundingVideoClip?: boolean } = {}) {
  const tracks: ProjectDoc['tracks'] = [
    {
      id: 'tv', kind: 'video', name: '비디오',
      clips: over.soundingVideoClip
        ? [{ id: 'v1', kind: 'video', assetId: 'a1', start: 0, duration: SIG.videoSec * 1000,
             in: 0, out: SIG.videoSec * 1000, speed: 1, volume: 1 }]
        : [],
    },
    {
      id: 'music', kind: 'audio', name: '음악',
      duckedBy: 'narr', duck: { amount: 0.25, attackMs: 200, releaseMs: 400 },
      clips: [audioClip('m1')],
    },
    { id: 'narr', kind: 'audio', name: '나레이션', clips: [audioClip('n1')] },
  ];
  if (over.extraAudio) {
    tracks.push({ id: 'sfx', kind: 'audio', name: '효과음', clips: [audioClip('s1')] });
  }
  return {
    schemaVersion: 1 as const, id: '', name: 'f17', revision: 0,
    settings: { width: 64, height: 64, fps: 30, background: { kind: 'color' as const, color: '#000000' } },
    assets: {
      a1: { id: 'a1', kind: 'audio' as const, src: 'assets/a1.wav', name: 'a1', duration: SIG.videoSec * 1000 },
    },
    tracks,
  };
}

async function waitJob(jobId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 2000; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    const job = res.json() as { status: string };
    if (job.status === 'done' || job.status === 'error') return job as Record<string, any>;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('잡이 제한 시간 안에 끝나지 않음');
}

/** 문서를 만들고 렌더해서 잡 결과를 준다. */
async function render(
  docPatch: Parameters<typeof makeDoc>[0],
  outName: string,
): Promise<Record<string, any>> {
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'f17' } });
  const base = created.json().doc as ProjectDoc;
  // restoreDoc 으로 문서를 통째로 앉힌다 (id·revision 은 엔진이 유지한다).
  const put = await app.inject({
    method: 'POST', url: `/api/projects/${base.id}/commands`,
    payload: { commands: [{ type: 'restoreDoc', doc: { ...makeDoc(docPatch), id: base.id } }] },
  });
  expect(put.statusCode).toBe(200);
  const id = base.id;
  const res = await app.inject({
    method: 'POST', url: `/api/projects/${id}/render`, payload: { outName },
  });
  expect(res.statusCode).toBe(200);
  const job = await waitJob(res.json().jobId as string);
  if (job.status !== 'done') throw new Error(`렌더 실패: ${JSON.stringify(job.error ?? job)}`);
  return job;
}

/** 오디오를 s16 raw 로 뽑아 md5 — 컨테이너·헤더를 빼고 «표본만» 비교한다. */
async function audioMd5(file: string): Promise<string> {
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vn', '-f', 's16le', '-c:a', 'pcm_s16le', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 },
  );
  return createHash('md5').update(stdout as unknown as Buffer).digest('hex');
}

describe('뺄셈 자체 — 「전체 − 트리거 = 눌릴 스템」이 비트 단위로 성립하는가', () => {
  it('mkv 안 pcm-16 에서 트리거를 빼면 음악 스템과 표본이 «완전히» 같다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kitkat-f17math-'));
    try {
      const full = path.join(dir, 'full.mkv');
      const fullWav = path.join(dir, 'full.wav');
      const out = path.join(dir, 'out.wav');
      // Remotion 이 하는 일 — 두 트랙 wav 를 «정수 덧셈»으로 섞어 pcm-16 으로 굽는다
      await exec('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=30:d=${SIG.videoSec}`,
        '-i', SIG.trigger, '-i', SIG.music,
        '-filter_complex', '[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[a]',
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', full]);

      await extractPcmAudio(full, fullWav);
      // 꺼내기는 «복사»다 — mkv 안 표본이 한 비트도 안 바뀌고 나와야 한다
      expect(await audioMd5(fullWav)).toBe(await audioMd5(full));
      expect((await countFullScaleSamples(fullWav)).full).toBe(0);
      const shapes = { a: await pcmShape(fullWav), b: await pcmShape(SIG.trigger) };
      expect(pcmShapesMatch(shapes.a, shapes.b)).toBe(true);

      await subtractStem(fullWav, SIG.trigger, out);
      expect(await audioMd5(out)).toBe(await audioMd5(SIG.music));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('포화가 없으면 잘린 표본이 0 이고, 볼륨을 올리면 0 이 아니다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kitkat-f17clip-'));
    try {
      const quiet = path.join(dir, 'quiet.wav');
      const loud = path.join(dir, 'loud.wav');
      await exec('ffmpeg', ['-v', 'error', '-y', '-i', SIG.music,
        '-af', 'aformat=sample_fmts=flt,volume=0.5', '-c:a', 'pcm_s16le', quiet]);
      await exec('ffmpeg', ['-v', 'error', '-y', '-i', SIG.music,
        '-af', 'aformat=sample_fmts=flt,volume=8', '-c:a', 'pcm_s16le', loud]);
      expect((await countFullScaleSamples(quiet)).full).toBe(0);
      expect((await countFullScaleSamples(loud)).full).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('스템 뺄셈 경로 (F17 V5-6)', () => {
  it('조건이 맞으면 뺄셈을 쓰고 포화 표본이 0 이라고 남긴다', async () => {
    const job = await render({}, 'f17-sub');
    const s = job.result.sidechain;
    expect(s.stemSubtract.used).toBe(true);
    expect(s.stemSubtract.clippedSamples).toBe(0);
    expect(s.stemSubtract.totalSamples).toBeGreaterThan(0);
    expect(s.stemSubtract.reason).toBeUndefined();
    // 전체 믹스가 영상 안에 있으므로 amix 에 또 넣으면 안 된다
    expect(s.videoHasAudio).toBe(false);
  }, 300_000);

  it('오디오 트랙이 3개면 조용히 3패스로 간다 (결과는 나오고 이유가 남는다)', async () => {
    const job = await render({ extraAudio: true }, 'f17-3track');
    const s = job.result.sidechain;
    expect(s.stemSubtract.used).toBe(false);
    expect(s.stemSubtract.reason).toMatch(/소리 나는 오디오 트랙이 2개가 아니다 \(3개\)/);
    expect(job.result.url).toMatch(/f17-3track\.mp4$/);
  }, 300_000);

  it('소리 내는 비디오 클립이 있으면 3패스로 간다', async () => {
    const job = await render({ soundingVideoClip: true }, 'f17-vidaudio');
    expect(job.result.sidechain.stemSubtract.used).toBe(false);
    expect(job.result.sidechain.stemSubtract.reason).toMatch(/소리 내는 비디오 클립/);
  }, 300_000);

  it('전체 믹스가 포화하면 뺄셈을 버리고 스템을 굽는다 (조용히 품질을 떨어뜨리지 않는다)', async () => {
    await bakeSignals(tmpRoot, true);
    try {
      const job = await render({}, 'f17-clip');
      const s = job.result.sidechain;
      expect(s.stemSubtract.used).toBe(false);
      expect(s.stemSubtract.clippedSamples).toBeGreaterThan(0);
      expect(s.stemSubtract.reason).toMatch(/전체 믹스가 포화했다/);
    } finally {
      await bakeSignals(tmpRoot, false);
    }
  }, 300_000);
});
