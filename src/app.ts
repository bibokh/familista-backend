import express, { Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'path';

import { config } from './config';
import { morganStream } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { requestId, accessLog, errorReporter } from './middleware/request-id.middleware';
import { edgeIdentity } from './middleware/rate-limit.middleware';
import routes from './routes';

// ── credentials that travel in a query string ────────────────────────────────
// Only these parameter names are replaced, and only their values: the path and
// every other parameter stay exactly as they were, so a logged line is still
// useful for debugging. Kept here beside the logging middleware that uses it.
const SECRET_QUERY_PARAMS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'code',
  'secret', 'key', 'apikey', 'api_key', 'password',
]);

function redactUrl(originalUrl: string): string {
  const q = originalUrl.indexOf('?');
  if (q < 0) return originalUrl;
  const path = originalUrl.slice(0, q);
  const params = new URLSearchParams(originalUrl.slice(q + 1));
  let touched = false;
  for (const name of Array.from(params.keys())) {
    if (!SECRET_QUERY_PARAMS.has(name.toLowerCase())) continue;
    params.set(name, '[redacted]');
    touched = true;
  }
  if (!touched) return originalUrl;
  return path + '?' + params.toString();
}

export function createApp(): express.Application {
  const app = express();

  // ── Request-ID FIRST so every downstream log can correlate.
  app.use(requestId);

  // ── Security headers
  // CSS lives in public/app.css, JS in public/app.js — both served as external
  // static assets.  All 53 inline onclick/onchange handlers in the legacy SPA
  // have been replaced with data-* attributes + event delegation in app.js, so
  // unsafe-inline and unsafe-eval are no longer needed in script-src / style-src.
  // connect-src includes wss:// so the match WebSocket can connect.
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'"],
        styleSrc:    ["'self'", 'https://fonts.googleapis.com'],
        imgSrc:      ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc:    ["'self'", 'blob:', 'https:'],
        connectSrc:  [
          "'self'",
          'https://familista-backend.onrender.com',
          'wss://familista-backend.onrender.com',
          ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
        ],
        fontSrc:     ["'self'", 'data:', 'https://fonts.gstatic.com'],
        objectSrc:   ["'none'"],
        frameSrc:    ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
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

  // ── Cookie parser (must be before auth middleware reads req.cookies)
  app.use(cookieParser());

  // ── Compression
  app.use(compression());

  // ── Request logging — morgan keeps the human-readable line, accessLog
  //     adds a structured JSON line with requestId + latency + actor.
  //
  // Some credentials travel in the query string because they have nowhere else
  // to go: EventSource cannot set an Authorization header, so the live-match
  // stream is opened as /matches/:id/live?token=<jwt>, and a password-reset
  // link is /reset-password?token=<raw>. Morgan's `combined` format logs the
  // full URL, which put a usable access token and a single-use reset token into
  // the log stream. accessLog already drops the query string; this makes morgan
  // do the same for the parameters that carry secrets, and leaves every other
  // parameter — page, limit, filters — legible.
  morgan.token('url', (req) => redactUrl((req as Request).originalUrl || req.url || ''));
  app.use(morgan(config.isDev ? 'dev' : 'combined', { stream: morganStream }));
  app.use(accessLog);

  // ── Body parsers (Stripe webhook needs raw body — handled in billing route)
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Trust proxy (for Railway / Render / Vercel)
  // Set BEFORE any limiter, so req.ip is the client rather than the proxy.
  app.set('trust proxy', 1);

  // ── Edge abuse guard
  //
  // This used to be a blanket 100-requests-per-15-minutes-per-IP limiter across
  // every route, static asset and health probe. One developer's normal session —
  // login, Clubs, open a club, walk the modules — is about sixty API calls, so
  // two laps exhausted a fifteen-minute budget and normal navigation answered
  // 429. It also counted every user behind one office NAT against one bucket.
  //
  // The real limiting is the three-tier IP/user/tenant bucket in
  // rate-limit.middleware, which knows who is asking. What stays here is only
  // the thing that layer cannot do: stop a flood before it reaches the router,
  // at a volume no human interface produces. It skips health probes and
  // anything that is not an API call, because a page load is not abuse.
  const EDGE_WINDOW_MS = parseInt(process.env.RATE_EDGE_WINDOW_MS ?? '60000', 10);
  const EDGE_MAX       = parseInt(process.env.RATE_EDGE_MAX       ?? '1200',  10);
  app.use(
    rateLimit({
      windowMs: EDGE_WINDOW_MS,
      max: EDGE_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      // Keyed by who is asking, not by where they are asking from. An address
      // is the only identity anonymous traffic has, but once a request carries
      // a session the address is a poor key: fifty colleagues in one building
      // share one public IP, and keying on it makes the size of an office a
      // scaling limit. `edgeIdentity` returns the token's subject when there
      // is a valid one and the address otherwise.
      keyGenerator: edgeIdentity,
      skip: (req) => !req.path.startsWith('/api/')
        || req.path === '/api/health'
        || req.path === '/api/v1/health',
      handler: (req, res) => {
        const retryAfterSec = Math.ceil(EDGE_WINDOW_MS / 1000);
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({
          success: false,
          message: 'Too many requests, please try again later',
          retryAfterSec,
        });
      },
    })
  );

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

  // ── Legacy SPA static assets (public/index.html + app.js + app.css)
  // Serves public/ at the root path so /app.js and /app.css are reachable.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { index: 'index.html' }));

  // ── Legacy SPA deep-link: /reset-password?token=...
  // express.static serves index.html only for the exact root path "/".
  // Password-reset emails link to /reset-password?token=<raw>; without this
  // route the static middleware falls through to 404 and the user cannot
  // complete their reset. Serve index.html here so the SPA boots and reads
  // the token from location.search.
  app.get('/reset-password', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // ── React SPA (Phase R) — serve built assets + SPA fallback
  // Client build writes to public/app/ (vite.config.ts outDir: '../public/app')
  const spaDir = path.join(__dirname, '..', 'public', 'app');
  app.use('/app', express.static(spaDir, { index: false }));
  // Any /app/* path that didn't match a static file → return index.html
  // so React Router handles navigation client-side.
  app.get('/app/*', (_req, res) => {
    res.sendFile(path.join(spaDir, 'index.html'));
  });

  // ── 404
  app.use(notFoundHandler);

  // ── Error reporter (structured + Sentry-ready) BEFORE the JSON shaper
  app.use(errorReporter);

  // ── Error handler (must be last)
  app.use(errorHandler);

  return app;
}
