// Familista — the owner's live trace, as an API
// ─────────────────────────────────────────────────────────────────────────────
// Four routes and a stream, all of them the platform owner's. The guard is
// `assertPlatformOwner`, which is the SAME function SYSTEM has always used —
// there is no second authorization system here, and a club role reaches none of
// this however senior it is in its club.
//
// The stream is Server-Sent Events over an ordinary authenticated request. It
// is read with `fetch` and a reader rather than `EventSource`, so the token
// travels in the Authorization header like every other call in the application
// — a credential in a query string is written to every proxy log between here
// and the browser, and this panel exists to make things visible, not to leak.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import {
  disableTracing, enableTracing, recentTraces, subscribe, tracingStatus,
  type TraceRequest,
} from '../observability/trace-bus';
import { emit, isTracing, beginTrace } from '../observability/trace-bus';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

/** Every route below, and the stream, pass through this and nothing else. */
router.use(async (req: Request, res: Response, next) => {
  try {
    const u = (req as Request & { user?: { id?: string; clubId?: string; role?: string } }).user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    next();
  } catch (err) { next(err); }
});

router.get('/status', (_req, res) => {
  res.json({ success: true, data: tracingStatus() });
});

router.post('/enable', (req: Request, res: Response) => {
  const u = (req as Request & { user?: { id?: string } }).user;
  const ms = typeof req.body?.minutes === 'number' ? req.body.minutes * 60_000 : undefined;
  const { until } = enableTracing(u?.id ?? 'owner', ms);
  logger.warn('trace.enabled', { by: u?.id, until });
  res.json({ success: true, data: { ...tracingStatus(), until } });
});

router.post('/disable', (req: Request, res: Response) => {
  const u = (req as Request & { user?: { id?: string } }).user;
  disableTracing();
  logger.warn('trace.disabled', { by: u?.id });
  res.json({ success: true, data: tracingStatus() });
});

router.get('/recent', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ success: true, data: { traces: recentTraces(limit) } });
});

/**
 * A stage the browser reports about itself.
 *
 * The click, the state write and the paint happen where the server cannot see
 * them, and half the question "why did that take three seconds" lives there. The
 * browser posts them under the SAME request id it sent on the call, which is
 * what puts a click and a query on one timeline.
 *
 * Nothing here is trusted beyond its shape: the category must be one of the
 * known ones, the name is truncated, and the detail bag goes through the same
 * central redaction everything else does.
 */
router.post('/client', (req: Request, res: Response) => {
  if (!isTracing()) { res.json({ success: true, data: { accepted: 0 } }); return; }
  const stages = Array.isArray(req.body?.stages) ? req.body.stages.slice(0, 40) : [];
  let accepted = 0;
  for (const s of stages) {
    const id = typeof s?.id === 'string' ? s.id.slice(0, 200) : '';
    if (!id) continue;
    // A client stage may be the FIRST thing seen for a request — the click
    // happens before the call. Opening it here is what lets them meet.
    beginTrace(id, { method: 'UI', route: 'browser' });
    emit(id, s.category, s.name, {
      durationMs: s.durationMs,
      outcome: s.outcome,
      detail: s.detail,
    });
    accepted += 1;
  }
  res.json({ success: true, data: { accepted } });
});

const HEARTBEAT_MS = 25_000;

/** The live stream. One frame per stage, one per closed request. */
router.get('/stream', (req: Request, res: Response) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown): void => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch (_) { /* a broken pipe closes below */ }
  };

  send('hello', tracingStatus());
  for (const t of recentTraces(50)) send('trace', t);

  const unsubscribe = subscribe(({ kind, trace }: { kind: string; trace: TraceRequest }) => {
    send(kind === 'close' ? 'trace' : 'stage', trace);
  });
  const beat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) { /* closed below */ }
  }, HEARTBEAT_MS);

  const stop = (): void => {
    clearInterval(beat);
    try { unsubscribe(); } catch (_) { /* already gone */ }
    try { res.end(); } catch (_) { /* already gone */ }
  };
  req.on('close', stop);
  req.on('error', stop);
});

export default router;
