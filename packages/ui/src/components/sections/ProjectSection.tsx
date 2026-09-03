// 프로젝트 섹션(선택 없음): 배경 채우기 color/blur/image → setSettings
import type { Background, ProjectDoc } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import { ColorField, Row, Section, SelectField, SliderField } from './fields.js';

type Props = {
  doc: ProjectDoc;
  dispatch: (cmds: Command[]) => Promise<void>;
};

export function ProjectSection({ doc, dispatch }: Props) {
  const bg = doc.settings.background;
  const setBg = (background: Background) => {
    void dispatch([{ type: 'setSettings', settings: { background } }]);
  };
  const imageAssets = Object.values(doc.assets).filter((a) => a.kind === 'image');
  const firstImage = imageAssets[0];

  return (
    <>
      <Section title="프로젝트">
        <Row label="이름">
          <span className="insp-static">{doc.name}</span>
        </Row>
        <Row label="해상도">
          <span className="insp-static">
            {doc.settings.width}×{doc.settings.height}
          </span>
        </Row>
        <Row label="프레임">
          <span className="insp-static">{doc.settings.fps} fps</span>
        </Row>
      </Section>
      <Section title="배경 채우기">
        <SelectField
          label="종류"
          value={bg.kind}
          options={[
            { value: 'color', label: '단색' },
            { value: 'blur', label: '블러 확장' },
            { value: 'image', label: '이미지', disabled: !firstImage },
          ]}
          onCommit={(v) => {
            if (v === 'color') setBg({ kind: 'color', color: '#000000' });
            else if (v === 'blur') setBg({ kind: 'blur', amount: 20 });
            else if (firstImage) setBg({ kind: 'image', assetId: firstImage.id });
          }}
        />
        {bg.kind === 'color' ? (
          <ColorField label="색상" value={bg.color} onCommit={(v) => setBg({ kind: 'color', color: v })} />
        ) : null}
        {bg.kind === 'blur' ? (
          <SliderField
            label="블러 양"
            value={bg.amount}
            min={4}
            max={80}
            step={1}
            digits={0}
            onCommit={(v) => setBg({ kind: 'blur', amount: v })}
          />
        ) : null}
        {bg.kind === 'image' ? (
          <SelectField
            label="이미지"
            value={bg.assetId}
            options={imageAssets.map((a) => ({ value: a.id, label: a.name }))}
            onCommit={(v) => setBg({ kind: 'image', assetId: v })}
          />
        ) : null}
      </Section>
    </>
  );
}
