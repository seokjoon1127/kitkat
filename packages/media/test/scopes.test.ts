// F6-B 정밀 스코프 — **진짜 ffmpeg** 로 알려진 신호를 대조한다.
//  · 100% 컬러바 → 벡터스코프 6개 점이 이론 좌표(U, 255-V)에
//  · 0~100% 램프 → 웨이브폼이 직선
//  · 흰색/검정   → 히스토그램 양 끝 스파이크
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isScopeKind,
  measureStillStats,
  renderScopeImage,
  renderScopeImages,
  scopeFileName,
  statsFromRgba,
  statsSampleSize,
  SCOPE_FILTERS,
  SCOPE_KINDS,
  type ScopeKind,
} from '../src/scopes.js';
import { ffprobeJson, runFfmpeg, runFfmpegBuffer } from '../src/ffmpeg.js';

const T = 60_000;

let dir: string;
let bars: string; // 100% 컬러바 PNG
let ramp: string; // 0→255 가로 램프 PNG
let white: string;
let black: string;

const BAR_W = 512;
const BAR_H = 288;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kitkat-scopes-'));
  bars = path.join(dir, 'bars.png');
  ramp = path.join(dir, 'ramp.png');
  white = path.join(dir, 'white.png');
  black = path.join(dir, 'black.png');
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `pal100bars=s=${BAR_W}x${BAR_H}`, '-frames:v', '1', bars,
  ]);
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `color=c=black:s=${BAR_W}x${BAR_H}`,
    '-vf', "geq=r='X*255/(W-1)':g='X*255/(W-1)':b='X*255/(W-1)'",
    '-frames:v', '1', ramp,
  ]);
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=white:s=128x128', '-frames:v', '1', white]);
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x128', '-frames:v', '1', black]);
}, T);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** PNG → 원시 RGBA. */
async function readRgba(abs: string, w: number, h: number): Promise<Uint8Array> {
  return runFfmpegBuffer(
    ['-i', abs, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    w * h * 4 + 4096,
  );
}

async function sizeOf(abs: string): Promise<{ w: number; h: number }> {
  const p = await ffprobeJson(abs);
  const s = p.streams?.find((x) => x.codec_type === 'video');
  return { w: s?.width ?? 0, h: s?.height ?? 0 };
}

function lit(px: Uint8Array, w: number, x: number, y: number, thr = 40): boolean {
  const o = (y * w + x) * 4;
  return Math.max(px[o] as number, px[o + 1] as number, px[o + 2] as number) > thr;
}

/**
 * BT.709 **리미티드 레인지** 8비트 색차 — ffmpeg 벡터스코프의 초록 격자 타깃이 그려진 좌표계다.
 * 화면 좌표는 (x, y) = (U, 255-V).
 */
function uv709Limited(r: number, g: number, b: number): { u: number; v: number } {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  return {
    u: 128 + Math.round(((B - y) / (2 * (1 - 0.0722))) * 224),
    v: 128 + Math.round(((R - y) / (2 * (1 - 0.2126))) * 224),
  };
}

describe('필터 문자열', () => {
  it('검증된 스코프 문자열은 그대로 두고, 형식 변환만 앞에 붙였다', () => {
    expect(SCOPE_FILTERS.waveform).toBe(
      'format=gbrp,waveform=intensity=0.2:mirror=1:components=7:display=overlay',
    );
    expect(SCOPE_FILTERS.vectorscope).toBe(
      'scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,' +
        'vectorscope=mode=color3:graticule=green:flags=name',
    );
    expect(SCOPE_FILTERS.histogram).toBe(
      'format=gbrp,histogram=display_mode=stack:levels_mode=logarithmic',
    );
    // 웨이브폼·히스토그램은 «풀레인지 RGB» 여야 한다 — 리미티드 YUV 로 두면 흰색이 235 에 선다
    expect(SCOPE_FILTERS.waveform).toContain('format=gbrp');
    expect(SCOPE_FILTERS.histogram).toContain('format=gbrp');
    // 벡터스코프는 «리미티드» 로 내려야 격자 타깃과 맞는다 (jpeg 스틸은 풀레인지로 들어온다)
    expect(SCOPE_FILTERS.vectorscope).toContain('out_range=tv');
    expect(SCOPE_KINDS.length).toBe(3);
  });

  it('isScopeKind 는 아는 것만 통과시킨다', () => {
    expect(isScopeKind('waveform')).toBe(true);
    expect(isScopeKind('rgb')).toBe(false);
    expect(isScopeKind(7)).toBe(false);
  });
});

describe('RGB 스틸을 그냥 먹이면 빈 그림이 나온다 (형식 변환이 필요한 이유)', () => {
  it(
    '형식 변환 없이는 벡터스코프가 사실상 빈 그림, 붙이면 점과 격자가 나온다',
    async () => {
      const bad = path.join(dir, 'vs-bad.png');
      const good = path.join(dir, 'vs-good.png');
      await runFfmpeg([
        '-y', '-i', bars,
        '-vf', 'vectorscope=mode=color3:graticule=green:flags=name',
        '-frames:v', '1', bad,
      ]);
      await renderScopeImage(bars, good, 'vectorscope');
      const badPx = await readRgba(bad, 256, 256);
      const goodPx = await readRgba(good, 256, 256);
      const count = (px: Uint8Array): number => {
        let n = 0;
        for (let i = 0; i < 256 * 256; i++) {
          if (Math.max(px[i * 4] as number, px[i * 4 + 1] as number, px[i * 4 + 2] as number) > 40) n++;
        }
        return n;
      };
      // 「오류 없이 사실상 빈 그림」 — 점 몇 개만 남고 격자도 안 나온다
      expect(count(badPx)).toBeLessThan(20);
      expect(count(goodPx)).toBeGreaterThan(count(badPx) * 20);
    },
    T,
  );
});

const TARGET_RGB: [string, [number, number, number]][] = [
  ['R', [255, 0, 0]],
  ['Yl', [255, 255, 0]],
  ['G', [0, 255, 0]],
  ['Cy', [0, 255, 255]],
  ['B', [0, 0, 255]],
  ['Mg', [255, 0, 255]],
];

describe('벡터스코프 — 100% 컬러바의 6개 점이 이론 좌표에', () => {
  // **png 와 jpeg 를 둘 다 본다.** 실제로 먹이는 스틸은 renderCover 가 만든 jpeg(풀레인지)이고,
  // 범위 변환을 빼면 점이 격자 바깥으로 밀려난다.
  for (const kind of ['png', 'jpeg'] as const) {
    it(
      `${kind} 스틸에서 R·Yl·G·Cy·B·Mg 가 (U, 255-V) 자리에 ±2px 안으로 찍힌다`,
      async () => {
        let input = bars;
        if (kind === 'jpeg') {
          input = path.join(dir, 'bars.jpg');
          await runFfmpeg(['-y', '-i', bars, '-q:v', '3', '-frames:v', '1', input]);
        }
        // 격자를 끄고 점만 본다 — 격자 픽셀이 판정에 섞이면 안 된다
        const out = path.join(dir, `vs-plain-${kind}.png`);
        await runFfmpeg([
          '-y', '-i', input,
          '-vf', SCOPE_FILTERS.vectorscope.replace('graticule=green', 'graticule=none'),
          '-frames:v', '1', out,
        ]);
        const px = await readRgba(out, 256, 256);
        for (const [name, [r, g, b]] of TARGET_RGB) {
          const { u, v } = uv709Limited(r, g, b);
          const ex = u;
          const ey = 255 - v;
          let found = false;
          for (let dy = -2; dy <= 2 && !found; dy++) {
            for (let dx = -2; dx <= 2 && !found; dx++) {
              const x = ex + dx;
              const y = ey + dy;
              if (x < 0 || y < 0 || x > 255 || y > 255) continue;
              if (lit(px, 256, x, y)) found = true;
            }
          }
          expect(found, `${kind}: ${name} 점이 (${ex},${ey}) 근처에 없다`).toBe(true);
        }
      },
      T,
    );
  }

  it(
    '범위 변환을 빼면 (풀레인지 jpeg 에서) 점이 격자 밖으로 밀려난다 — out_range=tv 의 근거',
    async () => {
      const jpg = path.join(dir, 'bars-range.jpg');
      await runFfmpeg(['-y', '-i', bars, '-q:v', '3', '-frames:v', '1', jpg]);
      const out = path.join(dir, 'vs-norange.png');
      await runFfmpeg([
        '-y', '-i', jpg,
        '-vf',
        'scale=out_color_matrix=bt709,format=yuv444p,vectorscope=mode=color3:graticule=none',
        '-frames:v', '1', out,
      ]);
      const px = await readRgba(out, 256, 256);
      const { u, v } = uv709Limited(255, 0, 0);
      let hit = false;
      for (let dy = -2; dy <= 2 && !hit; dy++) {
        for (let dx = -2; dx <= 2 && !hit; dx++) {
          const x = u + dx;
          const y = 255 - v + dy;
          if (x < 0 || y < 0 || x > 255 || y > 255) continue;
          if (lit(px, 256, x, y)) hit = true;
        }
      }
      expect(hit, 'out_range 없이도 맞으면 이 필터 옵션은 필요 없다는 뜻이다').toBe(false);
    },
    T,
  );

  it(
    '격자(graticule=green)와 라벨이 실제로 그려진다 — 점만 찍으면 쓸모없다',
    async () => {
      const plain = path.join(dir, 'vs-plain2.png');
      const grat = path.join(dir, 'vs-grat.png');
      await runFfmpeg([
        '-y', '-i', bars,
        '-vf', SCOPE_FILTERS.vectorscope.replace('graticule=green', 'graticule=none'),
        '-frames:v', '1', plain,
      ]);
      await renderScopeImage(bars, grat, 'vectorscope');
      const a = await readRgba(plain, 256, 256);
      const b = await readRgba(grat, 256, 256);
      const count = (px: Uint8Array): number => {
        let n = 0;
        for (let i = 0; i < 256 * 256; i++) {
          if (Math.max(px[i * 4] as number, px[i * 4 + 1] as number, px[i * 4 + 2] as number) > 40) n++;
        }
        return n;
      };
      // 격자·타깃 상자·이름표만큼 켜진 픽셀이 훨씬 많아야 한다
      expect(count(b)).toBeGreaterThan(count(a) + 200);
    },
    T,
  );
});

describe('웨이브폼 — 0~100% 그레이 램프는 직선', () => {
  it(
    '열마다 밝은 자국이 하나고, 그 위치가 가로에 대해 선형이다',
    async () => {
      const out = path.join(dir, 'wf-ramp.png');
      await renderScopeImage(ramp, out, 'waveform');
      const { w, h } = await sizeOf(out);
      expect(w).toBe(BAR_W);
      expect(h).toBe(256);
      const px = await readRgba(out, w, h);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let x = 0; x < w; x++) {
        const rows: number[] = [];
        for (let y = 0; y < h; y++) if (lit(px, w, x, y, 150)) rows.push(y);
        if (rows.length === 0) continue;
        expect(rows.length, `x=${x} 에서 자국이 ${rows.length}줄`).toBeLessThanOrEqual(4);
        xs.push(x);
        ys.push(rows.reduce((a, b) => a + b, 0) / rows.length);
      }
      expect(xs.length).toBeGreaterThan(w * 0.9);
      // 최소제곱 적합 — mirror=1 이라 값이 커질수록 위(y 감소)
      const n = xs.length;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < n; i++) {
        sx += xs[i] as number;
        sy += ys[i] as number;
        sxx += (xs[i] as number) ** 2;
        sxy += (xs[i] as number) * (ys[i] as number);
      }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const intercept = (sy - slope * sx) / n;
      let maxResid = 0;
      for (let i = 0; i < n; i++) {
        maxResid = Math.max(maxResid, Math.abs((ys[i] as number) - (slope * (xs[i] as number) + intercept)));
      }
      expect(slope).toBeLessThan(0);
      // 램프 전 구간이 한 직선에 붙어 있어야 «직선» 이다 (256줄 중 4줄 이내 어긋남)
      expect(maxResid).toBeLessThan(4);
    },
    T,
  );
});

describe('히스토그램 — 순수 흰색/검정은 양 끝 스파이크', () => {
  it(
    '흰색은 오른쪽 끝, 검정은 왼쪽 끝에만 막대가 선다',
    async () => {
      const wOut = path.join(dir, 'hi-white.png');
      const bOut = path.join(dir, 'hi-black.png');
      await renderScopeImage(white, wOut, 'histogram');
      await renderScopeImage(black, bOut, 'histogram');
      const s = await sizeOf(wOut);
      expect(s.w).toBe(256);
      const wp = await readRgba(wOut, s.w, s.h);
      const bp = await readRgba(bOut, s.w, s.h);
      // 첫 판(Y 성분)만 본다 — display_mode=stack 이라 세로로 3판이 쌓인다
      const pane = Math.floor(s.h / 3);
      const colHeight = (px: Uint8Array, x: number): number => {
        let n = 0;
        for (let y = 0; y < pane; y++) if (lit(px, s.w, x, y, 30)) n++;
        return n;
      };
      // 판 아래 12줄은 ffmpeg 가 그리는 «색 눈금 띠» 라 어느 열에나 있다 — 그보다 높으면 막대다
      const LEGEND = 16;
      // 흰색: 오른쪽 끝만 막대가 서고 왼쪽·가운데는 눈금 띠뿐
      expect(colHeight(wp, 255)).toBeGreaterThan(pane * 0.5);
      expect(colHeight(wp, 0)).toBeLessThanOrEqual(LEGEND);
      expect(colHeight(wp, 128)).toBeLessThanOrEqual(LEGEND);
      // 검정: 왼쪽 끝
      expect(colHeight(bp, 0)).toBeGreaterThan(pane * 0.5);
      expect(colHeight(bp, 255)).toBeLessThanOrEqual(LEGEND);
      expect(colHeight(bp, 128)).toBeLessThanOrEqual(LEGEND);
    },
    T,
  );
});

describe('캐시와 파일 이름', () => {
  it('리비전·시각·종류가 이름에 들어간다 → 리비전이 오르면 저절로 무효', () => {
    const a = scopeFileName('proj1', 3, 1500, 'waveform');
    const b = scopeFileName('proj1', 4, 1500, 'waveform');
    expect(a).toBe('proj1-r3-t1500-waveform.png');
    expect(b).not.toBe(a);
    expect(scopeFileName('proj1', 3, 1500, 'waveform', true)).toBe('proj1-r3-t1500-p-waveform.png');
    // 경로 구분자·점은 다 지운다 (media/scopes 밖으로 나갈 수 없다)
    expect(scopeFileName('../나쁜/id', 1, 0, 'histogram')).toBe('_나쁜_id-r1-t0-histogram.png');
  });

  it(
    '이미 있는 파일은 다시 굽지 않는다',
    async () => {
      const outDir = path.join(dir, 'cache');
      const fileFor = (k: ScopeKind): string => scopeFileName('p', 1, 0, k);
      const first = await renderScopeImages(bars, outDir, fileFor, ['vectorscope', 'histogram']);
      const t1 = await stat(first.vectorscope as string);
      await new Promise((r) => setTimeout(r, 30));
      const second = await renderScopeImages(bars, outDir, fileFor, ['vectorscope', 'histogram']);
      const t2 = await stat(second.vectorscope as string);
      expect(second.vectorscope).toBe(first.vectorscope);
      expect(t2.mtimeMs).toBe(t1.mtimeMs);
    },
    T,
  );

  it(
    '세 종류를 한 번에 만들고 각각 크기가 다르다',
    async () => {
      const outDir = path.join(dir, 'all');
      const made = await renderScopeImages(bars, outDir, (k) => `x-${k}.png`);
      expect(Object.keys(made).sort()).toEqual(['histogram', 'vectorscope', 'waveform']);
      expect(await sizeOf(made.waveform as string)).toEqual({ w: BAR_W, h: 256 });
      expect(await sizeOf(made.vectorscope as string)).toEqual({ w: 256, h: 256 });
      const hi = await sizeOf(made.histogram as string);
      expect(hi.w).toBe(256);
      expect(hi.h).toBeGreaterThan(256);
    },
    T,
  );
});

describe('통계 — 실시간 스코프와 견줄 숫자', () => {
  it('단색 스틸의 평균이 그 색과 같다', async () => {
    const s = await measureStillStats(white, 64, 64);
    expect(s.pixels).toBe(64 * 64);
    expect(s.mean[0]).toBeGreaterThan(250);
    expect(s.mean[1]).toBeGreaterThan(250);
    expect(s.mean[2]).toBeGreaterThan(250);
    expect(s.meanY).toBeGreaterThan(250);
    expect(Math.abs(s.meanCb)).toBeLessThan(1);
    expect(Math.abs(s.meanCr)).toBeLessThan(1);
  }, T);

  it('statsFromRgba 는 UI 의 scopeStats 와 같은 수식', () => {
    const px = new Uint8Array(4 * 4);
    for (let i = 0; i < 4; i++) {
      px[i * 4] = 10;
      px[i * 4 + 1] = 20;
      px[i * 4 + 2] = 30;
      px[i * 4 + 3] = 255;
    }
    const s = statsFromRgba(px, 2, 2);
    expect(s.mean).toEqual([10, 20, 30]);
    expect(s.meanY).toBeCloseTo(0.299 * 10 + 0.587 * 20 + 0.114 * 30, 6);
    expect(s.meanCb).toBeCloseTo(-0.169 * 10 - 0.331 * 20 + 0.5 * 30, 6);
  });

  it('표본 크기는 브라우저 쪽(scopeSampleSize)과 똑같이 나온다', () => {
    expect(statsSampleSize(1080, 1920)).toEqual({ width: 256, height: 455 });
    expect(statsSampleSize(1920, 1080)).toEqual({ width: 455, height: 256 });
    expect(statsSampleSize(100, 100)).toEqual({ width: 100, height: 100 });
    expect(statsSampleSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});
