// W8 F8 `drawStroke` — 글자 획이 그려지는 효과.
//
// **브라우저 없이 검사한다.** 글리프 윤곽선을 우리가 ttf 에서 직접 읽기 때문에 노드에서
// 번들 폰트를 그대로 넣어 같은 코드를 돌릴 수 있다 — 렌더가 하는 계산과 한 글자도 다르지 않다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { getLength, getSubpaths } from '@remotion/paths';
import type { TextClip, TextStyle } from '@kitkat/schema';
import { TEXT_ANIM_TYPES } from '@kitkat/schema';
import {
  ensureGlyphFont,
  fontFileFor,
  glyphOutline,
  glyphPath,
  glyphStemPx,
  outlineFileFor,
  outlineStaticFileFor,
  parseTtf,
  registerFontBytes,
  resetGlyphCache,
  stemWidthUnits,
} from '../src/composition/glyph-path.js';
import {
  computeTextLayout,
  glyphStrokeAt,
  strokePaint,
  textAnimEasing,
  textAnimUnitOf,
} from '../src/composition/text-layout.js';

const FONT_DIR = path.resolve(
  fileURLToPath(new URL('../../../media/fonts', import.meta.url)),
);

function loadFont(file: string): ArrayBuffer {
  const b = fs.readFileSync(path.join(FONT_DIR, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** 계획 08 §9 가 요구한 「폰트 3종 이상」 — 고딕·명조·손글씨 성격이 다른 것들을 고른다. */
const FONTS = [
  { file: 'DoHyeon-Regular.ttf', family: "'Do Hyeon', sans-serif" },
  { file: 'NanumMyeongjo-Regular.ttf', family: "'Nanum Myeongjo', serif" },
  { file: 'NanumPenScript-Regular.ttf', family: "'Nanum Pen Script', cursive" },
  { file: 'BlackHanSans-Regular.ttf', family: "'Black Han Sans', sans-serif" },
  { file: 'NotoSansKR-VF.ttf', family: "'Noto Sans KR', sans-serif" },
];

const styleOf = (family: string, over: Partial<TextStyle> = {}): TextStyle => ({
  fontFamily: family,
  fontSize: 100,
  color: '#ffffff',
  align: 'center',
  ...over,
});

/** 번들 폰트 전부(정적 Noto 두 파일 포함)를 파서 캐시에 꽂는다 — 캐시를 비운 테스트 뒤에도 다시 부른다. */
function registerAll(): void {
  for (const f of FONTS) registerFontBytes(f.file, loadFont(f.file));
  // 굵게(700)일 때 고르는 파일도 미리 넣어 둔다
  registerFontBytes('GothicA1-Regular.ttf', loadFont('GothicA1-Regular.ttf'));
  registerFontBytes('GothicA1-Black.ttf', loadFont('GothicA1-Black.ttf'));
  // drawStroke 윤곽선용 정적 Noto (W8 F8 #8)
  registerFontBytes('NotoSansKR-Regular.ttf', loadFont('NotoSansKR-Regular.ttf'));
  registerFontBytes('NotoSansKR-Bold.ttf', loadFont('NotoSansKR-Bold.ttf'));
}

beforeAll(registerAll);

// ── 1. 스키마 ────────────────────────────────────────────────────────────

describe('drawStroke 가 목록에 들어왔다', () => {
  it('맨 뒤에 붙었고 앞 20종은 그대로다', () => {
    expect(TEXT_ANIM_TYPES).toHaveLength(21);
    expect(TEXT_ANIM_TYPES[20]).toBe('drawStroke');
    expect(TEXT_ANIM_TYPES.slice(0, 5)).toEqual([
      'fade', 'slideUp', 'popIn', 'typewriter', 'wordHighlight',
    ]);
  });

  it('기본 이징은 linear — 붓이 멈칫거리면 안 된다', () => {
    const f = textAnimEasing({ type: 'drawStroke', duration: 1000 });
    for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(f(t)).toBe(t);
  });

  it("unit:'all' 이어도 쪼개는 단위는 글자다 (모든 글자가 동시에 그려진다)", () => {
    expect(textAnimUnitOf({ type: 'drawStroke', duration: 1000, unit: 'all' })).toBe('char');
    expect(textAnimUnitOf({ type: 'drawStroke', duration: 1000, unit: 'char' })).toBe('char');
  });
});

// ── 2. ttf 읽기 ──────────────────────────────────────────────────────────

describe('번들 폰트에서 글리프 윤곽선을 읽는다', () => {
  it('5종 전부 파싱되고 「값」·「A」의 획이 나온다', () => {
    for (const f of FONTS) {
      const font = parseTtf(loadFont(f.file));
      expect(font, f.file).not.toBeNull();
      expect(font!.unitsPerEm).toBeGreaterThan(0);
      expect(font!.cmap.size).toBeGreaterThan(1000);
      for (const ch of ['값', 'A', '한', '8']) {
        const d = glyphPath(font!, ch, 100);
        expect(d, `${f.file} ${ch}`).toBeTruthy();
        expect(d!.startsWith('M'), `${f.file} ${ch}`).toBe(true);
        // 우리 path 는 M/L/Q/Z 만 쓴다 (TrueType 은 2차 베지어다)
        expect(/^[MLQZ0-9eE ,.+-]+$/.test(d!)).toBe(true);
      }
    }
  });

  it('글리프는 «획(서브패스)» 여러 개로 나뉜다 — 한글은 특히', () => {
    for (const f of FONTS) {
      const d = glyphPath(parseTtf(loadFont(f.file))!, '값', 100)!;
      const subs = getSubpaths(d);
      expect(subs.length, f.file).toBeGreaterThanOrEqual(3);
      const total = subs.map(getLength).reduce((a, b) => a + b, 0);
      expect(total, f.file).toBeGreaterThan(100);
    }
  });

  it('없는 글자는 null (빈 사각형을 그리지 않는다)', () => {
    const font = parseTtf(loadFont('DoHyeon-Regular.ttf'))!;
    expect(glyphPath(font, '\u{10FFFD}', 100)).toBeNull();
  });

  it('크기에 비례한다 — 200px 은 100px 의 정확히 두 배', () => {
    const font = parseTtf(loadFont('DoHyeon-Regular.ttf'))!;
    const a = getSubpaths(glyphPath(font, 'A', 100)!).map(getLength).reduce((x, y) => x + y, 0);
    const b = getSubpaths(glyphPath(font, 'A', 200)!).map(getLength).reduce((x, y) => x + y, 0);
    expect(b / a).toBeCloseTo(2, 2);
  });

  it('굵게면 굵은 파일을 고른다 (모양이 실제로 다르다)', () => {
    const st = styleOf("'Gothic A1', sans-serif");
    expect(fontFileFor(st)).toBe('GothicA1-Regular.ttf');
    expect(fontFileFor({ ...st, bold: true })).toBe('GothicA1-Black.ttf');
    const thin = glyphOutline('한', st, 100, { getSubpaths, getLength })!;
    const thick = glyphOutline('한', { ...st, bold: true }, 100, { getSubpaths, getLength })!;
    expect(thick.total).not.toBeCloseTo(thin.total, 1);
  });

  it('번들 폰트가 아니면 null — 대체 동작으로 넘어간다', () => {
    expect(fontFileFor(styleOf('sans-serif'))).toBeNull();
    expect(glyphOutline('A', styleOf('sans-serif'), 100, { getSubpaths, getLength })).toBeNull();
  });
});

// ── 3. 진행률 → 획 ───────────────────────────────────────────────────────

describe('획이 진행률만큼 그려진다', () => {
  const st = styleOf("'Do Hyeon', sans-serif");

  /** 지금까지 «그려진» 길이 = 각 획의 (전체 길이 − dashoffset). */
  const drawnLength = (p: number, ch = '값', style: TextStyle = st): number => {
    const s = glyphStrokeAt(ch, style, 1, p)!;
    let sum = 0;
    for (const seg of s.segs) {
      const total = Number(seg.dasharray.split(' ')[0]);
      sum += total - seg.dashoffset;
    }
    return sum;
  };

  it('그려진 길이가 진행률에 따라 «단조 증가»한다', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = drawnLength(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = v;
    }
  });

  it('그려진 길이가 진행률 × 전체 길이와 같다 (일정한 속도)', () => {
    const o = glyphOutline('값', st, 100, { getSubpaths, getLength })!;
    for (const p of [0.1, 0.25, 0.5, 0.75, 1]) {
      expect(drawnLength(p)).toBeCloseTo(p * o.total, 3);
    }
  });

  it('p=0 이면 아무 획도 안 그려지고, p=1 이면 전부 그려진다', () => {
    expect(drawnLength(0)).toBeCloseTo(0, 6);
    const o = glyphOutline('값', st, 100, { getSubpaths, getLength })!;
    expect(drawnLength(1)).toBeCloseTo(o.total, 3);
    for (const seg of glyphStrokeAt('값', st, 1, 1)!.segs) expect(seg.dashoffset).toBeCloseTo(0, 9);
  });

  it('획은 «순서대로» 나온다 — 앞 획이 다 그려져야 다음 획이 시작한다', () => {
    const o = glyphOutline('값', st, 100, { getSubpaths, getLength })!;
    const half = glyphStrokeAt('값', st, 1, 0.5)!;
    // 절반이면 앞쪽 획들만 등장한다(전부가 조금씩 그려지는 게 아니다)
    expect(half.segs.length).toBeLessThan(o.subpaths.length);
    expect(half.segs.length).toBeGreaterThan(0);
  });

  it('폰트 5종에서 전부 그려진다 (폰트가 다르면 획도 다르다)', () => {
    const totals = FONTS.map(
      (f) => glyphOutline('값', styleOf(f.family), 100, { getSubpaths, getLength })!.total,
    );
    for (const t of totals) expect(t).toBeGreaterThan(100);
    expect(new Set(totals.map((t) => t.toFixed(1))).size).toBe(FONTS.length); // 전부 다르다
  });
});

// ── 4. 획 색·두께 — 외곽선이 없는 글자 ───────────────────────────────────

describe('외곽선을 안 켠 글자에도 반드시 그려진다 — 펜 폭은 기둥 폭', () => {
  const DH = "'Do Hyeon', sans-serif";
  const stemAt = (fontScale: number): number => glyphStemPx(styleOf(DH), 100 * fontScale)!;

  it('기둥 폭을 「ㅣ」 에서 잰다 — Thin < Regular < Bold', () => {
    const thin = stemWidthUnits(parseTtf(loadFont('NotoSansKR-VF.ttf'))!)!;
    const reg = stemWidthUnits(parseTtf(loadFont('NotoSansKR-Regular.ttf'))!)!;
    const bold = stemWidthUnits(parseTtf(loadFont('NotoSansKR-Bold.ttf'))!)!;
    expect(thin).toBeGreaterThan(0);
    expect(reg).toBeGreaterThan(thin * 1.5);
    expect(bold).toBeGreaterThan(reg);
    for (const f of FONTS) expect(stemWidthUnits(parseTtf(loadFont(f.file))!), f.file).toBeGreaterThan(0);
  });

  it('외곽선이 없으면 «글자 색» 으로, 두께는 기둥 폭(캔버스 배율 반영)', () => {
    const st = styleOf(DH, { color: '#00ff88' });
    expect(strokePaint(st, 1).color).toBe('#00ff88');
    expect(strokePaint(st, 1).width).toBeCloseTo(stemAt(1), 9);
    expect(strokePaint(st, 2).width).toBeCloseTo(stemAt(2), 9);
    // 아주 작은 글자에서도 최소 1px 은 그린다 (0px 이면 아무것도 안 보인다)
    expect(strokePaint(styleOf(DH, { fontSize: 10 }), 0.5).width).toBeGreaterThanOrEqual(1);
  });

  it('외곽선이 있으면 그 색·두께 — 단, 기둥보다 가늘면(속이 빈다) 기둥 폭으로 올린다', () => {
    const thin = styleOf(DH, { strokeColor: '#ff0000', strokeWidth: 2 });
    expect(strokePaint(thin, 1)).toEqual({ color: '#ff0000', width: stemAt(1) });
    const thick = styleOf(DH, { strokeColor: '#ff0000', strokeWidth: 200 });
    expect(strokePaint(thick, 1)).toEqual({ color: '#ff0000', width: 200 });
    expect(strokePaint(thick, 2).width).toBe(400); // 캔버스 배율 반영
  });

  it('외곽선 두께 0 은 «안 켠 것»으로 본다', () => {
    const st = styleOf(DH, { strokeColor: '#ff0000', strokeWidth: 0 });
    expect(strokePaint(st, 1).width).toBeCloseTo(stemAt(1), 9);
  });

  it('기둥을 못 재면(번들 폰트 아님) 글자 크기의 3.5%', () => {
    expect(glyphStemPx(styleOf('sans-serif'), 100)).toBeNull();
    expect(strokePaint(styleOf('sans-serif'), 1).width).toBeCloseTo(3.5, 9);
  });

  it('획은 글리프 윤곽선으로 클립된다 — clipD 는 서브패스 전체다', () => {
    const s = glyphStrokeAt('값', styleOf(DH), 1, 0.5)!;
    const o = glyphOutline('값', styleOf(DH), 100, { getSubpaths, getLength })!;
    expect(s.clipD).toBe(o.subpaths.join(' '));
  });
});

// ── 5. 레이아웃 통합 ─────────────────────────────────────────────────────

function clip(over: Partial<TextClip> = {}): TextClip {
  return {
    id: 'tx1', kind: 'text', start: 0, duration: 3000,
    text: '값한A', style: styleOf("'Do Hyeon', sans-serif"), ...over,
  } as TextClip;
}

describe('computeTextLayout — drawStroke', () => {
  const anim = { type: 'drawStroke', duration: 1000, unit: 'char', staggerMs: 90 } as const;

  it('글자마다 획이 붙고 글자 자신은 투명하다', () => {
    const l = computeTextLayout({ clip: clip({ animationIn: anim }), tMs: 300, canvasW: 1080, canvasH: 1080 });
    const units = l.lines!.flatMap((x) => x.units);
    expect(units.map((u) => u.text)).toEqual(['값', '한', 'A']);
    expect(units[0]!.stroke).toBeTruthy();
    expect(units[0]!.style.color).toBe('transparent');
    expect(units[0]!.style.WebkitTextStroke).toBe('0px transparent');
  });

  it('시차 — 같은 프레임에서 앞 글자가 더 많이 그려져 있다', () => {
    const l = computeTextLayout({ clip: clip({ animationIn: anim }), tMs: 200, canvasW: 1080, canvasH: 1080 });
    const drawn = l.lines!.flatMap((x) => x.units).map((u) =>
      (u.stroke?.segs ?? []).reduce(
        (a, s) => a + (Number(s.dasharray.split(' ')[0]) - s.dashoffset),
        0,
      ),
    );
    expect(drawn[0]!).toBeGreaterThan(drawn[1]!);
    expect(drawn[1]!).toBeGreaterThanOrEqual(drawn[2]!);
  });

  it('**끝나면 획을 걷어내고 원래 글자를 그린다** — 정적 글자와 같은 스타일', () => {
    const anim = { type: 'drawStroke', duration: 500, unit: 'char', staggerMs: 0 } as const;
    const done = computeTextLayout({ clip: clip({ animationIn: anim }), tMs: 500, canvasW: 1080, canvasH: 1080 });
    for (const u of done.lines!.flatMap((x) => x.units)) {
      expect(u.stroke).toBeUndefined();
      expect(u.style.color).toBeUndefined();
      expect(u.style.WebkitTextStroke).toBeUndefined();
      // 남는 것은 스팬을 만드는 두 값뿐이다
      expect(Object.keys(u.style).sort()).toEqual(['display', 'whiteSpace']);
    }
  });

  it('번들 폰트가 아니면 «왼쪽→오른쪽 하드 와이프»로 대신한다 (아무 일도 안 일어나지 않는다)', () => {
    const l = computeTextLayout({
      clip: clip({ style: styleOf('sans-serif'), animationIn: { ...anim } }),
      tMs: 200, canvasW: 1080, canvasH: 1080,
    });
    const u = l.lines!.flatMap((x) => x.units)[0]!;
    expect(u.stroke).toBeUndefined();
    expect(String(u.style.clipPath)).toMatch(/^inset\(0 \d/);
    expect(u.style.color).not.toBe('transparent'); // 글자를 감추지 않는다
  });

  it('fps 가 계산에 안 들어간다 — 같은 tMs 면 같은 결과', () => {
    const c = clip({ animationIn: anim });
    const a = computeTextLayout({ clip: c, tMs: 400, canvasW: 1080, canvasH: 1920 });
    const b = computeTextLayout({ clip: c, tMs: 400, canvasW: 1080, canvasH: 1920 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('캔버스 배율에 비례해 획이 커진다', () => {
    const c = clip({ animationIn: anim });
    const at = (h: number): number => {
      const l = computeTextLayout({ clip: c, tMs: 400, canvasW: 1080, canvasH: h });
      const u = l.lines!.flatMap((x) => x.units)[0]!;
      return u.stroke!.segs.reduce((a, s) => a + Number(s.dasharray.split(' ')[0]), 0);
    };
    expect(at(2160) / at(1080)).toBeCloseTo(2, 1);
  });

  it('공백에는 획을 그리지 않는다', () => {
    const l = computeTextLayout({
      clip: clip({ text: '값 한', animationIn: anim }),
      tMs: 900, canvasW: 1080, canvasH: 1080,
    });
    const units = l.lines!.flatMap((x) => x.units);
    expect(units[1]!.text).toBe(' ');
    expect(units[1]!.stroke).toBeUndefined();
  });
});

// ── 6. Noto Sans KR — 윤곽선은 정적 인스턴스에서 (W8 F8 #8) ─────────────────
//
// `NotoSansKR-VF.ttf` 의 fvar 기본 인스턴스는 wght=100(Thin)이다. 파서가 gvar 를 안 읽으니
// glyf 만 보면 Thin 윤곽선이 나오고, 화면은 400·700 으로 그린다 → 획이 가늘다가 t=1 에서 «툭».
// 그래서 획의 경로만 구글 폰트의 정적 Regular/Bold 인스턴스에서 뽑는다.

const NOTO = "'Noto Sans KR', sans-serif";

/** 「한」 첫 윤곽선(세로 기둥)의 x 폭 — 1000 유닛 기준. 같은 폰트의 인스턴스끼리는 윤곽선 순서가 같다. */
function stemWidth(font: NonNullable<ReturnType<typeof parseTtf>>): number {
  const d = glyphPath(font, '한', 1000)!;
  const first = d.split('Z')[0]!;
  const xs = [...first.matchAll(/[ML](-?[\d.]+),/g)].map((m) => Number(m[1]));
  return Math.max(...xs) - Math.min(...xs);
}

describe('Noto Sans KR — 획은 Thin 마스터가 아니라 정적 Regular/Bold 에서 나온다', () => {
  it('VF 의 「한」 세로 기둥은 33유닛 — 기본 인스턴스가 Thin 인 증거', () => {
    const vf = parseTtf(loadFont('NotoSansKR-VF.ttf'))!;
    expect(stemWidth(vf)).toBe(33);
  });

  it('정적 Regular·Bold 는 훨씬 두껍고 Bold > Regular > Thin', () => {
    const vf = stemWidth(parseTtf(loadFont('NotoSansKR-VF.ttf'))!);
    const reg = stemWidth(parseTtf(loadFont('NotoSansKR-Regular.ttf'))!);
    const bold = stemWidth(parseTtf(loadFont('NotoSansKR-Bold.ttf'))!);
    expect(reg).toBeGreaterThan(vf * 1.5);
    expect(bold).toBeGreaterThan(reg);
  });

  it('굵게가 아니면 Regular, 굵게면 Bold 파일을 고른다 (weight ≥ 600 → Bold)', () => {
    expect(outlineStaticFileFor(styleOf(NOTO))).toEqual({ want: 'NotoSansKR-Regular.ttf', vf: 'NotoSansKR-VF.ttf' });
    expect(outlineStaticFileFor(styleOf(NOTO, { bold: true }))).toEqual({ want: 'NotoSansKR-Bold.ttf', vf: 'NotoSansKR-VF.ttf' });
    // 정적 파일이 읽혀 있으므로 실제로 그것을 쓴다
    expect(outlineFileFor(styleOf(NOTO))).toBe('NotoSansKR-Regular.ttf');
    expect(outlineFileFor(styleOf(NOTO, { bold: true }))).toBe('NotoSansKR-Bold.ttf');
    // 화면(@font-face)은 여전히 VF 다 — 바꾸지 않는다
    expect(fontFileFor(styleOf(NOTO))).toBe('NotoSansKR-VF.ttf');
    expect(fontFileFor(styleOf(NOTO, { bold: true }))).toBe('NotoSansKR-VF.ttf');
  });

  it('다른 패밀리는 매핑이 없다 — 지금처럼 @font-face 파일을 그대로 쓴다', () => {
    expect(outlineStaticFileFor(styleOf("'Do Hyeon', sans-serif"))).toBeNull();
    expect(outlineFileFor(styleOf("'Do Hyeon', sans-serif"))).toBe('DoHyeon-Regular.ttf');
  });

  it('glyphOutline 이 정적 파일을 쓴다 — VF 와 총 길이가 다르고, Bold 는 Regular 와 다르다', () => {
    const reg = glyphOutline('한', styleOf(NOTO), 100, { getSubpaths, getLength })!;
    const bold = glyphOutline('한', styleOf(NOTO, { bold: true }), 100, { getSubpaths, getLength })!;
    const vfD = glyphPath(parseTtf(loadFont('NotoSansKR-VF.ttf'))!, '한', 100)!;
    const vfTotal = getSubpaths(vfD).map(getLength).reduce((x, y) => x + y, 0);
    expect(reg.total).not.toBeCloseTo(vfTotal, 1);
    expect(bold.total).not.toBeCloseTo(reg.total, 1);
  });

  it('정적 파일이 없으면(prewarm 전) VF 로 폴백하고 콘솔에 «한 번만» 남긴다', async () => {
    resetGlyphCache();
    try {
      registerFontBytes('NotoSansKR-VF.ttf', loadFont('NotoSansKR-VF.ttf'));
      // 브라우저에서 404 를 받은 뒤의 상태 = «시도했고 못 읽었다»(null 캐시). 빈 바이트로 같은 상태를 만든다.
      // (노드에는 document 가 없어 URL 을 «아직 못 찾은» 상태만 되는데, 그건 폴백을 정하면 안 되는 경우다 — 아래 테스트)
      registerFontBytes('NotoSansKR-Regular.ttf', new ArrayBuffer(0));
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => {
        warns.push(a.map(String).join(' '));
      };
      try {
        const f1 = await ensureGlyphFont(styleOf(NOTO));
        const f2 = await ensureGlyphFont(styleOf(NOTO));
        expect(f1).not.toBeNull();
        expect(f2).toBe(f1);
      } finally {
        console.warn = orig;
      }
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('NotoSansKR-Regular.ttf');
      expect(warns[0]).toContain('Thin');
      expect(warns[0]).toContain('prewarm');
      // 폴백이 정해졌으니 이후 윤곽선은 VF(Thin) 에서 나온다 — 조용히가 아니라 «알리고» 나서다
      expect(outlineFileFor(styleOf(NOTO))).toBe('NotoSansKR-VF.ttf');
      const o = glyphOutline('한', styleOf(NOTO), 1000, { getSubpaths, getLength })!;
      expect(o).not.toBeNull();
    } finally {
      resetGlyphCache();
      registerAll();
    }
  });

  it('URL 을 «아직» 못 찾은 경우(첫 렌더, @font-face 커밋 전)는 폴백을 정하지 않는다', async () => {
    resetGlyphCache();
    try {
      registerFontBytes('NotoSansKR-VF.ttf', loadFont('NotoSansKR-VF.ttf'));
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => {
        warns.push(a.map(String).join(' '));
      };
      try {
        // 노드에는 document 가 없다 = URL 을 못 찾는다 = 시도조차 못 한 경우
        expect(await ensureGlyphFont(styleOf(NOTO))).toBeNull();
      } finally {
        console.warn = orig;
      }
      expect(warns).toEqual([]);
      // 결정이 안 났으니 여전히 정적 파일을 «원한다» — 나중에 그 파일이 오면 그대로 쓴다
      expect(outlineFileFor(styleOf(NOTO))).toBe('NotoSansKR-Regular.ttf');
      registerFontBytes('NotoSansKR-Regular.ttf', loadFont('NotoSansKR-Regular.ttf'));
      expect((await ensureGlyphFont(styleOf(NOTO)))?.numGlyphs).toBe(24853);
    } finally {
      resetGlyphCache();
      registerAll();
    }
  });
});
