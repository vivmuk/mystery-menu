import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express, { type Express } from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the built PWA lives. In development the client is built by `npm run dev`
 * into the same folder, so there is exactly one code path in every environment.
 */
export function clientDir(): string {
  return process.env.CLIENT_DIR ?? path.resolve(here, '..', 'dist', 'client');
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mystery-menu', ts: new Date().toISOString() });
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
