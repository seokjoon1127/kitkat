// 글자 → 윤곽선 경로 (W8 F8 `drawStroke`).
//
// **왜 폰트 파일을 직접 읽나:** 브라우저는 글리프 외곽선을 노출하지 않는다. `<text>` 에는
// `getTotalLength()` 가 없어 「획이 얼마나 그려졌나」를 잴 수가 없다(계획 08 §4 의 a안이
// 「대충 됨」인 이유). 그래서 `media/fonts/*.ttf` 를 **우리가 파싱해서** path 를 만들고,
// 그 path 위에서 `@remotion/paths` 의 `getSubpaths`·`getLength`·`evolvePath` 로 진행률을 계산한다.
//
// 계획서는 이 자리에 opentype.js(+1 의존성)를 권했다. 번들 폰트 12개가 **전부 TrueType `glyf`**
// (CFF 없음)라 필요한 것은 `head/maxp/cmap/loca/glyf` 다섯 표뿐이고, 그만큼만 읽으면
// 의존성 없이 끝난다 — 그리고 노드에서도 그대로 돌아가 **테스트가 브라우저 없이 된다.**
// (CFF/OTF 를 번들에 넣게 되면 그때는 opentype.js 가 맞다. 지금은 읽을 대상이 없다.)
//
// **검증(#7):** opentype.js 를 루트 devDependency 로만 두고 대조한다 — 번들 12파일 × cmap 전수
// 104,268 글리프에서 불일치 0 (`npx tsx scripts/glyph-parity-check.mts`, 표본·특수 경우는
// `test/glyph-path-parity.test.ts`). 번들 폰트에 없는 경우(점 매칭·2×2·전부 곡선점·short loca)는
// 손으로 만든 glyf 로 opentype.js 와 맞췄다.
// **아는 한계:** 가변 폰트(Noto Sans KR VF)의 `gvar` 를 읽지 않는다 — fvar 기본값이 wght=100 이라
// 여기서 나오는 윤곽선은 Thin 마스터다(「한」 세로 기둥 33 유닛/1000). 브라우저는 400·700 으로 그린다.
import type { TextStyle } from '@kitkat/schema';
import { BUNDLED_FONTS } from './fonts.js';

// ── TrueType 최소 파서 ────────────────────────────────────────────────────

export type TtfFont = {
  unitsPerEm: number;
  numGlyphs: number;
  /** 코드포인트 → 글리프 번호 */
  cmap: Map<number, number>;
  /** 글리프 i 의 glyf 안 오프셋 (numGlyphs+1 개) */
  loca: Uint32Array;
  glyf: DataView;
};

type Contour = { x: number; y: number; on: boolean }[];

function tableDirectory(view: DataView): Map<string, { offset: number; length: number }> {
  const out = new Map<string, { offset: number; length: number }>();
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    let tag = '';
    for (let k = 0; k < 4; k++) tag += String.fromCharCode(view.getUint8(p + k));
    out.set(tag, { offset: view.getUint32(p + 8), length: view.getUint32(p + 12) });
  }
  return out;
}

/** cmap 서브테이블 하나를 읽는다. 형식 4(BMP)와 12(전체)만 — 번들 폰트가 쓰는 것이 그 둘이다. */
function readCmapSubtable(view: DataView, base: number, out: Map<number, number>): void {
  const format = view.getUint16(base);
  if (format === 4) {
    const segX2 = view.getUint16(base + 6);
    const seg = segX2 / 2;
    const endBase = base + 14;
    const startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    for (let s = 0; s < seg; s++) {
      const end = view.getUint16(endBase + s * 2);
      const start = view.getUint16(startBase + s * 2);
      if (start > end) continue;
      const delta = view.getInt16(deltaBase + s * 2);
      const rangeOffset = view.getUint16(rangeBase + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g: number;
        if (rangeOffset === 0) g = (c + delta) & 0xffff;
        else {
          const gi = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
          if (gi + 1 >= view.byteLength) continue;
          g = view.getUint16(gi);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g !== 0 && !out.has(c)) out.set(c, g);
      }
    }
    return;
  }
  if (format === 12) {
    const nGroups = view.getUint32(base + 12);
    for (let i = 0; i < nGroups; i++) {
      const p = base + 16 + i * 12;
      const start = view.getUint32(p);
      const end = view.getUint32(p + 4);
      const startGid = view.getUint32(p + 8);
      // 통째로 아주 큰 구간이 오는 폰트가 있어 상한을 둔다(한글·한자 전 영역이면 충분하다)
      const last = Math.min(end, start + 70000);
      for (let c = start; c <= last; c++) if (!out.has(c)) out.set(c, startGid + (c - start));
    }
  }
}

/** ttf 바이트 → 필요한 표만 읽은 폰트. TrueType(glyf)이 아니면 null. */
export function parseTtf(bytes: ArrayBuffer): TtfFont | null {
  try {
    const view = new DataView(bytes);
    if (view.byteLength < 12) return null;
    const tables = tableDirectory(view);
    const head = tables.get('head');
    const maxp = tables.get('maxp');
    const loca = tables.get('loca');
    const glyf = tables.get('glyf');
    const cmapT = tables.get('cmap');
    if (!head || !maxp || !loca || !glyf || !cmapT) return null; // CFF(OTTO) 등 — 여기서 다루지 않는다

    const unitsPerEm = view.getUint16(head.offset + 18);
    const indexToLocFormat = view.getInt16(head.offset + 50);
    const numGlyphs = view.getUint16(maxp.offset + 4);

    const locaArr = new Uint32Array(numGlyphs + 1);
    for (let i = 0; i <= numGlyphs; i++) {
      locaArr[i] =
        indexToLocFormat === 0
          ? view.getUint16(loca.offset + i * 2) * 2
          : view.getUint32(loca.offset + i * 4);
    }

    // cmap — (3,10) 형식 12 를 먼저, 없으면 (3,1) 형식 4, 그다음 아무거나
    const cmap = new Map<number, number>();
    const n = view.getUint16(cmapT.offset + 2);
    const subs: { platform: number; encoding: number; offset: number }[] = [];
    for (let i = 0; i < n; i++) {
      const p = cmapT.offset + 4 + i * 8;
      subs.push({
        platform: view.getUint16(p),
        encoding: view.getUint16(p + 2),
        offset: cmapT.offset + view.getUint32(p + 4),
      });
    }
    const pick =
      subs.find((s) => s.platform === 3 && s.encoding === 10) ??
      subs.find((s) => s.platform === 3 && s.encoding === 1) ??
      subs[0];
    if (pick) readCmapSubtable(view, pick.offset, cmap);
    if (cmap.size === 0) return null;

    return {
      unitsPerEm: unitsPerEm > 0 ? unitsPerEm : 1000,
      numGlyphs,
      cmap,
      loca: locaArr,
      glyf: new DataView(bytes, glyf.offset, Math.min(glyf.length, view.byteLength - glyf.offset)),
    };
  } catch {
    return null;
  }
}

/** 글리프 하나의 윤곽선(폰트 단위). 복합 글리프는 구성요소를 옮겨 붙인다. */
function glyphContours(font: TtfFont, gid: number, depth = 0): Contour[] {
  if (gid < 0 || gid >= font.numGlyphs || depth > 4) return [];
  const start = font.loca[gid]!;
  const end = font.loca[gid + 1]!;
  if (end <= start || end > font.glyf.byteLength) return [];
  const g = font.glyf;
  const numberOfContours = g.getInt16(start);

  if (numberOfContours < 0) {
    // 복합 글리프 — 구성요소를 재귀로 읽어 변환(배율·2×2)하고 옮겨 붙인다.
    // 옮기는 양은 두 가지 방식: ARGS_ARE_XY_VALUES(2) 면 인자가 곧 (dx,dy),
    // 아니면 인자는 «점 번호» 둘 — 지금까지 모은 점 arg1 위에 구성요소의 점 arg2 를 포갠다.
    const out: Contour[] = [];
    let p = start + 10;
    for (;;) {
      const flags = g.getUint16(p);
      const glyphIndex = g.getUint16(p + 2);
      p += 4;
      const words = (flags & 1) !== 0;
      const xy = (flags & 2) !== 0;
      // 오프셋은 부호 있음, 점 번호는 부호 없음
      const arg1 = words ? (xy ? g.getInt16(p) : g.getUint16(p)) : xy ? g.getInt8(p) : g.getUint8(p);
      const arg2 = words
        ? xy ? g.getInt16(p + 2) : g.getUint16(p + 2)
        : xy ? g.getInt8(p + 1) : g.getUint8(p + 1);
      p += words ? 4 : 2;
      // 변환 [a b; c d] (F2Dot14): x' = a·x + c·y, y' = b·x + d·y — 표 안 순서는 a, b, c, d
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & 8) {
        a = d = g.getInt16(p) / 16384;
        p += 2;
      } else if (flags & 0x40) {
        a = g.getInt16(p) / 16384;
        d = g.getInt16(p + 2) / 16384;
        p += 4;
      } else if (flags & 0x80) {
        a = g.getInt16(p) / 16384;
        b = g.getInt16(p + 2) / 16384;
        c = g.getInt16(p + 4) / 16384;
        d = g.getInt16(p + 6) / 16384;
        p += 8;
      }
      const tx = (pt: { x: number; y: number }) => ({ x: a * pt.x + c * pt.y, y: b * pt.x + d * pt.y });
      const sub = glyphContours(font, glyphIndex, depth + 1);
      let dx = 0;
      let dy = 0;
      if (xy) {
        dx = arg1;
        dy = arg2;
      } else {
        const parent = out.flat()[arg1];
        const child = sub.flat()[arg2];
        if (parent && child) {
          const t = tx(child);
          dx = parent.x - t.x;
          dy = parent.y - t.y;
        }
      }
      for (const cnt of sub) {
        out.push(
          cnt.map((pt) => {
            const t = tx(pt);
            return { x: t.x + dx, y: t.y + dy, on: pt.on };
          }),
        );
      }
      if (!(flags & 0x20)) break;
      if (p >= end) break;
    }
    return out;
  }

  const endPts: number[] = [];
  let p = start + 10;
  for (let i = 0; i < numberOfContours; i++) {
    endPts.push(g.getUint16(p));
    p += 2;
  }
  const numPts = numberOfContours === 0 ? 0 : endPts[endPts.length - 1]! + 1;
  const instrLen = g.getUint16(p);
  p += 2 + instrLen;

  const flags = new Uint8Array(numPts);
  for (let i = 0; i < numPts; ) {
    const f = g.getUint8(p++);
    flags[i++] = f;
    if (f & 8) {
      let rep = g.getUint8(p++);
      while (rep-- > 0 && i < numPts) flags[i++] = f;
    }
  }
  const xs = new Int16Array(numPts);
  let x = 0;
  for (let i = 0; i < numPts; i++) {
    const f = flags[i]!;
    if (f & 2) {
      const d = g.getUint8(p++);
      x += f & 16 ? d : -d;
    } else if (!(f & 16)) {
      x += g.getInt16(p);
      p += 2;
    }
    xs[i] = x;
  }
  const ys = new Int16Array(numPts);
  let y = 0;
  for (let i = 0; i < numPts; i++) {
    const f = flags[i]!;
    if (f & 4) {
      const d = g.getUint8(p++);
      y += f & 32 ? d : -d;
    } else if (!(f & 32)) {
      y += g.getInt16(p);
      p += 2;
    }
    ys[i] = y;
  }

  const out: Contour[] = [];
  let s = 0;
  for (const e of endPts) {
    const c: Contour = [];
    for (let i = s; i <= e && i < numPts; i++) {
      c.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 1) !== 0 });
    }
    if (c.length > 0) out.push(c);
    s = e + 1;
  }
  return out;
}

const r2 = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * 윤곽선 → SVG `d`. **y 는 뒤집는다**(폰트는 위가 +, SVG 는 아래가 +) — 원점이 곧 «기준선»이다.
 * TrueType 은 2차 베지어라 곡선점이 연달아 오면 그 사이의 «가운데 점»이 암시적 통과점이다.
 */
function contoursToPath(contours: Contour[], scale: number): string {
  const parts: string[] = [];
  for (const raw of contours) {
    if (raw.length === 0) continue;
    const P = raw.map((p) => ({ x: p.x * scale, y: -p.y * scale, on: p.on }));
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    });
    // 시작점: 통과점이 있으면 그것, 전부 곡선점이면 마지막·첫 점의 가운데.
    // 아래 루프는 시작점 «다음» 점부터 n 개를 돈다 — 통과점 시작이면 마지막에 시작점으로 돌아오고,
    // 전부 곡선점이면(startIdx = -1) 0..n-1 을 다 거친 뒤 루프 뒤의 Q 가 시작점으로 닫는다.
    const startIdx = P.findIndex((p) => p.on);
    const startPt = startIdx < 0 ? mid(P[P.length - 1]!, P[0]!) : P[startIdx]!;
    parts.push(`M${r2(startPt.x)},${r2(startPt.y)}`);
    let cur = startPt;
    let ctrl: { x: number; y: number } | null = null;
    for (let k = 1; k <= P.length; k++) {
      const pt = P[(startIdx + k) % P.length]!;
      if (pt.on) {
        if (ctrl) {
          parts.push(`Q${r2(ctrl.x)},${r2(ctrl.y)} ${r2(pt.x)},${r2(pt.y)}`);
          ctrl = null;
        } else {
          parts.push(`L${r2(pt.x)},${r2(pt.y)}`);
        }
        cur = pt;
      } else {
        if (ctrl) {
          const m = mid(ctrl, pt);
          parts.push(`Q${r2(ctrl.x)},${r2(ctrl.y)} ${r2(m.x)},${r2(m.y)}`);
          cur = m;
        }
        ctrl = pt;
      }
    }
    if (ctrl) parts.push(`Q${r2(ctrl.x)},${r2(ctrl.y)} ${r2(startPt.x)},${r2(startPt.y)}`);
    void cur;
    parts.push('Z');
  }
  return parts.join(' ');
}

/** 글자 한 개의 윤곽선 경로. 원점 = 글리프 왼쪽·기준선. 없는 글자면 null. */
export function glyphPath(font: TtfFont, ch: string, sizePx: number): string | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  const gid = font.cmap.get(cp);
  if (gid === undefined) return null;
  const contours = glyphContours(font, gid);
  if (contours.length === 0) return null;
  const d = contoursToPath(contours, sizePx / font.unitsPerEm);
  return d.length > 0 ? d : null;
}

// ── 폰트 파일 찾기 · 불러오기 ─────────────────────────────────────────────

/**
 * drawStroke 의 «윤곽선 전용» 정적 파일 (W8 F8 #8).
 *
 * `NotoSansKR-VF.ttf` 는 가변 폰트이고 **fvar 기본 인스턴스가 wght=100(Thin)** 이다. 이 파서는
 * `gvar` 를 읽지 않으므로 glyf 만 보면 Thin 윤곽선이 나온다(「한」 세로 기둥 33유닛/1000) —
 * 그런데 화면은 400·700 으로 글자를 그리니 «획은 가늘다가 t=1 에서 Regular 로 툭 바뀐다».
 * gvar 를 구현하는 길은 **대조할 기준이 없다**(opentype.js 도 gvar 를 못 읽는다). 그래서
 * 화면·렌더 글자는 지금처럼 VF 를 쓰고, **획의 경로 추출만 구글 폰트의 정적 인스턴스**
 * (같은 v39 릴리스, OFL)에서 한다. weight >= 600 → Bold, 아니면 Regular.
 * 정적 파일이 아직 없으면(`node scripts/prewarm.mjs fonts` 전) VF 로 폴백하고 콘솔에 한 줄 남긴다.
 * `@font-face` 는 바꾸지 않는다 — 이 파일들은 글자를 «그리는» 데 쓰이지 않는다.
 */
export const OUTLINE_FONT_FILES: readonly {
  family: string;
  /** @font-face 가 쓰는(화면에 그리는) 파일 — 폴백 대상 */
  vf: string;
  regular: string;
  bold: string;
}[] = [
  { family: 'Noto Sans KR', vf: 'NotoSansKR-VF.ttf', regular: 'NotoSansKR-Regular.ttf', bold: 'NotoSansKR-Bold.ttf' },
];

/** 이 스타일이 «윤곽선용으로 원하는» 정적 파일. 매핑에 없는 패밀리면 null. */
export function outlineStaticFileFor(style: TextStyle): { want: string; vf: string } | null {
  const m = OUTLINE_FONT_FILES.find((o) => style.fontFamily.includes(o.family));
  if (!m) return null;
  const weight = style.bold ? 700 : 400;
  return { want: weight >= 600 ? m.bold : m.regular, vf: m.vf };
}

/** 정적 파일을 못 얻어 VF 로 대신 쓰기로 «이미 정한» 것들 (want → vf). */
const outlineFallback = new Map<string, string>();
const warned = new Set<string>();

/**
 * 윤곽선을 실제로 뽑을 파일. 정적 인스턴스가 이미 읽혀 있으면 그것, 폴백이 정해졌으면 VF,
 * 아직 모르면 정적 파일 이름(→ glyphOutline 이 불러오기를 건다). 매핑 밖 패밀리는 @font-face 파일.
 */
export function outlineFileFor(style: TextStyle): string | null {
  const st = outlineStaticFileFor(style);
  if (!st) return fontFileFor(style);
  if (fonts.get(st.want)) return st.want;
  return outlineFallback.get(st.want) ?? st.want;
}

/** `TextStyle` 이 실제로 쓰는 번들 폰트 파일(@font-face 기준). 번들 폰트가 아니면 null. */
export function fontFileFor(style: TextStyle): string | null {
  const want = style.bold ? 700 : 400;
  let best: { file: string; score: number } | null = null;
  for (const f of BUNDLED_FONTS) {
    if (!style.fontFamily.includes(f.family)) continue;
    const ws = f.weight.split(' ').map(Number);
    const lo = ws[0] ?? 400;
    const hi = ws[ws.length - 1] ?? lo;
    // 요청 굵기가 범위 안이면 0점(최고), 아니면 거리
    const score = want >= lo && want <= hi ? 0 : Math.min(Math.abs(want - lo), Math.abs(want - hi));
    if (!best || score < best.score) best = { file: f.file, score };
  }
  return best ? best.file : null;
}

const fonts = new Map<string, TtfFont | null>();
const loading = new Map<string, Promise<Loaded>>();

/** 테스트·노드용 — 파일 바이트를 직접 꽂는다(브라우저가 없어도 같은 코드를 검사할 수 있다). */
export function registerFontBytes(file: string, bytes: ArrayBuffer): TtfFont | null {
  const f = parseTtf(bytes);
  fonts.set(file, f);
  return f;
}

/** 캐시된 폰트 (없으면 undefined = 아직 안 읽음, null = 못 읽음). */
export function loadedFont(file: string): TtfFont | null | undefined {
  return fonts.get(file);
}

/**
 * 문서에 주입된 `@font-face` 규칙에서 그 파일의 URL 을 찾는다.
 *
 * 렌더러는 미디어를 **임시 정적 서버**(다른 포트)에서 내려받으므로 상대 경로로는 못 찾는다.
 * `fontFaceCss(mediaBase)` 가 이미 그 절대 URL 을 문서에 넣어 두었으니 거기서 읽는다 —
 * 이러면 `TimelineVideo` 에 `mediaBase` 를 하나 더 실어 나르지 않아도 되고,
 * 빠른 미리보기(styles.css 의 `/media/fonts/...`)에서도 **같은 코드**가 동작한다.
 */
function fontUrlFromDocument(file: string): string | null {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return null;
  const re = new RegExp(`url\\(['"]?([^'")]*${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})['"]?\\)`);
  try {
    for (const sheet of Array.from(doc.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        rules = null; // 다른 출처의 스타일시트는 읽을 수 없다 — 아래 <style> 훑기로 넘어간다
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const src = (rule as CSSFontFaceRule).style?.getPropertyValue?.('src');
        const m = src ? re.exec(src) : null;
        if (m) return m[1]!;
      }
    }
  } catch {
    // 무시하고 아래로
  }
  for (const el of Array.from(doc.querySelectorAll('style'))) {
    const m = re.exec(el.textContent ?? '');
    if (m) return m[1]!;
  }
  return null;
}

type Loaded = {
  font: TtfFont | null;
  /**
   * false = **시도조차 못 했다** — `@font-face` 가 아직 문서에 없어 URL 을 못 찾은 것(첫 렌더 도중).
   * 이걸 «실패»로 캐시하면 안 된다: 실제로 겪었다 — 렌더 첫 패스에서 `glyphOutline` 이 불러오기를
   * 걸 때 `<style>` 이 아직 커밋되기 전이라(styleSheets=2) URL 이 null 이었고, 그걸 null 로 캐시해
   * **정적 파일이 있는데도 매번 Thin 으로 폴백**했다. 몇 ms 뒤 게이트(useEffect)가 부르면 찾는다.
   */
  attempted: boolean;
};

/**
 * 폰트 파일을 한 번만 내려받아 파싱한다. 실패해도 throw 하지 않는다(렌더가 멈추면 안 된다).
 * `viaSibling` 을 주면 그 파일의 `@font-face` URL 에서 이름만 바꿔 같은 폴더에서 받는다 —
 * 윤곽선용 정적 파일은 `@font-face` 에 없기 때문이다.
 */
function loadFontFile(file: string, viaSibling?: string): Promise<Loaded> {
  const hit = fonts.get(file);
  if (hit !== undefined) return Promise.resolve({ font: hit, attempted: true });
  const inflight = loading.get(file);
  if (inflight) return inflight;
  let url = fontUrlFromDocument(file);
  if (!url && viaSibling) {
    const sib = fontUrlFromDocument(viaSibling);
    if (sib && sib.endsWith(viaSibling)) url = sib.slice(0, sib.length - viaSibling.length) + file;
  }
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!url || !fetchFn) {
    // 캐시하지 않는다 — 다음 호출(게이트)이 다시 찾는다
    return Promise.resolve({ font: null, attempted: false });
  }
  const p = fetchFn(url)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => (buf ? registerFontBytes(file, buf) : null))
    .catch(() => null)
    .then((f): Loaded => {
      if (!fonts.has(file)) fonts.set(file, null); // 404·파싱 실패 = «시도했고 못 읽었다» — 이건 캐시한다
      loading.delete(file);
      return { font: f ?? fonts.get(file) ?? null, attempted: true };
    });
  loading.set(file, p);
  return p;
}

/** 폰트 파일을 한 번만 내려받아 파싱한다. 실패해도 throw 하지 않는다(렌더가 멈추면 안 된다). */
export function ensureFontFile(file: string, viaSibling?: string): Promise<TtfFont | null> {
  return loadFontFile(file, viaSibling).then((r) => r.font);
}

/**
 * 이 스타일의 «윤곽선용» 폰트를 준비한다. 렌더러는 `delayRender` 로 이걸 기다린다.
 * 정적 인스턴스가 있는 패밀리는 그것을 먼저 받고, 못 받으면(404 = prewarm 전) VF 로 폴백하되
 * **콘솔에 한 줄** 남긴다 — 조용히 가늘게 그리지 않는다.
 */
export async function ensureGlyphFont(style: TextStyle): Promise<TtfFont | null> {
  const st = outlineStaticFileFor(style);
  if (!st) {
    const file = fontFileFor(style);
    return file ? ensureFontFile(file) : null;
  }
  const already = outlineFallback.get(st.want);
  if (already) return ensureFontFile(already);
  const r = await loadFontFile(st.want, st.vf);
  if (r.font) return r.font;
  if (!r.attempted) return null; // @font-face 가 아직 문서에 없다(첫 렌더) — 결정을 미룬다
  outlineFallback.set(st.want, st.vf);
  if (!warned.has(st.want)) {
    warned.add(st.want);
    console.warn(
      `drawStroke: ${st.want} 이 없어 가변 폰트(${st.vf})의 기본 인스턴스 - Thin(wght 100) - 로 획을 그립니다. ` +
        'node scripts/prewarm.mjs fonts 로 정적 파일을 받으세요.',
    );
  }
  return ensureFontFile(st.vf);
}

// ── 글자 → 획 (캐시) ─────────────────────────────────────────────────────

export type GlyphOutline = {
  /** 획 순서대로 나눈 서브패스 */
  subpaths: string[];
  /** 각 서브패스의 길이 */
  lengths: number[];
  total: number;
};

const outlineCache = new Map<string, GlyphOutline | null>();

/**
 * 글자 하나의 «획 순서대로 나뉜» 윤곽선. 폰트가 아직 안 왔으면 null 을 주고
 * **불러오기를 걸어 둔다**(다음 프레임에는 나온다).
 *
 * 한글 「값」 한 글자는 서브패스가 여러 개다 — `getSubpaths` 로 나눠 순서대로 그려야
 * 붓으로 쓰는 것처럼 보인다. 파싱·분할·길이 재기는 **글자당 한 번**만 한다(프레임마다 하면 안 된다).
 */
export function glyphOutline(
  ch: string,
  style: TextStyle,
  sizePx: number,
  paths: {
    getSubpaths: (d: string) => string[];
    getLength: (d: string) => number;
  },
): GlyphOutline | null {
  const file = outlineFileFor(style);
  if (!file) return null;
  const key = `${file}|${ch}|${Math.round(sizePx * 100)}`;
  const hit = outlineCache.get(key);
  if (hit !== undefined) return hit;
  const font = fonts.get(file);
  if (font === undefined) {
    void ensureGlyphFont(style); // 아직 안 읽었다 — 걸어 두고 이번 프레임은 대체 동작
    return null;
  }
  if (font === null) {
    outlineCache.set(key, null);
    return null;
  }
  const d = glyphPath(font, ch, sizePx);
  if (!d) {
    outlineCache.set(key, null);
    return null;
  }
  let value: GlyphOutline | null = null;
  try {
    const subpaths = paths.getSubpaths(d).filter((s) => s.trim().length > 0);
    const lengths = subpaths.map((s) => paths.getLength(s));
    const total = lengths.reduce((a, b) => a + b, 0);
    value = total > 0 ? { subpaths, lengths, total } : null;
  } catch {
    value = null;
  }
  if (outlineCache.size > 4000) outlineCache.clear();
  outlineCache.set(key, value);
  return value;
}

// ── 기둥 폭 (drawStroke 펜 폭의 기준) ────────────────────────────────────
//
// 윤곽선을 «얇은 펜»으로 그리면 속이 빈 테두리가 되고 t=1 에 채움으로 «툭» 튄다(실측: Regular
// 30px 기둥에 12px 펜 → 속 빈 폭 17px, p=0.992↔1 평균 차이 10.45). 펜 폭을 그 폰트·그 굵기의
// **세로 기둥 폭**에 맞추면 윤곽선 양쪽에서 펜 반쪽씩이 만나 기둥이 꽉 찬다.
// 기둥은 「ㅣ」(U+3163, 사각형 윤곽선 하나)의 첫 윤곽선 x 폭으로 잰다 — 없으면 l · I · | 순.

const STEM_PROBES = ['ㅣ', 'l', 'I', '|'];
const stemCache = new WeakMap<TtfFont, number | null>();

/** 세로 기둥 폭 (폰트 유닛). 잴 글자가 없으면 null. */
export function stemWidthUnits(font: TtfFont): number | null {
  const hit = stemCache.get(font);
  if (hit !== undefined) return hit;
  let out: number | null = null;
  for (const ch of STEM_PROBES) {
    const d = glyphPath(font, ch, font.unitsPerEm); // 1em = upem 이라 좌표가 곧 유닛
    if (!d) continue;
    const first = d.split('Z')[0]!;
    const xs = [...first.matchAll(/(-?[\d.]+),/g)].map((m) => Number(m[1]));
    if (xs.length < 2) continue;
    const w = Math.max(...xs) - Math.min(...xs);
    if (w > 0) {
      out = w;
      break;
    }
  }
  stemCache.set(font, out);
  return out;
}

/** 이 스타일이 쓰는 윤곽선 폰트의 기둥 폭(px). 폰트가 아직 안 왔거나 못 재면 null. */
export function glyphStemPx(style: TextStyle, sizePx: number): number | null {
  const file = outlineFileFor(style);
  if (!file) return null;
  const font = fonts.get(file);
  if (!font) return null;
  const u = stemWidthUnits(font);
  return u === null ? null : (u / font.unitsPerEm) * sizePx;
}

/** 테스트용 — 캐시를 비운다. */
export function resetGlyphCache(): void {
  outlineCache.clear();
  fonts.clear();
  loading.clear();
  outlineFallback.clear();
  warned.clear();
}
