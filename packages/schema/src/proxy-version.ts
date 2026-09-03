// W8 F17 리뷰 #3 — 「어느 프록시가 옛 판인가」를 한 곳에서 정한다.
//
// 프록시는 키프레임 간격을 0.5초로 바꾸면서(F14) 파일 이름에 판 표시(.g15)가 붙었다.
// 원본 프록시(proxies/<id>.g15.mp4)와 파생 프록시(derived/<id>.<key>.p.g15.mp4) **둘 다** 같은 규칙이다.
// media 패키지의 PROXY_TAG 와 같은 값이어야 한다 — ui/test/proxy-tag.test.ts 가 어긋나면 잡는다.
import type { ProjectDoc } from './index.js';

export const PROXY_TAG = 'g15';

/** 이 프록시 경로가 지금 판인가. 없으면(undefined) 「옛 판」이 아니라 「없음」이다. */
export function isCurrentProxy(rel: string | undefined): boolean {
  return rel !== undefined && rel.endsWith(`.${PROXY_TAG}.mp4`);
}

/** 다시 구워야 할 프록시 하나. key 가 없으면 원본 프록시, 있으면 그 파생의 프록시. */
export type StaleProxyTarget = { assetId: string; key?: string };

/** 문서 안에서 옛 판 프록시를 전부 찾는다 (원본 + 파생). 프록시가 아예 없는 것은 세지 않는다. */
export function staleProxyTargets(doc: ProjectDoc): StaleProxyTarget[] {
  const out: StaleProxyTarget[] = [];
  for (const a of Object.values(doc.assets)) {
    if (a.kind !== 'video') continue;
    if (a.proxySrc !== undefined && !isCurrentProxy(a.proxySrc)) out.push({ assetId: a.id });
    for (const [key, d] of Object.entries(a.derived ?? {})) {
      if (d.proxySrc !== undefined && !isCurrentProxy(d.proxySrc)) out.push({ assetId: a.id, key });
    }
  }
  return out;
}

export const staleProxyCount = (doc: ProjectDoc): number => staleProxyTargets(doc).length;
