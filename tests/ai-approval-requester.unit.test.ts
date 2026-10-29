/**
 * The AI approval gate takes the requester from the authenticated session, never
 * from what the caller wrote into the job.
 *
 * Before this fix the worker read the requester from job.input.triggeredBy,
 * arbitrary JSON in the request body, and fell back to 'system' when it was
 * absent. Either way the person who queued a high-risk action was not the
 * requester on its approval, so segregation of duties (the approver must not be
 * the requester) let them approve their own action, and the audit trail named
 * whoever they chose.
 *
 * These tests run the real app (auth, routes, tenant guard, approval service)
 * and the real worker over an in-memory database: a forged identity is ignored
 * and recorded, a self-approval is refused at the API and again at execution,
 * and every refusal leaves the action unexecuted.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
process.env.RATE_AUTH_CAPACITY = '100000';

type Row = Record<string, any>;

// ── An in-memory database: every model is a table of plain rows ─────────────
const TABLES = new Map<string, Row[]>();
const rows = (model: string) => { if (!TABLES.has(model)) TABLES.set(model, []); return TABLES.get(model)!; };
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
const matches = (r: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('lt' in v) return r[k] != null && r[k] < v.lt;
    if ('in' in v) return (v.in as unknown[]).includes(r[k]);
    return true;
  }
  return same(r[k] ?? null, v ?? null);
});
let _seq = 0;
const table = (model: string) => ({
  findUnique: async ({ where }: Row) => rows(model).find((r) => matches(r, where)) ?? null,
  findFirst: async ({ where, orderBy }: Row = {}) => {
    const hits = rows(model).filter((r) => matches(r, where));
    if (orderBy?.createdAt === 'desc') hits.reverse();
    return hits[0] ?? null;
  },
  findMany: async ({ where }: Row = {}) => rows(model).filter((r) => matches(r, where)),
  count: async ({ where }: Row = {}) => rows(model).filter((r) => matches(r, where)).length,
  create: async ({ data }: Row) => { const r = { id: `${model}-${++_seq}`, createdAt: new Date(Date.now() + _seq), ...data }; rows(model).push(r); return r; },
  update: async ({ where, data }: Row) => { const r = rows(model).find((x) => matches(x, where)); if (!r) throw new Error(`${model} ${JSON.stringify(where)} not found`); Object.assign(r, data); return r; },
  updateMany: async ({ where, data }: Row) => { const hits = rows(model).filter((r) => matches(r, where)); hits.forEach((r) => Object.assign(r, data)); return { count: hits.length }; },
  upsert: async ({ create }: Row) => create,
  aggregate: async () => ({ _sum: {} }),
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

// What the approval service hands the audit chain and the security log.
const AUDIT: Row[] = [];
const EVENTS: Row[] = [];
jest.mock('../src/security/audit-chain.service', () => ({
  ...jest.requireActual('../src/security/audit-chain.service'),
  appendAuditEventAsync: (e: Row) => { AUDIT.push(e); },
}));
jest.mock('../src/security/security-event.service', () => ({
  ...jest.requireActual('../src/security/security-event.service'),
  logSecurityEvent: (e: Row) => { EVENTS.push(e); },
}));
// The action itself: a deterministic handler whose every run is counted. The
// model is never reached, and the event fabric is not under test here.
const EXECUTED: string[] = [];
jest.mock('../src/workers/agent-handlers', () => ({
  runDeterministicHandler: async (j: Row) => { EXECUTED.push(j.jobId); return { text: 'done', payload: null, model: 'deterministic', tokensIn: 0, tokensOut: 0, costCents: 0 }; },
}));
jest.mock('../src/services/llm-adapter.service', () => ({
  ...jest.requireActual('../src/services/llm-adapter.service'),
  llmStatus: () => ({ backend: 'none' }),
  llmCall: async () => { throw new Error('the model must not be called in these tests'); },
}));
jest.mock('../src/services/ai-agent-decision.service', () => ({ recordDecision: async () => ({}), impactFor: () => 'LOW' }));
jest.mock('../src/fabric/producers/ai.producer', () => new Proxy({}, { get: () => () => undefined }));
jest.mock('../src/fabric/producers/system.producer', () => new Proxy({}, { get: () => () => undefined }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import fs from 'fs';
import path from 'path';
import { signToken } from '../src/security/jwt-tokens';
import { forgetIdentity } from '../src/middleware/auth.middleware';
import { startAIAgentWorker, stopAIAgentWorker } from '../src/workers/ai-agent.worker';
import { approve, reject, requestApproval, APPROVER_ROLES } from '../src/security/ai-approval.service';

const app = createApp();
const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const C1 = 'c-1', C2 = 'c-2';
const USERS: Record<string, Row> = {
  coach:   { id: 'u-coach',   role: 'HEAD_COACH', clubId: C1 },
  admin:   { id: 'u-admin',   role: 'CLUB_ADMIN', clubId: C1 },
  analyst: { id: 'u-analyst', role: 'ANALYST',    clubId: C1 },
  other:   { id: 'u-other',   role: 'CLUB_ADMIN', clubId: C2 },
};
const bearer = (u: Row) => `Bearer ${signToken('access', { sub: u.id, role: u.role, tv: 0 }, { expiresIn: '10m' })}`;
const post = (u: Row, url: string, body: Row = {}) => request(app).post(url).set('Authorization', bearer(u)).send(body);

// One worker tick, on fake timers, then the worker is stopped again.
async function tick() {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  try {
    startAIAgentWorker();
    await jest.advanceTimersByTimeAsync(4_000);
  } finally {
    await stopAIAgentWorker();
    jest.useRealTimers();
  }
}

const job = (id: string) => rows('aIAgentJob').find((j) => j.id === id)!;
const approvalFor = (jobId: string) => rows('aIApprovalRequest').filter((a) => a.jobId === jobId);
const reasons = () => EVENTS.filter((e) => e.kind === 'UNAUTHORIZED_AI_ATTEMPT').map((e) => e.payload?.reason ?? e.payload?.tool);
// A job queued straight into the table, as an enqueue path would write it.
const seedJob = (over: Row) => { const r: Row = { id: `job-${++_seq}`, createdAt: new Date(Date.now() + _seq), clubId: C1, teamId: null, agent: 'COMMS', kind: 'MASS_MESSAGE', status: 'PENDING', input: { text: 'Training moved to 18:00' }, ...over }; rows('aIAgentJob').push(r); return r; };
const seedApproval = (over: Row) => { const r: Row = { id: `apr-${++_seq}`, createdAt: new Date(Date.now() + _seq), clubId: C1, agent: 'COMMS', kind: 'MASS_MESSAGE', payload: {}, expiresAt: new Date(Date.now() + 3_600_000), approvedBy: null, approvedAt: null, rejectedReason: null, ...over }; rows('aIApprovalRequest').push(r); return r; };

beforeEach(() => {
  TABLES.clear(); AUDIT.length = 0; EVENTS.length = 0; EXECUTED.length = 0; forgetIdentity();
  const base = { isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null };
  for (const u of Object.values(USERS)) rows('user').push({ ...base, email: `${u.id}@x.test`, ...u });
});

describe('a forged requester, through the real routes and the real worker', () => {
  it.each([
    ['POST /automation/agents/jobs', '/api/v1/automation/agents/jobs', { agent: 'COMMS', kind: 'MASS_MESSAGE', input: { text: 'Squad meeting', triggeredBy: 'u-admin' }, triggeredBy: 'u-admin' }],
    ['POST /ai-ops/agents/:agent/run', '/api/v1/ai-ops/agents/COMMS/run', { kind: 'MASS_MESSAGE', input: { text: 'Squad meeting', triggeredBy: 'u-admin' }, triggeredBy: 'u-admin' }],
  ])('%s: the job is the coach’s, whatever the body claims, and only somebody else can approve it', async (_name, url, body) => {
    // The coach queues a mass message and names the club admin as its requester.
    const created = await post(USERS.coach, url, body);
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(job(id).triggeredBy).toBe('u-coach');

    // The worker raises the approval for the coach, not for the admin the input named.
    await tick();
    expect(job(id).status).toBe('PENDING');
    const [apr] = approvalFor(id);
    expect(approvalFor(id)).toHaveLength(1);
    expect(apr).toMatchObject({ requesterId: 'u-coach', clubId: C1, status: 'PENDING' });
    expect(AUDIT.find((a) => a.action === 'AI_APPROVAL_REQUESTED')!.actor.userId).toBe('u-coach');
    expect(reasons()).toEqual(['INPUT_CLAIMS_ANOTHER_REQUESTER']);
    expect(EXECUTED).toEqual([]);

    // Negative: the coach cannot approve their own action, however the request is dressed.
    const self = await post(USERS.coach, `/api/v1/security/approvals/${apr.id}/approve`, { approvedBy: 'u-admin', userId: 'u-admin', requesterId: 'u-admin' });
    expect(self.status).toBe(403);
    expect(self.body.message).toMatch(/segregation of duties/);
    // Negative: a role that may not decide approvals, and an admin of another club.
    expect((await post(USERS.analyst, `/api/v1/security/approvals/${apr.id}/approve`)).status).toBe(403);
    expect((await post(USERS.other, `/api/v1/security/approvals/${apr.id}/approve`)).status).toBe(403);
    expect(apr.status).toBe('PENDING');
    await tick();
    expect(EXECUTED).toEqual([]);

    // A different person with an approver role approves; only then does the action run.
    const ok = await post(USERS.admin, `/api/v1/security/approvals/${apr.id}/approve`);
    expect(ok.status).toBe(200);
    expect(apr).toMatchObject({ status: 'APPROVED', approvedBy: 'u-admin' });
    expect(AUDIT.find((a) => a.action === 'AI_APPROVAL_GRANTED')).toMatchObject({ actor: { userId: 'u-admin' }, payload: { requesterId: 'u-coach' } });
    await tick();
    expect(EXECUTED).toEqual([id]);
    expect(job(id).status).toBe('SUCCESS');
    expect(apr.status).toBe('EXECUTED');
  });

  it('a body that claims nobody else is the same: the requester is still the authenticated user', async () => {
    const created = await post(USERS.coach, '/api/v1/automation/agents/jobs', { agent: 'COMMS', kind: 'MASS_MESSAGE', input: { text: 'x' } });
    await tick();
    expect(approvalFor(created.body.data.id)[0].requesterId).toBe('u-coach');
    expect(reasons()).toEqual([]);
  });
});

describe('the worker refuses, and does not execute, when the approval cannot be trusted', () => {
  it('negative: a high-risk job with no authenticated requester is refused, not parked for anyone to approve', async () => {
    // Before the fix this job's approval named 'system', so its creator could approve it.
    const j = seedJob({ triggeredBy: null, input: { text: 'x', triggeredBy: 'u-admin' } });
    await tick();
    expect(job(j.id).status).toBe('FAILED');
    expect(job(j.id).error).toMatch(/^Not authorised: no authenticated requester/);
    expect(approvalFor(j.id)).toEqual([]);
    expect(reasons()).toEqual(['NO_AUTHENTICATED_REQUESTER']);
    expect(EXECUTED).toEqual([]);
  });

  it.each([
    ['system', 'the fallback the old worker used'],
    ['u-admin', 'an identity the old worker took from job.input'],
  ])('negative: an approval naming %s (%s), approved by the job’s own requester, is refused', async (requesterId) => {
    const j = seedJob({ triggeredBy: 'u-coach' });
    const a = seedApproval({ jobId: j.id, requesterId, status: 'APPROVED', approvedBy: 'u-coach', approvedAt: new Date() });
    await tick();
    expect(job(j.id).status).toBe('FAILED');
    expect(job(j.id).error).toBe('Not authorised: the approval names a different requester than the job');
    expect(a.status).toBe('APPROVED');
    expect(reasons()).toEqual(['APPROVAL_REQUESTER_MISMATCH']);
    expect(EXECUTED).toEqual([]);
  });

  it('negative: an approval its own requester decided is refused at execution too', async () => {
    const j = seedJob({ triggeredBy: 'u-coach' });
    seedApproval({ jobId: j.id, requesterId: 'u-coach', status: 'APPROVED', approvedBy: 'u-coach', approvedAt: new Date() });
    await tick();
    expect(job(j.id).status).toBe('FAILED');
    expect(job(j.id).error).toBe('Not authorised: an action may not be approved by the user who requested it');
    expect(reasons()).toEqual(['SELF_APPROVAL']);
    expect(EXECUTED).toEqual([]);
  });

  it('still parks a pending approval, and still fails a rejected one', async () => {
    // The rejected one is older: a parked job is picked again on every pass of a
    // tick, so a parked job seeded first would hold the queue for the whole tick.
    const refused = seedJob({ triggeredBy: 'u-coach' });
    seedApproval({ jobId: refused.id, requesterId: 'u-coach', status: 'REJECTED', approvedBy: 'u-admin', rejectedReason: 'not now' });
    const parked = seedJob({ triggeredBy: 'u-coach' });
    seedApproval({ jobId: parked.id, requesterId: 'u-coach', status: 'PENDING' });
    await tick();
    expect(job(parked.id).status).toBe('PENDING');
    expect(job(refused.id)).toMatchObject({ status: 'FAILED', error: 'Approval rejected: not now' });
    expect(EXECUTED).toEqual([]);
  });

  it('runs an analysis job, which needs no approval, exactly as before', async () => {
    const j = seedJob({ agent: 'TACTICAL', kind: 'CHAT', triggeredBy: null, input: { prompt: 'Who presses best?' } });
    await tick();
    expect(job(j.id).status).toBe('SUCCESS');
    expect(approvalFor(j.id)).toEqual([]);
    expect(EXECUTED).toEqual([j.id]);
  });
});

describe('the approval service, called directly', () => {
  const pending = async (requesterId: string, clubId = C1) => requestApproval({ userId: requesterId, clubId }, { agent: 'COMMS', kind: 'MASS_MESSAGE', payload: {}, jobId: null });

  it('admits exactly the roles the route admits', () => {
    expect(read('src/routes/security.routes.ts')).toContain("tenantParam('aIApprovalRequest', 'approvalId'), authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH'), ctrl.approveOne");
    expect(read('src/routes/security.routes.ts')).toContain("tenantParam('aIApprovalRequest', 'approvalId'), authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH'), ctrl.rejectOne");
    expect([...APPROVER_ROLES]).toEqual(['SUPER_ADMIN', 'CLUB_ADMIN', 'HEAD_COACH']);
  });

  it.each([['ANALYST'], ['COACH'], ['MEDICAL_STAFF'], [undefined]])('negative: role %s may neither approve nor reject', async (role) => {
    const r = await pending('u-coach');
    await expect(approve({ userId: 'u-x', clubId: C1, role }, r.id)).rejects.toThrow(/Role may not decide approvals/);
    await expect(reject({ userId: 'u-x', clubId: C1, role }, r.id)).rejects.toThrow(/Role may not decide approvals/);
    expect(r.status).toBe('PENDING');
  });

  it('negative: nobody approves their own request, a platform administrator included', async () => {
    const r = await pending('u-owner');
    await expect(approve({ userId: 'u-owner', clubId: C1, role: 'SUPER_ADMIN' }, r.id)).rejects.toThrow(/segregation of duties/);
    await expect(approve({ userId: 'u-owner', clubId: C1, role: 'CLUB_ADMIN' }, r.id)).rejects.toThrow(/segregation of duties/);
    expect(r.status).toBe('PENDING');
  });

  it('negative: a club administrator of another club cannot decide it', async () => {
    const r = await pending('u-coach');
    await expect(approve({ userId: 'u-other', clubId: C2, role: 'CLUB_ADMIN' }, r.id)).rejects.toThrow();
    await expect(reject({ userId: 'u-other', clubId: C2, role: 'CLUB_ADMIN' }, r.id)).rejects.toThrow();
    expect(r.status).toBe('PENDING');
  });

  it('a different approver may approve, and a platform administrator may still decide for any club', async () => {
    const a = await pending('u-coach');
    expect((await approve({ userId: 'u-admin', clubId: C1, role: 'CLUB_ADMIN' }, a.id)).status).toBe('APPROVED');
    const b = await pending('u-coach', C2);
    expect((await approve({ userId: 'u-owner', clubId: C1, role: 'SUPER_ADMIN' }, b.id)).approvedBy).toBe('u-owner');
    const c = await pending('u-coach');
    expect((await reject({ userId: 'u-admin', clubId: C1, role: 'HEAD_COACH' }, c.id, 'no')).status).toBe('REJECTED');
  });
});

describe('the source', () => {
  it('the worker reads no identity from job.input and has no "system" requester', () => {
    const src = stripComments(read('src/workers/ai-agent.worker.ts'));
    expect(src).not.toMatch(/'system'/);
    expect(src).toContain("const requesterId = typeof job.triggeredBy === 'string' && job.triggeredBy.trim() ? job.triggeredBy : null;");
    expect(src).toContain('{ userId: requesterId, clubId: job.clubId, ipAddress: null, userAgent: null }');
    // job.input.triggeredBy is read in exactly one place: to record that it was forged.
    expect(src.match(/triggeredBy\?: unknown/g)).toHaveLength(1);
    expect(src).toContain("reason: 'INPUT_CLAIMS_ANOTHER_REQUESTER'");
  });

  it('every enqueue path writes the authenticated user as the job’s requester', () => {
    expect(stripComments(read('src/services/automation.service.ts'))).toMatch(/triggeredBy: actor\.userId,/);
    expect(read('src/services/automation.service.ts')).not.toMatch(/dto\.triggeredBy/);
    expect(read('src/controllers/ai-ops.controller.ts')).toContain('triggeredBy: req.user!.id,');
    expect(read('src/intelligence/intelligence.service.ts')).toContain('triggeredBy: actor.userId,');
    const writers = ['src/services/automation.service.ts', 'src/controllers/ai-ops.controller.ts', 'src/intelligence/intelligence.service.ts'];
    const all = require('child_process').execSync('grep -rl "aIAgentJob.create(" src', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').sort();
    expect(all).toEqual([...writers].sort());
  });
});

// The agent registry decides which agents run (src/platform/intelligence/agent-jobs.ts).
// This file's in-memory database and worker harness run the real worker against a
// registry in which four runtime agents may not run: TACTICAL is RETIRED, MEDICAL
// is LAB, BIG_DATA is DRAFT and COMMS has no manifest. A fresh copy of the worker
// and the runtime is loaded with that registry; everything else is this file's.
describe('agents the registry does not run, through the real worker', () => {
  it('refuses each of their jobs the way the worker refuses any unauthorised job, while a RUNNING agent’s job runs', async () => {
    let worker!: typeof import('../src/workers/ai-agent.worker');
    let runtime!: typeof import('../src/platform/intelligence/agent-jobs');
    jest.isolateModules(() => {
      jest.doMock('../src/platform/agents/catalog', () => {
        const actual = jest.requireActual('../src/platform/agents/catalog');
        const { AgentRegistry } = jest.requireActual('../src/platform/agents/registry');
        const lifecycle: Record<string, string> = { TACTICAL: 'RETIRED', MEDICAL: 'LAB', BIG_DATA: 'DRAFT' };
        const registry = new AgentRegistry();
        for (const m of actual.PLATFORM_AGENT_MANIFESTS) {
          if (m.binding.legacyAgent === 'COMMS') continue;
          registry.register(lifecycle[m.binding.legacyAgent] ? { ...m, lifecycle: lifecycle[m.binding.legacyAgent] } : m);
        }
        return { ...actual, platformAgentRegistry: () => registry };
      });
      worker = require('../src/workers/ai-agent.worker');
      runtime = require('../src/platform/intelligence/agent-jobs');
    });
    jest.dontMock('../src/platform/agents/catalog');
    expect(Object.keys(runtime.AGENT_PROFILES).sort()).toEqual(['CLUB_MANAGER', 'DEVICE_MGMT', 'FINANCE', 'MATCH_OPS', 'SCOUTING', 'TRAINING']);

    const seeded = {
      TACTICAL: seedJob({ agent: 'TACTICAL', kind: 'MATCH_REVIEW', input: {}, triggeredBy: USERS.coach.id }),
      MEDICAL:  seedJob({ agent: 'MEDICAL', kind: 'FATIGUE_SCAN', input: {}, triggeredBy: USERS.coach.id }),
      BIG_DATA: seedJob({ agent: 'BIG_DATA', kind: 'WEEKLY_DIGEST', input: {}, triggeredBy: USERS.coach.id }),
      COMMS:    seedJob({ agent: 'COMMS', kind: 'MASS_MESSAGE', triggeredBy: USERS.coach.id }),
      TRAINING: seedJob({ agent: 'TRAINING', kind: 'WEEKLY_DIGEST', input: {}, triggeredBy: USERS.coach.id }),
    };
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      worker.startAIAgentWorker();
      await jest.advanceTimersByTimeAsync(4_000);
    } finally {
      await worker.stopAIAgentWorker();
      jest.useRealTimers();
    }

    const refusedWith: Array<[keyof typeof seeded, string]> = [
      ['TACTICAL', 'The agent club.tactical is RETIRED in the agent registry; only a RUNNING agent runs'],
      ['MEDICAL', 'The agent club.medical is LAB in the agent registry; only a RUNNING agent runs'],
      ['BIG_DATA', 'The agent club.big-data is DRAFT in the agent registry; only a RUNNING agent runs'],
      ['COMMS', 'The agent COMMS has no manifest in the agent registry'],
    ];
    for (const [agent, reason] of refusedWith) {
      // FAILED, with the reason written on the job: what the worker has always done with an unauthorised job.
      expect([agent, job(seeded[agent].id).status, job(seeded[agent].id).error]).toEqual([agent, 'FAILED', `Not authorised: ${reason}`]);
      expect(job(seeded[agent].id).finishedAt).toBeInstanceOf(Date);
      expect(EXECUTED).not.toContain(seeded[agent].id);
      expect(approvalFor(seeded[agent].id)).toEqual([]);
    }
    // One UNAUTHORIZED_AI_ATTEMPT each, as before: the job, its agent, the tool it asked for.
    const events = EVENTS.filter((e) => e.kind === 'UNAUTHORIZED_AI_ATTEMPT');
    expect(events.map((e) => [e.payload.agent, e.severity, e.clubId, e.payload.jobId, e.payload.tool]).sort()).toEqual([
      ['BIG_DATA', 'WARN', C1, seeded.BIG_DATA.id, 'createReport'],
      ['COMMS', 'WARN', C1, seeded.COMMS.id, 'sendNotification'],
      ['MEDICAL', 'WARN', C1, seeded.MEDICAL.id, 'createReport'],
      ['TACTICAL', 'WARN', C1, seeded.TACTICAL.id, 'createReport'],
    ]);
    // Control: the RUNNING agent's job in the same tick ran, unrefused.
    expect(EXECUTED).toEqual([seeded.TRAINING.id]);
    expect(job(seeded.TRAINING.id).status).not.toBe('FAILED');
  });
});
