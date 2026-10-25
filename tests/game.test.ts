import { SHOT_CLOCK_MS, STARTING_COINS } from '../server/draft/engine.ts';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameSessions } from '../server/game.ts';
import { createApp } from '../server/app.ts';
import { RoomRegistry } from '../server/rooms.ts';
import { createVeniceClient } from '../server/venice/client.ts';

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function boot(registry: RoomRegistry): Promise<string> {
  const venice = { ...createVeniceClient(), chat: async () => { throw new Error('offline test'); } };
  const server = createServer(createApp(registry, venice));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port assigned');
  return `http://127.0.0.1:${address.port}`;
}

function postHands(base: string, code: string, body: unknown = { deckId: 'pizza', vegetarianOnly: true }): Promise<Response> {
  return fetch(`${base}/api/rooms/${code}/hands`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('server-owned shot clock', () => {
  async function session() {
    const rooms = new RoomRegistry();
    const room = rooms.create();
    rooms.join(room, 'one', 'One', '#fff');
    rooms.join(room, 'two', 'Two', '#000');
    const broadcasts = vi.fn();
    const games = new GameSessions(rooms, broadcasts);
    await games.generate(room.code, 'pizza', false);
    const game = games.get(room.code);
    game.start();
    return { rooms, room, games, game, broadcasts };
  }

  it('reschedules across several bids and awards only at the current deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { game, broadcasts } = await session();
    game.act({ type: 'reveal' });
    expect(vi.getTimerCount()).toBe(1);
    for (const [chef, amount] of [['chefOne', 1], ['chefTwo', 2], ['chefOne', 3]] as const) {
      vi.advanceTimersByTime(amount === 1 ? SHOT_CLOCK_MS - 1000 : SHOT_CLOCK_MS - 2000);
      game.act({ type: 'bid', chef, amount });
      expect(game.publicState()?.deadline).toBe(Date.now() + SHOT_CLOCK_MS);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1000); // Each replaced clock would fire here.
      expect(game.publicState()?.phase).toBe('auction');
    }
    vi.advanceTimersByTime(SHOT_CLOCK_MS - 1001);
    expect(broadcasts).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1001);
    expect(game.publicState()?.lastAward).toMatchObject({ chef: 'chefOne', price: 3, reason: 'timeout' });
    expect(game.publicState()?.chefs.chefOne.coins).toBe(STARTING_COINS - 3);
    expect(vi.getTimerCount()).toBe(0);
    expect(broadcasts).toHaveBeenCalledOnce();
    game.act({ type: 'reveal' });
    vi.advanceTimersByTime(SHOT_CLOCK_MS);
    expect(game.publicState()?.lastAward).toMatchObject({ chef: 'chefTwo', price: 0, reason: 'timeout' });
    expect(broadcasts).toHaveBeenCalledTimes(2);
  });

  it('rejects deadline bids without clearing expiry and survives backward wall-clock readings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { game, broadcasts } = await session();
    game.act({ type: 'reveal' });
    vi.setSystemTime(500);
    game.act({ type: 'bid', chef: 'chefOne', amount: 1 });
    expect(game.publicState()?.deadline).toBe(1000 + SHOT_CLOCK_MS);
    vi.setSystemTime(1000 + SHOT_CLOCK_MS);
    expect(() => game.act({ type: 'bid', chef: 'chefTwo', amount: 2 })).toThrow('Record the timeout');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(SHOT_CLOCK_MS + 500);
    expect(game.publicState()?.lastAward).toMatchObject({ chef: 'chefOne', price: 1, reason: 'timeout' });
    expect(broadcasts).toHaveBeenCalledOnce();
  });

  it('ignores an already queued stale callback across bids and different slots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const { game, broadcasts } = await session();
    game.act({ type: 'reveal' });
    const first = timers.mock.calls.at(-1)![0] as () => void;
    game.act({ type: 'bid', chef: 'chefOne', amount: 1 });
    game.act({ type: 'bid', chef: 'chefTwo', amount: 2 });
    const before = game.publicState();
    first(); // Same slot, turn and deadline; only timer identity changed.
    expect(game.publicState()).toEqual(before);
    game.act({ type: 'take-it', chef: 'chefOne' });
    game.act({ type: 'reveal' });
    const next = game.publicState();
    first(); // New item with the exact same deadline and turn.
    expect(game.publicState()).toEqual(next);
    expect(broadcasts).not.toHaveBeenCalled();
    timers.mockRestore();
  });

  it('owns vegetarian hands, projects detached public state and cannot redeal an active draft', async () => {
    const rooms = new RoomRegistry();
    const room = rooms.create();
    rooms.join(room, 'one', 'One', '#fff');
    rooms.join(room, 'two', 'Two', '#000');
    const games = new GameSessions(rooms);
    await games.generate(room.code, 'pizza', true);
    const game = games.get(room.code.toLowerCase());
    expect(game.publicState()).toBeNull();
    game.start();
    await expect(games.generate(room.code, 'pizza', false)).rejects.toMatchObject({ code: 'wrong-phase' });
    expect(() => game.start()).toThrow('Prepare hands');
    const detached = game.publicState()!;
    detached.chefs.chefOne.coins = 0;
    expect(game.publicState()?.chefs.chefOne.coins).toBe(STARTING_COINS);
    for (let index = 0; index < 10; index++) {
      game.act({ type: 'reveal' });
      const state = game.publicState()!;
      if (state.auction) game.act({ type: 'take-it', chef: state.auction.turn });
    }
    expect(game.publicState()?.phase).toBe('plating');
    expect(Object.values(game.publicState()!.chefs).flatMap((chef) => chef.items).every((item) => item.ingredient.vegetarian)).toBe(true);
    expect(Object.keys(rooms.state(room)).sort()).toEqual(['capacity', 'code', 'hostId', 'players']);
    expect(room).not.toHaveProperty('hands');
    games.dispose();
  });

  it('rejects concurrent generation and never resurrects deleted in-flight hands', async () => {
    const rooms = new RoomRegistry();
    const room = rooms.create();
    rooms.join(room, 'one', 'One', '#fff');
    rooms.join(room, 'two', 'Two', '#000');
    const games = new GameSessions(rooms);
    let unblock!: () => void;
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    const venice = { ...createVeniceClient(), chat: async () => { await wait; throw new Error('offline'); } };
    const pending = games.generate(room.code, 'pizza', false, venice);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'wrong-phase' });
    await expect(games.generate(room.code, 'pizza', false)).rejects.toMatchObject({ code: 'wrong-phase' });
    const game = games.get(room.code);
    expect(() => game.start()).toThrow('Prepare hands');
    rooms.delete(room.code);
    unblock();
    await rejected;
    expect(game.publicState()).toBeNull();
    expect(() => game.start()).toThrow('Prepare hands');
    expect(() => games.get(room.code)).toThrow('not open');
  });

  it('clears timers when the last occupant leaves and on server disposal', async () => {
    vi.useFakeTimers();
    const { game, rooms, room, games, broadcasts } = await session();
    game.act({ type: 'reveal' });
    rooms.leaveBySocket('one');
    expect(rooms.get(room.code)).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
    rooms.leaveBySocket('two');
    expect(rooms.get(room.code)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SHOT_CLOCK_MS);
    expect(broadcasts).not.toHaveBeenCalled();
    games.dispose();
    const other = await session();
    other.game.act({ type: 'reveal' });
    expect(vi.getTimerCount()).toBe(1);
    other.games.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(other.game.publicState()).toBeNull();
  });

  it('clears all room timers and private state on room deletion', async () => {
    vi.useFakeTimers();
    const { game, rooms, room, games, broadcasts } = await session();
    game.act({ type: 'reveal' });
    expect(vi.getTimerCount()).toBe(1);
    expect(rooms.delete(room.code)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(game.publicState()).toBeNull();
    expect(() => games.get(room.code)).toThrow('not open');
    vi.advanceTimersByTime(30000);
    expect(broadcasts).not.toHaveBeenCalled();
  });
});

describe('secret hands HTTP receipt', () => {
  it('refuses unknown rooms and rooms without two seated chefs', async () => {
    const rooms = new RoomRegistry();
    const base = await boot(rooms);
    expect((await postHands(base, '%3F%3F%3F%3F')).status).toBe(404);
    const room = rooms.create();
    expect((await postHands(base, room.code)).status).toBe(409);
    rooms.join(room, 'one', 'One', '#fff');
    expect((await postHands(base, room.code)).status).toBe(409);
  });

  it('validates setup options and canonicalizes the room code', async () => {
    const rooms = new RoomRegistry();
    const room = rooms.create();
    rooms.join(room, 'one', 'One', '#fff');
    rooms.join(room, 'two', 'Two', '#000');
    const base = await boot(rooms);
    for (const body of [{}, { deckId: 'unknown' }, { deckId: 'pizza', vegetarianOnly: 'true' }, []]) {
      expect((await postHands(base, room.code, body)).status).toBe(400);
    }
    const response = await postHands(base, room.code.toLowerCase(), { deckId: 'pizza' });
    expect(await response.json()).toEqual({ ok: true, vegetarianOnly: false });
  });
  it('returns only a receipt, never ingredient content or a content-derived count', async () => {
    const rooms = new RoomRegistry();
    const room = rooms.create();
    rooms.join(room, 'one', 'One', '#fff');
    rooms.join(room, 'two', 'Two', '#000');
    const response = await postHands(await boot(rooms), room.code);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, vegetarianOnly: true });
  });
});
