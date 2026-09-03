// 텍스트 합성 «수식» — 렌더러(text.tsx)와 빠른 미리보기(ui/preview/TextOverlay.tsx)가
// **같은 함수**를 쓴다. computeVisualLayout 이 영상·이미지에 해 주는 일을 텍스트에 하는 것이다.
//
// 왜 이게 먼저인가: 전에는 텍스트 그리기 코드가 두 벌이었고 **이미 갈라져 있었다** —
// 렌더에만 `paintOrder:'stroke fill'` 이 있어 두꺼운 외곽선 자막이 미리보기에서 뭉개졌고,
// 미리보기는 `style.fontSize` 같은 키프레임을 아예 반영하지 않았다. 여기에 움직임 20종 ×
// 단위 4종을 두 벌로 얹으면 갈라진 곳이 몇 개인지 셀 수도 없게 된다. 수치는 이 파일에서만 나온다.
//
// **fps 가 계산에 아예 안 들어간다.** 스태거는 ms 이고 진행도는 구간 정규화라
// 24/30/60fps 에서 «같은 절대 시각»의 그림이 같다 (계획 08 §판단 2).
import React from 'react';
import type { CSSProperties } from 'react';
import {
  easingFn,
  TEXT_ANIM_DEFAULT_STAGGER,
  type Easing,
  type TextAnim,
  type TextAnimOrigin,
  type TextAnimType,
  type TextAnimUnit,
  type TextClip,
  type TextStyle,
} from '@kitkat/schema';
import { evolvePath, getLength, getSubpaths } from '@remotion/paths';
import { applyKeyframes } from './keyframes.js';
import { effectsToFilter } from './effects.js';
import { glyphOutline, glyphStemPx } from './glyph-path.js';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// ── 이징 ──────────────────────────────────────────────────────────────────

/**
 * v1 popIn 의 손으로 짠 이징. **S2 프리셋으로 대체하지 않는다** — `backSoft`
 * (`{bezier:[0.34,1.56,0.64,1]}`)는 수식이 달라 기존 문서의 popIn 이 «조용히» 달라진다.
 * 사본이 두 벌(text.tsx·TextOverlay.tsx)이던 것을 **한 벌로 줄이는 것**이 이 파일의 일이다.
 */
export function legacyEaseOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

/** 움직임별 기본 이징. v1 5종은 여기 없다 = linear(=항등) 이라 값이 v1 과 같다. */
const DEFAULT_EASING: Partial<Record<TextAnimType, Easing>> = {
  slideDown: 'easeOut',
  slideLeft: 'easeOut',
  slideRight: 'easeOut',
  scaleUp: 'easeOut',
  scaleDown: 'easeOut',
  blurIn: 'easeOut',
  rotateIn: 'easeOut',
  flipX: 'easeInOut',
  flipY: 'easeInOut',
  wipeLeft: 'easeInOut',
  wipeRight: 'easeInOut',
  wipeUp: 'easeInOut',
  wipeDown: 'easeInOut',
  bounceIn: { spring: { damping: 8 } },
  springUp: { spring: { damping: 8 } },
  // 획은 «손이 지나가는 속도»라 일정해야 한다 — 이징을 넣으면 붓이 멈칫거린다
  drawStroke: 'linear',
};

/** 이 애니메이션이 실제로 쓰는 이징 함수. 스프링도 S2 의 한 벌에서 온다. */
export function textAnimEasing(anim: TextAnim): (t: number) => number {
  if (anim.easing) return easingFn(anim.easing);
  if (anim.type === 'popIn') return legacyEaseOutBack;
  const d = DEFAULT_EASING[anim.type];
  return d ? easingFn(d) : (t: number): number => t;
}

// ── 단위 · 스태거 ─────────────────────────────────────────────────────────

export function textAnimUnitOf(anim: TextAnim | undefined): TextAnimUnit {
  if (!anim) return 'all';
  if (anim.type === 'typewriter' || anim.type === 'wordHighlight') return 'all'; // 통짜 경로로 그린다
  // 획은 **언제나 글자별로** 그린다. `unit:'all'` 은 「모든 글자가 동시에」라는 뜻이고
  // (시차 기본값이 0), 그래도 글리프 하나하나의 path 가 필요하므로 쪼개는 단위는 글자다.
  if (anim.type === 'drawStroke') return 'char';
  return anim.unit ?? 'all';
}

export function textAnimStaggerMs(anim: TextAnim): number {
  return anim.staggerMs ?? TEXT_ANIM_DEFAULT_STAGGER[anim.unit ?? 'all'];
}

export type StaggerTiming = {
  /** 실제로 적용된 시차(ms) — 요청값보다 작을 수 있다 */
  stagger: number;
  /** 단위 하나가 움직이는 길이(ms). 항상 duration 의 40% 이상 */
  perUnit: number;
};

/**
 * **`duration` 의 뜻을 지킨다: 전체가 duration 안에서 끝난다.**
 * 마지막 단위가 넘치면 자르는 게 아니라 **시차를 줄여서 압축한다**
 * (글자 40개 · 600ms · 시차 30ms → 시차 9.23ms · 단위당 240ms, 마지막 글자가 정확히 600ms 에 끝).
 */
export function staggerTiming(n: number, durationMs: number, staggerMs: number): StaggerTiming {
  if (!(durationMs > 0)) return { stagger: 0, perUnit: 0 };
  const count = Math.max(1, Math.floor(n));
  if (count <= 1) return { stagger: 0, perUnit: durationMs };
  const stagger = Math.min(Math.max(0, staggerMs), (durationMs * 0.6) / (count - 1));
  return { stagger, perUnit: durationMs - (count - 1) * stagger };
}

/** 시드 문자열 → 32bit 정수 (FNV-1a). 클립 id 가 같으면 언제나 같은 순서가 나온다. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 단위 인덱스 → 시차 순서. `random` 은 **클립 id 를 시드로 한 결정적 셔플**이다 —
 * 렌더할 때마다 다르면 미리보기와 렌더가 갈린다.
 */
export function staggerOrder(n: number, origin: TextAnimOrigin, seed: string): number[] {
  const count = Math.max(0, Math.floor(n));
  const out = new Array<number>(count);
  if (origin === 'end') {
    for (let i = 0; i < count; i++) out[i] = count - 1 - i;
    return out;
  }
  if (origin === 'center') {
    const mid = (count - 1) / 2;
    const idx = [...Array(count).keys()].sort(
      (a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b,
    );
    idx.forEach((unitIndex, order) => {
      out[unitIndex] = order;
    });
    return out;
  }
  if (origin === 'random') {
    const rnd = mulberry32(hashSeed(seed));
    const idx = [...Array(count).keys()];
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = idx[i]!;
      idx[i] = idx[j]!;
      idx[j] = t;
    }
    idx.forEach((unitIndex, order) => {
      out[unitIndex] = order;
    });
    return out;
  }
  for (let i = 0; i < count; i++) out[i] = i;
  return out;
}

// ── 텍스트 측정 (자체 구현) ───────────────────────────────────────────────
//
// `@remotion/layout-utils` 의 measureText 는 4.0.520 이고 이 저장소의 remotion 은 4.0.519 라
// 단독 설치하면 remotion 사본이 둘이 된다. 그래서 **캔버스 2D 의 measureText 로 직접 잰다.**
// - 폰트가 로드되기 전에 재면 폴백 폰트의 폭이 나온다 → 렌더는 delayRender('번들 폰트 로딩'),
//   미리보기는 TextOverlay 의 폰트 게이트 뒤에서만 이 함수가 불린다.
// - **기준 크기는 언제나 style.fontSize(1080 기준)** 다. 캔버스 높이로 스케일한 크기로 재면
//   미리보기(작은 캔버스)와 렌더(1080)에서 줄이 다른 자리에서 꺾인다.

export type TextMeasurer = (text: string, cssFont: string) => number;

let customMeasurer: TextMeasurer | null = null;
let canvasCtx: { measureText: (t: string) => { width: number } } | null | undefined;

/** 테스트·특수 환경용. null 로 되돌리면 다시 캔버스를 쓴다. */
export function setTextMeasurer(fn: TextMeasurer | null): void {
  customMeasurer = fn;
  widthCache.clear();
  lineCache.clear();
}

/** 캔버스가 없는 환경(노드)의 결정적 근사 — 한글·전각 1.0em, 그 밖 0.5em. */
function estimateWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? fontSize : fontSize * 0.5;
  }
  return w;
}

const widthCache = new Map<string, number>();

function rawWidth(text: string, cssFont: string, fontSize: number): number {
  const key = `${cssFont} ${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  let w: number;
  if (customMeasurer) {
    w = customMeasurer(text, cssFont);
  } else {
    if (canvasCtx === undefined) {
      const doc = (globalThis as { document?: Document }).document;
      const c = doc?.createElement?.('canvas');
      canvasCtx = (c?.getContext?.('2d') as CanvasRenderingContext2D | null) ?? null;
    }
    if (canvasCtx) {
      (canvasCtx as CanvasRenderingContext2D).font = cssFont;
      w = canvasCtx.measureText(text).width;
    } else {
      w = estimateWidth(text, fontSize);
    }
  }
  if (widthCache.size > 20000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

/** 측정에 쓰는 CSS font 축약형. **1080 기준 크기**로 만든다. */
export function textCssFont(style: TextStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${style.fontSize}px ${style.fontFamily}`;
}

/** 자간까지 더한 폭(1080 기준 px). CSS letter-spacing 은 글자마다 뒤에 붙는다. */
export function measureTextWidth(text: string, style: TextStyle): number {
  if (text.length === 0) return 0;
  const base = rawWidth(text, textCssFont(style), style.fontSize);
  const ls = style.letterSpacing ?? 0;
  return ls === 0 ? base : base + ls * [...text].length;
}

// ── 줄 나누기 ─────────────────────────────────────────────────────────────

const CJK_RE = /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿＀-｠]/;

/**
 * 줄바꿈 기회가 있는 조각으로 자른다. 한국어·한자·가나는 «아무 데서나» 꺾이고,
 * 라틴 문자는 공백에서만 꺾인다(UAX#14 근사). 공백은 **앞 조각에 붙여** 줄 끝에서 사라지게 한다.
 */
export function breakChunks(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  const push = (): void => {
    if (buf.length > 0) out.push(buf);
    buf = '';
  };
  for (const ch of text) {
    if (ch === ' ' || ch === '\t') {
      // 공백은 **앞 조각에 붙인다** — 줄 끝에 오면 조용히 사라져야 한다.
      // 앞이 이미 확정된 조각(한글 한 글자 등)이면 그쪽 꼬리에 붙인다.
      if (buf.length === 0 && out.length > 0) {
        out[out.length - 1] += ch;
        continue;
      }
      buf += ch;
      push();
      continue;
    }
    if (CJK_RE.test(ch)) {
      push();
      out.push(ch);
      continue;
    }
    buf += ch;
  }
  push();
  return out;
}

const lineCache = new Map<string, string[]>();

/**
 * 그리디 줄바꿈. `maxRefPx` 는 **1080 기준** 폭(= canvasW·1080/canvasH·0.9,
 * 지금 `maxWidth:'90%'` 와 같은 값)이다. 명시적 `\n` 은 언제나 줄을 끊는다.
 */
export function splitLines(text: string, style: TextStyle, maxRefPx: number): string[] {
  const key = `${textCssFont(style)} ${style.letterSpacing ?? 0} ${maxRefPx.toFixed(2)} ${text}`;
  const hit = lineCache.get(key);
  if (hit) return hit;
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const chunk of breakChunks(para)) {
      if (line.length === 0) {
        line = chunk;
        continue;
      }
      if (measureTextWidth(line + chunk, style) <= maxRefPx) line += chunk;
      else {
        out.push(line);
        line = chunk;
      }
    }
    out.push(line);
  }
  if (lineCache.size > 2000) lineCache.clear();
  lineCache.set(key, out);
  return out;
}

/** 한 줄을 단위로 쪼갠다. 공백은 자리를 지키되 **시차 번호를 먹지 않는다**(visible=false). */
export type SplitPiece = { text: string; visible: boolean };

export function splitUnits(line: string, unit: TextAnimUnit): SplitPiece[] {
  if (unit === 'line') return [{ text: line, visible: line.trim().length > 0 }];
  if (unit === 'word') {
    const out: SplitPiece[] = [];
    // 공백은 앞 단어에 붙여 둔다 — inline-block 사이의 «자리»가 유지된다.
    const re = /\S+\s*|\s+/g;
    for (const m of line.match(re) ?? []) out.push({ text: m, visible: m.trim().length > 0 });
    return out;
  }
  // char — 코드포인트 단위 ([...s] 로 자른다. split('') 은 이모지를 깬다)
  return [...line].map((ch) => ({ text: ch, visible: ch.trim().length > 0 }));
}

// ── 움직임 → 스타일 ───────────────────────────────────────────────────────

export type AnimOpts = {
  /** slide 계열 이동 px */
  distance: number;
  /** blurIn 흐림 px */
  blurPx: number;
  /** wipe 계열 그라디언트 폭 % (0 이면 칼로 자른 듯한 clip-path) */
  wipePct: number;
  /** flip 계열 원근 px */
  perspective: number;
};

function wipeStyle(dir: 'right' | 'left' | 'bottom' | 'top', p: number, pct: number): CSSProperties {
  if (pct <= 0) {
    // 하드 — transitions.tsx 의 같은 이름과 **같은 기하**다 (inset: top right bottom left)
    const gone = (1 - p) * 100;
    const inset =
      dir === 'right' ? `0 ${gone}% 0 0`
      : dir === 'left' ? `0 0 0 ${gone}%`
      : dir === 'bottom' ? `0 0 ${gone}% 0`
      : `${gone}% 0 0 0`;
    return { clipPath: `inset(${inset})` };
  }
  const edge = p * 100;
  const image = `linear-gradient(to ${dir}, #000 ${(edge - pct).toFixed(3)}%, transparent ${edge.toFixed(3)}%)`;
  return { WebkitMaskImage: image, maskImage: image };
}

/**
 * 한 단위의 스타일. `v` 는 이징 **전** 진행도, `p` 는 이징 후.
 * v1 3종(fade·slideUp·popIn)은 기본값으로 부르면 v1 과 **문자열까지 같은 값**을 낸다.
 */
export function animUnitStyle(
  type: TextAnimType,
  v: number,
  p: number,
  o: AnimOpts,
): CSSProperties {
  switch (type) {
    case 'fade':
      return { opacity: p };
    case 'slideUp':
      return { opacity: p, transform: `translateY(${(1 - p) * o.distance}px)` };
    case 'popIn':
      return { opacity: Math.min(1, v * 2), transform: `scale(${Math.max(0.001, p)})` };
    case 'slideDown':
      return { opacity: p, transform: `translateY(${-(1 - p) * o.distance}px)` };
    case 'slideLeft':
      return { opacity: p, transform: `translateX(${(1 - p) * o.distance}px)` };
    case 'slideRight':
      return { opacity: p, transform: `translateX(${-(1 - p) * o.distance}px)` };
    case 'scaleUp':
      return { opacity: p, transform: `scale(${Math.max(0.001, 0.6 + 0.4 * p)})` };
    case 'scaleDown':
      return { opacity: p, transform: `scale(${Math.max(0.001, 1.4 - 0.4 * p)})` };
    case 'blurIn':
      return { opacity: p, filter: `blur(${((1 - p) * o.blurPx).toFixed(3)}px)` };
    case 'rotateIn':
      return { opacity: p, transform: `rotate(${((1 - p) * -90).toFixed(3)}deg)` };
    case 'flipX':
      return {
        opacity: p,
        transform: `perspective(${o.perspective.toFixed(1)}px) rotateX(${((1 - p) * 90).toFixed(3)}deg)`,
      };
    case 'flipY':
      return {
        opacity: p,
        transform: `perspective(${o.perspective.toFixed(1)}px) rotateY(${((1 - p) * 90).toFixed(3)}deg)`,
      };
    case 'wipeLeft':
      return wipeStyle('right', p, o.wipePct);
    case 'wipeRight':
      return wipeStyle('left', p, o.wipePct);
    case 'wipeUp':
      return wipeStyle('bottom', p, o.wipePct);
    case 'wipeDown':
      return wipeStyle('top', p, o.wipePct);
    case 'bounceIn':
      return { opacity: Math.min(1, v * 3), transform: `scale(${Math.max(0.001, 0.3 + 0.7 * p)})` };
    case 'springUp':
      return { opacity: Math.min(1, v * 3), transform: `translateY(${((1 - p) * o.distance).toFixed(3)}px)` };
    default:
      return {}; // typewriter · wordHighlight — 글자 내용으로 표현한다
  }
}

/**
 * 이동량·흐림·와이프 폭.
 *
 * **`distance` 를 안 적으면 40px 을 «스케일하지 않고» 쓴다** — v1 이 캔버스 크기와 무관하게
 * `translateY((1-v)*40px)` 였기 때문이다. 여기서 fontScale 을 곱하면 1080×1920 문서의
 * slideUp 이 40px → 71px 로 «조용히» 바뀐다(계획 08 §검증 1: 기존 문서 픽셀 완전 일치).
 * 값을 적으면 그때부터는 **1080 기준 px** 이라 해상도와 무관하게 같은 비율로 움직인다.
 */
export function animOpts(anim: TextAnim, fontScale: number): AnimOpts {
  const d = anim.distance;
  return {
    distance: d === undefined ? 40 : d * fontScale,
    blurPx: (d === undefined ? 12 : d) * fontScale,
    wipePct: d === undefined ? 15 : d,
    perspective: 600 * fontScale,
  };
}

// ── 레이아웃 ──────────────────────────────────────────────────────────────

/** TextStyle → CSS. fontSize 는 높이 1080 기준 px — 캔버스 높이에 비례 스케일. */
export function textCss(style: TextStyle, fontScale: number): CSSProperties {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize * fontScale,
    color: style.color,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    textAlign: style.align,
    whiteSpace: 'pre-wrap',
    // paintOrder 없이 -webkit-text-stroke 만 주면 외곽선의 «절반이 글자 안쪽»을 덮어
    // 두꺼운 테두리에서 글자가 뭉개진다(예능 자막이 새까맣게 나왔다). stroke 를 먼저 그려
    // 획이 바깥으로만 자라게 한다. **미리보기도 같은 값을 쓴다** — 이 함수가 한 벌이므로.
    ...(style.strokeColor && style.strokeWidth
      ? {
          WebkitTextStroke: `${style.strokeWidth * fontScale}px ${style.strokeColor}`,
          paintOrder: 'stroke fill' as const,
        }
      : {}),
    ...(style.backgroundColor
      ? {
          backgroundColor: style.backgroundColor,
          padding: `${0.15 * style.fontSize * fontScale}px ${0.35 * style.fontSize * fontScale}px`,
        }
      : {}),
    ...(style.shadow ? { textShadow: '0 2px 8px rgba(0,0,0,0.7)' } : {}),
    ...(style.letterSpacing != null ? { letterSpacing: style.letterSpacing * fontScale } : {}),
    ...(style.lineHeight != null ? { lineHeight: style.lineHeight } : {}),
  };
}

/**
 * `drawStroke` 한 글자의 «지금까지 그려진 획». 서브패스(획)마다 dasharray/dashoffset 한 벌이다.
 * 좌표 원점은 **글자의 왼쪽·기준선** 이라 `<svg width=0 height=0 vertical-align:baseline>` 안에
 * 그대로 넣으면 진짜 글자와 같은 자리에 겹친다.
 */
export type GlyphStrokeView = {
  color: string;
  width: number;
  segs: { d: string; dasharray: string; dashoffset: number }[];
  /** 글리프 전체 윤곽선 — 펜이 글자 밖으로 번지지 않게 이걸로 클립한다 */
  clipD: string;
};

export type TextUnitView = {
  key: string;
  text: string;
  style: CSSProperties;
  /** 있으면 이 글자는 «획이 그려지는 중»이다 (글자 자체는 투명하게 둔다) */
  stroke?: GlyphStrokeView;
};
export type TextLineView = { key: string; units: TextUnitView[] };
export type TextWordView = { key: string; text: string; highlighted: boolean };

export type TextLayout = {
  /** 가운데 정렬 래퍼 (100%×100% flex) */
  outerStyle: CSSProperties;
  /** 글자 상자 — maxWidth·transform·opacity·filter + textCss. **textCss 는 한 벌뿐이다** */
  boxStyle: CSSProperties;
  /** 등장/퇴장 애니메이션 래퍼(전체 크기). 단위 애니메이션이면 여기는 비어 있다 */
  wrapperStyles: CSSProperties[];
  /** null = 통짜 텍스트(v1 DOM 그대로). 아니면 줄→단위 스팬 */
  lines: TextLineView[] | null;
  /** lines === null 일 때 그릴 통짜 내용 */
  text: string;
  /** wordHighlight 일 때만 (없으면 null) */
  words: TextWordView[] | null;
};

export type TextLayoutArgs = {
  clip: TextClip;
  /** 움직임을 재는 시각 (클립 시작 기준 ms) */
  tMs: number;
  canvasW: number;
  canvasH: number;
  /**
   * 글자 «내용»을 재는 시각. 트랜스폼 모션 블러가 여러 시각을 겹쳐 그릴 때, 타자기 애니메이션의
   * 글자 수까지 시각마다 다르면 유령 글자가 겹친다 → 내용은 가운데 시각 것 하나를 쓴다.
   */
  contentTMs?: number;
};

// ── 획 그리기 (drawStroke) ────────────────────────────────────────────────
//
// **획 색·두께는 「외곽선」 설정과 무관하다.** 외곽선을 안 켠 글자에 걸어도 반드시 뭔가 그려져야
// 하기 때문이다(「골랐는데 아무 일도 안 일어난다」가 제일 나쁘다). 규칙은 이렇다:
//   색   = style.strokeColor 가 있으면 그 색, 없으면 **글자 색**
//   두께 = **그 폰트·그 굵기의 세로 기둥 폭**(glyphStemPx) — 윤곽선 양쪽에서 펜 반쪽씩이 만나
//          기둥이 꽉 차므로 «테두리»가 아니라 «칠해진 획»이 된다.
//          style.strokeWidth 가 있으면 그것을 쓰되 **기둥보다 가늘면(= 속이 빈다) 기둥 폭으로 올린다.**
//          기둥을 못 재면(번들 폰트 아님·아직 안 옴) 글자 크기의 3.5%.
// 펜이 글자 밖으로 번지지 않게 획은 글리프 윤곽선으로 **클립**한다(GlyphStrokeSvg) — 그래서
// 펜이 기둥보다 굵어도 채움 모양을 넘지 않고, p→1 에서 채워진 글자에 수렴한다.
// 그리는 동안 글자 자신은 투명하게 두고, **진행도가 1 이 되면 획을 걷어내고 원래 글자를 그린다** —
// 그래서 끝 프레임은 drawStroke 를 안 건 정적 글자와 픽셀이 같다.

/** 획 색·두께 (px 는 이미 캔버스 배율이 반영된 값). */
export function strokePaint(style: TextStyle, fontScale: number): { color: string; width: number } {
  const sizePx = style.fontSize * fontScale;
  const stem = glyphStemPx(style, sizePx);
  const base = stem ?? Math.max(1, sizePx * 0.035);
  const explicit =
    style.strokeWidth != null && style.strokeWidth > 0 ? style.strokeWidth * fontScale : null;
  return {
    color: style.strokeColor ?? style.color,
    width: Math.max(1, explicit !== null ? Math.max(explicit, base) : base),
  };
}

/**
 * 진행도 p 에서 «지금까지 그려진» 획들. 글리프를 못 얻으면 null 이고, 그때는 부르는 쪽이
 * 왼쪽→오른쪽 하드 와이프로 대체한다(움직이긴 한다).
 *
 * 서브패스를 **길이 비례로 이어서** 소비한다 — 「값」처럼 획이 여러 개인 한글도 한 획씩 차례로
 * 그려지고, 전체가 일정한 속도로 그려진다.
 */
export function glyphStrokeAt(
  ch: string,
  style: TextStyle,
  fontScale: number,
  p: number,
): GlyphStrokeView | null {
  const sizePx = style.fontSize * fontScale;
  const outline = glyphOutline(ch, style, sizePx, { getSubpaths, getLength });
  if (!outline) return null;
  const paint = strokePaint(style, fontScale);
  const target = clamp01(p) * outline.total;
  const segs: GlyphStrokeView['segs'] = [];
  let cum = 0;
  for (let i = 0; i < outline.subpaths.length; i++) {
    const len = outline.lengths[i]!;
    const local = len > 0 ? clamp01((target - cum) / len) : 0;
    cum += len;
    if (local <= 0) continue;
    try {
      const e = evolvePath(local, outline.subpaths[i]!);
      segs.push({ d: outline.subpaths[i]!, dasharray: e.strokeDasharray, dashoffset: e.strokeDashoffset });
    } catch {
      // 이 획만 건너뛴다 — 한 글자 때문에 렌더가 죽으면 안 된다
    }
  }
  return { ...paint, segs, clipD: outline.subpaths.join(' ') };
}

/** 단위 진행도 — 등장/퇴장 두 애니메이션의 결과를 곱하지 않고 «스타일 목록»으로 쌓는다. */
type UnitAnim = { anim: TextAnim; ease: (t: number) => number; timing: StaggerTiming; order: number[]; opts: AnimOpts };

function unitProgress(a: UnitAnim, orderIndex: number, tSince: number, out: boolean): { v: number; p: number } {
  const o = a.order[orderIndex] ?? 0;
  const perUnit = a.timing.perUnit;
  const raw = perUnit > 0 ? clamp01((tSince - o * a.timing.stagger) / perUnit) : 1;
  const v = out ? 1 - raw : raw;
  return { v, p: a.ease(v) };
}

/**
 * 텍스트 클립 한 개의 «그리는 데 필요한 모든 수치». 렌더러와 미리보기는 이걸 DOM 으로 옮기기만 한다.
 */
export function computeTextLayout(args: TextLayoutArgs): TextLayout {
  const { clip, tMs, canvasW, canvasH } = args;
  const contentTMs = args.contentTMs ?? tMs;
  const fontScale = canvasH / 1080;

  // 키프레임은 **여기 한 곳에서** 통과시킨다 (W8 S1) — style.fontSize·자간·외곽선 두께까지.
  const c = applyKeyframes(clip, tMs);
  const cContent = contentTMs === tMs ? c : applyKeyframes(clip, contentTMs);
  const tr = c.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
  const filter = effectsToFilter(c.effects);

  const inAnim = clip.animationIn;
  const outAnim = clip.animationOut;
  const inVis = inAnim && inAnim.duration > 0 ? clamp01(tMs / inAnim.duration) : 1;
  const outVis =
    outAnim && outAnim.duration > 0 ? clamp01((clip.duration - tMs) / outAnim.duration) : 1;

  // ── 타자기 · 단어 강조 (v1 그대로) ──
  const inVisC = inAnim && inAnim.duration > 0 ? clamp01(contentTMs / inAnim.duration) : 1;
  const outVisC =
    outAnim && outAnim.duration > 0 ? clamp01((clip.duration - contentTMs) / outAnim.duration) : 1;
  let visibleText = cContent.text;
  if (inAnim?.type === 'typewriter' && inVisC < 1) {
    visibleText = cContent.text.slice(0, Math.ceil(cContent.text.length * inVisC));
  } else if (outAnim?.type === 'typewriter' && outVisC < 1) {
    visibleText = cContent.text.slice(0, Math.ceil(cContent.text.length * outVisC));
  }

  const useWordHighlight =
    (inAnim?.type === 'wordHighlight' || outAnim?.type === 'wordHighlight') &&
    clip.words != null &&
    clip.words.length > 0;
  const words: TextWordView[] | null = useWordHighlight
    ? clip.words!.map((w, i) => ({
        key: String(i),
        text: w.text + (i < clip.words!.length - 1 ? ' ' : ''),
        highlighted: contentTMs >= w.start && contentTMs < w.start + w.duration,
      }))
    : null;

  // ── 단위 애니메이션이 걸리는가 ──
  // DOM 구조(줄→스팬)는 하나뿐이라 등장·퇴장이 서로 다른 단위를 쓰면 **등장 쪽을 따른다**.
  // (등장이 'all' 일 때만 퇴장의 단위를 본다.) 두 벌의 DOM 을 만들면 전환 순간에 글자가 튄다.
  const unit = textAnimUnitOf(inAnim) !== 'all' ? textAnimUnitOf(inAnim) : textAnimUnitOf(outAnim);
  const staggered = unit !== 'all' && !useWordHighlight;

  const wrapperStyles: CSSProperties[] = [];
  let lines: TextLineView[] | null = null;

  if (!staggered) {
    // v1 경로 — 문장 전체가 한 덩어리. DOM 도 v1 과 같다.
    if (inAnim && inVis < 1 && inAnim.type !== 'typewriter' && inAnim.type !== 'wordHighlight') {
      const ease = textAnimEasing(inAnim);
      wrapperStyles.push(animUnitStyle(inAnim.type, inVis, ease(inVis), animOpts(inAnim, fontScale)));
    }
    if (outAnim && outVis < 1 && outAnim.type !== 'typewriter' && outAnim.type !== 'wordHighlight') {
      const ease = textAnimEasing(outAnim);
      wrapperStyles.push(animUnitStyle(outAnim.type, outVis, ease(outVis), animOpts(outAnim, fontScale)));
    }
  } else {
    // ── 단위별 시차 ──
    // 줄 나누기를 «우리가» 계산한다. inline-block 스팬은 브라우저의 줄바꿈 규칙이 달라져
    // 「애니메이션을 켰다는 이유만으로 자막이 다른 줄에서 꺾이는」 일이 생기기 때문이다.
    const maxRefPx = (canvasW / Math.max(1e-6, fontScale)) * 0.9;
    const rawLines = splitLines(visibleText, cContent.style, maxRefPx);
    const pieces: { lineIndex: number; text: string; visible: boolean }[] = [];
    rawLines.forEach((ln, li) => {
      for (const piece of splitUnits(ln, unit)) pieces.push({ lineIndex: li, ...piece });
    });
    const visibleCount = pieces.filter((p) => p.visible).length;
    const n = Math.max(1, visibleCount);

    const build = (anim: TextAnim | undefined): UnitAnim | null => {
      if (!anim || anim.duration <= 0) return null;
      if (anim.type === 'typewriter' || anim.type === 'wordHighlight') return null;
      const timing = staggerTiming(n, anim.duration, textAnimStaggerMs(anim));
      return {
        anim,
        ease: textAnimEasing(anim),
        timing,
        order: staggerOrder(n, anim.origin ?? 'start', clip.id),
        opts: animOpts(anim, fontScale),
      };
    };
    const uIn = build(inAnim);
    const uOut = build(outAnim);
    const tOut = outAnim ? outAnim.duration - (clip.duration - tMs) : 0;

    lines = rawLines.map((_, li) => ({ key: `l${li}`, units: [] as TextUnitView[] }));
    let visIndex = 0;
    // 공백은 **뒤에 오는 보이는 글자**와 같은 시각에 나타난다 (자리는 유지, 번호는 안 먹는다)
    pieces.forEach((piece, pi) => {
      const orderIndex = piece.visible ? visIndex : Math.min(visIndex, n - 1);
      if (piece.visible) visIndex++;
      const style: CSSProperties = { display: 'inline-block', whiteSpace: 'pre' };
      let stroke: GlyphStrokeView | undefined;

      /** 한 애니메이션을 이 조각에 얹는다. drawStroke 는 «스타일»이 아니라 «내용»을 바꾼다. */
      const put = (u: UnitAnim, v: number, p: number): void => {
        if (u.anim.type !== 'drawStroke') {
          Object.assign(style, animUnitStyle(u.anim.type, v, p, u.opts));
          return;
        }
        if (!piece.visible) return; // 공백에는 그릴 획이 없다
        const s = glyphStrokeAt(piece.text, cContent.style, fontScale, p);
        if (s) {
          stroke = s;
          // 그리는 동안 글자 자신(칠·외곽선)은 감춘다 — 획만 보여야 한다
          style.color = 'transparent';
          style.WebkitTextStroke = '0px transparent';
          style.position = 'relative';
        } else {
          // 글리프를 못 얻었다(번들 폰트가 아니거나 폰트가 아직 안 왔다) →
          // **아무 일도 안 일어나게 두지 않는다.** 왼쪽→오른쪽 하드 와이프로 대신한다.
          Object.assign(style, animUnitStyle('wipeLeft', v, p, { ...u.opts, wipePct: 0 }));
        }
      };

      if (uIn && tMs < uIn.anim.duration + n * uIn.timing.stagger) {
        const { v, p } = unitProgress(uIn, orderIndex, tMs, false);
        if (v < 1) put(uIn, v, p);
      }
      if (uOut && tOut > 0) {
        const { v, p } = unitProgress(uOut, orderIndex, tOut, true);
        if (v < 1) put(uOut, v, p);
      }
      lines![piece.lineIndex]!.units.push({
        key: `u${pi}`,
        text: piece.text,
        style,
        ...(stroke ? { stroke } : {}),
      });
    });
  }

  return {
    outerStyle: {
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxStyle: {
      maxWidth: '90%',
      transform: `translate(${tr.x * canvasW}px, ${tr.y * canvasH}px) scale(${(tr.flipH ? -1 : 1) * tr.scale}, ${(tr.flipV ? -1 : 1) * tr.scale}) rotate(${tr.rotation}deg)`,
      opacity: clamp01(c.opacity ?? 1),
      ...(filter ? { filter } : {}),
      ...textCss(c.style, fontScale),
    },
    wrapperStyles,
    lines,
    text: visibleText,
    words,
  };
}

/**
 * 레이아웃 → DOM. **렌더러와 미리보기가 이 컴포넌트를 같이 쓴다** — 「같은 함수에서 나온 수치를
 * 서로 다른 JSX 로 옮기다가 갈리는」 마지막 틈까지 막는다.
 */
export const TextLayoutContent: React.FC<{ layout: TextLayout; highlightColor?: string }> = ({
  layout,
  highlightColor,
}) => {
  if (layout.lines) {
    return (
      <>
        {layout.lines.map((line) => (
          <div key={line.key} style={LINE_STYLE}>
            {line.units.map((u) => (
              <span key={u.key} style={u.style}>
                {u.stroke ? <GlyphStrokeSvg stroke={u.stroke} /> : null}
                {u.text}
              </span>
            ))}
          </div>
        ))}
      </>
    );
  }
  if (layout.words) {
    const color = highlightColor ?? '#ffd400';
    return (
      <>
        {layout.words.map((w) => (
          <span key={w.key} style={w.highlighted ? { color } : undefined}>
            {w.text}
          </span>
        ))}
      </>
    );
  }
  return <>{layout.text}</>;
};

/** 우리가 직접 나눈 줄 — 브라우저가 다시 꺾지 않게 `pre` 로 둔다. */
const LINE_STYLE: CSSProperties = { whiteSpace: 'pre' };

/**
 * 그려지는 중인 획.
 *
 * **`vertical-align: baseline` 인 인라인 svg 의 바닥이 곧 글자의 기준선이다.** 그래서 폰트의
 * ascent/half-leading 을 손으로 계산할 필요가 없다 — 그 계산은 브라우저마다 ±2px 씩 어긋나는
 * 대표적인 자리다. `overflow:visible` 로 상자 밖에 그린다.
 *
 * 크기는 **1×1** 이다(0×0 이 아니다). 실제로 겪었다: 0×0 svg 는 Chromium 이 «빈 상자»로 보고
 * overflow:visible 이어도 아예 칠하지 않는다 — 렌더에서 획이 한 픽셀도 안 보였다.
 * 1px 상자 때문에 생기는 오차 둘은 바로 되돌린다: 폭 1px → `margin-right:-1px`(뒤 글자가 안 밀린다),
 * 높이 1px → 기준선이 1px 위로 가므로 `translate(0,1)`.
 */
const GlyphStrokeSvg: React.FC<{ stroke: GlyphStrokeView }> = ({ stroke }) => {
  // 클립 id 는 문서 안에서 고유해야 한다 — useId 는 렌더러·미리보기 모두에서 안정적이다(픽셀과 무관)
  const clipId = `gs${React.useId().replace(/[^A-Za-z0-9]/g, '')}`;
  return (
  <svg
    width={1}
    height={1}
    style={{ overflow: 'visible', verticalAlign: 'baseline', marginRight: -1 }}
    aria-hidden
  >
    <defs>
      {/* clipPathUnits=userSpaceOnUse: 참조하는 <g> 의 좌표계(= translate 뒤)라 여기엔 translate 를 안 쓴다 */}
      <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
        <path d={stroke.clipD} />
      </clipPath>
    </defs>
    <g transform="translate(0,1)" clipPath={`url(#${clipId})`}>
    {stroke.segs.map((s, i) => (
      <path
        key={i}
        d={s.d}
        fill="none"
        stroke={stroke.color}
        strokeWidth={stroke.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={s.dasharray}
        strokeDashoffset={s.dashoffset}
      />
    ))}
    </g>
  </svg>
  );
};
