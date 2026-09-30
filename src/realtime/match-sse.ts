// Familista — Match Server-Sent Events (Phase E)
// ─────────────────────────────────────────────────────────────────────────
// SSE is the chosen protocol for the Live Intelligence panel.
//
// Why SSE over WS for this surface:
//   - One-way push (server → client) is exactly what we need here
//   - EventSource auto-reconnects on the client (no custom backoff)
//   - Plays nicely with Render's HTTP proxy and corporate firewalls
//   - We keep /ws/match (Phase C) for the bi-directional admin tooling
//
// Wire format (Express handler):
//   GET /api/v1/matches/:id/live?token=<JWT>
//   Content-Type: text/event-stream
//   Server emits: `event: <kind>\ndata: <json>\n\n`
//
//   Initial frames:
//     event: hello           — { matchId, userId, ts }
//     event: LIVE_STATE_UPDATE — TacticalState bootstrap
//   Periodic:
//     `: keepalive\n\n`       — every 25s, comment line (ignored by EventSource)
//   On every MatchChannel publish: the event is forwarded verbatim.
//
// Failure mode: SSE is best-effort. Any subscriber write failure
// disconnects this single client but cannot affect other subscribers.

import type { Request, Response } from 'express';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { verifySessionToken } from '../middleware/auth.middleware';
import { subscribe, subscriberCount, MatchChannelEvent } from './match-channel';
import { getState } from './tactical-state';
import { endStream, watchSession } from './session-watch';

const HEARTBEAT_MS = 25_000;

/** SSE handler — mounted at GET /api/v1/matches/:id/live */
export async function matchLiveSse(req: Request, res: Response): Promise<void> {
  const matchId = String(req.params.id || '').trim();
  if (!matchId) {
    res.status(400).json({ error: 'matchId required' });
    return;
  }

  // Auth — either via req.user (mounted by authenticate middleware) or
  // via ?token= query param (browsers cannot set headers on EventSource).
  let userId: string | undefined;
  let effectiveClubId: string | undefined;
  let role: string | undefined;
  let tokenVersion: number | null = null;

  const reqUser = (req as Request & { user?: { id: string; clubId?: string; currentClubId?: string | null; role?: string } }).user;
  if (reqUser?.id) {
    userId          = reqUser.id;
    effectiveClubId = reqUser.currentClubId ?? reqUser.clubId;
    role            = reqUser.role;
    tokenVersion    = (req as Request & { sessionTokenVersion?: number | null }).sessionTokenVersion ?? null;
  } else {
    const token = String(req.query.token ?? '');
    if (!token) {
      res.status(401).json({ error: 'missing token' });
      return;
    }
    // The same session rule as every request: signature, active user and
    // token version (a session ended server-side is refused here too).
    let session;
    try { session = await verifySessionToken(token); }
    catch (err) {
      const msg = (err as Error)?.message ?? '';
      const error = /deactivated/.test(msg) ? 'inactive user' : /Session ended/.test(msg) ? 'session ended' : 'invalid token';
      res.status(401).json({ error });
      return;
    }
    userId          = session.userId;
    effectiveClubId = session.clubId;
    role            = session.role;
    tokenVersion    = session.tokenVersion;
  }

  // Tenant gate.
  const match = await prisma.match.findUnique({
    where:  { id: matchId },
    select: { id: true, clubId: true },
  });
  if (!match) { res.status(404).json({ error: 'Match not found' }); return; }
  if (role !== 'SUPER_ADMIN' && match.clubId !== effectiveClubId) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  // ── SSE handshake ───────────────────────────────────────────────────
  res.status(200);
  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx buffering if present
  // Tell client to retry every 5s if the stream drops.
  res.write('retry: 5000\n\n');
  res.flushHeaders?.();

  // Hello frame.
  writeEvent(res, 'hello', { matchId, userId, ts: new Date().toISOString() });

  // Bootstrap with current TacticalState — costs one bounded read.
  try {
    const state = await getState(matchId, match.clubId);
    writeEvent(res, 'LIVE_STATE_UPDATE', state);
  } catch (err) {
    logger.warn('[match-sse] state bootstrap failed', { matchId, err: (err as Error).message });
  }

  // Subscribe to MatchChannel.
  const unsubscribe = subscribe(matchId, (event: MatchChannelEvent) => {
    if (res.writableEnded) return;
    try { writeEvent(res, event.kind, event); }
    catch (err) { logger.warn('[match-sse] write failed', { matchId, err: (err as Error)?.message }); }
  });

  // Heartbeat.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { /* ignore */ }
  }, HEARTBEAT_MS);

  // Held to the session it opened under for as long as it stays open (R1c).
  const unwatch = watchSession({
    userId: userId!, tokenVersion, channel: 'match-sse',
    close: () => endStream(res),
  });

  const teardown = () => {
    clearInterval(heartbeat);
    unsubscribe();
    unwatch();
    logger.info('[match-sse] disconnected', { matchId, userId, remaining: subscriberCount(matchId) });
  };
  req.on('close', teardown);
  req.on('aborted', teardown);
  res.on('close', teardown);

  logger.info('[match-sse] connected', { matchId, userId, totalSubs: subscriberCount(matchId) });
}

function writeEvent(res: Response, kind: string, payload: unknown): void {
  // SSE wants \n-terminated lines and a blank line as the record separator.
  res.write(`event: ${kind}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
