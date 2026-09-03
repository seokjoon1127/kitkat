// 자작 TrueType 파서(glyph-path.ts) ↔ opentype.js 대조 도구 (#7 검증).
//
// opentype.js 는 **검증용**(루트 devDependency)이다 — 렌더러 번들·런타임에는 들어가지 않는다.
// 이 파일은 테스트(glyph-path-parity.test.ts)와 전수 비교 스크립트(scripts/glyph-parity-check.mts)가
// 같이 쓴다. *.test.ts 가 아니므로 vitest 가 직접 돌리지는 않는다.
//
// 비교 방법: 두 쪽 경로를 «윤곽선별 선분 목록»(L 또는 Q)으로 바꿔 **순환 회전을 허용해** 맞춘다.
// 시작점 고르는 규칙이 서로 달라서다 — 우리는 «첫 통과점», opentype.js 는 «마지막 점이 통과점이면
// 그것». 같은 도형이면 회전만 다르다. 길이 0 인 L(닫는 점을 다시 찍는 것)은 양쪽 다 버린다.
// 좌표 오차 허용은 0.5 폰트 단위(우리 경로는 소수 둘째 자리로 반올림된다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { glyphPath, parseTtf, type TtfFont } from '../src/composition/glyph-path.js';

// opentype.js 2.0 은 타입 선언을 싣지 않는다 — 여기서 쓰는 만큼만 적는다
export type OtCmd = { type: 'M' | 'L' | 'Q' | 'C' | 'Z'; x: number; y: number; x1: number; y1: number };
export type OtFont = {
  glyphs: { get(gid: number): { path: { commands: OtCmd[] } } };
  tables: Record<string, any>;
};

export const FONT_DIR = path.resolve(fileURLToPath(new URL('../../../media/fonts', import.meta.url)));

export const ALL_FONT_FILES = [
  'NotoSansKR-VF.ttf',
  // drawStroke 윤곽선용 정적 인스턴스 (W8 F8 #8) — 화면에는 안 쓰이지만 파서가 읽으므로 대조한다
  'NotoSansKR-Regular.ttf',
  'NotoSansKR-Bold.ttf',
  'GothicA1-Regular.ttf',
  'GothicA1-Black.ttf',
  'BlackHanSans-Regular.ttf',
  'DoHyeon-Regular.ttf',
  'Jua-Regular.ttf',
  'Gaegu-Regular.ttf',
  'Gaegu-Bold.ttf',
  'NanumPenScript-Regular.ttf',
  'SongMyung-Regular.ttf',
  'NanumMyeongjo-Regular.ttf',
  'NanumMyeongjo-ExtraBold.ttf',
] as const;

export function loadFontBytes(file: string): ArrayBuffer {
  const b = fs.readFileSync(path.join(FONT_DIR, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export type Seg = { t: 'L' | 'Q'; cx: number; cy: number; x: number; y: number };
export type Contour = Seg[];

/** 우리 경로 문자열(M/L/Q/Z, 폰트 단위·y 뒤집힘) → 윤곽선별 선분. */
export function segmentsFromOurPath(d: string): Contour[] {
  const out: Contour[] = [];
  let cur: Contour | null = null;
  let cx = 0;
  let cy = 0;
  const re = /([MLQZ])([^MLQZ]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const nums = m[2]!.trim().length ? m[2]!.trim().split(/[\s,]+/).map(Number) : [];
    switch (m[1]) {
      case 'M':
        cur = [];
        out.push(cur);
        cx = nums[0]!;
        cy = nums[1]!;
        break;
      case 'L':
        pushSeg(cur!, { t: 'L', cx: 0, cy: 0, x: nums[0]!, y: nums[1]! }, cx, cy);
        cx = nums[0]!;
        cy = nums[1]!;
        break;
      case 'Q':
        pushSeg(cur!, { t: 'Q', cx: nums[0]!, cy: nums[1]!, x: nums[2]!, y: nums[3]! }, cx, cy);
        cx = nums[2]!;
        cy = nums[3]!;
        break;
      case 'Z':
        break;
    }
  }
  return out;
}

/** opentype.js 의 path.commands(폰트 단위, y 안 뒤집힘) → 같은 꼴. y 를 뒤집어 우리와 맞춘다. */
export function segmentsFromOpentype(cmds: OtCmd[]): Contour[] {
  const out: Contour[] = [];
  let cur: Contour | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const c of cmds) {
    if (c.type === 'M') {
      cur = [];
      out.push(cur);
      cx = sx = c.x;
      cy = sy = -c.y;
    } else if (c.type === 'L') {
      pushSeg(cur!, { t: 'L', cx: 0, cy: 0, x: c.x, y: -c.y }, cx, cy);
      cx = c.x;
      cy = -c.y;
    } else if (c.type === 'Q') {
      pushSeg(cur!, { t: 'Q', cx: c.x1, cy: -c.y1, x: c.x, y: -c.y }, cx, cy);
      cx = c.x;
      cy = -c.y;
    } else if (c.type === 'C') {
      // TrueType glyf 에는 3차 곡선이 없다 — 나오면 비교가 안 되는 것이므로 표시만 한다
      pushSeg(cur!, { t: 'Q', cx: Number.NaN, cy: Number.NaN, x: c.x, y: -c.y }, cx, cy);
      cx = c.x;
      cy = -c.y;
    } else if (c.type === 'Z') {
      // opentype.js 는 closePath 전에 시작점으로 lineTo 를 이미 넣는다(길이 0 → 버려짐). 혹시 안 넣었으면 보탠다.
      if (cur && (Math.abs(cx - sx) > 1e-9 || Math.abs(cy - sy) > 1e-9)) {
        pushSeg(cur, { t: 'L', cx: 0, cy: 0, x: sx, y: sy }, cx, cy);
        cx = sx;
        cy = sy;
      }
    }
  }
  return out;
}

function pushSeg(c: Contour, s: Seg, fromX: number, fromY: number): void {
  if (s.t === 'L' && Math.abs(s.x - fromX) < 1e-9 && Math.abs(s.y - fromY) < 1e-9) return; // 길이 0
  c.push(s);
}

const TOL = 0.5;

function segEq(a: Seg, b: Seg): boolean {
  if (a.t !== b.t) return false;
  if (Math.abs(a.x - b.x) > TOL || Math.abs(a.y - b.y) > TOL) return false;
  if (a.t === 'Q' && (Math.abs(a.cx - b.cx) > TOL || Math.abs(a.cy - b.cy) > TOL)) return false;
  return true;
}

/** 회전을 허용해 두 윤곽선이 같은지. */
export function contourEq(a: Contour, b: Contour): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  if (n === 0) return true;
  for (let r = 0; r < n; r++) {
    if (!segEq(a[0]!, b[r]!)) continue;
    let ok = true;
    for (let i = 1; i < n && ok; i++) ok = segEq(a[i]!, b[(r + i) % n]!);
    if (ok) return true;
  }
  return false;
}

export type Mismatch = {
  cp: number;
  gid: number;
  /** 어떤 종류로 어긋났나 */
  kind: 'ours-null' | 'ot-empty' | 'ot-throw' | 'contours' | 'segments' | 'geometry';
  detail: string;
};

/** 코드포인트 하나 비교. 일치하면 null. */
export function compareGlyph(
  ours: TtfFont,
  ot: OtFont,
  cp: number,
): Mismatch | null {
  const gid = ours.cmap.get(cp);
  if (gid === undefined) return null;
  const d = glyphPath(ours, String.fromCodePoint(cp), ours.unitsPerEm);
  let otCmds: OtCmd[];
  try {
    otCmds = ot.glyphs.get(gid).path.commands;
  } catch (e) {
    return { cp, gid, kind: 'ot-throw', detail: String((e as Error).message) };
  }
  const B = segmentsFromOpentype(otCmds).filter((c) => c.length > 0);
  if (d === null) {
    return B.length === 0 ? null : { cp, gid, kind: 'ours-null', detail: `opentype ${B.length} contours` };
  }
  const A = segmentsFromOurPath(d).filter((c) => c.length > 0);
  if (B.length === 0) return { cp, gid, kind: 'ot-empty', detail: `ours ${A.length} contours` };
  if (A.length !== B.length) return { cp, gid, kind: 'contours', detail: `ours ${A.length} vs opentype ${B.length}` };
  const segA = A.reduce((s, c) => s + c.length, 0);
  const segB = B.reduce((s, c) => s + c.length, 0);
  if (segA !== segB) return { cp, gid, kind: 'segments', detail: `ours ${segA} vs opentype ${segB}` };
  // 윤곽선 순서는 양쪽 다 glyf 순서 그대로다 — 인덱스끼리 맞춘다
  for (let i = 0; i < A.length; i++) {
    if (!contourEq(A[i]!, B[i]!)) return { cp, gid, kind: 'geometry', detail: `contour #${i} differs` };
  }
  return null;
}

// ── glyf 원시 플래그 훑기 — «어떤 특수 경우가 어느 글리프에 있나» 고르기용 ────────────

export type GlyfFacts = {
  composite: boolean;
  /** 복합: 구성요소 플래그들의 OR */
  compFlags: number;
  /** 복합: 점 매칭(ARGS_ARE_XY_VALUES 미설정) 구성요소가 하나라도 있나 */
  pointMatch: boolean;
  /** 복합: 배율(8) / xy배율(0x40) / 2×2(0x80) 구성요소 존재 */
  scale: boolean;
  xyScale: boolean;
  twoByTwo: boolean;
  /** 복합: 2×2 인데 비대각 성분이 0 이 아닌 것 */
  twoByTwoOffDiag: boolean;
  overlapCompound: boolean;
  depth: number;
  /** 단순: 첫 점이 곡선점(오프커브)인 윤곽선이 있나 */
  firstOff: boolean;
  /** 단순: 곡선점이 연달아 있는 윤곽선이 있나 (암시적 통과점) */
  consecutiveOff: boolean;
  /** 단순: 통과점이 하나도 없는 윤곽선이 있나 */
  allOff: boolean;
};

export function glyfFacts(font: TtfFont, gid: number, depth = 0): GlyfFacts {
  const f: GlyfFacts = {
    composite: false,
    compFlags: 0,
    pointMatch: false,
    scale: false,
    xyScale: false,
    twoByTwo: false,
    twoByTwoOffDiag: false,
    overlapCompound: false,
    depth,
    firstOff: false,
    consecutiveOff: false,
    allOff: false,
  };
  const start = font.loca[gid]!;
  const end = font.loca[gid + 1]!;
  if (end <= start) return f;
  const g = font.glyf;
  const n = g.getInt16(start);
  if (n < 0) {
    f.composite = true;
    let p = start + 10;
    for (;;) {
      const flags = g.getUint16(p);
      const child = g.getUint16(p + 2);
      p += 4;
      f.compFlags |= flags;
      if (!(flags & 2)) f.pointMatch = true;
      if (flags & 0x400) f.overlapCompound = true;
      p += flags & 1 ? 4 : 2;
      if (flags & 8) {
        f.scale = true;
        p += 2;
      } else if (flags & 0x40) {
        f.xyScale = true;
        p += 4;
      } else if (flags & 0x80) {
        f.twoByTwo = true;
        if (g.getInt16(p + 2) !== 0 || g.getInt16(p + 4) !== 0) f.twoByTwoOffDiag = true;
        p += 8;
      }
      const sub = glyfFacts(font, child, depth + 1);
      f.depth = Math.max(f.depth, sub.depth);
      f.pointMatch ||= sub.pointMatch;
      f.scale ||= sub.scale;
      f.xyScale ||= sub.xyScale;
      f.twoByTwo ||= sub.twoByTwo;
      f.twoByTwoOffDiag ||= sub.twoByTwoOffDiag;
      f.firstOff ||= sub.firstOff;
      f.consecutiveOff ||= sub.consecutiveOff;
      f.allOff ||= sub.allOff;
      if (!(flags & 0x20)) break;
    }
    return f;
  }
  const endPts: number[] = [];
  let p = start + 10;
  for (let i = 0; i < n; i++) {
    endPts.push(g.getUint16(p));
    p += 2;
  }
  const numPts = n === 0 ? 0 : endPts[endPts.length - 1]! + 1;
  const instrLen = g.getUint16(p);
  p += 2 + instrLen;
  const flags = new Uint8Array(numPts);
  for (let i = 0; i < numPts; ) {
    const fl = g.getUint8(p++);
    flags[i++] = fl;
    if (fl & 8) {
      let rep = g.getUint8(p++);
      while (rep-- > 0 && i < numPts) flags[i++] = fl;
    }
  }
  let s = 0;
  for (const e of endPts) {
    const on: boolean[] = [];
    for (let i = s; i <= e; i++) on.push((flags[i]! & 1) !== 0);
    s = e + 1;
    if (on.length === 0) continue;
    if (!on[0]) f.firstOff = true;
    if (!on.some(Boolean)) f.allOff = true;
    for (let i = 0; i < on.length; i++) if (!on[i] && !on[(i + 1) % on.length]) f.consecutiveOff = true;
  }
  return f;
}

/** head.indexToLocFormat (0 = short, 1 = long). */
export function locaFormat(bytes: ArrayBuffer): number {
  const view = new DataView(bytes);
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    let tag = '';
    for (let k = 0; k < 4; k++) tag += String.fromCharCode(view.getUint8(p + k));
    if (tag === 'head') return view.getInt16(view.getUint32(p + 8) + 50);
  }
  return -1;
}

export function parseBoth(file: string): { ours: TtfFont; ot: OtFont; bytes: ArrayBuffer } {
  const bytes = loadFontBytes(file);
  return { ...parseBothBytes(bytes, file), bytes };
}

export function parseBothBytes(bytes: ArrayBuffer, label = 'bytes'): { ours: TtfFont; ot: OtFont } {
  const ours = parseTtf(bytes);
  if (!ours) throw new Error(`parseTtf 실패: ${label}`);
  const ot = opentype.parse(bytes) as OtFont;
  return { ours, ot };
}

// ── 손으로 만든 최소 TTF ──────────────────────────────────────────────────────
// 번들 폰트에 **없는** 경우(점 매칭·2×2·OVERLAP_COMPOUND·오프커브 시작·short loca)를
// 검사하려면 그런 glyf 를 직접 써야 한다. 표는 head/maxp/hhea/hmtx/cmap(형식 4)/loca/glyf.
// 만든 바이트를 우리 파서와 opentype.js 양쪽에 넣어 대조한다.

export type MiniPoint = { x: number; y: number; on: boolean };
export type MiniComponent = {
  gid: number;
  /** ARGS_ARE_XY_VALUES: true 면 args 가 (dx,dy), false 면 (부모 점 번호, 자식 점 번호) */
  xy: boolean;
  args: [number, number];
  /** 없음 | 배율 하나 | (x배율, y배율) | 2×2 (a, b, c, d) */
  scale?: number | [number, number] | [number, number, number, number];
  overlap?: boolean;
};
export type MiniGlyph =
  | { kind: 'simple'; contours: MiniPoint[][] }
  | { kind: 'composite'; components: MiniComponent[] }
  /** 실제 폰트의 glyf 레코드를 그대로 복사한 것 (단순 글리프만 — 구성요소 번호를 옮기지 않는다) */
  | { kind: 'raw'; bytes: Uint8Array };

function u16(a: number[], v: number): void {
  a.push((v >>> 8) & 0xff, v & 0xff);
}
function i16(a: number[], v: number): void {
  u16(a, v < 0 ? v + 0x10000 : v);
}
function u32(a: number[], v: number): void {
  a.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
function f2dot14(a: number[], v: number): void {
  i16(a, Math.round(v * 16384));
}

function encodeGlyph(gl: MiniGlyph): number[] {
  if (gl.kind === 'raw') return [...gl.bytes];
  const out: number[] = [];
  if (gl.kind === 'simple') {
    const pts = gl.contours.flat();
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    i16(out, gl.contours.length);
    i16(out, Math.min(...xs, 0));
    i16(out, Math.min(...ys, 0));
    i16(out, Math.max(...xs, 0));
    i16(out, Math.max(...ys, 0));
    let e = -1;
    for (const c of gl.contours) {
      e += c.length;
      u16(out, e);
    }
    u16(out, 0); // instructions 없음
    for (const p of pts) out.push(p.on ? 1 : 0); // 플래그: x·y 모두 int16 델타
    let px = 0;
    for (const p of pts) {
      i16(out, p.x - px);
      px = p.x;
    }
    let py = 0;
    for (const p of pts) {
      i16(out, p.y - py);
      py = p.y;
    }
    return out;
  }
  i16(out, -1);
  i16(out, 0);
  i16(out, 0);
  i16(out, 0);
  i16(out, 0);
  gl.components.forEach((c, i) => {
    let flags = 1; // ARG_1_AND_2_ARE_WORDS
    if (c.xy) flags |= 2;
    if (typeof c.scale === 'number') flags |= 8;
    else if (Array.isArray(c.scale) && c.scale.length === 2) flags |= 0x40;
    else if (Array.isArray(c.scale) && c.scale.length === 4) flags |= 0x80;
    if (i < gl.components.length - 1) flags |= 0x20;
    if (c.overlap) flags |= 0x400;
    u16(out, flags);
    u16(out, c.gid);
    if (c.xy) {
      i16(out, c.args[0]);
      i16(out, c.args[1]);
    } else {
      u16(out, c.args[0]);
      u16(out, c.args[1]);
    }
    if (typeof c.scale === 'number') f2dot14(out, c.scale);
    else if (Array.isArray(c.scale)) for (const v of c.scale) f2dot14(out, v);
  });
  return out;
}

/** cmap 형식 4. `viaGlyphIdArray` 면 모든 구간을 idRangeOffset(glyphIdArray) 경로로 쓴다. */
function encodeCmap4(map: Map<number, number>, viaGlyphIdArray: boolean): number[] {
  const cps = [...map.keys()].sort((a, b) => a - b);
  type Seg = { start: number; end: number; delta: number; useArray: boolean };
  const segs: Seg[] = [];
  for (const cp of cps) {
    const last = segs[segs.length - 1];
    const g = map.get(cp)!;
    if (last && cp === last.end + 1 && (viaGlyphIdArray || (g - cp) === last.delta)) last.end = cp;
    else segs.push({ start: cp, end: cp, delta: (g - cp) & 0xffff, useArray: viaGlyphIdArray });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1, useArray: false });
  const n = segs.length;
  const body: number[] = [];
  for (const s of segs) u16(body, s.end);
  u16(body, 0);
  for (const s of segs) u16(body, s.start);
  for (const s of segs) u16(body, s.useArray ? 0 : s.delta);
  const arr: number[] = [];
  segs.forEach((s, i) => {
    if (!s.useArray) return u16(body, 0);
    // 이 idRangeOffset 칸에서 glyphIdArray 항목까지의 바이트 거리
    u16(body, (n - i) * 2 + arr.length); // arr 는 이미 바이트 단위
    for (let cp = s.start; cp <= s.end; cp++) u16(arr, map.get(cp)!);
  });
  body.push(...arr);
  const head: number[] = [];
  u16(head, 4);
  u16(head, 14 + body.length);
  u16(head, 0);
  u16(head, n * 2);
  u16(head, 0);
  u16(head, 0);
  u16(head, 0);
  const sub = [...head, ...body];
  const table: number[] = [];
  u16(table, 0);
  u16(table, 1);
  u16(table, 3);
  u16(table, 1);
  u32(table, 12);
  return [...table, ...sub];
}

export function buildMiniTtf(opts: {
  glyphs: MiniGlyph[];
  cmap: Map<number, number>;
  locaShort: boolean;
  unitsPerEm?: number;
  cmapViaGlyphIdArray?: boolean;
  /** cmap 을 파일 맨 뒤에 둔다 — glyphIdArray 가 파일 끝에 닿는 경계를 만든다 */
  cmapLast?: boolean;
}): ArrayBuffer {
  const upem = opts.unitsPerEm ?? 1000;
  const glyf: number[] = [];
  const loca: number[] = [];
  for (const gl of opts.glyphs) {
    loca.push(glyf.length);
    glyf.push(...encodeGlyph(gl));
    while (glyf.length % 4) glyf.push(0);
  }
  loca.push(glyf.length);
  const locaBytes: number[] = [];
  for (const o of loca) {
    if (opts.locaShort) u16(locaBytes, o / 2);
    else u32(locaBytes, o);
  }
  const head: number[] = [];
  u32(head, 0x00010000);
  u32(head, 0);
  u32(head, 0);
  u32(head, 0x5f0f3cf5);
  u16(head, 0);
  u16(head, upem);
  for (let i = 0; i < 16; i++) head.push(0); // created·modified
  for (let i = 0; i < 4; i++) i16(head, 0); // bbox
  u16(head, 0);
  u16(head, 8);
  i16(head, 2);
  i16(head, opts.locaShort ? 0 : 1);
  i16(head, 0);
  const maxp: number[] = [];
  u32(maxp, 0x00010000);
  u16(maxp, opts.glyphs.length);
  for (let i = 0; i < 13; i++) u16(maxp, 0);
  const hhea: number[] = [];
  u32(hhea, 0x00010000);
  i16(hhea, upem);
  i16(hhea, 0);
  for (let i = 0; i < 12; i++) i16(hhea, 0);
  u16(hhea, opts.glyphs.length);
  const hmtx: number[] = [];
  for (let i = 0; i < opts.glyphs.length; i++) {
    u16(hmtx, upem);
    i16(hmtx, 0);
  }
  const cmap = encodeCmap4(opts.cmap, opts.cmapViaGlyphIdArray ?? false);
  const name: number[] = [];
  u16(name, 0);
  u16(name, 0);
  u16(name, 6); // opentype.js 는 name·post 표가 없으면 파싱을 거부한다 — 빈 표를 넣는다
  const post: number[] = [];
  u32(post, 0x00030000); // 3.0 = 글리프 이름 없음
  for (let i = 0; i < 7; i++) u32(post, 0);

  const tables: [string, number[]][] = [
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['loca', locaBytes],
    ['maxp', maxp],
    ['name', name],
    ['post', post],
  ];
  if (opts.cmapLast) tables.push(['cmap', cmap]);
  else tables.unshift(['cmap', cmap]);
  const dir: number[] = [];
  u32(dir, 0x00010000);
  u16(dir, tables.length);
  u16(dir, 0);
  u16(dir, 0);
  u16(dir, 0);
  let offset = 12 + tables.length * 16;
  const bodies: number[] = [];
  for (const [tag, bytes] of tables) {
    for (const ch of tag) dir.push(ch.charCodeAt(0));
    u32(dir, 0);
    u32(dir, offset + bodies.length);
    u32(dir, bytes.length);
    bodies.push(...bytes);
    // 마지막 표가 cmap 이고 «파일 끝 경계»를 원하면 채우지 않는다
    if (!(opts.cmapLast && tag === 'cmap')) while (bodies.length % 4) bodies.push(0);
  }
  return new Uint8Array([...dir, ...bodies]).buffer;
}

/** 실제 폰트에서 단순 글리프 레코드 바이트를 복사한다 (복합이면 throw). */
export function rawGlyphBytes(font: TtfFont, gid: number): Uint8Array {
  const s = font.loca[gid]!;
  const e = font.loca[gid + 1]!;
  if (font.glyf.getInt16(s) < 0) throw new Error(`gid ${gid} 는 복합 글리프`);
  return new Uint8Array(font.glyf.buffer, font.glyf.byteOffset + s, e - s);
}
