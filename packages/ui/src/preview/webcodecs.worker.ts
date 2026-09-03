// F14 — WebCodecs 디코드 루프의 **워커 쪽**.
//
// 왜 워커인가: 편집기는 화면 주기마다 WebGL 업로드·합성 + React 타임라인을 메인 스레드에서
// 그린다. mediabunny 의 컨테이너 분해와 디코더 출력 콜백도 메인 스레드에서 돌면 그 사이에
// 끼어들 틈이 없어 **디코더가 굶는다**(실측: 편집기에서 초당 0.7프레임). 분해·디코드를 이 워커로
// 옮기면 메인 스레드가 아무리 바빠도 프레임이 계속 나오고, `VideoFrame` 은 복사 없이(transfer)
// 메인으로 넘어간다.
//
// 메인 쪽(`webcodecs.ts` 의 WorkerFrameSource)이 링버퍼와 `close()` 책임을 진다. 여기서는
// 창(window)을 계산해 프레임을 «흘려보내기만» 한다.
import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  UrlSource,
  VideoSampleSink,
  type InputVideoTrack,
} from 'mediabunny';
import { iterateWithStallGuard } from './pool.js';

/** 메인 → 워커 */
export type WorkerIn =
  | { type: 'open'; url: string; lookahead: number }
  | { type: 'hint'; ms: number; direction: 1 | -1; seq: number }
  | { type: 'close' };

/** 워커 → 메인 */
export type WorkerOut =
  | { type: 'opened'; frameMs: number; durationMs: number }
  | { type: 'failed'; reason: string }
  | { type: 'frame'; tsMs: number; frame: VideoFrame }
  /**
   * 디코드 루프가 창을 다 채우고 쉰다 (frameAt 의 «더 올 게 없다» 판정용).
   * `seq` = 마지막으로 받은 힌트 번호 — 메인은 자기가 보낸 최신 번호와 맞을 때만 믿는다
   * (옛 루프의 idle 이 새 힌트 직후에 도착해 «끝났다» 로 오해하던 경합).
   */
  | { type: 'idle'; seq: number }
  | { type: 'stats'; fills: number; aborts: number; error: string | null }
  | { type: 'closed' };

const DEFAULT_FRAME_MS = 1000 / 30;
const TOLERANCE_RATIO = 0.5;
/** 샘플이 이만큼 안 오면 그 채우기를 버린다 (부하 높은 기계에서 58장 채우기가 수 초 걸려 넉넉히 잡는다) */
const FILL_STALL_MS = 8000;

const ctx = self as unknown as {
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerIn>) => void) | null;
};

class WorkerDecoder {
  private input: Input | null = null;
  private track: InputVideoTrack | null = null;
  private sink: VideoSampleSink | null = null;
  private packets: EncodedPacketSink | null = null;
  private lookahead = 60;
  private frameMs = DEFAULT_FRAME_MS;
  private durationMs = Infinity;

  private gen = 0;
  private pumping = false;
  private pumpDone: Promise<void> = Promise.resolve();
  private targetMs = 0;
  private direction: 1 | -1 = 1;
  /** 지금까지 링에 넣어 준 연속 구간 (ms). 점프·방향 전환이면 초기화. */
  private filledLo = Infinity;
  private filledHi = -Infinity;
  /** 지금 채우는 중인(또는 마지막으로 채운) 계획 창 (ms) */
  private planLo = Infinity;
  private planHi = -Infinity;
  private fills = 0;
  private aborts = 0;
  private lastError: string | null = null;
  private lastSeq = 0;
  private closed = false;

  async open(url: string, lookahead: number): Promise<void> {
    this.lookahead = Math.max(4, Math.floor(lookahead));
    try {
      this.input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
      const track = await this.input.getPrimaryVideoTrack();
      if (!track) throw new Error('비디오 트랙 없음');
      if (track.rotation !== 0) throw new Error(`회전 ${track.rotation}° 는 미지원`);
      if (!(await track.canDecode())) throw new Error(`디코드 불가 코덱: ${track.codec ?? '알 수 없음'}`);
      this.track = track;
      this.sink = new VideoSampleSink(track, { optimizeForLatency: true });
      this.packets = new EncodedPacketSink(track);
      try {
        const stats = await track.computePacketStats(60);
        if (stats.averagePacketRate > 0) this.frameMs = 1000 / stats.averagePacketRate;
      } catch {
        /* 기본값 유지 */
      }
      try {
        const sec = await track.getDurationFromMetadata();
        if (sec !== null && sec > 0) this.durationMs = sec * 1000;
      } catch {
        /* 길이를 모르면 클램프를 안 한다 */
      }
      ctx.postMessage({ type: 'opened', frameMs: this.frameMs, durationMs: this.durationMs });
    } catch (e) {
      this.input?.dispose();
      this.input = null;
      ctx.postMessage({ type: 'failed', reason: e instanceof Error ? e.message : String(e) });
    }
  }

  private get tolMs(): number {
    return this.frameMs * TOLERANCE_RATIO;
  }

  private clamp(ms: number): number {
    const t = Math.max(0, ms);
    if (!Number.isFinite(this.durationMs)) return t;
    return Math.min(t, Math.max(0, this.durationMs - this.frameMs * 0.5));
  }

  /** 앞으로 미리 채워 둘 폭 (ms). 덮는 프레임 1장 + (lookahead-2)장 = 링 용량 안. */
  private get spanMs(): number {
    return (this.lookahead - 2) * this.frameMs;
  }

  hint(srcMs: number, direction: 1 | -1, seq: number): void {
    if (this.closed || !this.sink) return;
    this.lastSeq = seq;
    const ms = this.clamp(srcMs);
    const tol = this.tolMs;
    const sameDir = direction === this.direction;
    this.targetMs = ms;
    // «계획 창»(지금 채우는 중이거나 마지막으로 채운 범위) 안이거나 이미 채운 구간 안이면,
    // 루프가 돌고 있는 한 건드리지 않는다 — 목표만 갱신하면 루프가 알아서 이어 붙인다.
    // (채운 뒤에만 «덮였다» 로 치면, 채우기가 끝나기 전에 온 다음 힌트가 매번 루프를 재시작해
    //  영원히 한 장도 못 채우는 자물쇠가 걸린다 — 실측 fills 38 / aborts 37.)
    const inPlan = sameDir && ms >= this.planLo - tol && ms <= this.planHi + tol;
    const covered = sameDir && ms >= this.filledLo - tol && ms <= this.filledHi + tol;
    if ((inPlan || covered) && this.pumping) return;
    if (covered) {
      // 앞쪽 여유가 폭의 절반 넘게 남아 있으면 아무것도 안 한다. 한 프레임 움직일 때마다
      // 한 장씩 이어 붙이면 매번 디코더를 키프레임부터 다시 돌리게 된다(실측 힌트 87회에 fills 75회).
      // 여유가 절반 아래로 떨어지면 그때 폭만큼 **이어서** 채운다 (아래 pump 가 filledLo/Hi 를 본다).
      const half = this.spanMs * 0.5;
      const enough = direction > 0
        ? this.filledHi + tol >= Math.min(ms + half, this.clamp(Infinity))
        : this.filledLo - tol <= Math.max(0, ms - half);
      if (enough) {
        ctx.postMessage({ type: 'idle', seq }); // 할 일이 없다 — 기다리는 쪽을 바로 풀어 준다
        return;
      }
    } else {
      // 점프거나 방향이 바뀌었다 — 처음부터
      this.filledLo = Infinity;
      this.filledHi = -Infinity;
    }
    this.direction = direction;
    this.gen++;
    if (!this.pumping) this.pumpDone = this.pump();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gen++;
    // 루프가 스스로 빠져나온 뒤에 입력을 닫는다 — 도는 중에 닫으면 뒤늦게 나온 VideoSample 이 샌다
    await Promise.race([this.pumpDone, new Promise((r) => setTimeout(r, 5000))]);
    this.input?.dispose();
    this.input = null;
    ctx.postMessage({ type: 'closed' });
  }

  /**
   * 디코드 루프 — 목표 주변의 창을 **이어서** 채운다.
   *
   * - **정방향**: [이미 채운 끝, 목표 + span]. 목표가 앞으로 가면 새로 필요한 조각만 더 굽는다.
   *   mediabunny 가 알아서 앞 키프레임으로 가서 디코드하고, 시작을 «덮는» 프레임부터 내준다.
   * - **역방향**: 목표가 든 **GOP 를 통째로**(키프레임→목표) 디코드하고, 목표 - span 까지
   *   그 앞 GOP 들도 이어서 굽는다. 역재생은 원래 이 방법밖에 없다. 창의 범위를 «채우기로 한
   *   전체» 로 잡아야 GOP 가 짧은 파일(-g 15)에서 경계마다 루프가 재시작되지 않는다.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed) {
        const gen = this.gen;
        const target = this.targetMs;
        const dir = this.direction;
        const tol = this.tolMs;
        let aborted = false;
        if (dir > 0) {
          const cont = this.filledHi > -Infinity && target <= this.filledHi + tol && target >= this.filledLo - tol;
          const lo = cont ? this.filledHi + this.frameMs * 0.5 : target;
          const hi = target + this.spanMs;
          this.planLo = cont ? this.filledLo : target;
          this.planHi = hi;
          if (hi > lo) {
            const r = await this.fill(lo, hi + this.frameMs * 0.5, gen);
            aborted = r.aborted;
            if (!aborted) {
              this.filledHi = hi;
              if (!cont) this.filledLo = target;
            }
          }
        } else {
          const cont = this.filledLo < Infinity && target >= this.filledLo - tol && target <= this.filledHi + tol;
          let hiMs = cont ? this.filledLo : target;
          let first = !cont;
          const loBound = Math.max(0, target - this.spanMs);
          this.planHi = cont ? this.filledHi : target;
          this.planLo = loBound;
          if (!cont) this.filledHi = target;
          while (!aborted && hiMs > loBound && hiMs > 0) {
            const probeSec = (first ? hiMs : hiMs - this.frameMs * 0.5) / 1000;
            let lo = (await this.keyTimeSec(probeSec)) * 1000;
            if (lo >= hiMs) lo = Math.max(0, hiMs - this.frameMs);
            const r = await this.fill(lo, first ? hiMs + this.frameMs * 0.5 : hiMs, gen);
            aborted = r.aborted;
            if (aborted) break;
            this.filledLo = lo;
            first = false;
            if (lo <= 0) break;
            hiMs = lo;
          }
        }
        if (!aborted && gen === this.gen && target === this.targetMs) return;
      }
    } catch (e) {
      this.lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    } finally {
      this.pumping = false;
      ctx.postMessage({ type: 'stats', fills: this.fills, aborts: this.aborts, error: this.lastError });
      ctx.postMessage({ type: 'idle', seq: this.lastSeq });
    }
  }

  /**
   * [loMs, hiMs) 를 디코드해 메인으로 흘려보낸다.
   * 멈춤 감시(`iterateWithStallGuard`, 메인 폴백과 같은 규칙): 샘플이 `FILL_STALL_MS` 동안 안 오면
   * 이 채우기를 버리고 세대 번호를 올린다 — 안 그러면 `pumping` 이 영원히 참이라 이후 힌트가 전부
   * 무시된다(편집기 실측 3회 중 1회, 뒤로 끌기 79% 끊김).
   */
  private async fill(loMs: number, hiMs: number, gen: number): Promise<{ aborted: boolean; count: number }> {
    if (!(hiMs > loMs) || !this.sink) return { aborted: false, count: 0 };
    this.fills++;
    const r = await iterateWithStallGuard(this.sink.samples(loMs / 1000, hiMs / 1000), {
      stallMs: FILL_STALL_MS,
      alive: () => !this.closed && gen === this.gen,
      onItem: (sample) => {
        const tsMs = sample.timestamp * 1000;
        const frame = sample.toVideoFrame();
        sample.close();
        // transfer — 복사 없이 메인으로 넘어가고, 이쪽 손잡이는 자동으로 닫힌다
        ctx.postMessage({ type: 'frame', tsMs, frame }, [frame as unknown as Transferable]);
      },
      onStall: () => {
        this.gen++;
        this.lastError = `채우기 멈춤 ${FILL_STALL_MS}ms (${Math.round(loMs)}~${Math.round(hiMs)}ms)`;
      },
    });
    if (r.aborted) this.aborts++;
    return { aborted: r.aborted, count: r.count };
  }

  private async keyTimeSec(sec: number): Promise<number> {
    try {
      const key = await this.packets!.getKeyPacket(Math.max(0, sec), { metadataOnly: true });
      return key ? key.timestamp : 0;
    } catch {
      return 0;
    }
  }
}

const dec = new WorkerDecoder();
ctx.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  if (m.type === 'open') void dec.open(m.url, m.lookahead);
  else if (m.type === 'hint') dec.hint(m.ms, m.direction, m.seq);
  else if (m.type === 'close') void dec.close();
};
