// 더킹(ducking) — 목소리가 나오는 동안 음악 볼륨을 낮추는 volume 키프레임을 만든다 (계획 X2 · M4).
// 순수 함수: 문서를 건드리지 않고 키프레임 배열만 돌려준다.
//
// W8 F12-B: 「목소리 클립이 놓여 있으면 그 구간 전부가 목소리」였던 입력을 **파형 포락선**으로
// 바꾼다. 알고리즘(엔벨로프·합집합·교점)은 그대로다 — 문제는 방식이 아니라 입력 해상도였다.
import { rampSegments, type AudioClip, type Easing, type Keyframe, type VideoClip } from '@kitkat/schema';

export type DuckInterval = { start: number; end: number };  // 타임라인 절대 ms

/** 겹치거나 맞닿은 구간을 합친다(합집합). 결과는 start 오름차순. */
function unionIntervals(list: DuckInterval[]): DuckInterval[] {
  const sorted = list.filter((iv) => iv.end > iv.start).sort((a, b) => a.start - b.start);
  const out: DuckInterval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/**
 * 구간 하나가 시각 t 에 만드는 감쇠 배수.
 * [s-attack, s] 에서 1 → amount 로 내려가고, [s, e] 는 amount, [e, e+release] 에서 amount → 1 로 올라온다.
 */
function duckFactor(t: number, iv: DuckInterval, amount: number, attackMs: number, releaseMs: number): number {
  const a = iv.start - attackMs;
  const r = iv.end + releaseMs;
  if (t >= iv.start && t <= iv.end) return amount;   // attack/release 가 0이어도 구간 안은 amount
  if (t <= a || t >= r) return 1;
  if (t < iv.start) return 1 + (amount - 1) * ((t - a) / attackMs);   // attackMs > 0 이 보장된 분기
  return amount + (1 - amount) * ((t - iv.end) / releaseMs);          // releaseMs > 0 이 보장된 분기
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * 음악 클립 하나에 대한 volume 키프레임(클립 시작 기준 ms).
 * - voiceIntervals 는 타임라인 절대 ms — 내부에서 합집합을 구하고 클립 상대 ms 로 옮긴다.
 * - 기준 볼륨은 `musicClip.volume` (렌더러의 interpolateKeyframes 폴백과 같다).
 * - 감쇠가 전혀 없으면 빈 배열.
 */
/**
 * 램프의 이징 (W8 F12-B/S2).
 *
 * - `'linear'` — 기본값. 기존 동작 그대로다.
 * - `'comp'` — 「강한 감속」 베지어. 진짜 컴프레서의 게인 곡선은 지수형이라 **빠르게 내려갔다
 *   천천히 안착**하는데, 직선 램프는 그 모양이 아니다. 렌더의 `sidechaincompress` 와
 *   미리보기의 키프레임이 덜 갈리게 하려고 램프에만 이 곡선을 쓴다.
 *
 * 기본값을 바꾸지 않는 이유: 이 함수는 이미 쓰이고 있고, 이징을 바꾸면 **기존 문서의 소리가
 * 조용히 변한다**. 새 경로(포락선 더킹)에서만 켠다.
 */
export type DuckCurve = 'linear' | 'comp';

/** 컴프의 지수 곡선에 가까운 「강한 감속」 (계획 12 가 지정한 제어점). */
export const DUCK_COMP_EASING: Easing = { bezier: [0.19, 1, 0.22, 1] };

export function duckKeyframes(
  musicClip: AudioClip | VideoClip,
  voiceIntervals: DuckInterval[],
  amount: number,
  attackMs: number,
  releaseMs: number,
  curve: DuckCurve = 'linear',
): Keyframe[] {
  const base = musicClip.volume;
  const dur = musicClip.duration;
  if (dur <= 0) return [];

  const rel = unionIntervals(
    voiceIntervals.map((iv) => ({ start: iv.start - musicClip.start, end: iv.end - musicClip.start })),
  ).filter((iv) => iv.end + releaseMs > 0 && iv.start - attackMs < dur);
  if (rel.length === 0) return [];

  // 엔벨로프는 구간선형이다. 꺾이는 지점은 구간마다 네 시각(attack 시작·구간 시작·구간 끝·release 끝)에다,
  // 이웃한 두 구간의 release 램프와 attack 램프가 겹칠 때 생기는 교점 하나가 전부다 — 그 지점만 샘플링하면 된다.
  // attack/release 가 0이면 계단이 되는데 키프레임으로는 표현할 수 없으므로 최소 1ms 램프로 둔다.
  const times = new Set<number>();
  const addTime = (t: number): void => { times.add(Math.min(dur, Math.max(0, t))); };
  for (const iv of rel) {
    const before = iv.start - Math.max(attackMs, 1);
    const after = iv.end + Math.max(releaseMs, 1);
    for (const t of [before, iv.start, iv.end, after]) addTime(Math.round(t));
  }

  // 앞 구간의 release 선(e에서 amount → e+R에서 1)과 뒤 구간의 attack 선(s-A에서 1 → s에서 amount)의 교점:
  //   amount + (1-amount)·(t-e)/R = 1 + (amount-1)·(t-s+A)/A  ⟹  t = (e·A + s·R) / (A + R)
  // (amount 와 무관한 가중평균이다.) 이 t 가 두 램프 안에 들어오는 조건은 틈 s-e 가 A+R 보다 좁은 것과 같다.
  // 여기를 빠뜨리면 두 키프레임 사이가 직선으로 이어져 목소리 사이에서 음악이 눌린 채로 남는다.
  // 키프레임 time 은 정수 ms 라, 교점이 정수가 아니면 양옆 정수를 둘 다 넣는다(정수 격자 위에서는 정확해진다).
  if (attackMs > 0 && releaseMs > 0) {
    for (let i = 1; i < rel.length; i++) {
      const e = rel[i - 1]!.end;
      const s = rel[i]!.start;
      if (s - e >= attackMs + releaseMs) continue;   // 램프가 겹치지 않으면 교점이 구간 밖이다
      const cross = (e * attackMs + s * releaseMs) / (attackMs + releaseMs);
      addTime(Math.floor(cross));
      addTime(Math.ceil(cross));
    }
  }

  const easing: Easing = curve === 'comp' ? DUCK_COMP_EASING : 'linear';
  let dipped = false;
  const kfs: Keyframe[] = [...times]
    .sort((a, b) => a - b)
    .map((time) => {
      let f = 1;
      for (const iv of rel) {
        const x = duckFactor(time, iv, amount, attackMs, releaseMs);
        if (x < f) f = x;
      }
      if (f < 1) dipped = true;
      return { time, prop: 'volume', value: round6(base * f), easing } satisfies Keyframe;
    });

  return dipped ? kfs : [];
}

// ── W8 F12-B: 파형 포락선 → 목소리 구간 ───────────────────────────────────

/** 파형 파일(`waveforms/<assetId>.json`)의 더킹용 부분. peaks 는 그리기용이라 안 쓴다. */
export type VoiceEnvelope = { bucketMs: number; rms: number[] };

/** 대사 사이 이만큼의 «틈» 은 말이 이어지는 것으로 본다 (Premiere 의 Sensitivity). */
export const DUCK_SENSITIVITY_MS = 300;
/** 이보다 짧은 «말» 은 무시한다 — 기침·마우스 클릭·립노이즈를 거른다. */
export const DUCK_MIN_SPEECH_MS = 120;
/** 적응형 임계: 「말하는 레벨」(90퍼센타일)에서 이만큼 아래. */
export const DUCK_ADAPTIVE_DROP_DB = 25;

const dbToLinear = (db: number): number => Math.pow(10, db / 20);

/**
 * 클립이 실제로 쓰는 구간의 «말하는 레벨» = 0 아닌 RMS 의 90퍼센타일.
 * 고정 임계(-40dBFS 같은 것)를 기본으로 하면 조용히 녹음된 나레이션에서 아무것도 안 잡힌다.
 */
function speechLevel(rms: readonly number[], b0: number, b1: number): number {
  const vals: number[] = [];
  for (let b = b0; b < b1; b++) {
    const v = rms[b];
    if (v != null && v > 0) vals.push(v);
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))]!;
}

/** 소스 ms 구간 → 클립 시작 기준 ms 구간. 매핑을 못 하면 null(호출자가 클립 전체로 물러선다). */
type SrcToLocal = (srcMs: number) => number;

/**
 * 소스 시각 → 클립 로컬 시각 변환기.
 * - 등속: `(src - in) / speed`
 * - 역재생: `clip.in`/`out` 은 **원본** 좌표이고 재생 순서만 뒤집힌다 → `(out - src) / speed`
 * - 속도 램프: 세그먼트별로 선형 변환한다(등속 가정으로 계산하면 램프 구간에서 수백 ms 어긋난다)
 * - **역재생 + 속도 램프**: 두 좌표계가 겹쳐 조용히 틀리기 쉬워 매핑하지 않는다(null).
 *   호출자가 클립 전체를 한 구간으로 본다 — 옛 동작이고, 어긋난 더킹보다 낫다.
 */
function srcToLocal(clip: AudioClip | VideoClip): SrcToLocal | null {
  const reversed = clip.kind === 'video' && clip.reversed === true;
  const ramp = clip.kind === 'video' && clip.speedRamp != null;
  if (ramp) {
    if (reversed) return null;
    const segs = rampSegments(clip as VideoClip);
    if (segs.length === 0) return null;
    return (srcMs: number) => {
      for (const s of segs) {
        if (srcMs <= s.outMs || s === segs[segs.length - 1]) {
          const span = s.outMs - s.inMs;
          const u = span > 0 ? (srcMs - s.inMs) / span : 0;
          return s.startMs + u * s.durationMs;
        }
      }
      return 0;
    };
  }
  const speed = clip.speed > 0 ? clip.speed : 1;
  return reversed
    ? (srcMs: number) => (clip.out - srcMs) / speed
    : (srcMs: number) => (srcMs - clip.in) / speed;
}

/** 겹치거나 «gapMs 이하로 떨어진» 구간을 붙인다. */
function mergeGaps(list: DuckInterval[], gapMs: number): DuckInterval[] {
  const out: DuckInterval[] = [];
  for (const iv of unionIntervals(list)) {
    const last = out[out.length - 1];
    if (last && iv.start - last.end <= gapMs) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

/**
 * 목소리 트랙의 클립 + 파형 포락선 → 실제로 «말하는» 구간 (타임라인 절대 ms).
 *
 * `duckKeyframes` 는 손대지 않는다 — 이미 `DuckInterval[]` 을 받는 순수 함수라
 * **구간을 어떻게 만드느냐만** 바뀐다.
 *
 * - 포락선이 없는 클립(옛 형식 파형·아직 안 구움)은 **클립 전체**를 한 구간으로 본다.
 *   조용히 빼면 그 클립에서 더킹이 통째로 사라진다.
 * - `clip.volume === 0` 인 클립은 건너뛴다 — 안 들리는 소리가 더킹을 일으키면 안 된다.
 *   (트랙 muted 는 호출자가 거른다.)
 */
export function voiceIntervalsFromEnvelope(
  clips: readonly (AudioClip | VideoClip)[],
  envelopes: Record<string, VoiceEnvelope>,
  opts?: { thresholdDb?: number; sensitivityMs?: number; minSpeechMs?: number },
): DuckInterval[] {
  const sensitivityMs = opts?.sensitivityMs ?? DUCK_SENSITIVITY_MS;
  const minSpeechMs = opts?.minSpeechMs ?? DUCK_MIN_SPEECH_MS;
  const raw: DuckInterval[] = [];

  for (const clip of clips) {
    if (clip.volume === 0) continue;
    const whole = { start: clip.start, end: clip.start + clip.duration };
    const env = envelopes[clip.assetId];
    const map = srcToLocal(clip);
    if (!env || !(env.bucketMs > 0) || env.rms.length === 0 || !map) {
      raw.push(whole);
      continue;
    }
    const b0 = Math.max(0, Math.floor(clip.in / env.bucketMs));
    const b1 = Math.min(env.rms.length, Math.ceil(clip.out / env.bucketMs));
    if (b1 <= b0) {
      raw.push(whole);
      continue;
    }
    const level = speechLevel(env.rms, b0, b1);
    const threshold =
      opts?.thresholdDb != null
        ? dbToLinear(opts.thresholdDb)
        : level * dbToLinear(-DUCK_ADAPTIVE_DROP_DB);
    if (!(threshold > 0)) continue;   // 통째로 무음인 클립 — 더킹할 것이 없다

    // loop 클립은 소스를 반복해 duration 을 채운다 → 한 바퀴 분량을 반복해 깐다.
    const passMs = Math.max(1, Math.abs(clip.out - clip.in) / (clip.speed > 0 ? clip.speed : 1));
    const passes =
      clip.kind === 'video' && clip.loop === true ? Math.ceil(clip.duration / passMs) : 1;

    for (let b = b0; b < b1; b++) {
      if ((env.rms[b] ?? 0) < threshold) continue;
      const s0 = Math.max(clip.in, b * env.bucketMs);
      const s1 = Math.min(clip.out, (b + 1) * env.bucketMs);
      if (s1 <= s0) continue;
      const t0 = map(s0);
      const t1 = map(s1);
      const lo = Math.min(t0, t1);
      const hi = Math.max(t0, t1);
      for (let k = 0; k < passes; k++) {
        const off = k * passMs;
        const start = Math.max(0, lo + off);
        const end = Math.min(clip.duration, hi + off);
        if (end > start) raw.push({ start: clip.start + start, end: clip.start + end });
      }
    }
  }

  // 어절 사이 틈을 메운 «뒤» 짧은 말을 버린다 — 순서를 바꾸면 이어진 말이 토막나 버려진다.
  return mergeGaps(raw, sensitivityMs).filter((iv) => iv.end - iv.start >= minSpeechMs);
}
