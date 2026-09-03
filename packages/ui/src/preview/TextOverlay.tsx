// 프리뷰 v2 — 텍스트 레이어. 캔버스(WebGL) 위에 **DOM 으로** 얹는다.
//
// **수치는 하나도 여기서 만들지 않는다.** 렌더러와 «같은» `computeTextLayout` 을 부르고
// 그 결과를 `TextLayoutContent` 로 그린다 — remotion 훅만 props(tMs)로 바뀐 셈이다.
// (전에는 이 파일에 textCss·easeOutBack·animStyle 사본이 있었고, 렌더에만 있는
//  `paintOrder:'stroke fill'` 때문에 두꺼운 외곽선 자막이 미리보기에서 뭉개졌다.
//  `style.fontSize` 같은 키프레임도 여기서는 아예 안 먹었다. 둘 다 사라졌다.)
// (React 를 이름으로 들여온다 — 검증 스크립트가 이 파일을 «고전 JSX 변환»으로 돌려
//  렌더러 출력과 픽셀 대조하기 때문이다. 앱 번들은 자동 변환이라 이 import 가 남아도 무해하다.)
import React, { useEffect, useState } from 'react';
import type { TextClip } from '@kitkat/schema';
import {
  activeTransitionOverlays,
  activeTransitionStyles,
  computeTextLayout,
  fontLoadSpecs,
  TextLayoutContent,
} from '@kitkat/renderer/composition';
import type { CSSProperties, ReactNode } from 'react';

const Wrappers = ({ styles, children }: { styles: CSSProperties[]; children: ReactNode }) => {
  let node: ReactNode = children;
  for (let i = styles.length - 1; i >= 0; i--) {
    node = <div style={{ width: '100%', height: '100%', ...styles[i] }}>{node}</div>;
  }
  return <>{node}</>;
};

// ── 폰트 게이트 ───────────────────────────────────────────────────────────
//
// 줄 나누기를 우리가 계산하므로(F8) **폰트가 오기 전에 재면 폴백 글꼴의 폭으로 재고
// 그 줄바꿈이 그대로 남는다.** 렌더는 `delayRender('번들 폰트 로딩')` 이 이미 막아 주지만
// 빠른 미리보기에는 게이트가 없었다. 준비 전에는 **안 그리고 기다린다** —
// 폴백 글꼴로 잠깐 그렸다가 바꾸면 첫 0.3초가 렌더와 다른 그림이 되고, 그게 정확히
// W6 에서 문제가 된 종류의 어긋남이다.

const loaded = new Map<string, Promise<void>>();

function loadFamily(family: string): Promise<void> {
  const hit = loaded.get(family);
  if (hit) return hit;
  const fonts = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
  const p = fonts
    ? Promise.all(fontLoadSpecs([family]).map((s) => fonts.load(s).catch(() => [])))
        .then(() => fonts.ready.catch(() => undefined))
        .then(() => undefined)
    : Promise.resolve();
  loaded.set(family, p);
  return p;
}

const hasFontApi = (): boolean =>
  (globalThis as { document?: { fonts?: unknown } }).document?.fonts !== undefined;

function useFontReady(family: string): boolean {
  // 폰트 API 가 없는 환경(SSR·검증 스크립트)에서는 게이트가 «없다» — 기다릴 대상이 없다.
  const [ready, setReady] = useState(() => !hasFontApi());
  useEffect(() => {
    let alive = true;
    if (!hasFontApi()) return;
    setReady(false);
    loadFamily(family).then(
      () => {
        if (alive) setReady(true);
      },
      () => {
        if (alive) setReady(true); // 폰트가 없어도(404) 미리보기를 영원히 막지 않는다
      },
    );
    return () => {
      alive = false;
    };
  }, [family]);
  return ready;
}

/** 텍스트 클립 한 개. tMs = 클립 시작 기준 ms, canvasW/H = 표시 중인 캔버스의 CSS px. */
export const TextClipOverlay = ({
  clip,
  tMs,
  canvasW,
  canvasH,
}: {
  clip: TextClip;
  tMs: number;
  canvasW: number;
  canvasH: number;
}) => {
  const fontReady = useFontReady(clip.style.fontFamily);

  const transitionStyles = activeTransitionStyles(
    tMs,
    clip.duration,
    clip.transitionIn,
    clip.transitionOut,
  );
  const transitionOverlayList = activeTransitionOverlays(
    tMs,
    clip.duration,
    clip.transitionIn,
    clip.transitionOut,
  );

  if (!fontReady) return null;
  const layout = computeTextLayout({ clip, tMs, canvasW, canvasH });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Wrappers styles={transitionStyles as CSSProperties[]}>
        <div style={layout.outerStyle}>
          <div style={layout.boxStyle}>
            <Wrappers styles={layout.wrapperStyles}>
              <TextLayoutContent layout={layout} highlightColor={clip.highlightColor} />
            </Wrappers>
          </div>
        </div>
      </Wrappers>
      {transitionOverlayList.map((o) => (
        <div key={o.key} style={o.style} />
      ))}
    </div>
  );
};
