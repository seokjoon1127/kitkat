// F6 실시간 스코프 — **계산은 여기서**. 메인 스레드(=재생 루프·React)를 막지 않는다.
//
// 들어오는 것: RGBA 픽셀 한 장(ArrayBuffer, transfer 로 넘어와 복사가 없다)
// 나가는 것:   종류별 ImageBitmap (transfer) + 평균 통계.
//
// 격자·라벨은 OffscreenCanvas 2D 로 그림 위에 겹친다. OffscreenCanvas 가 없는 환경이면
// 원시 그림(ImageLike)을 그대로 보내고 메인 스레드가 그린다 — **스코프가 사라지지는 않는다.**
import {
  computeScopes,
  drawHistogramGraticule,
  drawVectorGraticule,
  drawWaveformGraticule,
  scopeStats,
  type Ctx2D,
  type ImageLike,
  type ScopeKind,
  type ScopeStats,
} from './scopes.js';

export type ScopeWorkerRequest = {
  id: number;
  buffer: ArrayBuffer;
  width: number;
  height: number;
  kinds: ScopeKind[];
  /** 히스토그램 로그 스케일 */
  log?: boolean;
  /** 무엇을 본 표본인지 (응답에 그대로 돌려준다) */
  timeMs?: number;
};

export type ScopeWorkerResponse = {
  id: number;
  timeMs: number;
  /** ImageBitmap 이면 그대로 drawImage, ImageLike 면 putImageData 로 그린다. */
  images: Partial<Record<ScopeKind, ImageBitmap | ImageLike>>;
  stats: ScopeStats;
  /** 계산에 걸린 시간(ms) — 「워커가 진짜로 일하고 있나」를 UI 에서 본다. */
  computeMs: number;
};

const workerCtx = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
};

const hasOffscreen = typeof OffscreenCanvas !== 'undefined';

/** 그림 + 격자 → ImageBitmap. OffscreenCanvas 가 없으면 원본 그림을 그대로 돌려준다. */
function toBitmap(kind: ScopeKind, img: ImageLike): ImageBitmap | ImageLike {
  if (!hasOffscreen) return img;
  try {
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return img;
    // createImageData 로 만들고 채운다 — `new ImageData(data,…)` 는 버퍼 타입이 까다롭다
    const id = ctx.createImageData(img.width, img.height);
    id.data.set(img.data);
    ctx.putImageData(id, 0, 0);
    const c2 = ctx as unknown as Ctx2D;
    if (kind === 'vectorscope') drawVectorGraticule(c2, img.width);
    else if (kind === 'waveform') drawWaveformGraticule(c2, Math.round(img.width / 3));
    else drawHistogramGraticule(c2, img.width, img.height);
    return canvas.transferToImageBitmap();
  } catch {
    return img;
  }
}

/** 요청 하나를 처리한다. 테스트가 워커 없이 직접 부를 수 있게 내보낸다. */
export function handleScopeRequest(req: ScopeWorkerRequest): {
  response: ScopeWorkerResponse;
  transfer: Transferable[];
} {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const px = new Uint8Array(req.buffer);
  const raw = computeScopes(px, req.width, req.height, req.kinds, {
    waveform: { sampleH: req.height },
    histogram: { log: req.log === true },
  });
  const images: Partial<Record<ScopeKind, ImageBitmap | ImageLike>> = {};
  const transfer: Transferable[] = [];
  for (const kind of req.kinds) {
    const img = raw[kind];
    if (!img) continue;
    const out = toBitmap(kind, img);
    images[kind] = out;
    if (typeof ImageBitmap !== 'undefined' && out instanceof ImageBitmap) transfer.push(out);
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : 0;
  return {
    response: {
      id: req.id,
      timeMs: req.timeMs ?? 0,
      images,
      stats: scopeStats(px, req.width, req.height),
      computeMs: t1 - t0,
    },
    transfer,
  };
}

/**
 * 워커 안에서만 듣는다. 메인 스레드가 이 모듈을 그냥 import 해도(워커를 못 만들었을 때의
 * 대비책·테스트) window 의 message 이벤트를 가로채지 않게 막는 것이다.
 */
const inWorker =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' &&
  typeof (globalThis as { window?: unknown }).window === 'undefined';

if (inWorker) {
  workerCtx.addEventListener('message', (e: MessageEvent) => {
    const req = e.data as ScopeWorkerRequest;
    if (!req || typeof req.id !== 'number') return;
    const { response, transfer } = handleScopeRequest(req);
    workerCtx.postMessage(response, transfer);
  });
}
