import { execa } from 'execa';
import { effectiveSignal } from './job-signal.js';

export type EncoderName = 'h264_qsv' | 'libx264';

const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';

export type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
};

export type FfprobeResult = {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
};

/**
 * `signal` — 잡 큐가 시간 초과로 포기할 때 **ffmpeg 프로세스도 같이 죽인다**(SIGTERM).
 * 없으면 큐만 다음으로 넘어가고 ffmpeg 은 끝날 때까지(또는 영원히) 살아남는다 — W8 F17 리뷰 #12.
 */
export type RunOpts = { cwd?: string; signal?: AbortSignal };

/** ffmpeg 실행(에러 시 throw). 전역 옵션 -hide_banner -v error 를 앞에 붙인다. */
export async function runFfmpeg(args: string[], opts?: RunOpts): Promise<void> {
  await execa(FFMPEG, ['-hide_banner', '-v', 'error', ...args], { cwd: opts?.cwd, cancelSignal: effectiveSignal(opts?.signal) });
}

/**
 * ffmpeg 실행 + `-progress pipe:1` 의 out_time_us 를 스트리밍 파싱해
 * 진행률(0..1 = out_time / totalMs)을 통지한다. totalMs 나 onProgress 가 없으면 runFfmpeg 과 동일.
 */
export async function runFfmpegProgress(
  args: string[],
  totalMs: number | undefined,
  onProgress?: (p: number) => void,
  opts?: RunOpts,
): Promise<void> {
  if (!onProgress || totalMs == null || totalMs <= 0) {
    await runFfmpeg(args, opts);
    return;
  }
  const child = execa(FFMPEG, ['-hide_banner', '-v', 'error', '-progress', 'pipe:1', ...args], {
    cwd: opts?.cwd,
    cancelSignal: effectiveSignal(opts?.signal),
  });
  let acc = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    acc += chunk.toString('utf8');
    const nl = acc.lastIndexOf('\n');
    if (nl < 0) return;
    const complete = acc.slice(0, nl);
    acc = acc.slice(nl + 1);
    const matches = complete.match(/out_time_us=(\d+)/g);
    const last = matches?.[matches.length - 1];
    if (last) {
      const us = Number(last.slice('out_time_us='.length));
      if (Number.isFinite(us) && us >= 0) onProgress(Math.min(1, us / 1000 / totalMs));
    }
  });
  await child;
}

/** ffmpeg stdout 을 바이너리로 수집(메모리 상한 maxBuffer 바이트). */
export async function runFfmpegBuffer(
  args: string[],
  maxBuffer: number,
  opts?: RunOpts,
): Promise<Buffer> {
  const { stdout } = await execa(FFMPEG, ['-hide_banner', '-v', 'error', ...args], {
    encoding: 'buffer',
    maxBuffer,
    cwd: opts?.cwd,
    cancelSignal: effectiveSignal(opts?.signal),
  });
  return Buffer.from(stdout);
}

/**
 * 컨테이너에 duration 헤더가 없는 파일(MediaRecorder가 만든 webm 등)의 길이를
 * 끝까지 디코드해 실측한다(ms). 측정 불가면 undefined.
 */
export async function measureDurationMs(absPath: string): Promise<number | undefined> {
  const res = await execa(
    FFMPEG,
    ['-hide_banner', '-v', 'error', '-progress', 'pipe:1', '-i', absPath, '-f', 'null', '-'],
    { reject: false },
  );
  const matches = String(res.stdout).match(/out_time_us=(\d+)/g);
  const last = matches?.[matches.length - 1];
  if (!last) return undefined;
  const us = Number(last.slice('out_time_us='.length));
  return Number.isFinite(us) && us > 0 ? Math.round(us / 1000) : undefined;
}

export async function ffprobeJson(absPath: string): Promise<FfprobeResult> {
  const { stdout } = await execa(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    absPath,
  ]);
  return JSON.parse(stdout) as FfprobeResult;
}

let cachedEncoder: Promise<EncoderName> | null = null;

/**
 * ffmpeg 직접 인코딩 경로(프록시·역재생)용 인코더 감지.
 * -encoders 파싱 + 1프레임 시험 인코딩. 결과는 프로세스 수명 동안 캐시.
 */
export function detectEncoder(): Promise<EncoderName> {
  if (!cachedEncoder) cachedEncoder = doDetectEncoder();
  return cachedEncoder;
}

async function doDetectEncoder(): Promise<EncoderName> {
  const listed = await execa(FFMPEG, ['-hide_banner', '-encoders'], { reject: false });
  if (listed.exitCode !== 0 || !/\bh264_qsv\b/.test(String(listed.stdout))) return 'libx264';
  const trial = await execa(
    FFMPEG,
    [
      '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=256x256:rate=30',
      '-frames:v', '1', '-c:v', 'h264_qsv', '-f', 'null', '-',
    ],
    { reject: false },
  );
  return trial.exitCode === 0 ? 'h264_qsv' : 'libx264';
}

/** 인코더별 비디오 인코딩 인자. qsv 는 -crf 미지원이라 -global_quality 26 고정. */
/**
 * 편집용 프록시의 키프레임 간격 — **0.5초마다 한 장**(30fps 기준 15프레임).
 *
 * libx264 기본값은 약 250프레임(8초)이라 스크럽에 최악이다. 어느 시각의 한 프레임을
 * 보려면 그 앞 키프레임까지 되감고 거기서부터 전부 디코딩해야 하기 때문이다.
 * **프록시의 존재 이유가 편집 반응성** 이므로 파일이 커지는 대가를 치른다.
 *
 * 실측(540p, veryfast, crf 28): 파일 크기 **+26.5% ~ +61.7%**,
 * 그 대신 임의 지점 점프가 `<video>` 경로 25.3ms → 4.2ms, WebCodecs 경로 28.7ms → 5.8ms.
 *
 * 원본 프록시(`makeProxy`)와 파생 프록시(`deriveMedia`) **둘 다** 이 값을 쓴다.
 */
export const PROXY_GOP = 15;

/** 프록시 파일 이름의 판 표시. 원본(`proxies/<id>.g15.mp4`)·파생(`….p.g15.mp4`) 둘 다 이걸 붙인다. */
export const PROXY_TAG = 'g15';

export function videoEncoderArgs(encoder: EncoderName, crf: number): string[] {
  if (encoder === 'h264_qsv') return ['-c:v', 'h264_qsv', '-global_quality', '26'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
}

/** Windows 경로 구분자를 forward slash 로 통일. */
export function toFwdSlash(p: string): string {
  return p.replaceAll('\\', '/');
}
