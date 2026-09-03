// F6-B 정밀 스코프 — 그 시각의 스틸을 굽고 ffmpeg 스코프 필터를 걸어 PNG 3장을 낸다.
//
// 실시간 스코프(브라우저)는 **540p 프록시에 근사 효과**를 본다. 색을 수치로 판정하려면
// 최종 렌더와 같은 픽셀이어야 하고, 그게 이 경로의 존재 이유다.
// 응답에 평균 통계도 같이 실어서 UI 가 「미리보기와 얼마나 다른지」를 숫자로 보여 준다.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  isScopeKind,
  measureStillStats,
  renderScopeImages,
  scopeFileName,
  statsSampleSize,
  SCOPE_KINDS,
  type ScopeKind,
  type StillStats,
} from '@kitkat/media';
import { renderCover } from '@kitkat/renderer';
import { sendError, type AppContext } from '../app.js';

const SCOPES_DIR = 'scopes';

type ScopesBody = { timeMs?: unknown; kinds?: unknown; proxy?: unknown };

/** 캐시된 통계 파일 이름 — 그림이 캐시에 맞았을 때 스틸을 다시 굽지 않으려고 같이 남긴다. */
function statsFileName(projectId: string, revision: number, timeMs: number, proxy: boolean): string {
  const safe = projectId.replace(/[^\w.-]+/g, '_');
  return `${safe}-r${revision}-t${Math.round(timeMs)}${proxy ? '-p' : ''}-stats.json`;
}

async function readJson<T>(abs: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(abs, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export function registerScopeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/projects/:id/scopes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as ScopesBody;
    try {
      const doc = await ctx.store.get(id); // 없으면 404

      if (
        typeof body.timeMs !== 'number' ||
        !Number.isFinite(body.timeMs) ||
        body.timeMs < 0
      ) {
        return reply.code(400).send({ error: 'timeMs 는 0 이상의 숫자(ms)여야 합니다' });
      }
      const timeMs = Math.round(body.timeMs);

      let kinds: ScopeKind[] = [...SCOPE_KINDS];
      if (body.kinds !== undefined) {
        if (!Array.isArray(body.kinds) || body.kinds.length === 0) {
          return reply.code(400).send({ error: 'kinds 는 비어 있지 않은 배열이어야 합니다' });
        }
        const bad = body.kinds.filter((k) => !isScopeKind(k));
        if (bad.length > 0) {
          return reply
            .code(400)
            .send({ error: `모르는 스코프 종류: ${bad.join(', ')} (waveform·vectorscope·histogram)` });
        }
        kinds = [...new Set(body.kinds as ScopeKind[])];
      }
      const proxy = body.proxy === true;
      // 리비전이 이름에 들어가므로 문서가 바뀌면 캐시는 저절로 무효가 된다.
      const revision = doc.revision;

      // 잡 종류는 'cover' 를 쓴다 — 하는 일이 renderCover 와 같은 «스틸 1장»이고,
      // 잡 종류를 새로 만들면 공용 파일(jobs.ts)을 건드려야 해서 그 대신 key 로 구분한다.
      const job = ctx.jobs.enqueue(
        'cover',
        id,
        async (_job, report) => {
          const outDir = path.join(ctx.mediaDir, SCOPES_DIR);
          await fs.mkdir(outDir, { recursive: true });
          const fileFor = (k: ScopeKind): string => scopeFileName(id, revision, timeMs, k, proxy);
          const statsAbs = path.join(outDir, statsFileName(id, revision, timeMs, proxy));

          const missing: ScopeKind[] = [];
          for (const k of kinds) {
            if (!(await fileExists(path.join(outDir, fileFor(k))))) missing.push(k);
          }
          let stats = await readJson<StillStats>(statsAbs);
          const cached = missing.length === 0 && stats !== null;

          if (!cached) {
            const docNow = await ctx.store.get(id);
            const stillAbs = path.join(outDir, `.still-${id}-r${revision}-t${timeMs}.jpg`);
            report(0.05);
            await renderCover(docNow, {
              mediaDir: ctx.mediaDir,
              outPath: stillAbs,
              timeMs,
              ...(proxy ? { proxy: true } : {}),
            });
            report(0.7);
            try {
              await renderScopeImages(stillAbs, outDir, fileFor, missing.length > 0 ? missing : kinds);
              report(0.9);
              const s = statsSampleSize(docNow.settings.width, docNow.settings.height);
              stats = await measureStillStats(stillAbs, s.width, s.height);
              await fs.writeFile(statsAbs, JSON.stringify(stats), 'utf8');
            } finally {
              // 스틸은 중간 산출물 — 스코프 PNG 만 남긴다
              await fs.rm(stillAbs, { force: true }).catch(() => {});
            }
          }
          report(1);

          const urls: Record<string, string> = {};
          const paths: Record<string, string> = {};
          for (const k of kinds) {
            urls[k] = `/media/${SCOPES_DIR}/${fileFor(k)}`;
            paths[k] = path.join(outDir, fileFor(k)).replaceAll('\\', '/');
          }
          return {
            urls,
            paths,
            revision,
            timeMs,
            proxy,
            cached,
            /** 최종 렌더 픽셀의 평균 — 실시간 스코프의 같은 숫자와 빼서 「얼마나 다른지」를 낸다. */
            ...(stats ? { stats } : {}),
          };
        },
        { key: `${id}:scopes:r${revision}:t${timeMs}${proxy ? ':p' : ''}` },
      );
      return { jobId: job.id, revision, timeMs, kinds };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
