// 순수 파생 헬퍼 (계획 X1-b) — zod·remotion 무의존.
// renderer 와 server 가 똑같은 계산을 써야 하므로 schema 에 둔다.
import type {
  AudioClip, AudioClipSource, ClipSource, ColorCurves, Crop, CurvePoint,
  HslSecondary, HueSatBand, LoudnessSpec, MatchLevels, MatchTo, MotionBlurSpec, SpeedPoint, VideoClip, VoiceSpec,
} from './index.js';

export type RampSegment = {
  startMs: number;    // 클립 시작 기준 타임라인 ms (정수)
  durationMs: number; // 타임라인 표시 길이 ms (정수)
  inMs: number;       // 소스 시작 ms (정수)
  outMs: number;      // 소스 끝 ms (정수)
  speed: number;      // 등속 재생 배율 ≈ (outMs-inMs)/durationMs
};

// ── sourceKey ────────────────────────────────────────────────────────────

/** 숫자를 소수점 4자리로 반올림해 문자열화 — 부동소수 잡음으로 키가 갈리는 것 방지. */
function round4(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

/** FNV-1a 32bit → hex 8자. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 사각형(0..1) → "x,y,w,h". 없으면 "-" (없는 것과 전체를 지정한 것은 다른 스펙이다). */
function crop4(c: Crop | undefined): string {
  return c ? `${round4(c.x)},${round4(c.y)},${round4(c.w)},${round4(c.h)}` : '-';
}

/** 측정 캐시 → refSourceKey + 샘플 시각 + 채널 6쌍(μ·σ) 12개 숫자 전부. */
function matchLevelsPart(l: MatchLevels | undefined): string {
  if (!l) return '-';
  const stats = [...l.ref, ...l.target].map((s) => `${round4(s.mean)}/${round4(s.std)}`).join('+');
  return `${l.refSourceKey}@${l.sampledAtMs.length}:${l.sampledAtMs.map(round4).join('+')}~${stats}`;
}

/**
 * F4 — 모든 필드를 넣는다. 하나라도 빠지면 «다른 설정인데 같은 파일» 이 된다.
 * levels 가 없으면(아직 안 잼) 키는 갈리지만 굽기는 서버가 건너뛴다.
 */
function matchToPart(m: MatchTo): string {
  return `match=${m.clipId},${round4(m.strength)},r${crop4(m.region)},R${crop4(m.refRegion)},L${matchLevelsPart(m.levels)}`;
}

/**
 * F5 — 배열은 «순서까지» 키에 넣는다. 필터 체인 순서가 결과를 바꾸기 때문이다.
 * 길이를 앞에 붙여 인접 원소가 이어붙어 생기는 충돌(예: [ab] vs [a,b])을 막는다.
 * `id` 도 넣는다: 렌더 결과에는 영향이 없지만 «모든 필드» 계약을 문자 그대로 지킨다
 * (id 는 생성 후 안 바뀌므로 헛굽기가 실제로 일어나지 않는다).
 */
function hueSatPart(bands: HueSatBand[]): string {
  const items = bands.map(
    (b) =>
      `${b.id}:${b.bands.join('')}:${round4(b.hue)}:${round4(b.saturation)}:${round4(b.intensity)}:${b.preserveLightness === true ? 1 : 0}`,
  );
  return `huesat=${bands.length}:${items.join(';')}`;
}

function hslPart(list: HslSecondary[]): string {
  const items = list.map(
    (h) => `${h.id}:${h.family}:${round4(h.cyan)}:${round4(h.magenta)}:${round4(h.yellow)}:${round4(h.black)}`,
  );
  return `hsl=${list.length}:${items.join(';')}`;
}

function motionBlurPart(mb: MotionBlurSpec): string {
  return `mblur=${mb.quality},${round4(mb.shutterAngle)}`;
}

/** F11 — preset·targetLufs·reverb.irId·reverb.wet 전부. 기본값은 «펼쳐서» 넣는다
 *  (targetLufs 를 안 적은 것과 -14 를 적은 것은 같은 파일을 굽는다 → 같은 키여야 한다). */
function voicePart(v: VoiceSpec): string {
  const lufs = round4(v.targetLufs ?? DEFAULT_TARGET_LUFS);
  const rv = v.reverb ? `${v.reverb.irId},${round4(v.reverb.wet)}` : '-';
  return `voice=${v.preset},${lufs},${rv}`;
}

/** 음량 맞춤 조각. **`voicePart` 는 건드리지 않는다** — 기존 문서의 키를 지키려면
 *  새 조각을 맨 뒤에 덧붙이는 수밖에 없다(이 파일 sourceKey 주석의 계약). */
function loudnessPart(l: LoudnessSpec): string {
  return `loud=${round4(l.targetLufs)}`;
}

/** 나레이션 기본 목표 라우드니스 (관행값 — 플랫폼 공식 문서로 확인된 값이 아니다). */
export const DEFAULT_TARGET_LUFS = -14;

/**
 * 옛 문서 호환 — 「음량 맞춤」은 원래 `voice.targetLufs` 안에 갇혀 있었다.
 * 그래서 프리셋을 끄면(`off`) 음량 맞춤까지 같이 꺼졌다. 이제 `loudness` 가 제자리다.
 *
 * 읽는 쪽은 여기 하나만 부른다 — 서버·UI·sourceKey 가 각자 규칙을 갖게 두면 갈린다.
 * `off` 에서 undefined 를 내는 것은 «옛 동작을 그대로 두기» 위해서다: 옛 문서에서
 * `preset:'off'` 는 「오디오를 건드리지 마라」였고, 그 문서를 열었다고 갑자기
 * 음량이 바뀌면 안 된다. 새로 켜려면 `loudness` 를 명시해야 한다.
 */
export function normalizeLoudness(
  src: { voice?: VoiceSpec; loudness?: LoudnessSpec },
): LoudnessSpec | undefined {
  if (src.loudness) return src.loudness;
  if (src.voice && src.voice.preset !== 'off') {
    return { targetLufs: src.voice.targetLufs ?? DEFAULT_TARGET_LUFS };
  }
  return undefined;
}

/**
 * ClipSource + reversed → 안정 키 "s" + FNV-1a 32bit hex(8자).
 * 키 순서를 고정한 정규화 문자열을 해시한다 — 객체 프로퍼티 순서와 무관.
 * source 가 없거나 비어 있으면 null.
 *
 * **새 필드를 여기 안 넣으면 다른 설정인데 같은 파일을 쓴다** — 사용자가 색을 바꿨는데
 * 화면이 안 변한다. W8 S3 의 5개 필드(matchTo·hueSat·hsl·motionBlur·voice)를 전부 넣는다.
 * 기존 4개는 «앞쪽 그대로» 두어, 새 필드가 없는 문서의 키가 한 글자도 안 바뀌게 한다
 * (바뀌면 이미 구워 둔 파생 파일이 전부 죽고 프로젝트마다 재인코딩이 돈다).
 */
export function sourceKey(clip: VideoClip | AudioClip): string | null {
  const src = clip.source as (ClipSource & AudioClipSource) | undefined;
  if (!src) return null;
  const parts: string[] = [];
  if (src.lut) parts.push(`lut=${src.lut.assetId},${round4(src.lut.intensity)}`);
  if (src.stabilize) parts.push(`stab=${round4(src.stabilize.smoothing)}`);
  if (src.denoise) parts.push(`den=${round4(src.denoise.amount)}`);
  if (src.pitch) parts.push(`pitch=${round4(src.pitch.semitones)}`);
  // 아래 순서는 deriveMedia 의 필터 순서와 같게 둔다 — 키를 읽을 때 파이프라인이 보인다.
  if (src.matchTo) parts.push(matchToPart(src.matchTo));
  if (src.hueSat && src.hueSat.length > 0) parts.push(hueSatPart(src.hueSat));
  if (src.hsl && src.hsl.length > 0) parts.push(hslPart(src.hsl));
  if (src.motionBlur) parts.push(motionBlurPart(src.motionBlur));
  if (src.voice) parts.push(voicePart(src.voice));
  if (src.loudness) parts.push(loudnessPart(src.loudness));
  if (parts.length === 0) return null;
  let normalized = parts.join('|');
  if ('reversed' in clip && clip.reversed === true) normalized += '|rev';
  return 's' + fnv1a32(normalized);
}

// ── 속도 램프 ────────────────────────────────────────────────────────────

/** [a,b] 구간선형 speed 에서 u 지점의 speed. */
function speedBetween(a: SpeedPoint, b: SpeedPoint, u: number): number {
  if (b.u <= a.u) return b.speed;
  const t = (u - a.u) / (b.u - a.u);
  return a.speed + (b.speed - a.speed) * t;
}

/** ∫_{u0}^{u1} du / speed(u). speed 는 points 를 잇는 구간선형, 범위 밖은 끝값 유지. */
function invSpeedIntegral(points: SpeedPoint[], u0: number, u1: number): number {
  if (u1 <= u0 || points.length === 0) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let sum = 0;
  if (u0 < first.u) sum += (Math.min(u1, first.u) - u0) / first.speed;
  if (u1 > last.u) sum += (u1 - Math.max(u0, last.u)) / last.speed;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b.u <= a.u) continue;
    const lo = Math.max(u0, a.u);
    const hi = Math.min(u1, b.u);
    if (hi <= lo) continue;
    const v0 = speedBetween(a, b, lo);
    const v1 = speedBetween(a, b, hi);
    // 선형 v(u) 의 ∫du/v = Δu·ln(v1/v0)/(v1-v0), v0==v1 이면 Δu/v0
    sum += Math.abs(v1 - v0) < 1e-9 ? (hi - lo) / v0 : ((hi - lo) * Math.log(v1 / v0)) / (v1 - v0);
  }
  return sum;
}

/** 속도 램프를 적분한 타임라인 길이(ms). speedRamp 없으면 round((out-in)/speed). */
export function rampDurationMs(clip: VideoClip): number {
  const span = clip.out - clip.in;
  const points = clip.speedRamp?.points;
  if (!points || points.length < 2) return Math.round(span / clip.speed);
  return Math.round(span * invSpeedIntegral(points, 0, 1));
}

/**
 * 램프를 등속 세그먼트로 전개 (렌더러가 세그먼트마다 OffthreadVideo 를 하나씩 놓는다).
 * - 소스 구간 [in,out] 을 균등 분할(최대 maxSegments, 기본 40)
 * - 세그먼트 durationMs 합 === rampDurationMs (반올림 오차는 마지막 세그먼트가 흡수)
 * - 모든 경계는 정수 ms
 */
export function rampSegments(clip: VideoClip, maxSegments = 40): RampSegment[] {
  const inMs = clip.in;
  const outMs = clip.out;
  const span = outMs - inMs;
  if (span <= 0) return [];
  const points = clip.speedRamp?.points;
  if (!points || points.length < 2) {
    return [{ startMs: 0, durationMs: Math.round(span / clip.speed), inMs, outMs, speed: clip.speed }];
  }
  const total = rampDurationMs(clip);
  const n = Math.max(1, Math.min(Math.max(1, Math.floor(maxSegments)), span));
  const segs: RampSegment[] = [];
  let prevSrc = inMs; // 다음 세그먼트의 소스 시작 (정수 ms)
  let prevT = 0;      // 다음 세그먼트의 타임라인 시작 (정수 ms)
  let acc = 0;        // prevSrc 까지의 타임라인 누적 (float ms)
  for (let k = 1; k <= n; k++) {
    const isLast = k === n;
    const srcEnd = isLast ? outMs : inMs + Math.round((k * span) / n);
    if (srcEnd <= prevSrc) continue;
    const segFloat = span * invSpeedIntegral(points, (prevSrc - inMs) / span, (srcEnd - inMs) / span);
    const tEnd = isLast ? total : Math.min(total, Math.round(acc + segFloat));
    const durationMs = tEnd - prevT;
    if (durationMs < 1) {
      if (!isLast) continue; // 표시 길이 0 → 다음 세그먼트에 흡수
      // 마지막인데 남은 표시 길이가 0: 직전 세그먼트가 남은 소스를 흡수
      const lastSeg = segs[segs.length - 1];
      if (lastSeg) {
        lastSeg.outMs = outMs;
        lastSeg.speed = (lastSeg.outMs - lastSeg.inMs) / lastSeg.durationMs;
      } else {
        segs.push({ startMs: 0, durationMs: Math.max(0, durationMs), inMs, outMs, speed: clip.speed });
      }
      break;
    }
    segs.push({ startMs: prevT, durationMs, inMs: prevSrc, outMs: srcEnd, speed: (srcEnd - prevSrc) / durationMs });
    acc += segFloat;
    prevSrc = srcEnd;
    prevT = tEnd;
  }
  return segs;
}

// ── 색조정 커브 → 테이블 ─────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const identityFn = (x: number): number => x;

/** 단조 3차(Fritsch-Carlson) 보간 함수 — 오버슈트 없음. 범위 밖은 끝값 유지. */
function monotoneCubic(points: CurvePoint[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a.x - b.x);
  const n = pts.length;
  if (n === 0) return identityFn;
  if (n === 1) return () => pts[0]!.y;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  // 시컨트 기울기
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1]! - xs[i]!;
    d.push(h > 0 ? (ys[i + 1]! - ys[i]!) / h : 0);
  }
  // 접선: 끝점은 시컨트, 내부는 평균(부호가 다르면 0)
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  // Fritsch-Carlson 제한
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return (x: number): number => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = n - 2;
    for (let j = 0; j < n - 1; j++) {
      if (x < xs[j + 1]!) {
        i = j;
        break;
      }
    }
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! +
      (t3 - 2 * t2 + t) * h * m[i]! +
      (-2 * t3 + 3 * t2) * ys[i + 1]! +
      (t3 - t2) * h * m[i + 1]!
    );
  };
}

/**
 * ColorCurves → 채널별 33개 테이블(0..1) — SVG feFuncR/G/B tableValues 용.
 * 마스터(rgb)를 먼저 적용하고 채널 커브를 합성: table[i] = curveR(curveRgb(i/32)).
 * 커브가 하나도 없으면 null.
 */
export function curvesToTables(c: ColorCurves): { r: number[]; g: number[]; b: number[] } | null {
  if (!c || (!c.rgb && !c.r && !c.g && !c.b)) return null;
  const master = c.rgb ? monotoneCubic(c.rgb) : identityFn;
  const fr = c.r ? monotoneCubic(c.r) : identityFn;
  const fg = c.g ? monotoneCubic(c.g) : identityFn;
  const fb = c.b ? monotoneCubic(c.b) : identityFn;
  const sample = (f: (x: number) => number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= 32; i++) out.push(clamp01(f(clamp01(master(i / 32)))));
    return out;
  };
  return { r: sample(fr), g: sample(fg), b: sample(fb) };
}
