// @kitkat/ai — F10 마스크 모션 트래킹. OpenCV TrackerVit 을 파이썬으로 돌리고 결과를 판정한다.
//
// demucs.ts 와 같은 규약: VENV_PYTHON 실행 → stdout JSON → 모듈 없으면 exit 3 →
// 노드가 AiUnavailableError → 서버가 HTTP 501 + 설치 안내(`node scripts/prewarm.mjs tracker`).
//
// **파이썬은 판정하지 않는다.** 점수와 상자를 있는 그대로 주고, 「추적 성공인가」는
// 여기 classifyTrack 이 정한다 — 규칙을 opencv 없이 단위 테스트할 수 있어야 한다.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { effectiveSignal } from '@kitkat/media';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_PYTHON = join(
  PKG_ROOT,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const SCRIPT_PATH = join(PKG_ROOT, 'python', 'track.py');

/** OpenCV Zoo, Apache-2.0, 0.71MB. */
export const VITTRACK_MODEL_FILE = 'object_tracking_vittrack_2023sep.onnx';
export const VITTRACK_MODEL_URL =
  'https://github.com/opencv/opencv_zoo/raw/main/models/object_tracking_vittrack/' +
  VITTRACK_MODEL_FILE;
/**
 * 받은 파일의 SHA-256 (2026-09-02 실측, 714,726 바이트).
 * 0.7MB 짜리라 받다 끊겨도 「파일이 있다」로 보여서, 검증 없이는 조용히 이상하게 동작한다.
 */
export const VITTRACK_MODEL_SHA256 =
  '2990f0b7cd44d92afa48cd97db6de7be113fc1d9594fddb74e2725c10478e91d';

export function vittrackModelPath(): string {
  return join(PKG_ROOT, 'models', VITTRACK_MODEL_FILE);
}

/** 추적 30분 상한 — 900프레임이 4초인데 1080p 긴 클립·느린 디스크를 넉넉히 덮는다. */
const TRACK_TIMEOUT_MS = 30 * 60 * 1000;

// ── 판정 규칙 (전부 실측으로 정한 값 — 아래 주석의 숫자를 근거 없이 바꾸지 마라) ─────

/**
 * 이 점수 아래면 실패. **0.45 는 재서 정한 값이다.**
 *
 * 합성 영상 5종 745프레임(사인파 왕복 / 1.0→2.0배 확대 / 화면 밖 이탈·복귀 /
 * 3초 완전 가림 / 조명 4배 급변)에서 임계를 훑은 결과:
 *
 * | 임계 | 놓친 실패 | 거짓 실패 |
 * |------|----------|----------|
 * | 0.30 |  22 (3.0%) |  1 |
 * | 0.40 |   1 (0.1%) |  2 |
 * | **0.45** | **0** | **2 (0.27%)** |
 * | 0.50 |   0        |  9 (1.21%) |
 * | 0.55 |   0        | 148 (19.9%) |
 *
 * 계획서 규칙이 「놓친 실패가 1건이라도 나오면 임계를 올린다」라서 0.45 다.
 * **주의**: 사인파 영상(빠른 움직임)의 점수 5분위가 0.48 이라 0.45 는 그 분포의 바로 아래다.
 * 아주 빠르게 움직이는 소재에서 거짓 실패가 잦으면 API 의 `scoreThreshold` 로 낮춰라.
 */
export const DEFAULT_SCORE_THRESHOLD = 0.45;

/**
 * 상자 넓이가 기준 상자의 몇 배까지 정상인가.
 *
 * **점수만으로는 실패를 못 잡는다 — 이게 실측의 핵심 발견이다.** 대상을 놓친 뒤
 * ViT 는 화면 전체(1280×720 영상에서 1397×812)를 상자로 잡고 **점수를 0.78 로 되돌린다.**
 * 점수만 보면 「잘 따라가는 중」이다. 넓이 검사를 빼면 놓친 실패가 745프레임 중 187건이다.
 */
const AREA_RATIO_MAX = 16;
/** 상자가 화면의 이 비율을 넘으면 추적이 아니다(마스크가 화면 전체면 가릴 것이 없다). */
const FRAME_FRACTION_MAX = 0.8;
/** 이만큼 연속으로 실패하면 그 뒤는 전부 실패다 — ViT 는 놓친 대상으로 스스로 못 돌아온다. */
const STICKY_RUN = 3;
/** 이보다 짧은 실패 구간은 일시적 흔들림으로 보고 앞뒤를 이어 준다(깜빡임 방지). */
const BRIDGE_RUN = 3;

// ── 타입 ──────────────────────────────────────────────────────────────────

/** track.py 가 그대로 주는 한 프레임 — 좌표는 **소스 파일 픽셀**. */
export type TrackFrame = {
  frame: number;
  /** 소스 파일 기준 정수 ms */
  ms: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
};

export type TrackResult = {
  fps: number;
  width: number;
  height: number;
  frames: TrackFrame[];
};

/**
 * 추적 방향. `startMs` 는 **어느 쪽이든 기준 상자의 시각**이고 `endMs` 가 반대편 끝이다.
 * - `forward` — 기준에서 뒤로. `endMs > startMs`.
 * - `backward` — 기준에서 앞으로. `endMs < startMs` (기본 파일 처음).
 */
export type TrackDirection = 'forward' | 'backward';

export type TrackOpts = {
  /** 시작 상자 — 소스 픽셀 */
  box: { x: number; y: number; w: number; h: number };
  /** 기준 상자의 시각 — **디코드할 파일 기준** 정수 ms */
  startMs: number;
  /** 반대편 끝(포함). forward 면 뒤쪽 끝(기본 EOF), backward 면 앞쪽 끝(기본 0). */
  endMs?: number;
  /** 기본 `forward`. `backward` 는 창 단위 디코드로 뒤로 훑는다 (track.py 헤더 주석 참고). */
  direction?: TrackDirection;
  /** 1 = 매 프레임(기본). 2 이상은 사용자가 «명시적으로» 켜는 옵션이다. */
  stride?: number;
  /** `done`·`total` 은 파이썬이 세는 «실제» 프레임 수 (total 0 = 아직 모름). */
  onProgress?: (p: number, done: number, total: number) => void;
  /** 잡 큐 시간 초과 → 파이썬 프로세스도 같이 죽인다 (리뷰 #12) */
  signal?: AbortSignal;
};

export class TrackerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerUnavailableError';
  }
}

// ── 준비 확인 ─────────────────────────────────────────────────────────────

async function canImportCv2(): Promise<boolean> {
  try {
    await execa(VENV_PYTHON, ['-c', 'import cv2; cv2.TrackerVit']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 설치를 **시도하지 않는** 빠른 준비 확인 (수 초). Demucs 의 isDemucsReady 와 같은 이유 —
 * 43.8MB 휠 설치를 HTTP 요청 처리 중에 기다리면 클라이언트가 먼저 타임아웃난다.
 */
export async function isTrackerReady(): Promise<boolean> {
  if (!existsSync(VENV_PYTHON)) return false;
  if (!existsSync(vittrackModelPath())) return false;
  return canImportCv2();
}

/** 모델 파일이 «있고 해시가 맞는가». 받다 끊긴 파일을 잡는다. */
export async function verifyModel(): Promise<{ ok: boolean; hint?: string }> {
  const p = vittrackModelPath();
  let buf: Buffer;
  try {
    buf = await readFile(p);
  } catch {
    return { ok: false, hint: `모델 파일이 없습니다: ${p}` };
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== VITTRACK_MODEL_SHA256) {
    return {
      ok: false,
      hint: `모델 파일 해시가 다릅니다 (받다 끊겼거나 다른 파일). 기대 ${VITTRACK_MODEL_SHA256.slice(0, 12)}…, 실제 ${sha.slice(0, 12)}…`,
    };
  }
  return { ok: true };
}

/** 모델 ONNX 를 packages/ai/models/ 에 받고 SHA-256 을 검증한다. 이미 맞으면 아무것도 안 한다. */
export async function downloadModel(): Promise<{ ok: boolean; hint?: string }> {
  if ((await verifyModel()).ok) return { ok: true };
  const dest = vittrackModelPath();
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    const res = await fetch(VITTRACK_MODEL_URL);
    if (!res.ok || !res.body) return { ok: false, hint: `모델 다운로드 실패 (HTTP ${res.status})` };
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    return { ok: false, hint: `모델 다운로드 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
  const v = await verifyModel();
  if (!v.ok) await rm(dest, { force: true }).catch(() => {});
  return v;
}

let ensureInFlight: Promise<{ ok: boolean; hint?: string }> | null = null;

/**
 * opencv-python-headless 설치 + 모델 다운로드. 실패해도 throw 하지 않는다.
 * ensurePython·ensureDemucs 와 같은 직렬화 — 같은 .venv 에 pip install 두 개가 겹치지 않게 한다.
 */
export function ensureTracker(): Promise<{ ok: boolean; hint?: string }> {
  ensureInFlight ??= doEnsureTracker().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

async function doEnsureTracker(): Promise<{ ok: boolean; hint?: string }> {
  if (!existsSync(VENV_PYTHON)) {
    return {
      ok: false,
      hint: '파이썬 venv 가 없습니다 — `node scripts/prewarm.mjs whisper` 로 venv 를 먼저 만드세요',
    };
  }
  if (!(await canImportCv2())) {
    try {
      // headless 판 — GUI(cv2.imshow) 용 Qt 의존이 빠져 훨씬 작고 서버에서 창을 띄울 일이 없다.
      // contrib 판(+53.8MB)은 «혹시 몰라서» 도 깔지 않는다. TrackerVit 은 기본 패키지에 있다.
      await execa(VENV_PYTHON, ['-m', 'pip', 'install', 'opencv-python-headless'], {
        timeout: TRACK_TIMEOUT_MS,
      });
    } catch (err) {
      return {
        ok: false,
        hint: `opencv-python-headless 설치에 실패했습니다 (휠 43.8MB — 네트워크·디스크 여유 확인): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (!(await canImportCv2())) {
      return { ok: false, hint: '설치 후에도 cv2.TrackerVit 을 찾지 못했습니다' };
    }
  }
  return downloadModel();
}

// ── 실행 ──────────────────────────────────────────────────────────────────

/**
 * stderr 에서 `PROGRESS <0..1> <done> <total>` 줄만 골라 보고한다. 나머지는 오류용으로 모은다.
 * (opencv 가 내는 `[ WARN:0@…]` 정보성 줄도 여기 쌓이지만, 성공하면 아무도 안 본다.)
 */
export function makeStderrSink(onProgress?: (p: number, done: number, total: number) => void): {
  push: (chunk: string) => void;
  text: () => string;
} {
  let buf = '';
  const errLines: string[] = [];
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^PROGRESS\s+([0-9.]+)(?:\s+(\d+)\s+(\d+))?$/.exec(line);
        if (m) onProgress?.(Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0));
        else if (line) errLines.push(line);
      }
    },
    text: () => errLines.join('\n'),
  };
}

/**
 * 영상에서 상자 하나를 추적한다. 좌표는 넣을 때도 받을 때도 **소스 픽셀**.
 *
 * `direction: 'backward'` 의 결과 프레임은 **추적한 순서**(기준 프레임이 먼저, 그 뒤는
 * 프레임 번호가 줄어든다)로 온다. `classifyTrack` 의 「3연속 실패 뒤는 전부 실패」가
 * «추적 순서» 규칙이므로 **판정을 먼저 하고 그 뒤에 시간순으로 정렬한다**
 * (`mergeTrackedFrames` 가 그 정렬까지 해 준다).
 */
export async function trackBox(absMediaPath: string, opts: TrackOpts): Promise<TrackResult> {
  const { box } = opts;
  const args = [
    SCRIPT_PATH,
    absMediaPath,
    '--box', String(box.x), String(box.y), String(box.w), String(box.h),
    '--start-ms', String(Math.max(0, Math.round(opts.startMs))),
    '--model', vittrackModelPath(),
  ];
  if (opts.direction === 'backward') args.push('--direction', 'backward');
  if (opts.endMs !== undefined) args.push('--end-ms', String(Math.max(0, Math.round(opts.endMs))));
  if (opts.stride !== undefined && opts.stride > 1) args.push('--stride', String(Math.round(opts.stride)));

  const sink = makeStderrSink(opts.onProgress);
  let stdout: string;
  try {
    const sub = execa(VENV_PYTHON, args, {
      env: { PYTHONIOENCODING: 'utf-8' },
      timeout: TRACK_TIMEOUT_MS,
      cancelSignal: effectiveSignal(opts.signal),
      buffer: { stdout: true, stderr: false },
    });
    sub.stderr?.on('data', (d: Buffer) => sink.push(d.toString('utf8')));
    const res = await sub;
    stdout = res.stdout;
  } catch (err) {
    const e = err as { code?: string; exitCode?: number; message?: string };
    const stderr = sink.text();
    if (e.code === 'ENOENT') {
      throw new TrackerUnavailableError(
        '추적용 파이썬 venv 가 없습니다 — `node scripts/prewarm.mjs tracker` 를 먼저 실행하세요',
      );
    }
    if (e.exitCode === 3 || /ModuleNotFoundError|No module named/.test(stderr)) {
      throw new TrackerUnavailableError(
        '추적 엔진(OpenCV TrackerVit)이 설치되어 있지 않습니다 — `node scripts/prewarm.mjs tracker` 로 먼저 설치하세요',
      );
    }
    throw new Error(`track.py 실행 실패: ${stderr || e.message || String(err)}`);
  }
  return parseTrackJson(stdout);
}

export function parseTrackJson(stdout: string): TrackResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error('track.py 출력을 JSON 으로 파싱하지 못했습니다');
  }
  const r = raw as Partial<TrackResult>;
  if (!Array.isArray(r.frames)) throw new Error('track.py 출력에 frames 배열이 없습니다');
  if (!Number.isFinite(r.fps) || (r.fps as number) <= 0) {
    throw new Error('track.py 출력의 fps 가 올바르지 않습니다');
  }
  return {
    fps: r.fps as number,
    width: Number(r.width) || 0,
    height: Number(r.height) || 0,
    frames: r.frames as TrackFrame[],
  };
}

// ── 판정 ──────────────────────────────────────────────────────────────────

export type ClassifyOpts = {
  /** 기준(첫) 상자 — 넓이 비교의 기준. 없으면 frames[0] 을 쓴다. */
  anchor?: { w: number; h: number };
  frameW: number;
  frameH: number;
  scoreThreshold?: number;
};

export type ClassifiedFrame = TrackFrame & { ok: boolean };

/** 놓친 구간 하나 — 소스 ms 기준. */
export type TrackGap = { startMs: number; endMs: number; startFrame: number; endFrame: number };

/**
 * 프레임별 성공/실패를 정한다. 순수 함수 — opencv 없이 테스트한다.
 *
 * 세 가지를 겹쳐 본다(각 값의 근거는 위 상수 주석에 실측표로 있다):
 *  1) 점수가 `scoreThreshold` 이상인가
 *  2) 상자가 온전한가 — 기준 상자 넓이의 16배 안, 화면의 80% 이하, 폭·높이 양수
 *  3) 3프레임 연속 실패 뒤는 전부 실패 (ViT 는 놓친 대상으로 스스로 못 돌아온다)
 * 그리고 3프레임 미만의 짧은 실패 구간은 앞뒤를 이어 준다(깜빡임 방지).
 */
export function classifyTrack(frames: TrackFrame[], opts: ClassifyOpts): ClassifiedFrame[] {
  const threshold = opts.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const first = frames[0];
  const anchor = opts.anchor ?? (first ? { w: first.w, h: first.h } : { w: 1, h: 1 });
  const anchorArea = Math.max(1e-6, anchor.w * anchor.h);
  const frameArea = Math.max(1e-6, opts.frameW * opts.frameH);

  const ok = frames.map((f, i) => {
    if (i === 0) return true; // 기준 프레임은 사용자가 찍어 준 상자다
    const area = f.w * f.h;
    if (!(f.w > 1) || !(f.h > 1)) return false;
    if (area / anchorArea > AREA_RATIO_MAX) return false;
    if (anchorArea / area > AREA_RATIO_MAX) return false;
    if (area > FRAME_FRACTION_MAX * frameArea) return false;
    return f.score >= threshold;
  });

  // 짧은 실패 구간 이어붙이기 — 양쪽이 성공일 때만 (끝에 매달린 실패는 진짜 실패다)
  for (let i = 1; i < ok.length; ) {
    if (ok[i]) { i++; continue; }
    let j = i;
    while (j < ok.length && !ok[j]) j++;
    if (j - i < BRIDGE_RUN && i > 0 && j < ok.length) {
      for (let k = i; k < j; k++) ok[k] = true;
    }
    i = j;
  }

  // sticky — 3연속 실패가 나온 그 지점부터 끝까지 실패
  let run = 0;
  for (let i = 0; i < ok.length; i++) {
    run = ok[i] ? 0 : run + 1;
    if (run >= STICKY_RUN) {
      for (let k = i - run + 1; k < ok.length; k++) ok[k] = false;
      break;
    }
  }

  return frames.map((f, i) => ({ ...f, ok: ok[i]! }));
}

/** 연속된 실패 프레임을 구간으로 묶는다 (UI 가 빨갛게 칠할 것). */
export function trackGaps(frames: ClassifiedFrame[]): TrackGap[] {
  const gaps: TrackGap[] = [];
  let start: ClassifiedFrame | null = null;
  let prev: ClassifiedFrame | null = null;
  for (const f of frames) {
    if (!f.ok) {
      start ??= f;
      prev = f;
    } else if (start && prev) {
      gaps.push({ startMs: start.ms, endMs: prev.ms, startFrame: start.frame, endFrame: prev.frame });
      start = null;
      prev = null;
    }
  }
  if (start && prev) {
    gaps.push({ startMs: start.ms, endMs: prev.ms, startFrame: start.frame, endFrame: prev.frame });
  }
  return gaps;
}

/**
 * 두 방향의 «판정이 끝난» 결과를 **시간순 한 줄**로 합친다.
 *
 * 두 가지를 여기서 해결한다:
 *  1. **기준 프레임이 양쪽에 하나씩 있다** — 앞으로 가는 패스와 뒤로 가는 패스가 둘 다
 *     기준 프레임을 점수 1.0 으로 내보낸다. 그대로 두면 같은 시각에 상자가 두 개다.
 *     겹치면 **점수가 높은 쪽만** 남기므로 기준 프레임(1.0)이 이긴다 — 사용자가 눈으로
 *     맞춘 그 상자가 이음매에 남는다는 뜻이다.
 *  2. **역방향 결과는 추적 순서(시간 역순)로 온다** — 여기서 프레임 번호로 정렬한다.
 *     판정(sticky)은 «추적 순서»에서 이미 끝난 뒤여야 한다.
 */
export function mergeTrackedFrames(
  ...passes: readonly (readonly ClassifiedFrame[])[]
): ClassifiedFrame[] {
  const byFrame = new Map<number, ClassifiedFrame>();
  for (const pass of passes) {
    for (const f of pass) {
      const prev = byFrame.get(f.frame);
      if (!prev || f.score > prev.score) byFrame.set(f.frame, f);
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/** 디스크 여유 확인용 — 설치 크기(휠 43.8MB, 설치 후 약 90MB) + 모델. */
export const TRACKER_INSTALL_BYTES = 100 * 1024 * 1024;

export async function modelSizeBytes(): Promise<number> {
  return stat(vittrackModelPath())
    .then((s) => s.size)
    .catch(() => 0);
}
