// W8 F17 리뷰 #12 — 잡이 시간 초과되면 «큐만 넘어가고 자식 프로세스는 살아남던» 것을 고쳤다.
// 잡 함수가 받는 AbortSignal 을 execa 의 cancelSignal 로 넘기면 프로세스가 같이 죽어야 한다.
import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { JobQueue } from '../src/jobs.js';
import { Hub } from '../src/ws.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('잡 시간 초과 → 자식 프로세스도 같이 죽는다', () => {
  it('60초짜리 자식이 300ms 타임아웃에 끝나고, 같은 레인의 다음 잡이 돈다', async () => {
    const q = new JobQueue(new Hub());
    let childOutcome: 'running' | 'canceled' | 'finished' | 'other' = 'running';
    let childPid: number | undefined;

    const slow = q.enqueue(
      'proxy',
      'p1',
      async (_job, _report, signal) => {
        const child = execa('node', ['-e', 'setTimeout(() => {}, 60000)'], { cancelSignal: signal });
        childPid = child.pid;
        try {
          await child;
          childOutcome = 'finished';
        } catch (e) {
          const err = e as { isCanceled?: boolean; isTerminated?: boolean };
          childOutcome = err.isCanceled || err.isTerminated ? 'canceled' : 'other';
          throw e;
        }
      },
      { timeoutMs: 300 },
    );
    // 같은 레인(proxy)에 뒤이어 하나 더 — 앞 잡이 레인을 «영구히» 붙잡지 않는지 본다
    const next = q.enqueue('proxy', 'p1', async () => ({ ok: true }));

    // 큐는 타임아웃 «순간» 다음 잡으로 넘어가고, 자식은 SIGTERM 을 받아 한 틱 뒤에 죽는다 —
    // 그래서 «다음 잡 완료»만 기다리면 자식의 종료 처리가 아직일 수 있다. 둘 다 기다린다.
    for (let i = 0; i < 200 && !(q.get(next.id)?.status === 'done' && childOutcome !== 'running'); i++) await wait(50);

    expect(q.get(slow.id)?.status).toBe('error');
    expect(q.get(slow.id)?.error).toMatch(/시간 초과/);
    expect(q.get(next.id)?.status).toBe('done');
    // 자식이 «끝까지 돈 것»도 «아직 도는 것»도 아니어야 한다 — 취소로 끝났어야 한다
    expect(childOutcome).toBe('canceled');
    expect(childPid).toBeDefined();
    // 프로세스가 실제로 사라졌는지 — signal 0 은 «살아 있나»만 묻는다
    let alive = true;
    try { process.kill(childPid!, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it('signal 을 안 쓰는 잡은 예전과 같이 동작한다 (회귀 0)', async () => {
    const q = new JobQueue(new Hub());
    const j = q.enqueue('proxy', 'p1', async () => ({ done: true }));
    for (let i = 0; i < 50 && q.get(j.id)?.status !== 'done'; i++) await wait(20);
    expect(q.get(j.id)?.status).toBe('done');
  });
});
