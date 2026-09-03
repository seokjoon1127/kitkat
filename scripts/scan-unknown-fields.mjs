#!/usr/bin/env node
// 저장된 프로젝트 문서 전부를 스키마에 통과시켜, «스키마에 없는데 살아남은 필드»를 센다.
//
// 왜: 문서 검증이 `safeParse` 로 「맞는지」만 보고 원본을 그대로 저장해 왔다(W8 F17 리뷰 #1).
// 그래서 에이전트가 없는 필드를 넣어도 200 이 나오고 파일에 남는다. 지금 얼마나 쌓였는지 본다.
//
//   node scripts/scan-unknown-fields.mjs            # 세기만
//   node scripts/scan-unknown-fields.mjs --json     # 경로 목록을 JSON 으로
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectDocSchema, findUnknownKeys } from '../packages/schema/dist/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'data', 'projects');
const asJson = process.argv.includes('--json');

const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
let totalUnknown = 0;
let docsWithUnknown = 0;
let invalid = 0;
const byPath = new Map(); // «형태만 남긴 경로» → 개수 (tracks.3.clips.1.foo → tracks.*.clips.*.foo)
const report = [];

for (const f of files) {
  const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
  const r = ProjectDocSchema.safeParse(raw);
  if (!r.success) {
    invalid++;
    report.push({ file: f, invalid: r.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} — ${i.message}`) });
    continue;
  }
  const unknown = findUnknownKeys(raw, r.data);
  if (unknown.length === 0) continue;
  docsWithUnknown++;
  totalUnknown += unknown.length;
  for (const p of unknown) {
    const shape = p.replace(/\.\d+(?=\.|$)/g, '.*');
    byPath.set(shape, (byPath.get(shape) ?? 0) + 1);
  }
  report.push({ file: f, name: raw.name, unknown });
}

if (asJson) {
  console.log(JSON.stringify({ files: files.length, docsWithUnknown, totalUnknown, invalid, byPath: Object.fromEntries(byPath), report }, null, 1));
} else {
  console.log(`프로젝트 파일 ${files.length}개 · 유령 필드 있는 문서 ${docsWithUnknown}개 · 유령 필드 총 ${totalUnknown}개 · 스키마 불통과 ${invalid}개`);
  if (byPath.size > 0) {
    console.log('\n경로별 (같은 모양끼리 묶음):');
    for (const [p, n] of [...byPath.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${p}`);
  }
  for (const r of report.filter((x) => x.invalid)) console.log(`\n스키마 불통과: ${r.file}\n  ${r.invalid.join('\n  ')}`);
}
