// mediaDir을 임시 포트로 서빙하는 최소 정적 서버 (Range 지원 — OffthreadVideo/Audio용)
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.ttf': 'font/ttf',      // media/fonts/ 번들 폰트 (T2)
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

export type StaticServer = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

export async function startStaticServer(rootDir: string): Promise<StaticServer> {
  const root = path.resolve(rootDir);

  const server = http.createServer((req, res) => {
    void (async () => {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      const abs = path.resolve(root, `.${path.posix.normalize(`/${urlPath}`)}`);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
      const range = req.headers.range;
      const size = stat.size;
      // 렌더 페이지(localhost:3000)와 이 서버(127.0.0.1:임의포트)는 다른 오리진이다.
      // <video>/<img> 와 달리 @font-face 는 CORS 를 요구하므로 허용 헤더가 없으면 폰트가 통째로 막힌다 (T2).
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m && (m[1] || m[2])) {
          let start = m[1] ? parseInt(m[1], 10) : NaN;
          let end = m[2] ? parseInt(m[2], 10) : NaN;
          if (Number.isNaN(start)) {
            // suffix range: 마지막 N바이트
            start = Math.max(0, size - (Number.isNaN(end) ? 0 : end));
            end = size - 1;
          } else if (Number.isNaN(end)) {
            end = size - 1;
          }
          end = Math.min(end, size - 1);
          if (start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
          });
          createReadStream(abs, { start, end }).pipe(res);
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(abs).pipe(res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
