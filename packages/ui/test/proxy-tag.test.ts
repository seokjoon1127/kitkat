// 프록시 판 표시는 «두 곳»에 있다 — @kitkat/schema(브라우저·서버 공용 순수 코드)와
// @kitkat/media(ffmpeg 쪽, node 전용). media 는 schema 에 의존하지 않기로 한 패키지라
// 값을 둘 다 갖는다. 어긋나면 UI 는 «옛 판»이라 하고 서버는 «새 판»이라 하는 사고가 난다.
import { describe, expect, it } from 'vitest';
import { PROXY_TAG as MEDIA_TAG, isCurrentProxy as mediaIsCurrent } from '@kitkat/media';
import { PROXY_TAG, isCurrentProxy } from '@kitkat/schema';
import { PROXY_TAG as UI_TAG, isCurrentProxy as uiIsCurrent } from '../src/components/sections/inspector-utils.js';

describe('프록시 판 표시 — schema · media · ui 재수출', () => {
  it('세 값이 같다', () => {
    expect(PROXY_TAG).toBe(MEDIA_TAG);
    expect(UI_TAG).toBe(PROXY_TAG);
  });

  it('세 판정이 같은 답을 낸다', () => {
    const cases = ['proxies/abc.g15.mp4', 'proxies/abc.mp4', 'derived/abc.k1.p.mp4', 'derived/abc.k1.p.g15.mp4', 'proxies/g15.mp4', '', undefined];
    for (const c of cases) {
      expect(isCurrentProxy(c), String(c)).toBe(mediaIsCurrent(c));
      expect(uiIsCurrent(c), String(c)).toBe(mediaIsCurrent(c));
    }
  });
});
