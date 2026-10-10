import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createGameServer } from '../server/server.ts';
import type { PublicDraftState } from '../server/draft/engine.ts';
import type { PublicVoteState } from '../server/votes.ts';

vi.mock('../server/ingredients/generate.ts', async (original) => {
  const actual = await original<typeof import('../server/ingredients/generate.ts')>();
  return { ...actual, generateHands: (deck: Parameters<typeof actual.generateHands>[0], options: Parameters<typeof actual.generateHands>[1]) => actual.generateHands(deck, { vegetarianOnly: options?.vegetarianOnly, random: () => 0 }) };
});
let server: ReturnType<typeof createGameServer>;
let base: string;
const clients: Socket[] = [];
beforeAll(async () => {
  server = createGameServer();
  server.http.listen(0, '127.0.0.1');
  await new Promise(resolve => server.http.once('listening', resolve));
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  clients.forEach(client => client.close());
  await new Promise<void>(resolve => server.io.close(() => resolve()));
});
function wait<T>(client: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off(event, listener); reject(new Error(`no ${event}`)); }, 2000);
    const listener = (payload: T) => { clearTimeout(timer); resolve(payload); };
    client.once(event, listener);
  });
}
async function request<T>(client: Socket, event: string, payload: unknown, response: string): Promise<T> {
  const result = wait<T>(client, response); client.emit(event, payload); return result;
}
async function connect(): Promise<Socket> {
  const client = ioClient(base, { transports: ['websocket'], reconnection: false });
  clients.push(client); await wait(client, 'hello'); return client;
}
async function setup(tableSeats = 2) {
  const { code } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json() as { code: string };
  const host = await connect(); const guest = await connect();
  await request(host, 'join', { code, name: 'Cook A', colour: '#ffaabb' }, 'room:state');
  const hostJoin = wait(host, 'room:state');
  await request(guest, 'join', { code, name: 'Cook B', colour: '#aabbff' }, 'room:state'); await hostJoin;
  const diners: Socket[] = [];
  for (let i = 0; i < tableSeats; i++) {
    const diner = await connect(); diners.push(diner);
    const echoes = [host, guest, ...diners.slice(0, -1)].map(c => wait(c, 'room:state'));
    await request(diner, 'join', { code, name: `private-diner-name-${i}`, colour: `private-colour-${i}`, role: 'table' }, 'room:state');
    await Promise.all(echoes);
  }
  const peers = [host, guest, ...diners];
  const draft = async (client: Socket, event: string, payload: unknown) => {
    const echoes = peers.map(peer => wait<PublicDraftState>(peer, 'draft:state'));
    client.emit(event, payload);
    const states = await Promise.all(echoes);
    states.forEach(s => expect(s).toEqual(states[0]));
    return states[0]!;
  };
  const finish = async () => {
    expect((await fetch(`${base}/api/rooms/${code}/hands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deckId: 'pizza', vegetarianOnly: true }) })).status).toBe(200);
    let state = await draft(host, 'draft:start', { code });
    for (let i = 0; i < 10; i++) {
      state = await draft(host, 'draft:reveal', { code });
      if (state.auction) state = await draft(state.auction.turn === 'chefOne' ? host : guest, 'draft:take-it', { code, chef: state.auction.turn });
    }
    expect(state.phase).toBe('plating');
  };
  return { code, host, guest, diners, peers, finish, draft };
}
async function broadcast(peers: Socket[], sender: Socket, event: string, payload: unknown) {
  const echoes = peers.map(peer => wait<PublicVoteState>(peer, 'vote:state'));
  sender.emit(event, payload);
  const states = await Promise.all(echoes);
  states.forEach(s => expect(s).toEqual(states[0]));
  return states[0]!;
}

describe('anonymous socket vote', () => {
  it('plays a full two-voter ballot, walks EVERY emitted payload and never broadcasts arrival-order counts', async () => {
    const { code, host, guest, diners, peers, finish } = await setup();
    const waitingEcho = Promise.all(peers.map(peer => wait<PublicVoteState>(peer, 'vote:state')));
    await finish();
    const waiting = await waitingEcho;
    expect(waiting[0]!.tally.phase).toBe('waiting');
    const packets: { event: string; payload: unknown }[] = waiting.map(payload => ({ event: 'vote:state waiting', payload }));
    peers.forEach(peer => peer.onAny((event, ...args: unknown[]) => packets.push({ event, payload: args })));
    const opened = await broadcast(peers, host, 'vote:open', { code });
    expect(opened.tally.phase).toBe('open');
    const result = await request<{ ok: true }>(diners[0]!, 'vote:cast', { code, dish: 'chefOne' }, 'vote:accepted');
    expect(result).toEqual({ ok: true });
    const duplicate = await request<{ code: string }>(diners[0]!, 'vote:cast', { code, dish: 'chefTwo' }, 'vote:error');
    expect(duplicate.code).toBe('already-voted');
    const closed = await broadcast(peers, diners[1]!, 'vote:cast', { code, dish: 'chefOne' });
    expect(closed.tally).toMatchObject({ phase: 'closed', total: 2, winner: 'chefOne', tie: false });
    expect(closed.tally.dishes.map(d => [d.count, d.vegetarian])).toEqual([[2, true], [0, true]]);
    expect(packets.filter(p => p.event === 'vote:state')).toHaveLength(peers.length * 2);
    const forbidden = diners.flatMap((diner, i) => [diner.id!, `private-diner-name-${i}`, `private-colour-${i}`]);
    forbidden.push(host.id!, guest.id!); // Chef names are dish labels, not voter metadata.
    for (const { event, payload } of packets) {
      const strings: string[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { strings.push(key); walk(entry); }
      };
      walk(payload);
      for (const identity of forbidden) {
        expect(strings, event).not.toContain(identity);
        expect(JSON.stringify(payload), event).not.toContain(identity);
      }
      for (const key of ['voter', 'voters', 'ballots', 'eligible', 'seatKey', 'socketId', 'colour']) expect(strings, event).not.toContain(key);
    }
  });

  it('authorizes host open, eligible seats only, malformed requests, and other-room sockets', async () => {
    const { code, host, guest, diners, peers, finish } = await setup(1);
    const outsider = await connect();
    const { code: otherCode } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json() as { code: string };
    await request(outsider, 'join', { code: otherCode, name: 'Other table', colour: '#fff', role: 'table' }, 'room:state');
    const refused = async (client: Socket, event: string, payload: unknown, expected: string) => {
      expect(await request(client, event, payload, 'vote:error')).toMatchObject({ code: expected });
    };
    await refused(host, 'vote:open', { code }, 'wrong-phase');
    await refused(guest, 'vote:open', { code }, 'invalid-action');
    await refused(outsider, 'vote:cast', { code, dish: 'chefOne' }, 'not-eligible');
    const waiting = Promise.all(peers.map(peer => wait(peer, 'vote:state'))); await finish(); await waiting;
    await refused(diners[0]!, 'vote:cast', { code, dish: 'chefOne' }, 'wrong-phase');
    await broadcast(peers, host, 'vote:open', { code });
    await refused(host, 'vote:open', { code }, 'wrong-phase');
    await refused(host, 'vote:cast', { code, dish: 'chefOne', voter: diners[0]!.id }, 'not-eligible');
    expect(await request(host, 'draft:trade', { code, chef: 'chefOne', give: '1:5', receive: '1:0' }, 'draft:error')).toMatchObject({ code: 'wrong-phase' });
    for (const payload of [null, [], {}, { code: 4 }]) await refused(diners[0]!, 'vote:cast', payload, 'invalid-action');
    await refused(diners[0]!, 'vote:cast', { code, dish: 'secret-id' }, 'invalid-dish');
    const closed = await broadcast(peers, diners[0]!, 'vote:cast', { code, dish: 'chefTwo' });
    expect(closed.tally.winner).toBe('chefTwo');
    await refused(diners[0]!, 'vote:cast', { code, dish: 'chefOne' }, 'already-voted');
  });

  it('supports a two-player self-vote tie without inventing a draft winner', async () => {
    const { code, host, guest, peers, finish } = await setup(0);
    const waiting = Promise.all(peers.map(peer => wait(peer, 'vote:state'))); await finish(); await waiting;
    await broadcast(peers, host, 'vote:open', { code });
    expect(await request(host, 'vote:cast', { code, dish: 'chefOne' }, 'vote:accepted')).toEqual({ ok: true });
    const tied = await broadcast(peers, guest, 'vote:cast', { code, dish: 'chefTwo' });
    expect(tied.tally).toMatchObject({ tie: true, winner: null, total: 2, phase: 'closed' });
  });
});
