// W8 F10 — /track 라우트, 좌표 변환, 시간축 변환, 키프레임 병합.
// @kitkat/ai 는 vi.mock (실제 opencv 실행 없음).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Asset, ProjectDoc, VideoClip } from '@kitkat/schema';

vi.mock('@kitkat/media', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    probeAsset: vi.fn(async () => ({ kind: 'video', duration: 10000, width: 1920, height: 1080, hasAudio: true })),
    makeProxy: vi.fn(async (_a: string, _m: string, id: string) => `proxies/${id}.mp4`),
    makeWaveform: vi.fn(async (_a: string, _m: string, id: string) => `waveforms/${id}.json`),
    makeThumb: vi.fn(async (_a: string, _m: string, id: string) => `thumbs/${id}.jpg`),
    preprocessReverse: vi.fn(async (_a: string, _m: string, id: string) => `derived/${id}.rev.mp4`),
    deriveMedia: vi.fn(async () => ({ src: 'derived/x.mp4' })),
    detectEncoder: vi.fn(async () => 'libx264'),
  };
});

vi.mock('@kitkat/renderer', () => ({
  renderProject: vi.fn(async (_d: unknown, o: { outPath: string }) => ({ outPath: o.outPath, durationMs: 1 })),
  renderCover: vi.fn(async (_d: unknown, o: { outPath: string }) => ({ outPath: o.outPath })),
}));

vi.mock('@kitkat/ai', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  class AiUnavailableError extends Error {}
  class TrackerUnavailableError extends Error {}
  return {
    ...real,
    AiUnavailableError,
    TrackerUnavailableError,
    ensurePython: vi.fn(async () => ({ ok: true })),
    transcribe: vi.fn(async () => []),
    ensureDemucs: vi.fn(async () => ({ ok: true })),
    isDemucsReady: vi.fn(async () => true),
    separateStems: vi.fn(async () => ({ vocals: '', accompaniment: '' })),
    isTrackerReady: vi.fn(async () => true),
    trackBox: vi.fn(async () => ({ fps: 30, width: 1920, height: 1080, frames: [] })),
  };
});

import { isTrackerReady, trackBox } from '@kitkat/ai';
import { buildApp } from '../src/app.js';
import {
  clipTimeMap,
  decodeWindow,
  maskNormFromSourcePx,
  mergeMaskKeyframes,
  sourcePxFromMaskNorm,
  trackToKeyframes,
  validateTrackRequest,
  DEFAULT_TOLERANCE_PX,
} from '../src/routes/track.js';

let app: FastifyInstance;
let tmpRoot: string;
let projectId: string;
let assetId: string;
let clipId: string;
let trackId: string;

const ASSET: Asset = { id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a', duration: 10000, width: 1920, height: 1080 };

function clipOf(over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 5000,
    in: 1000, out: 6000, speed: 1, volume: 1,
    mask: { shape: 'rect', feather: 0, x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    ...over,
  } as VideoClip;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'kitkat-f10-srv-'));
  app = await buildApp({ dataDir: path.join(tmpRoot, 'data', 'projects'), mediaDir: path.join(tmpRoot, 'media') });
  await app.ready();
  const doc = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'F10' } })).json().doc as ProjectDoc;
  projectId = doc.id;
  trackId = doc.tracks[0]!.id;
  const srcFile = path.join(tmpRoot, 'v.mp4');
  await writeFile(srcFile, 'dummy');
  const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/assets`, payload: { path: srcFile } });
  assetId = (res.json() as { asset: { id: string } }).asset.id;
  const add = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/commands`,
    payload: {
      commands: [
        { type: 'addClip', trackId, clip: { id: 'c-track', kind: 'video', assetId, start: 0, duration: 5000, in: 0, out: 5000, speed: 1, volume: 1 } },
        { type: 'updateClip', clipId: 'c-track', patch: { mask: { shape: 'rect', feather: 0, x: 0.25, y: 0.25, w: 0.5, h: 0.5 } } },
      ],
    },
  });
  if (add.statusCode !== 200) throw new Error(`클립 추가 실패 ${add.statusCode}: ${add.body}`);
  clipId = 'c-track';
});

afterAll(async () => {
  await app.close();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  vi.mocked(isTrackerReady).mockResolvedValue(true);
  vi.mocked(trackBox).mockClear();
});

const post = (payload: unknown, cid = clipId) =>
  app.inject({ method: 'POST', url: `/api/projects/${projectId}/clips/${cid}/track`, payload });

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 800; i++) {
    const job = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json() as { status: string };
    if (job.status === 'done' || job.status === 'error') return job as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('잡이 끝나지 않음');
}

// ── 좌표 변환 ─────────────────────────────────────────────────────────────

describe('좌표 변환 — 소스 픽셀 ↔ 마스크 정규화', () => {
  it('크롭이 없으면 소스 크기로 나누기만 한다', () => {
    expect(maskNormFromSourcePx({ x: 480, y: 270, w: 960, h: 540 }, 1920, 1080)).toEqual({
      x: 0.25, y: 0.25, w: 0.5, h: 0.5,
    });
  });

  it('정변환·역변환이 서로를 되돌린다 (크롭 있음)', () => {
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 };
    const px = { x: 700, y: 200, w: 300, h: 400 };
    const n = maskNormFromSourcePx(px, 1920, 1080, crop);
    const back = sourcePxFromMaskNorm(n, 1920, 1080, crop);
    expect(back.x).toBeCloseTo(px.x, 6);
    expect(back.y).toBeCloseTo(px.y, 6);
    expect(back.w).toBeCloseTo(px.w, 6);
    expect(back.h).toBeCloseTo(px.h, 6);
  });

  it('크롭 {x:0.25,w:0.5} 는 좌표를 옮기고 폭을 2배로 넓힌다', () => {
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 };
    // 크롭 왼쪽 끝(소스 x=480)이 마스크 0 이 된다
    expect(maskNormFromSourcePx({ x: 480, y: 0, w: 192, h: 108 }, 1920, 1080, crop)).toMatchObject({
      x: 0, w: 0.2, // 192/1920 / 0.5
    });
  });

  it('«캔버스 크기·scale·rotation 이 들어가지 않는다» — 변환 인자가 소스 크기와 크롭뿐이다', () => {
    // 같은 소스 픽셀은 캔버스가 세로든 가로든 같은 정규화 값을 준다(함수에 캔버스 인자가 없다).
    const a = maskNormFromSourcePx({ x: 100, y: 100, w: 50, h: 50 }, 1920, 1080);
    const b = maskNormFromSourcePx({ x: 100, y: 100, w: 50, h: 50 }, 1920, 1080);
    expect(a).toEqual(b);
  });
});

// ── 시간축 변환 ───────────────────────────────────────────────────────────

describe('시간축 변환', () => {
  it('보통 클립: fileMs = in + t·speed', () => {
    const m = clipTimeMap(clipOf({ speed: 2, in: 1000, out: 6000, duration: 2500 }), ASSET);
    expect(m.fileMs(0)).toBe(1000);
    expect(m.fileMs(1000)).toBe(3000);
    expect(m.clipMs(3000)).toBe(1000);
  });

  it('클립 구간 밖의 파일 시각은 null 이다', () => {
    const m = clipTimeMap(clipOf({ in: 1000, out: 6000, speed: 1, duration: 5000 }), ASSET);
    expect(m.clipMs(500)).toBeNull();
    expect(m.clipMs(9000)).toBeNull();
  });

  it('역재생 클립은 역재생 파일을 쓰고 구간이 미러링된다 (렌더러와 같은 규칙)', () => {
    const asset = { ...ASSET, reversedSrc: 'derived/a1.rev.mp4' };
    const clip = clipOf({ reversed: true, in: 1000, out: 6000, speed: 1, duration: 5000 });
    expect(decodeWindow(clip, asset)).toEqual({ rel: 'derived/a1.rev.mp4', inMs: 4000, outMs: 9000 });
    const m = clipTimeMap(clip, asset);
    expect(m.fileMs(0)).toBe(4000);
    expect(m.fileMs(5000)).toBe(9000);
    expect(m.clipMs(4000)).toBe(0);
  });

  it('역재생본이 아직 없으면 원본을 그대로 쓴다 (미러링 안 함)', () => {
    const clip = clipOf({ reversed: true });
    expect(decodeWindow(clip, ASSET).rel).toBe('assets/a1.mp4');
  });

  it('speedRamp 는 등속 구간별로 역산한다 — 왕복이 항등에 가깝다', () => {
    const clip = clipOf({
      in: 0, out: 5000, speed: 1, duration: 5000,
      speedRamp: { points: [{ u: 0, speed: 0.5 }, { u: 1, speed: 2 }] },
    } as Partial<VideoClip>);
    const m = clipTimeMap(clip, ASSET);
    for (const t of [0, 500, 1500, 2500]) {
      const back = m.clipMs(m.fileMs(t));
      expect(back).not.toBeNull();
      expect(Math.abs(back! - t)).toBeLessThan(120); // 구간 40개 분할의 선형보간 오차
    }
  });

  it('speedRamp 는 «지원 안 함» 이 아니다 — passMs 가 램프 길이다', () => {
    const clip = clipOf({
      in: 0, out: 5000, speed: 1, duration: 5000,
      speedRamp: { points: [{ u: 0, speed: 0.5 }, { u: 1, speed: 2 }] },
    } as Partial<VideoClip>);
    expect(clipTimeMap(clip, ASSET).passMs).toBeGreaterThan(0);
  });
});

// ── 결과 → 키프레임 ───────────────────────────────────────────────────────

const okFrames = (n: number, ok: (i: number) => boolean = () => true) =>
  Array.from({ length: n }, (_, i) => ({
    ms: i * 100, x: 480 + i * 10, y: 270, w: 960, h: 540, ok: ok(i),
  }));

describe('trackToKeyframes', () => {
  it('네 경로가 «같은 시각»에 함께 들어간다', () => {
    const r = trackToKeyframes({ frames: okFrames(20), clip: clipOf({ in: 0, out: 5000, speed: 1 }), asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0.5 });
    const byTime = new Map<number, string[]>();
    for (const k of r.keyframes) byTime.set(k.time, [...(byTime.get(k.time) ?? []), k.prop]);
    for (const props of byTime.values()) {
      expect(props.sort()).toEqual(['mask.h', 'mask.w', 'mask.x', 'mask.y']);
    }
  });

  it('«실패 구간에는 키프레임을 만들지 않는다»', () => {
    const frames = okFrames(30, (i) => i < 10 || i >= 20);
    const r = trackToKeyframes({ frames, clip: clipOf({ in: 0, out: 5000, speed: 1 }), asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0.5 });
    const times = new Set(r.keyframes.map((k) => k.time));
    for (let i = 10; i < 20; i++) expect(times.has(i * 100)).toBe(false);
    expect(r.gaps).toEqual([{ startMs: 1000, endMs: 1900 }]);
    expect(r.tracked).toBe(20);
    expect(r.total).toBe(30);
  });

  it('실패 구간을 사이에 두고 «가로지르는 직선»으로 뭉개지 않는다', () => {
    // 앞뒤가 서로 반대로 움직이는 궤적. 성공 구간을 따로 간소화하지 않으면
    // RDP 가 실패 구간을 가로질러 한 직선으로 만들어 버린다.
    const frames = Array.from({ length: 30 }, (_, i) => ({
      ms: i * 100, x: 480 + (i < 10 ? i * 20 : (29 - i) * 20), y: 270, w: 960, h: 540,
      ok: i < 10 || i >= 20,
    }));
    const r = trackToKeyframes({ frames, clip: clipOf({ in: 0, out: 5000, speed: 1 }), asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0.5 });
    // 성공 구간이 2개 → 최소 4점(각 구간의 양끝)이 남는다
    expect(r.after).toBeGreaterThanOrEqual(4);
  });

  it('등속 직선은 허용 오차가 0 이어도 양끝 2점으로 줄어든다 (오차가 정말 0이라서)', () => {
    const clip = clipOf({ in: 0, out: 5000, speed: 1 });
    const r = trackToKeyframes({ frames: okFrames(40), clip, asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0 });
    expect(r.before).toBe(40);
    expect(r.after).toBe(2);
    expect(r.keyframes).toHaveLength(8);
  });

  it('흔들리는 궤적은 허용 오차가 클수록 줄어든다 (실제 추적기 출력 성질)', () => {
    const clip = clipOf({ in: 0, out: 5000, speed: 1 });
    // ±1px 정수 지터 — TrackerVit 이 실제로 이렇게 흔들린다
    const jitter = Array.from({ length: 40 }, (_, i) => ({
      ms: i * 100, x: 480 + i * 10 + ((i % 3) - 1), y: 270 + ((i * 7) % 3) - 1, w: 960, h: 540, ok: true,
    }));
    const fine = trackToKeyframes({ frames: jitter, clip, asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0.5 });
    const coarse = trackToKeyframes({ frames: jitter, clip, asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 4 });
    expect(fine.after).toBeGreaterThan(coarse.after);
    expect(coarse.after).toBeLessThanOrEqual(4);
    // 허용 오차는 «소스 픽셀» 단위이고 실제로 지켜진다
    expect(coarse.maxDeviationPx).toBeLessThanOrEqual(4 + 1e-6);
  });

  it('클립 밖의 파일 시각은 버린다', () => {
    // 클립은 in=1000..out=2000 (1초). 0..2900ms 프레임 중 앞뒤가 잘려 나간다.
    const clip = clipOf({ in: 1000, out: 2000, speed: 1, duration: 1000 });
    const r = trackToKeyframes({ frames: okFrames(30), clip, asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0 });
    expect(r.total).toBeLessThan(30);
    expect(r.keyframes.every((k) => k.time >= 0 && k.time <= 1000)).toBe(true);
  });

  it('loop 클립은 한 바퀴 결과를 duration 까지 반복 복제한다', () => {
    const clip = clipOf({ in: 0, out: 1000, speed: 1, duration: 3000, loop: true });
    const r = trackToKeyframes({ frames: okFrames(11), clip, asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0 });
    const times = [...new Set(r.keyframes.map((k) => k.time))];
    expect(Math.max(...times)).toBeGreaterThan(1000);
    expect(Math.max(...times)).toBeLessThanOrEqual(3000);
  });

  it('정규화 값이 마스크 상자 단위(0..1)로 나온다', () => {
    const r = trackToKeyframes({ frames: okFrames(3), clip: clipOf({ in: 0, out: 5000, speed: 1 }), asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0 });
    const first = r.keyframes.filter((k) => k.time === 0);
    expect(first.find((k) => k.prop === 'mask.x')!.value).toBeCloseTo(0.25);
    expect(first.find((k) => k.prop === 'mask.w')!.value).toBeCloseTo(0.5);
  });
});

describe('mergeMaskKeyframes — 「여기서 다시 추적」', () => {
  const kf = (time: number, prop: string) => ({ time, prop, value: 0.5, easing: 'linear' as const });

  it('추적 구간 밖의 앞쪽 마스크 키프레임은 보존한다', () => {
    const existing = [kf(0, 'mask.x'), kf(500, 'mask.x'), kf(2000, 'mask.x')];
    const merged = mergeMaskKeyframes(existing, [kf(1000, 'mask.x')], 1000, 3000);
    expect(merged.map((k) => k.time)).toEqual([0, 500, 1000]);
  });

  it('마스크 상자가 아닌 키프레임은 구간 안이어도 건드리지 않는다', () => {
    const existing = [kf(1500, 'opacity'), kf(1500, 'mask.feather'), kf(1500, 'mask.x')];
    const merged = mergeMaskKeyframes(existing, [], 1000, 2000);
    expect(merged.map((k) => k.prop).sort()).toEqual(['mask.feather', 'opacity']);
  });

  it('시각 오름차순으로 정렬해 돌려준다', () => {
    const merged = mergeMaskKeyframes([kf(3000, 'mask.x')], [kf(100, 'mask.x'), kf(50, 'mask.y')], 0, 200);
    expect(merged.map((k) => k.time)).toEqual([50, 100, 3000]);
  });
});

// ── 요청 검증 ─────────────────────────────────────────────────────────────

describe('validateTrackRequest', () => {
  const doc = (clip: VideoClip): ProjectDoc =>
    ({ id: 'p', assets: { a1: ASSET }, tracks: [{ id: 't', kind: 'video', clips: [clip] }] }) as unknown as ProjectDoc;

  it('마스크가 없으면 400 + «먼저 마스크를 켜라»', () => {
    const v = validateTrackRequest(doc(clipOf({ mask: undefined })), 'c1', {});
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('먼저 마스크를 켜고');
  });

  it('마스크가 여러 장이면 400 + «한 장만 남겨라»', () => {
    const m = { shape: 'rect' as const, feather: 0, x: 0, y: 0, w: 1, h: 1 };
    const v = validateTrackRequest(doc(clipOf({ mask: undefined, masks: [m, m] })), 'c1', {});
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('한 장만');
  });

  it('freeze 클립은 400 + 이유를 말한다', () => {
    const v = validateTrackRequest(doc(clipOf({ freeze: true })), 'c1', {});
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('정지화면');
  });

  it('box 를 안 주면 지금 마스크 상자를 쓴다', () => {
    const v = validateTrackRequest(doc(clipOf()), 'c1', {});
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.req.box).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });

  it('기본 허용 오차는 4px 이다 (0.5px 은 실측 감소율 0%)', () => {
    expect(DEFAULT_TOLERANCE_PX).toBe(4);
    const v = validateTrackRequest(doc(clipOf()), 'c1', {});
    if (v.ok) expect(v.req.tolerancePx).toBe(4);
  });

  it('잘못된 값은 400 — 크기 0 상자·범위 밖 허용치·구간 역전', () => {
    const bad = [
      { box: { x: 0, y: 0, w: 0, h: 0.5 } },
      { tolerancePx: -1 },
      { scoreThreshold: 2 },
      { stride: 0 },
      { startMs: 4000, endMs: 1000 },
    ];
    for (const body of bad) {
      const v = validateTrackRequest(doc(clipOf()), 'c1', body);
      expect(v.ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('endMs 는 클립 길이로 잘린다', () => {
    const v = validateTrackRequest(doc(clipOf()), 'c1', { endMs: 999999 });
    if (v.ok) expect(v.req.endMs).toBe(5000);
  });
});

describe('validateTrackRequest — 방향', () => {
  const doc = (clip: VideoClip): ProjectDoc =>
    ({ id: 'p', assets: { a1: ASSET }, tracks: [{ id: 't', kind: 'video', clips: [clip] }] }) as unknown as ProjectDoc;

  it('기본은 forward 다 — 기존 호출자의 뜻이 바뀌면 안 된다', () => {
    const v = validateTrackRequest(doc(clipOf()), 'c1', {});
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.req.direction).toBe('forward');
      expect(v.req.backEndMs).toBe(0);
    }
  });

  it('모르는 방향은 400 + 셋을 알려 준다', () => {
    const v = validateTrackRequest(doc(clipOf()), 'c1', { direction: '뒤로' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('forward');
  });

  it('backEndMs 는 기준 시각보다 뒤로 갈 수 없다 (잘린다)', () => {
    const v = validateTrackRequest(doc(clipOf()), 'c1', { startMs: 2000, backEndMs: 4000, direction: 'both' });
    if (v.ok) expect(v.req.backEndMs).toBe(2000);
  });

  it('음수 backEndMs 는 400', () => {
    expect(validateTrackRequest(doc(clipOf()), 'c1', { backEndMs: -1 }).ok).toBe(false);
  });

  it('클립 처음에서 backward 는 400 — 앞으로 갈 것이 없다', () => {
    const v = validateTrackRequest(doc(clipOf()), 'c1', { startMs: 0, direction: 'backward' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('뒤로 갈 구간이 없습니다');
  });

  it('클립 끝에서 backward 는 통과한다 (역방향만 도는 정상 요청)', () => {
    const v = validateTrackRequest(doc(clipOf()), 'c1', { startMs: 5000, direction: 'backward' });
    expect(v.ok).toBe(true);
  });

  it('both 는 한쪽만 있어도 통과한다 — 클립 처음에서 눌러도 앞으로만 돈다', () => {
    expect(validateTrackRequest(doc(clipOf()), 'c1', { startMs: 0, direction: 'both' }).ok).toBe(true);
    expect(validateTrackRequest(doc(clipOf()), 'c1', { startMs: 5000, direction: 'both' }).ok).toBe(true);
  });

  it('both 인데 앞뒤 어느 쪽도 없으면 400', () => {
    const v = validateTrackRequest(doc(clipOf({ duration: 5000 })), 'c1', {
      startMs: 0, endMs: 0, direction: 'both',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('앞뒤 어느 쪽도');
  });

  it('forward 기본에서 구간 역전은 여전히 400 (기존 규칙 그대로)', () => {
    expect(validateTrackRequest(doc(clipOf()), 'c1', { startMs: 4000, endMs: 1000 }).ok).toBe(false);
  });
});

// ── 라우트 ────────────────────────────────────────────────────────────────

describe('POST /clips/:clipId/track', () => {
  it('엔진이 없으면 501 + prewarm 안내 (잡을 만들지 않는다)', async () => {
    vi.mocked(isTrackerReady).mockResolvedValue(false);
    const res = await post({});
    expect(res.statusCode).toBe(501);
    expect((res.json() as { error: string }).error).toContain('prewarm.mjs tracker');
    expect(vi.mocked(trackBox)).not.toHaveBeenCalled();
  });

  it('없는 클립은 404', async () => {
    expect((await post({}, '없는클립')).statusCode).toBe(404);
  });

  it('성공하면 jobId 를 주고 mask.x/y/w/h 키프레임이 문서에 들어간다', async () => {
    vi.mocked(trackBox).mockResolvedValue({
      fps: 30, width: 1920, height: 1080,
      frames: Array.from({ length: 30 }, (_, i) => ({
        frame: i, ms: i * 33, x: 480 + i * i, y: 270, w: 960, h: 540, score: i === 0 ? 1 : 0.8,
      })),
    });
    const res = await post({ tolerancePx: 0 });
    expect(res.statusCode).toBe(200);
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const result = job.result as { keyframes: number; tracked: number; gaps: unknown[] };
    expect(result.keyframes).toBe(30 * 4); // 2차 곡선 + 허용오차 0 → 한 점도 못 줄인다
    expect(result.tracked).toBe(30);
    expect(result.gaps).toEqual([]);

    const doc = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).json().doc as ProjectDoc;
    const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
    const props = new Set((clip.keyframes ?? []).map((k) => k.prop));
    expect([...props].sort()).toEqual(['mask.h', 'mask.w', 'mask.x', 'mask.y']);
  });

  it('추적한 상자를 «소스 픽셀 → 클립 정규화» 로 옮겨 넣는다', async () => {
    vi.mocked(trackBox).mockResolvedValue({
      fps: 30, width: 1920, height: 1080,
      frames: [{ frame: 0, ms: 0, x: 960, y: 540, w: 192, h: 108, score: 1 }],
    });
    const res = await post({ tolerancePx: 0 });
    await waitJob((res.json() as { jobId: string }).jobId);
    const doc = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).json().doc as ProjectDoc;
    const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
    const at0 = (clip.keyframes ?? []).filter((k) => k.time === 0);
    expect(at0.find((k) => k.prop === 'mask.x')!.value).toBeCloseTo(0.5);
    expect(at0.find((k) => k.prop === 'mask.y')!.value).toBeCloseTo(0.5);
    expect(at0.find((k) => k.prop === 'mask.w')!.value).toBeCloseTo(0.1);
  });

  it('기준 프레임 뒤가 전부 실패하면 «놓친 구간» 으로 보고한다 (조용히 메우지 않는다)', async () => {
    // 상자가 화면을 통째로 덮으면 점수와 무관하게 실패다 (실측: 놓친 뒤 ViT 가 이렇게 된다).
    vi.mocked(trackBox).mockResolvedValue({
      fps: 30, width: 1920, height: 1080,
      frames: Array.from({ length: 10 }, (_, i) => ({
        frame: i, ms: i * 33,
        ...(i === 0 ? { x: 480, y: 270, w: 960, h: 540 } : { x: 0, y: 0, w: 1900, h: 1070 }),
        score: i === 0 ? 1 : 0.9,
      })),
    });
    const res = await post({});
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status, String(job.error)).toBe('done');
    const result = job.result as { tracked: number; frames: number; gaps: { startMs: number }[] };
    expect(result.tracked).toBe(1); // 사용자가 찍어 준 기준 상자만
    expect(result.frames).toBe(10);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.startMs).toBe(33);
  });

  it('파이썬이 프레임을 하나도 못 주면 잡이 «실패» 로 끝난다', async () => {
    vi.mocked(trackBox).mockResolvedValue({ fps: 30, width: 1920, height: 1080, frames: [] });
    const res = await post({});
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status).toBe('error');
    expect(String(job.error)).toContain('추적에 성공한 프레임이 없습니다');
  });

  it('시작 상자를 «소스 픽셀» 로 바꿔 파이썬에 넘긴다', async () => {
    vi.mocked(trackBox).mockResolvedValue({
      fps: 30, width: 1920, height: 1080,
      frames: [{ frame: 0, ms: 0, x: 480, y: 270, w: 960, h: 540, score: 1 }],
    });
    const res = await post({ box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
    await waitJob((res.json() as { jobId: string }).jobId);
    expect(vi.mocked(trackBox).mock.calls[0]![1]).toMatchObject({
      box: { x: 480, y: 270, w: 960, h: 540 },
    });
  });
});

// ── 양방향 ────────────────────────────────────────────────────────────────

describe('POST /track — 방향', () => {
  const ANCHOR_FRAME = 75; // 2500ms @30fps
  /** x 를 2차 곡선으로 둔다 — 허용오차 0 에서 RDP 가 한 점도 못 줄이게 하려는 것. */
  const mk = (frame: number, score: number) => ({
    frame,
    ms: Math.round((frame * 1000) / 30),
    x: 480 + frame * frame * 0.02,
    y: 270, w: 960, h: 540, score,
  });
  const fwdResult = {
    fps: 30, width: 1920, height: 1080,
    frames: Array.from({ length: 76 }, (_, i) => mk(ANCHOR_FRAME + i, i === 0 ? 1 : 0.9)),
  };
  // 역방향은 **추적 순서**(기준이 먼저, 프레임 번호가 줄어든다)로 온다
  const backResult = {
    fps: 30, width: 1920, height: 1080,
    frames: Array.from({ length: 76 }, (_, i) => mk(ANCHOR_FRAME - i, i === 0 ? 1 : 0.9)),
  };
  const byDirection = () =>
    vi.mocked(trackBox).mockImplementation(async (_m: string, o: { direction?: string }) =>
      (o.direction === 'backward' ? backResult : fwdResult) as never,
    );

  const maskXTimes = async (): Promise<number[]> => {
    const doc = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).json().doc as ProjectDoc;
    const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
    return (clip.keyframes ?? []).filter((k) => k.prop === 'mask.x').map((k) => k.time);
  };

  const setKeyframes = (keyframes: unknown[]) =>
    app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/commands`,
      payload: { commands: [{ type: 'setKeyframes', clipId, keyframes }] },
    });

  it('기본(방향 없음)은 예전과 똑같이 «앞으로 한 번»만 부른다', async () => {
    vi.mocked(trackBox).mockResolvedValue(fwdResult);
    const res = await post({ startMs: 2500 });
    await waitJob((res.json() as { jobId: string }).jobId);
    expect(vi.mocked(trackBox)).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(trackBox).mock.calls[0]![1] as { direction?: string; startMs: number; endMs: number };
    expect(opts.direction).toBe('forward');
    expect(opts.startMs).toBe(2500);
    expect(opts.endMs).toBe(5000);
  });

  it('both 은 파이썬을 두 번 부른다 — 같은 기준 시각에서 앞으로 한 번, 뒤로 한 번', async () => {
    byDirection();
    const res = await post({ startMs: 2500, direction: 'both', tolerancePx: 0 });
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status, String(job.error)).toBe('done');
    const calls = vi.mocked(trackBox).mock.calls.map((c) => c[1] as { direction?: string; startMs: number; endMs: number });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.direction ?? 'forward').sort()).toEqual(['backward', 'forward']);
    // 두 패스 모두 **기준 상자의 시각**에서 출발한다 (반대편 끝만 다르다)
    expect(calls.every((c) => c.startMs === 2500)).toBe(true);
    expect(calls.find((c) => c.direction === 'backward')!.endMs).toBe(0);
    expect(calls.find((c) => (c.direction ?? 'forward') === 'forward')!.endMs).toBe(5000);
  });

  it('backward 만 요청하면 파이썬을 한 번, 뒤로만 부른다', async () => {
    byDirection();
    const res = await post({ startMs: 5000, direction: 'backward' });
    await waitJob((res.json() as { jobId: string }).jobId);
    expect(vi.mocked(trackBox)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(trackBox).mock.calls[0]![1] as { direction?: string }).direction).toBe('backward');
  });

  it('backEndMs 는 «뒤로 어디까지» 다 — 파이썬의 반대편 끝으로 간다', async () => {
    byDirection();
    const res = await post({ startMs: 2500, direction: 'backward', backEndMs: 1000 });
    await waitJob((res.json() as { jobId: string }).jobId);
    expect(vi.mocked(trackBox).mock.calls[0]![1]).toMatchObject({ startMs: 2500, endMs: 1000 });
  });

  it('양방향 이음매 — 기준 시각의 키프레임이 «한 벌»뿐이고 앞뒤가 이어진다', async () => {
    byDirection();
    const res = await post({ startMs: 2500, direction: 'both', tolerancePx: 0 });
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status, String(job.error)).toBe('done');
    const times = await maskXTimes();
    expect(times.filter((t) => t === 2500)).toHaveLength(1); // 겹치지 않는다
    expect(new Set(times).size).toBe(times.length);
    expect(Math.min(...times)).toBe(0); // 앞쪽 끝까지
    expect(Math.max(...times)).toBe(5000); // 뒤쪽 끝까지
    // 기준 시각을 사이에 두고 «빈 구간»이 생기지 않는다 (프레임 간격 33ms 를 넘는 틈이 없다)
    const sorted = [...times].sort((a, b) => a - b);
    const maxGap = Math.max(...sorted.slice(1).map((t, i) => t - sorted[i]!));
    expect(maxGap).toBeLessThanOrEqual(34);
  });

  it('forward 는 기준 «앞쪽» 키프레임을 그대로 둔다 — 「여기서 다시 추적」의 약속', async () => {
    vi.mocked(trackBox).mockResolvedValue(fwdResult);
    await setKeyframes([{ time: 150, prop: 'mask.x', value: 0.1, easing: 'linear' }]);
    const res = await post({ startMs: 2500 });
    await waitJob((res.json() as { jobId: string }).jobId);
    expect((await maskXTimes()).includes(150)).toBe(true);
  });

  it('both 은 기준 앞쪽까지 새로 만든다 — 그래서 기본값이 아니다', async () => {
    byDirection();
    await setKeyframes([{ time: 150, prop: 'mask.x', value: 0.1, easing: 'linear' }]);
    const res = await post({ startMs: 2500, direction: 'both', tolerancePx: 0 });
    await waitJob((res.json() as { jobId: string }).jobId);
    const times = await maskXTimes();
    expect(times.includes(150)).toBe(false); // 갈아 끼웠다 (150ms 는 추적 프레임 시각이 아니다)
    expect(times.length).toBeGreaterThan(100);
  });

  it('진행률은 앞·뒤를 합쳐 «하나»로 온다 (앞이 끝나면 절반)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(trackBox).mockImplementation(async (_m: string, o: { direction?: string; onProgress?: (p: number, d: number, t: number) => void }) => {
      if (o.direction === 'backward') {
        o.onProgress?.(0, 0, 75); // 아직 한 프레임도 안 했다
        await gate;
        return backResult as never;
      }
      o.onProgress?.(1, 76, 76); // 앞쪽은 끝났다
      return fwdResult as never;
    });
    const res = await post({ startMs: 2500, direction: 'both' });
    const jobId = (res.json() as { jobId: string }).jobId;
    let seen = { progress: 0, detail: '' };
    for (let i = 0; i < 400; i++) {
      const j = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json() as { progress: number; detail?: string };
      if ((j.detail ?? '').includes('앞쪽')) { seen = { progress: j.progress, detail: j.detail! }; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await waitJob(jobId);
    // 구간이 2500ms 로 같으니 앞쪽만 끝난 시점의 합산 진행률은 0.5 다 (1.0 이 아니다)
    expect(seen.progress).toBeCloseTo(0.5, 2);
    expect(seen.detail).toContain('앞쪽');
  });
});

describe('키프레임 시각 중복 방지', () => {
  it('배속이 커서 두 프레임이 같은 정수 ms 로 반올림돼도 키프레임은 한 벌만 나온다', () => {
    // speed 100 → 소스 33ms 간격이 클립에서 0.33ms 간격이 된다 → 여러 프레임이 같은 정수로 반올림
    const clip = clipOf({ in: 0, out: 5000, speed: 100, duration: 50 });
    const frames = Array.from({ length: 30 }, (_, i) => ({
      ms: i * 33, x: 480 + i * i, y: 270, w: 960, h: 540, ok: true,
    }));
    const r = trackToKeyframes({ frames, clip, asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0 });
    const seen = new Map<number, number>();
    for (const k of r.keyframes.filter((x) => x.prop === 'mask.x')) {
      seen.set(k.time, (seen.get(k.time) ?? 0) + 1);
    }
    for (const [time, n] of seen) expect(n, `time ${time}`).toBe(1);
  });

  it('loop 반복 복제에서도 이음매 시각이 겹치지 않는다', () => {
    const clip = clipOf({ in: 0, out: 1000, speed: 1, duration: 3000, loop: true });
    const frames = Array.from({ length: 11 }, (_, i) => ({
      ms: i * 100, x: 480 + i * i * 3, y: 270, w: 960, h: 540, ok: true,
    }));
    const r = trackToKeyframes({ frames, clip, asset: ASSET, fileW: 1920, fileH: 1080, tolerancePx: 0 });
    const times = r.keyframes.filter((k) => k.prop === 'mask.x').map((k) => k.time);
    expect(new Set(times).size).toBe(times.length);
  });
});
