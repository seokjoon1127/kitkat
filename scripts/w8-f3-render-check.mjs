// W8 F3 모션 블러 — **실제 렌더/굽기로** 재는 검증 스크립트.
//
//   node scripts/w8-f3-render-check.mjs a   소스 모션 블러: 셔터 각도 → 번짐 길이(px), 예상 시간 오차
//   node scripts/w8-f3-render-check.mjs b   트랜스폼 블러: 라플라시안 분산(엣지 선명도) 비교
//   node scripts/w8-f3-render-check.mjs c   전환 방향성 블러: 방향별 그래디언트 크기
//
// 픽셀은 ffmpeg 이 rawvideo(gray) 로 뱉은 바이트를 그대로 읽는다 — 이미지 라이브러리 없음.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyProject, validateDoc } from '@kitkat/schema';
import { renderProject } from '@kitkat/renderer';
import { deriveMedia, estimateMotionBlurSeconds } from '@kitkat/media';

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(MEDIA, 'w8-f3');
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.join(MEDIA, 'assets'), { recursive: true });

const W = 540;
const H = 960;
const FPS = 30;

// ── 픽셀 읽기 ─────────────────────────────────────────────────────────────

/** 파일의 frameIndex 번째 프레임을 8bit 그레이 raw 로. { w, h, px:Uint8Array } */
async function grayFrame(file, frameIndex) {
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frameIndex})`, '-vsync', '0',
     '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 },
  );
  const { stdout: probe } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]);
  const [w, h] = probe.trim().split('x').map(Number);
  if (stdout.length !== w * h) throw new Error(`프레임 크기가 안 맞는다: ${stdout.length} != ${w * h}`);
  return { w, h, px: new Uint8Array(stdout) };
}

/** 라플라시안(4이웃) 분산 — 엣지가 뭉개질수록 낮아진다. */
function laplacianVariance({ w, h, px }) {
  const vals = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      vals.push(px[i - 1] + px[i + 1] + px[i - w] + px[i + w] - 4 * px[i]);
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
}

/** 방향별 평균 그래디언트 크기. gx 가 낮으면 «세로 엣지»가 뭉개진 것 = 가로 블러. */
function gradients({ w, h, px }) {
  let gx = 0;
  let gy = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx += Math.abs(px[i + 1] - px[i - 1]);
      gy += Math.abs(px[i + w] - px[i - w]);
      n++;
    }
  }
  return { gx: gx / n, gy: gy / n };
}

/** 가로 밴드(y0..y1)에서 세로로 최댓값을 취한 «가로 프로필». */
function columnProfile({ w, h, px }, y0, y1) {
  const prof = new Float64Array(w);
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = 0; x < w; x++) prof[x] = Math.max(prof[x], px[y * w + x]);
  }
  return prof;
}

/** 프로필에서 최댓값의 frac 배를 넘는 구간의 폭(px). */
function profileWidth(prof, frac) {
  const peak = Math.max(...prof);
  if (peak <= 0) return 0;
  const t = peak * frac;
  let lo = -1;
  let hi = -1;
  for (let x = 0; x < prof.length; x++) {
    if (prof[x] >= t) {
      if (lo < 0) lo = x;
      hi = x;
    }
  }
  return lo < 0 ? 0 : hi - lo + 1;
}

const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

// ── 소스 만들기 ───────────────────────────────────────────────────────────

/**
 * 검은 배경 위를 초속 `speed` px 로 가로지르는 흰 막대 (모션 블러 A 측정용).
 * `drawbox` 를 쓰면 안 된다 — drawbox 의 `t` 는 **선 두께**지 시간이 아니라서 막대가 안 보인다.
 * `overlay` 의 x 식은 시간 `t` 를 받는다.
 */
async function makeMovingBar(rel, { w, h, barW, barH, barY, speed, fps }) {
  const abs = path.join(MEDIA, rel);
  if (existsSync(abs)) return abs;
  await exec('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=1:r=${fps}`,
    '-f', 'lavfi', '-i', `color=c=white:s=${barW}x${barH}:d=1:r=${fps}`,
    '-filter_complex', `[0][1]overlay=x='40+${speed}*t':y=${barY}`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '10', abs]);
  return abs;
}

/**
 * 모눈종이 — 흰 바탕에 검은 **세로줄**(32px 간격)과 **가로줄**(32px 간격).
 *
 * 체커보드를 쓰면 안 된다: 가로로만 번져도 각 «행»이 통째로 회색이 되면서 세로 방향 대비까지
 * 같이 사라져 방향을 못 잰다. 모눈종이는 가로줄이 X 방향으로 균일해서
 * **가로 블러가 가로줄을 건드리지 않는다** — 그래서 방향이 측정된다.
 */
async function makeGrid(rel) {
  const abs = path.join(MEDIA, rel);
  if (existsSync(abs)) return abs;
  await exec('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}`,
    '-vf', 'geq=lum=\'if(lt(mod(X\\,32)\\,3),0,if(lt(mod(Y\\,32)\\,3),0,255))\':cb=128:cr=128',
    '-frames:v', '1', abs]);
  return abs;
}

// ── 문서 조립 ─────────────────────────────────────────────────────────────

function docWith(clips, { width = W, height = H, fps = FPS } = {}) {
  const doc = createEmptyProject({ name: 'W8 F3 검증', width, height, fps });
  for (const [kind, clip, asset] of clips) {
    if (asset) doc.assets[asset.id] = asset;
    doc.tracks.find((t) => t.kind === kind).clips.push(clip);
  }
  return validateDoc(doc);
}

async function render(doc, name, range) {
  const outPath = path.join(OUT, `${name}.mp4`);
  const t0 = Date.now();
  await renderProject(doc, { mediaDir: MEDIA, outPath, ...(range ? { range } : {}) });
  return { outPath, sec: (Date.now() - t0) / 1000 };
}

// ── A. 소스 영상 모션 블러 ────────────────────────────────────────────────

async function checkA() {
  // **계획 03 의 실측 기준(1080×1920 1초)과 같은 조건**에서 잰다 — 예상 시간 계수가 이 점에서
  // 뽑힌 값이라, 다른 해상도에서 재면 「환산이 맞나」와 「계수가 맞나」가 섞여버린다.
  const AW = 1080;
  const AH = 1920;
  const SPEED = 800;                       // px/초 → 프레임당 26.67px
  const BAR_W = 32;
  const src = await makeMovingBar('assets/w8f3-bar.mp4',
    { w: AW, h: AH, barW: BAR_W, barH: 400, barY: 760, speed: SPEED, fps: FPS });
  console.log(`소스: ${AW}x${AH} ${FPS}fps 1초, 폭 ${BAR_W}px 막대가 초속 ${SPEED}px (프레임당 ${f2(SPEED / FPS)}px)\n`);

  const rows = [];
  for (const angle of [0, 90, 180, 360]) {
    const mb = { shutterAngle: angle, quality: 'precise' };
    const estimate = estimateMotionBlurSeconds(mb, { durationMs: 1000, width: AW, height: AH });
    const key = `f3a${angle}`;
    const t0 = Date.now();
    // 각도 0 은 필터가 항등이라 deriveMedia 가 «빈 파생 스펙»으로 거절한다 → 원본이 곧 기준선이다.
    const abs = angle === 0
      ? src
      : path.join(MEDIA, (await deriveMedia(src, MEDIA, 'w8f3bar', key, { motionBlur: mb })).src);
    const actual = (Date.now() - t0) / 1000;
    const frame = await grayFrame(abs, 15);
    const prof = columnProfile(frame, 800, 1120);
    rows.push({
      angle,
      width5: profileWidth(prof, 0.05),
      width50: profileWidth(prof, 0.5),
      estimate,
      actual,
      err: estimate > 0 ? ((actual - estimate) / estimate) * 100 : 0,
    });
    console.log(`  ${angle}° 굽기 완료 (${f2(actual)}초, 예상 ${estimate}초)`);
  }

  const base = rows[0].width5;
  // 이론값 = ffmpeg 이 실제로 하는 일: 8배로 보간한 뒤 N장을 섞으므로 **N-1 서브프레임**만큼 번진다
  // (N = round(8·각도/360), 서브프레임 간격 = 프레임당 이동 / 8).
  console.log('\n셔터각 | 번짐폭(5%) | 늘어난 폭 | 이론값 | 번짐폭(50%) | 예상 | 실제 | 오차');
  for (const r of rows) {
    const frames = Math.round((8 * r.angle) / 360);
    const theory = frames < 2 ? 0 : ((SPEED / FPS) / 8) * (frames - 1);
    console.log(
      `  ${String(r.angle).padStart(3)}° | ${String(r.width5).padStart(9)}px | ` +
      `${f2(r.width5 - base).padStart(8)}px | ${f2(theory).padStart(5)}px | ` +
      `${String(r.width50).padStart(10)}px | ${String(r.estimate).padStart(3)}초 | ` +
      `${f2(r.actual).padStart(6)}초 | ${f2(r.err).padStart(6)}%`,
    );
  }
  const mono = rows.every((r, i) => i === 0 || r.width5 >= rows[i - 1].width5);
  const within20 = rows.filter((r) => r.estimate > 0).every((r) => Math.abs(r.err) <= 20);
  console.log(`\n번짐이 각도에 따라 단조 증가: ${mono ? 'OK' : '실패'}`);
  console.log(`예상 시간 ±20% 안: ${within20 ? 'OK' : '실패'}`);
}

// ── B. 트랜스폼 모션 블러 ─────────────────────────────────────────────────

async function checkB() {
  const grid = await makeGrid('assets/w8f3-grid.png');
  const asset = { id: 'g1', kind: 'image', src: 'assets/w8f3-grid.png', name: 'grid',
                  width: W, height: H };
  void grid;

  /** 켄번스 급속 줌 — 1초에 scale 1 → 2.2 (광고에서 흔한 속도). */
  const kenBurns = (transformBlur) => docWith([[
    'video',
    {
      id: 'kb', kind: 'image', assetId: 'g1', start: 0, duration: 1000,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      keyframes: [
        { time: 0, prop: 'scale', value: 1, easing: 'linear' },
        { time: 1000, prop: 'scale', value: 2.2, easing: 'linear' },
      ],
      ...(transformBlur ? { transformBlur } : {}),
    },
    asset,
  ]]);

  /** 글자가 가로로 날아 들어온다 — 1초에 화면 폭만큼 이동. */
  const flyingText = (transformBlur) => docWith([[
    'text',
    {
      id: 'tx', kind: 'text', text: 'KITKAT', start: 0, duration: 1000,
      style: { fontFamily: 'sans-serif', fontSize: 140, color: '#ffffff', align: 'center' },
      transform: { x: -0.5, y: 0, scale: 1, rotation: 0 },
      keyframes: [
        { time: 0, prop: 'x', value: -0.5, easing: 'linear' },
        { time: 1000, prop: 'x', value: 0.5, easing: 'linear' },
      ],
      ...(transformBlur ? { transformBlur } : {}),
    },
  ]]);

  const cases = [
    ['켄번스 줌', kenBurns, 15],
    ['글자 이동', flyingText, 15],
  ];
  for (const [label, build, frame] of cases) {
    const off = await render(build(undefined), `b-${label === '켄번스 줌' ? 'kb' : 'tx'}-off`);
    const on180 = await render(build({ shutterAngle: 180, samples: 12 }),
      `b-${label === '켄번스 줌' ? 'kb' : 'tx'}-180`);
    const on360 = await render(build({ shutterAngle: 360, samples: 24 }),
      `b-${label === '켄번스 줌' ? 'kb' : 'tx'}-360`);
    const stat = async (r) => {
      const f = await grayFrame(r.outPath, frame);
      let sum = 0;
      for (const v of f.px) sum += v;
      return { lv: laplacianVariance(f), luma: sum / f.px.length };
    };
    const [a, b, c] = [await stat(off), await stat(on180), await stat(on360)];
    console.log(`\n[${label}] 프레임 ${frame} 라플라시안 분산 (낮을수록 흐림) · 평균 밝기`);
    console.log(`  블러 없음   : ${f2(a.lv).padStart(8)}   밝기 ${f2(a.luma)}   (렌더 ${f2(off.sec)}초)`);
    console.log(`  180° 12장   : ${f2(b.lv).padStart(8)}   밝기 ${f2(b.luma)}   (${f2(((b.lv - a.lv) / a.lv) * 100)}%, 렌더 ${f2(on180.sec)}초)`);
    console.log(`  360° 24장   : ${f2(c.lv).padStart(8)}   밝기 ${f2(c.luma)}   (${f2(((c.lv - a.lv) / a.lv) * 100)}%, 렌더 ${f2(on360.sec)}초)`);
    // 밝기가 1/N 로 떨어졌다면 plus-lighter 합성이 안 먹은 것이다 (그냥 흐린 게 아니라 «어두워진» 것).
    const dim = Math.abs(b.luma - a.luma) / Math.max(1, a.luma);
    console.log(`  판정: ${c.lv < b.lv && b.lv < a.lv ? 'OK — 각도가 클수록 더 흐리다' : '실패'}` +
      ` · 밝기 유지 ${dim < 0.1 ? 'OK' : `실패 (${f2(dim * 100)}% 차이 — plus-lighter 가 안 먹었다)`}`);
  }
}

// ── C. 전환 방향성 블러 ───────────────────────────────────────────────────

async function checkC() {
  const asset = { id: 'g1', kind: 'image', src: 'assets/w8f3-grid.png', name: 'grid',
                  width: W, height: H };
  await makeGrid('assets/w8f3-grid.png');

  // 전환 500ms → 중앙은 250ms = 프레임 7(≈233ms) 과 8(≈267ms) 사이. 7 을 본다.
  const build = (type) => docWith([[
    'video',
    { id: 'c1', kind: 'image', assetId: 'g1', start: 0, duration: 1000,
      transitionIn: { type, duration: 500 } },
    asset,
  ]]);

  console.log('전환 중앙(프레임 7) 방향별 평균 그래디언트 — gx 는 «세로 엣지», gy 는 «가로 엣지»\n');
  console.log('전환          |     gx |     gy | gx/gy | 판정');
  const rows = [];
  for (const type of ['wipeLeft', 'slideLeft', 'slideUp', 'whipPanLeft', 'whipPanUp', 'zoomIn']) {
    const r = await render(build(type), `c-${type}`, { start: 0, end: 500 });
    const g = gradients(await grayFrame(r.outPath, 7));
    rows.push({ type, ...g });
  }
  const control = rows.find((r) => r.type === 'wipeLeft');
  for (const r of rows) {
    const ratio = r.gy > 0 ? r.gx / r.gy : 0;
    const expect =
      r.type === 'slideLeft' || r.type === 'whipPanLeft' ? '가로 블러 → gx ≪ gy'
      : r.type === 'slideUp' || r.type === 'whipPanUp' ? '세로 블러 → gy ≪ gx'
      : r.type === 'zoomIn' ? '등방 근사 → 둘 다 낮다' : '블러 없음(대조군)';
    console.log(
      `${r.type.padEnd(13)} | ${f2(r.gx).padStart(6)} | ${f2(r.gy).padStart(6)} | ` +
      `${f2(ratio).padStart(5)} | ${expect}`,
    );
  }
  console.log(`\n대조군 대비 (wipeLeft gx=${f2(control.gx)} gy=${f2(control.gy)}):`);
  for (const r of rows.filter((x) => x.type !== 'wipeLeft')) {
    console.log(
      `  ${r.type.padEnd(12)} gx ${f2(((r.gx - control.gx) / control.gx) * 100).padStart(7)}% · ` +
      `gy ${f2(((r.gy - control.gy) / control.gy) * 100).padStart(7)}%`,
    );
  }
}

// ── D. 겹쳐 그려도 소리는 한 번만 (B 의 안전장치) ─────────────────────────

async function checkD() {
  const rel = 'assets/w8f3-tone.mp4';
  const abs = path.join(MEDIA, rel);
  if (!existsSync(abs)) {
    await exec('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:d=1:r=${FPS}`,
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-shortest', abs]);
  }
  const asset = { id: 'tone', kind: 'video', src: rel, name: 'tone', duration: 1000,
                  width: W, height: H };
  const build = (transformBlur) => docWith([[
    'video',
    { id: 'v1', kind: 'video', assetId: 'tone', start: 0, duration: 1000,
      in: 0, out: 1000, speed: 1, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      keyframes: [
        { time: 0, prop: 'x', value: -0.3, easing: 'linear' },
        { time: 1000, prop: 'x', value: 0.3, easing: 'linear' },
      ],
      ...(transformBlur ? { transformBlur } : {}) },
    asset,
  ]]);

  const meanVolume = async (file) => {
    const { stderr } = await exec('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect',
      '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)[1]);
  };

  const off = await render(build(undefined), 'd-audio-off');
  const on = await render(build({ shutterAngle: 180, samples: 12 }), 'd-audio-on');
  const [a, b] = [await meanVolume(off.outPath), await meanVolume(on.outPath)];
  console.log('\n겹쳐 그릴 때 소리가 N배가 되지 않는가 (12장 = +21.6dB 가 되면 실패)');
  console.log(`  블러 없음 : ${f2(a)} dB`);
  console.log(`  180° 12장 : ${f2(b)} dB  (차이 ${f2(b - a)} dB)`);
  console.log(`  판정: ${Math.abs(b - a) < 1 ? 'OK — 첫 장만 소리를 낸다' : '실패'}`);
}

const which = process.argv[2] ?? 'abcd';
if (which.includes('a')) await checkA();
if (which.includes('b')) await checkB();
if (which.includes('c')) await checkC();
if (which.includes('d')) await checkD();
