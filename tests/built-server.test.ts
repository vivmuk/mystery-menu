import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'dist', 'server.js');
const port = 4321;
const base = `http://127.0.0.1:${port}`;

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

async function waitForHealth(deadlineMs = 15_000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// Runs only when a build exists, so `npm test` stays useful before `npm run build`.
describe.skipIf(!existsSync(bundle))('built bundle', () => {
  it('boots dist/server.js and answers /healthz', async () => {
    child = spawn(process.execPath, ['dist/server.js'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
      stdio: 'ignore',
    });

    expect(await waitForHealth()).toBe(true);

    const body = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  }, 25_000);
});
