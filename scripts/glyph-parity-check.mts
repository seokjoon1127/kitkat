// #7 — 자작 TrueType 파서(glyph-path.ts) ↔ opentype.js **전수** 대조.
//
//   npx tsx scripts/glyph-parity-check.mts            번들 폰트 12파일 × cmap 의 모든 코드포인트
//   npx tsx scripts/glyph-parity-check.mts --census   특수 경우(복합 변환·점 매칭·오프커브 시작 …)가
//                                                     어느 글리프에 있는지 표본 코드포인트를 뽑는다
//
// 느려서(수십 초) vitest 에는 표본만 넣고, 전수는 이 스크립트로 돈다.
// 비교 규칙은 packages/renderer/test/glyph-parity.ts 참고.
import {
  ALL_FONT_FILES,
  compareGlyph,
  glyfFacts,
  locaFormat,
  parseBoth,
  type GlyfFacts,
  type Mismatch,
} from '../packages/renderer/test/glyph-parity.ts';

const census = process.argv.includes('--census');

type FactKey = keyof Omit<GlyfFacts, 'compFlags' | 'depth'>;
const FACT_KEYS: FactKey[] = [
  'composite',
  'pointMatch',
  'scale',
  'xyScale',
  'twoByTwo',
  'twoByTwoOffDiag',
  'overlapCompound',
  'firstOff',
  'consecutiveOff',
  'allOff',
];

let totalGlyphs = 0;
let totalMismatch = 0;
const t0 = Date.now();

for (const file of ALL_FONT_FILES) {
  const t1 = Date.now();
  const { ours, ot, bytes } = parseBoth(file);
  const cps = [...ours.cmap.keys()].sort((a, b) => a - b);

  // cmap: 우리 표와 opentype.js 표가 같은가 (양방향)
  const otMap: Record<string, number> = ot.tables.cmap.glyphIndexMap;
  let cmapDiff = 0;
  const cmapDiffSample: string[] = [];
  for (const cp of cps) {
    const g = otMap[cp];
    if (g !== ours.cmap.get(cp)) {
      cmapDiff++;
      if (cmapDiffSample.length < 5) cmapDiffSample.push(`U+${cp.toString(16)}: ours ${ours.cmap.get(cp)} ot ${g}`);
    }
  }
  let otOnly = 0;
  const otOnlySample: string[] = [];
  for (const k of Object.keys(otMap)) {
    const cp = Number(k);
    if (!ours.cmap.has(cp) && otMap[k] !== 0) {
      otOnly++;
      if (otOnlySample.length < 5) otOnlySample.push(`U+${cp.toString(16)}→${otMap[k]}`);
    }
  }

  const mismatches: Mismatch[] = [];
  const factSamples = new Map<FactKey, number[]>();
  let maxDepth = 0;
  for (const cp of cps) {
    const m = compareGlyph(ours, ot, cp);
    if (m) mismatches.push(m);
    if (census) {
      const f = glyfFacts(ours, ours.cmap.get(cp)!);
      maxDepth = Math.max(maxDepth, f.depth);
      for (const k of FACT_KEYS) {
        if (!f[k]) continue;
        const arr = factSamples.get(k) ?? [];
        if (arr.length < 6) arr.push(cp);
        factSamples.set(k, arr);
      }
    }
  }
  totalGlyphs += cps.length;
  totalMismatch += mismatches.length;

  const byKind = new Map<string, number>();
  for (const m of mismatches) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
  console.log(
    `${file.padEnd(28)} loca=${locaFormat(bytes) === 0 ? 'short' : 'long'} ` +
      `glyphs(cmap)=${cps.length.toString().padStart(6)} numGlyphs=${ours.numGlyphs} ` +
      `mismatch=${mismatches.length} cmapDiff=${cmapDiff} otOnly=${otOnly} (${Date.now() - t1}ms)`,
  );
  if (cmapDiffSample.length) console.log(`   cmap 불일치 예: ${cmapDiffSample.join(', ')}`);
  if (otOnlySample.length) console.log(`   opentype 에만 있는 코드포인트 예: ${otOnlySample.join(', ')}`);
  if (mismatches.length) {
    console.log(`   종류별: ${[...byKind].map(([k, v]) => `${k}=${v}`).join(' ')}`);
    const list = mismatches
      .slice(0, 40)
      .map((m) => `U+${m.cp.toString(16).toUpperCase()}(${String.fromCodePoint(m.cp)} gid${m.gid} ${m.kind}: ${m.detail})`)
      .join('\n     ');
    console.log(`   코드포인트: ${list}${mismatches.length > 40 ? `\n     … 외 ${mismatches.length - 40}개` : ''}`);
  }
  if (census) {
    const fvar = (ot.tables as { fvar?: { axes: { tag: string; defaultValue: number; minValue: number; maxValue: number }[] } }).fvar;
    if (fvar) console.log(`   fvar: ${fvar.axes.map((a) => `${a.tag}=${a.minValue}..${a.defaultValue}..${a.maxValue}`).join(' ')} gvar=${'gvar' in ot.tables}`);
    console.log(`   복합 최대 깊이=${maxDepth}`);
    for (const k of FACT_KEYS) {
      const s = factSamples.get(k);
      console.log(`   ${k.padEnd(16)} ${s ? s.map((cp) => `U+${cp.toString(16).toUpperCase()}(${String.fromCodePoint(cp)})`).join(' ') : '-'}`);
    }
  }
}

console.log(`\n합계: 글리프 ${totalGlyphs}개, 불일치 ${totalMismatch}개 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exitCode = totalMismatch === 0 ? 0 : 1;
