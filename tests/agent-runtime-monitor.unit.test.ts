/**
 * The agent runtime, observed (src/platform/intelligence/agent-runtime.ts and
 * GET /system/agents/runtime).
 *
 * 1. What the registry is enforcing: the runtime's own registry state, its
 *    digest the same as the room's, and a registry that does not validate
 *    reported as INVALID.
 * 2. Every failed job is counted by kind from the prefixes the worker writes,
 *    and a registry refusal is told apart from every other refusal by the
 *    reasons agent-jobs.ts gives; the worker still writes those prefixes.
 * 3. The aggregation: per agent and in total, the queue's state, stalled
 *    jobs, approvals waiting on a person, the last success, and a failure
 *    sample that says when it is not the whole window.
 * 4. Totals only: no club, team, person, input, output or error text leaves
 *    the server, every window is read on the indexed createdAt, nothing is
 *    written, and unreadable history is said so rather than answered with 0.
 * 5. The endpoint is the Platform Owner's alone, never cached, and returns the
 *    shape its contract pins.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-29T12:00:00.000Z');

// A database the test fills: what each query returns, and every query's arguments.
const Q: Row = {};
const CALLS: Array<{ model: string; op: string; args: Row }> = [];
let BROKEN = false;
const model = (name: string) => new Proxy({}, {
  get: (_t, op: string) => async (args: Row = {}) => {
    CALLS.push({ model: name, op, args });
    if (BROKEN) throw new Error('relation "AIAgentJob" does not exist');
    const key = `${name}.${op}`;
    const v = Q[key];
    return typeof v === 'function' ? v(args) : v;
  },
});
const db: Row = {
  platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === OWNER ? { isActive: true } : null) },
  aIAgentJob: model('aIAgentJob'),
  aIApprovalRequest: model('aIApprovalRequest'),
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

import type { AIAgent } from '@prisma/client';
import { agentRuntimeView, failureKind, FAILURE_KINDS, STALLED_AFTER_MS, BACKLOG_AFTER_MS, FAILURE_SAMPLE_LIMIT } from '../src/platform/intelligence/agent-runtime';
import { RUNTIME_AGENTS, deriveRuntimeProfiles, registryRefusalCode, runtimeRegistryState } from '../src/platform/intelligence/agent-jobs';
import { RUNNING_AGENTS } from './helpers/agent-runtime-baseline';
import { PLATFORM_AGENT_MANIFESTS, platformAgentRegistry } from '../src/platform/agents/catalog';
import { AgentRegistry } from '../src/platform/agents/registry';
import { AgentManifestError } from '../src/platform/agents/manifest';
import { AgentsRoomRuntimeSchema, OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';
import agentsRoomRoutes from '../src/routes/agents-room.routes';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const group = (agent: string, status: string, n: number) => ({ agent, status, _count: { _all: n } });

/** A day of work across clubs, as the job and approval tables would answer it. */
function fill() {
  for (const k of Object.keys(Q)) delete Q[k];
  CALLS.length = 0;
  BROKEN = false;
  Q['aIAgentJob.groupBy'] = (args: Row) => {
    if (args.by.length === 2) {
      return [
        group('COMMS', 'SUCCESS', 7), group('COMMS', 'FAILED', 3), group('COMMS', 'PENDING', 2),
        group('MEDICAL', 'SUCCESS', 1), group('MEDICAL', 'CANCELLED', 1), group('MEDICAL', 'RUNNING', 1),
        group('TACTICAL', 'FAILED', 2),
        group('NOT_AN_AGENT', 'SUCCESS', 99), // a row naming no agent of the platform is not counted
      ];
    }
    return [
      { agent: 'COMMS', _max: { finishedAt: ago(3600_000) } },
      { agent: 'MEDICAL', _max: { finishedAt: ago(7200_000) } },
    ];
  };
  Q['aIAgentJob.findMany'] = [
    { agent: 'COMMS', error: 'Not authorised: The agent does not hold "initiatePayment"' },
    { agent: 'COMMS', error: 'Approval rejected: the coach said no — Player Jane Doe, U12' },
    { agent: 'COMMS', error: 'model timeout after 20000 ms; prompt mentioned Jane Doe' },
    { agent: 'TACTICAL', error: 'Not authorised: The agent club.tactical is RETIRED in the agent registry; only a RUNNING agent runs' },
    { agent: 'TACTICAL', error: 'Stalled — exceeded max running window' },
  ];
  Q['aIAgentJob.count'] = (args: Row) => {
    if (args.where.status === 'PENDING') return 2;
    if (args.where.startedAt) return 1;
    return 1; // RUNNING
  };
  Q['aIAgentJob.findFirst'] = { createdAt: ago(90_000) };
  Q['aIApprovalRequest.groupBy'] = [{ agent: 'COMMS', _count: { _all: 2 } }, { agent: 'FINANCE', _count: { _all: 1 } }];
}

// ── 1. what the registry is enforcing ───────────────────────────────────────
describe('the registry the runtime enforces', () => {
  it('is the platform registry: enforced, with the same digest the room shows, all ten agents running', () => {
    const s = runtimeRegistryState();
    expect(s).toEqual({ state: 'ENFORCED', digest: platformAgentRegistry().digest(), running: [...RUNTIME_AGENTS], refused: [], failure: null });
    // The agents it monitors are the ones the platform runs, as recorded on main before the runtime read the registry.
    expect([...RUNTIME_AGENTS]).toEqual([...RUNNING_AGENTS]);
  });

  it('a registry that does not validate is reported INVALID, with no digest, every agent refused and the reason', () => {
    let state: ReturnType<typeof runtimeRegistryState> | undefined;
    jest.isolateModules(() => {
      jest.doMock('../src/config/database', () => ({ prisma: {}, basePrisma: {} }));
      jest.doMock('../src/utils/logger', () => ({ logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined } }));
      jest.doMock('../src/platform/agents/catalog', () => ({
        ...jest.requireActual('../src/platform/agents/catalog'),
        platformAgentRegistry: () => { throw new AgentManifestError('club.comms', [{ code: 'TOOL_PROTECTED', message: 'protected' }]); },
      }));
      state = require('../src/platform/intelligence/agent-jobs').runtimeRegistryState();
    });
    expect(state).toEqual({
      state: 'INVALID', digest: null, running: [],
      refused: RUNTIME_AGENTS.map((agent) => ({ agent, code: 'REGISTRY_INVALID' })),
      failure: 'Agent manifest "club.comms" is not valid: TOOL_PROTECTED',
    });
  });
});

// ── 2. what kind of failure a job's error records ───────────────────────────
describe('a failed job is counted by kind, never by its text', () => {
  const refusalReasons = () => {
    const reg = new AgentRegistry();
    for (const m of PLATFORM_AGENT_MANIFESTS) {
      if (m.binding?.legacyAgent === 'COMMS') continue;
      reg.register(m.binding?.legacyAgent === 'TACTICAL' ? { ...m, lifecycle: 'LAB' as const } : m);
    }
    const rt = deriveRuntimeProfiles(() => reg);
    const broken = deriveRuntimeProfiles(() => { throw new Error('x'); });
    return [rt.refused.COMMS!.reason, rt.refused.TACTICAL!.reason, broken.refused.FINANCE!.reason];
  };

  it('recognises every reason agent-jobs.ts gives for a registry refusal, and nothing else', () => {
    const [missing, notRunning, invalid] = refusalReasons();
    expect([registryRefusalCode(missing), registryRefusalCode(notRunning), registryRefusalCode(invalid)]).toEqual(['NOT_REGISTERED', 'NOT_RUNNING', 'REGISTRY_INVALID']);
    for (const other of ['The agent does not hold "sendNotification"', 'The agent is retired', 'Autonomous actions are stopped: kill switch engaged',
      'An agent job must belong to a club', '"deleteData" is protected: a person does this, or nobody does', 'The agent club.tactical is RUNNING in the agent registry; only a RUNNING agent runs', '']) {
      expect([other, registryRefusalCode(other)]).toEqual([other, null]);
    }
  });

  it('sorts the worker\'s errors into registry, authorization, approval, stalled and execution', () => {
    const [missing, notRunning, invalid] = refusalReasons();
    expect(failureKind(`Not authorised: ${missing}`)).toBe('registry');
    expect(failureKind(`Not authorised: ${notRunning}`)).toBe('registry');
    expect(failureKind(`Not authorised: ${invalid}`)).toBe('registry');
    expect(failureKind('Not authorised: The agent does not hold "initiatePayment"')).toBe('authorization');
    expect(failureKind('Not authorised: refused')).toBe('authorization');
    expect(failureKind('Approval rejected: no')).toBe('approval');
    expect(failureKind('Approval expired: ')).toBe('approval');
    expect(failureKind('Stalled — exceeded max running window')).toBe('stalled');
    expect(failureKind('ECONNRESET')).toBe('execution');
    expect(failureKind(null)).toBe('execution');
    expect(failureKind(undefined)).toBe('execution');
    expect([...FAILURE_KINDS]).toEqual(['registry', 'authorization', 'approval', 'stalled', 'execution']);
  });

  it('(pin) the worker still writes the prefixes the kinds are read from, and still reaps after ten minutes', () => {
    const w = read('src/workers/ai-agent.worker.ts');
    expect(w).toContain("error: 'Stalled — exceeded max running window'");
    expect(w).toContain('error: `Not authorised: ${authz.reason ?? \'refused\'}`');
    expect(w).toContain('`Approval ${existing.status.toLowerCase()}: ');
    expect(w).toMatch(/const STALE_RUNNING_MS = 10 \* 60 \* 1000;/);
    expect(STALLED_AFTER_MS).toBe(10 * 60 * 1000);
  });
});

// ── 3. the aggregation ──────────────────────────────────────────────────────
describe('what each agent did in the last 24 hours', () => {
  beforeEach(fill);

  it('counts every agent the platform has, in its order, and only those', async () => {
    const v = await agentRuntimeView(NOW);
    expect(v.agents!.map((a) => a.agent)).toEqual([...RUNTIME_AGENTS]);
    const comms = v.agents!.find((a) => a.agent === 'COMMS')!;
    expect(comms).toEqual({
      agent: 'COMMS', runs: true, refusedCode: null,
      queued: 12, succeeded: 7, failed: 3, cancelled: 0, inFlight: 2,
      failures: { registry: 0, authorization: 1, approval: 1, stalled: 0, execution: 1 },
      approvalsPending: 2, lastSucceededAt: ago(3600_000).toISOString(),
    });
    expect(v.agents!.find((a) => a.agent === 'MEDICAL')).toMatchObject({ queued: 3, succeeded: 1, cancelled: 1, inFlight: 1, failed: 0 });
    expect(v.agents!.find((a) => a.agent === 'TACTICAL')).toMatchObject({ failed: 2, failures: { registry: 1, authorization: 0, approval: 0, stalled: 1, execution: 0 }, lastSucceededAt: null });
    expect(v.agents!.find((a) => a.agent === 'FINANCE')).toMatchObject({ queued: 0, approvalsPending: 1 });
    expect(v.totals).toEqual({
      queued: 17, succeeded: 8, failed: 5, cancelled: 1, inFlight: 3, approvalsPending: 3,
      failures: { registry: 1, authorization: 1, approval: 1, stalled: 1, execution: 1 },
    });
    expect(v.failureSample).toEqual({ read: 5, limit: FAILURE_SAMPLE_LIMIT, complete: true });
    expect(v.unavailable).toBeNull();
  });

  it('reports the queue: waiting, the oldest wait, running and stalled; DRAINING while the oldest is younger than five minutes', async () => {
    const v = await agentRuntimeView(NOW);
    expect(v.queue).toEqual({ pending: 2, oldestPendingSeconds: 90, running: 1, stalled: 1, state: 'DRAINING' });
    const stalledQ = CALLS.find((c) => c.op === 'count' && c.args.where.startedAt)!;
    expect(stalledQ.args.where).toEqual({ status: 'RUNNING', startedAt: { lt: ago(STALLED_AFTER_MS) } });
  });

  it('calls the queue BACKLOG once the oldest job has waited longer than five minutes, and CLEAR when nothing waits', async () => {
    Q['aIAgentJob.findFirst'] = { createdAt: ago(BACKLOG_AFTER_MS + 1000) };
    expect((await agentRuntimeView(NOW)).queue!.state).toBe('BACKLOG');
    Q['aIAgentJob.findFirst'] = { createdAt: ago(BACKLOG_AFTER_MS - 1000) };
    expect((await agentRuntimeView(NOW)).queue!.state).toBe('DRAINING');
    Q['aIAgentJob.count'] = () => 0;
    Q['aIAgentJob.findFirst'] = null;
    expect((await agentRuntimeView(NOW)).queue).toEqual({ pending: 0, oldestPendingSeconds: null, running: 0, stalled: 0, state: 'CLEAR' });
  });

  it('says when the failure kinds describe only the latest failed jobs', async () => {
    Q['aIAgentJob.findMany'] = Array.from({ length: FAILURE_SAMPLE_LIMIT }, () => ({ agent: 'COMMS', error: 'boom' }));
    Q['aIAgentJob.groupBy'] = (args: Row) => (args.by.length === 2 ? [group('COMMS', 'FAILED', FAILURE_SAMPLE_LIMIT + 500)] : []);
    const v = await agentRuntimeView(NOW);
    expect(v.failureSample).toEqual({ read: FAILURE_SAMPLE_LIMIT, limit: FAILURE_SAMPLE_LIMIT, complete: false });
    expect(v.totals!.failed).toBe(FAILURE_SAMPLE_LIMIT + 500);
    expect(v.totals!.failures.execution).toBe(FAILURE_SAMPLE_LIMIT);
  });

  it('a quiet day is zeros, not dashes: every agent present, every count 0', async () => {
    Q['aIAgentJob.groupBy'] = [];
    Q['aIAgentJob.findMany'] = [];
    Q['aIAgentJob.count'] = () => 0;
    Q['aIAgentJob.findFirst'] = null;
    Q['aIApprovalRequest.groupBy'] = [];
    const v = await agentRuntimeView(NOW);
    expect(v.agents!.length).toBe(RUNTIME_AGENTS.length);
    expect(v.totals).toEqual({ queued: 0, succeeded: 0, failed: 0, cancelled: 0, inFlight: 0, approvalsPending: 0, failures: { registry: 0, authorization: 0, approval: 0, stalled: 0, execution: 0 } });
    expect(v.failureSample).toEqual({ read: 0, limit: FAILURE_SAMPLE_LIMIT, complete: true });
  });
});

// ── 4. totals only, read-only, honest ───────────────────────────────────────
describe('totals only, read on the index, written nowhere', () => {
  beforeEach(fill);

  it('sends no club, team, person, input, output or error text — even when an error names a person', async () => {
    const body = JSON.stringify(await agentRuntimeView(NOW));
    for (const k of ['clubId', 'teamId', 'triggeredBy', 'requesterId', 'approvedBy', '"input"', '"output"', '"error"', 'payload']) expect([k, body.includes(k)]).toEqual([k, false]);
    for (const text of ['Jane Doe', 'U12', 'coach said no', 'initiatePayment', 'model timeout', 'RETIRED in the agent registry']) expect([text, body.includes(text)]).toEqual([text, false]);
  });

  it('asks the job table for the agent and error of failed jobs only, never a club, a person, an input or an output', async () => {
    await agentRuntimeView(NOW);
    const find = CALLS.filter((c) => c.op === 'findMany');
    expect(find).toHaveLength(1);
    expect(find[0].args.select).toEqual({ agent: true, error: true });
    expect(find[0].args.take).toBe(FAILURE_SAMPLE_LIMIT);
    const first = CALLS.filter((c) => c.op === 'findFirst');
    expect(first.map((c) => c.args.select)).toEqual([{ createdAt: true }]);
    for (const c of CALLS.filter((x) => x.op === 'groupBy')) expect(c.args.by.every((b: string) => b === 'agent' || b === 'status')).toBe(true);
  });

  it('reads every window on createdAt, the column the job table indexes', async () => {
    await agentRuntimeView(NOW);
    const windowed = CALLS.filter((c) => c.model === 'aIAgentJob' && (c.op === 'groupBy' || c.op === 'findMany'));
    expect(windowed).toHaveLength(3);
    for (const c of windowed) {
      expect(c.args.where.createdAt).toEqual({ gte: expect.any(Date) });
      expect(c.args.where.finishedAt).toBeUndefined();
    }
    expect(read('prisma/schema.prisma')).toMatch(/model AIAgentJob \{[\s\S]*?@@index\(\[createdAt\]\)[\s\S]*?\n\}/);
  });

  it('writes nothing: the service and the route call no write, raw or transaction', () => {
    const src = read('src/platform/intelligence/agent-runtime.ts');
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    const routes = read('src/routes/agents-room.routes.ts');
    expect(routes).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });

  it('says history is unreadable rather than answering zero, and still reports what the registry enforces', async () => {
    BROKEN = true;
    const v = await agentRuntimeView(NOW);
    expect(v).toMatchObject({ queue: null, agents: null, totals: null, failureSample: null, unavailable: 'Agent job history is not readable in this deployment.' });
    expect(v.registry.state).toBe('ENFORCED');
    expect(v.registry.running).toHaveLength(RUNTIME_AGENTS.length);
  });
});

// ── 5. the endpoint ─────────────────────────────────────────────────────────
describe('GET /system/agents/runtime', () => {
  const app = express();
  app.use('/system/agents', agentsRoomRoutes);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Row, _req: unknown, res: Row, _next: unknown) => res.status(err.statusCode || 500).json({ success: false }));
  beforeEach(fill);

  it('is the Platform Owner\'s: the owner reads it uncached, in the shape its contract pins', async () => {
    actingAs = { id: OWNER, role: 'CLUB_ADMIN', clubId: 'c-1' };
    const res = await request(app).get('/system/agents/runtime');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(AgentsRoomRuntimeSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.registry.state).toBe('ENFORCED');
    expect(res.body.data.agents.map((a: Row) => a.agent)).toEqual([...RUNTIME_AGENTS]);
  });

  it('negative: an unauthenticated request and a club administrator are refused before any job row is read', async () => {
    actingAs = null;
    expect((await request(app).get('/system/agents/runtime')).status).toBe(401);
    actingAs = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'CLUB_ADMIN', clubId: 'c-1' };
    expect((await request(app).get('/system/agents/runtime')).status).toBe(403);
    expect(CALLS).toEqual([]);
  });

  it('is not mistaken for an agent id, and the contract names its consumer and the fields it reads', () => {
    const c = OWNER_API_CONTRACTS.find((x) => x.endpoint === '/system/agents/runtime')!;
    expect(c).toMatchObject({ module: 'AI Agents Operations Room', consumer: 'public/agents-room/agents-room.js', schema: AgentsRoomRuntimeSchema });
    const routes = read('src/routes/agents-room.routes.ts');
    expect(routes.indexOf("router.get('/runtime'")).toBeGreaterThan(0);
    expect(routes.indexOf("router.get('/runtime'")).toBeLessThan(routes.indexOf("router.get('/:agentId'"));
  });

  it('(control) the contract refuses a body that carries a club or an error text', () => {
    const ok = { generatedAt: NOW.toISOString(), windowHours: 24, registry: runtimeRegistryState(), killSwitch: { engaged: false }, queue: null, agents: null, totals: null, failureSample: null, unavailable: 'x' };
    expect(AgentsRoomRuntimeSchema.safeParse(ok).success).toBe(true);
    expect(AgentsRoomRuntimeSchema.safeParse({ ...ok, clubId: 'c-1' }).success).toBe(false);
    const row = { agent: 'COMMS' as AIAgent, runs: true, refusedCode: null, queued: 1, succeeded: 1, failed: 0, cancelled: 0, inFlight: 0, failures: { registry: 0, authorization: 0, approval: 0, stalled: 0, execution: 0 }, approvalsPending: 0, lastSucceededAt: null };
    expect(AgentsRoomRuntimeSchema.safeParse({ ...ok, agents: [row] }).success).toBe(true);
    expect(AgentsRoomRuntimeSchema.safeParse({ ...ok, agents: [{ ...row, error: 'Jane Doe' }] }).success).toBe(false);
    expect(AgentsRoomRuntimeSchema.safeParse({ ...ok, agents: [{ ...row, agent: 'NOT_AN_AGENT' }] }).success).toBe(false);
  });
});
