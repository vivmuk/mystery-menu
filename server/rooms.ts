import { randomInt } from 'node:crypto';

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

/** The first two seats at the table are the chefs; everyone else votes. */
function roleForSeat(seat: number): PlayerRole {
  return seat < 2 ? 'chef' : 'table';
}

/**
 * Rooms live in memory and die with the process — there is no database to
 * leak, and a party room dies with the evening.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  create(): Room {
    let code = generateCode();
    while (this.rooms.has(code)) code = generateCode();
    const room: Room = { code, createdAt: Date.now(), players: [] };
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    if (!code) return undefined;
    return this.rooms.get(normalizeCode(code));
  }

  join(room: Room, socketId: string, rawName: unknown, rawColour: unknown): JoinResult {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const colour = typeof rawColour === 'string' ? rawColour.trim() : '';
    if (!name) return { ok: false, error: 'Pick a name to sit down.' };
    if (name.length > MAX_NAME_LENGTH) {
      return { ok: false, error: `Names are capped at ${MAX_NAME_LENGTH} characters.` };
    }
    if (!colour || colour.length > MAX_COLOUR_LENGTH) {
      return { ok: false, error: 'Pick a colour to sit down.' };
    }
    if (room.players.some((p) => p.id === socketId)) {
      return { ok: false, error: 'You are already seated in this room.' };
    }
    if (room.players.length >= ROOM_CAPACITY) {
      return { ok: false, error: 'This table is full.' };
    }
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: `Someone is already seated as “${name}”. Pick another name.` };
    }
    const player: Player = { id: socketId, name, colour, role: roleForSeat(room.players.length) };
    room.players.push(player);
    return { ok: true, player };
  }

  leaveBySocket(socketId: string): { room: Room; player: Player } | undefined {
    for (const room of this.rooms.values()) {
      const index = room.players.findIndex((p) => p.id === socketId);
      if (index === -1) continue;
      const [player] = room.players.splice(index, 1);
      return player ? { room, player } : undefined;
    }
    return undefined;
  }

  state(room: Room): RoomStatePayload {
    return { code: room.code, capacity: ROOM_CAPACITY, players: [...room.players] };
  }
}
