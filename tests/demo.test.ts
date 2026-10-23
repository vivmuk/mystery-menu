import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createGameServer } from '../server/server.ts';
import type { PublicDraftState } from '../server/draft/engine.ts';
import type { PublicVoteState } from '../server/votes.ts';
import type { RoomStatePayload } from '../server/rooms.ts';

vi.mock('../server/ingredients/generate.ts', async (original) => {
  const actual = await original<typeof import('../server/ingredients/generate.ts')>();
  return {
    ...actual,
    generateHands: (deck: Parameters<typeof actual.generateHands>[0], options: Parameters<typeof actual.generateHands>[1]) =>
      actual.generateHands(deck, { vegetarianOnly: options?.vegetarianOnly, random: () => 0 }),
  };
});

let server: ReturnType<typeof createGameServer>;
let base: string;
const clients: Socket[] = [];

beforeAll(async () => {
  server = createGameServer();
  server.http.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.http.once('listening', resolve));
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  clients.forEach((client) => client.close());
  await new Promise<void>((resolve) => server.io.close(() => resolve()));
});

function wait<T>(client: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off(event, listener); reject(new Error(`no ${event}`)); }, 2000);
    const listener = (payload: T) => { clearTimeout(timer); resolve(payload); };
    client.once(event, listener);
  });
}

async function connect(): Promise<Socket> {
  const client = ioClient(base, { transports: ['websocket'], reconnection: false });
  clients.push(client);
  await wait(client, 'hello');
  return client;
}

async function request<T>(client: Socket, event: string, payload: unknown, response: string): Promise<T> {
  const result = wait<T>(client, response);
  client.emit(event, payload);
  return result;
}

describe('solo demo room', () => {
  it('seats virtual chefs and diners, lets the host drive both chefs, and casts every ballot', async () => {
    const created = await (await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demo: true }),
    })).json() as { code: string; demo: boolean; players: number };
    expect(created.demo).toBe(true);
    expect(created.players).toBe(5);

    const host = await connect();
    const joined = await request<RoomStatePayload>(host, 'join', { code: created.code, name: 'Director', colour: '#ff5a1f', role: 'table' }, 'room:state');
    expect(joined.demo).toBe(true);
    expect(joined.hostId).toBe(host.id);
    expect(joined.players.filter((player) => player.role === 'chef')).toHaveLength(2);
    expect(joined.players.filter((player) => player.virtual === true)).toHaveLength(5);
    const diners = joined.players.filter((player) => player.role === 'table' && player.virtual === true).map((player) => player.id);
    expect(diners).toEqual(['demo-diner-1', 'demo-diner-2', 'demo-diner-3']);

    expect((await fetch(`${base}/api/rooms/${created.code}/hands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deckId: 'pizza', vegetarianOnly: true }),
    })).status).toBe(200);

    const draft = async (event: string, payload: unknown): Promise<PublicDraftState> => {
      const state = wait<PublicDraftState>(host, 'draft:state');
      host.emit(event, payload);
      return state;
    };

    let state = await draft('draft:start', { code: created.code });
    for (let i = 0; i < 10; i++) {
      state = await draft('draft:reveal', { code: created.code });
      // Once a dish is full the engine hands the remaining items over for
      // free; there is no auction to play on those reveals.
      if (state.auction) state = await draft('draft:take-it', { code: created.code, chef: state.auction.turn });
    }
    expect(state.phase).toBe('plating');
    expect(state.chefs.chefOne.items).toHaveLength(5);
    expect(state.chefs.chefTwo.items).toHaveLength(5);

    const opened = wait<PublicVoteState>(host, 'vote:state');
    host.emit('vote:open', { code: created.code });
    expect((await opened).tally.phase).toBe('open');

    // Three diners pick Chef One; the Director's own ballot picks Chef Two.
    for (const [index, diner] of diners.entries()) {
      expect(await request(host, 'vote:cast', { code: created.code, dish: index < 2 ? 'chefOne' : 'chefTwo', voter: diner }, 'vote:accepted')).toEqual({ ok: true });
    }
    const closed = wait<PublicVoteState>(host, 'vote:state');
    host.emit('vote:cast', { code: created.code, dish: 'chefOne' });
    const tally = (await closed).tally;
    expect(tally).toMatchObject({ phase: 'closed', total: 4, winner: 'chefOne', tie: false });
    expect(tally.dishes.map((dish) => dish.count)).toEqual([3, 1]);
  });

  it('refuses a second phone driving the demo chefs or casting a virtual ballot', async () => {
    const { code } = await (await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demo: true }),
    })).json() as { code: string };
    const host = await connect();
    await request(host, 'join', { code, name: 'Director', colour: '#ff5a1f', role: 'table' }, 'room:state');
    const guest = await connect();
    await request(guest, 'join', { code, name: 'Guest', colour: '#35a7ff', role: 'table' }, 'room:state');
    expect(await request(guest, 'draft:start', { code }, 'draft:error')).toMatchObject({ code: 'invalid-action' });
    expect(await request(guest, 'vote:open', { code }, 'vote:error')).toMatchObject({ code: 'invalid-action' });
  });
});
