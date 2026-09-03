// 파생 미디어 섹션 (W5 M2) — clip.source 를 통째로 갈아끼운다.
// video: LUT + 손떨림 보정 + 잡음 제거 + 피치 / audio: 잡음 제거 + 피치.
// + W8 F11: 나레이션 오디오 체인(프리셋·목표 LUFS·공간감) — video·audio 양쪽에 둔다.
// 파생 파일은 서버가 ffmpeg 로 굽는다 — 다 굽기 전에는 미리보기·렌더가 원본을 쓴다.
import { useState } from 'react';
import {
  sourceKey,
  DEFAULT_TARGET_LUFS,
  LOUDNESS_TARGETS,
  VOICE_PRESETS,
  loudnessTargetOf,
} from '@kitkat/schema';
import type { Asset, AudioClip, ClipSource, VideoClip, VoicePreset } from '@kitkat/schema';
import { useEditor } from '../../state.js';
import {
  DEFAULT_SOURCE_MOTION_BLUR,
  derivePending,
  estimateSourceMotionBlurSec,
  formatEstimate,
  motionBlurConfirmMessage,
  normalizeClipSource,
} from './inspector-utils.js';
import type { Option } from './inspector-utils.js';
import { CheckField, Row, Section, SelectField, SliderField } from './fields.js';
import { MatchSection } from './MatchSection.js';
import { HslSection } from './HslSection.js';
import { VOICE_IR_OPTIONS } from './voice-ir.js';

type Props = {
  clip: VideoClip | AudioClip;
  assets: Record<string, Asset>;
  patch: (p: Record<string, unknown>) => void;
};

const NONE = '__none__';

const VOICE_PRESET_LABELS: Record<VoicePreset, string> = {
  off: '없음',
  broadcast: '방송용',
  warm: '따뜻하게',
  bright: '또렷하게',
  podcast: '팟캐스트',
};

const VOICE_PRESET_OPTIONS: Option[] = VOICE_PRESETS.map((p) => ({
  value: p,
  label: VOICE_PRESET_LABELS[p],
}));

/** 프리셋에 없는 값일 때 고르는 자리. 고를 수는 없고 «지금 상태»만 보여 준다. */
const CUSTOM_LUFS = '__custom__';

const LUFS_OPTIONS: Option[] = [
  ...LOUDNESS_TARGETS.map((t) => ({ value: t.id, label: t.label })),
  { value: CUSTOM_LUFS, label: '직접 지정' },
];

const IR_OPTIONS: Option[] = [
  { value: NONE, label: '없음' },
  ...VOICE_IR_OPTIONS.map((ir) => ({ value: ir.id, label: ir.label })),
];

type LoudnormResult = {
  input_i?: string;
  output_i?: string;
  input_tp?: string;
  output_tp?: string;
  normalization_type?: string;
};

/**
 * 이 클립의 파생 잡이 돌려준 loudnorm 측정값.
 *
 * **숫자를 보여주는 것이 핵심이다** — 「좋아졌다」가 아니라 「-21.8 → -14.0 LUFS」다.
 * 특히 `normalization_type` 이 `dynamic` 이면 «내가 지정한 것과 다른 처리» 이므로 이유까지 적는다.
 */
function useVoiceMeasurement(clip: VideoClip | AudioClip): LoudnormResult | null {
  const jobs = useEditor((s) => s.jobs);
  const key = sourceKey(clip);
  if (!key) return null;
  for (const job of Object.values(jobs).reverse()) {
    const r = job.result as { key?: string; loudnorm?: LoudnormResult } | undefined;
    if (job.type === 'derive' && job.status === 'done' && r?.key === key && r.loudnorm) {
      return r.loudnorm;
    }
  }
  return null;
}

function VoiceGroup({
  clip,
  source,
  setSource,
}: {
  clip: VideoClip | AudioClip;
  source: ClipSource;
  setSource: (next: ClipSource) => void;
}) {
  const voice = source.voice;
  const preset: VoicePreset = voice?.preset ?? 'off';
  const targetLufs = voice?.targetLufs ?? DEFAULT_TARGET_LUFS;
  // 지금 값이 어느 프리셋인지. 프리셋에 없으면 undefined → 「직접 지정」으로 뜬다.
  const loudnessMatch = loudnessTargetOf(targetLufs);
  const measured = useVoiceMeasurement(clip);
  const dynamic = measured?.normalization_type === 'dynamic';

  return (
    <>
      <SelectField
        label="나레이션"
        value={preset}
        options={VOICE_PRESET_OPTIONS}
        onCommit={(v) =>
          setSource({
            ...source,
            // 'off' 는 필드째 지운다 — 그래야 sourceKey 가 깨끗해지고 필요 없는 파생이 안 생긴다
            voice: v === 'off' ? undefined : { ...(voice ?? {}), preset: v as VoicePreset },
          })
        }
      />
      {preset !== 'off' ? (
        <>
          <SelectField
            label="내보낼 곳"
            value={loudnessMatch?.id ?? CUSTOM_LUFS}
            options={LUFS_OPTIONS}
            onCommit={(v) => {
              const t = LOUDNESS_TARGETS.find((x) => x.id === v);
              if (!t) return; // «직접 지정» 은 슬라이더로만 바꾼다
              setSource({ ...source, voice: { ...voice!, targetLufs: t.lufs } });
            }}
          />
          <SliderField
            label="목표 크기"
            value={targetLufs}
            min={-30}
            max={-9}
            step={0.5}
            digits={1}
            onCommit={(v) => setSource({ ...source, voice: { ...voice!, targetLufs: v } })}
          />
          <Row label="">
            <span className="insp-static">
              {loudnessMatch
                ? `${loudnessMatch.official ? '공식 규격' : '공식 문서 없는 관행값'} · ${loudnessMatch.hint}`
                : '프리셋에 없는 값입니다. 내보낼 곳의 규격을 확인하세요.'}
            </span>
          </Row>
          {loudnessMatch?.id === 'youtube' ? (
            <Row label="">
              <span className="insp-static">
                구글 광고(Campaign Manager 360 · Ad Manager · DV360)로 납품한다면 −24 LKFS 가
                공식 규격입니다 — 지금 값은 10dB 큽니다.
              </span>
            </Row>
          ) : null}
          <SelectField
            label="공간감"
            value={voice?.reverb?.irId ?? NONE}
            options={IR_OPTIONS}
            onCommit={(v) =>
              setSource({
                ...source,
                voice: {
                  ...voice!,
                  reverb: v === NONE ? undefined : { irId: v, wet: voice?.reverb?.wet ?? 0.3 },
                },
              })
            }
          />
          {voice?.reverb ? (
            <SliderField
              label="공간감 세기"
              value={voice.reverb.wet}
              min={0}
              max={1}
              onCommit={(v) =>
                setSource({ ...source, voice: { ...voice, reverb: { irId: voice.reverb!.irId, wet: v } } })
              }
            />
          ) : null}
          {measured ? (
            <>
              <Row label="측정 결과">
                <span className="insp-static">
                  {Number(measured.input_i).toFixed(1)} → {Number(measured.output_i).toFixed(1)} LUFS ·
                  트루피크 {Number(measured.output_tp).toFixed(1)} dBTP · {measured.normalization_type}
                </span>
              </Row>
              {dynamic ? (
                <p className="insp-badge">
                  목표 LRA 보다 원본 다이내믹이 좁아 dynamic 모드로 처리했습니다 (시간에 따라 게인을
                  조절해 목표에 맞춥니다).
                </p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

const MOTION_BLUR_QUALITY_OPTIONS: Option[] = [
  { value: 'precise', label: '정밀 (프레임 보간 · 느림)' },
  { value: 'fast', label: '빠름 (프레임 섞기 · 계단)' },
];

/**
 * W8 F3-A — 소스 영상 모션 블러. **영상 파일을 새로 굽는다.**
 *
 * 「AI 영상이 CG 같다」의 정체가 이거다 — 소스 안에서 움직이는 피사체에 번짐이 없다.
 * 기본은 `precise`(1080×1920 1초에 77초). **느리다고 몰래 `fast` 로 바꾸지 않는다** —
 * 예상 시간을 적어 보여주고, 굽기 전에 묻는다.
 */
function MotionBlurGroup({
  source,
  asset,
  clip,
  setSource,
}: {
  source: ClipSource;
  asset: Asset | undefined;
  clip: VideoClip;
  setSource: (next: ClipSource) => void;
}) {
  const mb = source.motionBlur;
  // 취소하면 슬라이더를 문서 값으로 되돌려야 한다 — 안 그러면 손잡이는 270° 를 가리키는데
  // 실제로는 180° 인 상태가 남는다. key 를 바꿔 다시 마운트시키는 게 제일 짧은 방법이다.
  const [cancels, setCancels] = useState(0);
  const info = {
    durationMs: asset?.duration ?? clip.out - clip.in,
    width: asset?.width ?? 1080,
    height: asset?.height ?? 1920,
  };

  /** 묻고 나서 바꾼다. 취소하면 문서를 건드리지 않는다 → 잡도 안 생긴다. */
  const commit = (next: ClipSource['motionBlur']): void => {
    if (next) {
      const sec = estimateSourceMotionBlurSec(next, info);
      if (sec > 0 && !window.confirm(motionBlurConfirmMessage(sec))) {
        setCancels((n) => n + 1);
        return;
      }
    }
    setSource({ ...source, motionBlur: next });
  };

  return (
    <>
      <CheckField
        label="모션 블러 (소스)"
        checked={!!mb}
        onCommit={(v) => commit(v ? DEFAULT_SOURCE_MOTION_BLUR : undefined)}
      />
      {mb ? (
        <>
          <SliderField
            key={`sa-${mb.shutterAngle}-${cancels}`}
            label="셔터 각도"
            value={mb.shutterAngle}
            min={0}
            max={360}
            step={5}
            digits={0}
            onCommit={(v) => commit({ ...mb, shutterAngle: v })}
          />
          <SelectField
            label="품질"
            value={mb.quality}
            options={MOTION_BLUR_QUALITY_OPTIONS}
            onCommit={(v) => commit({ ...mb, quality: v as 'fast' | 'precise' })}
          />
          <Row label="예상 시간">
            <span className="insp-static">
              {formatEstimate(estimateSourceMotionBlurSec(mb, info)) || '없음 (각도가 0에 가깝습니다)'}
            </span>
          </Row>
          <p className="insp-note">
            180° 가 표준 영화 셔터입니다. 「정밀」은 프레임을 8배로 보간해 진짜 셔터를 만들고,
            「빠름」은 이웃 프레임만 섞습니다 — 느린 움직임에서는 거의 같지만 빠른 움직임에서는
            계단이 보입니다.
          </p>
        </>
      ) : null}
    </>
  );
}

export function SourceSection({ clip, assets, patch }: Props) {
  const isVideo = clip.kind === 'video';
  const source = (clip.source ?? {}) as ClipSource;
  const asset = assets[clip.assetId];
  const pending = derivePending(clip, asset);

  const setSource = (next: ClipSource) => patch({ source: normalizeClipSource(next) });
  const lutOptions: Option[] = [
    { value: NONE, label: '없음' },
    ...Object.values(assets)
      .filter((a) => a.kind === 'lut')
      .map((a) => ({ value: a.id, label: a.name })),
  ];

  return (
    <>
    <Section title="원본 보정">
      {isVideo ? (
        <>
          {lutOptions.length > 1 ? (
            <SelectField
              label="LUT"
              value={source.lut?.assetId ?? NONE}
              options={lutOptions}
              onCommit={(v) =>
                setSource({
                  ...source,
                  lut: v === NONE ? undefined : { assetId: v, intensity: source.lut?.intensity ?? 1 },
                })
              }
            />
          ) : (
            <Row label="LUT">
              <span className="insp-static">.cube 파일을 임포트하세요</span>
            </Row>
          )}
          {source.lut ? (
            <SliderField
              label="LUT 강도"
              value={source.lut.intensity}
              min={0}
              max={1}
              onCommit={(v) => setSource({ ...source, lut: { assetId: source.lut!.assetId, intensity: v } })}
            />
          ) : null}
          <CheckField
            label="손떨림 보정"
            checked={!!source.stabilize}
            onCommit={(v) => setSource({ ...source, stabilize: v ? { smoothing: 10 } : undefined })}
          />
          {source.stabilize ? (
            <SliderField
              label="보정 강도"
              value={source.stabilize.smoothing}
              min={1}
              max={100}
              step={1}
              digits={0}
              onCommit={(v) => setSource({ ...source, stabilize: { smoothing: Math.round(v) } })}
            />
          ) : null}
          {/* W8 F3-A — 소스 영상 «속» 피사체의 모션 블러. 화면에서 클립이 움직이는 블러는
              「전환」 옆의 «움직임 블러» 다 (그건 파일을 안 굽는다). */}
          <MotionBlurGroup clip={clip} source={source} asset={asset} setSource={setSource} />
        </>
      ) : null}
      <CheckField
        label="잡음 제거"
        checked={!!source.denoise}
        onCommit={(v) => setSource({ ...source, denoise: v ? { amount: 0.5 } : undefined })}
      />
      {source.denoise ? (
        <SliderField
          label="제거 세기"
          value={source.denoise.amount}
          min={0}
          max={1}
          onCommit={(v) => setSource({ ...source, denoise: { amount: v } })}
        />
      ) : null}
      <CheckField
        label="피치 보정"
        checked={!!source.pitch}
        onCommit={(v) => setSource({ ...source, pitch: v ? { semitones: 0 } : undefined })}
      />
      {source.pitch ? (
        <SliderField
          label="피치"
          value={source.pitch.semitones}
          min={-12}
          max={12}
          step={0.5}
          digits={1}
          onCommit={(v) => setSource({ ...source, pitch: { semitones: v } })}
        />
      ) : null}
      {/* W8 F11 — 나레이션 체인. video 클립의 오디오에도 건다(나레이션이 audio 클립만은 아니다). */}
      <VoiceGroup clip={clip} source={source} setSource={setSource} />
      {pending ? (
        <p className="insp-badge">적용 중… (미리보기는 원본)</p>
      ) : clip.source ? (
        <p className="insp-note">파생 파일이 준비됐습니다 — 미리보기·렌더가 보정본을 씁니다.</p>
      ) : null}
      {/* W8 F13 — 여기에는 키프레임 버튼(◆)이 붙지 않는다. 이유를 적어 두지 않으면
          「왜 여기만 없냐」가 계속 올라온다. */}
      <p className="insp-note">
        이 설정들은 영상 파일을 다시 만드는 설정이라 시간에 따라 바꿀 수 없습니다 — 프레임마다
        바뀌면 파생 파일이 수백 개 생깁니다. 시간에 따라 바꾸려면 아래 「효과」의 색 파라미터에
        키프레임을 거세요.
      </p>
    </Section>
    {/* W8 F4·F5 — 같은 파생 스펙(clip.source)을 쓰지만 하는 일이 달라서 섹션을 나눈다.
        「원본 보정」이 이미 길고, 색 맞추기는 컷 사이의 관계라 개념이 다르다. */}
    {clip.kind === 'video' ? (
      <>
        <Section title="컷 색 맞추기">
          <MatchSection clip={clip} patch={patch} />
        </Section>
        <Section title="색 계열별 보정 (HSL)">
          <HslSection source={source} asset={asset} patch={patch} />
        </Section>
      </>
    ) : null}
    </>
  );
}
