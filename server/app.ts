import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express, { type Express } from 'express';
import { RoomRegistry } from './rooms.ts';
import { createVeniceClient, veniceConfig, type VeniceClient } from './venice/client.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the built PWA lives. In development the client is built by `npm run dev`
 * into the same folder, so there is exactly one code path in every environment.
 */
export function clientDir(): string {
  return process.env.CLIENT_DIR ?? path.resolve(here, '..', 'dist', 'client');
}

export function createApp(
  registry: RoomRegistry = new RoomRegistry(),
  venice: VeniceClient = createVeniceClient(),
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mystery-menu', ts: new Date().toISOString() });
  });

  /**
   * Is Venice usable right now? One cheap text call answers it. Returns 503
   * when the key is missing or Venice is unreachable — the service is
   * degraded, not the request malformed. The key never leaves this process.
   */
  app.get('/api/venice/health', async (_req, res) => {
    const config = veniceConfig();
    try {
      const result = await venice.health();
      const status = result.ok ? 200 : 503;
      res.status(status).json({
        ok: result.ok,
        textModel: config.textModel,
        imageModel: config.imageModel,
        ttsModel: config.ttsModel,
        reachable: result.reachable,
      });
    } catch {
      // A health probe must never 500 — an unexpected client error still
      // means "Venice is not usable", which is a 503.
      res.status(503).json({
        ok: false,
        textModel: config.textModel,
        imageModel: config.imageModel,
        ttsModel: config.ttsModel,
        reachable: false,
      });
    }
  });

  app.post('/api/rooms', (_req, res) => {
    const room = registry.create();
    res.status(201).json({ code: room.code });
  });

  app.get('/api/rooms/:code', (req, res) => {
    const room = registry.get(req.params.code ?? '');
    if (!room) {
      res.json({ exists: false });
      return;
    }
    res.json({ exists: true, players: room.players.length, capacity: registry.state(room).capacity });
  });

  const dir = clientDir();
  if (existsSync(dir)) {
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    // SPA fallback: only for browser navigations, never for the API, the socket
    // transport, or anything health-related — a probe for a typo'd health path
    // must 404, not receive an HTML page with a 200.
    app.get(/^\/(?!api\/|socket\.io\/|healthz).*/, (req, res) => {
      if (!req.accepts('html')) {
        res.status(404).type('text/plain').send('Not found');
        return;
      }
      res.sendFile(path.join(dir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.status(503).type('text/plain').send('Mystery Menu: client bundle not built yet. Run `npm run build`.');
    });
  }

  return app;
}
