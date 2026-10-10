import { describe, expect, it } from 'vitest';
import type { PublicDraftState } from '../server/draft/engine.ts';
import { canAct, canBid, isTwistReveal, remainingMs } from '../src/auction-model.ts';

const state: PublicDraftState = {
  phase: 'auction', round: 1, totalItems: 10,
  chefs: { chefOne: { coins: 4, items: [] }, chefTwo: { coins: 10, items: [] } },
  auction: { item: { slot: '1:0', ingredient: { id: 'garlic', name: 'Garlic', origin: 'mediterranean', vegetarian: true, vegan: true } }, turn: 'chefOne', standingBid: 2, bidder: 'chefTwo' },
  deadline: 12000, exchangeUsed: false, lastAward: null, pendingTrade: null,
  scores: { chefOne: 0, chefTwo: 0 }, winner: null,
};

it('enables only whole, affordable raises for the current chef before expiry', () => {
  expect(canBid(state, 'chefOne', 3, 5000)).toBe(true);
  expect(canBid(state, 'chefOne', 4, 5000)).toBe(true);
  for (const amount of [2, 1, 5, 2.5, NaN, Infinity]) expect(canBid(state, 'chefOne', amount, 5000)).toBe(false);
  expect(canBid(state, 'chefTwo', 3, 5000)).toBe(false);
  expect(canBid(state, null, 3, 5000)).toBe(false);
  expect(canAct(state, 'chefOne', 12000)).toBe(false);
  expect(canAct({ ...state, phase: 'reveal' }, 'chefOne', 5000)).toBe(false);
  expect(canAct({ ...state, deadline: null }, 'chefOne', 5000)).toBe(false);
});

it('marks only announced finale ingredients as twists, using the public reveal count', () => {
  expect(isTwistReveal(state)).toBe(false);
  const awarded = Array.from({ length: 8 }, (_, i) => ({ ...state.auction!.item, slot: `1:${i}` }));
  const finale = { ...state, chefs: { ...state.chefs, chefOne: { coins: 4, items: awarded.slice(0, 4) }, chefTwo: { coins: 10, items: awarded.slice(4) } } };
  expect(isTwistReveal(finale)).toBe(true);
  expect(isTwistReveal({ ...finale, auction: null, lastAward: { chef: 'chefOne', item: awarded[7]!, price: 0, reason: 'full' } })).toBe(false);
});

describe('public auction clock', () => {
  it('uses the server deadline and clamps expired, absent and invalid clock readings', () => {
    expect(remainingMs(12000, 5000)).toBe(7000);
    expect(remainingMs(12000, 12000)).toBe(0);
    expect(remainingMs(12000, 13000)).toBe(0);
    expect(remainingMs(null, 5000)).toBe(0);
    expect(remainingMs(Number.NaN, 5000)).toBe(0);
    expect(remainingMs(12000, Number.NaN)).toBe(0);
    expect(remainingMs(Infinity, 5000)).toBe(0);
    expect(remainingMs(20000, 5000)).toBe(10000);
  });
});
