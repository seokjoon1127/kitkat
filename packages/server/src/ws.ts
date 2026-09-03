// WS 허브 + /ws/projects/:id 라우트 — @fastify/websocket v11: 핸들러는 (socket, req), socket 이 ws WebSocket 그 자체.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.js';

/** ws WebSocket 의 최소 구조 타입 (@types/ws 미설치 환경 대응) */
export type Socket = {
  send(data: string): void;
  on(event: 'close' | 'message' | 'error', listener: (...args: any[]) => void): void;
  close(code?: number, reason?: string): void;
  readyState: number;
};

const OPEN = 1;

export class Hub {
  private rooms = new Map<string, Set<Socket>>();

  add(projectId: string, socket: Socket): void {
    let room = this.rooms.get(projectId);
    if (!room) {
      room = new Set();
      this.rooms.set(projectId, room);
    }
    room.add(socket);
    socket.on('close', () => {
      room.delete(socket);
      if (room.size === 0) this.rooms.delete(projectId);
    });
  }

  broadcast(projectId: string, msg: unknown): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    const data = JSON.stringify(msg);
    for (const socket of room) {
      if (socket.readyState === OPEN) {
        try {
          socket.send(data);
        } catch {
          // 끊어진 소켓은 close 이벤트에서 정리된다
        }
      }
    }
  }
}

export function registerWs(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/projects/:id', { websocket: true }, (rawSocket, req) => {
    const socket = rawSocket as unknown as Socket;
    const { id } = req.params as { id: string };
    ctx.hub.add(id, socket);

    const sendDoc = async () => {
      try {
        const doc = await ctx.store.get(id);
        socket.send(JSON.stringify({ type: 'doc', doc }));
      } catch {
        socket.close(1008, 'project not found');
      }
    };
    void sendDoc();

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg?.type === 'resync') void sendDoc();
      } catch {
        // 형식 오류 메시지는 무시
      }
    });
  });
}
