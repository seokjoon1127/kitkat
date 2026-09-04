// W8 F17 V5-6 실측 — 스템 뺄셈(「전체 − 트리거 = 눌릴 스템」)을 «실제 렌더»로 검증한다.
//
// 재는 것:
//  1) 비트 동일성  — 3패스로 구운 눌릴 스템 vs 뺄셈으로 얻은 것 (최대 오차·RMS·상관계수)
//  2) 속도        — 3패스 vs 뺄셈 실측 초
//  3) 포화 폴백    — 볼륨을 올려 일부러 클리핑을 만들고 폴백이 도는지
//  4) 최종 산출물  — 두 경로의 최종 mp4 오디오 (LUFS·감쇠 깊이·파형 상관)
//
// 서버를 거치지 않고 @kitkat/renderer 를 직접 부른다 (잡 큐·진행률과 무관하게 숫자만 본다).
// 렌더는 gl 기본값(SwiftShader) — GPU 를 켜지 않는다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAudioStem, renderProject } from '@kitkat/renderer';
import {
  canSubtractStems,
  countFullScaleSamples,
  extractPcmAudio,
  findDuckPairs,
  pcmShape,
  stripVolumeKeyframes,
  subtractStem,
  levelScGain,
  measureLoudness,
  muxSidechain,
  sidechainGraph,
  thresholdDbFor,
  thresholdLinear,
} from '../packages/server/dist/sidechain.js';

const exec = promisify(execFile);
// 인자가 없으면 이 파일 위치를 기준으로 레포 뿌리를 찾는다
const ROOT = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(MEDIA, 'w8-f17-sub');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const FPS = 30;
const DUR = 4000; // narration.wav 가 4초

/** 영상 1장(소리 없음) + 음악 트랙 + 나레이션 트랙. musicVolume 으로 포화를 만든다. */
function makeDoc(musicVolume = 1, narrVolume = 1, extraTrack = false, trackVolume = 1) {
  const tracks = [
    {
      id: 'tv', kind: 'video', name: '비디오',
      clips: [{ id: 'v1', kind: 'video', assetId: 'clipA', start: 0, duration: DUR,
                in: 0, out: DUR, speed: 1, volume: 0 }],
    },
    {
      id: 'music', kind: 'audio', name: '음악', volume: trackVolume,
      duckedBy: 'narr', duck: { amount: 0.25, attackMs: 200, releaseMs: 400 },
      clips: [{ id: 'm1', kind: 'audio', assetId: 'bgm', start: 0, duration: DUR,
                in: 0, out: DUR, speed: 1, volume: musicVolume }],
    },
    {
      id: 'narr', kind: 'audio', name: '나레이션', volume: trackVolume,
      clips: [{ id: 'n1', kind: 'audio', assetId: 'narr', start: 0, duration: DUR,
                in: 0, out: DUR, speed: 1, volume: narrVolume }],
    },
  ];
  if (extraTrack) {
    tracks.push({
      id: 'sfx', kind: 'audio', name: '효과음',
      clips: [{ id: 's1', kind: 'audio', assetId: 'beat', start: 0, duration: DUR,
                in: 0, out: DUR, speed: 1, volume: 0.5 }],
    });
  }
  return {
    schemaVersion: 1, id: 'f17sub', name: 'F17 스템 뺄셈', revision: 0,
    settings: { width: 540, height: 960, fps: FPS, background: { kind: 'color', color: '#000000' } },
    assets: {
      clipA: { id: 'clipA', kind: 'video', src: 'samples/clipA.mp4', name: 'clipA', duration: 5000, width: 1080, height: 1920 },
      bgm: { id: 'bgm', kind: 'audio', src: 'samples/bgm.wav', name: 'bgm', duration: 12000 },
      narr: { id: 'narr', kind: 'audio', src: 'samples/narration.wav', name: 'narration', duration: 4000 },
      beat: { id: 'beat', kind: 'audio', src: 'samples/beat.wav', name: 'beat', duration: 4000 },
    },
    tracks,
  };
}

// ── wav 비교 (순수) ──────────────────────────────────────────────────────
function wavSamples(abs) {
  const buf = readFileSync(abs);
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'data') {
      const n = Math.min(size, buf.length - p - 8);
      const out = new Int32Array(Math.floor(n / 2));
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(p + 8 + i * 2);
      return out;
    }
    p += 8 + size + (size % 2);
  }
  throw new Error(`data 청크 없음: ${abs}`);
}

function compare(aAbs, bAbs) {
  const a = wavSamples(aAbs);
  const b = wavSamples(bAbs);
  const n = Math.min(a.length, b.length);
  let maxAbs = 0, sq = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, diffCount = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    if (d !== 0) diffCount++;
    if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    sq += d * d;
    sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i];
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  const corr = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
  const rms = Math.sqrt(sq / n);
  const refRms = Math.sqrt(sbb / n);
  return {
    lenA: a.length, lenB: b.length, compared: n,
    maxAbsDiff: maxAbs, diffSamples: diffCount,
    rmsDiff: rms,
    rmsDiffDbfs: rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity,
    refRmsDbfs: refRms > 0 ? 20 * Math.log10(refRms / 32768) : -Infinity,
    corr,
  };
}

const stemOpts = { mediaDir: MEDIA, range: { start: 0, end: DUR } };
const log = (...a) => console.log(...a);
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1);

/**
 * Remotion 의 `<OffthreadVideo>` 프레임 가져오기가 가끔 28초 안에 안 끝나 렌더가 통째로 죽는다
 * (`delayRender() "Fetching …/proxy?src=…"`). 이 최적화와 무관한 흔들림이라 한 번 다시 해 본다.
 */
async function retry(label, fn, times = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= times) throw e;
      log(`    (${label} ${i}회차 실패 — 다시 한다: ${String(e).slice(0, 120)})`);
    }
  }
}

// ── 3패스 (지금 방식) ────────────────────────────────────────────────────
async function threePass(doc, tag) {
  const t0 = Date.now();
  const trigger = path.join(OUT, `${tag}-trigger.wav`);
  const ducked = path.join(OUT, `${tag}-ducked3.wav`);
  const video = path.join(OUT, `${tag}-video3.mp4`);
  await renderAudioStem(doc, { ...stemOpts, outPath: trigger, soloTrackIds: ['narr'] });
  const tStem = secs(t0);
  const t1 = Date.now();
  await renderAudioStem(stripVolumeKeyframes(doc, 'music'), {
    ...stemOpts, outPath: ducked, soloTrackIds: ['music'],
  });
  const tStem2 = secs(t1);
  const t2 = Date.now();
  await retry('3패스 영상', () =>
    renderProject(
      { ...doc, tracks: doc.tracks.map((t) => (t.id === 'music' || t.id === 'narr' ? { ...t, muted: true } : t)) },
      { mediaDir: MEDIA, outPath: video, range: { start: 0, end: DUR } },
    ),
  );
  const tVideo = secs(t2);
  return { trigger, ducked, video, total: secs(t0), tStem, tStem2, tVideo };
}

// ── 뺄셈 ────────────────────────────────────────────────────────────────
async function subtractPass(doc, tag, triggerWav) {
  const t0 = Date.now();
  // h264 + pcm-16 은 확장자가 mkv·mov 여야 한다 (remotion validateOutputFilename)
  const video = path.join(OUT, `${tag}-videoFull.mkv`);
  const full = path.join(OUT, `${tag}-full.wav`);
  const ducked = path.join(OUT, `${tag}-duckedSub.wav`);
  await retry('뺄셈 영상', () =>
    renderProject(stripVolumeKeyframes(doc, 'music'), {
      mediaDir: MEDIA, outPath: video, range: { start: 0, end: DUR }, audioCodec: 'pcm-16',
    }),
  );
  const tVideo = secs(t0);
  await extractPcmAudio(video, full);
  const clip = await countFullScaleSamples(full);
  const shapeFull = await pcmShape(full);
  const shapeTrig = await pcmShape(triggerWav);
  const t1 = Date.now();
  await subtractStem(full, triggerWav, ducked);
  return {
    video, full, ducked, clip, shapeFull, shapeTrig,
    total: secs(t0), tVideo, tSubtract: secs(t1),
  };
}

async function mux(doc, video, ducked, trigger, outAbs) {
  const tr = await measureLoudness(trigger);
  const o = {
    levelSc: levelScGain(tr.i),
    threshold: thresholdLinear(thresholdDbFor(0.25)),
    attackMs: 200, releaseMs: 400, videoHasAudio: false,
  };
  await muxSidechain(video, ducked, trigger, outAbs, o);
  return o;
}

async function finalAudio(mp4, tag) {
  const wav = path.join(OUT, `${tag}-final.wav`);
  await exec('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', wav]);
  const ln = await measureLoudness(wav);
  return { wav, lufs: ln.i, tp: ln.tp };
}

const ONLY = process.env.ONLY ?? '';

// ══ 1. 조건이 맞는 문서 ═════════════════════════════════════════════════
const doc = makeDoc();
if (ONLY !== 'B') {
log('■ 문서 A (영상 무음 + 음악 + 나레이션) — canSubtractStems:',
    JSON.stringify(canSubtractStems(doc, findDuckPairs(doc), {})));

// 준비운동 — 첫 렌더에 웹팩 번들 비용이 통째로 들어간다. 속도 비교에서 빼야 한다.
{
  const t = Date.now();
  await renderAudioStem(doc, {
    ...stemOpts, outPath: path.join(OUT, 'warmup.wav'), soloTrackIds: ['narr'],
  });
  log(`(준비운동 렌더 ${secs(t)}초 — 번들 비용. 아래 숫자에는 안 들어간다)`);
}

log('\n[1] 3패스 렌더');
const three = await threePass(doc, 'A');
log(`    트리거 스템 ${three.tStem}초 · 눌릴 스템 ${three.tStem2}초 · 영상 ${three.tVideo}초 → 합계 ${three.total}초`);

log('\n[2] 뺄셈 렌더 (트리거 스템은 위 것을 그대로 재사용 — 두 경로 공통 단계다)');
const sub = await subtractPass(doc, 'A', three.trigger);
log(`    영상+전체오디오 ${sub.tVideo}초 · 뺄셈 ${sub.tSubtract}초 → 합계 ${sub.total}초`);
log(`    전체 믹스 포화 표본 ${sub.clip.full}/${sub.clip.total}`);
log(`    표본 정렬 전체=${JSON.stringify(sub.shapeFull)} 트리거=${JSON.stringify(sub.shapeTrig)}`);

log('\n[3] 비트 동일성 — 3패스 눌릴 스템 vs 뺄셈 눌릴 스템');
const cmp = compare(sub.ducked, three.ducked);
log(JSON.stringify(cmp, null, 2));

log('\n[4] 속도 (트리거 스템 포함 총합)');
const t3 = Number(three.total);
const t2 = Number(three.tStem) + Number(sub.total);
log(`    3패스 ${t3.toFixed(1)}초 · 뺄셈 ${t2.toFixed(1)}초 → ${((1 - t2 / t3) * 100).toFixed(1)}% 단축`);

log('\n[5] 최종 산출물 비교');
const outThree = path.join(OUT, 'A-final-3pass.mp4');
const outSub = path.join(OUT, 'A-final-sub.mp4');
await mux(doc, three.video, three.ducked, three.trigger, outThree);
await mux(doc, sub.video, sub.ducked, three.trigger, outSub);
const fa = await finalAudio(outThree, 'A-3pass');
const fb = await finalAudio(outSub, 'A-sub');
log(`    3패스 최종: ${fa.lufs.toFixed(2)} LUFS · TP ${fa.tp.toFixed(2)}`);
log(`    뺄셈  최종: ${fb.lufs.toFixed(2)} LUFS · TP ${fb.tp.toFixed(2)}`);
log('    최종 오디오 비교:', JSON.stringify(compare(fb.wav, fa.wav), null, 2));
log(`    파일 크기 ${statSync(outThree).size} vs ${statSync(outSub).size}`);

}

// ══ 2. 포화 — 볼륨을 올려 일부러 클리핑 ═════════════════════════════════
log('\n■ 문서 B (클립 2.0 × 트랙 2.0 = 4배) — 포화 폴백');
const docB = makeDoc(2, 2, false, 2);
log('    canSubtractStems:', JSON.stringify(canSubtractStems(docB, findDuckPairs(docB), {})));
const trigB = path.join(OUT, 'B-trigger.wav');
await renderAudioStem(docB, { ...stemOpts, outPath: trigB, soloTrackIds: ['narr'] });
const videoB = path.join(OUT, 'B-videoFull.mkv');
await retry('B 영상', () =>
  renderProject(stripVolumeKeyframes(docB, 'music'), {
    mediaDir: MEDIA, outPath: videoB, range: { start: 0, end: DUR }, audioCodec: 'pcm-16',
  }),
);
const fullB = path.join(OUT, 'B-full.wav');
await extractPcmAudio(videoB, fullB);
const clipB = await countFullScaleSamples(fullB);
log(`    포화 표본 ${clipB.full}/${clipB.total} = ${((clipB.full / clipB.total) * 100).toFixed(4)}%`);
// 폴백이 안 돌았다면 뺄셈이 얼마나 틀리는지도 재 둔다
const duckedB3 = path.join(OUT, 'B-ducked3.wav');
await renderAudioStem(stripVolumeKeyframes(docB, 'music'), {
  ...stemOpts, outPath: duckedB3, soloTrackIds: ['music'],
});
const duckedBsub = path.join(OUT, 'B-duckedSub.wav');
await subtractStem(fullB, trigB, duckedBsub);
log('    (참고) 포화 상태에서 그냥 뺐다면:', JSON.stringify(compare(duckedBsub, duckedB3), null, 2));

// ══ 3. 조건 미달 — 오디오 트랙 3개 ══════════════════════════════════════
const docC = makeDoc(1, 1, true);
log('\n■ 문서 C (오디오 트랙 3개) — canSubtractStems:',
    JSON.stringify(canSubtractStems(docC, findDuckPairs(docC), {})));

log('\n결과 폴더:', OUT);
