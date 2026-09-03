// W8 F12-B — 옛 형식 파형(1000버킷 배열)을 다시 굽는 스케줄러.
// 「조용히 근사해서 쓰지 않는다」가 이 파일의 계약이다.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, type Asset, type ProjectDoc } from '@kitkat/schema';

const makeWaveformMock = vi.fn(async (_abs: string, _media: string, id: string) => `waveforms/${id}.json`);

vi.mock('@kitkat/media', async () => ({
  // 진짜 모듈을 통째로 깔고 스텁만 덮는다 — 서버 코어가 media 에서 새로 쓰는 것(runWithJobSignal 등)이
  // 생겨도 모의가 «함수가 아닙니다» 로 죽지 않는다. isCurrentProxy 도 진짜다.
  ...(await vi.importActual<typeof import('@kitkat/media')>('@kitkat/media')),
  makeWaveform: (...args: [string, string, string]) => makeWaveformMock(...args),
  deriveMedia: vi.fn(),
  estimateMotionBlurSeconds: vi.fn(() => 0),
  preprocessReverse: vi.fn(),
  voiceIrPath: vi.fn((id: string) => `/ir/${id}.wav`),
}));

const { scheduleWaveformRebake } = await import('../src/routes/commands.js');

let mediaDir: string;

type EnqueuedJob = { type: string; key?: string; run: () => Promise<unknown> };

function fakeCtx(jobs: EnqueuedJob[], applied: unknown[][]) {
  return {
    mediaDir,
    jobs: {
      hasActive: () => false,
      enqueue: (type: string, _pid: string, fn: () => Promise<unknown>, key?: string) => {
        jobs.push({ type, key, run: fn });
        return { id: 'j' };
      },
    },
    applyBatch: async (_id: string, commands: unknown[]) => {
      applied.push(commands);
      return {} as ProjectDoc;
    },
  } as never;
}

function docWith(assets: Asset[]): ProjectDoc {
  const doc = createEmptyProject({ name: 'wf' });
  for (const a of assets) doc.assets[a.id] = a;
  return doc;
}

const asset = (id: string): Asset => ({
  id, kind: 'audio', src: `assets/${id}.wav`, name: id, duration: 5000,
  waveformSrc: `waveforms/${id}.json`,
});

/**
 * 스케줄러는 파형 파일을 «비동기로» 읽는다. 고정 대기(30ms)는 다른 테스트와 같이 돌 때
 * 부족해져 헛되이 깜빡인다 — 조건이 찰 때까지 짧게 폴링한다.
 */
async function settle(until?: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (!until || until()) return;
  }
}

beforeAll(async () => {
  mediaDir = await mkdtemp(path.join(tmpdir(), 'kitkat-wf-'));
  await mkdir(path.join(mediaDir, 'waveforms'), { recursive: true });
  await writeFile(path.join(mediaDir, 'waveforms', 'old.json'), JSON.stringify([0.1, 0.2, 0.3]));
  await writeFile(
    path.join(mediaDir, 'waveforms', 'new.json'),
    JSON.stringify({ bucketMs: 20, peaks: [0.1], rms: [0.05] }),
  );
  await writeFile(path.join(mediaDir, 'waveforms', 'broken.json'), '{not json');
  await writeFile(path.join(mediaDir, 'waveforms', 'old2.json'), JSON.stringify([0.4, 0.5]));
});

afterAll(async () => {
  await rm(mediaDir, { recursive: true, force: true }).catch(() => {});
});

describe('scheduleWaveformRebake', () => {
  it('옛 형식(배열)은 다시 굽고 새 형식은 건드리지 않는다', async () => {
    const jobs: EnqueuedJob[] = [];
    const applied: unknown[][] = [];
    scheduleWaveformRebake(fakeCtx(jobs, applied), docWith([asset('old'), asset('new')]));
    await settle(() => jobs.length > 0);

    expect(jobs.map((j) => j.key)).toEqual(['old']);
    expect(jobs[0]!.type).toBe('waveform');

    await jobs[0]!.run();
    expect(makeWaveformMock).toHaveBeenCalledWith(
      path.join(mediaDir, 'assets', 'old.wav'), mediaDir, 'old',
    );
    expect(applied).toEqual([[{ type: 'updateAsset', assetId: 'old', patch: { waveformSrc: 'waveforms/old.json' } }]]);
  });

  it('깨진 파일도 다시 굽는다', async () => {
    const jobs: EnqueuedJob[] = [];
    scheduleWaveformRebake(fakeCtx(jobs, []), docWith([asset('broken')]));
    await settle(() => jobs.length > 0);
    expect(jobs.map((j) => j.key)).toEqual(['broken']);
  });

  it('같은 파일을 두 번 확인하지 않는다 (applyBatch 마다 디스크를 읽지 않게)', async () => {
    const first: EnqueuedJob[] = [];
    scheduleWaveformRebake(fakeCtx(first, []), docWith([asset('old2')]));
    await settle(() => first.length > 0);
    expect(first).toHaveLength(1);

    const second: EnqueuedJob[] = [];
    scheduleWaveformRebake(fakeCtx(second, []), docWith([asset('old2')]));
    await settle();
    expect(second).toHaveLength(0);
  });

  it('파형이 없는 에셋은 건너뛴다', async () => {
    const jobs: EnqueuedJob[] = [];
    const a: Asset = { id: 'nowave', kind: 'audio', src: 'assets/nowave.wav', name: 'n' };
    scheduleWaveformRebake(fakeCtx(jobs, []), docWith([a]));
    await settle();
    expect(jobs).toHaveLength(0);
  });
});
