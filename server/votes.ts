import type { Chef, PublicDraftState } from './draft/engine.ts';

export type VoteErrorCode = 'wrong-phase' | 'invalid-action' | 'not-eligible' | 'already-voted' | 'invalid-dish' | 'incomplete-vote';
export class VoteError extends Error {
  constructor(readonly code: VoteErrorCode, message: string) { super(message); this.name = 'VoteError'; }
}
export interface VoteDish {
  chef: Chef;
  chefName: string;
  ingredients: string[];
  vegetarian: boolean;
  count: number;
}
/** Only this detached aggregate is broadcast-safe, never VoteState. */
export interface PublicVoteState {
  tally: {
    phase: 'waiting' | 'open' | 'closed';
    dishes: VoteDish[];
    total: number;
    winner: Chef | null;
    tie: boolean;
  };
}
export interface VoteState {
  tally: PublicVoteState['tally'];
  private: { eligible: string[]; ballots: Record<string, Chef> };
}

/** Plating means this round's draft is over; match-result requires voting first. */
export function createVote(draft: PublicDraftState, names: Record<Chef, string>): VoteState {
  if (draft.phase !== 'plating' || draft.auction || draft.pendingTrade ||
      draft.chefs.chefOne.items.length !== 5 || draft.chefs.chefTwo.items.length !== 5) {
    throw new VoteError('wrong-phase', 'Finish both five-ingredient dishes and any trade before voting.');
  }
  return {
    tally: {
      phase: 'waiting', total: 0, winner: null, tie: false,
      dishes: (['chefOne', 'chefTwo'] as const).map((chef) => ({
        chef, chefName: names[chef], ingredients: draft.chefs[chef].items.map((item) => item.ingredient.name),
        vegetarian: draft.chefs[chef].items.every((item) => item.ingredient.vegetarian === true), count: 0,
      })),
    },
    private: { eligible: [], ballots: {} },
  };
}
export function publicVoteState(state: VoteState): PublicVoteState {
  return { tally: structuredClone(state.tally) };
}
export interface VoteSeat { key: string; role: 'chef' | 'table' }
export type VoteAction =
  | { type: 'open'; seats: VoteSeat[] }
  | { type: 'cast'; voter: string; dish: Chef }
  | { type: 'close' };

function close(state: VoteState): VoteState {
  if (Object.keys(state.private.ballots).length !== state.private.eligible.length) {
    throw new VoteError('incomplete-vote', 'Wait for every eligible ballot.');
  }
  for (const dish of state.tally.dishes) {
    dish.count = Object.values(state.private.ballots).filter((vote) => vote === dish.chef).length;
  }
  state.tally.total = state.private.eligible.length;
  const [one, two] = state.tally.dishes;
  state.tally.tie = one!.count === two!.count;
  state.tally.winner = state.tally.tie ? null : one!.count > two!.count ? 'chefOne' : 'chefTwo';
  state.tally.phase = 'closed';
  return state;
}

/** Immutable transitions. Ballots stay private until one final aggregate release. */
export function reduceVote(state: VoteState, action: VoteAction): VoteState {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new VoteError('invalid-action', 'Supply a vote action.');
  const next = structuredClone(state);
  switch (action.type) {
    case 'open': {
      if (state.tally.phase !== 'waiting') throw new VoteError('wrong-phase', 'Voting can open only once.');
      if (!Array.isArray(action.seats) || action.seats.some((seat) => !seat || typeof seat.key !== 'string' || !seat.key || !['chef', 'table'].includes(seat.role)) ||
          new Set(action.seats.map((seat) => seat.key)).size !== action.seats.length) {
        throw new VoteError('invalid-action', 'Supply distinct seated identities.');
      }
      const table = action.seats.filter((seat) => seat.role === 'table');
      const eligible = table.length ? table : action.seats.filter((seat) => seat.role === 'chef');
      if (!table.length && eligible.length !== 2) throw new VoteError('not-eligible', 'Seat two chefs or table voters.');
      next.private.eligible = eligible.map((seat) => seat.key);
      next.tally.phase = 'open';
      return next;
    }
    case 'cast': {
      if (state.tally.phase === 'waiting') throw new VoteError('wrong-phase', 'Voting is not open.');
      // A repeated ballot remains typed as already-voted even after auto-close.
      if (typeof action.voter !== 'string' || !state.private.eligible.includes(action.voter)) throw new VoteError('not-eligible', 'Only seats eligible when voting opened may vote.');
      if (Object.hasOwn(state.private.ballots, action.voter)) throw new VoteError('already-voted', 'Your anonymous vote is locked in.');
      if (state.tally.phase !== 'open') throw new VoteError('wrong-phase', 'Voting is not open.');
      if (action.dish !== 'chefOne' && action.dish !== 'chefTwo') throw new VoteError('invalid-dish', 'Choose one of the two dishes.');
      Object.defineProperty(next.private.ballots, action.voter, { value: action.dish, enumerable: true, writable: true, configurable: true });
      return Object.keys(next.private.ballots).length === next.private.eligible.length ? close(next) : next;
    }
    case 'close':
      if (state.tally.phase !== 'open') throw new VoteError('wrong-phase', 'Voting is not open.');
      return close(next);
    default: {
      const exhaustive: never = action;
      void exhaustive;
      throw new VoteError('invalid-action', 'Choose a known vote action.');
    }
  }
}
