// 정적 서빙(/media, /assets) + 편집기(/p/:id) + /healthz — C3
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../app.js';

const FALLBACK_HTML = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>kitkat — UI 미빌드</title></head>
<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto;line-height:1.6">
<h1>편집기 UI가 아직 빌드되지 않았습니다</h1>
<p>아래 명령으로 UI를 빌드한 뒤 새로고침하세요:</p>
<pre style="background:#f0f0f0;padding:1rem">npm run build -w @kitkat/ui</pre>
<p>HTTP API(<code>/api/*</code>)와 MCP는 UI 없이도 동작합니다.</p>
</body></html>`;

export async function registerStaticRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(fastifyStatic, {
    root: ctx.mediaDir,
    prefix: '/media/',
  });

  // 기동 시 dist가 없어도 항상 등록한다 — 파일 존재는 요청 시점에 확인되므로
  // 서버 기동 후 UI를 빌드해도 재시작 없이 /assets/*가 서빙된다 (/p/:id의 요청별 확인과 대칭)
  const assetsDir = ctx.uiDistDir ? path.join(ctx.uiDistDir, 'assets') : undefined;
  if (assetsDir) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/',
      decorateReply: false,
    });
  }

  app.get('/p/:id', async (_req, reply) => {
    const indexHtml = ctx.uiDistDir ? path.join(ctx.uiDistDir, 'index.html') : undefined;
    if (indexHtml && existsSync(indexHtml)) {
      // vite 산출물의 상대 "./assets/…" 참조를 "/assets/…" 로 바꿔 /p/:id 어디서든 로드되게 한다
      const html = (await fs.readFile(indexHtml, 'utf8')).replaceAll('"./assets/', '"/assets/');
      return reply.type('text/html; charset=utf-8').send(html);
    }
    return reply.type('text/html; charset=utf-8').send(FALLBACK_HTML);
  });

  app.get('/healthz', async () => ({ ok: true, version: ctx.version }));
}
