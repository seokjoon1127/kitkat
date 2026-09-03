// 스테이지 목록을 하나의 <filter> 로 이어 붙인다 (계획 X5-b).
// 클립 하나에 <filter> 가 최대 둘이다 — 커브 전용(`curves-<id>`)과 효과+크로마키(`fx-<id>`).
// 전체 적용 순서: 커브 → CSS 효과 → 효과 SVG(배열 순서) → 크로마키.
import React from 'react';
import type { VisualSvgFilter } from '../layout/index.js';
import {
  edgeKernel,
  glowThreshold,
  n4,
  sharpenKernel,
  tableValuesString,
  thresholdTransfer,
  type ChromaKeyParams,
} from './svg-data.js';

type TableData = { r: number[]; g: number[]; b: number[] };
type MatrixData = { values: string };
type GlowData = { amount: number; radius: number };
/** 방향성 블러의 X·Y 표준편차(px). 한쪽이 0 이면 그 방향으로만 번진다. */
export type DirBlurData = { x: number; y: number };

/** RGB 3채널 table 전이 (커브 · highlights · shadows 공용). */
function tableStage(prev: string, id: string, d: TableData): React.ReactElement {
  return (
    <feComponentTransfer key={id} in={prev} result={id}>
      <feFuncR type="table" tableValues={tableValuesString(d.r)} />
      <feFuncG type="table" tableValues={tableValuesString(d.g)} />
      <feFuncB type="table" tableValues={tableValuesString(d.b)} />
    </feComponentTransfer>
  );
}

/** 하이라이트만 뽑아 흐린 뒤 screen 으로 되얹는다 → 밝은 곳만 번진다. */
function glowStage(prev: string, id: string, d: GlowData): React.ReactElement[] {
  const { slope, intercept } = glowThreshold();
  return [
    <feComponentTransfer key={`${id}h`} in={prev} result={`${id}h`}>
      <feFuncR type="linear" slope={slope} intercept={intercept} />
      <feFuncG type="linear" slope={slope} intercept={intercept} />
      <feFuncB type="linear" slope={slope} intercept={intercept} />
    </feComponentTransfer>,
    <feGaussianBlur key={`${id}b`} in={`${id}h`} stdDeviation={n4(d.radius / 2)} result={`${id}b`} />,
    <feComponentTransfer key={`${id}s`} in={`${id}b`} result={`${id}s`}>
      <feFuncR type="linear" slope={n4(d.amount)} />
      <feFuncG type="linear" slope={n4(d.amount)} />
      <feFuncB type="linear" slope={n4(d.amount)} />
    </feComponentTransfer>,
    <feBlend key={id} in={prev} in2={`${id}s`} mode="screen" result={id} />,
  ];
}

const ONLY_R = '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0';
const ONLY_G = '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0';
const ONLY_B = '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0';

/** R/B 채널만 좌우로 밀고 G 는 제자리 — 채널이 겹치지 않으므로 screen 합성이 곧 재조합. */
function chromaShiftStage(prev: string, id: string, px: number): React.ReactElement[] {
  return [
    <feOffset key={`${id}ro`} in={prev} dx={n4(-px)} dy={0} result={`${id}ro`} />,
    <feColorMatrix key={`${id}r`} in={`${id}ro`} type="matrix" values={ONLY_R} result={`${id}r`} />,
    <feOffset key={`${id}bo`} in={prev} dx={n4(px)} dy={0} result={`${id}bo`} />,
    <feColorMatrix key={`${id}b`} in={`${id}bo`} type="matrix" values={ONLY_B} result={`${id}b`} />,
    <feColorMatrix key={`${id}g`} in={prev} type="matrix" values={ONLY_G} result={`${id}g`} />,
    <feBlend key={`${id}rg`} in={`${id}r`} in2={`${id}g`} mode="screen" result={`${id}rg`} />,
    <feBlend key={id} in={`${id}rg`} in2={`${id}b`} mode="screen" result={id} />,
  ];
}

/**
 * 크로마키 (계획 W6 T1) — 색차 공간 투영 + 디스필.
 *
 *   m      = c·rgb                        휘도를 뺀 색차를 키 색 방향에 투영 (밝기와 무관)
 *   alpha' = A_in · clamp01((t + w/2 - m)/w)
 *   rgb'   = rgb + max(0, m - t)·v        v = -spill·ĉ_key (색차 방향으로만 빼서 휘도 보존)
 *
 * **채널 패킹** — 어느 primitive 가 무슨 채널에 무엇을 담는지 (헷갈리기 쉬우니 명시한다):
 *
 * | result   | R,G,B                    | A            | 왜 |
 * |----------|--------------------------|--------------|----|
 * | `<id>q`  | clamp01(m - t)  (세 채널 같은 값) | 1     | 임계 초과분 q. 필터 표면이 0..1 로 잘리므로 clamp 가 곧 `max(0,·)` |
 * | `<id>e`  | 0.5 + 0.5·q·v_c          | 1            | 디스필 증분은 채널마다 **부호가 다르다**(초록 키면 R·B 는 +, G 는 −) → 0.5 오프셋으로 담는다 |
 * | `<id>d`  | rgb + q·v                | 1            | `arithmetic k2=1 k3=2 k4=-1` = in + 2·e − 1 |
 * | `<id>r`  | 0                        | 램프         | 램프는 R·G·B 의 선형 결합이라 **알파 행 한 줄**로 끝난다 |
 * | `<id>`   | d 의 RGB                 | 램프 · A_in  | `in` 두 번: d⟂r 로 알파를 얹고, 다시 이전 단계와 `in` 해서 **입력 알파를 곱한다** |
 *
 * A 를 1 로 고정해 두는 이유: SVG 필터 표면은 프리멀티플라이드라 알파가 0 이면 RGB 가 사라진다.
 * 마지막에 이전 단계와 한 번 더 `in` 하는 이유: 미디어 **바깥**(투명=검정)은 m=0 이라 램프가 1 이
 * 되어 검게 칠해진다 — 원본 알파를 다시 곱해야 그 영역이 투명하게 남는다.
 */
function chromaKeyStage(prev: string, id: string, p: ChromaKeyParams): React.ReactElement[] {
  const [cr, cg, cb] = p.c;
  const nodes: React.ReactElement[] = [];
  let color = prev; // 디스필까지 끝난 RGB 를 담은 이미지

  if (p.despill && !p.disabled) {
    // q = clamp01(m - t) — 세 채널에 같은 값, 알파는 1 로 고정
    nodes.push(
      <feColorMatrix
        key={`${id}q`}
        in={prev}
        type="matrix"
        values={[
          `${n4(cr)} ${n4(cg)} ${n4(cb)} 0 ${n4(-p.t)}`,
          `${n4(cr)} ${n4(cg)} ${n4(cb)} 0 ${n4(-p.t)}`,
          `${n4(cr)} ${n4(cg)} ${n4(cb)} 0 ${n4(-p.t)}`,
          '0 0 0 0 1',
        ].join(' ')}
        result={`${id}q`}
      />,
    );
    // e = 0.5 + 0.5·q·v — R 채널(=q)만 읽어 채널별 v 를 곱한다
    nodes.push(
      <feColorMatrix
        key={`${id}e`}
        in={`${id}q`}
        type="matrix"
        values={[
          `${n4(0.5 * p.v[0])} 0 0 0 0.5`,
          `0 ${n4(0.5 * p.v[1])} 0 0 0.5`,
          `0 0 ${n4(0.5 * p.v[2])} 0 0.5`,
          '0 0 0 0 1',
        ].join(' ')}
        result={`${id}e`}
      />,
    );
    // d = prev + 2·e - 1 = rgb + q·v (알파는 1+2-1=2 → 1 로 클램프)
    nodes.push(
      <feComposite
        key={`${id}d`}
        in={prev}
        in2={`${id}e`}
        operator="arithmetic"
        k1={0}
        k2={1}
        k3={2}
        k4={-1}
        result={`${id}d`}
      />,
    );
    color = `${id}d`;
  }

  // r = 알파 램프만 담은 이미지 (RGB 는 0). alpha = clamp01((t + w/2 - m)/w)
  const g = 1 / p.w;
  nodes.push(
    <feColorMatrix
      key={`${id}r`}
      in={prev}
      type="matrix"
      values={[
        '0 0 0 0 0',
        '0 0 0 0 0',
        '0 0 0 0 0',
        `${n4(-cr * g)} ${n4(-cg * g)} ${n4(-cb * g)} 0 ${n4((p.t + p.w / 2) * g)}`,
      ].join(' ')}
      result={`${id}r`}
    />,
  );
  // 디스필한 RGB 에 램프 알파를 얹고(첫 in), 원본 알파를 다시 곱한다(둘째 in)
  nodes.push(
    <feComposite key={`${id}k`} in={color} in2={`${id}r`} operator="in" result={`${id}k`} />,
  );
  nodes.push(<feComposite key={id} in={`${id}k`} in2={prev} operator="in" result={id} />);
  return nodes;
}

/**
 * 방향성 블러 (W8 F3-C) — `stdDeviation` 은 X·Y 를 **따로** 받는다.
 * 한쪽이 0 이면 그 방향으로만 번진다: `"20 0"` = 가로로만, `"0 20"` = 세로로만 (MDN 확인).
 *
 * 축에 안 맞는 각도(예: 대각선 45°)를 하려면 바깥을 `rotate(θ)` 로 감싸고 안쪽을 `rotate(-θ)` 로
 * 되돌려야 한다 — CSS `filter` 는 내용에 먼저 걸리고 그 결과에 `transform` 이 걸리기 때문이다.
 * **지금은 아무도 그게 필요 없다** (전환의 이동 방향이 전부 가로·세로거나 등방이다) →
 * 만들지 않았다. 대각선 휩팬이 생기면 그때 여기에 회전 샌드위치를 넣는다.
 */
function dirBlurStage(prev: string, id: string, d: DirBlurData): React.ReactElement {
  return (
    <feGaussianBlur
      key={id}
      in={prev}
      stdDeviation={`${n4(Math.max(0, d.x))} ${n4(Math.max(0, d.y))}`}
      edgeMode="none"
      result={id}
    />
  );
}

// ═══ W8 F16 신규 스테이지 ═══════════════════════════════════════════════════

type BloomData = { amount: number; radius: number; threshold: number; tint: [number, number, number] };
type BlurMixData = { amount: number; radius: number; mode: 'unsharp' | 'screen' };

/**
 * glow 의 일반형 — 임계와 «색»을 열어 준다.
 * threshold 위쪽만 남겨 흐린 다음 tint 를 곱하고 screen 으로 되얹는다.
 * tint 가 (1,1,1) 이면 블룸, 붉은 쪽으로 치우치면 할레이션이다.
 */
function bloomStage(prev: string, id: string, d: BloomData): React.ReactElement[] {
  const { slope, intercept } = thresholdTransfer(d.threshold);
  const [tr, tg, tb] = d.tint;
  return [
    <feComponentTransfer key={`${id}h`} in={prev} result={`${id}h`}>
      <feFuncR type="linear" slope={slope} intercept={intercept} />
      <feFuncG type="linear" slope={slope} intercept={intercept} />
      <feFuncB type="linear" slope={slope} intercept={intercept} />
    </feComponentTransfer>,
    <feGaussianBlur key={`${id}b`} in={`${id}h`} stdDeviation={n4(d.radius / 2)} result={`${id}b`} />,
    <feComponentTransfer key={`${id}s`} in={`${id}b`} result={`${id}s`}>
      <feFuncR type="linear" slope={n4(d.amount * tr)} />
      <feFuncG type="linear" slope={n4(d.amount * tg)} />
      <feFuncB type="linear" slope={n4(d.amount * tb)} />
    </feComponentTransfer>,
    <feBlend key={id} in={prev} in2={`${id}s`} mode="screen" result={id} />,
  ];
}

/**
 * 흐린 사본과 섞는다.
 * - `unsharp` = 로컬 대비. `prev + a·(prev − blur)` 를 `k2=1+a, k3=−a` 한 번으로 끝낸다.
 *   반경이 20px 이라 3x3 샤픈(가장자리만)과 **다른 그림**이다 — 덩어리 단위로 살아난다.
 * - `screen`  = 소프트 포커스(오튼). 흐린 사본을 screen 으로 얹어 밝은 곳이 뭉개지며 퍼진다.
 */
function blurMixStage(prev: string, id: string, d: BlurMixData): React.ReactElement[] {
  const blur = (
    <feGaussianBlur key={`${id}b`} in={prev} stdDeviation={n4(d.radius / 2)} result={`${id}b`} />
  );
  if (d.mode === 'screen') {
    return [
      blur,
      <feComponentTransfer key={`${id}o`} in={`${id}b`} result={`${id}o`}>
        <feFuncR type="linear" slope={n4(d.amount)} />
        <feFuncG type="linear" slope={n4(d.amount)} />
        <feFuncB type="linear" slope={n4(d.amount)} />
      </feComponentTransfer>,
      <feBlend key={id} in={prev} in2={`${id}o`} mode="screen" result={id} />,
    ];
  }
  return [
    blur,
    <feComposite
      key={id}
      in={prev}
      in2={`${id}b`}
      operator="arithmetic"
      k1={0}
      k2={n4(1 + d.amount)}
      k3={n4(-d.amount)}
      k4={0}
      result={id}
    />,
  ];
}

/**
 * 픽셀화 — SVG 에는 «축소 후 확대» 가 없어서 다음 순서로 만든다:
 *   1×1 점을 흘리고 → cell×cell 영역으로 자르고 → feTile 로 점 격자를 만들고 →
 *   원본을 그 점들로만 잘라 내고(`in`) → feMorphology dilate 로 각 점을 셀 크기로 부풀린다.
 * dilate 는 채널별 «최댓값»을 취하는데 이웃이 전부 투명(0)이라 그 점의 색이 그대로 퍼진다.
 * primitive subregion(x/y/width/height)은 사용자 좌표계 px 이라 cell 이 곧 화면 px 이다.
 */
function pixelateStage(prev: string, id: string, d: { cell: number; radius: number }): React.ReactElement[] {
  return [
    <feFlood key={`${id}f`} floodColor="#ffffff" floodOpacity={1} x={0} y={0} width={1} height={1}
      result={`${id}f`} />,
    <feComposite key={`${id}c`} in={`${id}f`} in2={`${id}f`} operator="over"
      x={0} y={0} width={d.cell} height={d.cell} result={`${id}c`} />,
    <feTile key={`${id}t`} in={`${id}c`} result={`${id}t`} />,
    <feComposite key={`${id}s`} in={prev} in2={`${id}t`} operator="in" result={`${id}s`} />,
    <feMorphology key={id} in={`${id}s`} operator="dilate" radius={d.radius} result={id} />,
  ];
}

/** 물결 — 난류 무늬를 «변위 지도»로 써서 픽셀을 밀어낸다. */
function displaceStage(prev: string, id: string, d: { scale: number; freq: number }): React.ReactElement[] {
  return [
    <feTurbulence key={`${id}n`} type="turbulence" baseFrequency={n4(d.freq)} numOctaves={2}
      seed={7} stitchTiles="stitch" result={`${id}n`} />,
    <feDisplacementMap key={id} in={prev} in2={`${id}n`} scale={n4(d.scale)}
      xChannelSelector="R" yChannelSelector="G" result={id} />,
  ];
}

/**
 * 엠보스 — 한 칸 어긋난 사본과의 «차이»에 0.5 를 더한다(`in + 0.5 − shifted`).
 * feConvolveMatrix 의 `bias` 를 쓰지 않는 이유: bias 는 브라우저마다 구현이 갈린다.
 * feOffset + arithmetic 은 어디서나 같은 결과를 낸다.
 */
function embossStage(prev: string, id: string, d: { amount: number; px: number }): React.ReactElement[] {
  return [
    <feOffset key={`${id}o`} in={prev} dx={d.px} dy={d.px} result={`${id}o`} />,
    <feComposite key={`${id}d`} in={prev} in2={`${id}o`} operator="arithmetic"
      k1={0} k2={n4(d.amount)} k3={n4(-d.amount)} k4={0.5} result={`${id}d`} />,
    <feColorMatrix key={id} in={`${id}d`} type="saturate" values="0" result={id} />,
  ];
}

/** 스테이지 목록 → <filter> 자식 노드. */
export function buildFilterNodes(stages: VisualSvgFilter[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let prev = 'SourceGraphic';
  for (const st of stages) {
    switch (st.kind) {
      case 'curves':
        nodes.push(tableStage(prev, st.id, st.data as TableData));
        break;
      case 'colorMatrix':
        nodes.push(
          <feColorMatrix
            key={st.id}
            in={prev}
            type="matrix"
            values={(st.data as MatrixData).values}
            result={st.id}
          />,
        );
        break;
      case 'chromaKey':
        nodes.push(...chromaKeyStage(prev, st.id, st.data as ChromaKeyParams));
        break;
      case 'sharpen': {
        const k = sharpenKernel((st.data as { amount: number }).amount);
        nodes.push(
          <feConvolveMatrix
            key={st.id}
            in={prev}
            order={k.order}
            kernelMatrix={k.kernelMatrix}
            divisor={k.divisor}
            edgeMode="duplicate"
            preserveAlpha="true"
            result={st.id}
          />,
        );
        break;
      }
      case 'glow':
        nodes.push(...glowStage(prev, st.id, st.data as GlowData));
        break;
      case 'chromaShift':
        nodes.push(...chromaShiftStage(prev, st.id, (st.data as { px: number }).px));
        break;
      case 'dirBlur':
        nodes.push(dirBlurStage(prev, st.id, st.data as DirBlurData));
        break;

      // ── W8 F16 신규 ──
      case 'discrete': {
        const values = (st.data as { values: number[] }).values.map((v) => n4(v)).join(' ');
        nodes.push(
          <feComponentTransfer key={st.id} in={prev} result={st.id}>
            <feFuncR type="discrete" tableValues={values} />
            <feFuncG type="discrete" tableValues={values} />
            <feFuncB type="discrete" tableValues={values} />
          </feComponentTransfer>,
        );
        break;
      }
      case 'linearTransfer': {
        const d = st.data as { slope: number; intercept: number };
        nodes.push(
          <feComponentTransfer key={st.id} in={prev} result={st.id}>
            <feFuncR type="linear" slope={n4(d.slope)} intercept={n4(d.intercept)} />
            <feFuncG type="linear" slope={n4(d.slope)} intercept={n4(d.intercept)} />
            <feFuncB type="linear" slope={n4(d.slope)} intercept={n4(d.intercept)} />
          </feComponentTransfer>,
        );
        break;
      }
      case 'bloom':
        nodes.push(...bloomStage(prev, st.id, st.data as BloomData));
        break;
      case 'blurMix':
        nodes.push(...blurMixStage(prev, st.id, st.data as BlurMixData));
        break;
      case 'pixelate':
        nodes.push(...pixelateStage(prev, st.id, st.data as { cell: number; radius: number }));
        break;
      case 'displace':
        nodes.push(...displaceStage(prev, st.id, st.data as { scale: number; freq: number }));
        break;
      case 'edge': {
        const k = edgeKernel((st.data as { amount: number }).amount);
        nodes.push(
          <feConvolveMatrix
            key={st.id}
            in={prev}
            order={k.order}
            kernelMatrix={k.kernelMatrix}
            divisor={k.divisor}
            edgeMode="duplicate"
            preserveAlpha="true"
            result={st.id}
          />,
        );
        break;
      }
      case 'emboss':
        nodes.push(...embossStage(prev, st.id, st.data as { amount: number; px: number }));
        break;
    }
    prev = st.id;
  }
  return nodes;
}

/**
 * 전환 방향성 블러 <filter> 들 (W8 F3-C). 전환 래퍼 div 에 `filter: url(#…)` 로 걸린다.
 *
 * 필터 영역을 넉넉히(-50%~200%) 잡는다 — 휩팬은 σ 가 60px 이라 기본 영역(±10%)에서는
 * 번진 자락이 «네모나게» 잘려 나간다.
 */
export const TransitionBlurDefs: React.FC<{
  blurs: { id: string; x: number; y: number; kind?: 'dirBlur' | 'rgbSplit' }[];
}> = ({ blurs }) => {
  if (blurs.length === 0) return null;
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        {blurs.map((b) => (
          <filter
            key={b.id}
            id={b.id}
            colorInterpolationFilters="sRGB"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            {/* W8 F16 — rgbSplit 전환은 같은 자리에 «채널 분리»를 건다 (x = 이동 px). */}
            {buildFilterNodes(
              b.kind === 'rgbSplit'
                ? [{ kind: 'chromaShift', id: `${b.id}s0`, data: { px: b.x } }]
                : [{ kind: 'dirBlur', id: `${b.id}s0`, data: { x: b.x, y: b.y } }],
            )}
          </filter>
        ))}
      </defs>
    </svg>
  );
};

export const ClipFilterDefs: React.FC<{
  id: string;
  stages: VisualSvgFilter[];
  wideRegion: boolean;
}> = ({ id, stages, wideRegion }) => {
  if (stages.length === 0) return null;
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        <filter
          id={id}
          colorInterpolationFilters="sRGB"
          {...(wideRegion ? { x: '-25%', y: '-25%', width: '150%', height: '150%' } : {})}
        >
          {buildFilterNodes(stages)}
        </filter>
      </defs>
    </svg>
  );
};
