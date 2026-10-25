/**
 * Hands: five secret ingredients per chef, drawn from a themed deck, with
 * exactly one cross-cuisine twist each.
 *
 * Two layers, both pure where it matters:
 * - `dealHands` is the deterministic core — injectable randomness, no I/O —
 *   used directly by tests and as the fallback when Venice is unavailable.
 * - `generateHands` adds live generation: the Venice model *chooses* each
 *   twist from the deck's curated twist pool, its reply is parsed as strict
 *   JSON and validated, and any garbage, hallucinated id, or failure falls
 *   back to the deck. The model proposes; the deck disposes.
 *
 * The twist is drawn from the curated pool rather than free-form generated
 * on purpose: a model-invented ingredient name cannot be structurally
 * verified as real, cookable, or vegetarian — a curated candidate list can.
 * The prompt still gives the model the already-dealt cores, so the choice is
 * narratively live even though the options are vetted.
 *
 * Nothing here touches a socket. The game layer calls this server-side; a
 * hand never reaches a client before the reveal.
 */

import { randomInt } from 'node:crypto';
import { deckById, makeCustomDeck, slugId, type Deck, type Ingredient, type Random } from './deck.ts';
import type { VeniceClient } from '../venice/client.ts';

/** Exactly five ingredients per chef — the format's most load-bearing number. */
export const INGREDIENTS_PER_CHEF = 5;

/** Why a hand was rejected — machine-readable, safe to show a developer. */
export type HandErrorCode =
  | 'not-an-object'
  | 'wrong-count'
  | 'duplicate-ingredient'
  | 'unknown-ingredient'
  | 'not-vegetarian'
  | 'twist-count';

/** The one typed error every hand violation raises. */
export class HandError extends Error {
  readonly code: HandErrorCode;

  constructor(code: HandErrorCode, message: string) {
    super(message);
    this.name = 'HandError';
    this.code = code;
  }
}

/** One chef's hand, already validated. */
export interface Hand {
  deckId: string;
  ingredients: Ingredient[];
}

/**
 * Parses and validates one hand built from ingredient ids, throwing a typed
 * HandError on any violation: shape, exactly five, no duplicates, ids known
 * to the deck, the dietary filter, and exactly one cross-cuisine twist.
 *
 * The generator runs this on its own output, so a bad deal is caught here and
 * never reaches a player; tests run it on hand-shaped values straight from a
 * model. Ids are resolved against the canonical catalog — a model's word
 * about what an ingredient *is* is never trusted, only its choice of id.
 */
export function parseHand(deckId: string, value: unknown, vegetarianOnly = false): Hand {
  const deck = deckById(deckId);
  if (!deck) throw new HandError('unknown-ingredient', `Unknown deck “${deckId}”.`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HandError('not-an-object', 'A hand must be an object with an ingredients array.');
  }
  const raw = value as { deckId?: unknown; ingredients?: unknown };
  if (raw.deckId !== undefined && raw.deckId !== deckId) {
    throw new HandError('unknown-ingredient', `Hand claims deck “${String(raw.deckId)}”, not “${deckId}”.`);
  }

  const list = raw.ingredients;
  if (!Array.isArray(list)) {
    throw new HandError('not-an-object', 'A hand must carry its ingredients as an array.');
  }
  if (list.length !== INGREDIENTS_PER_CHEF) {
    throw new HandError(
      'wrong-count',
      `A hand is exactly ${INGREDIENTS_PER_CHEF} ingredients, got ${list.length}.`,
    );
  }

  const ingredients: Ingredient[] = [];
  const seen = new Set<string>();
  let twists = 0;
  for (const entry of list) {
    // Wire shape is id strings; internal callers pass full ingredient objects.
    // Both are validated by resolving the id against the catalog — a model's
    // word about what an ingredient *is* is never trusted, only its id.
    const id =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { id?: unknown }).id === 'string'
          ? (entry as { id: string }).id
          : undefined;
    if (id === undefined) {
      throw new HandError('unknown-ingredient', 'Every ingredient must be given as an id string.');
    }
    const ingredient =
      deck.corePool.find((i) => i.id === id) ?? deck.twistPool.find((i) => i.id === id);
    if (!ingredient) {
      throw new HandError('unknown-ingredient', `“${id}” is not an ingredient of the ${deck.name} deck.`);
    }
    if (seen.has(ingredient.id)) {
      throw new HandError('duplicate-ingredient', `“${ingredient.name}” appears twice in one hand.`);
    }
    seen.add(ingredient.id);
    if (vegetarianOnly && !ingredient.vegetarian) {
      throw new HandError('not-vegetarian', `“${ingredient.name}” is not vegetarian.`);
    }
    if (deck.twistPool.some((twist) => twist.id === ingredient.id)) twists++;
    ingredients.push(ingredient);
  }

  if (twists !== 1) {
    throw new HandError('twist-count', `A hand carries exactly one cross-cuisine twist, got ${twists}.`);
  }

  return { deckId: deck.id, ingredients };
}

/**
 * Parses both chefs' hands and rejects the match when they came out
 * identical — two chefs drafting the same five items is not a draft.
 */
export function parseHands(
  deckId: string,
  value: unknown,
  vegetarianOnly = false,
): { chefOne: Hand; chefTwo: Hand } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HandError('not-an-object', 'Two hands must be an object with chefOne and chefTwo.');
  }
  const raw = value as { chefOne?: unknown; chefTwo?: unknown };
  const chefOne = parseHand(deckId, raw.chefOne, vegetarianOnly);
  const chefTwo = parseHand(deckId, raw.chefTwo, vegetarianOnly);
  if (handSignature(chefOne) === handSignature(chefTwo)) {
    throw new HandError('duplicate-ingredient', 'The two chefs cannot draft identical hands.');
  }
  return { chefOne, chefTwo };
}

function handSignature(hand: Hand): string {
  return hand.ingredients.map((i) => i.id).sort().join('|');
}

function pick(random: Random, pool: Ingredient[], taken: Set<string>): Ingredient {
  const remaining = pool.filter((i) => !taken.has(i.id));
  if (remaining.length === 0) {
    throw new HandError('wrong-count', 'The deck pool is exhausted — it cannot feed a full hand.');
  }
  return remaining[Math.floor(random(remaining.length))]!;
}

/**
 * Deals the two chefs' hands from a deck — exactly five each, exactly one
 * twist each, no repeats inside a hand, no shared twist between the chefs,
 * honouring the vegetarian filter. The twist lands last in each hand: it is
 * the beat the table reacts to.
 *
 * `random` is injectable: production passes crypto randomness, tests pass a
 * seeded function and get byte-for-byte the same hands back.
 */
export function dealHands(deck: Deck, random: Random, vegetarianOnly = false): {
  chefOne: Hand;
  chefTwo: Hand;
} {
  const hands: Hand[] = [];
  let chefOneTwistId: string | undefined;
  // Cross-hand uniqueness: no ingredient is announced twice in one round. Both
  // chefs draw from the same shrinking pool, so a name the table has just heard
  // cannot come back around. Every deck holds twelve or more cores, so two
  // four-core hands always fit; a deck too small fails loudly just below.
  const dealtIds = new Set<string>();
  for (let chef = 0; chef < 2; chef++) {
    const core = deck.corePool.filter(
      (i) => (!vegetarianOnly || i.vegetarian) && !dealtIds.has(i.id),
    );
    const twists = deck.twistPool.filter(
      (i) => (!vegetarianOnly || i.vegetarian) && i.id !== chefOneTwistId,
    );
    if (core.length < INGREDIENTS_PER_CHEF - 1 || twists.length === 0) {
      throw new HandError(
        'wrong-count',
        `The ${deck.name} deck cannot feed a ${vegetarianOnly ? 'vegetarian ' : ''}hand.`,
      );
    }
    const taken = new Set<string>();
    const ingredients: Ingredient[] = [];
    while (ingredients.length < INGREDIENTS_PER_CHEF - 1) {
      const next = pick(random, core, taken);
      taken.add(next.id);
      dealtIds.add(next.id);
      ingredients.push(next);
    }
    const twist = pick(random, twists, taken);
    taken.add(twist.id);
    ingredients.push(twist);
    if (chef === 0) chefOneTwistId = twist.id;
    hands.push({ deckId: deck.id, ingredients });
  }

  // Validate our own output — a bad deal is caught here, not at the table.
  const [chefOne, chefTwo] = hands;
  if (!chefOne || !chefTwo) throw new HandError('wrong-count', 'Both chefs must be dealt a hand.');
  return parseHands(deck.id, { chefOne, chefTwo }, vegetarianOnly);
}

/** The default randomness: crypto-grade, unbiasable by a player. */
export const cryptoRandom: Random = randomInt;

const TWIST_SYSTEM_PROMPT =
  'You pick one cross-cuisine twist ingredient for a party cooking game. ' +
  'Reply with JSON only — exactly {"twistId":"<id>"} — and no other text.';

function twistUserPrompt(deck: Deck, coreNames: string[], candidates: Ingredient[]): string {
  return JSON.stringify({
    task: 'Choose the twistId that makes the most surprising but genuinely cookable cross-cuisine twist for this dish, given what is already in the hand.',
    dish: deck.name,
    cuisine: deck.cuisine,
    alreadyDealt: coreNames,
    candidates: candidates.map((i) => ({ id: i.id, name: i.name, origin: i.origin })),
  });
}

/**
 * Models like to wrap JSON in prose or code fences. This pulls the first
 * balanced JSON object out of a reply, or returns undefined when there is
 * nothing parseable — the caller falls back to the deck either way.
 */
function extractJsonObject(content: string): Record<string, unknown> | undefined {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced?.[1] ?? content).trim();
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  for (let end = text.lastIndexOf('}'); end > start; end--) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      // Try a shorter tail — trailing prose after the object is common.
    }
  }
  return undefined;
}

async function modelTwist(
  venice: VeniceClient,
  deck: Deck,
  coreNames: string[],
  candidates: Ingredient[],
): Promise<Ingredient | undefined> {
  let content: string;
  try {
    ({ content } = await venice.chat(
      [
        { role: 'system', content: TWIST_SYSTEM_PROMPT },
        { role: 'user', content: twistUserPrompt(deck, coreNames, candidates) },
      ],
      // Reasoning models can spend a tiny budget on thinking and return no
      // content at all (see the health probe), so the ceiling stays generous.
      { maxTokens: 512 },
    ));
  } catch {
    return undefined;
  }
  const parsed = extractJsonObject(content);
  const twistId = parsed?.twistId;
  if (typeof twistId !== 'string') return undefined;
  // Only a vetted candidate is acceptable — a hallucinated id falls back.
  return candidates.find((candidate) => candidate.id === twistId);
}

export interface GenerateHandsOptions {
  /** Injected randomness; defaults to crypto-grade randomInt. */
  random?: Random;
  /** When true every ingredient, twist included, must be vegetarian. */
  vegetarianOnly?: boolean;
  /**
   * The Venice client, injected by the game layer. When omitted — or when the
   * call fails or returns anything but a vetted candidate id — the twist is
   * drawn from the deck instead, so a party never stalls on the network.
   */
  venice?: VeniceClient;
}

/**
 * Generates a full match's hands: five secret ingredients per chef, the twist
 * chosen live by Venice when a client is provided, everything validated by
 * parseHands before it leaves this function. Server-side only — the caller
 * holds the result and never broadcasts it before the reveal.
 */
export async function generateHands(
  deck: Deck,
  options: GenerateHandsOptions = {},
): Promise<{ chefOne: Hand; chefTwo: Hand }> {
  const random = options.random ?? cryptoRandom;
  const vegetarianOnly = options.vegetarianOnly ?? false;
  if (!options.venice) return dealHands(deck, random, vegetarianOnly);
  const vegetarian = (i: Ingredient): boolean => !vegetarianOnly || i.vegetarian;

  // Deal the four core ingredients per chef first, so the model sees what it
  // is twisting. The two hands never share a core: a round announces each
  // ingredient name exactly once, so nothing the table just heard returns.
  const dealt: Ingredient[][] = [];
  const dealtIds = new Set<string>();
  for (let chef = 0; chef < 2; chef++) {
    const taken = new Set<string>();
    const core = deck.corePool.filter((i) => vegetarian(i) && !dealtIds.has(i.id));
    const picks: Ingredient[] = [];
    while (picks.length < INGREDIENTS_PER_CHEF - 1) {
      const next = pick(random, core, taken);
      taken.add(next.id);
      dealtIds.add(next.id);
      picks.push(next);
    }
    dealt.push(picks);
  }

  // One twist per chef, live-picked when possible, never the same twist twice.
  const twists: Ingredient[] = [];
  for (let chef = 0; chef < 2; chef++) {
    const taken = new Set(dealt[chef]!.map((i) => i.id).concat(twists.map((i) => i.id)));
    const candidates = deck.twistPool.filter((i) => vegetarian(i) && !taken.has(i.id));
    if (candidates.length === 0) {
      throw new HandError('wrong-count', `The ${deck.name} deck has no twist left to deal.`);
    }
    const fromModel = options.venice
      ? await modelTwist(options.venice, deck, dealt[chef]!.map((i) => i.name), candidates)
      : undefined;
    twists.push(fromModel ?? pick(random, candidates, taken));
  }

  const [chefOne, chefTwo] = dealt;
  if (!chefOne || !chefTwo) throw new HandError('wrong-count', 'Both chefs must be dealt a hand.');
  const [twistOne, twistTwo] = twists;
  if (!twistOne || !twistTwo) throw new HandError('wrong-count', 'Both chefs must get a twist.');
  // The twist lands last in each hand — it is the beat everyone reacts to.
  return parseHands(
    deck.id,
    {
      chefOne: { deckId: deck.id, ingredients: [...chefOne, twistOne] },
      chefTwo: { deckId: deck.id, ingredients: [...chefTwo, twistTwo] },
    },
    vegetarianOnly,
  );
}

/* ------------------------------------------------------------------ */
/* Custom dish: the host types ANY dish or cuisine                      */
/* ------------------------------------------------------------------ */

const CUSTOM_SYSTEM_PROMPT =
  'You invent ingredients for a party cooking game. Reply with JSON only — ' +
  'exactly the object shape requested — and no other text.';

interface CustomIngredientDraft {
  name: string;
  origin: string;
  vegetarian: boolean;
  vegan: boolean;
}

function customUserPrompt(dishName: string, vegetarianOnly: boolean): string {
  return JSON.stringify({
    task:
      'Invent the two chefs\' secret ingredient hands for this dish or cuisine. ' +
      'Every ingredient must be a real, cookable, purchasable ingredient — never a prepared dish, brand, or novelty.',
    dish: dishName,
    rules: [
      'Each hand is exactly 5 ingredients.',
      'In each hand, the LAST ingredient is a cross-cuisine twist from a clearly different culinary tradition — surprising but genuinely cookable.',
      'No ingredient name appears in both hands; all ten names are distinct (case-insensitive).',
      ...(vegetarianOnly ? ['EVERY ingredient must be vegetarian (no meat, no fish); set the flags accordingly.'] : []),
      'vegan must be false whenever the ingredient contains any animal product (dairy, honey, etc.).',
    ],
    format: {
      chefOne: { ingredients: [{ name: 'string', origin: 'string', vegetarian: true, vegan: true }] },
      chefTwo: { ingredients: [{ name: 'string', origin: 'string', vegetarian: true, vegan: true }] },
    },
  });
}

/** A parsed custom reply that survives every structural check. */
function parseCustomReply(
  dishName: string,
  content: string,
  vegetarianOnly: boolean,
): { chefOne: Hand; chefTwo: Hand; deck: Deck } | undefined {
  const parsed = extractJsonObject(content);
  if (!parsed) return undefined;
  const readHand = (value: unknown): CustomIngredientDraft[] | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const list = (value as { ingredients?: unknown }).ingredients;
    if (!Array.isArray(list) || list.length !== INGREDIENTS_PER_CHEF) return undefined;
    const out: CustomIngredientDraft[] = [];
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) return undefined;
      const raw = entry as Record<string, unknown>;
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const origin = typeof raw.origin === 'string' ? raw.origin.trim() : '';
      if (!name || name.length > 80 || origin.length > 40) return undefined;
      if (typeof raw.vegetarian !== 'boolean' || typeof raw.vegan !== 'boolean') return undefined;
      // The dietary flags are a promise about data, not a model's guess: a
      // non-vegetarian ingredient in a vegetarian match is a hard rejection.
      // Vegan is a separate, softer flag — dairy is vegetarian, so only the
      // vegetarian flag gates a vegetarian match.
      if (vegetarianOnly && !raw.vegetarian) return undefined;
      out.push({ name, origin, vegetarian: raw.vegetarian, vegan: raw.vegan });
    }
    return out;
  };
  const one = readHand(parsed.chefOne);
  const two = readHand(parsed.chefTwo);
  if (!one || !two) return undefined;

  // All ten names distinct, case-insensitively — a repeat reads like a bug.
  const seen = new Set<string>();
  for (const draft of [...one, ...two]) {
    const key = draft.name.toLowerCase();
    if (seen.has(key)) return undefined;
    seen.add(key);
  }

  const toIngredient = (draft: CustomIngredientDraft): Ingredient => ({
    id: slugId(draft.name),
    name: draft.name,
    vegetarian: draft.vegetarian,
    vegan: draft.vegan,
    origin: draft.origin || 'custom',
  });
  // The twist is the last ingredient of each hand — the deck split relies on it.
  const deck = makeCustomDeck(dishName, [...one, ...two].map(toIngredient));
  return {
    chefOne: { deckId: deck.id, ingredients: one.map(toIngredient) },
    chefTwo: { deckId: deck.id, ingredients: two.map(toIngredient) },
    deck,
  };
}

export interface GenerateCustomHandsOptions {
  vegetarianOnly?: boolean;
  venice?: VeniceClient;
  random?: Random;
}

/**
 * Generates both hands for a host-typed dish. Venice invents all ten
 * ingredients; the structural checks here decide whether its answer is usable.
 * ANY failure — no client, network error, malformed JSON, a repeated name, a
 * bad dietary flag — falls back to the Chaos Mix deck, because a party never
 * stalls on the network. The returned `deck` is the one the hands validate
 * against: the caller must register it before the draft starts.
 */
export async function generateCustomHands(
  dishName: string,
  options: GenerateCustomHandsOptions = {},
): Promise<{ chefOne: Hand; chefTwo: Hand; deck: Deck }> {
  const clean = dishName.trim();
  const venice = options.venice;
  if (clean.length < 2 || clean.length > 80 || !venice) {
    return { ...(await generateHands(deckById('chaos')!, options)), deck: deckById('chaos')! };
  }
  try {
    const { content } = await venice.chat(
      [
        { role: 'system', content: CUSTOM_SYSTEM_PROMPT },
        { role: 'user', content: customUserPrompt(clean, options.vegetarianOnly ?? false) },
      ],
      // Ten invented ingredients need more room than a single twist pick.
      { maxTokens: 8192 },
    );
    const parsed = parseCustomReply(clean, content, options.vegetarianOnly ?? false);
    if (!parsed) {
      return { ...(await generateHands(deckById('chaos')!, options)), deck: deckById('chaos')! };
    }
    return parsed;
  } catch {
    return { ...(await generateHands(deckById('chaos')!, options)), deck: deckById('chaos')! };
  }
}
