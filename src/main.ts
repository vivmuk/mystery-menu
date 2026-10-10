import { io } from 'socket.io-client';

const status = document.querySelector<HTMLParagraphElement>('#status');

async function checkHealth(): Promise<void> {
  if (!status) return;
  try {
    const res = await fetch('/healthz');
    const body: unknown = await res.json();
    const ok = typeof body === 'object' && body !== null && (body as { ok?: boolean }).ok === true;
    status.textContent = ok ? 'Kitchen online.' : 'Kitchen responded oddly.';
  } catch {
    status.textContent = 'Kitchen unreachable.';
  }
}

void checkHealth();

// Proves the realtime channel is alive before any room logic exists.
const socket = io({ transports: ['websocket', 'polling'] });
socket.on('hello', () => {
  if (status) status.textContent = 'Kitchen online — realtime channel up.';
});
socket.on('connect_error', () => {
  if (status) status.textContent = 'Kitchen online — realtime channel down.';
});
