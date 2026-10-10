/** Typed client → server and server → client lobby and draft payloads. */
import type { Chef, DraftErrorCode, PublicDraftState } from './draft/engine.ts';
import type { PlayerRole } from './rooms.ts';

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
