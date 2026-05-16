import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';

import { config } from './config';
import { morganStream } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import routes from './routes';

export function createApp(): express.Application {
  const app = express();

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
  app.use(cors({ origin: true, credentials: true, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','x-club-id','x-seed-secret'] }));
  app.options('*', cors());
  app.use(compression());
  app.use(morgan(config.isDev ? 'dev' : 'combined', { stream: morganStream }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(rateLimit({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests' } }));
  app.set('trust proxy', 1);

  // ── Vision inference webhook payloads (player tracks + events) ─────────
  // Must be declared BEFORE the global express.json() and BEFORE the /api/v1 mount.
  app.use('/api/v1/vision/webhooks/inference', express.json({ limit: '32mb' }));

  // Serve static files from /public (works both locally and on Render)
  const publicPaths = [
    path.join(process.cwd(), 'public'),
    path.join(__dirname, '..', 'public'),
    path.join(__dirname, 'public'),
  ];

  for (const p of publicPaths) {
    if (fs.existsSync(p)) {
      app.use(express.static(p));
      break;
    }
  }

  // ── White-label asset uploads (LOCAL storage backend) ──────────────────
  if ((process.env.WL_ASSETS_BACKEND ?? 'LOCAL') === 'LOCAL') {
    const uploadsDir = process.env.WL_ASSETS_DIR ?? path.resolve(process.cwd(), 'uploads');
    if (fs.existsSync(uploadsDir)) {
      app.use('/uploads', express.static(uploadsDir, {
        maxAge: '1y',
        immutable: true,
        index: false,
        dotfiles: 'deny',
        setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
      }));
    }
  }

  // API routes
  app.use(`/api/${config.apiVersion}`, routes);

  // Serve index.html for root
  app.get('/', (_req, res) => {
    const indexPaths = [
      path.join(process.cwd(), 'public', 'index.html'),
      path.join(__dirname, '..', 'public', 'index.html'),
      path.join(__dirname, 'public', 'index.html'),
    ];

    for (const p of indexPaths) {
      if (fs.existsSync(p)) {
        return res.sendFile(p);
      }
    }

    // Fallback if no HTML file found
    res.json({
      name: 'Familista Football Intelligence Platform',
      version: '5.0',
      api: `/api/${config.apiVersion}`,
      health: `/api/${config.apiVersion}/health`,
      note: 'Frontend not deployed yet. Upload public/index.html to GitHub.',
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
