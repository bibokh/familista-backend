/**
 * AI read authorization, through the real app, for every role.
 *
 * Every record the AI layer writes — agent jobs with their input and output,
 * alerts, recommendations, reports, coaching recommendations, the ARIA history,
 * the live match channel's AI events and anomaly scans — is read through
 * src/security/ai-read-policy.ts. Before it, any authenticated member of a club,
 * a player or a parent included, could list every agent job with its prompt and
 * output, every medical alert with its payload, and any member's ARIA history.
 *
 * The expected matrix below is written out by hand, not derived from the module
 * under test, and pinned against it. Every sensitive field of every seeded record
 * carries a unique marker, so a leak is found in the serialized response however
 * it got there. The in-memory database evaluates conditions with SQL's
 * three-valued logic, so a filter that silently drops or reveals rows whose
 * `agent` is NULL fails here the way it would in PostgreSQL.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
process.env.RATE_AUTH_CAPACITY = '100000';
for (const k of ['RATE_EDGE_MAX', 'RATE_IP_CAPACITY', 'RATE_USER_CAPACITY', 'RATE_TENANT_CAPACITY', 'RATE_ACCOUNT_CAPACITY']) process.env[k] = '1000000';

type Row = Record<string, any>;
type Tri = boolean | null;

// ── An in-memory database with SQL's NULL semantics ─────────────────────────
const TABLES = new Map<string, Row[]>();
const rows = (model: string) => { if (!TABLES.has(model)) TABLES.set(model, []); return TABLES.get(model)!; };
const and3 = (xs: Tri[]): Tri => (xs.some((x) => x === false) ? false : xs.some((x) => x === null) ? null : true);
const or3 = (xs: Tri[]): Tri => (xs.some((x) => x === true) ? true : xs.some((x) => x === null) ? null : false);
const not3 = (x: Tri): Tri => (x === null ? null : !x);
const cmp = (a: any, b: any) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);
function field(value: any, cond: any): Tri {
  if (cond === null) return value == null;                       // IS NULL
  if (cond instanceof Date || typeof cond !== 'object') return value == null ? null : (value instanceof Date ? value.getTime() === new Date(cond).getTime() : value === cond);
  if ('path' in cond) return value == null ? null : (cond.path as string[]).reduce((o: any, k) => (o == null ? o : o[k]), value) === cond.equals;
  const parts: Tri[] = [];
  for (const [op, v] of Object.entries(cond)) {
    if (op === 'mode') continue;
    const ci = (cond as Row).mode === 'insensitive';
    const s = (x: any) => (ci ? String(x).toLowerCase() : String(x));
    if (op === 'equals')          parts.push(value == null ? (v === null) : value === v);
    else if (op === 'in')         parts.push(value == null ? null : (v as any[]).includes(value));
    else if (op === 'notIn')      parts.push(value == null ? null : !(v as any[]).includes(value));
    else if (op === 'not')        parts.push(v === null ? value != null : not3(field(value, v)));
    else if (op === 'contains')   parts.push(value == null ? null : s(value).includes(s(v)));
    else if (op === 'startsWith') parts.push(value == null ? null : s(value).startsWith(s(v)));
    else if (op === 'lt')         parts.push(value == null ? null : cmp(value, v) < 0);
    else if (op === 'lte')        parts.push(value == null ? null : cmp(value, v) <= 0);
    else if (op === 'gt')         parts.push(value == null ? null : cmp(value, v) > 0);
    else if (op === 'gte')        parts.push(value == null ? null : cmp(value, v) >= 0);
    else throw new Error(`test database: unsupported operator ${op}`);
  }
  return and3(parts);
}
function where3(r: Row, w: Row | undefined): Tri {
  if (!w) return true;
  const parts: Tri[] = [];
  for (const [k, v] of Object.entries(w)) {
    if (k === 'AND') parts.push(and3((Array.isArray(v) ? v : [v]).map((x) => where3(r, x))));
    else if (k === 'OR') parts.push(or3((v as Row[]).map((x) => where3(r, x))));
    else if (k === 'NOT') parts.push(not3(and3((Array.isArray(v) ? v : [v]).map((x) => where3(r, x)))));
    else parts.push(field(r[k], v));
  }
  return and3(parts);
}
const matches = (r: Row, w?: Row) => where3(r, w) === true;
const sorted = (list: Row[], orderBy?: Row) => (orderBy?.createdAt === 'desc' ? [...list].sort((a, b) => cmp(b.createdAt, a.createdAt)) : list);
let _seq = 0;
const table = (model: string) => ({
  findUnique: async ({ where }: Row) => rows(model).find((r) => matches(r, where)) ?? null,
  findFirst: async ({ where, orderBy }: Row = {}) => sorted(rows(model).filter((r) => matches(r, where)), orderBy)[0] ?? null,
  findMany: async ({ where, orderBy, skip = 0, take }: Row = {}) => {
    const hits = sorted(rows(model).filter((r) => matches(r, where)), orderBy);
    return hits.slice(skip, take == null ? undefined : skip + take);
  },
  count: async ({ where }: Row = {}) => rows(model).filter((r) => matches(r, where)).length,
  create: async ({ data }: Row) => { const r = { id: `${model}-${++_seq}`, createdAt: new Date(), ...data }; rows(model).push(r); return r; },
  update: async ({ where, data }: Row) => { const r = rows(model).find((x) => matches(x, where)); if (!r) throw new Error('not found'); Object.assign(r, data); return r; },
  updateMany: async ({ where, data }: Row) => { const hits = rows(model).filter((r) => matches(r, where)); hits.forEach((r) => Object.assign(r, data)); return { count: hits.length }; },
  upsert: async ({ create }: Row) => create,
  aggregate: async () => ({ _sum: {}, _count: 0 }),
  groupBy: async () => [],
});
const db: Row = new Proxy({}, {
  get: (_t, k: string) => {
    if (k === '$queryRaw' || k === '$executeRaw' || k === '$queryRawUnsafe' || k === '$executeRawUnsafe') return async () => [{ ok: 1 }];
    if (k === '$connect' || k === '$disconnect') return async () => {};
    if (k === '$transaction') return async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg));
    if (k === 'then') return undefined;
    return table(k);
  },
});
jest.mock('../src/config/database', () => ({ prisma: db }));
jest.mock('../src/lib/prisma', () => ({ prisma: db }));
jest.mock('../src/security/audit-chain.service', () => ({
  ...jest.requireActual('../src/security/audit-chain.service'),
  appendAuditEventAsync: () => undefined,
}));
jest.mock('../src/security/security-event.service', () => ({
  ...jest.requireActual('../src/security/security-event.service'),
  logSecurityEvent: () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import fs from 'fs';
import path from 'path';
import { signToken } from '../src/security/jwt-tokens';
import { forgetIdentity } from '../src/middleware/auth.middleware';
import {
  AI_READ_MATRIX, AI_READER_ROLES, AGENT_RECORD_CLASS, presentMatchEvent, recordClass,
} from '../src/security/ai-read-policy';
import { AGENT_PROFILES } from '../src/platform/intelligence/agent-jobs';
import * as intelligenceCtrl from '../src/controllers/intelligence.controller';

const app = createApp();
const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── The expected matrix, by hand ────────────────────────────────────────────
type Cls = 'OPERATIONAL' | 'SCOUTING' | 'FINANCE' | 'MEDICAL';
type Tier = 'FULL' | 'SUMMARY' | 'NONE';
const ROLES = ['SUPER_ADMIN', 'CLUB_ADMIN', 'MANAGER', 'HEAD_COACH', 'ASSISTANT_COACH', 'COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT', 'PARENT', 'PLAYER'] as const;
type Role = typeof ROLES[number];
const EXPECT: Record<Role, Record<Cls, Tier>> = {
  SUPER_ADMIN:     { OPERATIONAL: 'FULL', SCOUTING: 'FULL', FINANCE: 'FULL', MEDICAL: 'SUMMARY' },
  CLUB_ADMIN:      { OPERATIONAL: 'FULL', SCOUTING: 'FULL', FINANCE: 'FULL', MEDICAL: 'SUMMARY' },
  MANAGER:         { OPERATIONAL: 'FULL', SCOUTING: 'FULL', FINANCE: 'FULL', MEDICAL: 'SUMMARY' },
  HEAD_COACH:      { OPERATIONAL: 'FULL', SCOUTING: 'FULL', FINANCE: 'NONE', MEDICAL: 'SUMMARY' },
  ASSISTANT_COACH: { OPERATIONAL: 'FULL', SCOUTING: 'NONE', FINANCE: 'NONE', MEDICAL: 'SUMMARY' },
  COACH:           { OPERATIONAL: 'FULL', SCOUTING: 'NONE', FINANCE: 'NONE', MEDICAL: 'SUMMARY' },
  ANALYST:         { OPERATIONAL: 'FULL', SCOUTING: 'FULL', FINANCE: 'NONE', MEDICAL: 'NONE' },
  MEDICAL_STAFF:   { OPERATIONAL: 'FULL', SCOUTING: 'NONE', FINANCE: 'NONE', MEDICAL: 'FULL' },
  SCOUT:           { OPERATIONAL: 'NONE', SCOUTING: 'FULL', FINANCE: 'NONE', MEDICAL: 'NONE' },
  PARENT:          { OPERATIONAL: 'NONE', SCOUTING: 'NONE', FINANCE: 'NONE', MEDICAL: 'NONE' },
  PLAYER:          { OPERATIONAL: 'NONE', SCOUTING: 'NONE', FINANCE: 'NONE', MEDICAL: 'NONE' },
};
const NO_ACCESS: Role[] = ['PARENT', 'PLAYER'];
const MUTE_ROLES: Role[] = ['CLUB_ADMIN', 'HEAD_COACH', 'ANALYST']; // the route's own list, unchanged

const C1 = 'c-1', C2 = 'c-2';
const uid = (r: Role) => `u-${r.toLowerCase()}`;
const OTHER_CLUB_ADMIN = { id: 'u-other-admin', role: 'CLUB_ADMIN', clubId: C2 };

// ── Seeded records: one per class, plus the cases a class is decided by kind ─
// [label, agent, kind, expected class]
const SPECS: Array<[string, string | null, string, Cls]> = [
  ['ops',       'TACTICAL', 'MATCH_REVIEW',      'OPERATIONAL'],
  ['scouting',  'SCOUTING', 'SHORTLIST',         'SCOUTING'],
  ['finance',   'FINANCE',  'FINANCE_ANOMALY',   'FINANCE'],
  ['medical',   'MEDICAL',  'INJURY_RISK',       'MEDICAL'],
  ['medkind',   'TACTICAL', 'FATIGUE_WARNING',   'MEDICAL'],
];
const ALERT_EXTRA: Array<[string, string | null, string, Cls]> = [
  ['agentless',     null, 'DEVICE_FLEET_STALE', 'OPERATIONAL'],
  ['agentless-med', null, 'INJURY_NOTE',        'MEDICAL'],
];
const secret = (type: string, label: string, f: string) => `SECRET:${type}:${label}:${f}`;
const ID = (type: string, label: string, club = C1) => `${type}-${label}-${club}`;
const T0 = Date.now();
const at = (i: number) => new Date(T0 - i * 1000);

function seed() {
  TABLES.clear(); forgetIdentity();
  const base = { isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null };
  for (const r of ROLES) rows('user').push({ ...base, id: uid(r), email: `${uid(r)}@x.test`, role: r, clubId: C1 });
  rows('user').push({ ...base, ...OTHER_CLUB_ADMIN, email: 'other@x.test' });
  let i = 0;
  for (const club of [C1, C2]) {
    const specs = club === C1 ? SPECS : SPECS.slice(0, 1);
    for (const [label, agent, kind] of specs) {
      const L = club === C1 ? label : `${label}-c2`;
      rows('aIAgentJob').push({ id: ID('job', label, club), clubId: club, teamId: null, agent, kind: club === C1 && label === 'ops' ? 'INTELLIGENCE.TACTICAL_ADVISOR' : `INTELLIGENCE.${kind}`, status: 'SUCCESS', model: 'm', costTokens: 1, costCents: 0, triggeredBy: uid('HEAD_COACH'), createdAt: at(i++), startedAt: null, finishedAt: null,
        input: { prompt: secret('job', L, 'input') }, output: { text: secret('job', L, 'output') }, error: secret('job', L, 'error') });
      rows('aIRecommendation').push({ id: ID('rec', label, club), clubId: club, matchId: null, teamId: null, playerId: 'p-1', agent, kind, status: 'OPEN', createdAt: at(i++), ackedAt: null, ackedBy: null,
        title: secret('rec', L, 'title'), content: { x: secret('rec', L, 'content') }, score: 0.9 });
      rows('aIReport').push({ id: ID('report', label, club), clubId: club, matchId: null, teamId: null, agent, kind, createdAt: at(i++),
        title: secret('report', L, 'title'), content: secret('report', L, 'content'), payload: { x: secret('report', L, 'payload') } });
    }
    for (const [label, agent, kind] of club === C1 ? [...SPECS, ...ALERT_EXTRA] : SPECS.slice(0, 1)) {
      const L = club === C1 ? label : `${label}-c2`;
      rows('aIAlert').push({ id: ID('alert', label, club), clubId: club, matchId: null, teamId: null, playerId: 'p-1', agent, kind, severity: 'CRITICAL', status: 'OPEN', createdAt: at(i++), ackedAt: null, ackedBy: null, resolvedAt: null,
        title: secret('alert', L, 'title'), message: secret('alert', L, 'message'), payload: { x: secret('alert', L, 'payload') } });
    }
    for (const [label, kind] of [['coach-tactical', 'TACTICAL'], ['coach-injury', 'INJURY_RISK']] as const) {
      const L = club === C1 ? label : `${label}-c2`;
      rows('coachRecommendation').push({ id: ID('coach', label, club), clubId: club, matchId: null, teamId: null, playerId: 'p-1', agentId: null, kind, tacticalImpact: 'LOW', approvalRequestId: null, status: 'OPEN', createdAt: at(i++), ackedAt: null, ackedBy: null,
        title: secret('coach', L, 'title'), rationale: secret('coach', L, 'rationale'), payload: { x: secret('coach', L, 'payload') }, confidence: 0.7 });
    }
  }
  for (const r of ['HEAD_COACH', 'CLUB_ADMIN'] as Role[]) {
    rows('aiInsight').push({ id: `insight-${r}`, clubId: C1, userId: uid(r), type: 'medical', prompt: secret('insight', r, 'prompt'), response: secret('insight', r, 'response'), model: 'm', createdAt: at(i++) });
  }
}

const bearer = (id: string, role: string) => `Bearer ${signToken('access', { sub: id, role, tv: 0 }, { expiresIn: '10m' })}`;
const as = (role: Role | 'OTHER') => {
  const [id, r] = role === 'OTHER' ? [OTHER_CLUB_ADMIN.id, OTHER_CLUB_ADMIN.role] : [uid(role), role];
  return {
    get: (url: string) => request(app).get(url).set('Authorization', bearer(id, r)),
    post: (url: string) => request(app).post(url).set('Authorization', bearer(id, r)).send({}),
  };
};
const body = (res: Row) => JSON.stringify(res.body);
const itemsOf = (res: Row): Row[] => (Array.isArray(res.body.data) ? res.body.data : res.body.data?.items ?? res.body.items ?? res.body.data?.insights ?? []);
const classOfSpec = (label: string): Cls => [...SPECS, ...ALERT_EXTRA].find((s) => s[0] === label)![3];

beforeEach(seed);

// ── 1. The matrix and the classes ───────────────────────────────────────────
describe('the policy', () => {
  it('is exactly the hand-written matrix, with no role left undecided', () => {
    expect(AI_READ_MATRIX).toEqual(EXPECT);
    expect([...AI_READER_ROLES].sort()).toEqual(ROLES.filter((r) => !NO_ACCESS.includes(r)).sort());
  });

  it('classifies every agent the way its egress profile does', () => {
    for (const [agent, cls] of Object.entries(AGENT_RECORD_CLASS)) {
      const dc = (AGENT_PROFILES as Row)[agent].dataClass;
      if (dc === 'RESTRICTED') expect(cls).toBe('MEDICAL');
      if (cls === 'MEDICAL') expect(dc).toBe('RESTRICTED');
      if (dc === 'CONFIDENTIAL') expect(['SCOUTING', 'FINANCE']).toContain(cls);
    }
    expect(Object.keys(AGENT_RECORD_CLASS).sort()).toEqual(Object.keys(AGENT_PROFILES).sort());
  });

  it('makes a record medical by its kind whoever raised it, and an unknown agent the most sensitive', () => {
    for (const [, agent, kind, cls] of [...SPECS, ...ALERT_EXTRA]) expect(recordClass(agent, kind)).toBe(cls);
    expect(recordClass('TACTICAL', 'post_injury_return')).toBe('MEDICAL');
    expect(recordClass('SOMETHING_NEW', 'X')).toBe('MEDICAL');
  });

  it('(control) the test database drops a NULL agent from IN and from NOT, as PostgreSQL does', () => {
    const r = { agent: null, kind: 'X' };
    expect(matches(r, { agent: { in: ['TACTICAL'] } })).toBe(false);
    expect(matches(r, { NOT: { agent: 'MEDICAL' } })).toBe(false);
    expect(matches(r, { OR: [{ agent: null }, { agent: { in: ['TACTICAL'] } }] })).toBe(true);
  });
});

// ── 2. Lists, for every role ────────────────────────────────────────────────
const LISTS: Array<{ name: string; url: string; type: string; labels: string[]; listHides: string[]; fullShows: string[] }> = [
  { name: 'GET /ai-ops/alerts', url: '/api/v1/ai-ops/alerts', type: 'alert', labels: [...SPECS, ...ALERT_EXTRA].map((s) => s[0]), listHides: [], fullShows: ['title', 'message', 'payload'] },
  { name: 'GET /ai-ops/recommendations', url: '/api/v1/ai-ops/recommendations', type: 'rec', labels: SPECS.map((s) => s[0]), listHides: [], fullShows: ['title', 'content'] },
  { name: 'GET /ai-ops/reports', url: '/api/v1/ai-ops/reports', type: 'report', labels: SPECS.map((s) => s[0]), listHides: ['content', 'payload'], fullShows: ['title'] },
  { name: 'GET /automation/agents/jobs', url: '/api/v1/automation/agents/jobs', type: 'job', labels: SPECS.map((s) => s[0]), listHides: ['input', 'output', 'error'], fullShows: [] },
  { name: 'GET /phase-s/intelligence/jobs', url: '/api/v1/phase-s/intelligence/jobs?limit=50', type: 'job', labels: SPECS.map((s) => s[0]), listHides: ['input', 'output', 'error'], fullShows: [] },
];

describe.each(LISTS)('$name', ({ url, type, labels, listHides, fullShows }) => {
  it.each(NO_ACCESS)('negative: %s is refused', async (role) => {
    const res = await as(role).get(url);
    expect(res.status).toBe(403);
    expect(body(res)).not.toMatch(/SECRET:/);
  });

  it.each(ROLES.filter((r) => !NO_ACCESS.includes(r)))('%s sees exactly its tiers, never another club, never a raw input or output', async (role) => {
    const res = await as(role).get(url);
    expect(res.status).toBe(200);
    const items = itemsOf(res);
    const expected = labels.filter((l) => EXPECT[role][classOfSpec(l)] !== 'NONE').map((l) => ID(type, l)).sort();
    expect(items.map((x) => x.id).sort()).toEqual(expected);
    expect(body(res)).not.toMatch(/-c2:/);                                  // another club's markers
    for (const l of labels) {
      const tier = EXPECT[role][classOfSpec(l)];
      for (const f of listHides) expect(body(res)).not.toContain(secret(type, l, f));
      for (const f of fullShows) {
        if (tier === 'FULL') expect(body(res)).toContain(secret(type, l, f));
        else expect(body(res)).not.toContain(secret(type, l, f));
      }
      const item = items.find((x) => x.id === ID(type, l)) as Row;
      if (tier === 'SUMMARY') {
        expect(item.restricted).toBe(true);
        expect(body({ body: item })).not.toMatch(/SECRET:/);
      }
    }
    const total = res.body.meta?.total ?? res.body.total;
    if (total !== undefined) expect(total).toBe(expected.length);
  });

  it('negative: another club’s administrator sees none of this club’s records', async () => {
    const res = await as('OTHER').get(url);
    expect(res.status).toBe(200);
    expect(itemsOf(res).every((x) => x.clubId === C2)).toBe(true);
    expect((body(res).match(/SECRET:[^"]*/g) ?? []).every((m) => m.includes('-c2:'))).toBe(true);
  });
});

// ── 3. Detail reads, for every role and every record ────────────────────────
const DETAILS: Array<{ name: string; url: (id: string) => string; type: string; fields: string[]; envelope: (res: Row) => Row }> = [
  { name: 'GET /ai-ops/jobs/:id', url: (id) => `/api/v1/ai-ops/jobs/${id}`, type: 'job', fields: ['input', 'output', 'error'], envelope: (r) => r.body.data },
  { name: 'GET /automation/agents/jobs/:id', url: (id) => `/api/v1/automation/agents/jobs/${id}`, type: 'job', fields: ['input', 'output', 'error'], envelope: (r) => r.body.data },
  { name: 'GET /phase-s/intelligence/jobs/:jobId', url: (id) => `/api/v1/phase-s/intelligence/jobs/${id}`, type: 'job', fields: ['input', 'output', 'error'], envelope: (r) => r.body },
  { name: 'GET /ai-ops/reports/:id', url: (id) => `/api/v1/ai-ops/reports/${id}`, type: 'report', fields: ['title', 'content', 'payload'], envelope: (r) => r.body.data },
];

describe.each(DETAILS)('$name', ({ url, type, fields, envelope }) => {
  it.each(ROLES)('%s: FULL shows everything, SUMMARY nothing it says, NONE is refused', async (role) => {
    for (const [label] of SPECS) {
      const res = await as(role).get(url(ID(type, label)));
      const tier = EXPECT[role][classOfSpec(label)];
      if (tier === 'NONE') {
        expect(res.status).toBe(403);
        expect(body(res)).not.toMatch(/SECRET:/);
        continue;
      }
      expect(res.status).toBe(200);
      const rec = envelope(res);
      expect(rec.id).toBe(ID(type, label));
      for (const f of fields) {
        if (tier === 'FULL') expect(body(res)).toContain(secret(type, label, f));
        else expect(body(res)).not.toContain(secret(type, label, f));
      }
      if (tier === 'SUMMARY') expect(rec.restricted).toBe(true);
    }
  });

  it('negative: another club’s record is not found, even by id', async () => {
    const res = await as('CLUB_ADMIN').get(url(ID(type, 'ops', C2)));
    expect(res.status).toBe(404);
    expect(body(res)).not.toMatch(/SECRET:/);
    const back = await as('OTHER').get(url(ID(type, 'medical')));
    expect(back.status).toBe(404);
  });
});

// ── 4. Acting on alerts and recommendations ─────────────────────────────────
describe('alert and recommendation actions', () => {
  const alertLabels = [...SPECS, ...ALERT_EXTRA].map((s) => s[0]);
  it.each(ROLES)('%s: acknowledging needs any access, resolving and muting need full access', async (role) => {
    for (const label of alertLabels) {
      const tier = EXPECT[role][classOfSpec(label)];
      seed();
      const ack = await as(role).post(`/api/v1/ai-ops/alerts/${ID('alert', label)}/ack`);
      expect([label, ack.status]).toEqual([label, tier === 'NONE' ? 403 : 200]);
      if (tier === 'SUMMARY') expect(body(ack)).not.toMatch(/SECRET:/);
      if (tier !== 'NONE') expect(rows('aIAlert').find((a) => a.id === ID('alert', label))!.status).toBe('ACK');
      seed();
      const resolve = await as(role).post(`/api/v1/ai-ops/alerts/${ID('alert', label)}/resolve`);
      expect([label, resolve.status]).toEqual([label, tier === 'FULL' ? 200 : 403]);
      if (tier !== 'FULL') expect(rows('aIAlert').find((a) => a.id === ID('alert', label))!.status).toBe('OPEN');
      seed();
      const mute = await as(role).post(`/api/v1/ai-ops/alerts/${ID('alert', label)}/mute`);
      expect([label, mute.status]).toEqual([label, tier === 'FULL' && MUTE_ROLES.includes(role) ? 200 : 403]);
    }
    for (const [label] of SPECS) {
      const tier = EXPECT[role][classOfSpec(label)];
      seed();
      const ack = await as(role).post(`/api/v1/ai-ops/recommendations/${ID('rec', label)}/ack`);
      expect([label, ack.status]).toEqual([label, tier === 'NONE' ? 403 : 200]);
      if (tier === 'SUMMARY') expect(body(ack)).not.toMatch(/SECRET:/);
    }
  });

  it('negative: nobody acts on another club’s alert or recommendation', async () => {
    for (const p of [`/api/v1/ai-ops/alerts/${ID('alert', 'ops', C2)}/ack`, `/api/v1/ai-ops/alerts/${ID('alert', 'ops', C2)}/resolve`, `/api/v1/ai-ops/recommendations/${ID('rec', 'ops', C2)}/ack`]) {
      expect((await as('CLUB_ADMIN').post(p)).status).toBe(404);
    }
    expect(rows('aIAlert').find((a) => a.id === ID('alert', 'ops', C2))!.status).toBe('OPEN');
  });
});

// ── 5. Anomalies, coaching recommendations, the ARIA history ────────────────
describe('the remaining AI reads', () => {
  it.each(ROLES)('%s: an anomaly scan needs operational access', async (role) => {
    const res = await as(role).get('/api/v1/ai-ops/anomalies');
    expect(res.status).toBe(EXPECT[role].OPERATIONAL === 'FULL' ? 200 : 403);
  });

  it.each(ROLES)('%s: coaching recommendations follow the matrix (INJURY_RISK is medical)', async (role) => {
    const res = await as(role).get('/api/v1/phase-l/coaching/recommendations');
    if (NO_ACCESS.includes(role)) { expect(res.status).toBe(403); return; }
    expect(res.status).toBe(200);
    const want = (['coach-tactical', 'coach-injury'] as const).filter((l) => EXPECT[role][l === 'coach-injury' ? 'MEDICAL' : 'OPERATIONAL'] !== 'NONE');
    expect(itemsOf(res).map((x) => x.id).sort()).toEqual(want.map((l) => ID('coach', l)).sort());
    const injury = EXPECT[role].MEDICAL;
    for (const f of ['title', 'rationale', 'payload']) {
      if (injury === 'FULL') expect(body(res)).toContain(secret('coach', 'coach-injury', f));
      else expect(body(res)).not.toContain(secret('coach', 'coach-injury', f));
    }
    expect(body(res)).not.toMatch(/-c2:/);
  });

  it.each(ROLES)('%s: the ARIA history is the reader’s own, and nobody else’s', async (role) => {
    const res = await as(role).get('/api/v1/ai/history');
    if (NO_ACCESS.includes(role)) { expect(res.status).toBe(403); return; }
    expect(res.status).toBe(200);
    const mine = ['HEAD_COACH', 'CLUB_ADMIN'].includes(role) ? [`insight-${role}`] : [];
    expect(itemsOf(res).map((x) => x.id)).toEqual(mine);
    for (const other of ['HEAD_COACH', 'CLUB_ADMIN'].filter((r) => r !== role)) {
      expect(body(res)).not.toContain(secret('insight', other, 'response'));
    }
  });
});

// ── 6. The live match channel ───────────────────────────────────────────────
describe('the live match channel', () => {
  const medical = { kind: 'RULES_ALERT', matchId: 'm', clubId: C1, payload: { id: 'a', kind: 'INJURY_RISK', agent: 'MEDICAL', severity: 'CRITICAL', title: 'SECRET:live:title', message: 'SECRET:live:message', createdAt: 't' } };
  const scouting = { kind: 'AI_RECOMMENDATION', matchId: 'm', clubId: C1, payload: { id: 'r', kind: 'SHORTLIST', agent: 'SCOUTING', title: 'SECRET:live:scout', score: 1, createdAt: 't' } };
  const timeline = { kind: 'TIMELINE_ADDED', matchId: 'm', clubId: C1, payload: { id: 'e' } };

  it.each(ROLES)('%s: AI events are dropped, summarised or passed by the matrix; other events pass', (role) => {
    for (const [event, cls] of [[medical, 'MEDICAL'], [scouting, 'SCOUTING']] as const) {
      const out = presentMatchEvent(role, event);
      const tier = EXPECT[role][cls];
      if (tier === 'NONE') expect(out).toBeNull();
      else if (tier === 'FULL') expect(out).toEqual(event);
      else {
        expect(JSON.stringify(out)).not.toMatch(/SECRET:/);
        expect((out as Row).payload).toMatchObject({ id: event.payload.id, kind: event.payload.kind, restricted: true });
      }
    }
    expect(presentMatchEvent(role, timeline)).toBe(timeline);
  });

  it('is applied by both match streams, and the alert event names its agent', () => {
    expect(read('src/realtime/match-sse.ts')).toContain('const visible = presentMatchEvent(role, event);');
    expect(read('src/realtime/match-ws.ts')).toContain('const visible = presentMatchEvent(session.role, event);');
    expect(read('src/services/ai-ops.service.ts')).toContain('payload: { id: row.id, kind: row.kind, agent: row.agent, severity: row.severity');
  });
});

// ── 7. Responses to writes carry no more than a read would ──────────────────
describe('write responses', () => {
  const call = async (role: Role, label: string) => {
    const job = rows('aIAgentJob').find((j) => j.id === ID('job', label))!;
    job.kind = 'INTELLIGENCE.INJURY_RISK_SCAN';
    job.input = { ...job.input, entityId: 'team-1' };
    let sent: Row | undefined;
    const res: Row = { status: () => res, json: (b: Row) => { sent = b; return res; } };
    const next = jest.fn();
    await intelligenceCtrl.triggerInjuryRiskScan({ params: { teamId: 'team-1' }, user: { id: uid(role), clubId: C1, role } } as never, res as never, next);
    return { sent, next };
  };

  it('an injury-risk trigger that returns the recent scan shows it at the trigger’s tier', async () => {
    const coach = await call('HEAD_COACH', 'medical');
    expect(coach.next).not.toHaveBeenCalled();
    expect(coach.sent).toMatchObject({ id: ID('job', 'medical'), restricted: true });
    expect(JSON.stringify(coach.sent)).not.toMatch(/SECRET:/);
    seed();
    const medic = await call('MEDICAL_STAFF', 'medical');
    expect(JSON.stringify(medic.sent)).toContain(secret('job', 'medical', 'output'));
    // A role with no read tier on medical still started the job: it gets the summary, not a refusal.
    seed();
    const analyst = await call('ANALYST', 'medical');
    expect(analyst.next).not.toHaveBeenCalled();
    expect(analyst.sent).toMatchObject({ id: ID('job', 'medical'), restricted: true });
    expect(JSON.stringify(analyst.sent)).not.toMatch(/SECRET:/);
  });

  it('every intelligence trigger answers through the policy', () => {
    const src = read('src/controllers/intelligence.controller.ts');
    expect(src.match(/res\.status\(202\)\.json\(Svc\.presentTriggered\(actor\(req\), job\)\);/g)).toHaveLength(5);
    expect(src).not.toMatch(/res\.status\(202\)\.json\(job\)/);
  });

  it('cancelling a job answers at the canceller’s tier', async () => {
    rows('aIAgentJob').find((j) => j.id === ID('job', 'medical'))!.status = 'PENDING';
    const res = await as('HEAD_COACH').post(`/api/v1/automation/agents/jobs/${ID('job', 'medical')}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: ID('job', 'medical'), status: 'CANCELLED', restricted: true });
    expect(body(res)).not.toMatch(/SECRET:/);
  });
});

// ── 8. One place decides ────────────────────────────────────────────────────
describe('the source', () => {
  it('every AI read path goes through the policy module', () => {
    for (const f of ['src/services/ai-ops.service.ts', 'src/controllers/ai-ops.controller.ts', 'src/services/automation.service.ts', 'src/intelligence/intelligence.service.ts', 'src/services/ai.service.ts', 'src/coaching/coach-agent.service.ts', 'src/realtime/match-sse.ts', 'src/realtime/match-ws.ts']) {
      expect([f, read(f).includes("from '../security/ai-read-policy'")]).toEqual([f, true]);
    }
    // The match routes reuse the same, now policy-bound, handlers.
    const match = read('src/routes/match.routes.ts');
    expect(match).toContain("router.get('/:id/alerts',          ai.listAlerts);");
    expect(match).toContain("router.get('/:id/recommendations', ai.listRecommendations);");
    expect(match).toContain("router.get('/:id/reports',         ai.listReports);");
  });
});
