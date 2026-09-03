// @kitkat/ai — C6 구현 (W2-E). 공개 시그니처는 계획 문서 C6 계약과 동일하다.
// 초→ms 변환·2초 미만 인접 세그먼트 병합은 이 패키지 책임.
// 미디어 절대 시각 → 클립 상대 시각 변환·TextClip 생성은 서버 captions job 책임.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { effectiveSignal } from '@kitkat/media';

export type CaptionSegment = {
  text: string;
  /** ms — 입력 미디어 파일 기준 절대 시각 */
  start: number;
  /** ms */
  duration: number;
  /** start = 미디어 기준 절대 ms */
  words: { text: string; start: number; duration: number }[];
};

/** 파이썬/모델이 준비되지 않았을 때 던져진다. 서버는 이를 HTTP 501로 변환한다. */
export class AiUnavailableError extends Error {
  constructor(message = '자동자막 엔진이 아직 준비되지 않았습니다') {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

// X4 (W5 X1-D): 보컬 분리 — 기존 공개 시그니처는 그대로, export 추가만.
export { ensureDemucs, isDemucsReady, separateStems } from './demucs.js';

// F10 (W8): 마스크 모션 트래킹 — OpenCV TrackerVit.
export {
  classifyTrack,
  downloadModel,
  ensureTracker,
  isTrackerReady,
  mergeTrackedFrames,
  modelSizeBytes,
  parseTrackJson,
  trackBox,
  trackGaps,
  verifyModel,
  vittrackModelPath,
  TrackerUnavailableError,
  DEFAULT_SCORE_THRESHOLD,
  TRACKER_INSTALL_BYTES,
  VITTRACK_MODEL_FILE,
  VITTRACK_MODEL_SHA256,
  VITTRACK_MODEL_URL,
} from './track.js';
export type {
  ClassifiedFrame,
  ClassifyOpts,
  TrackDirection,
  TrackFrame,
  TrackGap,
  TrackOpts,
  TrackResult,
} from './track.js';

// packages/ai/ (dist/index.js·src/index.ts 어느 쪽에서든 한 단계 위)
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_DIR = join(PKG_ROOT, '.venv');
const VENV_PYTHON = join(
  VENV_DIR,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const SCRIPT_PATH = join(PKG_ROOT, 'python', 'transcribe.py');

/** 인접 세그먼트 병합 기준: 짧은(2초 미만) 세그먼트를 2초 미만 간격의 이웃과 합친다. */
const MERGE_MS = 2000;

async function canImportFasterWhisper(python: string): Promise<boolean> {
  try {
    await execa(python, ['-c', 'import faster_whisper']);
    return true;
  } catch {
    return false;
  }
}

let ensureInFlight: Promise<{ ok: boolean; hint?: string }> | null = null;

/**
 * 동시 호출 직렬화 — 진행 중이면 같은 Promise를 반환한다.
 * (같은 .venv에 pip install 두 개가 겹쳐 돌면 Windows 파일 잠금으로 반쯤 설치된 패키지가 남는다)
 */
export function ensurePython(): Promise<{ ok: boolean; hint?: string }> {
  ensureInFlight ??= doEnsurePython().finally(() => {
    ensureInFlight = null; // 완료 후에는 다음 호출이 새로 확인(빠른 import 체크)하게 한다
  });
  return ensureInFlight;
}

async function doEnsurePython(): Promise<{ ok: boolean; hint?: string }> {
  if (await canImportFasterWhisper(VENV_PYTHON)) return { ok: true };

  if (!existsSync(VENV_PYTHON)) {
    try {
      await execa('python', ['-m', 'venv', VENV_DIR]);
    } catch {
      try {
        await execa('py', ['-3', '-m', 'venv', VENV_DIR]);
      } catch {
        return {
          ok: false,
          hint: 'Python 3을 찾지 못했습니다 (python·py 명령 모두 실패) — Python 3.11을 설치한 뒤 다시 시도하세요',
        };
      }
    }
  }

  try {
    await execa(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'faster-whisper']);
  } catch {
    return { ok: false, hint: 'faster-whisper 설치에 실패했습니다 (네트워크·디스크 여유 확인)' };
  }

  if (await canImportFasterWhisper(VENV_PYTHON)) return { ok: true };
  return { ok: false, hint: '설치 후에도 faster_whisper import에 실패했습니다' };
}

export async function transcribe(
  absMediaPath: string,
  opts?: { language?: string },
): Promise<CaptionSegment[]> {
  const args = [SCRIPT_PATH, absMediaPath];
  if (opts?.language) args.push('--language', opts.language);

  let stdout: string;
  try {
    const res = await execa(VENV_PYTHON, args, {
      env: { PYTHONIOENCODING: 'utf-8' },
      cancelSignal: effectiveSignal(),
    });
    stdout = res.stdout;
  } catch (err) {
    const e = err as { code?: string; exitCode?: number; stderr?: string; message?: string };
    const stderr = e.stderr ?? '';
    if (e.code === 'ENOENT') {
      throw new AiUnavailableError(
        '자동자막용 파이썬 venv가 없습니다 — ensurePython()을 먼저 실행하세요',
      );
    }
    if (e.exitCode === 3 || /ModuleNotFoundError|faster_whisper/.test(stderr)) {
      throw new AiUnavailableError(
        'faster-whisper가 설치되어 있지 않습니다 — ensurePython()을 먼저 실행하세요',
      );
    }
    throw new Error(`transcribe.py 실행 실패: ${stderr || e.message || String(err)}`);
  }

  return mergeAdjacentShort(parseSegments(stdout));
}

// ---------- 내부: 파싱·변환·병합 ----------

type RawWord = { word: string; start: number; end: number };
type RawSegment = { text: string; start: number; end: number; words?: RawWord[] };

const toMs = (sec: number): number => Math.round(sec * 1000);

function parseSegments(stdout: string): CaptionSegment[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error('transcribe.py 출력을 JSON으로 파싱하지 못했습니다');
  }
  const segments = (raw as { segments?: RawSegment[] }).segments;
  if (!Array.isArray(segments)) {
    throw new Error('transcribe.py 출력에 segments 배열이 없습니다');
  }
  return segments.map((s) => {
    const startMs = toMs(s.start);
    return {
      text: s.text.trim(),
      start: startMs,
      duration: Math.max(1, toMs(s.end) - startMs),
      words: (s.words ?? []).map((w) => {
        const wStart = toMs(w.start);
        return { text: w.word.trim(), start: wStart, duration: Math.max(1, toMs(w.end) - wStart) };
      }),
    };
  });
}

/**
 * 2초 미만 인접 병합: 이웃과의 간격이 2초 미만이고 둘 중 하나가 2초 미만으로 짧으면
 * 앞 세그먼트에 합친다(텍스트 공백 연결, duration은 뒤 세그먼트 끝까지 확장, words 이어붙임).
 */
function mergeAdjacentShort(segments: CaptionSegment[]): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    const gap = prev ? seg.start - (prev.start + prev.duration) : Infinity;
    if (prev && gap < MERGE_MS && (prev.duration < MERGE_MS || seg.duration < MERGE_MS)) {
      prev.text = `${prev.text} ${seg.text}`.trim();
      prev.duration = seg.start + seg.duration - prev.start;
      prev.words.push(...seg.words);
    } else {
      out.push({ ...seg, words: [...seg.words] });
    }
  }
  return out;
}
