// 오버레이 효과 3종: grain(프레임마다 달라지는 필름 그레인) · scanlines · lightLeak.
// 클립 상자(box) 안, 미디어 위에 얹는다 — 크롭/트랜스폼을 그대로 따라간다.
import React from 'react';
import { useCurrentFrame } from 'remotion';
import type { VisualOverlay } from '../layout/index.js';
import {
  crtPhosphorCss,
  filmScratchLines,
  grainSeed,
  lightLeakCss,
  mosaicGroutCss,
  scanlinesCss,
  tiltShiftMaskCss,
  vhsBandCss,
} from './effects.js';

const num = (v: number | string | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const FULL: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' };

/**
 * feTurbulence 로 만든 흑백 노이즈를 overlay 블렌드로 얹는다.
 * seed 가 프레임마다 바뀌므로 그레인이 실제로 매 프레임 다르다 (정지 텍스처가 아니다).
 */
const GrainOverlay: React.FC<{ id: string; amount: number }> = ({ id, amount }) => {
  const frame = useCurrentFrame();
  const fid = `${id}-turb`;
  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        mixBlendMode: 'overlay',
        opacity: amount * 0.6,
      }}
    >
      <defs>
        <filter id={fid} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves={1}
            seed={grainSeed(frame)}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
          {/* 알파 노이즈를 없애 균일한 회색 노이즈로 만든다 */}
          <feComponentTransfer>
            <feFuncA type="linear" slope="0" intercept="1" />
          </feComponentTransfer>
        </filter>
      </defs>
      <rect width="100%" height="100%" filter={`url(#${fid})`} />
    </svg>
  );
};

/**
 * 먼지·티끌 — 난류를 **문턱 위에서만** 남긴다(discrete 로 0/1 로 자른다) → 균일한 그레인이
 * 아니라 «드문드문 큰 점». 프레임마다 seed 가 바뀌어 실제로 튄다.
 */
const DustOverlay: React.FC<{ id: string; amount: number; density: number }> = ({
  id, amount, density,
}) => {
  const frame = useCurrentFrame();
  const fid = `${id}-dust`;
  // density 가 높을수록 문턱이 낮아져 점이 많아진다 (0.86 ~ 0.62)
  const cut = 0.86 - density * 0.24;
  return (
    <svg style={{ ...FULL, width: '100%', height: '100%', mixBlendMode: 'screen', opacity: amount }}>
      <defs>
        <filter id={fid} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.32"
            numOctaves={2}
            seed={grainSeed(frame)}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="linear" slope={12} intercept={-12 * cut} />
            <feFuncG type="linear" slope={12} intercept={-12 * cut} />
            <feFuncB type="linear" slope={12} intercept={-12 * cut} />
            <feFuncA type="linear" slope="0" intercept="1" />
          </feComponentTransfer>
        </filter>
      </defs>
      <rect width="100%" height="100%" filter={`url(#${fid})`} />
    </svg>
  );
};

/** 필름 스크래치 — 세로 흠집 몇 줄. 자리는 프레임마다 바뀌지만 같은 프레임이면 항상 같다. */
const FilmScratchOverlay: React.FC<{ amount: number; count: number }> = ({ amount, count }) => {
  const frame = useCurrentFrame();
  const lines = filmScratchLines(frame, count, amount);
  if (lines.length === 0) return null;
  return (
    <div style={{ ...FULL, mixBlendMode: 'screen' }}>
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${l.leftPct}%`,
            width: `${l.widthPx}px`,
            opacity: l.opacity,
            background:
              'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.9) 18%, ' +
              'rgba(255,255,255,0.55) 62%, rgba(255,255,255,0) 100%)',
          }}
        />
      ))}
    </div>
  );
};

/** VHS — 색 띠(screen) + 굵은 스캔라인(multiply)을 한 묶음으로 얹는다. */
const VhsOverlay: React.FC<{ amount: number }> = ({ amount }) => (
  <>
    <div style={{ ...FULL, mixBlendMode: 'screen', background: vhsBandCss(amount) }} />
    <div
      style={{
        ...FULL,
        mixBlendMode: 'multiply',
        opacity: amount * 0.5,
        background: scanlinesCss(0.55, 4),
      }}
    />
  </>
);

/** CRT — 가로 스캔라인 + 세로 RGB 인광체 + 모서리가 어두워지는 튜브. */
const CrtOverlay: React.FC<{ amount: number; period: number }> = ({ amount, period }) => (
  <>
    <div
      style={{ ...FULL, mixBlendMode: 'multiply', background: scanlinesCss(amount * 0.8, period) }}
    />
    <div
      style={{
        ...FULL,
        mixBlendMode: 'multiply',
        opacity: amount * 0.6,
        background: crtPhosphorCss(1),
      }}
    />
    <div
      style={{
        ...FULL,
        opacity: amount,
        background:
          'radial-gradient(ellipse 78% 74% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.75) 100%)',
      }}
    />
  </>
);

export const EffectOverlayViews: React.FC<{ idBase: string; overlays: VisualOverlay[] }> = ({
  idBase,
  overlays,
}) => {
  if (overlays.length === 0) return null;
  return (
    <>
      {overlays.map((o, i) => {
        const key = `${idBase}-ov${i}`;
        if (o.kind === 'grain') {
          return <GrainOverlay key={key} id={key} amount={num(o.params.amount, 0.3)} />;
        }
        if (o.kind === 'scanlines') {
          return (
            <div
              key={key}
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                mixBlendMode: 'multiply',
                background: scanlinesCss(num(o.params.amount, 0.3), num(o.params.period, 2)),
              }}
            />
          );
        }
        if (o.kind === 'lightLeak') {
          return (
            <div
              key={key}
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                mixBlendMode: 'screen',
                background: lightLeakCss(num(o.params.amount, 0.4), num(o.params.hue, 30)),
              }}
            />
          );
        }
        // ── W8 F16 신규 ──
        if (o.kind === 'tiltShift') {
          // **backdrop-filter** — 이 레이어 «뒤에 있는 것»을 흐린다. 오버레이 div 로 미디어를
          // 실제로 건드릴 수 있는 유일한 수단이라, 위·아래만 흐린 틸트 시프트가 이걸로 된다.
          const mask = tiltShiftMaskCss(num(o.params.band, 0.35), num(o.params.center, 0.5));
          return (
            <div
              key={key}
              style={{
                ...FULL,
                backdropFilter: `blur(${num(o.params.px, 14)}px)`,
                WebkitBackdropFilter: `blur(${num(o.params.px, 14)}px)`,
                WebkitMaskImage: mask,
                maskImage: mask,
              }}
            />
          );
        }
        if (o.kind === 'dust') {
          return (
            <DustOverlay
              key={key}
              id={key}
              amount={num(o.params.amount, 0.4)}
              density={num(o.params.density, 0.5)}
            />
          );
        }
        if (o.kind === 'vhs') {
          return <VhsOverlay key={key} amount={num(o.params.amount, 0.6)} />;
        }
        if (o.kind === 'filmScratch') {
          return (
            <FilmScratchOverlay
              key={key}
              amount={num(o.params.amount, 0.5)}
              count={num(o.params.count, 4)}
            />
          );
        }
        if (o.kind === 'crt') {
          return (
            <CrtOverlay
              key={key}
              amount={num(o.params.amount, 0.6)}
              period={num(o.params.period, 2)}
            />
          );
        }
        if (o.kind === 'mosaicGrout') {
          return (
            <div
              key={key}
              style={{
                ...FULL,
                mixBlendMode: 'multiply',
                background: mosaicGroutCss(num(o.params.size, 28), num(o.params.grout, 0.12)),
              }}
            />
          );
        }
        return null;
      })}
    </>
  );
};
