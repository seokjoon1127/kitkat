// W8 F17 리뷰 #1 — 없는 필드를 넣으면 «조용히 저장» 이 아니라 «거절» 이어야 한다.
import { describe, expect, it } from 'vitest';
import { createEmptyProject, type ProjectDoc } from '@kitkat/schema';
import { applyCommands as apply } from '../src/index.js';

function base(): ProjectDoc {
  const doc = createEmptyProject({ name: 't' });
  doc.assets['a1'] = { id: 'a1', kind: 'image', src: 'a.png', name: 'a.png', width: 10, height: 10 };
  doc.assets['v1'] = { id: 'v1', kind: 'video', src: 'v.mp4', name: 'v.mp4', width: 10, height: 10, duration: 5000 };
  return doc;
}
const videoTrack = (d: ProjectDoc) => d.tracks.find((t) => t.kind === 'video')!.id;

describe('없는 필드 거절', () => {
  it('addClip — 이미지 클립에 오타 필드(chromaKeyy)', () => {
    const doc = base();
    expect(() =>
      apply(doc, [
        { type: 'addClip', trackId: videoTrack(doc), clip: {
          id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 1000,
          chromaKeyy: { color: '#00b140', similarity: 0.4, smoothness: 0.1 },
        } as never },
      ]),
    ).toThrow(/UNKNOWN_FIELD|스키마에 없는 필드.*chromaKeyy/);
  });

  it('addClip — 실제로 있었던 경우: chromaKey 안의 enabled', () => {
    const doc = base();
    let err: Error | undefined;
    try {
      apply(doc, [
        { type: 'addClip', trackId: videoTrack(doc), clip: {
          id: 'c1', kind: 'video', assetId: 'v1', start: 0, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1,
          chromaKey: { color: '#00b140', similarity: 0.4, smoothness: 0.1, enabled: true },
        } as never },
      ]);
    } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    // 경로가 그대로 나온다 — 에이전트가 «어디를» 잘못 썼는지 안다
    expect(err!.message).toMatch(/chromaKey\.enabled/);
    expect(err!.message).toMatch(/오타|지원하지 않는/);
  });

  it('updateClip — patch 로 들어와도 잡힌다', () => {
    const doc = base();
    const next = apply(doc, [
      { type: 'addClip', trackId: videoTrack(doc), clip: { id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 1000 } },
    ]);
    expect(() =>
      apply(next, [{ type: 'updateClip', clipId: 'c1', patch: { speeed: 2 } as never }]),
    ).toThrow(/speeed/);
  });

  it('updateAsset — 에셋도 같다', () => {
    const doc = base();
    expect(() =>
      apply(doc, [{ type: 'updateAsset', assetId: 'a1', patch: { proxySrcc: 'x' } as never }]),
    ).toThrow(/proxySrcc/);
  });

  it('맞는 문서는 그대로 통과한다 (회귀 0)', () => {
    const doc = base();
    const next = apply(doc, [
      { type: 'addClip', trackId: videoTrack(doc), clip: {
        id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 1000,
        chromaKey: { color: '#00b140', similarity: 0.4, smoothness: 0.1, spill: 0.5 },
      } },
    ]);
    expect(next.tracks.find((t) => t.kind === 'video')!.clips).toHaveLength(1);
  });

  it('원본 문서는 실패해도 안 바뀐다 (원자성)', () => {
    const doc = base();
    const snapshot = JSON.stringify(doc);
    try {
      apply(doc, [{ type: 'updateAsset', assetId: 'a1', patch: { zzz: 1 } as never }]);
    } catch { /* 기대한 실패 */ }
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
