import { createDraft, reduce, publicState, DraftError, type DraftAction, type DraftHands, type DraftState, type PublicDraftState } from './draft/engine.ts';
import { deckById } from './ingredients/deck.ts';
import { generateHands } from './ingredients/generate.ts';
import type { RoomRegistry } from './rooms.ts';
import type { VeniceClient } from './venice/client.ts';
import { createVote, reduceVote, publicVoteState, VoteError, type VoteState, type VoteSeat, type PublicVoteState } from './votes.ts';
import type { Chef } from './draft/engine.ts';

/** Only transport-supported actions; a caller cannot supply time or hands. */
export type GameAction = {
  [T in Exclude<DraftAction['type'], 'timeout' | 'round-result' | 'next-round'>]: Omit<Extract<DraftAction, { type: T }>, 'now'>
}[Exclude<DraftAction['type'], 'timeout' | 'round-result' | 'next-round'>];

export interface HandsReceipt {
  ok: true;
  vegetarianOnly: boolean;
}

/** The sole owner of dealt hands. Nothing returned from this service is a hand. */
export class GameSession {
  #hands: DraftHands | null = null;
  #generating = false;
  #state: DraftState | null = null;
  #vote: VoteState | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(private readonly onTimeout: () => void = () => {}) {}

  private now(): number {
    return Math.max(Date.now(), this.#state?.private.now ?? 0);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#state = null;
    this.#vote = null;
    this.#hands = null;
  }

  private schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const auction = this.#state?.public.auction;
    const deadline = this.#state?.public.deadline;
    if (!auction || deadline == null) return;
    const slot = auction.item.slot;
    const turn = auction.turn;
    const timer = setTimeout(() => {
      // Read the latest state. A cleared/queued callback must never reduce a
      // replaced turn, even if its deadline happens to equal the new one's.
      if (this.#timer !== timer || !this.#state) return;
      const current = this.#state.public;
      if (current.deadline !== deadline || current.auction?.item.slot !== slot || current.auction.turn !== turn) return;
      this.#timer = null;
      const now = this.now();
      if (now < current.deadline) { this.schedule(); return; }
      this.#state = reduce(this.#state, {
        type: 'timeout', chef: current.auction.turn, slot: current.auction.item.slot,
        deadline: current.deadline, now,
      });
      this.schedule();
      this.onTimeout();
    }, Math.max(0, deadline - this.now()));
    this.#timer = timer;
    timer.unref?.();
  }

  publicState(): PublicDraftState | null {
    return this.#state ? publicState(this.#state) : null;
  }

  /** Uses only finished public plates; secret queues never enter voting. */
  prepareVote(names: Record<Chef, string>): PublicVoteState | null {
    if (this.#state?.public.phase !== 'plating' || this.#state.public.pendingTrade) return null;
    if (!this.#vote || this.#vote.tally.phase === 'waiting') this.#vote = createVote(publicState(this.#state), names);
    return this.voteState();
  }

  voteState(): PublicVoteState | null { return this.#vote ? publicVoteState(this.#vote) : null; }

  openVote(seats: VoteSeat[]): void {
    if (!this.#vote || this.#state?.public.phase !== 'plating' || this.#state.public.pendingTrade) throw new VoteError('wrong-phase', 'Finish the draft and any trade before opening voting.');
    this.#vote = reduceVote(this.#vote, { type: 'open', seats });
  }

  castVote(voter: string, dish: Chef): boolean {
    if (!this.#vote) throw new VoteError('wrong-phase', 'Finish the draft before voting.');
    this.#vote = reduceVote(this.#vote, { type: 'cast', voter, dish });
    return this.#vote.tally.phase === 'closed';
  }

  start(): void {
    if (this.#disposed || this.#state || this.#generating || !this.#hands) {
      throw new DraftError('wrong-phase', 'Prepare hands before starting a new draft.');
    }
    this.#state = createDraft(this.#hands, this.now());
    this.#hands = null;
  }

  act(action: GameAction): void {
    if (!this.#state) throw new DraftError('wrong-phase', 'Start the draft first.');
    if (this.#vote && this.#vote.tally.phase !== 'waiting') throw new DraftError('wrong-phase', 'The dishes are locked for voting.');
    this.#state = reduce(this.#state, { ...action, now: this.now() });
    this.schedule();
  }

  async generate(deckId: string, vegetarianOnly: boolean, venice?: VeniceClient): Promise<HandsReceipt> {
    if (this.#disposed || this.#generating || this.#state) throw new DraftError('wrong-phase', 'Hands cannot be replaced during a draft or generation.');
    const deck = deckById(deckId);
    if (!deck) throw new DraftError('invalid-action', 'Choose a known deck.');
    this.#generating = true;
    try {
      const hands = await generateHands(deck, { vegetarianOnly, venice });
      if (this.#disposed) throw new DraftError('wrong-phase', 'This room is not open.');
      this.#hands = hands;
      return { ok: true, vegetarianOnly };
    } finally {
      this.#generating = false;
    }
  }
}

/** Sessions are keyed by the registry's canonical room code, not wire input. */
export class GameSessions {
  private readonly sessions = new Map<string, GameSession>();

  constructor(private readonly rooms: RoomRegistry, private readonly onTimeout: (code: string, state: PublicDraftState) => void = () => {}) {
    rooms.onDelete((code) => {
      this.sessions.get(code)?.dispose();
      this.sessions.delete(code);
    });
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  get(code: string): GameSession {
    const room = this.rooms.get(code);
    if (!room) throw new DraftError('wrong-phase', 'This room is not open.');
    let session = this.sessions.get(room.code);
    if (!session) {
      session = new GameSession(() => {
        const state = this.sessions.get(room.code)?.publicState();
        if (state) this.onTimeout(room.code, state);
      });
      this.sessions.set(room.code, session);
    }
    return session;
  }

  async generate(code: string, deckId: string, vegetarianOnly: boolean, venice?: VeniceClient): Promise<HandsReceipt> {
    const room = this.rooms.get(code);
    if (!room) throw new DraftError('wrong-phase', 'This room is not open.');
    if (room.players.filter((player) => player.role === 'chef').length !== 2) {
      throw new DraftError('wrong-phase', 'Seat two chefs before generating hands.');
    }
    return this.get(room.code).generate(deckId, vegetarianOnly, venice);
  }
}
