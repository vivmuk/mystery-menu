import { describe, expect, it } from 'vitest';
import { createDraft, reduce as draftReduce, publicState as draftPublic } from '../server/draft/engine.ts';
import { deckById } from '../server/ingredients/deck.ts';
import { dealHands } from '../server/ingredients/generate.ts';
import { createVote, publicVoteState, reduceVote, VoteError, type VoteSeat } from '../server/votes.ts';

function finishedDraft() {
  let draft = createDraft(dealHands(deckById('pizza')!, () => 0), 0);
  while (draft.public.phase === 'reveal' || draft.public.phase === 'auction') {
    draft = draftReduce(draft, draft.public.auction
      ? { type: 'take-it', chef: draft.public.auction.turn, now: 0 }
      : { type: 'reveal', now: 0 });
  }
  return draftPublic(draft);
}
const names = { chefOne: 'Cook One', chefTwo: 'Cook Two' };
const seats: VoteSeat[] = [
  { key: 'private-cook-1', role: 'chef' }, { key: 'private-cook-2', role: 'chef' },
  { key: 'private-diner-1', role: 'table' }, { key: 'private-diner-2', role: 'table' },
];
const waiting = () => createVote(finishedDraft(), names);
const opened = () => reduceVote(waiting(), { type: 'open', seats });

describe('anonymous best-dish vote', () => {
  it('requires the engine to report finished plating, not just ten populated slots', () => {
    const draft = finishedDraft();
    expect(publicVoteState(createVote(draft, names)).tally.phase).toBe('waiting');
    for (const phase of ['reveal', 'auction', 'round-result', 'match-result'] as const) {
      expect(() => createVote({ ...draft, phase }, names)).toThrow(VoteError);
    }
    expect(() => createVote({ ...draft, pendingTrade: { from: 'chefOne', give: '1:0', receive: '1:1' } }, names)).toThrow(VoteError);
    draft.chefs.chefOne.items.pop();
    expect(() => createVote(draft, names)).toThrow(VoteError);
  });
  it('opens only once and closes only once all eligible seats have voted', () => {
    const initial = waiting();
    expect(() => reduceVote(initial, { type: 'cast', voter: 'private-diner-1', dish: 'chefOne' })).toThrowError(expect.objectContaining({ code: 'wrong-phase' }));
    const state = reduceVote(initial, { type: 'open', seats });
    expect(initial.tally.phase).toBe('waiting');
    expect(state.tally.phase).toBe('open');
    expect(() => reduceVote(state, { type: 'open', seats })).toThrowError(expect.objectContaining({ code: 'wrong-phase' }));
    expect(() => reduceVote(state, { type: 'close' })).toThrowError(expect.objectContaining({ code: 'incomplete-vote' }));
    const first = reduceVote(state, { type: 'cast', voter: 'private-diner-1', dish: 'chefOne' });
    expect(publicVoteState(first)).toEqual(publicVoteState(state)); // No arrival-order signal.
    const last = reduceVote(first, { type: 'cast', voter: 'private-diner-2', dish: 'chefOne' });
    expect(last.tally).toMatchObject({ phase: 'closed', total: 2, winner: 'chefOne', tie: false });
    expect(last.tally.dishes.map(d => d.count)).toEqual([2, 0]);
    expect(() => reduceVote(last, { type: 'close' })).toThrowError(expect.objectContaining({ code: 'wrong-phase' }));
  });

  it('locks a stable seat ballot and rejects changes without mutating input', () => {
    const first = reduceVote(opened(), { type: 'cast', voter: seats[2]!.key, dish: 'chefOne' });
    const before = structuredClone(first);
    expect(() => reduceVote(first, { type: 'cast', voter: seats[2]!.key, dish: 'chefTwo' })).toThrowError(expect.objectContaining({ code: 'already-voted' }));
    expect(first).toEqual(before);
  });

  it('excludes chefs when table seats exist and refuses unseated identities', () => {
    for (const voter of [seats[0]!.key, seats[1]!.key, 'outsider']) {
      expect(() => reduceVote(opened(), { type: 'cast', voter, dish: 'chefOne' })).toThrowError(expect.objectContaining({ code: 'not-eligible' }));
    }
  });

  it('lets both chefs vote for their OWN dish when no table seat exists, producing a shared tie', () => {
    let state = reduceVote(waiting(), { type: 'open', seats: seats.slice(0, 2) });
    state = reduceVote(state, { type: 'cast', voter: seats[0]!.key, dish: 'chefOne' });
    state = reduceVote(state, { type: 'cast', voter: seats[1]!.key, dish: 'chefTwo' });
    expect(publicVoteState(state).tally).toMatchObject({ phase: 'closed', total: 2, winner: null, tie: true });
    expect(state.tally.dishes.map(d => d.count)).toEqual([1, 1]);
    expect(() => reduceVote(state, { type: 'cast', voter: seats[1]!.key, dish: 'chefOne' })).toThrowError(expect.objectContaining({ code: 'already-voted' }));
  });

  it.each([[true, true, true, true, true], [true, false, true, true, true], [false, false, false, false, false]])('marks vegetarian only when EVERY plate ingredient is vegetarian: %j', (...flags) => {
    const draft = finishedDraft();
    draft.chefs.chefOne.items = draft.chefs.chefOne.items.map((item, i) => ({ ...item, ingredient: { ...item.ingredient, vegetarian: flags[i]! } }));
    expect(publicVoteState(createVote(draft, names)).tally.dishes[0]!.vegetarian).toBe(flags.every(Boolean));
  });

  it('projects detached tally data only and walks keys and values for every private identity', () => {
    let state = opened();
    const packets = [publicVoteState(waiting()), publicVoteState(state)];
    for (const seat of seats.slice(2)) {
      state = reduceVote(state, { type: 'cast', voter: seat.key, dish: 'chefTwo' });
      packets.push(publicVoteState(state));
    }
    for (const payload of packets) {
      expect(Object.keys(payload)).toEqual(['tally']);
      const strings: string[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { strings.push(key); walk(entry); }
      };
      walk(payload);
      for (const seat of seats) {
        expect(strings).not.toContain(seat.key);
        expect(JSON.stringify(payload)).not.toContain(seat.key);
      }
      for (const key of ['private', 'ballots', 'eligible', 'voter', 'seatKey']) expect(strings).not.toContain(key);
    }
    packets.at(-1)!.tally.dishes[0]!.ingredients[0] = 'changed';
    expect(publicVoteState(state).tally.dishes[0]!.ingredients[0]).not.toBe('changed');
  });

  it('counts ballots by seat, never by arrival order, including prototype-like seat keys', () => {
    const unusual = [{ key: '__proto__', role: 'table' as const }, { key: 'constructor', role: 'table' as const }];
    const initial = reduceVote(waiting(), { type: 'open', seats: unusual });
    const cast = (order: typeof unusual) => order.reduce((state, seat) => reduceVote(state, { type: 'cast', voter: seat.key, dish: 'chefTwo' }), initial);
    expect(publicVoteState(cast(unusual))).toEqual(publicVoteState(cast([...unusual].reverse())));
    expect(cast(unusual).tally.dishes.map(d => d.count)).toEqual([0, 2]);
  });

  it('rejects invalid dishes, malformed actions and duplicate eligibility keys', () => {
    expect(() => reduceVote(opened(), { type: 'cast', voter: seats[2]!.key, dish: 'bad' as 'chefOne' })).toThrowError(expect.objectContaining({ code: 'invalid-dish' }));
    expect(() => reduceVote(waiting(), { type: 'open', seats: [seats[2]!, seats[2]!] })).toThrowError(expect.objectContaining({ code: 'invalid-action' }));
    expect(() => reduceVote(waiting(), { type: 'open', seats: [] })).toThrowError(expect.objectContaining({ code: 'not-eligible' }));
    expect(() => reduceVote(waiting(), null as never)).toThrowError(expect.objectContaining({ code: 'invalid-action' }));
  });
});
