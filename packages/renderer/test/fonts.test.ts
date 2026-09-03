import { describe, expect, it } from 'vitest';
import { FONT_FAMILIES } from '@kitkat/schema';
import type { ProjectDoc, TextClip } from '@kitkat/schema';
import {
  BUNDLED_FONTS,
  ensureFontsLoaded,
  fontFaceCss,
  fontLoadSpecs,
  fontUrl,
  usedFontFamilies,
} from '../src/composition/fonts.js';

const textClip = (fontFamily: string, id: string): TextClip => ({
  id, kind: 'text', start: 0, duration: 1000, text: '가나다',
  style: { fontFamily, fontSize: 60, color: '#ffffff', align: 'center' },
});

const docWith = (...families: string[]): ProjectDoc => ({
  schemaVersion: 1, id: 'd', name: 'd', revision: 0,
  settings: { width: 720, height: 720, fps: 30, background: { kind: 'color', color: '#000000' } },
  assets: {},
  tracks: [{
    id: 't', kind: 'text', name: '자막',
    clips: families.map((f, i) => textClip(f, `c${i}`)),
  }],
});

describe('번들 폰트 (T2)', () => {
  it('스키마 FONT_FAMILIES 의 모든 폰트가 실제 @font-face 를 가진다 (system 제외)', () => {
    const declared = new Set(BUNDLED_FONTS.map((f) => f.family));
    for (const f of FONT_FAMILIES) {
      if (f.id === 'system') continue;
      // css 스택의 첫 항목이 번들된 family 여야 한다
      const first = f.css.split(',')[0]!.trim().replace(/^'|'$/g, '');
      expect(declared, `${f.id} 의 폰트 ${first} 가 BUNDLED_FONTS 에 없다`).toContain(first);
    }
  });

  it('fontUrl 은 mediaBase 뒤에 /fonts/ 를 붙인다 (끝 슬래시 유무 무관)', () => {
    expect(fontUrl('http://127.0.0.1:5000', 'Jua-Regular.ttf')).toBe('http://127.0.0.1:5000/fonts/Jua-Regular.ttf');
    expect(fontUrl('/media/', 'Jua-Regular.ttf')).toBe('/media/fonts/Jua-Regular.ttf');
    expect(fontUrl('', 'Jua-Regular.ttf')).toBe('/fonts/Jua-Regular.ttf');
  });

  it('fontFaceCss 는 파일마다 @font-face 하나씩, URL 이 mediaBase 기준이다', () => {
    const css = fontFaceCss('/media');
    expect(css.match(/@font-face/g)).toHaveLength(BUNDLED_FONTS.length);
    for (const f of BUNDLED_FONTS) expect(css).toContain(`url('/media/fonts/${f.file}')`);
    // 미리보기(/media)와 렌더(임시 서버)가 같은 파일 이름을 쓴다
    expect(fontFaceCss('http://127.0.0.1:1234')).toContain("url('http://127.0.0.1:1234/fonts/NotoSansKR-VF.ttf')");
  });

  it('usedFontFamilies 는 텍스트 클립의 fontFamily 만 중복 없이 모은다', () => {
    const a = FONT_FAMILIES[2]!.css;
    const b = FONT_FAMILIES[4]!.css;
    expect(usedFontFamilies(docWith(a, b, a)).sort()).toEqual([a, b].sort());
    expect(usedFontFamilies(docWith())).toEqual([]);
  });

  it('fontLoadSpecs 는 실제로 쓰이는 폰트만 고른다 (35MB 를 매번 받지 않는다)', () => {
    const jua = FONT_FAMILIES.find((f) => f.id === 'jua')!.css;
    const specs = fontLoadSpecs([jua]);
    expect(specs).toEqual(['400 100px "Jua"']);
    expect(fontLoadSpecs([])).toEqual([]);
    // 시스템 기본만 쓰면 받을 게 없다
    expect(fontLoadSpecs([FONT_FAMILIES.find((f) => f.id === 'system')!.css])).toEqual([]);
  });

  it('weight 범위 폰트는 양 끝 굵기를 모두 요청한다 (굵게가 Black 파일을 고르게)', () => {
    const gothic = FONT_FAMILIES.find((f) => f.id === 'gothica1')!.css;
    expect(fontLoadSpecs([gothic]).sort()).toEqual(
      ['400 100px "Gothic A1"', '700 100px "Gothic A1"', '900 100px "Gothic A1"'].sort(),
    );
  });

  it('document.fonts 가 없어도(노드) 던지지 않는다 — 폰트가 없어서 렌더가 죽으면 안 된다', async () => {
    await expect(ensureFontsLoaded(docWith(FONT_FAMILIES[0]!.css))).resolves.toBeUndefined();
  });

  it('document.fonts.load 가 실패해도(폰트 404) 던지지 않는다', async () => {
    const g = globalThis as { document?: unknown };
    const prev = g.document;
    g.document = { fonts: { load: () => Promise.reject(new Error('404')), ready: Promise.resolve() } };
    try {
      await expect(ensureFontsLoaded(docWith(FONT_FAMILIES[0]!.css))).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete g.document;
      else g.document = prev;
    }
  });
});
