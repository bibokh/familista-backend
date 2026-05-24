import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { config } from './config';
import { morganStream } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { requestId, accessLog, errorReporter } from './middleware/request-id.middleware';
import routes from './routes';

export function createApp(): express.Application {
  const app = express();

  // ── Request-ID FIRST so every downstream log can correlate.
  app.use(requestId);

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

  // ── Request logging — morgan keeps the human-readable line, accessLog
  //     adds a structured JSON line with requestId + latency + actor.
  app.use(morgan(config.isDev ? 'dev' : 'combined', { stream: morganStream }));
  app.use(accessLog);

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

  // ── Cold-start / liveness probes (no auth, no body)
  // Two paths for resilience: /api/health (frontend ping) + /healthz (Render).
  const healthPayload = () => ({
    status: 'ok',
    server: 'Familista Backend',
    version: config.apiVersion || 'v1',
    env: config.env,
    uptimeSec: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
  app.get('/api/health', (_req, res) => res.json(healthPayload()));
  app.get('/healthz',    (_req, res) => res.json(healthPayload()));

  // ── Routes
  app.use(`/api/${config.apiVersion}`, routes);

  // ── 404
  app.use(notFoundHandler);

  // ── Error reporter (structured + Sentry-ready) BEFORE the JSON shaper
  app.use(errorReporter);

  // ── Error handler (must be last)
  app.use(errorHandler);

  return app;
}
