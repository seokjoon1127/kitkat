// JobQueue 복구력 테스트 (FIX-1)
//  A. 굳은 잡은 타임아웃으로 error 가 되고 큐는 계속 돈다
//  B. 완료된 잡은 상한까지만 보관하고 queued/running 은 절대 안 버린다
//  C. fast/slow 레인 2개가 동시에 하나씩 돈다 (레인 안에서는 순차)
import { describe, expect, it } from 'vitest';
import { JobQueue, type JobType } from '../src/jobs.js';
import { Hub } from '../src/ws.js';

const PID = 'p1';

function makeQueue(): JobQueue {
  // 소켓이 붙지 않은 Hub 의 broadcast 는 no-op 이라 그대로 쓴다.
  return new JobQueue(new Hub());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 밖에서 resolve 할 수 있는 promise */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 영원히 settle 되지 않는 잡 — 파이프 입력을 기다리며 굳은 ffmpeg 을 흉내낸다. */
const hung = () => new Promise<void>(() => {});

describe('버그 A — 굳은 잡이 큐를 영구히 죽이지 않는다', () => {
  it('안 끝나는 잡은 타임아웃 error 가 되고, 뒤이은 잡이 정상 실행된다', async () => {
    const q = makeQueue();
    const ran: string[] = [];

    const stuck = q.enqueue('render', PID, hung, { timeoutMs: 30 });
    const next = q.enqueue('render', PID, async () => {
      ran.push('next');
      return { ok: true };
    });

    await q.idle();

    expect(q.get(stuck.id)?.status).toBe('error');
    expect(q.get(stuck.id)?.error).toContain('시간 초과');
    expect(q.get(next.id)?.status).toBe('done');
    expect(ran).toEqual(['next']);
  });

  it('굳은 잡이 연달아 들어와도 큐는 계속 진행한다', async () => {
    const q = makeQueue();
    const a = q.enqueue('render', PID, hung, { timeoutMs: 20 });
    const b = q.enqueue('derive', PID, hung, { timeoutMs: 20 });
    const c = q.enqueue('reverse', PID, async () => ({ done: true }));

    await q.idle();

    expect(q.get(a.id)?.status).toBe('error');
    expect(q.get(b.id)?.status).toBe('error');
    expect(q.get(c.id)?.status).toBe('done');
  });

  it('타임아웃 전에 끝난 잡은 정상 done 이고 나중에 오염되지 않는다', async () => {
    const q = makeQueue();
    const job = q.enqueue(
      'proxy',
      PID,
      async () => {
        await sleep(5);
        return { url: '/x', path: 'x' };
      },
      { timeoutMs: 500 },
    );

    await q.idle();
    expect(q.get(job.id)?.status).toBe('done');
    expect(q.get(job.id)?.progress).toBe(1);

    // 타이머가 살아 있었다면 여기서 error 로 뒤집힌다.
    await sleep(60);
    expect(q.get(job.id)?.status).toBe('done');
  });

  it('fast 레인의 굳은 잡도 타임아웃되고 그 레인이 다시 돈다', async () => {
    const q = makeQueue();
    const stuck = q.enqueue('proxy', PID, hung, { timeoutMs: 20 });
    const after = q.enqueue('waveform', PID, async () => ({ ok: true }));

    await q.idle();
    expect(q.get(stuck.id)?.status).toBe('error');
    expect(q.get(stuck.id)?.error).toContain('proxy');
    expect(q.get(after.id)?.status).toBe('done');
  });
});

describe('버그 B — 완료 잡을 상한까지만 보관한다', () => {
  it('완료 잡이 상한(200)을 넘으면 오래된 것부터 사라진다', async () => {
    const q = makeQueue();
    const ids: string[] = [];
    for (let i = 0; i < 210; i++) {
      ids.push(q.enqueue('thumb', PID, async () => {}).id);
    }
    await q.idle();

    // 앞쪽 10개는 밀려나고, 마지막 200개는 남아 있다.
    expect(q.get(ids[0]!)).toBeUndefined();
    expect(q.get(ids[9]!)).toBeUndefined();
    expect(q.get(ids[10]!)).toBeDefined();
    expect(q.get(ids[209]!)?.status).toBe('done');
  });

  it('queued/running 잡은 완료 잡이 아무리 쌓여도 안 버려진다', async () => {
    const q = makeQueue();
    const gate = deferred();

    const running = q.enqueue('render', PID, () => gate.promise); // slow 레인에서 계속 running
    const queued = q.enqueue('upscale', PID, async () => {}); // 그 뒤에 계속 queued

    for (let i = 0; i < 210; i++) q.enqueue('thumb', PID, async () => {}); // fast 레인에서 완료 누적
    while (q.get(running.id)?.status !== 'running') await sleep(5);
    await sleep(50);

    expect(q.get(running.id)?.status).toBe('running');
    expect(q.get(queued.id)?.status).toBe('queued');

    gate.resolve();
    await q.idle();
    expect(q.get(running.id)?.status).toBe('done');
    expect(q.get(queued.id)?.status).toBe('done');
  });

  it('방금 끝난 잡은 GET /api/jobs/:id 가 찾을 수 있게 남아 있다', async () => {
    const q = makeQueue();
    const job = q.enqueue('cover', PID, async () => ({ url: '/c.png', path: 'c.png' }));
    await q.idle();
    expect(q.get(job.id)?.result).toEqual({ url: '/c.png', path: 'c.png' });
  });
});

describe('버그 C — fast/slow 레인 2개', () => {
  it('slow 잡이 도는 중에 fast 잡이 끝난다 (동시 실행)', async () => {
    const q = makeQueue();
    const gate = deferred();
    const slow = q.enqueue('upscale', PID, () => gate.promise);
    const fast = q.enqueue('proxy', PID, async () => ({ ok: true }));

    while (q.get(fast.id)?.status !== 'done') await sleep(5);

    // fast 가 끝난 시점에도 slow 는 아직 돌고 있다 = 두 레인이 동시에 실행됐다.
    expect(q.get(slow.id)?.status).toBe('running');

    gate.resolve();
    await q.idle();
    expect(q.get(slow.id)?.status).toBe('done');
  });

  it('fast 레인 잡들은 순차로 실행된다', async () => {
    const q = makeQueue();
    let inFlight = 0;
    let peak = 0;
    const body = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(10);
      inFlight--;
    };
    for (const t of ['proxy', 'waveform', 'thumb', 'cover', 'beats'] as JobType[]) {
      q.enqueue(t, PID, body);
    }
    await q.idle();
    expect(peak).toBe(1);
  });

  it('derive 두 개는 절대 겹치지 않는다 (asset.derived 경합 방지)', async () => {
    const q = makeQueue();
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const body = (tag: string) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      order.push(`${tag}:start`);
      await sleep(15);
      order.push(`${tag}:end`);
      inFlight--;
    };
    q.enqueue('derive', PID, body('d1'), 'a:lut');
    q.enqueue('derive', PID, body('d2'), 'b:lut');
    await q.idle();

    expect(peak).toBe(1);
    expect(order).toEqual(['d1:start', 'd1:end', 'd2:start', 'd2:end']);
  });

  it('slow 레인 잡들(render/derive/upscale…)도 서로 순차다', async () => {
    const q = makeQueue();
    let inFlight = 0;
    let peak = 0;
    const body = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(8);
      inFlight--;
    };
    for (const t of ['render', 'derive', 'reverse', 'upscale', 'interpolate', 'separate', 'captions'] as JobType[]) {
      q.enqueue(t, PID, body);
    }
    await q.idle();
    expect(peak).toBe(1);
  });

  it('idle() 은 두 레인이 모두 빌 때까지 기다린다', async () => {
    const q = makeQueue();
    let fastDone = false;
    let slowDone = false;
    q.enqueue('thumb', PID, async () => {
      await sleep(10);
      fastDone = true;
    });
    q.enqueue('render', PID, async () => {
      await sleep(60); // fast 보다 확실히 오래 — idle 이 fast 만 보고 돌아오면 실패한다
      slowDone = true;
    });

    await q.idle();
    expect(fastDone).toBe(true);
    expect(slowDone).toBe(true);
  });
});

describe('enqueue 시그니처 하위호환', () => {
  it('네 번째 인자가 문자열이면 key 로 취급한다', async () => {
    const q = makeQueue();
    const gate = deferred();
    const job = q.enqueue('reverse', PID, () => gate.promise, 'asset-1');

    expect(job.key).toBe('asset-1');
    expect(q.hasActive('reverse', 'asset-1')).toBe(true);
    expect(q.hasActive('reverse', 'asset-2')).toBe(false);

    gate.resolve();
    await q.idle();
    expect(q.hasActive('reverse', 'asset-1')).toBe(false);
  });

  it('opts 객체로 key 와 timeoutMs 를 함께 줄 수 있다', async () => {
    const q = makeQueue();
    const job = q.enqueue('derive', PID, hung, { key: 'a:lut', timeoutMs: 25 });
    expect(job.key).toBe('a:lut');
    expect(q.hasActive('derive', 'a:lut')).toBe(true);

    await q.idle();
    expect(q.get(job.id)?.status).toBe('error');
    expect(q.hasActive('derive', 'a:lut')).toBe(false);
  });
});
