import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createGameServer } from '../server/server.ts';
import type { HelloPayload } from '../server/server.ts';

let http: ReturnType<typeof createGameServer>['http'];
let io: ReturnType<typeof createGameServer>['io'];
let base: string;
const clients: Socket[] = [];

beforeAll(async () => {
  const server = createGameServer();
  http = server.http;
  io = server.io;
  http.listen(0, '127.0.0.1');
  await new Promise((resolve) => http.once('listening', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const client of clients) client.close();
  io.close();
  await new Promise((resolve) => http.close(resolve));
});

function connect(): Promise<{ client: Socket; hello: HelloPayload }> {
  return new Promise((resolve, reject) => {
    const client = ioClient(base, { transports: ['websocket'], reconnection: false });
    clients.push(client);
    const timer = setTimeout(() => reject(new Error('no hello within 5000ms')), 5000);
    client.on('hello', (payload: HelloPayload) => {
      clearTimeout(timer);
      resolve({ client, hello: payload });
    });
    client.on('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('realtime channel', () => {
  it('greets a client over a real socket connection', async () => {
    const { hello } = await connect();
    expect(hello.service).toBe('mystery-menu');
    expect(hello.socketId).toBeTruthy();
  });

  it('gives every client its own socket id', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);
    expect(first.hello.socketId).not.toBe(second.hello.socketId);
  });
});
