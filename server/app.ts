import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express, { type Express } from 'express';
import { RoomRegistry } from './rooms.ts';
import { GameSessions } from './game.ts';
import { DraftError } from './draft/engine.ts';
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
  games: GameSessions = new GameSessions(registry),
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mystery-menu', ts: new Date().toISOString() });
  });

  /**
   * Is Venice usable right now? Probes the transport, then checks the configured
   * model ids against what Venice advertises. Returns 503 when the key is missing
   * or Venice is unreachable — the service is degraded, not the request malformed.
   * The key never leaves this process.
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
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.missingModels && result.missingModels.length > 0
          ? { missingModels: result.missingModels }
          : {}),
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

  app.post('/api/rooms', (req, res) => {
    const body: unknown = req.body;
    const demo = !!body && typeof body === 'object' && !Array.isArray(body) && (body as { demo?: unknown }).demo === true;
    const room = registry.create(demo);
    res.status(201).json({ code: room.code, demo: room.demo === true, players: room.players.length });
  });

  app.post('/api/rooms/:code/hands', async (req, res) => {
    const room = registry.get(req.params.code ?? '');
    if (!room) {
      res.status(404).json({ ok: false, code: 'wrong-phase', message: 'This room is not open.' });
      return;
    }
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ ok: false, code: 'invalid-action', message: 'Supply a deckId or a customDish, plus an optional vegetarianOnly boolean.' });
      return;
    }
    const { deckId, customDish, vegetarianOnly = false } = body as { deckId?: unknown; customDish?: unknown; vegetarianOnly?: unknown };
    if (typeof vegetarianOnly !== 'boolean') {
      res.status(400).json({ ok: false, code: 'invalid-action', message: 'Supply a deckId or a customDish, plus an optional vegetarianOnly boolean.' });
      return;
    }
    // Two doors: a preset deck id, or a host-typed dish. Exactly one may open.
    if (typeof deckId === 'string' && deckId.length > 0) {
      if (customDish !== undefined) {
        res.status(400).json({ ok: false, code: 'invalid-action', message: 'Offer a deckId or a customDish, not both.' });
        return;
      }
      try {
        res.json(await games.generate(room.code, deckId, vegetarianOnly, venice));
      } catch (error) {
        // Never echo generator errors: their messages can include dealt content.
        if (error instanceof DraftError) {
          res.status(error.code === 'invalid-action' ? 400 : 409).json({ ok: false, code: error.code, message: error.message });
        } else {
          res.status(503).json({ ok: false, code: 'invalid-hands', message: 'Could not prepare hands. Try again.' });
        }
      }
      return;
    }
    if (typeof customDish !== 'string' || customDish.trim().length < 2 || customDish.trim().length > 80) {
      res.status(400).json({ ok: false, code: 'invalid-action', message: 'A dish or cuisine is 2–80 characters.' });
      return;
    }
    try {
      res.json(await games.generateCustom(room.code, customDish.trim(), vegetarianOnly, venice));
    } catch (error) {
      // Never echo generator errors: their messages can include dealt content.
      if (error instanceof DraftError) {
        res.status(error.code === 'invalid-action' ? 400 : 409).json({ ok: false, code: error.code, message: error.message });
      } else {
        res.status(503).json({ ok: false, code: 'invalid-hands', message: 'Could not prepare hands. Try again.' });
      }
    }
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
