// Familista — Match WebSocket layer (Phase C)
// ─────────────────────────────────────────────────────────────────────────
// Tenant-aware, authenticated WebSocket fan-out for live match events.
//
// Wire format:
//   Client connects to:   wss://host/ws/match/:matchId?token=<jwt>
//   Server validates JWT, loads User, verifies User.clubId === Match.clubId,
//   then subscribes to MatchChannel.subscribe(matchId, …)
//
//   Server messages: { type: 'hello' | 'event', ... }
//   Client messages: { type: 'ping' } → server replies { type: 'pong' }
//
// The handler is mounted via an UPGRADE listener so we can reject before the
// WS handshake completes (no protocol confusion with /ws/live).

import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { URL } from 'url';
import { prisma } from '../config/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { subscribe, subscriberCount, MatchChannelEvent } from './match-channel';

interface JwtPayload { sub: string; clubId: string; }

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
      const token   = reqUrl.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }

      let payload: JwtPayload;
      try {
        payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }

      // Resolve user + match in parallel; check tenant scope.
      Promise.all([
        prisma.user.findUnique({
          where: { id: payload.sub },
          select: { id: true, isActive: true, clubId: true, currentClubId: true, role: true },
        }),
        prisma.match.findUnique({
          where: { id: matchId },
          select: { id: true, clubId: true },
        }),
      ]).then(([user, match]) => {
        if (!user || !user.isActive) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
        }
        if (!match) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return;
        }
        const effectiveClubId = user.currentClubId ?? user.clubId;
        if (user.role !== 'SUPER_ADMIN' && match.clubId !== effectiveClubId) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
        }

        // Cleared — complete the WS handshake and hand off to our handler.
        wss.handleUpgrade(req, socket, head, (ws) => {
          wireSocket(ws, matchId, user.id);
        });
      }).catch((err) => {
        logger.warn('[match-ws] upgrade failed', { err: err && err.message });
        try { socket.write('HTTP/1.1 500 Internal\r\n\r\n'); socket.destroy(); } catch (_) {}
      });
    } catch (err) {
      try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); } catch (_) {}
    }
  });

  return wss;
}

function wireSocket(ws: WebSocket, matchId: string, userId: string) {
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
    logger.info('[match-ws] disconnected', { matchId, userId, remaining: subscriberCount(matchId) });
  });

  ws.on('error', (err) => {
    logger.warn('[match-ws] socket error', { matchId, err: (err as Error).message });
  });

  logger.info('[match-ws] connected', { matchId, userId, totalSubs: subscriberCount(matchId) });
}
