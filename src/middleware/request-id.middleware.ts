// Familista — Request-ID + structured error reporting middleware
// ─────────────────────────────────────────────────────────────────────────
// Why this exists:
//   • Every incoming request gets an X-Request-Id (echoed in the response
//     header). If the client passes one we trust it; otherwise we mint a
//     fresh uuidv4 prefixed by 'fam-'. Operators paste the id into the
//     log search bar and get the entire transaction.
//   • A high-precision millisecond `t0` is captured so the access log line
//     can record latency.
//   • An error reporter middleware turns unhandled errors into a single
//     structured log entry with: requestId, method, path, status, latency,
//     actorId (when authenticated), clubId, ip, errMessage, stack.
//
// Notes:
//   • Sentry / Honeycomb / OpenTelemetry exporters can hook into the
//     `onError(...)` extension point without modifying this file.
//   • No external dependency; uses node:crypto.randomUUID().

import { randomUUID } from 'crypto';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      t0?:        number;
    }
  }
}

const HEADER = 'x-request-id';

function ipOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.ip ?? 'unknown';
}

/** Stamp a request-id + start time, echo the header on the response. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.headers[HEADER];
  const id = typeof incoming === 'string' && incoming.length > 0 && incoming.length < 200
    ? incoming
    : `fam-${randomUUID()}`;
  req.requestId = id;
  req.t0        = Date.now();
  res.setHeader('x-request-id', id);
  next();
};

/** Structured access log on every response close. Single JSON line. */
export const accessLog: RequestHandler = (req, res, next) => {
  res.on('finish', () => {
    const latencyMs = req.t0 ? Date.now() - req.t0 : 0;
    const u = (req as Request & { user?: { id?: string; clubId?: string; role?: string } }).user;
    logger.info('http', {
      requestId: req.requestId,
      method:    req.method,
      path:      req.originalUrl.split('?')[0],
      status:    res.statusCode,
      latencyMs,
      ip:        ipOf(req),
      actorId:   u?.id,
      clubId:    u?.clubId,
      role:      u?.role,
    });
  });
  next();
};

// Pluggable hook so a future Sentry/Honeycomb exporter can subscribe
// without touching the middleware file. Each subscriber gets the full
// structured error frame.
type ErrSubscriber = (frame: {
  requestId?: string;
  method:     string;
  path:       string;
  status:     number;
  latencyMs:  number;
  actorId?:   string;
  clubId?:    string;
  ip:         string;
  err: {
    name?:    string;
    message:  string;
    stack?:   string;
    code?:    string | number;
  };
}) => void;

const _subscribers: ErrSubscriber[] = [];
export function onError(sub: ErrSubscriber): () => void {
  _subscribers.push(sub);
  return () => {
    const i = _subscribers.indexOf(sub);
    if (i >= 0) _subscribers.splice(i, 1);
  };
}

/**
 * Final error reporter. Place AFTER all routes, just before the
 * default Express error handler. Produces one structured log line +
 * fans out to subscribers without ever changing the response.
 */
export const errorReporter: ErrorRequestHandler = (err, req, _res, next) => {
  const e = err as { name?: string; message?: string; stack?: string; code?: string | number; status?: number; statusCode?: number };
  const latencyMs = (req as Request & { t0?: number }).t0
    ? Date.now() - (req as Request & { t0: number }).t0
    : 0;
  const u = (req as Request & { user?: { id?: string; clubId?: string } }).user;
  const frame = {
    requestId: (req as Request & { requestId?: string }).requestId,
    method:    req.method,
    path:      req.originalUrl.split('?')[0],
    status:    e?.status ?? e?.statusCode ?? 500,
    latencyMs,
    actorId:   u?.id,
    clubId:    u?.clubId,
    ip:        ipOf(req),
    err: {
      name:    e?.name,
      message: e?.message ?? 'unknown',
      stack:   e?.stack,
      code:    e?.code,
    },
  };
  logger.error('http.error', frame);
  for (const sub of _subscribers) {
    try { sub(frame); } catch (_) { /* never let a subscriber poison the report path */ }
  }
  next(err);   // hand off to the existing error.middleware which produces the JSON body
};
