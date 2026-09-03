import { runFfmpegBuffer } from './ffmpeg.js';

const HOP = 1024; // 홉 (샘플)
const WIN = 2048; // 분석 창 (샘플, 2의 거듭제곱)
const AVG_WINDOW = 20; // 이동 평균 반경 (±홉)
const THRESHOLD_RATIO = 1.5; // 임계 = 이동 평균 × 1.5
const MIN_GAP_MS = 200; // 비트 최소 간격
const SILENCE_EPS = 1e-6; // 무음 플럭스 하한
/**
 * 온셋 최소 세기: 플럭스가 그 프레임 스펙트럼 크기 합의 5% 는 넘어야 한다.
 * 이동 평균 대비 배수(THRESHOLD_RATIO)만으로는 «지속음의 미세한 흔들림» 도 지역
 * 최대점이 되면 통과한다. 지속 톤/화음의 창 누설 흔들림은 스펙트럼 합의 0.06%
 * 이하, 실제 온셋(클릭·말소리)은 43% 이상이라 그 사이 어디를 잘라도 된다.
 * 진폭에 비례하는 값이라 조용한 오디오에서도 기준이 같다.
 */
const ONSET_RATIO = 0.05;

/** PCM 추출 메모리 상한 (22050Hz mono s16le ≈ 44KB/s → 약 100분 분량). */
const BEATS_PCM_MAX_BYTES = 256 * 1024 * 1024;

/** in-place 라딕스-2 FFT (반복형 Cooley-Tukey). 길이는 2의 거듭제곱. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + half]! * cr - im[i + k + half]! * ci;
        const bi = re[i + k + half]! * ci + im[i + k + half]! * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + half] = ar - br;
        im[i + k + half] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * PCM(mono s16) 에서 비트 시각(정수 ms, 오름차순)을 찾는다.
 * 해닝 창 스펙트럼의 양의 차분 합(스펙트럼 플럭스) → 스펙트럼 크기 합의 5% 이상이고
 * 이동 평균(±20홉)×1.5 를 넘는 지역 최대점 → 인접 프레임 플럭스 가중으로 창 중심을
 * 보정 → 최소 간격 200ms.
 *
 * 한계: 프레임 0 은 비교할 이전 프레임이 없어 플럭스를 정의할 수 없으므로 후보에서
 * 제외한다. 따라서 첫 홉(22050Hz 기준 약 46ms) 안에서 시작하는 온셋은 검출되지
 * 않는다. 실제 오디오는 앞에 약간의 무음이 있는 것이 보통이라 문제되지 않는다.
 */
export function beatsFromPcm(pcm: Int16Array, sampleRate: number): number[] {
  if (sampleRate <= 0 || pcm.length < WIN) return [];
  const frameCount = Math.floor((pcm.length - WIN) / HOP) + 1;

  const hann = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));

  const flux = new Float64Array(frameCount);
  const magSum = new Float64Array(frameCount); // 프레임별 스펙트럼 크기 합 (온셋 세기 기준)
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  let prev = new Float64Array(WIN / 2);
  let cur = new Float64Array(WIN / 2);
  for (let f = 0; f < frameCount; f++) {
    const off = f * HOP;
    for (let i = 0; i < WIN; i++) {
      re[i] = (pcm[off + i]! / 32768) * hann[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    let mag = 0;
    for (let k = 0; k < WIN / 2; k++) {
      const m = Math.hypot(re[k]!, im[k]!);
      cur[k] = m;
      mag += m;
      const d = m - prev[k]!;
      if (d > 0) sum += d;
    }
    magSum[f] = mag;
    // 프레임 0 의 prev 는 0 배열이라 스펙트럼 전체가 플럭스로 잡힌다(가짜 온셋).
    // 실제 비교는 f=1 부터. flux[0] 은 0 으로 두어 후보에서 빠지게 한다.
    flux[f] = f === 0 ? 0 : sum;
    const t = prev;
    prev = cur;
    cur = t;
  }

  const beats: number[] = [];
  let lastMs = -Infinity;
  for (let f = 1; f < frameCount; f++) {
    const v = flux[f]!;
    if (v <= SILENCE_EPS) continue;
    if (v <= magSum[f]! * ONSET_RATIO) continue; // 지속음의 미세한 흔들림 배제
    const left = flux[f - 1]!;
    const right = f < frameCount - 1 ? flux[f + 1]! : 0;
    if (v < left || v <= right) continue; // 지역 최대 (동점은 뒤 프레임이 가져간다)

    let s = 0;
    let c = 0;
    for (let j = Math.max(1, f - AVG_WINDOW); j <= Math.min(frameCount - 1, f + AVG_WINDOW); j++) {
      s += flux[j]!;
      c++;
    }
    if (v <= (s / c) * THRESHOLD_RATIO) continue;

    // 시각 = 인접 3프레임의 플럭스 가중 평균한 창 중심 (홉 단위 양자화 오차 보정)
    const centerSamples = f * HOP + WIN / 2 + ((right - left) / (left + v + right)) * HOP;
    const ms = Math.round((centerSamples / sampleRate) * 1000);
    if (ms - lastMs < MIN_GAP_MS) continue;
    beats.push(ms);
    lastMs = ms;
  }
  return beats;
}

/** 오디오를 22050Hz mono PCM 으로 뽑아 비트 시각(ms, 오름차순)을 찾는다. */
export async function detectBeats(absSrc: string): Promise<number[]> {
  const buf = await runFfmpegBuffer(
    ['-i', absSrc, '-vn', '-ac', '1', '-ar', '22050', '-f', 's16le', '-'],
    BEATS_PCM_MAX_BYTES,
  );
  const aligned = buf.byteOffset % 2 === 0 ? buf : Buffer.from(buf);
  const pcm = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.length / 2));
  return beatsFromPcm(pcm, 22050);
}
