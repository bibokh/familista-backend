// Familista — Match WebSocket layer (Phase C)
// ─────────────────────────────────────────────────────────────────────────
// Tenant-aware, authenticated WebSocket fan-out for live match events.
//
// Wire format:
//   Client connects to:   wss://host/ws/match/:matchId?ticket=<single-use ticket from POST /api/v1/realtime/ticket>
//   Server verifies the session exactly as `authenticate` does (signature,
//   active user, token version), verifies the acting club === Match.clubId,
//   then subscribes to MatchChannel.subscribe(matchId, …). The connection is
//   closed (4401) as soon as that session ends (realtime/session-watch.ts).
//
//   Server messages: { type: 'hello' | 'event', ... }
//   Client messages: { type: 'ping' } → server replies { type: 'pong' }
//
// The handler is mounted via an UPGRADE listener so we can reject before the
// WS handshake completes (no protocol confusion with /ws/live).

import { registerWebSocketServer } from '../infra/ws-registry';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { URL } from 'url';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { type RealtimeSession } from '../middleware/auth.middleware';
import { redeemWsTicket } from './ws-ticket';
import { subscribe, subscriberCount, MatchChannelEvent } from './match-channel';
import { watchSession } from './session-watch';

const HEARTBEAT_MS = 25_000;

export function mountMatchWebSocket(httpServer: http.Server): WebSocketServer {
  // We instantiate WS with noServer so we control the upgrade pipeline.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      // Only handle /ws/match/<id>; let other paths (e.g. /ws/live) fall through.
      const reqUrl = new URL(req.url ?? '/', 'http://internal');
      const m = reqUrl.pathname.match(/^\/ws\/match\/([0-9a-fA-F-]{8,64})$/);
      if (!m) return;          // not our concern

      const matchId = m[1];
      // A single-use ticket from POST /api/v1/realtime/ticket, never the
      // session token itself (R7). Redeeming it applies the same session rule
      // as every request: active user and token version.
      const ticket  = reqUrl.searchParams.get('ticket');
      if (!ticket) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }

      Promise.all([
        redeemWsTicket(ticket),
        prisma.match.findUnique({
          where: { id: matchId },
          select: { id: true, clubId: true },
        }),
      ]).then(([session, match]) => {
        if (!session) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
        }
        if (!match) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return;
        }
        if (session.role !== 'SUPER_ADMIN' && match.clubId !== session.clubId) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
        }

        // Cleared — complete the WS handshake and hand off to our handler.
        wss.handleUpgrade(req, socket, head, (ws) => {
          wireSocket(ws, matchId, session);
        });
      }).catch((err) => {
        logger.warn('[match-ws] upgrade failed', { err: err && err.message });
        try { socket.write('HTTP/1.1 500 Internal\r\n\r\n'); socket.destroy(); } catch (_) {}
      });
    } catch (err) {
      try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); } catch (_) {}
    }
  });

  registerWebSocketServer('match', wss);
  return wss;
}

function wireSocket(ws: WebSocket, matchId: string, session: RealtimeSession) {
  const userId = session.userId;
  // Held to the session it opened under for as long as it stays open (R1c).
  const unwatch = watchSession({
    userId, tokenVersion: session.tokenVersion, channel: 'match-ws',
    close: () => { try { ws.close(4401, 'session ended'); } catch (_) {} },
  });
  ws.send(JSON.stringify({ type: 'hello', matchId, ts: new Date().toISOString() }));

  const unsubscribe = subscribe(matchId, (event: MatchChannelEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'event', event }));
    } catch (_err) { /* dropped */ }
  });

  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch (_) {} return; }
    alive = false;
    try { ws.ping(); } catch (_) {}
  }, HEARTBEAT_MS);
  ws.on('pong', () => { alive = true; });

  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m && m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch (_) { /* ignore */ }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    unwatch();
    logger.info('[match-ws] disconnected', { matchId, userId, remaining: subscriberCount(matchId) });
  });

  ws.on('error', (err) => {
    logger.warn('[match-ws] socket error', { matchId, err: (err as Error).message });
  });

  logger.info('[match-ws] connected', { matchId, userId, totalSubs: subscriberCount(matchId) });
}
