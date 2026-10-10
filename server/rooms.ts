import { randomInt } from 'node:crypto';
import type { Chef } from './draft/engine.ts';

/** A dinner table, not a stadium: two chefs plus the table that votes. */
export const ROOM_CAPACITY = 12;

/** Unambiguous alphabet: no I/1 and no O/0, so a code read aloud always lands. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
export const MAX_NAME_LENGTH = 24;
const MAX_COLOUR_LENGTH = 32;

export type PlayerRole = 'chef' | 'table';

export interface Player {
  /** Socket id — a player is a name and a colour, never an account. */
  id: string;
  name: string;
  colour: string;
  role: PlayerRole;
}

export interface Room {
  code: string;
  createdAt: number;
  players: Player[];
}

export interface RoomStatePayload {
  code: string;
  capacity: number;
  players: Player[];
}

export type JoinResult = { ok: true; player: Player } | { ok: false; error: string };

export function generateCode(random: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Rooms live in memory and die with the process — there is no database to
 * leak, and a party room dies with the evening.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly seats = new Map<string, { host: string | null; chefOne: string | null; chefTwo: string | null }>();

  private readonly deletionListeners = new Set<(code: string) => void>();

  onDelete(listener: (code: string) => void): void {
    this.deletionListeners.add(listener);
  }

  delete(code: string): boolean {
    const room = this.get(code);
    if (!room) return false;
    this.rooms.delete(room.code);
    this.seats.delete(room.code);
    for (const listener of this.deletionListeners) listener(room.code);
    return true;
  }

  isHost(room: Room, socketId: string): boolean {
    return this.seats.get(room.code)?.host === socketId && room.players.some((player) => player.id === socketId);
  }

  chefForSocket(room: Room, socketId: string): Chef | null {
    const seats = this.seats.get(room.code);
    if (seats?.chefOne === socketId) return 'chefOne';
    if (seats?.chefTwo === socketId) return 'chefTwo';
    return null;
  }

  create(): Room {
    let code = generateCode();
    while (this.rooms.has(code)) code = generateCode();
    const room: Room = { code, createdAt: Date.now(), players: [] };
    this.rooms.set(code, room);
    this.seats.set(code, { host: null, chefOne: null, chefTwo: null });
    return room;
  }

  get(code: string): Room | undefined {
    if (!code) return undefined;
    return this.rooms.get(normalizeCode(code));
  }

  join(
    room: Room,
    socketId: string,
    rawName: unknown,
    rawColour: unknown,
    rawRole?: unknown,
  ): JoinResult {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const colour = typeof rawColour === 'string' ? rawColour.trim() : '';
    if (!name) return { ok: false, error: 'Pick a name to sit down.' };
    if (name.length > MAX_NAME_LENGTH) {
      return { ok: false, error: `Names are capped at ${MAX_NAME_LENGTH} characters.` };
    }
    if (!colour || colour.length > MAX_COLOUR_LENGTH) {
      return { ok: false, error: 'Pick a colour to sit down.' };
    }
    if (Array.from(this.rooms.values()).some((open) => open.players.some((player) => player.id === socketId))) {
      return { ok: false, error: 'You are already seated in this room.' };
    }
    if (room.players.length >= ROOM_CAPACITY) {
      return { ok: false, error: 'This table is full.' };
    }
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: `Someone is already seated as “${name}”. Pick another name.` };
    }
    const seats = this.seats.get(room.code)!;
    // Every player chooses at the door: cook, or just judge. A judge never
    // takes a chef seat, so a host who only wanted to run the room is not
    // silently drafted into cooking. Anything else means "cook", which is
    // what every client that predates this choice already expects.
    const judgesOnly = rawRole === 'table';
    const chef = judgesOnly
      ? null
      : seats.chefOne === null
        ? 'chefOne'
        : seats.chefTwo === null
          ? 'chefTwo'
          : null;
    const player: Player = { id: socketId, name, colour, role: chef ? 'chef' : 'table' };
    if (chef) seats[chef] = socketId;
    if (seats.host === null && room.players.length === 0) seats.host = socketId;
    room.players.push(player);
    return { ok: true, player };
  }

  leaveBySocket(socketId: string): { room: Room; player: Player } | undefined {
    for (const room of this.rooms.values()) {
      const index = room.players.findIndex((p) => p.id === socketId);
      if (index === -1) continue;
      const [player] = room.players.splice(index, 1);
      const seats = this.seats.get(room.code)!;
      if (seats.chefOne === socketId) seats.chefOne = null;
      if (seats.chefTwo === socketId) seats.chefTwo = null;
      if (room.players.length === 0) this.delete(room.code);
      return player ? { room, player } : undefined;
    }
    return undefined;
  }

  state(room: Room): RoomStatePayload {
    return { code: room.code, capacity: ROOM_CAPACITY, players: [...room.players] };
  }
}
