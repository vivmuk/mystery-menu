import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('health endpoint', () => {
  it('reports the service as ok', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('mystery-menu');
  });

  it('never reports the service as ok when the path is wrong', async () => {
    const res = await fetch(`${base}/healthz-nope`);
    expect(res.status).not.toBe(200);
  });
});
