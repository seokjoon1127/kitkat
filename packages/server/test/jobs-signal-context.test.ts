// W8 F17 리뷰 #12 — 신호를 «명시적으로 안 넘긴» 잡도 자식 프로세스가 같이 죽는가.
// (호출 하나하나에 signal 을 실어 나르는 방식은 빠뜨린 자리가 곧 구멍이다. 잡 실행기가 비동기
//  컨텍스트에 신호를 걸어 두고 execa 를 부르는 곳이 자동으로 물려받는다 — media/job-signal.ts.)
import { describe, expect, it } from 'vitest';
import { runFfmpeg } from '@kitkat/media';
import { JobQueue } from '../src/jobs.js';
import { Hub } from '../src/ws.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('잡 컨텍스트 신호 — 명시 signal 없이도 ffmpeg 이 죽는다', () => {
  it('실시간(-re) 60초 ffmpeg 이 300ms 타임아웃 뒤 2초 안에 정리된다', async () => {
    const q = new JobQueue(new Hub());
    let settledAt = 0;
    let outcome: 'pending' | 'canceled' | 'finished' | 'other' = 'pending';
    const t0 = Date.now();

    const j = q.enqueue(
      'proxy',
      'p1',
      async () => {
        // signal 을 «일부러» 안 넘긴다 — 잡 컨텍스트에서 물려받아야 한다
        try {
          await runFfmpeg(['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-f', 'null', '-']);
          outcome = 'finished';
        } catch (e) {
          const err = e as { isCanceled?: boolean; isTerminated?: boolean; shortMessage?: string; message?: string; code?: string };
          outcome = err.isCanceled || err.isTerminated ? 'canceled' : 'other';
          throw e;
        } finally {
          settledAt = Date.now();
        }
      },
      { timeoutMs: 300 },
    );

    // 자식이 먼저 취소되고(outcome) 그 다음에 큐가 잡을 error 로 표시한다 — 둘 다 기다린다
    for (let i = 0; i < 100 && !(outcome !== 'pending' && q.get(j.id)?.status === 'error'); i++) await wait(50);

    expect(q.get(j.id)?.status).toBe('error');
    expect(outcome).toBe('canceled');
    // 60초짜리가 60초를 다 돌았다면 실패 — 취소가 먹었으면 몇백 ms 안에 끝난다
    expect(settledAt - t0).toBeLessThan(3000);
  }, 10_000);
});
