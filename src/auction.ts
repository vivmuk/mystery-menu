import type { Chef, PublicDraftState } from '../server/draft/engine.ts';
import type { DraftBidRequest, DraftChefRequest, DraftRequest } from '../server/protocol.ts';
import { canAct, canBid, isTwistReveal, remainingMs } from './auction-model.ts';

export interface AuctionContext {
  code: string;
  chef: Chef | null;
  names: Record<Chef, string>;
  host: boolean;
  connected: boolean;
  newReveal: boolean;
  newAward: boolean;
  send: (event: 'draft:bid' | 'draft:take-it' | 'draft:reveal', payload: DraftBidRequest | DraftChefRequest | DraftRequest) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** All ingredient, purse, plate and bid data comes from this public snapshot. */
export function mountAuction(root: HTMLElement, state: PublicDraftState, context: AuctionContext): () => void {
  const screen = el('section', 'auction-screen');
  const setText = (node: HTMLElement, text: string): void => {
    if (node.textContent !== text) node.textContent = text;
  };
  const heading = el('div', 'auction-heading');
  heading.append(el('h2', '', `Round ${state.round}`), el('span', 'auction-room', `Table ${context.code}`));
  const notice = el('p', 'auction-notice');
  notice.setAttribute('role', 'status');
  const error = el('p', 'draft-error');
  error.id = 'draft-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  screen.append(heading, error, notice);

  const purses = el('div', 'purses');
  for (const chef of ['chefOne', 'chefTwo'] as const) {
    const panel = el('section', `purse purse--${chef}${state.auction?.turn === chef ? ' purse--turn' : ''}`);
    const own = chef === context.chef;
    const name = el('h3', 'purse__name', own ? 'You' : context.names[chef]);
    name.title = context.names[chef];
    panel.append(name);
    const coins = el('p', 'purse__coins', String(state.chefs[chef].coins));
    coins.append(el('span', '', ' coins'));
    if (context.newAward && state.lastAward?.chef === chef && state.lastAward.price > 0) coins.classList.add('purse__coins--spent');
    const dots = el('div', 'purse__dots');
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 10; i++) dots.append(el('i', i < state.chefs[chef].coins ? 'coin coin--full' : 'coin'));
    panel.append(coins, dots);
    purses.append(panel);
  }
  screen.append(purses);

  const current = state.auction?.item ?? state.lastAward?.item;
  const hero = el('section', `ingredient${isTwistReveal(state) ? ' ingredient--twist' : ''}${context.newReveal ? ' ingredient--new' : ''}`);
  const revealed = state.chefs.chefOne.items.length + state.chefs.chefTwo.items.length + (state.auction ? 1 : 0);
  hero.append(el('p', 'ingredient__count', current ? `Ingredient ${revealed} / ${state.totalItems}` : 'The ingredients are still a secret'));
  const plate = el('div', 'ingredient__plate');
  plate.setAttribute('aria-hidden', 'true');
  plate.append(el('span', 'ingredient__monogram', current ? current.ingredient.name.slice(0, 1) : '?'));
  hero.append(plate);
  if (current) {
    if (isTwistReveal(state)) hero.append(el('p', 'twist-badge', 'Cross-cuisine twist!'));
    hero.append(el('h3', 'ingredient__name', current.ingredient.name));
    hero.append(el('p', 'ingredient__origin', `${current.ingredient.origin} origin${current.ingredient.vegan ? ' · Vegan' : current.ingredient.vegetarian ? ' · Vegetarian' : ''}`));
  } else hero.append(el('h3', 'ingredient__name', 'What’s on the menu?'));
  if (!state.auction && state.lastAward) {
    hero.append(el('p', 'ingredient__award', `${context.names[state.lastAward.chef]} gets it for ${state.lastAward.price} ${state.lastAward.price === 1 ? 'coin' : 'coins'}.${state.lastAward.reason === 'timeout' ? ' Time’s up!' : ''}`));
  }
  screen.append(hero);

  let tick = (): void => {};
  let pending = false;
  const buttons: { button: HTMLButtonElement; amount: number }[] = [];
  const clock = el('section', 'shot-clock');
  const clockLabel = el('p', 'shot-clock__label');
  const clockValue = el('strong', 'shot-clock__value');
  const track = el('div', 'shot-clock__track');
  track.setAttribute('aria-hidden', 'true');
  const fill = el('div', 'shot-clock__fill');
  track.append(fill);
  const controls = el('section', 'bid-controls');
  const take = el('button', 'btn take-it', 'Take it');
  take.type = 'button';
  const submit = (event: 'draft:bid' | 'draft:take-it' | 'draft:reveal', payload: DraftBidRequest | DraftChefRequest | DraftRequest): void => {
    pending = true;
    error.hidden = true;
    tick();
    context.send(event, payload);
  };
  if (state.auction) {
    const standing = el('div', 'standing-bid');
    standing.append(el('span', '', 'Standing bid'), el('strong', '', `${state.auction.standingBid} ${state.auction.standingBid === 1 ? 'coin' : 'coins'}`));
    controls.append(standing);
    controls.append(el('p', 'bid-owner', state.auction.bidder ? `${context.names[state.auction.bidder]} is bidding` : 'No bids yet. Open with 1 coin.'));
    clock.append(clockLabel, clockValue, track);
    screen.append(clock);
    const raises = el('div', 'bid-raises');
    for (const step of [1, 2, 5]) {
      const amount = state.auction.standingBid + step;
      const button = el('button', 'btn bid-raise', `+${step}`);
      button.type = 'button';
      button.append(el('span', '', `${amount} ${amount === 1 ? 'coin' : 'coins'}`));
      button.setAttribute('aria-label', `Raise by ${step}, bid ${amount} ${amount === 1 ? 'coin' : 'coins'}`);
      button.dataset.action = `raise-${step}`;
      button.addEventListener('click', () => {
        if (!pending && context.connected && canBid(state, context.chef, amount, Date.now()) && context.chef) submit('draft:bid', { code: context.code, chef: context.chef, amount });
      });
      buttons.push({ button, amount });
      raises.append(button);
    }
    controls.append(raises);
    const next = el('button', 'btn btn--secondary bid-next', `Bid ${state.auction.standingBid + 1} · next legal bid`);
    next.type = 'button';
    next.dataset.action = 'next-bid';
    const amount = state.auction.standingBid + 1;
    next.addEventListener('click', () => {
      if (!pending && context.connected && context.chef && canBid(state, context.chef, amount, Date.now())) submit('draft:bid', { code: context.code, chef: context.chef, amount });
    });
    buttons.push({ button: next, amount });
    take.dataset.action = 'take-it';
    take.append(el('span', '', `Let ${context.names[state.auction.turn === 'chefOne' ? 'chefTwo' : 'chefOne']} have it`));
    take.addEventListener('click', () => {
      if (!pending && context.connected && context.chef && canAct(state, context.chef, Date.now())) submit('draft:take-it', { code: context.code, chef: context.chef });
    });
    controls.append(next, take);
    tick = (): void => {
      const now = Date.now();
      const remaining = remainingMs(state.deadline, now);
      setText(clockValue, `${Math.ceil(remaining / 1000)}s`);
      setText(clockLabel, remaining === 0 ? 'Time’s up · waiting for the referee' : context.chef === state.auction!.turn ? 'Your shot clock' : `${context.names[state.auction!.turn]}’s shot clock`);
      fill.style.transform = `scaleX(${remaining / 10000})`;
      clock.classList.toggle('shot-clock--urgent', remaining > 0 && remaining <= 3000);
      for (const { button, amount } of buttons) button.disabled = pending || !context.connected || !canBid(state, context.chef, amount, now);
      take.disabled = pending || !context.connected || !canAct(state, context.chef, now);
      setText(notice, !context.connected ? 'Connection lost. Controls are paused.' : pending ? 'Waiting for the referee…' : remaining === 0 ? 'The server is settling this ingredient.' : context.chef === null ? `${context.names[state.auction!.turn]}’s turn. You’re watching from the table.` : state.auction!.turn === context.chef ? 'Your turn! Raise or say “Take it”.' : `${context.names[state.auction!.turn]}’s turn. Get ready.`);
    };
    screen.append(controls);
  } else {
    notice.textContent = !context.connected ? 'Connection lost. Controls are paused.' : state.pendingTrade ? 'A trade needs an answer before the next reveal.' : state.phase === 'reveal' ? context.host ? 'You’re the referee. Reveal the next ingredient.' : 'Waiting for the host to reveal the next ingredient.' : state.phase === 'plating' ? 'Dishes are ready for the table.' : state.winner ? `${context.names[state.winner]} wins!` : 'Round complete.';
  }

  if (context.host && state.phase === 'reveal') {
    const reveal = el('button', 'btn btn--primary host-reveal', 'Reveal next ingredient');
    reveal.type = 'button';
    reveal.disabled = !context.connected || state.pendingTrade !== null;
    reveal.addEventListener('click', () => {
      if (reveal.disabled) return;
      reveal.disabled = true;
      submit('draft:reveal', { code: context.code });
    });
    screen.append(reveal);
  }

  const dishes = el('section', 'dishes');
  dishes.append(el('h3', '', 'On the plates'));
  const plates = el('div', 'dish-grid');
  for (const chef of ['chefOne', 'chefTwo'] as const) {
    const dish = el('section', `dish dish--${chef}`);
    const items = state.chefs[chef].items;
    const name = el('h4', '', context.names[chef]);
    name.title = context.names[chef];
    dish.append(name, el('p', 'dish__count', `${items.length} / 5 ingredients`));
    const slots = el('div', 'dish__slots');
    slots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 5; i++) slots.append(el('span', i < items.length ? 'dish__slot dish__slot--filled' : 'dish__slot', i < items.length ? '●' : ''));
    dish.append(slots);
    const list = el('ul', 'dish__items');
    for (const item of items) {
      const row = el('li', '', item.ingredient.name);
      if (context.newAward && state.lastAward?.item.slot === item.slot) row.classList.add('dish__item--new');
      list.append(row);
    }
    if (!items.length) dish.append(el('p', 'dish__empty', 'First ingredient coming up.'));
    else dish.append(list);
    plates.append(dish);
  }
  dishes.append(plates);
  screen.append(dishes);
  root.append(screen);
  tick();
  const interval = state.auction ? window.setInterval(tick, 100) : null;
  return () => { if (interval !== null) window.clearInterval(interval); };
}
