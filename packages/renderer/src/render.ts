// 노드 전용 렌더 파이프라인 (C4): bundle 캐시 → 임시 정적 서버 → selectComposition → renderMedia
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { ProjectDoc } from '@kitkat/schema';
import { docDurationMs, msToFrames } from './composition/keyframes.js';
import { startStaticServer } from './static-server.js';

let bundlePromise: Promise<string> | null = null;

/** Remotion 웹팩 번들 (프로세스 내 캐시). */
function getServeUrl(): Promise<string> {
  if (!bundlePromise) {
    const entryPoint = fileURLToPath(new URL('./root.js', import.meta.url));
    bundlePromise = bundle({ entryPoint });
    bundlePromise.catch(() => {
      bundlePromise = null;
    });
  }
  return bundlePromise;
}

/**
 * Chromium 의 WebGL2 백엔드 (W8 S5-a).
 *
 * **기본은 `null`(Chrome 자율) 이다.** W8 계약 초안은 GPU 사고 이력 때문에 `'swangle'` 을
 * 기본으로 하자고 했는데, 이 컴퓨터에서 실측해 보니 그 전제가 틀렸다:
 *
 * | gl | WebGL2 | 실제 렌더러 | 렌더 시간(효과 많은 5초 프로젝트) |
 * |---|---|---|---|
 * | `null` | **된다** | ANGLE Vulkan **SwiftShader** (이미 소프트웨어, GPU 미사용) | **120.8초** |
 * | `'swangle'` | 된다 | 같은 SwiftShader | **793.2초 (6.57배)** |
 * | `'angle'` | 된다 | Intel Iris Xe D3D11 (**진짜 GPU**) | — |
 *
 * 즉 ① `null` 이 이미 GPU 를 안 쓰므로 회피 목적이 달성돼 있고 ② `null` 로도 WebGL2 가 잡히며
 * ③ `'swangle'` 은 Chromium 의 래스터·합성 경로 전체를 소프트웨어로 돌려 6.57배 느려지는데
 * ④ **렌더 결과의 재현성마저 깨진다**(`null` 은 6회 렌더 md5 동일, `'swangle'` 은 2회가 서로 다름).
 *
 * GPU 를 실제로 켜는 것은 `'angle'` 쪽이므로, **GPU 를 피하려면 `null` 또는 `'swangle'`,
 * 절대 `'angle'` 을 기본으로 두지 마라.**
 */
export type GlBackend = 'swangle' | 'angle' | 'swiftshader' | 'egl' | null;

const DEFAULT_GL: GlBackend = null;

function chromiumOptionsFor(gl: GlBackend | undefined): { gl: GlBackend } {
  return { gl: gl === undefined ? DEFAULT_GL : gl };
}

/** opts.range(ms) → renderMedia 의 frameRange(프레임) + 실제 렌더 길이(ms). */
function resolveFrameRange(
  range: { start: number; end: number } | undefined,
  durationInFrames: number,
  fps: number,
  totalMs: number,
): { frameRange: [number, number] | null; renderedMs: number } {
  if (!range) return { frameRange: null, renderedMs: totalMs };
  const lastFrame = durationInFrames - 1;
  const start = Math.min(Math.max(0, msToFrames(range.start, fps)), lastFrame);
  const end = Math.min(Math.max(start, msToFrames(range.end, fps) - 1), lastFrame);
  return { frameRange: [start, end], renderedMs: Math.round(((end - start + 1) * 1000) / fps) };
}

/**
 * 영상에 박히는 오디오 코덱. h264 는 `['aac','pcm-16','mp3']`, prores 는 `['aac','pcm-16']` 를
 * 받는다 (`@remotion/renderer` 의 `supportedAudioCodecs`).
 *
 * **미지정이면 넘기지 않는다** — Remotion 기본값(h264 → aac, prores → pcm-16)이 그대로 간다.
 * 기존 호출자의 결과물이 한 바이트도 안 바뀌게 하려는 것이다.
 */
export type RenderAudioCodec = 'aac' | 'pcm-16' | 'mp3';

export type RenderProjectOptions = {
  /**
   * 잡 큐가 시간 초과로 포기할 때 abort 된다 — Remotion 의 취소 신호로 이어 **브라우저 렌더를 멈춘다**.
   * 없으면 큐만 넘어가고 렌더는 끝까지(몇 분이든) 계속된다 (W8 F17 리뷰 #12).
   */
  signal?: AbortSignal;
  mediaDir: string; // 내부 임시 정적 서버로 서빙(mediaBase 자동 구성)
  outPath: string; // .mp4 (gif 변환은 서버 담당) / transparent면 .mov
  range?: { start: number; end: number };
  proxy?: boolean;
  width?: number;
  height?: number;
  fps?: number; // doc.settings 오버라이드
  /** 알파 보존 출력 (ProRes 4444 / yuva444p10le). 배경도 그리지 않는다 (X5-c). */
  transparent?: boolean;
  /** WebGL2 백엔드. 미지정이면 null(Chrome 자율 = 이 컴퓨터에선 SwiftShader). */
  gl?: GlBackend;
  /**
   * 영상 안 오디오의 코덱. 미지정이면 Remotion 기본값(h264 → aac 192k).
   *
   * 사이드체인 더킹의 «스템 뺄셈»(F17 V5-6)이 `'pcm-16'` 을 쓴다 — 「전체 − 트리거 = 눌릴 스템」
   * 이 성립하려면 전체 믹스가 **무손실**이어야 한다(aac 192k 는 잔차 −17.6dB 로 들린다).
   */
  audioCodec?: RenderAudioCodec;
  onProgress?: (p: number) => void;
};

export async function renderProject(
  doc: ProjectDoc,
  opts: RenderProjectOptions,
): Promise<{ outPath: string; durationMs: number }> {
  const settings = {
    ...doc.settings,
    ...(opts.width != null ? { width: opts.width } : {}),
    ...(opts.height != null ? { height: opts.height } : {}),
    ...(opts.fps != null ? { fps: opts.fps } : {}),
  };
  const effectiveDoc: ProjectDoc = { ...doc, settings };
  const fps = settings.fps;
  const totalMs = docDurationMs(effectiveDoc);
  const transparent = opts.transparent === true;

  // AbortSignal(잡 큐) → Remotion cancelSignal 브리지. abort 되면 진행 중인 브라우저 렌더가 멈춘다.
  const { cancelSignal, cancel } = makeCancelSignal();
  opts.signal?.addEventListener('abort', () => cancel(), { once: true });
  const serveUrl = await getServeUrl();
  const staticServer = await startStaticServer(opts.mediaDir);
  try {
    const inputProps = {
      doc: effectiveDoc,
      mediaBase: staticServer.url,
      proxy: opts.proxy === true,
      ...(transparent ? { transparent: true } : {}),
    };
    const composition = await selectComposition({ serveUrl, id: 'timeline', inputProps });

    const { frameRange, renderedMs } = resolveFrameRange(
      opts.range,
      composition.durationInFrames,
      fps,
      totalMs,
    );

    const onProgress = ({ progress }: { progress: number }): void => {
      opts.onProgress?.(progress);
    };
    const chromiumOptions = chromiumOptionsFor(opts.gl);
    // 미지정이면 아예 안 넘긴다 — Remotion 기본값이 그대로 가야 기존 호출자가 안 바뀐다.
    const audioCodecOpt = opts.audioCodec ? { audioCodec: opts.audioCodec } : {};

    if (transparent) {
      // 알파 보존: ProRes 4444 + yuva444p10le, 중간 프레임은 알파가 있는 png
      await renderMedia({
        composition,
        serveUrl,
        cancelSignal,
        codec: 'prores',
        proResProfile: '4444',
        pixelFormat: 'yuva444p10le',
        imageFormat: 'png',
        inputProps,
        outputLocation: opts.outPath,
        frameRange,
        onProgress,
        chromiumOptions,
        ...audioCodecOpt,
      });
    } else {
      // 최종 렌더는 항상 Remotion 내장 x264 (Global Constraints — detectEncoder와 무관)
      await renderMedia({
        composition,
        serveUrl,
        cancelSignal,
        codec: 'h264',
        crf: 18,
        inputProps,
        outputLocation: opts.outPath,
        frameRange,
        onProgress,
        chromiumOptions,
        ...audioCodecOpt,
      });
    }

    return { outPath: opts.outPath, durationMs: renderedMs };
  } finally {
    await staticServer.close();
  }
}

export type RenderAudioStemOptions = {
  /**
   * 잡 큐가 시간 초과로 포기할 때 abort 된다 — Remotion 의 취소 신호로 이어 **브라우저 렌더를 멈춘다**.
   * 없으면 큐만 넘어가고 렌더는 끝까지(몇 분이든) 계속된다 (W8 F17 리뷰 #12).
   */
  signal?: AbortSignal;
  mediaDir: string;
  outPath: string; // .wav
  /** 이 트랙만 살리고 나머지는 muted. 빈 배열이면 전부 muted = 무음 wav (오류 아님). */
  soloTrackIds: string[];
  range?: { start: number; end: number };
  onProgress?: (p: number) => void;
};

/**
 * 오디오 전용 스템 렌더 (W8 S5-b) — F12 사이드체인 더킹의 입력.
 *
 * doc 을 **복제**해 `tracks[].muted` 를 조작한다(원본 doc 은 변형하지 않는다).
 * Remotion 은 오디오를 자체 ffmpeg 파이프라인으로 섞고 `wav` 가 유효 코덱이라 프레임을
 * 그리지 않는다 — 실측 1080×1920 5초에서 영상+오디오 22.2초 vs 오디오 전용 12.7초.
 */
export async function renderAudioStem(
  doc: ProjectDoc,
  opts: RenderAudioStemOptions,
): Promise<{ outPath: string; durationMs: number }> {
  const missing = opts.soloTrackIds.filter((id) => !doc.tracks.some((t) => t.id === id));
  if (missing.length > 0) {
    throw new Error(
      `스템 렌더: 문서에 없는 트랙 id 입니다 — ${missing.join(', ')} ` +
        `(문서의 트랙: ${doc.tracks.map((t) => t.id).join(', ') || '없음'})`,
    );
  }
  const solo = new Set(opts.soloTrackIds);
  // 원본을 건드리지 않는다 — 트랙 배열과 트랙 객체를 새로 만든다.
  const stemDoc: ProjectDoc = {
    ...doc,
    tracks: doc.tracks.map((t) => ({ ...t, muted: !solo.has(t.id) })),
  };

  const fps = stemDoc.settings.fps;
  const totalMs = docDurationMs(stemDoc);

  // AbortSignal(잡 큐) → Remotion cancelSignal 브리지. abort 되면 진행 중인 브라우저 렌더가 멈춘다.
  const { cancelSignal, cancel } = makeCancelSignal();
  opts.signal?.addEventListener('abort', () => cancel(), { once: true });
  const serveUrl = await getServeUrl();
  const staticServer = await startStaticServer(opts.mediaDir);
  try {
    // 스템은 최종 믹스에 들어가므로 프록시(96k aac) 음원을 쓰지 않는다.
    const inputProps = { doc: stemDoc, mediaBase: staticServer.url, proxy: false };
    const composition = await selectComposition({ serveUrl, id: 'timeline', inputProps });
    const { frameRange, renderedMs } = resolveFrameRange(
      opts.range,
      composition.durationInFrames,
      fps,
      totalMs,
    );

    await renderMedia({
      composition,
      serveUrl,
      cancelSignal,
      codec: 'wav',
      inputProps,
      outputLocation: opts.outPath,
      frameRange,
      onProgress: ({ progress }) => opts.onProgress?.(progress),
      chromiumOptions: chromiumOptionsFor(undefined),
    });

    return { outPath: opts.outPath, durationMs: renderedMs };
  } finally {
    await staticServer.close();
  }
}

export type RenderCoverOptions = {
  /**
   * 잡 큐가 시간 초과로 포기할 때 abort 된다 — Remotion 의 취소 신호로 이어 **브라우저 렌더를 멈춘다**.
   * 없으면 큐만 넘어가고 렌더는 끝까지(몇 분이든) 계속된다 (W8 F17 리뷰 #12).
   */
  signal?: AbortSignal;
  mediaDir: string;
  outPath: string; // .jpg
  timeMs: number; // 커버로 쓸 타임라인 시각
  proxy?: boolean;
  /** WebGL2 백엔드. 미지정이면 null(Chrome 자율 = 이 컴퓨터에선 SwiftShader). */
  gl?: GlBackend;
};

/** 커버(대표 이미지) 1장 — renderStill, jpeg 품질 90 (X5-c). */
export async function renderCover(
  doc: ProjectDoc,
  opts: RenderCoverOptions,
): Promise<{ outPath: string }> {
  const fps = doc.settings.fps;
  // AbortSignal(잡 큐) → Remotion cancelSignal 브리지. abort 되면 진행 중인 브라우저 렌더가 멈춘다.
  const { cancelSignal, cancel } = makeCancelSignal();
  opts.signal?.addEventListener('abort', () => cancel(), { once: true });
  const serveUrl = await getServeUrl();
  const staticServer = await startStaticServer(opts.mediaDir);
  try {
    const inputProps = { doc, mediaBase: staticServer.url, proxy: opts.proxy === true };
    const composition = await selectComposition({ serveUrl, id: 'timeline', inputProps });
    const lastFrame = Math.max(0, composition.durationInFrames - 1);
    const frame = Math.min(Math.max(0, msToFrames(opts.timeMs, fps)), lastFrame);
    await renderStill({
      composition,
      serveUrl,
      cancelSignal,
      inputProps,
      output: opts.outPath,
      frame,
      imageFormat: 'jpeg',
      jpegQuality: 90,
      chromiumOptions: chromiumOptionsFor(opts.gl),
    });
    return { outPath: opts.outPath };
  } finally {
    await staticServer.close();
  }
}
