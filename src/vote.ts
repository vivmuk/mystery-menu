import type { PublicVoteState } from '../server/votes.ts';
import type { Chef } from '../server/draft/engine.ts';
import type { VoteRequest, VoteCastRequest } from '../server/protocol.ts';

export interface VoteContext {
  code: string;
  host: boolean;
  eligible: boolean;
  connected: boolean;
  locked: boolean;
  pending: boolean;
  error: string | null;
  /** Solo demo: the host casts every diner's ballot from this phone. */
  demo?: boolean;
  voters?: { key: string; name: string; colour: string }[];
  myKey?: string;
  ballots?: Record<string, Chef>;
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
  notice.textContent = tally.phase === 'closed' ? 'Voting is closed.' : context.locked ? 'Vote locked in — anonymous' : !context.connected ? 'Connection lost. Voting is paused.' : context.pending ? 'Sending your anonymous vote…' : tally.phase === 'waiting' ? 'Waiting for the vote to open' : context.eligible ? 'One vote. Pick the dish you would actually eat.' : 'The table is judging. Chefs watch this vote.';
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
  const demoMode = context.demo === true;
  const demo = demoMode && tally.phase === 'open';
  for (const dish of tally.dishes) {
    const card = el('section', `dish dish--${dish.chef} vote-dish`);
    card.append(el('h3', '', dish.chefName));
    card.append(el('p', dish.vegetarian ? 'vegetarian-badge' : 'dietary-badge', dish.vegetarian ? 'Vegetarian · every ingredient' : 'Contains meat or fish'));
    const list = el('ul', 'dish__items');
    for (const ingredient of dish.ingredients) list.append(el('li', '', ingredient));
    card.append(list);
    if (tally.phase === 'closed') card.append(el('p', 'vote-count', `${dish.count} ${dish.count === 1 ? 'vote' : 'votes'}`));
    if (!demoMode) {
      const button = el('button', `btn ${dish.chef === 'chefOne' ? 'btn--primary' : 'btn--secondary'} vote-button`, `Vote for ${dish.chefName}’s dish`);
      button.type = 'button';
      button.dataset.vote = dish.chef;
      button.disabled = tally.phase !== 'open' || !context.eligible || !context.connected || context.locked || context.pending;
      button.addEventListener('click', () => {
        if (!button.disabled) send('vote:cast', { code: context.code, dish: dish.chef });
      });
      buttons.push(button);
      card.append(button);
    }
    plates.append(card);
  }
  screen.append(plates);

  // In a solo demo the host is the whole table: one ballot per diner, cast
  // from this phone. The tally still releases only when every ballot is in.
  if (demo) {
    const voters = context.voters ?? [];
    const ballots = context.ballots ?? {};
    const panel = el('section', 'director-ballot');
    const total = voters.length;
    const cast = voters.filter((voter) => ballots[voter.key]).length;
    panel.append(el('h3', '', 'The table — your ballots'));
    panel.append(el('p', 'director-ballot__hint', `${cast} of ${total} ballots cast. The tally appears together, never one by one.`));
    const rows = el('div', 'director-ballot__rows');
    const rowButtons: Record<string, HTMLButtonElement[]> = {};
    const refresh = (): void => {
      const done = voters.filter((voter) => ballots[voter.key]).length;
      const hint = panel.querySelector('.director-ballot__hint');
      if (hint) hint.textContent = `${done} of ${total} ballots cast. ${done === total ? 'Releasing the tally…' : 'The tally appears together, never one by one.'}`;
      for (const voter of voters) {
        const voted = ballots[voter.key];
        const row = rows.querySelector<HTMLElement>(`[data-voter="${voter.key}"]`);
        if (!row) continue;
        row.classList.toggle('is-voted', !!voted);
        const label = row.querySelector<HTMLElement>('.director-ballot__state');
        if (label) label.textContent = voted ? `voted ${voted === 'chefOne' ? 'Chef One' : 'Chef Two'}` : 'not voted';
        (rowButtons[voter.key] ?? []).forEach((button) => { button.disabled = !!voted || submitted || !context.connected; });
      }
    };
    for (const voter of voters) {
      const row = el('div', 'director-ballot__row');
      row.dataset.voter = voter.key;
      const dot = el('span', 'director-ballot__dot');
      dot.style.backgroundColor = voter.colour;
      row.append(dot, el('span', 'director-ballot__name', voter.name), el('span', 'director-ballot__state', 'not voted'));
      const actions = el('div', 'director-ballot__actions');
      const rowSet: HTMLButtonElement[] = [];
      for (const chef of ['chefOne', 'chefTwo'] as const) {
        const button = el('button', 'btn director-ballot__pick', chef === 'chefOne' ? 'Chef One' : 'Chef Two');
        button.type = 'button';
        button.addEventListener('click', () => {
          if (ballots[voter.key] || submitted || !context.connected) return;
          ballots[voter.key] = chef;
          for (const node of rowSet) node.disabled = true;
          refresh();
          context.send('vote:cast', { code: context.code, dish: chef, voter: voter.key });
        });
        rowSet.push(button);
        actions.append(button);
      }
      rowButtons[voter.key] = rowSet;
      row.append(actions);
      rows.append(row);
    }
    panel.append(rows);
    const fill = el('button', 'btn btn--secondary director-ballot__fill', 'Fill the rest at random');
    fill.type = 'button';
    fill.addEventListener('click', () => {
      let delay = 0;
      for (const voter of voters) {
        if (ballots[voter.key]) continue;
        const chef: Chef = Math.random() < 0.5 ? 'chefOne' : 'chefTwo';
        ballots[voter.key] = chef;
        rowButtons[voter.key]?.forEach((button) => { button.disabled = true; });
        window.setTimeout(() => {
          context.send('vote:cast', { code: context.code, dish: chef, voter: voter.key });
        }, delay);
        delay += 220;
      }
      refresh();
    });
    panel.append(fill);
    screen.append(panel);
    refresh();
  }

  root.append(screen);
}
