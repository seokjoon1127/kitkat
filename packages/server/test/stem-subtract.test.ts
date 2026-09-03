// W8 F17 V5-6 — 스템 뺄셈(「전체 − 트리거 = 눌릴 스템」)의 «순수» 부분.
// 실렌더 비트 동일성은 scripts/w8-f17-stem-subtract-check.mjs 가 재고, 그 숫자를 보고서에 남긴다.
import { describe, expect, it } from 'vitest';
import { createEmptyProject, type AudioClip, type ProjectDoc, type VideoClip } from '@kitkat/schema';
import {
  SIDECHAIN_STAGE_WEIGHTS,
  SIDECHAIN_SUBTRACT_STAGE_WEIGHTS,
  SUBTRACT_GRAPH,
  audioSourceTrackIds,
  canSubtractStems,
  countFullScaleInt16,
  estimateSidechainSeconds,
  findDuckPairs,
  findWavDataChunk,
  pcmShapesMatch,
} from '../src/sidechain.js';

const DUCK = { amount: 0.25, attackMs: 400, releaseMs: 400 };

function audioClip(id: string, over: Partial<AudioClip> = {}): AudioClip {
  return {
    id, kind: 'audio', assetId: 'a1', start: 0, duration: 5000,
    in: 0, out: 5000, speed: 1, volume: 1, ...over,
  } as AudioClip;
}

function videoClip(id: string, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id, kind: 'video', assetId: 'v1', start: 0, duration: 5000,
    in: 0, out: 5000, speed: 1, volume: 1, ...over,
  } as VideoClip;
}

/** 비디오·텍스트 트랙 + 음악(눌릴) + 나레이션(트리거). 기본값이 «뺄셈 가능» 이다. */
function twoTrackDoc(): ProjectDoc {
  const doc = createEmptyProject({ name: 'sub' });
  doc.tracks = [
    { id: 'tv', kind: 'video', name: '비디오', clips: [] },
    { id: 'tt', kind: 'text', name: '텍스트', clips: [] },
    { id: 'music', kind: 'audio', name: '음악', clips: [audioClip('m1')],
      duckedBy: 'narr', duck: { ...DUCK } },
    { id: 'narr', kind: 'audio', name: '나레이션', clips: [audioClip('n1')] },
  ];
  return doc;
}

const decide = (doc: ProjectDoc, opts?: { transparent?: boolean }) =>
  canSubtractStems(doc, findDuckPairs(doc), opts);

describe('audioSourceTrackIds — «소리 나는» 트랙 세기', () => {
  it('클립이 있고 음소거·볼륨0·hidden 이 아닌 트랙만 센다', () => {
    expect(audioSourceTrackIds(twoTrackDoc())).toEqual(['music', 'narr']);
  });

  it('클립이 없는 오디오 트랙은 소리를 안 낸다', () => {
    const doc = twoTrackDoc();
    doc.tracks.push({ id: 'empty', kind: 'audio', name: '빈 트랙', clips: [] });
    expect(audioSourceTrackIds(doc)).toEqual(['music', 'narr']);
  });

  it('muted · 트랙볼륨 0 · hidden 은 빠진다 (hidden 은 컴포지션에서 통째로 빠진다)', () => {
    for (const patch of [{ muted: true }, { volume: 0 }, { hidden: true }]) {
      const doc = twoTrackDoc();
      doc.tracks.push({ id: 'x', kind: 'audio', name: 'x', clips: [audioClip('x1')], ...patch });
      expect(audioSourceTrackIds(doc)).toEqual(['music', 'narr']);
    }
  });

  it('클립 볼륨 0 은 안 세지만 volume 키프레임이 0 을 넘으면 «난다»로 센다', () => {
    const doc = twoTrackDoc();
    doc.tracks.push({ id: 'x', kind: 'audio', name: 'x', clips: [audioClip('x1', { volume: 0 })] });
    expect(audioSourceTrackIds(doc)).toEqual(['music', 'narr']);

    const doc2 = twoTrackDoc();
    doc2.tracks.push({ id: 'x', kind: 'audio', name: 'x', clips: [
      audioClip('x1', { volume: 0, keyframes: [{ time: 0, prop: 'volume', value: 0.8, easing: 'linear' }] }),
    ] });
    expect(audioSourceTrackIds(doc2)).toEqual(['music', 'narr', 'x']);
  });

  it('텍스트·이미지 클립은 소리가 없다', () => {
    const doc = twoTrackDoc();
    doc.tracks[1]!.clips.push({
      id: 't1', kind: 'text', start: 0, duration: 1000, text: 'hi',
      style: { fontFamily: 'f', fontSize: 10, color: '#fff', align: 'center' },
    } as never);
    expect(audioSourceTrackIds(doc)).toEqual(['music', 'narr']);
  });
});

describe('canSubtractStems — 적용 조건', () => {
  it('더킹 쌍 1개 + 소리 나는 트랙이 정확히 그 2개면 쓴다', () => {
    expect(decide(twoTrackDoc())).toEqual({ ok: true });
  });

  it('쌍이 0개면 안 쓴다', () => {
    const doc = twoTrackDoc();
    delete doc.tracks[2]!.duck;
    const d = decide(doc);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toMatch(/더킹 쌍이 1개가 아니다 \(0쌍\)/);
  });

  it('쌍이 2개면 안 쓴다 — 「전체 − 트리거」가 어느 트랙인지 정할 수 없다', () => {
    const doc = twoTrackDoc();
    doc.tracks.push({ id: 'sfx', kind: 'audio', name: '효과음', clips: [audioClip('s1')],
                      duckedBy: 'narr', duck: { ...DUCK } });
    const d = decide(doc);
    expect(d.ok === false && d.reason).toMatch(/더킹 쌍이 1개가 아니다 \(2쌍\)/);
  });

  it('오디오 트랙이 3개면 안 쓴다 — 더킹하면 안 되는 트랙까지 섞인다', () => {
    const doc = twoTrackDoc();
    doc.tracks.push({ id: 'sfx', kind: 'audio', name: '효과음', clips: [audioClip('s1')] });
    const d = decide(doc);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toMatch(/소리 나는 오디오 트랙이 2개가 아니다 \(3개\)/);
  });

  it('셋째 트랙을 음소거하면 다시 쓸 수 있다', () => {
    const doc = twoTrackDoc();
    doc.tracks.push({ id: 'sfx', kind: 'audio', name: '효과음', muted: true, clips: [audioClip('s1')] });
    expect(decide(doc)).toEqual({ ok: true });
  });

  it('소리 나는 두 트랙이 더킹 쌍이 «아니면» 안 쓴다', () => {
    const doc = twoTrackDoc();
    // 음악은 소리를 안 내고(빈 클립), 관계없는 효과음 트랙이 소리를 낸다
    doc.tracks[2]!.clips = [];
    doc.tracks.push({ id: 'sfx', kind: 'audio', name: '효과음', clips: [audioClip('s1')] });
    const d = decide(doc);
    expect(d.ok === false && d.reason).toMatch(/소리 나는 두 트랙이 더킹 쌍과 다르다/);
  });

  it('소리 내는 비디오 클립이 있으면 안 쓴다 (프록시로 음원이 갈린다)', () => {
    const doc = twoTrackDoc();
    doc.tracks[0]!.clips.push(videoClip('v1'));
    const d = decide(doc);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toMatch(/소리 내는 비디오 클립이 있다/);
  });

  it('소리 없는 비디오 클립(볼륨 0)은 막지 않는다 — 흔한 영상+음악+나레이션이 빠른 길로 간다', () => {
    const doc = twoTrackDoc();
    doc.tracks[0]!.clips.push(videoClip('v1', { volume: 0 }));
    expect(decide(doc)).toEqual({ ok: true });
  });

  it('알파(투명) 출력이면 안 쓴다 — pcm-16 전체 믹스를 실측하지 않았다', () => {
    const d = decide(twoTrackDoc(), { transparent: true });
    expect(d.ok === false && d.reason).toMatch(/알파\(투명\) 출력/);
  });
});

describe('뺄셈 필터그래프', () => {
  it('위상 반전 뒤 amix — normalize=0 이 없으면 값이 반토막 난다', () => {
    expect(SUBTRACT_GRAPH).toBe(
      '[1:a]volume=-1[neg];[0:a][neg]amix=inputs=2:duration=longest:normalize=0[out]',
    );
  });
});

describe('countFullScaleInt16 — 포화 표본 세기', () => {
  const of = (...v: number[]): Buffer => {
    const b = Buffer.alloc(v.length * 2);
    v.forEach((x, i) => b.writeInt16LE(x, i * 2));
    return b;
  };

  it('안 잘린 표본은 0 으로 센다', () => {
    expect(countFullScaleInt16(of(0, 100, -100, 32766, -32767))).toEqual({ full: 0, total: 5 });
  });

  it('+32767 과 −32768 을 «둘 다» 센다 (astats 의 Peak count 는 한쪽만 센다)', () => {
    expect(countFullScaleInt16(of(32767, -32768, 0, 32767))).toEqual({ full: 3, total: 4 });
  });

  it('짝수 바이트만 본다 (홀수 꼬리는 버린다)', () => {
    const b = Buffer.concat([of(32767), Buffer.from([0x7f])]);
    expect(countFullScaleInt16(b)).toEqual({ full: 1, total: 1 });
  });

  it('빈 버퍼는 0/0', () => {
    expect(countFullScaleInt16(Buffer.alloc(0))).toEqual({ full: 0, total: 0 });
  });
});

describe('findWavDataChunk', () => {
  const chunk = (id: string, size: number): Buffer => {
    const b = Buffer.alloc(8 + size + (size % 2));
    b.write(id, 0, 'ascii');
    b.writeUInt32LE(size, 4);
    return b;
  };
  const riff = (...chunks: Buffer[]): Buffer => {
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'ascii');
    head.write('WAVE', 8, 'ascii');
    return Buffer.concat([head, ...chunks]);
  };

  it('fmt 뒤의 data 를 찾는다 (표준 44바이트 헤더)', () => {
    expect(findWavDataChunk(riff(chunk('fmt ', 16), chunk('data', 400)))).toEqual({
      offset: 44, size: 400,
    });
  });

  it('LIST 같은 청크가 끼어 있어도 찾는다 — 순서를 가정하지 않는다', () => {
    const r = riff(chunk('fmt ', 16), chunk('LIST', 26), chunk('data', 8));
    expect(findWavDataChunk(r)).toEqual({ offset: 12 + 24 + 34 + 8, size: 8 });
  });

  it('홀수 크기 청크는 1바이트 패딩을 건너뛴다', () => {
    const r = riff(chunk('fmt ', 16), chunk('junk', 3), chunk('data', 2));
    expect(findWavDataChunk(r)).toEqual({ offset: 12 + 24 + 12 + 8, size: 2 });
  });

  it('RIFF/WAVE 가 아니거나 data 가 없으면 null', () => {
    expect(findWavDataChunk(Buffer.alloc(64))).toBeNull();
    expect(findWavDataChunk(riff(chunk('fmt ', 16)))).toBeNull();
  });
});

describe('pcmShapesMatch — 표본 정렬', () => {
  const s = { sampleRate: 48000, channels: 2, samples: 240_000 };
  it('셋이 모두 같아야 한다', () => {
    expect(pcmShapesMatch(s, { ...s })).toBe(true);
    expect(pcmShapesMatch(s, { ...s, samples: 239_999 })).toBe(false);
    expect(pcmShapesMatch(s, { ...s, channels: 1 })).toBe(false);
    expect(pcmShapesMatch(s, { ...s, sampleRate: 44_100 })).toBe(false);
  });
});

describe('예상 시간·단계 가중치', () => {
  it('뺄셈이면 스템이 한 장 — 32% 짧다', () => {
    const three = estimateSidechainSeconds(5000);
    const two = estimateSidechainSeconds(5000, { subtract: true });
    expect(three).toBe(65);   // 22.24 + 21×2 + 0.72
    expect(two).toBe(44);     // 22.24 + 21×1 + 0.72
    expect(1 - two / three).toBeGreaterThan(0.31);
  });

  it('기본값은 그대로 3패스 (기존 호출자가 안 바뀐다)', () => {
    expect(estimateSidechainSeconds(5000, {})).toBe(estimateSidechainSeconds(5000));
  });

  it('뺄셈 경로의 단계는 3개 — 눌릴 스템 단계가 없다', () => {
    expect(SIDECHAIN_STAGE_WEIGHTS).toHaveLength(4);
    expect(SIDECHAIN_SUBTRACT_STAGE_WEIGHTS).toHaveLength(3);
    expect(SIDECHAIN_SUBTRACT_STAGE_WEIGHTS.reduce((a, b) => a + b, 0)).toBeLessThan(
      SIDECHAIN_STAGE_WEIGHTS.reduce((a, b) => a + b, 0),
    );
  });
});
