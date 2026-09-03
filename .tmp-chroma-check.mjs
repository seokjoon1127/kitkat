// T1 크로마키 실렌더 검증 (임시 스크립트) — 서버(5757)에 프로젝트를 만들어 알파 MOV 를 뽑고
// 픽셀을 직접 읽는다.  node .tmp-chroma-check.mjs <label> [similarity] [smoothness] [spill]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const BASE = 'http://127.0.0.1:5757';
const label = process.argv[2] ?? 'run';
const similarity = Number(process.argv[3] ?? 0.4);
const smoothness = Number(process.argv[4] ?? 0.1);
const spillArg = process.argv[5];
const SRC = process.env.CHROMA_SRC ?? 'C:/Users/david/project/kitkat/media/samples/green.mp4';
const newId = () => randomUUID().replaceAll('-', '').slice(0, 21);

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${parsed.error ?? text}`);
  return parsed;
}

async function waitJob(jobId) {
  for (;;) {
    const job = await api('GET', `/api/jobs/${jobId}`);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error ?? '잡 오류');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const { doc } = await api('POST', '/api/projects', {
  name: `크로마키 검증 ${label}`, width: 480, height: 480, fps: 30,
});
const P = doc.id;
const { asset } = await api('POST', `/api/projects/${P}/assets`, { path: SRC });
console.log(`asset ${asset.id} ${asset.width}x${asset.height} ${asset.duration}ms`);

const chromaKey = { color: '#00b140', similarity, smoothness };
if (spillArg !== undefined) chromaKey.spill = Number(spillArg);
const vTrack = doc.tracks.find((t) => t.kind === 'video');
await api('POST', `/api/projects/${P}/commands`, {
  commands: [{
    type: 'addClip', trackId: vTrack.id,
    clip: {
      id: newId(), kind: 'video', assetId: asset.id,
      start: 0, duration: 500, in: 0, out: 500, speed: 1, volume: 0, chromaKey,
    },
  }],
});

const { jobId } = await api('POST', `/api/projects/${P}/render`, {
  format: 'mov', transparent: true, proxy: false, outName: `chroma-${label}`,
});
const done = await waitJob(jobId);
const out = done.result.path;
console.log('rendered', out);

const { stdout } = await run(
  'ffmpeg',
  ['-hide_banner', '-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  { encoding: 'buffer', maxBuffer: 1 << 28 },
);
const W = 480, H = 480;
if (stdout.length !== W * H * 4) throw new Error(`프레임 크기가 다름: ${stdout.length}`);
const px = (x, y) => {
  const i = (y * W + x) * 4;
  return { r: stdout[i], g: stdout[i + 1], b: stdout[i + 2], a: stdout[i + 3] };
};
const fmt = (p) => `rgba(${String(p.r).padStart(3)},${String(p.g).padStart(3)},${String(p.b).padStart(3)},${String(p.a).padStart(3)})`;

console.log(`\n=== ${label} (similarity=${similarity} smoothness=${smoothness}${spillArg !== undefined ? ` spill=${spillArg}` : ''}) ===`);
for (const [name, x, y] of [
  ['배경 (20,20)', 20, 20],
  ['배경 (460,460)', 460, 460],
  ['배경 (240,400)', 240, 400],
  ['피사체 중앙 (240,240)', 240, 240],
  ['가는 선3px (237,100)', 237, 100],
  ['가는 선2px (251,100)', 251, 100],
]) console.log(`${name.padEnd(24)} ${fmt(px(x, y))}`);

console.log('\n경계 안쪽 G - (R+B)/2  (알파>0 인 픽셀만, 20 이하가 합격):');
for (const d of [0, 1, 2, 3, 4]) {
  let worst = -999, worstAt = null;
  const scan = [];
  for (let y = 140 + d; y <= 339 - d; y++) { scan.push([140 + d, y]); scan.push([339 - d, y]); }
  for (let x = 140 + d; x <= 339 - d; x++) { scan.push([x, 140 + d]); scan.push([x, 339 - d]); }
  for (const [x, y] of scan) {
    const p = px(x, y);
    if (p.a === 0) continue;
    const v = p.g - (p.r + p.b) / 2;
    if (v > worst) { worst = v; worstAt = [x, y, p]; }
  }
  console.log(`  안쪽 ${d}px: 최대 ${worst.toFixed(1)}  at (${worstAt?.[0]},${worstAt?.[1]}) ${worstAt ? fmt(worstAt[2]) : ''}`);
}

let a0 = 0, a255 = 0, mid = 0;
for (let i = 3; i < stdout.length; i += 4) {
  const a = stdout[i];
  if (a === 0) a0++; else if (a === 255) a255++; else mid++;
}
console.log(`\n알파: 0=${a0} (${(a0 / (W * H) * 100).toFixed(1)}%)  255=${a255} (${(a255 / (W * H) * 100).toFixed(1)}%)  중간=${mid}`);
console.log(`피사체 기대 픽셀 수: ${200 * 200 + 3 * 90 + 2 * 90}`);

console.log('\ny=240 단면 x=134..148:');
console.log([...Array(15).keys()].map((i) => `${134 + i}:${fmt(px(134 + i, 240))}`).join('  '));
console.log('\ny=100 단면 x=232..256 (가는 선):');
console.log([...Array(25).keys()].map((i) => `${232 + i}:${fmt(px(232 + i, 100))}`).join('  '));
