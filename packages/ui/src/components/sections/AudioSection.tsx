// 오디오 섹션: 볼륨·페이드
import type { AudioClip } from '@kitkat/schema';
import { NumberField, Section, SliderField } from './fields.js';

type Props = {
  clip: AudioClip;
  patch: (p: Record<string, unknown>) => void;
};

export function AudioSection({ clip, patch }: Props) {
  return (
    <Section title="오디오">
      <SliderField
        label="볼륨"
        value={clip.volume}
        min={0}
        max={2}
        kfPath="volume"
        onCommit={(v) => patch({ volume: v })}
      />
      <NumberField
        label="페이드 인"
        value={clip.fadeIn ?? 0}
        min={0}
        step={100}
        suffix="ms"
        onCommit={(v) => patch({ fadeIn: v > 0 ? v : null })}
      />
      <NumberField
        label="페이드 아웃"
        value={clip.fadeOut ?? 0}
        min={0}
        step={100}
        suffix="ms"
        onCommit={(v) => patch({ fadeOut: v > 0 ? v : null })}
      />
    </Section>
  );
}
