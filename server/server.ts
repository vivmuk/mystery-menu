import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app.ts';
import { RoomRegistry } from './rooms.ts';
import { GameSessions } from './game.ts';
import { DraftError } from './draft/engine.ts';
import { createVeniceClient } from './venice/client.ts';
import type { DraftRequest, DraftBidRequest, DraftChefRequest, DraftGiftRequest, DraftTradeRequest, DraftRespondTradeRequest, DraftErrorPayload } from './protocol.ts';
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
  const games = new GameSessions(registry, (code, state) => {
    io.to(roomChannel(code)).emit('draft:state', state);
  });
  const http = createServer(createApp(registry, createVeniceClient(), games));
  const io = new SocketServer(http, {
    serveClient: true,
    cors: { origin: true },
  });

  http.on('close', () => games.dispose());

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

    function command(request: DraftRequest, referee: boolean, action: (session: ReturnType<GameSessions['get']>) => void): void {
      try {
        if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.code !== 'string') throw new DraftError('invalid-action', 'Supply a room code.');
        const room = registry.get(request.code);
        if (!room) throw new DraftError('wrong-phase', 'This room is not open.');
        if (referee) {
          if (!registry.isHost(room, socket.id)) throw new DraftError('invalid-action', 'Only the room host may drive the draft.');
        } else {
          const chef = registry.chefForSocket(room, socket.id);
          if (!chef || chef !== (request as DraftChefRequest).chef) throw new DraftError('invalid-chef', 'Act only for your own chef seat.');
        }
        const session = games.get(room.code);
        action(session);
        io.to(roomChannel(room.code)).emit('draft:state', session.publicState());
      } catch (error) {
        if (!(error instanceof DraftError)) throw error;
        socket.emit('draft:error', { code: error.code, message: error.message } satisfies DraftErrorPayload);
      }
    }

    socket.on('draft:start', (request: DraftRequest) => command(request, true, (session) => {
      const room = registry.get(request.code)!;
      if (room.players.filter((player) => player.role === 'chef').length !== 2) {
        throw new DraftError('wrong-phase', 'Seat two chefs before starting the draft.');
      }
      session.start();
    }));
    socket.on('draft:reveal', (request: DraftRequest) => command(request, true, (session) => session.act({ type: 'reveal' })));
    socket.on('draft:bid', (request: DraftBidRequest) => command(request, false, (session) => session.act({ type: 'bid', chef: request.chef, amount: request.amount })));
    socket.on('draft:take-it', (request: DraftChefRequest) => command(request, false, (session) => session.act({ type: 'take-it', chef: request.chef })));

    socket.on('draft:gift', (request: DraftGiftRequest) => command(request, false, (session) => session.act({ type: 'gift', chef: request.chef, slot: request.slot })));
    socket.on('draft:trade', (request: DraftTradeRequest) => command(request, false, (session) => session.act({ type: 'trade', chef: request.chef, give: request.give, receive: request.receive })));
    socket.on('draft:respond-trade', (request: DraftRespondTradeRequest) => command(request, false, (session) => session.act({ type: 'respond-trade', chef: request.chef, accept: request.accept })));

    socket.on('disconnect', () => {
      const left = registry.leaveBySocket(socket.id);
      if (left) {
        io.to(roomChannel(left.room.code)).emit('room:state', registry.state(left.room));
      }
    });
  });

  return { http, io };
}
