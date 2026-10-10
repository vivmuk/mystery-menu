import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateHands } from '../server/ingredients/generate.ts';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createGameServer } from '../server/server.ts';
import type { HelloPayload } from '../server/server.ts';
import type { PublicDraftState } from '../server/draft/engine.ts';
import type { RoomStatePayload } from '../server/rooms.ts';

// Keep the real generator/validator, but replace crypto/network nondeterminism:
// distinct cores and twists let the payload walker distinguish every secret.
vi.mock('../server/ingredients/generate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/ingredients/generate.ts')>();
  return {
    ...actual,
    generateHands: vi.fn((deck, options) => {
      let pick = 0;
      return actual.generateHands(deck, {
        vegetarianOnly: options?.vegetarianOnly,
        random: () => { const index = pick++; return index >= 5 && index <= 8 ? 4 : 0; },
      });
    }),
  };
});

let http: ReturnType<typeof createGameServer>['http'];
let io: ReturnType<typeof createGameServer>['io'];
let base: string;
const clients: Socket[] = [];
const peers = new Map<Socket, Socket>();

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

afterEach(() => vi.useRealTimers());

afterAll(async () => {
  for (const client of clients) client.close();
  io.close();
  await new Promise((resolve) => http.close(resolve));
});

function connect(): Promise<{ client: Socket; hello: HelloPayload }> {
  return new Promise((resolve, reject) => {
    const client = ioClient(base, { transports: ['websocket'], reconnection: false });
    clients.push(client);
    const timer = setTimeout(() => reject(new Error('no hello within 5000ms')), 5000);
    client.on('hello', (payload: HelloPayload) => {
      clearTimeout(timer);
      resolve({ client, hello: payload });
    });
    client.on('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function emitAndWait<T>(client: Socket, event: string, payload: unknown, waitFor = 'draft:state'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${waitFor} within 1000ms`)), 1000);
    client.once(waitFor, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
    client.emit(event, payload);
  });
}

async function table(): Promise<{ code: string; host: Socket; guest: Socket }> {
  const { code } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json() as { code: string };
  const host = (await connect()).client;
  const guest = (await connect()).client;
  await emitAndWait<RoomStatePayload>(host, 'join', { code, name: 'Host', colour: '#fff' }, 'room:state');
  await emitAndWait<RoomStatePayload>(guest, 'join', { code, name: 'Guest', colour: '#000' }, 'room:state');
  const response = await fetch(`${base}/api/rooms/${code}/hands`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deckId: 'pizza' }),
  });
  expect(await response.json()).toEqual({ ok: true, vegetarianOnly: false });
  peers.set(host, guest);
  peers.set(guest, host);
  return { code, host, guest };
}

async function draft(client: Socket, event: string, payload: unknown): Promise<PublicDraftState> {
  const peer = peers.get(client)!;
  const echo = new Promise<PublicDraftState>((resolve) => peer.once('draft:state', resolve));
  const [state, other] = await Promise.all([emitAndWait<PublicDraftState>(client, event, payload), echo]);
  expect(other).toEqual(state);
  return state;
}

describe('realtime channel', () => {
  it('plays a complete reveal → bid → take-it round over real sockets', async () => {
    const { code, host, guest } = await table();
    let state = await draft(host, 'draft:start', { code });
    expect(state.phase).toBe('reveal');
    for (let index = 0; index < 10; index++) {
      state = await draft(host, 'draft:reveal', { code });
      if (state.phase === 'auction') {
        const item = state.auction!.item;
        state = await draft(host, 'draft:bid', { code, chef: 'chefOne', amount: 1 });
        state = await draft(guest, 'draft:take-it', { code, chef: 'chefTwo' });
        expect(state.lastAward).toEqual({ chef: 'chefOne', item, price: 1, reason: 'take-it' });
      }
    }
    expect(state.phase).toBe('plating');
    expect(state.chefs.chefOne).toMatchObject({ coins: 5 });
    expect(state.chefs.chefOne.items).toHaveLength(5);
    expect(state.chefs.chefTwo.items).toHaveLength(5);
    expect(state.deadline).toBeNull();
    expect(state).not.toHaveProperty('private');
  });

  it('authorizes only the host and the socket holding the claimed chef seat', async () => {
    const { code, host, guest } = await table();
    const spectator = (await connect()).client;
    await emitAndWait(spectator, 'join', { code, name: 'Table', colour: '#123' }, 'room:state');
    const outsider = (await connect()).client;
    const refused = async (client: Socket, event: string, payload: unknown, expected: string): Promise<void> => {
      const error = await emitAndWait<{ code: string; message: string }>(client, event, payload, 'draft:error');
      expect(error.code).toBe(expected);
      expect(error.message).toBeTruthy();
    };
    await refused(guest, 'draft:start', { code }, 'invalid-action');
    await refused(spectator, 'draft:start', { code }, 'invalid-action');
    await refused(outsider, 'draft:start', { code }, 'invalid-action');
    await draft(host, 'draft:start', { code });
    await refused(guest, 'draft:reveal', { code }, 'invalid-action');
    await refused(spectator, 'draft:reveal', { code }, 'invalid-action');
    await draft(host, 'draft:reveal', { code });
    for (const event of ['draft:bid', 'draft:take-it', 'draft:gift', 'draft:trade', 'draft:respond-trade']) {
      await refused(guest, event, { code, chef: 'chefOne', amount: 1, slot: '1:0', give: '1:0', receive: '1:1', accept: true }, 'invalid-chef');
      await refused(host, event, { code, chef: 'chefTwo', amount: 1 }, 'invalid-chef');
      await refused(spectator, event, { code, chef: 'chefOne', amount: 1 }, 'invalid-chef');
      await refused(outsider, event, { code, chef: 'chefOne', amount: 1 }, 'invalid-chef');
    }
    await refused(guest, 'draft:bid', { code, chef: 'chefTwo', amount: 1 }, 'wrong-turn');
    await draft(host, 'draft:bid', { code, chef: 'chefOne', amount: 2, now: -100000, deadline: 0 });
    await draft(guest, 'draft:take-it', { code, chef: 'chefTwo' });
  });

  it('walks EVERY emitted payload through a complete round without leaking unrevealed ids or names', async () => {
    const packets: { event: string; payload: unknown; revealed: number }[] = [];
    const { code } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json() as { code: string };
    const host = (await connect()).client;
    const guest = (await connect()).client;
    peers.set(host, guest);
    peers.set(guest, host);
    const revealedByClient = new Map<Socket, number>([[host, 0], [guest, 0]]);
    for (const client of [host, guest]) {
      client.onAny((event: string, ...args: unknown[]) => {
        // Only an announced engine item permits content to become public;
        // malicious extra fields cannot mark themselves as "revealed".
        if (event === 'draft:state') {
          const state = args[0] as PublicDraftState;
          const item = state.auction?.item ?? state.lastAward?.item;
          if (item) revealedByClient.set(client, Math.max(revealedByClient.get(client)!, Number(item.slot.split(':')[1]) + 1));
        }
        packets.push({ event, payload: args, revealed: revealedByClient.get(client)! });
      });
    }
    await emitAndWait(host, 'join', { code, name: 'Host', colour: '#fff' }, 'room:state');
    await emitAndWait(guest, 'join', { code, name: 'Guest', colour: '#000' }, 'room:state');
    const receipt = await (await fetch(`${base}/api/rooms/${code}/hands`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deckId: 'pizza' }),
    })).json();
    packets.push({ event: 'HTTP hands receipt', payload: receipt, revealed: 0 });
    const hands = await vi.mocked(generateHands).mock.results.at(-1)!.value;
    const ordered = Array.from({ length: 5 }, (_, index) => [hands.chefOne.ingredients[index]!, hands.chefTwo.ingredients[index]!]).flat();
    expect(new Set(ordered.map((ingredient) => ingredient.id)).size).toBe(10);
    let state = await draft(host, 'draft:start', { code });
    await emitAndWait(guest, 'draft:reveal', { code }, 'draft:error');
    for (let index = 0; index < 10; index++) {
      state = await draft(host, 'draft:reveal', { code });
      if (state.phase === 'auction') {
        state = await draft(host, 'draft:bid', { code, chef: 'chefOne', amount: 1 });
        state = await draft(guest, 'draft:take-it', { code, chef: 'chefTwo' });
      }
    }
    expect(state.phase).toBe('plating');
    await emitAndWait(host, 'draft:reveal', { code }, 'draft:error');
    const roomUpdate = new Promise((resolve) => host.once('room:state', resolve));
    guest.close();
    await roomUpdate;
    expect(packets.some((packet) => packet.event === 'room:state')).toBe(true);
    expect(packets.some((packet) => packet.event === 'draft:error')).toBe(true);
    expect(packets.filter((packet) => packet.event === 'draft:state')).toHaveLength(42);
    for (const { event, payload, revealed } of packets) {
      const strings: string[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (value && typeof value === 'object') {
          for (const [key, entry] of Object.entries(value)) { strings.push(key); walk(entry); }
        }
      };
      walk(payload);
      const json = JSON.stringify(payload);
      for (const ingredient of ordered.slice(revealed)) {
        expect(strings, `${event} before reveal ${revealed}`).not.toContain(ingredient.id);
        expect(strings, `${event} before reveal ${revealed}`).not.toContain(ingredient.name);
        expect(json, `${event} before reveal ${revealed}`).not.toContain(ingredient.id);
        expect(json, `${event} before reveal ${revealed}`).not.toContain(ingredient.name);
      }
    }
  });

  it('broadcasts server clock expiry over sockets and ignores forged client clock readings', async () => {
    const { code, host, guest } = await table();
    await draft(host, 'draft:start', { code });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const revealed = await draft(host, 'draft:reveal', { code, now: 0 });
    expect(revealed.deadline).toBe(Date.now() + 10000);
    vi.advanceTimersByTime(2000);
    const bid = await draft(host, 'draft:bid', { code, chef: 'chefOne', amount: 3, now: 0, deadline: 0 });
    expect(bid.deadline).toBe(Date.now() + 10000);
    const hostAward = new Promise<PublicDraftState>((resolve) => host.once('draft:state', resolve));
    const guestAward = new Promise<PublicDraftState>((resolve) => guest.once('draft:state', resolve));
    await vi.advanceTimersByTimeAsync(9999);
    await vi.advanceTimersByTimeAsync(1);
    const [state, echo] = await Promise.all([hostAward, guestAward]);
    expect(state).toEqual(echo);
    expect(state.lastAward).toMatchObject({ chef: 'chefOne', price: 3, reason: 'timeout' });
    expect(state.chefs.chefOne.coins).toBe(7);
    expect(state.deadline).toBeNull();
  });

  it('gifts and trades revealed slots only, with acceptance by the other seat', async () => {
    const { code, host, guest } = await table();
    await draft(host, 'draft:start', { code });
    await draft(host, 'draft:reveal', { code });
    await draft(host, 'draft:bid', { code, chef: 'chefOne', amount: 1 });
    await draft(guest, 'draft:take-it', { code, chef: 'chefTwo' });
    await draft(host, 'draft:reveal', { code });
    await draft(host, 'draft:take-it', { code, chef: 'chefOne' });
    const offer = await draft(host, 'draft:trade', { code, chef: 'chefOne', give: '1:0', receive: '1:1' });
    expect(offer.pendingTrade).toEqual({ from: 'chefOne', give: '1:0', receive: '1:1' });
    const error = await emitAndWait<{ code: string }>(host, 'draft:respond-trade', { code, chef: 'chefOne', accept: true }, 'draft:error');
    expect(error.code).toBe('wrong-turn');
    const accepted = await draft(guest, 'draft:respond-trade', { code, chef: 'chefTwo', accept: true });
    expect(accepted.chefs.chefOne.items[0]?.slot).toBe('1:1');
    expect(accepted.chefs.chefTwo.items[0]?.slot).toBe('1:0');
    expect(accepted.pendingTrade).toBeNull();
    const other = await table();
    await draft(other.host, 'draft:start', { code: other.code });
    await draft(other.host, 'draft:reveal', { code: other.code });
    await draft(other.host, 'draft:bid', { code: other.code, chef: 'chefOne', amount: 1 });
    await draft(other.guest, 'draft:take-it', { code: other.code, chef: 'chefTwo' });
    const gifted = await draft(other.host, 'draft:gift', { code: other.code, chef: 'chefOne', slot: '1:0' });
    expect(gifted.exchangeUsed).toBe(true);
    expect(gifted.chefs.chefOne.items).toEqual([]);
    expect(gifted.chefs.chefTwo.items[0]?.slot).toBe('1:0');
  });

  it('refuses malformed socket payloads without echoing untrusted content', async () => {
    const { code, host, guest } = await table();
    for (const payload of [null, [], {}, { code: 4 }]) {
      const error = await emitAndWait<{ code: string }>(host, 'draft:start', payload, 'draft:error');
      expect(error.code).toBe('invalid-action');
    }
    await draft(host, 'draft:start', { code });
    await draft(host, 'draft:reveal', { code });
    const badBid = await emitAndWait<{ code: string }>(host, 'draft:bid', { code, chef: 'chefOne', amount: 'hidden-content' }, 'draft:error');
    expect(badBid.code).toBe('invalid-bid');
    expect(JSON.stringify(badBid)).not.toContain('hidden-content');
    await draft(host, 'draft:bid', { code, chef: 'chefOne', amount: 1 });
    await draft(guest, 'draft:take-it', { code, chef: 'chefTwo' });
  });

  it('keeps chef seats and host authority stable when seat one disconnects', async () => {
    const { code, host, guest } = await table();
    await draft(host, 'draft:start', { code });
    await draft(host, 'draft:reveal', { code });
    const left = new Promise((resolve) => guest.once('room:state', resolve));
    host.close();
    await left;
    const impostor = await emitAndWait<{ code: string }>(guest, 'draft:bid', { code, chef: 'chefOne', amount: 1 }, 'draft:error');
    expect(impostor.code).toBe('invalid-chef');
    const referee = await emitAndWait<{ code: string }>(guest, 'draft:reveal', { code }, 'draft:error');
    expect(referee.code).toBe('invalid-action');
    const ownSeat = await emitAndWait<{ code: string }>(guest, 'draft:bid', { code, chef: 'chefTwo', amount: 1 }, 'draft:error');
    expect(ownSeat.code).toBe('wrong-turn');
  });

  it('cannot start after a chef disconnects, or join several rooms on one socket', async () => {
    const { code, host, guest } = await table();
    const left = new Promise((resolve) => host.once('room:state', resolve));
    guest.close();
    await left;
    const error = await emitAndWait<{ code: string }>(host, 'draft:start', { code }, 'draft:error');
    expect(error.code).toBe('wrong-phase');
    const other = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json() as { code: string };
    const joinError = await emitAndWait<{ reason: string }>(host, 'join', { code: other.code, name: 'Other', colour: '#fff' }, 'join:error');
    expect(joinError.reason).toContain('already seated');
  });

  it('keeps refusals sender-only and broadcasts accepted state only inside its room', async () => {
    const { code, host, guest } = await table();
    const other = await table();
    const hostErrors: unknown[] = [];
    const guestErrors: unknown[] = [];
    const outsiderStates: unknown[] = [];
    host.on('draft:error', (error) => hostErrors.push(error));
    guest.on('draft:error', (error) => guestErrors.push(error));
    other.host.on('draft:state', (state) => outsiderStates.push(state));
    other.guest.on('draft:state', (state) => outsiderStates.push(state));
    await draft(host, 'draft:start', { code });
    await emitAndWait(guest, 'draft:reveal', { code }, 'draft:error');
    const revealed = await draft(host, 'draft:reveal', { code });
    expect(revealed.auction?.standingBid).toBe(0);
    expect(hostErrors).toEqual([]);
    expect(guestErrors).toHaveLength(1);
    const barrier = new Promise((resolve) => other.guest.once('room:state', resolve));
    other.host.close();
    await barrier;
    expect(outsiderStates).toEqual([]);
    await draft(host, 'draft:take-it', { code, chef: 'chefOne' });
  });

  it('greets a client over a real socket connection', async () => {
    const { hello } = await connect();
    expect(hello.service).toBe('mystery-menu');
    expect(hello.socketId).toBeTruthy();
  });

  it('gives every client its own socket id', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);
    expect(first.hello.socketId).not.toBe(second.hello.socketId);
  });
});
