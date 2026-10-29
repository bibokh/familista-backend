/**
 * tests/ai-execution-gate.unit.test.ts — AI cost control and agent execution safety
 *
 * The execution gate (src/platform/intelligence/execution-gate.ts) in front of
 * every paid model call, through the real gateway with an in-memory ledger that
 * follows the PostgreSQL ledger's rules (tests/helpers/ai-gate.ts). The ledger
 * itself, its lock and its SQL are proven on PostgreSQL in
 * tests/ai-execution-gate.integration.test.ts.
 *
 *    1  disabled by default              8  emergency shutdown
 *    2  missing configuration fails      9  recursive agent calls rejected
 *       closed                          10  autonomous execution rejected
 *    3  unauthorised execution rejected 11  the deterministic LAB still runs
 *    4  per-request/workflow/agent      12  tenant isolation
 *    5  daily budget                    13  no key in logs or responses
 *    6  monthly budget                  14  existing behaviour preserved
 *    7  concurrency cannot overspend
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'sk-ant-api03-NOT-REAL-but-shaped-like-one-0123456789abcdef';

// ── a database with only what the owner endpoints and the job producers touch ──
const control: { row: Row | null } = { row: null };
const audit: Row[] = [];
const jobsCreated: Row[] = [];
const db: Row = {
  platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === OWNER ? { isActive: true } : null) },
  $transaction: async (fn: (tx: Row) => unknown) => fn(db),
  $executeRaw: async () => 1,
  $queryRaw: async () => [{}],
  aiExecutionControl: {
    findUnique: async () => control.row,
    upsert: async ({ create, update }: Row) => (control.row = { ...(control.row ?? create), ...(control.row ? update : {}), changedAt: new Date() }),
  },
  platformAuditLog: { create: async ({ data }: Row) => { audit.push(data); return data; } },
  aiEgressRecord: { count: async () => 0, findMany: async () => [], create: async () => ({ id: 'x' }), update: async () => ({}) },
  aIAgentJob: { count: async () => 0, create: async ({ data }: Row) => { jobsCreated.push(data); return { id: 'job-x', ...data }; } },
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

// The provider SDK, so the no-retry and abort behaviour can be observed without a network.
const mockSdk = { ctor: [] as Row[], calls: [] as Row[], hang: true };
jest.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    static RateLimitError = class extends Error {};
    static APIConnectionError = class extends Error {};
    messages: Row;
    constructor(o: Row) {
      mockSdk.ctor.push(o);
      this.messages = {
        create: (body: Row, opts: Row) => {
          mockSdk.calls.push({ body, opts });
          return new Promise((resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            if (!mockSdk.hang) resolve({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 2 } });
          });
        },
      };
    }
  }
  return { __esModule: true, default: Anthropic };
});

import { config } from '../src/config';
import { logger } from '../src/utils/logger';
import {
  AUTONOMOUS_AI_EXECUTION, FRAMING_OVERHEAD_TOKENS, LIMIT_SETTINGS, aiPolicyConfig, assertMayCreateAgentWork,
  costMicros, decide, inputTokenUpperBound, runAsAgentJob, runInBackgroundScope, withWorkflow,
} from '../src/platform/intelligence/execution-gate';
import { complete, registerModel, registerProvider, resetGateway, setEgressRecorder, type GatewayRequest, type GatewayResult } from '../src/platform/intelligence/gateway';
import { prismaAiLedger } from '../src/platform/intelligence/ai-ledger';
import { aiCostRoomView } from '../src/platform/intelligence/ai-cost-view';
import { anthropicProvider } from '../src/platform/intelligence/anthropic-provider';
import { generateNarrative } from '../src/services/ai-llm.adapter';
import { enqueueAgentJob } from '../src/services/automation.service';
import { replayDefinition } from '../lab/orchestrator/replay';
import systemRoutes from '../src/routes/system.routes';
import agentsRoomRoutes from '../src/routes/agents-room.routes';
import { asUser, memoryLedger, TEST_PRICING, type MemoryLedger } from './helpers/ai-gate';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ENV_KEYS = ['AI_MODEL_PRICING', ...LIMIT_SETTINGS.map((s) => s.env)];
let ledger: MemoryLedger;
let sent: GatewayRequest[] = [];
let release: Array<() => void> = [];
let hold = false;

function install(enabled = true): void {
  resetGateway();
  registerProvider({
    id: 'anthropic', available: () => true,
    complete: async (req) => {
      sent.push(req);
      if (hold) await new Promise<void>((r) => release.push(r));
      return { text: 'ok', usage: { inputTokens: 40, outputTokens: 10 } };
    },
  });
  registerModel({ id: 'familista-default', provider: 'anthropic', providerModel: 'test-model', purposes: ['agent'] });
  ledger = memoryLedger({ enabled });
  setEgressRecorder(ledger);
}

const ask = (over: Partial<GatewayRequest> = {}): Promise<GatewayResult> =>
  complete({ caller: 'test', purpose: 'agent', clubId: 'club-a', prompt: 'hello', maxOutputTokens: 100, dataClasses: ['INTERNAL'], ...over });
/** One call's reservation for `ask()`: the prompt's bytes, the framing and the output cap. */
const ONE = Buffer.byteLength('hello') + FRAMING_OVERHEAD_TOKENS + 100;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AI_MODEL_PRICING = TEST_PRICING;
  sent = []; release = []; hold = false; control.row = null; audit.length = 0; jobsCreated.length = 0; actingAs = null;
  install();
});
afterAll(() => { for (const k of ENV_KEYS) delete process.env[k]; resetGateway(); (config.anthropic as Row).apiKey = ''; });

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/system/agents', agentsRoomRoutes);
  a.use('/system', systemRoutes);
  a.use((err: Row, _req: Row, res: Row, _next: unknown) => res.status(err?.statusCode || 500).json({ success: false, message: err?.message }));
  return a;
};
const CLUB_ROLES = ['CLUB_ADMIN', 'HEAD_COACH', 'ANALYST', 'MEDICAL_STAFF', 'PLAYER'];

// ── 1 ───────────────────────────────────────────────────────────────────────
describe('1. paid AI execution is disabled by default', () => {
  it('with the switch at its default, a call is refused and recorded, and nothing is sent', async () => {
    install(false);
    const out = await asUser('u-1', () => ask());
    expect(out).toMatchObject({ ok: false, refusal: 'disabled' });
    expect(sent).toHaveLength(0);
    expect(ledger.rows.map((r) => [r.outcome, r.reason])).toEqual([['REFUSED', 'disabled']]);
  });

  it('the stored switch: no row is OFF, and only a row that says enabled is ON', async () => {
    expect(await prismaAiLedger.executionEnabled()).toBe(false);
    control.row = { id: 'global', enabled: false };
    expect(await prismaAiLedger.executionEnabled()).toBe(false);
    control.row = { id: 'global', enabled: true };
    expect(await prismaAiLedger.executionEnabled()).toBe(true);
  });

  it('the owner\'s view says so, and says autonomous execution does not exist', async () => {
    const v = await aiCostRoomView();
    expect(v.execution).toMatchObject({ enabled: false, readable: true });
    expect(v.autonomous).toBe(false);
    expect(AUTONOMOUS_AI_EXECUTION).toBe(false);
  });
});

// ── 2 ───────────────────────────────────────────────────────────────────────
describe('2. missing or invalid configuration fails closed', () => {
  it('a model with no configured price is never called', async () => {
    delete process.env.AI_MODEL_PRICING;
    expect((await asUser('u-1', () => ask())).refusal).toBe('pricing');
    process.env.AI_MODEL_PRICING = JSON.stringify({ 'other-model': { inputPerMTokUsd: 1, outputPerMTokUsd: 1 } });
    expect((await asUser('u-1', () => ask())).refusal).toBe('pricing');
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['AI_MODEL_PRICING', 'not json'], ['AI_MODEL_PRICING', '{"test-model":{"inputPerMTokUsd":0,"outputPerMTokUsd":1}}'],
    ['AI_MODEL_PRICING', '{"test-model":{"inputPerMTokUsd":-3,"outputPerMTokUsd":15}}'], ['AI_MODEL_PRICING', '[]'],
    ['AI_PLATFORM_DAILY_TOKEN_BUDGET', 'abc'], ['AI_PLATFORM_DAILY_TOKEN_BUDGET', '-5'], ['AI_MAX_TOKENS_PER_REQUEST', '1.5'],
    ['AI_PLATFORM_MONTHLY_COST_BUDGET_USD', '0'], ['AI_MAX_CONCURRENT_REQUESTS', 'Infinity'],
  ])('%s=%s refuses every call, naming the setting and never its value', async (k, v) => {
    process.env[k] = v;
    const out = await asUser('u-1', () => ask());
    expect(out.refusal).toBe('config');
    expect(out.refusedBecause).toContain(k);
    expect(out.refusedBecause).not.toContain(v);
    expect(sent).toHaveLength(0);
  });

  it.each([[Number.NaN], [0], [-1], [1.5]])('an output cap of %p refuses rather than slipping past every limit', async (cap) => {
    const out = await asUser('u-1', () => ask({ maxOutputTokens: cap }));
    expect(out.refusal).toBe('config');
    expect(sent).toHaveLength(0);
    expect(ledger.rows.filter((r) => r.outcome === 'STARTED')).toHaveLength(0);
  });

  it('an unreadable switch or ledger refuses rather than proceeds', async () => {
    ledger.down = true;
    expect((await asUser('u-1', () => ask())).refusal).toBe('audit');
    ledger.down = false;
    const reserve = ledger.reserve;
    ledger.reserve = async () => { throw new Error('db down'); };
    expect((await asUser('u-1', () => ask())).refusal).toBe('audit');
    ledger.reserve = reserve;
    expect(sent).toHaveLength(0);
  });

  it('defaults are deliberately small, and every limit has one', () => {
    const l = aiPolicyConfig({}).limits;
    expect(aiPolicyConfig({}).errors).toEqual([]);
    expect(l).toEqual({
      perRequestTokens: 32_000, perWorkflowTokens: 100_000, perAgentRunTokens: 50_000, clubDailyTokens: 200_000,
      dailyTokens: 200_000, monthlyTokens: 2_000_000, dailyCostMicros: 2_000_000, monthlyCostMicros: 20_000_000, maxConcurrent: 2,
    });
  });
});

// ── 3 ───────────────────────────────────────────────────────────────────────
describe('3. unauthorised execution is rejected', () => {
  it('a call with no origin, from a request with no signed-in person, or from a job with no requester is refused', async () => {
    expect((await ask()).refusal).toBe('origin');
    expect((await asUser(null, () => ask())).refusal).toBe('origin');
    expect((await runAsAgentJob({ id: 'job-1', agent: 'TACTICAL', triggeredBy: null }, () => ask())).refusal).toBe('origin');
    expect(sent).toHaveLength(0);
  });

  it('a person\'s queued agent job may call, and its record names the job and the agent', async () => {
    const out = await runAsAgentJob({ id: 'job-1', agent: 'TACTICAL', triggeredBy: 'u-1' }, () => ask());
    expect(out.ok).toBe(true);
    expect(ledger.rows[0]).toMatchObject({ origin: 'agent-job', agentRunId: 'job-1', agent: 'TACTICAL' });
  });

  it('the switch is the Platform Owner\'s: anonymous 401, every club role 403, and nothing changes', async () => {
    expect((await request(app()).post('/system/agents/ai-execution').send({ enabled: true, reason: 'go' })).status).toBe(401);
    for (const role of CLUB_ROLES) {
      actingAs = { id: `u-${role}`, clubId: 'c-1', role };
      const res = await request(app()).post('/system/agents/ai-execution').send({ enabled: true, reason: 'please' });
      expect([role, res.status]).toEqual([role, 403]);
    }
    expect(control.row).toBeNull();
    expect(audit).toEqual([]);
  });

  it('the owner must say on or off, and why', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const body of [{}, { enabled: 'yes', reason: 'because' }, { enabled: true }, { enabled: true, reason: 'x' }, { enabled: true, reason: 'y'.repeat(501) }]) {
      expect((await request(app()).post('/system/agents/ai-execution').send(body)).status).toBe(400);
    }
    expect(control.row).toBeNull();
  });

  it('the cost view is the owner\'s alone', async () => {
    expect((await request(app()).get('/system/agents/cost')).status).toBe(401);
    for (const role of CLUB_ROLES) {
      actingAs = { id: `u-${role}`, clubId: 'c-1', role };
      expect([role, (await request(app()).get('/system/agents/cost')).status]).toEqual([role, 403]);
    }
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    const res = await request(app()).get('/system/agents/cost');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

// ── 4 ───────────────────────────────────────────────────────────────────────
describe('4. per-request, per-workflow and per-agent-run limits', () => {
  it('a request that could exceed the per-request limit is refused before anything is reserved', async () => {
    process.env.AI_MAX_TOKENS_PER_REQUEST = String(ONE - 1);
    const out = await asUser('u-1', () => ask());
    expect(out.refusal).toBe('request-limit');
    expect(ledger.rows.map((r) => r.outcome)).toEqual(['REFUSED']);
    process.env.AI_MAX_TOKENS_PER_REQUEST = String(ONE);
    expect((await asUser('u-1', () => ask())).ok).toBe(true);
  });

  it('input and output both count: the reservation is the input upper bound plus the output cap, priced apart', () => {
    expect(inputTokenUpperBound('héllo', 'sys')).toBe(6 + 3 + FRAMING_OVERHEAD_TOKENS);
    expect(costMicros(1_000, 100, { inputPerMTokUsd: 3, outputPerMTokUsd: 15 })).toBe(3_000 + 1_500);
    expect(costMicros(1, 1, { inputPerMTokUsd: 0.25, outputPerMTokUsd: 1.25 })).toBe(2);
  });

  it('a workflow stops at its budget; another workflow is unaffected', async () => {
    // Reported usage (40 + 10) replaces each reservation once settled.
    process.env.AI_MAX_TOKENS_PER_WORKFLOW = String(50 + ONE);
    const inWf = (id: string) => asUser('u-1', () => withWorkflow(id, () => ask()));
    expect((await inWf('wf-1')).ok).toBe(true);
    expect((await inWf('wf-1')).ok).toBe(true);
    expect((await inWf('wf-1')).refusal).toBe('workflow-budget');
    expect((await inWf('wf-2')).ok).toBe(true);
  });

  it('an agent run stops at its budget', async () => {
    // Reported usage (40 + 10) replaces each reservation once settled.
    process.env.AI_MAX_TOKENS_PER_AGENT_RUN = String(50 + ONE);
    const job = (id: string) => runAsAgentJob({ id, agent: 'TACTICAL', triggeredBy: 'u-1' }, () => ask());
    expect((await job('job-1')).ok).toBe(true);
    expect((await job('job-1')).ok).toBe(true);
    expect((await job('job-1')).refusal).toBe('agent-budget');
    expect((await job('job-2')).ok).toBe(true);
  });
});

// ── 5, 6 ────────────────────────────────────────────────────────────────────
describe('5. the daily platform budget, in tokens and in estimated cost', () => {
  it('tokens: refused once the next reservation would not fit', async () => {
    process.env.AI_PLATFORM_DAILY_TOKEN_BUDGET = String(50 + ONE);
    expect((await asUser('u-1', () => ask())).ok).toBe(true);
    expect((await asUser('u-1', () => ask())).ok).toBe(true);
    expect((await asUser('u-1', () => ask())).refusal).toBe('daily-budget');
  });

  it('cost: refused once the next reservation\'s estimated cost would not fit', async () => {
    const oneCost = costMicros(ONE - 100, 100, { inputPerMTokUsd: 3, outputPerMTokUsd: 15 });
    process.env.AI_PLATFORM_DAILY_COST_BUDGET_USD = String(oneCost / 1_000_000);
    expect((await asUser('u-1', () => ask())).ok).toBe(true);
    expect((await asUser('u-1', () => ask())).refusal).toBe('daily-budget');
  });
});

describe('6. the monthly platform budget', () => {
  it('earlier days of the month count; last month does not', async () => {
    const now = new Date();
    const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 5));
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12));
    const seed = (createdAt: Date, tokensIn: number) => ledger.rows.push({
      id: `seed-${ledger.rows.length}`, caller: 's', purpose: 'agent', clubId: 'club-z', model: 'm', provider: 'anthropic', dataClasses: ['INTERNAL'],
      pseudonymised: 0, outcome: 'OK', createdAt, tokensIn, tokensOut: 0, reservedTokens: null, costMicros: 0, reservedCostMicros: null, workflowId: null, agentRunId: null,
    });
    process.env.AI_PLATFORM_MONTHLY_TOKEN_BUDGET = '10000';
    seed(lastMonth, 9_999);
    expect((await asUser('u-1', () => ask())).ok).toBe(true);
    if (firstOfMonth.getUTCDate() === now.getUTCDate() && now.getUTCDate() === 1) return; // the 1st: no earlier day this month
    seed(firstOfMonth, 10_000 - ONE);
    expect((await asUser('u-1', () => ask())).refusal).toBe('monthly-budget');
  });

  it('cost: the monthly estimate is a limit of its own', () => {
    const l = { ...aiPolicyConfig({}).limits, monthlyCostMicros: 1_000 };
    const s = { enabled: true, dayTokens: 0, monthTokens: 0, dayCostMicros: 0, monthCostMicros: 999, clubDayTokens: 0, workflowTokens: 0, agentRunTokens: 0, inFlight: 0 };
    expect(decide(s, { tokens: 1, costMicros: 1, workflowId: null, agentRunId: null }, l)).toEqual({ ok: true });
    expect(decide(s, { tokens: 1, costMicros: 2, workflowId: null, agentRunId: null }, l)).toMatchObject({ ok: false, refusal: 'monthly-budget' });
  });
});

// ── 7 ───────────────────────────────────────────────────────────────────────
describe('7. concurrent requests cannot overspend a shared budget', () => {
  it('twenty-five at once against a budget for ten: exactly ten are reserved, one at a time', async () => {
    process.env.AI_PLATFORM_DAILY_TOKEN_BUDGET = String(10 * ONE);
    process.env.AI_MAX_CONCURRENT_REQUESTS = '1000';
    hold = true; // nothing settles until every reservation has been decided
    const calls = Array.from({ length: 25 }, () => asUser('u-1', () => ask()));
    await new Promise((r) => setTimeout(r, 50));
    const reserved = ledger.rows.filter((r) => r.outcome === 'STARTED');
    expect(reserved).toHaveLength(10);
    expect(reserved.reduce((n, r) => n + (r.reservedTokens ?? 0), 0)).toBeLessThanOrEqual(10 * ONE);
    expect(ledger.maxOverlap).toBe(1);
    release.forEach((r) => r());
    const outs = await Promise.all(calls);
    expect(outs.filter((o) => o.ok)).toHaveLength(10);
    expect(outs.filter((o) => o.refusal === 'daily-budget')).toHaveLength(15);
  });

  it('the concurrency limit holds while calls are in flight, and frees as they settle', async () => {
    process.env.AI_MAX_CONCURRENT_REQUESTS = '2';
    hold = true;
    const a = asUser('u-1', () => ask()); const b = asUser('u-1', () => ask());
    await new Promise((r) => setTimeout(r, 20));
    expect((await asUser('u-1', () => ask())).refusal).toBe('concurrency');
    release.forEach((r) => r()); release = [];
    await Promise.all([a, b]);
    hold = false;
    expect((await asUser('u-1', () => ask())).ok).toBe(true);
  });
});

// ── 8 ───────────────────────────────────────────────────────────────────────
describe('8. the emergency switch', () => {
  it('OFF refuses every new call at once; a call already sent finishes and is recorded', async () => {
    hold = true;
    const inFlight = asUser('u-1', () => ask());
    await new Promise((r) => setTimeout(r, 20));
    ledger.enabled = false;
    expect((await asUser('u-1', () => ask())).refusal).toBe('disabled');
    release.forEach((r) => r());
    expect((await inFlight).ok).toBe(true);
    expect(ledger.rows.map((r) => r.outcome)).toEqual(['OK', 'REFUSED']);
  });

  it('the owner switches it server-side, and each change is audited with its reason', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    const on = await request(app()).post('/system/agents/ai-execution').send({ enabled: true, reason: 'approved trial' });
    expect(on.status).toBe(200);
    expect(on.body.data.aiExecution).toMatchObject({ enabled: true, reason: 'approved trial', readable: true });
    expect(await prismaAiLedger.executionEnabled()).toBe(true);
    const off = await request(app()).post('/system/agents/ai-execution').send({ enabled: false, reason: 'stop now' });
    expect(off.body.data.aiExecution.enabled).toBe(false);
    expect(await prismaAiLedger.executionEnabled()).toBe(false);
    expect(audit.map((a) => [a.action, a.category, a.userId, a.message])).toEqual([
      ['AI_EXECUTION_ENABLED', 'LIMITS', OWNER, 'approved trial'],
      ['AI_EXECUTION_DISABLED', 'LIMITS', OWNER, 'stop now'],
    ]);
  });
});

// ── 9 ───────────────────────────────────────────────────────────────────────
describe('9. recursive and agent-to-agent execution is rejected', () => {
  it('a job cannot run inside a job', () => {
    expect(() => runAsAgentJob({ id: 'a', agent: 'TACTICAL', triggeredBy: 'u-1' },
      () => runAsAgentJob({ id: 'b', agent: 'MEDICAL', triggeredBy: 'u-1' }, () => 1))).toThrow(/cannot start another agent job/);
  });

  it('only a signed-in person\'s request creates AI work: never a job, a timer or nothing', async () => {
    expect(() => assertMayCreateAgentWork()).toThrow();
    await expect(asUser(null, () => assertMayCreateAgentWork())).rejects.toThrow();
    await expect(runAsAgentJob({ id: 'a', agent: 'TACTICAL', triggeredBy: 'u-1' }, async () => assertMayCreateAgentWork())).rejects.toThrow();
    expect(() => runInBackgroundScope('t', () => assertMayCreateAgentWork())).toThrow();
    await expect(asUser('u-1', () => assertMayCreateAgentWork())).resolves.toBeUndefined();
  });

  it('a job that tries to queue another job is refused, and no job is written', async () => {
    const actor = { userId: 'u-1', clubId: 'c-1', role: 'HEAD_COACH' } as never;
    const dto = { agent: 'TACTICAL', kind: 'TACTICAL.CUSTOM', input: {} } as never;
    await expect(runAsAgentJob({ id: 'a', agent: 'TACTICAL', triggeredBy: 'u-1' }, () => enqueueAgentJob(actor, dto))).rejects.toThrow(/signed-in person/);
    expect(jobsCreated).toEqual([]);
  });

  it('every place that creates an AIAgentJob asks first', () => {
    for (const f of ['src/controllers/ai-ops.controller.ts', 'src/intelligence/intelligence.service.ts', 'src/services/automation.service.ts']) {
      const src = read(f);
      const at = src.indexOf('assertMayCreateAgentWork();');
      expect([f, at > 0 && at < src.indexOf('aIAgentJob.create(', at)]).toEqual([f, true]);
    }
    const creators = execSyncList(/aIAgentJob\.create\(/);
    expect(creators.sort()).toEqual(['src/controllers/ai-ops.controller.ts', 'src/intelligence/intelligence.service.ts', 'src/services/automation.service.ts']);
  });
});

const NARRATIVE = {
  clubId: 'c-1', domain: 'player', decisionType: 'injury-risk', subject: { type: 'player', id: 'p-1' },
  score: 0.5, confidence: 0.5, urgency: 'LOW', features: {}, factors: [], recommendation: { action: 'rest' }, alternatives: [],
} as never;

/** Files under src/ whose code (comments stripped) matches. */
function execSyncList(re: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && re.test(fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))) out.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

// ── 10 ──────────────────────────────────────────────────────────────────────
describe('10. autonomous, scheduled and background execution is rejected', () => {
  it('a timer set inside a background origin inherits it, and its call is refused', async () => {
    const out = await new Promise<GatewayResult>((resolve) => runInBackgroundScope('test-worker', () => { setTimeout(() => { ask().then(resolve); }, 1); }));
    expect(out.refusal).toBe('autonomous');
    expect(sent).toHaveLength(0);
  });

  it('every background worker is started inside a background origin, and the agent worker runs each job as itself', () => {
    expect(read('src/infra/background-workers.ts')).toMatch(/runInBackgroundScope\(w\.label, w\.start\)/);
    expect(read('src/workers/ai-agent.worker.ts')).toMatch(/runAsAgentJob\(\{ id: j\.id, agent: j\.agent, triggeredBy: j\.triggeredBy \}, \(\) => runOne\(j\)\)/);
    expect(read('src/app.ts')).toMatch(/app\.use\(`\/api\/\$\{config\.apiVersion\}`, aiRequestScope\);\n\s+app\.use\(`\/api\/\$\{config\.apiVersion\}`, tenantGuard, routes\);/);
  });

  it('no retry storms: the provider makes one attempt and aborts at its timeout', async () => {
    (config.anthropic as Row).apiKey = KEY;
    mockSdk.hang = true; mockSdk.calls.length = 0;
    await expect(anthropicProvider.complete({ caller: 't', purpose: 'agent', prompt: 'p', timeoutMs: 30, maxOutputTokens: 5 },
      { id: 'm', provider: 'anthropic', providerModel: 'test-model', purposes: ['agent'] })).rejects.toMatchObject({ category: 'timeout' });
    expect(mockSdk.ctor.at(-1)).toMatchObject({ maxRetries: 0 });
    expect(mockSdk.calls).toHaveLength(1);
    expect(mockSdk.calls[0].opts).toMatchObject({ maxRetries: 0, timeout: 30 });
    expect(mockSdk.calls[0].opts.signal.aborted).toBe(true);
  });

  it('and the narrative adapter calls once, never again on a timeout', async () => {
    (config.anthropic as Row).apiKey = KEY;
    resetGateway();
    let n = 0;
    registerProvider({ id: 'anthropic', available: () => true, complete: async () => { n += 1; throw Object.assign(new Error('t'), { category: 'timeout' }); } });
    registerModel({ id: 'familista-default', provider: 'anthropic', providerModel: 'test-model', purposes: ['decision-narrative'] });
    setEgressRecorder(memoryLedger({ enabled: true }));
    const r = await asUser('u-1', () => generateNarrative(NARRATIVE));
    expect(r.ok).toBe(false);
    expect(n).toBe(1);
  });
});

// ── 11 ──────────────────────────────────────────────────────────────────────
describe('11. the deterministic LAB still runs, and makes no model call', () => {
  it('the committed execution definition replays identically twice, with nothing sent', () => {
    const at = 'lab/orchestrator/definitions/matchday-staff-notice.json';
    const text = read(at);
    const a = replayDefinition(text, at, { environment: 'LAB' });
    const b = replayDefinition(text, at, { environment: 'LAB' });
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.dossierText === b.dossierText).toBe(true);
    expect(sent).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });
});

// ── 12 ──────────────────────────────────────────────────────────────────────
describe('12. tenant isolation', () => {
  it('one club using its daily budget does not refuse another club', async () => {
    process.env.AI_CLUB_DAILY_TOKEN_BUDGET = String(50 + ONE);
    expect((await asUser('u-1', () => ask({ clubId: 'club-a' }))).ok).toBe(true);
    expect((await asUser('u-1', () => ask({ clubId: 'club-a' }))).ok).toBe(true);
    expect((await asUser('u-1', () => ask({ clubId: 'club-a' }))).refusal).toBe('budget');
    expect((await asUser('u-2', () => ask({ clubId: 'club-b' }))).ok).toBe(true);
  });

  it('the owner\'s view is platform-wide: it has no club field anywhere', async () => {
    const v = await aiCostRoomView();
    expect(JSON.stringify(v)).not.toMatch(/clubId|"club"/);
  });
});

// ── 13 ──────────────────────────────────────────────────────────────────────
describe('13. a provider key never appears in a log or a response', () => {
  it('through success, refusal, provider failure, the owner\'s view and the switch', async () => {
    (config.anthropic as Row).apiKey = KEY;
    const lines: string[] = [];
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(logger, m).mockImplementation(((...a: unknown[]) => { lines.push(JSON.stringify(a)); return logger; }) as never));
    const cons = (['log', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(JSON.stringify(a)); }));
    try {
      const outs: unknown[] = [];
      outs.push(await asUser('u-1', () => ask()));
      ledger.enabled = false;
      outs.push(await asUser('u-1', () => ask()));
      ledger.enabled = true;
      registerProvider({ id: 'anthropic', available: () => true, complete: async () => { throw Object.assign(new Error(`401 invalid x-api-key ${KEY}`), { category: 'failed', status: 401 }); } });
      outs.push(await asUser('u-1', () => ask()));
      outs.push(await aiCostRoomView());
      actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
      outs.push((await request(app()).get('/system/agents/cost')).body);
      outs.push((await request(app()).post('/system/agents/ai-execution').send({ enabled: true, reason: 'checking' })).body);
      const text = JSON.stringify(outs) + lines.join('\n') + JSON.stringify(ledger.rows);
      expect(text).not.toContain(KEY);
      expect(text).not.toMatch(/sk-ant-/);
      expect((outs[3] as Row).providerConfigured).toBe(true);
    } finally {
      spies.forEach((s) => s.mockRestore()); cons.forEach((s) => s.mockRestore());
    }
  });
});

// ── 14 ──────────────────────────────────────────────────────────────────────
describe('14. existing behaviour is preserved while AI is off', () => {
  it('the decision narrative falls back to its deterministic text: the refusal is a reason, not an error', async () => {
    (config.anthropic as Row).apiKey = KEY;
    resetGateway();
    setEgressRecorder(memoryLedger({ enabled: false }));
    const r = await asUser('u-1', () => generateNarrative(NARRATIVE));
    expect(r).toMatchObject({ ok: false, reason: 'LLM_REFUSED_DISABLED' });
  });

  it('a successful call settles to the reported usage and the configured price', async () => {
    const out = await asUser('u-1', () => ask());
    expect(out.ok).toBe(true);
    expect(ledger.rows[0]).toMatchObject({ outcome: 'OK', tokensIn: 40, tokensOut: 10, reservedTokens: ONE, costMicros: 40 * 3 + 10 * 15 });
  });
});
