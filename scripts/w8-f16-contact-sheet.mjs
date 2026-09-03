// W8 F16 — **눈으로 보는** 검증. 카탈로그의 전환·효과를 전부 실제로 렌더해 컨택트 시트를 만든다.
//
//   node scripts/w8-f16-contact-sheet.mjs t   전환 51종 — «두 클립 사이»에 걸어 중앙 프레임
//   node scripts/w8-f16-contact-sheet.mjs u   전환 51종 — «들어오는 클립에만» 걸었을 때
//   node scripts/w8-f16-contact-sheet.mjs e   효과 44종 — 실사·그래픽 두 소스에 각각 (p·g 로 나눠 실행 가능)
//   node scripts/w8-f16-contact-sheet.mjs x   텍스트 템플릿 90종
//   node scripts/w8-f16-contact-sheet.mjs s   소스 두 장 만들기 (t·e 가 알아서 부른다)
//
// 왜 한 장에 다 못 넣나: 전환 스타일은 **캔버스 전체**를 감싸는 래퍼에 걸린다(clips.tsx).
// 타일마다 다른 전환을 걸려고 한 화면에 늘어놓으면 슬라이드가 캔버스 폭만큼 움직여 버린다.
// 그래서 한 종류에 한 장씩 stills 를 뽑고 ffmpeg 로 붙인다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EFFECT_CATALOG,
  TEXT_TEMPLATES,
  TEXT_TEMPLATE_GROUPS,
  TRANSITION_CATALOG,
  createEmptyProject,
  newId,
  validateDoc,
} from '@kitkat/schema';
import { renderCover } from '@kitkat/renderer';

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(MEDIA, 'w8-f16');
const TILES = path.join(OUT, 'tiles');

const W = 540;
const H = 960;
const FPS = 30;
const FONT = 'media/fonts/GothicA1-Regular.ttf'; // 상대경로 — 윈도우 드라이브 문자의 콜론을 피한다

// ── 소스 두 장 ────────────────────────────────────────────────────────────
// 「효과는 실사·그래픽 두 종류 소스에 각각 걸어본다 — 컬러바에서만 좋아 보이는 효과가 있다」

async function makeSources() {
  await fs.mkdir(OUT, { recursive: true });
  const photo = path.join(OUT, 'src-photo.png');
  const graphic = path.join(OUT, 'src-graphic.png');

  if (!existsSync(photo)) {
    // 연속 계조 + 날아간 하이라이트(블룸·할레이션용) + 살색 덩어리 + 잔 줄무늬(선명도·픽셀화용)
    // + 순검정 띠 + 흰/중간회색 패치(이치화·포스터라이즈·화이트밸런스용)
    const t = (n) => path.join(OUT, `_tmp${n}.png`);
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `gradients=s=${W}x${H}:c0=0x0d1e33:c1=0xf0b070:x0=0:y0=0:x1=${W}:y1=${H}:type=linear:d=1:r=1`,
      '-frames:v', '1', t(1)]);
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `gradients=s=${W}x${H}:c0=0xffffff:c1=0x000000:x0=300:y0=250:x1=395:y1=250:type=radial:d=1:r=1`,
      '-frames:v', '1', t(2)]);
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xd8a07a:s=250x330',
      '-vf', 'boxblur=10:2', '-frames:v', '1', t(3)]);
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', t(1), '-i', t(2),
      '-filter_complex', '[0][1]blend=all_mode=screen,format=rgb24', '-frames:v', '1', t(4)]);
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', t(4), '-i', t(3),
      '-filter_complex', '[0][1]overlay=x=150:y=470,format=rgb24', '-frames:v', '1', t(5)]);
    const stripe = (c) =>
      `if(between(Y,120,215)*lt(mod(X,7),3),245,${c}(X,Y))`;
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', t(5), '-vf',
      `geq=r='${stripe('r')}':g='${stripe('g')}':b='${stripe('b')}',` +
      'drawbox=x=0:y=860:w=540:h=90:color=0x080808@1:t=fill,' +
      'drawbox=x=40:y=880:w=200:h=50:color=0xfaf7f0@1:t=fill,' +
      'drawbox=x=300:y=880:w=200:h=50:color=0x8f8f8f@1:t=fill,format=rgb24',
      '-frames:v', '1', photo]);
    for (let i = 1; i <= 5; i++) await fs.rm(t(i), { force: true });
  }
  if (!existsSync(graphic)) {
    // 평평한 색면 + 딱딱한 경계 + 글자 — 실사와 «완전히 다른» 성격의 소스
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `testsrc2=s=${W}x${H}:d=1:r=1`, '-frames:v', '1', graphic]);
  }
  return { photo, graphic };
}

// ── 문서 조립 ─────────────────────────────────────────────────────────────

function imageAsset(id, rel) {
  return { id, kind: 'image', src: rel.split(path.sep).join('/'), name: id, width: W, height: H };
}

/**
 * 두 클립 사이의 전환 — 아래 트랙에 A(실사), 새로 얹은 위 트랙에 B(그래픽).
 * 같은 트랙에는 겹칠 수 없어서 트랙을 하나 더 쓴다.
 *
 * `bothSides` = A 에도 같은 전환을 `transitionOut` 으로 건다.
 * **두 방식이 다른 그림을 낸다:**
 * - 움직이는 전환(슬라이드·줌·휩팬)은 양쪽에 걸어야 «밀어내는» 모양이 나온다.
 * - **잘라 내는 전환(와이프·원형·대각·시계·점 디졸브)은 들어오는 쪽에만 걸어야 한다** —
 *   양쪽에 걸면 A 도 같이 잘려서 화면 절반이 «구멍»(배경색)이 된다.
 */
function transitionDoc(type, durMs, bothSides) {
  const doc = createEmptyProject({ name: `F16 ${type}`, width: W, height: H, fps: FPS });
  doc.assets.a = imageAsset('a', 'w8-f16/src-photo.png');
  doc.assets.b = imageAsset('b', 'w8-f16/src-graphic.png');
  const lower = doc.tracks.find((t) => t.kind === 'video');
  lower.clips.push({
    id: 'A', kind: 'image', assetId: 'a', start: 0, duration: 2000,
    ...(bothSides ? { transitionOut: { type, duration: durMs } } : {}),
  });
  doc.tracks.splice(1, 0, {
    id: newId(), kind: 'video', name: 'B',
    clips: [{
      id: 'B', kind: 'image', assetId: 'b', start: 2000 - durMs, duration: 2000,
      transitionIn: { type, duration: durMs },
    }],
  });
  return validateDoc(doc);
}

/**
 * 효과를 «보이게» 하는 값. 기본값이 항등인 효과(gamma 1·6500K·sharpen 0 …)를 기본값으로 렌더하면
 * 원본과 똑같은 타일이 나와서 「구현이 없는 것」과 구별이 안 된다.
 */
const SHOWCASE = {
  brightness: { amount: 1.5 }, contrast: { amount: 1.7 }, saturation: { amount: 1.9 },
  hue: { deg: 100 }, exposure: { stops: 1 },
  temperature: { amount: 0.7 }, tint: { amount: 0.6 },
  highlights: { amount: -0.8 }, shadows: { amount: 0.8 }, sharpen: { amount: 1.6 },
  gamma: { gamma: 1.9 }, whiteBalance: { kelvin: 3000, tint: 0 },
};

function effectDoc(effectType, srcRel) {
  const doc = createEmptyProject({ name: `F16 ${effectType}`, width: W, height: H, fps: FPS });
  doc.assets.s = imageAsset('s', srcRel);
  const def = EFFECT_CATALOG.find((d) => d.id === effectType);
  const params = SHOWCASE[effectType] ?? Object.fromEntries(def.params.map((p) => [p.key, p.def]));
  doc.tracks.find((t) => t.kind === 'video').clips.push({
    id: 'C', kind: 'image', assetId: 's', start: 0, duration: 1000,
    ...(effectType === '__none__' ? {} : { effects: [{ id: 'e1', type: effectType, params }] }),
  });
  return validateDoc(doc);
}

function plainDoc(srcRel) {
  const doc = createEmptyProject({ name: 'F16 원본', width: W, height: H, fps: FPS });
  doc.assets.s = imageAsset('s', srcRel);
  doc.tracks.find((t) => t.kind === 'video').clips.push({
    id: 'C', kind: 'image', assetId: 's', start: 0, duration: 1000,
  });
  return validateDoc(doc);
}

// ── 렌더 + 타일 ───────────────────────────────────────────────────────────

/** drawtext 는 콜론·역슬래시를 문법으로 먹는다 — 라벨은 ASCII id 만 쓴다. */
async function labelled(srcPng, outPng, label, tileW, tileH) {
  await exec('ffmpeg', ['-v', 'error', '-y', '-i', srcPng, '-vf',
    `scale=${tileW}:${tileH},drawbox=x=0:y=${tileH - 26}:w=${tileW}:h=26:color=black@0.72:t=fill,` +
    `drawtext=fontfile=${FONT}:text='${label}':x=5:y=${tileH - 22}:fontsize=15:fontcolor=white`,
    outPng], { cwd: ROOT });
}

async function tile(pattern, cols, rows, outPng) {
  await exec('ffmpeg', ['-v', 'error', '-y', '-i', pattern,
    '-filter_complex', `tile=${cols}x${rows}:margin=4:padding=3:color=0x1a1a1a`,
    '-frames:v', '1', outPng]);
}

async function renderStills(dir, items, build, timeMs, tileW, tileH) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  let i = 0;
  const t0 = Date.now();
  for (const it of items) {
    const raw = path.join(dir, `raw-${String(i).padStart(3, '0')}.jpg`);
    await renderCover(build(it), { mediaDir: MEDIA, outPath: raw, timeMs: timeMs(it) });
    await labelled(raw, path.join(dir, `t-${String(i).padStart(3, '0')}.png`), it.label, tileW, tileH);
    i++;
    if (i % 10 === 0) console.log(`  ${i}/${items.length} (${((Date.now() - t0) / 1000).toFixed(0)}초)`);
  }
  console.log(`  ${items.length}장 완료 (${((Date.now() - t0) / 1000).toFixed(0)}초)`);
}

// ── A. 전환 51종 ──────────────────────────────────────────────────────────

async function sheetTransitions(bothSides) {
  await makeSources();
  const DUR = 1000;
  const items = TRANSITION_CATALOG.map((d) => ({ id: d.id, label: d.id, group: d.group }));
  // 갈래 순으로 늘어놓아야 「같은 갈래 안에서 서로 다른가」를 눈으로 비교할 수 있다
  const order = ['basic', 'slide', 'wipe', 'zoom', 'rotate', 'impact', 'whip'];
  items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const how = bothSides ? '양쪽 클립' : '들어오는 클립에만';
  console.log(`전환 ${items.length}종 — ${how}, 전환 중앙(${DUR / 2}ms) 프레임`);
  const dir = path.join(TILES, bothSides ? 'both' : 'in');
  await renderStills(
    dir,
    items,
    (it) => transitionDoc(it.id, DUR, bothSides),
    () => 2000 - DUR / 2,   // 전환이 **딱 절반** 지난 순간
    180, 320,
  );
  const out = path.join(OUT, `sheet-transitions-${bothSides ? 'both' : 'in'}.png`);
  await tile(path.join(dir, 't-%03d.png'), 9, 6, out);
  console.log(`→ ${out}`);
}

// ── B. 효과 44종 × 소스 2 ─────────────────────────────────────────────────

async function sheetEffects(only) {
  const src = await makeSources();
  const drawn = EFFECT_CATALOG.filter((d) => d.impl !== 'webgl');
  const order = ['color', 'look', 'focus', 'texture', 'distort', 'style'];
  const items = [
    { id: '__none__', label: 'ORIGINAL', group: 'color' },
    ...drawn.map((d) => ({ id: d.id, label: `${d.id}`, group: d.group })),
  ];
  items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const sources = [['photo', 'w8-f16/src-photo.png'], ['graphic', 'w8-f16/src-graphic.png']]
    .filter(([name]) => !only || name === only);
  for (const [name, rel] of sources) {
    console.log(`효과 ${drawn.length}종 + 원본 — 소스: ${name}`);
    const dir = path.join(TILES, `fx-${name}`);
    await renderStills(
      dir,
      items,
      (it) => (it.id === '__none__' ? plainDoc(rel) : effectDoc(it.id, rel)),
      () => 500,
      180, 320,
    );
    const out = path.join(OUT, `sheet-effects-${name}.png`);
    await tile(path.join(dir, 't-%03d.png'), 9, 5, out);
    console.log(`→ ${out}`);
  }
  void src;
}

// ── C. 텍스트 템플릿 90종 ─────────────────────────────────────────────────
// W6 에서 이 과정에 **예능 자막이 새까맣게 나오는 결함**을 찾았다. 안 봤으면 못 찾았다.

const SAMPLE_TEXT = '오늘의 광고 카피\n지금 50% 할인';

function templateDoc(tpl) {
  const doc = createEmptyProject({ name: `F16 ${tpl.id}`, width: W, height: H, fps: FPS });
  doc.assets.s = imageAsset('s', 'w8-f16/src-photo.png');
  doc.tracks.find((t) => t.kind === 'video').clips.push({
    id: 'bg', kind: 'image', assetId: 's', start: 0, duration: 3000,
  });
  doc.tracks.find((t) => t.kind === 'text').clips.push({
    id: 'tx', kind: 'text', start: 0, duration: 3000, text: SAMPLE_TEXT,
    style: structuredClone(tpl.style),
    ...(tpl.animationIn ? { animationIn: structuredClone(tpl.animationIn) } : {}),
    ...(tpl.animationOut ? { animationOut: structuredClone(tpl.animationOut) } : {}),
    ...(tpl.transform ? { transform: structuredClone(tpl.transform) } : {}),
    ...(tpl.highlightColor ? { highlightColor: tpl.highlightColor } : {}),
    ...(tpl.animationIn?.type === 'wordHighlight'
      ? { words: [
          { text: '오늘의', start: 0, duration: 500 },
          { text: '광고', start: 500, duration: 500 },
          { text: '카피', start: 1000, duration: 500 },
          { text: '지금', start: 1500, duration: 300 },
          { text: '50%', start: 1800, duration: 300 },
          { text: '할인', start: 2100, duration: 400 },
        ] }
      : {}),
  });
  return validateDoc(doc);
}

async function sheetTemplates() {
  await makeSources();
  const byId = new Map(TEXT_TEMPLATES.map((t) => [t.id, t]));
  const items = TEXT_TEMPLATE_GROUPS.flatMap((g) =>
    g.templateIds.map((id) => ({ id, label: id, tpl: byId.get(id) })),
  );
  console.log(`템플릿 ${items.length}종 — 등장이 **끝난 뒤**(2500ms) 프레임`);
  const dir = path.join(TILES, 'tpl');
  await renderStills(
    dir,
    items,
    (it) => templateDoc(it.tpl),
    // 등장 애니메이션이 다 끝난 시각을 본다 — 「스타일이 제대로 보이는가」가 이 시트의 목적이다
    () => 2500,
    180, 320,
  );
  const out = path.join(OUT, 'sheet-templates.png');
  await tile(path.join(dir, 't-%03d.png'), 10, 9, out);
  console.log(`→ ${out}`);
}

const which = process.argv[2] ?? 'teu';
if (which.includes('s')) await makeSources();
if (which.includes('t')) await sheetTransitions(true);   // 양쪽 클립
if (which.includes('u')) await sheetTransitions(false);  // 들어오는 클립에만
if (which.includes('p')) await sheetEffects('photo');    // 실사 소스만
if (which.includes('g')) await sheetEffects('graphic');  // 그래픽 소스만
if (which.includes('e')) await sheetEffects();
if (which.includes('x')) await sheetTemplates();
