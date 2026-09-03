// 미리보기 플레이어 — 렌더와 동일한 TimelineVideo 컴포지션을 @remotion/player로 재생 (WYSIWYG, 프록시)
// W5: previewEngine === 'fast' 면 프리뷰 엔진 v2(<FastPreview>)로 바꿔 그린다.
// **기본값은 'remotion' 이고, 그 경로의 동작·성능은 v1 과 똑같아야 한다.**
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { TimelineVideo, docDurationMs, msToFrames } from '@kitkat/renderer/composition';
import { useEditor } from '../state.js';
import { FastPreview } from '../preview/FastPreview.js';
import { ScopesPanel } from './ScopesPanel.js';
import { MaskPenOverlay } from './sections/MaskEditor.js';

function fmtMs(ms: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const t = Math.floor((total % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${t}`;
}

export function PlayerPane() {
  const doc = useEditor((s) => s.doc);
  const playing = useEditor((s) => s.playing);
  const playheadMs = useEditor((s) => s.playheadMs);
  const seek = useEditor((s) => s.seek);
  const previewEngine = useEditor((s) => s.previewEngine);
  const playerRef = useRef<PlayerRef>(null);
  const [glNotice, setGlNotice] = useState<string | null>(null);
  const [glFailed, setGlFailed] = useState(false);

  const fps = doc?.settings.fps ?? 30;
  const durationMs = doc ? docDurationMs(doc) : 1000;
  const hasDoc = doc !== null;
  // WebGL 초기화가 실패하면 자동으로 기준선(Remotion)으로 되돌린다
  const fast = previewEngine === 'fast' && !glFailed;

  const onGlFailure = useCallback((message: string) => {
    setGlFailed(true);
    setGlNotice(message);
  }, []);

  // 프리뷰 엔진을 다시 'fast' 로 켜면 한 번 더 시도하게 한다
  useEffect(() => {
    if (previewEngine === 'fast') return;
    setGlFailed(false);
    setGlNotice(null);
  }, [previewEngine]);

  // 플레이어 이벤트 → 상태 (재생 중 재생헤드 동기화, play/pause 반영)
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => {
      seek((e.detail.frame * 1000) / fps);
    };
    const onPlay = () => useEditor.setState({ playing: true });
    const onPause = () => useEditor.setState({ playing: false });
    const onEnded = () => useEditor.setState({ playing: false });
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    p.addEventListener('ended', onEnded);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
      p.removeEventListener('ended', onEnded);
    };
  }, [hasDoc, fps, seek, fast]);

  // 상태 → 플레이어 (타임라인에서 seek 등 외부 변경 시)
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const frame = msToFrames(playheadMs, fps);
    if (frame !== p.getCurrentFrame()) p.seekTo(frame);
  }, [playheadMs, fps, hasDoc]);

  // 상태 → 플레이어 (Space 등 외부에서 playing 이 바뀐 경우)
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    if (playing && !p.isPlaying()) p.play();
    else if (!playing && p.isPlaying()) p.pause();
  }, [playing, hasDoc]);

  if (!doc) {
    return <div className="player-pane player-empty">프로젝트 불러오는 중…</div>;
  }

  const togglePlay = (e: MouseEvent) => {
    if (fast) {
      useEditor.setState({ playing: !playing });
      return;
    }
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play(e); // 클릭 제스처를 넘겨 자동재생 제한 회피
  };

  const stepFrame = (dir: 1 | -1) => {
    if (fast) useEditor.setState({ playing: false });
    else playerRef.current?.pause();
    const frameMs = 1000 / fps;
    seek(Math.min(durationMs, Math.max(0, playheadMs + dir * frameMs)));
  };

  return (
    <div className="player-pane">
      {/* position:relative — 펜 툴 오버레이(MaskPenOverlay)가 이 상자를 기준으로 붙는다 */}
      <div className="player-stage" style={{ position: 'relative' }}>
        {fast ? (
          <FastPreview onGlFailure={onGlFailure} />
        ) : (
          <Player
            ref={playerRef}
            component={TimelineVideo}
            inputProps={{ doc, mediaBase: '/media', proxy: true }}
            durationInFrames={Math.max(1, msToFrames(durationMs, fps))}
            compositionWidth={doc.settings.width}
            compositionHeight={doc.settings.height}
            fps={fps}
            clickToPlay={false}
            spaceKeyToPlayOrPause={false}
            acknowledgeRemotionLicense
            style={{ width: '100%', height: '100%' }}
          />
        )}
        {/* W8 F9 — 펜 툴은 «재생 화면과 같은 상자» 위에 얹힌다. 마스크를 안 그리는 동안에는 null. */}
        <MaskPenOverlay />
      </div>
      {glNotice ? (
        <div
          style={{
            padding: '4px 12px',
            fontSize: 12,
            color: '#ffd45e',
            textAlign: 'center',
          }}
        >
          {glNotice}
        </div>
      ) : null}
      <div className="player-controls">
        <button className="btn icon-btn" title="이전 프레임 (←)" onClick={() => stepFrame(-1)}>
          ⟨
        </button>
        <button className="btn play-btn" title="재생/일시정지 (Space)" onClick={togglePlay}>
          {playing ? '일시정지' : '재생'}
        </button>
        <button className="btn icon-btn" title="다음 프레임 (→)" onClick={() => stepFrame(1)}>
          ⟩
        </button>
        <span className="player-time">
          {fmtMs(playheadMs)} <span className="dim">/ {fmtMs(durationMs)}</span>
        </span>
        {fast ? <span className="dim" style={{ fontSize: 11 }}>빠른 미리보기(실험)</span> : null}
      </div>
      {/* F6 — 플레이어 아래 접이식 스코프 패널 (실시간 + 정밀) */}
      <ScopesPanel />
    </div>
  );
}
