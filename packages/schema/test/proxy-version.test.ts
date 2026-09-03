// W8 F17 리뷰 #3 — 옛 판 프록시 판정을 원본·파생 한 곳에서.
import { describe, expect, it } from 'vitest';
import { createEmptyProject, isCurrentProxy, staleProxyCount, staleProxyTargets } from '../src/index.js';

describe('isCurrentProxy', () => {
  it('판 표시가 붙은 것만 지금 판이다 (원본·파생 둘 다)', () => {
    expect(isCurrentProxy('proxies/a.g15.mp4')).toBe(true);
    expect(isCurrentProxy('derived/a.k1.p.g15.mp4')).toBe(true);
    expect(isCurrentProxy('proxies/a.mp4')).toBe(false);
    expect(isCurrentProxy('derived/a.k1.p.mp4')).toBe(false);
    expect(isCurrentProxy(undefined)).toBe(false);
  });
});

describe('staleProxyTargets — 원본 + 파생', () => {
  it('옛 판만 고른다. 프록시가 아예 없는 것과 오디오는 세지 않는다', () => {
    const doc = createEmptyProject({ name: 't' });
    doc.assets['old'] = { id: 'old', kind: 'video', src: 'v.mp4', name: 'v', proxySrc: 'proxies/old.mp4' };
    doc.assets['new'] = { id: 'new', kind: 'video', src: 'v.mp4', name: 'v', proxySrc: 'proxies/new.g15.mp4' };
    doc.assets['none'] = { id: 'none', kind: 'video', src: 'v.mp4', name: 'v' };
    doc.assets['aud'] = { id: 'aud', kind: 'audio', src: 'a.wav', name: 'a' };
    doc.assets['mix'] = {
      id: 'mix', kind: 'video', src: 'v.mp4', name: 'v', proxySrc: 'proxies/mix.g15.mp4',
      derived: {
        k1: { src: 'derived/mix.k1.mp4', proxySrc: 'derived/mix.k1.p.mp4' },      // 옛 판
        k2: { src: 'derived/mix.k2.mp4', proxySrc: 'derived/mix.k2.p.g15.mp4' },  // 지금 판
        k3: { src: 'derived/mix.k3.m4a' },                                       // 프록시 없음(오디오 파생)
      },
    };
    const t = staleProxyTargets(doc);
    expect(t).toEqual([{ assetId: 'old' }, { assetId: 'mix', key: 'k1' }]);
    expect(staleProxyCount(doc)).toBe(2);
  });

  it('전부 최신이면 0', () => {
    const doc = createEmptyProject({ name: 't' });
    doc.assets['a'] = { id: 'a', kind: 'video', src: 'v.mp4', name: 'v', proxySrc: 'proxies/a.g15.mp4' };
    expect(staleProxyCount(doc)).toBe(0);
  });
});
