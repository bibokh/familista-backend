/**
 * Cyber Defense · Step 7 — the owner's two-step sign-in, required at sign-in
 *
 * With enforcement on, the right password answers a single-use challenge and
 * nothing else; only the challenge plus an accepted code becomes a session.
 * Pinned here: the switch (who, how it is proven, what it records), the two
 * steps, replay, races, restarts, malformed input, failing closed, and every
 * path that must not become a way around it. Driven through the real
 * `createApp()` over an in-memory stand-in for the three tables involved, whose
 * conditional updates are atomic the way a single Postgres statement is.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
process.env.MFA_ENCRYPTION_KEY = 'test-only-mfa-key-'.padEnd(48, 'x');
// The credential buckets are exercised on their own below; here they must not
// cut a long suite short.
process.env.RATE_AUTH_CAPACITY = '100000';
process.env.RATE_ACCOUNT_CAPACITY = '100000';

type Row = Record<string, unknown>;
const USERS: Record<string, Row> = {};
const MFA = new Map<string, Row>();
const CHALLENGES = new Map<string, Row>();
const FAULT = { mfaRead: false };
/**
 * A barrier at the consume step: when set to n, the first n consume calls wait
 * for each other, so n requests that all passed verification reach the final
 * atomic step together — the race the consume guard exists for.
 */
const BARRIER = { size: 0, waiting: [] as Array<() => void> };
async function atBarrier(): Promise<void> {
  if (BARRIER.size <= 0) return;
  await new Promise<void>((resolve) => {
    BARRIER.waiting.push(resolve);
    if (BARRIER.waiting.length >= BARRIER.size) { BARRIER.size = 0; BARRIER.waiting.splice(0).forEach((r) => r()); }
  });
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}
/** The subset of Prisma's `where` these services use. */
function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') { if (!(cond as Row[]).some((w) => matches(row, w))) return false; continue; }
    const v = row[key];
    if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('lt' in c) { if (v === null || v === undefined || !((v as number) < (c.lt as number))) return false; continue; }
      if ('gt' in c) { if (v === null || v === undefined || !((v as number) > (c.gt as number))) return false; continue; }
      if ('not' in c && c.not === null) { if (v === null || v === undefined) return false; continue; }
      if ('equals' in c) { if (JSON.stringify(v) !== JSON.stringify(c.equals)) return false; continue; }
    }
    if (!same(v, cond)) return false;
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
let challengeSeq = 0;

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findUnique: async (q: { where: { email?: string; id?: string } }) =>
          Object.values(USERS).find((u) => u.email === q.where.email || u.id === q.where.id) ?? null,
        findFirst: async (q: { where: Row }) =>
          Object.values(USERS).find((u) => u.id === q.where.id && (q.where.isActive === undefined || u.isActive === q.where.isActive)) ?? null,
        update: async () => ({}),
      };
      if (k === 'refreshToken') return { create: async () => ({}), findUnique: async () => null, delete: async () => ({}) };
      if (k === 'mFASetting') return {
        findUnique: async (q: { where: { userId: string } }) => {
          if (FAULT.mfaRead) throw new Error('database unavailable');
          return MFA.has(q.where.userId) ? { ...MFA.get(q.where.userId) } : null;
        },
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
          challengeSeq += 1;
          const id = `00000000-0000-4000-8000-${String(challengeSeq).padStart(12, '0')}`;
          const row = { id, consumedAt: null, attempts: 0, createdAt: new Date(), ...q.data };
          CHALLENGES.set(id, row); return { ...row };
        },
        findUnique: async (q: { where: { id: string } }) => (CHALLENGES.has(q.where.id) ? { ...CHALLENGES.get(q.where.id) } : null),
        updateMany: async (q: { where: Row; data: Row }) => {
          if (q.data.consumedAt) await atBarrier();
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
const jwt = require('jsonwebtoken');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import fs from 'fs';
import path from 'path';
import { config } from '../src/config';
import { hashPassword } from '../src/utils/password';
import { totpFor, base32Decode } from '../src/auth-prod/mfa.service';
import { LOGIN_CHALLENGE_MAX_ATTEMPTS, LOGIN_CHALLENGE_TTL_MS } from '../src/auth-prod/mfa-enforcement.service';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import { resetSecurityCollectors } from '../src/cyber-defense/collectors';

const app = createApp();
const OWNER = 'u-owner';
const COACH = 'u-coach';
const EMAIL = 'owner@familista.test';
const PASSWORD = 'right-password';
const tokenFor = (id: string, role: string) =>
  jwt.sign({ sub: id, role }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const asOwner = (r: { set: (k: string, v: string) => unknown }) => r.set('Authorization', `Bearer ${tokenFor(OWNER, 'SUPER_ADMIN')}`);
const get = (p: string) => asOwner(request(app).get(`/api/v1${p}`)) as ReturnType<typeof request>;
const post = (p: string, body: Row = {}) => (asOwner(request(app).post(`/api/v1${p}`)) as ReturnType<typeof request>).send(body);
/** A code for `steps` 30-second steps from now; 0 and 1 are both accepted (±1 tolerance). */
const codeIn = (base32: string, steps: number) => totpFor(base32Decode(base32), Math.floor(Date.now() / 1000) + steps * 30);
const login = (target: unknown = app, password = PASSWORD) =>
  request(target).post('/api/v1/auth/login').send({ email: EMAIL, password });
const second = (challenge: unknown, code: unknown, target: unknown = app) =>
  request(target).post('/api/v1/auth/login/mfa').send({ challenge, code });

let published: FamilistaEvent[] = [];
const transport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as unknown as EventTransport;
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  const base = { passwordHash, isActive: true, clubId: 'c-1', currentClubId: null, currentTeamId: null, tokenVersion: 0, club: { name: 'C' } };
  USERS.owner = { ...base, id: OWNER, email: EMAIL, role: 'SUPER_ADMIN', platformAdmin: null };
  USERS.coach = { ...base, id: COACH, email: 'coach@familista.test', role: 'COACH', platformAdmin: null };
  setEventTransport(transport);
});
afterAll(async () => { await settle(); setEventTransport(null); });

beforeEach(() => {
  MFA.clear(); CHALLENGES.clear(); FAULT.mfaRead = false; published = [];
  BARRIER.size = 0; BARRIER.waiting.splice(0).forEach((r) => r());
  USERS.owner.isActive = true;
  resetSecurityCollectors();
});

/** Enrol and confirm with the step-0 code; returns the key and recovery codes. */
async function enrolOwner(): Promise<{ base32: string; recoveryCodes: string[] }> {
  const e = await post('/auth/mfa/enroll');
  const base32 = e.body.data.base32;
  const c = await post('/auth/mfa/confirm', { code: codeIn(base32, 0) });
  expect(c.status).toBe(201);
  return { base32, recoveryCodes: c.body.data.recoveryCodes };
}

/**
 * Enrolled and enforced. Confirm used step 0 and enforcement uses step 1, so
 * the next app code free for sign-in is step... none within tolerance: each
 * sign-in in these tests therefore uses a recovery code or pushes the stored
 * step back, via `freeAppCode`.
 */
async function enforceOwner(): Promise<{ base32: string; recoveryCodes: string[] }> {
  const m = await enrolOwner();
  const res = await post('/auth/mfa/enforcement', { enabled: true, code: codeIn(m.base32, 1), recoveryCode: m.recoveryCodes[0] });
  expect(res.status).toBe(200);
  return { base32: m.base32, recoveryCodes: m.recoveryCodes.slice(1) };
}

/** Forget the last used app step, as if the codes above were used a while ago. */
function freeAppCode(): void {
  const row = MFA.get(OWNER)!;
  MFA.set(OWNER, { ...row, lastTotpStep: null });
}

async function challengeFor(): Promise<string> {
  const res = await login();
  expect(res.status).toBe(200);
  return res.body.data.challenge;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the switch: who may use it', () => {
  it('requires a session', async () => {
    const res = await request(app).post('/api/v1/auth/mfa/enforcement').send({ enabled: false, code: '123456' });
    expect(res.status).toBe(401);
  });

  it('is the platform owner’s — a club role is refused', async () => {
    const res = await request(app).post('/api/v1/auth/mfa/enforcement')
      .set('Authorization', `Bearer ${tokenFor(COACH, 'COACH')}`).send({ enabled: false, code: '123456' });
    expect(res.status).toBe(403);
  });
});

describe('the switch: switching it on', () => {
  it('cannot be switched on before enrolment', async () => {
    const res = await post('/auth/mfa/enforcement', { enabled: true, code: '123456', recoveryCode: 'AAAABBBBCCCCDDDD' });
    expect(res.status).toBe(400);
    expect(MFA.get(OWNER)?.enforcedAt ?? null).toBeNull();
  });

  it.each([
    ['nothing', {}],
    ['enabled as a string', { enabled: 'yes', code: '123456', recoveryCode: 'AAAABBBBCCCCDDDD' }],
    ['no recovery code', { enabled: true, code: '123456' }],
    ['an over-long code', { enabled: true, code: '1'.repeat(33), recoveryCode: 'AAAABBBBCCCCDDDD' }],
    ['a code of the wrong type', { enabled: true, code: 123456, recoveryCode: 'AAAABBBBCCCCDDDD' }],
  ])('refuses malformed input (%s) with 400 and sets nothing', async (_label, body) => {
    await enrolOwner();
    const res = await post('/auth/mfa/enforcement', body as Row);
    expect(res.status).toBe(400);
    expect(MFA.get(OWNER)!.enforcedAt ?? null).toBeNull();
  });

  it('needs an APP code in the code field — a recovery code there is refused', async () => {
    const m = await enrolOwner();
    const res = await post('/auth/mfa/enforcement', { enabled: true, code: m.recoveryCodes[0], recoveryCode: m.recoveryCodes[1] });
    expect(res.status).toBe(400);
    expect(MFA.get(OWNER)!.enforcedAt ?? null).toBeNull();
    expect((await get('/auth/mfa')).body.data.recoveryCodesRemaining).toBe(8);
  });

  it('needs a RECOVERY code in the recoveryCode field — an app code there is refused', async () => {
    const m = await enrolOwner();
    const res = await post('/auth/mfa/enforcement', { enabled: true, code: codeIn(m.base32, 1), recoveryCode: codeIn(m.base32, 1) });
    expect(res.status).toBe(400);
    expect(MFA.get(OWNER)!.enforcedAt ?? null).toBeNull();
  });

  it('a wrong recovery code sets nothing', async () => {
    const m = await enrolOwner();
    const res = await post('/auth/mfa/enforcement', { enabled: true, code: codeIn(m.base32, 1), recoveryCode: 'AAAABBBBCCCCDDDD' });
    expect(res.status).toBe(400);
    expect(MFA.get(OWNER)!.enforcedAt ?? null).toBeNull();
  });

  it('a wrong app code sets nothing and spends no recovery code', async () => {
    const m = await enrolOwner();
    const res = await post('/auth/mfa/enforcement', { enabled: true, code: '000000' === codeIn(m.base32, 1) ? '111111' : '000000', recoveryCode: m.recoveryCodes[0] });
    expect(res.status).toBe(400);
    expect(MFA.get(OWNER)!.enforcedAt ?? null).toBeNull();
    expect((await get('/auth/mfa')).body.data.recoveryCodesRemaining).toBe(8);
  });

  it('refuses when fewer than two recovery codes remain, so one is always left', async () => {
    const m = await enrolOwner();
    const row = MFA.get(OWNER)!;
    MFA.set(OWNER, { ...row, backupCodesHash: (row.backupCodesHash as string[]).slice(0, 1) });
    const res = await post('/auth/mfa/enforcement', { enabled: true, code: codeIn(m.base32, 1), recoveryCode: m.recoveryCodes[0] });
    expect(res.status).toBe(400);
    expect(MFA.get(OWNER)!.enforcedAt ?? null).toBeNull();
  });

  it('with both codes: on, reported, one recovery code used, response not cached', async () => {
    const m = await enrolOwner();
    expect((await get('/auth/mfa')).body.data.enforced).toBe(false);
    const res = await post('/auth/mfa/enforcement', { enabled: true, code: codeIn(m.base32, 1), recoveryCode: m.recoveryCodes[0] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enforced: true });
    expect(res.headers['cache-control']).toBe('no-store');
    const st = (await get('/auth/mfa')).body.data;
    expect(st).toMatchObject({ enrolled: true, enforced: true, recoveryCodesRemaining: 7 });
    expect(JSON.stringify(st)).not.toMatch(/secret|hash|base32/i);
  });
});

describe('the switch: switching it off', () => {
  it('needs a code — a session alone is not enough', async () => {
    await enforceOwner();
    expect((await post('/auth/mfa/enforcement', { enabled: false })).status).toBe(400);
    expect((await post('/auth/mfa/enforcement', { enabled: false, code: 'AAAABBBBCCCCDDDD' })).status).toBe(400);
    expect((await get('/auth/mfa')).body.data.enforced).toBe(true);
  });

  it('with a code: off, and the password alone signs in again', async () => {
    const m = await enforceOwner();
    const res = await post('/auth/mfa/enforcement', { enabled: false, code: m.recoveryCodes[0] });
    expect(res.status).toBe(200);
    expect((await get('/auth/mfa')).body.data.enforced).toBe(false);
    const l = await login();
    expect(l.status).toBe(200);
    expect(l.body.data.tokens.accessToken).toBeTruthy();
  });

  it('turning two-step sign-in off clears the requirement with it', async () => {
    const m = await enforceOwner();
    expect((await post('/auth/mfa/disable', { code: m.recoveryCodes[0] })).status).toBe(200);
    expect(MFA.get(OWNER)!.enforcedAt).toBeNull();
  });

  it('a requirement left from an earlier enrolment does not re-arm on a new one', async () => {
    await enforceOwner();
    // As the legacy disable route leaves it: MFA off, the old timestamp kept.
    const row = MFA.get(OWNER)!;
    MFA.set(OWNER, { ...row, method: 'NONE', enabledAt: null, secretEncrypted: null, backupCodesHash: null, lastTotpStep: null });
    await new Promise((r) => setTimeout(r, 5));
    await enrolOwner();
    expect((await get('/auth/mfa')).body.data.enforced).toBe(false);
    const l = await login();
    expect(l.body.data.tokens.accessToken).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('sign-in when it is NOT required (regression)', () => {
  it('no MFA: the password alone signs in, as before', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
    expect(res.body.data.mfaRequired).toBeUndefined();
  });

  it('enrolled but not enforced: the password alone signs in, as in Step 6', async () => {
    await enrolOwner();
    const res = await login();
    expect(res.body.data.tokens.accessToken).toBeTruthy();
  });

  it('a wrong password is refused exactly as before, enforced or not', async () => {
    await enforceOwner();
    const res = await login(app, 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid email or password' });
    expect(CHALLENGES.size).toBe(0);
  });
});

describe('sign-in when it IS required', () => {
  it('the password step answers a challenge and nothing else', async () => {
    await enforceOwner();
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ mfaRequired: true, challenge: expect.any(String), expiresIn: LOGIN_CHALLENGE_TTL_MS / 1000 });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken|owner@|u-owner/);
  });

  it('the challenge is stored only as a hash', async () => {
    await enforceOwner();
    const challenge = await challengeFor();
    const [id, secret] = challenge.split('.');
    const row = CHALLENGES.get(id)!;
    expect(row.userId).toBe(OWNER);
    expect(String(row.challengeHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('challenge + app code → a session, cookies set, not cached', async () => {
    const m = await enforceOwner();
    freeAppCode();
    const res = await second(await challengeFor(), codeIn(m.base32, 0));
    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
    expect(res.body.data.user.id).toBe(OWNER);
    expect(String(res.headers['set-cookie'])).toMatch(/access_token=/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('challenge + recovery code → a session; that recovery code never works again', async () => {
    const m = await enforceOwner();
    expect((await second(await challengeFor(), m.recoveryCodes[0])).status).toBe(200);
    const again = await second(await challengeFor(), m.recoveryCodes[0]);
    expect(again.status).toBe(400);
    expect((await get('/auth/mfa')).body.data.recoveryCodesRemaining).toBe(6);
  });

  it('an app code that signed in once is not accepted again', async () => {
    const m = await enforceOwner();
    freeAppCode();
    const code = codeIn(m.base32, 0);
    expect((await second(await challengeFor(), code)).status).toBe(200);
    expect((await second(await challengeFor(), code)).status).toBe(400);
  });

  it('a used challenge cannot be replayed, even with another valid code', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    expect((await second(challenge, m.recoveryCodes[0])).status).toBe(200);
    const replay = await second(challenge, m.recoveryCodes[1]);
    expect(replay.status).toBe(401);
    expect(replay.body.message).toBe('Sign-in expired. Sign in again.');
    expect((await get('/auth/mfa')).body.data.recoveryCodesRemaining).toBe(6);
  });

  it('a wrong code is 400, keeps the challenge alive, and records security.mfa.failed', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    const bad = await second(challenge, 'AAAABBBBCCCCDDDD');
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Invalid code');
    await settle();
    const events = published.filter((e) => e.eventType === 'security.mfa.failed');
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(OWNER);
    expect(JSON.stringify(events[0])).not.toMatch(/AAAABBBB|owner@|challenge/i);
    expect((await second(challenge, m.recoveryCodes[0])).status).toBe(200);
  });

  it(`a challenge is good for ${LOGIN_CHALLENGE_MAX_ATTEMPTS} tries; then even a right code needs a fresh sign-in`, async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    for (let i = 0; i < LOGIN_CHALLENGE_MAX_ATTEMPTS; i += 1) {
      expect((await second(challenge, `WRONGCODE${i}AAAAA`)).status).toBe(400);
    }
    expect((await second(challenge, m.recoveryCodes[0])).status).toBe(401);
  });

  it('a fresh challenge does not reset the account’s persistent wrong-code limit', async () => {
    const m = await enforceOwner();
    for (let i = 0; i < 5; i += 1) await second(await challengeFor(), `WRONGCODE${i}AAAAA`);
    const res = await second(await challengeFor(), m.recoveryCodes[0]);
    expect(res.status).toBe(429);
  });

  it('an expired challenge is refused', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    const id = challenge.split('.')[0];
    CHALLENGES.set(id, { ...CHALLENGES.get(id)!, expiresAt: new Date(Date.now() - 1) });
    expect((await second(challenge, m.recoveryCodes[0])).status).toBe(401);
  });

  it('an account deactivated between the steps gets no session', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    USERS.owner.isActive = false;
    expect((await second(challenge, m.recoveryCodes[0])).status).toBe(401);
  });

  it('switching enforcement off between the steps voids the challenge — never a pass-through', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    MFA.set(OWNER, { ...MFA.get(OWNER)!, enforcedAt: null });
    expect((await second(challenge, 'ANYTHING-AT-ALL')).status).toBe(401);
    expect((await second(challenge, m.recoveryCodes[0])).status).toBe(401);
  });

  it('removing MFA between the steps voids the challenge — `verifyLogin` pass-through is unreachable', async () => {
    await enforceOwner();
    const challenge = await challengeFor();
    MFA.set(OWNER, { ...MFA.get(OWNER)!, method: 'NONE', enabledAt: null, secretEncrypted: null, backupCodesHash: null });
    expect((await second(challenge, '000000')).status).toBe(401);
  });
});

describe('malformed and forged challenges', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a number', 12345],
    ['no secret', '00000000-0000-4000-8000-000000000001'],
    ['not a uuid', 'abc.' + 'A'.repeat(43)],
    ['a short secret', '00000000-0000-4000-8000-000000000001.' + 'A'.repeat(42)],
    ['an over-long value', 'x'.repeat(500)],
    ['SQL-looking', "' OR 1=1 --." + 'A'.repeat(43)],
  ])('%s → 400 or 401, never a session', async (_label, challenge) => {
    await enforceOwner();
    await challengeFor();
    const res = await second(challenge, '123456');
    expect([400, 401]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken/);
  });

  it('the right id with a forged secret is refused and spends none of the real challenge’s tries', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    const [id] = challenge.split('.');
    for (let i = 0; i < 10; i += 1) {
      expect((await second(`${id}.${'B'.repeat(43)}`, m.recoveryCodes[0])).status).toBe(401);
    }
    expect(CHALLENGES.get(id)!.attempts).toBe(0);
    expect((await get('/auth/mfa')).body.data.recoveryCodesRemaining).toBe(7);
    expect((await second(challenge, m.recoveryCodes[0])).status).toBe(200);
  });

  it.each([
    ['missing', undefined],
    ['too short', '12345'],
    ['too long', '1'.repeat(33)],
    ['an object', { $ne: null }],
  ])('a malformed code (%s) → 400, no session', async (_label, code) => {
    await enforceOwner();
    const res = await second(await challengeFor(), code);
    expect(res.status).toBe(400);
  });

  it('a challenge is not a token: it opens nothing as a bearer or a refresh token', async () => {
    await enforceOwner();
    const challenge = await challengeFor();
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${challenge}`)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: challenge })).status).toBe(401);
  });
});

describe('concurrent requests', () => {
  it('one challenge, the same valid code sent twice at once → exactly one session', async () => {
    const m = await enforceOwner();
    freeAppCode();
    const challenge = await challengeFor();
    const code = codeIn(m.base32, 0);
    const results = await Promise.all([second(challenge, code), second(challenge, code)]);
    expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
  });

  it('one challenge, an app code and a recovery code both accepted at once → exactly one session', async () => {
    const m = await enforceOwner();
    freeAppCode();
    const challenge = await challengeFor();
    BARRIER.size = 2; // both requests pass verification, then meet at the consume step
    const results = await Promise.all([second(challenge, codeIn(m.base32, 0)), second(challenge, m.recoveryCodes[0])]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(CHALLENGES.get(challenge.split('.')[0])!.consumedAt).toBeInstanceOf(Date);
  });

  it('one challenge, two different recovery codes at once → exactly one session', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    const results = await Promise.all([second(challenge, m.recoveryCodes[0]), second(challenge, m.recoveryCodes[1])]);
    expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
  });

  it('a burst of wrong codes cannot exceed the challenge’s tries', async () => {
    await enforceOwner();
    const challenge = await challengeFor();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => second(challenge, `WRONGCODE${i}AAAAA`)));
    expect(results.every((r) => r.status !== 200)).toBe(true);
    expect(CHALLENGES.get(challenge.split('.')[0])!.attempts).toBeLessThanOrEqual(LOGIN_CHALLENGE_MAX_ATTEMPTS);
  });
});

describe('restart and persistence', () => {
  it('a challenge issued before a restart is completed after it — and only once', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    let restarted: unknown;
    jest.isolateModules(() => { restarted = require('../src/app').createApp(); });
    expect((await second(challenge, m.recoveryCodes[0], restarted)).status).toBe(200);
    expect((await second(challenge, m.recoveryCodes[1], app)).status).toBe(401);
  });

  it('the requirement survives a restart: a freshly loaded server still asks for a code', async () => {
    await enforceOwner();
    let restarted: unknown;
    jest.isolateModules(() => { restarted = require('../src/app').createApp(); });
    const res = await login(restarted);
    expect(res.body.data.mfaRequired).toBe(true);
    expect(res.body.data.tokens).toBeUndefined();
  });
});

describe('fails closed', () => {
  const saved = config.mfa.encryptionKey;
  afterEach(() => { (config.mfa as { encryptionKey: string }).encryptionKey = saved; });

  it('enforced, and the server cannot check a code: the password step answers 503, no session', async () => {
    await enforceOwner();
    (config.mfa as { encryptionKey: string }).encryptionKey = '';
    const res = await login();
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('enforced, key lost after the password step: the second step answers 503, no session', async () => {
    const m = await enforceOwner();
    const challenge = await challengeFor();
    (config.mfa as { encryptionKey: string }).encryptionKey = '';
    const res = await second(challenge, m.recoveryCodes[0]);
    expect(res.status).toBe(503);
    // …and spent none of the challenge's tries on a code it could not check.
    expect(CHALLENGES.get(challenge.split('.')[0])!.attempts).toBe(0);
  });

  it('the requirement cannot be read (database error): no session', async () => {
    await enforceOwner();
    FAULT.mfaRead = true;
    const res = await login();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken/);
  });

  it('not enforced, no key: nothing changes — the password alone still signs in', async () => {
    (config.mfa as { encryptionKey: string }).encryptionKey = '';
    expect((await login()).body.data.tokens.accessToken).toBeTruthy();
  });
});

describe('the second step is behind the credential rate limiter', () => {
  it('failed second steps spend the per-address failure budget', async () => {
    let limited: unknown;
    const before = process.env.RATE_AUTH_CAPACITY;
    process.env.RATE_AUTH_CAPACITY = '3';
    try { jest.isolateModules(() => { limited = require('../src/app').createApp(); }); }
    finally { process.env.RATE_AUTH_CAPACITY = before; }
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await request(limited).post('/api/v1/auth/login/mfa').set('X-Forwarded-For', '203.0.113.77').send({ challenge: 'x', code: '123456' })).status);
    }
    expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});

describe('no other way to a session for an existing account', () => {
  const ROOT = path.join(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const AUTH = read('src/services/auth.service.ts');

  it('the password step asks before it records, issues or announces anything', () => {
    const body = AUTH.slice(AUTH.indexOf('export async function loginUser'), AUTH.indexOf('export async function completeMfaLogin'));
    const gate = body.indexOf('await loginSecondFactor(user.id)');
    expect(gate).toBeGreaterThan(body.indexOf('verifyPassword('));
    for (const after of ['lastLoginAt', 'issueTokens(user)', 'publishUserLogin(']) {
      expect(`${after}: ${body.indexOf(after) > gate}`).toBe(`${after}: true`);
    }
  });

  it('tokens are issued in exactly five places, each accounted for', () => {
    // register (new account), invited register (new account), password login
    // (after the gate), second step, refresh (continues a session one of those
    // began). None signs an existing account in on a password alone.
    expect((AUTH.match(/await issueTokens\(user\)|return issueTokens\(user\)/g) ?? []).length).toBe(5);
    expect(AUTH.match(/^async function issueTokens/m)).not.toBeNull();
    expect(AUTH).not.toMatch(/export (async )?function issueTokens/);
  });

  it('a password reset issues no session', () => {
    expect(read('src/services/password-reset.service.ts')).not.toMatch(/issueTokens|generateAccessToken|jwt\.sign/);
  });
});
