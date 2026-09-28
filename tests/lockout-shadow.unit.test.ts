/**
 * Cyber Defense · Step 5 — the login lockout, in shadow mode
 *
 * Every sign-in is measured against the lockout service's own thresholds, and an
 * attempt the lockout would have refused is recorded as
 * `security.lockout.triggered` with `shadow: true`. Nothing is refused: every
 * response here is exactly what it would be without the evaluator. Driven
 * through the real `createApp()`.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
// Read once at load. The real rate limits would stop these runs before the
// lockout thresholds are reached; the shadow is what is under test here.
process.env.RATE_ACCOUNT_CAPACITY = '1000';
process.env.RATE_AUTH_CAPACITY = '1000';
process.env.RATE_IP_CAPACITY = '100000';

const USERS: Record<string, Record<string, unknown>> = {};
const loginAttemptWrites = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findUnique: async (q: { where: { email?: string; id?: string } }) =>
          Object.values(USERS).find((u) => u.email === q.where.email || u.id === q.where.id) ?? null,
        findFirst: async () => null,
        update: async () => ({}),
      };
      if (k === 'refreshToken') return { create: async () => ({}), findUnique: async () => null, delete: async () => ({}) };
      if (k === 'loginAttempt') return { create: (...a: unknown[]) => { loginAttemptWrites(...a); return Promise.resolve({}); }, count: async () => 0 };
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { hashPassword } from '../src/utils/password';
import { resetSecurityCollectors } from '../src/cyber-defense/collectors';
import { resetLockoutShadow, lockoutShadowSize, MAX_KEYS } from '../src/cyber-defense/lockout-shadow';
import {
  emailHash, EMAIL_FAIL_THRESHOLD, IP_FAIL_THRESHOLD,
} from '../src/security/login-attempt.service';

let published: FamilistaEvent[] = [];
setEventTransport({
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as unknown as EventTransport);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};
const lockouts = () => published.filter((e) => e.eventType === 'security.lockout.triggered');
type Ev = { evidence: Record<string, unknown>; severity: string; outcome: string; source: { ipPrefix: string | null } };
const payload = (e: FamilistaEvent) => e.payload as unknown as Ev;

const app = createApp();
let n = 0;
const freshIp = () => { n += 1; return `10.${(n >> 8) & 255}.${n & 255}.${(n % 200) + 1}`; };
const login = (email: string, password: string, ip = freshIp()) =>
  request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password });

beforeAll(async () => {
  const passwordHash = await hashPassword('right-password');
  USERS.owner = {
    id: 'u-owner', email: 'owner@familista.test', passwordHash, isActive: true, role: 'SUPER_ADMIN',
    clubId: 'c-1', currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null,
    club: { name: 'Club' },
  };
});

beforeEach(() => {
  published = [];
  resetSecurityCollectors();
  resetLockoutShadow();
  loginAttemptWrites.mockClear();
});

afterAll(async () => { await settle(); setEventTransport(null); });

describe('the account threshold, measured and never enforced', () => {
  it(`records nothing for the first ${EMAIL_FAIL_THRESHOLD} failures, then records the next one — and still answers 401`, async () => {
    for (let i = 0; i < EMAIL_FAIL_THRESHOLD; i += 1) {
      expect((await login('owner@familista.test', 'wrong')).status).toBe(401);
    }
    await settle();
    expect(lockouts()).toEqual([]);

    const res = await login('owner@familista.test', 'wrong');
    await settle();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid email or password' });

    const [e] = lockouts();
    expect(e).toBeDefined();
    expect(validateEventPayload(e.eventType, 1, e.payload).ok).toBe(true);
    expect(payload(e).outcome).toBe('DETECTED');
    expect(payload(e).severity).toBe('MEDIUM');
    expect(payload(e).evidence).toMatchObject({
      shadow: true, scope: 'ACCOUNT', attemptSucceeded: false,
      accountFailures: EMAIL_FAIL_THRESHOLD, accountThreshold: EMAIL_FAIL_THRESHOLD, accountWindowMinutes: 15,
      accountRef: emailHash('owner@familista.test').slice(0, 16),
    });
  });

  it('a correct password that the lockout would have refused is let in — and recorded as HIGH', async () => {
    for (let i = 0; i < EMAIL_FAIL_THRESHOLD; i += 1) await login('owner@familista.test', 'wrong');
    await login('owner@familista.test', 'wrong'); // a would-be refusal of a failure, same minute
    const res = await login('owner@familista.test', 'right-password');
    await settle();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const succeeded = lockouts().filter((e) => payload(e).evidence.attemptSucceeded === true);
    expect(succeeded).toHaveLength(1);
    expect(payload(succeeded[0]).severity).toBe('HIGH');
    expect(validateEventPayload('security.lockout.triggered', 1, succeeded[0].payload).ok).toBe(true);
  });

  it('a success does not reset the count, as the lockout service would not', async () => {
    for (let i = 0; i < EMAIL_FAIL_THRESHOLD; i += 1) await login('owner@familista.test', 'wrong');
    await login('owner@familista.test', 'right-password');
    await login('owner@familista.test', 'right-password');
    await settle();
    // Both successes would have been refused; the second is capped (same account, same minute).
    expect(lockouts().filter((e) => payload(e).evidence.attemptSucceeded === true)).toHaveLength(1);
  });

  it('counts failures against an account that does not exist', async () => {
    for (let i = 0; i <= EMAIL_FAIL_THRESHOLD; i += 1) await login('nobody@familista.test', 'x');
    await settle();
    expect(lockouts()).toHaveLength(1);
    expect(payload(lockouts()[0]).evidence.scope).toBe('ACCOUNT');
  });

  it('forgets failures older than the window', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(10_000_000);
    for (let i = 0; i < EMAIL_FAIL_THRESHOLD; i += 1) await login('owner@familista.test', 'wrong');
    now.mockReturnValue(10_000_000 + 15 * 60_000 + 1);
    await login('owner@familista.test', 'wrong');
    await settle();
    now.mockRestore();
    expect(lockouts()).toEqual([]);
  });
});

describe('the address threshold', () => {
  it(`records the attempt after ${IP_FAIL_THRESHOLD} failures from one address, across different accounts`, async () => {
    const ip = '203.0.113.50';
    for (let i = 0; i < IP_FAIL_THRESHOLD; i += 1) {
      expect((await login(`spray${i}@familista.test`, 'x', ip)).status).toBe(401);
    }
    await settle();
    expect(lockouts()).toEqual([]);
    await login('spray-last@familista.test', 'x', ip);
    await settle();
    const [e] = lockouts();
    expect(payload(e).evidence).toMatchObject({ scope: 'ADDRESS', addressFailures: IP_FAIL_THRESHOLD, addressWindowMinutes: 5 });
    expect(payload(e).evidence.accountRef).toBeUndefined();
    expect(payload(e).source.ipPrefix).toBe('203.0.113.0/24');
  });
});

describe('what it does not do', () => {
  it('writes no LoginAttempt row, and records no e-mail, password or full address', async () => {
    for (let i = 0; i <= EMAIL_FAIL_THRESHOLD; i += 1) await login('owner@familista.test', 'wrong', '198.51.100.77');
    await settle();
    expect(loginAttemptWrites).not.toHaveBeenCalled();
    const blob = JSON.stringify(lockouts());
    expect(lockouts().length).toBeGreaterThan(0);
    expect(blob).not.toContain('owner@familista.test');
    expect(blob).not.toContain('wrong');
    expect(blob).not.toContain('198.51.100.77');
    expect(blob).not.toContain(emailHash('owner@familista.test'));
  });

  it('ignores a request that was not a password check (validation 400)', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email', password: '' })).status).toBe(400);
    }
    await settle();
    expect(lockouts()).toEqual([]);
    expect(lockoutShadowSize()).toEqual({ accounts: 0, addresses: 0 });
  });

  it('holds bounded memory', () => {
    expect(MAX_KEYS).toBeLessThanOrEqual(10_000);
  });
});
