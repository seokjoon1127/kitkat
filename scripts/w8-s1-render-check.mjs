// W8 S1 실측 검증 — effects#<id>.params.amount 키프레임이 «실제 렌더»에 나오는지 픽셀로 잰다.
// 균일한 중간회색(RGB 128) 1초 소스에 brightness 를 걸고 0.5 → 1.5 로 램프한 뒤
// 프레임마다 평균 밝기를 잰다. 기대: 0.5*128=64 → 1.0*128=128 → 1.4667*128=188, 단조 증가.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
const exec = promisify(execFile);

const BASE = 'http://127.0.0.1:5757';
const j = async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};

// 균일 중간회색 소스를 만든다 (없으면). RGB 128 · 540x960 · 1초 · 30fps
const GRAY = 'media/assets/w8-gray.mp4';
if (!existsSync(GRAY)) {
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=540x960:d=1:r=30',
                        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '0', GRAY]);
  console.log('중간회색 소스 생성:', GRAY);
}

const doc = await j('POST', '/api/projects', { name: 'W8 S1 렌더검증' });
const id = doc.id ?? doc.doc?.id;
const project = doc.id ? doc : doc.doc;
const videoTrack = project.tracks.find((t) => t.kind === 'video');

await j('POST', `/api/projects/${id}/commands`, {
  commands: [
    { type: 'addAsset', asset: { id: 'gray', kind: 'video', src: 'assets/w8-gray.mp4',
                                 name: 'w8-gray.mp4', duration: 1000, width: 540, height: 960 } },
    { type: 'addClip', trackId: videoTrack.id, clip: {
        id: 'kfclip', kind: 'video', assetId: 'gray', start: 0, duration: 1000,
        in: 0, out: 1000, speed: 1, volume: 1,
        effects: [{ id: 'e1', type: 'brightness', params: { amount: 1 } }],
      } },
    { type: 'setKeyframes', clipId: 'kfclip', keyframes: [
        { time: 0, prop: 'effects#e1.params.amount', value: 0.5, easing: 'linear' },
        { time: 1000, prop: 'effects#e1.params.amount', value: 1.5, easing: 'linear' },
      ] },
  ],
});
console.log('문서 준비 완료 — effects#e1.params.amount 0.5 → 1.5 (linear, 0→1000ms)');

const { jobId } = await j('POST', `/api/projects/${id}/render`, { outName: 'w8-s1-kfcheck', fps: 30 });
let job;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  job = await j('GET', `/api/jobs/${jobId}`);
  if (job.status === 'done' || job.status === 'error' || job.status === 'failed') break;
}
if (job.status !== 'done') throw new Error(`렌더 실패: ${JSON.stringify(job)}`);
const out = job.result.path;
console.log('렌더 완료:', out);

/** 프레임별 평균 밝기 — signalstats 의 YAVG. 출력이 full range(yuvj420p/pc)라 Y = RGB 값이다. */
async function frameLuma(file) {
  const { stderr, stdout } = await exec(
    'ffmpeg',
    ['-v', 'info', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'],
    { maxBuffer: 1 << 26 },
  );
  return [...`${stdout}${stderr}`.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
}

const frames = await frameLuma(out);
console.log(`프레임 ${frames.length}장`);

let monotonic = true;
for (let i = 1; i < frames.length; i++) if (frames[i] < frames[i - 1]) monotonic = false;

const rows = frames.map((v, f) => {
  const amount = 0.5 + f / 30;                 // t = f/30 초, 0→1000ms 를 0.5→1.5 로 램프
  const expect = Math.min(255, 128 * amount);
  return { f, 측정: v, 기대: +expect.toFixed(1), 차이: +(v - expect).toFixed(1) };
});
console.table(rows.filter((r) => r.f % 5 === 0 || r.f === rows.length - 1));

const maxErr = Math.max(...rows.map((r) => Math.abs(r.차이)));
console.log(`\n최대 오차 ${maxErr.toFixed(2)} (합격 기준 ≤ 3)`);
console.log(`단조 증가: ${monotonic ? 'OK' : '실패'} (30프레임 전부 Y[i+1] >= Y[i])`);
console.log(`프레임 0 → ${frames[0]} (기대 64) · 15 → ${frames[15]} (기대 128) · 29 → ${frames[29]} (기대 188)`);

// ── 대조군: 같은 문서에서 키프레임만 지우면 밝기가 «변하지 않아야» 한다 ──
await j('POST', `/api/projects/${id}/commands`, {
  commands: [{ type: 'setKeyframes', clipId: 'kfclip', keyframes: [] }],
});
const ctl = await j('POST', `/api/projects/${id}/render`, { outName: 'w8-s1-kfcheck-control', fps: 30 });
let cjob;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  cjob = await j('GET', `/api/jobs/${ctl.jobId}`);
  if (cjob.status === 'done' || cjob.status === 'error' || cjob.status === 'failed') break;
}
const control = await frameLuma(cjob.result.path);
const spread = Math.max(...control) - Math.min(...control);
console.log(`대조군(키프레임 없음, amount=1): ${Math.min(...control)}..${Math.max(...control)} — 변동폭 ${spread}`);

const ok = maxErr <= 3 && monotonic && spread <= 1;
console.log(ok ? '\n✅ 합격' : '\n❌ 불합격');
process.exit(ok ? 0 : 1);
