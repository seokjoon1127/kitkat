// @kitkat/ai — X4 구현 (W5 X1-D). 보컬 분리(Demucs 2-stem).
// 공개 시그니처는 계획 문서 X4 계약과 동일하다. 실제 실행 검증은 XW-4 E2E.

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { effectiveSignal } from '@kitkat/media';

// index.ts 와 같은 규칙 — packages/ai/ (dist/demucs.js·src/demucs.ts 어느 쪽에서든 한 단계 위)
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_DIR = join(PKG_ROOT, '.venv');
const VENV_PYTHON = join(
  VENV_DIR,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

/** 모델 최초 다운로드(수백 MB)를 허용한다 — 30분. */
const SEPARATE_TIMEOUT_MS = 30 * 60 * 1000;

async function canImportDemucs(python: string): Promise<boolean> {
  try {
    await execa(python, ['-c', 'import demucs']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 설치를 **시도하지 않는** 빠른 준비 확인 (수 초).
 *
 * `ensureDemucs` 는 없으면 PyTorch 포함 2.5GB 를 내려받느라 수십 분이 걸린다. HTTP 요청 처리 중에
 * 그걸 기다리면 클라이언트가 먼저 타임아웃나서(실측) 사용자는 설치가 도는 줄도 모른 채 실패만 본다.
 * 그래서 라우트는 이 함수로 판정하고, 설치는 `node scripts/prewarm.mjs demucs` 로 따로 한다.
 */
export async function isDemucsReady(): Promise<boolean> {
  if (!existsSync(VENV_PYTHON)) return false;
  return canImportDemucs(VENV_PYTHON);
}

let ensureInFlight: Promise<{ ok: boolean; hint?: string }> | null = null;

/**
 * Demucs 준비 확인·지연 설치. 실패해도 throw 하지 않는다 — 서버가 {ok:false} 를 501 로 바꾼다.
 * ensurePython 과 같은 직렬화 — 같은 .venv 에 pip install 두 개가 겹치지 않게 한다.
 */
export function ensureDemucs(): Promise<{ ok: boolean; hint?: string }> {
  ensureInFlight ??= doEnsureDemucs().finally(() => {
    ensureInFlight = null; // 완료 후에는 다음 호출이 새로 확인(빠른 import 체크)하게 한다
  });
  return ensureInFlight;
}

async function doEnsureDemucs(): Promise<{ ok: boolean; hint?: string }> {
  if (await canImportDemucs(VENV_PYTHON)) return { ok: true };

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
    await execa(VENV_PYTHON, ['-m', 'pip', 'install', 'demucs']);
  } catch {
    return {
      ok: false,
      hint: 'demucs 설치에 실패했습니다 (네트워크·디스크 여유 확인 — torch 포함 수 GB가 필요할 수 있습니다)',
    };
  }

  if (await canImportDemucs(VENV_PYTHON)) return { ok: true };
  return { ok: false, hint: '설치 후에도 demucs import에 실패했습니다' };
}

/**
 * Demucs 2-stem 분리 → 산출물 절대경로 2개.
 * 산출물은 보통 <outDir>/htdemucs/<입력 basename>/vocals.wav·no_vocals.wav 지만
 * 모델 폴더 이름이 버전에 따라 다를 수 있어 outDir 아래를 재귀 탐색해 찾는다.
 */
export async function separateStems(
  absMediaPath: string,
  outDir: string,
): Promise<{ vocals: string; accompaniment: string }> {
  try {
    await execa(
      VENV_PYTHON,
      ['-m', 'demucs', '--two-stems=vocals', '-o', outDir, absMediaPath],
      // 잡 큐가 포기하면 파이썬도 같이 죽는다 (리뷰 #12 — 잡 컨텍스트에서 신호를 물려받는다)
      { timeout: SEPARATE_TIMEOUT_MS, cancelSignal: effectiveSignal() },
    );
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string };
    const stderr = e.stderr ?? '';
    if (e.code === 'ENOENT') {
      throw new Error('보컬 분리용 파이썬 venv가 없습니다 — ensureDemucs()를 먼저 실행하세요');
    }
    if (/No module named demucs|ModuleNotFoundError/.test(stderr)) {
      throw new Error('demucs가 설치되어 있지 않습니다 — ensureDemucs()를 먼저 실행하세요');
    }
    throw new Error(`demucs 실행 실패: ${stderr || e.message || String(err)}`);
  }

  const base = basename(absMediaPath, extname(absMediaPath));
  const vocals = await findStem(outDir, 'vocals.wav', base);
  const accompaniment = await findStem(outDir, 'no_vocals.wav', base);
  if (!vocals || !accompaniment) {
    throw new Error(
      `보컬 분리 산출물(vocals.wav·no_vocals.wav)을 ${outDir} 아래에서 찾지 못했습니다 — demucs 출력 구조가 예상과 다릅니다`,
    );
  }
  return { vocals, accompaniment };
}

/** outDir 아래를 재귀 탐색해 fileName 을 찾는다. 입력 basename 폴더 아래의 것을 우선한다. */
async function findStem(outDir: string, fileName: string, base: string): Promise<string | null> {
  const found: string[] = [];
  await walkFor(outDir, fileName, found);
  if (found.length === 0) return null;
  return found.find((p) => basename(dirname(p)) === base) ?? found[0]!;
}

async function walkFor(dir: string, fileName: string, acc: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // outDir 자체가 없으면 "못 찾음" 으로 처리
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await walkFor(p, fileName, acc);
    else if (ent.name === fileName) acc.push(p);
  }
}
