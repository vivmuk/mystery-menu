/**
 * The themed ingredient decks: the canonical library the whole game draws
 * from. Every ingredient carries its own vegetarian and vegan flags, so a
 * dietary filter is a check on data, never a promise made by a model.
 *
 * Each deck splits its pool in two: `corePool` — ingredients that belong in
 * this dish — and `twistPool` — real, cookable ingredients from other
 * culinary traditions. Exactly one twist lands in each chef's hand; it is the
 * beat the table reacts to, and it is never novelty candy.
 */

export interface Ingredient {
  /** Stable identifier — the only thing a wire payload is trusted to carry. */
  id: string;
  /** Human-readable name, shown when the referee announces the ingredient. */
  name: string;
  /** True when the ingredient contains no meat or fish. */
  vegetarian: boolean;
  /** True when the ingredient contains no animal product at all. */
  vegan: boolean;
  /** Cuisine of origin, e.g. `italian` — what makes a twist a twist. */
  origin: string;
}

export interface Deck {
  id: string;
  name: string;
  /** The deck's own culinary tradition, e.g. `italian`. */
  cuisine: string;
  /** Ingredients that belong in this dish. */
  corePool: Ingredient[];
  /** Real ingredients from OTHER traditions — plausible, never novelty. */
  twistPool: Ingredient[];
}

/** A strictness contract for the random function: an integer in `[0, max)`. */
export type Random = (max: number) => number;

function ing(
  id: string,
  name: string,
  origin: string,
  vegetarian = true,
  vegan = vegetarian,
): Ingredient {
  return { id, name, origin, vegetarian, vegan };
}

/**
 * The full canonical library in one flat list. Ids are globally unique — the
 * catalog self-check below throws on a duplicate, because a deck that can't
 * agree on what “gochujang” is would silently corrupt a hand.
 */
const INGREDIENTS: Ingredient[] = [
  // Shared across decks.
  ing('garlic', 'Garlic', 'mediterranean'),
  ing('red-onion', 'Red onion', 'mediterranean'),
  ing('lime', 'Lime', 'mexican'),
  ing('cilantro', 'Fresh coriander', 'mexican'),
  ing('avocado', 'Avocado', 'mexican'),
  ing('black-beans', 'Black beans', 'mexican'),
  ing('corn-tortillas', 'Corn tortillas', 'mexican'),
  ing('cotija', 'Cotija cheese', 'mexican', true, false),
  ing('basmati-rice', 'Basmati rice', 'indian'),
  ing('paneer', 'Paneer', 'indian', true, false),
  ing('cremini-mushrooms', 'Cremini mushrooms', 'french'),
  ing('san-marzano-tomatoes', 'San Marzano tomatoes', 'italian'),
  ing('fior-di-latte', 'Fior di latte mozzarella', 'italian', true, false),

  // Pizza deck.
  ing('pizza-dough', 'Pizza dough', 'italian'),
  ing('fresh-basil', 'Fresh basil', 'italian'),
  ing('extra-virgin-olive-oil', 'Extra-virgin olive oil', 'italian'),
  ing('dried-oregano', 'Dried oregano', 'italian'),
  ing('cherry-tomatoes', 'Cherry tomatoes', 'italian'),
  ing('taggiasca-olives', 'Taggiasca olives', 'italian'),
  ing('artichoke-hearts', 'Artichoke hearts', 'italian'),
  ing('smoked-scamorza', 'Smoked scamorza', 'italian', true, false),
  ing('hot-salami', 'Calabrian hot salami', 'italian', false, false),
  ing('prosciutto', 'Prosciutto di Parma', 'italian', false, false),
  ing('anchovies', 'Anchovies', 'italian', false, false),

  // Bowls deck (chipotle-style).
  ing('cilantro-lime-rice', 'Cilantro-lime rice', 'cal-mexican'),
  ing('fajita-peppers', 'Fajita peppers', 'cal-mexican'),
  ing('sofritas', 'Braised chipotle tofu', 'cal-mexican'),
  ing('pico-de-gallo', 'Pico de gallo', 'cal-mexican'),
  ing('corn-salsa', 'Roasted corn salsa', 'cal-mexican'),
  ing('guacamole', 'Guacamole', 'cal-mexican'),
  ing('shredded-romaine', 'Shredded romaine', 'cal-mexican'),
  ing('sour-cream', 'Sour cream', 'cal-mexican', true, false),
  ing('monterey-jack', 'Monterey Jack', 'cal-mexican', true, false),
  ing('queso-blanco', 'Queso blanco', 'cal-mexican', true, false),
  ing('chipotle-honey-vinaigrette', 'Chipotle-honey vinaigrette', 'cal-mexican', true, false),
  ing('grilled-chicken', 'Grilled chicken', 'cal-mexican', false, false),
  ing('carnitas', 'Carnitas', 'cal-mexican', false, false),
  ing('steak', 'Grilled steak', 'cal-mexican', false, false),

  // Tacos deck.
  ing('cebollitas', 'Grilled scallions', 'mexican'),
  ing('salsa-verde', 'Salsa verde', 'mexican'),
  ing('salsa-roja', 'Salsa roja', 'mexican'),
  ing('mexican-crema', 'Mexican crema', 'mexican', true, false),
  ing('pickled-red-onion', 'Pickled red onion', 'mexican'),
  ing('radishes', 'Radishes', 'mexican'),
  ing('charred-jalapeno', 'Charred jalapeño', 'mexican'),
  ing('carne-asada', 'Carne asada', 'mexican', false, false),
  ing('al-pastor', 'Al pastor pork', 'mexican', false, false),
  ing('pollo-asado', 'Pollo asado', 'mexican', false, false),

  // Indian deck.
  ing('garam-masala', 'Garam masala', 'indian'),
  ing('toor-dal', 'Toor dal', 'indian'),
  ing('cumin-seeds', 'Cumin seeds', 'indian'),
  ing('turmeric', 'Turmeric', 'indian'),
  ing('ghee', 'Ghee', 'indian', true, false),
  ing('naan', 'Naan', 'indian', true, false),
  ing('ripe-tomatoes', 'Ripe tomatoes', 'indian'),
  ing('green-chilli', 'Green chilli', 'indian'),
  ing('mustard-oil', 'Mustard oil', 'indian'),
  ing('kasuri-methi', 'Kasuri methi', 'indian'),
  ing('chicken-thigh', 'Chicken thigh', 'indian', false, false),
  ing('lamb-shoulder', 'Lamb shoulder', 'indian', false, false),

  // Chaos Mix deck staples.
  ing('chipotle-in-adobo', 'Chipotle in adobo', 'mexican'),

  // The cross-cuisine twist library. Every one is a real ingredient a chef
  // could actually cook with — funky, fermented, or fiercely spiced, but
  // never a novelty. Two of them (furikake, fish sauce…) are not even
  // vegetarian, which keeps the vegetarian filter honest.
  ing('douchi', 'Fermented black beans', 'chinese'),
  ing('gochujang', 'Gochujang', 'korean'),
  ing('doenjang', 'Doenjang', 'korean'),
  ing('miso-paste', 'Miso paste', 'japanese'),
  ing('furikake', 'Furikake', 'japanese', false, false),
  ing('yuzu-kosho', 'Yuzu kosho', 'japanese'),
  ing('doubanjiang', 'Doubanjiang', 'sichuan'),
  ing('fish-sauce', 'Fish sauce', 'southeast-asian', false, false),
  ing('shrimp-paste', 'Shrimp paste', 'southeast-asian', false, false),
  ing('harissa', 'Harissa', 'north-african'),
  ing('preserved-lemon', 'Preserved lemon', 'north-african'),
  ing('zaatar', 'Za’atar', 'levantine'),
  ing('sumac', 'Sumac', 'levantine'),
  ing('dukkah', 'Dukkah', 'egyptian'),
];

/** Every ingredient by id — the one source of truth for lookups. */
const CATALOG = new Map<string, Ingredient>();
for (const ingredient of INGREDIENTS) {
  if (CATALOG.has(ingredient.id)) {
    throw new Error(`Duplicate ingredient id “${ingredient.id}” in the canonical library.`);
  }
  CATALOG.set(ingredient.id, ingredient);
}

/** Looks up one canonical ingredient, or undefined when the id is unknown. */
export function ingredientById(id: string): Ingredient | undefined {
  return CATALOG.get(id);
}

/** Deck definitions reference the library by id, so nothing is duplicated. */
interface DeckDef {
  id: string;
  name: string;
  cuisine: string;
  coreIds: string[];
  twistIds: string[];
}

const DECK_DEFS: DeckDef[] = [
  {
    id: 'pizza',
    name: 'Pizza',
    cuisine: 'italian',
    coreIds: [
      'pizza-dough', 'san-marzano-tomatoes', 'fior-di-latte', 'fresh-basil',
      'extra-virgin-olive-oil', 'garlic', 'dried-oregano', 'cherry-tomatoes',
      'cremini-mushrooms', 'red-onion', 'taggiasca-olives', 'artichoke-hearts',
      'smoked-scamorza', 'hot-salami', 'prosciutto', 'anchovies',
    ],
    twistIds: [
      'douchi', 'gochujang', 'miso-paste', 'doubanjiang', 'harissa',
      'preserved-lemon', 'zaatar', 'yuzu-kosho', 'fish-sauce', 'shrimp-paste',
    ],
  },
  {
    id: 'bowls',
    name: 'Bowls',
    cuisine: 'cal-mexican',
    coreIds: [
      'cilantro-lime-rice', 'black-beans', 'fajita-peppers', 'sofritas',
      'pico-de-gallo', 'corn-salsa', 'guacamole', 'shredded-romaine',
      'sour-cream', 'monterey-jack', 'queso-blanco', 'chipotle-honey-vinaigrette',
      'lime', 'grilled-chicken', 'carnitas', 'steak',
    ],
    twistIds: [
      'gochujang', 'miso-paste', 'harissa', 'preserved-lemon', 'zaatar',
      'sumac', 'douchi', 'furikake', 'fish-sauce',
    ],
  },
  {
    id: 'tacos',
    name: 'Tacos',
    cuisine: 'mexican',
    coreIds: [
      'corn-tortillas', 'carne-asada', 'al-pastor', 'pollo-asado',
      'cebollitas', 'cilantro', 'salsa-verde', 'salsa-roja', 'avocado',
      'cotija', 'mexican-crema', 'pickled-red-onion', 'lime', 'radishes',
      'charred-jalapeno',
    ],
    twistIds: [
      'gochujang', 'doenjang', 'miso-paste', 'furikake', 'harissa',
      'preserved-lemon', 'dukkah', 'zaatar', 'fish-sauce', 'shrimp-paste',
    ],
  },
  {
    id: 'indian',
    name: 'Indian',
    cuisine: 'indian',
    coreIds: [
      'basmati-rice', 'garam-masala', 'paneer', 'toor-dal', 'cumin-seeds',
      'turmeric', 'ghee', 'naan', 'red-onion', 'ripe-tomatoes', 'green-chilli',
      'cilantro', 'mustard-oil', 'kasuri-methi', 'chicken-thigh', 'lamb-shoulder',
    ],
    twistIds: [
      'gochujang', 'miso-paste', 'doubanjiang', 'furikake', 'harissa',
      'preserved-lemon', 'sumac', 'zaatar', 'fish-sauce', 'shrimp-paste',
    ],
  },
  {
    id: 'chaos',
    name: 'Chaos Mix',
    cuisine: 'chaos',
    coreIds: [
      'corn-tortillas', 'san-marzano-tomatoes', 'fior-di-latte', 'black-beans',
      'basmati-rice', 'paneer', 'cotija', 'cilantro', 'chipotle-in-adobo',
      'cremini-mushrooms', 'garlic', 'lime', 'avocado', 'red-onion',
      'hot-salami',
    ],
    twistIds: [
      'douchi', 'doenjang', 'miso-paste', 'yuzu-kosho', 'gochujang',
      'harissa', 'fish-sauce', 'shrimp-paste',
    ],
  },
];

function resolve(id: string): Ingredient {
  const ingredient = CATALOG.get(id);
  if (!ingredient) throw new Error(`Deck references unknown ingredient id “${id}”.`);
  return ingredient;
}

/** Every themed deck, ready to deal from. */
export const DECKS: Deck[] = DECK_DEFS.map((def) => {
  const corePool = def.coreIds.map(resolve);
  const twistPool = def.twistIds.map(resolve);
  const coreIds = new Set(corePool.map((i) => i.id));
  for (const twist of twistPool) {
    if (coreIds.has(twist.id)) {
      throw new Error(`Deck “${def.id}” lists “${twist.id}” as both core and twist.`);
    }
  }
  return { id: def.id, name: def.name, cuisine: def.cuisine, corePool, twistPool };
});

/** Looks up one deck by id, or undefined when the id is unknown. */
export function deckById(id: string): Deck | undefined {
  return DECKS.find((deck) => deck.id === id) ?? CUSTOM_DECKS.get(id);
}

/**
 * The registry of host-typed decks. A match's custom deck is stored here so
 * `deckById` — and therefore the draft engine's own re-validation — can
 * resolve its ingredient ids. Entries are per-match and in-memory only, like
 * the rooms themselves; the cap keeps a long-running server from growing the
 * map forever, evicting the oldest deck first (a room whose deck was evicted
 * has long since ended its evening).
 */
const CUSTOM_DECKS = new Map<string, Deck>();
let customSequence = 0;
const CUSTOM_DECK_CAP = 100;

export function registerCustomDeck(deck: Deck): Deck {
  const id = `custom-${slugId(deck.name)}-${++customSequence}`;
  const stored: Deck = { ...deck, id };
  CUSTOM_DECKS.set(id, stored);
  if (CUSTOM_DECKS.size > CUSTOM_DECK_CAP) {
    const oldest = CUSTOM_DECKS.keys().next().value;
    if (oldest !== undefined) CUSTOM_DECKS.delete(oldest);
  }
  return stored;
}

/**
 * Custom decks: when a host types ANY dish or cuisine instead of picking a
 * preset, the generator builds a one-off deck from the model's ingredients.
 * These are deliberately NOT registered in `DECKS` — the catalog's duplicate
 * check exists for curated presets, and a per-match deck must never leak into
 * another room's `deckById` lookup.
 */

/** Kebab-case id for a free-form ingredient name, e.g. `Gochujang` → `gochujang`. */
export function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    // Strip combining marks so accented names slug cleanly (jalapeño → jalapeno).
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'ingredient';
}

/**
 * Builds the one-off deck for a host-typed dish. The caller hands the
 * ingredients in generation order — every chef's four cores first, the two
 * cross-cuisine twists last — so the split is positional: everything but the
 * final two is `corePool` (the first four of each hand come from here), and
 * the final two are the `twistPool`.
 */
export function makeCustomDeck(dishName: string, ingredients: Ingredient[]): Deck {
  const name = dishName.trim();
  if (name.length === 0) throw new Error('A custom deck needs a dish name.');
  if (ingredients.length < 3) {
    throw new Error('A custom deck needs at least one core ingredient and a twist.');
  }
  const split = Math.max(ingredients.length - 2, 1);
  return {
    id: 'custom',
    name,
    cuisine: name.toLowerCase(),
    corePool: ingredients.slice(0, split),
    twistPool: ingredients.slice(split),
  };
}
