// 이미지 섹션 — 블렌드 · 크로마키 · 마스크.
//
// ## 왜 따로 있나 (W8 F17)
// 이미지 클립은 스키마·렌더러가 **마스크를 이미 지원하는데 인스펙터에 자리가 없었다.**
// 크로마키는 아예 이미지에서 안 걸렸다 — 그런데 광고 소재는 «초록 배경 제품 컷아웃»·
// «AI 로 만든 이미지» 가 흔해서 이미지에 크로마키를 걸 일이 실제로 많다.
// (렌더러 쪽도 같이 고쳤다 — `layout/index.ts` 의 chromaKey 스테이지 조건.)
//
// 영상과 다른 점: **속도·역재생·볼륨·페이드가 없고, 마스크 추적도 없다**
// (정지 그림에는 따라갈 «움직이는 대상» 이 없다).
import type { ImageClip } from '@kitkat/schema';
import {
  BLEND_OPTIONS,
  clipMasks,
  defaultChromaKey,
  defaultMask,
  defaultPathMask,
  masksPatch,
} from './inspector-utils.js';
import type { BlendMode } from './inspector-utils.js';
import { CheckField, Row, Section, SelectField } from './fields.js';
import { ChromaKeyFields, MaskFields } from './VideoSection.js';

type Props = {
  clip: ImageClip;
  patch: (p: Record<string, unknown>) => void;
};

export function ImageSection({ clip, patch }: Props) {
  const chromaKey = clip.chromaKey;
  const masks = clipMasks(clip);

  return (
    <Section title="이미지">
      <SelectField
        label="블렌드"
        value={clip.blendMode ?? 'normal'}
        options={BLEND_OPTIONS}
        onCommit={(v) => patch({ blendMode: v === 'normal' ? null : (v as BlendMode) })}
      />
      <CheckField
        label="크로마키 사용"
        checked={!!chromaKey}
        onCommit={(v) => patch({ chromaKey: v ? defaultChromaKey() : null })}
      />
      {chromaKey ? (
        <ChromaKeyFields ck={chromaKey} onPatch={(ck) => patch({ chromaKey: ck })} />
      ) : null}
      <CheckField
        label="마스크 사용"
        checked={masks.length > 0}
        onCommit={(v) => patch(masksPatch(v ? [defaultMask()] : []))}
      />
      {masks.map((m, i) => (
        <MaskFields
          key={i}
          mask={m}
          index={i}
          count={masks.length}
          clipId={clip.id}
          onPatch={(next) => patch(masksPatch(masks.map((x, k) => (k === i ? next : x))))}
          onRemove={() => patch(masksPatch(masks.filter((_, k) => k !== i)))}
        />
      ))}
      {masks.length > 0 && masks.length < 8 ? (
        <Row label="마스크 추가">
          <button
            type="button"
            className="btn"
            onClick={() => patch(masksPatch([...masks, defaultPathMask()]))}
          >
            + 자유 곡선
          </button>
        </Row>
      ) : null}
    </Section>
  );
}
