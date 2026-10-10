/** Typed client → server and server → client lobby, draft and vote payloads. */
import type { Chef, DraftErrorCode, PublicDraftState } from './draft/engine.ts';
import type { PlayerRole } from './rooms.ts';
import type { PublicVoteState, VoteErrorCode } from './votes.ts';

export interface JoinRequest {
  code: string;
  name: string;
  colour: string;
  /**
   * The seat this player asked for: 'table' means "I'm judging, don't seat me
   * as a chef". Omitted or anything else means "cook" — a chef seat if one is
   * free. The server decides the real seat; this is only a preference.
   */
  role?: PlayerRole;
}

export interface JoinErrorPayload {
  reason: string;
}

export interface DraftRequest { code: string }
export interface DraftChefRequest extends DraftRequest { chef: Chef }
export interface DraftBidRequest extends DraftChefRequest { amount: number }
export interface DraftGiftRequest extends DraftChefRequest { slot: string }
export interface DraftTradeRequest extends DraftChefRequest { give: string; receive: string }
export interface DraftRespondTradeRequest extends DraftChefRequest { accept: boolean }
export type DraftStatePayload = PublicDraftState;
export interface DraftErrorPayload { code: DraftErrorCode; message: string }

export interface VoteRequest { code: string }
export interface VoteCastRequest extends VoteRequest { dish: Chef }
export type VoteStatePayload = PublicVoteState;
export interface VoteErrorPayload { code: VoteErrorCode; message: string }
/** Sender-only receipt; never identifies the voter or their choice. */
export interface VoteAcceptedPayload { ok: true }
