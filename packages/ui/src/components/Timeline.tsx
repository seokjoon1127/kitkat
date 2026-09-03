// 타임라인 패널 — 눈금자·트랙·재생헤드·클립 드래그(이동/트림)·단축키·트랙 추가
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Track } from '@kitkat/schema';
import { newId } from '@kitkat/schema';
import { findClip, TRACK_ACCEPTS } from '@kitkat/engine';
import { useEditor } from '../state.js';
import {
  clampMs,
  collectBeatMarkers,
  collectSnapPoints,
  findFreeStart,
  hasOverlap,
  msToPx,
  pxToMs,
  snapMove,
  snapValue,
  timelineDurationMs,
  trimRange,
} from '../timeline-utils.js';
import Ruler, { RULER_HEIGHT } from './Ruler.js';
import TimelineTrack, { HEADER_WIDTH, TRACK_HEIGHT, TRACK_KIND_LABEL, type TrackGhost } from './TimelineTrack.js';
import type { ClipDragMode } from './TimelineClip.js';
import '../timeline.css';

const ZOOM_MIN = 10;
const ZOOM_MAX = 500;
const TAIL_MS = 2000; // 마지막 클립 뒤 여유 표시 구간
const FREEZE_MS = 1000; // 단축키 F 로 만드는 정지화면 길이
const MAX_BEAT_MARKERS = 1200; // 세로선이 너무 많아지면 그리기가 느려진다

type DragCtx = {
  mode: ClipDragMode;
  clipId: string;
  clipKind: Clip['kind'];
  sourceTrackId: string;
  origStart: number;
  origDuration: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
  label: string;
  // trim 전용
  range: { min: number; max: number };
  lastTrimTo: number;
  // move 전용
  lastMove: { targetTrackId: string; start: number; invalid: boolean };
};

type MoveUi = { targetTrackId: string; start: number; duration: number; invalid: boolean };
type TrimUi = { clipId: string; trackId: string; start: number; duration: number; invalid: boolean };

export function Timeline() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const playheadMs = useEditor((s) => s.playheadMs);
  const zoom = useEditor((s) => s.zoom);
  const dispatch = useEditor((s) => s.dispatch);
  const select = useEditor((s) => s.select);
  const seek = useEditor((s) => s.seek);
  const setZoom = useEditor((s) => s.setZoom);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragCtx | null>(null);
  const [moveUi, setMoveUi] = useState<MoveUi | null>(null);
  const [trimUi, setTrimUi] = useState<TrimUi | null>(null);

  const durationMs = useMemo(() => timelineDurationMs(doc) + TAIL_MS, [doc]);
  const laneWidth = Math.ceil(msToPx(durationMs, zoom));
  const tracks = doc?.tracks ?? [];

  // 비트 마커 — 선택 클립 + 오디오 트랙 클립들의 에셋 beats 를 타임라인 시각으로 옮긴 것
  const beatMarkers = useMemo(
    () => collectBeatMarkers(doc, { selectedClipId: selection.clipId }).slice(0, MAX_BEAT_MARKERS),
    [doc, selection.clipId],
  );
  // 드래그 핸들러(의존성 [])가 최신 비트를 읽을 수 있게 ref 로 넘긴다
  const beatsRef = useRef<number[]>(beatMarkers);
  beatsRef.current = beatMarkers;

  // 문서의 트랙 순서는 아래(0)→위 렌더 순서 — 화면에는 위 레이어를 먼저(위쪽에) 보여준다
  const displayTracks = useMemo(() => [...tracks].reverse(), [tracks]);
  const contentHeight = RULER_HEIGHT + displayTracks.length * TRACK_HEIGHT;

  const zoomBy = useCallback(
    (factor: number) => {
      const z = useEditor.getState().zoom * factor;
      setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
    },
    [setZoom],
  );

  // ---------- 클립 드래그 (이동·트림) ----------

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clipId: string, mode: ClipDragMode) => {
      const state = useEditor.getState();
      const curDoc = state.doc;
      if (!curDoc) return;
      const found = findClip(curDoc, clipId);
      if (!found || found.track.locked) return;
      const { track, clip } = found;
      const asset = 'assetId' in clip ? curDoc.assets[clip.assetId] : undefined;
      const label = clip.kind === 'text' ? clip.text : asset?.name ?? '';
      const edge = mode === 'trim-start' ? 'start' : 'end';
      const ctx: DragCtx = {
        mode,
        clipId,
        clipKind: clip.kind,
        sourceTrackId: track.id,
        origStart: clip.start,
        origDuration: clip.duration,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
        label,
        range: mode === 'move' ? { min: 0, max: 0 } : trimRange(track, clip, edge, asset?.duration),
        lastTrimTo: edge === 'start' ? clip.start : clip.start + clip.duration,
        lastMove: { targetTrackId: track.id, start: clip.start, invalid: false },
      };
      dragRef.current = ctx;
      e.preventDefault();

      const onMove = (ev: PointerEvent) => {
        const c = dragRef.current;
        const st = useEditor.getState();
        const d = st.doc;
        if (!c || !d) return;
        const dx = ev.clientX - c.startClientX;
        const dy = ev.clientY - c.startClientY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) c.moved = true;
        const dms = pxToMs(dx, st.zoom);
        const points = collectSnapPoints(d, {
          excludeClipId: c.clipId,
          playheadMs: st.playheadMs,
          beats: beatsRef.current,
        });

        if (c.mode === 'move') {
          const rawStart = Math.max(0, c.origStart + dms);
          const start = Math.max(0, snapMove(rawStart, c.origDuration, points, st.zoom));
          // 세로 위치 → 대상 트랙 (화면 위 = 배열 뒤)
          let targetTrack: Track | undefined;
          const scroller = scrollRef.current;
          if (scroller && d.tracks.length > 0) {
            const rect = scroller.getBoundingClientRect();
            const contentY = ev.clientY - rect.top + scroller.scrollTop - RULER_HEIGHT;
            const di = Math.min(
              d.tracks.length - 1,
              Math.max(0, Math.floor(contentY / TRACK_HEIGHT)),
            );
            targetTrack = d.tracks[d.tracks.length - 1 - di];
          }
          if (!targetTrack) targetTrack = d.tracks.find((t) => t.id === c.sourceTrackId);
          if (!targetTrack) return;
          const compatible = TRACK_ACCEPTS[targetTrack.kind].includes(c.clipKind);
          const invalid =
            !compatible ||
            !!targetTrack.locked ||
            hasOverlap(targetTrack.clips, start, c.origDuration, c.clipId);
          c.lastMove = { targetTrackId: targetTrack.id, start, invalid };
          setMoveUi({ targetTrackId: targetTrack.id, start, duration: c.origDuration, invalid });
        } else {
          const edge = c.mode === 'trim-start' ? 'start' : 'end';
          const origEdge = edge === 'start' ? c.origStart : c.origStart + c.origDuration;
          const snapped = snapValue(origEdge + dms, points, st.zoom);
          const to = clampMs(snapped.ms, c.range.min, c.range.max);
          c.lastTrimTo = to;
          const start = edge === 'start' ? to : c.origStart;
          const dur = edge === 'start' ? c.origStart + c.origDuration - to : to - c.origStart;
          setTrimUi({ clipId: c.clipId, trackId: c.sourceTrackId, start, duration: dur, invalid: false });
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const c = dragRef.current;
        dragRef.current = null;
        setMoveUi(null);
        setTrimUi(null);
        if (!c || !c.moved) return;
        const st = useEditor.getState();
        if (c.mode === 'move') {
          const { targetTrackId, start, invalid } = c.lastMove;
          // 겹침·비호환 위치는 드롭 시 원위치 (최종 방어는 engine)
          if (invalid) return;
          if (start === c.origStart && targetTrackId === c.sourceTrackId) return;
          void st.dispatch([
            {
              type: 'moveClip',
              clipId: c.clipId,
              start,
              ...(targetTrackId !== c.sourceTrackId ? { trackId: targetTrackId } : {}),
            },
          ]);
        } else {
          const edge = c.mode === 'trim-start' ? 'start' : 'end';
          const origEdge = edge === 'start' ? c.origStart : c.origStart + c.origDuration;
          if (c.lastTrimTo === origEdge) return;
          void st.dispatch([{ type: 'trimClip', clipId: c.clipId, edge, to: c.lastTrimTo }]);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [],
  );

  // ---------- 단축키 ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return;
      const st = useEditor.getState();
      const d = st.doc;
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (ctrl && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        if (!d || !st.selection.clipId) return;
        const found = findClip(d, st.selection.clipId);
        if (!found) return;
        const copy = structuredClone(found.clip) as Clip;
        copy.id = newId();
        if ('effects' in copy && copy.effects) {
          copy.effects = copy.effects.map((fx) => ({ ...fx, id: newId() }));
        }
        copy.start = findFreeStart(
          found.track.clips,
          found.clip.start + found.clip.duration,
          found.clip.duration,
        );
        void st.dispatch([{ type: 'addClip', trackId: found.track.id, clip: copy }]);
        st.select(copy.id);
        return;
      }
      if (ctrl) return;

      switch (e.code) {
        case 'Space': {
          e.preventDefault();
          useEditor.setState((s) => ({ playing: !s.playing }));
          break;
        }
        case 'KeyS': {
          if (!d || !st.selection.clipId) break;
          const found = findClip(d, st.selection.clipId);
          if (!found) break;
          const { clip } = found;
          const at = st.playheadMs;
          if (at > clip.start && at < clip.start + clip.duration) {
            // newClipId를 여기서 만들어야 낙관 적용·서버·다른 클라이언트가 같은 id를 갖는다 (C3)
            void st.dispatch([{ type: 'splitClip', clipId: clip.id, at, newClipId: newId() }]);
          }
          break;
        }
        case 'KeyF': {
          // 정지화면 — 재생헤드에서 선택된 video 클립을 나누고 1초짜리 정지 조각을 끼운다
          if (!d || !st.selection.clipId) break;
          const found = findClip(d, st.selection.clipId);
          if (!found || found.clip.kind !== 'video') {
            useEditor.setState({ notice: '정지화면은 영상 클립에서만 만들 수 있습니다.' });
            break;
          }
          const { clip } = found;
          const at = st.playheadMs;
          if (at <= clip.start || at >= clip.start + clip.duration) {
            useEditor.setState({ notice: '재생헤드를 클립 안에 두고 F 를 누르세요.' });
            break;
          }
          void st.dispatch([
            {
              type: 'freezeFrame',
              clipId: clip.id,
              at,
              duration: FREEZE_MS,
              // 낙관 적용·서버·다른 클라이언트가 같은 id를 갖게 여기서 만든다 (C3)
              newClipIds: [newId(), newId()],
            },
          ]);
          break;
        }
        case 'Delete': {
          if (!st.selection.clipId) break;
          const clipId = st.selection.clipId;
          st.select(null);
          void st.dispatch([{ type: 'removeClip', clipId }]);
          break;
        }
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const fps = d?.settings.fps ?? 30;
          const step = e.shiftKey ? 1000 : Math.max(1, Math.round(1000 / fps));
          const delta = e.code === 'ArrowLeft' ? -step : step;
          st.seek(clampMs(st.playheadMs + delta, 0, timelineDurationMs(d)));
          break;
        }
        default: {
          if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            zoomBy(1.25);
          } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            zoomBy(1 / 1.25);
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomBy]);

  // ---------- 트랙 추가 ----------

  const addTrack = (kind: Track['kind']) => {
    const d = useEditor.getState().doc;
    if (!d) return;
    const count = d.tracks.filter((t) => t.kind === kind).length;
    void dispatch([
      {
        type: 'addTrack',
        track: { id: newId(), kind, name: `${TRACK_KIND_LABEL[kind]} ${count + 1}` },
      },
    ]);
  };

  if (!doc) {
    return <div className="timeline timeline-empty">프로젝트를 불러오는 중…</div>;
  }

  return (
    <div className="timeline">
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" style={{ width: HEADER_WIDTH + laneWidth, minHeight: contentHeight }}>
          <div className="tl-row tl-ruler-row" style={{ height: RULER_HEIGHT }}>
            <div className="tl-header tl-corner" style={{ width: HEADER_WIDTH, height: RULER_HEIGHT }}>
              <button type="button" className="tl-btn" title="축소 (-)" onClick={() => zoomBy(1 / 1.25)}>
                −
              </button>
              <span className="tl-zoom-label">{Math.round(zoom)}px/s</span>
              <button type="button" className="tl-btn" title="확대 (+)" onClick={() => zoomBy(1.25)}>
                +
              </button>
            </div>
            <Ruler
              durationMs={durationMs}
              zoom={zoom}
              playheadMs={playheadMs}
              beats={beatMarkers}
              onSeek={seek}
            />
          </div>
          {displayTracks.map((track) => (
            <TimelineTrack
              key={track.id}
              track={track}
              zoom={zoom}
              laneWidth={laneWidth}
              assets={doc.assets}
              selectedClipId={selection.clipId}
              movingClipId={moveUi ? dragRef.current?.clipId ?? null : null}
              trimPreview={trimUi && trimUi.trackId === track.id ? trimUi : null}
              ghost={
                (moveUi && moveUi.targetTrackId === track.id
                  ? {
                      start: moveUi.start,
                      duration: moveUi.duration,
                      invalid: moveUi.invalid,
                      label: dragRef.current?.label ?? '',
                    }
                  : null) satisfies TrackGhost
              }
              onClipPointerDown={onClipPointerDown}
              onSelect={select}
            />
          ))}
          <div className="tl-row tl-addrow">
            <div className="tl-header tl-addtrack" style={{ width: HEADER_WIDTH }}>
              <span className="tl-addtrack-label">+ 트랙</span>
              {(['video', 'text', 'audio', 'overlay'] as const).map((kind) => (
                <button key={kind} type="button" className="tl-btn" onClick={() => addTrack(kind)}>
                  {TRACK_KIND_LABEL[kind]}
                </button>
              ))}
            </div>
          </div>
          {beatMarkers.map((ms) => (
            <div
              key={ms}
              className="tl-beat"
              style={{ left: HEADER_WIDTH + msToPx(ms, zoom), height: contentHeight }}
            />
          ))}
          <div
            className="tl-playhead"
            style={{
              left: HEADER_WIDTH + msToPx(playheadMs, zoom),
              height: contentHeight,
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default Timeline;
