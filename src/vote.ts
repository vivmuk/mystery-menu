import type { PublicVoteState } from '../server/votes.ts';
import type { VoteRequest, VoteCastRequest } from '../server/protocol.ts';

export interface VoteContext {
  code: string;
  host: boolean;
  eligible: boolean;
  connected: boolean;
  locked: boolean;
  pending: boolean;
  error: string | null;
  send: (event: 'vote:open' | 'vote:cast', payload: VoteRequest | VoteCastRequest) => void;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Dishes, badges, counts and outcomes come ONLY from the public vote projection. */
export function mountVote(root: HTMLElement, state: PublicVoteState, context: VoteContext): void {
  const { tally } = state;
  const screen = el('section', 'vote-screen');
  const heading = el('div', 'auction-heading');
  heading.append(el('h2', '', 'Which would you eat?'), el('span', 'auction-room', `Table ${context.code}`));
  screen.append(heading);
  const winner = tally.dishes.find(dish => dish.chef === tally.winner);
  if (tally.phase === 'closed') {
    const result = el('section', 'vote-result');
    result.setAttribute('role', 'status');
    result.append(el('h2', '', tally.tie ? 'It’s a tie. Both dishes win the table.' : `The table picks ${winner?.chefName ?? 'the winning chef'}’s dish`));
    result.append(el('p', '', tally.tie ? 'A shared result. No tie-breaker and no extra ballot.' : 'The dish the table would rather eat.'));
    screen.append(result);
  }
  const notice = el('p', 'vote-notice');
  notice.setAttribute('role', 'status');
  notice.textContent = context.locked ? 'Vote locked in — anonymous' : !context.connected ? 'Connection lost. Voting is paused.' : context.pending ? 'Sending your anonymous vote…' : tally.phase === 'waiting' ? 'Waiting for the vote to open' : tally.phase === 'closed' ? 'Voting is closed.' : context.eligible ? 'One vote. Pick the dish you would actually eat.' : 'The table is judging. Chefs watch this vote.';
  screen.append(notice, el('p', 'vote-privacy', 'Anonymous ballots. The tally appears together when everyone has voted, never in arrival order.'));
  if (context.error) {
    const error = el('p', 'draft-error', context.error);
    error.id = 'vote-error'; error.setAttribute('role', 'alert'); screen.append(error);
  }
  let submitted = context.pending;
  const buttons: HTMLButtonElement[] = [];
  const send = (event: 'vote:open' | 'vote:cast', payload: VoteRequest | VoteCastRequest): void => {
    if (submitted || !context.connected) return;
    submitted = true;
    buttons.forEach(button => { button.disabled = true; });
    notice.textContent = event === 'vote:open' ? 'Opening the vote…' : 'Sending your anonymous vote…';
    context.send(event, payload);
  };
  if (context.host && tally.phase === 'waiting') {
    const open = el('button', 'btn btn--primary vote-open', 'Open voting');
    open.type = 'button'; open.disabled = !context.connected || context.pending;
    open.addEventListener('click', () => send('vote:open', { code: context.code }));
    buttons.push(open); screen.append(open);
  }
  const plates = el('div', 'vote-grid');
  for (const dish of tally.dishes) {
    const card = el('section', `dish dish--${dish.chef} vote-dish`);
    card.append(el('h3', '', dish.chefName));
    card.append(el('p', dish.vegetarian ? 'vegetarian-badge' : 'dietary-badge', dish.vegetarian ? 'Vegetarian · every ingredient' : 'Contains meat or fish'));
    const list = el('ul', 'dish__items');
    for (const ingredient of dish.ingredients) list.append(el('li', '', ingredient));
    card.append(list);
    if (tally.phase === 'closed') card.append(el('p', 'vote-count', `${dish.count} ${dish.count === 1 ? 'vote' : 'votes'}`));
    const button = el('button', `btn ${dish.chef === 'chefOne' ? 'btn--primary' : 'btn--secondary'} vote-button`, `Vote for ${dish.chefName}’s dish`);
    button.type = 'button'; button.dataset.vote = dish.chef;
    button.disabled = tally.phase !== 'open' || !context.eligible || !context.connected || context.locked || context.pending;
    button.addEventListener('click', () => {
      if (!button.disabled) send('vote:cast', { code: context.code, dish: dish.chef });
    });
    buttons.push(button); card.append(button); plates.append(card);
  }
  screen.append(plates);
  root.append(screen);
}
