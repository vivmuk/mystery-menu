import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app.ts';

export interface HelloPayload {
  service: 'mystery-menu';
  socketId: string;
}

export interface GameServer {
  http: HttpServer;
  io: SocketServer;
}

/**
 * The whole realtime service in one place, so a test can boot exactly what
 * production boots instead of a hand-rolled copy of it.
 */
export function createGameServer(): GameServer {
  const http = createServer(createApp());
  const io = new SocketServer(http, {
    serveClient: true,
    cors: { origin: true },
  });

  // The room protocol lands with the join-flow backlog item. A socket that does
  // nothing yet still proves the transport is wired end to end.
  io.on('connection', (socket) => {
    const payload: HelloPayload = { service: 'mystery-menu', socketId: socket.id };
    socket.emit('hello', payload);
  });

  return { http, io };
}
