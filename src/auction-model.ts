import type { Chef, PublicDraftState } from '../server/draft/engine.ts';

const TURN_MS = 10000;

/** Display only: expiry is always resolved by the server, never by this clock. */
export function remainingMs(deadline: number | null, now: number): number {
  if (deadline === null || !Number.isFinite(deadline) || !Number.isFinite(now)) return 0;
  return Math.min(TURN_MS, Math.max(0, deadline - now));
}

export function canAct(state: PublicDraftState, chef: Chef | null, now: number): boolean {
  return chef !== null && state.phase === 'auction' && state.auction?.turn === chef
    && remainingMs(state.deadline, now) > 0;
}

export function canBid(state: PublicDraftState, chef: Chef | null, amount: number, now: number): boolean {
  return canAct(state, chef, now) && chef !== null && Number.isSafeInteger(amount)
    && amount > state.auction!.standingBid && amount <= state.chefs[chef].coins;
}

/** The engine reveals its two twists last. Count only already public items. */
export function isTwistReveal(state: PublicDraftState): boolean {
  if (!state.auction && !state.lastAward) return false;
  const revealed = state.chefs.chefOne.items.length + state.chefs.chefTwo.items.length
    + (state.auction ? 1 : 0);
  return revealed > state.totalItems - 2;
}
