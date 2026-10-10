import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app.ts';
import { RoomRegistry } from './rooms.ts';
import type { JoinRequest, JoinErrorPayload } from './protocol.ts';

export interface HelloPayload {
  service: 'mystery-menu';
  socketId: string;
}

export interface GameServer {
  http: HttpServer;
  io: SocketServer;
}

function roomChannel(code: string): string {
  return `room:${code}`;
}

/**
 * The whole realtime service in one place, so a test can boot exactly what
 * production boots instead of a hand-rolled copy of it.
 */
export function createGameServer(): GameServer {
  const registry = new RoomRegistry();
  const http = createServer(createApp(registry));
  const io = new SocketServer(http, {
    serveClient: true,
    cors: { origin: true },
  });

  io.on('connection', (socket) => {
    const payload: HelloPayload = { service: 'mystery-menu', socketId: socket.id };
    socket.emit('hello', payload);

    socket.on('join', (request: JoinRequest) => {
      const code = typeof request?.code === 'string' ? request.code.trim().toUpperCase() : '';
      const room = registry.get(code);
      if (!room) {
        const error: JoinErrorPayload = { reason: `No room called “${code || '????'}” is open.` };
        socket.emit('join:error', error);
        return;
      }
      const result = registry.join(room, socket.id, request.name, request.colour);
      if (!result.ok) {
        socket.emit('join:error', { reason: result.error } satisfies JoinErrorPayload);
        return;
      }
      void socket.join(roomChannel(room.code));
      io.to(roomChannel(room.code)).emit('room:state', registry.state(room));
    });

    socket.on('disconnect', () => {
      const left = registry.leaveBySocket(socket.id);
      if (left) {
        io.to(roomChannel(left.room.code)).emit('room:state', registry.state(left.room));
      }
    });
  });

  return { http, io };
}
