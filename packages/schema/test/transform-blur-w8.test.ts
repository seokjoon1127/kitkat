// W8 F3-B — ClipBase.transformBlur 스키마.
// 합성 단계에서 겹쳐 그리는 블러라 파생 파일을 굽지 않는다 → sourceKey 에 **들어가면 안 된다**.
import { describe, expect, it } from 'vitest';
import {
  TransformBlurSchema,
  createEmptyProject,
  sourceKey,
  validateDoc,
  type AudioClip,
  type ImageClip,
  type ProjectDoc,
  type TextClip,
  type VideoClip,
} from '../src/index.js';

function docWith(clip: VideoClip | ImageClip | TextClip | AudioClip): ProjectDoc {
  const doc = createEmptyProject({ name: '테스트' });
  doc.assets['a1'] = { id: 'a1', kind: 'video', src: 'a.mp4', name: 'a.mp4', duration: 5000,
                       width: 1080, height: 1920 };
  const kind = clip.kind === 'audio' ? 'audio' : clip.kind === 'text' ? 'text' : 'video';
  const track = doc.tracks.find((t) => t.kind === kind);
  if (!track) throw new Error(`${kind} 트랙이 없다`);
  track.clips.push(clip as never);
  return doc;
}

const video = (extra?: Partial<VideoClip>): VideoClip => ({
  id: 'c1', kind: 'video', assetId: 'a1',
  start: 0, duration: 1000, in: 0, out: 1000, speed: 1, volume: 1,
  ...extra,
});

const text = (extra?: Partial<TextClip>): TextClip => ({
  id: 't1', kind: 'text', text: '안녕', start: 0, duration: 1000,
  style: { fontFamily: 'Pretendard', fontSize: 64, color: '#ffffff', align: 'center' },
  ...extra,
});

describe('TransformBlurSchema', () => {
  it('기본 조합(180° · 12장)을 통과시킨다', () => {
    expect(TransformBlurSchema.parse({ shutterAngle: 180, samples: 12 })).toEqual({
      shutterAngle: 180, samples: 12,
    });
  });

  it('셔터 각도는 0~360 (밖은 거부한다 — 조용히 클램프하지 않는다)', () => {
    expect(() => TransformBlurSchema.parse({ shutterAngle: 0, samples: 8 })).not.toThrow();
    expect(() => TransformBlurSchema.parse({ shutterAngle: 360, samples: 8 })).not.toThrow();
    expect(() => TransformBlurSchema.parse({ shutterAngle: -1, samples: 8 })).toThrow();
    expect(() => TransformBlurSchema.parse({ shutterAngle: 361, samples: 8 })).toThrow();
  });

  it('samples 는 4~32 정수 — 4 미만은 계단이 보이고 32 초과는 시간만 든다', () => {
    expect(() => TransformBlurSchema.parse({ shutterAngle: 180, samples: 4 })).not.toThrow();
    expect(() => TransformBlurSchema.parse({ shutterAngle: 180, samples: 32 })).not.toThrow();
    expect(() => TransformBlurSchema.parse({ shutterAngle: 180, samples: 3 })).toThrow();
    expect(() => TransformBlurSchema.parse({ shutterAngle: 180, samples: 33 })).toThrow();
    expect(() => TransformBlurSchema.parse({ shutterAngle: 180, samples: 12.5 })).toThrow();
  });
});

describe('transformBlur 는 어떤 시각 클립에든 걸린다', () => {
  it('비디오 클립', () => {
    expect(() => validateDoc(docWith(video({ transformBlur: { shutterAngle: 180, samples: 12 } })))).not.toThrow();
  });

  it('이미지 클립 (켄번스 줌이 여기서 제일 티 난다)', () => {
    const img: ImageClip = { id: 'i1', kind: 'image', assetId: 'a1', start: 0, duration: 1000,
                             transformBlur: { shutterAngle: 270, samples: 16 } };
    expect(() => validateDoc(docWith(img))).not.toThrow();
  });

  it('텍스트 클립 (글자가 날아 들어올 때 블러가 걸리는 게 「비싸 보이는」 이유다)', () => {
    expect(() => validateDoc(docWith(text({ transformBlur: { shutterAngle: 180, samples: 12 } })))).not.toThrow();
  });

  it('오디오 클립에는 없다 — 소리에 모션 블러는 말이 안 되므로 파싱하면서 떨어져 나간다', () => {
    const audio = { id: 'au1', kind: 'audio', assetId: 'a1', start: 0, duration: 1000,
                    in: 0, out: 1000, speed: 1, volume: 1,
                    transformBlur: { shutterAngle: 180, samples: 12 } } as unknown as AudioClip;
    const parsed = validateDoc(docWith(audio));
    const clip = parsed.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    expect(clip).not.toHaveProperty('transformBlur');
  });

  it('없어도 된다 — 기존 문서가 그대로 유효하다', () => {
    expect(() => validateDoc(docWith(video()))).not.toThrow();
  });

  it('범위를 벗어난 값은 문서째 거부된다', () => {
    expect(() => validateDoc(docWith(video({ transformBlur: { shutterAngle: 400, samples: 12 } })))).toThrow();
  });
});

describe('transformBlur 는 파생 파일을 굽지 않는다', () => {
  it('sourceKey 를 바꾸지 않는다 (합성 단계 블러라 ffmpeg 를 안 돌린다)', () => {
    const plain = video({ source: { denoise: { amount: 0.5 } } });
    const blurred = video({
      source: { denoise: { amount: 0.5 } },
      transformBlur: { shutterAngle: 360, samples: 32 },
    });
    expect(sourceKey(blurred)).toBe(sourceKey(plain));
  });

  it('source 가 없으면 transformBlur 만으로는 sourceKey 가 생기지 않는다', () => {
    expect(sourceKey(video({ transformBlur: { shutterAngle: 180, samples: 12 } }))).toBeNull();
  });
});
