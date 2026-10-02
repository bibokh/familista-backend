/**
 * tests/realtime-session-revocation.unit.test.ts
 *
 * Cyber Defense, R1c — a live connection is held to the same session rule as
 * a request, for as long as it stays open.
 *
 * Before: the match and market WebSockets and the live match stream checked
 * only the token's signature and that the user row was active. A session
 * ended server-side (membership revoked → tokenVersion bumped) was refused at
 * the next HTTP request but could still OPEN a socket, and a socket already
 * open kept receiving the club's live data until the tab closed.
 *
 * After: they verify exactly as `authenticate` does (signature, active user,
 * token version), and every open connection is closed when its session ends —
 * at once on an identity change, and by a timed re-check as the backstop.
 * Driven here over real HTTP servers and real WebSocket clients.
 */

process.env.AUTH_IDENTITY_TTL_MS = '0'; // every check reads the (mocked) database

import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import type { AddressInfo } from 'net';

type UserRow = { id: string; email: string; role: string; clubId: string; isActive: boolean; currentClubId: string | null; currentTeamId: string | null; tokenVersion: number; platformAdmin: null };
const users = new Map<string, UserRow>();
const CLUB = '11111111-1111-4111-8111-111111111111';
const MATCH = '22222222-2222-4222-8222-222222222222';
let failLookups = false;

jest.mock('../src/config/database', () => ({
  prisma: {
    user: {
      findFirst: async ({ where }: { where: { id: string; isActive?: boolean } }) => {
        if (failLookups) throw new Error('database unavailable');
        const u = users.get(where.id);
        return u && (where.isActive === undefined || u.isActive === where.isActive) ? { ...u } : null;
      },
    },
    match: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === MATCH ? { id: MATCH, clubId: CLUB } : null) },
  },
}));
jest.mock('../src/realtime/tactical-state', () => ({ getState: async () => ({ phase: 'live' }) }));

import { config } from '../src/config';
import { forgetIdentity, verifySessionToken } from '../src/middleware/auth.middleware';
import { mountMatchWebSocket } from '../src/realtime/match-ws';
import { mountMarketWebSocket } from '../src/realtime/market-ws';
import { matchLiveSse } from '../src/realtime/match-sse';
import { recheckSessions, watchedSessionCount, watchRequestSession } from '../src/realtime/session-watch';
import { issueWsTicket } from '../src/realtime/ws-ticket';

/** WebSockets open with a single-use ticket (R7); its claims are the session's. */
const ticket = (sub: string, tv?: number) => issueWsTicket(sub, tv ?? null).ticket;
import { signToken } from '../src/security/jwt-tokens';

function addUser(id: string, tv = 0): UserRow {
  const u: UserRow = { id, email: `${id}@test.invalid`, role: 'HEAD_COACH', clubId: CLUB, isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: tv, platformAdmin: null };
  users.set(id, u);
  return u;
}
const token = (sub: string, tv?: number) => signToken('access', { sub, email: `${sub}@test.invalid`, role: 'HEAD_COACH', clubId: CLUB, ...(tv === undefined ? {} : { tv }) }, { expiresIn: '15m' });

/** Ends a session the way the platform does: bump the version, drop the cached identity. */
function endSession(id: string): void { users.get(id)!.tokenVersion += 1; forgetIdentity(id); }

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

let server: http.Server;
let port: number;
beforeAll(async () => {
  const app = express();
  app.get('/api/v1/matches/:id/live', matchLiveSse);
  // A stream behind `authenticate`, as data-pulse / infrastructure / owner-trace are.
  app.get('/owner/stream', (req, res) => {
    (req as any).user = { id: 'owner-1' }; (req as any).sessionTokenVersion = 0;
    res.status(200).setHeader('Content-Type', 'text/event-stream');
    res.write(': open\n\n');
    watchRequestSession(req, res, 'test-sse');
    const beat = setInterval(() => res.write(': beat\n\n'), 20);
    req.on('close', () => { clearInterval(beat); streamTornDown += 1; });
  });
  server = http.createServer(app);
  mountMatchWebSocket(server);
  mountMarketWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { users.clear(); failLookups = false; });
let streamTornDown = 0;

function openWs(path: string): Promise<{ ws: WebSocket; closed: Promise<number>; hello: Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    const hello = new Promise((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
    ws.on('open', () => resolve({ ws, closed, hello }));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', () => undefined);
  });
}

describe('the shared verifier is the request rule', () => {
  it('accepts a current session and a legacy token without a version', async () => {
    addUser('u-1', 3);
    await expect(verifySessionToken(token('u-1', 3))).resolves.toMatchObject({ userId: 'u-1', clubId: CLUB, tokenVersion: 3 });
    await expect(verifySessionToken(token('u-1'))).resolves.toMatchObject({ tokenVersion: null });
  });

  it('refuses an ended session, a deactivated user and a bad signature', async () => {
    addUser('u-1', 4);
    await expect(verifySessionToken(token('u-1', 3))).rejects.toThrow(/Session ended/);
    users.get('u-1')!.isActive = false;
    await expect(verifySessionToken(token('u-1', 4))).rejects.toThrow(/deactivated/);
    await expect(verifySessionToken(jwt.sign({ sub: 'u-1', tv: 4 }, 'not-the-secret'))).rejects.toThrow(/Invalid/);
  });
});

describe.each([
  ['match WebSocket', `/ws/match/${MATCH}`],
  ['market WebSocket', '/ws/market'],
])('%s', (_name, path) => {
  it('refuses to open with a session that has already ended', async () => {
    addUser('u-1', 1);
    await expect(openWs(`${path}?ticket=${ticket('u-1', 0)}`)).rejects.toMatchObject({ status: 401 });
  });

  it('closes an open socket with 4401 the moment its session ends, and leaves other people connected', async () => {
    addUser('u-1', 0); addUser('u-2', 0);
    const a = await openWs(`${path}?ticket=${ticket('u-1', 0)}`);
    const b = await openWs(`${path}?ticket=${ticket('u-2', 0)}`);
    await a.hello;
    endSession('u-1');
    expect(await a.closed).toBe(4401);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    b.ws.close(); await b.closed;
  });

  it('closes an open socket when the account is deactivated', async () => {
    addUser('u-1', 0);
    const a = await openWs(`${path}?ticket=${ticket('u-1', 0)}`);
    users.get('u-1')!.isActive = false; forgetIdentity('u-1');
    expect(await a.closed).toBe(4401);
  });
});

describe('live match stream (SSE)', () => {
  const get = (tok: string) => new Promise<http.IncomingMessage>((resolve) => {
    http.get(`http://127.0.0.1:${port}/api/v1/matches/${MATCH}/live?token=${tok}`, resolve);
  });

  it('refuses to open with an ended session', async () => {
    addUser('u-1', 2);
    const res = await get(token('u-1', 1));
    let body = ''; res.on('data', (c) => { body += c; });
    await new Promise((r) => res.on('end', r));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(body)).toEqual({ error: 'session ended' });
  });

  it('ends an open stream the moment its session ends', async () => {
    addUser('u-1', 0);
    const res = await get(token('u-1', 0));
    expect(res.statusCode).toBe(200);
    const ended = new Promise((r) => { res.on('close', r); res.on('end', r); });
    res.resume();
    await until(() => watchedSessionCount() > 0);
    endSession('u-1');
    await ended;
  });
});

describe('streams behind authenticate (data-pulse, infrastructure, owner-trace, vision)', () => {
  it('are ended when the session ends, and the route\'s own teardown runs', async () => {
    addUser('owner-1', 0);
    const before = streamTornDown;
    const res = await new Promise<http.IncomingMessage>((r) => http.get(`http://127.0.0.1:${port}/owner/stream`, r));
    const ended = new Promise((r) => { res.on('close', r); res.on('end', r); });
    res.resume();
    await until(() => watchedSessionCount() > 0);
    endSession('owner-1');
    await ended;
    await until(() => streamTornDown === before + 1);
  });
});

describe('the timed re-check (backstop for a change nobody announced)', () => {
  it('closes a socket whose session ended without forgetIdentity being called', async () => {
    addUser('u-1', 0);
    const a = await openWs(`/ws/market?ticket=${ticket('u-1', 0)}`);
    users.get('u-1')!.tokenVersion = 7; // a direct database edit: no forget, no broadcast
    await new Promise((r) => setTimeout(r, 50));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(await recheckSessions()).toBe(1);
    expect(await a.closed).toBe(4401);
  });

  it('keeps connections open when the identity lookup itself fails', async () => {
    addUser('u-1', 0);
    const a = await openWs(`/ws/market?ticket=${ticket('u-1', 0)}`);
    failLookups = true;
    expect(await recheckSessions()).toBe(0);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    failLookups = false;
    a.ws.close(); await a.closed;
  });

  it('forgets a connection once it closes, so nothing is left watched', async () => {
    addUser('u-1', 0);
    const a = await openWs(`/ws/market?ticket=${ticket('u-1', 0)}`);
    a.ws.close(); await a.closed;
    await until(() => watchedSessionCount() === 0);
  });
});
