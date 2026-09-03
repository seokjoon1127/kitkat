// Remotion 번들 엔트리: 'timeline' 컴포지션 등록 (calculateMetadata로 doc 기반 크기/길이 결정)
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { ProjectDoc } from '@kitkat/schema';
import { TimelineVideo, type TimelineVideoProps } from './composition/TimelineVideo.js';
import { docDurationMs, msToFrames } from './composition/keyframes.js';

const defaultDoc: ProjectDoc = {
  schemaVersion: 1,
  id: 'default',
  name: '빈 프로젝트',
  revision: 0,
  settings: {
    width: 1080,
    height: 1920,
    fps: 30,
    background: { kind: 'color', color: '#000000' },
  },
  assets: {},
  tracks: [],
};

const defaultProps: TimelineVideoProps = { doc: defaultDoc, mediaBase: '', proxy: false };

const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="timeline"
      component={TimelineVideo}
      durationInFrames={30}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => {
        const { fps, width, height } = props.doc.settings;
        return {
          durationInFrames: Math.max(1, msToFrames(docDurationMs(props.doc), fps)),
          fps,
          width,
          height,
        };
      }}
    />
  );
};

registerRoot(RemotionRoot);
