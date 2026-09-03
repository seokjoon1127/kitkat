// 트랙 1줄 — 왼쪽 고정 헤더(음소거/잠금/숨김/볼륨/삭제) + 클립 레인
import React, { useState } from 'react';
import type { Asset, Track } from '@kitkat/schema';
import { useEditor } from '../state.js';
import { msToPx } from '../timeline-utils.js';
import TimelineClip, { type ClipDragMode, type ClipPreview } from './TimelineClip.js';

export const TRACK_HEIGHT = 64;
export const HEADER_WIDTH = 190;

export const TRACK_KIND_LABEL: Record<Track['kind'], string> = {
  video: '비디오',
  audio: '오디오',
  text: '텍스트',
  overlay: '오버레이',
};

/** 이동 드래그 중 이 트랙 위에 그리는 고스트 */
export type TrackGhost = { start: number; duration: number; invalid: boolean; label: string } | null;

type Props = {
  track: Track;
  zoom: number;
  laneWidth: number;
  assets: Record<string, Asset>;
  selectedClipId: string | null;
  movingClipId: string | null; // 이동 드래그 중인 클립(원본 흐리게)
  trimPreview: { clipId: string; start: number; duration: number; invalid: boolean } | null;
  ghost: TrackGhost;
  onClipPointerDown: (e: React.PointerEvent, clipId: string, mode: ClipDragMode) => void;
  onSelect: (clipId: string | null) => void;
};

export default function TimelineTrack({
  track,
  zoom,
  laneWidth,
  assets,
  selectedClipId,
  movingClipId,
  trimPreview,
  ghost,
  onClipPointerDown,
  onSelect,
}: Props) {
  const dispatch = useEditor((s) => s.dispatch);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);

  const hasVolume = track.kind === 'video' || track.kind === 'audio';
  const volume = volumeDraft ?? track.volume ?? 1;

  const toggle = (patch: { muted?: boolean; locked?: boolean; hidden?: boolean }) => {
    void dispatch([{ type: 'setTrackProps', trackId: track.id, patch }]);
  };

  return (
    <div className="tl-row" style={{ height: TRACK_HEIGHT }}>
      <div className="tl-header" style={{ width: HEADER_WIDTH, height: TRACK_HEIGHT }}>
        <div className="tl-header-top">
          <span className={`tl-kind tl-kind-${track.kind}`}>{TRACK_KIND_LABEL[track.kind]}</span>
          <span className="tl-track-name" title={track.name}>
            {track.name}
          </span>
          <button
            type="button"
            className="tl-btn tl-btn-danger"
            title="트랙 삭제"
            onClick={() => {
              onSelect(null);
              void dispatch([{ type: 'removeTrack', trackId: track.id }]);
            }}
          >
            ✕
          </button>
        </div>
        <div className="tl-header-bottom">
          <button
            type="button"
            className={`tl-btn${track.muted ? ' tl-btn-on' : ''}`}
            title={track.muted ? '음소거 해제' : '음소거'}
            onClick={() => toggle({ muted: !track.muted })}
          >
            M
          </button>
          <button
            type="button"
            className={`tl-btn${track.locked ? ' tl-btn-on' : ''}`}
            title={track.locked ? '잠금 해제' : '잠금'}
            onClick={() => toggle({ locked: !track.locked })}
          >
            잠금
          </button>
          <button
            type="button"
            className={`tl-btn${track.hidden ? ' tl-btn-on' : ''}`}
            title={track.hidden ? '표시' : '숨김'}
            onClick={() => toggle({ hidden: !track.hidden })}
          >
            숨김
          </button>
          {hasVolume && (
            <input
              type="range"
              className="tl-volume"
              min={0}
              max={2}
              step={0.05}
              value={volume}
              title={`트랙 볼륨 ${Math.round(volume * 100)}%`}
              onChange={(e) => setVolumeDraft(Number(e.target.value))}
              onPointerUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                setVolumeDraft(null);
                void dispatch([{ type: 'setTrackProps', trackId: track.id, patch: { volume: v } }]);
              }}
            />
          )}
        </div>
      </div>
      <div
        className={`tl-lane${track.hidden ? ' tl-lane-hidden' : ''}${track.locked ? ' tl-lane-locked' : ''}`}
        style={{ width: laneWidth, height: TRACK_HEIGHT }}
        onPointerDown={() => onSelect(null)}
      >
        {track.clips.map((clip) => (
          <TimelineClip
            key={clip.id}
            clip={clip}
            asset={'assetId' in clip ? assets[clip.assetId] : undefined}
            zoom={zoom}
            selected={selectedClipId === clip.id}
            locked={!!track.locked}
            dimmed={movingClipId === clip.id}
            preview={
              (trimPreview && trimPreview.clipId === clip.id
                ? { start: trimPreview.start, duration: trimPreview.duration, invalid: trimPreview.invalid }
                : null) satisfies ClipPreview
            }
            onPointerDown={onClipPointerDown}
            onSelect={(id) => onSelect(id)}
          />
        ))}
        {ghost && (
          <div
            className={`tl-ghost${ghost.invalid ? ' tl-ghost-invalid' : ''}`}
            style={{ left: msToPx(ghost.start, zoom), width: Math.max(2, msToPx(ghost.duration, zoom)) }}
          >
            <span className="tl-clip-name">{ghost.label}</span>
          </div>
        )}
      </div>
    </div>
  );
}
