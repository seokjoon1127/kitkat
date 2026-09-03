// 텍스트 클립 렌더 — **수치는 전부 text-layout.tsx 의 computeTextLayout 에서 온다.**
// 이 파일은 그 결과를 DOM 으로 옮기고 remotion 훅(프레임·해상도)을 붙이는 일만 한다.
// 빠른 미리보기(ui/preview/TextOverlay.tsx)도 같은 함수를 부른다 — 그래서 갈릴 수가 없다.
// + W8 F3-B 트랜스폼 모션 블러 · F3-C 전환 방향성 블러 · F8 키네틱 타이포(단위별 시차)
import React from 'react';
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TextClip } from '@kitkat/schema';
import { ensureGlyphFont } from './glyph-path.js';
import {
  activeTransitionBlurs,
  activeTransitionOverlays,
  activeTransitionStyles,
  type TransitionBlurSpec,
} from './transitions.js';
import { TransitionOverlayViews, TransitionWrappers } from './clips.js';
import { TransitionBlurDefs } from './svg-filters.js';
import { computeTextLayout, TextLayoutContent } from './text-layout.js';
import {
  TRANSFORM_BLUR_GROUP_STYLE,
  transformBlurLayerStyle,
  transformBlurOffsets,
} from './transform-blur.js';

/**
 * W8 F8 `drawStroke` — 글자 윤곽선은 **ttf 를 내려받아야** 나온다. 폰트가 오기 전에 그리면
 * 첫 프레임들이 대체 동작(하드 와이프)으로 나가므로, 렌더에서는 `delayRender` 로 막는다
 * (`TimelineVideo` 의 '번들 폰트 로딩' 과 같은 방식이고, 어떤 경우에도 반드시 풀린다).
 */
const useGlyphGate = (clip: TextClip): void => {
  const needed =
    clip.animationIn?.type === 'drawStroke' || clip.animationOut?.type === 'drawStroke';
  const [handle] = React.useState<number | null>(() =>
    needed ? delayRender('drawStroke 글리프 로딩') : null,
  );
  // **폰트가 온 뒤에 한 번 더 렌더해야 한다.** continueRender 는 «찍어도 된다»는 신호일 뿐
  // 다시 그리지 않는다 — 정지화면(renderStill)은 폰트가 오기 전의 첫 렌더(대체 와이프)를 그대로 찍었다.
  // 실제로 겪었다: 단위 테스트(노드)는 윤곽선을 그렸는데 Chromium 렌더는 전부 와이프였다.
  const [loaded, setLoaded] = React.useState(false);
  const doneRef = React.useRef(false);
  const styleRef = React.useRef(clip.style);
  styleRef.current = clip.style;
  React.useEffect(() => {
    if (handle === null) return;
    let alive = true;
    const t = setTimeout(() => {
      if (alive) setLoaded(true); // 어떤 이유로든 20초 안에는 반드시 풀린다
    }, 20000);
    ensureGlyphFont(styleRef.current).then(
      () => {
        if (alive) setLoaded(true);
      },
      () => {
        if (alive) setLoaded(true);
      },
    );
    return () => {
      alive = false;
      clearTimeout(t);
      if (!doneRef.current) {
        doneRef.current = true;
        continueRender(handle); // 언마운트되면 잡고 있던 렌더를 풀어 준다
      }
    };
  }, [handle]);
  // 폰트가 반영된 렌더가 «커밋된 다음» 에 푼다 — 이 effect 는 그 커밋 뒤에 돈다.
  React.useEffect(() => {
    if (handle === null || !loaded || doneRef.current) return;
    doneRef.current = true;
    continueRender(handle);
  }, [handle, loaded]);
};

export const TextClipView: React.FC<{ clip: TextClip }> = ({ clip }) => {
  const frame = useCurrentFrame();
  const { fps, width: canvasW, height: canvasH } = useVideoConfig();
  const tMs = (frame / fps) * 1000;
  useGlyphGate(clip);

  const transitionStyles = activeTransitionStyles(tMs, clip.duration, clip.transitionIn, clip.transitionOut);
  const transitionBlurs = activeTransitionBlurs(
    tMs,
    clip.duration,
    clip.id,
    canvasH / 1080,
    clip.transitionIn,
    clip.transitionOut,
  );
  const transitionOverlayList = activeTransitionOverlays(
    tMs,
    clip.duration,
    clip.transitionIn,
    clip.transitionOut,
  );

  // W8 F3-B — 글자가 날아 들어올 때 블러가 걸리는 게 「비싸 보이는」 이유다.
  // 빈 배열이면(블러 꺼짐) 한 장만 그린다 = 기존 렌더 결과와 같다.
  // 글자 «내용»(타자기 글자 수·강조 단어)은 언제나 가운데 시각 것이다 — 유령 글자가 겹치면 안 된다.
  const offsets = transformBlurOffsets(clip.transformBlur, fps);
  const times = offsets.length > 0 ? offsets.map((o) => tMs + o) : [tMs];

  const layer = (t: number): React.ReactNode => {
    const layout = computeTextLayout({ clip, tMs: t, canvasW, canvasH, contentTMs: tMs });
    return (
      <div style={layout.outerStyle}>
        <div style={layout.boxStyle}>
          <TransitionWrappers styles={layout.wrapperStyles}>
            <TextLayoutContent layout={layout} highlightColor={clip.highlightColor} />
          </TransitionWrappers>
        </div>
      </div>
    );
  };

  const stack =
    offsets.length > 0 ? (
      <div style={TRANSFORM_BLUR_GROUP_STYLE}>
        {times.map((t, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              ...transformBlurLayerStyle(times.length),
            }}
          >
            {layer(t)}
          </div>
        ))}
      </div>
    ) : (
      layer(tMs)
    );

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <TransitionBlurDefs blurs={transitionBlurs.filter((b): b is TransitionBlurSpec => b !== null)} />
      <TransitionWrappers styles={transitionStyles} blurs={transitionBlurs}>
        {stack}
      </TransitionWrappers>
      <TransitionOverlayViews overlays={transitionOverlayList} />
    </AbsoluteFill>
  );
};
