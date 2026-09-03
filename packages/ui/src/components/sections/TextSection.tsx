// 텍스트 섹션: 내용·스타일 전체·등장/퇴장 애니메이션·강조 색상
// + W8 F8 키네틱 타이포 — 「움직임 × 단위」 두 축, 시차·순서·이징, 이름 붙은 프리셋.
import { useState } from 'react';
import { FONT_FAMILIES, KINETIC_PRESETS, TEXT_ANIM_TYPES } from '@kitkat/schema';
import type { Easing, TextAnim, TextAnimType, TextAnimUnit, TextClip, TextStyle } from '@kitkat/schema';
import {
  TEXT_ANIM_LABELS,
  TEXT_ANIM_ORIGIN_LABELS,
  textAnimHint,
  textAnimUnitOptions,
} from './inspector-utils.js';
import type { Option } from './inspector-utils.js';
import { useEditor } from '../../state.js';
import { EasingEditor } from './EasingEditor.js';
import {
  CheckField,
  ColorField,
  NumberField,
  Row,
  Section,
  SelectField,
  SliderField,
  TextAreaField,
  TextField,
} from './fields.js';

type Props = {
  clip: TextClip;
  patch: (p: Record<string, unknown>) => void;
};

const ANIM_OPTIONS: Option[] = [
  { value: 'none', label: '없음' },
  ...TEXT_ANIM_TYPES.map((t) => ({ value: t, label: TEXT_ANIM_LABELS[t] })),
];

const ORIGIN_OPTIONS: Option[] = (
  ['start', 'end', 'center', 'random'] as const
).map((v) => ({ value: v, label: TEXT_ANIM_ORIGIN_LABELS[v] }));

const CUSTOM_FONT = '__custom__';

/**
 * 번들 폰트 드롭다운 (T2). 각 항목을 그 폰트로 그려서 고르기 쉽게 한다.
 * fontFamily 는 자유 문자열이라 목록에 없는 값이면 «직접 입력» 항목이 선택된 것으로 보인다.
 */
function FontSelect({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const known = FONT_FAMILIES.some((f) => f.css === value);
  return (
    <Row label="글꼴">
      <select
        className="insp-select"
        value={known ? value : CUSTOM_FONT}
        onChange={(e) => {
          if (e.target.value !== CUSTOM_FONT) onCommit(e.target.value);
        }}
      >
        {FONT_FAMILIES.map((f) => (
          // 각 항목을 그 폰트로 그려서 고르기 쉽게 한다 (@font-face 는 styles.css 에 있다)
          <option key={f.id} value={f.css} style={{ fontFamily: f.css, fontSize: 15 }}>
            {f.name}
          </option>
        ))}
        {known ? null : (
          <option value={CUSTOM_FONT} style={{ fontFamily: value }}>
            직접 입력
          </option>
        )}
      </select>
    </Row>
  );
}

/**
 * 등장/퇴장 한 벌. 두 축(움직임·단위)을 나란히 놓고, 단위가 '전체'면 시차·순서 줄을 접는다
 * — 의미 없는 값을 보여 주지 않는다.
 */
function AnimFields({
  label,
  anim,
  text,
  fps,
  onPatch,
}: {
  label: string;
  anim: TextAnim;
  text: string;
  fps: number;
  onPatch: (a: TextAnim | null) => void;
}) {
  const [easingOpen, setEasingOpen] = useState(false);
  const unit: TextAnimUnit = anim.unit ?? 'all';
  const units = textAnimUnitOptions(anim.type);
  const hint = textAnimHint(anim, text, fps);
  const set = (partial: Partial<TextAnim>) => onPatch({ ...anim, ...partial });

  return (
    <>
      <NumberField
        label={`${label} 길이`}
        value={anim.duration}
        min={50}
        max={5000}
        step={50}
        suffix="ms"
        onCommit={(v) => set({ duration: v })}
      />
      {units.length > 1 ? (
        <SelectField
          label={`${label} 단위`}
          value={unit}
          options={units}
          onCommit={(v) => {
            const next = v as TextAnimUnit;
            // 단위를 바꾸면 시차는 그 단위의 기본값으로 돌아간다(직접 적은 값은 지운다)
            const { staggerMs: _s, ...rest } = anim;
            onPatch(next === 'all' ? { ...rest, unit: undefined } : { ...rest, unit: next });
          }}
        />
      ) : null}
      {unit !== 'all' ? (
        <>
          <NumberField
            label="시차"
            value={Math.round(hint.applied * 10) / 10}
            min={0}
            max={2000}
            step={5}
            suffix="ms"
            onCommit={(v) => set({ staggerMs: v })}
          />
          {hint.compressed ? (
            <div className="insp-note" style={{ fontSize: 11, opacity: 0.65, padding: '0 8px 4px' }}>
              실제 적용된 시차: {hint.applied.toFixed(1)}ms — {label}이 {anim.duration}ms 안에서
              끝나도록 자동으로 줄었습니다(자르지 않고 압축합니다)
            </div>
          ) : null}
          {hint.warning ? (
            <div style={{ fontSize: 11, color: '#ffd45e', padding: '0 8px 4px' }}>
              {hint.warning}
            </div>
          ) : null}
          <SelectField
            label="순서"
            value={anim.origin ?? 'start'}
            options={ORIGIN_OPTIONS}
            onCommit={(v) => set({ origin: v as TextAnim['origin'] })}
          />
        </>
      ) : null}
      <Row label="이징">
        <button type="button" className="btn" onClick={() => setEasingOpen((o) => !o)}>
          {anim.easing ? '곡선 편집 ▾' : '기본 ▾'}
        </button>
      </Row>
      {easingOpen ? (
        <EasingEditor
          easing={anim.easing ?? 'easeOut'}
          onCommit={(e: Easing) => set({ easing: e })}
          onClose={() => setEasingOpen(false)}
        />
      ) : null}
      {anim.type === 'drawStroke' ? (
        // 획은 «이동량»이 없다. 대신 무엇으로 그려지는지 알려 준다 —
        // 외곽선을 안 켠 글자에도 반드시 그려진다(글자 색 · 크기의 3.5% 두께).
        <div style={{ fontSize: 11, opacity: 0.65, padding: '0 8px 4px' }}>
          획은 <b>외곽선 색·두께</b>로 그려집니다. 외곽선을 안 켰으면 <b>글자 색</b>으로,
          두께는 글자 크기의 3.5% 입니다. 다 그려지면 원래 글자로 바뀝니다.
        </div>
      ) : (
        <NumberField
          label={anim.type.startsWith('wipe') ? '가장자리 %' : anim.type === 'blurIn' ? '흐림 px' : '이동 px'}
          value={anim.distance ?? (anim.type.startsWith('wipe') ? 15 : anim.type === 'blurIn' ? 12 : 40)}
          min={0}
          max={2000}
          step={1}
          onCommit={(v) => set({ distance: v })}
        />
      )}
    </>
  );
}

export function TextSection({ clip, patch }: Props) {
  const st = clip.style;
  const fps = useEditor((s) => s.doc?.settings.fps ?? 30);
  const setStyle = (partial: Partial<TextStyle>) => patch({ style: { ...st, ...partial } });
  const animIn = clip.animationIn;
  const animOut = clip.animationOut;

  const setAnimType = (which: 'animationIn' | 'animationOut', type: string, prev?: TextAnim) => {
    if (type === 'none') {
      patch({ [which]: null });
      return;
    }
    // 움직임을 바꾸면 그 움직임이 못 쓰는 단위는 떨어뜨린다 (스키마가 거부하는 조합이다)
    const next: TextAnim = { ...(prev ?? { duration: 500 }), type: type as TextAnimType } as TextAnim;
    const allowed = textAnimUnitOptions(next.type).map((o) => o.value);
    if (next.unit && !allowed.includes(next.unit)) delete next.unit;
    patch({ [which]: next });
  };

  return (
    <Section title="텍스트">
      <TextAreaField
        label="내용"
        value={clip.text}
        onCommit={(v) => {
          if (v.length > 0) patch({ text: v });
        }}
      />
      <FontSelect value={st.fontFamily} onCommit={(v) => setStyle({ fontFamily: v })} />
      <TextField label="글꼴 직접" value={st.fontFamily} onCommit={(v) => setStyle({ fontFamily: v })} />
      <NumberField
        label="크기"
        value={st.fontSize}
        min={8}
        max={500}
        step={1}
        suffix="px"
        kfPath="style.fontSize"
        onCommit={(v) => setStyle({ fontSize: v })}
      />
      <ColorField label="색상" value={st.color} onCommit={(v) => setStyle({ color: v })} />
      <CheckField label="굵게" checked={st.bold ?? false} onCommit={(v) => setStyle({ bold: v })} />
      <CheckField label="기울임" checked={st.italic ?? false} onCommit={(v) => setStyle({ italic: v })} />
      <SelectField
        label="정렬"
        value={st.align}
        options={[
          { value: 'left', label: '왼쪽' },
          { value: 'center', label: '가운데' },
          { value: 'right', label: '오른쪽' },
        ]}
        onCommit={(v) => setStyle({ align: v as TextStyle['align'] })}
      />
      <NumberField
        label="자간"
        value={st.letterSpacing ?? 0}
        min={-20}
        max={100}
        step={0.5}
        suffix="px"
        kfPath="style.letterSpacing"
        onCommit={(v) => setStyle({ letterSpacing: v })}
      />
      <NumberField
        label="행간"
        value={st.lineHeight ?? 1.2}
        min={0.5}
        max={3}
        step={0.1}
        kfPath="style.lineHeight"
        onCommit={(v) => setStyle({ lineHeight: v })}
      />
      <CheckField
        label="외곽선"
        checked={st.strokeColor !== undefined}
        onCommit={(v) => {
          if (v) setStyle({ strokeColor: '#000000', strokeWidth: st.strokeWidth ?? 2 });
          else {
            const { strokeColor: _sc, strokeWidth: _sw, ...rest } = st;
            patch({ style: rest });
          }
        }}
      />
      {st.strokeColor !== undefined ? (
        <>
          <ColorField
            label="외곽선 색"
            value={st.strokeColor}
            onCommit={(v) => setStyle({ strokeColor: v })}
          />
          <SliderField
            label="외곽선 두께"
            value={st.strokeWidth ?? 2}
            min={0}
            max={20}
            step={0.5}
            digits={1}
            kfPath="style.strokeWidth"
            onCommit={(v) => setStyle({ strokeWidth: v })}
          />
        </>
      ) : null}
      <CheckField
        label="배경색"
        checked={st.backgroundColor !== undefined}
        onCommit={(v) => {
          if (v) setStyle({ backgroundColor: '#000000' });
          else {
            const { backgroundColor: _bg, ...rest } = st;
            patch({ style: rest });
          }
        }}
      />
      {st.backgroundColor !== undefined ? (
        <ColorField
          label="배경 색상"
          value={st.backgroundColor}
          onCommit={(v) => setStyle({ backgroundColor: v })}
        />
      ) : null}
      <CheckField label="그림자" checked={st.shadow ?? false} onCommit={(v) => setStyle({ shadow: v })} />

      {/* 74가지 유효 조합을 드롭다운 두 개로만 고르게 하면 아무도 안 쓴다 — 이름 붙인 조합을 먼저 준다 */}
      <div className="insp-col">
        <span className="insp-label">키네틱 프리셋</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 0' }}>
          {KINETIC_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn"
              style={{ fontSize: 11, padding: '2px 8px' }}
              title={`${TEXT_ANIM_LABELS[p.anim.type]} · ${p.anim.duration}ms`}
              onClick={() => patch({ animationIn: { ...p.anim } })}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <SelectField
        label="등장 애니"
        value={animIn?.type ?? 'none'}
        options={ANIM_OPTIONS}
        onCommit={(v) => setAnimType('animationIn', v, animIn)}
      />
      {animIn ? (
        <AnimFields
          label="등장"
          anim={animIn}
          text={clip.text}
          fps={fps}
          onPatch={(a) => patch({ animationIn: a })}
        />
      ) : null}
      <SelectField
        label="퇴장 애니"
        value={animOut?.type ?? 'none'}
        options={ANIM_OPTIONS}
        onCommit={(v) => setAnimType('animationOut', v, animOut)}
      />
      {animOut ? (
        <AnimFields
          label="퇴장"
          anim={animOut}
          text={clip.text}
          fps={fps}
          onPatch={(a) => patch({ animationOut: a })}
        />
      ) : null}

      <CheckField
        label="단어 강조색"
        checked={clip.highlightColor !== undefined}
        onCommit={(v) => patch({ highlightColor: v ? '#ffe14d' : null })}
      />
      {clip.highlightColor !== undefined ? (
        <ColorField
          label="강조 색상"
          value={clip.highlightColor}
          onCommit={(v) => patch({ highlightColor: v })}
        />
      ) : null}
    </Section>
  );
}
