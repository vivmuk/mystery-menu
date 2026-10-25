import { describe, expect, it } from 'vitest';
import { DECKS, deckById, type Random } from '../server/ingredients/deck.ts';
import { dealHands } from '../server/ingredients/generate.ts';
import {
  createDraft, DraftError, publicState, reduce, SHOT_CLOCK_MS, STARTING_COINS,
  type DraftAction, type DraftErrorCode, type DraftState,
} from '../server/draft/engine.ts';

function rejected(state: DraftState, action: DraftAction, code: DraftErrorCode): void {
  const before = structuredClone(state);
  expect(() => reduce(state, action)).toThrow(DraftError);
  try {
    reduce(state, action);
  } catch (error) {
    expect((error as DraftError).code).toBe(code);
  }
  expect(state).toEqual(before);
}

function auction(): DraftState {
  return reduce(createDraft(hands(), 0), { type: 'reveal', now: 0 });
}

function twoAwards(): DraftState {
  let state = reduce(auction(), { type: 'take-it', chef: 'chefOne', now: 0 });
  state = reduce(state, { type: 'reveal', now: 0 });
  state = reduce(state, { type: 'bid', chef: 'chefOne', amount: 1, now: 0 });
  return reduce(state, { type: 'take-it', chef: 'chefTwo', now: 0 });
}

function finishDraft(state = createDraft(hands(), 0)): DraftState {
  while (state.public.phase === 'reveal' || state.public.phase === 'auction') {
    if (state.public.phase === 'reveal') state = reduce(state, { type: 'reveal', now: state.private.now });
    else state = reduce(state, { type: 'take-it', chef: state.public.auction!.turn, now: state.private.now });
  }
  return state;
}

/** The dealer and action driver consume the same reproducible random stream. */
function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return (max) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * max);
  };
}

const hands = () => dealHands(deckById('pizza')!, () => 0);

describe('Budget Draft', () => {
  it('starts with ten secret items, five seats and the starting purse per chef', () => {
    const state = createDraft(hands(), 1000);
    const payload = publicState(state);
    expect(payload.phase).toBe('reveal');
    expect(payload.round).toBe(1);
    expect(payload.totalItems).toBe(10);
    expect(payload.chefs.chefOne).toEqual({ coins: STARTING_COINS, items: [] });
    expect(payload.chefs.chefTwo).toEqual({ coins: STARTING_COINS, items: [] });
    expect(payload.auction).toBeNull();
    expect(payload.deadline).toBeNull();
    expect(payload.exchangeUsed).toBe(false);
    expect(payload.scores).toEqual({ chefOne: 0, chefTwo: 0 });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const serialized = JSON.stringify(payload);
    for (const hand of Object.values(hands())) {
      for (const ingredient of hand.ingredients) {
        expect(serialized).not.toContain(ingredient.id);
        expect(serialized).not.toContain(ingredient.name);
      }
    }
  });

  it('reveals only the announced item and declares a twenty-five-second deadline', () => {
    const state = createDraft(hands(), 1000);
    const next = reduce(state, { type: 'reveal', now: 2000 });
    expect(next.public.phase).toBe('auction');
    expect(next.public.auction?.item.ingredient).toEqual(hands().chefOne.ingredients[0]);
    expect(next.public.auction?.turn).toBe('chefOne');
    expect(next.public.auction?.standingBid).toBe(0);
    expect(next.public.deadline).toBe(2000 + SHOT_CLOCK_MS);
    expect(state.public.phase).toBe('reveal');
    expect(state.public.auction).toBeNull();
  });

  it('bids upward, alternates turns and resets the clock without charging yet', () => {
    const original = auction();
    let state = reduce(original, { type: 'bid', chef: 'chefOne', amount: 1, now: 500 });
    expect(state.public.auction).toMatchObject({ turn: 'chefTwo', standingBid: 1, bidder: 'chefOne' });
    expect(state.public.chefs.chefOne.coins).toBe(STARTING_COINS);
    expect(state.public.deadline).toBe(500 + SHOT_CLOCK_MS);
    state = reduce(state, { type: 'bid', chef: 'chefTwo', amount: 3, now: 700 });
    expect(state.public.auction).toMatchObject({ turn: 'chefOne', standingBid: 3, bidder: 'chefTwo' });
    expect(state.public.deadline).toBe(700 + SHOT_CLOCK_MS);
    expect(original.public.auction?.standingBid).toBe(0);
  });

  it('Take it awards the OTHER chef the item and deducts exactly the standing price', () => {
    const bid = reduce(auction(), { type: 'bid', chef: 'chefOne', amount: 3, now: 1 });
    const state = reduce(bid, { type: 'take-it', chef: 'chefTwo', now: 2 });
    expect(state.public.phase).toBe('reveal');
    expect(state.public.chefs.chefOne.coins).toBe(STARTING_COINS - 3);
    expect(state.public.chefs.chefOne.items).toEqual([bid.public.auction!.item]);
    expect(state.public.chefs.chefTwo.items).toEqual([]);
    expect(state.public.auction).toBeNull();
    expect(state.public.deadline).toBeNull();
  });

  it('a concede before the first bid gives the opponent the item free', () => {
    const state = reduce(auction(), { type: 'take-it', chef: 'chefOne', now: 0 });
    expect(state.public.chefs.chefTwo.items).toHaveLength(1);
    expect(state.public.chefs.chefTwo.coins).toBe(STARTING_COINS);
  });

  it('rejects wrong-turn bids and concessions without mutating state', () => {
    rejected(auction(), { type: 'bid', chef: 'chefTwo', amount: 1, now: 0 }, 'wrong-turn');
    rejected(auction(), { type: 'take-it', chef: 'chefTwo', now: 0 }, 'wrong-turn');
  });

  it('rejects equal, lower, fractional, negative and non-finite bids', () => {
    const state = reduce(auction(), { type: 'bid', chef: 'chefOne', amount: 3, now: 0 });
    for (const amount of [3, 2, 0, -1, 4.5, NaN, Infinity]) {
      rejected(state, { type: 'bid', chef: 'chefTwo', amount, now: 0 }, 'invalid-bid');
    }
  });

  it('rejects bids over the remaining purse, not just the starting purse', () => {
    const spent = 7;
    let state = reduce(auction(), { type: 'bid', chef: 'chefOne', amount: spent, now: 0 });
    state = reduce(state, { type: 'take-it', chef: 'chefTwo', now: 0 });
    state = reduce(state, { type: 'reveal', now: 0 });
    const remaining = STARTING_COINS - spent;
    rejected(state, { type: 'bid', chef: 'chefOne', amount: remaining + 1, now: 0 }, 'insufficient-coins');
    rejected(state, { type: 'bid', chef: 'chefOne', amount: STARTING_COINS, now: 0 }, 'insufficient-coins');
  });

  it('records an explicit timeout at the deadline as a concede', () => {
    const state = reduce(auction(), { type: 'bid', chef: 'chefOne', amount: 2, now: 50 });
    const deadline = 50 + SHOT_CLOCK_MS;
    rejected(state, { type: 'timeout', chef: 'chefTwo', slot: '1:0', deadline: deadline + 1, now: deadline + 1 }, 'stale-timeout');
    rejected(state, { type: 'timeout', chef: 'chefTwo', slot: '1:0', deadline, now: deadline - 1 }, 'too-early');
    const next = reduce(state, { type: 'timeout', chef: 'chefTwo', slot: '1:0', deadline, now: deadline });
    expect(next.public.chefs.chefOne.coins).toBe(STARTING_COINS - 2);
    expect(next.public.chefs.chefOne.items).toHaveLength(1);
    expect(next.public.lastAward).toMatchObject({ chef: 'chefOne', price: 2, reason: 'timeout' });
    expect(next.public.phase).toBe('reveal');
  });

  it('a timeout without a standing bid awards the other chef at zero', () => {
    const state = reduce(auction(), { type: 'timeout', chef: 'chefOne', slot: '1:0', deadline: SHOT_CLOCK_MS, now: SHOT_CLOCK_MS + 10 });
    expect(state.public.chefs.chefTwo.coins).toBe(STARTING_COINS);
    expect(state.public.chefs.chefTwo.items).toHaveLength(1);
    expect(state.public.lastAward?.reason).toBe('timeout');
  });

  it('rejects expired player actions and stale or wrong-turn timeout notifications', () => {
    const state = auction();
    rejected(state, { type: 'bid', chef: 'chefOne', amount: 1, now: SHOT_CLOCK_MS }, 'clock-expired');
    rejected(state, { type: 'take-it', chef: 'chefOne', now: SHOT_CLOCK_MS + 1 }, 'clock-expired');
    rejected(state, { type: 'timeout', chef: 'chefTwo', slot: '1:0', deadline: SHOT_CLOCK_MS, now: SHOT_CLOCK_MS }, 'wrong-turn');
    rejected(state, { type: 'timeout', chef: 'chefOne', slot: '1:0', deadline: SHOT_CLOCK_MS - 1, now: SHOT_CLOCK_MS }, 'stale-timeout');
    let next = reduce(state, { type: 'bid', chef: 'chefOne', amount: 1, now: 1 });
    next = reduce(next, { type: 'bid', chef: 'chefTwo', amount: 2, now: 2 });
    rejected(next, { type: 'timeout', chef: 'chefOne', slot: '1:0', deadline: SHOT_CLOCK_MS, now: SHOT_CLOCK_MS }, 'stale-timeout');
  });

  it('auto-concedes when the opposing chef cannot afford a higher bid', () => {
    const state = reduce(auction(), { type: 'bid', chef: 'chefOne', amount: STARTING_COINS, now: 1 });
    expect(state.public.phase).toBe('reveal');
    expect(state.public.chefs.chefOne.coins).toBe(0);
    expect(state.public.chefs.chefOne.items).toHaveLength(1);
    expect(state.public.lastAward?.reason).toBe('unaffordable');
  });

  it('a broke chef is forced to take the remaining slots free, one reveal at a time', () => {
    let state = reduce(auction(), { type: 'bid', chef: 'chefOne', amount: STARTING_COINS, now: 1 });
    for (let count = 2; count <= 5; count++) {
      state = reduce(state, { type: 'reveal', now: count });
      expect(state.public.chefs.chefOne.items).toHaveLength(count);
      expect(state.public.chefs.chefOne.coins).toBe(0);
      expect(state.public.lastAward).toMatchObject({ chef: 'chefOne', price: 0, reason: 'broke' });
      expect(state.public.deadline).toBeNull();
    }
    while (state.public.phase === 'reveal') state = reduce(state, { type: 'reveal', now: 6 });
    expect(state.public.phase).toBe('plating');
    expect(state.public.chefs.chefOne.items).toHaveLength(5);
    expect(state.public.chefs.chefTwo.items).toHaveLength(5);
    expect(state.public.chefs.chefTwo.coins).toBe(STARTING_COINS);
    expect(state.public.lastAward?.reason).toBe('full');
  });

  it('a five-item chef cannot acquire a sixth, even with coins left', () => {
    let state = auction();
    for (let count = 0; count < 5; count++) {
      state = reduce(state, { type: 'take-it', chef: 'chefOne', now: 0 });
      if (count < 4) state = reduce(state, { type: 'reveal', now: 0 });
    }
    while (state.public.phase === 'reveal') state = reduce(state, { type: 'reveal', now: 0 });
    expect(state.public.chefs.chefOne.items).toHaveLength(5);
    expect(state.public.chefs.chefTwo.items).toHaveLength(5);
    expect(state.public.chefs.chefOne.coins).toBe(STARTING_COINS);
    expect(state.public.chefs.chefTwo.coins).toBe(STARTING_COINS);
    expect(state.public.phase).toBe('plating');
    rejected(state, { type: 'bid', chef: 'chefOne', amount: 1, now: 0 }, 'wrong-phase');
    rejected(state, { type: 'take-it', chef: 'chefOne', now: 0 }, 'wrong-phase');
    rejected(state, { type: 'reveal', now: 0 }, 'wrong-phase');
  });

  it('allows one free gift between auctions and keeps both dishes at five', () => {
    const original = twoAwards();
    const slot = original.public.chefs.chefOne.items[0]!.slot;
    const state = reduce(original, { type: 'gift', chef: 'chefOne', slot, now: 0 });
    expect(state.public.chefs.chefOne.items).toHaveLength(0);
    expect(state.public.chefs.chefTwo.items).toHaveLength(2);
    expect(state.public.chefs.chefOne.coins).toBe(STARTING_COINS - 1);
    expect(state.public.chefs.chefTwo.coins).toBe(STARTING_COINS);
    expect(state.public.exchangeUsed).toBe(true);
    rejected(state, { type: 'gift', chef: 'chefTwo', slot, now: 0 }, 'exchange-used');
    rejected(state, { type: 'trade', chef: 'chefTwo', give: slot, receive: '1:9', now: 0 }, 'exchange-used');
    const done = finishDraft(state);
    expect(done.public.chefs.chefOne.items).toHaveLength(5);
    expect(done.public.chefs.chefTwo.items).toHaveLength(5);
    expect(original.public.exchangeUsed).toBe(false);
  });

  it('validates gift ownership, revealed slots, recipient capacity and phase', () => {
    const state = twoAwards();
    rejected(state, { type: 'gift', chef: 'chefOne', slot: '1:9', now: 0 }, 'invalid-item');
    rejected(state, { type: 'gift', chef: 'chefOne', slot: state.public.chefs.chefTwo.items[0]!.slot, now: 0 }, 'invalid-item');
    const active = reduce(state, { type: 'reveal', now: 0 });
    rejected(active, { type: 'gift', chef: 'chefOne', slot: state.public.chefs.chefOne.items[0]!.slot, now: 0 }, 'wrong-phase');
    const full = finishDraft(state);
    rejected(full, { type: 'gift', chef: 'chefOne', slot: full.public.chefs.chefOne.items[0]!.slot, now: 0 }, 'hand-full');
  });

  it('offers one trade and swaps only after the other chef accepts', () => {
    const state = twoAwards();
    const give = state.public.chefs.chefOne.items[0]!.slot;
    const receive = state.public.chefs.chefTwo.items[0]!.slot;
    const offer = reduce(state, { type: 'trade', chef: 'chefOne', give, receive, now: 0 });
    expect(offer.public.chefs).toEqual(state.public.chefs);
    expect(offer.public.exchangeUsed).toBe(true);
    expect(offer.public.pendingTrade).toEqual({ from: 'chefOne', give, receive });
    rejected(offer, { type: 'respond-trade', chef: 'chefOne', accept: true, now: 0 }, 'wrong-turn');
    rejected(offer, { type: 'reveal', now: 0 }, 'pending-trade');
    rejected(offer, { type: 'gift', chef: 'chefTwo', slot: receive, now: 0 }, 'exchange-used');
    const accepted = reduce(offer, { type: 'respond-trade', chef: 'chefTwo', accept: true, now: 0 });
    expect(accepted.public.chefs.chefOne.items[0]?.slot).toBe(receive);
    expect(accepted.public.chefs.chefTwo.items[0]?.slot).toBe(give);
    expect(accepted.public.pendingTrade).toBeNull();
    expect(accepted.public.chefs.chefOne.coins).toBe(STARTING_COINS - 1);
    expect(accepted.public.chefs.chefTwo.coins).toBe(STARTING_COINS);
    rejected(accepted, { type: 'trade', chef: 'chefTwo', give, receive, now: 0 }, 'exchange-used');
  });

  it('declining a trade preserves ownership but consumes the single offer', () => {
    const state = twoAwards();
    const give = state.public.chefs.chefOne.items[0]!.slot;
    const receive = state.public.chefs.chefTwo.items[0]!.slot;
    const offer = reduce(state, { type: 'trade', chef: 'chefOne', give, receive, now: 0 });
    const declined = reduce(offer, { type: 'respond-trade', chef: 'chefTwo', accept: false, now: 0 });
    expect(declined.public.chefs).toEqual(state.public.chefs);
    expect(declined.public.exchangeUsed).toBe(true);
    expect(declined.public.pendingTrade).toBeNull();
    rejected(declined, { type: 'respond-trade', chef: 'chefTwo', accept: true, now: 0 }, 'no-trade');
  });

  it('validates both sides of a trade and permits trades at plating', () => {
    const state = twoAwards();
    const give = state.public.chefs.chefOne.items[0]!.slot;
    const receive = state.public.chefs.chefTwo.items[0]!.slot;
    rejected(state, { type: 'trade', chef: 'chefOne', give: receive, receive: give, now: 0 }, 'invalid-item');
    rejected(state, { type: 'trade', chef: 'chefOne', give, receive: '1:9', now: 0 }, 'invalid-item');
    const plated = finishDraft(state);
    const offer = reduce(plated, { type: 'trade', chef: 'chefOne', give, receive, now: 0 });
    const accepted = reduce(offer, { type: 'respond-trade', chef: 'chefTwo', accept: true, now: 0 });
    expect(accepted.public.chefs.chefOne.items).toHaveLength(5);
    expect(accepted.public.chefs.chefTwo.items).toHaveLength(5);
    expect(accepted.public.phase).toBe('plating');
  });

  it('plays a complete three-round match with reset budgets, hands and exchanges', () => {
    let state = createDraft(hands(), 0);
    for (const [index, winner] of (['chefOne', 'chefTwo', 'chefOne'] as const).entries()) {
      state = finishDraft(state);
      expect(state.public.chefs.chefOne.items).toHaveLength(5);
      expect(state.public.chefs.chefTwo.items).toHaveLength(5);
      expect(new Set(Object.values(state.public.chefs).flatMap((chef) => chef.items.map((item) => item.slot))).size).toBe(10);
      state = reduce(state, {
        type: 'trade', chef: 'chefOne', give: state.public.chefs.chefOne.items[0]!.slot,
        receive: state.public.chefs.chefTwo.items[0]!.slot, now: index,
      });
      rejected(state, { type: 'round-result', winner, now: index }, 'pending-trade');
      state = reduce(state, { type: 'respond-trade', chef: 'chefTwo', accept: true, now: index });
      state = reduce(state, { type: 'round-result', winner, now: index });
      expect(state.public.phase).toBe(index === 2 ? 'match-result' : 'round-result');
      expect(state.public.winner).toBe(winner);
      if (index !== 2) {
        state = reduce(state, { type: 'next-round', hands: hands(), now: index + 1 });
        expect(state.public.round).toBe(index + 2);
        expect(state.public.chefs.chefOne).toEqual({ coins: STARTING_COINS, items: [] });
        expect(state.public.chefs.chefTwo).toEqual({ coins: STARTING_COINS, items: [] });
        expect(state.public.exchangeUsed).toBe(false);
        expect(state.public.pendingTrade).toBeNull();
        expect(state.public.lastAward).toBeNull();
        expect(state.public.winner).toBeNull();
      }
    }
    expect(state.public.round).toBe(3);
    expect(state.public.scores).toEqual({ chefOne: 2, chefTwo: 1 });
    expect(state.public.winner).toBe('chefOne');
    for (const action of [
      { type: 'bid', chef: 'chefOne', amount: 1, now: 3 },
      { type: 'take-it', chef: 'chefOne', now: 3 },
      { type: 'timeout', chef: 'chefOne', slot: '1:0', deadline: 10000, now: 10000 },
      { type: 'gift', chef: 'chefOne', slot: '3:0', now: 3 },
      { type: 'trade', chef: 'chefOne', give: '3:0', receive: '3:1', now: 3 },
      { type: 'respond-trade', chef: 'chefTwo', accept: true, now: 3 },
      { type: 'reveal', now: 3 },
      { type: 'round-result', winner: 'chefTwo', now: 3 },
      { type: 'next-round', hands: hands(), now: 3 },
    ] satisfies DraftAction[]) rejected(state, action, 'match-ended');
  });

  it('stops best-of-three after a two-round sweep', () => {
    let state = reduce(finishDraft(), { type: 'round-result', winner: 'chefTwo', now: 0 });
    state = reduce(state, { type: 'next-round', hands: hands(), now: 0 });
    state = reduce(finishDraft(state), { type: 'round-result', winner: 'chefTwo', now: 0 });
    expect(state.public.phase).toBe('match-result');
    expect(state.public.round).toBe(2);
    expect(state.public.scores).toEqual({ chefOne: 0, chefTwo: 2 });
    rejected(state, { type: 'next-round', hands: hands(), now: 0 }, 'match-ended');
  });

  it('only accepts a referee result after all ten items and a new deck after a result', () => {
    rejected(auction(), { type: 'round-result', winner: 'chefOne', now: 0 }, 'wrong-phase');
    rejected(auction(), { type: 'next-round', hands: hands(), now: 0 }, 'wrong-phase');
    rejected(finishDraft(), { type: 'next-round', hands: hands(), now: 0 }, 'wrong-phase');
    const result = reduce(finishDraft(), { type: 'round-result', winner: 'chefOne', now: 0 });
    rejected(result, { type: 'round-result', winner: 'chefOne', now: 0 }, 'wrong-phase');
    rejected(result, { type: 'gift', chef: 'chefOne', slot: '1:0', now: 0 }, 'wrong-phase');
    rejected(result, { type: 'trade', chef: 'chefOne', give: '1:0', receive: '1:1', now: 0 }, 'wrong-phase');
    const bad = hands();
    bad.chefOne.ingredients.pop();
    rejected(result, { type: 'next-round', hands: bad, now: 0 }, 'invalid-hands');
  });

  it('rejects malformed wire actions, unknown chefs and invalid clock readings', () => {
    for (const action of [null, [], 'bid', {}, { type: 'unknown', now: 0 }] as unknown as DraftAction[]) {
      rejected(auction(), action, 'invalid-action');
    }
    for (const now of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => createDraft(hands(), now)).toThrow(DraftError);
      rejected(auction(), { type: 'bid', chef: 'chefOne', amount: 1, now }, 'invalid-time');
    }
    const state = reduce(auction(), { type: 'bid', chef: 'chefOne', amount: 1, now: 10 });
    rejected(state, { type: 'bid', chef: 'chefTwo', amount: 2, now: 9 }, 'invalid-time');
    for (const action of [
      { type: 'bid', chef: 'table', amount: 1, now: 0 },
      { type: 'take-it', chef: 'table', now: 0 },
      { type: 'gift', chef: 'table', slot: '1:0', now: 0 },
      { type: 'trade', chef: 'table', give: '1:0', receive: '1:1', now: 0 },
      { type: 'timeout', chef: 'table', slot: '1:0', deadline: 10000, now: 10000 },
      { type: 'respond-trade', chef: 'table', accept: true, now: 0 },
      { type: 'round-result', winner: 'table', now: 0 },
    ] as unknown as DraftAction[]) rejected(auction(), action, 'invalid-chef');
    const offer = reduce(twoAwards(), { type: 'trade', chef: 'chefOne', give: '1:1', receive: '1:0', now: 0 });
    rejected(offer, { type: 'respond-trade', chef: 'chefTwo', accept: 'yes', now: 0 } as unknown as DraftAction, 'invalid-action');
  });

  it('rejects a stale timeout from a previous item with the same turn and deadline', () => {
    let state = reduce(auction(), { type: 'take-it', chef: 'chefOne', now: 0 });
    state = reduce(state, { type: 'reveal', now: 0 });
    rejected(state, { type: 'timeout', chef: 'chefOne', slot: '1:0', deadline: 10000, now: 10000 }, 'stale-timeout');
  });

  it('keeps twists last even if validated input hands are not ordered', () => {
    const source = hands();
    for (const hand of Object.values(source)) hand.ingredients.reverse();
    const state = createDraft(source, 0);
    const twists = new Set(deckById('pizza')!.twistPool.map((ingredient) => ingredient.id));
    expect(state.private.remaining.slice(0, 8).some((item) => twists.has(item.ingredient.id))).toBe(false);
    expect(state.private.remaining.slice(8).every((item) => twists.has(item.ingredient.id))).toBe(true);
  });

  it('a chef who spends the last coins on item three gets exactly the last two slots free', () => {
    let state = auction();
    for (let item = 0; item < 3; item++) {
      state = reduce(state, { type: 'bid', chef: 'chefOne', amount: item === 2 ? STARTING_COINS - 2 : 1, now: 0 });
      state = reduce(state, { type: 'take-it', chef: 'chefTwo', now: 0 });
      if (item < 2) state = reduce(state, { type: 'reveal', now: 0 });
    }
    expect(state.public.chefs.chefOne.coins).toBe(0);
    expect(state.public.chefs.chefOne.items).toHaveLength(3);
    for (let item = 0; item < 2; item++) {
      state = reduce(state, { type: 'reveal', now: 0 });
      expect(state.public.lastAward?.reason).toBe('broke');
      expect(state.public.lastAward?.price).toBe(0);
    }
    expect(state.public.chefs.chefOne.items).toHaveLength(5);
    state = finishDraft(state);
    expect(state.public.chefs.chefTwo.items).toHaveLength(5);
  });

  it('validates setup and copies input hands and the public snapshot', () => {
    for (const value of [null, {}, { chefOne: null }, { ...hands(), chefTwo: { ...hands().chefTwo, deckId: 'tacos' } }]) {
      expect(() => createDraft(value as Parameters<typeof createDraft>[0], 0)).toThrow(DraftError);
    }
    const input = hands();
    const state = createDraft(input, 0);
    input.chefOne.ingredients[0] = { ...input.chefOne.ingredients[0]!, name: 'Mutated' };
    expect(state.private.remaining[0]!.ingredient.name).not.toBe('Mutated');
    const payload = publicState(state);
    payload.chefs.chefOne.coins = 0;
    expect(state.public.chefs.chefOne.coins).toBe(STARTING_COINS);
  });

  it('walks public JSON after every transition: no unrevealed id or name leaks', () => {
    const deck = deckById('pizza')!;
    // Distinct ingredients make this stronger than a deal with overlapping cores.
    const source = {
      chefOne: { deckId: deck.id, ingredients: [...deck.corePool.slice(0, 4), deck.twistPool[0]!] },
      chefTwo: { deckId: deck.id, ingredients: [...deck.corePool.slice(4, 8), deck.twistPool[1]!] },
    };
    let state = createDraft(source, 0);
    const check = (): void => {
      const payload: unknown = JSON.parse(JSON.stringify(publicState(state)));
      const strings: string[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (typeof value === 'object' && value !== null) for (const entry of Object.values(value)) walk(entry);
      };
      walk(payload);
      const serialized = JSON.stringify(payload);
      for (const item of state.private.remaining) {
        expect(strings).not.toContain(item.ingredient.id);
        expect(strings).not.toContain(item.ingredient.name);
        expect(serialized).not.toContain(item.ingredient.id);
        expect(serialized).not.toContain(item.ingredient.name);
      }
    };
    check();
    for (let index = 0; index < 10; index++) {
      state = reduce(state, { type: 'reveal', now: index });
      check();
      if (state.public.phase === 'auction') {
        state = reduce(state, { type: 'bid', chef: state.public.auction!.turn, amount: 1, now: index });
        check();
        if (state.public.phase === 'auction') {
          state = reduce(state, { type: 'take-it', chef: state.public.auction!.turn, now: index });
          check();
        }
      }
    }
    expect(state.public.phase).toBe('plating');
    const all = Object.values(state.public.chefs).flatMap((chef) => chef.items);
    expect(all).toHaveLength(10);
    expect(all.filter((item) => Number(item.slot.split(':')[1]) >= 8).every((item) => deck.twistPool.some((twist) => twist.id === item.ingredient.id))).toBe(true);
  });

  it.each(DECKS)('replays seeded $name matches byte-for-byte and preserves invariants', (deck) => {
    function run(seed: number, deck: (typeof DECKS)[number]): string[] {
      const random = seededRandom(seed);
      const snapshots: string[] = [];
      let state = createDraft(dealHands(deck, random, seed % 2 === 0), 0);
      const step = (action: DraftAction): void => {
        const before = structuredClone(state);
        const next = reduce(state, action);
        expect(state).toEqual(before);
        state = JSON.parse(JSON.stringify(next)) as DraftState;
        expect(state).toEqual(next);
        for (const chef of Object.values(state.public.chefs)) {
          expect(chef.coins).toBeGreaterThanOrEqual(0);
          expect(chef.coins).toBeLessThanOrEqual(STARTING_COINS);
          expect(chef.items.length).toBeLessThanOrEqual(5);
        }
        const items = Object.values(state.public.chefs).flatMap((chef) => chef.items)
          .concat(state.public.auction ? [state.public.auction.item] : [], state.private.remaining);
        expect(items).toHaveLength(10);
        expect(new Set(items.map((item) => item.slot)).size).toBe(10);
        snapshots.push(JSON.stringify(state));
      };
      while (state.public.phase !== 'match-result') {
        const now = state.private.now + 1;
        if (state.public.phase === 'reveal') step({ type: 'reveal', now });
        else if (state.public.phase === 'auction') {
          const auction = state.public.auction!;
          const max = state.public.chefs[auction.turn].coins;
          const choice = random(3);
          if (choice === 0) step({ type: 'take-it', chef: auction.turn, now });
          else if (choice === 1) step({ type: 'timeout', chef: auction.turn, slot: auction.item.slot, deadline: state.public.deadline!, now: state.public.deadline! });
          else step({ type: 'bid', chef: auction.turn, amount: auction.standingBid + 1 + random(max - auction.standingBid), now });
        } else if (state.public.phase === 'plating') {
          expect(state.public.chefs.chefOne.items).toHaveLength(5);
          expect(state.public.chefs.chefTwo.items).toHaveLength(5);
          step({ type: 'round-result', winner: random(2) === 0 ? 'chefOne' : 'chefTwo', now });
        } else step({ type: 'next-round', hands: dealHands(deck, random, seed % 2 === 0), now });
      }
      expect(state.public.round).toBeLessThanOrEqual(3);
      expect(Math.max(...Object.values(state.public.scores))).toBe(2);
      return snapshots;
    }
    expect(run(42, deck)).toEqual(run(42, deck));
    for (let seed = 0; seed < 20; seed++) run(seed, deck);
  });
});
