import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { RoomRegistry } from '../server/rooms.ts';
import {
  createVeniceClient,
  veniceConfig,
  VeniceConfigError,
  VeniceError,
  VeniceTimeoutError,
  type VeniceClient,
  type VeniceFetch,
} from '../server/venice/client.ts';

/** A key that exists only to prove it never leaks. Never a real credential. */
const SENTINEL_KEY = 'sk-test-DO-NOT-LEAK';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, VENICE_API_KEY: SENTINEL_KEY };
  // This suite asserts the documented defaults, so ambient overrides must not leak
  // in: Railway sets VENICE_TEXT_MODEL as a service variable, which made these
  // tests pass locally and fail in the build.
  delete process.env.VENICE_TEXT_MODEL;
  delete process.env.VENICE_IMAGE_MODEL;
  delete process.env.VENICE_TTS_MODEL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

/** A Response carrying a JSON body, shaped like a real fetch answer. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every thrown or returned value is scrubbed for the sentinel key. */
function expectNoLeak(value: unknown): void {
  const seen: unknown[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      expect(v).not.toContain(SENTINEL_KEY);
      return;
    }
    if (v instanceof Uint8Array) {
      expect(Buffer.from(v).toString('utf8')).not.toContain(SENTINEL_KEY);
      return;
    }
    if (typeof v === 'object' && v !== null && !seen.includes(v)) {
      seen.push(v);
      for (const nested of Object.values(v)) walk(nested);
    }
  };
  walk(value);
}

async function expectRejectsNoLeak(promise: Promise<unknown>): Promise<unknown> {
  const err = await promise.then(
    () => {
      throw new Error('expected the call to reject, but it resolved');
    },
    (caught: unknown) => caught,
  );
  expectNoLeak(err);
  return err;
}

describe('veniceConfig', () => {
  it('resolves working defaults when no model env vars are set', () => {
    delete process.env.VENICE_TEXT_MODEL;
    delete process.env.VENICE_IMAGE_MODEL;
    delete process.env.VENICE_TTS_MODEL;
    const config = veniceConfig();
    expect(config.textModel).toBe('z-ai-glm-5-3-flash');
    expect(config.imageModel).toBe('venice-sd35');
    expect(config.ttsModel).toBe('tts-elevenlabs-turbo-v2-5');
  });

  it('honours model overrides from the environment', () => {
    process.env.VENICE_TEXT_MODEL = 'text-override';
    process.env.VENICE_IMAGE_MODEL = 'image-override';
    process.env.VENICE_TTS_MODEL = 'tts-override';
    const config = veniceConfig();
    expect(config.textModel).toBe('text-override');
    expect(config.imageModel).toBe('image-override');
    expect(config.ttsModel).toBe('tts-override');
  });
});

describe('Venice client capabilities (mocked fetch)', () => {
  it('sends the key only in the authorization header and parses a text completion', async () => {
    const fetchMock = vi.fn<VeniceFetch>(async () =>
      jsonResponse({
        id: 'chatcmpl-1',
        model: 'z-ai-glm-5-3-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'five secret ingredients' } }],
      }),
    );
    const client = createVeniceClient(fetchMock);

    const result = await client.chat([{ role: 'user', content: 'list ingredients' }]);

    expect(result.content).toBe('five secret ingredients');
    expect(result.model).toBe('z-ai-glm-5-3-flash');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.venice.ai/api/v1/chat/completions');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${SENTINEL_KEY}`);
    expectNoLeak(result);
  });

  it('parses base64 images from the image endpoint', async () => {
    const fetchMock = vi.fn<VeniceFetch>(async () =>
      jsonResponse({ images: ['aW5ncmVkaWVudA=='], id: 'gen-1' }),
    );
    const client = createVeniceClient(fetchMock);

    const result = await client.generateImage('a single anchovy, low-poly');

    expect(result.images).toEqual(['aW5ncmVkaWVudA==']);
    expect(result.model).toBe('venice-sd35');
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.venice.ai/api/v1/image/generate');
    expectNoLeak(result);
  });

  it('returns binary audio from the speech endpoint', async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn<VeniceFetch>(
      async () =>
        new Response(pcm, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );
    const client = createVeniceClient(fetchMock);

    const result = await client.synthesizeSpeech('Ladies and gentlemen, the twist.');

    expect(Array.from(result.audio)).toEqual([1, 2, 3, 4]);
    expect(result.contentType).toBe('audio/mpeg');
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.venice.ai/api/v1/audio/speech');
    expectNoLeak(result);
  });

  it('throws a typed config error, without the key, when VENICE_API_KEY is missing', async () => {
    delete process.env.VENICE_API_KEY;
    const fetchMock = vi.fn<VeniceFetch>();
    const client = createVeniceClient(fetchMock);

    const err = (await expectRejectsNoLeak(
      client.chat([{ role: 'user', content: 'hi' }]),
    )) as VeniceConfigError;

    expect(err).toBeInstanceOf(VeniceConfigError);
    expect(err).toBeInstanceOf(VeniceError);
    expect(err.message).toContain('VENICE_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts with a VeniceTimeoutError when the call outlives its timeout', async () => {
    const fetchMock = vi.fn<VeniceFetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('TimeoutError'));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('TimeoutError'));
          });
        }),
    );
    const client = createVeniceClient(fetchMock);

    const err = (await expectRejectsNoLeak(
      client.chat([{ role: 'user', content: 'hi' }], { timeoutMs: 25, maxRetries: 0 }),
    )) as VeniceTimeoutError;

    expect(err).toBeInstanceOf(VeniceTimeoutError);
    expect(err.message).toContain('25ms');
  });

  it('retries a 500 and then succeeds, with one call per attempt', async () => {
    const fetchMock = vi
      .fn<VeniceFetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: 'recovered' } }] }),
      );
    const client = createVeniceClient(fetchMock);
    const sleep = vi.fn(async (_ms: number) => {});

    const result = await client.chat([{ role: 'user', content: 'hi' }], { sleep });

    expect(result.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('exhausts the retry budget on persistent 429s and throws the status', async () => {
    const fetchMock = vi.fn<VeniceFetch>(async () => jsonResponse({ error: 'slow down' }, 429));
    const client = createVeniceClient(fetchMock);
    const sleep = vi.fn(async (_ms: number) => {});

    const err = (await expectRejectsNoLeak(
      client.chat([{ role: 'user', content: 'hi' }], { sleep }),
    )) as VeniceError;

    expect(err).toBeInstanceOf(VeniceError);
    expect(err.status).toBe(429);
    // 1 initial attempt + 2 retries by default.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Exponential backoff: 500ms, then 1000ms.
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000]);
  });

  it('never retries a 400 — a malformed request stays malformed', async () => {
    const fetchMock = vi.fn<VeniceFetch>(async () => jsonResponse({ error: 'bad request' }, 400));
    const client = createVeniceClient(fetchMock);

    const err = (await expectRejectsNoLeak(
      client.chat([{ role: 'user', content: 'hi' }]),
    )) as VeniceError;

    expect(err).toBeInstanceOf(VeniceError);
    expect(err.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a transport failure as retryable, then surfaces a typed error', async () => {
    const fetchMock = vi.fn<VeniceFetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createVeniceClient(fetchMock);
    const sleep = vi.fn(async (_ms: number) => {});

    const err = (await expectRejectsNoLeak(
      client.generateImage('an anchovy', { sleep }),
    )) as VeniceError;

    expect(err).toBeInstanceOf(VeniceError);
    expect(err.capability).toBe('image');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('/api/venice/health', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  });

  async function listenWith(client: VeniceClient): Promise<string> {
    server = createApp(new RoomRegistry(), client).listen(0, '127.0.0.1');
    await new Promise((resolve) => server?.once('listening', resolve));
    const address = server?.address();
    if (!address || typeof address === 'string') throw new Error('no port assigned');
    return `http://127.0.0.1:${address.port}`;
  }

  function fakeClient(health: VeniceClient['health']): VeniceClient {
    return {
      chat: vi.fn(),
      generateImage: vi.fn(),
      synthesizeSpeech: vi.fn(),
      health,
    };
  }

  it('reports ok with the resolved models when Venice answers', async () => {
    const base = await listenWith(
      fakeClient(async () => ({
        ok: true,
        reachable: true,
        configured: true,
        textModel: 'text-x',
        imageModel: 'image-x',
        ttsModel: 'tts-x',
      })),
    );

    const res = await fetch(`${base}/api/venice/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      reachable: true,
      textModel: 'z-ai-glm-5-3-flash',
      imageModel: 'venice-sd35',
      ttsModel: 'tts-elevenlabs-turbo-v2-5',
    });
    expectNoLeak(body);
  });

  it('returns 503, not 500, when Venice is unreachable', async () => {
    const base = await listenWith(
      fakeClient(async () => ({
        ok: false,
        reachable: false,
        configured: true,
        textModel: 'text-x',
        imageModel: 'image-x',
        ttsModel: 'tts-x',
      })),
    );

    const res = await fetch(`${base}/api/venice/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.reachable).toBe(false);
    expectNoLeak(body);
  });

  it('returns 503 when the key is missing, without naming a value', async () => {
    delete process.env.VENICE_API_KEY;
    const fetchMock = vi.fn<VeniceFetch>();
    const base = await listenWith(createVeniceClient(fetchMock));

    const res = await fetch(`${base}/api/venice/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.reachable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoLeak(body);
  });

  it('returns 503 even if the injected client throws unexpectedly', async () => {
    const base = await listenWith(
      fakeClient(async () => {
        throw new Error('something very strange');
      }),
    );

    const res = await fetch(`${base}/api/venice/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expectNoLeak(body);
  });
});

describe('VeniceClient.health', () => {
  it('makes exactly one cheap text call when reachable', async () => {
    const fetchMock = vi.fn<VeniceFetch>(async () =>
      jsonResponse({ choices: [{ message: { content: 'pong' } }] }),
    );
    const client = createVeniceClient(fetchMock);

    const result = await client.health();

    expect(result.ok).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.configured).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { max_tokens: number; messages: unknown[] };
    expect(body.max_tokens).toBe(1);
    expectNoLeak(result);
  });

  it('reports unreachable without leaking anything when the call fails', async () => {
    const fetchMock = vi.fn<VeniceFetch>(async () => jsonResponse({ error: 'down' }, 503));
    const client = createVeniceClient(fetchMock);

    const result = await client.health();

    expect(result.ok).toBe(false);
    expect(result.reachable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoLeak(result);
  });
});
