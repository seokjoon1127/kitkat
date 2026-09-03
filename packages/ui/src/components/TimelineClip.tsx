// 타임라인 클립 1개 — 위치/폭 렌더, 선택, 트림 핸들, 오디오 파형, 텍스트 미리보기
import React, { useEffect, useRef } from 'react';
import type { Asset, Clip } from '@kitkat/schema';
import { msToPx } from '../timeline-utils.js';
import { loadWaveform } from '../waveform.js';

export type ClipDragMode = 'move' | 'trim-start' | 'trim-end';

/** 드래그 중 미리보기 오버라이드 */
export type ClipPreview = { start: number; duration: number; invalid: boolean } | null;

type Props = {
  clip: Clip;
  asset: Asset | undefined; // text 클립이면 undefined
  zoom: number;
  selected: boolean;
  locked: boolean;
  dimmed: boolean; // 이동 드래그 중 원본 클립 표시 약화
  preview: ClipPreview; // 트림 드래그 중 위치/폭 오버라이드
  onPointerDown: (e: React.PointerEvent, clipId: string, mode: ClipDragMode) => void;
  onSelect: (clipId: string) => void;
};

function WaveformCanvas({
  src,
  widthPx,
  inMs,
  outMs,
  assetDurationMs,
}: {
  src: string;
  widthPx: number;
  inMs: number;
  outMs: number;
  assetDurationMs: number | undefined;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    loadWaveform(src).then((wave) => {
      if (!alive || !ref.current || !wave || wave.peaks.length === 0) return;
      const peaks = wave.peaks;
      const canvas = ref.current;
      const w = Math.max(1, Math.floor(widthPx));
      const h = canvas.height;
      canvas.width = w;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(126, 211, 155, 0.85)';
      // 새 형식은 버킷 시간이 있어 «소스 ms → 버킷» 이 바로 나온다.
      // 옛 형식(1000버킷 배열)은 버킷 시간을 모르므로 예전처럼 전체 길이 비율로 잡는다.
      let b0: number;
      let b1: number;
      if (wave.kind === 'bucketed') {
        b0 = Math.max(0, Math.floor(inMs / wave.bucketMs));
        b1 = Math.min(peaks.length, Math.ceil((outMs || peaks.length * wave.bucketMs) / wave.bucketMs));
      } else {
        const total = assetDurationMs && assetDurationMs > 0 ? assetDurationMs : outMs || 1;
        b0 = Math.max(0, Math.floor((inMs / total) * peaks.length));
        b1 = Math.min(peaks.length, Math.ceil(((outMs || total) / total) * peaks.length));
      }
      const span = Math.max(1, b1 - b0);
      // 버킷이 픽셀보다 많으면(20ms 버킷이면 흔하다) 픽셀당 최댓값을 취해야 파형이 안 사라진다.
      const perPx = span / w;
      for (let x = 0; x < w; x++) {
        const from = b0 + Math.floor(x * perPx);
        const to = Math.max(from + 1, b0 + Math.floor((x + 1) * perPx));
        let v = 0;
        for (let i = from; i < to && i < peaks.length; i++) {
          const p = peaks[i] ?? 0;
          if (p > v) v = p;
        }
        const bar = Math.max(1, v * (h - 2));
        ctx.fillRect(x, (h - bar) / 2, 1, bar);
      }
    });
    return () => {
      alive = false;
    };
  }, [src, widthPx, inMs, outMs, assetDurationMs]);
  return <canvas ref={ref} className="tl-waveform" height={32} />;
}

export default function TimelineClip({
  clip,
  asset,
  zoom,
  selected,
  locked,
  dimmed,
  preview,
  onPointerDown,
  onSelect,
}: Props) {
  const start = preview ? preview.start : clip.start;
  const duration = preview ? preview.duration : clip.duration;
  const left = msToPx(start, zoom);
  const width = Math.max(2, msToPx(duration, zoom));

  const classes = ['tl-clip', `tl-clip-${clip.kind}`];
  if (selected) classes.push('tl-clip-selected');
  if (dimmed) classes.push('tl-clip-dimmed');
  if (preview?.invalid) classes.push('tl-clip-invalid');
  if (locked) classes.push('tl-clip-locked');

  const label =
    clip.kind === 'text' ? clip.text.replace(/\s+/g, ' ').trim() || '(빈 텍스트)' : asset?.name ?? '(에셋 없음)';

  let badge: string | null = null;
  // 정지화면·반복(스티커)은 길이 규칙이 다르므로 눈에 띄게 따로 표시한다 (W5)
  let markBadge: string | null = null;
  if (clip.kind === 'video') {
    const parts: string[] = [];
    if (clip.speed !== 1 && !clip.freeze) parts.push(`${clip.speed}x`);
    if (clip.reversed) parts.push('역재생');
    if (clip.speedRamp) parts.push('속도곡선');
    badge = parts.length > 0 ? parts.join(' · ') : null;
    if (clip.freeze) markBadge = '정지';
    else if (clip.loop) markBadge = '반복';
  } else if (clip.kind === 'audio' && clip.speed !== 1) {
    badge = `${clip.speed}x`;
  }
  if (markBadge) classes.push(`tl-clip-${clip.kind === 'video' && clip.freeze ? 'freeze' : 'loop'}`);

  const thumbUrl =
    (clip.kind === 'video' || clip.kind === 'image') && asset?.thumbSrc
      ? `/media/${asset.thumbSrc}`
      : null;

  return (
    <div
      className={classes.join(' ')}
      style={{ left, width }}
      title={label}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect(clip.id);
        if (!locked) onPointerDown(e, clip.id, 'move');
      }}
    >
      {thumbUrl && (
        <div className="tl-clip-thumb" style={{ backgroundImage: `url(${thumbUrl})` }} />
      )}
      {clip.kind === 'audio' && asset?.waveformSrc && (
        <WaveformCanvas
          src={asset.waveformSrc}
          widthPx={width}
          inMs={clip.in}
          outMs={clip.out}
          assetDurationMs={asset.duration}
        />
      )}
      <div className="tl-clip-label">
        {clip.kind === 'text' && <span className="tl-clip-kindmark">T</span>}
        {markBadge && <span className="tl-clip-mark">{markBadge}</span>}
        <span className="tl-clip-name">{label}</span>
        {badge && <span className="tl-clip-badge">{badge}</span>}
      </div>
      {!locked && (
        <>
          <div
            className="tl-trim-handle tl-trim-start"
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect(clip.id);
              onPointerDown(e, clip.id, 'trim-start');
            }}
          />
          <div
            className="tl-trim-handle tl-trim-end"
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect(clip.id);
              onPointerDown(e, clip.id, 'trim-end');
            }}
          />
        </>
      )}
    </div>
  );
}
