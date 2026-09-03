// 텍스트 템플릿 갤러리 (W5 M1) — TEXT_TEMPLATES 90종을 실제 스타일이 보이는 칩으로 그린다.
// 클릭하면 applyTextTemplate 명령 (style·animationIn/Out·transform·highlightColor 를 덮어쓴다).
// W8 F16: 35 → 90 이 되면서 **갈래별로 접어** 보여 준다 — 90개를 한 판에 늘어놓으면 못 찾는다.
import { useState } from 'react';
import { TEXT_TEMPLATES, TEXT_TEMPLATE_GROUPS } from '@kitkat/schema';
import type { CSSProperties } from 'react';
import type { TextClip, TextStyle } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import { Section } from './fields.js';

type Props = {
  clip: TextClip;
  dispatch: (cmds: Command[]) => Promise<void>;
};

/** 템플릿 fontSize 는 1080 기준 px — 칩 크기에 맞춰 줄인다. */
const CHIP_SCALE = 0.24;
const SAMPLE = '가나다 Aa';

/** TextStyle 을 실제 CSS 로 — 굵기·기울임·외곽선·그림자·배경·자간을 그대로 적용한다. */
export function templateChipStyle(style: TextStyle): CSSProperties {
  const css: CSSProperties = {
    fontFamily: style.fontFamily,
    fontSize: Math.max(9, Math.round(style.fontSize * CHIP_SCALE)),
    color: style.color,
    fontWeight: style.bold ? 800 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    textAlign: style.align,
    letterSpacing: style.letterSpacing !== undefined ? style.letterSpacing * CHIP_SCALE : undefined,
    lineHeight: style.lineHeight ?? 1.3,
  };
  if (style.backgroundColor) css.backgroundColor = style.backgroundColor;
  if (style.strokeColor && style.strokeWidth) {
    css.WebkitTextStrokeWidth = `${Math.max(0.5, style.strokeWidth * CHIP_SCALE).toFixed(1)}px`;
    css.WebkitTextStrokeColor = style.strokeColor;
    css.paintOrder = 'stroke fill';
  }
  if (style.shadow) css.textShadow = '0 1px 3px rgba(0,0,0,0.85)';
  return css;
}

const BY_ID = new Map(TEXT_TEMPLATES.map((t) => [t.id, t]));

export function TemplatesSection({ clip, dispatch }: Props) {
  const [open, setOpen] = useState<string>(TEXT_TEMPLATE_GROUPS[0]!.id);
  const group = TEXT_TEMPLATE_GROUPS.find((g) => g.id === open) ?? TEXT_TEMPLATE_GROUPS[0]!;
  return (
    <Section title="텍스트 템플릿">
      {/* 갈래 탭 — 한 번에 한 갈래만 그린다. 90개 칩을 전부 그리면 인스펙터가 무거워진다. */}
      <div className="insp-tpl-tabs">
        {TEXT_TEMPLATE_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            className={g.id === open ? 'insp-tpl-tab insp-tpl-tab-on' : 'insp-tpl-tab'}
            onClick={() => setOpen(g.id)}
          >
            {g.name} <span className="insp-tpl-count">{g.templateIds.length}</span>
          </button>
        ))}
      </div>
      <div className="insp-tpl-grid">
        {group.templateIds.map((id) => BY_ID.get(id)).filter((t) => t !== undefined).map((t) => (
          <button
            key={t.id}
            type="button"
            className="insp-tpl-chip"
            title={`${t.name} 적용`}
            onClick={() => {
              void dispatch([{ type: 'applyTextTemplate', clipId: clip.id, templateId: t.id }]);
            }}
          >
            <span className="insp-tpl-preview">
              <span className="insp-tpl-sample" style={templateChipStyle(t.style)}>
                {SAMPLE}
              </span>
            </span>
            <span className="insp-tpl-name">{t.name}</span>
          </button>
        ))}
      </div>
      <p className="insp-note">
        템플릿을 적용하면 글자 모양·등장 효과·위치가 덮어써집니다. 내용(글)은 그대로 둡니다.
        「키네틱」은 글자·단어·줄이 차례로 움직이는 템플릿입니다.
      </p>
    </Section>
  );
}
