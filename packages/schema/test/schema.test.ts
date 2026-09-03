import { describe, expect, it } from 'vitest';
import {
  EFFECT_TYPES,
  FONT_FALLBACK,
  FONT_FAMILIES,
  SCHEMA_VERSION,
  SPEED_RAMP_PRESETS,
  SpeedRampSchema,
  TEXT_ANIM_TYPES,
  TEXT_TEMPLATES,
  TEXT_TEMPLATE_GROUPS,
  TRANSITION_TYPES,
  TextTemplateSchema,
  createEmptyProject,
  newId,
  rampDurationMs,
  validateDoc,
  type Asset,
  type AudioClip,
  type ProjectDoc,
  type VideoClip,
} from '../src/index.js';

function docWithVideoClip(mutate?: (doc: ProjectDoc, clip: VideoClip, asset: Asset) => void): ProjectDoc {
  const doc = createEmptyProject({ name: '테스트' });
  const asset: Asset = { id: 'a1', kind: 'video', src: 'assets/a1.mp4', name: 'a1.mp4', duration: 5000 };
  const clip: VideoClip = {
    id: 'c1', kind: 'video', assetId: 'a1',
    start: 0, duration: 2000, in: 0, out: 2000, speed: 1, volume: 1,
  };
  doc.assets[asset.id] = asset;
  doc.tracks[0]!.clips.push(clip);
  mutate?.(doc, clip, asset);
  return doc;
}

describe('createEmptyProject', () => {
  it('유효한 문서를 만든다 (validateDoc 통과)', () => {
    const doc = createEmptyProject({ name: '새 프로젝트' });
    expect(validateDoc(doc)).toEqual(doc);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.name).toBe('새 프로젝트');
    expect(doc.revision).toBe(0);
    expect(doc.id.length).toBeGreaterThan(0);
  });

  it('기본 설정: 1080×1920 30fps, 검정 배경', () => {
    const doc = createEmptyProject({ name: 'x' });
    expect(doc.settings.width).toBe(1080);
    expect(doc.settings.height).toBe(1920);
    expect(doc.settings.fps).toBe(30);
    expect(doc.settings.background).toEqual({ kind: 'color', color: '#000000' });
  });

  it('트랙 3개: video/text/audio 순서', () => {
    const doc = createEmptyProject({ name: 'x' });
    expect(doc.tracks.map((t) => t.kind)).toEqual(['video', 'text', 'audio']);
    expect(doc.tracks.every((t) => t.clips.length === 0)).toBe(true);
    expect(new Set(doc.tracks.map((t) => t.id)).size).toBe(3);
  });

  it('width/height/fps 오버라이드', () => {
    const doc = createEmptyProject({ name: 'x', width: 1920, height: 1080, fps: 60 });
    expect(doc.settings).toMatchObject({ width: 1920, height: 1080, fps: 60 });
    expect(validateDoc(doc)).toEqual(doc);
  });
});

describe('validateDoc — 정상 문서', () => {
  it('비디오 클립이 든 문서를 통과시킨다', () => {
    const doc = docWithVideoClip();
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('선택 필드(transform/crop/effects/transition/키프레임)를 통과시킨다', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.transform = { x: 0.1, y: -0.2, scale: 1.5, rotation: 45, flipH: true };
      clip.crop = { x: 0, y: 0, w: 1, h: 0.5 };
      clip.opacity = 0.8;
      clip.effects = [{ id: 'e1', type: 'blur', params: { px: 10 } }];
      clip.transitionOut = { type: 'zoomIn', duration: 600 };
      clip.keyframes = [{ time: 0, prop: 'opacity', value: 0, easing: 'easeInOut' }];
    });
    expect(validateDoc(doc)).toEqual(doc);
  });
});

describe('validateDoc — 불량 문서 거부', () => {
  it('음수 duration 거부', () => {
    const doc = docWithVideoClip((_, clip) => { clip.duration = -100; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('미지의 클립 kind 거부', () => {
    const doc = docWithVideoClip((_, clip) => { (clip as { kind: string }).kind = 'gif'; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('미지의 트랙 kind 거부', () => {
    const doc = createEmptyProject({ name: 'x' });
    (doc.tracks[0] as { kind: string }).kind = 'subtitle';
    expect(() => validateDoc(doc)).toThrow();
  });

  it('opacity 3 거부 (0..1)', () => {
    const doc = docWithVideoClip((_, clip) => { clip.opacity = 3; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('asset src의 백슬래시 거부', () => {
    const doc = docWithVideoClip((_, __, asset) => { asset.src = 'assets\\a1.mp4'; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('proxySrc의 백슬래시 거부', () => {
    const doc = docWithVideoClip((_, __, asset) => { asset.proxySrc = 'proxies\\a1.mp4'; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('out ≤ in 거부', () => {
    const doc = docWithVideoClip((_, clip) => { clip.in = 2000; clip.out = 2000; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('speed 범위 밖(0.05) 거부', () => {
    const doc = docWithVideoClip((_, clip) => { clip.speed = 0.05; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('배경색 #rrggbb 아닌 값 거부', () => {
    const doc = createEmptyProject({ name: 'x' });
    doc.settings.background = { kind: 'color', color: 'black' };
    expect(() => validateDoc(doc)).toThrow();
  });

  it('schemaVersion 2 거부', () => {
    const doc = createEmptyProject({ name: 'x' });
    (doc as { schemaVersion: number }).schemaVersion = 2;
    expect(() => validateDoc(doc)).toThrow();
  });

  it('정수 아닌 시간(ms) 거부', () => {
    const doc = docWithVideoClip((_, clip) => { clip.start = 10.5; });
    expect(() => validateDoc(doc)).toThrow();
  });
});

describe('상수·newId', () => {
  it('상수 노출', () => {
    // W5 계약(X1): 전환 20종·효과 20종 — v1 목록이 앞머리에 그대로 유지된다
    // W8 F3-C: 휩팬 3종을 **뒤에** 붙였다 (앞 20종의 순서는 한 칸도 안 움직인다)
    expect(SCHEMA_VERSION).toBe(1);
    // W8 F16: 목록이 catalog.ts 에서 파생된다. **앞머리 순서가 한 칸도 안 움직였는가**를 본다 —
    // 저장된 문서의 type 값이 그대로 유효해야 하기 때문이다(뒤에 붙는 것은 자유).
    expect(TRANSITION_TYPES.slice(0, 23)).toEqual([
      'fade','slideLeft','slideRight','slideUp','slideDown','wipeLeft','zoomIn','zoomOut',
      'wipeRight','wipeUp','wipeDown','circleOpen','circleClose','blurFade',
      'whiteFlash','blackFlash','spin','bounce','shake','glitch',
      'whipPanLeft','whipPanRight','whipPanUp',
    ]);
    expect(EFFECT_TYPES.slice(0, 20)).toEqual([
      'brightness','contrast','saturation','hue','blur','vignette','grayscale','sepia','invert',
      'temperature','tint','exposure','highlights','shadows','sharpen',
      'glow','grain','scanlines','chromaShift','lightLeak',
    ]);
    // v1 5종은 **값·의미·자리**가 고정이다 (기존 문서·템플릿이 이 순서를 본다).
    expect(TEXT_ANIM_TYPES.slice(0, 5)).toEqual(['fade','slideUp','popIn','typewriter','wordHighlight']);
    // W8 F8 에서 16종이 뒤에 붙었다 (계획서 21종 그대로 — drawStroke 는 remotion 4.0.520 상향 후 합류)
    expect(TEXT_ANIM_TYPES).toEqual([
      'fade','slideUp','popIn','typewriter','wordHighlight',
      'slideDown','slideLeft','slideRight',
      'scaleUp','scaleDown',
      'blurIn',
      'rotateIn','flipX','flipY',
      'wipeLeft','wipeRight','wipeUp','wipeDown',
      'bounceIn','springUp',
      'drawStroke',
    ]);
  });

  it('newId는 매번 다른 비어있지 않은 문자열', () => {
    const a = newId();
    const b = newId();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

// ── W5 확장 ──────────────────────────────────────────────────────────────

function docWithAudioClip(mutate?: (doc: ProjectDoc, clip: AudioClip) => void): ProjectDoc {
  const doc = createEmptyProject({ name: '테스트' });
  doc.assets['au1'] = { id: 'au1', kind: 'audio', src: 'assets/au1.mp3', name: 'au1.mp3', duration: 5000 };
  const clip: AudioClip = {
    id: 'ac1', kind: 'audio', assetId: 'au1',
    start: 0, duration: 2000, in: 0, out: 2000, speed: 1, volume: 1,
  };
  doc.tracks[2]!.clips.push(clip);
  mutate?.(doc, clip);
  return doc;
}

describe('W5 새 필드 — 유효 문서', () => {
  it('lut 에셋 + derived + beats 통과', () => {
    const doc = docWithVideoClip((d, _, asset) => {
      d.assets['lut1'] = { id: 'lut1', kind: 'lut', src: 'assets/lut1.cube', name: 'teal.cube' };
      asset.derived = { sabcdef12: { src: 'derived/a1.sabcdef12.mp4', proxySrc: 'derived/a1.sabcdef12.p.mp4' } };
      asset.beats = [0, 480, 960, 1440];
    });
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('VideoClip source(lut/stabilize/denoise/pitch) + curves 통과', () => {
    const doc = docWithVideoClip((d, clip) => {
      d.assets['lut1'] = { id: 'lut1', kind: 'lut', src: 'assets/lut1.cube', name: 'teal.cube' };
      clip.source = {
        lut: { assetId: 'lut1', intensity: 0.8 },
        stabilize: { smoothing: 12 },
        denoise: { amount: 0.5 },
        pitch: { semitones: -3 },
      };
      clip.curves = { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }], r: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] };
    });
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('freeze 클립(out=in+1, speed=1, duration 자유) 통과', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.freeze = true;
      clip.in = 1000; clip.out = 1001; clip.speed = 1;
      clip.duration = 3000; // (out-in)/speed 와 무관
    });
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('loop 클립(duration이 소스 길이와 무관) 통과', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.loop = true;
      clip.in = 0; clip.out = 1000; clip.speed = 1;
      clip.duration = 5000;
    });
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('speedRamp 클립: duration === rampDurationMs 통과', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.in = 0; clip.out = 4000; clip.speed = 1;
      clip.speedRamp = { points: [{ u: 0, speed: 1 }, { u: 0.5, speed: 4 }, { u: 1, speed: 1 }] };
      clip.duration = rampDurationMs(clip);
    });
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('AudioClip source(denoise/pitch) 통과', () => {
    const doc = docWithAudioClip((_, clip) => {
      clip.source = { denoise: { amount: 0.4 }, pitch: { semitones: 2 } };
    });
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('settings.coverMs 통과', () => {
    const doc = createEmptyProject({ name: 'x' });
    doc.settings.coverMs = 1500;
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('텍스트 클립 curves(ClipBase) + 새 전환/효과 타입 통과', () => {
    const doc = docWithVideoClip((d, clip) => {
      clip.transitionIn = { type: 'glitch', duration: 400 };
      clip.transitionOut = { type: 'circleClose', duration: 300 };
      clip.effects = [{ id: 'e1', type: 'lightLeak', params: { amount: 0.4, hue: 30 } }];
      d.tracks[1]!.clips.push({
        id: 't1', kind: 'text', start: 0, duration: 1000, text: '안녕',
        style: { fontFamily: 'Pretendard', fontSize: 60, color: '#ffffff', align: 'center' },
        curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      });
    });
    expect(validateDoc(doc)).toEqual(doc);
  });

  it('speedRamp/freeze/loop 없는 클립의 duration은 v1처럼 Zod가 묶지 않는다 (v1 문서 유효 유지)', () => {
    // duration ≈ (out-in)/speed 는 엔진 불변식 — Zod 는 v1 에서도 검사하지 않았고, W5 도 그대로 둔다
    const doc = docWithVideoClip((_, clip) => { clip.duration = 999; });
    expect(validateDoc(doc)).toEqual(doc);
  });
});

describe('W5 새 필드 — 불량 거부', () => {
  it('freeze인데 out ≠ in+1 거부', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.freeze = true; clip.in = 0; clip.out = 2000; clip.speed = 1; clip.duration = 3000;
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('freeze인데 speed ≠ 1 거부', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.freeze = true; clip.in = 100; clip.out = 101; clip.speed = 2; clip.duration = 3000;
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('speedRamp인데 duration이 rampDurationMs와 2ms 넘게 다르면 거부', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.in = 0; clip.out = 4000; clip.speed = 1;
      clip.speedRamp = { points: [{ u: 0, speed: 2 }, { u: 1, speed: 2 }] };
      clip.duration = rampDurationMs(clip) + 3;
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('speedRamp points[0].u ≠ 0 거부', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.speedRamp = { points: [{ u: 0.1, speed: 1 }, { u: 1, speed: 1 }] };
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('speedRamp 마지막 u ≠ 1 거부', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.speedRamp = { points: [{ u: 0, speed: 1 }, { u: 0.9, speed: 1 }] };
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('speedRamp u 오름차순 위반 거부', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.speedRamp = { points: [{ u: 0, speed: 1 }, { u: 0.6, speed: 2 }, { u: 0.4, speed: 2 }, { u: 1, speed: 1 }] };
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('speedRamp speed 범위 밖(0.05) 거부', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.speedRamp = { points: [{ u: 0, speed: 0.05 }, { u: 1, speed: 1 }] };
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('커브 1점 거부 (최소 2점)', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.curves = { rgb: [{ x: 0.5, y: 0.5 }] };
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('커브 x 오름차순 위반 거부', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.curves = { r: [{ x: 0, y: 0 }, { x: 0.8, y: 0.5 }, { x: 0.3, y: 1 }] };
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('lut intensity 1.5 거부 (0..1)', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.source = { lut: { assetId: 'lut1', intensity: 1.5 } };
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('beats 오름차순 위반 거부', () => {
    const doc = docWithVideoClip((_, __, asset) => { asset.beats = [0, 500, 400]; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('beats 비정수 거부', () => {
    const doc = docWithVideoClip((_, __, asset) => { asset.beats = [0, 500.5]; });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('derived src 백슬래시 거부', () => {
    const doc = docWithVideoClip((_, __, asset) => {
      asset.derived = { sabcdef12: { src: 'derived\\a1.mp4' } };
    });
    expect(() => validateDoc(doc)).toThrow();
  });

  it('audio pitch semitones 13 거부 (-12..12)', () => {
    const doc = docWithAudioClip((_, clip) => {
      clip.source = { pitch: { semitones: 13 } };
    });
    expect(() => validateDoc(doc)).toThrow();
  });
});

describe('W5 템플릿·프리셋', () => {
  it('TEXT_TEMPLATES 90종 — 앞 35종의 id·순서 고정, id·이름 유일, 스키마 통과 (T3/F16)', () => {
    // W6 T3: 35종 (기본 5 · 예능 6 · 광고 5 · 감성 5 · 손글씨 4 · 뉴스 4 · 숫자 3 · 미니멀 3)
    // W8 F16: +55종 (기본 +5 · 예능 +10 · 광고 +11 · 감성 +7 · 손글씨 +4 · 뉴스 +6 ·
    //                 숫자 +5 · 미니멀 +3 · 키네틱 +4)
    expect(TEXT_TEMPLATES).toHaveLength(90);
    // **앞 35종의 순서가 한 칸도 안 움직였는가** — 저장된 문서·서버 capabilities 가 이 순서를 본다
    expect(TEXT_TEMPLATES.slice(0, 35).map((t) => t.id)).toEqual([
      'basic','outline','boxed','softShadow','round',
      'variety','pop','neon','shout','highlightBar','karaoke',
      'adBig','adYellow','adSale','adLuxury','adCta',
      'quote','emotion','filmSub','lyric','moodBand',
      'penNote','penSticky','gaeguCute','gaeguDoodle',
      'news','typing','ticker','infoCard',
      'countdown','bigNumber','price',
      'minimal','minimalWide','minimalDark',
    ]);
    expect(new Set(TEXT_TEMPLATES.map((t) => t.id)).size).toBe(90);
    expect(new Set(TEXT_TEMPLATES.map((t) => t.name)).size).toBe(90);
    for (const t of TEXT_TEMPLATES) {
      expect(TextTemplateSchema.safeParse(t).success, t.id).toBe(true);
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it('신규 55종의 id 도 전부 있다 (조용히 빠지면 실패한다)', () => {
    expect(TEXT_TEMPLATES.slice(35).map((t) => t.id)).toEqual([
      // 기본 +5
      'basicSerif','basicNavy','basicPill','basicLeft','basicWipe',
      // 예능 +10
      'varietyBubble','varietyPunch','varietyShock','varietyWhisper','varietyMint',
      'varietyStamp','varietyFlip','varietyChase','varietyQuiz','varietyAlert',
      // 광고 +11
      'adWhite','adNeon','adMinimalLux','adUrgent','adBadge','adTech','adFood',
      'adBeauty','adSports','adKids','adBlackFriday',
      // 감성 +7
      'quoteCard','poem','diary','sunset','cinemaTitle','letter','farewell',
      // 손글씨 +4
      'penMarker','penSign','gaeguChalk','penScribble',
      // 뉴스 +6
      'newsBlue','newsName','statCard','caption','warning','chapter',
      // 숫자 +5
      'timer','percent','rank','score','discount',
      // 미니멀 +3
      'minimalSerif','minimalLeft','minimalBand',
      // 키네틱 +4 (F8 이후 생긴 갈래)
      'kineticSpring','kineticWordPop','kineticFocus','kineticLines',
    ]);
  });

  it('TEXT_TEMPLATE_GROUPS — 90종이 정확히 한 갈래씩에 들어간다 (빠짐·중복 0)', () => {
    const listed = TEXT_TEMPLATE_GROUPS.flatMap((g) => g.templateIds);
    expect(listed).toHaveLength(90);
    expect(new Set(listed).size).toBe(90);
    const all = new Set(TEXT_TEMPLATES.map((t) => t.id));
    for (const id of listed) expect(all.has(id), `${id} 는 없는 템플릿이다`).toBe(true);
    for (const t of TEXT_TEMPLATES) {
      expect(listed.includes(t.id), `${t.id} 가 어느 갈래에도 없다`).toBe(true);
    }
    // 갈래 이름·개수 — 계획 16 의 표 그대로
    expect(TEXT_TEMPLATE_GROUPS.map((g) => [g.id, g.templateIds.length])).toEqual([
      ['basic', 10], ['variety', 16], ['ad', 16], ['emotion', 12], ['hand', 8],
      ['news', 10], ['number', 8], ['minimal', 6], ['kinetic', 4],
    ]);
  });

  it('키네틱 4종은 «움직임이 곧 스타일» — unit 이 all 이 아니다 (F8 이 없으면 못 만든다)', () => {
    const kinetic = TEXT_TEMPLATES.filter((t) => t.id.startsWith('kinetic'));
    expect(kinetic).toHaveLength(4);
    for (const t of kinetic) {
      expect(t.animationIn, t.id).toBeTruthy();
      expect(t.animationIn!.unit, t.id).toBeTruthy();
      expect(t.animationIn!.unit, t.id).not.toBe('all');
    }
    // 단위(char/word/line)를 골고루 쓴다 — 넷이 같은 단위면 갈래가 아니라 복제본이다
    expect(new Set(kinetic.map((t) => t.animationIn!.unit)).size).toBeGreaterThanOrEqual(3);
  });

  it('단일 굵기 글꼴에는 bold 를 켜지 않는다 (합성 굵게는 획이 뭉개진다)', () => {
    const singleWeight = new Set(
      ['blackhansans', 'dohyeon', 'jua', 'songmyung', 'nanumpenscript']
        .map((id) => FONT_FAMILIES.find((f) => f.id === id)!.css),
    );
    for (const t of TEXT_TEMPLATES) {
      if (singleWeight.has(t.style.fontFamily)) expect(t.style.bold ?? false, t.id).toBe(false);
    }
  });

  it('W5 의 10종 id 는 그대로 남아 있다 (문서·저장된 프로젝트가 참조한다)', () => {
    const ids = new Set(TEXT_TEMPLATES.map((t) => t.id));
    for (const id of ['basic','outline','variety','neon','minimal','boxed','news','quote','typing','pop']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('글꼴은 전부 번들 폰트(FONT_FAMILIES)에서 온다 — 설치 안 된 Pretendard 는 없다', () => {
    const bundled = new Set(FONT_FAMILIES.map((f) => f.css));
    const used = new Set<string>();
    for (const t of TEXT_TEMPLATES) {
      expect(bundled.has(t.style.fontFamily)).toBe(true);
      expect(t.style.fontFamily).not.toContain('Pretendard');
      used.add(t.style.fontFamily);
    }
    // 시스템 폴백만 쓰는 템플릿은 없고, 번들 9종을 골고루 쓴다
    expect(used.size).toBeGreaterThanOrEqual(9);
    expect(used.has(FONT_FALLBACK)).toBe(false);
  });

  it('두 템플릿이 완전히 같은 style 을 갖지 않는다 (색만 바꾼 복제본 금지)', () => {
    const seen = new Map<string, string>();
    for (const t of TEXT_TEMPLATES) {
      const key = JSON.stringify(t.style);
      const dup = seen.get(key);
      expect(dup, `${t.id} 의 style 이 ${dup} 와 완전히 같습니다`).toBeUndefined();
      seen.set(key, t.id);
    }
    // style + 애니메이션 + 위치까지 합쳐도 유일해야 한다
    const full = TEXT_TEMPLATES.map((t) =>
      JSON.stringify([t.style, t.animationIn, t.animationOut, t.transform, t.highlightColor]),
    );
    expect(new Set(full).size).toBe(TEXT_TEMPLATES.length);
  });

  it('90종을 텍스트 클립에 적용하면(=applyTextTemplate) validateDoc 를 통과한다', () => {
    for (const t of TEXT_TEMPLATES) {
      const doc = createEmptyProject({ name: t.id });
      doc.tracks.push({
        id: 'tt', kind: 'text', name: '자막',
        clips: [{
          id: 'x1', kind: 'text', start: 0, duration: 2000, text: '가나다 Aa 123',
          // applyTextTemplate 과 같은 덮어쓰기 (schema 는 engine 을 못 쓴다 — 의존 방향이 반대)
          style: structuredClone(t.style),
          ...(t.animationIn ? { animationIn: structuredClone(t.animationIn) } : {}),
          ...(t.animationOut ? { animationOut: structuredClone(t.animationOut) } : {}),
          ...(t.transform ? { transform: structuredClone(t.transform) } : {}),
          ...(t.highlightColor ? { highlightColor: t.highlightColor } : {}),
        }],
      });
      expect(() => validateDoc(doc), `${t.id} 적용 후 validateDoc 실패`).not.toThrow();
    }
  });

  it('렌더러가 실제로 그리는 값의 범위 — 글자 크기·외곽선·자간이 화면 밖으로 안 나간다', () => {
    for (const t of TEXT_TEMPLATES) {
      const s = t.style;
      expect(s.fontSize, t.id).toBeGreaterThanOrEqual(30);
      expect(s.fontSize, t.id).toBeLessThanOrEqual(240);
      // 렌더러 text.tsx 가 paint-order:stroke fill 을 주므로 획은 «바깥으로만» 자란다 —
      // 글자 속이 먹히지 않는다. 두께 10%(예능 자막)·12%(외침)까지 렌더로 확인했다.
      // 상한 15% 는 「글자가 서로 붙어 뭉개지지 않는」 선이지 글자가 먹히는 선이 아니다.
      if (s.strokeWidth) expect(s.strokeWidth / s.fontSize, t.id).toBeLessThanOrEqual(0.15);
      // 자간이 글자보다 넓으면 단어가 흩어진다
      expect(Math.abs(s.letterSpacing ?? 0) / s.fontSize, t.id).toBeLessThan(0.5);
      // 화면 밖으로 밀려나는 위치 금지 (y 는 캔버스 높이 비율, 중앙 기준)
      if (t.transform) {
        expect(Math.abs(t.transform.y), t.id).toBeLessThanOrEqual(0.44);
        expect(t.transform.scale, t.id).toBeGreaterThan(0);
      }
    }
  });

  it('SPEED_RAMP_PRESETS 6종 — id·points 계획서 그대로 + 스키마 통과', () => {
    expect(SPEED_RAMP_PRESETS.map((p) => p.id)).toEqual(['montage','hero','bullet','jumpIn','flashOut','slowMo']);
    expect(SPEED_RAMP_PRESETS[0]!.points).toEqual([{ u: 0, speed: 1 }, { u: 0.5, speed: 4 }, { u: 1, speed: 1 }]);
    expect(SPEED_RAMP_PRESETS[1]!.points).toEqual([{ u: 0, speed: 2 }, { u: 0.4, speed: 0.4 }, { u: 1, speed: 2 }]);
    expect(SPEED_RAMP_PRESETS[2]!.points).toEqual([{ u: 0, speed: 1 }, { u: 0.45, speed: 0.2 }, { u: 0.55, speed: 0.2 }, { u: 1, speed: 1 }]);
    expect(SPEED_RAMP_PRESETS[3]!.points).toEqual([{ u: 0, speed: 4 }, { u: 0.3, speed: 1 }, { u: 1, speed: 1 }]);
    expect(SPEED_RAMP_PRESETS[4]!.points).toEqual([{ u: 0, speed: 1 }, { u: 0.7, speed: 1 }, { u: 1, speed: 5 }]);
    expect(SPEED_RAMP_PRESETS[5]!.points).toEqual([{ u: 0, speed: 1 }, { u: 0.2, speed: 0.3 }, { u: 0.8, speed: 0.3 }, { u: 1, speed: 1 }]);
    for (const p of SPEED_RAMP_PRESETS) {
      expect(SpeedRampSchema.safeParse({ points: p.points }).success).toBe(true);
    }
  });
});

describe('W6 크로마키 spill', () => {
  it('spill 없는 v1 문서가 그대로 유효하다 (마이그레이션 없음)', () => {
    const doc = docWithVideoClip((_, clip) => {
      clip.chromaKey = { color: '#00b140', similarity: 0.4, smoothness: 0.1 };
    });
    const out = validateDoc(doc);
    const clip = out.tracks[0]!.clips[0] as VideoClip;
    expect(clip.chromaKey).toEqual({ color: '#00b140', similarity: 0.4, smoothness: 0.1 });
    expect(clip.chromaKey!.spill).toBeUndefined(); // 문서에 없던 필드는 생기지 않는다
  });

  it('spill 0..1 을 받는다', () => {
    for (const spill of [0, 0.5, 1]) {
      const doc = docWithVideoClip((_, clip) => {
        clip.chromaKey = { color: '#00b140', similarity: 0.4, smoothness: 0.1, spill };
      });
      expect((validateDoc(doc).tracks[0]!.clips[0] as VideoClip).chromaKey!.spill).toBe(spill);
    }
  });

  it('spill 범위 밖(-0.1 · 1.5)은 거부', () => {
    for (const spill of [-0.1, 1.5]) {
      const doc = docWithVideoClip((_, clip) => {
        clip.chromaKey = { color: '#00b140', similarity: 0.4, smoothness: 0.1, spill };
      });
      expect(() => validateDoc(doc)).toThrow();
    }
  });
});

describe('W8 F12 — Track.duckedBy · duck', () => {
  it('둘 다 없는 v1 문서가 그대로 유효하다 (optional)', () => {
    const doc = docWithVideoClip();
    expect(validateDoc(doc).tracks[0]!.duckedBy).toBeUndefined();
  });

  it('duckedBy · duck 을 받는다', () => {
    const doc = docWithVideoClip((d) => {
      d.tracks.push({ id: 'vo', kind: 'audio', name: '나레이션', clips: [] });
      d.tracks[0]!.duckedBy = 'vo';
      d.tracks[0]!.duck = { amount: 0.25, attackMs: 400, releaseMs: 400 };
    });
    const out = validateDoc(doc);
    expect(out.tracks[0]!.duckedBy).toBe('vo');
    expect(out.tracks[0]!.duck).toEqual({ amount: 0.25, attackMs: 400, releaseMs: 400 });
  });

  it('amount 0..1 밖 · attack 2000 초과 · release 5000 초과는 거부', () => {
    const bad = [
      { amount: 1.5, attackMs: 400, releaseMs: 400 },
      { amount: -0.1, attackMs: 400, releaseMs: 400 },
      { amount: 0.25, attackMs: 2500, releaseMs: 400 },   // sidechaincompress attack 상한 2000
      { amount: 0.25, attackMs: 400, releaseMs: 9000 },   // 엔진 상한 5000
      { amount: 0.25, attackMs: -1, releaseMs: 400 },
    ];
    for (const duck of bad) {
      const doc = docWithVideoClip((d) => {
        d.tracks[0]!.duck = duck;
      });
      expect(() => validateDoc(doc), JSON.stringify(duck)).toThrow();
    }
  });

  it('duckedBy 는 빈 문자열을 거부한다', () => {
    const doc = docWithVideoClip((d) => {
      d.tracks[0]!.duckedBy = '';
    });
    expect(() => validateDoc(doc)).toThrow();
  });
});
