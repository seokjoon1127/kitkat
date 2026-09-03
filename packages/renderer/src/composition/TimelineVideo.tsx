// 타임라인 컴포지션 루트: 트랙 순서(배열 0 = 아래)대로 렌더, hidden 스킵 (C4)
import React from 'react';
import { AbsoluteFill, Sequence, continueRender, delayRender, useVideoConfig } from 'remotion';
import type { ProjectDoc } from '@kitkat/schema';
import { msToFrames } from './keyframes.js';
import { AudioClipView, VisualClipView } from './clips.js';
import { TextClipView } from './text.js';
import { BackgroundView } from './background.js';
import { ensureFontsLoaded, fontFaceCss } from './fonts.js';

export type TimelineVideoProps = {
  doc: ProjectDoc;
  mediaBase: string;
  proxy: boolean;
  /** 알파 내보내기(MOV/ProRes 4444) — 배경을 그리지 않아 빈 곳이 투명하게 남는다 (X5-c). */
  transparent?: boolean;
};

/**
 * 번들 폰트(@font-face)를 주입하고, 첫 프레임에서 글꼴이 빠지지 않게 로딩을 기다린다 (T2).
 * 폰트가 없어도 delayRender 는 반드시 풀린다 — 렌더가 멈추지 않는다.
 */
const FontFaces: React.FC<{ doc: ProjectDoc; mediaBase: string }> = ({ doc, mediaBase }) => {
  const [handle] = React.useState(() => delayRender('번들 폰트 로딩'));
  const done = React.useRef(false);
  const docRef = React.useRef(doc);
  docRef.current = doc;
  React.useEffect(() => {
    const finish = (): void => {
      if (done.current) return;
      done.current = true;
      continueRender(handle);
    };
    ensureFontsLoaded(docRef.current).then(finish, finish);
    // 어떤 이유로든 폰트 로딩이 끝나지 않아도 렌더를 막지 않는다(폰트 파일이 없을 때 포함)
    const t = setTimeout(finish, 20000);
    return () => {
      clearTimeout(t);
      finish();
    };
  }, [handle]);
  return <style dangerouslySetInnerHTML={{ __html: fontFaceCss(mediaBase) }} />;
};

export const TimelineVideo: React.FC<TimelineVideoProps> = ({ doc, mediaBase, proxy, transparent }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={transparent ? {} : { backgroundColor: '#000000' }}>
      <FontFaces doc={doc} mediaBase={mediaBase} />
      {transparent ? null : <BackgroundView doc={doc} mediaBase={mediaBase} proxy={proxy} />}
      {doc.tracks.map((track) => {
        if (track.hidden) return null;
        return (
          <React.Fragment key={track.id}>
            {track.clips.map((clip) => {
              const from = msToFrames(clip.start, fps);
              const dur = Math.max(1, msToFrames(clip.duration, fps));
              let child: React.ReactNode = null;
              if (clip.kind === 'audio') {
                child = (
                  <AudioClipView
                    clip={clip}
                    track={track}
                    asset={doc.assets[clip.assetId]}
                    mediaBase={mediaBase}
                  />
                );
              } else if (clip.kind === 'text') {
                child = <TextClipView clip={clip} />;
              } else {
                child = (
                  <VisualClipView
                    clip={clip}
                    track={track}
                    asset={doc.assets[clip.assetId]}
                    mediaBase={mediaBase}
                    proxy={proxy}
                  />
                );
              }
              return (
                <Sequence key={clip.id} from={from} durationInFrames={dur}>
                  {child}
                </Sequence>
              );
            })}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
