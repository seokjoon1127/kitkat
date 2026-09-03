// W8 S3 — sourceKey 빠뜨림 검사.
//
// 새 필드를 정규화 문자열에 «하나라도» 빠뜨리면 다른 설정인데 같은 파생 파일을 쓴다
// — 사용자가 색을 바꿨는데 화면이 안 변한다. 그래서 필드마다 한 개씩 테스트를 만든다.
import { describe, expect, it } from 'vitest';
import {
  ClipSourceSchema,
  DEFAULT_TARGET_LUFS,
  sourceKey,
  validateDoc,
  type AudioClip,
  type ClipSource,
  type HslSecondary,
  type HueSatBand,
  type MatchLevels,
  type VideoClip,
} from '../src/index.js';

function vclip(source?: ClipSource, extra?: Partial<VideoClip>): VideoClip {
  return {
    id: 'c1', kind: 'video', assetId: 'a1',
    start: 0, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1,
    ...(source ? { source } : {}),
    ...extra,
  };
}

const stat = (mean: number, std: number) => ({ mean, std });

const LEVELS: MatchLevels = {
  sampledAtMs: [100, 300, 500, 700, 900],
  refSourceKey: 's1a2b3c4',
  ref: [stat(0.468, 0.461), stat(0.517, 0.472), stat(0.497, 0.495)],
  target: [stat(0.407, 0.4), stat(0.365, 0.35), stat(0.28, 0.259)],
};

const HUESAT: HueSatBand = {
  id: 'hs1', bands: ['r', 'y'], hue: 12, saturation: -0.15, intensity: 0.05,
  preserveLightness: false,
};

const HSL: HslSecondary = {
  id: 'sc1', family: 'reds', cyan: 0.06, magenta: -0.05, yellow: 0.2, black: -0.08,
};

/** 기준이 되는 «모든 필드가 채워진» source. */
function fullSource(): ClipSource {
  return {
    matchTo: {
      clipId: 'ref-clip',
      strength: 0.8,
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      refRegion: { x: 0.5, y: 0.6, w: 0.2, h: 0.1 },
      levels: structuredClone(LEVELS),
    },
    hueSat: [structuredClone(HUESAT)],
    hsl: [structuredClone(HSL)],
    motionBlur: { shutterAngle: 180, quality: 'precise' },
    voice: { preset: 'broadcast', targetLufs: -16, reverb: { irId: 'voxengo/hall-medium', wet: 0.3 } },
  };
}

/** 필드 하나만 바꾸는 변형들 — 이름이 곧 테스트 이름이 된다. */
const MUTATIONS: Record<string, (s: ClipSource) => void> = {
  'matchTo.clipId': (s) => { s.matchTo!.clipId = 'other-clip'; },
  'matchTo.strength': (s) => { s.matchTo!.strength = 0.7; },
  'matchTo.region': (s) => { s.matchTo!.region = { x: 0.1, y: 0.2, w: 0.3, h: 0.41 }; },
  'matchTo.region 없음': (s) => { delete s.matchTo!.region; },
  'matchTo.refRegion': (s) => { s.matchTo!.refRegion = { x: 0.55, y: 0.6, w: 0.2, h: 0.1 }; },
  'matchTo.refRegion 없음': (s) => { delete s.matchTo!.refRegion; },
  'matchTo.levels 없음': (s) => { delete s.matchTo!.levels; },
  'matchTo.levels.refSourceKey': (s) => { s.matchTo!.levels!.refSourceKey = 'raw'; },
  'matchTo.levels.sampledAtMs 값': (s) => { s.matchTo!.levels!.sampledAtMs[2] = 501; },
  'matchTo.levels.sampledAtMs 개수': (s) => { s.matchTo!.levels!.sampledAtMs.push(950); },
  'hueSat[0].id': (s) => { s.hueSat![0]!.id = 'hs2'; },
  'hueSat[0].bands': (s) => { s.hueSat![0]!.bands = ['r', 'g']; },
  'hueSat[0].bands 순서': (s) => { s.hueSat![0]!.bands = ['y', 'r']; },
  'hueSat[0].hue': (s) => { s.hueSat![0]!.hue = 13; },
  'hueSat[0].saturation': (s) => { s.hueSat![0]!.saturation = -0.16; },
  'hueSat[0].intensity': (s) => { s.hueSat![0]!.intensity = 0.06; },
  'hueSat[0].preserveLightness': (s) => { s.hueSat![0]!.preserveLightness = true; },
  'hsl[0].id': (s) => { s.hsl![0]!.id = 'sc2'; },
  'hsl[0].family': (s) => { s.hsl![0]!.family = 'yellows'; },
  'hsl[0].cyan': (s) => { s.hsl![0]!.cyan = 0.07; },
  'hsl[0].magenta': (s) => { s.hsl![0]!.magenta = -0.06; },
  'hsl[0].yellow': (s) => { s.hsl![0]!.yellow = 0.21; },
  'hsl[0].black': (s) => { s.hsl![0]!.black = -0.09; },
  'motionBlur.shutterAngle': (s) => { s.motionBlur!.shutterAngle = 181; },
  'motionBlur.quality': (s) => { s.motionBlur!.quality = 'fast'; },
  'voice.preset': (s) => { s.voice!.preset = 'podcast'; },
  'voice.targetLufs': (s) => { s.voice!.targetLufs = -17; },
  'voice.reverb 없음': (s) => { delete s.voice!.reverb; },
  'voice.reverb.irId': (s) => { s.voice!.reverb!.irId = 'voxengo/hall-large'; },
  'voice.reverb.wet': (s) => { s.voice!.reverb!.wet = 0.31; },
};

// levels 의 12개 μ·σ 각각 — 하나라도 빠지면 「다시 잰 결과가 반영 안 됨」이 된다
for (const which of ['ref', 'target'] as const) {
  for (let ch = 0; ch < 3; ch++) {
    for (const field of ['mean', 'std'] as const) {
      MUTATIONS[`matchTo.levels.${which}[${ch}].${field}`] = (s) => {
        s.matchTo!.levels![which][ch]![field] += 0.01;
      };
    }
  }
}

describe('sourceKey — W8 S3 필드 빠뜨림 검사', () => {
  const base = sourceKey(vclip(fullSource()));

  it('모든 필드가 찬 source 는 s+hex8 키를 낸다', () => {
    expect(base).toMatch(/^s[0-9a-f]{8}$/);
  });

  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    it(`${name} 이(가) 바뀌면 키가 갈린다`, () => {
      const s = fullSource();
      mutate(s);
      expect(sourceKey(vclip(s))).not.toBe(base);
    });
  }

  it(`변형 ${Object.keys(MUTATIONS).length}개가 전부 «서로 다른» 키를 낸다 (충돌 없음)`, () => {
    const keys = new Set<string>([base!]);
    for (const mutate of Object.values(MUTATIONS)) {
      const s = fullSource();
      mutate(s);
      keys.add(sourceKey(vclip(s))!);
    }
    expect(keys.size).toBe(Object.keys(MUTATIONS).length + 1);
  });
});

describe('sourceKey — 배열 순서', () => {
  it('hsl 배열 순서가 바뀌면 키가 갈린다 (체인 순서가 결과를 바꾼다)', () => {
    const a: HslSecondary = { id: 'x', family: 'reds', cyan: 0.1, magenta: 0, yellow: 0, black: 0 };
    const b: HslSecondary = { id: 'y', family: 'blues', cyan: 0, magenta: 0.2, yellow: 0, black: 0 };
    expect(sourceKey(vclip({ hsl: [a, b] }))).not.toBe(sourceKey(vclip({ hsl: [b, a] })));
  });

  it('hueSat 배열 순서가 바뀌면 키가 갈린다', () => {
    const a: HueSatBand = { id: 'x', bands: ['r'], hue: 10, saturation: 0, intensity: 0 };
    const b: HueSatBand = { id: 'y', bands: ['g'], hue: -10, saturation: 0.2, intensity: 0 };
    expect(sourceKey(vclip({ hueSat: [a, b] }))).not.toBe(sourceKey(vclip({ hueSat: [b, a] })));
  });

  it('빈 배열은 아무것도 굽지 않으므로 키가 안 생긴다', () => {
    expect(sourceKey(vclip({ hsl: [], hueSat: [] }))).toBeNull();
  });
});

describe('sourceKey — 하위호환', () => {
  // 기존 키가 바뀌면 이미 구워 둔 파생 파일이 전부 죽고 프로젝트마다 재인코딩이 돈다.
  // 아래 값은 W8 이전 알고리즘의 정규화 문자열("lut=L1,0.8|den=0.3" 등)을
  // 별도로 FNV-1a 해 얻은 것 — 구현을 베낀 게 아니라 «예전 결과» 다.
  it('W5 필드만 든 문서의 키는 W8 이전과 한 글자도 안 바뀐다', () => {
    expect(sourceKey(vclip({ lut: { assetId: 'L1', intensity: 0.8 }, denoise: { amount: 0.3 } })))
      .toBe('s0460895d');
    expect(sourceKey(vclip({ stabilize: { smoothing: 10 } }))).toBe('sca752f1d');
    expect(sourceKey(vclip({ pitch: { semitones: -2 } }))).toBe('s6560b59b');
  });

  it('새 필드를 안 쓰면 키는 예전 그대로다 (undefined 가 키에 안 들어간다)', () => {
    const old = sourceKey(vclip({ denoise: { amount: 0.3 } }));
    const withUndef = sourceKey(vclip({ denoise: { amount: 0.3 }, hsl: undefined, voice: undefined }));
    expect(withUndef).toBe(old);
  });

  it('reversed 는 여전히 |rev 로 키를 가른다 (새 필드와 함께 써도)', () => {
    const s: ClipSource = { motionBlur: { shutterAngle: 180, quality: 'precise' } };
    expect(sourceKey(vclip(s))).not.toBe(sourceKey(vclip(s, { reversed: true })));
  });
});

describe('sourceKey — 기본값 펼치기', () => {
  it('targetLufs 를 안 적은 것과 -14 를 적은 것은 같은 파일을 굽는다 → 같은 키', () => {
    expect(sourceKey(vclip({ voice: { preset: 'broadcast' } })))
      .toBe(sourceKey(vclip({ voice: { preset: 'broadcast', targetLufs: DEFAULT_TARGET_LUFS } })));
  });

  it('preserveLightness 를 안 적은 것과 false 는 같은 키', () => {
    const a: HueSatBand = { id: 'x', bands: ['r'], hue: 0, saturation: 0.1, intensity: 0 };
    expect(sourceKey(vclip({ hueSat: [a] })))
      .toBe(sourceKey(vclip({ hueSat: [{ ...a, preserveLightness: false }] })));
  });

  it('객체 프로퍼티 순서가 달라도 같은 키 (새 필드 포함)', () => {
    const a = vclip();
    a.source = { voice: { preset: 'warm' }, motionBlur: { shutterAngle: 90, quality: 'fast' } };
    const b = vclip();
    b.source = { motionBlur: { quality: 'fast', shutterAngle: 90 }, voice: { preset: 'warm' } };
    expect(sourceKey(a)).toBe(sourceKey(b));
  });
});

describe('sourceKey — audio 클립의 voice', () => {
  function aclip(source?: AudioClip['source']): AudioClip {
    return {
      id: 'ac1', kind: 'audio', assetId: 'au1',
      start: 0, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1,
      ...(source ? { source } : {}),
    };
  }

  it('나레이션은 대부분 audio 클립이다 — voice 가 키에 들어간다', () => {
    const k = sourceKey(aclip({ voice: { preset: 'podcast' } }));
    expect(k).toMatch(/^s[0-9a-f]{8}$/);
    expect(sourceKey(aclip({ voice: { preset: 'broadcast' } }))).not.toBe(k);
  });

  it('denoise 만 든 audio 클립의 키는 예전 그대로', () => {
    expect(sourceKey(aclip({ denoise: { amount: 0.5 }, pitch: { semitones: -2 } })))
      .toBe(sourceKey(aclip({ pitch: { semitones: -2 }, denoise: { amount: 0.5 } })));
  });
});

describe('ClipSourceSchema — 범위 검증', () => {
  const ok = (s: unknown) => ClipSourceSchema.safeParse(s).success;

  it('matchTo.strength 는 0..1', () => {
    expect(ok({ matchTo: { clipId: 'c', strength: 1 } })).toBe(true);
    expect(ok({ matchTo: { clipId: 'c', strength: 1.1 } })).toBe(false);
    expect(ok({ matchTo: { clipId: 'c', strength: -0.1 } })).toBe(false);
  });

  it('matchTo.clipId 는 빈 문자열 불가', () => {
    expect(ok({ matchTo: { clipId: '', strength: 1 } })).toBe(false);
  });

  it('matchTo.region 은 0..1 정규화 사각형', () => {
    expect(ok({ matchTo: { clipId: 'c', strength: 1, region: { x: 0, y: 0, w: 1, h: 1 } } })).toBe(true);
    expect(ok({ matchTo: { clipId: 'c', strength: 1, region: { x: 0, y: 0, w: 1.2, h: 1 } } })).toBe(false);
  });

  it('levels 는 r/g/b 3쌍이어야 한다 (2개면 거부)', () => {
    const two = [stat(0.5, 0.2), stat(0.5, 0.2)];
    expect(ok({ matchTo: { clipId: 'c', strength: 1, levels: { ...LEVELS, ref: two } } })).toBe(false);
  });

  it('hsl CMYK 는 -1..1 (selectivecolor 규격)', () => {
    expect(ok({ hsl: [{ ...HSL, cyan: 1 }] })).toBe(true);
    expect(ok({ hsl: [{ ...HSL, cyan: 1.01 }] })).toBe(false);
    expect(ok({ hsl: [{ ...HSL, black: -1.5 }] })).toBe(false);
  });

  it('hsl.family 는 9계열 밖이면 거부', () => {
    expect(ok({ hsl: [{ ...HSL, family: 'oranges' }] })).toBe(false);
  });

  it('hueSat.hue 는 -180..180, saturation/intensity 는 -1..1', () => {
    expect(ok({ hueSat: [{ ...HUESAT, hue: 180 }] })).toBe(true);
    expect(ok({ hueSat: [{ ...HUESAT, hue: 181 }] })).toBe(false);
    expect(ok({ hueSat: [{ ...HUESAT, saturation: -1.2 }] })).toBe(false);
    expect(ok({ hueSat: [{ ...HUESAT, intensity: 2 }] })).toBe(false);
  });

  it('hueSat.bands 는 최소 1개, r/y/g/c/b/m 만', () => {
    expect(ok({ hueSat: [{ ...HUESAT, bands: [] }] })).toBe(false);
    expect(ok({ hueSat: [{ ...HUESAT, bands: ['a'] }] })).toBe(false);
  });

  it('motionBlur.shutterAngle 는 0..360, quality 는 fast|precise', () => {
    expect(ok({ motionBlur: { shutterAngle: 360, quality: 'precise' } })).toBe(true);
    expect(ok({ motionBlur: { shutterAngle: 361, quality: 'precise' } })).toBe(false);
    expect(ok({ motionBlur: { shutterAngle: 180, quality: 'best' } })).toBe(false);
  });

  it('voice.targetLufs 는 -30..-9, reverb.wet 은 0..1', () => {
    expect(ok({ voice: { preset: 'broadcast', targetLufs: -14 } })).toBe(true);
    expect(ok({ voice: { preset: 'broadcast', targetLufs: -8 } })).toBe(false);
    expect(ok({ voice: { preset: 'broadcast', targetLufs: -31 } })).toBe(false);
    expect(ok({ voice: { preset: 'broadcast', reverb: { irId: 'x', wet: 1.5 } } })).toBe(false);
  });

  it('voice.preset 은 5종 밖이면 거부 (off 는 유효)', () => {
    expect(ok({ voice: { preset: 'off' } })).toBe(true);
    expect(ok({ voice: { preset: 'radio' } })).toBe(false);
  });

  it('기존 W5 필드만 든 source 는 그대로 통과한다', () => {
    expect(ok({ lut: { assetId: 'L1', intensity: 0.5 }, stabilize: { smoothing: 10 } })).toBe(true);
  });
});

describe('문서 전체 검증', () => {
  it('새 필드를 단 video 클립과 voice 를 단 audio 클립이 든 문서가 통과한다', () => {
    const doc = {
      schemaVersion: 1 as const,
      id: 'p1', name: 't', revision: 0,
      settings: { width: 1080, height: 1920, fps: 30, background: { kind: 'color' as const, color: '#000000' } },
      assets: { a1: { id: 'a1', kind: 'video' as const, src: 'a.mp4', name: 'a' } },
      tracks: [
        { id: 't1', kind: 'video' as const, name: 'V', clips: [vclip(fullSource())] },
        {
          id: 't2', kind: 'audio' as const, name: 'A',
          clips: [{
            id: 'ac1', kind: 'audio' as const, assetId: 'a1',
            start: 0, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1,
            source: { voice: { preset: 'podcast' as const, targetLufs: -14 } },
          }],
        },
      ],
    };
    expect(() => validateDoc(doc)).not.toThrow();
  });
});
