/**
 * tests/cybersecurity.unit.test.ts
 *
 * THE CYBERSECURITY COMMAND CENTER — what is protected, where, how, and the
 * evidence for it.
 *
 * SIX PROPERTIES, AND THEY ARE THE WHOLE REASON THIS ROOM IS ALLOWED TO DRAW A
 * SECURITY POSTURE:
 *
 *   · It INVENTS no state. Protection comes from the coverage map, the
 *     generated security manifest and the posture policy; the live layer from
 *     counts the platform recorded. A domain is PROTECTED only when every
 *     boundary it answers for is covered and every control on them is present.
 *     Nothing is green by default, nothing unmeasured is LIVE, and a read that
 *     failed is UNAVAILABLE — never zero.
 *
 *   · It is COMPLETE, and stays complete. Every trust boundary is answered for
 *     by a domain; every mounted router sits in a platform area; every control
 *     a domain or lifecycle stage names exists in the manifest. A new router
 *     that joins the platform without a place on the map fails here.
 *
 *   · It LEAKS nothing. Counts, instants and evidence metadata travel; no IP
 *     address, user, club or row id, setting value, secret or query does —
 *     even when the database hands one back.
 *
 *   · It CHANGES nothing. Two reads, no writes, no RLS mode or enforcement
 *     change, no process.env assignment.
 *
 *   · It is GUARDED by the platform: the same assertPlatformOwner every other
 *     owner room uses, applied to the router.
 *
 *   · It is FINISHED as a product: three locales in step, Arabic laid out RTL,
 *     a stable layout, an escape hatch, and every string it shows catalogued.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import express from 'express';
import request from 'supertest';

type Row = Record<string, any>;

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOf = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');

const CS_JS = 'public/cybersecurity/cybersecurity.js';
const CS_CSS = 'public/cybersecurity/cybersecurity.css';
const I18N = 'public/cybersecurity/i18n';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRESIDENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLUB = '11111111-1111-4111-8111-111111111111';

// ── a database that answers, fails, or hands back more than it was asked ────

/** What the database is holding, including the parts that must never travel. */
const LEAK = {
  ipAddress: '203.0.113.77',
  userId: 'f00dfeed-0000-4000-8000-000000000001',
  clubId: CLUB,
  metadata: { email: 'victim@example.test', token: 'tok_live_LEAKLEAKLEAK' },
};
const sim = {
  fail: false,
  enforced: false as unknown,
  /** Every call the Command Center made, so a write would be seen. */
  calls: [] as Array<{ model: string; op: string; args: Row }>,
};
const failure = () => new Error('connect ECONNREFUSED postgresql://app:hunter2@db.internal:5432/familista');

function model(name: string, impl: Record<string, (args: Row) => unknown>) {
  return new Proxy({}, {
    get: (_t, op: string) => async (args: Row = {}) => {
      sim.calls.push({ model: name, op, args });
      if (sim.fail) throw failure();
      if (impl[op]) return impl[op](args);
      if (op === 'count') return 0;
      if (op === 'findFirst' || op === 'findUnique') return null;
      return [];
    },
  });
}

const db: Row = {
  securityEvent: model('securityEvent', {
    groupBy: (a) => (a.by.includes('severity')
      ? [
        { kind: 'LOGIN_FAILED', severity: 'WARN', _count: { _all: 3 } },
        { kind: 'TENANT_MISMATCH', severity: 'CRITICAL', _count: { _all: 1 } },
      ]
      : [{ kind: 'LOGIN_FAILED', _count: { _all: 9 } }, { kind: 'TENANT_MISMATCH', _count: { _all: 1 } }]),
    // The full row, whatever `select` asked for: the mapping must drop it.
    findMany: () => [{ id: 'evt-1', kind: 'TENANT_MISMATCH', severity: 'CRITICAL', createdAt: new Date('2026-10-03T09:00:00Z'), ...LEAK }],
  }),
  fabricEventHistory: model('fabricEventHistory', {
    groupBy: () => [{ eventType: 'security.login.failed', _count: { _all: 4 } }],
    findMany: () => [{ id: 'fh-1', eventType: 'security.login.failed', occurredAt: new Date('2026-10-03T08:00:00Z'), payload: LEAK, clubId: CLUB }],
  }),
  deviceSecurityEvent: model('deviceSecurityEvent', { count: () => 2 }),
  aiEgressRecord: model('aiEgressRecord', {
    groupBy: () => [{ outcome: 'OK', _count: { _all: 5 } }, { outcome: 'REFUSED', _count: { _all: 1 } }],
    count: () => 6,
  }),
  aIApprovalRequest: model('aIApprovalRequest', { count: () => 1 }),
  securityAuditEvent: model('securityAuditEvent', {
    count: () => 12,
    findFirst: () => ({ createdAt: new Date('2026-10-02T10:00:00Z'), ...LEAK }),
  }),
  backupRecord: model('backupRecord', {
    findFirst: () => ({ finishedAt: new Date(Date.now() - 2 * 3_600_000) }),
    count: () => 0,
  }),
  user: model('user', { count: (a) => (a.where?.id ? 1 : 2) }),
  mFASetting: model('mFASetting', { findMany: () => [{ userId: OWNER, secretEncrypted: 'enc:SECRETSECRET' }] }),
  platformAdmin: {
    findUnique: async ({ where }: Row) => (where.userId === OWNER ? { isActive: true } : null),
  },
  $queryRaw: async () => {
    sim.calls.push({ model: '$raw', op: '$queryRaw', args: {} });
    if (sim.fail) throw failure();
    return [{ enforced: sim.enforced }];
  },
};

jest.mock('../src/config/database', () => ({ prisma: db, basePrisma: db }));

let actingAs: Row | null = null;
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req: Row, res: Row, next: () => void) => {
    if (!actingAs) { res.status(401).json({ success: false, message: 'unauthenticated' }); return; }
    req.user = actingAs;
    next();
  },
  onIdentityForgotten: () => () => undefined,
  sessionStillValid: async () => true,
}));

import {
  SECURITY_DOMAINS, PLATFORM_AREAS, AREA_GROUPS, SECURITY_LIFECYCLE, METRIC_LABELS, EVENT_KIND_LABELS,
  WARNING_TEXT, CONFIG_VALUES, CONFIG_LABELS, NO_LIVE_TEXT, RLS_STAGES,
} from '../src/cyber-defense/control-plane/registry';
import { commandCenterOverview, commandCenterDomain, type DomainDetail } from '../src/cyber-defense/control-plane/control-plane.service';
import { resetRuntimeSnapshot } from '../src/cyber-defense/control-plane/runtime';
import { resetPostureEvidence } from '../src/cyber-defense/control-plane/posture-source';
import { SECURITY_EVENT_TYPES } from '../src/cyber-defense/security-event-schema';
import {
  noteRlsObservation, rlsObservations, resetRlsObservations,
} from '../src/security/rls-observations';
import cybersecurityRoutes from '../src/routes/cybersecurity.routes';

const manifest = JSON.parse(read('src/cyber-defense/generated/security-manifest.json'));
const coverage = JSON.parse(read('src/cyber-defense/coverage-map.json'));
const policy = JSON.parse(read('src/cyber-defense/posture-policy.json'));
const controlIds = new Set((manifest.controls as Row[]).map((c) => c.id));

function app() {
  const a = express();
  a.use(express.json());
  a.use('/system/cybersecurity', cybersecurityRoutes);
  a.use((err: Row, _req: Row, res: Row, _next: unknown) => {
    res.status(err?.statusCode || err?.status || 500).json({ success: false, message: err?.message });
  });
  return a;
}

const ENV_KEYS = ['DB_RLS_CONTEXT', 'SECURITY_ALERT_EMAIL', 'VISION_WEBHOOK_TOKEN', 'VISION_CLIP_WEBHOOK_TOKEN', 'MFA_REQUIRED_FOR_ADMINS'];
const savedEnv: Row = {};

beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  sim.fail = false;
  sim.enforced = false;
  sim.calls = [];
  actingAs = null;
  for (const k of ENV_KEYS) delete process.env[k];
  resetRuntimeSnapshot();
  resetPostureEvidence();
  resetRlsObservations();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The registry is complete, and joins nothing to nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('the security registry covers the whole platform, and stays covering it', () => {
  const rowIds = Object.keys(coverage.boundaries).map(Number);

  it('names every domain the owner asked to see', () => {
    expect(SECURITY_DOMAINS.map((d) => d.title)).toEqual([
      'Identity & Access Security', 'MFA & Session Security', 'Club / Tenant Isolation',
      'PostgreSQL Row-Level Security', 'API Security', 'AI & ML Security', 'Video Intelligence Security',
      'Camera / Device Security', 'Webhook & SSRF Protection', 'Data Protection & Encryption',
      'Secrets Management', 'Storage Security', 'Backup & Disaster Recovery', 'Audit & Evidence',
      'Security Events & Alerts', 'Dependency / Supply Chain Security', 'Infrastructure Security',
      'Security Monitoring',
    ]);
    expect(new Set(SECURITY_DOMAINS.map((d) => d.id)).size).toBe(SECURITY_DOMAINS.length);
  });

  it('answers for every trust boundary in the coverage map — none is outside the Command Center', () => {
    const answered = new Set(SECURITY_DOMAINS.flatMap((d) => d.rows));
    expect(rowIds.filter((id) => !answered.has(id))).toEqual([]);
  });

  it('names only boundaries, controls, event kinds and signals that exist', () => {
    const kinds = new Set([...read('prisma/schema.prisma').matchAll(/enum SecurityEventKind \{([^}]*)\}/g)][0][1]
      .split(/\s+/).filter(Boolean));
    const types = new Set(SECURITY_EVENT_TYPES.map((t) => t.type));
    for (const d of SECURITY_DOMAINS) {
      for (const r of d.rows) expect(`${d.id} row ${r}: ${rowIds.includes(r)}`).toBe(`${d.id} row ${r}: true`);
      for (const c of d.extraControls) expect(`${d.id} ${c}: ${controlIds.has(c)}`).toBe(`${d.id} ${c}: true`);
      for (const k of d.eventKinds) if (k !== '*') expect(`${d.id} ${k}: ${kinds.has(k)}`).toBe(`${d.id} ${k}: true`);
    }
    // Every declared signal names a domain that exists, so a new signal lands
    // on the map the moment it is declared — and only the events domain reads
    // them all.
    const ids = new Set(SECURITY_DOMAINS.map((d) => d.id));
    for (const t of SECURITY_EVENT_TYPES) expect(`${t.type} → ${t.evidences}: ${ids.has(t.evidences)}`).toBe(`${t.type} → ${t.evidences}: true`);
    expect(SECURITY_DOMAINS.filter((d) => d.allSignals).map((d) => d.id)).toEqual(['events']);
    expect(types.size).toBe(SECURITY_EVENT_TYPES.length);
    for (const k of Object.keys(EVENT_KIND_LABELS)) expect(kinds.has(k)).toBe(true);
    for (const s of SECURITY_LIFECYCLE) {
      for (const c of s.controls) expect(`${s.id} ${c}: ${controlIds.has(c)}`).toBe(`${s.id} ${c}: true`);
    }
  });

  it('places every mounted router in a platform area — new development cannot join off the map', () => {
    const assigned = new Set(PLATFORM_AREAS.flatMap((a) => a.routers));
    const mapped = Object.keys(coverage.components.routers);
    expect(mapped.filter((r) => !assigned.has(r)).sort()).toEqual([]);
    // And no area names a router that does not exist.
    expect([...assigned].filter((r) => !mapped.includes(r)).sort()).toEqual([]);
    // The two lists are the same thing seen twice: the manifest's mounts.
    const mounted = (manifest.apiSurface.mounts as Row[]).map((m) => m.module);
    expect(mounted.filter((m) => !assigned.has(m)).sort()).toEqual([]);
  });

  it('covers every area the owner asked to see, each in a group the map draws', () => {
    const titles = PLATFORM_AREAS.map((a) => a.title);
    for (const t of ['System', 'Clubs & club workspaces', 'Users, roles & permissions', 'Authentication, MFA & sessions',
      'Databases & tenant data', 'PostgreSQL / RLS', 'APIs', 'Realtime & WebSockets', 'AI Gateway & AI engines',
      'ML, models & training data', 'Agents & multi-agent systems', 'Video Intelligence', 'Cameras', 'Sensors & devices',
      'Uploads & media', 'Object storage', 'Data Vault', 'Data Fabric & data sources', 'Integrations & webhooks',
      'Transfers', 'Coach Market', 'Academy', 'Match Center', 'Familista League', 'Infrastructure & services',
      'Backups & disaster recovery', 'Secrets', 'Audit trails', 'CI/CD & deployments', 'Dependencies & supply chain',
      'Security events, alerts & monitoring']) {
      expect(`${t}: ${titles.includes(t)}`).toBe(`${t}: true`);
    }
    const groups = new Set(AREA_GROUPS.map((g) => g.id));
    for (const a of PLATFORM_AREAS) {
      expect(groups.has(a.group)).toBe(true);
      for (const r of a.rows) expect(rowIds.includes(r)).toBe(true);
      // An area with no router must say why, or the map cannot explain it.
      if (!a.routers.length) expect(`${a.id}: ${!!a.note}`).toBe(`${a.id}: true`);
    }
  });

  it('is itself an owner room, pinned and mapped like the other six', () => {
    expect(policy.ownerRooms['cybersecurity.routes']).toEqual({ mount: '/system/cybersecurity' });
    expect(coverage.components.routers['cybersecurity.routes']).toEqual([4, 5, 6, 7, 35, 36]);
    expect(policy.tenancyExemptions['cybersecurity.routes :domain'].basis).toBe('platform-only');
    expect(manifest.apiSurface.authorization.byRouter['cybersecurity.routes']).toEqual({ 'platform-owner': 2 });
  });

  it('holds no status of its own — status comes only from evidence', () => {
    const reg = codeOf(read('src/cyber-defense/control-plane/registry.ts'));
    expect(reg).not.toMatch(/\b(PROTECTED|AT_RISK|OBSERVING)\b/);
    expect(reg).not.toMatch(/status\s*:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · States are evidence, and absence is said
// ─────────────────────────────────────────────────────────────────────────────

describe('a state is what the evidence says, and nothing kinder', () => {
  it('is PROTECTED only when every boundary is covered and every control is present', async () => {
    const o = await commandCenterOverview();
    expect(o.state).toBe('READY');
    const rows = new Map(o.boundaries.map((b) => [b.id, b]));
    for (const d of o.domains) {
      const anyOpenRow = d.rows.some((id) => rows.get(id)!.coverage !== 'C');
      const anyMissingControl = d.controls.present < d.controls.total;
      if (anyOpenRow || anyMissingControl) {
        expect(`${d.id}: ${d.protection}`).not.toBe(`${d.id}: PROTECTED`);
        expect(`${d.id}: ${d.state}`).not.toBe(`${d.id}: PROTECTED`);
      }
    }
    // The verdict is the weakest boundary: while any boundary is partial, the
    // posture is never drawn as protected.
    const open = o.boundaries.filter((b) => b.coverage !== 'C').length;
    if (open) expect(o.posture!.verdict).not.toBe('PROTECTED');
    expect(o.posture!.boundaries.C + o.posture!.boundaries.P + o.posture!.boundaries.U).toBe(o.posture!.boundaries.total);
  });

  it('never calls a domain LIVE when nothing measures it at runtime', async () => {
    const o = await commandCenterOverview();
    const byId = new Map(o.domains.map((d) => [d.id, d]));
    for (const id of ['video', 'storage', 'webhooks', 'data-protection', 'secrets', 'infrastructure']) {
      expect(`${id}: ${byId.get(id)!.live}`).toBe(`${id}: NOT_INSTRUMENTED`);
      expect(byId.get(id)!.liveWhy).toBeTruthy();
    }
    // Enforced before deploy: there is nothing to measure, and it says so.
    expect(byId.get('supply-chain')!.live).toBe('NOT_APPLICABLE');
  });

  it('shows a measured zero as 0 and a failed read as null with a reason — never 0', async () => {
    sim.fail = true;
    const o = await commandCenterOverview();
    expect(o.events.state).toBe('UNAVAILABLE');
    expect(o.events.total24h).toBeNull();
    for (const k of o.events.kinds) {
      expect(k.count24h).toBeNull();
      expect(k.count7d).toBeNull();
      expect(k.critical24h).toBeNull();
    }
    for (const s of o.events.signals) expect(s.count24h).toBeNull();
    for (const d of o.domains) {
      for (const f of d.figures.filter((x) => x.source === 'runtime')) {
        expect(`${d.id}.${f.key}: ${f.value}`).toBe(`${d.id}.${f.key}: null`);
        expect(f.why).toBeTruthy();
      }
    }
    const rls = o.domains.find((d) => d.id === 'rls')!;
    expect(rls.state).not.toBe('PROTECTED');
    expect(o.rls!.enforced).toBeNull();
    expect(o.rls!.state).toBe('UNKNOWN');
  });

  it('reads real counts when the database answers', async () => {
    const o = await commandCenterOverview();
    expect(o.events.state).toBe('WARNING'); // a CRITICAL event in 24 hours
    expect(o.events.total24h).toBe(4);
    expect(o.events.critical24h).toBe(1);
    const tenant = o.domains.find((d) => d.id === 'tenant')!;
    expect(tenant.warnings.map((w) => w.key)).toContain('events.tenantMismatch');
    const ai = o.domains.find((d) => d.id === 'ai-ml')!;
    expect(ai.figures.find((f) => f.key === 'ai.calls24h')!.value).toBe(6);
    expect(ai.figures.find((f) => f.key === 'ai.refused24h')!.value).toBe(1);
  });
});

describe('row-level security keeps the context and the wall apart', () => {
  const rlsOf = async () => (await commandCenterOverview()).rls!;

  it('context on, enforcement off: OBSERVING at stage three of four', async () => {
    process.env.DB_RLS_CONTEXT = 'on';
    sim.enforced = false;
    const r = await rlsOf();
    expect(r.mode).toBe('on');
    expect(r.enforced).toBe(false);
    expect(r.state).toBe('OBSERVING');
    expect(r.stage.id).toBe('context');
    expect(r.stages.map((s) => s.reached)).toEqual([true, true, true, false]);
    expect(r.tables).toEqual(policy.rlsPilotTables);
  });

  it('observe: OBSERVING at stage two', async () => {
    process.env.DB_RLS_CONTEXT = 'observe';
    const r = await rlsOf();
    expect(r.state).toBe('OBSERVING');
    expect(r.stage.id).toBe('observe');
  });

  it('off: installed, PARTIAL — the policies exist and nothing sends a context', async () => {
    const r = await rlsOf();
    expect(r.mode).toBe('off');
    expect(r.state).toBe('PARTIAL');
    expect(r.stage.id).toBe('installed');
  });

  it('enforced without a context is AT RISK, and says why', async () => {
    sim.enforced = true;
    const r = await rlsOf();
    expect(r.state).toBe('AT_RISK');
    expect(r.warnings.map((w) => w.key)).toContain('rls.enforcedWithoutContext');
  });

  it('enforced with the context on is the only PROTECTED stage', async () => {
    process.env.DB_RLS_CONTEXT = 'on';
    sim.enforced = true;
    const r = await rlsOf();
    expect(r.state).toBe('PROTECTED');
    expect(r.stage.id).toBe('enforced');
  });

  it('a non-boolean answer from the database is UNKNOWN, not "off"', async () => {
    sim.enforced = 't';
    const r = await rlsOf();
    expect(r.enforced).toBeNull();
    expect(r.state).toBe('UNKNOWN');
  });

  it('surfaces queries seen without a context, with model and operation only', async () => {
    process.env.DB_RLS_CONTEXT = 'on';
    noteRlsObservation('Player', 'findMany');
    const r = await rlsOf();
    expect(r.observations).toEqual([{ model: 'Player', operation: 'findMany', firstSeenAt: expect.any(String) }]);
    expect(r.warnings.map((w) => w.key)).toContain('rls.observations');
  });
});

describe('the in-memory observation record', () => {
  it('records each model and operation once, and never throws', () => {
    noteRlsObservation('Player', 'findMany');
    noteRlsObservation('Player', 'findMany');
    noteRlsObservation('Membership', 'count');
    expect(rlsObservations().map((o) => `${o.model}.${o.operation}`)).toEqual(['Player.findMany', 'Membership.count']);
    expect(() => noteRlsObservation(undefined as unknown as string, null as unknown as string)).not.toThrow();
  });

  it('is bounded', () => {
    for (let i = 0; i < 700; i++) noteRlsObservation(`M${i}`, 'findMany');
    expect(rlsObservations().length).toBe(500);
  });

  it('is fed by the same reporter that writes the log line, and changes nothing about the query', () => {
    const src = codeOf(read('src/config/database.ts'));
    const at = src.indexOf('withRlsContext(basePrisma');
    const reporter = src.slice(at, src.indexOf('});', src.indexOf('noteRlsObservation', at)));
    expect(reporter).toContain("logger.warn('[rls] pilot table queried with no database context'");
    expect(reporter).toContain('noteRlsObservation(model, operation);');
    const rec = codeOf(read('src/security/rls-observations.ts'));
    expect(rec).toContain('catch (_)');
    expect(rec).not.toMatch(/args|query|clubId|userId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Nothing leaks, even when the database hands it back
// ─────────────────────────────────────────────────────────────────────────────

describe('it leaks nothing', () => {
  const SECRET_TOKEN = 'vision-webhook-secret-0123456789abcdef0123456789';
  const ALERT_TO = 'security-owner@example.test';

  const everything = async () => {
    process.env.DB_RLS_CONTEXT = 'on';
    process.env.SECURITY_ALERT_EMAIL = ALERT_TO;
    process.env.VISION_WEBHOOK_TOKEN = SECRET_TOKEN;
    const o = await commandCenterOverview();
    const details: DomainDetail[] = [];
    for (const d of SECURITY_DOMAINS) {
      const found = await commandCenterDomain(d.id);
      if (found.state !== 'READY') throw new Error(d.id);
      details.push(found.detail);
    }
    return JSON.stringify({ o, details });
  };

  it('returns no IP address, id, e-mail, token, secret or connection string', async () => {
    const out = await everything();
    for (const bad of [LEAK.ipAddress, LEAK.userId, LEAK.clubId, LEAK.metadata.email, LEAK.metadata.token,
      'enc:SECRETSECRET', 'evt-1', 'fh-1', SECRET_TOKEN, ALERT_TO, 'hunter2', 'postgresql://', OWNER]) {
      expect(`${bad}: ${out.includes(bad)}`).toBe(`${bad}: false`);
    }
    expect(out).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(out).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it('reports a configured secret as a fact, never as a value', async () => {
    process.env.VISION_WEBHOOK_TOKEN = SECRET_TOKEN;
    process.env.SECURITY_ALERT_EMAIL = ALERT_TO;
    const o = await commandCenterOverview();
    const webhooks = o.domains.find((d) => d.id === 'webhooks')!;
    expect(webhooks.config.find((c) => c.key === 'webhooks.vision')!.value).toBe('Open — signed callbacks only');
    expect(o.events.alerts.recipientConfigured).toBe(true);
    // A setting travels as one word from a closed vocabulary — never a value,
    // a length or a fragment of one.
    for (const d of o.domains) {
      for (const c of d.config) expect(`${d.id}.${c.key}: ${(CONFIG_VALUES as readonly string[]).includes(c.value)}`).toBe(`${d.id}.${c.key}: true`);
    }
    expect(webhooks.figures).toEqual([]);
  });

  it('names no secret-bearing setting at all', async () => {
    const out = await everything();
    for (const name of (manifest.secrets.envVars as Row[] | undefined ?? []).filter((v) => v.secretNamed).map((v) => v.name)) {
      expect(`${name}: ${out.includes(name)}`).toBe(`${name}: false`);
    }
    for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'BACKUP_ENCRYPTION_KEY']) {
      expect(`${name}: ${out.includes(name)}`).toBe(`${name}: false`);
    }
  });

  it('asks the database for kind, severity and time — and maps away anything else that comes back', async () => {
    await commandCenterDomain('events');
    const ev = sim.calls.find((c) => c.model === 'securityEvent' && c.op === 'findMany')!;
    expect(Object.keys(ev.args.select).sort()).toEqual(['createdAt', 'kind', 'severity']);
    const sig = sim.calls.find((c) => c.model === 'fabricEventHistory' && c.op === 'findMany')!;
    expect(Object.keys(sig.args.select).sort()).toEqual(['eventType', 'occurredAt']);
    const d = await commandCenterDomain('events');
    if (d.state !== 'READY') throw new Error('not ready');
    expect(d.detail.recentEvents.items[0]).toEqual({ kind: 'TENANT_MISMATCH', severity: 'CRITICAL', at: '2026-10-03T09:00:00.000Z', label: EVENT_KIND_LABELS.TENANT_MISMATCH });
    expect(d.detail.recentSignals.items[0]).toEqual({ type: 'security.login.failed', at: '2026-10-03T08:00:00.000Z' });
  });

  it('says a failed read in words, never with the error it caught', async () => {
    sim.fail = true;
    const out = JSON.stringify(await commandCenterOverview());
    expect(out).not.toContain('ECONNREFUSED');
    expect(out).not.toContain('db.internal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Read-only, and the platform owner's alone
// ─────────────────────────────────────────────────────────────────────────────

describe('only the platform owner, and only to read', () => {
  it('admits the platform owner, with no-store', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    const res = await request(app()).get('/system/cybersecurity');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.state).toBe('READY');
  });

  it('serves every domain, and 404s a name that is not one', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const d of SECURITY_DOMAINS) {
      const res = await request(app()).get(`/system/cybersecurity/domains/${d.id}`);
      expect(`${d.id}: ${res.status}`).toBe(`${d.id}: 200`);
      expect(res.body.data.id).toBe(d.id);
    }
    expect((await request(app()).get('/system/cybersecurity/domains/not-a-domain')).status).toBe(404);
  });

  it('refuses a club administrator, however senior in their club', async () => {
    actingAs = { id: PRESIDENT, clubId: CLUB, role: 'CLUB_ADMIN' };
    for (const route of ['/system/cybersecurity', '/system/cybersecurity/domains/rls']) {
      const res = await request(app()).get(route);
      expect(`${route}: ${res.status}`).toBe(`${route}: 403`);
      expect(JSON.stringify(res.body)).not.toContain('posture');
    }
  });

  it('refuses an unauthenticated caller before the guard', async () => {
    expect((await request(app()).get('/system/cybersecurity')).status).toBe(401);
  });

  it('uses the platform\'s own guard, not a second one', () => {
    const src = codeOf(read('src/routes/cybersecurity.routes.ts'));
    expect(src).toContain('router.use(authenticate);');
    expect(src).toContain('await assertPlatformOwner(');
    expect(src).not.toMatch(/SUPER_ADMIN|role\s*===/);
  });

  it('has no writing route, and its sources write nothing and change no setting', async () => {
    const routes = codeOf(read('src/routes/cybersecurity.routes.ts'));
    for (const verb of ['post', 'put', 'patch', 'delete']) {
      expect(`${verb}: ${new RegExp(`router\\.${verb}\\(`).test(routes)}`).toBe(`${verb}: false`);
    }
    const plane = ['registry.ts', 'posture-source.ts', 'runtime.ts', 'control-plane.service.ts']
      .map((f) => codeOf(read(`src/cyber-defense/control-plane/${f}`))).join('\n');
    expect(plane).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(plane).not.toMatch(/\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe/);
    expect(plane).not.toMatch(/process\.env\.[A-Z_]+\s*=[^=]/);
    expect(plane).not.toMatch(/writeFileSync|appendFileSync/);
    // And at runtime: every call it made was a read.
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    await request(app()).get('/system/cybersecurity');
    await request(app()).get('/system/cybersecurity/domains/events');
    const ops = new Set(sim.calls.map((c) => c.op));
    for (const op of ops) expect(['groupBy', 'count', 'findFirst', 'findMany', '$queryRaw']).toContain(op);
  });

  it('reads the database\'s RLS switch with the one fixed query, and nothing else raw', () => {
    const rt = codeOf(read('src/cyber-defense/control-plane/runtime.ts'));
    const raws = rt.match(/\$queryRaw/g) || [];
    expect(raws.length).toBe(1);
    expect(rt).toContain('SELECT public.familista_rls_enforced() AS enforced');
  });

  it('says NOT GENERATED rather than 404 when the evidence is missing beside the server', () => {
    const route = codeOf(read('src/routes/cybersecurity.routes.ts'));
    expect(route).toContain("found.state === 'UNKNOWN_DOMAIN'");
    expect(route).toContain("found.state === 'NOT_GENERATED'");
    expect(read('scripts/copy-runtime-assets.js')).toContain("'dist/cyber-defense/generated/security-manifest.json'");
    expect(read('scripts/copy-runtime-assets.js')).toContain("'dist/cyber-defense/posture-policy.json'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · The room, as a finished product
// ─────────────────────────────────────────────────────────────────────────────

describe('the Command Center draws evidence and invents none', () => {
  const src = read(CS_JS);
  const code = codeOf(src);

  it('holds no list of controls, statuses or numbers of its own', () => {
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/'(tenant-guard|db-rls-pilot|codeowners|audit-hash-chain)'/);
    // The only status words in the module are the vocabulary that maps them.
    const vocab = code.slice(code.indexOf('function stateKind'), code.indexOf('function chip('));
    const outside = code.replace(vocab, '');
    expect(outside).not.toMatch(/'PROTECTED'\s*:/);
  });

  it('maps every state to one colour kind, and keeps the three greys apart', () => {
    const sandbox: Row = { window: {}, document: {}, localStorage: { getItem: () => null, setItem: () => {} } };
    vm.runInNewContext(src, sandbox);
    const kind = sandbox.window.__familistaCybersecurityStateKind as (s: string) => string;
    expect(kind('PROTECTED')).toBe('ok');
    expect(kind('PARTIAL')).toBe('warn');
    expect(kind('AT_RISK')).toBe('crit');
    expect(kind('OBSERVING')).toBe('obs');
    expect(kind('NOT_INSTRUMENTED')).toBe('none');
    expect(kind('NOT_APPLICABLE')).toBe('na');
    expect(kind('UNAVAILABLE')).toBe('off');
    expect(kind('UNKNOWN')).toBe('unknown');
    expect(kind('')).toBe('unknown');
    const css = read(CS_CSS);
    expect(css).toContain('.cs-chip--none    { color: var(--cs-off);  border-color: rgba(91, 100, 128, .44); border-style: dotted; }');
    expect(css).toContain('.cs-chip--na      { color: var(--cs-off);  border-color: rgba(91, 100, 128, .44); border-style: dashed; }');
  });

  it('shows an em dash with a reason for an absent figure, never a zero', () => {
    expect(code).toContain("if (!has(f.value)) return absent(T(f.why || 'Not measured.'));");
    expect(code).toMatch(/function num\(n\) \{\s*if \(typeof n !== 'number' \|\| !isFinite\(n\)\) return '—';/);
  });

  it('names the fields it cannot draw without, and says CONTRACT ERROR rather than drawing empty', () => {
    expect(code).toContain('var REQUIRED = {');
    expect(code).toContain("overview: ['state', 'measuredAt', 'instance', 'groups', 'domains', 'areas', 'events']");
    expect(code).toContain("domain: ['controlList', 'rowList', 'recentEvents', 'recentSignals']");
    const fn = code.slice(code.indexOf('function missingFields'), code.indexOf('function contractError'));
    expect(fn).toContain('=== undefined');
    expect(fn).toContain('=== null');
    expect(fn).not.toMatch(/\.length\s*===\s*0/);
    const ce = code.slice(code.indexOf('function contractError'), code.indexOf('function loadOverview'));
    expect(ce).toContain("T('CONTRACT ERROR')");
    expect(ce).toContain("missing.join(', ')");
  });

  it('quotes repository evidence as recorded, in English, and never translates it', () => {
    const q = code.slice(code.indexOf('function quote('), code.indexOf('// ── figures'));
    expect(q).toContain('lang="en" dir="ltr" data-no-i18n');
    expect(code).toContain("quote(b.reason, 'Why it is not fully covered, as recorded')");
    expect(code).toContain("quote(g.text, 'As the posture policy records it')");
    expect(code).toContain('<code class="cs-ctl-id" data-no-i18n>');
  });

  it('never changes anything: every request it makes is a GET', () => {
    expect(code).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/i);
    expect(code).toContain("cache: 'no-store'");
    expect(code).toContain("api('/system/cybersecurity')");
    expect(code).toContain("api('/system/cybersecurity/domains/' + encodeURIComponent(id))");
  });
});

describe('nothing moves that the reader did not move', () => {
  const css = read(CS_CSS);
  const code = codeOf(read(CS_JS));

  it('is a fixed-height workspace whose body scrolls inside itself, with a stable gutter', () => {
    expect(css).toMatch(/\.cs-shell \{ display: flex; height: 100vh; height: 100dvh; overflow: hidden; \}/);
    expect(css).toMatch(/\.cs-body \{[^}]*overflow-y: auto; scrollbar-gutter: stable;/);
  });

  it('floats its inspector, animated on opacity and transform only', () => {
    expect(css).toMatch(/\.cs-insp \{[^}]*position: fixed;/);
    expect(css).toMatch(/\.cs-insp-scrim \{[^}]*position: fixed;/);
    for (const kf of css.matchAll(/@keyframes [\w-]+ \{([^@]*?)\}\s*\}/g)) {
      expect(kf[1]).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding|inset)\s*:/);
    }
    // Opened and closed on its own: the page under it is never repainted.
    const open = code.slice(code.indexOf('function openInspector'), code.indexOf('function closeInspector'));
    expect(open).not.toContain('repaintBody');
  });

  it('has no idle motion, and pointing at the map changes colour and opacity only', () => {
    expect(css).not.toMatch(/infinite/);
    for (const t of css.matchAll(/transition:\s*([^;]+);/g)) {
      expect(t[1]).not.toMatch(/\b(width|height|margin|padding|top|left|transform|all)\b/);
    }
    const focus = code.slice(code.indexOf('function applyFocus'), code.indexOf('var NARROW'));
    expect(focus).not.toMatch(/innerHTML|outerHTML/);
  });

  it('sizes its skeleton like the content it stands in for, and its buttons so a label change moves nothing', () => {
    expect(css).toContain('.cs-skel-hero { height: 214px;');
    expect(css).toContain('.cs-skel-row--control { height: 58px; }');
    expect(css).toMatch(/\.cs-btn \{[^}]*min-width: 112px;/);
    expect(css).toMatch(/\.cs-lens \{[^}]*height: 40px;/);
  });

  it('carries the escape hatch, and stops drawing wires when the columns stop facing each other', () => {
    expect(css).toContain('@media (max-width: 980px), (max-height: 620px) {');
    const hatch = css.slice(css.indexOf('@media (max-width: 980px), (max-height: 620px) {'));
    expect(hatch).toContain('body.cs-cyber-open { overflow: auto; }');
    expect(hatch).toContain('.cs-wires { display: none; }');
    expect(code).toContain("var NARROW = '(max-width: 980px), (max-height: 620px)';");
  });

  it('draws under the platform CSP: no inline style, handler or script', () => {
    // The CSP's style-src has no 'unsafe-inline'. A style attribute is refused
    // in production — so bars are SVG geometry and skeleton heights are classes.
    expect(code).not.toMatch(/style="/);
    expect(code).not.toMatch(/\son[a-z]+="/);
    expect(code).not.toMatch(/<style|<script/);
    const card = read('public/app.js');
    const markup = card.slice(card.indexOf('<button class="oh-card oh-card--cyber"'), card.indexOf('<button class="oh-card oh-card--clubs"'));
    expect(markup).not.toMatch(/style="/);
  });

  it('honours a request for less motion', () => {
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toContain('.cs-insp, .cs-insp-scrim { animation: none; }');
  });
});

describe('the Command Center speaks English, German and Arabic — and only those', () => {
  const en = JSON.parse(read(`${I18N}/en.json`));
  const de = JSON.parse(read(`${I18N}/de.json`));
  const ar = JSON.parse(read(`${I18N}/ar.json`));
  const code = codeOf(read(CS_JS));

  it('ships exactly three catalogues, key for key', () => {
    expect(fs.readdirSync(path.join(ROOT, I18N)).sort()).toEqual(['ar.json', 'de.json', 'en.json']);
    const keys = Object.keys(en).sort();
    expect(keys.length).toBeGreaterThan(400);
    expect(Object.keys(de).sort()).toEqual(keys);
    expect(Object.keys(ar).sort()).toEqual(keys);
    for (const k of keys) expect(en[k]).toBe(k);
  });

  it('actually translates, keeps every number slot, and writes Arabic in Arabic script', () => {
    expect(Object.entries(ar).filter(([k, v]) => v === k)).toEqual([]);
    for (const [k, v] of Object.entries({ ...de, ...ar }) as Array<[string, string]>) {
      expect(v.trim().length).toBeGreaterThan(0);
      void k;
    }
    for (const k of Object.keys(en)) {
      for (const cat of [de, ar]) {
        expect(`${k}: ${(cat[k].match(/%d/g) || []).length}`).toBe(`${k}: ${(k.match(/%d/g) || []).length}`);
        expect(`${k}: ${(cat[k].match(/%s/g) || []).length}`).toBe(`${k}: ${(k.match(/%s/g) || []).length}`);
      }
    }
    for (const k of ['Cybersecurity', 'Command Center', 'Security Domains', 'Protected', 'Not instrumented', 'Observing']) {
      expect(ar[k]).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('has an entry for every string the module asks for', () => {
    const asked = new Set<string>();
    const add = (v: string) => { if (v && /[A-Za-z]/.test(v)) asked.add(v.replace(/\\'/g, "'")); };
    for (const m of code.matchAll(/\bT\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) add(m[1]);
    for (const m of code.matchAll(/\btf\(\s*'((?:[^'\\]|\\.)*)'/g)) add(m[1]);
    for (const fn of ['panel', 'emptyState', 'quote']) {
      for (const m of code.matchAll(new RegExp('\\b' + fn + "\\(\\s*'((?:[^'\\\\]|\\\\.)*)'", 'g'))) add(m[1]);
    }
    for (const block of [/var SECTIONS = \[[\s\S]*?\];/, /var GROUP_LABEL = \{[\s\S]*?\};/, /var STATE_MEANING = \{[\s\S]*?\};/,
      /var SOURCE_LABEL = \{[\s\S]*?\};/, /var TEXT_VALUE = \{[\s\S]*?\};/]) {
      const b = (code.match(block) || [''])[0];
      expect(b.length).toBeGreaterThan(0);
      for (const m of b.matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (/^[A-Z]/.test(m[1]) && /[a-z ]/.test(m[1])) add(m[1]);
    }
    expect(asked.size).toBeGreaterThan(150);
    expect([...asked].filter((k) => !(k in en))).toEqual([]);
  });

  it('has an entry for every string the server sends for it to show', () => {
    const sent = new Set<string>();
    for (const d of SECURITY_DOMAINS) { sent.add(d.title); sent.add(d.protects); }
    for (const a of PLATFORM_AREAS) { sent.add(a.title); if (a.note) sent.add(a.note); }
    for (const g of AREA_GROUPS) sent.add(g.title);
    for (const s of SECURITY_LIFECYCLE) { sent.add(s.title); sent.add(s.describes); if (s.outsideView) sent.add(s.outsideView); }
    for (const s of RLS_STAGES) { sent.add(s.title); sent.add(s.describes); }
    for (const t of [METRIC_LABELS, EVENT_KIND_LABELS, WARNING_TEXT, CONFIG_LABELS, NO_LIVE_TEXT]) Object.values(t).forEach((v) => sent.add(v));
    CONFIG_VALUES.forEach((v) => sent.add(v));
    SECURITY_EVENT_TYPES.forEach((t) => sent.add(t.describes));
    for (const b of Object.values(coverage.boundaries) as Row[]) sent.add(b.name);
    // Product and technology names are the only exceptions: they render as
    // themselves in every language because the catalogue has no entry for them.
    const products = new Set(['Data Vault', 'PostgreSQL', 'Redis', 'Stripe']);
    expect([...sent].filter((k) => !products.has(k) && !(k in en)).sort()).toEqual([]);
    for (const p of products) expect(`${p}: ${p in en}`).toBe(`${p}: false`);
  });

  it('sets the direction from the locale, and lays the shell out for RTL', () => {
    expect(code).toContain("[['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']]");
    expect(code).toContain("host.setAttribute('dir', CS_DIR)");
    expect(code).toContain('CS_DIR = l[2]');
    const css = read(CS_CSS);
    expect(css).toContain('@keyframes cs-slide-rtl');
    expect(css).toContain('#cs-root[dir="rtl"] .cs-insp { animation-name: cs-slide-rtl; }');
    expect(css).toContain('border-inline-end');
    expect(css).toContain('inset-inline-end');
    // Wires are drawn from the edge that faces the other column, in either direction.
    const wires = code.slice(code.indexOf('function drawWires'), code.indexOf('function focusOf'));
    expect(wires).toContain("var rtl = CS_DIR === 'rtl';");
  });

  it('keeps its catalogue out of the club-facing locale files and the platform extractor', () => {
    const club = JSON.parse(read('public/i18n/catalogue/de-DE.json'));
    expect(club['Command Center']).toBeUndefined();
    expect(club['Security Domains']).toBeUndefined();
    const extractor = read('scripts/i18n-extract.js');
    expect(extractor.slice(extractor.indexOf('const SOURCES = ['), extractor.indexOf('const OUT'))).not.toContain('cybersecurity');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · A top-level room, beside SYSTEM and CLUBS
// ─────────────────────────────────────────────────────────────────────────────

describe('Cybersecurity is a top-level room, not a page inside another', () => {
  const app = read('public/app.js');
  const css = read('public/app.css');
  const html = read('public/index.html');

  it('is wired everywhere a room has to be wired', () => {
    expect(app).toContain("'cybersecurity':               ['renderFamilistaCybersecurity'],");
    expect(app).toContain("case 'pg-cybersecurity':      renderFamilistaCybersecurity(document.getElementById('cs-root')); break;");
    expect(app).toContain("document.body.classList.toggle('cs-cyber-open', page === 'cybersecurity');");
    expect(app).toContain("window.teardownFamilistaCybersecurity();");
    expect(app).toContain("    'cybersecurity': 1,");
    expect(app).toContain("'cybersecurity':               renderCybersecurityHTML,");
    expect(app).toContain('<div class="page" id="pg-cybersecurity" data-no-i18n><div id="cs-root"></div></div>');
    const eager = app.slice(app.indexOf('var _EAGER_PAGES = ['), app.indexOf('];', app.indexOf('var _EAGER_PAGES = [')));
    expect(eager).toContain("'cybersecurity'");
    expect(html).toContain('<link rel="stylesheet" href="/cybersecurity/cybersecurity.css?v=20261003-cybersecurity">');
    expect(html).toContain('<script src="/cybersecurity/cybersecurity.js?v=20261003-cybersecurity" defer></script>');
  });

  it('is not nested inside SYSTEM or a club workspace', () => {
    // Its own page id and shell class, its own top-level card — not a SYSTEM
    // module, and not a club page.
    const system = read('public/system/system.js');
    expect(system).not.toContain('cybersecurity');
    const landing = app.slice(app.indexOf('function _ownerHomeForPlatformOwner'), app.indexOf('function _ownerHomeForClubMember'));
    expect(landing).toContain('data-page="cybersecurity"');
    const member = app.slice(app.indexOf('function _ownerHomeForClubMember'), app.indexOf('function renderOwnerHome'));
    expect(member).not.toContain('cybersecurity');
  });

  it('sits between SYSTEM and CLUBS on the landing, the same size as every other room', () => {
    expect(css).toContain('".     system system cyber  cyber  clubs  clubs  .    "');
    expect(css).toContain('body.club-theme .oh-cards--core .oh-card--cyber{  grid-area: cyber; }');
    expect(css).toMatch(/\.oh-cards--core\{[^}]*grid-auto-rows:\s*1fr/);
    expect(css).toContain('grid-template-areas: "system" "cyber" "clubs" "core" "vision" "vault" "city";');
  });

  it('says on its card what the evidence says, and only green when every boundary is covered', () => {
    const fn = app.slice(app.indexOf('function _fillCybersecurityStatus'), app.indexOf('function _fillSourceCoreStatus'));
    expect(fn).toContain("base + '/system/cybersecurity'");
    expect(fn).toContain("d.state === 'NOT_GENERATED'");
    expect(fn).toContain("write('bad', 'Domains at risk: ' + atRisk)");
    expect(fn).toContain("else if (b.P + b.U > 0) write('warn', 'Trust boundaries covered: ' + b.C + ' of ' + b.total)");
    expect(fn).toContain("else write('ok', 'All trust boundaries covered')");
    expect(fn).toContain("write('bad', 'Security posture unreachable')");
    expect(fn).not.toMatch(/Math\.random/);
    expect(app).toContain('Reading security evidence…');
    expect(app).toContain('try { _fillCybersecurityStatus(); } catch (_) {}');
  });

  it('translates the card in every locale the platform ships', () => {
    const N = '\u0000';
    const keys = ['CYBERSECURITY', 'Security Posture, Protection, Evidence & Monitoring', 'Reading security evidence…',
      'Enter Cybersecurity', 'Security evidence not generated', `Domains at risk: ${N}`, `Security warnings: ${N}`,
      `Trust boundaries covered: ${N} of ${N}`, 'All trust boundaries covered', 'Security posture unreachable'];
    const tags = fs.readdirSync(path.join(ROOT, 'public/i18n/catalogue')).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f));
    expect(tags.length).toBeGreaterThan(10);
    for (const f of tags) {
      const cat = JSON.parse(read(`public/i18n/catalogue/${f}`));
      if (f.startsWith('en-') && f !== 'en-GB.json') continue;
      for (const k of keys) expect(`${f} ${JSON.stringify(k)}: ${typeof cat[k]}`).toBe(`${f} ${JSON.stringify(k)}: string`);
    }
  });
});
