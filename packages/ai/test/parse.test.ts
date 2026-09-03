// W2-E 테스트 — 파이썬 spawn(execa)을 mock(고정 stdout)으로 두고 파싱·초→ms 변환·병합을 검증한다.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock, existsSyncMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
  existsSyncMock: vi.fn(() => false),
}));
vi.mock('execa', () => ({ execa: execaMock }));
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }));

import { AiUnavailableError, ensurePython, transcribe } from '../src/index.js';

const stdoutOf = (obj: unknown) => ({ stdout: JSON.stringify(obj) });

beforeEach(() => {
  execaMock.mockReset();
  existsSyncMock.mockReturnValue(false); // .venv 미존재 시나리오 고정
});

describe('transcribe: 파싱·초→ms 변환', () => {
  it('세그먼트/단어를 ms로 변환하고 텍스트를 trim한다', async () => {
    execaMock.mockResolvedValueOnce(
      stdoutOf({
        segments: [
          {
            text: ' 안녕하세요 여러분 ',
            start: 0.5,
            end: 3.0015,
            words: [
              { word: ' 안녕하세요', start: 0.5, end: 1.2 },
              { word: ' 여러분', start: 1.3, end: 3.0015 },
            ],
          },
        ],
      }),
    );
    const segs = await transcribe('C:/media/narration.wav');
    expect(segs).toEqual([
      {
        text: '안녕하세요 여러분',
        start: 500,
        duration: 2502, // round(3001.5) - 500
        words: [
          { text: '안녕하세요', start: 500, duration: 700 },
          { text: '여러분', start: 1300, duration: 1702 },
        ],
      },
    ]);
  });

  it('venv 파이썬 경로와 transcribe.py·미디어 경로로 spawn한다 (기본: --language 없음)', async () => {
    execaMock.mockResolvedValueOnce(stdoutOf({ segments: [] }));
    await transcribe('C:/media/a.wav');
    const [cmd, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(cmd).toMatch(/[/\\]\.venv[/\\]/);
    expect(args[0]).toMatch(/transcribe\.py$/);
    expect(args[1]).toBe('C:/media/a.wav');
    expect(args).not.toContain('--language');
  });

  it('opts.language를 --language 인자로 전달한다', async () => {
    execaMock.mockResolvedValueOnce(stdoutOf({ segments: [] }));
    await transcribe('C:/media/a.wav', { language: 'ko' });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--language');
    expect(args[args.indexOf('--language') + 1]).toBe('ko');
  });

  it('segments가 비면 빈 배열을 반환한다', async () => {
    execaMock.mockResolvedValueOnce(stdoutOf({ segments: [] }));
    await expect(transcribe('C:/media/a.wav')).resolves.toEqual([]);
  });

  it('words가 없는 세그먼트는 빈 words 배열이 된다', async () => {
    execaMock.mockResolvedValueOnce(
      stdoutOf({ segments: [{ text: 'x', start: 0, end: 2.5 }] }),
    );
    const segs = await transcribe('C:/media/a.wav');
    expect(segs[0]!.words).toEqual([]);
  });

  it('JSON이 아니면 일반 Error를 던진다 (AiUnavailableError 아님)', async () => {
    execaMock.mockResolvedValueOnce({ stdout: 'not json' });
    await expect(transcribe('C:/media/a.wav')).rejects.toThrow(/JSON/);
    execaMock.mockResolvedValueOnce({ stdout: 'not json' });
    await expect(transcribe('C:/media/a.wav')).rejects.not.toBeInstanceOf(AiUnavailableError);
  });
});

describe('transcribe: 2초 미만 인접 병합', () => {
  it('짧은(2초 미만) 세그먼트를 인접한 앞 세그먼트에 합친다(텍스트·duration·words)', async () => {
    execaMock.mockResolvedValueOnce(
      stdoutOf({
        segments: [
          { text: '첫 문장', start: 0, end: 1.0, words: [{ word: '첫', start: 0, end: 1.0 }] },
          { text: '둘째', start: 1.2, end: 2.0, words: [{ word: '둘째', start: 1.2, end: 2.0 }] },
        ],
      }),
    );
    const segs = await transcribe('C:/media/a.wav');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ text: '첫 문장 둘째', start: 0, duration: 2000 });
    expect(segs[0]!.words.map((w) => w.text)).toEqual(['첫', '둘째']);
  });

  it('둘 다 2초 이상인 인접 세그먼트는 병합하지 않는다', async () => {
    execaMock.mockResolvedValueOnce(
      stdoutOf({
        segments: [
          { text: 'A', start: 0, end: 3.0, words: [] },
          { text: 'B', start: 3.1, end: 6.5, words: [] },
        ],
      }),
    );
    const segs = await transcribe('C:/media/a.wav');
    expect(segs.map((s) => s.text)).toEqual(['A', 'B']);
  });

  it('간격이 2초 이상이면 짧아도 병합하지 않는다', async () => {
    execaMock.mockResolvedValueOnce(
      stdoutOf({
        segments: [
          { text: 'A', start: 0, end: 1.0, words: [] },
          { text: 'B', start: 5.0, end: 5.8, words: [] },
        ],
      }),
    );
    const segs = await transcribe('C:/media/a.wav');
    expect(segs.map((s) => s.text)).toEqual(['A', 'B']);
  });

  it('연쇄 병합: 짧은 세그먼트 셋이 하나로 합쳐진다', async () => {
    execaMock.mockResolvedValueOnce(
      stdoutOf({
        segments: [
          { text: 'a', start: 0, end: 0.5, words: [] },
          { text: 'b', start: 0.6, end: 1.1, words: [] },
          { text: 'c', start: 1.2, end: 1.8, words: [] },
        ],
      }),
    );
    const segs = await transcribe('C:/media/a.wav');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ text: 'a b c', start: 0, duration: 1800 });
  });
});

describe('transcribe: 실패 → AiUnavailableError 매핑', () => {
  it('spawn ENOENT(venv 없음)면 AiUnavailableError', async () => {
    execaMock.mockRejectedValueOnce(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(transcribe('C:/media/a.wav')).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('exit 3(faster_whisper 미설치)이면 AiUnavailableError', async () => {
    execaMock.mockRejectedValueOnce(
      Object.assign(new Error('exit 3'), {
        exitCode: 3,
        stderr: 'faster_whisper is not installed (run ensurePython)',
      }),
    );
    await expect(transcribe('C:/media/a.wav')).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('그 밖의 파이썬 오류는 stderr를 담은 일반 Error', async () => {
    execaMock.mockRejectedValueOnce(
      Object.assign(new Error('exit 1'), { exitCode: 1, stderr: 'FileNotFoundError: bad.wav' }),
    );
    await expect(transcribe('C:/media/a.wav')).rejects.toThrow(/FileNotFoundError/);
  });
});

describe('ensurePython', () => {
  it('venv에서 faster_whisper import가 되면 설치 없이 ok:true', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' }); // python -c "import faster_whisper"
    await expect(ensurePython()).resolves.toEqual({ ok: true });
    expect(execaMock).toHaveBeenCalledTimes(1);
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['-c', 'import faster_whisper']);
  });

  it('python·py 모두 실패하면 ok:false + hint', async () => {
    // import 확인 실패 → python -m venv 실패 → py -3 -m venv 실패
    execaMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const r = await ensurePython();
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/Python 3/);
  });

  it('동시 호출은 진행 중인 설치를 공유한다 — pip install 은 한 번만 실행', async () => {
    let installed = false;
    execaMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '-c') {
        // import 확인: 설치 전엔 실패, pip install 후 성공
        if (installed) return { stdout: '' };
        throw Object.assign(new Error('ModuleNotFoundError'), { exitCode: 1 });
      }
      if (args.includes('venv')) return { stdout: '' };
      if (args.includes('pip')) {
        await new Promise((r) => setTimeout(r, 20)); // 설치 진행 중 두 번째 호출이 도착하는 상황
        installed = true;
        return { stdout: '' };
      }
      throw new Error(`예상 밖 호출: ${args.join(' ')}`);
    });

    const [a, b] = await Promise.all([ensurePython(), ensurePython()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    const pipCalls = execaMock.mock.calls.filter((c) => (c[1] as string[]).includes('pip'));
    expect(pipCalls).toHaveLength(1);
  });
});
