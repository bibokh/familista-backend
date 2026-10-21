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
 * The expected matrix and every record's classes are written out by hand in
 * tests/helpers/ai-read-fixtures.ts, not derived from the module under test,
 * and pinned against it. Every sensitive field of every seeded record carries a
 * unique marker, so a leak is found in the serialized response however it got
 * there. The in-memory database evaluates conditions with SQL's three-valued
 * logic, so a filter that silently drops or reveals rows whose `agent` is NULL
 * fails here the way it would in PostgreSQL; the same expectations run against
 * real PostgreSQL in tests/ai-read-authorization.integration.test.ts.
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
  AI_READ_MATRIX, AI_READER_ROLES, AGENT_RECORD_CLASS, COACH_KIND_CLASS, DECLARED_KINDS, HEALTH_FIELDS,
  classify, holdsHealthData, presentMatchEvent, tierOf,
} from '../src/security/ai-read-policy';
import { AGENT_PROFILES } from '../src/platform/intelligence/agent-jobs';
import { FACTOR_CLASSES, FEATURE_CLASSES } from '../src/platform/intelligence/data-classes';
import * as intelligenceCtrl from '../src/controllers/intelligence.controller';
import {
  C1, C2, C2_LABELS, CANCEL_ROUTE_ROLES, DETAILS, EXPECT, ID, LISTS, MUTE_ROUTE_ROLES, NO_ACCESS, OPERATIONAL_CANCEL_ROLES,
  OPERATIONAL_MUTE_ROLES, READERS, ROLES, SPECS, SUMMARY_KEYS, buildRecords, expectTier, intelligenceOnly, itemsOf, mayAct,
  secret, spec, specsOf, totalOf, uid, type Role, type Spec,
} from './helpers/ai-read-fixtures';

const app = createApp();
const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TYPE: Record<string, 'job' | 'alert' | 'recommendation' | 'report' | 'coach'> = { job: 'job', alert: 'alert', rec: 'recommendation', report: 'report', coach: 'coach' };
const MODEL: Record<string, string> = { job: 'aIAgentJob', alert: 'aIAlert', rec: 'aIRecommendation', report: 'aIReport', coach: 'coachRecommendation' };
const OTHER_CLUB_ADMIN = { id: uid('CLUB_ADMIN', C2), role: 'CLUB_ADMIN' };

function seed() {
  TABLES.clear(); forgetIdentity();
  const base = { isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null };
  for (const club of [C1, C2]) for (const r of ROLES) rows('user').push({ ...base, id: uid(r, club), email: `${uid(r, club)}@x.test`, role: r, clubId: club });
  for (const [model, list] of Object.entries(buildRecords())) rows(model).push(...list.map((x) => ({ ...x })));
  for (const r of ['HEAD_COACH', 'CLUB_ADMIN'] as Role[]) {
    rows('aiInsight').push({ id: `insight-${r}`, clubId: C1, userId: uid(r), type: 'medical', prompt: secret('insight', r, 'prompt'), response: secret('insight', r, 'response'), model: 'm', createdAt: new Date() });
  }
}

const bearer = (id: string, role: string) => `Bearer ${signToken('access', { sub: id, role, tv: 0 }, { expiresIn: '10m' })}`;
const as = (role: Role | 'OTHER') => {
  const [id, r] = role === 'OTHER' ? [OTHER_CLUB_ADMIN.id, OTHER_CLUB_ADMIN.role] : [uid(role), role];
  return {
    get: (url: string) => request(app).get(url).set('Authorization', bearer(id, r)),
    post: (url: string, payload: Row = {}) => request(app).post(url).set('Authorization', bearer(id, r)).send(payload),
  };
};
const body = (res: Row) => JSON.stringify(res.body);
const rowOf = (s: Spec, club = C1) => rows(MODEL[s.type]).find((x) => x.id === ID(s.type, s.label, club))!;
const reader = (role: Role) => ({ userId: uid(role), clubId: C1, role });
const recordCount = () => [...TABLES.entries()].filter(([m]) => Object.values(MODEL).includes(m)).reduce((n, [, t]) => n + t.length, 0);

beforeEach(seed);

// ── 1. The matrix and the classification ────────────────────────────────────
describe('the policy', () => {
  it('is exactly the hand-written matrix: medical for medical staff alone, no summary granted by role', () => {
    expect(AI_READ_MATRIX).toEqual(EXPECT);
    expect([...AI_READER_ROLES].sort()).toEqual([...READERS].sort());
    for (const r of ROLES) if (r !== 'MEDICAL_STAFF') expect([r, AI_READ_MATRIX[r].MEDICAL]).toEqual([r, 'NONE']);
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

  it('every hand-classified record gets exactly the tier the matrix gives it, for every role', () => {
    for (const s of SPECS) for (const role of ROLES) {
      const want = NO_ACCESS.includes(role) ? 'NONE' : expectTier(role, s);
      expect([s.type, s.label, role, tierOf(reader(role), TYPE[s.type], rowOf(s))]).toEqual([s.type, s.label, role, want]);
    }
  });

  it('does not decide by words: no medical word is needed to restrict, nor is one enough to restrict', () => {
    // An undeclared kind with no medical word in it, under a non-medical agent, is restricted.
    expect(classify('alert', 'TACTICAL', 'PLAYER_UPDATE')).toMatchObject({ declared: false, classes: ['OPERATIONAL', 'MEDICAL'] });
    // Decided by the vocabulary, not by "FATIGUE" in the string: the rules engine's is medical, a hand-written one unclassified.
    expect(classify('alert', null, 'FATIGUE')).toMatchObject({ declared: true, medical: true, classes: ['MEDICAL'] });
    expect(classify('alert', 'TACTICAL', 'FATIGUE')).toMatchObject({ declared: false, medical: false, classes: ['OPERATIONAL', 'MEDICAL'] });
    expect(classify('alert', 'TACTICAL', 'TACTICAL_COLLAPSE_RISK')).toMatchObject({ declared: true, classes: ['OPERATIONAL'] });
    // An agent the policy does not know is the most sensitive.
    expect(classify('alert', 'SOMETHING_NEW', 'X')).toMatchObject({ classes: ['MEDICAL'] });
  });

  it('finds health data by structured field, from the egress data classes, at any depth', () => {
    for (const [k, c] of [...Object.entries(FEATURE_CLASSES), ...Object.entries(FACTOR_CLASSES)]) {
      expect([k, HEALTH_FIELDS.has(k)]).toEqual([k, c === 'RESTRICTED']);
    }
    expect(holdsHealthData({ context: { players: [{ workload: { injuryRiskScore: 0.9 } }] } })).toBe(true);
    expect(holdsHealthData({ formation: '4-3-3', goalsFor: 2, workload: { acwr: 1.3, acuteLoad: 400 } })).toBe(false);
    expect(holdsHealthData('a string that says injury')).toBe(false);
  });

  it('every kind a platform producer writes is declared, and every declared kind has its producer', () => {
    const found = new Set<string>();
    const add = (type: string, agent: string | null, kind: string) => found.add(`${type}|${agent ?? '-'}|${kind}`);
    for (const m of read('src/services/rules-engine.service.ts').matchAll(/kind:\s*'([A-Z_]+)'/g)) add('alert', null, m[1]);
    expect(read('src/services/rules-engine.service.ts')).toContain('agent:    null,');
    for (const m of read('src/services/anomaly-detector.service.ts').matchAll(/kind:\s*'([A-Z_]+)'/g)) add('alert', 'CLUB_MANAGER', m[1]);
    expect(read('src/services/anomaly-detector.service.ts')).toContain("agent:    'CLUB_MANAGER'");
    for (const m of read('src/intel/predictive.service.ts').matchAll(/safeAlert\([^,]+,[^,]+,[^,]+,\s*'([A-Z_]+)'/g)) add('alert', 'TACTICAL', m[1]);
    expect(read('src/intel/predictive.service.ts')).toContain("agent: 'TACTICAL' });");
    const handlers = read('src/workers/agent-handlers.ts');
    for (const m of handlers.matchAll(/aiOps\.createAlert\(\{[\s\S]*?agent:\s*'([A-Z_]+)',\s*kind:\s*'([A-Z_]+)'/g)) add('alert', m[1], m[2]);
    for (const m of handlers.matchAll(/emitRecommendation\(ctx\.clubId,\s*\w+,\s*'([A-Z_]+)',\s*'([A-Z_]+)'/g)) add('recommendation', m[1], m[2]);
    for (const m of handlers.matchAll(/emitReport\(ctx\.clubId,\s*\w+,\s*'([A-Z_]+)',\s*'([A-Z_]+)'/g)) add('report', m[1], m[2]);
    const intel = read('src/intelligence/intelligence.service.ts');
    const kinds = Object.fromEntries([...intel.matchAll(/(\w+):\s*'(INTELLIGENCE\.[A-Z_]+)'/g)].map((m) => [m[1], m[2]]));
    for (const m of intel.matchAll(/_createJob\(actor,\s*'([A-Z_]+)',\s*KIND\.(\w+)/g)) add('job', m[1], kinds[m[2]]);
    const declared = new Set(Object.entries(DECLARED_KINDS).flatMap(([type, list]) => list.map((d) => `${type}|${d.agent ?? '-'}|${d.kind}`)));
    expect([...found].sort()).toEqual([...declared].sort());
    // Every place an AI record is written is one of the producers read above, or a hand-written path that refuses declared kinds.
    const writers = [...walk('src')].filter((f) => /aiOps\.createAlert\(|aiOps\.createRecommendation\(|aiOps\.createReport\(|aIAgentJob\.create\(|await createAlert\(|safeAlert\(/.test(read(f)));
    expect(writers.sort()).toEqual([
      'src/controllers/ai-ops.controller.ts', 'src/intel/predictive.service.ts', 'src/intelligence/intelligence.service.ts',
      'src/services/anomaly-detector.service.ts', 'src/services/automation.service.ts', 'src/services/rules-engine.service.ts',
      'src/workers/agent-handlers.ts',
    ]);
  });

  it('classifies every coaching-recommendation kind, and only INJURY_RISK as medical', () => {
    expect(Object.entries(COACH_KIND_CLASS).filter(([, c]) => c === 'MEDICAL').map(([k]) => k)).toEqual(['INJURY_RISK']);
  });

  it('(control) the test database drops a NULL agent from IN and from NOT, as PostgreSQL does', () => {
    const r = { agent: null, kind: 'X' };
    expect(matches(r, { agent: { in: ['TACTICAL'] } })).toBe(false);
    expect(matches(r, { NOT: { agent: 'MEDICAL' } })).toBe(false);
    expect(matches(r, { agent: null, kind: { notIn: ['Y'] } })).toBe(true);
  });
});

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

// ── 2. Lists, for every role ────────────────────────────────────────────────
describe.each(LISTS)('$name', ({ url, type, fullShows, listHides, paged }) => {
  const specs = specsOf(type).filter((s) => intelligenceOnly(url, s));

  it.each(NO_ACCESS)('negative: %s is refused', async (role) => {
    const res = await as(role).get(url);
    expect(res.status).toBe(403);
    expect(body(res)).not.toMatch(/SECRET:/);
  });

  it.each(READERS)('%s sees exactly what it is cleared for, each at its tier, never another club’s', async (role) => {
    const res = await as(role).get(url);
    expect(res.status).toBe(200);
    const items = itemsOf(res.body);
    const expected = specs.filter((s) => expectTier(role, s) !== 'NONE');
    expect(items.map((x) => x.id).sort()).toEqual(expected.map((s) => ID(type, s.label)).sort());
    expect(body(res)).not.toMatch(/-c2:/);
    for (const s of specs) {
      const tier = expectTier(role, s);
      for (const f of listHides) expect(body(res)).not.toContain(secret(type, s.label, f));
      for (const f of fullShows) {
        if (tier === 'FULL') expect(body(res)).toContain(secret(type, s.label, f));
        else expect(body(res)).not.toContain(secret(type, s.label, f));
      }
      const item = items.find((x) => x.id === ID(type, s.label));
      if (tier === 'SUMMARY') {
        expect(item!.restricted).toBe(true);
        expect([s.label, Object.keys(item!).filter((k) => !SUMMARY_KEYS[type].includes(k))]).toEqual([s.label, []]);
        expect(JSON.stringify(item)).not.toMatch(/SECRET:/);
      }
      if (tier === 'FULL') expect(item!.restricted).toBeUndefined();
    }
    const total = totalOf(res.body);
    if (total !== undefined) expect(total).toBe(expected.length);
  });

  if (paged) {
    it.each(['CLUB_ADMIN', 'MEDICAL_STAFF', 'ANALYST'] as Role[])('%s: pages add up to the list, and every page reports the same total', async (role) => {
      const all = itemsOf((await as(role).get(url)).body).map((x) => x.id);
      const seen: string[] = [];
      for (let page = 1; page <= all.length + 1; page++) {
        const res = await as(role).get(`${url}?page=${page}&limit=2`);
        expect(totalOf(res.body)).toBe(all.length);
        seen.push(...itemsOf(res.body).map((x) => x.id as string));
      }
      expect(seen).toEqual(all);
    });
  }

  it('negative: another club’s administrator sees none of this club’s records', async () => {
    const res = await as('OTHER').get(url);
    expect(res.status).toBe(200);
    expect(itemsOf(res.body).every((x) => x.clubId === C2)).toBe(true);
    expect((body(res).match(/SECRET:[^"]*/g) ?? []).every((m) => m.includes('-c2:'))).toBe(true);
  });
});

// ── 3. Detail reads, for every role and every record ────────────────────────
describe.each(DETAILS)('$name', ({ url, type, fields, envelope }) => {
  const specs = specsOf(type).filter((s) => intelligenceOnly(url('x'), s));

  it.each(ROLES)('%s: FULL shows everything, SUMMARY nothing it says, anything else is not found', async (role) => {
    for (const s of specs) {
      const res = await as(role).get(url(ID(type, s.label)));
      if (NO_ACCESS.includes(role)) { expect([s.label, res.status]).toEqual([s.label, 403]); continue; }
      const tier = expectTier(role, s);
      if (tier === 'NONE') {
        // Exactly as a record that does not exist: neither its existence nor its class is confirmed.
        expect([s.label, res.status]).toEqual([s.label, 404]);
        expect(body(res)).not.toMatch(/SECRET:|medical/i);
        continue;
      }
      expect([s.label, res.status]).toEqual([s.label, 200]);
      const rec = envelope(res.body);
      expect(rec.id).toBe(ID(type, s.label));
      for (const f of fields) {
        if (tier === 'FULL') expect(body(res)).toContain(secret(type, s.label, f));
        else expect(body(res)).not.toContain(secret(type, s.label, f));
      }
      if (tier === 'SUMMARY') {
        expect(rec.restricted).toBe(true);
        expect([s.label, Object.keys(rec).filter((k) => !SUMMARY_KEYS[type].includes(k))]).toEqual([s.label, []]);
      }
    }
  });

  it('list and detail agree: restricted in one is restricted in the other, and what a list omits is not found', async () => {
    const list = LISTS.find((l) => l.type === type && intelligenceOnly(l.url, specs[0]) && l.url.includes('/phase-s/') === url('x').includes('/phase-s/'))!;
    for (const role of READERS) {
      const listed = new Map(itemsOf((await as(role).get(list.url)).body).map((x) => [x.id as string, x]));
      for (const s of specs) {
        const res = await as(role).get(url(ID(type, s.label)));
        const item = listed.get(ID(type, s.label));
        if (!item) { expect([role, s.label, res.status]).toEqual([role, s.label, 404]); continue; }
        expect([role, s.label, res.status, !!envelope(res.body).restricted]).toEqual([role, s.label, 200, !!item.restricted]);
      }
    }
  });

  it('negative: another club’s record is not found, even by id, in both directions', async () => {
    const res = await as('CLUB_ADMIN').get(url(ID(type, 'ops', C2)));
    expect(res.status).toBe(404);
    expect(body(res)).not.toMatch(/SECRET:/);
    expect((await as('OTHER').get(url(ID(type, 'ops')))).status).toBe(404);
  });
});

// ── 4. Acting on alerts, recommendations and jobs ───────────────────────────
describe('actions', () => {
  it.each(ROLES)('%s: ack needs to see it; resolve needs it in full; mute follows the record’s medical class', async (role) => {
    for (const s of specsOf('alert')) {
      const tier = NO_ACCESS.includes(role) ? 'NONE' : expectTier(role, s);
      const p = `/api/v1/ai-ops/alerts/${ID('alert', s.label)}`;
      seed();
      const ack = await as(role).post(`${p}/ack`);
      expect([s.label, ack.status]).toEqual([s.label, NO_ACCESS.includes(role) ? 403 : tier === 'NONE' ? 404 : 200]);
      expect([s.label, rowOf(s).status]).toEqual([s.label, tier === 'NONE' ? 'OPEN' : 'ACK']);
      if (tier === 'SUMMARY') expect(body(ack)).not.toMatch(/SECRET:/);
      seed();
      const resolve = await as(role).post(`${p}/resolve`);
      expect([s.label, resolve.status]).toEqual([s.label, NO_ACCESS.includes(role) ? 403 : tier === 'NONE' ? 404 : tier === 'FULL' ? 200 : 403]);
      expect([s.label, rowOf(s).status]).toEqual([s.label, tier === 'FULL' ? 'RESOLVED' : 'OPEN']);
      seed();
      const mute = await as(role).post(`${p}/mute`);
      const muteOk = MUTE_ROUTE_ROLES.includes(role) && mayAct(role, s, OPERATIONAL_MUTE_ROLES);
      expect([s.label, mute.status]).toEqual([s.label, !MUTE_ROUTE_ROLES.includes(role) ? 403 : tier === 'NONE' ? 404 : muteOk ? 200 : 403]);
      expect([s.label, rowOf(s).status]).toEqual([s.label, muteOk ? 'MUTED' : 'OPEN']);
    }
    for (const s of specsOf('rec')) {
      const tier = NO_ACCESS.includes(role) ? 'NONE' : expectTier(role, s);
      seed();
      const ack = await as(role).post(`/api/v1/ai-ops/recommendations/${ID('rec', s.label)}/ack`);
      expect([s.label, ack.status]).toEqual([s.label, NO_ACCESS.includes(role) ? 403 : tier === 'NONE' ? 404 : 200]);
    }
  });

  it('medical staff can acknowledge, resolve and mute every medical alert; nobody else can touch one', async () => {
    for (const label of ['fatigue', 'medical', 'ops-health']) {
      for (const action of ['ack', 'resolve', 'mute']) {
        seed();
        expect([label, action, (await as('MEDICAL_STAFF').post(`/api/v1/ai-ops/alerts/${ID('alert', label)}/${action}`)).status]).toEqual([label, action, 200]);
      }
    }
    for (const role of ['SUPER_ADMIN', 'CLUB_ADMIN', 'HEAD_COACH', 'ANALYST'] as Role[]) {
      for (const action of ['ack', 'resolve', 'mute']) {
        seed();
        const res = await as(role).post(`/api/v1/ai-ops/alerts/${ID('alert', 'medical')}/${action}`);
        // Not found to anyone the route lets in; the mute route turns the others away first.
        const want = action === 'mute' && !MUTE_ROUTE_ROLES.includes(role) ? 403 : 404;
        expect([role, action, res.status]).toEqual([role, action, want]);
        expect(rowOf(spec('alert', 'medical')).status).toBe('OPEN');
      }
    }
  });

  it.each(ROLES)('%s: cancelling a job follows the job’s medical class, and answers at the canceller’s tier', async (role) => {
    for (const s of specsOf('job')) {
      seed();
      rowOf(s).status = 'PENDING';
      const res = await as(role).post(`/api/v1/automation/agents/jobs/${ID('job', s.label)}/cancel`);
      const tier = NO_ACCESS.includes(role) ? 'NONE' : expectTier(role, s);
      const ok = CANCEL_ROUTE_ROLES.includes(role) && mayAct(role, s, OPERATIONAL_CANCEL_ROLES);
      expect([s.label, res.status]).toEqual([s.label, !CANCEL_ROUTE_ROLES.includes(role) ? 403 : tier === 'NONE' ? 404 : ok ? 200 : 403]);
      expect([s.label, rowOf(s).status]).toEqual([s.label, ok ? 'CANCELLED' : 'PENDING']);
      if (ok && tier !== 'FULL') expect(body(res)).not.toMatch(/SECRET:/);
    }
  });

  it('a requester can cancel their own unclassified job, and medical staff can cancel a medical one', async () => {
    rowOf(spec('job', 'chat')).status = 'PENDING';
    expect((await as('HEAD_COACH').post(`/api/v1/automation/agents/jobs/${ID('job', 'chat')}/cancel`)).status).toBe(200);
    seed();
    rowOf(spec('job', 'medical')).status = 'PENDING';
    const medic = await as('MEDICAL_STAFF').post(`/api/v1/automation/agents/jobs/${ID('job', 'medical')}/cancel`);
    expect(medic.status).toBe(200);
    expect(medic.body.data).toMatchObject({ id: ID('job', 'medical'), status: 'CANCELLED' });
  });

  it('negative: nobody acts on another club’s alert, recommendation or job', async () => {
    rowOf(spec('job', 'ops'), C2).status = 'PENDING';
    for (const p of [`/api/v1/ai-ops/alerts/${ID('alert', 'ops', C2)}/ack`, `/api/v1/ai-ops/alerts/${ID('alert', 'ops', C2)}/resolve`,
      `/api/v1/ai-ops/alerts/${ID('alert', 'ops', C2)}/mute`, `/api/v1/ai-ops/recommendations/${ID('rec', 'ops', C2)}/ack`,
      `/api/v1/automation/agents/jobs/${ID('job', 'ops', C2)}/cancel`]) {
      expect([p, (await as('CLUB_ADMIN').post(p)).status]).toEqual([p, 404]);
    }
    expect(rowOf(spec('alert', 'ops'), C2).status).toBe('OPEN');
    expect(rowOf(spec('job', 'ops'), C2).status).toBe('PENDING');
  });
});

// ── 5. Hand-written records cannot pass as the platform's own ───────────────
describe('hand-written AI records', () => {
  const cases: Array<[string, string, Row]> = [
    ['an alert', '/api/v1/ai-ops/alerts', { agent: null, kind: 'FATIGUE', title: 'x' }],
    ['an alert', '/api/v1/ai-ops/alerts', { agent: 'TACTICAL', kind: 'TACTICAL_COLLAPSE_RISK', title: 'x' }],
    ['a recommendation', '/api/v1/ai-ops/recommendations', { agent: 'TACTICAL', kind: 'TACTICAL_ADJUSTMENT', content: { x: 1 } }],
    ['a report', '/api/v1/ai-ops/reports', { agent: 'MATCH_OPS', kind: 'MATCH_SUMMARY', title: 't', content: 'c' }],
    ['a job (run)', '/api/v1/ai-ops/agents/TACTICAL/run', { kind: 'INTELLIGENCE.TACTICAL_ADVISOR', input: { prompt: 'x' } }],
    ['a job (enqueue)', '/api/v1/automation/agents/jobs', { agent: 'TRAINING', kind: 'INTELLIGENCE.TRAINING_PLANNER', input: { prompt: 'x' } }],
  ];
  it.each(cases)('negative: %s cannot take a declared producer kind (%s)', async (_what, url, payload) => {
    const before = recordCount();
    const res = await as('CLUB_ADMIN').post(url, payload);
    expect(res.status).toBe(400);
    expect(body(res)).toContain('reserved');
    expect(recordCount()).toBe(before);
  });

  it('a hand-written record with its own kind is written, and is restricted as unclassified', async () => {
    const res = await as('HEAD_COACH').post('/api/v1/ai-ops/alerts', { agent: 'TACTICAL', kind: 'NOTE', title: 'SECRET:hand:title', message: 'hamstring' });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    for (const role of READERS) {
      const listed = itemsOf((await as(role).get('/api/v1/ai-ops/alerts')).body).some((x) => x.id === id);
      expect([role, listed]).toEqual([role, role === 'MEDICAL_STAFF']);
    }
    const job = await as('HEAD_COACH').post('/api/v1/ai-ops/agents/TACTICAL/run', { kind: 'CHAT', input: { prompt: 'SECRET:hand:prompt' } });
    expect([200, 201, 202]).toContain(job.status);
    const jid = job.body.data.id;
    expect((await as('HEAD_COACH').get(`/api/v1/ai-ops/jobs/${jid}`)).body.data.input).toEqual({ prompt: 'SECRET:hand:prompt' });
    expect((await as('ASSISTANT_COACH').get(`/api/v1/ai-ops/jobs/${jid}`)).status).toBe(404);
  });
});

// ── 6. Anomalies, the ARIA history ──────────────────────────────────────────
describe('the remaining AI reads', () => {
  it.each(ROLES)('%s: an anomaly scan needs operational access', async (role) => {
    const res = await as(role).get('/api/v1/ai-ops/anomalies');
    expect(res.status).toBe(EXPECT[role].OPERATIONAL === 'FULL' ? 200 : 403);
  });

  it.each(ROLES)('%s: the ARIA history is the reader’s own, and nobody else’s', async (role) => {
    const res = await as(role).get('/api/v1/ai/history');
    if (NO_ACCESS.includes(role)) { expect(res.status).toBe(403); return; }
    expect(res.status).toBe(200);
    const mine = ['HEAD_COACH', 'CLUB_ADMIN'].includes(role) ? [`insight-${role}`] : [];
    expect(itemsOf(res.body).map((x) => x.id)).toEqual(mine);
    for (const other of ['HEAD_COACH', 'CLUB_ADMIN'].filter((r) => r !== role)) {
      expect(body(res)).not.toContain(secret('insight', other, 'response'));
    }
  });
});

// ── 7. The live match channel ───────────────────────────────────────────────
describe('the live match channel', () => {
  const ev = (kind: string, agent: string | null, k: string) => ({ kind, matchId: 'm', clubId: C1, payload: { id: 'x', kind: k, agent, severity: 'CRITICAL', title: 'SECRET:live:title', message: 'SECRET:live:message', createdAt: 't' } });
  const timeline = { kind: 'TIMELINE_ADDED', matchId: 'm', clubId: C1, payload: { id: 'e' } };
  const live: Array<[string, Row, Spec]> = [
    ['a medical alert', ev('RULES_ALERT', 'MEDICAL', 'INJURY_RISK'), spec('alert', 'medical')],
    ['a fatigue alert', ev('RULES_ALERT', null, 'FATIGUE'), spec('alert', 'fatigue')],
    ['an operational alert', ev('RULES_ALERT', null, 'FORMATION_DRIFT'), spec('alert', 'ops-agentless')],
    ['an unclassified alert', ev('RULES_ALERT', 'TACTICAL', 'PLAYER_UPDATE'), spec('alert', 'undeclared')],
    ['a tactical recommendation', ev('AI_RECOMMENDATION', 'TACTICAL', 'TACTICAL_ADJUSTMENT'), spec('rec', 'ops')],
    ['a medical report', ev('AI_REPORT', 'MEDICAL', 'WEEKLY_HEALTH'), spec('report', 'medical')],
  ];

  it.each(ROLES)('%s: an AI event reaches only a subscriber cleared for all of it; others pass unchanged', (role) => {
    for (const [what, event, s] of live) {
      const out = presentMatchEvent(role, event as never);
      const want = NO_ACCESS.includes(role) ? 'NONE' : expectTier(role, s);
      expect([what, out === null ? 'dropped' : 'passed']).toEqual([what, want === 'FULL' ? 'passed' : 'dropped']);
      if (out) expect(out).toEqual(event);
    }
    expect(presentMatchEvent(role, timeline)).toBe(timeline);
  });

  it('is applied by both match streams, and the alert event names its agent', () => {
    expect(read('src/realtime/match-sse.ts')).toContain('const visible = presentMatchEvent(role, event);');
    expect(read('src/realtime/match-ws.ts')).toContain('const visible = presentMatchEvent(session.role, event);');
    expect(read('src/services/ai-ops.service.ts')).toContain('payload: { id: row.id, kind: row.kind, agent: row.agent, severity: row.severity');
  });
});

// ── 8. Responses to writes carry no more than a read would ──────────────────
describe('write responses', () => {
  const call = async (role: Role, label: string) => {
    const job = rows('aIAgentJob').find((j) => j.id === ID('job', label))!;
    job.input = { ...job.input, entityId: 'team-1' };
    let sent: Row | undefined;
    const res: Row = { status: () => res, json: (b: Row) => { sent = b; return res; } };
    const next = jest.fn();
    await intelligenceCtrl.triggerInjuryRiskScan({ params: { teamId: 'team-1' }, user: { id: uid(role), clubId: C1, role } } as never, res as never, next);
    return { sent, next };
  };

  it('an injury-risk trigger that returns the recent scan gives medical staff the scan, anyone else its bare receipt', async () => {
    const medic = await call('MEDICAL_STAFF', 'medical');
    expect(JSON.stringify(medic.sent)).toContain(secret('job', 'medical', 'output'));
    for (const role of ['HEAD_COACH', 'ANALYST', 'CLUB_ADMIN'] as Role[]) {
      seed();
      const r = await call(role, 'medical');
      expect(r.next).not.toHaveBeenCalled();
      expect(r.sent).toMatchObject({ id: ID('job', 'medical'), restricted: true });
      expect([role, Object.keys(r.sent!).filter((k) => !SUMMARY_KEYS.job.includes(k))]).toEqual([role, []]);
      expect(JSON.stringify(r.sent)).not.toMatch(/SECRET:/);
    }
  });

  it('every intelligence trigger answers through the policy', () => {
    const src = read('src/controllers/intelligence.controller.ts');
    expect(src.match(/res\.status\(202\)\.json\(Svc\.presentTriggered\(actor\(req\), job\)\);/g)).toHaveLength(5);
    expect(src).not.toMatch(/res\.status\(202\)\.json\(job\)/);
  });
});

// ── 9. Medical data does not travel through non-medical agents ──────────────
describe('the source', () => {
  it('the training planner gives the TRAINING agent load figures, never the injury-risk inference', () => {
    const src = read('src/intelligence/intelligence.service.ts');
    const query = src.slice(src.indexOf('workloadRecord?.findMany?.('), src.indexOf('if (records) workloadData = records;'));
    expect(query).toMatch(/select:\s*\{[^}]*acwr: true[^}]*\}/);
    expect(query).not.toMatch(/injuryRiskScore|isHighRisk|riskFlags/);
  });

  it('the mute and cancel routes admit medical staff; the service limits them to medical or unclassified records', () => {
    expect(read('src/routes/ai-ops.routes.ts')).toContain("router.post('/alerts/:id/mute',      authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','MEDICAL_STAFF'), ctrl.muteAlert);");
    expect(read('src/routes/automation.routes.ts')).toContain("router.post('/agents/jobs/:id/cancel', authorize('CLUB_ADMIN','HEAD_COACH','MEDICAL_STAFF'), ctrl.cancelAgentJob);");
  });

  it('every AI read path goes through the policy module', () => {
    for (const f of ['src/services/ai-ops.service.ts', 'src/controllers/ai-ops.controller.ts', 'src/services/automation.service.ts', 'src/intelligence/intelligence.service.ts', 'src/services/ai.service.ts', 'src/coaching/coach-agent.service.ts', 'src/realtime/match-sse.ts', 'src/realtime/match-ws.ts']) {
      expect([f, read(f).includes("from '../security/ai-read-policy'")]).toEqual([f, true]);
    }
    const match = read('src/routes/match.routes.ts');
    expect(match).toContain("router.get('/:id/alerts',          ai.listAlerts);");
    expect(match).toContain("router.get('/:id/recommendations', ai.listRecommendations);");
    expect(match).toContain("router.get('/:id/reports',         ai.listReports);");
  });

  it('(control) another club holds the records the cross-club tests read', () => {
    for (const [type, labels] of Object.entries(C2_LABELS)) for (const l of labels) {
      expect(rows(MODEL[type]).some((x) => x.id === ID(type, l, C2))).toBe(true);
    }
  });
});
