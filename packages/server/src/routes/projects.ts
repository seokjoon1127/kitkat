// 프로젝트 CRUD — C3
import type { FastifyInstance } from 'fastify';
import { createEmptyProject, ProjectDocSchema } from '@kitkat/schema';
import { sendError, type AppContext } from '../app.js';

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      width?: unknown;
      height?: unknown;
      fps?: unknown;
    };
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.code(400).send({ error: 'name(문자열)이 필요합니다' });
    }
    try {
      const doc = createEmptyProject({
        name: body.name,
        ...(typeof body.width === 'number' ? { width: body.width } : {}),
        ...(typeof body.height === 'number' ? { height: body.height } : {}),
        ...(typeof body.fps === 'number' ? { fps: body.fps } : {}),
      });
      // width/height/fps 불량값(0, 음수, 소수 해상도 등)은 저장 전에 거부한다
      const parsed = ProjectDocSchema.safeParse(doc);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return reply.code(400).send({
          error: `잘못된 프로젝트 설정: ${first ? `${first.path.join('.')} — ${first.message}` : '검증 실패'}`,
        });
      }
      await ctx.store.save(parsed.data);
      return { doc: parsed.data };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/projects', async () => {
    return { projects: await ctx.store.list() };
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { doc: await ctx.store.get(id) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      // 진행 중인 applyBatch의 save(tmp→rename)와 겹치면 rm 뒤 rename이 파일을 되살린다 — 뮤텍스로 직렬화
      await ctx.store.withLock(id, async () => {
        await ctx.store.get(id); // 없으면 404
        await ctx.store.remove(id);
      });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
