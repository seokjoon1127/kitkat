// W8 F8(키네틱 타이포) · F9(자유 마스크) — **실제 렌더 픽셀로** 재는 검증 스크립트.
//
//   npx tsx scripts/w8-f8f9-render-check.mts t   키네틱: 글자별 시차 · 와이프 · fps 무관성 · popIn 회귀
//   npx tsx scripts/w8-f8f9-render-check.mts d   붓글씨(drawStroke): 획 잉크 단조 증가 · 끝 픽셀 일치 · 폰트 3종
//   npx tsx scripts/w8-f8f9-render-check.mts 6   붓글씨 · Noto 정적 인스턴스 전/후만 (D6)
//   npx tsx scripts/w8-f8f9-render-check.mts p   미리보기 ↔ 렌더 픽셀 대조 (computeTextLayout 한 벌)
//   npx tsx scripts/w8-f8f9-render-check.mts m   자유 마스크: 꼭짓점 ±1px · 페더 · 겹치기 · 반전
//   npx tsx scripts/w8-f8f9-render-check.mts x   마스크 × 회전 × mixBlendMode 8조합 좌표 확인
//
// 픽셀은 ffmpeg 이 rawvideo(gray) 로 뱉은 바이트를 그대로 읽는다 — 이미지 라이브러리 없음.
// (.mts 인 이유: 미리보기 경로를 «진짜 컴포넌트»로 그려 대조하려고 TSX 를 그대로 들여온다.)
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { bundle } from '@remotion/bundler';
import { createEmptyProject, validateDoc } from '@kitkat/schema';
import type { Mask, ProjectDoc, TextAnim, TextClip } from '@kitkat/schema';
import { startStaticServer } from '@kitkat/renderer';
import { msToFrames } from '@kitkat/renderer/composition';
import { TextClipOverlay } from '../packages/ui/src/preview/TextOverlay.js';

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(MEDIA, 'w8-f8f9');
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.join(MEDIA, 'assets'), { recursive: true });

const W = 540;
const H = 960;
const FPS = 30;

// ── 픽셀 ──────────────────────────────────────────────────────────────────

type Frame = { w: number; h: number; px: Uint8Array };

async function grayPng(file: string): Promise<Frame> {
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 },
  );
  const { stdout: probe } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]);
  const [w, h] = probe.trim().split('x').map(Number) as [number, number];
  return { w, h, px: new Uint8Array(stdout as unknown as ArrayBuffer) };
}

const f2 = (v: number): string => (Math.round(v * 100) / 100).toFixed(2);

/** 프레임 전체의 «잉크량» = 밝기 합 / 255. 글자가 많이·진하게 보일수록 크다. */
function ink(f: Frame): number {
  let s = 0;
  for (const v of f.px) s += v;
  return s / 255;
}

/** 세로로 최댓값을 취한 가로 프로필 (열마다 하나). */
function columnProfile(f: Frame): Float64Array {
  const p = new Float64Array(f.w);
  for (let y = 0; y < f.h; y++) {
    const row = y * f.w;
    for (let x = 0; x < f.w; x++) if (f.px[row + x]! > p[x]!) p[x] = f.px[row + x]!;
  }
  return p;
}

function rowProfile(f: Frame): Float64Array {
  const p = new Float64Array(f.h);
  for (let y = 0; y < f.h; y++) {
    const row = y * f.w;
    for (let x = 0; x < f.w; x++) if (f.px[row + x]! > p[y]!) p[y] = f.px[row + x]!;
  }
  return p;
}

/** 프로필에서 threshold 를 넘는 첫/마지막 자리 */
function extent(p: Float64Array, t = 128): { lo: number; hi: number } {
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < p.length; i++) {
    if (p[i]! >= t) {
      if (lo < 0) lo = i;
      hi = i;
    }
  }
  return { lo, hi };
}

/** 두 프레임의 채널 차이 (평균·최대·12 를 넘는 픽셀 수). */
function diff(a: Frame, b: Frame): { mean: number; max: number; over: number } {
  const n = Math.min(a.px.length, b.px.length);
  let sum = 0;
  let max = 0;
  let over = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.px[i]! - b.px[i]!);
    sum += d;
    if (d > max) max = d;
    if (d > 12) over++;
  }
  return { mean: sum / n, max, over };
}

// ── 문서 조립 · 렌더 ──────────────────────────────────────────────────────

function docWith(clips: [string, Record<string, unknown>, Record<string, unknown>?][],
                 opt: { width?: number; height?: number; fps?: number } = {}): ProjectDoc {
  const doc = createEmptyProject({
    name: 'W8 F8·F9 검증',
    width: opt.width ?? W, height: opt.height ?? H, fps: opt.fps ?? FPS,
  });
  for (const [kind, clip, asset] of clips) {
    if (asset) doc.assets[asset.id as string] = asset as never;
    doc.tracks.find((t) => t.kind === kind)!.clips.push(clip as never);
  }
  return validateDoc(doc);
}

// renderCover 는 **JPEG** 를 낸다 — 압축 자국이 「꼭짓점 ±1px」·「알파 합 1.0±0.01」 같은
// 측정을 망친다. 그래서 여기서는 같은 번들·같은 컴포지션을 **PNG 로** 직접 뽑는다.
let serveUrlPromise: Promise<string> | null = null;
let serverPromise: Promise<{ url: string; close: () => Promise<void> }> | null = null;

function serveUrl(): Promise<string> {
  if (!serveUrlPromise) {
    serveUrlPromise = bundle({ entryPoint: path.join(ROOT, 'packages/renderer/dist/root.js') });
  }
  return serveUrlPromise;
}
function mediaServer(): Promise<{ url: string; close: () => Promise<void> }> {
  if (!serverPromise) serverPromise = startStaticServer(MEDIA) as never;
  return serverPromise;
}

/** 한 시각의 정지 프레임(PNG, 무손실). */
async function still(doc: ProjectDoc, name: string, atMs: number): Promise<Frame> {
  const outPath = path.join(OUT, `${name}.png`);
  const url = await serveUrl();
  const srv = await mediaServer();
  const inputProps = { doc, mediaBase: srv.url, proxy: false };
  const composition = await selectComposition({ serveUrl: url, id: 'timeline', inputProps });
  const frame = Math.min(
    Math.max(0, msToFrames(atMs, doc.settings.fps)),
    Math.max(0, composition.durationInFrames - 1),
  );
  await renderStill({
    composition, serveUrl: url, inputProps, output: outPath, frame,
    imageFormat: 'png', chromiumOptions: { gl: null },
  });
  return grayPng(outPath);
}

async function makeWhite(rel: string, w: number, h: number): Promise<void> {
  const abs = path.join(MEDIA, rel);
  if (existsSync(abs)) return;
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=white:s=${w}x${h}`,
    '-frames:v', '1', abs]);
}

const textStyle = (over: Record<string, unknown> = {}) => ({
  fontFamily: 'sans-serif', fontSize: 80, color: '#ffffff', align: 'center', ...over,
});

const textClip = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'tx', kind: 'text', start: 0, duration: 2000, text: 'ABCDEFGH',
  style: textStyle(), ...over,
});

// ── T. 키네틱 타이포 ──────────────────────────────────────────────────────

async function checkT(): Promise<void> {
  console.log('\n== T1. 글자별 시차가 «프레임마다 다른 글자»를 보이게 하는가 ==');
  // fade · char · 60ms · 800ms → 8글자면 마지막 글자가 7×60=420ms 에 시작
  const anim: TextAnim = { type: 'fade', duration: 800, unit: 'char', staggerMs: 60 };
  const staggered = docWith([['text', textClip({ animationIn: anim })]]);
  const whole = docWith([['text', textClip({ animationIn: { type: 'fade', duration: 800 } })]]);

  console.log('시각 |  글자별 잉크 |  통짜 잉크 |  왼쪽 절반/오른쪽 절반 (글자별)');
  const rows: { t: number; a: number; b: number; ratio: number }[] = [];
  for (const t of [0, 100, 200, 300, 400, 600, 800]) {
    const fa = await still(staggered, `t1-stag-${t}`, t);
    const fb = await still(whole, `t1-whole-${t}`, t);
    // 왼쪽 절반 : 오른쪽 절반 잉크 비 — 시차가 있으면 앞 글자가 먼저 진해진다
    let left = 0;
    let right = 0;
    for (let y = 0; y < fa.h; y++) {
      for (let x = 0; x < fa.w; x++) {
        if (x < fa.w / 2) left += fa.px[y * fa.w + x]!;
        else right += fa.px[y * fa.w + x]!;
      }
    }
    const ratio = right > 0 ? left / right : Infinity;
    rows.push({ t, a: ink(fa), b: ink(fb), ratio });
    console.log(`${String(t).padStart(4)} | ${f2(ink(fa)).padStart(12)} | ${f2(ink(fb)).padStart(10)} | ${f2(ratio)}`);
  }
  const mono = rows.every((r, i) => i === 0 || r.a >= rows[i - 1]!.a - 1e-6);
  const skew = rows.filter((r) => r.t > 0 && r.t < 500).every((r) => r.ratio > 1.05);
  const differs = rows.some((r) => Math.abs(r.a - r.b) / Math.max(1, r.b) > 0.05);
  console.log(`잉크 단조 증가: ${mono ? 'OK' : '실패'}`);
  console.log(`앞 글자가 먼저 진해진다(왼쪽/오른쪽 > 1.05): ${skew ? 'OK' : '실패'}`);
  console.log(`통짜(unit:'all')와 실제로 다른 그림: ${differs ? 'OK' : '실패 — 시차가 안 걸렸다'}`);

  console.log('\n== T2. 와이프가 실제로 «쓸려 나오는가» (wipeLeft = 좌→우) ==');
  const wipe = docWith([['text', textClip({
    text: 'WIPEWIPEWIPE',
    animationIn: { type: 'wipeLeft', duration: 800 } as TextAnim,
  })]]);
  console.log('시각 | 보이는 오른쪽 끝(px) | 잉크');
  const edges: number[] = [];
  for (const t of [100, 200, 400, 600, 800]) {
    const f = await still(wipe, `t2-wipe-${t}`, t);
    const e = extent(columnProfile(f), 100);
    edges.push(e.hi);
    console.log(`${String(t).padStart(4)} | ${String(e.hi).padStart(20)} | ${f2(ink(f))}`);
  }
  const grows = edges.every((v, i) => i === 0 || v >= edges[i - 1]!);
  console.log(`오른쪽 끝이 오른쪽으로 이동: ${grows ? 'OK' : '실패'}`);

  console.log('\n== T3. fps 무관성 — 24/30/60fps 의 같은 절대 시각(400ms) ==');
  const frames: Record<number, Frame> = {};
  for (const fps of [24, 30, 60]) {
    const d = docWith([['text', textClip({ animationIn: anim })]], { fps });
    frames[fps] = await still(d, `t3-${fps}`, 400);
  }
  for (const fps of [24, 60]) {
    const d = diff(frames[30]!, frames[fps]!);
    console.log(`  30fps ↔ ${fps}fps : 평균 ${f2(d.mean)} · 최대 ${d.max}  (합격 평균 ≤ 2)`);
  }

  console.log('\n== T4. popIn 회귀 — 크기가 easeOutBack 과 같은가 ==');
  const pop = docWith([['text', textClip({ text: 'M', style: textStyle({ fontSize: 200 }),
    animationIn: { type: 'popIn', duration: 1000 } as TextAnim })]]);
  const full = await still(pop, 't4-pop-full', 1500);
  const fullW = extent(columnProfile(full)).hi - extent(columnProfile(full)).lo + 1;
  const easeOutBack = (p: number): number => {
    const c1 = 1.70158;
    return 1 + (c1 + 1) * (p - 1) ** 3 + c1 * (p - 1) ** 2;
  };
  console.log('진행도 | 기대 배율 | 실측 폭/전체 폭 | 오차');
  for (const p of [0.3, 0.5, 0.8]) {
    const f = await still(pop, `t4-pop-${p}`, Math.round(p * 1000));
    const e = extent(columnProfile(f), 60);
    const measured = (e.hi - e.lo + 1) / fullW;
    const want = easeOutBack(p);
    console.log(`  ${p} | ${f2(want).padStart(9)} | ${f2(measured).padStart(15)} | ${f2(Math.abs(measured - want) / want * 100)}%`);
  }
}

// ── P. 미리보기 ↔ 렌더 ────────────────────────────────────────────────────
//
// 두 경로가 «같은 computeTextLayout» 을 쓰는지 픽셀로 확인한다.
//   렌더  : renderStill(TimelineVideo → TextClipView)
//   미리보기: 진짜 TextClipOverlay 를 그려 브라우저에서 래스터화(foreignObject)
// 폰트는 번들 폰트 대신 sans-serif 를 써서 «폰트 파일 임베딩»이 변수로 끼지 않게 한다.

async function checkP(): Promise<void> {
  const cases: { name: string; clip: Record<string, unknown>; at: number }[] = [
    { name: '외곽선12-정지', at: 1500, clip: textClip({ text: '예능 자막', style: textStyle({ strokeColor: '#000000', strokeWidth: 12, bold: true }) }) },
    { name: 'slideUp-통짜', at: 250, clip: textClip({ text: '슬라이드', animationIn: { type: 'slideUp', duration: 500 } }) },
    { name: 'popIn-통짜', at: 200, clip: textClip({ text: '팝인', animationIn: { type: 'popIn', duration: 500 } }) },
    { name: 'fade-글자시차', at: 300, clip: textClip({ text: 'ABCDEFGH', animationIn: { type: 'fade', duration: 800, unit: 'char', staggerMs: 60 } }) },
    { name: 'slideUp-단어시차', at: 300, clip: textClip({ text: '하나 둘 셋 넷', animationIn: { type: 'slideUp', duration: 800, unit: 'word', staggerMs: 70, distance: 24 } }) },
    { name: 'blurIn-글자', at: 250, clip: textClip({ text: '초점', animationIn: { type: 'blurIn', duration: 700, unit: 'char', staggerMs: 20 } }) },
    { name: 'wipeLeft-통짜', at: 350, clip: textClip({ text: 'WIPE', animationIn: { type: 'wipeLeft', duration: 700 } }) },
    { name: 'scaleUp-무작위', at: 400, clip: textClip({ text: '무작위등장', animationIn: { type: 'scaleUp', duration: 900, unit: 'char', staggerMs: 35, origin: 'random' } }) },
    { name: '타자기', at: 400, clip: textClip({ text: '타자기입니다', animationIn: { type: 'typewriter', duration: 1000 } }) },
    // ── 대조군 ──
    // 같은 클립을 애니메이션이 «끝난» 시각에 본다: 래퍼 스타일이 아예 없는 경우.
    { name: '대조:slideUp끝', at: 600, clip: textClip({ text: '슬라이드', animationIn: { type: 'slideUp', duration: 500 } }) },
    { name: '대조:wipe끝', at: 800, clip: textClip({ text: 'WIPE', animationIn: { type: 'wipeLeft', duration: 700 } }) },
    // transform 이 «상자»에 붙는 경우 (래퍼가 아니라)
    { name: '대조:상자이동', at: 100, clip: textClip({ text: '슬라이드', transform: { x: 0.05, y: 0.02, scale: 1.1, rotation: 3 } }) },
  ];

  const browser = await openBrowser('chrome', {});
  const page = (await browser.newPage({ context: null, logLevel: 'error', indent: false } as never)) as never as {
    goto: (o: { url: string; timeout: number }) => Promise<unknown>;
    evaluate: (fn: unknown, args: unknown, opts?: unknown) => Promise<unknown>;
  };
  await page.goto({ url: 'about:blank', timeout: 30000 });

  console.log('\n== P. 미리보기 ↔ 렌더 픽셀 대조 (합격: 평균 ≤ 3, 최대 ≤ 12) ==');
  console.log('조합                  | 평균  | 최대 | >12 픽셀 | 판정');
  let worstMean = 0;
  for (const c of cases) {
    const doc = docWith([['text', c.clip]]);
    const renderFrame = await still(doc, `p-${c.name}`, c.at);
    const html = renderToStaticMarkup(
      React.createElement(TextClipOverlay, {
        clip: doc.tracks.find((t) => t.kind === 'text')!.clips[0] as TextClip,
        tMs: c.at, canvasW: W, canvasH: H,
      }),
    );
    const previewPng = path.join(OUT, `p-${c.name}-preview.png`);
    const dataUrl = (await rasterize(page, html, W, H)) as string;
    await fs.writeFile(previewPng, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
    const previewFrame = await grayPng(previewPng);
    const d = diff(renderFrame, previewFrame);
    worstMean = Math.max(worstMean, d.mean);
    const pass = d.mean <= 3 && d.max <= 12;
    console.log(
      `${c.name.padEnd(21)} | ${f2(d.mean).padStart(5)} | ${String(d.max).padStart(4)} | ` +
      `${String(d.over).padStart(8)} | ${pass ? 'OK' : '최대 초과'}`,
    );
  }
  console.log(`가장 나쁜 평균 차이: ${f2(worstMean)}`);
  await browser.close({ silent: true } as never);
}

/** DOM 을 SVG foreignObject 로 감싸 캔버스에 그린 뒤 PNG data URL 로 돌려준다. */
function rasterize(
  page: { evaluate: (fn: unknown, args: unknown, opts?: unknown) => Promise<unknown> },
  html: string, w: number, h: number,
): Promise<unknown> {
  return page.evaluate(
    (args: { html: string; w: number; h: number }) =>
      new Promise<string>((resolve, reject) => {
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${args.w}" height="${args.h}">` +
          `<foreignObject width="100%" height="100%">` +
          `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${args.w}px;height:${args.h}px;position:relative;background:#000">` +
          args.html +
          `</div></foreignObject></svg>`;
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = args.w;
          c.height = args.h;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, args.w, args.h);
          ctx.drawImage(img, 0, 0);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('foreignObject 래스터화 실패'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      }),
    { html, w, h },
  );
}

// ── D. drawStroke (붓글씨) ────────────────────────────────────────────────

async function checkD(): Promise<void> {
  // 번들 폰트여야 글리프를 읽을 수 있다 — 성격이 다른 3종으로 재 본다.
  const FONTS: [string, string][] = [
    ['도현(고딕)', "'Do Hyeon', sans-serif"],
    ['나눔명조', "'Nanum Myeongjo', serif"],
    ['나눔펜(손글씨)', "'Nanum Pen Script', cursive"],
  ];
  const TEXT = '값한';

  const strokeDoc = (family: string, dur = 1000): ProjectDoc =>
    docWith([['text', textClip({
      text: TEXT, style: textStyle({ fontFamily: family, fontSize: 200 }),
      animationIn: { type: 'drawStroke', duration: dur, unit: 'char', staggerMs: 0 } as TextAnim,
    })]]);
  const plainDoc = (family: string): ProjectDoc =>
    docWith([['text', textClip({
      text: TEXT, style: textStyle({ fontFamily: family, fontSize: 200 }),
    })]]);

  console.log('\n== D1. 그려진 획의 «잉크 양» 이 진행률에 따라 단조 증가하는가 ==');
  console.log('폰트           |' + [0, 100, 250, 500, 750, 1000].map((t) => String(t).padStart(9)).join(' |') + ' | 단조');
  for (const [name, family] of FONTS) {
    const doc = strokeDoc(family);
    const inks: number[] = [];
    for (const t of [0, 100, 250, 500, 750, 1000]) {
      inks.push(ink(await still(doc, `d1-${name}-${t}`, t)));
    }
    const mono = inks.every((v, i) => i === 0 || v >= inks[i - 1]! - 1);
    console.log(
      `${name.padEnd(14)} |` + inks.map((v) => f2(v).padStart(9)).join(' |') +
      ` | ${mono ? 'OK' : '실패'}`,
    );
  }

  console.log('\n== D2. 끝(t≥duration)에서 drawStroke 를 «안 건» 정적 글자와 픽셀이 같은가 ==');
  console.log('폰트           | 평균  | 최대 | >0 픽셀 | 판정');
  for (const [name, family] of FONTS) {
    const drawn = await still(strokeDoc(family, 600), `d2-${name}-drawn`, 1200);
    const plain = await still(plainDoc(family), `d2-${name}-plain`, 1200);
    const d = diff(drawn, plain);
    let nonZero = 0;
    for (let i = 0; i < drawn.px.length; i++) if (drawn.px[i] !== plain.px[i]) nonZero++;
    console.log(
      `${name.padEnd(14)} | ${f2(d.mean).padStart(5)} | ${String(d.max).padStart(4)} | ` +
      `${String(nonZero).padStart(7)} | ${d.max === 0 ? 'OK — 완전히 같다' : '다르다(획이 덜 그려졌다)'}`,
    );
  }

  console.log('\n== D3. fps 무관성 — 30 vs 60fps 의 같은 절대 시각(400ms) ==');
  for (const [name, family] of FONTS) {
    const at = async (fps: number): Promise<Frame> => {
      const base = strokeDoc(family);
      return still({ ...base, settings: { ...base.settings, fps } }, `d3-${name}-${fps}`, 400);
    };
    const d = diff(await at(30), await at(60));
    console.log(`  ${name.padEnd(14)} 평균 ${f2(d.mean)} · 최대 ${d.max}  (합격 평균 ≤ 2)`);
  }

  console.log('\n== D4. 외곽선을 «안 켠» 글자에도 획이 그려지는가 (글자 색으로) ==');
  const noStroke = docWith([['text', textClip({
    text: TEXT, style: textStyle({ fontFamily: "'Do Hyeon', sans-serif", fontSize: 200 }),
    animationIn: { type: 'drawStroke', duration: 1000, unit: 'char', staggerMs: 0 } as TextAnim,
  })]]);
  const withStroke = docWith([['text', textClip({
    text: TEXT,
    style: textStyle({ fontFamily: "'Do Hyeon', sans-serif", fontSize: 200, strokeColor: '#ff0000', strokeWidth: 10 }),
    animationIn: { type: 'drawStroke', duration: 1000, unit: 'char', staggerMs: 0 } as TextAnim,
  })]]);
  for (const [label, doc] of [['외곽선 없음', noStroke], ['외곽선 10px', withStroke]] as const) {
    const half = ink(await still(doc, `d4-${label}`, 500));
    const zero = ink(await still(doc, `d4-${label}-0`, 0));
    console.log(`  ${label.padEnd(11)} t=0 잉크 ${f2(zero).padStart(9)} · t=500 잉크 ${f2(half).padStart(9)} · ${half > zero + 10 ? 'OK — 그려진다' : '실패'}`);
  }

  console.log('\n== D5. 번들 폰트가 아닐 때(sans-serif) 대체 동작이 움직이는가 ==');
  const fallback = docWith([['text', textClip({
    text: TEXT, style: textStyle({ fontFamily: 'sans-serif', fontSize: 200 }),
    animationIn: { type: 'drawStroke', duration: 1000, unit: 'char', staggerMs: 0 } as TextAnim,
  })]]);
  const fb: number[] = [];
  for (const t of [0, 250, 500, 1000]) fb.push(ink(await still(fallback, `d5-${t}`, t)));
  console.log(`  잉크: ${fb.map((v) => f2(v)).join(' → ')}`);
  console.log(`  단조 증가(= 아무 일도 안 일어나지 않는다): ${fb.every((v, i) => i === 0 || v >= fb[i - 1]! - 1) && fb[fb.length - 1]! > fb[0]! + 10 ? 'OK' : '실패'}`);

}

// ── D6. Noto Sans KR — 정적 인스턴스 전/후 (W8 F8 #8) ──
//
// VF 의 기본 인스턴스가 Thin 이라 «전»에는 획이 가늘다가 t=1 에서 Regular 로 툭 바뀐다.
// «전»은 정적 두 파일을 잠시 치워(prewarm 전 상태) 같은 코드로 렌더한 것이다 — VF 폴백 경로.
//
// **«전» 은 별도 프로세스에서 돈다.** 한 프로세스에서 전→후 순서로 돌리면 «전»의 404·폴백 상태
// (Chromium 캐시·Remotion 브라우저 재사용)가 «후» 로 새어 Regular 가 계속 폴백된다 — 실제로 겪었다
// (전·후 픽셀이 완전히 같고 Bold 만 달랐다).
//
// 프레임은 정수라 t=0.999 는 못 찍는다: 120fps 에서 마지막 앞 프레임(991.7ms, p=0.992)을 쓴다.
// 「어느 파일이 실제로 쓰였나」는 **렌더된 「ㅣ」의 기둥 폭(px)** 으로 잰다 — Thin/Regular/Bold 가
// 세 개의 서로 다른 폭으로 나온다(가늘고 굵고의 판단을 눈이 아니라 숫자로 한다).
const NOTO = "'Noto Sans KR', sans-serif";
const D6_STATICS = ['NotoSansKR-Regular.ttf', 'NotoSansKR-Bold.ttf'].map((f) => path.join(MEDIA, 'fonts', f));

function d6Doc(text: string, fontSize: number, bold: boolean, durationMs: number): ProjectDoc {
  return docWith([['text', textClip({
    text, style: textStyle({ fontFamily: NOTO, fontSize, bold }),
    animationIn: { type: 'drawStroke', duration: durationMs, unit: 'char', staggerMs: 0 } as TextAnim,
  })]], { fps: 120 });
}

/** 한 «다리»(전/후/후·굵게)의 프레임들을 렌더한다. 파일 이름으로만 결과를 남긴다(다른 프로세스가 읽는다). */
async function d6RenderLeg(tag: string, bold: boolean): Promise<void> {
  const doc = d6Doc('한글', 240, bold, 1000);
  await still(doc, `d6-${tag}-p0992`, 991.7);
  await still(doc, `d6-${tag}-p1`, 1000);
  await still(doc, `d6-${tag}-p05`, 500);
  // 기둥 폭 계측용 — 「ㅣ」 한 글자, p=0.95 (사각형 윤곽선이 거의 다 그려진 상태)
  await still(d6Doc('ㅣ', 400, bold, 1000), `d6-${tag}-stem`, 950);
}

/** 가운데 가로줄의 «흰 구간»들 — [시작, 끝] px. 기둥이 하나면 1개, 속이 빈 윤곽선이면 2개다. */
function whiteRuns(f: Frame, y: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let x = 0; x < f.w; x++) {
    const on = f.px[y * f.w + x]! >= 128;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, f.w - 1]);
  return runs;
}

async function d6Measure(tag: string): Promise<{ mean: number; max: number; over: number; inkHalf: number; stemW: number; runs: number; gap: number }> {
  const near = await grayPng(path.join(OUT, `d6-${tag}-p0992.png`));
  const end = await grayPng(path.join(OUT, `d6-${tag}-p1.png`));
  const half = await grayPng(path.join(OUT, `d6-${tag}-p05.png`));
  const stem = await grayPng(path.join(OUT, `d6-${tag}-stem.png`));
  // 「ㅣ」 는 세로 막대라 세로 중앙 부근 어느 줄이든 기둥을 지난다 — 가운데서 조금 위(글자 중앙)를 본다
  const y = Math.floor(stem.h / 2);
  const runs = whiteRuns(stem, y).filter(([a, b]) => b - a >= 2);
  const stemW = runs.length ? runs[runs.length - 1]![1] - runs[0]![0] + 1 : 0;
  const gap = runs.length >= 2 ? runs[1]![0] - runs[0]![1] - 1 : 0;
  return { ...diff(near, end), inkHalf: ink(half), stemW, runs: runs.length, gap };
}

async function checkD6(): Promise<void> {
  if (process.env.KITKAT_D6_LEG === 'before') {
    // 자식 프로세스: 정적 파일을 치우고 «전» 다리만 렌더한다
    for (const f of D6_STATICS) if (existsSync(f)) await fs.rename(f, `${f}.bak`);
    try {
      await d6RenderLeg('before', false);
    } finally {
      for (const f of D6_STATICS) if (existsSync(`${f}.bak`)) await fs.rename(`${f}.bak`, f);
    }
    console.log('  («전» 다리 렌더 완료 — 자식 프로세스)');
    return;
  }

  console.log('\n== D6. Noto Sans KR — 마지막 앞 프레임(p=0.992) ↔ 끝(p=1) 픽셀 차이, 정적 인스턴스 전/후 ==');
  for (const f of D6_STATICS) {
    if (!existsSync(f)) throw new Error(`${f} 이 없습니다 — node scripts/prewarm.mjs fonts`);
  }
  await d6RenderLeg('after', false);
  await d6RenderLeg('after-bold', true);
  console.log('  «전»(정적 파일 없음) 다리를 별도 프로세스로 렌더 중… (404·폴백 상태가 «후» 로 새지 않게)');
  const r = spawnSync('npx', ['tsx', fileURLToPath(import.meta.url), '6'], {
    env: { ...process.env, KITKAT_D6_LEG: 'before' },
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) throw new Error(`«전» 다리 프로세스 실패 (exit ${r.status})`);
  for (const f of D6_STATICS) if (!existsSync(f)) throw new Error(`${f} 이 복구되지 않았습니다`);

  const before = await d6Measure('before');
  const after = await d6Measure('after');
  const afterBold = await d6Measure('after-bold');
  console.log('경우                 | 평균  |  최대 | >12 픽셀 | p=0.5 잉크 | 「ㅣ」기둥 폭(px) | 흰 구간 | 속 빈 폭');
  const row = (name: string, m: Awaited<ReturnType<typeof d6Measure>>): void =>
    console.log(
      `${name.padEnd(20)} | ${f2(m.mean).padStart(5)} | ${String(m.max).padStart(5)} | ${String(m.over).padStart(8)} | ` +
      `${f2(m.inkHalf).padStart(10)} | ${String(m.stemW).padStart(15)} | ${String(m.runs).padStart(7)} | ${String(m.gap).padStart(7)}`,
    );
  row('전(VF Thin 폴백)', before);
  row('후(정적 Regular)', after);
  row('후·굵게(정적 Bold)', afterBold);
  console.log(
    `  기둥 폭: Thin ${before.stemW}px → Regular ${after.stemW}px → Bold ${afterBold.stemW}px ` +
    `(${after.stemW > before.stemW && afterBold.stemW > after.stemW ? 'OK — 세 폭이 다르고 굵어진다' : '실패'})`,
  );
  console.log(
    `  p=0.992↔1 >12 픽셀 수: ${before.over} → ${after.over} ` +
    `(${before.over > 0 ? f2((1 - after.over / before.over) * 100) : '0'}% 감소) · 평균 ${f2(before.mean)} → ${f2(after.mean)}`,
  );
}

// ── M. 자유 마스크 ────────────────────────────────────────────────────────

const IMG = { id: 'wht', kind: 'image', src: 'assets/w8f9-white.png', name: 'white', width: W, height: H };

function maskedImage(mask: Mask | Mask[], over: Record<string, unknown> = {}): ProjectDoc {
  const clip: Record<string, unknown> = {
    id: 'im', kind: 'image', assetId: 'wht', start: 0, duration: 1000,
    ...(Array.isArray(mask) ? { masks: mask } : { mask }),
    ...over,
  };
  return docWith([['video', clip, IMG]]);
}

/** 마스크가 남긴 알파(=흰 그림의 밝기) 합 — 넓이에 비례한다. */
const area = (f: Frame): number => ink(f);

async function checkM(): Promise<void> {
  await makeWhite('assets/w8f9-white.png', W, H);

  console.log('\n== M1. 하드 엣지 정확도 — 삼각형 꼭짓점이 계산값과 ±1px 인가 ==');
  // 마스크 상자 (0.2,0.1,0.6,0.8) 안의 삼각형 (0,0)(1,0)(0.5,1)
  const tri: Mask = { shape: 'path', feather: 0, x: 0.2, y: 0.1, w: 0.6, h: 0.8, d: 'M 0,0 L 1,0 L 0.5,1 Z' };
  const fTri = await still(maskedImage(tri), 'm1-tri', 0);
  const cp = extent(columnProfile(fTri), 128);
  const rp = extent(rowProfile(fTri), 128);
  const wantLeft = 0.2 * W;
  const wantRight = (0.2 + 0.6) * W;
  const wantTop = 0.1 * H;
  const wantBottom = (0.1 + 0.8) * H;
  console.log(`  좌: 실측 ${cp.lo} / 기대 ${wantLeft} (Δ ${f2(Math.abs(cp.lo - wantLeft))})`);
  console.log(`  우: 실측 ${cp.hi} / 기대 ${wantRight - 1} (Δ ${f2(Math.abs(cp.hi - (wantRight - 1)))})`);
  console.log(`  상: 실측 ${rp.lo} / 기대 ${wantTop} (Δ ${f2(Math.abs(rp.lo - wantTop))})`);
  console.log(`  하: 실측 ${rp.hi} / 기대 ${wantBottom - 1} (Δ ${f2(Math.abs(rp.hi - (wantBottom - 1)))})`);
  // 삼각형 넓이 = 상자의 1/2
  const boxArea = 0.6 * W * 0.8 * H;
  console.log(`  넓이: 실측 ${f2(area(fTri))} / 기대 ${f2(boxArea / 2)} (오차 ${f2(Math.abs(area(fTri) - boxArea / 2) / (boxArea / 2) * 100)}%)`);

  console.log('\n== M2. 페더 — 경계 전이 폭이 feather 에 비례하고 단조인가 ==');
  console.log('feather |  10→90% 전이 폭(px) | 비 (폭/feather) | 단조 감소');
  for (const feather of [0, 0.1, 0.3, 0.6]) {
    const m: Mask = { shape: 'path', feather, x: 0.25, y: 0.25, w: 0.5, h: 0.5, d: 'M 0,0 L 1,0 L 1,1 L 0,1 Z' };
    const f = await still(maskedImage(m), `m2-feather-${feather}`, 0);
    // 가운데 가로줄에서 왼쪽 경계를 가로지르는 알파 프로파일
    const y = Math.floor(H / 2);
    const row: number[] = [];
    for (let x = 0; x < f.w; x++) row.push(f.px[y * f.w + x]!);
    const peak = Math.max(...row);
    const t10 = row.findIndex((v) => v >= peak * 0.1);
    const t90 = row.findIndex((v) => v >= peak * 0.9);
    const width = t90 - t10;
    // 단조: 왼쪽 끝에서 중앙까지 값이 줄지 않는가
    let monoOk = true;
    for (let x = 1; x <= Math.floor(f.w / 2); x++) if (row[x]! < row[x - 1]! - 2) monoOk = false;
    const k = feather > 0 ? width / (feather * Math.min(W, H)) : 0;
    console.log(`  ${String(feather).padStart(5)} | ${String(width).padStart(18)} | ${f2(k).padStart(14)} | ${monoOk ? 'OK' : '실패(프리멀티플라이 의심)'}`);
  }

  console.log('\n== M3. 여러 마스크 — add / subtract / intersect 의 보이는 넓이 ==');
  // 왼쪽 절반 사각형 + 오른쪽 절반 사각형, 겹침 = 가운데 1/4
  const left: Mask = { shape: 'path', feather: 0, x: 0, y: 0.25, w: 0.6, h: 0.5, d: 'M 0,0 L 1,0 L 1,1 L 0,1 Z' };
  const right: Mask = { shape: 'path', feather: 0, x: 0.4, y: 0.25, w: 0.6, h: 0.5, d: 'M 0,0 L 1,0 L 1,1 L 0,1 Z' };
  const A = 0.6 * W * 0.5 * H;
  const overlap = 0.2 * W * 0.5 * H;
  const want = { add: 2 * A - overlap, subtract: A - overlap, intersect: overlap };
  console.log('op        |     실측 |     기대 | 오차');
  for (const op of ['add', 'subtract', 'intersect'] as const) {
    const f = await still(maskedImage([left, { ...right, op }]), `m3-${op}`, 0);
    const got = area(f);
    console.log(`${op.padEnd(9)} | ${f2(got).padStart(8)} | ${f2(want[op]).padStart(8)} | ${f2(Math.abs(got - want[op]) / want[op] * 100)}%`);
  }

  console.log('\n== M4. 반전 — 원본 + 반전 = 전체가 정확히 채워지는가 ==');
  const base: Mask = { shape: 'path', feather: 0.3, x: 0.2, y: 0.2, w: 0.6, h: 0.6, d: 'M 0.5,0 L 1,0.5 L 0.5,1 L 0,0.5 Z' };
  const fa = await still(maskedImage(base), 'm4-normal', 0);
  const fb = await still(maskedImage({ ...base, invert: true }), 'm4-invert', 0);
  let worst = 0;
  let sum = 0;
  for (let i = 0; i < fa.px.length; i++) {
    const s = (fa.px[i]! + fb.px[i]!) / 255;
    sum += s;
    worst = Math.max(worst, Math.abs(s - 1));
  }
  console.log(`  알파 합 평균 ${f2(sum / fa.px.length)} · 최대 오차 ${f2(worst)} (합격 ≤ 0.01)`);

  console.log('\n== M5. 모양 키프레임(dKeys) — 보이는 넓이가 단조 변화하는가 ==');
  const small = 'M 0.25,0.25 L 0.75,0.25 L 0.75,0.75 L 0.25,0.75 Z';
  const big = 'M 0,0 L 1,0 L 1,1 L 0,1 Z';
  const anim: Mask = {
    shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1, d: small,
    dKeys: [{ time: 0, d: small }, { time: 1000, d: big }],
  };
  const areas: number[] = [];
  for (const t of [0, 250, 500, 750, 1000]) {
    const f = await still(maskedImage(anim), `m5-${t}`, t);
    areas.push(area(f));
  }
  console.log(`  넓이: ${areas.map((v) => f2(v)).join(' → ')}`);
  console.log(`  단조 증가: ${areas.every((v, i) => i === 0 || v >= areas[i - 1]! - 1) ? 'OK' : '실패'}`);
  // t=0 · t=1000 이 각 키의 정적 결과와 같은가
  const staticSmall = await still(maskedImage({ shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1, d: small }), 'm5-static-small', 0);
  const d0 = diff(await still(maskedImage(anim), 'm5-cmp0', 0), staticSmall);
  console.log(`  t=0 ↔ 정적 결과: 평균 ${f2(d0.mean)} · 최대 ${d0.max} (합격 0)`);
}

// ── X. 마스크 × 회전 × mixBlendMode (W7 이 확인 못 한 항목) ───────────────

async function checkX(): Promise<void> {
  await makeWhite('assets/w8f9-white.png', W, H);
  console.log('\n== X. mask + mixBlendMode + 부모 transform 8조합 ==');
  console.log('규격상의 순서는 「그리기 → 필터 → 클립/마스크 → 불투명도 → 블렌드」라');
  console.log('마스크가 먼저, 블렌드가 나중이고 transform 은 마스크까지 포함한 결과에 걸린다.');
  console.log('즉 «마스크가 클립과 함께 돈다» 가 맞아야 한다. 실제로 재 본다.\n');

  const rect: Mask = { shape: 'rect', feather: 0, x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const pathM: Mask = { shape: 'path', feather: 0, x: 0.25, y: 0.25, w: 0.5, h: 0.5, d: 'M 0,0 L 1,0 L 1,1 L 0,1 Z' };

  console.log('마스크 | 회전 | 블렌드 |   좌 |   우 |   상 |   하 | 기대 반너비 | 판정(±2px)');
  for (const [mname, mask] of [['rect', rect], ['path', pathM]] as const) {
    for (const rotation of [0, 30]) {
      for (const blend of [undefined, 'screen'] as const) {
        const doc = maskedImage(mask, {
          transform: { x: 0, y: 0, scale: 1, rotation },
          ...(blend ? { blendMode: blend } : {}),
        });
        const f = await still(doc, `x-${mname}-${rotation}-${blend ?? 'none'}`, 0);
        const cp = extent(columnProfile(f), 100);
        const rp = extent(rowProfile(f), 100);
        // 정사각형 마스크(0.5W × 0.5H)를 θ 만큼 돌리면 가로 반너비 = (w·|cosθ| + h·|sinθ|)/2
        const mw = 0.5 * W;
        const mh = 0.5 * H;
        const th = (rotation * Math.PI) / 180;
        const halfW = (mw * Math.abs(Math.cos(th)) + mh * Math.abs(Math.sin(th))) / 2;
        const gotHalfW = (cp.hi - cp.lo + 1) / 2;
        const ok = Math.abs(gotHalfW - halfW) <= 2;
        console.log(
          `${mname.padEnd(6)} | ${String(rotation).padStart(4)} | ${(blend ?? '-').padEnd(6)} | ` +
          `${String(cp.lo).padStart(4)} | ${String(cp.hi).padStart(4)} | ${String(rp.lo).padStart(4)} | ${String(rp.hi).padStart(4)} | ` +
          `${f2(halfW).padStart(11)} | ${ok ? 'OK' : `어긋남 (실측 ${f2(gotHalfW)})`}`,
        );
      }
    }
  }
}

// 결과를 파일로도 남긴다 — 백그라운드로 돌릴 때 표준출력이 안 보일 수 있다.
const LOG = path.join(OUT, `report-${process.argv[2] ?? 'all'}.txt`);
const lines: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]): void => {
  const s = args.map(String).join(' ');
  lines.push(s);
  realLog(s);
};

const which = process.argv[2] ?? 'tdpmx';
try {
  if (which.includes('t')) await checkT();
  if (which.includes('d')) {
    await checkD();
    await checkD6();
  } else if (which.includes('6')) {
    await checkD6();
  }
  if (which.includes('p')) await checkP();
  if (which.includes('m')) await checkM();
  if (which.includes('x')) await checkX();
} catch (e) {
  // finally 의 process.exit 가 예외를 삼키지 않게 여기서 먼저 찍는다
  console.log(`\n!! 오류: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await fs.writeFile(LOG, lines.join('\n'), 'utf8');
  realLog(`\n(기록: ${LOG})`);
  // 정적 서버가 이벤트 루프를 잡고 있어 그냥 두면 프로세스가 안 끝난다.
  if (serverPromise) await (await serverPromise).close().catch(() => undefined);
  process.exit(process.exitCode ?? 0);
}
