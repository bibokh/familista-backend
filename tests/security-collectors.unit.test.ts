/**
 * Cyber Defense · Step 4 — collectors
 *
 * Five signals the platform already produces become `security.*` events, and
 * nothing about any response changes. Driven through the real `createApp()`,
 * with a database that answers the handful of queries these paths make and an
 * event transport that records what was published.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
// Read once at load by the limiter: a small account bucket makes a real 429 cheap.
process.env.RATE_ACCOUNT_CAPACITY = '2';

const USERS: Record<string, Record<string, unknown>> = {};

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === '$transaction') return async (fns: unknown) =>
        (Array.isArray(fns) ? [] : (fns as (tx: unknown) => unknown)({}));
      if (k === 'user') return {
        findUnique: async (q: { where: { email?: string; id?: string } }) =>
          Object.values(USERS).find((u) => u.email === q.where.email || u.id === q.where.id) ?? null,
        findFirst: async (q: { where: { id?: string } }) =>
          Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
        update: async () => ({}),
      };
      if (k === 'refreshToken') return { findUnique: async () => null, findFirst: async () => null, delete: async () => ({}), deleteMany: async () => ({ count: 0 }), create: async () => ({}) };
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
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { hashPassword } from '../src/utils/password';
import {
  recordRateLimitHit, resetSecurityCollectors, securityCollectorStats,
  MAX_PER_TYPE_PER_MINUTE,
} from '../src/cyber-defense/collectors';

let published: FamilistaEvent[] = [];
const transport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as unknown as EventTransport;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};
const security = () => published.filter((e) => e.eventType.startsWith('security.'));
const ofType = (t: string) => security().filter((e) => e.eventType === t);

const app = createApp();
let n = 0;
/** A distinct address per test, so one test's flood cap never hides another's event. */
const nextIp = () => `198.51.${100 + (n += 1)}.7`;

beforeAll(async () => {
  const passwordHash = await hashPassword('right-password');
  USERS.known = {
    id: 'u-known', email: 'known@familista.test', passwordHash, isActive: true, role: 'COACH',
    clubId: 'c-1', currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null,
    club: { name: 'Club' },
  };
  USERS.inactive = { ...USERS.known, id: 'u-off', email: 'off@familista.test', isActive: false };
  // Its own account: the account bucket is deliberately small in this file.
  USERS.fresh = { ...USERS.known, id: 'u-fresh', email: 'fresh@familista.test' };
});

beforeEach(() => {
  published = [];
  setEventTransport(transport);
  resetSecurityCollectors();
});

afterAll(async () => { await settle(); setEventTransport(null); });

function expectValid(e: FamilistaEvent) {
  const check = validateEventPayload(e.eventType, 1, e.payload);
  expect(`${e.eventType}: ${check.ok ? 'ok' : JSON.stringify((check as { issues?: string[] }).issues)}`)
    .toBe(`${e.eventType}: ok`);
}

describe('a refused sign-in', () => {
  it.each([
    ['nobody@familista.test', 'x', 'UNKNOWN_ACCOUNT', false],
    ['off@familista.test', 'right-password', 'INACTIVE_ACCOUNT', true],
    ['known@familista.test', 'wrong-password', 'BAD_PASSWORD', true],
  ])('%s → security.login.failed (%s), and the response is unchanged', async (email, password, reason, knownAccount) => {
    const ip = nextIp();
    const res = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password });
    await settle();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid email or password' });

    const [e] = ofType('security.login.failed');
    expect(e).toBeDefined();
    expectValid(e);
    expect(e.payload).toMatchObject({
      category: 'AUTHENTICATION', outcome: 'FAILURE', actor: { type: 'ANONYMOUS', role: null },
      source: { component: 'AUTH', ipPrefix: ip.replace(/\.\d+$/, '.0/24') },
      evidence: { reason, knownAccount },
    });
    expect(e.actorUserId ?? null).toBeNull();
  });

  it('never records the e-mail or the password that was tried', async () => {
    await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', nextIp())
      .send({ email: 'known@familista.test', password: 'wrong-password' });
    await settle();
    const blob = JSON.stringify(security());
    expect(blob).not.toContain('known@familista.test');
    expect(blob).not.toContain('wrong-password');
  });

  it('a successful sign-in produces no security event', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', nextIp())
      .send({ email: 'fresh@familista.test', password: 'right-password' });
    await settle();
    expect(res.status).toBe(200);
    expect(security()).toEqual([]);
  });
});

describe('a refresh token presented again after rotation', () => {
  it('→ security.refresh.reused, attributed to the token’s verified subject; response unchanged', async () => {
    const token = jwt.sign({ sub: 'u-known', jti: 'j-1' }, process.env.JWT_REFRESH_SECRET, { expiresIn: '1h' });
    const res = await request(app).post('/api/v1/auth/refresh').set('X-Forwarded-For', nextIp())
      .send({ refreshToken: token });
    await settle();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: 'Refresh token expired or revoked' });
    const [e] = ofType('security.refresh.reused');
    expect(e).toBeDefined();
    expectValid(e);
    expect(e.actorUserId).toBe('u-known');
    expect(e.payload).toMatchObject({ category: 'SESSION', outcome: 'BLOCKED', severity: 'MEDIUM' });
    expect(JSON.stringify(e)).not.toContain(token);
  });

  it('a token whose signature does not verify is not a reuse', async () => {
    const forged = jwt.sign({ sub: 'u-known' }, 'not-the-secret-'.repeat(4));
    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: forged });
    await settle();
    expect(res.status).toBe(401);
    expect(ofType('security.refresh.reused')).toEqual([]);
  });
});

describe('a refused browser origin', () => {
  it('→ security.origin.rejected with the origin host only; response unchanged', async () => {
    const res = await request(app).options('/api/v1/auth/login')
      .set('Origin', 'https://probe.attacker.example').set('Access-Control-Request-Method', 'POST')
      .set('X-Forwarded-For', nextIp());
    await settle();
    expect(res.status).toBe(403);
    const [e] = ofType('security.origin.rejected');
    expectValid(e);
    expect(e.payload).toMatchObject({
      category: 'NETWORK', source: { component: 'CORS' },
      evidence: { method: 'OPTIONS', preflight: true, originHost: 'probe.attacker.example' },
    });
    // The 403 is recorded once, as an origin refusal, not also as access denied.
    expect(ofType('security.access.denied')).toEqual([]);
  });
});

describe('a 403 from an access check', () => {
  it('→ security.access.denied with the user, role and route family; response unchanged', async () => {
    const token = jwt.sign({ sub: 'u-known', role: 'COACH' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
    const res = await request(app).get('/api/v1/system/overview')
      .set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', nextIp());
    await settle();
    expect(res.status).toBe(403);
    const [e] = ofType('security.access.denied');
    expect(e).toBeDefined();
    expectValid(e);
    expect(e.actorUserId).toBe('u-known');
    expect(e.payload).toMatchObject({
      category: 'ACCESS', actor: { type: 'USER', role: 'COACH' },
      evidence: { method: 'GET', area: 'system' },
    });
  });
});

describe('a rate-limit refusal', () => {
  it('a real 429 → security.ratelimit.exceeded naming the bucket; response unchanged', async () => {
    const ip = nextIp();
    const attempt = () => request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip)
      .send({ email: 'target@familista.test', password: 'x' });
    await attempt(); await attempt();
    const res = await attempt();
    await settle();
    expect(res.status).toBe(429);
    expect(res.body.message).toBe('Too many attempts for this account. Try again later.');
    expect(res.headers['retry-after']).toBeDefined();
    const [e] = ofType('security.ratelimit.exceeded');
    expect(e).toBeDefined();
    expectValid(e);
    expect(e.payload).toMatchObject({
      category: 'ABUSE', severity: 'MEDIUM', source: { component: 'RATE_LIMIT' },
      evidence: { bucket: 'account', method: 'POST' },
    });
  });
});

describe('a flood cannot become a write flood', () => {
  const fakeReq = (ip: string) => ({ ip, method: 'GET', originalUrl: '/api/v1/x', headers: {} }) as never;

  it('one event per source per minute; the next one written says how many were held back', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    for (let i = 0; i < 25; i += 1) recordRateLimitHit(fakeReq('203.0.113.9'), 'ip');
    await settle();
    expect(ofType('security.ratelimit.exceeded')).toHaveLength(1);
    expect(securityCollectorStats().suppressed).toBe(24);

    now.mockReturnValue(1_000_000 + 61_000);
    recordRateLimitHit(fakeReq('203.0.113.9'), 'ip');
    await settle();
    const events = ofType('security.ratelimit.exceeded');
    expect(events).toHaveLength(2);
    expect((events[1].payload as { evidence: Record<string, unknown> }).evidence.suppressedBefore).toBe(24);
    expectValid(events[1]);
    now.mockRestore();
  });

  it('at most MAX_PER_TYPE_PER_MINUTE per signal across every source', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(5_000_000);
    for (let i = 0; i < MAX_PER_TYPE_PER_MINUTE + 40; i += 1) recordRateLimitHit(fakeReq(`10.${i >> 8}.${i & 255}.1`), 'ip');
    await settle();
    expect(ofType('security.ratelimit.exceeded')).toHaveLength(MAX_PER_TYPE_PER_MINUTE);
    expect(securityCollectorStats().overCap).toBe(40);
    now.mockRestore();
  });

  it('a failing transport never fails the request', async () => {
    setEventTransport({
      name: 'BROKEN', async append() { throw new Error('outbox is down'); }, async read() { return []; },
    } as unknown as EventTransport);
    const res = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', nextIp())
      .send({ email: 'nobody@familista.test', password: 'x' });
    await settle();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid email or password' });
  });
});
