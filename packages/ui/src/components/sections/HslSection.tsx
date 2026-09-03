// W8 F5 — HSL 세컨더리. 화면 전체가 아니라 «빨간 것만»·«노란 것만» 골라서 고친다.
//
// 두 필터를 함께 쓴다 (계획 05):
//   hueSat (huesaturation, primary)   — 6구간의 색상 회전·채도. selectivecolor 로는 못 한다.
//   hsl    (selectivecolor, secondary) — 9계열의 CMYK 잉크 미세 조정.
// 굽는 순서는 hueSat → hsl (광범위 → 미세). derive.ts 가 고정한다.
import { useState } from 'react';
import {
  COLOR_PRESETS,
  HUESAT_BANDS,
  hslFamiliesOfRgb,
  type Asset,
  type ClipSource,
  type HslFamily,
  type HslSecondary,
  type HueSatBand,
  type HueSatBandName,
} from '@kitkat/schema';
import { Row, SliderField } from './fields.js';
import { FramePicker } from './FramePicker.js';
import {
  applyColorPreset,
  emptyHsl,
  emptyHueSat,
  HSL_FAMILY_LABELS,
  HSL_FAMILY_SWATCH,
  HSL_INK_FIELDS,
  HUESAT_BAND_LABELS,
  isIdentityHsl,
  isIdentityHueSat,
  normalizeClipSource,
} from './inspector-utils.js';

type Props = {
  source: ClipSource;
  asset: Asset | undefined;
  patch: (p: Record<string, unknown>) => void;
};

/** 색상환 순서로 6칩 + 밝기 3칩. 드롭다운에 9개를 나열하는 건 실무에서 안 쓰는 방식이다. */
const HUE_CHIPS: HslFamily[] = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
const TONE_CHIPS: HslFamily[] = ['whites', 'neutrals', 'blacks'];

export function HslSection({ source, asset, patch }: Props) {
  const [family, setFamily] = useState<HslFamily>('reds');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<{ rgb: [number, number, number]; families: HslFamily[] } | null>(null);

  const setSource = (next: ClipSource) => patch({ source: normalizeClipSource(next) });

  const hsl = source.hsl ?? [];
  const hueSat = source.hueSat ?? [];
  const current = hsl.find((h) => h.family === family);

  /** family 하나를 갈아끼운다. 값이 전부 0이면 항목째 뺀다. */
  const setInk = (next: HslSecondary) => {
    const rest = hsl.filter((h) => h.family !== next.family);
    const list = isIdentityHsl(next) ? rest : [...rest, next];
    setSource({ ...source, hsl: list });
  };

  /** hueSat 은 구간 조합마다 항목 하나. 지금 고른 구간 집합에 해당하는 항목을 찾는다. */
  const bandKey = (b: HueSatBand) => [...b.bands].sort().join('');
  const [bands, setBands] = useState<HueSatBandName[]>(['r', 'y']);
  const currentBand = hueSat.find((b) => bandKey(b) === [...bands].sort().join(''));

  const setBand = (next: HueSatBand) => {
    const rest = hueSat.filter((b) => bandKey(b) !== bandKey(next));
    const list = isIdentityHueSat(next) ? rest : [...rest, next];
    setSource({ ...source, hueSat: list });
  };

  const toggleBand = (b: HueSatBandName) => {
    const on = bands.includes(b);
    const next = on ? bands.filter((x) => x !== b) : [...bands, b];
    if (next.length === 0) return; // 최소 1개 (스키마 규칙)
    setBands(next);
  };

  const onPick = (rgb: [number, number, number]) => {
    const families = hslFamiliesOfRgb(rgb[0], rgb[1], rgb[2]).map((m) => m.family);
    setPicked({ rgb, families });
    const hue = families.find((f) => HUE_CHIPS.includes(f));
    setFamily(hue ?? families[0] ?? 'reds');
    setPicking(false);
  };

  const chip = (f: HslFamily) => {
    const has = hsl.some((h) => h.family === f);
    return (
      <button
        key={f}
        type="button"
        className={`insp-swatch${family === f ? ' is-active' : ''}${has ? ' has-data' : ''}`}
        style={{ background: HSL_FAMILY_SWATCH[f] }}
        title={HSL_FAMILY_LABELS[f]}
        onClick={() => setFamily(f)}
      >
        <span>{HSL_FAMILY_LABELS[f]}</span>
      </button>
    );
  };

  return (
    <>
      <div className="insp-preset-grid">
        {COLOR_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="insp-btn insp-preset"
            title={p.note}
            onClick={() => setSource(applyColorPreset(source, p))}
          >
            {p.name}
          </button>
        ))}
      </div>
      <p className="insp-note">
        프리셋은 «출발점»입니다 — 피부색은 인종·조명·카메라마다 다릅니다. 걸어 놓고 스코프를 보며 다듬으세요.
      </p>

      <div className="insp-add-row">
        <button
          className="insp-btn"
          type="button"
          disabled={!asset?.thumbSrc}
          onClick={() => setPicking((v) => !v)}
        >
          {picking ? '스포이드 끄기' : '스포이드로 찍기'}
        </button>
        {picked ? (
          <span className="insp-static">
            <span
              className="insp-swatch-dot"
              style={{ background: `rgb(${picked.rgb.join(',')})` }}
            />
            {picked.rgb.join(', ')} → {picked.families.map((f) => HSL_FAMILY_LABELS[f]).join(' · ')}
          </span>
        ) : null}
      </div>
      {picking ? (
        <FramePicker asset={asset} onPick={onPick} label="찍을 픽셀을 클릭하세요" />
      ) : null}
      {picked && picked.families.length > 1 ? (
        <p className="insp-note">
          이 색은 {picked.families.length}개 계열에 걸쳐 있습니다 — 두 계열을 같이 만지면 효과가 더해집니다.
        </p>
      ) : null}

      <p className="insp-label" style={{ marginTop: 6 }}>
        색 계열 (selectivecolor)
      </p>
      <div className="insp-swatch-grid">
        <div className="insp-swatch-hues">{HUE_CHIPS.map(chip)}</div>
        <div className="insp-swatch-tones">{TONE_CHIPS.map(chip)}</div>
      </div>
      {HSL_INK_FIELDS.map((f) => (
        <SliderField
          key={f.key}
          label={f.label}
          value={current?.[f.key] ?? 0}
          min={-1}
          max={1}
          onCommit={(v) => setInk({ ...(current ?? emptyHsl(family)), [f.key]: v })}
        />
      ))}
      {hsl.length > 0 ? (
        <p className="insp-note">
          조정한 계열: {hsl.map((h) => HSL_FAMILY_LABELS[h.family]).join(' · ')}
        </p>
      ) : null}

      <p className="insp-label" style={{ marginTop: 6 }}>
        색상·채도 (huesaturation)
      </p>
      <Row label="구간">
        <span className="insp-bandrow">
          {HUESAT_BANDS.map((b) => (
            <button
              key={b}
              type="button"
              className={`insp-tab${bands.includes(b) ? ' is-active' : ''}${
                hueSat.some((x) => x.bands.includes(b)) ? ' has-data' : ''
              }`}
              onClick={() => toggleBand(b)}
            >
              {HUESAT_BAND_LABELS[b]}
            </button>
          ))}
        </span>
      </Row>
      <SliderField
        label="색상(°)"
        value={currentBand?.hue ?? 0}
        min={-180}
        max={180}
        step={1}
        digits={0}
        onCommit={(v) => setBand({ ...(currentBand ?? emptyHueSat(bands)), bands, hue: v })}
      />
      <SliderField
        label="채도"
        value={currentBand?.saturation ?? 0}
        min={-1}
        max={1}
        onCommit={(v) => setBand({ ...(currentBand ?? emptyHueSat(bands)), bands, saturation: v })}
      />
      <SliderField
        label="강도"
        value={currentBand?.intensity ?? 0}
        min={-1}
        max={1}
        onCommit={(v) => setBand({ ...(currentBand ?? emptyHueSat(bands)), bands, intensity: v })}
      />
      {hueSat.length > 0 ? (
        <p className="insp-note">
          조정한 구간: {hueSat.map((b) => b.bands.map((x) => HUESAT_BAND_LABELS[x]).join('+')).join(' · ')}
        </p>
      ) : null}
    </>
  );
}
