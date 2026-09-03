// W8 #8 — WebGL 효과 6종을 **실제 Remotion 렌더**로 검증한다 (F17-A V5-1 의 방법 재사용).
//
//   node scripts/w8-gl-effects-render-check.mjs            영상 6종 + 이미지 경로 + CSS 체인 순서
//   node scripts/w8-gl-effects-render-check.mjs mirror     한 종만
//
// 무엇을 재나 — 「첫 프레임만 걸리고 나머지는 빠지는 사고」를 잡으려고 **30 프레임 전부**를 본다:
//   ① 효과 없음(대조군) 렌더와 프레임마다 픽셀 차이 — 0 이면 그 프레임엔 안 걸린 것
//   ② mirror 는 «좌우 대칭 오차»를 프레임마다 잰다 — 걸렸으면 0 에 가깝고 대조군은 크다
//   ③ 이미지 클립(<CanvasImage> 경로)과 영상 클립(<OffthreadVideo onVideoFrame> 경로) 둘 다
//   ④ WebGL 효과 뒤에 CSS 체인(brightness)이 실제로 걸리는지 — 캔버스에 filter 가 붙는 구조의 확인
// 소스는 ffmpeg testsrc2(움직이는 컬러 패턴) 1초 — 프레임마다 그림이 달라서 «같은 프레임을 두 번
// 뽑은» 사고도 드러난다. 렌더 gl 옵션은 **기본값 그대로**(null = 이 컴퓨터에선 SwiftShader).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyProject, validateDoc } from '@kitkat/schema';
import { renderProject } from '@kitkat/renderer';

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(MEDIA, 'w8-gl');
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.join(MEDIA, 'assets'), { recursive: true });

const W = 540;
const H = 960;
const FPS = 30;
const FRAMES = 30;

// ── 소스 ──────────────────────────────────────────────────────────────────

async function makeVideo() {
  const rel = 'assets/w8gl-testsrc.mp4';
  const abs = path.join(MEDIA, rel);
  if (!existsSync(abs)) {
    // B-프레임 없이·키프레임 촘촘히 — Remotion 컴포지터가 seek 중 «No frame found at position» 을 내는
    // 소스(B-프레임 x264)를 피한다 (remotion.dev/docs/troubleshooting/no-frame-found-at-position).
    // 소스는 3초로 만들고 앞 1초만 쓴다 — 1초짜리 파일은 끝 근처 seek 에서 컴포지터가 같은 오류를 냈다
    // (대조군 렌더 프레임 27, time 0.9 에서 재현).
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=3`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '10', '-bf', '0', '-g', '15',
      '-movflags', '+faststart', abs]);
  }
  return rel;
}

async function makeImage() {
  const rel = 'assets/w8gl-still.png';
  const abs = path.join(MEDIA, rel);
  if (!existsSync(abs)) {
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=1:d=1`,
      '-frames:v', '1', abs]);
  }
  return rel;
}

// ── 픽셀 ──────────────────────────────────────────────────────────────────

/** 렌더 결과 전 프레임을 rgb24 로 읽는다 → Uint8Array[] */
async function rgbFrames(file) {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 29 });
  const n = W * H * 3;
  const out = [];
  for (let o = 0; o + n <= stdout.length; o += n) out.push(new Uint8Array(stdout.buffer, stdout.byteOffset + o, n));
  return out;
}

function meanAbsDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** 좌우 대칭 오차 — 픽셀 (x,y) 와 (W-1-x,y) 의 평균 절대 차이 */
function symmetryError(f) {
  let s = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W / 2; x++) {
      const i = (y * W + x) * 3;
      const j = (y * W + (W - 1 - x)) * 3;
      for (let k = 0; k < 3; k++) {
        s += Math.abs(f[i + k] - f[j + k]);
        n++;
      }
    }
  }
  return s / n;
}

function meanLuma(f) {
  let s = 0;
  for (let i = 0; i < f.length; i += 3) s += 0.299 * f[i] + 0.587 * f[i + 1] + 0.114 * f[i + 2];
  return s / (f.length / 3);
}

/** 가로 이웃 차이의 평균 — 망점처럼 «잘게 반복되는 무늬»의 세기 */
function highFreq(f) {
  let s = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const i = (y * W + x) * 3;
      s += Math.abs(f[i] - f[i - 3]);
      n++;
    }
  }
  return s / n;
}

const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

// ── 문서 ──────────────────────────────────────────────────────────────────

function docWith(kind, src, effects, durationMs) {
  const doc = createEmptyProject({ name: 'W8 #8 WebGL 렌더 검증', width: W, height: H, fps: FPS });
  const asset = kind === 'video'
    ? { id: 'src', kind: 'video', src, name: src, duration: 3000, width: W, height: H }
    : { id: 'src', kind: 'image', src, name: src, width: W, height: H };
  doc.assets.src = asset;
  const clip = kind === 'video'
    ? { id: 'c', kind: 'video', assetId: 'src', start: 0, duration: durationMs, in: 0, out: durationMs,
        speed: 1, volume: 1, ...(effects.length ? { effects } : {}) }
    : { id: 'c', kind: 'image', assetId: 'src', start: 0, duration: durationMs, ...(effects.length ? { effects } : {}) };
  doc.tracks.find((t) => t.kind === 'video').clips.push(clip);
  return validateDoc(doc);
}

async function render(doc, name) {
  const outPath = path.join(OUT, `${name}.mp4`);
  const t0 = Date.now();
  await renderProject(doc, { mediaDir: MEDIA, outPath });
  return { outPath, sec: (Date.now() - t0) / 1000 };
}

// ── 효과 케이스 ───────────────────────────────────────────────────────────

const CASES = [
  { key: 'vibrance', effects: [{ id: 'e', type: 'vibrance', params: { amount: 1 } }] },
  { key: 'bokeh', effects: [{ id: 'e', type: 'bokeh', params: { radius: 16, amount: 1 } }] },
  { key: 'radialBlur', effects: [{ id: 'e', type: 'radialBlur', params: { px: 40, cx: 0.5, cy: 0.5 } }] },
  { key: 'mirror', effects: [{ id: 'e', type: 'mirror', params: { axis: 0, side: 0, pos: 0.5 } }] },
  { key: 'kaleidoscope', effects: [{ id: 'e', type: 'kaleidoscope', params: { segments: 6, angle: 0 } }] },
  { key: 'halftone', effects: [{ id: 'e', type: 'halftone', params: { size: 10, angle: 45 } }] },
];

const only = process.argv[2];
const video = await makeVideo();
const image = await makeImage();

let allOk = true;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'OK ' : '실패'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) allOk = false;
};

// ── ① 영상: 대조군 + 6종, 30프레임 전부 ───────────────────────────────────
const videoPart = !only || only === 'all' || CASES.some((c) => c.key === only);
if (videoPart) {
console.log(`\n== 영상 클립 (OffthreadVideo → onVideoFrame → runEffectChain), ${FRAMES}프레임 ==`);
const ctl = await render(docWith('video', video, [], 1000), 'v-control');
const ctlFrames = await rgbFrames(ctl.outPath);
console.log(`대조군(효과 없음): ${ctlFrames.length}프레임, ${f2(ctl.sec)}초`);
check('대조군 프레임 수', ctlFrames.length === FRAMES, `${ctlFrames.length}`);
// 대조군 자체가 프레임마다 다른 그림이어야 «같은 프레임 반복» 사고를 잡을 수 있다
const ctlMotion = ctlFrames.slice(1).map((f, i) => meanAbsDiff(f, ctlFrames[i]));
check('대조군이 프레임마다 다르다', ctlMotion.every((d) => d > 0.5), `프레임 간 차이 최소 ${f2(Math.min(...ctlMotion))}`);

const table = [];
for (const c of CASES) {
  if (only && only !== c.key && only !== 'all') continue;
  const r = await render(docWith('video', video, c.effects, 1000), `v-${c.key}`);
  const frames = await rgbFrames(r.outPath);
  const diffs = frames.map((f, i) => meanAbsDiff(f, ctlFrames[i]));
  const minDiff = Math.min(...diffs);
  const applied = diffs.filter((d) => d >= 2).length;
  const row = { 효과: c.key, 프레임: frames.length, '적용된 프레임': applied, 'Δ최소': +f2(minDiff),
    'Δ평균': +f2(diffs.reduce((a, b) => a + b, 0) / diffs.length), '렌더(초)': +f2(r.sec) };
  if (c.key === 'mirror') {
    const sym = frames.map(symmetryError);
    const symCtl = ctlFrames.map(symmetryError);
    row['대칭오차 최대'] = +f2(Math.max(...sym));
    row['대조군 대칭오차 최소'] = +f2(Math.min(...symCtl));
    check('mirror: 30프레임 전부 좌우 대칭 (오차 ≤ 1.5)', sym.every((v) => v <= 1.5), `최대 ${f2(Math.max(...sym))}`);
    check('mirror: 대조군은 대칭이 아니다', symCtl.every((v) => v > 5), `최소 ${f2(Math.min(...symCtl))}`);
  }
  if (c.key === 'halftone') {
    const hf = frames.map(highFreq);
    const hfCtl = ctlFrames.map(highFreq);
    row['잔무늬(효과/대조)'] = `${f2(Math.min(...hf))}/${f2(Math.max(...hfCtl))}`;
    check('halftone: 30프레임 전부 대조군보다 잔무늬가 세다', hf.every((v, i) => v > hfCtl[i] * 1.5));
  }
  table.push(row);
  check(`${c.key}: ${FRAMES}프레임 전부 걸렸다 (프레임별 Δ ≥ 2)`, frames.length === FRAMES && applied === FRAMES,
    `${applied}/${frames.length}, Δ최소 ${f2(minDiff)}`);
}
console.table(table);
}

// ── ② 이미지 클립 (<CanvasImage effects>) ──────────────────────────────────
if (!only || only === 'all' || only === 'image') {
  console.log('\n== 이미지 클립 (<CanvasImage effects>), 10프레임 ==');
  const ictl = await render(docWith('image', image, [], 334), 'i-control');
  // 렌더는 문서 길이만큼 나온다(클립 뒤는 검정 배경) — 클립 안 10프레임만 본다
  const N = Math.round((334 / 1000) * FPS);
  const ictlFrames = (await rgbFrames(ictl.outPath)).slice(0, N);
  const imir = await render(docWith('image', image, [{ id: 'e', type: 'mirror', params: { axis: 1, side: 1, pos: 0.5 } }], 334), 'i-mirror');
  const imirFrames = (await rgbFrames(imir.outPath)).slice(0, N);
  const ihalf = await render(docWith('image', image, [{ id: 'e', type: 'halftone', params: { size: 8, angle: 30 } }], 334), 'i-halftone');
  const ihalfFrames = (await rgbFrames(ihalf.outPath)).slice(0, N);
  console.log(`대조군 ${f2(ictl.sec)}초 · mirror ${f2(imir.sec)}초 · halftone ${f2(ihalf.sec)}초`);
  const dm = imirFrames.map((f, i) => meanAbsDiff(f, ictlFrames[i]));
  const dh = ihalfFrames.map((f, i) => meanAbsDiff(f, ictlFrames[i]));
  check(`이미지 mirror(상하): ${N}프레임 전부 걸렸다`, imirFrames.length === N && dm.every((d) => d >= 2), `${dm.filter((d) => d >= 2).length}/${imirFrames.length}, Δ최소 ${f2(Math.min(...dm))}`);
  check(`이미지 halftone: ${N}프레임 전부 걸렸다`, ihalfFrames.length === N && dh.every((d) => d >= 2), `${dh.filter((d) => d >= 2).length}/${ihalfFrames.length}, Δ최소 ${f2(Math.min(...dh))}`);
  // 상하 거울 = 위아래 대칭. 위아래가 뒤집혀 그려지는 사고(FLIP_Y)는 여기서 드러난다:
  // side 1(아래를 남긴다)이면 아래쪽 절반이 대조군과 같아야 한다.
  const bottomSame = (() => {
    const a = imirFrames[0];
    const b = ictlFrames[0];
    let s = 0;
    let n = 0;
    for (let y = Math.floor(H * 0.55); y < H; y++) {
      for (let i = y * W * 3; i < (y + 1) * W * 3; i++) { s += Math.abs(a[i] - b[i]); n++; }
    }
    return s / n;
  })();
  check('이미지 mirror(side=1): 아래 절반은 원본 그대로 (위아래 방향이 안 뒤집혔다)', bottomSame <= 2, `아래 절반 Δ ${f2(bottomSame)}`);
}

// ── ③ WebGL 효과 뒤에 CSS 체인이 걸리는가 (캔버스에 filter) ───────────────
if (!only || only === 'all' || only === 'chain') {
  console.log('\n== 체인 순서: mirror + brightness(1.6) — 캔버스에 CSS filter 가 붙는가 ==');
  const a = await render(docWith('video', video, [{ id: 'e', type: 'mirror', params: { axis: 0, side: 0, pos: 0.5 } }], 334), 'v-chain-mirror');
  const b = await render(docWith('video', video, [
    { id: 'e', type: 'mirror', params: { axis: 0, side: 0, pos: 0.5 } },
    { id: 'f', type: 'brightness', params: { amount: 1.6 } },
  ], 334), 'v-chain-mirror-bright');
  const N = Math.round((334 / 1000) * FPS);
  const fa = (await rgbFrames(a.outPath)).slice(0, N);
  const fb = (await rgbFrames(b.outPath)).slice(0, N);
  const la = fa.map(meanLuma);
  const lb = fb.map(meanLuma);
  const symB = fb.map(symmetryError);
  // testsrc2 는 흰 영역이 많아 brightness(1.6) 이 대부분 255 에서 잘린다 — 평균 밝기 +5% 면 걸린 것이다
  check(`mirror+brightness: ${N}프레임 전부 더 밝다 (CSS filter 가 캔버스에 걸렸다)`, lb.every((v, i) => v > la[i] * 1.05),
    `밝기 ${f2(la[0])} → ${f2(lb[0])} (${fb.length}프레임)`);
  check('mirror+brightness: 여전히 좌우 대칭 (WebGL 이 앞, CSS 가 뒤)', symB.every((v) => v <= 1.5), `대칭오차 최대 ${f2(Math.max(...symB))}`);
}

console.log(allOk ? '\n✅ 합격' : '\n❌ 불합격');
process.exit(allOk ? 0 : 1);
