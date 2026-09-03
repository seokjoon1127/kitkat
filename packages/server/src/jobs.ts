// 잡 큐 — {proxy, waveform, thumb, render, captions, reverse}
// + W5: {derive, beats, separate, upscale, interpolate, cover}. 상태 변화·진행률을 WS로 브로드캐스트.
//
// 레인 2개(fast/slow)가 각각 하나씩, 즉 동시에 최대 2개를 실행한다.
// 잡마다 타임아웃이 걸려 있어, 굳은 잡 하나가 큐 전체를 영구히 막지 못한다.
import { runWithJobSignal } from '@kitkat/media';
import { newId } from '@kitkat/schema';
import type { Hub } from './ws.js';

export type JobType =
  | 'proxy'
  | 'waveform'
  | 'thumb'
  | 'render'
  | 'captions'
  | 'reverse'
  | 'derive'
  | 'beats'
  | 'separate'
  | 'upscale'
  | 'interpolate'
  | 'cover'
  /** W8 F4 — 컷별 색 맞추기의 통계 측정. 5프레임 디코드라 fast 레인이다. */
  | 'matchStats'
  /** W8 F10 — 마스크 모션 트래킹. 실측 4.5ms/프레임이라 900프레임이 약 4초다. */
  | 'track';
export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export type Job = {
  id: string;
  type: JobType;
  projectId: string;
  status: JobStatus;
  progress: number; // 0..1
  /**
   * 진행 상황 한 줄 (예: "312/900 프레임").
   * 퍼센트만으로는 «얼마나 남았는지» 가늠이 안 되는 긴 잡(AI 업스케일·보간)이 채운다.
   */
  detail?: string;
  /** 중복 방지용 키 (예: reverse 잡의 assetId) */
  key?: string;
  /**
   * 예상 소요 시간(초) — **잡을 등록하는 순간** 채워져 브로드캐스트된다 (W8 F3-A).
   * 모션 블러 파생은 1080×1920 30초에 38분이다. 끝나고 나서 알려주는 건 소용이 없다.
   */
  estimateSec?: number;
  result?: { url: string; path: string } | Record<string, unknown>;
  error?: string;
};

export type JobFn = (
  job: Job,
  report: (p: number, detail?: string) => void,
  /**
   * 시간 초과로 큐가 이 잡을 포기하는 순간 abort 된다. ffmpeg 등 자식 프로세스를 띄우는 잡은
   * 이걸 `RunOpts.signal` 로 넘겨야 프로세스가 **같이 죽는다** — 안 넘기면 큐만 넘어가고
   * 프로세스는 남아 재시도할수록 쌓인다 (W8 F17 리뷰 #12).
   */
  signal: AbortSignal,
) => Promise<Job['result'] | void>;

export type EnqueueOpts = { key?: string; timeoutMs?: number; estimateSec?: number };

const MIN = 60_000;

/**
 * 잡 종류별 기본 타임아웃.
 * 이 시간을 넘기면 그 잡만 error 로 끝내고 레인은 다음 잡으로 넘어간다.
 * (타임아웃된 잡이 띄운 자식 프로세스를 죽이지는 못한다 — 목표는 큐를 계속 돌리는 것)
 */
const DEFAULT_TIMEOUT_MS: Record<JobType, number> = {
  proxy: 10 * MIN,
  waveform: 10 * MIN,
  thumb: 10 * MIN,
  cover: 10 * MIN,
  beats: 10 * MIN,
  matchStats: 10 * MIN,
  reverse: 60 * MIN,
  derive: 60 * MIN,
  track: 30 * MIN,
  render: 60 * MIN,
  upscale: 120 * MIN,
  interpolate: 120 * MIN,
  separate: 120 * MIN, // 모델 다운로드 포함
  captions: 120 * MIN, // 모델 다운로드 포함
};

/**
 * 여러 단계로 나뉜 잡의 진행률 (W8 S5-c).
 * `deriveMedia`(media/derive.ts)의 `passProgress`/`endPass` 와 같은 형태지만,
 * 단계마다 걸리는 시간이 다르므로 **가중치**를 받는다.
 * (예: F12 사이드체인 = 스템 0.26 / 스템 0.26 / 영상 0.46 / 믹스 0.02)
 *
 * 가중치는 합이 1이 아니어도 되고 내부에서 정규화한다. 단계 하나(`[1]`)면 그냥 통과다.
 */
export function stageProgress(
  weights: readonly number[],
  report: (p: number) => void,
): { passProgress: (p: number) => void; endPass: () => void } {
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  let index = 0;
  let base = 0; // 끝난 단계들의 가중치 합
  return {
    passProgress: (p: number) => {
      const cur = w[index] ?? 0;
      report((base + cur * Math.min(1, Math.max(0, p))) / total);
    },
    endPass: () => {
      base += w[index] ?? 0;
      index++;
      report(base / total);
    },
  };
}

export type JobLane = 'fast' | 'slow';

/** 짧고 자주 도는 잡. 임포트 직후 UI(파형·썸네일·프록시)가 여기에 걸린다. */
const FAST_TYPES = new Set<JobType>(['proxy', 'waveform', 'thumb', 'cover', 'beats', 'matchStats']);

function laneOf(type: JobType): JobLane {
  return FAST_TYPES.has(type) ? 'fast' : 'slow';
}

/** 끝난(done/error) 잡을 이만큼만 보관하고 오래된 것부터 버린다. queued/running 은 절대 안 버린다. */
const MAX_FINISHED_JOBS = 200;

type Entry = { job: Job; fn: JobFn; timeoutMs: number };
type Lane = { queue: Entry[]; running: boolean };

export class JobQueue {
  private jobs = new Map<string, Job>();
  /** 끝난 잡 id 를 끝난 순서대로 — 상한을 넘으면 앞에서부터 버린다. */
  private finished: string[] = [];
  // 레인은 정확히 2개, 레인당 동시 실행은 정확히 1개다.
  //
  // 이 성질을 깨지 마라: derive 잡은 asset.derived 를 락 밖에서 읽고 통째로 교체하기 때문에
  // 두 개가 동시에 돌면 먼저 끝난 쪽의 결과가 조용히 덮여 사라진다.
  // derive 가 slow 레인 하나뿐이라는 사실만이 그 경합을 막고 있다.
  // 레인을 늘리거나 레인당 동시성을 2 이상으로 올리려면 derive 쓰기부터 직렬화해야 한다.
  private lanes: Record<JobLane, Lane> = {
    fast: { queue: [], running: false },
    slow: { queue: [], running: false },
  };

  constructor(private hub: Hub) {}

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** 같은 type+key 의 잡이 대기/실행 중인가 (reverse 중복 등록 방지) */
  hasActive(type: JobType, key: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.type === type && job.key === key && (job.status === 'queued' || job.status === 'running')) {
        return true;
      }
    }
    return false;
  }

  /**
   * 아직 시작 안 한(queued) 같은 type·projectId 의 잡 중 `isDead(key)` 인 것을 레인 큐에서 빼고
   * 조용히 done + `result:{cancelled:true}` 로 끝낸다. 실패가 아니라 사용자가 버린 값일 뿐이라
   * error 로 두지 않는다. 실행 중(running)인 잡은 건드리지 않는다. 취소한 개수를 반환한다.
   *
   * (W5 회수: LUT 강도 슬라이더를 드래그하면 버려진 강도값마다 잡이 하나씩 쌓이는데,
   *  그걸 끝까지 굽는 것은 원본 전체 재인코딩 × 버려진 값 개수의 낭비다.)
   */
  cancelQueued(type: JobType, projectId: string, isDead: (key: string) => boolean): number {
    let cancelled = 0;
    for (const lane of Object.values(this.lanes)) {
      const keep: Entry[] = [];
      for (const entry of lane.queue) {
        const job = entry.job;
        if (job.type === type && job.projectId === projectId && job.key !== undefined && isDead(job.key)) {
          job.status = 'done';
          job.progress = 1;
          job.result = { cancelled: true };
          this.retire(job);
          this.broadcast(job);
          cancelled++;
        } else {
          keep.push(entry);
        }
      }
      lane.queue = keep;
    }
    return cancelled;
  }

  /**
   * 잡 등록. 네 번째 인자는 문자열(= key) 또는 { key, timeoutMs } 둘 다 받는다 (기존 호출부 호환).
   */
  enqueue(type: JobType, projectId: string, fn: JobFn, opts?: string | EnqueueOpts): Job {
    const o: EnqueueOpts = typeof opts === 'string' ? { key: opts } : (opts ?? {});
    const job: Job = { id: newId(), type, projectId, status: 'queued', progress: 0 };
    if (o.key !== undefined) job.key = o.key;
    if (o.estimateSec !== undefined && o.estimateSec > 0) job.estimateSec = o.estimateSec;
    this.jobs.set(job.id, job);
    const lane = laneOf(type);
    this.lanes[lane].queue.push({ job, fn, timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS[type] });
    this.broadcast(job);
    void this.pump(lane);
    return job;
  }

  /** 두 레인의 대기 잡이 전부 끝날 때까지 대기 (테스트·종료 처리용) */
  async idle(): Promise<void> {
    while (this.busy()) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private busy(): boolean {
    for (const lane of Object.values(this.lanes)) {
      if (lane.running || lane.queue.length > 0) return true;
    }
    return false;
  }

  private async pump(laneName: JobLane): Promise<void> {
    const lane = this.lanes[laneName];
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.queue.length > 0) {
        const { job, fn, timeoutMs } = lane.queue.shift()!;
        job.status = 'running';
        this.broadcast(job);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        try {
          const report = (p: number, detail?: string) => {
            const clamped = Math.min(1, Math.max(0, p));
            const changed =
              Math.round(clamped * 100) !== Math.round(job.progress * 100) ||
              (detail !== undefined && detail !== job.detail);
            job.progress = clamped;
            if (detail !== undefined) job.detail = detail;
            if (changed) this.broadcast(job);
          };
          // settle 되지 않는 잡(예: 파이프 입력을 기다리며 굳은 ffmpeg)이 레인을 영구히
          // 붙잡지 못하도록 타임아웃과 race 시킨다. 진 쪽은 그대로 매달려 있지만,
          // race 가 양쪽에 핸들러를 달아두므로 나중에 reject 돼도 unhandled 가 되지 않는다.
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                // 진 쪽이 «그대로 매달려 있지» 않게 — 자식 프로세스까지 함께 끝낸다
                controller.abort(new Error('시간 초과'));
                reject(
                  new Error(
                    `시간 초과: ${job.type} 잡이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 중단했습니다.`,
                  ),
                );
              },
              timeoutMs,
            );
            // 아직 안 터진 타임아웃 타이머가 프로세스 종료를 붙잡지 않도록 unref.
            timer.unref?.();
          });
          // 잡 안에서 띄우는 모든 자식 프로세스(ffmpeg·ncnn·파이썬)가 이 신호를 물려받는다 —
          // 함수 서명마다 signal 을 뚫어 넘기지 않아도 된다 (media/job-signal.ts).
          const result = await Promise.race([
            runWithJobSignal(controller.signal, () => fn(job, report, controller.signal)),
            timeout,
          ]);
          job.progress = 1;
          if (result) job.result = result;
          job.status = 'done';
        } catch (err) {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        this.retire(job);
        this.broadcast(job);
      }
    } finally {
      lane.running = false;
    }
  }

  /** 끝난 잡을 보관 목록에 넣고, 상한을 넘으면 오래된 것부터 Map 에서 지운다. */
  private retire(job: Job): void {
    this.finished.push(job.id);
    while (this.finished.length > MAX_FINISHED_JOBS) {
      const oldest = this.finished.shift()!;
      this.jobs.delete(oldest);
    }
  }

  private broadcast(job: Job): void {
    this.hub.broadcast(job.projectId, { type: 'job', job });
  }
}
