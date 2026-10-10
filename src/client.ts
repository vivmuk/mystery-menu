import QRCode from 'qrcode';
import { io, type Socket } from 'socket.io-client';

/** Mirrors server/rooms.ts — the payload everyone in a room receives. */
interface RoomPlayer {
  id: string;
  name: string;
  colour: string;
  role: 'chef' | 'table';
}

interface RoomState {
  code: string;
  capacity: number;
  players: RoomPlayer[];
}

type ScreenName = 'home' | 'host' | 'lobby';

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
  app.replaceChildren();
  return app;
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

function showHome(): void {
  const root = clearScreen();

  const lede = el('p', 'pitch__lede', 'Open a room, pass the phone, or scan in.');
  root.appendChild(lede);

  const createCard = el('div', 'card');
  createCard.appendChild(el('span', 'card__num', 'HOST'));
  createCard.appendChild(el('h2', undefined, 'Create a game'));
  createCard.appendChild(el('p', undefined, 'You get the barcode. Everyone else scans it.'));
  const createBtn = el('button', 'btn btn--primary', 'Create a room');
  createBtn.type = 'button';
  createBtn.addEventListener('click', () => void createRoom());
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

async function createRoom(): Promise<void> {
  setStatus('Opening a room…');
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    const body = (await res.json()) as { code: string };
    showHostLobby(body.code);
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

function showHostLobby(code: string): void {
  const root = clearScreen();
  root.appendChild(el('p', 'pitch__lede', 'Pass the phone around.'));

  const codeCard = el('div', 'card card--code');
  codeCard.appendChild(el('span', 'card__num', 'ROOM CODE'));
  codeCard.appendChild(el('p', 'room-code', code));
  root.appendChild(codeCard);

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

  const listCard = el('div', 'card');
  listCard.appendChild(el('h2', undefined, 'At the table'));
  const list = el('ul', 'player-list');
  listCard.appendChild(list);
  root.appendChild(listCard);

  joinRoom(code, 'Host', PLAYER_COLOURS[0].value);
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

  const joinBtn = el('button', 'btn btn--primary', 'Sit down');
  joinBtn.type = 'submit';
  form.append(nameInput, swatches, joinBtn);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      setStatus('Pick a name to sit down.');
      return;
    }
    joinRoom(code, name, picked);
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

function joinRoom(code: string, name: string, colour: string): void {
  joined = true;
  const emit = (): void => {
    socket.emit('join', { code, name, colour });
  };
  if (socket.connected) emit();
  else socket.once('connect', emit);
}

function wireRoomState(code: string, list: HTMLUListElement): void {
  socket.on('room:state', (state: RoomState) => {
    if (state.code !== code) return;
    list.replaceChildren(
      ...state.players.map((player) => {
        const row = el('li', 'player-list__row');
        const dot = el('span', 'player-list__dot');
        dot.style.backgroundColor = player.colour;
        row.appendChild(dot);
        row.appendChild(el('span', 'player-list__name', player.name));
        row.appendChild(el('span', 'player-list__role', player.role === 'chef' ? 'chef' : 'table'));
        return row;
      }),
    );
    const seatCount = `${state.players.length}/${state.capacity} seated`;
    setStatus(joined ? `Room ${code} — ${seatCount}.` : seatCount);
  });

  socket.on('join:error', (error: { reason: string }) => {
    setStatus(error.reason);
    joined = false;
  });
}

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
