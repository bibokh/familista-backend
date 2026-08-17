// Familista — Transfer-market WebSocket layer
// ─────────────────────────────────────────────────────────────────────────
// The same upgrade pipeline the match socket already uses, pointed at a
// different path. One connection per session:
//
//   Client connects to:   wss://host/ws/market?token=<jwt>
//   Server verifies the JWT, loads the User, and resolves the acting club
//   FROM THAT USER ROW — currentClubId ?? clubId. The browser does not say
//   which club it is; it could not be believed if it did.
//
//   Server messages: { type: 'hello', clubId } | { type: 'event', event }
//   Client messages: { type: 'ping' } → { type: 'pong' }
//
// A socket is subscribed to exactly two streams: the public one every club
// sees, and the private one belonging to the club the session is acting for.
// Switching clubs means a new socket — the old one is closed by the browser
// and its subscriptions go with it — so a private event for the club just
// left has nowhere to arrive.

import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { URL } from 'url';
import { prisma } from '../config/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { subscribeClub, subscribePublic, marketSubscriberCount, MarketEvent } from './market-channel';

interface JwtPayload { sub: string; clubId: string }

const HEARTBEAT_MS = 25_000;

export function mountMarketWebSocket(httpServer: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      // Only /ws/market. Every other path — /ws/match/:id included — is left
      // for the handler that owns it, exactly as that one leaves this.
      const reqUrl = new URL(req.url ?? '/', 'http://internal');
      if (reqUrl.pathname !== '/ws/market') return;

      const token = reqUrl.searchParams.get('token');
      if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

      let payload: JwtPayload;
      try {
        payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }

      prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, isActive: true, clubId: true, currentClubId: true },
      }).then((user) => {
        if (!user || !user.isActive) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
        }
        // The acting club, read from the user row. Never from the query.
        const clubId = user.currentClubId ?? user.clubId;
        if (!clubId) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wireMarketSocket(ws, clubId, user.id));
      }).catch((err) => {
        logger.warn('[market-ws] upgrade failed', { err: err && err.message });
        try { socket.write('HTTP/1.1 500 Internal\r\n\r\n'); socket.destroy(); } catch (_) {}
      });
    } catch (_err) {
      try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); } catch (_) {}
    }
  });

  return wss;
}

function wireMarketSocket(ws: WebSocket, clubId: string, userId: string) {
  ws.send(JSON.stringify({ type: 'hello', clubId, ts: new Date().toISOString() }));

  const send = (event: MarketEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'event', event })); } catch (_err) { /* dropped */ }
  };
  // Two streams, one socket: what the market may see, and what this club may.
  const offPublic = subscribePublic(send);
  const offClub = subscribeClub(clubId, send);

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
    offPublic(); offClub();
    logger.info('[market-ws] disconnected', { clubId, userId, remaining: marketSubscriberCount(clubId) });
  });

  ws.on('error', (err) => {
    logger.warn('[market-ws] socket error', { clubId, err: (err as Error).message });
  });

  logger.info('[market-ws] connected', { clubId, userId, totalSubs: marketSubscriberCount(clubId) });
}
