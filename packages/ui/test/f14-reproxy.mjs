// F14 — 프로젝트의 옛 판 프록시(원본·파생)를 `-g 15` 판으로 다시 굽는다 (reproxy-all) 후 끝날 때까지 기다린다.
// 사용: node f14-reproxy.mjs <base> <projectId>
const BASE = process.argv[2] ?? 'http://localhost:5757';
const PROJECT = process.argv[3] ?? 'kZ55tAPqA6KFN7xj80kJ0';

const listProxies = async () => {
  const { doc } = await (await fetch(`${BASE}/api/projects/${PROJECT}`)).json();
  const rows = [];
  for (const a of Object.values(doc.assets)) {
    if (a.kind !== 'video') continue;
    rows.push(`${a.id.slice(0, 6)} proxy=${a.proxySrc} derived=${Object.values(a.derived ?? {}).map((x) => x.proxySrc).join(',')}`);
  }
  return rows;
};

console.log('--- 전 ---');
for (const r of await listProxies()) console.log(r);

const res = await fetch(`${BASE}/api/projects/${PROJECT}/assets/reproxy-all`, { method: 'POST' });
const body = await res.json();
console.log('reproxy-all →', res.status, JSON.stringify(body));
if (!res.ok) process.exit(res.status === 400 ? 0 : 1);

const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const job = await (await fetch(`${BASE}/api/jobs/${body.jobId}`)).json();
  const st = job.status ?? job.state;
  process.stdout.write(`\r  ${Math.round((Date.now() - t0) / 1000)}s ${st} ${job.message ?? ''}   `);
  if (st === 'done' || st === 'succeeded' || st === 'completed' || st === 'failed' || st === 'error') {
    console.log('\n잡 종료:', JSON.stringify(job).slice(0, 400));
    break;
  }
  if (Date.now() - t0 > 20 * 60_000) { console.log('\n20분 초과'); process.exit(1); }
}
console.log('--- 후 ---');
for (const r of await listProxies()) console.log(r);
