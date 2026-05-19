import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { config } from './config';
import { morganStream } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import routes from './routes';

export function createApp(): express.Application {
  const app = express();

  // ── Security headers
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // ── CORS
  // Multi-origin allowlist so the SPA can sit on its own Render host
  // while still reaching the backend. The single-string config.cors.origin
  // could only allow ONE host; that's why every other origin saw
  // "Failed to fetch" in the browser console. Comma-separated overrides
  // via FRONTEND_URL still work.
  const corsAllowlist = new Set<string>([
    'https://familista-v5.onrender.com',
    'https://familista-backend.onrender.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    ...((config.cors.origin || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)),
  ]);

  app.use(
    cors({
      origin: (origin, callback) => {
        // No-Origin requests (curl, Postman, server-to-server) — allow.
        if (!origin) return callback(null, true);
        if (corsAllowlist.has(origin)) return callback(null, origin);
        return callback(new Error(`CORS: origin ${origin} not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-club-id'],
    })
  );

  // ── Compression
  app.use(compression());

  // ── Request logging
  app.use(morgan(config.isDev ? 'dev' : 'combined', { stream: morganStream }));

  // ── Body parsers (Stripe webhook needs raw body — handled in billing route)
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Global rate limiter
  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, message: 'Too many requests, please try again later' },
    })
  );

  // ── Trust proxy (for Railway / Render / Vercel)
  app.set('trust proxy', 1);

  // ── Routes
  app.use(`/api/${config.apiVersion}`, routes);

  // ── 404
  app.use(notFoundHandler);

  // ── Error handler (must be last)
  app.use(errorHandler);

  return app;
}
