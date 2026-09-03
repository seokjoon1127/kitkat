// W8 F8(키네틱 타이포) · F9(자유 마스크) — 스키마 쪽 검증.
//
// 여기서 지키는 것은 두 가지다.
//  1. **기존 문서가 한 글자도 안 바뀐 채 통과한다** — 새 필드는 전부 optional 이다.
//  2. **어긋난 조합·이상한 `d` 는 조용히 통과하지 않는다** — 특히 CSS 주입.
import { describe, expect, it } from 'vitest';
import {
  createEmptyProject,
  isValidMaskPathD,
  KINETIC_PRESETS,
  maskPathRejection,
  maskPathSignature,
  parseMaskPathD,
  TEXT_ANIM_DEFAULT_STAGGER,
  TEXT_ANIM_ORIGINS,
  TEXT_ANIM_TYPES,
  TEXT_ANIM_UNITS,
  textAnimUnits,
  validateDoc,
} from '../src/index.js';
import type { ImageClip, Mask, ProjectDoc, TextAnim, TextClip, VideoClip } from '../src/index.js';

function docWithText(anim: Partial<TextAnim> & { type: TextAnim['type'] }): unknown {
  const doc = createEmptyProject({ name: 't', width: 1080, height: 1920, fps: 30 });
  const clip: TextClip = {
    id: 'tx1', kind: 'text', start: 0, duration: 3000, text: '안녕하세요 여러분',
    style: { fontFamily: 'sans-serif', fontSize: 60, color: '#fff', align: 'center' },
    animationIn: { duration: 800, ...anim },
    words: [{ text: '안녕', start: 0, duration: 500 }],
  };
  doc.tracks.find((t) => t.kind === 'text')!.clips.push(clip);
  return doc;
}

function docWithMask(mask: Mask | Mask[]): unknown {
  const doc = createEmptyProject({ name: 'm', width: 1080, height: 1920, fps: 30 });
  doc.assets.a1 = { id: 'a1', kind: 'image', src: 'a.png', name: 'a', width: 1080, height: 1920 };
  const clip: ImageClip = {
    id: 'im1', kind: 'image', assetId: 'a1', start: 0, duration: 1000,
    ...(Array.isArray(mask) ? { masks: mask } : { mask }),
  };
  doc.tracks.find((t) => t.kind === 'video')!.clips.push(clip);
  return doc;
}

const ok = (d: unknown): ProjectDoc => validateDoc(d);
const bad = (d: unknown): void => expect(() => validateDoc(d)).toThrow();

const PATH = (d: string): Mask => ({ shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1, d });

describe('F8 — 텍스트 애니메이션 20종 · 두 축', () => {
  it('v1 5종은 값·의미·자리가 그대로다', () => {
    expect(TEXT_ANIM_TYPES.slice(0, 5)).toEqual([
      'fade', 'slideUp', 'popIn', 'typewriter', 'wordHighlight',
    ]);
    expect(TEXT_ANIM_TYPES).toHaveLength(21);
  });

  it('단위 4종과 단위별 기본 시차', () => {
    expect(TEXT_ANIM_UNITS).toEqual(['all', 'line', 'word', 'char']);
    expect(TEXT_ANIM_DEFAULT_STAGGER).toEqual({ all: 0, line: 120, word: 60, char: 30 });
    expect(TEXT_ANIM_ORIGINS).toEqual(['start', 'end', 'center', 'random']);
  });

  it('typewriter=글자 · wordHighlight=단어 · drawStroke=전체·글자 로 고정 — 나머지 18종은 4종 전부', () => {
    expect(textAnimUnits('typewriter')).toEqual(['char']);
    expect(textAnimUnits('wordHighlight')).toEqual(['word']);
    // 획은 글자 단위로만 의미가 있다. 'all' 은 「모든 글자가 동시에」(시차 0)라는 뜻이다.
    expect(textAnimUnits('drawStroke')).toEqual(['all', 'char']);
    const free = TEXT_ANIM_TYPES.filter(
      (t) => t !== 'typewriter' && t !== 'wordHighlight' && t !== 'drawStroke',
    );
    expect(free).toHaveLength(18);
    for (const t of free) expect(textAnimUnits(t)).toEqual(['all', 'line', 'word', 'char']);
  });

  it('v1 문서 `{type,duration}` 는 그대로 유효하다 (새 필드가 전부 optional)', () => {
    for (const type of ['fade', 'slideUp', 'popIn', 'typewriter', 'wordHighlight'] as const) {
      const doc = ok(docWithText({ type }));
      const clip = doc.tracks.find((t) => t.kind === 'text')!.clips[0] as TextClip;
      expect(clip.animationIn).toEqual({ type, duration: 800 });
    }
  });

  it('유효 조합 76가지(18×4 + 1 + 1 + 2)가 전부 통과한다', () => {
    let n = 0;
    for (const type of TEXT_ANIM_TYPES) {
      for (const unit of textAnimUnits(type)) {
        ok(docWithText({ type, unit }));
        n++;
      }
    }
    expect(n).toBe(76);
  });

  it('어긋난 조합은 거부한다 — 조용히 무시하지 않는다', () => {
    bad(docWithText({ type: 'typewriter', unit: 'word' }));
    bad(docWithText({ type: 'typewriter', unit: 'all' }));
    bad(docWithText({ type: 'wordHighlight', unit: 'char' }));
    bad(docWithText({ type: 'drawStroke', unit: 'word' }));
    bad(docWithText({ type: 'drawStroke', unit: 'line' }));
  });

  it('시차·이동량·순서·이징이 문서에 실린다', () => {
    const doc = ok(
      docWithText({
        type: 'springUp', unit: 'char', staggerMs: 30, distance: 24,
        origin: 'random', easing: { spring: { damping: 8 } },
      }),
    );
    const clip = doc.tracks.find((t) => t.kind === 'text')!.clips[0] as TextClip;
    expect(clip.animationIn).toMatchObject({ unit: 'char', staggerMs: 30, origin: 'random' });
  });

  it('키네틱 프리셋 12종이 전부 유효한 조합이다', () => {
    expect(KINETIC_PRESETS.length).toBe(12);
    expect(KINETIC_PRESETS.map((p) => p.id)).toContain('brush');
    for (const p of KINETIC_PRESETS) {
      expect(textAnimUnits(p.anim.type)).toContain(p.anim.unit ?? 'all');
      ok(docWithText(p.anim));
    }
  });

  // (뒤집힌 테스트) remotion 이 4.0.520 으로 맞춰지기 전에는 «거부되는지» 를 확인했다.
  // 이제는 **받아들여야** 한다 — 목록 맨 뒤에 있고, 문서에 실리고, 글자 단위로만 쓸 수 있다.
  it('drawStroke 는 이제 유효하다 — 목록 맨 뒤 · 문서 통과 · 단위는 전체/글자', () => {
    expect((TEXT_ANIM_TYPES as readonly string[]).includes('drawStroke')).toBe(true);
    expect(TEXT_ANIM_TYPES[TEXT_ANIM_TYPES.length - 1]).toBe('drawStroke');
    const doc = ok(docWithText({ type: 'drawStroke', unit: 'char', staggerMs: 90 }));
    const clip = doc.tracks.find((t) => t.kind === 'text')!.clips[0] as TextClip;
    expect(clip.animationIn).toMatchObject({ type: 'drawStroke', unit: 'char', staggerMs: 90 });
    ok(docWithText({ type: 'drawStroke', unit: 'all' }));
    ok(docWithText({ type: 'drawStroke' }));
  });
});

describe('F9 — 자유 마스크 `d` 문법 · CSS 주입 차단', () => {
  // 계획 09 §검증 6 의 표를 그대로 옮긴 것이다.
  it('허용: M L C Q Z 와 숫자', () => {
    expect(isValidMaskPathD('M 0,0 L 1,0 L 1,1 Z')).toBe(true);
    expect(isValidMaskPathD('M0,0 C0.1,0.2 0.3,0.4 1,1 Z')).toBe(true);
    expect(isValidMaskPathD('M0,0 Q0.5,0.5 1,1')).toBe(true);
    expect(isValidMaskPathD('M 0,0 L 1e-3,0 L 1,1 Z')).toBe(true);
  });

  it('거부: 호(A) — 파서를 늘리는 대신 원은 C 4개로 근사한다', () => {
    expect(isValidMaskPathD('M 0,0 A 1 1 0 0 1 1,1')).toBe(false);
    expect(maskPathRejection('M 0,0 A 1 1 0 0 1 1,1')).toContain('M L C Q Z');
  });

  it('거부: 축약형 H V S T', () => {
    for (const d of ['M0,0 H1', 'M0,0 V1', 'M0,0 S1,1 1,1', 'M0,0 T1,1']) {
      expect(isValidMaskPathD(d)).toBe(false);
    }
  });

  it('거부: CSS 주입 시도', () => {
    const evil = 'M 0,0 L 1,0") ; background:url(evil';
    expect(isValidMaskPathD(evil)).toBe(false);
    expect(maskPathRejection(evil)).not.toBeNull();
    bad(docWithMask(PATH(evil)));
  });

  it('거부: 길이 상한 4000자 · 명령 500개', () => {
    expect(isValidMaskPathD('M0,0 ' + 'L1,1 '.repeat(900))).toBe(false); // 길이
    expect(maskPathRejection('M0,0 ' + 'L1,1 '.repeat(900))).toContain('너무 깁니다');
  });

  it('거부: NaN · Infinity · 유한하지 않은 수', () => {
    expect(isValidMaskPathD('M 0,0 L NaN,0')).toBe(false);
    expect(isValidMaskPathD('M 0,0 L 1e999,0')).toBe(false);
    expect(isValidMaskPathD('M 0,0 L Infinity,0')).toBe(false);
  });

  it('거부: 인자 개수가 안 맞거나 M 으로 시작하지 않는 경로', () => {
    expect(isValidMaskPathD('L 0,0')).toBe(false);
    expect(isValidMaskPathD('M 0')).toBe(false);
    expect(isValidMaskPathD('M 0,0 C 1,1 2,2')).toBe(false);
  });

  it('parseMaskPathD 는 명령·좌표를 그대로 돌려준다', () => {
    expect(parseMaskPathD('M0,0 L1,0 Z')).toEqual([
      { cmd: 'M', nums: [0, 0] },
      { cmd: 'L', nums: [1, 0] },
      { cmd: 'Z', nums: [] },
    ]);
    expect(maskPathSignature('M0,0 C0,0 1,1 1,1 Z')).toBe('MCZ');
  });
});

describe('F9 — Mask 스키마', () => {
  it('기존 3종은 그대로 유효하다', () => {
    for (const shape of ['rect', 'circle', 'linear'] as const) {
      ok(docWithMask({ shape, feather: 0.2, x: 0, y: 0, w: 1, h: 1 }));
    }
  });

  it("shape:'path' 인데 d 가 없으면 거부", () => {
    bad(docWithMask({ shape: 'path', feather: 0, x: 0, y: 0, w: 1, h: 1 }));
  });

  it('masks[] 는 8장까지, 빈 배열은 거부', () => {
    const one = PATH('M0,0 L1,0 L1,1 Z');
    ok(docWithMask([one, { ...one, op: 'subtract' }]));
    ok(docWithMask(Array.from({ length: 8 }, () => one)));
    bad(docWithMask(Array.from({ length: 9 }, () => one)));
    bad(docWithMask([]));
  });

  it('dKeys — 정점 수가 같으면 통과, 다르면 거부한다(조용히 이상한 값을 내지 않는다)', () => {
    const a = 'M0,0 L1,0 L1,1 Z';
    const b = 'M0.1,0.1 L0.9,0.1 L0.9,0.9 Z';
    const c = 'M0,0 L1,0 L1,1 L0,1 Z'; // 점이 하나 더 많다
    ok(docWithMask({ ...PATH(a), dKeys: [{ time: 0, d: a }, { time: 500, d: b }] }));
    bad(docWithMask({ ...PATH(a), dKeys: [{ time: 0, d: a }, { time: 500, d: c }] }));
  });

  it('dKeys 는 time 오름차순이어야 하고 path 마스크에만 쓸 수 있다', () => {
    const a = 'M0,0 L1,0 L1,1 Z';
    bad(docWithMask({ ...PATH(a), dKeys: [{ time: 500, d: a }, { time: 100, d: a }] }));
    bad(docWithMask({
      shape: 'rect', feather: 0, x: 0, y: 0, w: 1, h: 1,
      dKeys: [{ time: 0, d: a }, { time: 100, d: a }],
    } as Mask));
  });

  it('op 3종과 invert 가 실린다', () => {
    const doc = ok(docWithMask([
      PATH('M0,0 L1,0 L1,1 Z'),
      { ...PATH('M0,0 L1,0 L1,1 Z'), op: 'subtract', invert: true },
    ]));
    const clip = doc.tracks.find((t) => t.kind === 'video')!.clips[0] as VideoClip;
    expect(clip.masks?.[1]).toMatchObject({ op: 'subtract', invert: true });
  });
});
