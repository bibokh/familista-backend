/**
 * Cyber Defense, R7 — tokens and sockets
 *
 * Every JWT is signed and verified in src/security/jwt-tokens.ts: HS256 only,
 * an issuer and a per-kind audience, a key id. A token minted before this
 * build is honoured only if it was issued before a fixed date. A WebSocket
 * opens with a 30-second ticket that can be spent once, anywhere. The React
 * client keeps nothing in browser storage.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

// ── a Redis that two processes share, and that can fail ─────────────────────
const redisStore = new Map<string, string>();
const redisState = { configured: false, client: true, throws: false };
jest.mock('../src/infra/redis', () => ({
  redisConfigured: () => redisState.configured,
  rkey: (...p: unknown[]) => ['fam', ...p].join(':'),
  getRedis: () => (!redisState.client ? null : {
    set: async (k: string, v: string, _px: string, _ms: number, nx: string) => {
      if (redisState.throws) throw new Error('connection refused');
      if (nx === 'NX' && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    },
  }),
}));

const sessionCalls: Array<[string, number | undefined, boolean | undefined]> = [];
jest.mock('../src/middleware/auth.middleware', () => ({
  realtimeSessionFor: async (sub: string, tv: number | undefined, passedCode?: boolean) => {
    sessionCalls.push([sub, tv, passedCode]);
    return { userId: sub, role: 'COACH', clubId: 'c-1', tokenVersion: tv ?? null };
  },
}));

import fs from 'fs';
import path from 'path';
import { createHmac } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../src/config';
import {
  AUDIENCE, ISSUER, LEGACY_ISSUED_BEFORE, TokenRejected, kidOf, signToken, verifyToken, type TokenKind,
} from '../src/security/jwt-tokens';
import { issueWsTicket, redeemWsTicket, TICKET_TTL_SECONDS, __resetTicketClaims } from '../src/realtime/ws-ticket';

const ACCESS = config.jwt.secret;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const outcome = (kind: TokenKind, token: string, now?: number): string => {
  try { verifyToken(kind, token, now); return 'accepted'; } catch (e) {
    return e instanceof TokenRejected ? e.reason : `threw:${(e as Error).message}`;
  }
};
/** A token shaped exactly as this build would mint it, but with `over` changed. */
const handMade = (over: { header?: object; payload?: object; secret?: string } = {}): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: kidOf(ACCESS), ...over.header };
  const payload = { sub: 'u-1', iss: ISSUER, aud: AUDIENCE.access, iat: now, exp: now + 600, ...over.payload };
  const body = `${b64(header)}.${b64(payload)}`;
  const sig = createHmac('sha256', over.secret ?? ACCESS).update(body).digest('base64url');
  return `${body}.${sig}`;
};

describe('signing: HS256, a key id, an issuer and an audience on every token', () => {
  it.each(['access', 'refresh', 'device', 'ws-ticket'] as TokenKind[])('a %s token round-trips and names its key', (kind) => {
    const t = signToken(kind, { sub: 'u-1' }, { expiresIn: 60 });
    const d = jwt.decode(t, { complete: true }) as jwt.Jwt;
    expect(d.header.alg).toBe('HS256');
    expect(d.header.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(d.payload).toMatchObject({ iss: ISSUER, aud: AUDIENCE[kind] });
    expect(outcome(kind, t)).toBe('accepted');
  });

  it('the key id is a fingerprint, never the secret', () => {
    expect(kidOf(ACCESS)).not.toContain(ACCESS.slice(0, 8));
    expect(kidOf(ACCESS)).not.toBe(kidOf(config.jwt.refreshSecret));
  });
});

describe('verification refuses what it must', () => {
  it('a hand-made token in the right shape is accepted (the fixture is honest)', () => {
    expect(outcome('access', handMade())).toBe('accepted');
  });

  it('alg: none is refused', () => {
    const t = `${b64({ alg: 'none', typ: 'JWT', kid: kidOf(ACCESS) })}.${b64({ sub: 'u-1', iss: ISSUER, aud: AUDIENCE.access })}.`;
    expect(outcome('access', t)).toBe('invalid');
  });

  it('RS/HS confusion is refused: an RS256 header over an HMAC made with the secret', () => {
    expect(outcome('access', handMade({ header: { alg: 'RS256' } }))).toBe('invalid');
  });

  it('another HMAC algorithm with the right secret is refused', () => {
    const t = jwt.sign({ sub: 'u-1' }, ACCESS, { algorithm: 'HS512', keyid: kidOf(ACCESS), issuer: ISSUER, audience: AUDIENCE.access });
    expect(outcome('access', t)).toBe('invalid');
  });

  it('a wrong issuer is refused', () => {
    expect(outcome('access', handMade({ payload: { iss: 'someone-else' } }))).toBe('invalid');
  });

  it('a token of one kind is refused as another', () => {
    expect(outcome('access', signToken('device', { sub: 'd-1', kind: 'device' }))).toBe('invalid');
    expect(outcome('access', signToken('ws-ticket', { sub: 'u-1' }, { expiresIn: 30 }))).toBe('invalid');
    expect(outcome('access', signToken('refresh', { sub: 'u-1' }, { expiresIn: 60 }))).not.toBe('accepted');
    expect(outcome('ws-ticket', signToken('access', { sub: 'u-1' }, { expiresIn: 60 }))).toBe('invalid');
    expect(outcome('device', signToken('access', { sub: 'u-1' }, { expiresIn: 60 }))).toBe('invalid');
  });

  it('an unknown key id is refused, and the right kid with another secret is refused', () => {
    expect(outcome('access', handMade({ header: { kid: 'not-a-known-key' } }))).toBe('unknown-key');
    expect(outcome('access', handMade({ secret: 'z'.repeat(48) }))).toBe('invalid');
  });

  it('an expired token is refused as expired', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(outcome('access', handMade({ payload: { iat: past, exp: past + 60 } }))).toBe('expired');
  });
});

describe('the transition window for tokens minted before this build', () => {
  const cutoff = Math.floor(LEGACY_ISSUED_BEFORE / 1000);
  const legacy = (payload: object, iat: number) => jwt.sign({ sub: 'u-1', ...payload, iat }, ACCESS, { expiresIn: 7200 });

  it('is a fixed date, not configuration', () => {
    expect(new Date(LEGACY_ISSUED_BEFORE).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('accepts an unscoped token issued before the cut-off, HS256 only', () => {
    expect(outcome('access', legacy({}, cutoff - 3600), LEGACY_ISSUED_BEFORE - 1000)).toBe('accepted');
    const hs512 = jwt.sign({ sub: 'u-1', iat: cutoff - 3600 }, ACCESS, { algorithm: 'HS512', expiresIn: 7200 });
    expect(outcome('access', hs512, LEGACY_ISSUED_BEFORE - 1000)).toBe('invalid');
  });

  it('refuses an unscoped token issued at or after the cut-off', () => {
    expect(outcome('access', legacy({}, cutoff + 10), LEGACY_ISSUED_BEFORE + 20_000)).toBe('legacy-closed');
  });

  it('keeps the old kinds apart and never takes a legacy ticket', () => {
    const now = LEGACY_ISSUED_BEFORE - 1000;
    expect(outcome('access', legacy({ kind: 'device' }, cutoff - 3600), now)).toBe('wrong-kind');
    expect(outcome('device', legacy({}, cutoff - 3600), now)).toBe('wrong-kind');
    expect(outcome('ws-ticket', legacy({}, cutoff - 3600), now)).toBe('invalid');
    expect(outcome('access', legacy({ iss: ISSUER }, cutoff - 3600), now)).toBe('invalid');
  });
});

describe('key rotation is configuration, not an outage', () => {
  const OLD = 'o'.repeat(48);
  afterEach(() => { delete process.env.JWT_ACCESS_SECRET_PREVIOUS; });

  it('a token signed with the previous key is accepted while that key is in the keyring, and refused after', () => {
    const t = jwt.sign({ sub: 'u-1' }, OLD, { algorithm: 'HS256', keyid: kidOf(OLD), issuer: ISSUER, audience: AUDIENCE.access, expiresIn: 60 });
    expect(outcome('access', t)).toBe('unknown-key');
    process.env.JWT_ACCESS_SECRET_PREVIOUS = OLD;
    expect(outcome('access', t)).toBe('accepted');
    // New tokens are still signed with the active key.
    expect((jwt.decode(signToken('access', { sub: 'u-1' }), { complete: true }) as jwt.Jwt).header.kid).toBe(kidOf(ACCESS));
  });
});

describe('WebSocket tickets', () => {
  beforeEach(() => {
    __resetTicketClaims(); redisStore.clear(); sessionCalls.length = 0;
    Object.assign(redisState, { configured: false, client: true, throws: false });
  });

  it('live thirty seconds, and are not access tokens', () => {
    const { ticket, expiresIn } = issueWsTicket('u-1', 3);
    const p = jwt.decode(ticket) as jwt.JwtPayload;
    expect(expiresIn).toBe(TICKET_TTL_SECONDS);
    expect(TICKET_TTL_SECONDS).toBe(30);
    expect((p.exp as number) - (p.iat as number)).toBe(30);
    expect(typeof p.jti).toBe('string');
    expect(outcome('access', ticket)).toBe('invalid');
  });

  it('open one socket: the second redemption is refused (one process)', async () => {
    const { ticket } = issueWsTicket('u-1', 3);
    expect(await redeemWsTicket(ticket)).toMatchObject({ userId: 'u-1', tokenVersion: 3 });
    expect(await redeemWsTicket(ticket)).toBeNull();
  });

  it('open one socket across processes: the claim is SET NX in Redis', async () => {
    redisState.configured = true;
    const { ticket } = issueWsTicket('u-1', 3);
    expect(await redeemWsTicket(ticket)).not.toBeNull();
    __resetTicketClaims(); // a second process has no memory of the first
    expect(await redeemWsTicket(ticket)).toBeNull();
  });

  it('fail closed when Redis is configured but cannot answer', async () => {
    redisState.configured = true; redisState.throws = true;
    expect(await redeemWsTicket(issueWsTicket('u-1', 3).ticket)).toBeNull();
    redisState.throws = false; redisState.client = false;
    expect(await redeemWsTicket(issueWsTicket('u-1', 3).ticket)).toBeNull();
  });

  it('refuse an access token, nothing, and garbage', async () => {
    expect(await redeemWsTicket(signToken('access', { sub: 'u-1' }, { expiresIn: 60 }))).toBeNull();
    expect(await redeemWsTicket(null)).toBeNull();
    expect(await redeemWsTicket('x.y.z')).toBeNull();
  });

  it('carry whether the session passed a code, so the admin MFA rule holds on the socket', async () => {
    await redeemWsTicket(issueWsTicket('u-1', 3, true).ticket);
    await redeemWsTicket(issueWsTicket('u-2', 1).ticket);
    expect(sessionCalls).toEqual([['u-1', 3, true], ['u-2', 1, false]]);
  });

  it('the sockets read ?ticket= and never ?token=', () => {
    for (const f of ['src/realtime/match-ws.ts', 'src/realtime/market-ws.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(src).toContain("searchParams.get('ticket')");
      expect(src).not.toContain("searchParams.get('token')");
    }
  });
});

describe('the React client keeps nothing in browser storage', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(__dirname, '..', 'client', 'src'));
  const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('no localStorage or sessionStorage anywhere in client/src', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(`${path.basename(f)}: ${/\b(localStorage|sessionStorage)\b/.test(code(f))}`).toBe(`${path.basename(f)}: false`);
  });

  it('refreshes through the httpOnly cookie and sends credentials', () => {
    const client = code(path.join(__dirname, '..', 'client', 'src', 'api', 'client.ts'));
    expect(client).toMatch(/\$\{BASE\}\/auth\/refresh/);
    expect(client).toMatch(/credentials: 'include'/);
    expect(client).not.toMatch(/refreshToken/);
  });
});
