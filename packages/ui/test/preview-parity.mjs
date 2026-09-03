// W8 F15 — 프리뷰(WebGL) vs 렌더러(SVG 필터/CSS) **픽셀 대조**.
//
//   node packages/ui/test/preview-parity.mjs           9종 대조 + 성능 + 메모리
//   node packages/ui/test/preview-parity.mjs noise     feTurbulence 그레인 분포만
//
// **GPU 안전** — 이 컴퓨터의 NVIDIA MX450 은 GPU 작업 중 여러 번 다운됐다(BugCheck 0x116).
// 그래서 소프트웨어 래스터라이저(SwiftShader)만 쓴다. `--use-angle=gpu` 를 넣지 마라.
//
// 기준은 «렌더러가 만든 DOM 을 Chrome 이 래스터화한 것» 이다. 서버 렌더(Remotion)도
// 결국 같은 Chrome 이 같은 DOM 을 그린다 — 다른 것은 ffmpeg 로 묶느냐뿐이다.
import { execFileSync } from 'node:child_process';
import { accessSync, existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, 'media', 'w8-f15');

const THRESHOLD = { mean: 3, max: 12 };

// 펜으로 그린 것 같은 자유 곡선 (마스크 상자 안 0..1). dKeys 보간을 쓰려면 **명령 구성이 같아야**
// 하므로 PATH_D2 는 좌표만 다르다.
const PATH_D =
  'M 0.5,0.02 C 0.86,0.06 1,0.36 0.9,0.63 C 0.78,0.95 0.34,1 0.16,0.82 C 0,0.65 0.06,0.18 0.5,0.02 Z';
const PATH_D2 =
  'M 0.3,0.1 C 0.9,0.02 0.95,0.5 0.82,0.78 C 0.6,1 0.2,0.9 0.08,0.66 C 0,0.42 0.1,0.22 0.3,0.1 Z';

// ── 대조 항목 9종 ─────────────────────────────────────────────────────────
const CASES = [
  { key: 'mask-rect', label: '마스크 rect(feather 0.35)',
    spec: { name: 'mask-rect', mask: { shape: 'rect', feather: 0.35, x: 0.12, y: 0.1, w: 0.7, h: 0.75 } } },
  { key: 'mask-circle', label: '마스크 circle(feather 0.4)',
    spec: { name: 'mask-circle', mask: { shape: 'circle', feather: 0.4, x: 0.15, y: 0.1, w: 0.6, h: 0.8 } } },
  { key: 'mask-linear', label: '마스크 linear(feather 0.3)',
    spec: { name: 'mask-linear', mask: { shape: 'linear', feather: 0.3, x: 0, y: 0.15, w: 1, h: 0.7 } } },
  // ── W8 F17 — 자유 곡선(펜) 마스크 · 여러 장 겹치기 ──
  // `d` 는 **마스크 상자 안 0..1** 이다 (최종 px = (x + dx·w)·boxW).
  { key: 'mask-path', label: '마스크 path(feather 0 — clip-path 경로)',
    spec: { name: 'mask-path', mask: { shape: 'path', feather: 0, x: 0.1, y: 0.08, w: 0.75, h: 0.8, d: PATH_D } } },
  // 페더를 σ≈0.14px 로 두면 «거의 하드 엣지»인데 경로는 SVG <mask> 를 탄다 —
  // clip-path 의 AA 와 SVG 경로 채우기의 AA 중 어느 쪽이 갈리는지 가르는 대조군이다.
  { key: 'mask-path-f001', label: '마스크 path(feather 0.001 — SVG mask, σ≈0.14px)',
    spec: { name: 'mask-path-f001', mask: { shape: 'path', feather: 0.001, x: 0.1, y: 0.08, w: 0.75, h: 0.8, d: PATH_D } } },
  // 가로 직선 한 줄만 있는 자유 곡선 — 아래 변이 y=100.35 에 오므로 100 행의 «정확한» 덮임은
  // 0.35 다. 브라우저 두 래스터라이저(DOM 경로 AA vs Canvas2D 경로 AA)를 가르는 자다.
  { key: 'mask-hedge', label: '마스크 path(가로 변 y=100.35 — AA 기준자)',
    spec: { name: 'mask-hedge', mask: {
      shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 0.371666,
      d: 'M 0,0 L 1,0 L 1,1 L 0,1 Z',
    } } },
  { key: 'mask-path-f01', label: '마스크 path(feather 0.1 — SVG mask+블러)',
    spec: { name: 'mask-path-f01', mask: { shape: 'path', feather: 0.1, x: 0.1, y: 0.08, w: 0.75, h: 0.8, d: PATH_D } } },
  { key: 'mask-path-f03', label: '마스크 path(feather 0.3 — SVG mask+블러)',
    spec: { name: 'mask-path-f03', mask: { shape: 'path', feather: 0.3, x: 0.1, y: 0.08, w: 0.75, h: 0.8, d: PATH_D } } },
  { key: 'mask-path-inv0', label: '마스크 path 반전(feather 0 — evenodd 구멍)',
    spec: { name: 'mask-path-inv0', mask: { shape: 'path', feather: 0, invert: true, x: 0.1, y: 0.08, w: 0.75, h: 0.8, d: PATH_D } } },
  { key: 'mask-path-inv', label: '마스크 path 반전(feather 0.2 — feFuncA 1 0)',
    spec: { name: 'mask-path-inv', mask: { shape: 'path', feather: 0.2, invert: true, x: 0.1, y: 0.08, w: 0.75, h: 0.8, d: PATH_D } } },
  { key: 'mask-2-add', label: '마스크 2장 add (원 ∪ 자유곡선)',
    spec: { name: 'mask-2-add', masks: [
      { shape: 'circle', feather: 0.2, x: 0.05, y: 0.1, w: 0.5, h: 0.7 },
      { shape: 'path', feather: 0.15, x: 0.4, y: 0.15, w: 0.55, h: 0.7, d: PATH_D, op: 'add' },
    ] } },
  { key: 'mask-2-sub', label: '마스크 2장 subtract (원 − 자유곡선)',
    spec: { name: 'mask-2-sub', masks: [
      { shape: 'circle', feather: 0.2, x: 0.05, y: 0.1, w: 0.5, h: 0.7 },
      { shape: 'path', feather: 0.15, x: 0.4, y: 0.15, w: 0.55, h: 0.7, d: PATH_D, op: 'subtract' },
    ] } },
  { key: 'mask-2-int', label: '마스크 2장 intersect (원 ∩ 자유곡선)',
    spec: { name: 'mask-2-int', masks: [
      { shape: 'circle', feather: 0.2, x: 0.05, y: 0.1, w: 0.6, h: 0.8 },
      { shape: 'path', feather: 0.15, x: 0.2, y: 0.1, w: 0.7, h: 0.8, d: PATH_D, op: 'intersect' },
    ] } },
  { key: 'mask-3', label: '마스크 3장 (rect ∩ (linear ∪ path)) — 접힘 순서',
    spec: { name: 'mask-3', masks: [
      { shape: 'rect', feather: 0.2, x: 0.05, y: 0.05, w: 0.85, h: 0.85 },
      { shape: 'linear', feather: 0.3, x: 0, y: 0.1, w: 1, h: 0.8, op: 'intersect' },
      { shape: 'path', feather: 0.1, x: 0.3, y: 0.2, w: 0.6, h: 0.6, d: PATH_D, op: 'add' },
    ] } },
  { key: 'mask-anim', label: '마스크 dKeys 중간 프레임(t=0.5)',
    spec: { name: 'mask-anim', tMs: 500, mask: {
      shape: 'path', feather: 0.15, x: 0.1, y: 0.08, w: 0.75, h: 0.8, d: PATH_D,
      dKeys: [{ time: 0, d: PATH_D }, { time: 1000, d: PATH_D2 }],
    } } },
  { key: 'sharpen', label: 'sharpen(1.0)',
    spec: { name: 'sharpen', effects: [{ id: 'e', type: 'sharpen', params: { amount: 1 } }] } },
  { key: 'glow', label: 'glow(0.8 / r16)',
    spec: { name: 'glow', effects: [{ id: 'e', type: 'glow', params: { amount: 0.8, radius: 16 } }] } },
  { key: 'chromaShift', label: 'chromaShift(6px)',
    spec: { name: 'chromaShift', effects: [{ id: 'e', type: 'chromaShift', params: { px: 6 } }] } },
  { key: 'grain', label: 'grain(0.5) — 노이즈라 픽셀 대조 불가',
    spec: { name: 'grain', effects: [{ id: 'e', type: 'grain', params: { amount: 0.5 } }], frame: 3 } },
  { key: 'scanlines', label: 'scanlines(0.6 / 600줄)',
    spec: { name: 'scanlines', effects: [{ id: 'e', type: 'scanlines', params: { amount: 0.6, lines: 600 } }] } },
  { key: 'lightLeak', label: 'lightLeak(0.7 / hue 30)',
    spec: { name: 'lightLeak', effects: [{ id: 'e', type: 'lightLeak', params: { amount: 0.7, hue: 30 } }] } },
  { key: 'glitch', label: 'glitch 전환 덮개(v=0.45)',
    spec: { name: 'glitch', glitch: 0.45 } },
  { key: 'blur', label: 'blur(8px)',
    spec: { name: 'blur', effects: [{ id: 'e', type: 'blur', params: { px: 8 } }] } },
  { key: 'blur24', label: 'blur(24px)',
    spec: { name: 'blur24', effects: [{ id: 'e', type: 'blur', params: { px: 24 } }] } },
  { key: 'all', label: '8종 전부 (마스크+샤픈+글로우+색수차+그레인+스캔+리크+블러)',
    spec: {
      name: 'all',
      mask: { shape: 'rect', feather: 0.25, x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
      frame: 5,
      effects: [
        { id: '1', type: 'blur', params: { px: 3 } },
        { id: '2', type: 'sharpen', params: { amount: 0.8 } },
        { id: '3', type: 'glow', params: { amount: 0.6, radius: 12 } },
        { id: '4', type: 'chromaShift', params: { px: 4 } },
        { id: '5', type: 'grain', params: { amount: 0.4 } },
        { id: '6', type: 'scanlines', params: { amount: 0.5, lines: 500 } },
        { id: '7', type: 'lightLeak', params: { amount: 0.5, hue: 45 } },
      ],
    } },
  { key: 'all-nograin', label: '7종 (그레인 빼고 전부)',
    spec: {
      name: 'all-nograin',
      mask: { shape: 'rect', feather: 0.25, x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
      effects: [
        { id: '1', type: 'blur', params: { px: 3 } },
        { id: '2', type: 'sharpen', params: { amount: 0.8 } },
        { id: '3', type: 'glow', params: { amount: 0.6, radius: 12 } },
        { id: '4', type: 'chromaShift', params: { px: 4 } },
        { id: '6', type: 'scanlines', params: { amount: 0.5, lines: 500 } },
        { id: '7', type: 'lightLeak', params: { amount: 0.5, hue: 45 } },
      ],
    } },
  // ── W8 #8 — WebGL 효과 6종 (렌더 = Remotion createEffect 체인, 미리보기 = gl-passes) ──
  { key: 'vibrance', label: 'vibrance(0.8)', gl: true,
    spec: { name: 'vibrance', effects: [{ id: 'e', type: 'vibrance', params: { amount: 0.8 } }] } },
  { key: 'bokeh', label: 'bokeh(r12 / 1.0, 표본 간격 1)', gl: true,
    spec: { name: 'bokeh', effects: [{ id: 'e', type: 'bokeh', params: { radius: 12, amount: 1 } }] } },
  { key: 'bokeh30', label: 'bokeh(r30 / 0.8, 표본 간격 3)', gl: true,
    spec: { name: 'bokeh30', effects: [{ id: 'e', type: 'bokeh', params: { radius: 30, amount: 0.8 } }] } },
  { key: 'radialBlur', label: 'radialBlur(24px, 중심 0.5/0.5)', gl: true,
    spec: { name: 'radialBlur', effects: [{ id: 'e', type: 'radialBlur', params: { px: 24, cx: 0.5, cy: 0.5 } }] } },
  { key: 'mirror', label: 'mirror(좌우 · 앞 · 0.5)', gl: true,
    spec: { name: 'mirror', effects: [{ id: 'e', type: 'mirror', params: { axis: 0, side: 0, pos: 0.5 } }] } },
  { key: 'mirror-quad', label: 'mirror(사분면 · 뒤 · 0.4)', gl: true,
    spec: { name: 'mirror-quad', effects: [{ id: 'e', type: 'mirror', params: { axis: 2, side: 1, pos: 0.4 } }] } },
  { key: 'kaleidoscope', label: 'kaleidoscope(6조각 · 15°)', gl: true,
    spec: { name: 'kaleidoscope', effects: [{ id: 'e', type: 'kaleidoscope', params: { segments: 6, angle: 15 } }] } },
  { key: 'halftone', label: 'halftone(8px · 45°)', gl: true,
    spec: { name: 'halftone', effects: [{ id: 'e', type: 'halftone', params: { size: 8, angle: 45 } }] } },
  { key: 'gl-all', label: 'WebGL 6종 전부 + 커브 뒤 blur·glow (체인 순서)', gl: true,
    spec: {
      name: 'gl-all',
      effects: [
        { id: '1', type: 'vibrance', params: { amount: 0.5 } },
        { id: '2', type: 'mirror', params: { axis: 1, side: 0, pos: 0.6 } },
        { id: '3', type: 'kaleidoscope', params: { segments: 4, angle: 0 } },
        { id: '4', type: 'radialBlur', params: { px: 10, cx: 0.5, cy: 0.5 } },
        { id: '5', type: 'bokeh', params: { radius: 6, amount: 0.7 } },
        { id: '6', type: 'halftone', params: { size: 10, angle: 30 } },
        { id: '7', type: 'blur', params: { px: 2 } },
        { id: '8', type: 'glow', params: { amount: 0.5, radius: 10 } },
      ],
    } },
  // 회귀 확인 — 아무 효과도 없는 클립(단일 패스 경로)
  { key: 'plain', label: '효과 없음 (단일 패스 회귀 확인)', spec: { name: 'plain' } },
  { key: 'color-only', label: '색만 (brightness+temperature, 단일 패스)',
    spec: { name: 'color-only', effects: [
      { id: 'a', type: 'brightness', params: { amount: 1.15 } },
      { id: 'b', type: 'temperature', params: { amount: 0.6 } },
    ] } },
];

function chromePath() {
  const cache = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cache', 'puppeteer', 'chrome');
  try {
    const dirs = readdirSync(cache).sort();
    const last = dirs[dirs.length - 1];
    const p = path.join(cache, last, 'chrome-win64', 'chrome.exe');
    if (existsSync(p)) return p;
  } catch {
    /* 아래 후보로 */
  }
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]) {
    try {
      accessSync(p);
      return p;
    } catch {
      /* 다음 */
    }
  }
  throw new Error('Chrome 을 못 찾았다');
}

async function bundle() {
  await fs.mkdir(OUT, { recursive: true });
  const outFile = path.join(OUT, 'parity-bundle.js');
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(HERE, 'parity-entry.ts'),
      '--bundle', '--format=iife', '--target=chrome120',
      '--define:process.env.NODE_ENV="production"',
      `--outfile=${outFile}`,
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return outFile;
}

const PAGE = (js) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#000}
  #stage{position:relative;width:480px;height:270px;background:#000;overflow:hidden}
  #ref{position:absolute;inset:0;background:#000;overflow:hidden}
  #gl{position:absolute;inset:0;display:none}
</style>
<div id="stage"><div id="ref"></div><canvas id="gl" width="480" height="270"></canvas></div>
<script>${js}</script>`;

async function main() {
  const mode = process.argv[2] ?? 'all';
  const js = await fs.readFile(await bundle(), 'utf8');
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: [
      // SwiftShader = 소프트웨어 래스터라이저. **NVIDIA 를 절대 안 쓴다.**
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--hide-scrollbars',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: 640, height: 400, deviceScaleFactor: 1 });
  await page.setContent(PAGE(js), { waitUntil: 'load' });
  await page.evaluate(() => window.kkReady());
  console.log(`래스터라이저: ${await page.evaluate(() => window.kkRenderer())}`);

  const clip = { x: 0, y: 0, width: 480, height: 270 };
  const shot = async () => `data:image/png;base64,${await page.screenshot({ clip, encoding: 'base64' })}`;

  if (mode === 'noise') {
    await page.evaluate(() => window.kkNoiseRef());
    const s = await page.evaluate((d) => window.kkStatsOf(d), await shot());
    console.log(`feTurbulence 그레인: 평균 ${s.mean.toFixed(4)} · 표준편차 ${s.sigma.toFixed(4)}`);
    await browser.close();
    return;
  }

  const only = process.argv[3];
  const rows = [];
  for (const c of CASES) {
    if (only && c.key !== only) continue;
    if (process.env.KK_PERFONLY) break; // 성능만 잴 때는 스크린샷 대조를 건너뛴다
    await page.evaluate((s) => window.kkBuildRef(s), c.spec);
    const png = await shot();
    const drew = await page.evaluate((s) => window.kkDrawPreview(s), c.spec);
    const st = await page.evaluate((d) => window.kkCompare(d), png);
    if (mode === 'dump') {
      await fs.writeFile(path.join(OUT, `${c.key}-ref.png`), Buffer.from(png.split(',')[1], 'base64'));
      await fs.writeFile(path.join(OUT, `${c.key}-gl.png`), Buffer.from(st.previewPng.split(',')[1], 'base64'));
      await fs.writeFile(path.join(OUT, `${c.key}-diff.png`), Buffer.from(st.diffPng.split(',')[1], 'base64'));
    }
    delete st.previewPng;
    delete st.diffPng;
    // «걸렸다» 증거 — 효과 없음 대비 픽셀 차이 (WebGL 6종만)
    const delta = c.gl ? await page.evaluate((s) => window.kkEffectDelta(s), c.spec) : null;
    rows.push({ ...c, ...st, glErr: drew.err, why: drew.why, bytes: drew.bytes, surf: drew.surf, delta });
  }

  // 한 항목만 볼 때는 성능·증거 구간을 건너뛴다 (KK_FAST=1) — 대조 수치를 손보는 동안 5분씩
  // 기다리지 않으려는 것이다. 최종 수치는 언제나 전체 실행으로 낸다.
  if (process.env.KK_FAST) {
    console.log('\n== 픽셀 대조 (KK_FAST — 성능/증거 생략) ==');
    for (const r of rows) {
      const pass = r.mean <= THRESHOLD.mean && r.max <= THRESHOLD.max ? 'O' : 'X';
      console.log(
        `${r.label.padEnd(46)} ${r.mean.toFixed(2).padStart(6)} ${String(r.max).padStart(5)} ` +
        `${(r.overThreshold * 100).toFixed(2).padStart(7)}%  ${pass}` +
        (r.why.length ? `  배지:${r.why.join(',')}` : '') +
        (process.env.KK_HOT
          ? `\n    큰차이(앞): ${r.hot.join(' ')}\n    큰차이(뒤): ${r.hotLast.join(' ')}`
          : ''),
      );
    }
    // KK_MASKPROBE=키,y,x0,x1 — 셰이더를 거치기 **전**의 구운 알파를 그대로 본다
    if (process.env.KK_MASKPROBE) {
      const [key, y, x0, x1] = process.env.KK_MASKPROBE.split(',');
      const c = CASES.find((k) => k.key === key);
      const r = await page.evaluate(
        (a) => window.kkMaskProbe(a.spec, a.y, a.x0, a.x1),
        { spec: c.spec, y: +y, x0: +x0, x1: +x1 },
      );
      console.log(`\n== 구운 알파 (pad ${r.pad} tex ${r.texW}x${r.texH}) y=${y} x=${x0}..${x1} ==`);
      console.log(r.alpha.join(' '));
    }
    if (logs.length) console.log('\n== 브라우저 로그 ==\n' + logs.join('\n'));
    await browser.close();
    return;
  }

  // 성능만 — 단일 패스 회귀와 마스크 재사용을 **한 실행 안에서** 나란히 잰다
  // (이 컴퓨터의 SwiftShader 는 실행마다 20% 씩 흔들려서 실행을 넘나드는 비교는 못 믿는다)
  if (process.env.KK_PERFONLY) {
    const rp = await page.evaluate((spec) => window.kkBenchRepeat(spec, 150, 5),
      CASES.find((c) => c.key === 'plain').spec);
    const rc = await page.evaluate((spec) => window.kkBenchRepeat(spec, 150, 5),
      CASES.find((c) => c.key === 'color-only').spec);
    const md = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(`효과 없음: 중앙값 ${md(rp).toFixed(1)} fps  [${rp.map((v) => v.toFixed(0)).join(', ')}]`);
    console.log(`색만:      중앙값 ${md(rc).toFixed(1)} fps  [${rc.map((v) => v.toFixed(0)).join(', ')}]`);
    for (const [key, animate] of [
      ['mask-rect', false], ['mask-path-f03', false], ['mask-3', false], ['mask-anim', true],
    ]) {
      const r = await page.evaluate((a) => window.kkMaskReuse(a.spec, a.frames, a.animate),
        { spec: CASES.find((c) => c.key === key).spec, frames: 150, animate });
      console.log(`${key.padEnd(16)} ${r.fps.toFixed(1).padStart(6)} fps  굽기 ${r.misses} 재사용 ${r.hits}`);
    }
    await browser.close();
    return;
  }

  // ── 보케 «원반» 증거 — 한 점을 흐린 단면 ──
  const probe = await page.evaluate(() => window.kkProbeDisc(20, 10));
  const cx = 240;
  const atD = (arr, d) => arr[cx + d];
  const discFlat = atD(probe.disc, 0) > 0 && Math.abs(atD(probe.disc, 10) - atD(probe.disc, 0)) <= Math.max(2, atD(probe.disc, 0) * 0.15);
  const discEdge = atD(probe.disc, 17) > 0 && atD(probe.disc, 26) === 0;
  const gaussSlope = atD(probe.gauss, 0) > atD(probe.gauss, 10) * 1.3;

  // ── 성능 ──
  const bench = async (spec, frames) =>
    page.evaluate((a) => window.kkBench(a.spec, a.frames), { spec, frames });
  const fpsAll = await bench(CASES.find((c) => c.key === 'all').spec, 60);
  const fpsGlAll = await bench(CASES.find((c) => c.key === 'gl-all').spec, 30);
  const fpsGl = {};
  for (const k of ['vibrance', 'bokeh', 'bokeh30', 'radialBlur', 'mirror', 'kaleidoscope', 'halftone']) {
    fpsGl[k] = await bench(CASES.find((c) => c.key === k).spec, 30);
  }
  const fpsPlain = await bench(CASES.find((c) => c.key === 'plain').spec, 200);
  const fpsColor = await bench(CASES.find((c) => c.key === 'color-only').spec, 200);
  const fpsGlow = await bench(CASES.find((c) => c.key === 'glow').spec, 60);
  const fpsBlur = await bench(CASES.find((c) => c.key === 'blur24').spec, 60);
  const bytes = await page.evaluate(() => {
    const r = window.kkDrawPreview({ name: 'm', effects: [{ id: 'g', type: 'glow', params: { amount: 0.6, radius: 20 } }] });
    return r.bytes;
  });
  // ── 세로 영상(1080x1920) 실제 크기 — 재생 성능은 이 크기로 재야 뜻이 있다 ──
  const at = async (key, frames) =>
    page.evaluate((a) => window.kkBenchAt(a.spec, 1080, 1920, a.frames),
      { spec: CASES.find((c) => c.key === key).spec, frames });
  const bigAll = await at('all', 3);
  const bigGlAll = await at('gl-all', 2);
  const bigBokeh = await at('bokeh', 2);
  const bigHalftone = await at('halftone', 3);
  const bigPlain = await at('plain', 8);
  const bigColor = await at('color-only', 8);
  const bigBlur = await at('blur24', 3);
  const bigGlow = await at('glow', 3);
  const freshBytes = await page.evaluate(() => window.kkFreshBytes());
  const rep = async (key) =>
    page.evaluate((spec) => window.kkBenchRepeat(spec, 150, 5),
      CASES.find((c) => c.key === key).spec);
  const repPlain = await rep('plain');
  const repColor = await rep('color-only');

  // ── W8 F17 — 마스크 알파 캔버스 재사용 · fps ──
  const reuse = async (key, frames, animate) =>
    page.evaluate((a) => window.kkMaskReuse(a.spec, a.frames, a.animate),
      { spec: CASES.find((c) => c.key === key).spec, frames, animate: !!animate });
  const maskReuse = {
    path: await reuse('mask-path-f03', 120, false),
    multi: await reuse('mask-3', 120, false),
    anim: await reuse('mask-anim', 120, true),
    none: await reuse('plain', 120, false),
    rect: await reuse('mask-rect', 120, false),
  };

  console.log('\n== 픽셀 대조 (기준: 렌더러 DOM 을 Chrome/SwiftShader 가 그린 것) ==');
  console.log('항목                                             평균   최대   >12비율  통과   안쪽평균 안쪽최대');
  for (const r of rows) {
    const pass = r.mean <= THRESHOLD.mean && r.max <= THRESHOLD.max ? 'O' : 'X';
    console.log(
      `${r.label.padEnd(46)} ${r.mean.toFixed(2).padStart(6)} ${String(r.max).padStart(5)} ` +
      `${(r.overThreshold * 100).toFixed(2).padStart(7)}%  ${pass}   ` +
      `${r.innerMean.toFixed(2).padStart(8)} ${String(r.innerMax).padStart(8)}` +
      `  잡음(기준 ${r.hfRef.toFixed(2)} / GL ${r.hfGl.toFixed(2)})` +
      (r.delta ? `  걸림증거 Δ평균 ${r.delta.mean.toFixed(2)} Δ최대 ${r.delta.max}` : '') +
      (r.why.length ? `  배지:${r.why.join(',')}` : '') +
      (process.env.KK_HOT ? `
    표면: ${r.surf}
    가장자리(좌${r.edge.L} 우${r.edge.R} 상${r.edge.T} 하${r.edge.B} 안${r.edge.mid})
    큰차이: ${r.hot.join(' ')}
    표본: ${r.probe.join('  ')}` : ''),
    );
  }
  console.log('\n== 보케 «원반» 증거 (검은 바탕 한 점, r=20 vs blur 10px) — 중심에서의 거리별 값 ==');
  console.log(`  bokeh r20:  ${[0, 5, 10, 15, 17, 19, 21, 23, 26, 30].map((d) => `+${d}:${atD(probe.disc, d)}`).join('  ')}`);
  console.log(`  blur 10px:  ${[0, 5, 10, 15, 17, 19, 21, 23, 26, 30].map((d) => `+${d}:${atD(probe.gauss, d)}`).join('  ')}`);
  console.log(`  원반 판정: 평평한 꼭대기 ${discFlat ? 'O' : 'X'} · r 에서 뚝 끊김 ${discEdge ? 'O' : 'X'} · (가우시안은 미끄러짐 ${gaussSlope ? 'O' : 'X'})`);
  console.log('\n== 성능 (480x270, SwiftShader 소프트웨어 래스터) ==');
  console.log(`8종 전부:        ${fpsAll.toFixed(1)} fps`);
  console.log(`WebGL 6종+blur+glow: ${fpsGlAll.toFixed(1)} fps`);
  for (const [k, v] of Object.entries(fpsGl)) console.log(`${(k + ':').padEnd(17)}${v.toFixed(1)} fps`);
  console.log(`글로우만:        ${fpsGlow.toFixed(1)} fps`);
  console.log(`블러 24px:       ${fpsBlur.toFixed(1)} fps`);
  console.log(`효과 없음:       ${fpsPlain.toFixed(1)} fps  (단일 패스 — 회귀 확인)`);
  console.log(`색만:            ${fpsColor.toFixed(1)} fps  (단일 패스 — 회귀 확인)`);
  console.log('\n== 성능 (1080x1920 세로, SwiftShader 소프트웨어 래스터) ==');
  console.log(`8종 전부:        ${bigAll.fps.toFixed(2)} fps   패스 메모리 ${(bigAll.bytes / 1048576).toFixed(1)} MiB`);
  console.log(`WebGL 6종+2:     ${bigGlAll.fps.toFixed(2)} fps   패스 메모리 ${(bigGlAll.bytes / 1048576).toFixed(1)} MiB`);
  console.log(`보케 r12 만:     ${bigBokeh.fps.toFixed(2)} fps`);
  console.log(`망점만:          ${bigHalftone.fps.toFixed(2)} fps`);
  console.log(`글로우만:        ${bigGlow.fps.toFixed(2)} fps   패스 메모리 ${(bigGlow.bytes / 1048576).toFixed(1)} MiB`);
  console.log(`블러 24px:       ${bigBlur.fps.toFixed(2)} fps   패스 메모리 ${(bigBlur.bytes / 1048576).toFixed(1)} MiB`);
  console.log(`효과 없음:       ${bigPlain.fps.toFixed(2)} fps   패스 메모리 ${(bigPlain.bytes / 1048576).toFixed(1)} MiB`);
  console.log(`색만:            ${bigColor.fps.toFixed(2)} fps   패스 메모리 ${(bigColor.bytes / 1048576).toFixed(1)} MiB`);
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log('\n== 단일 패스 회귀 (480x270, 150프레임 x 5회) ==');
  console.log(`효과 없음: 중앙값 ${med(repPlain).toFixed(1)} fps  [${repPlain.map((v) => v.toFixed(0)).join(', ')}]`);
  console.log(`색만:      중앙값 ${med(repColor).toFixed(1)} fps  [${repColor.map((v) => v.toFixed(0)).join(', ')}]`);
  console.log(`새 합성기가 단일 패스 클립만 그렸을 때 잡은 프레임버퍼: ${freshBytes} 바이트`);
  console.log('\n== 마스크 알파 캔버스 재사용 (480x270, 120프레임, 합성기 새로 만들어 잰다) ==');
  console.log('경우                                 굽기  재사용  적중률    fps');
  for (const [k, label] of [
    ['path', 'path feather 0.3 (모양 고정)'],
    ['multi', '3장 겹침 (모양 고정)'],
    ['anim', 'dKeys 애니메이션 (매 프레임 다른 모양)'],
    ['rect', 'rect 램프 (굽지 않는다 — 회귀 확인)'],
    ['none', '마스크 없음 (회귀 확인)'],
  ]) {
    const r = maskReuse[k];
    const total = r.hits + r.misses;
    const rate = total > 0 ? `${((r.hits / total) * 100).toFixed(1)}%` : '—';
    console.log(
      `${label.padEnd(38)}${String(r.misses).padStart(4)}${String(r.hits).padStart(7)}` +
      `${rate.padStart(9)}${r.fps.toFixed(1).padStart(8)}`,
    );
  }
  console.log(`\n== 메모리 ==\n패스 표면(480x270 3장): ${(bytes / 1024).toFixed(0)} KiB` +
    ``);
  if (logs.length) console.log('\n== 브라우저 로그 ==\n' + logs.join('\n'));

  await fs.writeFile(
    path.join(OUT, 'parity.json'),
    JSON.stringify({ rows, fps: { all: fpsAll, plain: fpsPlain, color: fpsColor, glow: fpsGlow, blur: fpsBlur, glAll: fpsGlAll, ...fpsGl },
      big: { all: bigAll, plain: bigPlain, color: bigColor, glow: bigGlow, blur: bigBlur, glAll: bigGlAll, bokeh: bigBokeh, halftone: bigHalftone },
      probe: { disc: probe.disc.slice(cx - 40, cx + 41), gauss: probe.gauss.slice(cx - 40, cx + 41), discFlat, discEdge, gaussSlope },
      maskReuse,
      bytes }, null, 2),
  );
  await browser.close();
}

await main();
