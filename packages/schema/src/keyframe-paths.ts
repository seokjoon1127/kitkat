// 키프레임 대상 경로 (W8 S1) — `Keyframe.prop` 이 열거형 6종에서 «경로 문자열»로 넓어졌다.
//
// 문법:  path := seg ( '.' seg | '[' 정수 ']' | '#' id )*
//        seg  := [A-Za-z_][A-Za-z0-9_]*
//        id   := [A-Za-z0-9_-]+      ← 배열 원소를 그 원소의 .id 필드로 고른다
//
// **효과는 `effects#<id>` 로 가리킨다. `effects[N]` 이 아니다.** UI 가 effects 배열을
// 통째로 patch 하므로(EffectsSection), 효과 하나를 지우면 뒤 인덱스가 전부 당겨진다 —
// 밝기에 걸어 둔 키프레임이 «조용히» 채도를 흔들게 된다. id 로 가리키면 대상이 사라졌을 때
// 다른 효과에 붙는 대신 «무동작»이 된다.
// `[N]` 문법은 파서에 남겨 두지만(crop 같은 고정 구조용) 화이트리스트에는 쓰지 않는다.

import type { Clip } from './index.js';

export const KEYFRAME_PATH_MAX = 120;
/** 스키마(zod)가 «문법»만 검사한다. «이 클립에 허용된 경로인가»는 isKeyframablePath 가 본다. */
export const KEYFRAME_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|#[A-Za-z0-9_-]+)*$/;

export type KeyframePathDef = {
  path: string; // 'effects#*.params.*' 처럼 * 와일드카드 허용
  label: string; // UI 표시용 한국어
  min?: number;
  max?: number;
  unit?: 'ratio' | 'px' | 'deg' | 'x';
};

// ── 토크나이저 ────────────────────────────────────────────────────────────

type Token = { kind: 'key'; v: string } | { kind: 'idx'; v: number } | { kind: 'id'; v: string };

const SEG_HEAD = /[A-Za-z_]/;
const SEG_BODY = /[A-Za-z0-9_]/;
const ID_BODY = /[A-Za-z0-9_-]/;
const DIGIT = /[0-9]/;

/** 프로토타입 오염 방지 — 정규식은 통과하지만 절대 따라가지 않는다. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function tokenize(path: string, wild = false): Token[] | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > KEYFRAME_PATH_MAX) return null;
  const out: Token[] = [];
  let i = 0;

  const readSeg = (): string | null => {
    if (wild && path[i] === '*') {
      i++;
      return '*';
    }
    if (i >= path.length || !SEG_HEAD.test(path[i]!)) return null;
    const s = i++;
    while (i < path.length && SEG_BODY.test(path[i]!)) i++;
    return path.slice(s, i);
  };

  const head = readSeg();
  if (head === null) return null;
  out.push({ kind: 'key', v: head });

  while (i < path.length) {
    const ch = path[i]!;
    if (ch === '.') {
      i++;
      const s = readSeg();
      if (s === null) return null;
      out.push({ kind: 'key', v: s });
    } else if (ch === '[') {
      i++;
      const s = i;
      while (i < path.length && DIGIT.test(path[i]!)) i++;
      if (i === s || path[i] !== ']') return null;
      out.push({ kind: 'idx', v: Number(path.slice(s, i)) });
      i++;
    } else if (ch === '#') {
      i++;
      if (wild && path[i] === '*') {
        i++;
        out.push({ kind: 'id', v: '*' });
        continue;
      }
      const s = i;
      while (i < path.length && ID_BODY.test(path[i]!)) i++;
      if (i === s) return null;
      out.push({ kind: 'id', v: path.slice(s, i) });
    } else {
      return null;
    }
  }
  return out;
}

/** 경로 문법이 올바른가 (화이트리스트 검사는 별개). */
export function isValidKeyframePath(path: string): boolean {
  return tokenize(path) !== null;
}

// ── 별칭 · 기본값 ─────────────────────────────────────────────────────────
// 기존 6종 prop 중 x·y·scale·rotation 은 «클립의 필드»가 아니라 clip.transform 의 필드다.
// 하위호환을 위해 경로 이름은 그대로 두고 여기서 실제 위치로 옮긴다.

const ALIASES: Record<string, string> = {
  x: 'transform.x',
  y: 'transform.y',
  scale: 'transform.scale',
  rotation: 'transform.rotation',
};

/**
 * 값이 «없을 때» 쓰는 기본값. 렌더러가 쓰던 폴백(`tr.x`, `clip.opacity ?? 1`)과 같은 값이라
 * 기존 문서의 계산 결과가 한 자리도 안 바뀐다. 동시에 «transform 없는 클립에 x 키프레임»
 * 같은 기존 문서가 «대상 없음»으로 거부되지 않게 한다.
 */
const LEGACY_DEFAULTS: Record<string, number> = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  volume: 1,
};

const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0 };

// ── 읽기 ──────────────────────────────────────────────────────────────────

function walk(obj: unknown, toks: Token[]): unknown {
  let cur: unknown = obj;
  for (const t of toks) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (t.kind === 'key') {
      if (FORBIDDEN_KEYS.has(t.v)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, t.v)) return undefined;
      cur = (cur as Record<string, unknown>)[t.v];
    } else if (t.kind === 'idx') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t.v];
    } else {
      if (!Array.isArray(cur)) return undefined;
      cur = (cur as unknown[]).find(
        (e) => e !== null && typeof e === 'object' && (e as { id?: unknown }).id === t.v,
      );
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * 경로가 가리키는 «현재 값». 없거나 숫자가 아니면 undefined.
 * 기존 6종(x·y·scale·rotation·opacity·volume)은 대상이 없어도 기본값을 돌려준다 —
 * 렌더러의 폴백과 같은 값이다.
 */
export function readPath(obj: unknown, path: string): number | undefined {
  const toks = tokenize(ALIASES[path] ?? path);
  if (!toks) return undefined;
  const v = walk(obj, toks);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === undefined && path in LEGACY_DEFAULTS) return LEGACY_DEFAULTS[path];
  return undefined;
}

// ── 쓰기 (구조 공유 복제) ─────────────────────────────────────────────────

/** 부모가 없을 때 만들어 주는 것은 transform 하나뿐이다(기본값이 명확한 유일한 경우). */
function seedFor(key: string, depth: number): Record<string, unknown> | undefined {
  if (depth === 0 && key === 'transform') return { ...DEFAULT_TRANSFORM };
  return undefined;
}

function setIn(cur: unknown, toks: Token[], i: number, value: number): unknown {
  const t = toks[i]!;
  const last = i === toks.length - 1;

  if (t.kind === 'key') {
    if (FORBIDDEN_KEYS.has(t.v)) return cur;
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return cur;
    const rec = cur as Record<string, unknown>;
    if (last) {
      if (rec[t.v] === value) return cur;
      return { ...rec, [t.v]: value };
    }
    let child = rec[t.v];
    if (child === undefined || child === null) {
      const seed = seedFor(t.v, i);
      if (!seed) return cur; // 부모가 없으면 «무동작» (mask 를 껐다 켜면 키프레임이 살아 돌아온다)
      child = seed;
    }
    const next = setIn(child, toks, i + 1, value);
    if (next === rec[t.v]) return cur;
    return { ...rec, [t.v]: next };
  }

  if (!Array.isArray(cur)) return cur;
  const arr = cur as unknown[];
  const idx =
    t.kind === 'idx'
      ? t.v
      : arr.findIndex((e) => e !== null && typeof e === 'object' && (e as { id?: unknown }).id === t.v);
  if (idx < 0 || idx >= arr.length) return cur;
  if (last) {
    if (arr[idx] === value) return cur;
    const copy = arr.slice();
    copy[idx] = value;
    return copy;
  }
  const next = setIn(arr[idx], toks, i + 1, value);
  if (next === arr[idx]) return cur;
  const copy = arr.slice();
  copy[idx] = next;
  return copy;
}

/**
 * 경로에 값을 쓴 «새 객체»를 돌려준다. 경로에 걸린 객체만 얕은 복제하고 나머지는 그대로 참조한다.
 * 대상이 없으면(마스크 없이 `mask.x`, 없는 효과 id 등) 아무것도 안 하고 **같은 객체**를 돌려준다.
 */
export function writePath<T>(obj: T, path: string, value: number): T {
  const toks = tokenize(ALIASES[path] ?? path);
  if (!toks || !Number.isFinite(value)) return obj;
  return setIn(obj, toks, 0, value) as T;
}

// ── 화이트리스트 ──────────────────────────────────────────────────────────

const COMMON: readonly KeyframePathDef[] = [
  { path: 'x', label: 'X 위치', min: -2, max: 2, unit: 'ratio' },
  { path: 'y', label: 'Y 위치', min: -2, max: 2, unit: 'ratio' },
  { path: 'scale', label: '크기', min: 0, max: 10, unit: 'x' },
  { path: 'rotation', label: '회전', unit: 'deg' },
  { path: 'opacity', label: '불투명도', min: 0, max: 1, unit: 'ratio' },
  { path: 'effects#*.params.*', label: '효과 파라미터' },
];

const CROP: readonly KeyframePathDef[] = [
  { path: 'crop.x', label: '크롭 좌', min: 0, max: 1, unit: 'ratio' },
  { path: 'crop.y', label: '크롭 상', min: 0, max: 1, unit: 'ratio' },
  { path: 'crop.w', label: '크롭 너비', min: 0, max: 1, unit: 'ratio' },
  { path: 'crop.h', label: '크롭 높이', min: 0, max: 1, unit: 'ratio' },
];

const MASK: readonly KeyframePathDef[] = [
  { path: 'mask.x', label: '마스크 X', min: 0, max: 1, unit: 'ratio' },
  { path: 'mask.y', label: '마스크 Y', min: 0, max: 1, unit: 'ratio' },
  { path: 'mask.w', label: '마스크 너비', min: 0, max: 1, unit: 'ratio' },
  { path: 'mask.h', label: '마스크 높이', min: 0, max: 1, unit: 'ratio' },
  { path: 'mask.feather', label: '마스크 흐림', min: 0, max: 1, unit: 'ratio' },
];

const CHROMA: readonly KeyframePathDef[] = [
  { path: 'chromaKey.similarity', label: '크로마키 허용치', min: 0, max: 1, unit: 'ratio' },
  { path: 'chromaKey.smoothness', label: '크로마키 경계', min: 0, max: 1, unit: 'ratio' },
  { path: 'chromaKey.spill', label: '크로마키 물듦 제거', min: 0, max: 1, unit: 'ratio' },
];

const VOLUME: KeyframePathDef = { path: 'volume', label: '볼륨', min: 0, max: 2, unit: 'x' };

/**
 * 클립 종류별 허용 경로. **여기 없는 경로는 BAD_KEYFRAME 이다.**
 * `source.*` 는 일부러 빠져 있다 — ffmpeg 로 파일을 굽는 스펙이라 프레임마다 바뀌면
 * 파생 파일이 수백 개 생긴다(30fps 30초 = 900개).
 */
export const KEYFRAME_PATHS: Record<Clip['kind'], readonly KeyframePathDef[]> = {
  video: [...COMMON, VOLUME, ...CROP, ...MASK, ...CHROMA],
  image: [...COMMON, ...CROP, ...MASK],
  // text 에 crop.* 를 넣지 않는다 — TextClip 은 ClipBase 를 상속해 타입엔 있지만
  // computeVisualLayout 을 안 타서 아무 효과가 없다. «걸 수 있는데 아무 일도 안 일어나는 것»이 제일 나쁘다.
  text: [
    ...COMMON,
    { path: 'style.fontSize', label: '글자 크기', min: 1, max: 500, unit: 'px' },
    { path: 'style.letterSpacing', label: '자간', min: -50, max: 200, unit: 'px' },
    { path: 'style.strokeWidth', label: '외곽선 두께', min: 0, max: 50, unit: 'px' },
    { path: 'style.lineHeight', label: '줄 간격', min: 0.5, max: 3, unit: 'x' },
  ],
  audio: [VOLUME],
};

/** 패턴은 클립 종류마다 매번 토크나이즈하지 않고 모듈 로드 시 한 번만 만든다. */
const PATTERNS: Record<string, { def: KeyframePathDef; toks: Token[] }[]> = {};
for (const [kind, defs] of Object.entries(KEYFRAME_PATHS)) {
  PATTERNS[kind] = defs.flatMap((def) => {
    const toks = tokenize(def.path, true);
    return toks ? [{ def, toks }] : [];
  });
}

function matches(pattern: Token[], actual: Token[]): boolean {
  if (pattern.length !== actual.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const a = actual[i]!;
    if (p.kind !== a.kind) return false;
    if (p.v === '*') continue;
    if (p.v !== a.v) return false;
  }
  return true;
}

function findDef(kind: Clip['kind'], path: string): KeyframePathDef | undefined {
  const toks = tokenize(path);
  if (!toks) return undefined;
  for (const p of PATTERNS[kind] ?? []) {
    if (matches(p.toks, toks)) return p.def;
  }
  return undefined;
}

/** 이 클립 종류에 이 경로로 키프레임을 걸 수 있나. */
export function isKeyframablePath(kind: Clip['kind'], path: string): boolean {
  return findDef(kind, path) !== undefined;
}

/** UI 표시용 한국어 라벨 (모르는 경로는 경로 그대로). */
export function keyframePathLabel(kind: Clip['kind'], path: string): string {
  const def = findDef(kind, path);
  if (!def) return path;
  if (def.path === 'effects#*.params.*') {
    const toks = tokenize(path);
    const name = toks && toks.length === 4 ? toks[3]!.v : '';
    return name ? `효과 ${name}` : def.label;
  }
  return def.label;
}

export function keyframePathDef(kind: Clip['kind'], path: string): KeyframePathDef | undefined {
  return findDef(kind, path);
}

/**
 * 거부 사유(한국어). 허용되면 null.
 * `source.*` 는 «왜 안 되는지»를 반드시 설명한다 — 안 그러면 「나중에 완화」 요청이 계속 온다.
 */
export function keyframePathRejection(kind: Clip['kind'], path: string): string | null {
  if (isKeyframablePath(kind, path)) return null;
  if (path === 'source' || path.startsWith('source.') || path.startsWith('source[') || path.startsWith('source#')) {
    return `${path} 는 키프레임을 걸 수 없습니다 — 이 값은 영상 파일을 새로 굽는 설정이라 프레임마다 바뀌면 파일이 수백 개 생깁니다. 대신 effects 의 색 파라미터에 거세요.`;
  }
  if (path === 'curves' || path.startsWith('curves.')) {
    return `${path} 는 키프레임을 걸 수 없습니다 — 색조정 커브는 값이 숫자가 아니라 점 배열입니다.`;
  }
  if (path === 'speed' || path.startsWith('speedRamp')) {
    return `${path} 는 키프레임을 걸 수 없습니다 — 속도는 duration 불변식(duration === (out-in)/speed)을 깹니다.`;
  }
  if (path.startsWith('effects[')) {
    return `${path} 는 키프레임을 걸 수 없습니다 — 효과는 인덱스가 아니라 id 로 가리킵니다(effects#<효과id>.params.<이름>). 효과를 지우면 인덱스가 당겨져 엉뚱한 효과에 붙기 때문입니다.`;
  }
  return `${kind} 클립에는 '${path}' 키프레임을 쓸 수 없습니다`;
}
