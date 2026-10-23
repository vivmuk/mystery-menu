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
  /** Seeded by the server for a solo demo; no phone is behind this seat. */
  virtual?: boolean;
}

export interface Room {
  code: string;
  createdAt: number;
  players: Player[];
  /** Solo demo: one human runs both chefs and the whole table. */
  demo?: boolean;
}

export interface RoomStatePayload {
  code: string;
  capacity: number;
  players: Player[];
  /** The socket that may drive reveals and open voting. Null before anyone joins. */
  hostId: string | null;
  demo?: boolean;
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

  create(demo = false): Room {
    let code = generateCode();
    while (this.rooms.has(code)) code = generateCode();
    const room: Room = { code, createdAt: Date.now(), players: [], ...(demo ? { demo: true } : {}) };
    this.rooms.set(code, room);
    this.seats.set(code, { host: null, chefOne: null, chefTwo: null });
    if (demo) this.seedDemo(room);
    return room;
  }

  /**
   * A demo room arrives pre-seated: two chefs and three diners are virtual
   * seats the host drives. That is what makes a one-phone demo possible
   * without pretending the multiplayer rules changed.
   */
  private seedDemo(room: Room): void {
    const seats = this.seats.get(room.code)!;
    const virtual: Player[] = [
      { id: 'demo-chef-one', name: 'Chef One', colour: '#ff6a2b', role: 'chef', virtual: true },
      { id: 'demo-chef-two', name: 'Chef Two', colour: '#35a7ff', role: 'chef', virtual: true },
      { id: 'demo-diner-1', name: 'Diner 1', colour: '#46ff9b', role: 'table', virtual: true },
      { id: 'demo-diner-2', name: 'Diner 2', colour: '#ff2f9c', role: 'table', virtual: true },
      { id: 'demo-diner-3', name: 'Diner 3', colour: '#8b5cff', role: 'table', virtual: true },
    ];
    room.players.push(...virtual);
    seats.chefOne = 'demo-chef-one';
    seats.chefTwo = 'demo-chef-two';
  }

  isDemo(room: Room): boolean {
    return room.demo === true;
  }

  /** A seat with no phone behind it, which only a demo host may act for. */
  isVirtualSeat(room: Room, key: string): boolean {
    return room.players.some((player) => player.id === key && player.virtual === true);
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
    // First human at the table hosts. A demo room is seeded with virtual
    // players, so its host is the first real phone rather than player #0.
    if (seats.host === null) seats.host = socketId;
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
      if (seats.host === socketId) seats.host = null;
      // A demo room with no human left is dead too — its virtual diners would
      // otherwise keep it in memory forever.
      if (!room.players.some((candidate) => candidate.virtual !== true)) this.delete(room.code);
      return player ? { room, player } : undefined;
    }
    return undefined;
  }

  state(room: Room): RoomStatePayload {
    return {
      code: room.code,
      capacity: ROOM_CAPACITY,
      players: [...room.players],
      hostId: this.seats.get(room.code)?.host ?? null,
      ...(room.demo ? { demo: true } : {}),
    };
  }
}
