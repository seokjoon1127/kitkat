#!/usr/bin/env node
// W5 확장 기능 E2E 데모 — HTTP API(C3+X6)만 사용한다. 서버(포트 5757)가 떠 있어야 하고
// `node scripts/make-sample-media.mjs` 로 media/samples 가 준비돼 있어야 한다.
//
//   node scripts/demo-w5.mjs          기본(빠른 것 전부)
//   node scripts/demo-w5.mjs --full   업스케일·프레임 보간·보컬 분리까지 (몇 분 걸림)
//
// 각 단계는 성공/실패를 한 줄씩 찍고, 끝에 요약표를 낸다. 하나라도 실패하면 exit 1.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.KITKAT_URL ?? 'http://127.0.0.1:5757';
const FULL = process.argv.includes('--full');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const samplesDir = path.join(root, 'media', 'samples');

const newId = () => randomUUID().replaceAll('-', '').slice(0, 21);
const abs = (name) => path.join(samplesDir, name).replaceAll('\\', '/');

const results = [];
function ok(step, detail = '') {
  results.push({ step, ok: true, detail });
  console.log(`  ✓ ${step}${detail ? ` — ${detail}` : ''}`);
}
function skip(step, why) {
  results.push({ step, ok: null, detail: why });
  console.log(`  · ${step} — 건너뜀 (${why})`);
}
function bad(step, err) {
  results.push({ step, ok: false, detail: err });
  console.log(`  ✗ ${step} — ${err}`);
}

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`${method} ${route} → ${res.status}: ${parsed.error ?? text}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

/** job 완료까지 폴링. 실패하면 throw. */
async function waitJob(jobId, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await api('GET', `/api/jobs/${jobId}`);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error ?? '알 수 없는 잡 오류');
    if (Date.now() > deadline) throw new Error('잡 타임아웃');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const getDoc = (id) => api('GET', `/api/projects/${id}`).then((r) => r.doc);
const send = (id, commands) => api('POST', `/api/projects/${id}/commands`, { commands });

/** 프로젝트의 특정 에셋이 조건을 만족할 때까지 기다린다(후처리 잡은 비동기라서). */
async function waitAsset(id, assetId, pred, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const doc = await getDoc(id);
    const asset = doc.assets[assetId];
    if (asset && pred(asset)) return asset;
    if (Date.now() > deadline) throw new Error(`에셋 ${assetId} 대기 타임아웃`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** 따뜻하게 살짝 밀어주는 16단계 .cube LUT 를 만든다 (없으면). */
async function ensureSampleLut() {
  const cubePath = path.join(samplesDir, 'warm.cube');
  try {
    await fs.access(cubePath);
    return cubePath;
  } catch {
    /* 아래에서 생성 */
  }
  const N = 16;
  const lines = ['TITLE "warm"', `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  const f = (v, gain, lift) => Math.min(1, Math.max(0, v * gain + lift));
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const R = f(r / (N - 1), 1.08, 0.02);
        const G = f(g / (N - 1), 1.0, 0.0);
        const B = f(b / (N - 1), 0.9, 0.0);
        lines.push(`${R.toFixed(6)} ${G.toFixed(6)} ${B.toFixed(6)}`);
      }
    }
  }
  await fs.writeFile(cubePath, lines.join('\n') + '\n');
  return cubePath;
}

/**
 * 실제 박자가 있는 8초 드럼 트랙을 만든다 (없으면) — 120BPM, 500ms 간격 16타.
 * bgm.wav 는 지속 화음이라 온셋이 없어서 비트 감지를 증명하지 못한다.
 */
async function ensureBeatTrack() {
  const wavPath = path.join(samplesDir, 'beat.wav');
  try {
    await fs.access(wavPath);
    return wavPath;
  } catch {
    /* 아래에서 생성 */
  }
  // PCM 을 직접 만든다 — ffmpeg 표현식으로 하면 mod(t,0.5) 의 쉼표가 필터 구분자와 충돌한다.
  const rate = 44100;
  const seconds = 8;
  const periodSec = 0.5; // 120 BPM
  const n = rate * seconds;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const since = t % periodSec; // 마지막 타격 이후 경과
    const kick = 0.9 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-25 * since);
    const hat = 0.35 * Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-80 * since);
    const v = Math.max(-1, Math.min(1, kick + hat));
    pcm.writeInt16LE(Math.round(v * 32000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); // fmt 청크 크기
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 모노
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // 바이트/초
  header.writeUInt16LE(2, 32); // 블록 정렬
  header.writeUInt16LE(16, 34); // 비트 깊이
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  await fs.writeFile(wavPath, Buffer.concat([header, pcm]));
  return wavPath;
}

/** 1초짜리 작은 GIF 스티커를 만든다 (없으면). ffmpeg 필요. */
async function ensureSampleGif() {
  const gifPath = path.join(samplesDir, 'sticker.gif');
  try {
    await fs.access(gifPath);
    return gifPath;
  } catch {
    /* 아래에서 생성 */
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=200x200:rate=12:duration=1',
    '-vf', 'format=rgb24', gifPath,
  ]);
  return gifPath;
}

async function main() {
  console.log(`kitkat W5 데모 — ${BASE}${FULL ? ' (--full)' : ''}\n`);

  // ── 0. capabilities ─────────────────────────────────────────────────────
  console.log('0) 기능 목록');
  const caps = await api('GET', '/api/capabilities');
  // 개수는 «최소»로만 본다 — 정확한 개수는 schema 의 catalog.test.ts 가 갈래별로 못 박는다.
  // 여기서 정확한 개수를 박아 두면 목록이 늘 때마다 이 데모가 «실패» 로 뜬다
  // (W5 의 20/20/35 가 W8 에서 51/50/90 이 되면서 실제로 그렇게 됐다).
  const atLeast = (name, got, min) => {
    if (!(got >= min)) throw new Error(`${name} 가 ${min}종보다 적음: ${got}`);
  };
  atLeast('전환', caps.transitions?.length ?? 0, 20);
  atLeast('효과', caps.effects?.length ?? 0, 20);
  atLeast('텍스트 템플릿', caps.textTemplates?.length ?? 0, 35);
  // «최소치»만 보면 목록이 줄어도 통과한다. id 배열과 카탈로그는 같은 원천에서 나와야 하므로
  // 길이가 다르면 서버가 둘을 다르게 만들고 있는 것이다 — 그걸 잡는다.
  const same = (name, ids, cat) => {
    if (!Array.isArray(cat)) throw new Error(`${name} 카탈로그가 없음`);
    if (ids.length !== cat.length) throw new Error(`${name}: id 배열 ${ids.length}개 ≠ 카탈로그 ${cat.length}개`);
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== cat[i].id) throw new Error(`${name}: ${i}번째가 다름 (${ids[i]} vs ${cat[i].id})`);
    }
  };
  same('전환', caps.transitions ?? [], caps.transitionCatalog);
  same('효과', caps.effects ?? [], caps.effectCatalog);
  // W5 에서 쓰던 것이 사라지지 않았는지는 «이름»으로 본다
  for (const t of ['fade', 'slideLeft', 'circleOpen', 'glitch']) {
    if (!caps.transitions?.includes(t)) throw new Error(`전환 ${t} 가 사라짐`);
  }
  for (const e of ['blur', 'vignette', 'grain', 'lightLeak']) {
    if (!caps.effects?.includes(e)) throw new Error(`효과 ${e} 가 사라짐`);
  }
  // W8 F16 — 「대기」 효과는 걸어도 아무 일도 안 일어난다. 데모가 그걸 고르면 안 된다.
  const pending = new Set(caps.pendingEffects ?? []);
  for (const e of ['blur', 'vignette', 'grain', 'lightLeak']) {
    if (pending.has(e)) throw new Error(`데모가 쓰는 효과 ${e} 가 「대기」 상태다`);
  }
  ok('capabilities', `전환 ${caps.transitions.length} · 효과 ${caps.effects.length} · 템플릿 ${caps.textTemplates.length} · 속도프리셋 ${caps.speedRampPresets.length}`);

  // ── 1. 프로젝트 + 에셋 ──────────────────────────────────────────────────
  console.log('\n1) 프로젝트·에셋');
  const { doc: doc0 } = await api('POST', '/api/projects', { name: 'W5 데모', width: 1080, height: 1920, fps: 30 });
  const P = doc0.id;
  ok('프로젝트 생성', P);

  const cubePath = await ensureSampleLut();
  const gifPath = await ensureSampleGif();
  const beatPath = await ensureBeatTrack();

  const imported = {};
  for (const [key, file] of [
    ['A', abs('clipA.mp4')], ['B', abs('clipB.mp4')],
    ['bgm', abs('bgm.wav')], ['narr', abs('narration.wav')],
    ['beat', beatPath.replaceAll('\\', '/')],
    ['lut', cubePath.replaceAll('\\', '/')], ['gif', gifPath.replaceAll('\\', '/')],
  ]) {
    const { asset } = await api('POST', `/api/projects/${P}/assets`, { path: file });
    imported[key] = asset;
  }
  if (imported.lut.kind !== 'lut') throw new Error(`.cube 가 kind:'lut' 이 아님: ${imported.lut.kind}`);
  ok('LUT(.cube) 임포트', `kind=${imported.lut.kind}`);
  if (!/\.webm$/.test(imported.gif.src)) throw new Error(`.gif 가 webm 으로 변환되지 않음: ${imported.gif.src}`);
  ok('GIF 스티커 임포트', `src=${imported.gif.src}`);

  // 프록시가 붙을 때까지 기다린다(파생·렌더가 프록시를 쓴다)
  await waitAsset(P, imported.A.id, (a) => a.proxySrc != null);
  ok('에셋 후처리(프록시)', 'clipA');

  const doc1 = await getDoc(P);
  const vTrack = doc1.tracks.find((t) => t.kind === 'video');
  const tTrack = doc1.tracks.find((t) => t.kind === 'text');
  const aTrack = doc1.tracks.find((t) => t.kind === 'audio');

  // ── 2. 기본 배치 ────────────────────────────────────────────────────────
  console.log('\n2) 클립 배치');
  const clipA = newId(), clipB = newId(), title = newId(), bgm = newId(), narr = newId();
  const overlayTrack = newId(), musicTrack = newId();
  await send(P, [
    { type: 'addClip', trackId: vTrack.id, clip: {
      id: clipA, kind: 'video', assetId: imported.A.id,
      start: 0, duration: 5000, in: 0, out: 5000, speed: 1, volume: 1,
      transitionOut: { type: 'glitch', duration: 500 },
    } },
    { type: 'addClip', trackId: vTrack.id, clip: {
      id: clipB, kind: 'video', assetId: imported.B.id,
      start: 5000, duration: 5000, in: 0, out: 5000, speed: 1, volume: 1,
      transitionIn: { type: 'whiteFlash', duration: 400 },
    } },
    { type: 'addClip', trackId: tTrack.id, clip: {
      id: title, kind: 'text', start: 300, duration: 2500, text: '킷캣 W5',
      style: { fontFamily: "Pretendard, 'Malgun Gothic', sans-serif", fontSize: 96, color: '#ffffff', align: 'center' },
    } },
    { type: 'addTrack', track: { id: musicTrack, kind: 'audio', name: '음악' } },
    { type: 'addClip', trackId: musicTrack, clip: {
      id: bgm, kind: 'audio', assetId: imported.bgm.id,
      start: 0, duration: 10000, in: 0, out: 10000, speed: 1, volume: 0.8,
    } },
    { type: 'addClip', trackId: aTrack.id, clip: {
      id: narr, kind: 'audio', assetId: imported.narr.id,
      start: 2000, duration: 4000, in: 0, out: 4000, speed: 1, volume: 1,
    } },
    { type: 'addTrack', track: { id: overlayTrack, kind: 'overlay', name: '스티커' } },
  ]);
  ok('배치 + 새 전환(glitch/whiteFlash)');

  // ── 3. 스티커 반복 ──────────────────────────────────────────────────────
  const sticker = newId();
  const gifDur = imported.gif.duration ?? 1000;
  await send(P, [{ type: 'addClip', trackId: overlayTrack, clip: {
    id: sticker, kind: 'video', assetId: imported.gif.id,
    start: 1000, duration: 6000, in: 0, out: gifDur, speed: 1, volume: 0, loop: true,
    transform: { x: 0.3, y: -0.3, scale: 0.25, rotation: 0 },
  } }]);
  ok('스티커/GIF 반복 배치', `소스 ${gifDur}ms → 6000ms 반복`);

  // ── 4. 효과·커브 ────────────────────────────────────────────────────────
  console.log('\n3) 색·효과');
  await send(P, [{ type: 'updateClip', clipId: clipA, patch: {
    effects: [
      { id: newId(), type: 'temperature', params: { amount: 0.35 } },
      { id: newId(), type: 'glow', params: { amount: 0.4, radius: 18 } },
      { id: newId(), type: 'grain', params: { amount: 0.25 } },
    ],
    curves: {
      rgb: [{ x: 0, y: 0.02 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.84 }, { x: 1, y: 1 }],
      b: [{ x: 0, y: 0 }, { x: 0.5, y: 0.55 }, { x: 1, y: 1 }],
    },
  } }]);
  ok('새 효과 3종 + 색조정 커브');

  // ── 5. LUT / 손떨림 (파생 미디어) ───────────────────────────────────────
  console.log('\n4) 파생 미디어(LUT·손떨림·잡음·피치)');
  await send(P, [
    { type: 'updateClip', clipId: clipA, patch: { source: { lut: { assetId: imported.lut.id, intensity: 0.8 } } } },
    { type: 'updateClip', clipId: clipB, patch: { source: { stabilize: { smoothing: 24 } } } },
    { type: 'updateClip', clipId: narr, patch: { source: { denoise: { amount: 0.5 }, pitch: { semitones: 2 } } } },
  ]);
  await waitAsset(P, imported.A.id, (a) => a.derived && Object.keys(a.derived).length > 0);
  ok('LUT 굽기', `clipA 파생 생성`);
  await waitAsset(P, imported.B.id, (a) => a.derived && Object.keys(a.derived).length > 0);
  ok('손떨림 보정 굽기', 'clipB 파생 생성');
  await waitAsset(P, imported.narr.id, (a) => a.derived && Object.keys(a.derived).length > 0);
  ok('잡음 제거 + 피치 보정 굽기', 'narration 파생 생성');

  // ── 6. 속도 램프 / 정지화면 ─────────────────────────────────────────────
  console.log('\n5) 시간 조작');
  const beforeRamp = (await getDoc(P)).tracks.find((t) => t.id === vTrack.id).clips.find((c) => c.id === clipB);
  await send(P, [{ type: 'setSpeedRamp', clipId: clipB, points: [
    { u: 0, speed: 1 }, { u: 0.45, speed: 0.2 }, { u: 0.55, speed: 0.2 }, { u: 1, speed: 1 },
  ] }]);
  const afterRamp = (await getDoc(P)).tracks.find((t) => t.id === vTrack.id).clips.find((c) => c.id === clipB);
  if (afterRamp.duration <= beforeRamp.duration) throw new Error('속도 램프 후 duration 이 늘지 않음');
  ok('커브 속도(총알 시간)', `${beforeRamp.duration}ms → ${afterRamp.duration}ms`);

  const freezeIds = [newId(), newId()];
  await send(P, [{ type: 'freezeFrame', clipId: clipA, at: 2000, duration: 800, newClipIds: freezeIds }]);
  const vClips = (await getDoc(P)).tracks.find((t) => t.id === vTrack.id).clips;
  const frozen = vClips.find((c) => c.id === freezeIds[0]);
  if (!frozen?.freeze) throw new Error('정지화면 클립이 생기지 않음');
  ok('정지화면', `${frozen.duration}ms 정지컷 삽입, 트랙 클립 ${vClips.length}개`);

  // ── 7. 텍스트 템플릿 ────────────────────────────────────────────────────
  console.log('\n6) 텍스트·오디오');
  await send(P, [{ type: 'applyTextTemplate', clipId: title, templateId: 'variety' }]);
  const styled = (await getDoc(P)).tracks.find((t) => t.id === tTrack.id).clips.find((c) => c.id === title);
  if (!styled.style.strokeColor) throw new Error('템플릿이 적용되지 않음');
  ok('텍스트 템플릿(variety)', `색 ${styled.style.color} / 외곽선 ${styled.style.strokeColor}`);

  // ── 8. 비트 감지 ────────────────────────────────────────────────────────
  // 실제 온셋이 있는 드럼 트랙(120BPM, 500ms 간격 16타)으로 검증한다.
  const beatJob = await api('POST', `/api/projects/${P}/assets/${imported.beat.id}/beats`);
  await waitJob(beatJob.jobId);
  const beats = (await getDoc(P)).assets[imported.beat.id].beats ?? [];
  if (beats.length < 14 || beats.length > 18) {
    throw new Error(`비트 16타를 기대했는데 ${beats.length}개 검출 (${beats.slice(0, 6).join(',')}…)`);
  }
  const gaps = beats.slice(1).map((b, i) => b - beats[i]);
  const worst = Math.max(...gaps.map((g) => Math.abs(g - 500)));
  if (worst > 60) throw new Error(`비트 간격이 500ms에서 최대 ${worst}ms 벗어남`);
  ok('비트 감지', `${beats.length}타 · 간격 오차 최대 ${worst}ms`);

  // 지속 화음(bgm)은 온셋이 없으므로 비트가 잡히면 안 된다 — 허위 비트 회귀 방지
  const bgmBeatJob = await api('POST', `/api/projects/${P}/assets/${imported.bgm.id}/beats`);
  await waitJob(bgmBeatJob.jobId);
  const bgmBeats = (await getDoc(P)).assets[imported.bgm.id].beats ?? [];
  if (bgmBeats.length > 0) throw new Error(`지속 화음에서 허위 비트 ${bgmBeats.length}개`);
  ok('허위 비트 없음', '지속 화음 → 0개');

  // ── 9. 더킹 ─────────────────────────────────────────────────────────────
  await send(P, [{ type: 'duckTrack', musicTrackId: musicTrack, voiceTrackId: aTrack.id,
    amount: 0.25, attackMs: 200, releaseMs: 400 }]);
  const ducked = (await getDoc(P)).tracks.find((t) => t.id === musicTrack).clips.find((c) => c.id === bgm);
  const volKfs = (ducked.keyframes ?? []).filter((k) => k.prop === 'volume');
  if (volKfs.length < 4) throw new Error(`더킹 키프레임이 부족: ${volKfs.length}`);
  ok('더킹', `볼륨 키프레임 ${volKfs.length}개`);

  // ── 10. 커버 ────────────────────────────────────────────────────────────
  console.log('\n7) 출력');
  const coverJob = await api('POST', `/api/projects/${P}/cover`, { timeMs: 1500 });
  const coverDone = await waitJob(coverJob.jobId);
  ok('커버 지정', coverDone.result?.url ?? '(url 없음)');

  // ── 11. 렌더 (mp4 + mov 알파) ───────────────────────────────────────────
  const mp4Job = await api('POST', `/api/projects/${P}/render`, { format: 'mp4', outName: 'w5-demo' });
  const mp4Done = await waitJob(mp4Job.jobId);
  ok('MP4 렌더', mp4Done.result?.path ?? '');

  const movJob = await api('POST', `/api/projects/${P}/render`, { format: 'mov', transparent: true, outName: 'w5-alpha' });
  const movDone = await waitJob(movJob.jobId);
  ok('MOV(알파) 렌더', movDone.result?.path ?? '');

  // ── 12. 느린 것들 (--full) ──────────────────────────────────────────────
  console.log('\n8) 무거운 처리');
  if (!FULL) {
    skip('업스케일', '--full 필요');
    skip('프레임 보간', '--full 필요');
    skip('보컬 분리', '--full 필요');
  } else {
    const up = await api('POST', `/api/projects/${P}/assets/${imported.A.id}/upscale`, { scale: 2 });
    await waitJob(up.jobId);
    ok('업스케일 2x');

    const interp = await api('POST', `/api/projects/${P}/assets/${imported.A.id}/interpolate`, { fps: 60 });
    await waitJob(interp.jobId);
    ok('프레임 보간 60fps');

    try {
      const sep = await api('POST', `/api/projects/${P}/assets/${imported.bgm.id}/separate`);
      await waitJob(sep.jobId, 40 * 60 * 1000);
      ok('보컬 분리(Demucs)');
    } catch (err) {
      if (err.status === 501) skip('보컬 분리', 'Demucs 미설치 → 501 (계약대로)');
      else throw err;
    }
  }

  // ── 요약 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.ok === false);
  const passed = results.filter((r) => r.ok === true);
  const skipped = results.filter((r) => r.ok === null);
  console.log(`\n결과: 통과 ${passed.length} · 건너뜀 ${skipped.length} · 실패 ${failed.length}`);
  console.log(`프로젝트: ${BASE}/p/${P}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\ndemo-w5 실패: ${err.message}`);
  process.exit(1);
});
