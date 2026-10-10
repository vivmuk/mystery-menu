import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createGameServer } from '../server/server.ts';
import { CODE_ALPHABET, CODE_LENGTH, ROOM_CAPACITY, type RoomStatePayload } from '../server/rooms.ts';
import type { JoinRequest, JoinErrorPayload } from '../server/protocol.ts';

let http: ReturnType<typeof createGameServer>['http'];
let io: ReturnType<typeof createGameServer>['io'];
let base: string;
const clients: Socket[] = [];

beforeAll(async () => {
  const server = createGameServer();
  http = server.http;
  io = server.io;
  http.listen(0, '127.0.0.1');
  await new Promise((resolve) => http.once('listening', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const client of clients) client.close();
  io.close();
  await new Promise((resolve) => http.close(resolve));
});

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = ioClient(base, { transports: ['websocket'], reconnection: false });
    clients.push(client);
    client.on('hello', () => resolve(client));
    client.on('connect_error', reject);
  });
}

function emitAndWait<T>(client: Socket, event: string, payload: unknown, waitFor: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${waitFor} within 5000ms`)), 5000);
    client.once(waitFor, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
    client.emit(event, payload);
  });
}

describe('room HTTP API', () => {
  it('creates a room with an unambiguous 4-character code', async () => {
    const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string };
    expect(body.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`));
    expect(body.code).not.toMatch(/[01IO]/);
  });

  it('reports a created room with zero players', async () => {
    const created = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const res = await fetch(`${base}/api/rooms/${created.code}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean; players: number; capacity: number };
    expect(body.exists).toBe(true);
    expect(body.players).toBe(0);
    expect(body.capacity).toBe(ROOM_CAPACITY);
  });

  it('reports an unknown code as not existing', async () => {
    const res = await fetch(`${base}/api/rooms/ZZZZ`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean };
    expect(body.exists).toBe(false);
  });

  it('accepts a lowercase code', async () => {
    const created = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const res = await fetch(`${base}/api/rooms/${created.code.toLowerCase()}`);
    const body = (await res.json()) as { exists: boolean };
    expect(body.exists).toBe(true);
  });
});

describe('room socket protocol', () => {
  it('rejects a join for an unknown code', async () => {
    const client = await connect();
    const error = await emitAndWait<JoinErrorPayload>(client, 'join', { code: 'NOPE', name: 'A', colour: '#fff' } satisfies JoinRequest, 'join:error');
    expect(error.reason).toContain('NOPE');
    expect(error.reason).toContain('open');
  });

  it('rejects a duplicate name', async () => {
    const created = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const first = await connect();
    const second = await connect();
    const join: JoinRequest = { code: created.code, name: 'Viv', colour: '#ff5a1f' };
    await emitAndWait<RoomStatePayload>(first, 'join', join, 'room:state');
    const error = await emitAndWait<JoinErrorPayload>(second, 'join', { ...join, colour: '#1f5aff' }, 'join:error');
    expect(error.reason).toContain('Viv');
    expect(error.reason).toContain('another name');
  });

  it('broadcasts room:state with the joining player in it', async () => {
    const created = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const host = await connect();
    const guest = await connect();

    const hostJoin: JoinRequest = { code: created.code, name: 'Host', colour: '#ff5a1f' };
    const hostState = await emitAndWait<RoomStatePayload>(host, 'join', hostJoin, 'room:state');
    expect(hostState.code).toBe(created.code);
    expect(hostState.players).toHaveLength(1);
    expect(hostState.players[0]?.name).toBe('Host');
    expect(hostState.players[0]?.role).toBe('chef');

    const guestJoin: JoinRequest = { code: created.code, name: 'Guest', colour: '#1f5aff' };
    const [guestState, hostEcho] = await Promise.all([
      emitAndWait<RoomStatePayload>(guest, 'join', guestJoin, 'room:state'),
      new Promise<RoomStatePayload>((resolve) => host.once('room:state', resolve)),
    ]);
    expect(guestState.players).toHaveLength(2);
    expect(guestState.players.map((p) => p.name)).toEqual(['Host', 'Guest']);
    expect(guestState.players[1]?.role).toBe('chef');
    expect(hostEcho.players).toHaveLength(2);
  });

  it('assigns the table role to the third seat', async () => {
    const created = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const names = ['One', 'Two', 'Three'];
    const sockets = await Promise.all(names.map(() => connect()));
    let latest: RoomStatePayload | undefined;
    sockets[0]!.on('room:state', (state: RoomStatePayload) => {
      latest = state;
    });
    for (let i = 0; i < sockets.length; i++) {
      const state = await emitAndWait<RoomStatePayload>(
        sockets[i]!,
        'join',
        { code: created.code, name: names[i]!, colour: '#000' } satisfies JoinRequest,
        'room:state',
      );
      expect(state.players).toHaveLength(i + 1);
    }
    // The broadcast of the third join also lands on the first seat's socket.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(latest?.players).toHaveLength(3);
    expect(latest?.players[2]?.role).toBe('table');
  });

  it('removes a player on disconnect and rebroadcasts', async () => {
    const created = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as { code: string };
    const host = await connect();
    const guest = await connect();
    await emitAndWait<RoomStatePayload>(host, 'join', { code: created.code, name: 'Host', colour: '#ff5a1f' } satisfies JoinRequest, 'room:state');
    await emitAndWait<RoomStatePayload>(guest, 'join', { code: created.code, name: 'Guest', colour: '#1f5aff' } satisfies JoinRequest, 'room:state');

    const rebroadcast = new Promise<RoomStatePayload>((resolve) => host.once('room:state', resolve));
    guest.close();
    const state = await rebroadcast;
    expect(state.players).toHaveLength(1);
    expect(state.players[0]?.name).toBe('Host');
  });
});
