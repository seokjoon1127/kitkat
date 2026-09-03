// 프로젝트 문서 저장소 — data/projects/<id>.json
// 원자적 쓰기(tmp→rename, Windows EPERM 지수 백오프 3회 재시도) + 프로젝트별 적용 뮤텍스.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateDoc, type ProjectDoc } from '@kitkat/schema';

export class NotFoundError extends Error {
  constructor(message = '찾을 수 없습니다') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** POST commands 의 baseRevision 이 현재 revision 과 다를 때 (409 응답용, 최신 doc 동봉) */
export class RevisionConflictError extends Error {
  constructor(public doc: ProjectDoc) {
    super('baseRevision 불일치 — 최신 문서를 확인하세요');
    this.name = 'RevisionConflictError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 50;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows: 바이러스 검사기 등이 파일을 잠깐 잡으면 EPERM/EACCES — 지수 백오프 3회 재시도
      if ((code === 'EPERM' || code === 'EACCES') && attempt < 3) {
        await sleep(delay);
        delay *= 3;
        continue;
      }
      throw err;
    }
  }
}

export class ProjectStore {
  private cache = new Map<string, ProjectDoc>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(private dataDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  private fileOf(id: string): string {
    return path.join(this.dataDir, `${id}.json`);
  }

  async get(id: string): Promise<ProjectDoc> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    let raw: string;
    try {
      raw = await fs.readFile(this.fileOf(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`프로젝트 없음: ${id}`);
      }
      throw err;
    }
    const doc = validateDoc(JSON.parse(raw));
    this.cache.set(id, doc);
    return doc;
  }

  async list(): Promise<{ id: string; name: string; revision: number }[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dataDir);
    } catch {
      return [];
    }
    const out: { id: string; name: string; revision: number }[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const doc = await this.get(f.slice(0, -'.json'.length));
        out.push({ id: doc.id, name: doc.name, revision: doc.revision });
      } catch {
        // 깨진 파일은 목록에서 제외
      }
    }
    return out;
  }

  async save(doc: ProjectDoc): Promise<void> {
    const file = this.fileOf(doc.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
    await renameWithRetry(tmp, file);
    // 디스크 쓰기가 성공한 뒤에만 캐시를 갱신한다 — 실패 시 메모리 revision만 앞서 나가
    // 같은 baseRevision 재시도가 409가 되고, 재시작 시 디스크의 옛 상태로 되돌아가는 불일치 방지
    this.cache.set(doc.id, doc);
  }

  async remove(id: string): Promise<void> {
    this.cache.delete(id);
    await fs.rm(this.fileOf(id), { force: true });
  }

  /** 프로젝트별 뮤텍스 — 같은 id 의 작업을 순차 직렬화한다. */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    this.locks.set(
      id,
      run.catch(() => {}),
    );
    return run;
  }
}
