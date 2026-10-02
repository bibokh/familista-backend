/**
 * Cyber Defense · Step 8 — refresh tokens hashed at rest, dual-read
 *
 * What is pinned: the database never receives a raw refresh token; a refresh
 * and a logout find a row by its hash; a row from before Step 8 (raw value,
 * with or without its backfilled hash) still works, so nobody is logged out;
 * rotation is single-use under concurrency; replay, cross-user, expiry,
 * malformed input and a failing database all end without a session. Driven
 * through the real `createApp()` over an in-memory stand-in for the tables,
 * whose conditional delete is atomic the way one Postgres statement is.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
process.env.RATE_AUTH_CAPACITY = '100000';
process.env.RATE_ACCOUNT_CAPACITY = '100000';

type Row = Record<string, unknown>;
const USERS: Record<string, Row> = {};
let TOKENS: Row[] = [];
const FAULT = { lookup: false };
const WRITES: Row[] = [];
/** Barrier at the rotation claim: the first n claims wait for each other. */
const BARRIER = { size: 0, waiting: [] as Array<() => void> };
async function atBarrier(): Promise<void> {
  if (BARRIER.size <= 0) return;
  await new Promise<void>((resolve) => {
    BARRIER.waiting.push(resolve);
    if (BARRIER.waiting.length >= BARRIER.size) { BARRIER.size = 0; BARRIER.waiting.splice(0).forEach((r) => r()); }
  });
}

function rtMatch(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => rtMatch(row, w));
    if (v === null) return row[k] === null || row[k] === undefined;
    return row[k] === v;
  });
}
const withUser = (t: Row | undefined) => {
  if (!t) return null;
  const u = Object.values(USERS).find((x) => x.id === t.userId);
  return { ...t, user: u ? { clubId: u.clubId } : null };
};
let seq = 0;

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findUnique: async (q: { where: Row }) =>
          Object.values(USERS).find((u) => u.email === q.where.email || u.id === q.where.id) ?? null,
        findFirst: async (q: { where: Row }) =>
          Object.values(USERS).find((u) => u.id === q.where.id && (q.where.isActive === undefined || u.isActive === q.where.isActive)) ?? null,
        update: async () => ({}),
      };
      if (k === 'refreshToken') return {
        create: async (q: { data: Row }) => {
          WRITES.push({ ...q.data });
          if (q.data.tokenHash && TOKENS.some((t) => t.tokenHash === q.data.tokenHash)) throw new Error('Unique constraint failed on the fields: (`tokenHash`)');
          seq += 1; const row = { id: `rt-${seq}`, token: null, tokenHash: null, createdAt: new Date(), ...q.data };
          TOKENS.push(row); return { ...row };
        },
        findUnique: async (q: { where: Row }) => {
          if (FAULT.lookup) throw new Error('database unavailable');
          return withUser(TOKENS.find((t) => rtMatch(t, q.where)));
        },
        findFirst: async (q: { where: Row }) => {
          if (FAULT.lookup) throw new Error('database unavailable');
          return withUser(TOKENS.find((t) => rtMatch(t, q.where)));
        },
        deleteMany: async (q: { where: Row }) => {
          await atBarrier();
          const before = TOKENS.length;
          TOKENS = TOKENS.filter((t) => !rtMatch(t, q.where));
          return { count: before - TOKENS.length };
        },
        delete: async () => { throw new Error('rotation must use the conditional deleteMany'); },
      };
      if (k === 'mFASetting') return { findUnique: async () => null };
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jwt = require('jsonwebtoken');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { hashPassword } from '../src/utils/password';
import { hashRefreshToken, REFRESH_TOKEN_HASH_PREFIX } from '../src/security/refresh-token-hash';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import { resetSecurityCollectors } from '../src/cyber-defense/collectors';
import { signToken } from '../src/security/jwt-tokens';

const app = createApp();
const EMAIL = 'coach@familista.test';
const PASSWORD = 'right-password';

let published: FamilistaEvent[] = [];
const transport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as unknown as EventTransport;
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

const login = async (target: unknown = app) => {
  const res = await request(target).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.tokens as { accessToken: string; refreshToken: string };
};
const refresh = (token: unknown, target: unknown = app) => request(target).post('/api/v1/auth/refresh').send({ refreshToken: token });
const logout = (token: unknown) => request(app).post('/api/v1/auth/logout').send({ refreshToken: token });
/** A refresh token as the previous build issued it: same secret, same claims. */
const legacyToken = (sub = 'u-coach') =>
  signToken('refresh', { sub, email: EMAIL, role: 'HEAD_COACH', clubId: 'c-1', tv: 0, jti: `legacy-${Math.random()}` }, { expiresIn: '7d' });
const week = () => new Date(Date.now() + 7 * 24 * 3600_000);

beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  USERS.coach = { id: 'u-coach', email: EMAIL, passwordHash, role: 'HEAD_COACH', isActive: true, clubId: 'c-1', tokenVersion: 0, club: { name: 'C' } };
  USERS.other = { id: 'u-other', email: 'other@familista.test', passwordHash, role: 'HEAD_COACH', isActive: true, clubId: 'c-2', tokenVersion: 0, club: { name: 'D' } };
  setEventTransport(transport);
});
afterAll(async () => { await settle(); setEventTransport(null); });
beforeEach(() => {
  TOKENS = []; WRITES.length = 0; FAULT.lookup = false; published = [];
  USERS.coach.isActive = true;
  BARRIER.size = 0; BARRIER.waiting.splice(0).forEach((r) => r());
  resetSecurityCollectors();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the hash', () => {
  it('is a 64-hex SHA-256, deterministic, and domain-separated from a plain SHA-256', () => {
    const h = hashRefreshToken('abc.def.ghi');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken('abc.def.ghi')).toBe(h);
    expect(h).not.toBe(createHash('sha256').update('abc.def.ghi').digest('hex'));
    expect(hashRefreshToken('abc.def.ghj')).not.toBe(h);
  });

  it('the migration backfills with exactly the same prefix and formula', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20260929100000_refresh_token_hashed_at_rest/migration.sql'), 'utf8');
    expect(sql).toContain(`encode(sha256(convert_to('${REFRESH_TOKEN_HASH_PREFIX}' || "token", 'UTF8')), 'hex')`);
  });

  it('the migration is additive and keeps every still-valid raw value, so nobody is logged out', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20260929100000_refresh_token_hashed_at_rest/migration.sql'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)|DELETE\s+FROM|TRUNCATE/i);
    // The only statement that clears a raw value is limited to expired rows.
    const clears = sql.match(/SET\s+"token"\s*=\s*NULL[^;]*;/gi) ?? [];
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatch(/"expiresAt"\s*<\s*\(now\(\) AT TIME ZONE 'UTC'\)/);
  });
});

describe('what is written', () => {
  it('a sign-in stores the hash and never the token', async () => {
    const t = await login();
    expect(WRITES).toHaveLength(1);
    expect(WRITES[0].token).toBeUndefined();
    expect(WRITES[0].tokenHash).toBe(hashRefreshToken(t.refreshToken));
    expect(JSON.stringify(TOKENS)).not.toContain(t.refreshToken);
    expect(JSON.stringify(TOKENS)).not.toContain(t.refreshToken.split('.')[2]); // not even the signature
  });

  it('a refresh stores only the new hash', async () => {
    const t = await login();
    const r = await refresh(t.refreshToken);
    expect(r.status).toBe(200);
    expect(WRITES.every((w) => w.token === undefined)).toBe(true);
    expect(JSON.stringify(TOKENS)).not.toContain(r.body.data.refreshToken);
  });

  it('two sign-ins in the same breath get two different hashes', async () => {
    const [a, b] = await Promise.all([login(), login()]);
    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(new Set(TOKENS.map((t) => t.tokenHash)).size).toBe(2);
  });
});

describe('refresh', () => {
  it('rotates: the new pair works, the old row is gone', async () => {
    const t = await login();
    const r = await refresh(t.refreshToken);
    expect(r.status).toBe(200);
    expect(r.body.data.refreshToken).not.toBe(t.refreshToken);
    expect(TOKENS).toHaveLength(1);
    expect(TOKENS[0].tokenHash).toBe(hashRefreshToken(r.body.data.refreshToken));
    expect((await refresh(r.body.data.refreshToken)).status).toBe(200);
  });

  it('replaying a rotated token is refused as before and recorded as security.refresh.reused', async () => {
    const t = await login();
    expect((await refresh(t.refreshToken)).status).toBe(200);
    const again = await refresh(t.refreshToken);
    expect(again.status).toBe(401);
    expect(again.body.message).toBe('Refresh token expired or revoked');
    await settle();
    expect(published.filter((e) => e.eventType === 'security.refresh.reused')).toHaveLength(1);
  });

  it('the same token twice at once → exactly one new session; the other is a reuse', async () => {
    const t = await login();
    BARRIER.size = 2; // both pass the lookup, then meet at the claim
    const results = await Promise.all([refresh(t.refreshToken), refresh(t.refreshToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(TOKENS).toHaveLength(1);
  });

  it('a row whose hash matches but belongs to somebody else is refused', async () => {
    const t = await login();
    TOKENS[0].userId = 'u-other';
    expect((await refresh(t.refreshToken)).status).toBe(401);
  });

  it('an expired row is refused', async () => {
    const t = await login();
    TOKENS[0].expiresAt = new Date(Date.now() - 1);
    expect((await refresh(t.refreshToken)).status).toBe(401);
  });

  it('a deactivated account gets no new session', async () => {
    const t = await login();
    USERS.coach.isActive = false;
    expect((await refresh(t.refreshToken)).status).toBe(401);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['garbage', 'not-a-jwt'],
    ['an object', { $ne: null }],
    ['over-long', 'x'.repeat(10_000)],
    ['signed with the wrong secret', jwt.sign({ sub: 'u-coach' }, 'c'.repeat(48))],
  ])('malformed or forged (%s) → refused, nothing looked up or written', async (_label, token) => {
    const res = await refresh(token);
    expect([400, 401]).toContain(res.status);
    expect(WRITES).toHaveLength(0);
  });

  it('a database that cannot be read issues no session', async () => {
    const t = await login();
    FAULT.lookup = true;
    const res = await refresh(t.refreshToken);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken/);
    expect(WRITES).toHaveLength(1); // only the sign-in's
  });

  it('survives a restart: a freshly loaded server refreshes a token issued before it', async () => {
    const t = await login();
    let restarted: unknown;
    jest.isolateModules(() => { restarted = require('../src/app').createApp(); });
    expect((await refresh(t.refreshToken, restarted)).status).toBe(200);
  });
});

describe('dual-read: nobody is logged out by the change', () => {
  it('a legacy row (raw value, no hash — as the previous build writes it) still refreshes, and is replaced by a hashed one', async () => {
    const legacy = legacyToken();
    TOKENS.push({ id: 'legacy-1', token: legacy, tokenHash: null, userId: 'u-coach', expiresAt: week() });
    const r = await refresh(legacy);
    expect(r.status).toBe(200);
    expect(TOKENS.find((t) => t.id === 'legacy-1')).toBeUndefined();
    expect(TOKENS).toHaveLength(1);
    expect(TOKENS[0].token).toBeNull();
    expect(TOKENS[0].tokenHash).toBe(hashRefreshToken(r.body.data.refreshToken));
    expect((await refresh(legacy)).status).toBe(401); // and it is single-use like any other
  });

  it('a migrated row (raw value kept, hash backfilled) is found by its hash', async () => {
    const legacy = legacyToken();
    TOKENS.push({ id: 'legacy-2', token: legacy, tokenHash: hashRefreshToken(legacy), userId: 'u-coach', expiresAt: week() });
    expect((await refresh(legacy)).status).toBe(200);
    expect(TOKENS.find((t) => t.id === 'legacy-2')).toBeUndefined();
  });

  it('the raw fallback never matches a row that has a hash (a backfilled hash is authoritative)', async () => {
    const legacy = legacyToken();
    TOKENS.push({ id: 'legacy-3', token: legacy, tokenHash: 'f'.repeat(64), userId: 'u-coach', expiresAt: week() });
    expect((await refresh(legacy)).status).toBe(401);
  });

  it('logout ends a legacy session, a migrated one and a hashed one alike', async () => {
    const a = legacyToken(); const b = legacyToken();
    TOKENS.push({ id: 'l-a', token: a, tokenHash: null, userId: 'u-coach', expiresAt: week() });
    TOKENS.push({ id: 'l-b', token: b, tokenHash: hashRefreshToken(b), userId: 'u-coach', expiresAt: week() });
    const c = (await login()).refreshToken;
    for (const t of [a, b, c]) expect((await logout(t)).status).toBe(200);
    expect(TOKENS).toHaveLength(0);
    await settle();
    expect(published.filter((e) => e.eventType === 'user.logout')).toHaveLength(3);
  });

  it('logout of an unknown token is a no-op and records no logout', async () => {
    await login();
    expect((await logout(legacyToken())).status).toBe(200);
    expect(TOKENS).toHaveLength(1);
    await settle();
    expect(published.filter((e) => e.eventType === 'user.logout')).toHaveLength(0);
  });
});

describe('source guarantees', () => {
  const AUTH = fs.readFileSync(path.join(__dirname, '../src/services/auth.service.ts'), 'utf8');

  it('no code path writes a raw refresh token or looks one up by its raw value first', () => {
    expect(AUTH).not.toMatch(/refreshToken\.create\(\{\s*data:\s*\{[^}]*\btoken\s*:/);
    expect(AUTH).not.toMatch(/refreshToken\.findUnique\(\{\s*where:\s*\{\s*token\s*[:,}]/);
    expect(AUTH).not.toMatch(/refreshToken\.delete\(/);
    const find = AUTH.slice(AUTH.indexOf('async function findStoredRefreshToken'));
    expect(find.indexOf('tokenHash: hashRefreshToken(token)')).toBeLessThan(find.indexOf('tokenHash: null'));
  });

  it('nothing else in the application reads the raw column', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
    const offenders = walk(path.join(__dirname, '../src'))
      .filter((f) => !f.endsWith('auth.service.ts'))
      .filter((f) => /refreshToken\.(find\w*|delete\w*|update\w*)\(\{\s*where:\s*\{[^}]*\btoken\b/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
