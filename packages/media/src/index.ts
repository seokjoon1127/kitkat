import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectEncoder,
  ffprobeJson,
  measureDurationMs,
  runFfmpeg,
  runFfmpegBuffer,
  toFwdSlash,
  PROXY_GOP,
  type RunOpts,
  PROXY_TAG,
  videoEncoderArgs,
} from './ffmpeg.js';

export { detectEncoder } from './ffmpeg.js';
export type { EncoderName } from './ffmpeg.js';
export {
  deriveMedia, gifToWebm,
  // W8 F1·F2 폴백 — AI 엔진이 없을 때 `upscale.ts`·`interpolate.ts` 가 이것으로 물러난다.
  upscaleVideo as upscaleVideoLanczos, interpolateFps as interpolateFpsMinterpolate,
  audioFilterChain, videoFilterChain, matchColorLevels, voiceChain, voiceLra, voiceIrPath,
  estimateMotionBlurSeconds, MOTION_BLUR_SEC_PER_SEC, VOICE_TRUE_PEAK_DB,
  MUSIC_LRA, loudnessLra,
} from './derive.js';
// W8 F1·F2 — AI 업스케일·보간 (기본 진입점). engine:'auto' 는 AI 가능하면 AI, 아니면 위 폴백.
export {
  upscaleVideo, isUpscaleAiReady, nativeScale, chunkFramesFor,
  UPSCALE_MODELS, DEFAULT_UPSCALE_MODEL,
} from './upscale.js';
export type {
  UpscaleEngine, UpscaleModel, UpscaleOpts, UpscaleResult, FrameProgress,
} from './upscale.js';
export {
  interpolateFps, isInterpolateAiReady, chunkTargets, supportsArbitraryRatio,
  INTERPOLATE_MODELS, DEFAULT_INTERPOLATE_MODEL,
} from './interpolate.js';
export type { InterpEngine, InterpolateOpts, InterpolateResult } from './interpolate.js';
export type {
  DeriveSpec, ChannelStat, MatchLevels, HslFamily, HslSecondary, HueSatBand,
  LoudnormStats, MotionBlurSpec, VoiceDeriveSpec, VoicePresetId, LoudnessDeriveSpec,
} from './derive.js';
export {
  clippedFraction, matchAffine, measureChannelHistograms, measureChannelStats,
  predictAfter, sampleTimesMs, statsFromHistogram, DEFAULT_SAMPLE_COUNT,
} from './measure.js';
export type { ChannelHistogram, Region } from './measure.js';
export { beatsFromPcm, detectBeats } from './beats.js';
export { parseCubeLut } from './lut.js';
export { mergeGpus, ncnnInfo, ncnnRun, pickSafeGpu } from './ncnn.js';
export type { NcnnGpu, NcnnInfo, NcnnTool } from './ncnn.js';
export {
  assertDiskSpace,
  estimateChunkBytes,
  outputTrim,
  planChunks,
  processInChunks,
} from './frames.js';
export type { ChunkPlan } from './frames.js';
// W8 F6 — 정밀 스코프(웨이브폼·벡터스코프·히스토그램) ffmpeg 래퍼
export {
  isScopeKind, measureStillStats, renderScopeImage, renderScopeImages, scopeFileName,
  statsFromRgba, statsSampleSize, SCOPE_FILTERS, SCOPE_KINDS, STATS_PIXEL_BUDGET,
} from './scopes.js';
export type { ScopeKind, StillStats } from './scopes.js';
// W8 F10 — 추적 궤적 간소화(RDP). 순수 함수, ffmpeg 무관.
export { maxTrackDeviation, rdpIndices, simplifyBoxTrack } from './rdp.js';
export type { BoxSample, Pt2, SimplifyReport } from './rdp.js';

export type ProbeResult = {
  kind: 'video' | 'audio' | 'image';
  duration?: number; // ms (정수)
  width?: number;
  height?: number;
  hasAudio?: boolean;
};

/** ffprobe format_name 토큰 중 정지 이미지로 취급하는 것들 (gif 는 영상 취급). */
const IMAGE_FORMAT_TOKENS = new Set([
  'image2', 'png_pipe', 'jpeg_pipe', 'mjpeg_pipe', 'bmp_pipe',
  'webp_pipe', 'tiff_pipe', 'psd_pipe', 'svg_pipe', 'exr_pipe',
  'dpx_pipe', 'ppm_pipe', 'pgm_pipe',
]);

export async function probeAsset(absPath: string): Promise<ProbeResult> {
  const info = await ffprobeJson(absPath);
  const streams = info.streams ?? [];
  // mp3 앨범아트 같은 attached_pic 비디오 스트림은 무시
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const formatTokens = (info.format?.format_name ?? '').split(',');

  const durationSec = Number(info.format?.duration ?? video?.duration ?? audio?.duration ?? NaN);
  const duration = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : undefined;

  if (video && formatTokens.some((t) => IMAGE_FORMAT_TOKENS.has(t))) {
    return { kind: 'image', width: video.width, height: video.height };
  }
  if (video) {
    return {
      kind: 'video',
      // 컨테이너에 duration이 없으면(MediaRecorder webm 등) 디코드로 실측한다
      duration: duration ?? (await measureDurationMs(absPath)),
      width: video.width,
      height: video.height,
      hasAudio: audio != null,
    };
  }
  if (audio) {
    return { kind: 'audio', duration: duration ?? (await measureDurationMs(absPath)), hasAudio: true };
  }
  throw new Error(`미디어 스트림을 찾지 못했습니다: ${absPath}`);
}


/**
 * 프록시 파일 이름의 **판(version) 표시**.
 *
 * 왜 이름을 바꾸나: 이미 만들어 둔 프록시는 키프레임 간격이 옛 값(약 250프레임)이다.
 * 이름이 같으면 «내 프록시가 어느 판인가» 를 알 길이 없다. 이름에 판을 박아 두면
 * 옛 파일은 그대로 두고(다시 굽지 않는다 — 라이브러리 전체 재인코딩은 몇 분씩 걸린다)
 * 나중에 «옛 프록시만 골라 다시 굽기» 를 파일 목록만 보고 할 수 있다.
 * 대가: 이미 임포트해 둔 에셋은 다시 임포트하기 전까지 옛 프록시(느린 스크럽)를 쓴다.
 */
export { PROXY_TAG };
export { runFfmpeg, runFfmpegProgress, runFfmpegBuffer, type RunOpts } from './ffmpeg.js';
export { runWithJobSignal, currentJobSignal, effectiveSignal } from './job-signal.js';

/**
 * 이 프록시가 «지금 판» 인가. 옛 판(`proxies/<id>.mp4`)은 키프레임 간격이 기본값(약 250프레임)이라
 * 스크럽이 느리다. 이미 임포트해 둔 에셋은 다시 굽기 전까지 옛 판을 쓴다.
 *
 * 판이 여러 번 바뀌어도 이 함수 하나만 보면 된다 — 파일 이름의 판 표시를 그대로 본다.
 */
export function isCurrentProxy(rel: string | undefined): boolean {
  if (!rel) return false;
  return rel.endsWith(`.${PROXY_TAG}.mp4`);
}

/** 540p 프록시 인코딩 한 벌 — 원본 프록시와 파생 프록시가 «같은 인코딩»이어야 스크럽 반응이 같다. */
async function encodeProxy(absSrc: string, outAbs: string, opts?: RunOpts): Promise<void> {
  await mkdir(path.dirname(outAbs), { recursive: true });
  const enc = await detectEncoder();
  await runFfmpeg([
    '-y', '-i', absSrc,
    '-vf', 'scale=-2:540',
    ...videoEncoderArgs(enc, 28),
    '-g', String(PROXY_GOP),
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    outAbs,
  ], opts);
}

/** 540p 편집용 프록시 생성 → "proxies/<id>.g15.mp4" (forward slash). */
export async function makeProxy(
  absSrc: string,
  mediaDir: string,
  assetId: string,
  opts?: RunOpts,
): Promise<string> {
  const name = `${assetId}.${PROXY_TAG}.mp4`;
  await encodeProxy(absSrc, path.join(mediaDir, 'proxies', name), opts);
  return `proxies/${name}`;
}

/**
 * 파생 미디어(derived/<id>.<key>.mp4)의 프록시만 다시 굽는다 → "derived/<id>.<key>.p.g15.mp4".
 * 파생 본체는 그대로 두고(다시 굽는 데 몇 분씩 걸린다) 540p 사본만 만든다 — 옛 판 프록시 갱신용.
 */
export async function makeDerivedProxy(
  absDerived: string,
  mediaDir: string,
  assetId: string,
  key: string,
  opts?: RunOpts,
): Promise<string> {
  const name = `${assetId}.${key}.p.${PROXY_TAG}.mp4`;
  await encodeProxy(absDerived, path.join(mediaDir, 'derived', name), opts);
  return `derived/${name}`;
}

/** 파형 PCM 샘플레이트 (8kHz mono) — 1ms 당 8샘플. */
const WAVEFORM_HZ = 8000;
/**
 * 버킷 시간 하한 20ms (= 160샘플).
 *
 * 옛 형식은 «길이와 무관하게 1000버킷» 이라 60초짜리는 버킷당 60ms 였다. 한국어 음절이
 * 100~200ms 이니 더킹 판정에 아슬아슬하고, 5분이면 버킷당 300ms 라 아예 못 쓴다.
 */
export const WAVEFORM_BUCKET_MS = 20;
/** 버킷 개수 상한 — 400초를 넘으면 버킷 시간을 늘려 파일 크기를 묶는다(상한에서 약 240KB). */
const WAVEFORM_MAX_BUCKETS = 20000;
/** PCM 추출 메모리 상한(8kHz mono s16le = 16KB/s → 약 4.5시간 분량). */
const PCM_MAX_BYTES = 256 * 1024 * 1024;

/**
 * 파형 데이터 (W8 F12) — **옛 형식은 `number[]`(1000버킷 peak) 였다.**
 * 읽는 쪽은 `Array.isArray()` 로 가르고, 옛 형식은 더킹에 쓰지 않는다
 * (버킷 시간을 알 수 없어 시각을 계산할 수 없다 → 다시 굽는다).
 */
export type WaveformData = {
  bucketMs: number;   // 버킷 하나의 길이 (ms)
  peaks: number[];    // 0..1 버킷 최댓값 — UI 파형 그리기 (파형이 살아 보인다)
  rms: number[];      // 0..1 버킷 RMS   — 더킹 판정 (클릭 잡음 하나에 안 속는다)
};

/** 소스 길이(ms)에 맞는 버킷 시간. 20ms 가 기본이고 아주 긴 파일만 늘어난다. */
export function waveformBucketMs(durationMs: number): number {
  return Math.max(WAVEFORM_BUCKET_MS, Math.ceil(durationMs / WAVEFORM_MAX_BUCKETS));
}

/**
 * 파형 JSON 생성 → "waveforms/<id>.json" ({ bucketMs, peaks, rms }).
 * 오디오 스트림이 없으면 null.
 *
 * peak 과 rms 를 «같은 루프에서» 낸다 — 비용이 같고, 용도가 다르다(위 타입 주석 참조).
 */
export async function makeWaveform(absSrc: string, mediaDir: string, assetId: string): Promise<string | null> {
  const probe = await probeAsset(absSrc);
  if (probe.kind === 'image' || probe.hasAudio !== true) return null;

  const pcm = await runFfmpegBuffer(
    ['-i', absSrc, '-vn', '-ac', '1', '-ar', String(WAVEFORM_HZ), '-f', 's16le', '-'],
    PCM_MAX_BYTES,
  );
  const sampleCount = Math.floor(pcm.length / 2);
  const bucketMs = waveformBucketMs((sampleCount / WAVEFORM_HZ) * 1000);
  const perBucket = (bucketMs * WAVEFORM_HZ) / 1000;
  const bucketCount = Math.max(1, Math.ceil(sampleCount / perBucket));

  const peaks = new Array<number>(bucketCount).fill(0);
  const rms = new Array<number>(bucketCount).fill(0);
  const sumSq = new Float64Array(bucketCount);
  const count = new Float64Array(bucketCount);
  for (let i = 0; i < sampleCount; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
    const b = Math.min(bucketCount - 1, Math.floor(i / perBucket));
    if (v > peaks[b]!) peaks[b] = v;
    sumSq[b]! += v * v;
    count[b]! += 1;
  }
  const round4 = (v: number) => Math.min(1, Math.round(v * 10000) / 10000);
  for (let b = 0; b < bucketCount; b++) {
    rms[b] = round4(count[b]! > 0 ? Math.sqrt(sumSq[b]! / count[b]!) : 0);
    peaks[b] = round4(peaks[b]!);
  }
  const data: WaveformData = { bucketMs, peaks, rms };

  const rel = `waveforms/${assetId}.json`;
  const outAbs = path.join(mediaDir, 'waveforms', `${assetId}.json`);
  await mkdir(path.dirname(outAbs), { recursive: true });
  await writeFile(outAbs, JSON.stringify(data));
  return rel;
}

/** 대표 썸네일 1장(영상은 중간 지점, 가로 320px) → "thumbs/<id>.jpg". */
export async function makeThumb(absSrc: string, mediaDir: string, assetId: string): Promise<string> {
  const rel = `thumbs/${assetId}.jpg`;
  const outAbs = path.join(mediaDir, 'thumbs', `${assetId}.jpg`);
  await mkdir(path.dirname(outAbs), { recursive: true });
  const probe = await probeAsset(absSrc);
  const args = ['-y'];
  if (probe.kind === 'video' && probe.duration != null && probe.duration > 0) {
    args.push('-ss', (probe.duration / 2000).toFixed(3)); // 중간 지점(초)
  }
  args.push('-i', absSrc, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', outAbs);
  await runFfmpeg(args);
  return rel;
}

/**
 * 역재생 파일 생성 → "derived/<id>.rev.mp4".
 * 통짜 -vf reverse 는 전 프레임을 메모리에 올려 OOM → 5초 청크 분할(segment muxer)
 * 후 청크별 reverse/areverse, 마지막에 역순 concat.
 */
export async function preprocessReverse(absSrc: string, mediaDir: string, assetId: string): Promise<string> {
  const rel = `derived/${assetId}.rev.mp4`;
  const outAbs = path.join(mediaDir, 'derived', `${assetId}.rev.mp4`);
  await mkdir(path.dirname(outAbs), { recursive: true });

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'kitkat-rev-'));
  try {
    const enc = await detectEncoder();
    const probe = await probeAsset(absSrc);
    const hasAudio = probe.hasAudio === true;

    // 1) 5초마다 강제 키프레임을 넣어 재인코딩하며 segment muxer 로 청크 분할
    await runFfmpeg([
      '-y', '-i', absSrc,
      ...videoEncoderArgs(enc, 18),
      '-force_key_frames', 'expr:gte(t,n_forced*5)',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      '-f', 'segment', '-segment_time', '5', '-reset_timestamps', '1',
      path.join(tmpDir, 'seg-%04d.mp4'),
    ]);
    const segs = (await readdir(tmpDir)).filter((f) => /^seg-\d+\.mp4$/.test(f)).sort();
    if (segs.length === 0) throw new Error(`역재생 청크 분할 결과가 없습니다: ${absSrc}`);

    // 2) 청크별 역재생
    for (const seg of segs) {
      await runFfmpeg([
        '-y', '-i', path.join(tmpDir, seg),
        '-vf', 'reverse',
        ...(hasAudio ? ['-af', 'areverse', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        ...videoEncoderArgs(enc, 18),
        path.join(tmpDir, seg.replace(/^seg-/, 'rev-')),
      ]);
    }

    // 3) 역순 concat (스트림 복사)
    const listAbs = path.join(tmpDir, 'concat.txt');
    const lines = segs
      .slice()
      .reverse()
      .map((seg) => `file '${toFwdSlash(path.join(tmpDir, seg.replace(/^seg-/, 'rev-')))}'`);
    await writeFile(listAbs, lines.join('\n') + '\n');
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listAbs,
      '-c', 'copy', '-movflags', '+faststart',
      outAbs,
    ]);
    return rel;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** 오디오 추출 → wav 16kHz mono (outAbs 절대경로에 저장). */
export async function extractAudio(absSrc: string, outAbs: string): Promise<void> {
  await mkdir(path.dirname(outAbs), { recursive: true });
  await runFfmpeg(['-y', '-i', absSrc, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outAbs]);
}

/** mp4 → gif 변환 (palettegen/paletteuse 2패스). */
export async function toGif(
  mp4Abs: string,
  gifAbs: string,
  opts?: { fps?: number; width?: number },
): Promise<void> {
  const fps = opts?.fps ?? 15;
  const width = opts?.width ?? 480;
  await mkdir(path.dirname(gifAbs), { recursive: true });
  const palette = path.join(
    path.dirname(gifAbs),
    `.palette-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );
  const chain = `fps=${fps},scale=${width}:-2:flags=lanczos`;
  try {
    await runFfmpeg(['-y', '-i', mp4Abs, '-vf', `${chain},palettegen`, palette]);
    await runFfmpeg(['-y', '-i', mp4Abs, '-i', palette, '-lavfi', `${chain}[x];[x][1:v]paletteuse`, gifAbs]);
  } finally {
    await rm(palette, { force: true });
  }
}
