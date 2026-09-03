// F4 컷별 색 맞추기 — «통계 측정». derive.ts 가 굽는 colorlevels 의 입력을 여기서 만든다.
//
// signalstats 는 YUV 기준이라 RGB 채널별 μ·σ 를 안 준다 → rawvideo 로 받아 여기서 직접 센다.
// media 패키지는 @kitkat/schema 에 의존하지 않는다 (derive.ts 와 같은 규칙).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffprobeJson, runFfmpeg, runFfmpegBuffer } from './ffmpeg.js';
import type { ChannelStat } from './derive.js';

/** 0..1 정규화 사각형 (schema 의 Crop 과 같은 모양). */
export type Region = { x: number; y: number; w: number; h: number };

/** 채널 하나의 256칸 히스토그램. 8비트 소스에서는 이것이 «채널의 완전한 요약» 이다. */
export type ChannelHistogram = Uint32Array;

/** 한 프레임 rawvideo 버퍼 상한 — 8K(7680×4320×3 = 99.5MB)까지 통과시킨다. */
const FRAME_MAX_BYTES = 128 * 1024 * 1024;

/** 기본 샘플 장수 (계획 04). 「검증」에서 1·5·20장을 비교해 5장으로 확정했다. */
export const DEFAULT_SAMPLE_COUNT = 5;

/**
 * 클립 [inMs, outMs] 를 균등 간격으로 count 장 뽑는 시각들.
 *
 * **양 끝 5% 를 잘라내는 이유:** 소스 자체에 페이드가 걸려 있으면 그 프레임은 색이 다른 화면이다.
 * **한 장이 아닌 이유:** 그 프레임에 우연히 큰 빨간 물체가 지나가면 통계가 통째로 튄다.
 * **중앙 한 장이 아닌 이유:** 컷 안에서 조명이 변하는 경우(창가로 걸어가는 인물)를 못 잡는다.
 *
 * t_k = in + (out−in)·(0.05 + 0.9·k/(count−1)),  k = 0..count−1
 */
export function sampleTimesMs(inMs: number, outMs: number, count = DEFAULT_SAMPLE_COUNT): number[] {
  const span = Math.max(0, outMs - inMs);
  const n = Math.max(1, Math.floor(count));
  if (span <= 0) return [Math.max(0, Math.round(inMs))];
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const u = n === 1 ? 0.5 : 0.05 + (0.9 * k) / (n - 1);
    const t = Math.max(0, Math.round(inMs + span * u));
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 정수 픽셀 crop 사각형. 0픽셀이 되지 않도록 최소 1px 을 보장한다. */
function cropRect(
  region: Region | undefined,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!region) return null;
  const cx = Math.min(Math.max(0, Math.round(region.x * width)), Math.max(0, width - 1));
  const cy = Math.min(Math.max(0, Math.round(region.y * height)), Math.max(0, height - 1));
  const cw = Math.min(Math.max(1, Math.round(region.w * width)), width - cx);
  const ch = Math.min(Math.max(1, Math.round(region.h * height)), height - cy);
  if (cw === width && ch === height && cx === 0 && cy === 0) return null;
  return { x: cx, y: cy, w: cw, h: ch };
}

/** "30000/1001" → 29.97. 못 읽으면 30. */
function parseFps(s: string | undefined): number {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '');
  if (!m) return 30;
  const num = Number(m[1]);
  const den = Number(m[2]);
  return Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0 ? num / den : 30;
}

/**
 * 손떨림 보정이 «걸린 뒤» 의 프레임을 뽑는다 (계획 04 의 「⚠️ 확인 필요」에 대한 답).
 *
 * **실측(2026-09-02): 같은 소스를 stabilize 있음/없음으로 굽고 재면 채널 μ 가 최대 8/255
 * 어긋난다.** 계획 04 의 기준(1/255)을 훌쩍 넘는다 — vidstabtransform 이 화면을 확대·이동시켜
 * «보이는 내용 자체» 가 달라지기 때문이다(가장자리만의 문제가 아니라서 영역을 안쪽으로 물려도
 * 안 줄어든다: 10% 안쪽 9.5/255, 20% 안쪽 6.2/255). 그래서 대상 클립에 stabilize 가 걸려
 * 있으면 **보정 후 프레임을 잰다.**
 *
 * 비용은 «디코드 2패스» 뿐이다 — 인코딩을 하지 않고 필요한 5장만 rawvideo 로 받는다.
 * (파생 굽기와 같은 인자를 써야 같은 그림이 나온다: shakiness=5 · 같은 smoothing · unsharp.)
 */
async function stabilizedFrames(
  absSrc: string,
  frameIdx: number[],
  vfTail: string,
  smoothing: number,
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kitkat-measure-stab-'));
  try {
    await runFfmpeg(
      ['-y', '-i', absSrc, '-vf', 'vidstabdetect=shakiness=5:result=tr.trf', '-f', 'null', '-'],
      { cwd: dir },
    );
    const select = frameIdx.map((n) => `eq(n\\,${n})`).join('+');
    return await runFfmpegBuffer(
      [
        '-i', absSrc,
        '-vf',
        `vidstabtransform=input=tr.trf:smoothing=${smoothing},unsharp=5:5:0.8:3:3:0.4,` +
          `select='${select}',${vfTail}`,
        '-vsync', '0', '-f', 'rawvideo', '-',
      ],
      FRAME_MAX_BYTES,
      { cwd: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 지정 시각들의 프레임을 rawvideo(rgb24)로 받아 채널별 256칸 히스토그램을 만든다.
 *
 * **여러 장의 픽셀을 «한 통에» 넣는다.** 프레임별 평균의 평균은 프레임 간 변동을 지워
 * σ 를 과소평가하고, 그러면 대비 보정(a = σ_ref/σ_target)이 어긋난다.
 *
 * **축소하지 않는다.** 이웃 픽셀을 평균내면 분산이 깎여 σ 가 작아진다.
 * 1080×1920 5장 = 31MB — 한 장씩 받아 즉시 히스토그램으로 접으므로 메모리에 쌓이지 않는다.
 *
 * 디코드에 실패한 시각은 건너뛴다(EOF 근처). 한 장도 못 받으면 throw.
 * 실제로 쓴 시각 목록을 `usedMs` 로 돌려준다 — 문서의 `sampledAtMs` 가 사실과 같아야 한다.
 */
export async function measureChannelHistograms(
  absSrc: string,
  opts: { atMs: number[]; region?: Region; stabilize?: { smoothing: number } },
): Promise<{ hist: [ChannelHistogram, ChannelHistogram, ChannelHistogram]; usedMs: number[]; pixels: number }> {
  const info = await ffprobeJson(absSrc);
  const video = (info.streams ?? []).find((s) => s.codec_type === 'video');
  const width = video?.width ?? 0;
  const height = video?.height ?? 0;
  if (!(width > 0 && height > 0)) {
    throw new Error(`영상 크기를 읽을 수 없어 색을 측정할 수 없습니다: ${absSrc}`);
  }
  const crop = cropRect(opts.region, width, height);
  const vf = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=rgb24` : 'format=rgb24';
  const expect = (crop ? crop.w * crop.h : width * height) * 3;

  const hist: [ChannelHistogram, ChannelHistogram, ChannelHistogram] = [
    new Uint32Array(256),
    new Uint32Array(256),
    new Uint32Array(256),
  ];
  const usedMs: number[] = [];
  let pixels = 0;
  const errors: string[] = [];

  /** 프레임 하나를 히스토그램에 접는다. */
  const fold = (buf: Buffer, off: number): void => {
    for (let i = 0; i + 2 < expect; i += 3) {
      hist[0]![buf[off + i]!]!++;
      hist[1]![buf[off + i + 1]!]!++;
      hist[2]![buf[off + i + 2]!]!++;
    }
    pixels += expect / 3;
  };

  if (opts.stabilize) {
    // 보정 후 프레임은 «순서대로» 한 번에 받는다 — vidstab 은 시간을 거슬러 seek 할 수 없다
    // (앞뒤 프레임을 봐야 흔들림을 푼다). -ss 로 한 장씩 뽑으면 다른 그림이 나온다.
    const fps = parseFps(video?.r_frame_rate ?? video?.avg_frame_rate);
    const idx = opts.atMs.map((t) => Math.max(0, Math.round((Math.max(0, t) / 1000) * fps)));
    const buf = await stabilizedFrames(absSrc, idx, vf, opts.stabilize.smoothing);
    const got = Math.floor(buf.length / expect);
    for (let k = 0; k < got; k++) {
      fold(buf, k * expect);
      usedMs.push(opts.atMs[k]!);
    }
  } else {
    for (const t of opts.atMs) {
      let buf: Buffer;
      try {
        buf = await runFfmpegBuffer(
          ['-ss', (Math.max(0, t) / 1000).toFixed(3), '-i', absSrc, '-frames:v', '1',
           '-vf', vf, '-f', 'rawvideo', '-'],
          FRAME_MAX_BYTES,
        );
      } catch (err) {
        errors.push(`${t}ms: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (buf.length < expect) continue; // EOF 근처 — 프레임이 안 나왔다
      fold(buf, 0);
      usedMs.push(t);
    }
  }

  if (usedMs.length === 0) {
    // 조용히 항등으로 넘어가지 않는다 — 「맞췄는데 아무 변화가 없다」가 제일 헷갈린다.
    throw new Error(
      `색 통계를 잴 프레임을 한 장도 얻지 못했습니다: ${absSrc}` +
        (errors.length > 0 ? ` (${errors[0]})` : ''),
    );
  }
  return { hist, usedMs, pixels };
}

/** 히스토그램 → μ·σ (0..1 정규화). 8비트라 이 값은 픽셀을 다 더한 것과 «정확히» 같다. */
export function statsFromHistogram(h: ChannelHistogram): ChannelStat {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let v = 0; v < 256; v++) {
    const c = h[v]!;
    if (c === 0) continue;
    n += c;
    sum += c * v;
    sumSq += c * v * v;
  }
  if (n === 0) return { mean: 0, std: 0 };
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { mean: mean / 255, std: Math.sqrt(variance) / 255 };
}

/**
 * 지정 시각들의 채널별 μ·σ (0..1 정규화, r/g/b 순서 고정).
 * 계획 04 가 요구한 진입점 — 서버 측정 잡이 이것을 두 번(기준·대상) 부른다.
 */
export async function measureChannelStats(
  absSrc: string,
  opts: { atMs: number[]; region?: Region; stabilize?: { smoothing: number } },
): Promise<[ChannelStat, ChannelStat, ChannelStat]> {
  const { hist } = await measureChannelHistograms(absSrc, opts);
  return [statsFromHistogram(hist[0]), statsFromHistogram(hist[1]), statsFromHistogram(hist[2])];
}

/** 0·255 에 몰린 픽셀 비율 (0..1). 맞추기 전후를 비교해 「뭉갠 정도」를 알린다. */
export function clippedFraction(h: ChannelHistogram): { low: number; high: number } {
  let n = 0;
  for (let v = 0; v < 256; v++) n += h[v]!;
  if (n === 0) return { low: 0, high: 0 };
  return { low: h[0]! / n, high: h[255]! / n };
}

const clip01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 채널별 아핀 사상 out = a·in + b (강도 s 적용 후).
 *
 * ⚠️ **derive.ts 의 private `affine()` 과 같은 식이어야 한다.** 여기서 예측한 「맞춘 뒤 색차」와
 * 실제로 구워지는 파일이 갈리면 안 된다. 두 구현이 같은지는 measure.test.ts 가
 * `matchColorLevels()` 의 출력 문자열을 직접 평가해서 검사한다(주석이 아니라 테스트로 묶는다).
 *
 * σ_target 이 0 이면(단색 프레임) 대비 배율이 무한대 → 평균만 옮긴다.
 * 아핀이라 «사상을 보간» 과 «결과를 보간» 이 같다 → s=0.5 는 진짜로 절반이다.
 */
export function matchAffine(
  ref: ChannelStat,
  target: ChannelStat,
  strength: number,
): { a: number; b: number } {
  const s = clip01(strength);
  const a0 = target.std > 1e-6 ? ref.std / target.std : 1;
  const b0 = ref.mean - a0 * target.mean;
  return { a: 1 + (a0 - 1) * s, b: b0 * s };
}

/**
 * 히스토그램에 아핀 사상 + 0..1 클리핑을 그대로 먹여 «맞춘 뒤» 의 μ·σ 와 뭉갠 비율을 예측한다.
 * 8비트 값 256개를 전부 통과시키므로 근사가 아니라 계산이다 (인코딩 손실만 빠진다).
 */
export function predictAfter(
  h: ChannelHistogram,
  a: number,
  b: number,
): { stat: ChannelStat; clipped: { low: number; high: number } } {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let low = 0;
  let high = 0;
  for (let v = 0; v < 256; v++) {
    const c = h[v]!;
    if (c === 0) continue;
    const raw = a * (v / 255) + b;
    const y = clip01(raw);
    n += c;
    sum += c * y;
    sumSq += c * y * y;
    if (raw <= 0) low += c;
    if (raw >= 1) high += c;
  }
  if (n === 0) return { stat: { mean: 0, std: 0 }, clipped: { low: 0, high: 0 } };
  const mean = sum / n;
  return {
    stat: { mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) },
    clipped: { low: low / n, high: high / n },
  };
}
