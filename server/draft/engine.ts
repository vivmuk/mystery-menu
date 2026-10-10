/**
 * The Budget Draft is data, not a service: no timers, sockets or I/O. Keep the
 * whole DraftState server-side; only publicState is safe to broadcast. The
 * referee reveals one item at a time, including forced free takes.
 */
import { deckById, type Ingredient } from '../ingredients/deck.ts';
import { parseHands, type Hand } from '../ingredients/generate.ts';

/** The format's fixed starting purse. */
export const STARTING_COINS = 10;
/** Every turn lasts ten seconds; the caller records expiry, never this module. */
export const SHOT_CLOCK_MS = 10000;
/** Ten items always fill two five-item dishes. */
export const ITEMS_PER_CHEF = 5;

/** Stable seats, mapped to authenticated players by the game layer. */
export type Chef = 'chefOne' | 'chefTwo';
/** Lifecycle of the draft and its round result, not the voting implementation. */
export type DraftPhase = 'reveal' | 'auction' | 'plating' | 'round-result' | 'match-result';
/** A slot distinguishes two copies of the same canonical ingredient. */
export interface DraftItem {
  slot: string;
  ingredient: Ingredient;
}
/** Coins and already revealed ingredients only. */
export interface ChefState {
  coins: number;
  items: DraftItem[];
}
/** The current announced item and the player whose shot clock is running. */
export interface Auction {
  item: DraftItem;
  turn: Chef;
  standingBid: number;
  bidder: Chef | null;
}
/** A revealed award gives the referee a reason to announce without an event bus. */
export interface DraftAward {
  chef: Chef;
  item: DraftItem;
  price: number;
  reason: 'take-it' | 'timeout' | 'unaffordable' | 'broke' | 'full';
}
/** One offer, awaiting the recipient's decision; all referenced slots are revealed. */
export interface PendingTrade {
  from: Chef;
  give: string;
  receive: string;
}
/** This payload never carries the private queue or future rounds' hands. */
export interface PublicDraftState {
  phase: DraftPhase;
  round: number;
  totalItems: number;
  chefs: Record<Chef, ChefState>;
  auction: Auction | null;
  deadline: number | null;
  exchangeUsed: boolean;
  lastAward: DraftAward | null;
  pendingTrade: PendingTrade | null;
  scores: Record<Chef, number>;
  winner: Chef | null;
}
/** Serializable server-only state. Never broadcast this envelope. */
export interface DraftState {
  public: PublicDraftState;
  private: { remaining: DraftItem[]; now: number };
}
/** Dealt hands remain server-side until a reveal transition. */
export interface DraftHands {
  chefOne: Hand;
  chefTwo: Hand;
}
/** Every action supplies a clock reading from the trusted game layer. */
export type DraftAction =
  | { type: 'reveal'; now: number }
  | { type: 'bid'; chef: Chef; amount: number; now: number }
  | { type: 'take-it'; chef: Chef; now: number }
  | { type: 'timeout'; chef: Chef; slot: string; deadline: number; now: number }
  | { type: 'gift'; chef: Chef; slot: string; now: number }
  | { type: 'trade'; chef: Chef; give: string; receive: string; now: number }
  | { type: 'respond-trade'; chef: Chef; accept: boolean; now: number }
  | { type: 'round-result'; winner: Chef; now: number }
  | { type: 'next-round'; hands: DraftHands; now: number };
/** Machine-readable reasons an action or setup was rejected. */
export type DraftErrorCode =
  | 'invalid-hands' | 'invalid-time' | 'wrong-phase' | 'invalid-action'
  | 'wrong-turn' | 'invalid-chef' | 'invalid-bid' | 'insufficient-coins' | 'clock-expired'
  | 'too-early' | 'stale-timeout' | 'exchange-used' | 'invalid-item' | 'hand-full'
  | 'pending-trade' | 'no-trade' | 'match-ended';
/** Every invalid draft transition throws this error without changing its input. */
export class DraftError extends Error {
  readonly code: DraftErrorCode;

  constructor(code: DraftErrorCode, message: string) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
  }
}

function checkTime(now: number, previous = 0): void {
  if (!Number.isSafeInteger(now) || now < previous || now > Number.MAX_SAFE_INTEGER - SHOT_CLOCK_MS) {
    throw new DraftError('invalid-time', 'Supply a safe, non-decreasing clock reading in milliseconds.');
  }
}

/** Start a match without exposing even the first ingredient. */
export function createDraft(hands: DraftHands, now: number): DraftState {
  return startRound(hands, now, 1, { chefOne: 0, chefTwo: 0 });
}

function startRound(hands: DraftHands, now: number, round: number, scores: Record<Chef, number>): DraftState {
  checkTime(now);
  let parsed: DraftHands;
  try {
    parsed = parseHands(hands.chefOne.deckId, hands);
  } catch {
    throw new DraftError('invalid-hands', 'A round needs two validated five-ingredient hands from one deck.');
  }
  const twistIds = new Set(deckById(parsed.chefOne.deckId)!.twistPool.map((item) => item.id));
  for (const hand of [parsed.chefOne, parsed.chefTwo]) {
    // parseHands validates composition, not order. Keep both twists for the finale.
    hand.ingredients = hand.ingredients.filter((item) => !twistIds.has(item.id))
      .concat(hand.ingredients.filter((item) => twistIds.has(item.id)));
  }
  const remaining: DraftItem[] = [];
  for (let index = 0; index < ITEMS_PER_CHEF; index++) {
    for (const chef of ['chefOne', 'chefTwo'] as const) {
      remaining.push({ slot: `${round}:${remaining.length}`, ingredient: { ...parsed[chef].ingredients[index]! } });
    }
  }
  return {
    public: {
      phase: 'reveal', round, totalItems: ITEMS_PER_CHEF * 2,
      chefs: { chefOne: { coins: STARTING_COINS, items: [] }, chefTwo: { coins: STARTING_COINS, items: [] } },
      auction: null, deadline: null, exchangeUsed: false, lastAward: null, pendingTrade: null,
      scores: { ...scores }, winner: null,
    },
    private: { remaining, now },
  };
}

/** Return a detached, broadcast-safe snapshot containing revealed items only. */
export function publicState(state: DraftState): PublicDraftState {
  return structuredClone(state.public);
}

function otherChef(chef: Chef): Chef {
  return chef === 'chefOne' ? 'chefTwo' : 'chefOne';
}

function checkChef(chef: Chef): void {
  if (chef !== 'chefOne' && chef !== 'chefTwo') throw new DraftError('invalid-chef', 'Only the two chefs may act.');
}

function currentAuction(state: DraftState, chef: Chef, now: number, allowExpired = false): Auction {
  checkChef(chef);
  const auction = state.public.auction;
  if (state.public.phase !== 'auction' || !auction) throw new DraftError('wrong-phase', 'Bidding is not open.');
  if (auction.turn !== chef) throw new DraftError('wrong-turn', 'Wait for your turn.');
  if (!allowExpired && state.public.deadline !== null && now >= state.public.deadline) {
    throw new DraftError('clock-expired', 'Record the timeout before taking another action.');
  }
  return auction;
}

function award(state: DraftState, chef: Chef, item: DraftItem, price: number, reason: DraftAward['reason']): void {
  state.public.lastAward = { chef, item, price, reason };
  state.public.chefs[chef].coins -= price;
  state.public.chefs[chef].items.push(item);
  state.public.auction = null;
  state.public.deadline = null;
  state.public.phase = state.private.remaining.length === 0 ? 'plating' : 'reveal';
}

function exchangePhase(state: DraftState): void {
  if (state.public.phase !== 'reveal' && state.public.phase !== 'plating') {
    throw new DraftError('wrong-phase', 'Gifts and trades happen between auctions or before voting.');
  }
}

function checkExchange(state: DraftState, chef: Chef): void {
  checkChef(chef);
  exchangePhase(state);
  if (state.public.exchangeUsed) throw new DraftError('exchange-used', 'The round allows only one gift or trade offer.');
}

function ownedIndex(state: DraftState, chef: Chef, slot: string): number {
  const index = state.public.chefs[chef].items.findIndex((item) => item.slot === slot);
  if (index === -1) throw new DraftError('invalid-item', 'Choose a revealed item owned by that chef.');
  return index;
}

function assertNever(action: never): never {
  throw new DraftError('invalid-action', 'Unknown draft action.');
}

/** Apply a validated action to a copy; failures leave the original untouched. */
export function reduce(state: DraftState, action: DraftAction): DraftState {
  if (state.public.phase === 'match-result') throw new DraftError('match-ended', 'The match is already over.');
  if (typeof action !== 'object' || action === null || Array.isArray(action) || typeof action.type !== 'string') {
    throw new DraftError('invalid-action', 'A draft action must be an object with a type.');
  }
  checkTime(action.now, state.private.now);
  const next = structuredClone(state);
  switch (action.type) {
    case 'reveal': {
      if (next.public.phase !== 'reveal') throw new DraftError('wrong-phase', 'No ingredient is awaiting a reveal.');
      if (next.public.pendingTrade) throw new DraftError('pending-trade', 'Resolve the trade before revealing another item.');
      const item = next.private.remaining.shift();
      if (!item) throw new DraftError('wrong-phase', 'There are no items left.');
      const chefs = next.public.chefs;
      // A full dish wins over the broke rule: nobody can acquire a sixth item.
      const full = chefs.chefOne.items.length === ITEMS_PER_CHEF ? 'chefOne'
        : chefs.chefTwo.items.length === ITEMS_PER_CHEF ? 'chefTwo' : null;
      const broke = chefs.chefOne.coins === 0 ? 'chefOne' : chefs.chefTwo.coins === 0 ? 'chefTwo' : null;
      if (full) award(next, otherChef(full), item, 0, 'full');
      else if (broke) award(next, broke, item, 0, 'broke');
      else {
        next.public.phase = 'auction';
        next.public.auction = { item, turn: 'chefOne', standingBid: 0, bidder: null };
        next.public.deadline = action.now + SHOT_CLOCK_MS;
      }
      break;
    }
    case 'bid': {
      const auction = currentAuction(next, action.chef, action.now);
      if (!Number.isSafeInteger(action.amount) || action.amount <= auction.standingBid) {
        throw new DraftError('invalid-bid', 'A bid must be a whole coin strictly above the standing price.');
      }
      if (action.amount > next.public.chefs[action.chef].coins) {
        throw new DraftError('insufficient-coins', 'You cannot bid more coins than you have.');
      }
      auction.standingBid = action.amount;
      auction.bidder = action.chef;
      auction.turn = otherChef(action.chef);
      if (next.public.chefs[auction.turn].coins <= action.amount) {
        award(next, action.chef, auction.item, action.amount, 'unaffordable');
      } else next.public.deadline = action.now + SHOT_CLOCK_MS;
      break;
    }
    case 'take-it': {
      const auction = currentAuction(next, action.chef, action.now);
      award(next, otherChef(action.chef), auction.item, auction.standingBid, 'take-it');
      break;
    }
    case 'timeout': {
      const auction = currentAuction(next, action.chef, action.now, true);
      if (action.slot !== auction.item.slot || action.deadline !== next.public.deadline) {
        throw new DraftError('stale-timeout', 'This notification belongs to a different item or turn.');
      }
      if (action.now < action.deadline) throw new DraftError('too-early', 'The shot clock has not expired.');
      award(next, otherChef(action.chef), auction.item, auction.standingBid, 'timeout');
      break;
    }
    case 'gift': {
      checkExchange(next, action.chef);
      const index = ownedIndex(next, action.chef, action.slot);
      const recipient = otherChef(action.chef);
      if (next.public.chefs[recipient].items.length === ITEMS_PER_CHEF) {
        throw new DraftError('hand-full', 'The other dish already has five ingredients; offer a trade instead.');
      }
      const [item] = next.public.chefs[action.chef].items.splice(index, 1);
      next.public.chefs[recipient].items.push(item!);
      next.public.exchangeUsed = true;
      break;
    }
    case 'trade': {
      checkExchange(next, action.chef);
      ownedIndex(next, action.chef, action.give);
      ownedIndex(next, otherChef(action.chef), action.receive);
      next.public.pendingTrade = { from: action.chef, give: action.give, receive: action.receive };
      // The spec permits one offer, not unlimited rejected proposals.
      next.public.exchangeUsed = true;
      break;
    }
    case 'respond-trade': {
      checkChef(action.chef);
      exchangePhase(next);
      const trade = next.public.pendingTrade;
      if (!trade) throw new DraftError('no-trade', 'There is no trade to answer.');
      if (action.chef !== otherChef(trade.from)) throw new DraftError('wrong-turn', 'Only the recipient may answer a trade.');
      if (typeof action.accept !== 'boolean') throw new DraftError('invalid-action', 'Accept must be a boolean.');
      if (action.accept) {
        const from = next.public.chefs[trade.from].items;
        const to = next.public.chefs[action.chef].items;
        const give = ownedIndex(next, trade.from, trade.give);
        const receive = ownedIndex(next, action.chef, trade.receive);
        const item = from[give]!;
        from[give] = to[receive]!;
        to[receive] = item;
      }
      next.public.pendingTrade = null;
      break;
    }
    case 'round-result': {
      checkChef(action.winner);
      if (next.public.phase !== 'plating') throw new DraftError('wrong-phase', 'Finish the draft before recording the vote result.');
      if (next.public.pendingTrade) throw new DraftError('pending-trade', 'Resolve the trade before recording the result.');
      next.public.scores[action.winner]++;
      next.public.winner = action.winner;
      next.public.phase = next.public.scores[action.winner] === 2 ? 'match-result' : 'round-result';
      break;
    }
    case 'next-round': {
      if (next.public.phase !== 'round-result') throw new DraftError('wrong-phase', 'The current round needs a result first.');
      return startRound(action.hands, action.now, next.public.round + 1, next.public.scores);
    }
    default:
      return assertNever(action);
  }
  next.private.now = action.now;
  return next;
}
