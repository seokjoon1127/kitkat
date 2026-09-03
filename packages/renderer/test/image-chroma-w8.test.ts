// W8 F17 — 이미지 클립의 크로마키.
//
// V2 브라우저 확인 중에 찾았다: 서버가 이미지 클립의 chromaKey 를 **받아서 저장하는데**
// 렌더러가 `kind === 'video'` 일 때만 스테이지를 붙여서 **아무 일도 안 일어났다.**
// 실제 렌더로 확인한 값: 고치기 전 모서리 #00ad3f(초록 그대로) → 고친 뒤 #000000(배경).
import { describe, expect, it } from 'vitest';
import type { Asset, ImageClip, VideoClip } from '@kitkat/schema';
import { ProjectDocSchema } from '@kitkat/schema';
import { computeVisualLayout } from '../src/layout/index.js';

const asset: Asset = {
  id: 'a1', kind: 'image', src: 'a.png', name: 'a.png', width: 480, height: 854,
};
const ck = { enabled: true, color: '#00b140', similarity: 0.4, smoothness: 0.1, spill: 0.5 } as const;

const img = (extra?: Partial<ImageClip>): ImageClip =>
  ({ id: 'c1', kind: 'image', assetId: 'a1', start: 0, duration: 1000, ...extra }) as ImageClip;

function parseDoc(clip: ImageClip) {
  return ProjectDocSchema.safeParse({
    schemaVersion: 1, id: 'p1', name: 't', revision: 1,
    settings: { width: 480, height: 854, fps: 30, background: { kind: 'color', color: '#000000' } },
    assets: { a1: asset },
    tracks: [{ id: 't1', kind: 'video', name: '비디오', clips: [clip] }],
  });
}

const layout = (clip: ImageClip | VideoClip) =>
  computeVisualLayout({ clip, asset, canvasW: 480, canvasH: 854, tMs: 0 });

describe('이미지 클립 크로마키', () => {
  it('스키마가 받는다 (저장은 되는데 안 그려지는 상태를 없앤다)', () => {
    // 클립 스키마는 문서 스키마 안에만 있어서 문서째로 확인한다
    expect(parseDoc(img({ chromaKey: { ...ck } })).success).toBe(true);
  });

  it('레이아웃에 chromaKey 스테이지가 생긴다', () => {
    const l = layout(img({ chromaKey: { ...ck } }));
    const kinds = l.svgFilters.map((f) => f.kind);
    expect(kinds).toContain('chromaKey');
  });

  it('크로마키를 안 걸면 스테이지가 안 생긴다 (회귀 0)', () => {
    const l = layout(img());
    expect(l.svgFilters.map((f) => f.kind)).not.toContain('chromaKey');
  });

  it('영상 클립의 스테이지 파라미터와 «완전히 같다» — 두 경로가 갈리면 안 된다', () => {
    const vclip: VideoClip = {
      id: 'v1', kind: 'video', assetId: 'a1', start: 0, duration: 1000,
      in: 0, out: 1000, speed: 1, volume: 1, chromaKey: { ...ck },
    };
    const vAsset: Asset = { ...asset, kind: 'video', src: 'a.mp4', name: 'a.mp4', duration: 1000 };
    const vi = computeVisualLayout({ clip: vclip, asset: vAsset, canvasW: 480, canvasH: 854, tMs: 0 });
    const iStage = layout(img({ chromaKey: { ...ck } })).svgFilters.find((f) => f.kind === 'chromaKey');
    const vStage = vi.svgFilters.find((f) => f.kind === 'chromaKey');
    expect(iStage).toBeDefined();
    expect(vStage).toBeDefined();
    expect(iStage!.data).toEqual(vStage!.data);
  });

  it('문서 유효성 검사도 통과한다 (에이전트가 MCP 로 넣는 경로)', () => {
    const r = parseDoc(img({ chromaKey: { ...ck } }));
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 2))).toBe(true);
  });
});
