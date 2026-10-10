import './client.ts';

const status = document.querySelector<HTMLParagraphElement>('#status');

// A one-shot probe so a cold page still reports when the kitchen is down,
// before any socket traffic lands.
async function checkHealth(): Promise<void> {
  if (!status) return;
  try {
    const res = await fetch('/healthz');
    const body: unknown = await res.json();
    const ok = typeof body === 'object' && body !== null && (body as { ok?: boolean }).ok === true;
    if (!ok) status.textContent = 'Kitchen responded oddly.';
  } catch {
    status.textContent = 'Kitchen unreachable.';
  }
}

void checkHealth();
