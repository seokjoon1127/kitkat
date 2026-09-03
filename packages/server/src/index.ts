// 서버 엔트리 — http://127.0.0.1:5757
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

export { buildApp, sendError, type AppContext, type AppOptions } from './app.js';
export { ProjectStore, NotFoundError, RevisionConflictError } from './store.js';
export { JobQueue, type Job, type JobType } from './jobs.js';
export { Hub } from './ws.js';

// 포트는 5757 이 기본이다. 검증할 때 «이미 떠 있는 서버를 끄지 않고» 두 번째 서버를 띄우려면
// KITKAT_PORT 로 바꾼다 — 남이 재고 있는 서버를 죽이지 않기 위한 것이다.
const PORT = Number(process.env.KITKAT_PORT ?? 5757);

// packages/server/(dist|src) 어느 쪽에서 실행돼도 한 단계 위 = packages/server
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;

if (isMain) {
  const app = await buildApp({
    dataDir: path.join(REPO_ROOT, 'data', 'projects'),
    mediaDir: path.join(REPO_ROOT, 'media'),
    uiDistDir: path.join(REPO_ROOT, 'packages', 'ui', 'dist'),
    logger: true,
  });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  // eslint-disable-next-line no-console
  console.log(`kitkat 서버 실행 중: http://127.0.0.1:${PORT}`);
}
