/**
 * Cyber Defense · Step 6 — owner two-step sign-in: enrolment and recovery codes
 *
 * The platform owner can enrol an authenticator app, receive recovery codes,
 * replace them, and turn two-step sign-in off — each with a real code. Sign-in
 * itself does not ask for a code in this build (enforcement is a later step),
 * and that is pinned here too. Driven through the real `createApp()`.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
process.env.MFA_ENCRYPTION_KEY = 'test-only-mfa-key-'.padEnd(48, 'x');

type Row = Record<string, unknown>;
const USERS: Record<string, Row> = {};
const MFA = new Map<string, Row>();

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findUnique: async (q: { where: { email?: string; id?: string } }) =>
          Object.values(USERS).find((u) => u.email === q.where.email || u.id === q.where.id) ?? null,
        findFirst: async (q: { where: { id?: string } }) => Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
        update: async () => ({}),
      };
      if (k === 'refreshToken') return { create: async () => ({}), findUnique: async () => null, delete: async () => ({}) };
      if (k === 'mFASetting') return {
        findUnique: async (q: { where: { userId: string } }) => MFA.get(q.where.userId) ?? null,
        upsert: async (q: { where: { userId: string }; create: Row; update: Row }) => {
          const cur = MFA.get(q.where.userId);
          const next = cur ? { ...cur, ...q.update } : { method: 'NONE', enabledAt: null, backupCodesHash: null, lastVerifiedAt: null, ...q.create };
          MFA.set(q.where.userId, next); return next;
        },
        update: async (q: { where: { userId: string }; data: Row }) => {
          const next = { ...(MFA.get(q.where.userId) ?? {}), ...q.data };
          for (const [key, v] of Object.entries(next)) if (v && typeof v === 'object' && (v as { toJSON?: unknown }).toJSON === undefined && String(v) === 'JsonNull') next[key] = null;
          MFA.set(q.where.userId, next); return next;
        },
      };
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
import { config } from '../src/config';
import { hashPassword } from '../src/utils/password';
import {
  totpFor, base32Decode, resetMfaThrottle, MAX_CODE_FAILURES,
} from '../src/auth-prod/mfa.service';

const app = createApp();
const OWNER = 'u-owner';
const COACH = 'u-coach';
const tokenFor = (id: string, role: string) =>
  jwt.sign({ sub: id, role }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const asOwner = (r: { set: (k: string, v: string) => unknown }) => r.set('Authorization', `Bearer ${tokenFor(OWNER, 'SUPER_ADMIN')}`);
const get = (p: string) => asOwner(request(app).get(`/api/v1${p}`)) as ReturnType<typeof request>;
const post = (p: string, body: Row = {}) => (asOwner(request(app).post(`/api/v1${p}`)) as ReturnType<typeof request>).send(body);
const codeNow = (base32: string) => totpFor(base32Decode(base32));

beforeAll(async () => {
  const passwordHash = await hashPassword('right-password');
  const base = { passwordHash, isActive: true, clubId: 'c-1', currentClubId: null, currentTeamId: null, tokenVersion: 0, club: { name: 'C' } };
  USERS.owner = { ...base, id: OWNER, email: 'owner@familista.test', role: 'SUPER_ADMIN', platformAdmin: null };
  USERS.coach = { ...base, id: COACH, email: 'coach@familista.test', role: 'COACH', platformAdmin: null };
});

beforeEach(() => { MFA.clear(); resetMfaThrottle(); });

/** Enrol and confirm; returns the setup key and the recovery codes. */
async function enrolOwner(): Promise<{ base32: string; recoveryCodes: string[] }> {
  const e = await post('/auth/mfa/enroll');
  const base32 = e.body.data.base32;
  const c = await post('/auth/mfa/confirm', { code: codeNow(base32) });
  return { base32, recoveryCodes: c.body.data.recoveryCodes };
}

describe('who may use it', () => {
  it('requires a session', async () => {
    expect((await request(app).get('/api/v1/auth/mfa')).status).toBe(401);
  });

  it('is the platform owner’s — a club role is refused', async () => {
    const res = await request(app).get('/api/v1/auth/mfa').set('Authorization', `Bearer ${tokenFor(COACH, 'COACH')}`);
    expect(res.status).toBe(403);
  });
});

describe('enrolment', () => {
  it('starts off, and says it is not enforced', async () => {
    const res = await get('/auth/mfa');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ configured: true, enrolled: false, pending: false, recoveryCodesRemaining: 0, enforced: false });
  });

  it('issues a setup key once, marked no-store, and stores it only encrypted', async () => {
    const res = await post('/auth/mfa/enroll');
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.base32).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.data.otpauth).toMatch(/^otpauth:\/\/totp\/Familista:owner%40familista\.test\?secret=[A-Z2-7]{32}&issuer=Familista/);
    const stored = MFA.get(OWNER)!;
    expect(stored.enabledAt).toBeNull();
    expect(String(stored.secretEncrypted)).not.toContain(res.body.data.base32);
    expect((await get('/auth/mfa')).body.data).toMatchObject({ pending: true, enrolled: false });
  });

  it('a wrong code is a 400, never a 401 that would end the session', async () => {
    await post('/auth/mfa/enroll');
    const res = await post('/auth/mfa/confirm', { code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid code');
  });

  it('the right code turns it on and returns eight recovery codes — and nothing else', async () => {
    const e = await post('/auth/mfa/enroll');
    const res = await post('/auth/mfa/confirm', { code: codeNow(e.body.data.base32) });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.recoveryCodes).toHaveLength(8);
    for (const c of res.body.data.recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{16}$/);
    expect(Object.keys(res.body.data).sort()).toEqual(['enabledAt', 'recoveryCodes']);
    const stored = MFA.get(OWNER)!;
    expect(JSON.stringify(stored.backupCodesHash)).not.toContain(res.body.data.recoveryCodes[0]);

    const s = (await get('/auth/mfa')).body.data;
    expect(s).toMatchObject({ enrolled: true, pending: false, recoveryCodesRemaining: 8, enforced: false });
    expect(JSON.stringify(s)).not.toMatch(/secret|hash/i);
  });

  it('cannot be confirmed twice', async () => {
    const { base32 } = await enrolOwner();
    expect((await post('/auth/mfa/confirm', { code: codeNow(base32) })).status).toBe(400);
  });
});

describe('recovery codes', () => {
  it('are replaced with an app code, and the old ones stop working', async () => {
    const { base32, recoveryCodes } = await enrolOwner();
    const res = await post('/auth/mfa/recovery-codes', { code: codeNow(base32) });
    expect(res.status).toBe(201);
    expect(res.body.data.recoveryCodes).toHaveLength(8);
    expect(res.body.data.recoveryCodes).not.toEqual(recoveryCodes);
    expect((await post('/auth/mfa/disable', { code: recoveryCodes[0] })).status).toBe(400);
  });

  it('cannot be replaced with a recovery code', async () => {
    const { recoveryCodes } = await enrolOwner();
    expect((await post('/auth/mfa/recovery-codes', { code: recoveryCodes[0] })).status).toBe(400);
  });
});

describe('turning it off', () => {
  it('needs a code — a session alone is refused', async () => {
    await enrolOwner();
    expect((await post('/auth/mfa/disable')).status).toBe(400);
    expect((await post('/auth/mfa/disable', { code: '123456' })).status).toBe(400);
    expect((await get('/auth/mfa')).body.data.enrolled).toBe(true);
  });

  it('accepts a recovery code as displayed (dashes, lower case), once', async () => {
    const { recoveryCodes } = await enrolOwner();
    const shown = recoveryCodes[0].toLowerCase().match(/.{4}/g)!.join('-');
    const res = await post('/auth/mfa/disable', { code: shown });
    expect(res.status).toBe(200);
    expect((await get('/auth/mfa')).body.data).toMatchObject({ enrolled: false, pending: false, recoveryCodesRemaining: 0 });
  });

  it('the older /phase-o disable route needs a code too', async () => {
    await enrolOwner();
    const res = await post('/phase-o/auth/mfa/disable');
    expect(res.status).toBe(400);
    expect(MFA.get(OWNER)!.enabledAt).toBeTruthy();
  });
});

describe('guessing is limited', () => {
  it(`after ${MAX_CODE_FAILURES} wrong codes even the right one is refused with 429`, async () => {
    const { base32 } = await enrolOwner();
    for (let i = 0; i < MAX_CODE_FAILURES; i += 1) {
      expect((await post('/auth/mfa/disable', { code: '000000' })).status).toBe(400);
    }
    const res = await post('/auth/mfa/disable', { code: codeNow(base32) });
    expect(res.status).toBe(429);
    expect(MFA.get(OWNER)!.enabledAt).toBeTruthy();
  });
});

describe('not enforced in this build', () => {
  it('an enrolled owner still signs in with the password alone', async () => {
    await enrolOwner();
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'owner@familista.test', password: 'right-password' });
    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
  });
});

describe('a server without an MFA key', () => {
  const saved = config.mfa.encryptionKey;
  afterEach(() => { (config.mfa as { encryptionKey: string }).encryptionKey = saved; });

  it('says so — status reports configured:false and enrolment answers 503, not 500', async () => {
    (config.mfa as { encryptionKey: string }).encryptionKey = '';
    expect((await get('/auth/mfa')).body.data.configured).toBe(false);
    const res = await post('/auth/mfa/enroll');
    expect(res.status).toBe(503);
    expect(MFA.get(OWNER)).toBeUndefined();
  });
});
