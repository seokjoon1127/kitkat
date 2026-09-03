// X1-D 테스트 — 파이썬 spawn(execa)을 mock 으로 두고 인자 조립·산출물 재귀 탐색·실패 메시지를 검증한다.
// 실제 Demucs 는 실행하지 않는다 (E2E 는 XW-4). 산출물 탐색은 실제 임시 디렉터리로 검증한다.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock, existsSyncMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
}));
vi.mock('execa', () => ({ execa: execaMock }));
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }));

// index.js 에서 import — 재export 배선까지 함께 검증한다.
import { ensureDemucs, separateStems } from '../src/index.js';

const tempDirs: string[] = [];

async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kitkat-demucs-'));
  tempDirs.push(dir);
  return dir;
}

async function makeStems(outDir: string, modelDir: string, base: string): Promise<string> {
  const stemDir = join(outDir, modelDir, base);
  await mkdir(stemDir, { recursive: true });
  await writeFile(join(stemDir, 'vocals.wav'), 'x');
  await writeFile(join(stemDir, 'no_vocals.wav'), 'x');
  return stemDir;
}

beforeEach(() => {
  execaMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true); // 기본: .venv 존재 시나리오
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('separateStems: 인자 조립·산출물 탐색', () => {
  it('venv 파이썬으로 python -m demucs --two-stems=vocals -o <outDir> <src> 를 30분 타임아웃으로 실행한다', async () => {
    const outDir = await makeOutDir();
    const stemDir = await makeStems(outDir, 'htdemucs', 'song');
    execaMock.mockResolvedValueOnce({ stdout: '' });

    const r = await separateStems('C:/media/song.mp3', outDir);

    expect(execaMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execaMock.mock.calls[0] as [
      string,
      string[],
      { timeout?: number },
    ];
    expect(cmd).toMatch(/[/\\]\.venv[/\\]/);
    expect(args).toEqual(['-m', 'demucs', '--two-stems=vocals', '-o', outDir, 'C:/media/song.mp3']);
    expect(opts.timeout).toBe(30 * 60 * 1000);
    expect(r.vocals).toBe(join(stemDir, 'vocals.wav'));
    expect(r.accompaniment).toBe(join(stemDir, 'no_vocals.wav'));
  });

  it('모델 폴더 이름이 htdemucs 가 아니어도 재귀 탐색으로 찾는다', async () => {
    const outDir = await makeOutDir();
    const stemDir = await makeStems(outDir, 'mdx_extra_q', 'narration');
    execaMock.mockResolvedValueOnce({ stdout: '' });

    const r = await separateStems('C:/media/narration.wav', outDir);
    expect(r.vocals).toBe(join(stemDir, 'vocals.wav'));
    expect(r.accompaniment).toBe(join(stemDir, 'no_vocals.wav'));
  });

  it('outDir 에 다른 입력의 산출물이 함께 있으면 입력 basename 폴더의 것을 우선한다', async () => {
    const outDir = await makeOutDir();
    await makeStems(outDir, 'htdemucs', 'other');
    const stemDir = await makeStems(outDir, 'htdemucs', 'song');
    execaMock.mockResolvedValueOnce({ stdout: '' });

    const r = await separateStems('C:/media/song.mp3', outDir);
    expect(r.vocals).toBe(join(stemDir, 'vocals.wav'));
    expect(r.accompaniment).toBe(join(stemDir, 'no_vocals.wav'));
  });

  it('산출물이 없으면 한국어 메시지로 throw 한다', async () => {
    const outDir = await makeOutDir(); // 비어 있음
    execaMock.mockResolvedValueOnce({ stdout: '' });

    await expect(separateStems('C:/media/song.mp3', outDir)).rejects.toThrow(/찾지 못했습니다/);
  });

  it('spawn ENOENT(venv 없음)면 ensureDemucs 안내 메시지로 throw 한다', async () => {
    const outDir = await makeOutDir();
    execaMock.mockRejectedValueOnce(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(separateStems('C:/media/song.mp3', outDir)).rejects.toThrow(/ensureDemucs/);
  });

  it('demucs 미설치(ModuleNotFoundError)면 ensureDemucs 안내 메시지로 throw 한다', async () => {
    const outDir = await makeOutDir();
    execaMock.mockRejectedValueOnce(
      Object.assign(new Error('exit 1'), {
        exitCode: 1,
        stderr: "ModuleNotFoundError: No module named demucs",
      }),
    );

    await expect(separateStems('C:/media/song.mp3', outDir)).rejects.toThrow(
      /demucs가 설치되어 있지 않습니다/,
    );
  });

  it('그 밖의 실행 오류는 stderr 를 담아 throw 한다', async () => {
    const outDir = await makeOutDir();
    execaMock.mockRejectedValueOnce(
      Object.assign(new Error('exit 1'), { exitCode: 1, stderr: 'CUDA out of memory' }),
    );

    await expect(separateStems('C:/media/song.mp3', outDir)).rejects.toThrow(/CUDA out of memory/);
  });
});

describe('ensureDemucs', () => {
  it('venv 에서 demucs import 가 되면 설치 없이 ok:true', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' }); // python -c "import demucs"
    await expect(ensureDemucs()).resolves.toEqual({ ok: true });
    expect(execaMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(cmd).toMatch(/[/\\]\.venv[/\\]/);
    expect(args).toEqual(['-c', 'import demucs']);
  });

  it('import 실패 후 pip install demucs 가 성공하고 재import 되면 ok:true', async () => {
    execaMock
      .mockRejectedValueOnce(Object.assign(new Error('no module'), { exitCode: 1 })) // import 실패
      .mockResolvedValueOnce({ stdout: '' }) // pip install demucs
      .mockResolvedValueOnce({ stdout: '' }); // 재import 성공

    await expect(ensureDemucs()).resolves.toEqual({ ok: true });
    const [, pipArgs] = execaMock.mock.calls[1] as [string, string[]];
    expect(pipArgs).toEqual(['-m', 'pip', 'install', 'demucs']);
  });

  it('pip install 이 실패해도 throw 하지 않고 ok:false + hint 를 반환한다', async () => {
    execaMock
      .mockRejectedValueOnce(Object.assign(new Error('no module'), { exitCode: 1 })) // import 실패
      .mockRejectedValueOnce(Object.assign(new Error('pip fail'), { exitCode: 1 })); // pip 실패

    const r = await ensureDemucs();
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/설치에 실패/);
  });

  it('설치 후에도 import 가 안 되면 ok:false + hint 를 반환한다', async () => {
    execaMock
      .mockRejectedValueOnce(Object.assign(new Error('no module'), { exitCode: 1 })) // import 실패
      .mockResolvedValueOnce({ stdout: '' }) // pip install 성공
      .mockRejectedValueOnce(Object.assign(new Error('still no module'), { exitCode: 1 })); // 재import 실패

    const r = await ensureDemucs();
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/import에 실패/);
  });

  it('venv 가 없고 python·py 모두 실패하면 ok:false + Python 3 hint', async () => {
    existsSyncMock.mockReturnValue(false); // .venv 미존재
    execaMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const r = await ensureDemucs();
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/Python 3/);
  });
});
