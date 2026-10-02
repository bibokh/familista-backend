/**
 * Cyber Defense, R3 + R8 — the club's AI data switches, through the real app
 *
 * GET /api/v1/ai-data-policy: any member reads them (both off by default).
 * PUT: a club administrator changes them for their own club; nobody else can.
 * And the Settings card that shows them is wired, translated and accessible.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
process.env.RATE_AUTH_CAPACITY = '100000';

type Row = Record<string, unknown>;
const USERS: Record<string, Row> = {};
const POLICIES = new Map<string, Row>();

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findUnique: async (q: { where: { id?: string } }) => Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
        findFirst: async (q: { where: { id?: string } }) => Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
      };
      if (k === 'clubAiDataPolicy') return {
        findUnique: async ({ where }: { where: { clubId: string } }) => POLICIES.get(where.clubId) ?? null,
        upsert: async ({ where, create, update }: { where: { clubId: string }; create: Row; update: Row }) => {
          const cur = POLICIES.get(where.clubId);
          const next = cur ? { ...cur, ...update } : { ...create };
          POLICIES.set(where.clubId, next);
          return next;
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
import fs from 'fs';
import path from 'path';
import { signToken } from '../src/security/jwt-tokens';
import { __resetClubAiPolicyCache } from '../src/platform/intelligence/club-ai-policy';
import { forgetIdentity } from '../src/middleware/auth.middleware';

const app = createApp();
const ROOT = path.join(__dirname, '..');
const token = (id: string, role: string) => signToken('access', { sub: id, role, tv: 0 }, { expiresIn: '10m' });
const as = (id: string, role: string) => ({
  get: () => request(app).get('/api/v1/ai-data-policy').set('Authorization', `Bearer ${token(id, role)}`),
  put: (body: Row) => request(app).put('/api/v1/ai-data-policy').set('Authorization', `Bearer ${token(id, role)}`).send(body),
});

beforeAll(() => {
  const base = { isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null };
  USERS.admin = { ...base, id: 'u-admin', email: 'a@x.test', role: 'CLUB_ADMIN', clubId: 'c-1' };
  USERS.coach = { ...base, id: 'u-coach', email: 'c@x.test', role: 'HEAD_COACH', clubId: 'c-1' };
  USERS.other = { ...base, id: 'u-other', email: 'o@x.test', role: 'CLUB_ADMIN', clubId: 'c-2' };
});
beforeEach(() => { POLICIES.clear(); __resetClubAiPolicyCache(); forgetIdentity(); });

describe('the switches', () => {
  it('read as both off for a club that never set them', async () => {
    const res = await as('u-coach', 'HEAD_COACH').get();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ restrictedEgress: false, trainingUse: false });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a club administrator changes them for their own club only', async () => {
    const res = await as('u-admin', 'CLUB_ADMIN').put({ trainingUse: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ restrictedEgress: false, trainingUse: true });
    expect(POLICIES.get('c-1')).toMatchObject({ trainingUse: true, updatedById: 'u-admin' });
    expect((await as('u-other', 'CLUB_ADMIN').get()).body.data).toEqual({ restrictedEgress: false, trainingUse: false });
  });

  it('nobody else can, and a malformed change is refused', async () => {
    expect((await as('u-coach', 'HEAD_COACH').put({ restrictedEgress: true })).status).toBe(403);
    expect((await as('u-admin', 'CLUB_ADMIN').put({})).status).toBe(400);
    expect((await as('u-admin', 'CLUB_ADMIN').put({ restrictedEgress: 'yes' })).status).toBe(400);
    expect((await as('u-admin', 'CLUB_ADMIN').put({ clubId: 'c-2', trainingUse: true })).status).toBe(400);
    expect((await request(app).get('/api/v1/ai-data-policy')).status).toBe(401);
  });
});

describe('the Settings card', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/settings-ai-data.js'), 'utf8');
  const app_js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

  it('is mounted in Settings › Platform and loaded after app.js', () => {
    expect(app_js).toContain('<div class="set-card set-aidata" id="set-aidata-card" data-no-i18n hidden></div>');
    expect(app_js).toContain('window.SettingsAiData.mount()');
    const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    expect(index.indexOf('/settings-ai-data.js')).toBeGreaterThan(index.indexOf('/app.js?'));
  });

  it('is accessible switches, editable by administrators only', () => {
    expect(js).toContain('role="switch" aria-checked="');
    expect(js).toContain('aria-labelledby="aid-');
    expect(js).toContain("u.role === 'SUPER_ADMIN' || u.role === 'CLUB_ADMIN'");
    expect(js).toMatch(/editable \? '' : ' disabled'/);
    expect(js).not.toMatch(/localStorage|sessionStorage/);
  });

  it('every string it uses exists in every locale', () => {
    const keys = [...new Set([...js.matchAll(/tr\('([a-zA-Z]+)'\)|tr\(key \+ '(Title|Help)'\)/g)].map((m) => m[1]).filter(Boolean))];
    const all = [...keys, 'egressTitle', 'egressHelp', 'trainingTitle', 'trainingHelp'];
    for (const f of fs.readdirSync(path.join(ROOT, 'public/i18n/locales'))) {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n/locales', f), 'utf8'));
      for (const k of all) expect(`${f}: ${k} ${typeof d.settings?.aiData?.[k]}`).toBe(`${f}: ${k} string`);
    }
  });
});

describe('the agent worker asks the tool registry before it asks for approval', () => {
  it('a refused job fails without creating an approval request', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/workers/ai-agent.worker.ts'), 'utf8');
    const authz = src.indexOf('authorizeAgentJob(job)');
    expect(authz).toBeGreaterThan(0);
    expect(authz).toBeLessThan(src.indexOf('getJobApproval(job.id)'));
    expect(authz).toBeLessThan(src.indexOf('runDeterministicHandler('));
    expect(src.slice(authz, src.indexOf('getJobApproval(job.id)'))).toMatch(/if \(!authz\.allowed\) \{[\s\S]*?status: +AutomationStatus\.FAILED[\s\S]*?return;/);
  });
});
