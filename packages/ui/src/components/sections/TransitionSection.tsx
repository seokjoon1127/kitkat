// 전환 섹션: transitionIn/transitionOut 타입 + 길이
// + W8 F3-B: 움직임 블러(트랜스폼 모션 블러). 비디오·이미지·텍스트 **모든 시각 클립**에 걸리는
//   설정이라 이 파일에 같이 둔다 — 인스펙터에서 세 종류 모두에 나오는 묶음이 여기뿐이다.
import type { Transition, TransitionType, TransformBlur } from '@kitkat/schema';
import { DEFAULT_TRANSFORM_BLUR, transitionOptionGroups } from './inspector-utils.js';
import { CheckField, NumberField, Row, Section, SliderField } from './fields.js';

type Props = {
  transitionIn: Transition | undefined;
  transitionOut: Transition | undefined;
  transformBlur: TransformBlur | undefined;
  patch: (p: Record<string, unknown>) => void;
};

/**
 * 축에 안 맞는 블러가 필요한데 SVG 로는 안 되는 전환들 — 등방 블러로 «근사» 중이라고 알린다.
 * 줌 계열은 방사형(중심에서 바깥)이어야 하고, 대각 슬라이드는 45° 방향이어야 한다.
 */
const APPROX_BLUR_TYPES = new Set<TransitionType>([
  'zoomIn', 'zoomOut', 'zoomBlurIn', 'zoomBlurOut', 'whipZoom',
  'slideUpLeft', 'slideUpRight', 'slideDownLeft', 'slideDownRight',
]);

/**
 * 화면을 «잘라 내는» 전환들 (clip-path·마스크). 컨택트 시트에서 찾은 것:
 * 시작·끝에 같이 걸면 겹치는 구간에서 **잘린 자리가 배경색으로 비어 보인다**
 * (앞 클립도 같이 잘리기 때문). 움직이는 전환(슬라이드·줌)은 반대로 양쪽에 걸어야 «밀어내는»
 * 모양이 나오므로, 이 목록에 있는 것만 골라 알려 준다.
 */
const CLIP_PATH_TYPES = new Set<TransitionType>([
  'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown',
  'wipeDiagTL', 'wipeDiagTR', 'wipeDiagBL', 'wipeDiagBR',
  'circleOpen', 'circleClose', 'clockWipe', 'dissolve',
]);

export function TransitionSection({ transitionIn, transitionOut, transformBlur, patch }: Props) {
  const approx =
    (transitionIn && APPROX_BLUR_TYPES.has(transitionIn.type)) ||
    (transitionOut && APPROX_BLUR_TYPES.has(transitionOut.type));
  const clipPathBoth =
    !!transitionIn && !!transitionOut &&
    CLIP_PATH_TYPES.has(transitionIn.type) && CLIP_PATH_TYPES.has(transitionOut.type);
  return (
    <>
      <Section title="전환">
        <TransitionEditor
          label="시작 전환"
          value={transitionIn}
          onChange={(t) => patch({ transitionIn: t })}
        />
        <TransitionEditor
          label="끝 전환"
          value={transitionOut}
          onChange={(t) => patch({ transitionOut: t })}
        />
        <p className="insp-note">
          슬라이드·줌·휩팬에는 이동 방향으로 번지는 블러가 자동으로 걸립니다 (전환 중앙에서 제일
          세고 양끝에서 0). 렌더 시간은 늘지 않습니다 — 프레임을 더 뽑지 않습니다. 빠른
          미리보기(WebGL)에서는 이 블러가 안 보입니다 — 렌더와 Remotion 미리보기에만 걸립니다.
        </p>
        {clipPathBoth ? (
          <p className="insp-badge">
            와이프·원형·대각·시계·점 디졸브는 화면을 «잘라 내는» 전환입니다. 시작과 끝에 같이
            걸면 겹치는 구간에서 잘린 자리가 비어 보입니다 — 보통은 한쪽에만 겁니다.
          </p>
        ) : null}
        {approx ? (
          <p className="insp-badge">
            이 전환의 블러는 «근사»입니다 — 줌은 방사형(중심에서 바깥), 대각 슬라이드는 45°
            방향으로 번져야 맞지만 SVG 필터는 가로·세로로만 번질 수 있어서 등방 블러로 대신하고
            있습니다.
          </p>
        ) : null}
      </Section>
      <Section title="움직임 블러">
        <TransformBlurEditor value={transformBlur} patch={patch} />
      </Section>
    </>
  );
}

/**
 * W8 F3-B — 트랜스폼 모션 블러. 켄번스 줌·팬·글자 이동처럼 **합성 단계에서 움직이는 것**을
 * 흐린다. 파일을 굽지 않으므로 껐다 켜는 데 대기 시간이 없다.
 */
function TransformBlurEditor({
  value,
  patch,
}: {
  value: TransformBlur | undefined;
  patch: (p: Record<string, unknown>) => void;
}) {
  return (
    <>
      <CheckField
        label="움직임 블러"
        checked={!!value}
        onCommit={(v) => patch({ transformBlur: v ? DEFAULT_TRANSFORM_BLUR : null })}
      />
      {value ? (
        <>
          <SliderField
            label="셔터 각도"
            value={value.shutterAngle}
            min={0}
            max={360}
            step={5}
            digits={0}
            onCommit={(v) => patch({ transformBlur: { ...value, shutterAngle: v } })}
          />
          <SliderField
            label="겹쳐 그릴 장수"
            value={value.samples}
            min={4}
            max={32}
            step={1}
            digits={0}
            onCommit={(v) => patch({ transformBlur: { ...value, samples: Math.round(v) } })}
          />
          <p className="insp-badge">
            빠른 미리보기(WebGL)에는 안 나옵니다 — 렌더와 Remotion 미리보기에만 걸립니다.
          </p>
          <p className="insp-note">
            한 프레임을 그릴 때 셔터가 열려 있는 동안의 위치를 장수만큼 계산해 겹쳐 그립니다.
            소스 영상 «속» 피사체는 이걸로 안 흐려집니다 — 그건 비디오 클립의 「원본 보정 → 모션
            블러 (소스)」입니다.
          </p>
        </>
      ) : null}
    </>
  );
}

function TransitionEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Transition | undefined;
  onChange: (t: Transition | null) => void;
}) {
  // 51종을 평평하게 늘어놓으면 못 찾는다 — 갈래별 optgroup 으로 묶는다.
  // (SelectField 는 optgroup 을 모르므로 여기서 <select> 를 직접 그린다. Row 는 그대로 쓴다.)
  return (
    <>
      <Row label={label}>
        <select
          className="insp-select"
          value={value?.type ?? 'none'}
          onChange={(e) => {
            const v = e.target.value;
            onChange(
              v === 'none' ? null : { type: v as TransitionType, duration: value?.duration ?? 500 },
            );
          }}
        >
          <option value="none">없음</option>
          {transitionOptionGroups().map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Row>
      {value ? (
        <NumberField
          label="전환 길이"
          value={value.duration}
          min={50}
          max={5000}
          step={50}
          suffix="ms"
          onCommit={(v) => onChange({ type: value.type, duration: v })}
        />
      ) : null}
    </>
  );
}
