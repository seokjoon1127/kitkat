import { describe, expect, it } from 'vitest';
import { ProjectDocSchema, createEmptyProject, describeUnknownKeys, findUnknownKeys } from '../src/index.js';

describe('findUnknownKeys — 스키마에 없는 필드 찾기', () => {
  it('원본에만 있는 키의 경로를 낸다 (중첩·배열 포함)', () => {
    const original = { a: 1, b: { c: 2, ghost: 3 }, list: [{ x: 1 }, { x: 1, y: 2 }] };
    const parsed = { a: 1, b: { c: 2 }, list: [{ x: 1 }, { x: 1 }] };
    expect(findUnknownKeys(original, parsed)).toEqual(['b.ghost', 'list.1.y']);
  });

  it('값이 undefined 인 키는 세지 않는다 (JSON 에 안 실린다)', () => {
    expect(findUnknownKeys({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
  });

  it('완전히 같으면 빈 배열', () => {
    const doc = createEmptyProject({ name: 't' });
    const r = ProjectDocSchema.parse(doc);
    expect(findUnknownKeys(doc, r)).toEqual([]);
  });

  it('진짜 스키마로: 이미지 클립에 없는 필드를 넣으면 잡힌다', () => {
    const doc = createEmptyProject({ name: 't' });
    doc.assets['a1'] = { id: 'a1', kind: 'image', src: 'a.png', name: 'a.png', width: 10, height: 10 };
    const vt = doc.tracks.find((t) => t.kind === 'video')!;
    vt.clips.push({
      id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 1000,
      // @ts-expect-error — 일부러 없는 필드
      chromaKeyy: { color: '#00b140' },
      chromaKey: { color: '#00b140', similarity: 0.4, smoothness: 0.1, enabled: true },
    });
    const r = ProjectDocSchema.safeParse(doc);
    expect(r.success).toBe(true);
    const unknown = findUnknownKeys(doc, r.success ? r.data : null);
    expect(unknown).toContain(`tracks.${doc.tracks.indexOf(vt)}.clips.0.chromaKeyy`);
    expect(unknown).toContain(`tracks.${doc.tracks.indexOf(vt)}.clips.0.chromaKey.enabled`);
  });

  it('describeUnknownKeys — 3개까지 보여 주고 나머지는 개수', () => {
    expect(describeUnknownKeys(['a'])).toBe('스키마에 없는 필드: a');
    expect(describeUnknownKeys(['a', 'b', 'c', 'd', 'e'])).toBe('스키마에 없는 필드: a, b, c 외 2개');
  });
});
