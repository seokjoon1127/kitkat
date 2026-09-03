// 배경: color / blur(맨 아래 시각 클립 확대+블러) / image
import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  getRemotionEnvironment,
  useVideoConfig,
} from 'remotion';
import type { ImageClip, ProjectDoc, VideoClip } from '@kitkat/schema';
import { msToFrames } from './keyframes.js';
import { resolveMediaWindow } from './media-src.js';
import { mediaTrimFrames } from './ramp.js';

/** 맨 아래(배열 앞) 트랙부터 시각(video/image) 클립들을 찾는다. */
function bottomVisualClips(doc: ProjectDoc): { clips: (VideoClip | ImageClip)[] } {
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    if (track.kind !== 'video' && track.kind !== 'overlay') continue;
    const clips = track.clips.filter(
      (c): c is VideoClip | ImageClip => c.kind === 'video' || c.kind === 'image',
    );
    if (clips.length > 0) return { clips };
  }
  return { clips: [] };
}

export const BackgroundView: React.FC<{
  doc: ProjectDoc;
  mediaBase: string;
  proxy: boolean;
}> = ({ doc, mediaBase, proxy }) => {
  const { fps } = useVideoConfig();
  const { isRendering } = getRemotionEnvironment();
  const bg = doc.settings.background;

  if (bg.kind === 'color') {
    return <AbsoluteFill style={{ backgroundColor: bg.color }} />;
  }

  if (bg.kind === 'image') {
    const asset = doc.assets[bg.assetId];
    if (!asset) return <AbsoluteFill style={{ backgroundColor: '#000000' }} />;
    return (
      <AbsoluteFill style={{ backgroundColor: '#000000' }}>
        <Img
          src={`${mediaBase}/${asset.src}`}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </AbsoluteFill>
    );
  }

  // blur: 맨 아래 시각 클립을 cover로 확대 + 블러해 여백을 채운다
  const { clips } = bottomVisualClips(doc);
  const blurPx = bg.amount;
  const cover: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: 'scale(1.15)',
    filter: `blur(${blurPx}px)`,
  };
  return (
    <AbsoluteFill style={{ backgroundColor: '#000000', overflow: 'hidden' }}>
      {clips.map((clip) => {
        const asset = doc.assets[clip.assetId];
        if (!asset) return null;
        const from = msToFrames(clip.start, fps);
        const dur = Math.max(1, msToFrames(clip.duration, fps));
        if (clip.kind === 'image') {
          return (
            <Sequence key={`bg-${clip.id}`} from={from} durationInFrames={dur}>
              <Img src={`${mediaBase}/${asset.src}`} style={cover} />
            </Sequence>
          );
        }
        // 본 클립(clips.tsx)과 동일하게: reversed 미러링 + 렌더 시 playbackRate 클램프 해제
        const { src, inMs, outMs } = resolveMediaWindow(clip, asset, mediaBase, proxy);
        return (
          <Sequence key={`bg-${clip.id}`} from={from} durationInFrames={dur}>
            <OffthreadVideo
              src={src}
              {...mediaTrimFrames(inMs, outMs, clip.duration, fps)}
              playbackRate={isRendering ? clip.speed : Math.min(16, clip.speed)}
              muted
              style={cover}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
