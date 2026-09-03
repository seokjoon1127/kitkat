// 눈금자 — 시간 눈금 + 재생헤드 핸들, 클릭/드래그로 시킹
import React, { useCallback, useRef } from 'react';
import { clampMs, formatTime, msToPx, pxToMs, rulerStep } from '../timeline-utils.js';

export const RULER_HEIGHT = 28;

type Props = {
  durationMs: number;
  zoom: number;
  playheadMs: number;
  beats?: readonly number[]; // 비트 마커 (타임라인 ms)
  onSeek: (ms: number) => void;
};

export default function Ruler({ durationMs, zoom, playheadMs, beats, onSeek }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ms = clampMs(pxToMs(clientX - rect.left, zoom), 0, durationMs);
      onSeek(ms);
    },
    [zoom, durationMs, onSeek],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      seekFromEvent(e.clientX);
      const move = (ev: PointerEvent) => seekFromEvent(ev.clientX);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [seekFromEvent],
  );

  const { major, minor } = rulerStep(zoom);
  const ticks: React.ReactNode[] = [];
  for (let t = 0; t <= durationMs; t += minor) {
    const isMajor = t % major === 0;
    const left = msToPx(t, zoom);
    ticks.push(
      <div
        key={t}
        className={isMajor ? 'tl-tick tl-tick-major' : 'tl-tick'}
        style={{ left }}
      >
        {isMajor && <span className="tl-tick-label">{formatTime(t)}</span>}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      className="tl-ruler"
      style={{ width: msToPx(durationMs, zoom), height: RULER_HEIGHT }}
      onPointerDown={onPointerDown}
    >
      {ticks}
      {beats?.map((ms) => (
        <div key={`beat-${ms}`} className="tl-beat-tick" style={{ left: msToPx(ms, zoom) }} />
      ))}
      <div className="tl-playhead-handle" style={{ left: msToPx(playheadMs, zoom) }} />
    </div>
  );
}
