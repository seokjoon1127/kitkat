import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_FAMILY, FONT_FALLBACK, FONT_FAMILIES, validateDoc } from '../src/index.js';
import { createEmptyProject } from '../src/factory.js';

describe('FONT_FAMILIES (T2)', () => {
  it('9종 번들 폰트 + 시스템 기본', () => {
    expect(FONT_FAMILIES).toHaveLength(10);
    expect(FONT_FAMILIES.map((f) => f.id)).toEqual([
      'notosanskr', 'gothica1', 'blackhansans', 'dohyeon', 'jua',
      'gaegu', 'nanumpenscript', 'songmyung', 'nanummyeongjo', 'system',
    ]);
  });

  it('id·name·css 가 전부 비어있지 않고 id 는 유일하다', () => {
    for (const f of FONT_FAMILIES) {
      expect(f.id.length).toBeGreaterThan(0);
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.css.length).toBeGreaterThan(0);
    }
    expect(new Set(FONT_FAMILIES.map((f) => f.id)).size).toBe(FONT_FAMILIES.length);
    expect(new Set(FONT_FAMILIES.map((f) => f.css)).size).toBe(FONT_FAMILIES.length);
  });

  it('모든 css 가 시스템 한글 폰트 폴백으로 끝난다 (폰트 파일이 없어도 한글이 보인다)', () => {
    for (const f of FONT_FAMILIES) expect(f.css.endsWith(FONT_FALLBACK)).toBe(true);
  });

  it('기본 글꼴은 목록의 첫 항목(노토 산스 KR) — 설치 안 된 Pretendard 가 아니다', () => {
    expect(DEFAULT_FONT_FAMILY).toBe(FONT_FAMILIES[0]!.css);
    expect(DEFAULT_FONT_FAMILY).toContain('Noto Sans KR');
    expect(DEFAULT_FONT_FAMILY).not.toContain('Pretendard');
  });

  it('fontFamily 는 여전히 자유 문자열 — 목록 밖 값도 validateDoc 를 통과한다', () => {
    const doc = createEmptyProject({ name: 't' });
    doc.tracks.push({
      id: 'tt', kind: 'text', name: '자막',
      clips: [{
        id: 'c1', kind: 'text', start: 0, duration: 1000, text: '가나다',
        style: { fontFamily: '내가 만든 폰트', fontSize: 40, color: '#ffffff', align: 'center' },
      }],
    });
    expect(() => validateDoc(doc)).not.toThrow();
  });
});
