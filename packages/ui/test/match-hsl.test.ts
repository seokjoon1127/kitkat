// W8 F4·F5 인스펙터 헬퍼 — 배지 상태·프리셋 합성·영역 정규화·source 보존.
import { describe, expect, it } from 'vitest';
import { COLOR_PRESETS, sourceKey, type Asset, type ClipSource, type ProjectDoc, type VideoClip } from '@kitkat/schema';
import {
  applyColorPreset,
  emptyHsl,
  emptyHueSat,
  HSL_FAMILY_LABELS,
  HSL_FAMILY_SWATCH,
  HSL_INK_FIELDS,
  HUESAT_BAND_LABELS,
  isIdentityHsl,
  isIdentityHueSat,
  matchCandidates,
  matchState,
  normalizeClipSource,
  normalizeRegion,
  refSourceKeyOf,
} from '../src/components/sections/inspector-utils';

const vclip = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 1000,
  in: 0, out: 1000, speed: 1, volume: 1, ...over,
});

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1', ...over,
});

const LEVELS = {
  sampledAtMs: [50, 275, 500, 725, 950],
  refSourceKey: 'raw',
  ref: [{ mean: 0.5, std: 0.2 }, { mean: 0.5, std: 0.2 }, { mean: 0.5, std: 0.2 }] as [never, never, never],
  target: [{ mean: 0.4, std: 0.2 }, { mean: 0.4, std: 0.2 }, { mean: 0.4, std: 0.2 }] as [never, never, never],
};

describe('normalizeClipSource — W8 필드를 실어 나른다', () => {
  it('matchTo·hsl·hueSat 가 살아남는다 (LUT 슬라이더 한 번에 색이 사라지면 안 된다)', () => {
    const src: ClipSource = {
      lut: { assetId: 'l1', intensity: 0.5 },
      matchTo: { clipId: 'ref', strength: 1, levels: LEVELS },
      hsl: [{ id: 'h1', family: 'reds', cyan: 0.06, magenta: -0.05, yellow: 0, black: 0 }],
      hueSat: [{ id: 'b1', bands: ['r', 'y'], hue: 0, saturation: -0.15, intensity: 0 }],
    };
    const out = normalizeClipSource(src)!;
    expect(out.matchTo?.clipId).toBe('ref');
    expect(out.matchTo?.levels).toEqual(LEVELS);
    expect(out.hsl).toHaveLength(1);
    expect(out.hueSat).toHaveLength(1);
  });

  it('범위를 벗어난 값은 클램프한다', () => {
    const out = normalizeClipSource({
      matchTo: { clipId: 'ref', strength: 3 },
      hsl: [{ id: 'h1', family: 'blues', cyan: 5, magenta: -9, yellow: 0, black: 0 }],
      hueSat: [{ id: 'b1', bands: ['g'], hue: 900, saturation: -4, intensity: 7 }],
    })!;
    expect(out.matchTo!.strength).toBe(1);
    expect(out.hsl![0]).toMatchObject({ cyan: 1, magenta: -1 });
    expect(out.hueSat![0]).toMatchObject({ hue: 180, saturation: -1, intensity: 1 });
  });

  it('빈 배열은 필드를 만들지 않는다 (sourceKey 를 깨끗하게)', () => {
    expect(normalizeClipSource({ hsl: [], hueSat: [] })).toBeNull();
  });
});

describe('matchState — 배지가 거짓말하지 않는가', () => {
  it('matchTo 없으면 off', () => {
    expect(matchState(vclip(), undefined, {})).toBe('off');
  });

  it('기준 클립이 사라졌으면 missing', () => {
    const clip = vclip({ source: { matchTo: { clipId: 'gone', strength: 1, levels: LEVELS } } });
    expect(matchState(clip, undefined, {})).toBe('missing');
  });

  it('levels 가 없으면 unmeasured — 서버도 이때는 굽지 않는다', () => {
    const clip = vclip({ source: { matchTo: { clipId: 'r1', strength: 1 } } });
    expect(matchState(clip, vclip({ id: 'r1' }), {})).toBe('unmeasured');
  });

  it('기준 컷의 파생이 생기면 stale (refSourceKey 불일치)', () => {
    const refSource: ClipSource = { hsl: [{ id: 'h', family: 'reds', cyan: 0.1, magenta: 0, yellow: 0, black: 0 }] };
    const ref = vclip({ id: 'r1', assetId: 'a2', source: refSource });
    const key = sourceKey(ref)!;
    const assets: Record<string, Asset> = {
      a1: asset(),
      a2: asset({ id: 'a2', derived: { [key]: { src: `derived/a2.${key}.mp4` } } }),
    };
    const clip = vclip({ source: { matchTo: { clipId: 'r1', strength: 1, levels: LEVELS } } });
    expect(matchState(clip, ref, assets)).toBe('stale');
    // 기준의 파생이 아직 안 구워졌으면 'raw' 라 일치한다
    expect(matchState(clip, ref, { a1: asset(), a2: asset({ id: 'a2' }) })).toBe('baking');
  });

  it('다 쟀고 파생까지 있으면 ready', () => {
    const clip = vclip({ source: { matchTo: { clipId: 'r1', strength: 1, levels: LEVELS } } });
    const key = sourceKey(clip)!;
    const assets = { a1: asset({ derived: { [key]: { src: `derived/a1.${key}.mp4` } } }) };
    expect(matchState(clip, vclip({ id: 'r1', assetId: 'a2' }), assets)).toBe('ready');
  });
});

describe('refSourceKeyOf', () => {
  it('파생이 없으면 raw', () => {
    const ref = vclip({ source: { hsl: [{ id: 'h', family: 'reds', cyan: 0.1, magenta: 0, yellow: 0, black: 0 }] } });
    expect(refSourceKeyOf(ref, { a1: asset() })).toBe('raw');
  });
  it('source 자체가 없어도 raw', () => {
    expect(refSourceKeyOf(vclip(), { a1: asset() })).toBe('raw');
  });
});

describe('matchCandidates', () => {
  const doc = (): ProjectDoc => ({
    schemaVersion: 1, id: 'p', name: 'p', revision: 1,
    settings: { width: 1080, height: 1920, fps: 30, background: { kind: 'color', color: '#000000' } },
    assets: { a1: asset(), a2: asset({ id: 'a2', name: 'B' }) },
    tracks: [
      {
        id: 't1', kind: 'video', name: 'V', clips: [
          vclip({ id: 'c1', start: 2000 }),
          vclip({ id: 'c2', assetId: 'a2', start: 0 }),
          { id: 't3', kind: 'text', start: 0, duration: 100, text: 'x',
            style: { fontFamily: 'x', fontSize: 40, color: '#fff', align: 'center' } },
        ],
      },
    ],
  });

  it('자기 자신과 텍스트 클립은 뺀다', () => {
    const out = matchCandidates(doc(), 'c1');
    expect(out.map((o) => o.clip.id)).toEqual(['c2']);
  });

  it('시간순으로 준다', () => {
    const out = matchCandidates(doc(), 'zzz');
    expect(out.map((o) => o.clip.id)).toEqual(['c2', 'c1']);
  });
});

describe('normalizeRegion — 드래그 사각형', () => {
  it('반대 방향 드래그도 정상 사각형이 된다', () => {
    expect(normalizeRegion({ x: 0.8, y: 0.9, w: -0.3, h: -0.4 })).toEqual({ x: 0.5, y: 0.5, w: 0.3, h: 0.4 });
  });
  it('화면 밖으로 넘치면 안쪽으로 자른다', () => {
    const r = normalizeRegion({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
    expect(r.x + r.w).toBeLessThanOrEqual(1.0001);
    expect(r.y + r.h).toBeLessThanOrEqual(1.0001);
  });
  it('0 크기는 최소 1%로 올린다 (0픽셀 측정 방지)', () => {
    const r = normalizeRegion({ x: 0.5, y: 0.5, w: 0, h: 0 });
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });
});

describe('HSL 프리셋', () => {
  it('7종 전부 hsl 이나 hueSat 을 갖고, 라벨·설명이 비어 있지 않다', () => {
    expect(COLOR_PRESETS).toHaveLength(7);
    for (const p of COLOR_PRESETS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.note.length).toBeGreaterThan(0);
      expect((p.hsl?.length ?? 0) + (p.hueSat?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it('같은 family 를 두 번 걸면 덮어쓴다 (selectivecolor 는 계열마다 인자가 하나뿐)', () => {
    const first = applyColorPreset({}, COLOR_PRESETS.find((p) => p.id === 'skin-less-red')!);
    const second = applyColorPreset(first, COLOR_PRESETS.find((p) => p.id === 'skin-warmth')!);
    const reds = (second.hsl ?? []).filter((h) => h.family === 'reds');
    expect(reds).toHaveLength(1);
    expect(reds[0]!.cyan).toBe(-0.04); // 나중 프리셋의 값
    expect(reds[0]!.id).toBe(first.hsl![0]!.id); // id 는 유지 (헛굽기 방지)
  });

  it('다른 family 프리셋은 쌓인다', () => {
    let src: ClipSource = {};
    src = applyColorPreset(src, COLOR_PRESETS.find((p) => p.id === 'skin-less-red')!);
    src = applyColorPreset(src, COLOR_PRESETS.find((p) => p.id === 'sky-deepen')!);
    expect((src.hsl ?? []).map((h) => h.family).sort()).toEqual(['blues', 'reds']);
  });

  it('「초록 자연스럽게」는 두 필터를 같이 건다', () => {
    const src = applyColorPreset({}, COLOR_PRESETS.find((p) => p.id === 'green-natural')!);
    expect(src.hsl).toHaveLength(1);
    expect(src.hueSat).toHaveLength(1);
    expect(src.hueSat![0]!.bands).toEqual(['g']);
  });

  it('프리셋을 걸면 sourceKey 가 바뀐다 (안 바뀌면 화면이 안 변한다)', () => {
    const base = vclip();
    const withPreset = vclip({ source: applyColorPreset({}, COLOR_PRESETS[0]!) });
    expect(sourceKey(base)).toBeNull();
    expect(sourceKey(withPreset)).not.toBeNull();
  });
});

describe('HSL 편집 헬퍼', () => {
  it('값이 전부 0이면 항등 — 저장하지 않는다', () => {
    expect(isIdentityHsl(emptyHsl('reds'))).toBe(true);
    expect(isIdentityHsl({ ...emptyHsl('reds'), black: -0.08 })).toBe(false);
    expect(isIdentityHueSat(emptyHueSat(['r']))).toBe(true);
    expect(isIdentityHueSat({ ...emptyHueSat(['r']), saturation: -0.15 })).toBe(false);
  });

  it('9계열·6구간 라벨과 색 칩이 모두 있다', () => {
    expect(Object.keys(HSL_FAMILY_LABELS)).toHaveLength(9);
    expect(Object.keys(HSL_FAMILY_SWATCH)).toHaveLength(9);
    expect(Object.keys(HUESAT_BAND_LABELS)).toHaveLength(6);
  });

  it('CMYK 슬라이더 라벨은 색 이름이 아니라 방향이다', () => {
    expect(HSL_INK_FIELDS.map((f) => f.key)).toEqual(['cyan', 'magenta', 'yellow', 'black']);
    for (const f of HSL_INK_FIELDS) expect(f.label).toContain('↔');
  });
});
