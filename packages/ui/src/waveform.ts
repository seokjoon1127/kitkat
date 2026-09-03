// 파형 파일 로더 (W8 F12-B) — 타임라인 그리기와 더킹이 «같은 한 벌»을 쓴다.
//
// 형식이 두 가지다:
//   옛 형식(배열)  [0.1, 0.3, ...]                       ← 길이와 무관하게 1000버킷 peak
//   새 형식(객체)  { bucketMs, peaks: [...], rms: [...] } ← 20ms 고정 버킷 + RMS
//
// 옛 형식은 **버킷 시간을 알 수 없다** — 그리기는 「전체를 1000등분」으로 되지만
// 더킹은 시각을 계산해야 하므로 못 쓴다. 조용히 근사하지 않고 다시 굽는다.
import type { VoiceEnvelope } from '@kitkat/engine';

export type WaveformFile =
  | { kind: 'legacy'; peaks: number[] }
  | { kind: 'bucketed'; bucketMs: number; peaks: number[]; rms: number[] };

const cache = new Map<string, Promise<WaveformFile | null>>();

export function parseWaveform(raw: unknown): WaveformFile | null {
  if (Array.isArray(raw)) {
    return raw.every((v) => typeof v === 'number') ? { kind: 'legacy', peaks: raw } : null;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { bucketMs?: unknown; peaks?: unknown; rms?: unknown };
    if (typeof o.bucketMs === 'number' && o.bucketMs > 0 && Array.isArray(o.peaks) && Array.isArray(o.rms)) {
      return { kind: 'bucketed', bucketMs: o.bucketMs, peaks: o.peaks as number[], rms: o.rms as number[] };
    }
  }
  return null;
}

export function loadWaveform(src: string): Promise<WaveformFile | null> {
  let p = cache.get(src);
  if (!p) {
    p = fetch(`/media/${src}`)
      .then(async (r) => (r.ok ? parseWaveform(await r.json()) : null))
      .catch(() => null)
      .then((w) => {
        // 옛 형식·실패는 **캐시에 눌러앉히지 않는다** — 서버가 다시 굽고 나면
        // 같은 경로에 새 형식이 들어오는데, 캐시가 남아 있으면 영영 옛 값을 본다.
        if (!w || w.kind === 'legacy') cache.delete(src);
        return w;
      });
    cache.set(src, p);
  }
  return p;
}

/** 더킹에 쓸 포락선 — 옛 형식이면 null(버킷 시간을 모른다). */
export function toEnvelope(w: WaveformFile | null): VoiceEnvelope | null {
  return w && w.kind === 'bucketed' ? { bucketMs: w.bucketMs, rms: w.rms } : null;
}
