// 에셋 분석·변환 라우트 (X6/M3·M4) — beats · separate · upscale · interpolate.
// 501/400 판정은 잡 등록 전에 끝낸다 (captions 라우트와 같은 방식).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { newId, type Asset } from '@kitkat/schema';
import type { Command } from '@kitkat/engine';
import {
  detectBeats,
  interpolateFps,
  isInterpolateAiReady,
  isUpscaleAiReady,
  probeAsset,
  upscaleVideo,
  INTERPOLATE_MODELS,
  UPSCALE_MODELS,
  type FrameProgress,
  type InterpEngine,
  type UpscaleEngine,
  type UpscaleModel,
} from '@kitkat/media';
import { AiUnavailableError, isDemucsReady, separateStems } from '@kitkat/ai';
import { sendError, type AppContext } from '../app.js';
import { enqueuePostprocess } from './assets.js';

const DEFAULT_UPSCALE: 2 | 3 | 4 = 2;
const DEFAULT_INTERPOLATE_FPS = 60;
const UPSCALE_ENGINES: UpscaleEngine[] = ['auto', 'ai', 'lanczos'];
const INTERP_ENGINES: InterpEngine[] = ['auto', 'ai', 'minterpolate'];

/** 「312/900 프레임」 — 퍼센트만으로는 남은 시간이 가늠이 안 되는 긴 잡에 붙인다. */
function frameDetail(frames?: FrameProgress): string | undefined {
  return frames && frames.total > 0 ? `${frames.done}/${frames.total} 프레임` : undefined;
}

export function registerMediaOpRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── 비트 감지 → asset.beats ─────────────────────────────────────────────
  app.post('/api/projects/:id/assets/:assetId/beats', async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    try {
      const doc = await ctx.store.get(id);
      const asset = doc.assets[assetId];
      if (!asset) return reply.code(404).send({ error: `에셋 없음: ${assetId}` });
      if (asset.kind !== 'audio' && asset.kind !== 'video') {
        return reply.code(400).send({ error: '오디오·비디오 에셋에서만 비트를 감지할 수 있습니다' });
      }

      const job = ctx.jobs.enqueue(
        'beats',
        id,
        async () => {
          const docNow = await ctx.store.get(id);
          const now = docNow.assets[assetId];
          if (!now) throw new Error(`에셋 없음: ${assetId}`);
          const beats = await detectBeats(path.join(ctx.mediaDir, now.src));
          await ctx.applyBatch(id, [{ type: 'updateAsset', assetId, patch: { beats } }]);
          return { beats: beats.length };
        },
        assetId,
      );
      return { jobId: job.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 보컬 분리 → audio 에셋 2개 ──────────────────────────────────────────
  app.post('/api/projects/:id/assets/:assetId/separate', async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    try {
      const doc = await ctx.store.get(id);
      const asset = doc.assets[assetId];
      if (!asset) return reply.code(404).send({ error: `에셋 없음: ${assetId}` });
      if (asset.kind !== 'audio') {
        return reply.code(400).send({ error: '오디오 에셋에서만 보컬을 분리할 수 있습니다' });
      }

      // Demucs 미설치 → 501. **설치를 여기서 시도하지 않는다** — PyTorch 포함 2.5GB 라
      // 요청 처리 중에 기다리면 클라이언트가 먼저 타임아웃난다(실측). 설치는 prewarm 으로 따로.
      try {
        if (!(await isDemucsReady())) {
          return reply.code(501).send({
            error:
              '보컬 분리 엔진(Demucs)이 설치되어 있지 않습니다. ' +
              '`node scripts/prewarm.mjs demucs` 로 먼저 설치하세요 (PyTorch 포함 약 2.5GB, 최초 1회).',
          });
        }
      } catch (err) {
        if (err instanceof AiUnavailableError) {
          return reply.code(501).send({ error: err.message });
        }
        throw err;
      }

      const sourceName = asset.name;
      const job = ctx.jobs.enqueue(
        'separate',
        id,
        async () => {
          const docNow = await ctx.store.get(id);
          const now = docNow.assets[assetId];
          if (!now) throw new Error(`에셋 없음: ${assetId}`);
          const outDir = path.join(ctx.mediaDir, 'derived', `${assetId}-stems`);
          await fs.mkdir(outDir, { recursive: true });
          const stems = await separateStems(path.join(ctx.mediaDir, now.src), outDir);

          const made: Asset[] = [];
          const commands: Command[] = [];
          for (const [abs, suffix] of [
            [stems.vocals, '보컬'],
            [stems.accompaniment, '반주'],
          ] as const) {
            const stemId = newId();
            const rel = `assets/${stemId}.wav`;
            await fs.copyFile(abs, path.join(ctx.mediaDir, rel));
            const probe = await probeAsset(path.join(ctx.mediaDir, rel)).catch(() => ({
              duration: now.duration,
            }));
            const stemAsset: Asset = {
              id: stemId,
              kind: 'audio',
              src: rel,
              name: `${sourceName} ${suffix}`,
              ...(probe.duration !== undefined ? { duration: probe.duration } : {}),
            };
            made.push(stemAsset);
            commands.push({ type: 'addAsset', asset: stemAsset });
          }
          await ctx.applyBatch(id, commands);
          await fs.rm(outDir, { recursive: true, force: true });
          for (const stemAsset of made) {
            enqueuePostprocess(
              ctx,
              id,
              stemAsset.id,
              path.join(ctx.mediaDir, stemAsset.src),
              'audio',
              true,
            );
          }
          return { assetIds: made.map((a) => a.id) };
        },
        assetId,
      );
      return { jobId: job.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 업스케일 2x/3x/4x → 새 video 에셋 (W8 F1: engine·model 확장) ─────────
  app.post('/api/projects/:id/assets/:assetId/upscale', async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    const body = (req.body ?? {}) as { scale?: unknown; engine?: unknown; model?: unknown };
    try {
      const doc = await ctx.store.get(id);
      const asset = doc.assets[assetId];
      if (!asset) return reply.code(404).send({ error: `에셋 없음: ${assetId}` });
      if (asset.kind !== 'video') {
        return reply.code(400).send({ error: '비디오 에셋만 업스케일할 수 있습니다' });
      }
      let scale: 2 | 3 | 4 = DEFAULT_UPSCALE;
      if (body.scale !== undefined) {
        if (body.scale !== 2 && body.scale !== 3 && body.scale !== 4) {
          return reply.code(400).send({ error: 'scale 은 2·3·4 중 하나여야 합니다' });
        }
        scale = body.scale;
      }
      let engine: UpscaleEngine = 'auto';
      if (body.engine !== undefined) {
        if (!UPSCALE_ENGINES.includes(body.engine as UpscaleEngine)) {
          return reply.code(400).send({ error: `engine 은 ${UPSCALE_ENGINES.join('·')} 중 하나여야 합니다` });
        }
        engine = body.engine as UpscaleEngine;
      }
      let model: UpscaleModel | undefined;
      if (body.model !== undefined) {
        if (!UPSCALE_MODELS.includes(body.model as UpscaleModel)) {
          return reply.code(400).send({ error: `model 은 ${UPSCALE_MODELS.join('·')} 중 하나여야 합니다` });
        }
        model = body.model as UpscaleModel;
      }
      // AI 를 «명시적으로» 요구했는데 실행 파일이 없으면 잡을 걸지 않고 501 로 알린다
      // (auto 는 lanczos 로 물러나므로 여기서 막지 않는다).
      if (engine === 'ai') {
        const ready = await isUpscaleAiReady();
        if (!ready.ok) {
          return reply.code(501).send({
            error:
              `AI 업스케일 엔진(Real-ESRGAN)이 없습니다. ${ready.hint ?? ''} ` +
              '`node scripts/prewarm.mjs realesrgan` 로 먼저 받으세요.',
          });
        }
      }

      const sourceName = asset.name;
      const job = ctx.jobs.enqueue(
        'upscale',
        id,
        async (_job, report, signal) => {
          const docNow = await ctx.store.get(id);
          const now = docNow.assets[assetId];
          if (!now) throw new Error(`에셋 없음: ${assetId}`);
          let used: 'ai' | 'lanczos' = 'lanczos';
          const newAsset = await makeVideoAsset(ctx, id, `${sourceName} ${scale}배 업스케일`, async (outAbs) => {
            const res = await upscaleVideo(path.join(ctx.mediaDir, now.src), outAbs, {
              scale,
              engine,
              ...(model ? { model } : {}),
              onProgress: (p, frames) => report(p, frameDetail(frames)),
              signal,
            });
            if (res?.engine) used = res.engine;
          });
          return { assetId: newAsset.id, engine: used };
        },
        `${assetId}:upscale`,
      );
      return { jobId: job.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 프레임 보간 → 새 video 에셋 ─────────────────────────────────────────
  app.post('/api/projects/:id/assets/:assetId/interpolate', async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    const body = (req.body ?? {}) as { fps?: unknown; engine?: unknown; model?: unknown };
    try {
      const doc = await ctx.store.get(id);
      const asset = doc.assets[assetId];
      if (!asset) return reply.code(404).send({ error: `에셋 없음: ${assetId}` });
      if (asset.kind !== 'video') {
        return reply.code(400).send({ error: '비디오 에셋만 프레임 보간을 할 수 있습니다' });
      }
      let fps = DEFAULT_INTERPOLATE_FPS;
      if (body.fps !== undefined) {
        if (typeof body.fps !== 'number' || !Number.isInteger(body.fps) || body.fps < 1 || body.fps > 240) {
          return reply.code(400).send({ error: 'fps 는 1..240 사이의 정수여야 합니다' });
        }
        fps = body.fps;
      }
      let engine: InterpEngine = 'auto';
      if (body.engine !== undefined) {
        if (!INTERP_ENGINES.includes(body.engine as InterpEngine)) {
          return reply.code(400).send({ error: `engine 은 ${INTERP_ENGINES.join('·')} 중 하나여야 합니다` });
        }
        engine = body.engine as InterpEngine;
      }
      let model: string | undefined;
      if (body.model !== undefined) {
        if (typeof body.model !== 'string' || !INTERPOLATE_MODELS.includes(body.model)) {
          return reply.code(400).send({ error: `model 은 ${INTERPOLATE_MODELS.join('·')} 중 하나여야 합니다` });
        }
        model = body.model;
      }
      if (engine === 'ai') {
        const ready = await isInterpolateAiReady();
        if (!ready.ok) {
          return reply.code(501).send({
            error:
              `AI 프레임 보간 엔진(RIFE)이 없습니다. ${ready.hint ?? ''} ` +
              '`node scripts/prewarm.mjs rife` 로 먼저 받으세요.',
          });
        }
      }

      const sourceName = asset.name;
      const job = ctx.jobs.enqueue(
        'interpolate',
        id,
        async (_job, report, signal) => {
          const docNow = await ctx.store.get(id);
          const now = docNow.assets[assetId];
          if (!now) throw new Error(`에셋 없음: ${assetId}`);
          let used: 'ai' | 'minterpolate' = 'minterpolate';
          const newAsset = await makeVideoAsset(ctx, id, `${sourceName} ${fps}fps`, async (outAbs) => {
            const res = await interpolateFps(path.join(ctx.mediaDir, now.src), outAbs, {
              fps,
              engine,
              ...(model ? { model } : {}),
              onProgress: (p, frames) => report(p, frameDetail(frames)),
              signal,
            });
            if (res?.engine) used = res.engine;
          });
          return { assetId: newAsset.id, engine: used };
        },
        `${assetId}:interpolate`,
      );
      return { jobId: job.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

/** 산출 mp4 를 assets/ 에 만들고 addAsset + 후처리 잡까지 붙인다. */
async function makeVideoAsset(
  ctx: AppContext,
  projectId: string,
  name: string,
  produce: (outAbs: string) => Promise<void>,
): Promise<Asset> {
  const newAssetId = newId();
  const rel = `assets/${newAssetId}.mp4`;
  const outAbs = path.join(ctx.mediaDir, rel);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await produce(outAbs);
  const probe = await probeAsset(outAbs);
  const asset: Asset = {
    id: newAssetId,
    kind: 'video',
    src: rel,
    name,
    ...(probe.duration !== undefined ? { duration: probe.duration } : {}),
    ...(probe.width !== undefined ? { width: probe.width } : {}),
    ...(probe.height !== undefined ? { height: probe.height } : {}),
  };
  await ctx.applyBatch(projectId, [{ type: 'addAsset', asset }]);
  enqueuePostprocess(ctx, projectId, newAssetId, outAbs, 'video', probe.hasAudio === true);
  return asset;
}
