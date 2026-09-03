// Fastify 앱 조립 — 모든 문서 변경은 engine.applyCommands 단일 관문(applyBatch)을 거친다.
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { applyCommands, EngineError, type Command } from '@kitkat/engine';
import type { ProjectDoc } from '@kitkat/schema';
import { NotFoundError, ProjectStore, RevisionConflictError } from './store.js';
import { Hub, registerWs } from './ws.js';
import { JobQueue } from './jobs.js';
import { registerProjectRoutes } from './routes/projects.js';
import {
  liveDeriveKeys,
  planDerivePrune,
  registerCommandRoutes,
  scheduleDeriveJobs,
  scheduleWaveformRebake,
} from './routes/commands.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerMediaOpRoutes } from './routes/media-ops.js';
import { registerMatchRoutes } from './routes/match.js';
import { registerTrackRoutes } from './routes/track.js';
import { registerRenderRoutes } from './routes/render.js';
import { registerScopeRoutes } from './routes/scopes.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { registerStaticRoutes } from './routes/static.js';

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export type AppOptions = {
  dataDir: string; // data/projects
  mediaDir: string; // media/
  uiDistDir?: string; // packages/ui/dist
  logger?: boolean;
};

export type AppContext = {
  store: ProjectStore;
  hub: Hub;
  jobs: JobQueue;
  mediaDir: string;
  uiDistDir?: string;
  version: string;
  /**
   * 영구 실패한 derive 키(`<assetId>:<sourceKey>`) — 서버 수명 동안 유지된다.
   * 실패한 잡은 `derived[key]` 를 안 만들어서, 기억해 두지 않으면 이후 모든 applyBatch 가
   * 같은 잡을 다시 등록한다. 키가 스펙의 해시라 다시 유효해질 일은 없다.
   */
  failedDerive: Set<string>;
  /**
   * 명령 배치를 뮤텍스 아래에서 적용·저장·브로드캐스트한다.
   * baseRevision 불일치 → RevisionConflictError, 엔진 위반 → EngineError.
   */
  applyBatch(
    id: string,
    commands: Command[],
    opts?: { clientId?: string; baseRevision?: number },
  ): Promise<ProjectDoc>;
};

/** 라우트 공용 오류 → HTTP 매핑 */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: err.message });
  }
  if (err instanceof RevisionConflictError) {
    return reply.code(409).send({ error: err.message, doc: err.doc });
  }
  if (err instanceof EngineError) {
    return reply.code(400).send({ error: `${err.code}: ${err.message}` });
  }
  if (err instanceof Error && err.name === 'ZodError') {
    return reply.code(400).send({ error: `문서 검증 실패: ${err.message}` });
  }
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ error: message });
}

const MEDIA_SUBDIRS = ['assets', 'proxies', 'waveforms', 'thumbs', 'renders', 'derived', 'samples'];

/** mediaDir 안에 있는 상대경로만 지운다 (경로 탈출 방지). 없는 파일은 조용히 넘어간다. */
async function removeMediaFile(mediaDir: string, rel: string): Promise<void> {
  const root = path.resolve(mediaDir);
  const abs = path.resolve(root, rel);
  if (abs === root || !abs.startsWith(root + path.sep)) return;
  await fs.rm(abs, { force: true }).catch(() => {});
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 32 * 1024 * 1024, // restoreDoc 등 큰 문서 배치 허용
  });

  await fs.mkdir(opts.dataDir, { recursive: true });
  for (const sub of MEDIA_SUBDIRS) {
    await fs.mkdir(path.join(opts.mediaDir, sub), { recursive: true });
  }

  const store = new ProjectStore(opts.dataDir);
  await store.init();
  const hub = new Hub();
  const jobs = new JobQueue(hub);

  /** 같은 프로젝트에 회수 패스가 이미 예약돼 있으면 합친다. */
  const prunePending = new Set<string>();

  const ctx: AppContext = {
    store,
    hub,
    jobs,
    mediaDir: opts.mediaDir,
    uiDistDir: opts.uiDistDir,
    version: VERSION,
    failedDerive: new Set<string>(),
    applyBatch(id, commands, o) {
      return store.withLock(id, () => applyLocked(id, commands, o));
    },
  };

  /** 프로젝트 락을 이미 쥔 상태에서 적용·저장·브로드캐스트한다. */
  async function applyLocked(
    id: string,
    commands: Command[],
    o?: { clientId?: string; baseRevision?: number },
  ): Promise<ProjectDoc> {
    const doc = await store.get(id);
    if (o?.baseRevision !== undefined && o.baseRevision !== doc.revision) {
      throw new RevisionConflictError(doc);
    }
    const next = applyCommands(doc, commands);
    await store.save(next);
    hub.broadcast(id, {
      type: 'commands',
      revision: next.revision,
      commands,
      ...(o?.clientId ? { clientId: o.clientId } : {}),
    });
    // 저장·브로드캐스트 후 파생 잡 스케줄 (X6) — 잡 완료가 일으킨 문서 변경도 여기로 들어온다.
    // 재귀는 자연히 멈춘다: 파생 완료 → updateAsset → 다시 훑음 → derived[key] 가 이미 있음.
    scheduleDeriveJobs(ctx, next);
    // W8 F12-B — 옛 형식(1000버킷 배열) 파형은 버킷 시간을 몰라 더킹에 못 쓴다. 다시 굽는다.
    // (파일당 한 번만 확인하고, 새 형식이면 아무 일도 안 한다.)
    scheduleWaveformRebake(ctx, next);
    schedulePrune(id);
    return next;
  }

  /**
   * 죽은 파생 미디어 회수를 이 프로젝트 락 **뒤에** 한 번 예약한다.
   *
   * 지금 문서로 계산해서 나중에 적용하면 안 된다 — 그 사이 derive 잡이 써넣은 새 키까지
   * 통째로 덮어 지운다. 그래서 락을 잡은 다음 최신 문서에서 계산한다.
   * 여기서 나온 명령도 다시 회수를 예약하지만, 그 패스는 지울 게 없어 그대로 끝난다.
   */
  function schedulePrune(id: string): void {
    if (prunePending.has(id)) return;
    prunePending.add(id);
    void store
      .withLock(id, async () => {
        prunePending.delete(id);
        let doc: ProjectDoc;
        try {
          doc = await store.get(id); // 그 사이 삭제된 프로젝트면 할 일 없음
        } catch {
          return;
        }
        // 먼저 버려진 대기 잡을 취소한다 — 취소하고 나면 hasActive 가 풀려서
        // 그 키의 파생 파일까지 같은 패스에서 회수된다.
        const live = liveDeriveKeys(doc);
        jobs.cancelQueued('derive', id, (key) => !live.has(key));

        const { commands, files } = planDerivePrune(ctx, doc);
        if (commands.length === 0) return;
        await applyLocked(id, commands);
        for (const rel of files) await removeMediaFile(opts.mediaDir, rel);
      })
      .catch(() => {
        // 회수는 최선 노력 — 실패해도 편집 흐름을 막지 않는다 (다음 배치에서 다시 시도된다)
      });
  }

  await app.register(websocket);
  await app.register(multipart, {
    limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  });

  registerProjectRoutes(app, ctx);
  registerCommandRoutes(app, ctx);
  registerAssetRoutes(app, ctx);
  registerMediaOpRoutes(app, ctx);
  registerMatchRoutes(app, ctx);
  registerTrackRoutes(app, ctx);
  registerRenderRoutes(app, ctx);
  registerScopeRoutes(app, ctx);
  registerCapabilityRoutes(app, ctx);
  await registerStaticRoutes(app, ctx);
  registerWs(app, ctx);

  return app;
}
