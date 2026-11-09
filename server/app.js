import { rateLimitStore } from './rate-limits.js';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { installAuth } from './auth.js';
import { installPhotos } from './photos.js';
import { installTrips } from './trips.js';
import { installAdmin } from './admin.js';

export async function createApp(options = {}) {
  const app = express(),
    store = options.store || (await openStore(options.dataDir));
  app.locals.store = store;
  app.locals.db = store.db;
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', options.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'", ...(process.env.R2_ENDPOINT ? [process.env.R2_ENDPOINT] : [])],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: options.secureCookies ? [] : null,
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.get('/manifest.webmanifest', async (req, res) => {
    const settings = await store.getSettings();
    res
      .set('Cache-Control', 'no-cache')
      .type('application/manifest+json')
      .json({
        name: settings.appName,
        short_name: settings.organizationName.slice(0, 20) + ' Fleet',
        description: 'Private staff vehicle checkout and return',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f6f7f3',
        theme_color: settings.accentColor,
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      });
  });
  app.get('/api/health', async (req, res) =>
    res
      .set('Cache-Control', 'no-store')
      .json({ ok: (await store.db.prepare('SELECT 1 AS healthy').get()).healthy === 1 }),
  );
  await installAuth(app, store, options);
  app.use(
    '/api/photos',
    rateLimit({
      store: rateLimitStore(store.db, 'photos'),
      windowMs: 5 * 60000,
      limit: store.evidence.cloud ? 200 : 100,
      skip: (req) =>
        ['GET', 'HEAD'].includes(req.method) ||
        (!store.evidence.cloud && req.path === '/upload-ticket'),
      keyGenerator: (req) => req.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Photo request limit reached. Wait a few minutes and retry.' },
    }),
  );
  installPhotos(app, store);
  installTrips(app, store, options);
  installAdmin(app, store, options);
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
  const dist = options.distDir || fileURLToPath(new URL('../dist', import.meta.url));
  if (existsSync(dist)) {
    app.get('/support', (req, res) =>
      res.set('Cache-Control', 'no-cache').sendFile(path.join(dist, 'support.html')),
    );
    app.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, file) => {
          if (file.endsWith('sw.js') || file.endsWith('index.html'))
            res.setHeader('Cache-Control', 'no-cache');
          else if (file.includes(`${path.sep}assets${path.sep}`))
            res.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
        },
      }),
    );
    app.get('/{*path}', (req, res) =>
      res.set('Cache-Control', 'no-cache').sendFile(path.join(dist, 'index.html')),
    );
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 400,
      message = error.message || 'Request failed.';
    if (error.code === 'LIMIT_FILE_SIZE') {
      status = 413;
      message = 'Photo must be no larger than 12 MB. Retake or export a smaller image.';
    } else if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
      status = 409;
      message =
        'This record conflicts with an existing account or checkout. Refresh and try again.';
    } else if (
      error.code?.startsWith('SQLITE') ||
      (!error.status && !error.name?.includes('Multer'))
    ) {
      status = 500;
      message =
        'The server could not complete this request. Your signed records remain saved; please retry or contact an administrator.';
      console.error(error);
    }
    res.status(status).json({ error: message });
  });
  return app;
}
