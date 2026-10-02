/**
 * Cyber Defense, R7 — administrators and a second factor; the sign-in lockout
 *
 * With MFA_REQUIRED_FOR_ADMINS=true, a SUPER_ADMIN or CLUB_ADMIN who has
 * enrolled must give a code at sign-in; one who has not gets a session that can
 * only enrol; a session that did not pass a code is refused once they have; and
 * none of them can remove the factor. Off, nothing changes. And the lockout is
 * enforced: five failures on one account and the right password is refused too.
 * Driven through the real `createApp()`.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
process.env.MFA_ENCRYPTION_KEY = 'test-only-mfa-key-'.padEnd(48, 'x');
process.env.RATE_AUTH_CAPACITY = '100000';
process.env.RATE_ACCOUNT_CAPACITY = '100000';

type Row = Record<string, unknown>;
const USERS: Record<string, Row> = {};
const MFA = new Map<string, Row>();
const CHALLENGES = new Map<string, Row>();
const ATTEMPTS: Row[] = [];

function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') { if (!(cond as Row[]).some((w) => matches(row, w))) return false; continue; }
    const v = row[key];
    if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('lt' in c) { if (v === null || v === undefined || !((v as number) < (c.lt as number))) return false; continue; }
      if ('gt' in c) { if (v === null || v === undefined || !((v as number) > (c.gt as number))) return false; continue; }
      if ('gte' in c) { if (v === null || v === undefined || !((v as number) >= (c.gte as number))) return false; continue; }
      if ('not' in c && c.not === null) { if (v === null || v === undefined) return false; continue; }
    }
    if (v instanceof Date && cond instanceof Date) { if (v.getTime() !== cond.getTime()) return false; continue; }
    if (v !== cond) return false;
  }
  return true;
}
function applyData(row: Row, data: Row): Row {
  for (const [key, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) { row[key] = Number(row[key] ?? 0) + Number((v as Row).increment); continue; }
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && String((v as object).constructor?.name).includes('Null')) { row[key] = null; continue; }
    row[key] = v;
  }
  return row;
}
let seq = 0;

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findUnique: async (q: { where: { email?: string; id?: string } }) =>
          Object.values(USERS).find((u) => u.email === q.where.email || u.id === q.where.id) ?? null,
        findFirst: async (q: { where: Row }) => Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
        update: async () => ({}),
      };
      if (k === 'refreshToken') return { create: async () => ({}), findUnique: async () => null, deleteMany: async () => ({ count: 0 }) };
      if (k === 'loginAttempt') return {
        count: async (q: { where: Row }) => ATTEMPTS.filter((a) => matches(a, q.where)).length,
        create: async (q: { data: Row }) => { ATTEMPTS.push({ ...q.data, createdAt: new Date() }); return {}; },
      };
      if (k === 'mFASetting') return {
        findUnique: async (q: { where: { userId: string } }) => (MFA.has(q.where.userId) ? { ...MFA.get(q.where.userId) } : null),
        upsert: async (q: { where: { userId: string }; create: Row; update: Row }) => {
          const cur = MFA.get(q.where.userId);
          const next = cur ? applyData({ ...cur }, q.update)
            : applyData({ method: 'NONE', enabledAt: null, backupCodesHash: null, lastVerifiedAt: null, codeFailures: 0, codeWindowStart: null, lastTotpStep: null, enforcedAt: null }, q.create);
          MFA.set(q.where.userId, next); return next;
        },
        update: async (q: { where: { userId: string }; data: Row }) => {
          const next = applyData({ ...(MFA.get(q.where.userId) ?? {}) }, q.data);
          MFA.set(q.where.userId, next); return next;
        },
        updateMany: async (q: { where: Row; data: Row }) => {
          const row = MFA.get(String(q.where.userId));
          if (!row || !matches(row, q.where)) return { count: 0 };
          MFA.set(String(q.where.userId), applyData({ ...row }, q.data));
          return { count: 1 };
        },
      };
      if (k === 'mFAChallenge') return {
        create: async (q: { data: Row }) => {
          seq += 1;
          const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
          const row = { id, consumedAt: null, attempts: 0, createdAt: new Date(), ...q.data };
          CHALLENGES.set(id, row); return { ...row };
        },
        findUnique: async (q: { where: { id: string } }) => (CHALLENGES.has(q.where.id) ? { ...CHALLENGES.get(q.where.id) } : null),
        updateMany: async (q: { where: Row; data: Row }) => {
          const row = CHALLENGES.get(String(q.where.id));
          if (!row || !matches(row, q.where)) return { count: 0 };
          CHALLENGES.set(String(q.where.id), applyData({ ...row }, q.data));
          return { count: 1 };
        },
      };
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import jwt from 'jsonwebtoken';
import { hashPassword } from '../src/utils/password';
import { totpFor, base32Decode } from '../src/auth-prod/mfa.service';
import { signToken } from '../src/security/jwt-tokens';
import { sessionMfaState, assertSessionMayProceed, SETUP_ONLY_ROUTES } from '../src/auth-prod/admin-mfa';
import { forgetIdentity } from '../src/middleware/auth.middleware';

const app = createApp();
const ADMIN = 'u-club-admin';
const SUPER = 'u-super';
const COACH = 'u-coach';
const token = (id: string, role: string, extra: Row = {}) => signToken('access', { sub: id, role, tv: 0, ...extra }, { expiresIn: '10m' });
const as = (t: string) => ({
  get: (p: string) => request(app).get(`/api/v1${p}`).set('Authorization', `Bearer ${t}`),
  post: (p: string, body: Row = {}) => request(app).post(`/api/v1${p}`).set('Authorization', `Bearer ${t}`).send(body),
});
const codeIn = (base32: string, steps: number) => totpFor(base32Decode(base32), Math.floor(Date.now() / 1000) + steps * 30);
const login = (email: string, password = 'right-password') => request(app).post('/api/v1/auth/login').send({ email, password });

beforeAll(async () => {
  const passwordHash = await hashPassword('right-password');
  const base = { passwordHash, isActive: true, clubId: 'c-1', currentClubId: null, currentTeamId: null, tokenVersion: 0, club: { name: 'C' }, platformAdmin: null };
  USERS.admin = { ...base, id: ADMIN, email: 'admin@familista.test', role: 'CLUB_ADMIN', firstName: 'A', lastName: 'Admin' };
  USERS.super = { ...base, id: SUPER, email: 'super@familista.test', role: 'SUPER_ADMIN', firstName: 'S', lastName: 'Super' };
  USERS.coach = { ...base, id: COACH, email: 'coach@familista.test', role: 'COACH', firstName: 'C', lastName: 'Coach' };
});

beforeEach(() => {
  MFA.clear(); CHALLENGES.clear(); ATTEMPTS.length = 0;
  delete process.env.MFA_REQUIRED_FOR_ADMINS;
  forgetIdentity();
});
afterAll(() => { delete process.env.MFA_REQUIRED_FOR_ADMINS; });

/** Enrol through the API with a session that passed a code (or with the switch off). */
async function enrol(id: string, role: string): Promise<string> {
  const t = token(id, role, { mfa: true });
  const e = await as(t).post('/auth/mfa/enroll');
  expect(e.status).toBe(201);
  const base32 = e.body.data.base32 as string;
  const c = await as(t).post('/auth/mfa/confirm', { code: codeIn(base32, 0) });
  expect(c.status).toBe(201);
  return base32;
}

describe('the rule, as a table', () => {
  it('off: every session is full', () => {
    expect(sessionMfaState('CLUB_ADMIN', false, false)).toBe('full');
    expect(sessionMfaState('SUPER_ADMIN', false, true)).toBe('full');
  });

  it('on: administrators without a code are setup-only (not enrolled) or refused (enrolled); others are untouched', () => {
    process.env.MFA_REQUIRED_FOR_ADMINS = 'true';
    expect(sessionMfaState('CLUB_ADMIN', false, false)).toBe('setup-only');
    expect(sessionMfaState('SUPER_ADMIN', false, true)).toBe('reauth');
    expect(sessionMfaState('CLUB_ADMIN', true, true)).toBe('full');
    expect(sessionMfaState('COACH', false, false)).toBe('full');
    expect(sessionMfaState('PLAYER', false, false)).toBe('full');
  });

  it('only "true" switches it on', () => {
    process.env.MFA_REQUIRED_FOR_ADMINS = '1';
    expect(sessionMfaState('CLUB_ADMIN', false, false)).toBe('full');
  });

  it('a setup-only session reaches exactly the enrolment routes, under any API version', () => {
    expect([...SETUP_ONLY_ROUTES].sort()).toEqual(['GET /auth/me', 'GET /auth/mfa', 'POST /auth/logout', 'POST /auth/mfa/confirm', 'POST /auth/mfa/enroll']);
    expect(() => assertSessionMayProceed('setup-only', 'GET', '/api/v1/auth/me')).not.toThrow();
    expect(() => assertSessionMayProceed('setup-only', 'POST', '/api/v2/auth/mfa/enroll/')).not.toThrow();
    expect(() => assertSessionMayProceed('setup-only', 'POST', '/api/v1/auth/mfa/disable')).toThrow(/Set up two-step sign-in/);
    expect(() => assertSessionMayProceed('setup-only', 'GET', '/api/v1/auth/me/../../players')).toThrow();
    expect(() => assertSessionMayProceed('reauth', 'GET', '/api/v1/auth/me')).toThrow(/Sign in again/);
  });
});

describe('switched off (the default), nothing changes for an administrator', () => {
  it('a session without a code is full, and sign-in asks for none', async () => {
    expect((await as(token(ADMIN, 'CLUB_ADMIN')).post('/realtime/ticket')).status).toBe(200);
    await enrol(ADMIN, 'CLUB_ADMIN');
    const res = await login('admin@familista.test');
    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
    expect(res.body.data.mfaEnrolmentRequired).toBeUndefined();
  });

  it('a club administrator may set up two-step sign-in; a coach may not', async () => {
    expect((await as(token(ADMIN, 'CLUB_ADMIN')).get('/auth/mfa')).status).toBe(200);
    expect((await as(token(COACH, 'COACH')).get('/auth/mfa')).status).toBe(403);
  });
});

describe('switched on', () => {
  beforeEach(() => { process.env.MFA_REQUIRED_FOR_ADMINS = 'true'; });

  it('an administrator who has not enrolled signs in to a setup-only session', async () => {
    const res = await login('admin@familista.test');
    expect(res.status).toBe(200);
    expect(res.body.data.mfaEnrolmentRequired).toBe(true);
    const at = res.body.data.tokens.accessToken as string;
    expect((jwt.decode(at) as Row).mfa).toBeUndefined();

    const refused = await as(at).post('/realtime/ticket');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('MFA_ENROLMENT_REQUIRED');
    expect((await as(at).get('/players')).body.code).toBe('MFA_ENROLMENT_REQUIRED');

    const me = await as(at).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.mfaEnrolmentRequired).toBe(true);
    expect((await as(at).get('/auth/mfa')).status).toBe(200);
    expect((await as(at).post('/auth/mfa/enroll')).status).toBe(201);
  });

  it('once enrolled, a session that did not pass a code is refused, and sign-in asks for the code', async () => {
    const base32 = await enrol(SUPER, 'SUPER_ADMIN');
    const stale = await as(token(SUPER, 'SUPER_ADMIN')).post('/realtime/ticket');
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('MFA_REAUTH_REQUIRED');

    const step1 = await login('super@familista.test');
    expect(step1.body.data).toMatchObject({ mfaRequired: true });
    expect(step1.body.data.tokens).toBeUndefined();

    const step2 = await request(app).post('/api/v1/auth/login/mfa').send({ challenge: step1.body.data.challenge, code: codeIn(base32, 1) });
    expect(step2.status).toBe(200);
    const at = step2.body.data.tokens.accessToken as string;
    expect((jwt.decode(at) as Row).mfa).toBe(true);
    expect((await as(at).post('/realtime/ticket')).status).toBe(200);
  });

  it('a session that passed a code keeps it across refresh (the claim rides the refresh token)', async () => {
    const rt = signToken('refresh', { sub: SUPER, role: 'SUPER_ADMIN', tv: 0, mfa: true, jti: 'x' }, { expiresIn: 60 });
    expect((jwt.decode(rt) as Row).mfa).toBe(true);
  });

  it('an administrator cannot turn two-step sign-in off', async () => {
    const base32 = await enrol(ADMIN, 'CLUB_ADMIN');
    const res = await as(token(ADMIN, 'CLUB_ADMIN', { mfa: true })).post('/auth/mfa/disable', { code: codeIn(base32, 1) });
    expect(res.status).toBe(403);
    expect(MFA.get(ADMIN)?.enabledAt).toBeTruthy();
  });

  it('other roles are untouched', async () => {
    expect((await as(token(COACH, 'COACH')).post('/realtime/ticket')).status).toBe(200);
    const res = await login('coach@familista.test');
    expect(res.status).toBe(200);
    expect(res.body.data.mfaEnrolmentRequired).toBeUndefined();
  });
});

describe('the sign-in lockout is enforced', () => {
  it('five failures on one account, and then the right password is refused with 429', async () => {
    for (let i = 0; i < 5; i += 1) expect((await login('coach@familista.test', 'wrong')).status).toBe(401);
    const locked = await login('COACH@familista.test');
    expect(locked.status).toBe(429);
    expect(locked.body.data?.tokens).toBeUndefined();
  });

  it('four failures do not lock, and an unknown account counts too', async () => {
    for (let i = 0; i < 4; i += 1) await login('coach@familista.test', 'wrong');
    expect((await login('coach@familista.test')).status).toBe(200);
    for (let i = 0; i < 5; i += 1) await login('nobody@familista.test', 'wrong');
    expect((await login('nobody@familista.test')).status).toBe(429);
  });

  it('keeps only a hash of the address', () => {
    for (const a of ATTEMPTS) {
      expect(JSON.stringify(a)).not.toMatch(/@familista\.test/);
      expect(a.emailHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
