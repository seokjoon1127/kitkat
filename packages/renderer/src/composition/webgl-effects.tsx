// W8 #8 — WebGL 효과 6종의 **렌더 쪽** 실행기: Remotion `createEffect`(backend webgl2).
//
// 셰이더·유니폼 수식은 gl-effects.ts(순수 모듈)에 있고 여기서는 그것을 Remotion 이펙트 규약에
// 끼워 넣기만 한다. 미리보기(ui/preview/gl-passes.ts)도 같은 모듈의 같은 문자열을 컴파일한다.
//
// 미디어를 어떻게 셰이더에 태우나:
//   - 이미지 → `<CanvasImage effects>` (Remotion 표준 경로. delayRender 를 라이브러리가 건다)
//   - 영상   → `<OffthreadVideo onVideoFrame>` 이 준 프레임 그림을 `Internals.runEffectChain` 으로
//             캔버스에 그린다 (`GlVideoEffects`). **이 경로는 delayRender 를 우리가 직접 건다** —
//             F17-A(V5-1)가 확인했듯 라이브러리 컴포넌트들이 각자 거는 것이지 체인이 대신 걸어 주지 않는다.
//
// 결과 캔버스에 CSS `filter`(커브 → CSS 효과 → SVG 체인)를 그대로 건다. 그래서 WebGL 효과는
// 언제나 그 체인 **앞**에 걸린다(gl-effects.ts 머리 주석).
import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
  CanvasImage,
  Internals,
  cancelRender,
  continueRender,
  createEffect,
  delayRender,
  getRemotionEnvironment,
  useCurrentFrame,
  type EffectApplyParams,
  type EffectDescriptor,
} from 'remotion';
import type { VisualGlStage } from '../layout/index.js';
import {
  GL_FULL_MEDIA,
  GL_STAGE_KINDS,
  GL_STAGE_LABEL,
  glStageUniforms,
  linkGlEffect,
  setGlUniforms,
  type GlStageData,
  type GlStageKind,
} from './gl-effects.js';

type GlState = {
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
  tex: WebGLTexture;
  vao: WebGLVertexArrayObject;
  buf: WebGLBuffer;
};

type GlParams = Record<string, number>;

function setup(kind: GlStageKind, target: HTMLCanvasElement): GlState {
  // 캔버스 풀이 이미 webgl2 컨텍스트를 만들어 뒀다(premultipliedAlpha·preserveDrawingBuffer) —
  // 같은 옵션으로 다시 부르면 같은 컨텍스트가 돌아온다.
  const gl = target.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) throw new Error(`WebGL 효과(${kind}): WebGL2 컨텍스트를 얻을 수 없습니다`);
  const { prog, loc } = linkGlEffect(gl, kind);
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray();
  const tex = gl.createTexture();
  if (!buf || !vao || !tex) throw new Error(`WebGL 효과(${kind}): 버퍼·텍스처를 만들 수 없습니다`);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { gl, prog, loc, tex, vao, buf };
}

function apply(kind: GlStageKind, p: EffectApplyParams<GlParams, GlState>): void {
  const { gl, prog, loc, tex, vao } = p.state;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // 셰이더 규약은 «v=0 이 미디어 위». DOM 방향 소스(flipSourceY=true)는 안 뒤집고 올리면 그렇게 된다.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !p.flipSourceY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.source as TexImageSource);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.viewport(0, 0, p.width, p.height);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  gl.uniform1i(loc.uSrc as WebGLUniformLocation, 0);
  // 화면 방향(위가 위)으로 그린다 — 정점에서 뒤집는다
  gl.uniform1f(loc.uFlipY as WebGLUniformLocation, 1);
  const stage = { kind, data: p.params } as GlStageData;
  setGlUniforms(gl, loc, glStageUniforms(stage, GL_FULL_MEDIA(p.width, p.height)));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

function cleanup(s: GlState): void {
  const { gl } = s;
  gl.deleteTexture(s.tex);
  gl.deleteVertexArray(s.vao);
  gl.deleteBuffer(s.buf);
  gl.deleteProgram(s.prog);
}

function validate(kind: GlStageKind, params: GlParams): void {
  for (const [k, v] of Object.entries(params)) {
    if (k === 'disabled') continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`WebGL 효과(${kind}): 파라미터 ${k} 가 숫자가 아닙니다 (${String(v)})`);
    }
  }
}

function makeFactory(kind: GlStageKind) {
  return createEffect<GlParams, GlState>({
    type: `kitkat.${kind}`,
    label: GL_STAGE_LABEL[kind],
    documentationLink: null,
    backend: 'webgl2',
    calculateKey: (params) => JSON.stringify(params),
    setup: (target) => setup(kind, target),
    apply: (p) => apply(kind, p),
    cleanup,
    schema: {},
    validateParams: (params) => validate(kind, params),
  });
}

/** 효과 종류별 Remotion 이펙트 팩토리. 파라미터는 `GlStageData['data']` 그대로다. */
export const GL_EFFECT_FACTORY = Object.fromEntries(
  GL_STAGE_KINDS.map((k) => [k, makeFactory(k)]),
) as Record<GlStageKind, ReturnType<typeof makeFactory>>;

/** 레이아웃의 WebGL 스테이지 → Remotion `effects` prop. */
export function glStageDescriptors(stages: readonly VisualGlStage[]): EffectDescriptor<unknown>[] {
  return stages.map((s) => GL_EFFECT_FACTORY[s.kind]({ ...(s.data as GlParams) }));
}

/** 스테이지 목록의 «내용» 키 — 같은 값이면 같은 디스크립터를 다시 쓴다. */
function stagesKey(stages: readonly VisualGlStage[]): string {
  return JSON.stringify(stages.map((s) => [s.kind, s.data]));
}

// ── 이미지 ────────────────────────────────────────────────────────────────

/** 이미지 클립 — Remotion 표준 `<CanvasImage>`. 캔버스 크기 = 미디어 자리(inner) px. */
export const GlImageMedia: React.FC<{
  src: string;
  width: number;
  height: number;
  stages: readonly VisualGlStage[];
  style: React.CSSProperties;
}> = ({ src, width, height, stages, style }) => {
  const key = stagesKey(stages);
  const effects = useMemo(() => glStageDescriptors(stages), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <CanvasImage
      src={src}
      width={Math.max(1, Math.round(width))}
      height={Math.max(1, Math.round(height))}
      fit="fill"
      effects={effects}
      style={style}
    />
  );
};

// ── 영상 ──────────────────────────────────────────────────────────────────

export type GlVideoFrameSource = CanvasImageSource;

/**
 * 영상 클립 — 자식(`<OffthreadVideo>` 트리)에게 `onVideoFrame` 을 건네 프레임 그림을 받고,
 * 그 그림을 이펙트 체인에 태워 옆의 캔버스에 그린다. 자식은 **숨긴 채** 둔다(소리·타이밍은 그대로).
 *
 * 렌더 중에는 프레임마다 `delayRender` → 체인 완료 + 다음 화면 갱신 → `continueRender` 다.
 * 프레임 그림이 안 오면 Remotion 의 delayRender 시간 초과로 **시끄럽게** 실패한다(조용히 빠지지 않는다).
 */
export const GlVideoEffects: React.FC<{
  width: number;
  height: number;
  stages: readonly VisualGlStage[];
  /** 결과 캔버스의 스타일 — 자리 + CSS filter(커브·CSS·SVG 체인) */
  style: React.CSSProperties;
  children: (onVideoFrame: (img: GlVideoFrameSource) => void) => React.ReactNode;
}> = ({ width, height, stages, style, children }) => {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const frame = useCurrentFrame();
  const { isRendering } = getRemotionEnvironment();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chain = Internals.useEffectChainState();
  const key = stagesKey(stages);
  const descriptors = useMemo(() => glStageDescriptors(stages), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const effects = Internals.useMemoizedEffects({ effects: descriptors, overrideId: null });
  const effectsRef = useRef(effects);
  effectsRef.current = effects;
  const latest = useRef<GlVideoFrameSource | null>(null);
  const handle = useRef<number | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const warned = useRef(false);

  const finish = useCallback((): void => {
    const hnd = handle.current;
    if (hnd === null) return;
    handle.current = null;
    // 캔버스가 실제로 화면에 올라간 뒤 풀어 준다 (<CanvasImage> 의 waitForNextFrame 과 같다)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => continueRender(hnd));
    else continueRender(hnd);
  }, []);

  const run = useCallback(async (): Promise<void> => {
    const img = latest.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const state = chain.get(w, h);
      if (!state) throw new Error('WebGL 효과: 이펙트 체인 상태를 만들 수 없습니다');
      const ok = await Internals.runEffectChain({
        state,
        source: img,
        effects: effectsRef.current,
        output: canvas,
        width: w,
        height: h,
      });
      if (ok) finish();
    } catch (err) {
      if (isRendering) {
        cancelRender(err);
        return;
      }
      // Player 미리보기에서 WebGL2 가 없을 때 — 최종 렌더가 아니므로 원본만 그리고 계속 간다.
      if (!warned.current) {
        warned.current = true;
        console.warn('WebGL 효과를 미리보기에서 그릴 수 없어 원본을 보여 줍니다:', err);
      }
      canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
      finish();
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void run();
      }
    }
  }, [chain, w, h, isRendering, finish]);

  useLayoutEffect(() => {
    if (!isRendering) return;
    const hnd = delayRender(`WebGL 효과 프레임 ${frame}`);
    handle.current = hnd;
    return () => {
      if (handle.current === hnd) {
        handle.current = null;
        continueRender(hnd);
      }
    };
  }, [frame, isRendering]);

  const onVideoFrame = useCallback(
    (img: GlVideoFrameSource): void => {
      latest.current = img;
      void run();
    },
    [run],
  );

  return (
    <>
      {children(onVideoFrame)}
      <canvas ref={canvasRef} width={w} height={h} style={style} />
    </>
  );
};
