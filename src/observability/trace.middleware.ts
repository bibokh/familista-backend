// Familista — where a request writes its own trace
// ─────────────────────────────────────────────────────────────────────────────
// Two middlewares and a helper. The first opens a trace for the request and
// closes it when the response finishes; the second is what a guard calls to say
// it allowed or refused. Neither decides anything: authorization is decided
// where it always was, and this only writes down what was decided.
//
// Every one of them is inert while tracing is off.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { beginTrace, emit, endTrace, isTracing, safeRoute } from './trace-bus';
import type { TraceOutcome } from './trace-bus';

type ReqUser = { id?: string; role?: string; clubId?: string; currentClubId?: string | null; currentTeamId?: string | null };

/**
 * Open the trace, and close it on the way out.
 *
 * Mounted after `requestId`, so the id a trace is filed under is the same id the
 * access log records and the same id the response header carries. A client that
 * sent its own `X-Request-Id` keeps it, which is how a frontend stage and a
 * backend stage end up on one screen together.
 */
export const traceRequest: RequestHandler = (req, res, next) => {
  if (!isTracing()) return next();
  const id = req.requestId;
  try {
    beginTrace(id ?? '', {
      method: req.method,
      route: safeRoute(req.originalUrl),
    });
    emit(id, 'API', 'route matched', { detail: { method: req.method, route: safeRoute(req.originalUrl) } });

    res.on('finish', () => {
      const u = (req as Request & { user?: ReqUser }).user;
      const status = res.statusCode;
      emit(id, 'RESPONSE', `${status}`, {
        outcome: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'ok',
        detail: { status, method: req.method },
      });
      endTrace(id, {
        status,
        // Ids, because a trace has to be about SOMETHING — and never a name.
        clubId: u?.currentClubId ?? u?.clubId ?? null,
        teamId: u?.currentTeamId ?? null,
        actorRole: u?.role ?? null,
      });
    });
  } catch (_) { /* tracing never stands between a request and its handler */ }
  next();
};

/**
 * The authentication stage, written after `authenticate` has run.
 *
 * It reports WHETHER a session was established and what role the account
 * carries. It does not report the token, its claims, its expiry or its subject.
 */
export const traceAuthenticated: RequestHandler = (req, _res, next) => {
  if (!isTracing()) return next();
  try {
    const u = (req as Request & { user?: ReqUser }).user;
    emit(req.requestId, 'AUTH', u?.id ? 'authenticated' : 'anonymous', {
      outcome: u?.id ? 'ok' : 'warn',
      detail: u?.role ? { role: u.role } : undefined,
    });
  } catch (_) { /* as above */ }
  next();
};

/**
 * What a guard decided, in the only two words that matter.
 *
 * Called from the guards themselves, so the panel shows the real decision
 * rather than a guess made from the status code. `ALLOWED` or `DENIED`, the
 * guard's own name, and nothing about the credential that was examined.
 */
export function traceAuthz(
  req: Request,
  guard: string,
  allowed: boolean,
  detail?: Record<string, string | number | boolean>,
): void {
  if (!isTracing()) return;
  try {
    emit(req.requestId, 'AUTHZ', guard, {
      outcome: allowed ? 'ok' : ('warn' as TraceOutcome),
      detail: { decision: allowed ? 'ALLOWED' : 'DENIED', ...(detail ?? {}) },
    });
  } catch (_) { /* as above */ }
}

/** A service step, for the handful of paths worth naming. */
export function traceService(req: Request, name: string, durationMs?: number): void {
  if (!isTracing()) return;
  try { emit(req.requestId, 'SERVICE', name, { durationMs }); } catch (_) { /* as above */ }
}

/** An outbound call to somebody else's system — its name and its timing only. */
export function traceExternal(
  req: Request | { requestId?: string },
  name: string,
  durationMs?: number,
  outcome: TraceOutcome = 'ok',
): void {
  if (!isTracing()) return;
  try { emit((req as Request).requestId, 'EXTERNAL', name, { durationMs, outcome }); } catch (_) { /* as above */ }
}

/** The error stage. The message's SHAPE — its class — never its content. */
export const traceError = (err: unknown, req: Request, _res: Response, next: NextFunction): void => {
  if (isTracing()) {
    try {
      const e = err as { name?: string; status?: number; statusCode?: number };
      emit(req.requestId, 'ERROR', e?.name || 'Error', {
        outcome: 'error',
        detail: { status: e?.status ?? e?.statusCode ?? 500 },
      });
    } catch (_) { /* as above */ }
  }
  next(err);
};
