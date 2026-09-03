// EFFECT_TYPES 50종 → CSS filter / SVG 필터 스테이지 / 오버레이 (순수 로직)
//
// **목록의 원천은 `@kitkat/schema` 의 catalog.ts 다.** 카탈로그가 `impl:'css'` 라고 적은 효과는
// effectsToFilter 가, `'svg'` 는 effectSvgStages 가, `'overlay'` 는 effectOverlays 가 뭔가를
// 돌려줘야 한다 — 아니면 catalog-impl.test.ts 가 실패한다. `impl:'webgl'`(대기)은 반대로
// **세 곳 모두 아무것도 돌려주면 안 된다**(반쯤 그려지는 것이 제일 헷갈린다).
import type { Effect } from '@kitkat/schema';
import {
  bleachBypassMatrix,
  bleachBypassTable,
  crossProcessTables,
  duotoneMatrix,
  edgeKernel,
  fadedMatrix,
  fadedTable,
  gammaTable,
  highlightsTable,
  hslRgb,
  n4,
  pixelateSpec,
  posterizeLevels,
  shadowsTable,
  tealOrangeTables,
  temperatureMatrix,
  thresholdTransferSteep,
  tintMatrix,
  waveSpec,
  whiteBalanceMatrix,
  type ChromaKeyParams,
} from './svg-data.js';

const SATURATE_0 = '0.213 0.715 0.072 0 0 0.213 0.715 0.072 0 0 0.213 0.715 0.072 0 0 0 0 0 1 0';

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 효과 배열 → CSS filter 문자열. vignette는 CSS filter가 아니므로 제외
 * (vignetteAmount + 오버레이로 처리). 효과 없음이면 빈 문자열.
 * SVG 필터/오버레이로 처리하는 W5 효과(temperature·tint·highlights·shadows·sharpen·
 * glow·chromaShift·grain·scanlines·lightLeak)도 여기서는 빠진다.
 */
export function effectsToFilter(effects?: Effect[]): string {
  if (!effects || effects.length === 0) return '';
  const parts: string[] = [];
  for (const e of effects) {
    const p = e.params ?? {};
    switch (e.type) {
      case 'brightness':
        parts.push(`brightness(${num(p.amount, 1)})`);
        break;
      case 'contrast':
        parts.push(`contrast(${num(p.amount, 1)})`);
        break;
      case 'saturation':
        parts.push(`saturate(${num(p.amount, 1)})`);
        break;
      case 'hue':
        parts.push(`hue-rotate(${num(p.deg, 0)}deg)`);
        break;
      case 'blur':
        parts.push(`blur(${num(p.px, 0)}px)`);
        break;
      case 'grayscale':
        parts.push(`grayscale(${clamp01(num(p.amount, 1))})`);
        break;
      case 'sepia':
        parts.push(`sepia(${clamp01(num(p.amount, 1))})`);
        break;
      case 'invert':
        parts.push(`invert(${clamp01(num(p.amount, 1))})`);
        break;
      // 노출은 선형 배율이므로 CSS brightness(2^stops) 로 정확히 표현된다 (X5-b)
      case 'exposure':
        parts.push(`brightness(${n4(Math.pow(2, Math.min(2, Math.max(-2, num(p.stops, 0)))))})`);
        break;
      case 'vignette':
        break;
    }
  }
  return parts.join(' ');
}

/** 비네트 강도 0..1 (마지막 vignette 효과 기준, 없으면 0). */
export function vignetteAmount(effects?: Effect[]): number {
  if (!effects || effects.length === 0) return 0;
  let amount = 0;
  for (const e of effects) {
    if (e.type === 'vignette') amount = clamp01(num(e.params?.amount, 0.5));
  }
  return amount;
}

// ── SVG 필터 스테이지 (하나의 <filter> 안에 순서대로 이어 붙는다) ─────────────

export type SvgStageData =
  | { kind: 'curves'; data: { r: number[]; g: number[]; b: number[] } }
  | { kind: 'colorMatrix'; data: { values: string } }
  | { kind: 'sharpen'; data: { amount: number } }
  | { kind: 'glow'; data: { amount: number; radius: number } }
  | { kind: 'chromaShift'; data: { px: number } }
  // 크로마키는 행렬 문자열이 아니라 **판정 상수**를 넘긴다 — 프리뷰 셰이더도 같은 값을 쓴다
  | { kind: 'chromaKey'; data: ChromaKeyParams }
  // ── W8 F16 신규 ──
  /** 축에 나란한 방향성 블러 (전환용 dirBlur 와 **같은 스테이지**를 효과로도 쓴다) */
  | { kind: 'dirBlur'; data: { x: number; y: number } }
  /** feFunc type="discrete" — 포스터라이즈 */
  | { kind: 'discrete'; data: { values: number[] } }
  /** feFunc type="linear" — 이치화처럼 «기울기를 아주 세게» 줘야 하는 것 */
  | { kind: 'linearTransfer'; data: { slope: number; intercept: number } }
  /** 임계 위쪽을 흐려 screen 으로 되얹는다. glow 를 임계·색까지 열어 준 것 (bloom·halation) */
  | { kind: 'bloom'; data: { amount: number; radius: number; threshold: number; tint: [number, number, number] } }
  /** 흐린 사본과 섞는다. unsharp = 로컬 대비(clarity), screen = 소프트 포커스 */
  | { kind: 'blurMix'; data: { amount: number; radius: number; mode: 'unsharp' | 'screen' } }
  | { kind: 'pixelate'; data: { cell: number; radius: number } }
  | { kind: 'displace'; data: { scale: number; freq: number } }
  | { kind: 'edge'; data: { amount: number } }
  | { kind: 'emboss'; data: { amount: number; px: number } };

/** 효과 배열 → SVG 필터 스테이지 목록 (효과 배열 순서 유지). */
export function effectSvgStages(effects?: Effect[]): SvgStageData[] {
  if (!effects || effects.length === 0) return [];
  const stages: SvgStageData[] = [];
  for (const e of effects) {
    const p = e.params ?? {};
    switch (e.type) {
      case 'temperature': {
        const a = num(p.amount, 0);
        if (a !== 0) stages.push({ kind: 'colorMatrix', data: { values: temperatureMatrix(a) } });
        break;
      }
      case 'tint': {
        const a = num(p.amount, 0);
        if (a !== 0) stages.push({ kind: 'colorMatrix', data: { values: tintMatrix(a) } });
        break;
      }
      case 'highlights': {
        const a = num(p.amount, 0);
        if (a !== 0) {
          const t = highlightsTable(a);
          stages.push({ kind: 'curves', data: { r: t, g: t, b: t } });
        }
        break;
      }
      case 'shadows': {
        const a = num(p.amount, 0);
        if (a !== 0) {
          const t = shadowsTable(a);
          stages.push({ kind: 'curves', data: { r: t, g: t, b: t } });
        }
        break;
      }
      case 'sharpen': {
        const a = Math.min(2, Math.max(0, num(p.amount, 0)));
        if (a > 0) stages.push({ kind: 'sharpen', data: { amount: a } });
        break;
      }
      case 'glow': {
        const amount = clamp01(num(p.amount, 0.5));
        const radius = Math.min(40, Math.max(0, num(p.radius, 16)));
        if (amount > 0 && radius > 0) stages.push({ kind: 'glow', data: { amount, radius } });
        break;
      }
      case 'chromaShift': {
        const px = Math.min(20, Math.max(0, num(p.px, 4)));
        if (px > 0) stages.push({ kind: 'chromaShift', data: { px } });
        break;
      }

      // ═══ W8 F16 신규 ═══════════════════════════════════════════════════

      // ── 기본 색 ──
      case 'gamma': {
        const g = num(p.gamma, 1);
        if (g !== 1) {
          const t = gammaTable(g);
          stages.push({ kind: 'curves', data: { r: t, g: t, b: t } });
        }
        break;
      }
      case 'whiteBalance': {
        const k = num(p.kelvin, 6500);
        const t = num(p.tint, 0);
        if (k !== 6500 || t !== 0) {
          stages.push({ kind: 'colorMatrix', data: { values: whiteBalanceMatrix(k, t) } });
        }
        break;
      }

      // ── 색감·룩 ── 강도 0 이면 스테이지를 안 만든다(항등 필터도 합성 비용이다)
      case 'bleachBypass': {
        const a = clamp01(num(p.amount, 0.6));
        if (a > 0) {
          stages.push({ kind: 'colorMatrix', data: { values: bleachBypassMatrix(a) } });
          const t = bleachBypassTable(a);
          stages.push({ kind: 'curves', data: { r: t, g: t, b: t } });
        }
        break;
      }
      case 'crossProcess': {
        const a = clamp01(num(p.amount, 0.6));
        if (a > 0) stages.push({ kind: 'curves', data: crossProcessTables(a) });
        break;
      }
      case 'tealOrange': {
        const a = clamp01(num(p.amount, 0.6));
        if (a > 0) stages.push({ kind: 'curves', data: tealOrangeTables(a) });
        break;
      }
      case 'duotone': {
        const a = clamp01(num(p.amount, 0.8));
        if (a > 0) {
          const values = duotoneMatrix(num(p.hueA, 220), num(p.hueB, 40), a);
          stages.push({ kind: 'colorMatrix', data: { values } });
        }
        break;
      }
      case 'faded': {
        const a = clamp01(num(p.amount, 0.5));
        if (a > 0) {
          const t = fadedTable(a);
          stages.push({ kind: 'curves', data: { r: t, g: t, b: t } });
          stages.push({ kind: 'colorMatrix', data: { values: fadedMatrix(a) } });
        }
        break;
      }

      // ── 흐림·선명 ──
      case 'dirBlur': {
        const x = Math.min(60, Math.max(0, num(p.x, 20)));
        const y = Math.min(60, Math.max(0, num(p.y, 0)));
        if (x > 0 || y > 0) stages.push({ kind: 'dirBlur', data: { x, y } });
        break;
      }
      case 'clarity': {
        const amount = clamp01(num(p.amount, 0.5));
        const radius = Math.min(60, Math.max(2, num(p.radius, 20)));
        if (amount > 0) stages.push({ kind: 'blurMix', data: { amount, radius, mode: 'unsharp' } });
        break;
      }
      case 'softFocus': {
        const amount = clamp01(num(p.amount, 0.5));
        const radius = Math.min(60, Math.max(2, num(p.radius, 20)));
        if (amount > 0) stages.push({ kind: 'blurMix', data: { amount, radius, mode: 'screen' } });
        break;
      }

      // ── 질감 ──
      case 'halation': {
        const amount = clamp01(num(p.amount, 0.5));
        const radius = Math.min(60, Math.max(0, num(p.radius, 24)));
        if (amount > 0 && radius > 0) {
          // 붉은 기운만 남긴 하이라이트가 번진다 — glow 와 달리 «색이 있는» 번짐이다.
          const [r, g, b] = hslRgb(num(p.hue, 12), 1, 0.55);
          stages.push({
            kind: 'bloom',
            data: { amount, radius, threshold: 0.72, tint: [r, g * 0.45, b * 0.25] },
          });
        }
        break;
      }
      case 'vhs': {
        // 테이프 색 번짐 — 나머지(스캔라인·노이즈 띠)는 오버레이가 그린다.
        const a = clamp01(num(p.amount, 0.6));
        if (a > 0) stages.push({ kind: 'chromaShift', data: { px: 1 + a * 6 } });
        break;
      }
      case 'bloom': {
        const amount = clamp01(num(p.amount, 0.5));
        const radius = Math.min(120, Math.max(0, num(p.radius, 48)));
        const threshold = clamp01(num(p.threshold, 0.5));
        if (amount > 0 && radius > 0) {
          stages.push({ kind: 'bloom', data: { amount, radius, threshold, tint: [1, 1, 1] } });
        }
        break;
      }

      // ── 왜곡 ──
      case 'pixelate': {
        const spec = pixelateSpec(num(p.size, 16));
        stages.push({ kind: 'pixelate', data: spec });
        break;
      }
      case 'mosaic': {
        // 픽셀화와 같은 체인 + 격자선 오버레이 — 「검열 모자이크」와 「타일」은 다른 그림이다.
        const spec = pixelateSpec(num(p.size, 28));
        stages.push({ kind: 'pixelate', data: spec });
        break;
      }
      case 'wave': {
        const spec = waveSpec(num(p.amount, 18), num(p.scale, 0.012));
        if (spec.scale > 0) stages.push({ kind: 'displace', data: spec });
        break;
      }

      // ── 스타일 ──
      case 'posterize': {
        const values = posterizeLevels(num(p.levels, 6));
        stages.push({ kind: 'discrete', data: { values } });
        break;
      }
      case 'threshold': {
        stages.push({ kind: 'colorMatrix', data: { values: SATURATE_0 } });
        stages.push({ kind: 'linearTransfer', data: thresholdTransferSteep(num(p.level, 0.5)) });
        break;
      }
      case 'edgeDetect': {
        const amount = Math.min(2, Math.max(0, num(p.amount, 1)));
        if (amount > 0) {
          stages.push({ kind: 'colorMatrix', data: { values: SATURATE_0 } });
          stages.push({ kind: 'edge', data: { amount } });
        }
        break;
      }
      case 'emboss': {
        const amount = Math.min(2, Math.max(0, num(p.amount, 1)));
        const px = Math.min(8, Math.max(1, Math.round(num(p.px, 2))));
        if (amount > 0) stages.push({ kind: 'emboss', data: { amount, px } });
        break;
      }

      // ── 「대기」(impl:'webgl') — vibrance·bokeh·radialBlur·mirror·kaleidoscope·halftone.
      //    **일부러 아무것도 안 만든다.** 반쯤 그리면 「걸었는데 왜 이래」가 된다.
      default:
        break;
    }
  }
  return stages;
}

/** 원래 박스 «밖»으로 번지는 스테이지들 — 필터 영역을 넓히지 않으면 자락이 네모나게 잘린다. */
const WIDE_KINDS = new Set(['glow', 'chromaShift', 'bloom', 'blurMix', 'dirBlur', 'displace']);

export function needsWideFilterRegion(stages: SvgStageData[]): boolean {
  return stages.some((s) => WIDE_KINDS.has(s.kind));
}

// ── 오버레이 효과 (미디어 위에 얹는 div) ───────────────────────────────────

export type EffectOverlay =
  | { kind: 'grain'; params: { amount: number } }
  | { kind: 'scanlines'; params: { amount: number; lines: number } }
  | { kind: 'lightLeak'; params: { amount: number; hue: number } }
  // ── W8 F16 신규 ──
  /** 위·아래만 흐리게 (backdrop-filter + 세로 그라디언트 마스크) */
  | { kind: 'tiltShift'; params: { px: number; band: number; center: number } }
  | { kind: 'dust'; params: { amount: number; density: number } }
  | { kind: 'vhs'; params: { amount: number } }
  | { kind: 'filmScratch'; params: { amount: number; count: number } }
  | { kind: 'crt'; params: { amount: number; lines: number } }
  /** 타일 모자이크의 격자선 — 셀 크기는 px 라서 캔버스 높이 환산이 필요 없다 */
  | { kind: 'mosaicGrout'; params: { size: number; grout: number } };

/**
 * 프레임 → feTurbulence seed. **1 이상**이어야 한다 —
 * SVG 난수 시드는 0 이하를 1 로 접어버려서 seed 0 과 1 이 똑같은 노이즈를 낸다
 * (그러면 첫 두 프레임의 그레인이 완전히 같아진다).
 */
export function grainSeed(frame: number): number {
  return 1 + (((Math.round(frame) % 977) + 977) % 977);
}

/** scanlines 오버레이의 background — period px 주기로 절반은 어둡게. */
export function scanlinesCss(amount: number, periodPx: number): string {
  const a = n4(clamp01(amount) * 0.75);
  const p = Math.max(2, periodPx);
  const h = p / 2;
  return (
    `repeating-linear-gradient(to bottom, rgba(0,0,0,${a}) 0px, rgba(0,0,0,${a}) ${n4(h)}px, ` +
    `rgba(0,0,0,0) ${n4(h)}px, rgba(0,0,0,0) ${n4(p)}px)`
  );
}

/** lightLeak 오버레이의 background — 대각선으로 스미는 빛 띠 (screen 합성용). */
export function lightLeakCss(amount: number, hue: number): string {
  const a = clamp01(amount);
  const h = ((hue % 360) + 360) % 360;
  return (
    `linear-gradient(115deg, rgba(0,0,0,0) 0%, ` +
    `hsla(${n4(h)},100%,62%,${n4(a * 0.85)}) 38%, ` +
    `hsla(${n4((h + 22) % 360)},100%,74%,${n4(a)}) 52%, ` +
    `hsla(${n4(h)},100%,60%,${n4(a * 0.5)}) 64%, rgba(0,0,0,0) 84%)`
  );
}

/** 효과 배열 → 오버레이 목록 (vignette 는 별도 경로, v1 그대로). */
export function effectOverlays(effects?: Effect[]): EffectOverlay[] {
  if (!effects || effects.length === 0) return [];
  const out: EffectOverlay[] = [];
  for (const e of effects) {
    const p = e.params ?? {};
    switch (e.type) {
      case 'grain': {
        const amount = clamp01(num(p.amount, 0.3));
        if (amount > 0) out.push({ kind: 'grain', params: { amount } });
        break;
      }
      case 'scanlines': {
        const amount = clamp01(num(p.amount, 0.3));
        const lines = Math.min(2000, Math.max(100, Math.round(num(p.lines, 600))));
        if (amount > 0) out.push({ kind: 'scanlines', params: { amount, lines } });
        break;
      }
      case 'lightLeak': {
        const amount = clamp01(num(p.amount, 0.4));
        const hue = ((num(p.hue, 30) % 360) + 360) % 360;
        if (amount > 0) out.push({ kind: 'lightLeak', params: { amount, hue } });
        break;
      }

      // ═══ W8 F16 신규 ═══
      case 'tiltShift': {
        const px = Math.min(40, Math.max(0, num(p.px, 14)));
        const band = Math.min(1, Math.max(0.05, num(p.band, 0.35)));
        const center = clamp01(num(p.center, 0.5));
        if (px > 0) out.push({ kind: 'tiltShift', params: { px, band, center } });
        break;
      }
      case 'dust': {
        const amount = clamp01(num(p.amount, 0.4));
        const density = clamp01(num(p.density, 0.5));
        if (amount > 0) out.push({ kind: 'dust', params: { amount, density } });
        break;
      }
      case 'vhs': {
        const amount = clamp01(num(p.amount, 0.6));
        if (amount > 0) out.push({ kind: 'vhs', params: { amount } });
        break;
      }
      case 'filmScratch': {
        const amount = clamp01(num(p.amount, 0.5));
        const count = Math.min(12, Math.max(1, Math.round(num(p.count, 4))));
        if (amount > 0) out.push({ kind: 'filmScratch', params: { amount, count } });
        break;
      }
      case 'crt': {
        const amount = clamp01(num(p.amount, 0.6));
        const lines = Math.min(2000, Math.max(100, Math.round(num(p.lines, 900))));
        if (amount > 0) out.push({ kind: 'crt', params: { amount, lines } });
        break;
      }
      case 'mosaic': {
        const size = Math.max(4, Math.min(120, Math.round(num(p.size, 28))));
        const grout = Math.min(0.4, Math.max(0, num(p.grout, 0.12)));
        if (grout > 0) out.push({ kind: 'mosaicGrout', params: { size, grout } });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ── 신규 오버레이의 CSS (순수 문자열 — 단위테스트 대상) ───────────────────

/**
 * 틸트 시프트 마스크 — **가운데 띠만 빼고** 흐리게 한다. 그래서 마스크는 「가운데가 투명」이다
 * (`backdrop-filter` 는 마스크가 «불투명한» 곳에만 걸린다).
 */
export function tiltShiftMaskCss(band: number, center: number): string {
  const half = clamp01(band) / 2;
  const c = clamp01(center);
  const lo = Math.max(0, c - half) * 100;
  const hi = Math.min(100, (c + half) * 100);
  // 0%→lo% 와 hi%→100% 구간이 그대로 «번지는 폭»이다 — 따로 페더 값을 둘 필요가 없다.
  return (
    `linear-gradient(to bottom, #fff 0%, rgba(0,0,0,0) ${n4(lo)}%, ` +
    `rgba(0,0,0,0) ${n4(hi)}%, #fff 100%)`
  );
}

/** VHS 색 띠 — 가로로 뭉개진 노이즈 밴드가 화면을 가로지른다 (screen 합성). */
export function vhsBandCss(amount: number): string {
  const a = clamp01(amount);
  return (
    `repeating-linear-gradient(to bottom, ` +
    `rgba(255,255,255,0) 0px, rgba(255,255,255,0) 7px, ` +
    `rgba(120,255,240,${n4(a * 0.22)}) 8px, rgba(255,80,200,${n4(a * 0.18)}) 10px, ` +
    `rgba(255,255,255,0) 12px)`
  );
}

/** CRT — RGB 인광체 세로 줄무늬. 가로 스캔라인과 «직각»이라 둘이 겹쳐 격자로 보인다. */
export function crtPhosphorCss(amount: number): string {
  const a = clamp01(amount) * 0.5;
  return (
    `repeating-linear-gradient(to right, ` +
    `rgba(255,0,0,${n4(a)}) 0px, rgba(255,0,0,${n4(a)}) 1px, ` +
    `rgba(0,255,0,${n4(a)}) 1px, rgba(0,255,0,${n4(a)}) 2px, ` +
    `rgba(0,0,255,${n4(a)}) 2px, rgba(0,0,255,${n4(a)}) 3px)`
  );
}

/** 타일 모자이크의 격자선 — 셀 경계에 어두운 홈을 판다. */
export function mosaicGroutCss(sizePx: number, grout: number): string {
  const s = Math.max(4, sizePx);
  const w = Math.max(0.5, s * clamp01(grout) * 0.5);
  const a = n4(0.25 + clamp01(grout));
  return (
    `repeating-linear-gradient(to right, rgba(0,0,0,${a}) 0px, rgba(0,0,0,${a}) ${n4(w)}px, ` +
    `rgba(0,0,0,0) ${n4(w)}px, rgba(0,0,0,0) ${n4(s)}px), ` +
    `repeating-linear-gradient(to bottom, rgba(0,0,0,${a}) 0px, rgba(0,0,0,${a}) ${n4(w)}px, ` +
    `rgba(0,0,0,0) ${n4(w)}px, rgba(0,0,0,0) ${n4(s)}px)`
  );
}

/**
 * 필름 스크래치 — 세로 흠집의 가로 위치·굵기. **프레임마다 자리가 바뀐다**(정지 텍스처가 아니다).
 * 같은 (frame, i) 면 항상 같은 값이라 렌더가 재현된다.
 */
export function filmScratchLines(
  frame: number,
  count: number,
  amount: number,
): { leftPct: number; widthPx: number; opacity: number }[] {
  const n = Math.max(1, Math.min(12, Math.round(count)));
  const f = Math.round(frame);
  const out: { leftPct: number; widthPx: number; opacity: number }[] = [];
  for (let i = 0; i < n; i++) {
    // 흠집은 «몇 프레임 동안 같은 자리»에 있다가 튄다 — 매 프레임 흩어지면 지지직거린다.
    const seed = Math.floor(f / (3 + (i % 4))) * 17 + i * 101;
    // **첫 줄은 항상 보인다.** 처음엔 전부 확률로 뽑았더니 프레임에 따라 «아무것도 안 나오는»
    // 순간이 생겼다(컨택트 시트 프레임 15 에서 4줄이 전부 빠졌다 — 걸었는데 원본과 똑같았다).
    // 나머지 줄만 가끔 빠져서 «필름이 튀는» 느낌을 낸다.
    if (i > 0 && hash01(seed) < 0.3) continue;
    out.push({
      leftPct: hash01(seed + 7) * 100,
      widthPx: 1 + Math.floor(hash01(seed + 13) * 2),
      opacity: clamp01(amount) * (0.35 + hash01(seed + 23) * 0.5),
    });
  }
  return out;
}

/** 결정적 의사난수 0..1 — transitions.tsx 와 같은 수식(사본이지만 두 모듈이 서로를 안 부른다). */
function hash01(x: number): number {
  const n = Math.sin(x * 127.1) * 43758.5453;
  return n - Math.floor(n);
}
