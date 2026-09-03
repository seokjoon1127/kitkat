// 프리뷰 v2 크로마키 (W6 T1) — 셰이더가 렌더러와 **같은 수식**을 써야 한다.
// 셰이더를 브라우저 없이 실행할 수 없으므로 (1) 소스에 수식이 있는지 확인하고
// (2) 셰이더가 하는 계산을 그대로 JS 로 옮겨 렌더러 함수와 값을 맞춰 본다.
import { describe, expect, it } from 'vitest';
import type { Asset, VideoClip } from '@kitkat/schema';
import { computeVisualLayout } from '@kitkat/renderer/layout';
import {
  chromaKeyAlphaFactor,
  chromaKeyDespill,
  chromaKeyParams,
  type ChromaKeyParams,
} from '@kitkat/renderer/composition';
import { composeSvgChain, layerColorParams } from '../src/preview/gl-params.js';
import { PREVIEW_FRAG_SRC } from '../src/preview/gl.js';

const ASSET: Asset = {
  id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1',
  duration: 10000, width: 1920, height: 1080,
};

const KEY = { color: '#00b140', similarity: 0.4, smoothness: 0.1 };

function layoutOf(over: Partial<VideoClip>): ReturnType<typeof computeVisualLayout> {
  const clip: VideoClip = {
    id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 4000,
    in: 0, out: 4000, speed: 1, volume: 1, ...over,
  };
  return computeVisualLayout({ clip, asset: ASSET, canvasW: 1920, canvasH: 1080, tMs: 0 });
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 프래그먼트 셰이더의 크로마키 블록을 **그대로** 옮긴 것:
 *   float mk = dot(uChromaC, c);
 *   chromaA = clamp((uChromaT + uChromaW*0.5 - mk) / uChromaW, 0, 1);
 *   c = clamp(c + max(0, mk - uChromaT) * uChromaV, 0, 1);
 */
function shaderChroma(
  p: ChromaKeyParams,
  c: [number, number, number],
): { a: number; c: [number, number, number] } {
  const mk = p.c[0] * c[0] + p.c[1] * c[1] + p.c[2] * c[2];
  const a = clamp01((p.t + p.w * 0.5 - mk) / p.w);
  const q = Math.max(0, mk - p.t);
  return {
    a,
    c: [clamp01(c[0] + q * p.v[0]), clamp01(c[1] + q * p.v[1]), clamp01(c[2] + q * p.v[2])],
  };
}

const SAMPLES: [number, number, number][] = [
  [0, 0xb1 / 255, 0x40 / 255], // 키 그린
  [0xe8 / 255, 0xb4 / 255, 0x8c / 255], // 밝은 피부
  [1, 1, 1], // 흰옷
  [0x87 / 255, 0xce / 255, 0xeb / 255], // 하늘색
  [0x4a / 255, 0x2f / 255, 0x1e / 255], // 어두운 피부
  [0xc0 / 255, 0x39 / 255, 0x2b / 255], // 빨간 옷
  [0.2, 0.6, 0.3], // 초록 물든 경계색
  [0.45, 0.7, 0.4],
];

describe('프리뷰 크로마키', () => {
  it('셰이더 소스에 판정식·디스필이 들어 있다', () => {
    expect(PREVIEW_FRAG_SRC).toContain('uniform vec3 uChromaC');
    expect(PREVIEW_FRAG_SRC).toContain('uniform float uChromaT');
    expect(PREVIEW_FRAG_SRC).toContain('uniform float uChromaW');
    expect(PREVIEW_FRAG_SRC).toContain('uniform vec3 uChromaV');
    expect(PREVIEW_FRAG_SRC).toContain('float mk = dot(uChromaC, c);');
    expect(PREVIEW_FRAG_SRC).toContain(
      'chromaA = clamp((uChromaT + uChromaW * 0.5 - mk) / uChromaW, 0.0, 1.0);',
    );
    expect(PREVIEW_FRAG_SRC).toContain('c = clamp(c + max(0.0, mk - uChromaT) * uChromaV, 0.0, 1.0);');
    // 알파에 곱해진다
    expect(PREVIEW_FRAG_SRC).toContain('uOpacity * chromaA');
  });

  it('셰이더 수식과 렌더러 수식이 같은 알파·색을 낸다', () => {
    for (const opts of [
      KEY,
      { ...KEY, similarity: 0 },
      { ...KEY, similarity: 0.8, smoothness: 0.6 },
      { ...KEY, spill: 1 },
      { ...KEY, spill: 0 },
      { color: '#0047bb', similarity: 0.5, smoothness: 0.2 },
    ]) {
      const p = chromaKeyParams(opts);
      for (const c of SAMPLES) {
        const s = shaderChroma(p, c);
        expect(s.a).toBeCloseTo(chromaKeyAlphaFactor(p, ...c), 12);
        const r = chromaKeyDespill(p, ...c);
        for (let i = 0; i < 3; i++) expect(s.c[i]!).toBeCloseTo(r[i]!, 12);
      }
    }
  });

  it('크로마키는 더 이상 「못 그림」이 아니다 (배지 사유에서 빠졌다)', () => {
    const L = layoutOf({ chromaKey: KEY });
    const params = layerColorParams(L);
    expect(params.approx).toEqual([]);
    expect(params.chroma).not.toBeNull();
    expect(params.chroma!.t).toBeCloseTo(chromaKeyParams(KEY).t, 12);
    // 크로마키가 없으면 chroma 는 null
    expect(layerColorParams(layoutOf({})).chroma).toBeNull();
  });

  it('레이아웃이 준 스테이지를 그대로 셰이더 상수로 옮긴다 (렌더러와 같은 객체)', () => {
    const L = layoutOf({ chromaKey: { ...KEY, spill: 0.25 } });
    const chain = composeSvgChain(L.effectFilters);
    expect(chain.chroma).toEqual(chromaKeyParams({ ...KEY, spill: 0.25 }));
    expect(chain.unsupported).toEqual([]);
  });
});
