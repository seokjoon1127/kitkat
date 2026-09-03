// #7 — 자작 TrueType 파서(glyph-path.ts) 검증. 기준은 opentype.js(검증용 devDependency).
//
// 전수(14파일 — 번들 12 + drawStroke 윤곽선용 정적 Noto 2 — 약 150k 글리프)는 `npx tsx scripts/glyph-parity-check.mts` 로 돈다(약 2분).
// 여기서는 (1) 표본 대조, (2) F8 이 확인하지 않았던 경우 하나씩:
//   복합 글리프의 배율 / xy배율 / 2×2 / 점 매칭 / OVERLAP_COMPOUND,
//   cmap 형식 4 의 idRangeOffset(glyphIdArray) 경계, loca short/long,
//   곡선점 연속(암시적 통과점) / 첫 점이 곡선점 / 전부 곡선점, 가변 폰트의 gvar.
// 번들 폰트에 **없는** 경우는 손으로 만든 최소 TTF(buildMiniTtf)로 검사한다 — 같은 바이트를
// opentype.js 에도 넣어 대조하므로 «우리 짐작»이 아니라 «검증된 구현»과 맞추는 것이다.
import { describe, expect, it } from 'vitest';
import { fontFileFor, glyphPath, parseTtf, type TtfFont } from '../src/composition/glyph-path.js';
import {
  ALL_FONT_FILES,
  buildMiniTtf,
  compareGlyph,
  contourEq,
  glyfFacts,
  loadFontBytes,
  locaFormat,
  parseBoth,
  parseBothBytes,
  rawGlyphBytes,
  segmentsFromOpentype,
  segmentsFromOurPath,
  type MiniPoint,
  type OtFont,
} from './glyph-parity.js';

const cache = new Map<string, { ours: TtfFont; ot: OtFont; bytes: ArrayBuffer }>();
function both(file: string) {
  let v = cache.get(file);
  if (!v) {
    v = parseBoth(file);
    cache.set(file, v);
  }
  return v;
}
const cpOf = (ch: string) => ch.codePointAt(0)!;

/** 코드포인트 목록을 대조하고 불일치 목록(문자열)을 돌려준다. */
function mismatchesOf(file: string, cps: number[]): string[] {
  const { ours, ot } = both(file);
  const out: string[] = [];
  for (const cp of cps) {
    const m = compareGlyph(ours, ot, cp);
    if (m) out.push(`${file} U+${cp.toString(16).toUpperCase()} ${m.kind}: ${m.detail}`);
  }
  return out;
}

/** 손으로 만든 폰트를 양쪽에 넣어 코드포인트마다 대조한다. */
function miniParity(bytes: ArrayBuffer, cps: number[]): string[] {
  const { ours, ot } = parseBothBytes(bytes, 'mini');
  const out: string[] = [];
  for (const cp of cps) {
    const m = compareGlyph(ours, ot, cp);
    if (m) out.push(`U+${cp.toString(16)} ${m.kind}: ${m.detail}`);
  }
  return out;
}

const TRIANGLE: MiniPoint[][] = [
  [
    { x: 0, y: 0, on: true },
    { x: 100, y: 0, on: true },
    { x: 0, y: 200, on: true },
  ],
];
const NOTDEF = { kind: 'simple' as const, contours: [] as MiniPoint[][] };

// ── 1. 표본 대조 ──────────────────────────────────────────────────────────

describe('자작 파서 ↔ opentype.js 표본 대조 (14파일)', () => {
  const FIXED = ['값', '한', '글', '뷁', 'A', 'g', '8', '$', '%', '&', '@', '0'].map(cpOf);

  it('cmap 의 29번째 코드포인트마다 + 고정 12자: 불일치 0', () => {
    const bad: string[] = [];
    let n = 0;
    for (const file of ALL_FONT_FILES) {
      const { ours } = both(file);
      const cps = [...ours.cmap.keys()].sort((a, b) => a - b).filter((_, i) => i % 29 === 0);
      const all = [...new Set([...cps, ...FIXED])];
      n += all.length;
      bad.push(...mismatchesOf(file, all));
    }
    expect(n).toBeGreaterThan(3000);
    expect(bad).toEqual([]);
  });

  it('cmap 도 같다 — 우리 표의 모든 항목이 opentype.js 와 같은 글리프 번호', () => {
    for (const file of ALL_FONT_FILES) {
      const { ours, ot } = both(file);
      const otMap: Record<string, number> = ot.tables.cmap.glyphIndexMap;
      let diff = 0;
      for (const [cp, g] of ours.cmap) if (otMap[cp] !== g) diff++;
      let otOnly = 0;
      for (const k of Object.keys(otMap)) if (otMap[k] !== 0 && !ours.cmap.has(Number(k))) otOnly++;
      expect(diff, file).toBe(0);
      expect(otOnly, file).toBe(0);
    }
  });

  it('비교기 음성 대조군 — 다른 글리프·1 유닛 밀림은 잡고, 0.4 유닛은 봐준다', () => {
    const { ours, ot } = both('DoHyeon-Regular.ttf');
    const A = segmentsFromOurPath(glyphPath(ours, '값', ours.unitsPerEm)!);
    const B = segmentsFromOpentype(ot.glyphs.get(ours.cmap.get(cpOf('갑'))!).path.commands);
    expect(A.length === B.length && A.every((c, i) => contourEq(c, B[i]!))).toBe(false);
    const plus1 = A.map((c) => c.map((s) => ({ ...s, x: s.x + 1 })));
    expect(plus1.every((c, i) => contourEq(c, A[i]!))).toBe(false);
    const plus04 = A.map((c) => c.map((s) => ({ ...s, x: s.x + 0.4 })));
    expect(plus04.every((c, i) => contourEq(c, A[i]!))).toBe(true);
  });
});

// ── 2. 복합 글리프 ────────────────────────────────────────────────────────

describe('복합 글리프', () => {
  it('번들 폰트의 복합 글리프는 «오프셋만»과 «xy배율» 뿐 — 점 매칭·2×2·OVERLAP 은 없다', () => {
    // 복합 글리프가 있는 5파일을 전수로 훑는다(값이 바뀌면 아래 손제작 검사만으로는 부족해진다)
    const seen = { composite: 0, xyScale: 0, scale: 0, pointMatch: 0, twoByTwo: 0, overlap: 0, depth: 0 };
    for (const file of ['GothicA1-Regular.ttf', 'GothicA1-Black.ttf', 'NanumPenScript-Regular.ttf', 'NanumMyeongjo-Regular.ttf', 'NanumMyeongjo-ExtraBold.ttf']) {
      const { ours } = both(file);
      for (const gid of new Set(ours.cmap.values())) {
        const f = glyfFacts(ours, gid);
        if (!f.composite) continue;
        seen.composite++;
        if (f.xyScale) seen.xyScale++;
        if (f.scale) seen.scale++;
        if (f.pointMatch) seen.pointMatch++;
        if (f.twoByTwo) seen.twoByTwo++;
        if (f.overlapCompound) seen.overlap++;
        seen.depth = Math.max(seen.depth, f.depth);
      }
    }
    expect(seen.composite).toBeGreaterThan(1000);
    expect(seen.xyScale).toBeGreaterThan(0);
    expect({ scale: seen.scale, pointMatch: seen.pointMatch, twoByTwo: seen.twoByTwo, overlap: seen.overlap }).toEqual({ scale: 0, pointMatch: 0, twoByTwo: 0, overlap: 0 });
    expect(seen.depth).toBe(1);
  });

  it('오프셋만 있는 복합 (실제: 나눔명조·나눔펜 「갂」, Gothic A1 「À」)', () => {
    const cps = ['갂', '갃', '갅', 'À', 'Ĳ'].map(cpOf);
    for (const file of ['NanumMyeongjo-Regular.ttf', 'NanumPenScript-Regular.ttf', 'GothicA1-Regular.ttf']) {
      const { ours } = both(file);
      const has = cps.filter((cp) => ours.cmap.has(cp));
      expect(has.some((cp) => glyfFacts(ours, ours.cmap.get(cp)!).composite), file).toBe(true);
      expect(mismatchesOf(file, has)).toEqual([]);
    }
  });

  it('xy 배율 (실제: Gothic A1 「Ǩ」「Ⅳ」「℡」)', () => {
    for (const file of ['GothicA1-Regular.ttf', 'GothicA1-Black.ttf']) {
      const { ours } = both(file);
      const cps = ['Ǩ', 'Ⅳ', '℡', 'Ӟ', 'Ṿ'].map(cpOf);
      for (const cp of cps) expect(glyfFacts(ours, ours.cmap.get(cp)!).xyScale, `${file} U+${cp.toString(16)}`).toBe(true);
      expect(mismatchesOf(file, cps)).toEqual([]);
    }
  });

  it('배율 하나 (손제작: 삼각형을 0.5 배로)', () => {
    const bytes = buildMiniTtf({
      glyphs: [NOTDEF, { kind: 'simple', contours: TRIANGLE }, { kind: 'composite', components: [{ gid: 1, xy: true, args: [10, 20], scale: 0.5 }] }],
      cmap: new Map([[0x41, 1], [0x42, 2]]),
      locaShort: false,
    });
    expect(miniParity(bytes, [0x41, 0x42])).toEqual([]);
    const ours = parseTtf(bytes)!;
    // 0.5 배 뒤 (10,20) 이동: (0,0)→(10,20) (100,0)→(60,20) (0,200)→(10,120); y 는 뒤집힌다
    expect(glyphPath(ours, 'B', 1000)).toBe('M10,-20 L60,-20 L10,-120 L10,-20 Z');
  });

  it('2×2 변환 — 비대각 성분(회전·기울임)까지 (손제작: 90° 회전)', () => {
    // [a b; c d] = [0 1; -1 0]: x' = a·x + c·y = -y, y' = b·x + d·y = x
    const bytes = buildMiniTtf({
      glyphs: [NOTDEF, { kind: 'simple', contours: TRIANGLE }, { kind: 'composite', components: [{ gid: 1, xy: true, args: [0, 0], scale: [0, 1, -1, 0] }] }],
      cmap: new Map([[0x41, 1], [0x42, 2]]),
      locaShort: false,
    });
    expect(miniParity(bytes, [0x41, 0x42])).toEqual([]);
    const ours = parseTtf(bytes)!;
    // (0,0)→(0,0) (100,0)→(0,100) (0,200)→(-200,0); y 뒤집힘
    expect(glyphPath(ours, 'B', 1000)).toBe('M0,0 L0,-100 L-200,0 L0,0 Z');
  });

  it('점 매칭 (ARGS_ARE_XY_VALUES 미설정) — 자식의 점을 부모의 점 위에 포갠다 (손제작)', () => {
    // 첫 구성요소: 삼각형을 (300,300) 으로. 둘째: 삼각형의 2번 점(0,200)을 첫 구성요소의 1번 점(400,300) 에 맞춘다
    const bytes = buildMiniTtf({
      glyphs: [
        NOTDEF,
        { kind: 'simple', contours: TRIANGLE },
        { kind: 'composite', components: [{ gid: 1, xy: true, args: [300, 300] }, { gid: 1, xy: false, args: [1, 2] }] },
        // 점 매칭 + 배율 0.5: 배율을 먼저 적용한 뒤 맞춘다
        { kind: 'composite', components: [{ gid: 1, xy: true, args: [0, 0] }, { gid: 1, xy: false, args: [2, 0], scale: 0.5 }] },
      ],
      cmap: new Map([[0x41, 1], [0x42, 2], [0x43, 3]]),
      locaShort: false,
    });
    expect(miniParity(bytes, [0x41, 0x42, 0x43])).toEqual([]);
    const ours = parseTtf(bytes)!;
    // 둘째 삼각형은 (400,100) 만큼 이동: (0,200)+(400,100) = (400,300) ✓
    expect(glyphPath(ours, 'B', 1000)).toBe('M300,-300 L400,-300 L300,-500 L300,-300 Z M400,-100 L500,-100 L400,-300 L400,-100 Z');
    // 0.5 배 삼각형의 0번 점(0,0)을 부모 2번 점(0,200) 에: 이동 (0,200)
    expect(glyphPath(ours, 'C', 1000)).toBe('M0,0 L100,0 L0,-200 L0,0 Z M0,-200 L50,-200 L0,-300 L0,-200 Z');
  });

  it('OVERLAP_COMPOUND(0x400) 은 모양에 영향이 없다 (손제작)', () => {
    const mk = (overlap: boolean) =>
      buildMiniTtf({
        glyphs: [NOTDEF, { kind: 'simple', contours: TRIANGLE }, { kind: 'composite', components: [{ gid: 1, xy: true, args: [5, 5], overlap }, { gid: 1, xy: true, args: [500, 0], overlap }] }],
        cmap: new Map([[0x41, 1], [0x42, 2]]),
        locaShort: false,
      });
    const a = mk(false);
    const b = mk(true);
    expect(miniParity(b, [0x42])).toEqual([]);
    expect(glyphPath(parseTtf(b)!, 'B', 1000)).toBe(glyphPath(parseTtf(a)!, 'B', 1000));
  });
});

// ── 3. cmap 형식 4 ────────────────────────────────────────────────────────

describe('cmap 형식 4', () => {
  it('Noto Sans KR 의 (3,10) 형식 12 를 가리면 (3,1) 형식 4 로 읽는다 — idRangeOffset 구간 254개, BMP 전부 일치', () => {
    const { ot, bytes } = both('NotoSansKR-VF.ttf');
    // 사본에서 (3,10) 항목의 platform 을 바꿔 우리 파서가 (3,1) 을 고르게 한다
    const copy = bytes.slice(0);
    const v = new DataView(copy);
    let cmapOff = 0;
    const nt = v.getUint16(4);
    for (let i = 0; i < nt; i++) {
      const p = 12 + i * 16;
      if (String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3)) === 'cmap') cmapOff = v.getUint32(p + 8);
    }
    const n = v.getUint16(cmapOff + 2);
    let patched = 0;
    for (let i = 0; i < n; i++) {
      const p = cmapOff + 4 + i * 8;
      if (v.getUint16(p) === 3 && v.getUint16(p + 2) === 10) {
        v.setUint16(p, 7);
        patched++;
      }
    }
    expect(patched).toBe(1);
    const ours4 = parseTtf(copy)!;
    const otMap: Record<string, number> = ot.tables.cmap.glyphIndexMap;
    const bmp = Object.keys(otMap).map(Number).filter((cp) => cp <= 0xffff && otMap[cp] !== 0);
    expect(bmp.length).toBeGreaterThan(10000);
    const wrong = bmp.filter((cp) => ours4.cmap.get(cp) !== otMap[cp]);
    expect(wrong.slice(0, 10)).toEqual([]);
    const extra = [...ours4.cmap.keys()].filter((cp) => cp > 0xffff || otMap[cp] !== ours4.cmap.get(cp));
    expect(extra.slice(0, 10)).toEqual([]);
  });

  it('13개 폰트가 실제로 형식 4 를 쓰고 그중 10개에 idRangeOffset≠0 구간이 있다 (Gothic A1 ×2·송명은 delta 만; 정적 Noto 2개는 glyphIdArray 를 쓴다)', () => {
    let withArray = 0;
    for (const file of ALL_FONT_FILES) {
      if (file === 'NotoSansKR-VF.ttf') continue;
      const v = new DataView(loadFontBytes(file));
      let cmapOff = 0;
      const nt = v.getUint16(4);
      for (let i = 0; i < nt; i++) {
        const p = 12 + i * 16;
        if (String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3)) === 'cmap') cmapOff = v.getUint32(p + 8);
      }
      const n = v.getUint16(cmapOff + 2);
      let f4 = false;
      let nz = 0;
      for (let i = 0; i < n; i++) {
        const p = cmapOff + 4 + i * 8;
        if (v.getUint16(p) !== 3 || v.getUint16(p + 2) !== 1) continue;
        const off = cmapOff + v.getUint32(p + 4);
        if (v.getUint16(off) !== 4) continue;
        f4 = true;
        const segX2 = v.getUint16(off + 6);
        const rangeBase = off + 16 + segX2 * 3;
        for (let s = 0; s < segX2 / 2; s++) if (v.getUint16(rangeBase + s * 2) !== 0) nz++;
      }
      expect(f4, file).toBe(true);
      if (nz > 0) withArray++;
    }
    expect(withArray).toBe(10); // 번들 8 + drawStroke 윤곽선용 정적 Noto Regular/Bold (W8 F8 #8)
  });

  it('glyphIdArray 가 파일 끝에 닿는 마지막 구간 (손제작: cmap 을 맨 뒤에, 모든 구간을 배열 경로로)', () => {
    const cmap = new Map<number, number>([[0x41, 1], [0x42, 2], [0x43, 3], [0xac00, 3], [0xac01, 1], [0xfffd, 2]]);
    const bytes = buildMiniTtf({
      glyphs: [NOTDEF, { kind: 'simple', contours: TRIANGLE }, { kind: 'simple', contours: [TRIANGLE[0]!.map((p) => ({ ...p, x: p.x + 300 }))] }, { kind: 'composite', components: [{ gid: 1, xy: true, args: [0, 0] }, { gid: 2, xy: true, args: [0, 0] }] }],
      cmap,
      locaShort: false,
      cmapViaGlyphIdArray: true,
      cmapLast: true,
    });
    const { ours, ot } = parseBothBytes(bytes, 'mini-cmap');
    expect([...ours.cmap].sort((a, b) => a[0] - b[0])).toEqual([...cmap].sort((a, b) => a[0] - b[0]));
    const otMap: Record<string, number> = ot.tables.cmap.glyphIndexMap;
    for (const [cp, g] of cmap) expect(otMap[cp], `U+${cp.toString(16)}`).toBe(g);
    expect(miniParity(bytes, [...cmap.keys()])).toEqual([]);
  });
});

// ── 4. loca ───────────────────────────────────────────────────────────────

describe('loca short / long', () => {
  it('14파일은 전부 long — short 는 실제 데이터로는 못 본다', () => {
    for (const file of ALL_FONT_FILES) expect(locaFormat(loadFontBytes(file)), file).toBe(1);
  });

  it('같은 glyf 를 short loca 로 싸도 long 과, 원본 폰트와, opentype.js 와 같은 경로 (손제작: 도현 「값」「한」「A」)', () => {
    const { ours: real } = both('DoHyeon-Regular.ttf');
    const chars = ['값', '한', 'A'];
    const glyphs = [NOTDEF, ...chars.map((ch) => ({ kind: 'raw' as const, bytes: rawGlyphBytes(real, real.cmap.get(cpOf(ch))!) }))];
    const cmap = new Map(chars.map((ch, i) => [cpOf(ch), i + 1]));
    for (const locaShort of [true, false]) {
      const bytes = buildMiniTtf({ glyphs, cmap, locaShort, unitsPerEm: real.unitsPerEm });
      expect(locaFormat(bytes)).toBe(locaShort ? 0 : 1);
      const mini = parseTtf(bytes)!;
      for (const ch of chars) expect(glyphPath(mini, ch, 100), `${ch} short=${locaShort}`).toBe(glyphPath(real, ch, 100));
      expect(miniParity(bytes, [...cmap.keys()])).toEqual([]);
    }
  });
});

// ── 5. 곡선점 ─────────────────────────────────────────────────────────────

describe('2차 베지어 곡선점', () => {
  it('곡선점이 연달아 오면 가운데가 암시적 통과점 (실제: 14파일의 「$」「%」「&」「0」)', () => {
    for (const file of ALL_FONT_FILES) {
      const { ours } = both(file);
      const cps = ['$', '%', '&', '0', '8', 'S'].map(cpOf).filter((cp) => ours.cmap.has(cp));
      const withRun = cps.filter((cp) => glyfFacts(ours, ours.cmap.get(cp)!).consecutiveOff);
      expect(withRun.length, file).toBeGreaterThan(0);
      expect(mismatchesOf(file, cps)).toEqual([]);
      // 우리 경로에 Q 가 연달아 나오는 자리가 실제로 있다
      const d = glyphPath(ours, String.fromCodePoint(withRun[0]!), ours.unitsPerEm)!;
      expect(/Q[^MLQZ]*Q/.test(d), file).toBe(true);
    }
  });

  it('첫 점이 곡선점인 윤곽선 — 번들 폰트엔 없어 손제작; 시작은 첫 통과점', () => {
    // 오프·온·오프·온 … : 둥근 마름모
    const contour: MiniPoint[] = [
      { x: 0, y: 100, on: false },
      { x: 100, y: 200, on: true },
      { x: 200, y: 100, on: false },
      { x: 100, y: 0, on: true },
    ];
    const bytes = buildMiniTtf({ glyphs: [NOTDEF, { kind: 'simple', contours: [contour] }], cmap: new Map([[0x41, 1]]), locaShort: false });
    expect(miniParity(bytes, [0x41])).toEqual([]);
    expect(glyphPath(parseTtf(bytes)!, 'A', 1000)).toBe('M100,-200 Q200,-100 100,0 Q0,-100 100,-200 Z');
  });

  it('통과점이 하나도 없는 윤곽선 — 손제작; 시작은 마지막·첫 점의 가운데', () => {
    const contour: MiniPoint[] = [
      { x: 0, y: 0, on: false },
      { x: 200, y: 0, on: false },
      { x: 200, y: 200, on: false },
      { x: 0, y: 200, on: false },
    ];
    const bytes = buildMiniTtf({ glyphs: [NOTDEF, { kind: 'simple', contours: [contour] }], cmap: new Map([[0x41, 1]]), locaShort: false });
    expect(miniParity(bytes, [0x41])).toEqual([]);
    expect(glyphPath(parseTtf(bytes)!, 'A', 1000)).toBe('M0,-100 Q0,0 100,0 Q200,0 200,-100 Q200,-200 100,-200 Q0,-200 0,-100 Z');
  });

  it('번들 폰트엔 첫 점이 곡선점이거나 전부 곡선점인 윤곽선이 없다 (있게 되면 위 손제작만으로는 부족)', () => {
    for (const file of ['DoHyeon-Regular.ttf', 'Gaegu-Regular.ttf', 'NanumPenScript-Regular.ttf', 'NotoSansKR-VF.ttf']) {
      const { ours } = both(file);
      let firstOff = 0;
      let allOff = 0;
      for (const gid of new Set(ours.cmap.values())) {
        const f = glyfFacts(ours, gid);
        if (f.firstOff) firstOff++;
        if (f.allOff) allOff++;
      }
      expect({ file, firstOff, allOff }).toEqual({ file, firstOff: 0, allOff: 0 });
    }
  });
});

// ── 6. 가변 폰트 ──────────────────────────────────────────────────────────

describe('가변 폰트 (Noto Sans KR VF) — gvar 를 읽지 않는다', () => {
  it('fvar 기본값은 wght=100(Thin) 이고, 파서는 그 기본 마스터의 윤곽선을 준다 — 굵게여도 같은 윤곽선', () => {
    const { ours, bytes } = both('NotoSansKR-VF.ttf');
    const v = new DataView(bytes);
    const nt = v.getUint16(4);
    let def = -1;
    let hasGvar = false;
    for (let i = 0; i < nt; i++) {
      const p = 12 + i * 16;
      const tag = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
      if (tag === 'gvar') hasGvar = true;
      if (tag === 'fvar') {
        const off = v.getUint32(p + 8);
        const q = off + v.getUint16(off + 4);
        expect(String.fromCharCode(v.getUint8(q), v.getUint8(q + 1), v.getUint8(q + 2), v.getUint8(q + 3))).toBe('wght');
        def = v.getInt32(q + 8) / 65536;
      }
    }
    expect(hasGvar).toBe(true);
    expect(def).toBe(100);
    // «굵게» 를 켜도 같은 파일(VF) → 같은(Thin) 윤곽선. 브라우저는 700 으로 그린다 — 여기가 어긋나는 지점이다.
    const regular = fontFileFor({ fontFamily: "'Noto Sans KR', sans-serif", fontSize: 100, color: '#fff', align: 'left' });
    const bold = fontFileFor({ fontFamily: "'Noto Sans KR', sans-serif", fontSize: 100, color: '#fff', align: 'left', bold: true });
    expect(regular).toBe('NotoSansKR-VF.ttf');
    expect(bold).toBe('NotoSansKR-VF.ttf');
    // 「한」 의 세로 기둥 굵기: Thin 마스터라 33 유닛(1000 upem). Regular 라면 두 배가 넘는다.
    const d = glyphPath(ours, '한', ours.unitsPerEm)!;
    expect(d.startsWith('M701,-815 L734,-815 L734,-151 L701,-151')).toBe(true);
  });
});
