// 프리뷰 v2 — 재생 클럭(performance.now 기준, 1배 고정)과 오디오 믹서.
// 판정 수식(드리프트·활성 클립·볼륨)은 timing.ts 의 순수 함수를 쓴다.
import type { Asset, AudioClip, Track } from '@kitkat/schema';
import { resolveAudioSrc } from '@kitkat/renderer/composition';
import { advanceClock, clipVolume, needsResync } from './timing.js';

export type ClockOptions = {
  /** 매 rAF 프레임마다 현재 시각(ms)과 재생 여부를 받는다 */
  onTick: (tMs: number, playing: boolean) => void;
  /** 문서 전체 길이 ms — 끝에 닿으면 멈춘다 */
  getDurationMs: () => number;
  onEnded: () => void;
};

/** performance.now 기반 재생 클럭. 배속 없음(1배 고정), 프레임 콜백은 requestAnimationFrame. */
export class PlaybackClock {
  private readonly opts: ClockOptions;
  private timeMs = 0;
  private playing = false;
  private lastNow = 0;
  private raf: number | null = null;
  private running = false;

  constructor(opts: ClockOptions) {
    this.opts = opts;
  }

  get currentMs(): number {
    return this.timeMs;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    const loop = (): void => {
      if (!this.running) return;
      const now = performance.now();
      const elapsed = now - this.lastNow;
      this.lastNow = now;
      if (this.playing) {
        const r = advanceClock(this.timeMs, elapsed, this.opts.getDurationMs());
        this.timeMs = r.ms;
        if (r.ended) {
          this.playing = false;
          this.opts.onEnded();
        }
      }
      this.opts.onTick(this.timeMs, this.playing);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  play(): void {
    if (this.playing) return;
    this.lastNow = performance.now();
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** 외부(타임라인 클릭·키보드)에서 온 시크. */
  seek(ms: number): void {
    this.timeMs = Math.max(0, ms);
    this.lastNow = performance.now();
  }
}

export type AudioTarget = { clip: AudioClip; track: Track; localMs: number };

/**
 * 오디오 클립마다 HTMLAudioElement 를 하나 두고 같은 클럭에 맞춘다.
 * (비디오 클립의 소리는 decoder.ts 의 video 엘리먼트가 직접 낸다.)
 */
export class AudioMixer {
  private readonly els = new Map<string, HTMLAudioElement>();
  private readonly mediaBase: string;
  private readonly driftMs: number;

  constructor(mediaBase: string, driftMs = 100) {
    this.mediaBase = mediaBase;
    this.driftMs = driftMs;
  }

  /** 이번 프레임에 들려야 할 클립들에 맞춰 엘리먼트를 정렬한다. */
  sync(targets: AudioTarget[], assets: Record<string, Asset>, playing: boolean): void {
    const alive = new Set<string>();
    for (const t of targets) {
      const asset = assets[t.clip.assetId];
      if (!asset) continue;
      alive.add(t.clip.id);
      let el = this.els.get(t.clip.id);
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        el.crossOrigin = 'anonymous';
        this.els.set(t.clip.id, el);
      }
      const src = resolveAudioSrc(t.clip, asset, this.mediaBase);
      if (!el.src.endsWith(src)) el.src = src;
      el.playbackRate = Math.min(16, Math.max(0.0625, t.clip.speed));
      el.volume = clipVolume(t.clip, t.track, t.localMs);
      const targetMs = t.clip.in + t.localMs * t.clip.speed;
      if (!playing) {
        if (!el.paused) el.pause();
        continue;
      }
      if (el.paused) {
        el.currentTime = Math.max(0, targetMs) / 1000;
        void el.play().catch(() => {
          /* 자동재생 제한 — 소리만 빠지고 화면은 계속 간다 */
        });
      } else if (needsResync(el.currentTime * 1000, targetMs, this.driftMs)) {
        el.currentTime = Math.max(0, targetMs) / 1000;
      }
    }
    for (const [id, el] of this.els) {
      if (alive.has(id)) continue;
      if (!el.paused) el.pause();
    }
  }

  pauseAll(): void {
    for (const el of this.els.values()) {
      if (!el.paused) el.pause();
    }
  }

  dispose(): void {
    for (const el of this.els.values()) {
      el.pause();
      el.removeAttribute('src');
    }
    this.els.clear();
  }
}
