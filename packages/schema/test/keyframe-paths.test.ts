import { describe, expect, it } from 'vitest';
import {
  KEYFRAME_PATHS,
  ProjectDocSchema,
  createEmptyProject,
  isKeyframablePath,
  isValidKeyframePath,
  keyframePathLabel,
  keyframePathRejection,
  readPath,
  writePath,
  type AudioClip,
  type ImageClip,
  type TextClip,
  type VideoClip,
} from '../src/index.js';

const video = (extra?: Partial<VideoClip>): VideoClip => ({
  id: 'c1', kind: 'video', assetId: 'a1', start: 0, duration: 1000,
  in: 0, out: 1000, speed: 1, volume: 1, ...extra,
});
const image = (extra?: Partial<ImageClip>): ImageClip => ({
  id: 'c2', kind: 'image', assetId: 'a2', start: 0, duration: 1000, ...extra,
});
const text = (extra?: Partial<TextClip>): TextClip => ({
  id: 'c3', kind: 'text', start: 0, duration: 1000, text: '안녕',
  style: { fontFamily: 'Pretendard', fontSize: 64, color: '#ffffff', align: 'center' },
  ...extra,
});
const audio = (extra?: Partial<AudioClip>): AudioClip => ({
  id: 'c4', kind: 'audio', assetId: 'a4', start: 0, duration: 1000,
  in: 0, out: 1000, speed: 1, volume: 1, ...extra,
});

// ── 문법 ──────────────────────────────────────────────────────────────────

describe('경로 문법', () => {
  it('유효한 경로', () => {
    for (const p of ['x', 'crop.x', 'mask.feather', 'style.fontSize', 'effects#e1.params.amount',
                     'effects[0].params.amount', 'a_b.c1', 'effects#a-3f.params.px']) {
      expect(isValidKeyframePath(p)).toBe(true);
    }
  });

  it('무효한 경로', () => {
    for (const p of ['', '.x', 'x.', '1x', 'x..y', 'x[]', 'x[a]', 'x#', 'x-y', 'x y', 'x[0', 'a'.repeat(200)]) {
      expect(isValidKeyframePath(p)).toBe(false);
    }
  });
});

// ── readPath ──────────────────────────────────────────────────────────────

describe('readPath', () => {
  it('기존 6종은 transform 별칭·기본값으로 읽는다 (렌더러 폴백과 같은 값)', () => {
    const c = video();
    expect(readPath(c, 'x')).toBe(0);
    expect(readPath(c, 'y')).toBe(0);
    expect(readPath(c, 'scale')).toBe(1);
    expect(readPath(c, 'rotation')).toBe(0);
    expect(readPath(c, 'opacity')).toBe(1);
    expect(readPath(c, 'volume')).toBe(1);
  });

  it('transform 이 있으면 그 값을 읽는다', () => {
    const c = video({ transform: { x: 0.25, y: -0.1, scale: 2, rotation: 45 }, opacity: 0.3, volume: 1.5 });
    expect(readPath(c, 'x')).toBe(0.25);
    expect(readPath(c, 'y')).toBe(-0.1);
    expect(readPath(c, 'scale')).toBe(2);
    expect(readPath(c, 'rotation')).toBe(45);
    expect(readPath(c, 'opacity')).toBe(0.3);
    expect(readPath(c, 'volume')).toBe(1.5);
  });

  it('중첩 경로', () => {
    const c = video({
      crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 },
      mask: { shape: 'rect', feather: 0.35, x: 0, y: 0, w: 1, h: 1 },
      chromaKey: { color: '#00ff00', similarity: 0.4, smoothness: 0.1, spill: 0.5 },
    });
    expect(readPath(c, 'crop.w')).toBe(0.8);
    expect(readPath(c, 'mask.feather')).toBe(0.35);
    expect(readPath(c, 'chromaKey.similarity')).toBe(0.4);
    expect(readPath(c, 'chromaKey.spill')).toBe(0.5);
  });

  it('effects#<id> 는 id 로 고른다 (인덱스가 아니다)', () => {
    const c = video({
      effects: [
        { id: 'e1', type: 'brightness', params: { amount: 1.2 } },
        { id: 'e2', type: 'blur', params: { px: 8 } },
      ],
    });
    expect(readPath(c, 'effects#e1.params.amount')).toBe(1.2);
    expect(readPath(c, 'effects#e2.params.px')).toBe(8);
    expect(readPath(c, 'effects#없는id.params.amount')).toBeUndefined();
  });

  it('배열 인덱스 문법도 파서에는 남아 있다', () => {
    const c = video({ effects: [{ id: 'e1', type: 'brightness', params: { amount: 1.2 } }] });
    expect(readPath(c, 'effects[0].params.amount')).toBe(1.2);
    expect(readPath(c, 'effects[5].params.amount')).toBeUndefined();
  });

  it('없는 경로·타입 불일치는 undefined', () => {
    const c = video({ mask: { shape: 'rect', feather: 0.2, x: 0, y: 0, w: 1, h: 1 } });
    expect(readPath(c, 'mask.wdith')).toBeUndefined();   // 오타
    expect(readPath(c, 'mask.shape')).toBeUndefined();   // 문자열
    expect(readPath(c, 'crop.x')).toBeUndefined();       // crop 자체가 없다
    expect(readPath(video(), 'mask.x')).toBeUndefined(); // mask 자체가 없다
    expect(readPath(c, 'transform')).toBeUndefined();    // 객체는 숫자가 아니다
    expect(readPath(c, 'effects#e1.params.amount')).toBeUndefined();
  });

  it('프로토타입 오염 경로는 따라가지 않는다', () => {
    expect(readPath(video(), '__proto__.x')).toBeUndefined();
    expect(readPath(video(), 'constructor.prototype.x')).toBeUndefined();
  });

  it('숫자가 아니거나 무한대면 undefined', () => {
    expect(readPath({ a: 'x' }, 'a')).toBeUndefined();
    expect(readPath({ a: Infinity }, 'a')).toBeUndefined();
    expect(readPath({ a: NaN }, 'a')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
    expect(readPath(undefined, 'a')).toBeUndefined();
  });
});

// ── writePath ─────────────────────────────────────────────────────────────

describe('writePath', () => {
  it('transform 이 없으면 기본값으로 만들어서 쓴다 (부모를 만드는 유일한 경우)', () => {
    const c = video();
    const out = writePath(c, 'x', 0.5);
    expect(out.transform).toEqual({ x: 0.5, y: 0, scale: 1, rotation: 0 });
    expect(c.transform).toBeUndefined(); // 원본 불변
  });

  it('구조 공유 — 손대지 않은 가지는 «같은 참조»', () => {
    const c = video({
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      crop: { x: 0, y: 0, w: 1, h: 1 },
      effects: [
        { id: 'e1', type: 'brightness', params: { amount: 1 } },
        { id: 'e2', type: 'blur', params: { px: 4 } },
      ],
    });
    const out = writePath(c, 'effects#e1.params.amount', 1.5);
    expect(out).not.toBe(c);
    expect(out.effects).not.toBe(c.effects);
    expect(out.effects![0]).not.toBe(c.effects![0]);
    expect(out.effects![0]!.params).not.toBe(c.effects![0]!.params);
    expect(out.effects![0]!.params.amount).toBe(1.5);
    // 안 건드린 것들은 그대로
    expect(out.effects![1]).toBe(c.effects![1]);
    expect(out.crop).toBe(c.crop);
    expect(out.transform).toBe(c.transform);
    expect(c.effects![0]!.params.amount).toBe(1); // 원본 불변
  });

  it('mask 가 없으면 «무동작» — 같은 객체를 돌려준다', () => {
    const c = video();
    expect(writePath(c, 'mask.x', 0.5)).toBe(c);
    expect(writePath(c, 'crop.x', 0.5)).toBe(c);
    expect(writePath(c, 'chromaKey.similarity', 0.5)).toBe(c);
    expect(writePath(c, 'effects#e1.params.amount', 1)).toBe(c);
  });

  it('값이 같으면 새 객체를 만들지 않는다', () => {
    const c = video({ transform: { x: 0.5, y: 0, scale: 1, rotation: 0 } });
    expect(writePath(c, 'x', 0.5)).toBe(c);
  });

  it('중첩·배열 인덱스', () => {
    const c = video({
      mask: { shape: 'circle', feather: 0.1, x: 0, y: 0, w: 1, h: 1 },
      effects: [{ id: 'e1', type: 'blur', params: { px: 0 } }],
    });
    expect(writePath(c, 'mask.feather', 0.9).mask!.feather).toBe(0.9);
    expect(writePath(c, 'effects[0].params.px', 20).effects![0]!.params.px).toBe(20);
  });

  it('프로토타입 오염을 막는다', () => {
    const c = video();
    const out = writePath(c, '__proto__.polluted', 1);
    expect(out).toBe(c);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(writePath(c, 'constructor.prototype.x', 1)).toBe(c);
  });

  it('문법이 틀렸거나 값이 유한하지 않으면 무동작', () => {
    const c = video();
    expect(writePath(c, 'x.', 1)).toBe(c);
    expect(writePath(c, 'x', NaN)).toBe(c);
    expect(writePath(c, 'x', Infinity)).toBe(c);
  });

  it('쓴 뒤 readPath 로 되읽으면 같은 값', () => {
    const c = video({ mask: { shape: 'rect', feather: 0, x: 0, y: 0, w: 1, h: 1 } });
    const out = writePath(c, 'mask.x', 0.42);
    expect(readPath(out, 'mask.x')).toBe(0.42);
  });
});

// ── 화이트리스트 ──────────────────────────────────────────────────────────

describe('isKeyframablePath', () => {
  it('video: 기존 6종 + crop/mask/chromaKey/effects', () => {
    for (const p of ['x', 'y', 'scale', 'rotation', 'opacity', 'volume',
                     'crop.x', 'crop.y', 'crop.w', 'crop.h',
                     'mask.x', 'mask.y', 'mask.w', 'mask.h', 'mask.feather',
                     'chromaKey.similarity', 'chromaKey.smoothness', 'chromaKey.spill',
                     'effects#e1.params.amount', 'effects#e1.params.px']) {
      expect(isKeyframablePath('video', p), p).toBe(true);
    }
  });

  it('image: volume·chromaKey 없음', () => {
    expect(isKeyframablePath('image', 'x')).toBe(true);
    expect(isKeyframablePath('image', 'crop.w')).toBe(true);
    expect(isKeyframablePath('image', 'mask.feather')).toBe(true);
    expect(isKeyframablePath('image', 'volume')).toBe(false);
    expect(isKeyframablePath('image', 'chromaKey.similarity')).toBe(false);
  });

  it('text: style.* 는 되고 crop.* 는 안 된다 (걸어도 아무 일이 안 일어나므로)', () => {
    for (const p of ['style.fontSize', 'style.letterSpacing', 'style.strokeWidth', 'style.lineHeight']) {
      expect(isKeyframablePath('text', p), p).toBe(true);
    }
    expect(isKeyframablePath('text', 'crop.x')).toBe(false);
    expect(isKeyframablePath('text', 'volume')).toBe(false);
    expect(isKeyframablePath('text', 'mask.x')).toBe(false);
  });

  it('audio: volume 하나뿐', () => {
    expect(isKeyframablePath('audio', 'volume')).toBe(true);
    for (const p of ['x', 'y', 'scale', 'rotation', 'opacity', 'effects#e1.params.amount']) {
      expect(isKeyframablePath('audio', p), p).toBe(false);
    }
  });

  it('source.* 는 전 클립 종류에서 거부 — 파일을 굽는 스펙이라서', () => {
    for (const kind of ['video', 'image', 'text', 'audio'] as const) {
      expect(isKeyframablePath(kind, 'source.lut.intensity')).toBe(false);
      expect(isKeyframablePath(kind, 'source.denoise.amount')).toBe(false);
      expect(isKeyframablePath(kind, 'source.pitch.semitones')).toBe(false);
    }
    const msg = keyframePathRejection('video', 'source.lut.intensity');
    expect(msg).toContain('영상 파일을 새로 굽는 설정');
    expect(msg).toContain('effects');
  });

  it('그 밖의 금지 경로', () => {
    for (const p of ['speed', 'speedRamp.points', 'curves.rgb', 'start', 'duration', 'in', 'out',
                     'fadeIn', 'fadeOut', 'transitionIn.duration', 'mask.invert', 'mask.wdith',
                     '__proto__.x', 'constructor.prototype.x', 'effects[0].params.amount']) {
      expect(isKeyframablePath('video', p), p).toBe(false);
    }
  });

  it('effects 는 인덱스가 아니라 id 로만 — 거부 사유가 그 이유를 말한다', () => {
    expect(keyframePathRejection('video', 'effects[0].params.amount')).toContain('id 로 가리킵니다');
  });

  it('와일드카드는 파라미터 이름을 가리지 않는다 (경로 깊이가 달라지면 거부)', () => {
    expect(isKeyframablePath('video', 'effects#e1.params')).toBe(false);
    expect(isKeyframablePath('video', 'effects#e1.params.a.b')).toBe(false);
    expect(isKeyframablePath('video', 'effects#e1.type')).toBe(false);
  });

  it('KEYFRAME_PATHS 는 클립 종류 4개를 전부 덮는다', () => {
    expect(Object.keys(KEYFRAME_PATHS).sort()).toEqual(['audio', 'image', 'text', 'video']);
  });

  it('keyframePathLabel: 한국어 라벨', () => {
    expect(keyframePathLabel('video', 'x')).toBe('X 위치');
    expect(keyframePathLabel('video', 'mask.feather')).toBe('마스크 흐림');
    expect(keyframePathLabel('video', 'effects#e1.params.amount')).toBe('효과 amount');
    expect(keyframePathLabel('video', 'nope')).toBe('nope');
  });
});

// ── 스키마 통합 ───────────────────────────────────────────────────────────

describe('KeyframeSchema — prop 이 경로 문자열이 됐다', () => {
  function docWithProp(prop: string): unknown {
    const doc = createEmptyProject({ name: '경로' });
    doc.assets['a1'] = { id: 'a1', kind: 'video', src: 'media/a.mp4', name: 'a.mp4', duration: 5000 };
    doc.tracks[0]!.clips.push(video({ keyframes: [{ time: 0, prop, value: 1, easing: 'linear' }] }));
    return JSON.parse(JSON.stringify(doc));
  }

  it('기존 6종 문서는 그대로 통과', () => {
    for (const p of ['x', 'y', 'scale', 'rotation', 'opacity', 'volume']) {
      expect(ProjectDocSchema.safeParse(docWithProp(p)).success, p).toBe(true);
    }
  });

  it('경로 문자열도 통과 (허용 목록 검사는 엔진이 한다)', () => {
    for (const p of ['effects#e1.params.amount', 'mask.feather', 'style.fontSize']) {
      expect(ProjectDocSchema.safeParse(docWithProp(p)).success, p).toBe(true);
    }
  });

  it('문법 위반은 스키마가 거부', () => {
    for (const p of ['', '.x', 'x-y', 'x y', '1x']) {
      expect(ProjectDocSchema.safeParse(docWithProp(p)).success, p).toBe(false);
    }
  });

  it('audio 클립 픽스처도 정상 (kind 별 타입 확인용)', () => {
    expect(readPath(audio(), 'volume')).toBe(1);
    expect(readPath(image(), 'scale')).toBe(1);
    expect(readPath(text(), 'style.fontSize')).toBe(64);
  });
});
