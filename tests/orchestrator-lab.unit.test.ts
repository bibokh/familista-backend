/**
 * Global Multi-Agent Intelligence, AI-0.2 — the Multi-Agent Orchestrator
 * foundation, in the Lab (lab/orchestrator).
 *
 * 1. Discovery and routing: agents come from the Agent Registry, every routing
 *    decision says why for every candidate, the least-privileged agent wins, a
 *    DRAFT agent and an agent of the wrong scope are never routed to, and a new
 *    agent joins through the registry with no change to the orchestrator.
 * 2. A multi-agent workflow: three registry agents exchange validated outputs
 *    in dependency order, deterministically, with a verifiable trace.
 * 3. Human approval and the kill switch: an action waits for a person; only an
 *    approver of the plan's club, not the requester, who may read what it
 *    writes, can decide it; the kill switch stops actions and not reading.
 * 4. Security and isolation: LAB only, synthetic tenants only, no cross-tenant
 *    input, the requester's read rights, medical data kept with medical agents,
 *    bounded plans, failures contained to what depends on them.
 * 5. The lab stays out of production: nothing in src/ imports it, it runs with
 *    no database configured and no network, and it refuses outside the Lab.
 *
 * Each guard has a negative control: the same plan with one thing changed,
 * refused or contained for exactly that reason.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import net from 'net';
import { spawnSync } from 'child_process';
import { z } from 'zod';
import { PLATFORM_AGENT_MANIFESTS, platformAgentRegistry } from '../src/platform/agents/catalog';
import { AgentRegistry } from '../src/platform/agents/registry';
import { authorizeTool, engageKillSwitch, releaseKillSwitch } from '../src/platform/intelligence/agents';
import { AGENT_RECORD_CLASS, tierFor } from '../src/security/ai-read-policy';
import { APPROVER_ROLES as SERVICE_APPROVER_ROLES } from '../src/security/ai-approval.service';
import { APPROVER_ROLES } from '../src/security/approver-roles';
import { ORCHESTRATION_CONTRACT, LIMITS, type PlanRequest } from '../lab/orchestrator/contracts';
import { decideApproval, eligibleApproverRoles, labIdentity, startRun, type PlanRun, type RunContext } from '../lab/orchestrator/engine';
import { labOperations, OperationCatalog, OperationCatalogError, type LabOperation } from '../lab/orchestrator/operations';
import { capabilityIndex, readCeiling, recordClassOf, route } from '../lab/orchestrator/routing';
import { GENESIS, Trace, verifyTrace, type TraceEvent } from '../lab/orchestrator/trace';
import * as S from '../lab/orchestrator/scenarios';
import { SYNTHETIC_LAB_MANIFESTS } from './fixtures/agents/synthetic-manifests';

const ROOT = path.join(__dirname, '..');
const LAB_DIR = path.join(ROOT, 'lab', 'orchestrator');

const ctx = (over: Partial<RunContext> = {}): RunContext => ({ registry: platformAgentRegistry(), operations: labOperations(), environment: 'LAB', ...over });
const task = (run: PlanRun, id: string) => {
  const t = run.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
const types = (run: PlanRun) => run.trace.map((e) => e.type);
const lastOf = (run: PlanRun) => run.trace[run.trace.length - 1];
const op = <I, O>(o: Partial<LabOperation<I, O>> & Pick<LabOperation<I, O>, 'key' | 'tool' | 'run'>): LabOperation => ({
  title: o.key, domain: null, output: 'INTERNAL', input: z.object({}).passthrough(), result: z.unknown(), consumes: [], ...o,
} as unknown as LabOperation);
const catalogWith = (...extra: LabOperation[]) => {
  const c = labOperations();
  for (const e of extra) c.register(e);
  return c;
};
const plan = (over: Partial<PlanRequest>, tasks: PlanRequest['tasks']): PlanRequest => ({
  contract: ORCHESTRATION_CONTRACT, id: 'lab-plan', title: 'A LAB plan', scope: { kind: 'CLUB', clubId: S.LAB_CLUB },
  requestedBy: { ...S.HEAD_COACH }, tasks, ...over,
});
const opponentTask = (id = 'opponent', input: Record<string, unknown> = S.matchPreparation().tasks[0].input) =>
  ({ id, operation: 'tactics.opponent-profile@1', input, dependsOn: [] as string[] });

afterEach(() => releaseKillSwitch());

// ── 1. discovery and routing ────────────────────────────────────────────────

describe('discovery and routing over the Agent Registry', () => {
  it('holds no list of agents: no registry id appears anywhere in the orchestrator, and its capability index is the registry\'s', () => {
    const sources = fs.readdirSync(LAB_DIR).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(LAB_DIR, f), 'utf8')).join('\n');
    for (const a of platformAgentRegistry().list()) expect(sources).not.toContain(a.id);
    const index = capabilityIndex(platformAgentRegistry());
    for (const a of platformAgentRegistry().list()) for (const t of a.tools) expect(index[t]).toContain(a.id);
    expect(Object.values(index).flat().every((id) => platformAgentRegistry().get(id))).toBe(true);
  });

  it('every candidate is recorded with the reason it was taken or passed over', () => {
    const r = route(platformAgentRegistry(), labOperations().get('tactics.opponent-profile@1') as LabOperation, { kind: 'CLUB', clubId: S.LAB_CLUB });
    expect(r.agent?.domain).toBe('TACTICS');
    expect(r.candidates).toHaveLength(platformAgentRegistry().size);
    expect(r.candidates.filter((c) => !c.eligible).every((c) => /^domain /.test(c.reason))).toBe(true);
  });

  it('the least-privileged agent wins: lowest read ceiling, then fewest tools, then id', () => {
    const any = op({ key: 'reports.any-holder@1', tool: 'createReport', run: () => ({}) });
    const r = route(platformAgentRegistry(), any, { kind: 'CLUB', clubId: S.LAB_CLUB });
    const order = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 } as const;
    const ranked = r.ranked.map((id) => platformAgentRegistry().get(id)!);
    expect(ranked.length).toBe(platformAgentRegistry().size);
    for (let i = 1; i < ranked.length; i++) expect(order[readCeiling(ranked[i])]).toBeGreaterThanOrEqual(order[readCeiling(ranked[i - 1])]);
    expect(readCeiling(r.agent!)).toBe('INTERNAL');
    expect(r.ranked[r.ranked.length - 1]).toBe(platformAgentRegistry().list().find((a) => readCeiling(a) === 'RESTRICTED')!.id);
  });

  it('a new agent joins through the registry and its operation, with no change to the orchestrator', () => {
    const registry = new AgentRegistry();
    for (const m of PLATFORM_AGENT_MANIFESTS) registry.register(m);
    const vision = SYNTHETIC_LAB_MANIFESTS.find((m) => m.domain === 'VISION')!;
    registry.register(vision);
    const summary = op({
      key: 'vision.match-summary@1', tool: 'getMatch', domain: 'VISION',
      input: z.object({ shots: z.number().int().min(0) }).strict(), result: z.object({ shots: z.number(), verdict: z.string() }).strict(),
      run: (i: { shots: number }) => ({ shots: i.shots, verdict: i.shots > 10 ? 'dominant' : 'even' }),
    });
    const run = startRun(plan({}, [{ id: 'watch', operation: 'vision.match-summary@1', input: { shots: 14 }, dependsOn: [] }]), ctx({ registry, operations: catalogWith(summary) }));
    expect(run.outcome).toBe('COMPLETED');
    expect(task(run, 'watch').agent?.id).toBe(vision.id);
    expect(task(run, 'watch').output).toEqual({ shots: 14, verdict: 'dominant' });
    // Negative control: the same plan over the platform registry alone has nobody to route to.
    const without = startRun(plan({}, [{ id: 'watch', operation: 'vision.match-summary@1', input: { shots: 14 }, dependsOn: [] }]), ctx({ operations: catalogWith(summary) }));
    expect(without.refusal?.code).toBe('NO_ELIGIBLE_AGENT');
  });

  it('a DRAFT agent is never routed to', () => {
    const registry = new AgentRegistry();
    const draft = SYNTHETIC_LAB_MANIFESTS.find((m) => m.lifecycle === 'DRAFT' && m.domain === 'COMMERCE')!;
    registry.register(draft);
    const order = op({ key: 'commerce.order-draft@1', tool: 'createReport', domain: 'COMMERCE', run: () => ({}) });
    const run = startRun(plan({}, [{ id: 'order', operation: 'commerce.order-draft@1', input: {}, dependsOn: [] }]), ctx({ registry, operations: catalogWith(order) }));
    expect(run.refusal?.code).toBe('NO_ELIGIBLE_AGENT');
    expect(run.refusal?.message).toContain('lifecycle DRAFT is never routed to');
  });

  it('a platform plan never reaches a club agent, and only the Platform Owner may make one', () => {
    const owner = { userId: 'lab-user-owner', role: 'SUPER_ADMIN', clubId: null };
    const run = startRun(plan({ scope: { kind: 'PLATFORM' }, requestedBy: owner }, [opponentTask()]), ctx());
    expect(run.refusal?.code).toBe('NO_ELIGIBLE_AGENT');
    expect(run.refusal?.message).toContain('a CLUB agent does not act in a PLATFORM plan');
    const notOwner = startRun(plan({ scope: { kind: 'PLATFORM' }, requestedBy: { ...S.CLUB_ADMIN } }, [opponentTask()]), ctx());
    expect(notOwner.refusal?.code).toBe('REQUESTER_SCOPE');
  });

  it('a record\'s class follows the read policy for every bound agent', () => {
    for (const a of platformAgentRegistry().list()) if (a.binding) expect(recordClassOf(a)).toBe(AGENT_RECORD_CLASS[a.binding.legacyAgent]);
  });
});

// ── 2. a multi-agent workflow ───────────────────────────────────────────────

describe('a multi-agent LAB workflow', () => {
  it('three agents exchange validated outputs in dependency order: tactical analysis → training draft → staff briefing', () => {
    const run = startRun(S.matchPreparation(), ctx());
    expect(run.outcome).toBe('COMPLETED');
    expect(run.order).toEqual(['opponent', 'session', 'briefing']);
    const agents = run.tasks.map((t) => platformAgentRegistry().get(t.agent!.id)!.domain);
    expect(agents).toEqual(['TACTICS', 'TRAINING', 'CLUB_OPERATIONS']);
    expect(task(run, 'opponent').output).toMatchObject({ pressing: 'HIGH', attackSide: 'LEFT', matches: 3 });
    expect(task(run, 'session').output).toMatchObject({ focus: ['Play out under a high press', 'Defending attacks down their left side'], committed: false, totalMinutes: 90 });
    expect((task(run, 'briefing').output as { sections: unknown[] }).sections).toHaveLength(2);
    expect(types(run).filter((t) => t === 'HANDOFF_ACCEPTED')).toHaveLength(3);
    expect(verifyTrace(run.trace)).toEqual({ ok: true, brokenAt: null });
  });

  it('is deterministic: the same plan over the same registry gives the same trace, byte for byte', () => {
    const a = startRun(S.matchPreparation(), ctx());
    const b = startRun(S.matchPreparation(), ctx());
    expect(b.digest).toBe(a.digest);
    expect(JSON.stringify(b.trace)).toBe(JSON.stringify(a.trace));
    // Negative control: one input changed changes the run's digest.
    const changed = S.matchPreparation();
    (changed.tasks[1].input as { minutes: number }).minutes = 75;
    expect(startRun(changed, ctx()).digest).not.toBe(a.digest);
  });

  it('the trace records decisions and digests, never an output', () => {
    const run = startRun(S.matchPreparation(), ctx());
    const text = JSON.stringify(run.trace);
    expect(text).not.toContain('Lab Rovers');
    expect(text).not.toContain('Play out under a high press');
    expect(text).toContain(task(run, 'briefing').outputDigest!.slice(0, 12));
  });

  it('the run is frozen: nothing outside the orchestrator can change what it decided', () => {
    const run = startRun(S.matchPreparation(), ctx());
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(task(run, 'opponent').output)).toBe(true);
    expect(() => { (run.tasks as unknown as unknown[]).push({}); }).toThrow();
  });
});

// ── 3. human approval and the kill switch ───────────────────────────────────

describe('human approval', () => {
  it('an action waits for a person, and the approvers named are those who may read what it writes', () => {
    const run = startRun(S.liveAdjustment(), ctx());
    expect(run.outcome).toBe('AWAITING_APPROVAL');
    const change = task(run, 'change');
    expect(change.state).toBe('AWAITING_APPROVAL');
    expect(change.output).toBeNull();
    expect(change.approval?.eligibleRoles).toEqual(APPROVER_ROLES.filter((r) => tierFor(r, 'OPERATIONAL') === 'FULL'));
  });

  it('approved by another person of the club, the action is simulated, never made', () => {
    const waiting = startRun(S.liveAdjustment(), ctx());
    const done = decideApproval(waiting, S.approveLiveChange(), ctx());
    expect(done.outcome).toBe('COMPLETED');
    expect(task(done, 'change').output).toEqual({ proposal: { minute: 46, formation: '4-2-3-1', because: 'Opponent pressing is high' }, executed: false, simulated: true });
    expect(task(done, 'change').approval).toMatchObject({ decision: 'APPROVED', decidedBy: { userId: S.CLUB_ADMIN.userId, role: 'CLUB_ADMIN' } });
    expect(task(waiting, 'change').state).toBe('AWAITING_APPROVAL');
    expect(verifyTrace(done.trace).ok).toBe(true);
    expect(done.trace.slice(0, waiting.trace.length)).toEqual(waiting.trace);
  });

  it.each([
    ['the requester', { ...S.HEAD_COACH }, 'SEGREGATION_OF_DUTIES'],
    ['a role that may not decide', { userId: 'lab-user-coach', role: 'COACH', clubId: S.LAB_CLUB }, 'APPROVER_ROLE'],
    ['an approver of another club', { userId: 'lab-user-admin-south', role: 'CLUB_ADMIN', clubId: S.OTHER_LAB_CLUB }, 'APPROVER_CLUB'],
  ])('a decision by %s is refused, recorded, and changes nothing', (_who, by, code) => {
    const waiting = startRun(S.liveAdjustment(), ctx());
    const after = decideApproval(waiting, { taskId: 'change', decision: 'APPROVED', by }, ctx());
    expect(task(after, 'change').state).toBe('AWAITING_APPROVAL');
    expect(after.trace[after.trace.length - 1]).toMatchObject({ type: 'APPROVAL_DECISION_REFUSED', code });
    expect(verifyTrace(after.trace).ok).toBe(true);
  });

  it('a decision on a task that is not waiting, or a malformed one, is refused', () => {
    const waiting = startRun(S.liveAdjustment(), ctx());
    expect(lastOf(decideApproval(waiting, { ...S.approveLiveChange(), taskId: 'opponent' }, ctx())).code).toBe('APPROVAL_NOT_PENDING');
    expect(lastOf(decideApproval(waiting, { taskId: 'change', decision: 'MAYBE', by: S.CLUB_ADMIN }, ctx())).code).toBe('DECISION_INVALID');
    expect(lastOf(decideApproval(waiting, S.approveLiveChange(), ctx({ environment: 'PRODUCTION' }))).code).toBe('ENVIRONMENT_NOT_LAB');
  });

  it('a rejected action ends there, and what consumes it is skipped', () => {
    const notice = op({ key: 'operations.change-notice@1', tool: 'createReport', domain: 'CLUB_OPERATIONS', consumes: ['tactics.live-change@1'], run: () => ({ sent: false }) });
    const p = S.liveAdjustment();
    p.tasks.push({ id: 'notice', operation: 'operations.change-notice@1', input: {}, dependsOn: ['change'] });
    const c = ctx({ operations: catalogWith(notice) });
    const after = decideApproval(startRun(p, c), { ...S.approveLiveChange(), decision: 'REJECTED' }, c);
    expect(task(after, 'change')).toMatchObject({ state: 'REJECTED', reason: { code: 'REJECTED_BY_APPROVER' } });
    expect(task(after, 'notice')).toMatchObject({ state: 'SKIPPED', reason: { code: 'DEPENDENCY_NOT_SUCCEEDED' } });
    expect(after.outcome).toBe('PARTIAL');
  });

  it('a medical action names no approver, because no approver role may read medical records, and every decision on it is refused', () => {
    const run = startRun(S.medicalBoundary(), ctx());
    expect(task(run, 'availability').state).toBe('SUCCEEDED');
    const rec = task(run, 'recommendation');
    expect(rec.state).toBe('AWAITING_APPROVAL');
    expect(rec.approval?.eligibleRoles).toEqual([]);
    expect(eligibleApproverRoles('MEDICAL')).toEqual([]);
    expect(run.trace.find((e) => e.type === 'APPROVAL_REQUIRED')?.code).toBe('NO_ELIGIBLE_APPROVER');
    expect(lastOf(decideApproval(run, { taskId: 'recommendation', decision: 'APPROVED', by: { ...S.CLUB_ADMIN } }, ctx())).code).toBe('APPROVER_CANNOT_READ');
    expect(lastOf(decideApproval(run, { taskId: 'recommendation', decision: 'APPROVED', by: { userId: 'lab-user-doctor', role: 'MEDICAL_STAFF', clubId: S.LAB_CLUB } }, ctx())).code).toBe('APPROVER_ROLE');
  });

  it('the orchestrator applies the AI Approval Gate\'s own approver list', () => {
    expect(SERVICE_APPROVER_ROLES).toBe(APPROVER_ROLES);
  });
});

describe('the global kill switch', () => {
  it('stops actions and not reading: the analysis runs, the change is refused', () => {
    engageKillSwitch('LAB test');
    const run = startRun(S.liveAdjustment(), ctx());
    expect(task(run, 'opponent').state).toBe('SUCCEEDED');
    expect(task(run, 'change')).toMatchObject({ state: 'REFUSED', reason: { code: 'KILL_SWITCH' } });
    expect(run.outcome).toBe('PARTIAL');
  });

  it('stops an action approved before it was engaged', () => {
    const waiting = startRun(S.liveAdjustment(), ctx());
    engageKillSwitch('LAB test');
    const after = decideApproval(waiting, S.approveLiveChange(), ctx());
    expect(task(after, 'change')).toMatchObject({ state: 'REFUSED', reason: { code: 'KILL_SWITCH' } });
    // Negative control: released, the same decision runs it.
    releaseKillSwitch();
    expect(task(decideApproval(waiting, S.approveLiveChange(), ctx()), 'change').state).toBe('SUCCEEDED');
  });
});

// ── 4. security and isolation ───────────────────────────────────────────────

describe('LAB only, synthetic only', () => {
  it.each(['PRODUCTION', 'STAGING', 'PREVIEW'] as const)('in %s every plan is refused before anything is routed or run', (environment) => {
    const run = startRun(S.matchPreparation(), ctx({ environment }));
    expect(run.refusal?.code).toBe('ENVIRONMENT_NOT_LAB');
    expect(run.tasks).toEqual([]);
    expect(types(run)).toEqual(['PLAN_RECEIVED', 'PLAN_REFUSED', 'RUN_SETTLED']);
  });

  it('this process\'s own environment decides when none is given, and a test process is not the Lab', () => {
    expect(startRun(S.matchPreparation(), { registry: platformAgentRegistry(), operations: labOperations() }).refusal?.code).toBe('ENVIRONMENT_NOT_LAB');
  });

  it('the tool registry refuses a LAB agent outside the Lab too, whatever the orchestrator decided', () => {
    const tactical = platformAgentRegistry().list().find((a) => a.domain === 'TACTICS')!;
    const identity = labIdentity(tactical, { kind: 'CLUB', clubId: S.LAB_CLUB });
    expect(authorizeTool(identity, 'analyzeOpponent', 'LAB').allowed).toBe(true);
    expect(authorizeTool(identity, 'analyzeOpponent', 'PRODUCTION')).toMatchObject({ allowed: false, reason: 'The agent belongs to LAB; this is PRODUCTION' });
  });

  it('no real tenant or person can be named in a LAB plan', () => {
    expect(startRun(plan({ scope: { kind: 'CLUB', clubId: '7f3c2a1e-0000-4000-8000-000000000001' } }, [opponentTask()]), ctx()).refusal?.code).toBe('CONTRACT_INVALID');
    expect(startRun(plan({ requestedBy: { ...S.HEAD_COACH, userId: 'coach@club.example' } }, [opponentTask()]), ctx()).refusal?.code).toBe('CONTRACT_INVALID');
  });
});

describe('tenant isolation and role-based access', () => {
  it('a requester from another club is refused', () => {
    const run = startRun(plan({ requestedBy: { userId: 'lab-user-south', role: 'HEAD_COACH', clubId: S.OTHER_LAB_CLUB } }, [opponentTask()]), ctx());
    expect(run.refusal?.code).toBe('REQUESTER_SCOPE');
  });

  it('a task whose input names another club is refused, and only that task', () => {
    const foreign = { ...S.matchPreparation().tasks[0].input, context: { clubId: S.OTHER_LAB_CLUB } };
    const run = startRun(plan({}, [opponentTask('own'), opponentTask('foreign', foreign)]), ctx());
    expect(task(run, 'foreign')).toMatchObject({ state: 'REFUSED', reason: { code: 'CROSS_TENANT' } });
    expect(task(run, 'own').state).toBe('SUCCEEDED');
  });

  it.each([
    ['SCOUT', S.matchPreparation, 'OPERATIONAL'],
    ['PLAYER', S.matchPreparation, 'OPERATIONAL'],
    ['HEAD_COACH', S.medicalBoundary, 'MEDICAL'],
    ['CLUB_ADMIN', S.medicalBoundary, 'MEDICAL'],
  ])('a %s cannot request a plan whose agents write records it may not read', (role, scenario, cls) => {
    const p = scenario();
    p.requestedBy = { userId: 'lab-user-someone', role, clubId: S.LAB_CLUB };
    const run = startRun(p, ctx());
    expect(run.refusal?.code).toBe('REQUESTER_CANNOT_READ');
    expect(run.refusal?.message).toContain(cls);
  });

  it('control: roles that may read every record class the plan writes are accepted', () => {
    for (const role of ['HEAD_COACH', 'COACH', 'ANALYST', 'CLUB_ADMIN']) {
      const p = S.matchPreparation();
      p.requestedBy = { userId: 'lab-user-someone', role, clubId: S.LAB_CLUB };
      expect(startRun(p, ctx()).outcome).toBe('COMPLETED');
    }
  });
});

describe('medical and sensitive data', () => {
  const fitList = op({
    key: 'medical.fit-list@1', tool: 'createReport', domain: 'MEDICAL', output: 'INTERNAL',
    run: (i: { players: Array<{ ref: string; medicalStatus: string }> }) => ({ available: i.players.filter((p) => p.medicalStatus === 'FIT').map((p) => p.ref) }),
  });
  const leaky = op({
    key: 'medical.leaky-summary@1', tool: 'createReport', domain: 'MEDICAL', output: 'INTERNAL',
    run: (i: { players: unknown[] }) => ({ players: i.players }),
  });
  const loadPlan = op({
    key: 'training.load-plan@1', tool: 'createTrainingDraft', domain: 'TRAINING',
    consumes: ['medical.availability@1', 'medical.fit-list@1', 'medical.leaky-summary@1'], run: () => ({ committed: false }),
  });
  const medCtx = () => ctx({ operations: catalogWith(fitList, leaky, loadPlan) });
  const players = S.medicalBoundary().tasks[0].input;
  const medicalPlan = (producer: string) => plan({ requestedBy: { ...S.MEDICAL_STAFF } }, [
    { id: 'medical', operation: producer, input: players, dependsOn: [] },
    { id: 'load', operation: 'training.load-plan@1', input: {}, dependsOn: ['medical'] },
  ]);

  it('health data in a task\'s input reaches a medical agent only', () => {
    const injured = { ...S.matchPreparation().tasks[0].input, injuries: [{ ref: 'lab-player-2' }] };
    const run = startRun(plan({}, [opponentTask('opponent', injured)]), ctx());
    expect(task(run, 'opponent')).toMatchObject({ state: 'REFUSED', reason: { code: 'INPUT_HEALTH_DATA' } });
    // Control: the medical agent may take the same kind of input.
    expect(task(startRun(S.medicalBoundary(), ctx()), 'availability').state).toBe('SUCCEEDED');
  });

  it('a RESTRICTED output is never handed to an agent that may not read it', () => {
    const run = startRun(medicalPlan('medical.availability@1'), medCtx());
    expect(task(run, 'medical').state).toBe('SUCCEEDED');
    expect(task(run, 'load')).toMatchObject({ state: 'REFUSED', reason: { code: 'HANDOFF_BLOCKED' } });
    expect(task(run, 'load').reason?.message).toContain('RESTRICTED output');
    expect(types(run)).toContain('HANDOFF_BLOCKED');
  });

  it('a medical record reaches a medical agent only, even when it carries no health field', () => {
    const run = startRun(medicalPlan('medical.fit-list@1'), medCtx());
    expect(task(run, 'medical')).toMatchObject({ state: 'SUCCEEDED', dataClass: 'INTERNAL', recordClass: 'MEDICAL' });
    expect(task(run, 'load')).toMatchObject({ state: 'REFUSED', reason: { code: 'HANDOFF_BLOCKED' } });
    expect(task(run, 'load').reason?.message).toContain('is a medical record');
  });

  it('health data in an output declared below RESTRICTED fails, and nothing consumes it', () => {
    const run = startRun(medicalPlan('medical.leaky-summary@1'), medCtx());
    expect(task(run, 'medical')).toMatchObject({ state: 'FAILED', reason: { code: 'OUTPUT_MISLABELLED' } });
    expect(task(run, 'load').state).toBe('SKIPPED');
  });
});

describe('bounded plans and contained failures', () => {
  const thrower = op({ key: 'tactics.thrower@1', tool: 'analyzeOpponent', domain: 'TACTICS', run: () => { throw new Error('the simulation gave up'); } });
  const malformed = op({ key: 'tactics.malformed@1', tool: 'analyzeOpponent', domain: 'TACTICS', result: z.object({ ok: z.literal(true) }).strict(), run: () => ({ ok: false }) });
  const huge = op({ key: 'tactics.huge@1', tool: 'analyzeOpponent', domain: 'TACTICS', run: () => ({ blob: 'x'.repeat(LIMITS.maxOutputBytes + 1) }) });
  const mutator = op({ key: 'tactics.mutator@1', tool: 'analyzeOpponent', domain: 'TACTICS', run: (i: { n: number }) => { i.n = 2; return { n: i.n }; } });
  const failing = () => ctx({ operations: catalogWith(thrower, malformed, huge, mutator) });

  it.each([
    ['more tasks than the bound', plan({}, Array.from({ length: LIMITS.maxTasks + 1 }, (_, i) => opponentTask(`t-${i}`))), 'CONTRACT_INVALID'],
    ['a cycle', plan({}, [{ ...opponentTask('aa'), dependsOn: ['bb'] }, { ...opponentTask('bb'), dependsOn: ['aa'] }]), 'CYCLE'],
    ['a task that depends on itself', plan({}, [{ ...opponentTask('aa'), dependsOn: ['aa'] }]), 'DEPENDENCY_SELF'],
    ['an unknown dependency', plan({}, [{ ...opponentTask('aa'), dependsOn: ['ghost'] }]), 'DEPENDENCY_UNKNOWN'],
    ['a duplicated task', plan({}, [opponentTask('aa'), opponentTask('aa')]), 'TASK_DUPLICATE'],
    ['an unknown operation', plan({}, [{ id: 'aa', operation: 'tactics.unknown@1', input: {}, dependsOn: [] }]), 'OPERATION_UNKNOWN'],
    ['an exchange the consumer does not declare', plan({ requestedBy: { ...S.MEDICAL_STAFF } }, [S.medicalBoundary().tasks[0], { id: 'brief', operation: 'operations.match-briefing@1', input: { fixture: 'x' }, dependsOn: ['availability'] }]), 'HANDOFF_UNDECLARED'],
    ['another contract version', { ...S.matchPreparation(), contract: 'familista.orchestration/v2' }, 'CONTRACT_INVALID'],
  ])('%s is refused before anything runs', (_what, p, code) => {
    const run = startRun(p, ctx());
    expect(run.refusal?.code).toBe(code);
    expect(run.tasks).toEqual([]);
  });

  it('an oversized input is refused', () => {
    const big = { ...S.matchPreparation().tasks[0].input, note: 'x'.repeat(LIMITS.maxInputBytes) };
    expect(task(startRun(plan({}, [opponentTask('aa', big)]), ctx()), 'aa').reason?.code).toBe('INPUT_TOO_LARGE');
  });

  it('a failing branch takes only what depends on it: the other branch completes', () => {
    const run = startRun(S.partialFailure(), ctx());
    expect(run.outcome).toBe('PARTIAL');
    expect(task(run, 'opponent-a').state).toBe('SUCCEEDED');
    expect(task(run, 'opponent-b')).toMatchObject({ state: 'FAILED', reason: { code: 'INPUT_INVALID' } });
    expect(task(run, 'session-b')).toMatchObject({ state: 'SKIPPED', reason: { code: 'DEPENDENCY_NOT_SUCCEEDED' } });
  });

  it.each([
    ['tactics.thrower@1', 'OPERATION_FAILED'],
    ['tactics.malformed@1', 'OUTPUT_INVALID'],
    ['tactics.huge@1', 'OUTPUT_TOO_LARGE'],
    ['tactics.mutator@1', 'OPERATION_FAILED'],
  ])('%s fails with %s and the run settles', (key, code) => {
    const input = key === 'tactics.mutator@1' ? { n: 1 } : {};
    const p = plan({}, [{ id: 'probe', operation: key, input, dependsOn: [] }, opponentTask('fine')]);
    const run = startRun(p, failing());
    expect(task(run, 'probe')).toMatchObject({ state: 'FAILED', reason: { code } });
    expect(task(run, 'fine').state).toBe('SUCCEEDED');
    expect(p.tasks[0].input).toEqual(input);
  });

  it('an operation that could not be allowed is refused by the catalog itself', () => {
    const c = new OperationCatalog();
    const bad = (o: Partial<LabOperation>) => () => c.register(op({ key: 'tactics.ok@1', tool: 'analyzeOpponent', run: () => ({}), ...o }));
    expect(bad({ tool: 'deleteData' })).toThrow(OperationCatalogError);
    expect(bad({ tool: 'noSuchTool' })).toThrow(/no tool is registered/);
    expect(bad({ key: 'NotAKey' })).toThrow(/not <area>/);
    expect(bad({ domain: 'ASTROLOGY' as never })).toThrow(/not a platform domain/);
    expect(bad({ consumes: ['nope'] })).toThrow(/not an operation key/);
    c.register(op({ key: 'tactics.ok@1', tool: 'analyzeOpponent', run: () => ({}) }));
    expect(bad({})).toThrow(/already registered/);
  });
});

describe('the trace', () => {
  const run = () => startRun(S.matchPreparation(), ctx());
  const tampered = (f: (events: TraceEvent[]) => void) => { const e = run().trace.map((x) => ({ ...x })); f(e); return verifyTrace(e); };

  it('a changed, dropped or reordered event breaks the chain where it happened', () => {
    expect(verifyTrace(run().trace)).toEqual({ ok: true, brokenAt: null });
    expect(tampered((e) => { e[4].detail = 'nothing to see'; })).toEqual({ ok: false, brokenAt: 5 });
    expect(tampered((e) => { e.splice(3, 1); })).toEqual({ ok: false, brokenAt: 4 });
    expect(tampered((e) => { [e[2], e[3]] = [e[3], e[2]]; })).toEqual({ ok: false, brokenAt: 3 });
    expect(run().trace[0].prev).toBe(GENESIS);
  });

  it('is bounded', () => {
    const t = new Trace();
    for (let i = 0; i < LIMITS.maxTraceEvents; i++) t.append('RUN_SETTLED', { detail: String(i) });
    expect(() => t.append('RUN_SETTLED', { detail: 'one more' })).toThrow(/bound/);
  });
});

// ── 5. the lab stays out of production ──────────────────────────────────────

describe('the lab stays out of production', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

  it('the build compiles src/ only, and nothing in src/ imports the lab', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8').replace(/\/\/.*$/gm, ''));
    expect(tsconfig.include).toEqual(['src/**/*']);
    const importers = walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|js)$/.test(f)).filter((f) => /from ['"][^'"]*\blab\/|require\(['"][^'"]*\blab\//.test(fs.readFileSync(f, 'utf8')));
    expect(importers).toEqual([]);
  });

  it('the orchestrator imports only the rules it reuses: no database, gateway, provider, worker or network module', () => {
    const allowed = new Set([
      'zod', 'crypto', 'fs', 'path',
      '../../src/platform/intelligence/agents', '../../src/platform/intelligence/data-classes', '../../src/platform/environment',
      '../../src/platform/agents/registry', '../../src/platform/agents/manifest', '../../src/platform/agents/catalog',
      '../../src/security/ai-read-policy', '../../src/security/approver-roles',
      // AI-0.3: the hash chain and the evidence verifier are production's, so the Lab publishes only what production accepts.
      '../../src/platform/agents/trace-chain', '../../src/platform/agents/orchestration-evidence',
      // AI-0.5: the v2 contract, its verifier and the shared id rules, so the Lab prepares only what production accepts.
      '../../src/platform/agents/execution-evidence',
    ]);
    for (const f of fs.readdirSync(LAB_DIR).filter((x) => x.endsWith('.ts'))) {
      const specs = [...fs.readFileSync(path.join(LAB_DIR, f), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((s) => !s.startsWith('./'));
      for (const s of specs) expect({ file: f, import: s, allowed: allowed.has(s) }).toEqual({ file: f, import: s, allowed: true });
    }
  });

  it('every scenario runs with the network refused', () => {
    const refuse = () => { throw new Error('network refused in the Lab'); };
    const saved = { hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, f: (globalThis as { fetch?: unknown }).fetch };
    Object.assign(http, { request: refuse, get: refuse });
    Object.assign(https, { request: refuse, get: refuse });
    Object.assign(net, { connect: refuse });
    (globalThis as { fetch?: unknown }).fetch = refuse;
    try {
      expect(startRun(S.matchPreparation(), ctx()).outcome).toBe('COMPLETED');
      expect(decideApproval(startRun(S.liveAdjustment(), ctx()), S.approveLiveChange(), ctx()).outcome).toBe('COMPLETED');
      expect(startRun(S.medicalBoundary(), ctx()).outcome).toBe('AWAITING_APPROVAL');
      expect(startRun(S.partialFailure(), ctx()).outcome).toBe('PARTIAL');
    } finally {
      Object.assign(http, { request: saved.hr, get: saved.hg });
      Object.assign(https, { request: saved.sr, get: saved.sg });
      Object.assign(net, { connect: saved.nc });
      (globalThis as { fetch?: unknown }).fetch = saved.f;
    }
  });

  const cli = (env: Record<string, string>) => spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'lab/orchestrator/cli.ts'], {
    cwd: ROOT, encoding: 'utf8', timeout: 90_000, env: { PATH: String(process.env.PATH), HOME: String(process.env.HOME ?? ''), ...env },
  });

  it('the LAB runner works with no database configured and no secret in its environment', () => {
    const r = cli({ FAMILISTA_ENV: 'LAB' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/match-preparation {2}COMPLETED/);
    expect(r.stdout).toMatch(/live-adjustment \(approved by the club admin\) {2}COMPLETED/);
    expect(r.stdout).toMatch(/medical-boundary {2}AWAITING_APPROVAL/);
    expect(r.stdout).toMatch(/partial-failure {2}PARTIAL/);
  }, 120_000);

  it('the same runner in a production process refuses every plan', () => {
    const r = cli({ NODE_ENV: 'production' });
    expect(r.status).toBe(0);
    expect(r.stdout.match(/refused ENVIRONMENT_NOT_LAB/g)?.length).toBe(5);
    expect(r.stdout).not.toContain('SUCCEEDED');
  }, 120_000);
});
