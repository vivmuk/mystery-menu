import QRCode from 'qrcode';
import { io, type Socket } from 'socket.io-client';

import type { RoomStatePayload as RoomState, PlayerRole } from '../server/rooms.ts';
import type { Chef, PublicDraftState } from '../server/draft/engine.ts';
import type { DraftErrorPayload, VoteErrorPayload } from '../server/protocol.ts';
import type { PublicVoteState } from '../server/votes.ts';
import { mountVote } from './vote.ts';
import { mountAuction, renderPlatedDishes } from './auction.ts';

let roomCode: string | null = null;
let roomState: RoomState | null = null;
let draftState: PublicDraftState | null = null;
let voteState: PublicVoteState | null = null;
let voteLocked = false;
let votePending = false;
let voteError: string | null = null;
let voteEligible = false;
let playerList: HTMLUListElement | null = null;
let hostSocket: string | null = null;
/** Solo demo: this phone drives both chef seats and the table. */
let isDemo = false;
const demoBallots: Record<string, Chef> = {};
const seatSockets: Record<Chef, string | null> = { chefOne: null, chefTwo: null };
let disposeAuction: (() => void) | null = null;
let preparing = false;

/** A player is a name and a colour, never an account. */
const PLAYER_COLOURS = [
  { name: 'Orange', value: '#ff5a1f' },
  { name: 'Blue', value: '#1f5aff' },
  { name: 'Leaf', value: '#2f9e44' },
  { name: 'Plum', value: '#9c36b5' },
  { name: 'Gold', value: '#e8a400' },
  { name: 'Slate', value: '#5d6470' },
] as const;

const app = document.querySelector<HTMLElement>('#app');
const status = document.querySelector<HTMLParagraphElement>('#status');

const socket: Socket = io({ transports: ['websocket', 'polling'] });

function setStatus(text: string): void {
  if (status) status.textContent = text;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clearScreen(): HTMLElement {
  if (!app) throw new Error('no #app mount point');
  disposeAuction?.();
  disposeAuction = null;
  playerList = null;
  app.replaceChildren();
  // A new phase is a new screen. Without this, a phone scrolled down in the
  // lobby lands halfway through the auction with the ingredient off-screen.
  window.scrollTo({ top: 0, behavior: 'instant' });
  return app;
}

/* ------------------------------------------------------------------ */
/* Seat choice                                                         */
/* ------------------------------------------------------------------ */

/** Which seat this browser asks for on the home screen. Cooking by default. */
let homeSeat: PlayerRole = 'chef';

/**
 * The two ways to sit down. A host who only wants to run the room picks
 * "I'm judging" and is never silently drafted into cooking.
 */
function seatChooser(initial: PlayerRole, onPick: (seat: PlayerRole) => void): HTMLDivElement {
  const wrap = el('div', 'seat-choice');
  const options: Array<{ seat: PlayerRole; label: string; hint: string }> = [
    { seat: 'chef', label: 'I’m cooking', hint: 'You get five secret ingredients and bid on them.' },
    { seat: 'table', label: 'I’m judging', hint: 'You vote on the dishes — and can run the room.' },
  ];
  const buttons = new Map<PlayerRole, HTMLButtonElement>();
  for (const option of options) {
    const button = el('button', 'btn btn--seat', option.label);
    button.type = 'button';
    button.title = option.hint;
    button.dataset.seat = option.seat;
    button.addEventListener('click', () => {
      onPick(option.seat);
      for (const [seat, node] of buttons) {
        node.classList.toggle('btn--primary', seat === option.seat);
        node.setAttribute('aria-pressed', String(seat === option.seat));
      }
    });
    buttons.set(option.seat, button);
    wrap.appendChild(button);
  }
  const picked = buttons.get(initial);
  if (picked) {
    picked.classList.add('btn--primary');
    picked.setAttribute('aria-pressed', 'true');
  }
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

function showHome(): void {
  const root = clearScreen();

  const lede = el('p', 'pitch__lede', 'Open a room, run the whole table solo, or scan in.');
  root.appendChild(lede);
  root.appendChild(el('p', 'pitch__sub', 'Two chefs. Five secret ingredients each. One table voting on the dish they would actually eat.'));

  const demoCard = el('div', 'card card--demo');
  demoCard.appendChild(el('span', 'card__num', 'DEMO · ONE PHONE'));
  demoCard.appendChild(el('h2', undefined, 'Run the whole table yourself'));
  demoCard.appendChild(el('p', undefined, 'You are the referee, both chefs and every diner. Perfect for showing the game without asking anyone to scan in. Chef Two can auto-bid if you want a rival.'));
  const demoBtn = el('button', 'btn btn--demo', 'Start a solo demo');
  demoBtn.type = 'button';
  demoBtn.addEventListener('click', () => void createRoom(true));
  demoCard.appendChild(demoBtn);
  root.appendChild(demoCard);

  const createCard = el('div', 'card');
  createCard.appendChild(el('span', 'card__num', 'HOST'));
  createCard.appendChild(el('h2', undefined, 'Create a game'));
  createCard.appendChild(el('p', undefined, 'You get the barcode. Everyone else scans it.'));
  // Ask before the room exists: a host who only wants to run the room should
  // never be quietly seated as a chef.
  createCard.appendChild(seatChooser(homeSeat, (seat) => {
    homeSeat = seat;
  }));
  const createBtn = el('button', 'btn btn--primary', 'Create a room');
  createBtn.type = 'button';
  createBtn.addEventListener('click', () => void createRoom(false));
  createCard.appendChild(createBtn);
  root.appendChild(createCard);

  const joinCard = el('div', 'card');
  joinCard.appendChild(el('span', 'card__num', 'JOIN'));
  joinCard.appendChild(el('h2', undefined, 'Enter a code'));
  joinCard.appendChild(el('p', undefined, 'Four letters from the host’s screen.'));
  const form = el('form', 'join-form');
  const codeInput = document.createElement('input');
  codeInput.className = 'code-input';
  codeInput.maxLength = 4;
  codeInput.placeholder = 'ABCD';
  codeInput.autocomplete = 'off';
  codeInput.autocapitalize = 'characters';
  codeInput.setAttribute('aria-label', 'Room code');
  const joinBtn = el('button', 'btn btn--secondary', 'Find the room');
  joinBtn.type = 'submit';
  form.append(codeInput, joinBtn);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void findRoom(codeInput.value);
  });
  joinCard.appendChild(form);
  root.appendChild(joinCard);
}

/* ------------------------------------------------------------------ */
/* Host lobby                                                          */
/* ------------------------------------------------------------------ */

async function createRoom(demo = false): Promise<void> {
  setStatus(demo ? 'Setting a demo table…' : 'Opening a room…');
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demo }),
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    const body = (await res.json()) as { code: string; demo?: boolean };
    showHostLobby(body.code, body.demo === true);
  } catch {
    setStatus('Could not open a room — is the kitchen online?');
  }
}

async function findRoom(code: string): Promise<void> {
  const normalized = code.trim().toUpperCase();
  if (normalized.length !== 4) {
    setStatus('Codes are exactly four letters.');
    return;
  }
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(normalized)}`);
    const body = (await res.json()) as { exists: boolean };
    if (!body.exists) {
      setStatus(`No room called “${normalized}” is open.`);
      return;
    }
    showJoinForm(normalized);
  } catch {
    setStatus('Could not reach the kitchen.');
  }
}

function showHostLobby(code: string, demo = false): void {
  isDemo = demo;
  const root = clearScreen();
  root.appendChild(el('p', 'pitch__lede', demo ? 'You’re the whole table.' : 'Pass the phone around.'));

  if (demo) {
    const banner = el('div', 'demo-banner');
    banner.append(
      el('span', 'demo-banner__tag', 'SOLO DEMO'),
      el('p', undefined, 'Two chefs and three diners are already seated. You drive all of them — reveal, bid for either chef, then cast the table’s ballots. Chef Two can auto-bid for you.'),
    );
    root.appendChild(banner);
  }

  const codeCard = el('div', `card card--code${demo ? ' card--code-quiet' : ''}`);
  codeCard.appendChild(el('span', 'card__num', demo ? 'DEMO TABLE' : 'ROOM CODE'));
  codeCard.appendChild(el('p', 'room-code', code));
  root.appendChild(codeCard);

  if (!demo) {
    const qrCard = el('div', 'card card--qr');
    const canvas = document.createElement('canvas');
    canvas.className = 'qr';
    qrCard.appendChild(canvas);
    qrCard.appendChild(el('p', undefined, 'Scan to join this table.'));
    root.appendChild(qrCard);

    const joinUrl = `${window.location.origin}/?code=${code}`;
    QRCode.toCanvas(canvas, joinUrl, { width: 240, margin: 1 }, (err) => {
      if (err) setStatus('The barcode failed to draw — the code still works.');
    });
  }

  const listCard = el('div', 'card');
  listCard.appendChild(el('h2', undefined, 'At the table'));
  const list = el('ul', 'player-list');
  listCard.appendChild(list);
  root.appendChild(listCard);

  joinRoom(code, demo ? 'Director' : 'Host', PLAYER_COLOURS[0].value, demo ? 'table' : homeSeat);
  wireRoomState(code, list);
}

/* ------------------------------------------------------------------ */
/* Player lobby                                                        */
/* ------------------------------------------------------------------ */

function showJoinForm(code: string): void {
  const root = clearScreen();
  root.appendChild(el('p', 'pitch__lede', `Take a seat in ${code}.`));

  const card = el('div', 'card');
  const form = el('form', 'join-form join-form--stack');

  const nameInput = document.createElement('input');
  nameInput.className = 'name-input';
  nameInput.maxLength = 24;
  nameInput.placeholder = 'Your name';
  nameInput.autocomplete = 'off';
  nameInput.setAttribute('aria-label', 'Your name');

  const swatches = el('div', 'swatches');
  let picked: string = PLAYER_COLOURS[1].value;
  for (const colour of PLAYER_COLOURS) {
    const swatch = el('button', 'swatch', colour.name);
    swatch.type = 'button';
    swatch.style.setProperty('--swatch', colour.value);
    swatch.setAttribute('aria-label', colour.name);
    if (colour.value === picked) swatch.classList.add('swatch--picked');
    swatch.addEventListener('click', () => {
      picked = colour.value;
      swatches.querySelectorAll('.swatch').forEach((node) => node.classList.remove('swatch--picked'));
      swatch.classList.add('swatch--picked');
    });
    swatches.appendChild(swatch);
  }

  let seat: PlayerRole = 'chef';
  const seatRow = seatChooser(seat, (next) => {
    seat = next;
  });

  const joinBtn = el('button', 'btn btn--primary', 'Sit down');
  joinBtn.type = 'submit';
  form.append(nameInput, swatches, seatRow, joinBtn);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      setStatus('Pick a name to sit down.');
      return;
    }
    joinRoom(code, name, picked, seat);
  });
  card.appendChild(form);
  root.appendChild(card);
}

function showPlayerLobby(code: string): void {
  const root = clearScreen();
  root.appendChild(el('p', 'pitch__lede', 'You’re in. Waiting on the referee.'));

  const codeCard = el('div', 'card card--code');
  codeCard.appendChild(el('span', 'card__num', 'ROOM'));
  codeCard.appendChild(el('p', 'room-code room-code--small', code));
  root.appendChild(codeCard);

  const listCard = el('div', 'card');
  listCard.appendChild(el('h2', undefined, 'At the table'));
  const list = el('ul', 'player-list');
  listCard.appendChild(list);
  root.appendChild(listCard);

  wireRoomState(code, list);
}

/* ------------------------------------------------------------------ */
/* Socket wiring                                                       */
/* ------------------------------------------------------------------ */

let joined = false;

function joinRoom(code: string, name: string, colour: string, role: PlayerRole = 'chef'): void {
  joined = true;
  roomCode = code;
  const emit = (): void => {
    socket.emit('join', { code, name, colour, role });
  };
  if (socket.connected) emit();
  else socket.once('connect', emit);
}

function wireRoomState(_code: string, list: HTMLUListElement): void {
  playerList = list;
}

function myChef(): Chef | null {
  return seatSockets.chefOne === socket.id ? 'chefOne' : seatSockets.chefTwo === socket.id ? 'chefTwo' : null;
}

function showDraftError(message: string): void {
  const error = document.querySelector<HTMLElement>('#draft-error');
  if (error) {
    error.textContent = message;
    error.hidden = false;
    error.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  setStatus(message);
}

function renderAuction(newReveal = false, newAward = false): void {
  if (voteState) { renderVote(); return; }
  if (!draftState || !roomCode) return;
  document.querySelector('.stage')?.classList.add('stage--auction');
  const names = { chefOne: 'Chef One', chefTwo: 'Chef Two' };
  for (const chef of ['chefOne', 'chefTwo'] as const) {
    names[chef] = roomState?.players.find((player) => player.id === seatSockets[chef])?.name ?? names[chef];
  }
  disposeAuction = mountAuction(clearScreen(), draftState, {
    code: roomCode, chef: myChef(), names, host: hostSocket === socket.id,
    connected: socket.connected, newReveal, newAward, demo: isDemo,
    send: (event, payload) => socket.emit(event, payload),
  });
}

function renderVote(): void {
  if (!voteState || !roomCode) return;
  document.querySelector('.stage')?.classList.add('stage--auction');
  const root = clearScreen();
  // Show the finished plates above the ballot. The auction view never gets to
  // render them: the vote state lands in the same broadcast as the end of the
  // draft, so the plates would otherwise never be seen at all.
  if (draftState) {
    const names: Record<Chef, string> = { chefOne: 'Chef One', chefTwo: 'Chef Two' };
    for (const chef of ['chefOne', 'chefTwo'] as const) {
      names[chef] = roomState?.players.find((player) => player.id === seatSockets[chef])?.name ?? names[chef];
    }
    root.append(renderPlatedDishes(draftState, names));
  }
  const voters = isDemo
    ? [
        ...((roomState?.players ?? [])
          .filter((player) => player.virtual === true && player.role === 'table')
          .map((player) => ({ key: player.id, name: player.name, colour: player.colour }))),
        { key: socket.id ?? 'me', name: 'You (Director)', colour: '#ff6a2b' },
      ]
    : [];
  mountVote(root, voteState, {
    code: roomCode, host: hostSocket === socket.id, eligible: voteEligible,
    connected: socket.connected, locked: voteLocked, pending: votePending, error: voteError,
    demo: isDemo, voters, myKey: socket.id ?? '', ballots: demoBallots,
    send: (event, payload) => { votePending = true; voteError = null; socket.emit(event, payload); },
  });
}

function updateHostSetup(): void {
  if (!app || draftState || hostSocket !== socket.id) return;
  let setup = document.querySelector<HTMLElement>('#draft-setup');
  if (!setup) {
    setup = el('section', 'card draft-setup');
    setup.id = 'draft-setup';
    setup.append(
      el('h2', undefined, isDemo ? 'Set the demo table' : 'Let’s cook'),
      el('p', undefined, isDemo ? 'Both chef seats are yours. Pick a menu and deal ten secret ingredients.' : 'Two chefs. Ten secret ingredients. Choose your menu.'),
    );
    const label = el('label', 'setup-label', 'Menu');
    const menu = el('select', 'menu-select');
    menu.id = 'draft-menu';
    menu.name = 'deckId';
    menu.autocomplete = 'off';
    for (const [value, name] of [['pizza', 'Pizza'], ['bowls', 'Bowls'], ['tacos', 'Tacos'], ['indian', 'Indian'], ['chaos', 'Chaos Mix']]) {
      const option = el('option', undefined, name);
      option.value = value!;
      menu.append(option);
    }
    label.append(menu);
    // Or write your own menu: the kitchen takes any dish or cuisine by name.
    const customLabel = el('label', 'setup-label', '…or name your own');
    const custom = el('input', 'menu-input');
    custom.id = 'draft-custom';
    custom.name = 'customDish';
    custom.type = 'text';
    custom.autocomplete = 'off';
    custom.maxLength = 80;
    custom.placeholder = 'Any dish or cuisine — Thai street food, Ottoman brunch, Neapolitan pizza…';
    customLabel.append(custom);
    const dietary = el('label', 'dietary-toggle');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'draft-vegetarian';
    checkbox.name = 'vegetarianOnly';
    dietary.append(checkbox, el('span', undefined, 'Vegetarian only'));
    const error = el('p', 'draft-error');
    error.id = 'draft-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const start = el('button', 'btn btn--primary', isDemo ? 'Start the demo' : 'Start draft');
    start.type = 'button';
    start.id = 'draft-start';
    start.addEventListener('click', () => void prepareDraft());
    setup.append(label, customLabel, dietary, error, start);
    app.append(setup);
  }
  const button = setup.querySelector<HTMLButtonElement>('#draft-start');
  if (button) button.disabled = preparing || !socket.connected || roomState?.players.filter((player) => player.role === 'chef').length !== 2;
}

async function prepareDraft(): Promise<void> {
  if (preparing || !roomCode || !socket.connected || hostSocket !== socket.id) return;
  const code = roomCode;
  const deckId = document.querySelector<HTMLSelectElement>('#draft-menu')?.value;
  const vegetarianOnly = document.querySelector<HTMLInputElement>('#draft-vegetarian')?.checked ?? false;
  // A named dish wins over the preset menu: two characters is enough to mean
  // something, one is probably a typo.
  const customDish = document.querySelector<HTMLInputElement>('#draft-custom')?.value.trim() ?? '';
  const useCustom = customDish.length >= 2;
  preparing = true;
  let startSent = false;
  updateHostSetup();
  setStatus('Preparing secret ingredients…');
  try {
    // The receipt contains no hands. Starting is still host-authorized by socket.
    // The kitchen takes either a preset deck or a dish named on the spot; the
    // server rejects a customDish it cannot cook, and that error surfaces here.
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/hands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(useCustom ? { customDish, vegetarianOnly } : { deckId, vegetarianOnly }),
    });
    const receipt = await res.json() as { ok?: boolean; message?: string };
    if (!res.ok || receipt.ok !== true) throw new Error(receipt.message ?? 'Could not prepare the draft. Try again.');
    if (!socket.connected) throw new Error('Connection lost. Reopen the room before starting.');
    socket.emit('draft:start', { code });
    startSent = true;
  } catch (error) {
    showDraftError(error instanceof Error ? error.message : 'Could not prepare the draft. Try again.');
  } finally {
    if (!startSent) preparing = false;
    updateHostSetup();
  }
}

socket.on('room:state', (state: RoomState) => {
  if (state.code !== roomCode) return;
  const firstSnapshot = roomState === null;
  roomState = state;
  if (typeof state.demo === 'boolean') isDemo = state.demo;
  // The server owns the host seat; reading it beats inferring it from join order.
  if (state.hostId) hostSocket = state.hostId;
  const chefs = state.players.filter((player) => player.role === 'chef');
  // room:state has no seat IDs. Track stable seats from the initial lobby,
  // then fill only vacated seats; never renumber the surviving chef.
  if (firstSnapshot) {
    seatSockets.chefOne = chefs[0]?.id ?? null;
    seatSockets.chefTwo = chefs[1]?.id ?? null;
  } else {
    for (const chef of ['chefOne', 'chefTwo'] as const) {
      if (!chefs.some((player) => player.id === seatSockets[chef])) seatSockets[chef] = null;
    }
    for (const player of chefs) {
      if (Object.values(seatSockets).includes(player.id)) continue;
      if (seatSockets.chefOne === null) seatSockets.chefOne = player.id;
      else if (seatSockets.chefTwo === null) seatSockets.chefTwo = player.id;
    }
  }
  if (!playerList && !draftState && hostSocket !== socket.id) showPlayerLobby(state.code);
  playerList?.replaceChildren(...state.players.map((player) => {
    const row = el('li', `player-list__row${player.virtual ? ' player-list__row--virtual' : ''}`);
    const dot = el('span', 'player-list__dot');
    dot.style.backgroundColor = player.colour;
    // Say the seat in the table's own language: COOKING or JUDGING, never the
    // internal role name — a host who chose to judge should recognise himself.
    const role = player.virtual ? (player.role === 'chef' ? 'DEMO CHEF' : 'DEMO DINER') : player.role === 'chef' ? 'COOKING' : 'JUDGING';
    row.append(dot, el('span', 'player-list__name', player.name), el('span', 'player-list__role', role));
    return row;
  }));
  setStatus(`Room ${state.code} · ${state.players.filter((p) => !p.virtual).length} on this phone · ${state.players.length} seated.`);
  if (draftState) renderAuction();
  else updateHostSetup();
});

socket.on('draft:state', (state: PublicDraftState) => {
  preparing = false;
  const previous = draftState;
  draftState = state;
  setStatus(`Room ${roomCode} · Round ${state.round} · ${state.phase === 'auction' ? 'Bidding is live.' : state.phase === 'reveal' ? 'Next reveal ready.' : 'Dishes on the table.'}`);
  const item = state.auction?.item ?? state.lastAward?.item;
  const oldItem = previous?.auction?.item ?? previous?.lastAward?.item;
  renderAuction(item?.slot !== oldItem?.slot, state.lastAward?.item.slot !== previous?.lastAward?.item.slot);
});

socket.on('vote:state', (state: PublicVoteState) => {
  // Freeze eligibility at opening, matching the server's private seat snapshot.
  if (!voteState || voteState.tally.phase === 'waiting') {
    const self = roomState?.players.find(player => player.id === socket.id);
    const tableExists = roomState?.players.some(player => player.role === 'table');
    voteEligible = !!self && (tableExists ? self.role === 'table' : self.role === 'chef');
  }
  voteState = state;
  votePending = false;
  voteError = null;
  renderVote();
  setStatus(`Room ${roomCode} · ${state.tally.phase === 'closed' ? 'The table has decided.' : 'Anonymous best-dish vote.'}`);
});

socket.on('vote:accepted', () => {
  voteLocked = true; votePending = false; voteError = null; renderVote();
});
socket.on('vote:error', (error: VoteErrorPayload) => {
  votePending = false; voteError = error.message;
  if (error.code === 'already-voted') voteLocked = true;
  renderVote(); setStatus(error.message);
});

socket.on('draft:error', (error: DraftErrorPayload) => {
  preparing = false;
  if (draftState) renderAuction(); // Release request lock without changing the public state.
  else updateHostSetup();
  showDraftError(error.message);
});

socket.on('join:error', (error: { reason: string }) => {
  setStatus(error.reason);
  joined = false;
});

socket.on('disconnect', () => {
  if (draftState) renderAuction();
  else updateHostSetup();
  setStatus('Connection lost. Reopen the room to take a new seat; host reconnection is not supported yet.');
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const params = new URLSearchParams(window.location.search);
const scannedCode = params.get('code')?.trim().toUpperCase();

if (scannedCode && scannedCode.length === 4) {
  // A scanned barcode skips the code form and goes straight to a seat.
  void findRoom(scannedCode);
} else {
  showHome();
}

socket.on('connect', () => {
  if (!joined) setStatus('Kitchen online — realtime channel up.');
});
socket.on('connect_error', () => {
  setStatus('Kitchen online — realtime channel down.');
});
