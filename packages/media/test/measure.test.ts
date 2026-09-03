// F4 컷별 색 맞추기 — «측정» 의 실측 검증 (계획 04 검증 1·2·3).
// 「돌아간다」가 아니라 숫자로 낸다: 색차가 몇 % 줄었는지, 강도 0.5 가 정말 절반인지,
// 5장이 20장과 같은 값을 내는지.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clippedFraction,
  matchAffine,
  measureChannelHistograms,
  measureChannelStats,
  predictAfter,
  sampleTimesMs,
  statsFromHistogram,
} from '../src/measure.js';
import { matchColorLevels, type MatchLevels } from '../src/derive.js';

const T = 120_000;

let dir: string;
let refWarm: string;   // 같은 장면 · 따뜻하고 밝음
let tgtCold: string;   // 같은 장면 · 차갑고 어두움
let otherContent: string; // «내용이 다른» 컷 (같은 색 왜곡)
let refWarmRgb: string;   // 위와 같지만 무손실 rgb24 — 코덱 손실을 분리해 재기 위해
let tgtColdRgb: string;
let clippedRef: string;   // 0·255 에 절반이 붙은 «뭉갠» 소스 (컬러바)
let clippedTgt: string;

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p'];
const FFV1 = ['-c:v', 'ffv1', '-pix_fmt', 'rgb24'];

/**
 * 2초 320x180 30fps. vf 로 색을 갈라 놓는다.
 *
 * 기본 소스가 `mandelbrot` 인 이유: **연속 계조라 0·255 에 붙은 픽셀이 10% 안쪽**이다.
 * `testsrc2`·`smptebars` 는 순수 원색 판이라 픽셀의 46~80%가 이미 뭉개져 있고,
 * 그런 소스에서는 어떤 사상을 걸어도 μ 를 기준에 맞출 수 없다(아래 「뭉갠 소스」 테스트가
 * 그 사실을 숫자로 남긴다). 실사 영상은 연속 계조 쪽에 가깝다.
 */
async function makeClip(out: string, source: string, vf: string, enc = X264): Promise<void> {
  const input = source.includes('=') ? source : `${source}=size=320x180:rate=30`;
  await execa('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', input, '-t', '2',
    '-vf', vf, ...enc, out,
  ]);
}

const WARM = 'colorbalance=rm=0.15:bm=-0.15,eq=brightness=0.05:contrast=1.15';
const COLD = 'colorbalance=rm=-0.15:bm=0.15,eq=brightness=-0.08:contrast=0.85';

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kitkat-measure-'));
  refWarm = path.join(dir, 'ref-warm.mp4');
  tgtCold = path.join(dir, 'tgt-cold.mp4');
  otherContent = path.join(dir, 'other.mp4');
  refWarmRgb = path.join(dir, 'ref-warm.mkv');
  tgtColdRgb = path.join(dir, 'tgt-cold.mkv');
  clippedRef = path.join(dir, 'clip-ref.mp4');
  clippedTgt = path.join(dir, 'clip-tgt.mp4');
  await makeClip(refWarm, 'mandelbrot', WARM);
  await makeClip(tgtCold, 'mandelbrot', COLD);
  // 「내용이 다른 컷」 — 만델브로트와 공통점이 없는 연속 계조 화면
  await makeClip(otherContent, 'gradients=size=320x180:rate=30:nb_colors=4:c0=#402060:c1=#20a080:c2=#c08040:c3=#204080', COLD);
  await makeClip(refWarmRgb, 'mandelbrot', WARM, FFV1);
  await makeClip(tgtColdRgb, 'mandelbrot', COLD, FFV1);
  await makeClip(clippedRef, 'testsrc2', WARM);
  await makeClip(clippedTgt, 'testsrc2', COLD);
}, T);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stats3 = (h: Awaited<ReturnType<typeof measureChannelHistograms>>['hist']) =>
  h.map(statsFromHistogram) as [ReturnType<typeof statsFromHistogram>, ReturnType<typeof statsFromHistogram>, ReturnType<typeof statsFromHistogram>];

/** 채널별 |Δμ| 합 (0..255 단위) — W7 실측과 같은 척도. */
function deltaSum(
  a: ReturnType<typeof stats3>,
  b: ReturnType<typeof stats3>,
): { total: number; per: number[] } {
  const per = [0, 1, 2].map((i) => Math.abs(a[i]!.mean - b[i]!.mean) * 255);
  return { total: per.reduce((x, y) => x + y, 0), per };
}

/** 대상 파일을 colorlevels 로 구워서 실제 파일을 만든다 (derive 와 같은 필터 문자열). */
async function bake(
  src: string,
  out: string,
  levels: MatchLevels,
  strength: number,
  enc = X264,
): Promise<void> {
  await execa('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y', '-i', src,
    '-vf', matchColorLevels(levels, strength), ...enc, out,
  ]);
}

/** 두 파일을 재고 맞춘 뒤, 「전 → 후」 색차와 감소율을 낸다. */
async function matchAndMeasure(
  refSrc: string,
  tgtSrc: string,
  out: string,
  strength = 1,
  enc = X264,
): Promise<{ before: number; after: number; predicted: number; reduction: number; perBefore: number[]; perAfter: number[] }> {
  const ref = await measureChannelHistograms(refSrc, ALL);
  const tgt = await measureChannelHistograms(tgtSrc, ALL);
  const refS = stats3(ref.hist);
  const tgtS = stats3(tgt.hist);
  const levels: MatchLevels = { sampledAtMs: tgt.usedMs, refSourceKey: 'raw', ref: refS, target: tgtS };
  await bake(tgtSrc, out, levels, strength, enc);
  const actual = stats3((await measureChannelHistograms(out, ALL)).hist);
  const before = deltaSum(refS, tgtS);
  const after = deltaSum(refS, actual);
  // 사상만 적용한 «예측» — 코덱 손실 없이 클리핑만 반영된 값
  const predicted = [0, 1, 2]
    .map((i) => {
      const { a, b } = matchAffine(refS[i]!, tgtS[i]!, strength);
      return Math.abs(refS[i]!.mean - predictAfter(tgt.hist[i]!, a, b).stat.mean) * 255;
    })
    .reduce((x, y) => x + y, 0);
  return {
    before: before.total,
    after: after.total,
    predicted,
    reduction: 1 - after.total / before.total,
    perBefore: before.per,
    perAfter: after.per,
  };
}

const ALL = { atMs: sampleTimesMs(0, 2000) };

describe('sampleTimesMs', () => {
  it('양 끝 5%를 잘라낸 균등 5장', () => {
    expect(sampleTimesMs(0, 1000)).toEqual([50, 275, 500, 725, 950]);
  });
  it('클립 구간(in..out)을 그대로 따른다', () => {
    expect(sampleTimesMs(2000, 4000)).toEqual([2100, 2550, 3000, 3450, 3900]);
  });
  it('길이 0이면 한 장', () => {
    expect(sampleTimesMs(500, 500)).toEqual([500]);
  });
});

describe('statsFromHistogram', () => {
  it('단색이면 σ=0', () => {
    const h = new Uint32Array(256);
    h[128] = 1000;
    const s = statsFromHistogram(h);
    expect(s.mean).toBeCloseTo(128 / 255, 6);
    expect(s.std).toBe(0);
  });
  it('0과 255 절반씩이면 μ=0.5 σ=0.5', () => {
    const h = new Uint32Array(256);
    h[0] = 500;
    h[255] = 500;
    const s = statsFromHistogram(h);
    expect(s.mean).toBeCloseTo(0.5, 6);
    expect(s.std).toBeCloseTo(0.5, 6);
  });
});

describe('색 맞추기 실측 — 같은 장면, 따뜻·밝음 ↔ 차갑·어두움', () => {
  it(
    '무손실(rgb24) 파이프라인에서 94% 이상 줄어든다 — W7 실측 재현',
    async () => {
      const r = await matchAndMeasure(refWarmRgb, tgtColdRgb, path.join(dir, 'matched.mkv'), 1, FFV1);
      console.log(
        `[F4 실측·무손실] 전 ${r.before.toFixed(1)} (R ${r.perBefore[0]!.toFixed(1)} G ${r.perBefore[1]!.toFixed(1)} B ${r.perBefore[2]!.toFixed(1)})` +
          ` → 후 ${r.after.toFixed(1)} (R ${r.perAfter[0]!.toFixed(1)} G ${r.perAfter[1]!.toFixed(1)} B ${r.perAfter[2]!.toFixed(1)})` +
          ` = ${(r.reduction * 100).toFixed(1)}% 감소 · 사상만(예측) ${(100 * (1 - r.predicted / r.before)).toFixed(1)}%`,
      );
      expect(r.before).toBeGreaterThan(20);
      expect(r.reduction).toBeGreaterThan(0.94);
    },
    T,
  );

  it(
    '실제 파생 경로(yuv420p/x264)에서도 90% 이상 줄어든다',
    async () => {
      // 무손실 대비 2%p 정도가 4:2:0 크로마 서브샘플링 + 리미티드 레인지 양자화로 사라진다.
      // 그건 파생 파이프라인 전체(LUT·손떨림)가 공유하는 손실이지 색 맞추기의 오차가 아니다.
      const r = await matchAndMeasure(refWarm, tgtCold, path.join(dir, 'matched.mp4'));
      console.log(
        `[F4 실측·yuv420p] 전 ${r.before.toFixed(1)} → 후 ${r.after.toFixed(1)} = ${(r.reduction * 100).toFixed(1)}% 감소` +
          ` (사상만 ${(100 * (1 - r.predicted / r.before)).toFixed(1)}%)`,
      );
      expect(r.reduction).toBeGreaterThan(0.9);
    },
    T,
  );

  it(
    '내용이 다른 두 컷도 80% 이상 줄어든다',
    async () => {
      const r = await matchAndMeasure(refWarm, otherContent, path.join(dir, 'matched-other.mp4'));
      console.log(`[F4 실측·내용 다름] 전 ${r.before.toFixed(1)} → 후 ${r.after.toFixed(1)} = ${(r.reduction * 100).toFixed(1)}% 감소`);
      expect(r.reduction).toBeGreaterThan(0.8);
    },
    T,
  );

  it(
    '이미 뭉갠 소스(0·255 에 46% 이상)는 덜 줄어든다 — 한계를 숫자로 남긴다',
    async () => {
      const tgt = await measureChannelHistograms(clippedTgt, ALL);
      const clipped = [0, 1, 2].map((i) => {
        const c = clippedFraction(tgt.hist[i]!);
        return c.low + c.high;
      });
      const r = await matchAndMeasure(clippedRef, clippedTgt, path.join(dir, 'matched-clipped.mp4'));
      console.log(
        `[F4 실측·뭉갠 소스] 대상 클리핑 ${clipped.map((c) => (c * 100).toFixed(0) + '%').join('/')} → ` +
          `전 ${r.before.toFixed(1)} → 후 ${r.after.toFixed(1)} = ${(r.reduction * 100).toFixed(1)}% 감소`,
      );
      // 클리핑된 픽셀은 어떤 선형 사상으로도 되살릴 수 없다 — 80% 언저리가 상한이다.
      expect(Math.max(...clipped)).toBeGreaterThan(0.4);
      expect(r.reduction).toBeGreaterThan(0.75);
      expect(r.reduction).toBeLessThan(0.94);
    },
    T,
  );

  it(
    '강도 0.5 는 감소량의 절반 ±5%p, 강도 0 은 항등',
    async () => {
      const ref = await measureChannelHistograms(refWarm, ALL);
      const tgt = await measureChannelHistograms(tgtCold, ALL);
      const refS = stats3(ref.hist);
      const tgtS = stats3(tgt.hist);
      const levels: MatchLevels = {
        sampledAtMs: tgt.usedMs, refSourceKey: 'raw', ref: refS, target: tgtS,
      };
      const before = deltaSum(refS, tgtS).total;

      const half = path.join(dir, 'half.mp4');
      await bake(tgtCold, half, levels, 0.5);
      const halfDelta = deltaSum(refS, stats3((await measureChannelHistograms(half, ALL)).hist)).total;
      const full = path.join(dir, 'full.mp4');
      await bake(tgtCold, full, levels, 1);
      const fullDelta = deltaSum(refS, stats3((await measureChannelHistograms(full, ALL)).hist)).total;

      const halfRatio = (before - halfDelta) / (before - fullDelta);
      console.log(
        `[F4 강도] s=0 ${before.toFixed(1)} · s=0.5 ${halfDelta.toFixed(1)} · s=1 ${fullDelta.toFixed(1)} → 절반 비율 ${(halfRatio * 100).toFixed(1)}%`,
      );
      expect(halfRatio).toBeGreaterThan(0.45);
      expect(halfRatio).toBeLessThan(0.55);

      // s=0 은 항등 — colorlevels 인자가 «아무것도 안 하는» 값이어야 한다.
      const zero = matchColorLevels(levels, 0);
      for (const ch of ['r', 'g', 'b']) {
        expect(zero).toContain(`${ch}imin=0`);
        expect(zero).toContain(`${ch}imax=1`);
        expect(zero).toContain(`${ch}omin=0`);
        expect(zero).toContain(`${ch}omax=1`);
      }
    },
    T,
  );
});

describe('샘플 프레임 수 — 5장이면 충분한가 (계획 04 검증 3)', () => {
  it(
    '5장이 20장 대비 채널 μ 차 2/255 이내',
    async () => {
      for (const [name, src] of [['조명 고정', tgtCold], ['내용 변화', refWarm]] as const) {
        const one = await measureChannelStats(src, { atMs: sampleTimesMs(0, 2000, 1) });
        const five = await measureChannelStats(src, { atMs: sampleTimesMs(0, 2000, 5) });
        const twenty = await measureChannelStats(src, { atMs: sampleTimesMs(0, 2000, 20) });
        const diff = (a: typeof five, b: typeof five) =>
          Math.max(...[0, 1, 2].map((i) => Math.abs(a[i]!.mean - b[i]!.mean) * 255));
        const diffStd = (a: typeof five, b: typeof five) =>
          Math.max(...[0, 1, 2].map((i) => Math.abs(a[i]!.std - b[i]!.std) * 255));
        console.log(
          `[F4 샘플수·${name}] 1↔20 μ차 ${diff(one, twenty).toFixed(2)} σ차 ${diffStd(one, twenty).toFixed(2)} · ` +
            `5↔20 μ차 ${diff(five, twenty).toFixed(2)} σ차 ${diffStd(five, twenty).toFixed(2)}`,
        );
        expect(diff(five, twenty)).toBeLessThan(2);
      }
    },
    T,
  );

  it(
    '프레임별 평균의 평균은 σ 를 과소평가한다 — 픽셀을 한 통에 넣는 이유',
    async () => {
      const times = sampleTimesMs(0, 2000);
      const pooled = await measureChannelStats(refWarm, { atMs: times });
      const perFrame = await Promise.all(times.map((t) => measureChannelStats(refWarm, { atMs: [t] })));
      const avgOfStd = [0, 1, 2].map(
        (i) => perFrame.reduce((s, f) => s + f[i]!.std, 0) / perFrame.length,
      );
      console.log(
        `[F4 풀링] 합친 σ ${(pooled[0]!.std * 255).toFixed(2)} vs 프레임별 σ 평균 ${(avgOfStd[0]! * 255).toFixed(2)}`,
      );
      for (let i = 0; i < 3; i++) expect(pooled[i]!.std).toBeGreaterThanOrEqual(avgOfStd[i]! - 1e-9);
    },
    T,
  );
});

describe('예측이 실제와 맞는가', () => {
  it(
    'predictAfter 의 μ 예측이 «무손실로» 구운 파일과 1/255 이내',
    async () => {
      const ref = await measureChannelHistograms(refWarmRgb, ALL);
      const tgt = await measureChannelHistograms(tgtColdRgb, ALL);
      const refS = stats3(ref.hist);
      const tgtS = stats3(tgt.hist);
      const levels: MatchLevels = { sampledAtMs: tgt.usedMs, refSourceKey: 'raw', ref: refS, target: tgtS };
      const out = path.join(dir, 'predict.mkv');
      await bake(tgtColdRgb, out, levels, 1, FFV1);
      const actual = stats3((await measureChannelHistograms(out, ALL)).hist);
      for (let i = 0; i < 3; i++) {
        const { a, b } = matchAffine(refS[i]!, tgtS[i]!, 1);
        const p = predictAfter(tgt.hist[i]!, a, b);
        expect(Math.abs(p.stat.mean - actual[i]!.mean) * 255).toBeLessThan(1);
      }
    },
    T,
  );

  it(
    'colorlevels 가 실제 픽셀에서 내는 사상이 a·in+b 와 2/255 이내 — 음수 imin 회귀 방지',
    async () => {
      // 0..255 램프를 rawvideo 로 바로 통과시켜 «필터만» 잰다 (인코딩·색공간 개입 없음).
      const W = 256;
      const ramp = Buffer.alloc(W * 3);
      for (let x = 0; x < W; x++) {
        ramp[x * 3] = x;
        ramp[x * 3 + 1] = x;
        ramp[x * 3 + 2] = x;
      }
      // b>0(밝히기)이 포함된 조합들 — 옛 역산은 여기서 imin 이 음수가 되어 필터가
      // «프레임에서 자동 검출» 모드로 떨어졌다(최대 39/255 어긋남).
      const cases: [number, number][] = [[1.35, 0.18], [0.8, 0.1], [0.3, 0.35], [1.6, -0.25], [1.15, 0.05]];
      let worstAll = 0;
      for (const [a, b] of cases) {
        // a·in+b 를 그대로 내는 levels 를 만든다: σ_ref/σ_tgt = a, μ_ref = a·μ_tgt + b
        const muT = 0.4;
        const sdT = 0.2;
        const levels: MatchLevels = {
          sampledAtMs: [0], refSourceKey: 'raw',
          ref: [0, 1, 2].map(() => ({ mean: a * muT + b, std: a * sdT })) as never,
          target: [0, 1, 2].map(() => ({ mean: muT, std: sdT })) as never,
        };
        const args = matchColorLevels(levels, 1);
        expect(args).not.toMatch(/imin=-/); // 음수 imin 은 «자동 검출» 신호다 — 절대 내면 안 된다
        expect(args).not.toMatch(/imax=-/);
        const { stdout } = await execa(
          'ffmpeg',
          ['-hide_banner', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x1`,
           '-i', 'pipe:0', '-vf', args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
          { input: ramp, encoding: 'buffer', maxBuffer: 10e6 },
        );
        const out = Buffer.from(stdout);
        let worst = 0;
        for (let x = 0; x < W; x++) {
          const want = Math.min(255, Math.max(0, (a * (x / 255) + b) * 255));
          worst = Math.max(worst, Math.abs(out[x * 3]! - want));
        }
        worstAll = Math.max(worstAll, worst);
        expect(worst).toBeLessThan(2);
      }
      console.log(`[F4 필터 정확도] 램프 0..255 최대오차 ${worstAll.toFixed(2)}/255`);
    },
    T,
  );

  it(
    'matchAffine 이 derive 의 colorlevels 문자열과 같은 사상을 낸다',
    () => {
      const mk = (m: number, s: number) => ({ mean: m, std: s });
      const levels: MatchLevels = {
        sampledAtMs: [0], refSourceKey: 'raw',
        ref: [mk(0.47, 0.46), mk(0.52, 0.47), mk(0.5, 0.5)],
        target: [mk(0.41, 0.4), mk(0.36, 0.35), mk(0.28, 0.26)],
      };
      for (const s of [0, 0.25, 0.5, 0.75, 1]) {
        const args = matchColorLevels(levels, s);
        for (let i = 0; i < 3; i++) {
          const ch = 'rgb'[i]!;
          const get = (k: string) => Number(new RegExp(`${ch}${k}=(-?[0-9.]+)`).exec(args)![1]);
          const imin = get('imin');
          const imax = get('imax');
          const omin = get('omin');
          const omax = get('omax');
          const { a, b } = matchAffine(levels.ref[i]!, levels.target[i]!, s);
          for (let x = 0; x <= 255; x++) {
            const inV = x / 255;
            const filter = Math.min(1, Math.max(0, ((inV - imin) * (omax - omin)) / (imax - imin) + omin));
            const mine = Math.min(1, Math.max(0, a * inV + b));
            expect(Math.abs(filter - mine)).toBeLessThan(1 / 255);
          }
        }
      }
    },
  );
});

describe('영역 지정', () => {
  it(
    '왼쪽 절반과 오른쪽 절반의 통계가 다르다 (crop 이 실제로 걸린다)',
    async () => {
      const left = await measureChannelStats(refWarm, { atMs: [500], region: { x: 0, y: 0, w: 0.5, h: 1 } });
      const right = await measureChannelStats(refWarm, { atMs: [500], region: { x: 0.5, y: 0, w: 0.5, h: 1 } });
      const whole = await measureChannelStats(refWarm, { atMs: [500] });
      const diff = Math.max(...[0, 1, 2].map((i) => Math.abs(left[i]!.mean - right[i]!.mean) * 255));
      expect(diff).toBeGreaterThan(2);
      // 전체는 두 반쪽 사이에 있다
      for (let i = 0; i < 3; i++) {
        const lo = Math.min(left[i]!.mean, right[i]!.mean);
        const hi = Math.max(left[i]!.mean, right[i]!.mean);
        expect(whole[i]!.mean).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(whole[i]!.mean).toBeLessThanOrEqual(hi + 1e-6);
      }
    },
    T,
  );

  it('0픽셀 영역은 최소 1픽셀로 올라간다(에러가 아니라 측정된다)', async () => {
    const s = await measureChannelStats(refWarm, {
      atMs: [500],
      region: { x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 },
    });
    expect(s).toHaveLength(3);
  }, T);

  it('디코드할 프레임이 없으면 조용히 넘어가지 않고 throw', async () => {
    await expect(measureChannelStats(path.join(dir, '없는파일.mp4'), { atMs: [0] })).rejects.toThrow();
  }, T);
});

describe('손떨림 보정과의 상호작용 (계획 04 「⚠️ 확인 필요」)', () => {
  it(
    '보정 전후로 색 통계가 1/255 넘게 달라지고, stabilize 옵션이 «보정 후» 값을 낸다',
    async () => {
      const shake = path.join(dir, 'shake.mp4');
      await execa('ffmpeg', [
        '-hide_banner', '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'mandelbrot=size=320x180:rate=30', '-t', '2',
        '-vf', 'crop=280:160:20+10*sin(t*9):10+8*cos(t*7)', ...X264, shake,
      ]);
      // 파생이 실제로 굽는 것과 같은 2패스 (derive.ts 와 같은 인자)
      const trf = path.join(dir, 'tr.trf');
      await execa('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', shake,
        '-vf', 'vidstabdetect=shakiness=5:result=tr.trf', '-f', 'null', '-'], { cwd: dir });
      const stabBaked = path.join(dir, 'stab.mp4');
      await execa('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', shake,
        '-vf', 'vidstabtransform=input=tr.trf:smoothing=10,unsharp=5:5:0.8:3:3:0.4',
        ...X264, stabBaked], { cwd: dir });
      expect(trf).toBeTruthy();

      const times = { atMs: sampleTimesMs(0, 2000) };
      const raw = await measureChannelStats(shake, times);
      const viaOption = await measureChannelStats(shake, { ...times, stabilize: { smoothing: 10 } });
      const baked = await measureChannelStats(stabBaked, times);

      const diff = (a: typeof raw, b: typeof raw) =>
        Math.max(...[0, 1, 2].map((i) => Math.abs(a[i]!.mean - b[i]!.mean) * 255));
      console.log(
        `[F4 stabilize] 원본↔보정후 μ차 ${diff(raw, baked).toFixed(2)}/255 · ` +
          `stabilize 옵션↔구운 파일 μ차 ${diff(viaOption, baked).toFixed(2)}/255`,
      );
      // 1/255 를 넘으므로 대상 측정은 «보정 후» 에서 해야 한다 (계획 04 의 판정 기준)
      expect(diff(raw, baked)).toBeGreaterThan(1);
      // 옵션을 쓰면 실제로 구워질 파일과 같은 값이 나온다 (인코딩 손실만 남는다)
      expect(diff(viaOption, baked)).toBeLessThan(2);
    },
    T,
  );
});

describe('클리핑 경고용 계산', () => {
  it('과보정하면 0·255 에 몰린 비율이 는다', async () => {
    const tgt = await measureChannelHistograms(tgtCold, ALL);
    const before = clippedFraction(tgt.hist[0]!);
    // 대비를 3배로 올리는 극단적 사상
    const after = predictAfter(tgt.hist[0]!, 3, -0.6);
    expect(after.clipped.low + after.clipped.high).toBeGreaterThan(before.low + before.high);
  }, T);
});
