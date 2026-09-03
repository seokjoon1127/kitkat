// 인스펙터 패널: 선택된 클립(또는 프로젝트)의 속성 편집 — C7 useEditor만 소비
import { findClip } from '@kitkat/engine';
import { useEditor } from '../state.js';
import '../inspector.css';
import { CommonSection } from './sections/CommonSection.js';
import { VideoSection } from './sections/VideoSection.js';
import { ImageSection } from './sections/ImageSection.js';
import { AudioSection } from './sections/AudioSection.js';
import { TextSection } from './sections/TextSection.js';
import { EffectsSection } from './sections/EffectsSection.js';
import { TransitionSection } from './sections/TransitionSection.js';
import { KeyframesSection } from './sections/KeyframesSection.js';
import { ProjectSection } from './sections/ProjectSection.js';
import { CurvesSection } from './sections/CurvesSection.js';
import { SourceSection } from './sections/SourceSection.js';
import { SpeedRampSection } from './sections/SpeedRampSection.js';
import { TemplatesSection } from './sections/TemplatesSection.js';
import { KeyframeProvider } from './sections/keyframe-dot.js';

const KIND_LABELS = {
  video: '비디오 클립',
  image: '이미지 클립',
  audio: '오디오 클립',
  text: '텍스트 클립',
} as const;

export function Inspector() {
  const doc = useEditor((s) => s.doc);
  const clipId = useEditor((s) => s.selection.clipId);
  const playheadMs = useEditor((s) => s.playheadMs);
  const dispatch = useEditor((s) => s.dispatch);

  if (!doc) {
    return (
      <aside className="inspector">
        <header className="insp-header">인스펙터</header>
        <p className="insp-empty">프로젝트를 불러오는 중…</p>
      </aside>
    );
  }

  const found = clipId ? findClip(doc, clipId) : null;

  if (!found) {
    return (
      <aside className="inspector">
        <header className="insp-header">프로젝트</header>
        <div className="insp-scroll">
          <ProjectSection doc={doc} dispatch={dispatch} />
        </div>
      </aside>
    );
  }

  const clip = found.clip;
  const patch = (p: Record<string, unknown>) => {
    void dispatch([{ type: 'updateClip', clipId: clip.id, patch: p }]);
  };

  // 배치 순서 (계획 X3-A):
  //  video: 기본 → 비디오 → 원본 보정 → 속도 램프 → 커브 → 효과 → 전환 → 키프레임
  //  text : 기본 → 텍스트 → 템플릿 → 커브 → 효과 → 전환 → 키프레임
  //  audio: 기본 → 오디오 → 원본 보정 → 키프레임
  // 키프레임 버튼(◆)이 쓰는 클립·재생헤드·dispatch 를 여기서 한 번만 내려보낸다 (W8 F13).
  // 이게 없으면 MaskFields 안쪽 슬라이더까지 prop 3개를 실어 날라야 한다.
  return (
    <aside className="inspector">
      <header className="insp-header">{KIND_LABELS[clip.kind]}</header>
      <KeyframeProvider value={{ clip, playheadMs, dispatch }}>
      <div className="insp-scroll">
        <CommonSection clip={clip} patch={patch} playheadMs={playheadMs} dispatch={dispatch} />
        {clip.kind === 'video' ? (
          <>
            <VideoSection clip={clip} patch={patch} dispatch={dispatch} />
            <SourceSection clip={clip} assets={doc.assets} patch={patch} />
            <SpeedRampSection clip={clip} dispatch={dispatch} />
          </>
        ) : null}
        {clip.kind === 'image' ? <ImageSection clip={clip} patch={patch} /> : null}
        {clip.kind === 'audio' ? (
          <>
            <AudioSection clip={clip} patch={patch} />
            <SourceSection clip={clip} assets={doc.assets} patch={patch} />
          </>
        ) : null}
        {clip.kind === 'text' ? (
          <>
            <TextSection clip={clip} patch={patch} />
            <TemplatesSection clip={clip} dispatch={dispatch} />
          </>
        ) : null}
        {clip.kind !== 'audio' ? (
          <>
            {/* key: 클립을 바꾸면 커브 편집 로컬 상태를 새로 시작한다 */}
            <CurvesSection key={clip.id} curves={clip.curves} patch={patch} />
            <EffectsSection effects={clip.effects} patch={patch} />
            <TransitionSection
              transitionIn={clip.transitionIn}
              transitionOut={clip.transitionOut}
              transformBlur={clip.transformBlur}
              patch={patch}
            />
          </>
        ) : null}
        <KeyframesSection clip={clip} playheadMs={playheadMs} dispatch={dispatch} />
      </div>
      </KeyframeProvider>
    </aside>
  );
}

export default Inspector;
