// 에셋 임포트(로컬 경로 또는 multipart) + 오디오 추출 — C3
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { newId, staleProxyTargets, type Asset } from '@kitkat/schema';
import {
  extractAudio,
  gifToWebm,
  isCurrentProxy,
  makeDerivedProxy,
  makeProxy,
  makeThumb,
  makeWaveform,
  parseCubeLut,
  probeAsset,
} from '@kitkat/media';
import { sendError, type AppContext } from '../app.js';
import type { Job } from '../jobs.js';

const toPosix = (p: string) => p.replaceAll('\\', '/');

/** LUT 에셋으로 취급하는 확장자 (probe·후처리 없음) */
const LUT_EXTS = new Set(['.cube', '.3dl']);

/** 임포트 후처리 잡 등록: video→proxy+thumb(+waveform), audio→waveform, image→thumb. 대표 잡을 반환. */
export function enqueuePostprocess(
  ctx: AppContext,
  projectId: string,
  assetId: string,
  absSrc: string,
  kind: Asset['kind'],
  hasAudio: boolean,
): Job {
  const patchJob = (patch: Partial<Asset>) =>
    ctx.applyBatch(projectId, [{ type: 'updateAsset', assetId, patch }]);

  const waveformJob = () =>
    ctx.jobs.enqueue('waveform', projectId, async () => {
      const rel = await makeWaveform(absSrc, ctx.mediaDir, assetId);
      if (rel) await patchJob({ waveformSrc: rel });
    });
  const thumbJob = () =>
    ctx.jobs.enqueue('thumb', projectId, async () => {
      const rel = await makeThumb(absSrc, ctx.mediaDir, assetId);
      await patchJob({ thumbSrc: rel });
    });

  if (kind === 'video') {
    const primary = ctx.jobs.enqueue('proxy', projectId, async (_job, _report, signal) => {
      const rel = await makeProxy(absSrc, ctx.mediaDir, assetId, { signal });
      await patchJob({ proxySrc: rel });
    });
    thumbJob();
    if (hasAudio) waveformJob();
    return primary;
  }
  if (kind === 'audio') return waveformJob();
  return thumbJob();
}

export function registerAssetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/projects/:id/assets', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await ctx.store.get(id); // 없으면 404

      const assetId = newId();
      let src: string; // media/ 기준 상대경로 (forward slash)
      let name: string;

      if (req.isMultipart()) {
        const part = await req.file();
        if (!part) return reply.code(400).send({ error: 'file 파트가 필요합니다' });
        name = part.filename || assetId;
        const ext = path.extname(name);
        src = `assets/${assetId}${ext}`;
        await pipeline(part.file, createWriteStream(path.join(ctx.mediaDir, src)));
      } else {
        const body = (req.body ?? {}) as { path?: unknown };
        if (typeof body.path !== 'string' || body.path.trim() === '') {
          return reply.code(400).send({ error: 'path(로컬 절대경로) 또는 multipart file 이 필요합니다' });
        }
        const abs = path.resolve(body.path);
        try {
          const st = await fs.stat(abs);
          if (!st.isFile()) throw new Error('not a file');
        } catch {
          return reply.code(400).send({ error: `파일을 찾을 수 없습니다: ${toPosix(abs)}` });
        }
        name = path.basename(abs);
        const rel = path.relative(ctx.mediaDir, abs);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          // 이미 media/ 안에 있으면 복사 없이 그대로 참조
          src = toPosix(rel);
        } else {
          src = `assets/${assetId}${path.extname(abs)}`;
          await fs.copyFile(abs, path.join(ctx.mediaDir, src));
        }
      }

      let absSrc = path.join(ctx.mediaDir, src);
      const ext = path.extname(name).toLowerCase();

      // .cube/.3dl → LUT 에셋. 형식 검증만 하고 probe·후처리 잡은 붙이지 않는다 (X6)
      if (LUT_EXTS.has(ext)) {
        try {
          await parseCubeLut(absSrc);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply.code(400).send({ error: `LUT 파일이 아닙니다: ${message}` });
        }
        const lutAsset: Asset = { id: assetId, kind: 'lut', src, name };
        await ctx.applyBatch(id, [{ type: 'addAsset', asset: lutAsset }]);
        return { asset: lutAsset };
      }

      // .gif → 알파 보존 webm 으로 구워 그 파일을 src 로 삼는다(이름은 원본 유지) (X6)
      if (ext === '.gif') {
        const webmRel = `assets/${assetId}.webm`;
        const webmAbs = path.join(ctx.mediaDir, webmRel);
        try {
          await gifToWebm(absSrc, webmAbs);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply.code(400).send({ error: `GIF 변환 실패: ${message}` });
        }
        src = webmRel;
        absSrc = webmAbs;
      }

      const probe = await probeAsset(absSrc);
      const asset: Asset = {
        id: assetId,
        kind: probe.kind,
        src,
        name,
        ...(probe.duration !== undefined ? { duration: probe.duration } : {}),
        ...(probe.width !== undefined ? { width: probe.width } : {}),
        ...(probe.height !== undefined ? { height: probe.height } : {}),
      };
      await ctx.applyBatch(id, [{ type: 'addAsset', asset }]);

      const job = enqueuePostprocess(ctx, id, assetId, absSrc, probe.kind, probe.hasAudio === true);
      return { asset, jobId: job.id };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // W8 F17 — 옛 판 프록시 다시 굽기.
  //
  // 프록시에 키프레임을 0.5초마다 넣도록 바꾸면서(F14) 파일 이름에 판 표시(.g15)를 붙였다.
  // 이미 임포트해 둔 에셋은 옛 판을 그대로 쓰므로 스크럽이 느린 채로 남는다.
  // 자동으로 다시 굽지 않는다 — 라이브러리가 크면 몇 분씩 걸리는 재인코딩을 사용자가
  // 시키지도 않았는데 시작하는 셈이라서다. 이 라우트로 «시켰을 때만» 굽는다.
  //
  // 옛 파일은 지우지 않는다 — media/ 는 프로젝트끼리 공유하므로 다른 프로젝트가 아직
  // 그 이름을 가리키고 있을 수 있다.
  // W8 F17 리뷰 #3 — 「에셋마다 한 번씩 누르기」는 라이브러리가 크면 쓸 수 없다(이 컴퓨터만 52개).
  // 옛 판 프록시를 **원본·파생 가리지 않고** 한 잡으로 전부 다시 굽는다. 파생은 본체를 다시
  // 굽지 않고(몇 분씩 걸린다) 540p 사본만 만든다. 자동으로는 안 돈다 — 누를 때만.
  app.post('/api/projects/:id/assets/reproxy-all', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const doc = await ctx.store.get(id);
      const targets = staleProxyTargets(doc);
      if (targets.length === 0) return reply.code(400).send({ error: '옛 판 프록시가 없습니다 — 전부 최신입니다' });
      const job = ctx.jobs.enqueue('proxy', id, async (_job, report, signal) => {
        let done = 0;
        for (const t of targets) {
          report(done / targets.length, `${done + 1}/${targets.length} ${t.assetId.slice(0, 6)}${t.key ? ' (' + t.key.slice(0, 6) + ')' : ''}`);
          const now = await ctx.store.get(id);
          const asset = now.assets[t.assetId];
          if (!asset) { done++; continue; }
          if (t.key === undefined) {
            const rel = await makeProxy(path.join(ctx.mediaDir, asset.src), ctx.mediaDir, asset.id, { signal });
            await ctx.applyBatch(id, [{ type: 'updateAsset', assetId: asset.id, patch: { proxySrc: rel } }]);
          } else {
            const d = asset.derived?.[t.key];
            if (!d) { done++; continue; }
            const rel = await makeDerivedProxy(path.join(ctx.mediaDir, d.src), ctx.mediaDir, asset.id, t.key, { signal });
            await ctx.applyBatch(id, [{
              type: 'updateAsset',
              assetId: asset.id,
              patch: { derived: { ...(asset.derived ?? {}), [t.key]: { ...d, proxySrc: rel } } },
            }]);
          }
          done++;
        }
        return { updated: done, total: targets.length };
      }, { timeoutMs: Math.max(10 * 60_000, targets.length * 3 * 60_000) });
      return reply.send({ jobId: job.id, total: targets.length });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/projects/:id/assets/:assetId/reproxy', async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    try {
      const doc = await ctx.store.get(id);
      const asset = doc.assets[assetId];
      if (!asset) return reply.code(404).send({ error: `에셋 없음: ${assetId}` });
      if (asset.kind !== 'video') {
        return reply.code(400).send({ error: '프록시는 비디오 에셋에만 있습니다' });
      }
      if (isCurrentProxy(asset.proxySrc)) {
        return reply.code(400).send({ error: '이미 최신 판 프록시입니다' });
      }
      const absSrc = path.join(ctx.mediaDir, asset.src);
      const job = ctx.jobs.enqueue('proxy', id, async (_job, _report, signal) => {
        const rel = await makeProxy(absSrc, ctx.mediaDir, assetId, { signal });
        await ctx.applyBatch(id, [{ type: 'updateAsset', assetId, patch: { proxySrc: rel } }]);
      });
      return reply.send({ jobId: job.id });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/projects/:id/assets/:assetId/extract-audio', async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    try {
      const doc = await ctx.store.get(id);
      const source = doc.assets[assetId];
      if (!source) return reply.code(404).send({ error: `에셋 없음: ${assetId}` });
      if (source.kind !== 'video') {
        return reply.code(400).send({ error: '비디오 에셋에서만 오디오를 추출할 수 있습니다' });
      }

      const audioId = newId();
      const src = `assets/${audioId}.wav`;
      const outAbs = path.join(ctx.mediaDir, src);
      try {
        await extractAudio(path.join(ctx.mediaDir, source.src), outAbs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: `오디오 추출 실패: ${message}` });
      }
      const probe = await probeAsset(outAbs).catch(() => ({ duration: source.duration }));
      const asset: Asset = {
        id: audioId,
        kind: 'audio',
        src,
        name: `${source.name} 오디오`,
        ...(probe.duration !== undefined ? { duration: probe.duration } : {}),
      };
      await ctx.applyBatch(id, [{ type: 'addAsset', asset }]);
      enqueuePostprocess(ctx, id, audioId, outAbs, 'audio', true);
      return { asset };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
