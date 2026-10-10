import { describe, expect, it, vi } from 'vitest';
import { DECKS, deckById, ingredientById } from '../server/ingredients/deck.ts';
import {
  cryptoRandom,
  dealHands,
  generateHands,
  HandError,
  INGREDIENTS_PER_CHEF,
  parseHand,
  parseHands,
} from '../server/ingredients/generate.ts';
import type { VeniceClient } from '../server/venice/client.ts';
import type { Ingredient, Random } from '../server/ingredients/deck.ts';

/** A mulberry32 PRNG — small, fast, and fully reproducible from one seed. */
function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return (max) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * max;
  };
}

const ALL_IDS = DECKS.flatMap((d) => [...d.corePool, ...d.twistPool]).map((i) => i.id);

describe('deck catalog', () => {
  it('has unique ids within each deck and consistent vegetarian/vegan flags', () => {
    for (const deck of DECKS) {
      const ids = [...deck.corePool, ...deck.twistPool].map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    for (const ingredient of DECKS.flatMap((d) => [...d.corePool, ...d.twistPool])) {
      expect(ingredient.name.length).toBeGreaterThan(0);
      if (!ingredient.vegetarian) expect(ingredient.vegan).toBe(false);
    }
  });

  it('never offers a twist that is also a core of the same deck', () => {
    for (const deck of DECKS) {
      const core = new Set(deck.corePool.map((i) => i.id));
      for (const twist of deck.twistPool) expect(core.has(twist.id)).toBe(false);
    }
  });

  it('resolves ids through the catalog and rejects unknown decks', () => {
    expect(ingredientById('miso-paste')?.name).toBe('Miso paste');
    expect(ingredientById('skittles')).toBeUndefined();
    expect(deckById('pizza')).toBeDefined();
    expect(deckById('nonna-special')).toBeUndefined();
  });
});

describe('parseHand', () => {
  const deck = deckById('pizza')!;
  const cores = deck.corePool.filter((i) => i.vegetarian).slice(0, 4).map((i) => i.id);
  const twist = deck.twistPool.find((i) => i.vegetarian)!.id;
  const good = { ingredients: [...cores, twist] };

  it('accepts a valid hand and resolves full ingredient objects', () => {
    const hand = parseHand('pizza', good);
    expect(hand.ingredients).toHaveLength(5);
    expect(hand.ingredients.every((i) => i.name && i.vegetarian !== undefined)).toBe(true);
    expect(hand.ingredients[4]?.id).toBe(twist);
  });

  it('throws wrong-count on four or six ingredients', () => {
    expect(() => parseHand('pizza', { ingredients: good.ingredients.slice(0, 4) })).toThrow(HandError);
    expect(() => parseHand('pizza', { ingredients: [...good.ingredients, 'garlic'] })).toThrow(HandError);
    try {
      parseHand('pizza', { ingredients: good.ingredients.slice(0, 4) });
    } catch (err) {
      expect((err as HandError).code).toBe('wrong-count');
    }
  });

  it('throws on non-arrays, non-strings, unknown ids, and unknown decks', () => {
    expect(() => parseHand('pizza', { ingredients: 'five ingredients' })).toThrow(HandError);
    expect(() => parseHand('pizza', { ingredients: [1, 2, 3, 4, 5] })).toThrow(HandError);
    expect(() => parseHand('pizza', { ingredients: [...good.ingredients.slice(0, 4), 'skittles'] })).toThrow(
      /not an ingredient/,
    );
    expect(() => parseHand('chaos', good)).toThrow(HandError);
  });

  it('throws on duplicates inside one hand', () => {
    const dup = [...good.ingredients.slice(0, 4), good.ingredients[0]!];
    expect(() => parseHand('pizza', { ingredients: dup })).toThrow(/twice/);
  });

  it('enforces the vegetarian filter against the data, not a promise', () => {
    const meatCore = deck.corePool.find((i) => !i.vegetarian)!.id;
    const hand = { ingredients: [...cores.slice(0, 3), twist, meatCore] };
    expect(() => parseHand('pizza', hand, true)).toThrow(/not vegetarian/);
    try {
      parseHand('pizza', hand, true);
    } catch (err) {
      expect((err as HandError).code).toBe('not-vegetarian');
    }
  });

  it('counts twists strictly: zero or two twists both fail', () => {
    const secondTwist = deck.twistPool.find((i) => i.id !== twist)!.id;
    expect(() => parseHand('pizza', { ingredients: [...cores, secondTwist] })).not.toThrow();
    expect(() =>
      parseHand('pizza', { ingredients: [...good.ingredients.slice(0, 3), twist, secondTwist] }),
    ).toThrow(/twist/);
    expect(() => parseHand('pizza', { ingredients: deck.corePool.slice(0, 5).map((i) => i.id) })).toThrow(
      /twist/,
    );
  });

  it('rejects a vegetarian-only hand built from non-vegetarian items (model output injected)', () => {
    // Simulated model output: plausible-looking JSON claiming a vegetarian hand
    // that actually contains anchovies. The validator must reject it.
    const modelSays = {
      deckId: 'pizza',
      ingredients: [...cores, 'anchovies'],
    };
    expect(() => parseHand('pizza', modelSays, true)).toThrow(/not vegetarian/);
  });
});

describe('parseHands', () => {
  it('rejects two identical hands', () => {
    const deck = deckById('tacos')!;
    const cores = deck.corePool.filter((i) => i.vegetarian).slice(0, 4).map((i) => i.id);
    const twist = deck.twistPool.find((i) => i.vegetarian)!.id;
    const same = { chefOne: { ingredients: [...cores, twist] }, chefTwo: { ingredients: [...cores, twist] } };
    expect(() => parseHands('tacos', same)).toThrow(/identical/);
  });
});

describe('dealHands (deterministic core)', () => {
  it('deals exactly five per chef for every deck and dietary mode', () => {
    for (const deck of DECKS) {
      for (const vegetarianOnly of [false, true]) {
        const { chefOne, chefTwo } = dealHands(deck, seededRandom(1), vegetarianOnly);
        expect(chefOne.ingredients).toHaveLength(INGREDIENTS_PER_CHEF);
        expect(chefTwo.ingredients).toHaveLength(INGREDIENTS_PER_CHEF);
      }
    }
  });

  it('keeps every vegetarian-only hand fully vegetarian', () => {
    for (const deck of DECKS) {
      const { chefOne, chefTwo } = dealHands(deck, seededRandom(7), true);
      for (const hand of [chefOne, chefTwo]) {
        expect(hand.ingredients.every((i) => i.vegetarian)).toBe(true);
      }
    }
  });

  it('gives each chef exactly one twist, always last in the hand', () => {
    for (const deck of DECKS) {
      const { chefOne, chefTwo } = dealHands(deck, seededRandom(2));
      for (const hand of [chefOne, chefTwo]) {
        const twistCount = hand.ingredients.filter(
          (i) => deck.twistPool.some((t) => t.id === i.id),
        ).length;
        expect(twistCount).toBe(1);
        expect(deck.twistPool.some((t) => t.id === hand.ingredients[4]?.id)).toBe(true);
      }
    }
  });

  it('never duplicates an ingredient inside a hand', () => {
    for (const deck of DECKS) {
      const { chefOne, chefTwo } = dealHands(deck, seededRandom(3));
      for (const hand of [chefOne, chefTwo]) {
        expect(new Set(hand.ingredients.map((i) => i.id)).size).toBe(INGREDIENTS_PER_CHEF);
      }
    }
  });

  it('never deals the same twist to both chefs', () => {
    for (const deck of DECKS) {
      const { chefOne, chefTwo } = dealHands(deck, seededRandom(4));
      expect(chefOne.ingredients[4]?.id).not.toBe(chefTwo.ingredients[4]?.id);
    }
  });

  it('produces distinct hands for the two chefs', () => {
    for (const deck of DECKS) {
      const { chefOne, chefTwo } = dealHands(deck, seededRandom(5), true);
      expect(chefOne.ingredients.map((i) => i.id).sort().join('|')).not.toBe(
        chefTwo.ingredients.map((i) => i.id).sort().join('|'),
      );
    }
  });

  it('is deterministic under a seeded random and reproducible via cryptoRandom shape', () => {
    const first = dealHands(deckById('indian')!, seededRandom(42));
    const second = dealHands(deckById('indian')!, seededRandom(42));
    expect(first).toEqual(second);
    // cryptoRandom is just randomInt: same signature, integer in [0, max).
    expect(Number.isInteger(cryptoRandom(3))).toBe(true);
    expect(cryptoRandom(1)).toBe(0);
  });

  it('survives many seeded draws without ever violating the rules', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const deck of DECKS) {
        const { chefOne, chefTwo } = dealHands(deck, seededRandom(seed), seed % 2 === 0);
        const check = (hand: typeof chefOne): void => {
          expect(hand.ingredients).toHaveLength(5);
          expect(new Set(hand.ingredients.map((i) => i.id)).size).toBe(5);
          expect(hand.ingredients.filter((i) => deck.twistPool.some((t) => t.id === i.id))).toHaveLength(1);
        };
        check(chefOne);
        check(chefTwo);
        expect(chefOne.ingredients[4]?.id).not.toBe(chefTwo.ingredients[4]?.id);
      }
    }
  });
});

describe('generateHands (Venice-mocked)', () => {
  const deck = deckById('bowls')!;

  function fakeVenice(twistId: string): { client: VeniceClient; chat: ReturnType<typeof vi.fn> } {
    const chat = vi.fn(async () => ({ content: `{"twistId":"${twistId}"}`, model: 'mock', raw: {} }));
    const client: VeniceClient = {
      chat: chat as unknown as VeniceClient['chat'],
      generateImage: vi.fn(),
      synthesizeSpeech: vi.fn(),
      health: vi.fn(),
    };
    return { client, chat };
  }

  it('uses the model-chosen twist when it names a vetted candidate', async () => {
    const twistId = deck.twistPool[0]!.id;
    const { client, chat } = fakeVenice(twistId);

    const { chefOne, chefTwo } = await generateHands(deck, { venice: client, random: seededRandom(9) });

    expect(chat).toHaveBeenCalledTimes(2); // one twist choice per chef
    expect(chefOne.ingredients[4]?.id).toBe(twistId);
    expect(chefTwo.ingredients[4]?.id).not.toBe(twistId); // never the same twist twice
    const prompt = JSON.parse(String(chat.mock.calls[0]![0]![1].content)) as {
      alreadyDealt: string[];
    };
    expect(prompt.alreadyDealt).toHaveLength(4); // the model sees the dealt cores
  });

  it('falls back to the deck when the model names a hallucinated id', async () => {
    const { client, chat } = fakeVenice('skittles');
    const { chefOne, chefTwo } = await generateHands(deck, { venice: client, random: seededRandom(11) });

    expect(chat).toHaveBeenCalledTimes(2);
    for (const hand of [chefOne, chefTwo]) {
      expect(hand.ingredients).toHaveLength(INGREDIENTS_PER_CHEF);
      // The twist is still a real, vetted twist — never the hallucination.
      expect(deck.twistPool.some((t) => t.id === hand.ingredients[4]?.id)).toBe(true);
    }
  });

  it('falls back when the model wraps JSON in prose or fences, or fails entirely', async () => {
    const fenced: VeniceClient = {
      chat: vi.fn(async () => ({
        content: 'Sure! Here is my choice:\n```json\n{"twistId":"harissa"}\n```',
        model: 'mock',
        raw: {},
      })) as unknown as VeniceClient['chat'],
      generateImage: vi.fn(),
      synthesizeSpeech: vi.fn(),
      health: vi.fn(),
    };
    const { chefOne } = await generateHands(deck, { venice: fenced, random: seededRandom(13) });
    expect(chefOne.ingredients[4]?.id).toBe('harissa');

    const failing: VeniceClient = {
      chat: vi.fn(async () => {
        throw new Error('venice down');
      }) as unknown as VeniceClient['chat'],
      generateImage: vi.fn(),
      synthesizeSpeech: vi.fn(),
      health: vi.fn(),
    };
    const fallback = await generateHands(deck, { venice: failing, random: seededRandom(15) });
    expect(fallback.chefOne.ingredients).toHaveLength(5);
  });

  it('without a venice client it is exactly the deterministic dealer', async () => {
    const generated = await generateHands(deck, { random: seededRandom(21) });
    const dealt = dealHands(deck, seededRandom(21));
    expect(generated).toEqual(dealt);
  });

  it('honours the vegetarian filter on model-chosen twists too', async () => {
    // furikake is a vetted candidate but not vegetarian — in a vegetarian-only
    // match the model picking it must not survive validation.
    const vegetarianDeck = deckById('indian')!;
    const nonVegetarianTwist = vegetarianDeck.twistPool.find((i) => !i.vegetarian);
    expect(nonVegetarianTwist).toBeDefined();
    const { client } = fakeVenice(nonVegetarianTwist!.id);

    // The generator filters candidates before the model sees them, so the
    // unfiltered pick can only be exercised at the parseHand level — already
    // covered. Here: prove the generated hands are still all-vegetarian.
    const { chefOne, chefTwo } = await generateHands(vegetarianDeck, {
      venice: client,
      random: seededRandom(23),
      vegetarianOnly: true,
    });
    expect(chefOne.ingredients.every((i) => i.vegetarian)).toBe(true);
    expect(chefTwo.ingredients.every((i) => i.vegetarian)).toBe(true);
  });
});

describe('no early leak of hands into room state', () => {
  it('a hand never appears in any room:state payload before the reveal', async () => {
    // The rule from the spec: chefs know the theme and the count, never the
    // items. Room state is the only payload that exists today, and it must
    // stay ingredient-free: no hand field, no ingredient names in any player
    // payload, before a reveal phase exists.
    const deck = deckById('pizza')!;
    const { chefOne, chefTwo } = await generateHands(deck, { random: seededRandom(31) });
    const dealt = { chefOne, chefTwo };
    const stateShapeKeys = ['code', 'capacity', 'players'];

    // The room-state payload contract: exactly these keys, nothing more.
    const { RoomRegistry } = await import('../server/rooms.ts');
    const registry = new RoomRegistry();
    const room = registry.create();
    registry.join(room, 's1', 'Chef One', '#ff5a1f');
    registry.join(room, 's2', 'Chef Two', '#1f5aff');
    const payload = registry.state(room) as unknown as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([...stateShapeKeys].sort());
    const serialized = JSON.stringify(payload);
    for (const hand of [dealt.chefOne, dealt.chefTwo]) {
      for (const ingredient of hand.ingredients) {
        expect(serialized).not.toContain(ingredient.id);
        expect(serialized).not.toContain(ingredient.name);
      }
    }
  });

  it('dealHands output shape itself carries no broadcast-ready surprises', () => {
    const deck = deckById('tacos')!;
    const { chefOne } = dealHands(deck, seededRandom(33));
    // The hand payload is per-chef, deliberately private; it must not embed a
    // room or broadcast marker that could tempt a caller to ship it whole.
    expect(Object.keys(chefOne).sort()).toEqual(['deckId', 'ingredients']);
  });
});
