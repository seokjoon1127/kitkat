// 미디어 src·소스 구간 결정 (순수 로직 — remotion 무의존, 단위테스트 대상)
import type { Asset, AudioClip, ImageClip, VideoClip } from '@kitkat/schema';
import { sourceKey } from '@kitkat/schema';

/** 클립의 파생 미디어(M2) — clip.source 로 구운 클립 전용 파일. 없으면 undefined. */
function derivedFor(
  clip: VideoClip | AudioClip | ImageClip,
  asset: Asset,
): { src: string; proxySrc?: string } | undefined {
  if (clip.kind !== 'video' && clip.kind !== 'audio') return undefined;
  const k = sourceKey(clip);
  if (!k) return undefined;
  return asset.derived?.[k];
}

/**
 * 미디어 src 결정.
 * 1) 파생 파일(clip.source 로 구운 것)이 있으면 그것 — **reversed 보다 우선**(X5-b).
 *    reversed 클립의 파생 파일은 역재생본에서 구워지므로(X6) 소스 구간 미러링은 그대로 필요하다.
 * 2) reversed면 reversedSrc(없으면 원본 폴백).
 * 3) 그 외 proxy면 proxySrc 우선.
 */
export function resolveMediaSrc(
  clip: VideoClip | AudioClip | ImageClip,
  asset: Asset,
  mediaBase: string,
  proxy: boolean,
): { src: string; useReversed: boolean; useDerived: boolean } {
  const d = derivedFor(clip, asset);
  if (d) {
    const rel = proxy ? d.proxySrc ?? d.src : d.src;
    return { src: `${mediaBase}/${rel}`, useReversed: false, useDerived: true };
  }
  if (clip.kind === 'video' && clip.reversed && asset.reversedSrc && asset.duration != null) {
    return { src: `${mediaBase}/${asset.reversedSrc}`, useReversed: true, useDerived: false };
  }
  const rel = proxy && asset.proxySrc ? asset.proxySrc : asset.src;
  return { src: `${mediaBase}/${rel}`, useReversed: false, useDerived: false };
}

/**
 * src + 재생할 소스 구간(ms). 역재생본은 원본을 뒤집어 놓은 것이므로
 * 소스 구간을 미러링한다: inMs = assetDuration - out, outMs = assetDuration - in.
 *
 * **파생 파일도 reversed 클립이면 미러링한다** — 서버는 reversed 클립의 파생을
 * `reversedSrc` 에서 굽고(X6), 그 파일의 길이는 원본과 같다. 미러링을 빼면
 * 클립의 엉뚱한 구간이 재생된다.
 */
export function resolveMediaWindow(
  clip: VideoClip | AudioClip,
  asset: Asset,
  mediaBase: string,
  proxy: boolean,
): { src: string; inMs: number; outMs: number; useReversed: boolean; useDerived: boolean } {
  const { src, useReversed, useDerived } = resolveMediaSrc(clip, asset, mediaBase, proxy);
  const mirrored = useReversed || (useDerived && clip.kind === 'video' && clip.reversed === true);
  if (mirrored && asset.duration != null) {
    return {
      src,
      inMs: asset.duration - clip.out,
      outMs: asset.duration - clip.in,
      useReversed,
      useDerived,
    };
  }
  return { src, inMs: clip.in, outMs: clip.out, useReversed, useDerived };
}

/**
 * 오디오 클립의 src. 파생(잡음 제거·피치)이 있으면 그것, 없으면 원본 (v1 그대로 — 오디오는 프록시 없음).
 */
export function resolveAudioSrc(clip: AudioClip, asset: Asset, mediaBase: string): string {
  const d = derivedFor(clip, asset);
  return `${mediaBase}/${d ? d.src : asset.src}`;
}
