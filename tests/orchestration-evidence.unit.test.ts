/**
 * Global Multi-Agent Intelligence, AI-0.3 — the LAB orchestration evidence the
 * AI Agents Operations Room shows.
 *
 * 1. Reproducible: the committed file is exactly what the LAB orchestrator
 *    produces from the scenarios over the real Agent Registry, byte for byte,
 *    and it is produced in the Lab only.
 * 2. Integrity: every run's trace is a hash chain whose head is the run's id,
 *    and the file's digest is the digest of its content. Each check has a
 *    negative control that changes one thing and is refused for that reason.
 * 3. Coverage: the runs show every state the room distinguishes — completed,
 *    awaiting approval, rejected, failed, skipped, blocked by governance — and
 *    the medical action stays blocked.
 * 4. Privacy: no input, no output, no person's id outside synthetic `lab-…`
 *    references, no health field; a document that holds one is refused.
 * 5. The reader: a missing, oversized, malformed or tampered file shows nothing.
 * 6. The endpoint: the platform owner's alone, uncached, read-only, and as its
 *    contract says.
 * 7. Isolation: production reads the file and never runs the Lab.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

type Row = Record<string, any>;
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const db: Row = {
  platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === OWNER ? { isActive: true } : null) },
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

import { PLATFORM_AGENT_MANIFESTS, platformAgentRegistry } from '../src/platform/agents/catalog';
import { AgentRegistry } from '../src/platform/agents/registry';
import { chainHash, GENESIS, verifyChain } from '../src/platform/agents/trace-chain';
import {
  evidenceDigest, orchestrationRoomView, readOrchestrationEvidence, resetOrchestrationEvidence, verifyOrchestrationEvidence,
  ORCHESTRATION_EVIDENCE_FILE, ORCHESTRATION_EVIDENCE_MAX_BYTES, ORCHESTRATION_EVIDENCE_REASONS, type OrchestrationEvidence,
} from '../src/platform/agents/orchestration-evidence';
import { killSwitchEngaged, engageKillSwitch, releaseKillSwitch } from '../src/platform/intelligence/agents';
import { OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';
import { holdsHealthData } from '../src/security/ai-read-policy';
import agentsRoomRoutes from '../src/routes/agents-room.routes';
import { buildEvidence, serialise, SCENARIOS } from '../lab/orchestrator/evidence';
import { LAB_REF } from '../lab/orchestrator/contracts';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const COMMITTED = read('src/platform/agents/generated/orchestration-evidence.json');
const committed = (): OrchestrationEvidence => JSON.parse(COMMITTED);
const run = (e: OrchestrationEvidence, scenario: string) => {
  const r = e.runs.find((x) => x.scenario === scenario);
  if (!r) throw new Error(`no run ${scenario}`);
  return r;
};
const taskOf = (r: OrchestrationEvidence['runs'][number], id: string) => {
  const t = r.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
/** Re-hash a run's trace and the file, as a forger who knows the rules would: only the check under test can refuse it. */
function reseal(e: OrchestrationEvidence, r?: OrchestrationEvidence['runs'][number]): OrchestrationEvidence {
  if (r) {
    let prev = GENESIS;
    for (const ev of r.trace) { ev.prev = prev; ev.hash = chainHash(ev); prev = ev.hash; }
    r.id = prev; r.digest = prev;
  }
  e.digest = evidenceDigest(e);
  return e;
}
const reasonsOf = (e: unknown) => verifyOrchestrationEvidence(e).reasons;
const keysIn = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysIn(x, out); }
  return out;
};

// ── 1. Reproducible, and made in the Lab only ───────────────────────────────
describe('the evidence is what the LAB orchestrator decided, reproducibly', () => {
  it('the committed file is a fresh build, byte for byte', () => {
    expect(serialise(buildEvidence({ environment: 'LAB' }))).toBe(COMMITTED);
    // Twice: no clock, no randomness.
    expect(buildEvidence({ environment: 'LAB' }).digest).toBe(buildEvidence({ environment: 'LAB' }).digest);
  });

  it.each(['PRODUCTION', 'STAGING', 'PREVIEW'] as const)('negative: it is not produced in %s', (env) => {
    expect(() => buildEvidence({ environment: env as never })).toThrow(/produced in the Lab only/);
  });

  it('negative: it is not produced while the kill switch is engaged, and the kill switch scenario leaves it released', () => {
    engageKillSwitch('test');
    try { expect(() => buildEvidence({ environment: 'LAB' })).toThrow(/kill switch is engaged/); } finally { releaseKillSwitch(); }
    buildEvidence({ environment: 'LAB' });
    expect(killSwitchEngaged()).toBe(false);
  });

  it('holds one run per scenario, in order, over the registry this server runs', () => {
    const e = committed();
    expect(e.runs.map((r) => r.scenario)).toEqual(SCENARIOS.map((s) => s.slug));
    expect(e.registryDigest).toBe(platformAgentRegistry().digest());
    expect(e.environment).toBe('LAB');
  });
});

// ── 2. Integrity ────────────────────────────────────────────────────────────
describe('integrity: every trace is a chain, every run id is its head, the file is its digest', () => {
  it('verifies as committed', () => {
    const e = committed();
    expect(reasonsOf(e)).toEqual([]);
    expect(evidenceDigest(e)).toBe(e.digest);
    for (const r of e.runs) {
      expect([r.scenario, verifyChain(r.trace).ok]).toEqual([r.scenario, true]);
      expect([r.scenario, r.id]).toEqual([r.scenario, r.trace[r.trace.length - 1].hash]);
      expect(r.trace[0].prev).toBe(GENESIS);
    }
  });

  it('negative: one changed word in a trace breaks its chain at that event', () => {
    const e = committed();
    run(e, 'match-preparation').trace[3].detail += ' (edited)';
    e.digest = evidenceDigest(e);
    expect(reasonsOf(e)).toEqual(['integrity: run match-preparation: the trace chain breaks at event 4']);
  });

  it('negative: a re-chained trace whose head is no longer the run id is refused', () => {
    const e = committed();
    const r = run(e, 'live-adjustment-approved');
    const id = r.id;
    r.trace[2].detail += ' (edited)';
    reseal(e, r);
    expect(reasonsOf(e)).toEqual([]); // the forger re-sealed everything, consistently…
    r.id = id; r.digest = id; e.digest = evidenceDigest(e); // …but kept the run id the room was shown
    expect(reasonsOf(e)).toEqual(['integrity: run live-adjustment-approved: its id and digest are not its trace\'s head']);
  });

  it('negative: a state recoloured without its trace is refused, by the file digest and, when that is re-sealed, by the chain', () => {
    const e = committed();
    taskOf(run(e, 'live-adjustment-awaiting'), 'change').state = 'SUCCEEDED';
    expect(reasonsOf(e)).toEqual([
      'integrity: the file\'s digest is not the digest of its content',
      'coherence: run live-adjustment-awaiting: task change is shown as SUCCEEDED; its trace records AWAITING_APPROVAL',
    ]);
    // The state is not in the chain itself, so it is checked against what the chain records.
    expect(reasonsOf(reseal(e))).toEqual(['coherence: run live-adjustment-awaiting: task change is shown as SUCCEEDED; its trace records AWAITING_APPROVAL']);
  });

  it('negative: an incoherent run is refused even when every hash is right', () => {
    const cases: Array<[string, (e: OrchestrationEvidence) => void, RegExp]> = [
      ['order', (e) => { run(e, 'match-preparation').order.pop(); }, /its order is not its tasks/],
      ['operation', (e) => { taskOf(run(e, 'match-preparation'), 'session').operation = 'tactics.unknown-thing@1'; }, /names an operation the evidence does not declare/],
      ['dependency', (e) => { taskOf(run(e, 'match-preparation'), 'session').dependsOn.push('ghost'); }, /depends on a task the run does not hold/],
      ['handoff', (e) => { taskOf(run(e, 'match-preparation'), 'opponent').inputs.push({ from: 'session', status: 'ACCEPTED' }); }, /received a handoff it does not depend on/],
      ['agent', (e) => { taskOf(run(e, 'match-preparation'), 'session').eligibleAgents = []; }, /ran on an agent routing did not rank/],
      ['refusal', (e) => { run(e, 'requester-refused').refusal = null; }, /its outcome and refusal disagree/],
      ['repeat', (e) => { e.runs.push(JSON.parse(JSON.stringify(e.runs[0]))); }, /its id repeats another run's/],
      ['routed agent', (e) => { const t = taskOf(run(e, 'match-preparation'), 'session'); t.agent = { ...taskOf(run(e, 'match-preparation'), 'opponent').agent! }; t.eligibleAgents.push(t.agent.id); }, /names an agent its trace did not route it to/],
      ['decision', (e) => { taskOf(run(e, 'live-adjustment-awaiting'), 'change').approval!.decision = 'APPROVED'; }, /shows a decision its trace does not record/],
      ['outcome', (e) => { run(e, 'partial-failure').outcome = 'COMPLETED'; }, /its outcome is not the one its trace settled on/],
      ['steps', (e) => { (run(e, 'medical-boundary').steps[1] as Row).accepted = true; }, /its steps are not the decisions its trace records/],
    ];
    for (const [name, mutate, why] of cases) {
      const e = committed();
      mutate(e);
      const reasons = reasonsOf(reseal(e));
      expect([name, reasons.length, reasons.some((r) => why.test(r))]).toEqual([name, 1, true]);
    }
  });
});

// ── 3. What the runs show ───────────────────────────────────────────────────
describe('the runs show every state the room distinguishes, as the platform\'s rules decided them', () => {
  const e = committed();

  it('completed, awaiting approval, rejected, failed, skipped and blocked by governance, all present', () => {
    const states = new Set(e.runs.flatMap((r) => r.tasks.map((t) => t.state)));
    expect([...states].sort()).toEqual(['AWAITING_APPROVAL', 'FAILED', 'REFUSED', 'REJECTED', 'SKIPPED', 'SUCCEEDED']);
    expect(new Set(e.runs.map((r) => r.outcome))).toEqual(new Set(['COMPLETED', 'AWAITING_APPROVAL', 'PARTIAL', 'REFUSED']));
  });

  it('three registry agents hand their outputs on in dependency order', () => {
    const r = run(e, 'match-preparation');
    expect(r.outcome).toBe('COMPLETED');
    expect(r.order).toEqual(['opponent', 'session', 'briefing']);
    expect(new Set(r.tasks.map((t) => t.agent?.id)).size).toBe(3);
    expect(taskOf(r, 'briefing').inputs).toEqual([{ from: 'opponent', status: 'ACCEPTED' }, { from: 'session', status: 'ACCEPTED' }]);
  });

  it('an action waits for a person, is approved or rejected by one, and the decision is recorded by role only', () => {
    expect(taskOf(run(e, 'live-adjustment-awaiting'), 'change')).toMatchObject({ state: 'AWAITING_APPROVAL', approval: { decision: null, decidedByRole: null } });
    expect(taskOf(run(e, 'live-adjustment-approved'), 'change')).toMatchObject({ state: 'SUCCEEDED', approval: { decision: 'APPROVED', decidedByRole: 'CLUB_ADMIN' } });
    expect(taskOf(run(e, 'live-adjustment-rejected'), 'change')).toMatchObject({ state: 'REJECTED', approval: { decision: 'REJECTED' }, reason: { code: 'REJECTED_BY_APPROVER' } });
  });

  it('the medical action stays blocked: no approver role may read it, and a club admin\'s approval is refused', () => {
    const r = run(e, 'medical-boundary');
    const rec = taskOf(r, 'recommendation');
    expect(rec).toMatchObject({ state: 'AWAITING_APPROVAL', approval: { eligibleRoles: [], decision: null } });
    expect(r.steps).toEqual([{ kind: 'START' }, { kind: 'DECISION', taskId: 'recommendation', decision: 'APPROVED', byRole: 'CLUB_ADMIN', accepted: false }]);
    expect(r.trace.find((t) => t.type === 'APPROVAL_DECISION_REFUSED')?.code).toBe('APPROVER_CANNOT_READ');
    // The medical report is never handed to the training agent: the handoff itself is blocked, and the report still completes.
    const h = run(e, 'medical-handoff');
    expect(taskOf(h, 'availability')).toMatchObject({ state: 'SUCCEEDED', agent: { id: 'club.medical' }, dataClass: 'RESTRICTED' });
    expect(taskOf(h, 'load')).toMatchObject({ state: 'REFUSED', agent: { id: 'club.training' }, inputs: [{ from: 'availability', status: 'BLOCKED' }], reason: { code: 'HANDOFF_BLOCKED' } });
    expect(h.trace.map((t) => t.type)).toContain('HANDOFF_BLOCKED');
    expect(h.trace.map((t) => t.type)).not.toContain('HANDOFF_ACCEPTED');
    // And the head coach who asks for the medical plan is refused before anything is routed.
    expect(run(e, 'requester-refused')).toMatchObject({ outcome: 'REFUSED', tasks: [], refusal: { code: 'REQUESTER_CANNOT_READ' } });
  });

  it('a failure is contained to what consumes it; the kill switch and another club\'s input are refused by governance', () => {
    const pf = run(e, 'partial-failure');
    expect([taskOf(pf, 'opponent-a').state, taskOf(pf, 'opponent-b').state, taskOf(pf, 'session-b').state]).toEqual(['SUCCEEDED', 'FAILED', 'SKIPPED']);
    // What depends on a failure is skipped before any handoff is checked: there is nothing to hand over.
    expect(taskOf(pf, 'session-b')).toMatchObject({ inputs: [], reason: { code: 'DEPENDENCY_NOT_SUCCEEDED' } });
    expect(taskOf(run(e, 'kill-switch-stop'), 'change')).toMatchObject({ state: 'REFUSED', reason: { code: 'KILL_SWITCH' } });
    expect(taskOf(run(e, 'kill-switch-stop'), 'opponent').state).toBe('SUCCEEDED');
    expect(taskOf(run(e, 'cross-tenant-input'), 'foreign')).toMatchObject({ state: 'REFUSED', reason: { code: 'CROSS_TENANT' } });
    expect(taskOf(run(e, 'cross-tenant-input'), 'own').state).toBe('SUCCEEDED');
  });
});

// ── 4. Privacy ──────────────────────────────────────────────────────────────
describe('privacy: decisions only, about invented clubs and people', () => {
  it('holds no input, output, payload, person id or timestamp in any run', () => {
    const keys = new Set(keysIn(committed().runs));
    for (const k of ['input', 'output', 'payload', 'userId', 'decidedBy', 'requestedBy', 'email', 'name', 'at', 'timestamp', 'createdAt']) {
      expect([k, keys.has(k)]).toEqual([k, false]);
    }
    // What the scenarios' inputs held never reaches the file: opponents, fixtures, players, statuses.
    for (const s of ['Lab Rovers', 'Lab United', 'lab-player', 'medicalStatus', 'INJURED', 'RECOVERING', '4-2-3-1']) expect([s, COMMITTED.includes(s)]).toEqual([s, false]);
  });

  it('names clubs and people by synthetic lab references only', () => {
    const refs = [...COMMITTED.matchAll(/\blab-[a-z0-9-]+/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !LAB_REF.test(r))).toEqual([]);
    for (const r of committed().runs) if (r.scope.kind === 'CLUB') expect(LAB_REF.test(r.scope.clubId)).toBe(true);
  });

  it('negative: an unknown key — an output, a payload — is refused by the contract', () => {
    for (const [where, mutate] of [
      ['task output', (e: Row) => { e.runs[0].tasks[0].output = { opponent: 'Lab Rovers' }; }],
      ['run payload', (e: Row) => { e.runs[0].payload = {}; }],
      ['evidence extra', (e: Row) => { e.inputs = []; }],
    ] as Array<[string, (e: Row) => void]>) {
      const e = committed();
      mutate(e);
      expect([where, reasonsOf(reseal(e))[0]]).toEqual([where, expect.stringMatching(/^shape: .*Unrecognized key/)]);
    }
  });

  it('negative: a real-looking person or tenant is refused, even when the forger re-chains the trace', () => {
    const club = committed();
    (club.runs[0].scope as Row).clubId = 'c-7b0e2f2a-1d3c-4e5f-8a9b-0c1d2e3f4a5b';
    expect(reasonsOf(reseal(club))[0]).toMatch(/^shape: runs\.0\.scope\.clubId/);

    for (const detail of ['approved by coach@example.org', 'approved by 7b0e2f2a-1d3c-4e5f-8a9b-0c1d2e3f4a5b']) {
      const e = committed();
      const r = run(e, 'live-adjustment-approved');
      r.trace[r.trace.length - 2].detail = detail;
      expect([detail, reasonsOf(reseal(e, r))]).toEqual([detail, ['synthetic: it holds what looks like a real person\'s address or a real id']]);
    }
  });

  it('negative: a health field is refused by the contract, and by the read policy\'s own health check behind it', () => {
    const e = committed() as Row;
    e.runs[4].tasks[0].medicalStatus = 'INJURED';
    expect(reasonsOf(reseal(e as OrchestrationEvidence))[0]).toMatch(/^shape: runs\.4\.tasks\.0: Unrecognized key/);
    expect(holdsHealthData(e)).toBe(true);
    expect(holdsHealthData(committed())).toBe(false);
  });

  it('negative: a document from anywhere but the Lab is refused', () => {
    const e = committed() as Row;
    e.environment = 'PRODUCTION';
    expect(reasonsOf(reseal(e as OrchestrationEvidence))[0]).toMatch(/^shape: environment/);
  });
});

// ── 5. The reader ───────────────────────────────────────────────────────────
describe('the reader shows verified evidence, or nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-evidence-'));
  const file = (name: string, body: string | Buffer) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  afterEach(() => resetOrchestrationEvidence());

  it('reads the file that ships with the build as verified', () => {
    const r = readOrchestrationEvidence();
    expect(r.state).toBe('VERIFIED');
    expect(ORCHESTRATION_EVIDENCE_FILE.endsWith(path.join('platform', 'agents', 'generated', 'orchestration-evidence.json'))).toBe(true);
    const v = orchestrationRoomView(platformAgentRegistry(), r);
    expect(v).toMatchObject({ state: 'VERIFIED', reason: null, evidenceDigest: committed().digest, registry: { matches: true } });
    expect(v.runs).toHaveLength(SCENARIOS.length);
    expect(v.agents.length).toBeGreaterThan(2);
    expect(v.agents.every((a) => a.known && a.current)).toBe(true);
  });

  it('negative: missing, oversized, not JSON, or tampered — and not one run is shown', () => {
    const tampered = committed();
    tampered.runs[0].trace[0].detail += '!';
    const cases: Array<[string, string, 'NOT_GENERATED' | 'INVALID', RegExp]> = [
      ['missing', path.join(tmp, 'absent.json'), 'NOT_GENERATED', /not beside this server/],
      ['too large', file('big.json', Buffer.alloc(ORCHESTRATION_EVIDENCE_MAX_BYTES + 1, 32)), 'INVALID', /larger than any real one/],
      ['not json', file('bad.json', '{ "runs": ['), 'INVALID', /not valid JSON/],
      ['tampered', file('tampered.json', JSON.stringify(tampered)), 'INVALID', /^integrity: /],
    ];
    for (const [name, p, state, why] of cases) {
      const r = readOrchestrationEvidence(p);
      expect([name, r.state]).toEqual([name, state]);
      const v = orchestrationRoomView(platformAgentRegistry(), r);
      expect([name, why.test(String(v.reason)), v.runs, v.agents, v.operations, v.evidenceDigest]).toEqual([name, true, [], [], [], null]);
    }
    expect(Object.values(ORCHESTRATION_EVIDENCE_REASONS)).toHaveLength(3);
  });

  it('says when the registry has moved on since the Lab ran, agent by agent', () => {
    const drifted = new AgentRegistry();
    for (const m of PLATFORM_AGENT_MANIFESTS) drifted.register(m.id === 'club.tactical' ? { ...m, purpose: `${m.purpose} Revised.` } : m);
    const v = orchestrationRoomView(drifted, readOrchestrationEvidence());
    expect(v.state).toBe('VERIFIED');
    expect(v.registry.matches).toBe(false);
    expect(v.agents.find((a) => a.id === 'club.tactical')).toEqual({ id: 'club.tactical', known: true, current: false });
    expect(v.agents.filter((a) => a.id !== 'club.tactical').every((a) => a.current)).toBe(true);
  });
});

// ── 6. The endpoint ─────────────────────────────────────────────────────────
describe('GET /system/agents/orchestration', () => {
  const app = () => {
    const a = express();
    a.use('/system/agents', agentsRoomRoutes);
    a.use((err: Row, _req: Row, res: Row, _next: unknown) => res.status(err?.statusCode || 500).json({ success: false, message: err?.message }));
    return a;
  };
  const URL = '/system/agents/orchestration';
  afterEach(() => { actingAs = null; });

  it('answers the platform owner, uncached, exactly as its contract says', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    const res = await request(app()).get(URL);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const contract = OWNER_API_CONTRACTS.find((c) => c.endpoint === URL);
    expect(contract?.consumer).toBe('public/agents-room/agents-room.js');
    expect(contract!.schema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({ state: 'VERIFIED', evidenceDigest: committed().digest });
    expect(res.body.data.runs).toHaveLength(SCENARIOS.length);
    // It is the route for the evidence, not a lookup of an agent called "orchestration".
    expect(res.body.data.agent).toBeUndefined();
  });

  it('negative: the contract refuses what the room must never be sent', () => {
    const schema = OWNER_API_CONTRACTS.find((c) => c.endpoint === URL)!.schema;
    const v = JSON.parse(JSON.stringify(orchestrationRoomView(platformAgentRegistry())));
    expect(schema.safeParse(v).success).toBe(true);
    v.runs[0].tasks[0].output = { any: 'thing' };
    expect(schema.safeParse(v).success).toBe(false);
  });

  it.each(['CLUB_ADMIN', 'MANAGER', 'HEAD_COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT', 'PARENT', 'PLAYER'])(
    'negative: a club %s reaches none of it', async (role) => {
      actingAs = { id: `u-${role}`, clubId: 'c-1', role };
      const res = await request(app()).get(URL);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toMatch(/digest|runs|trace|lab-club/);
    });

  it('negative: an unauthenticated request is refused', async () => {
    expect((await request(app()).get(URL)).status).toBe(401);
  });

  it('negative: there is no way to submit, run or decide anything through it', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app())[verb](URL).send({ contract: 'familista.orchestration/v1' });
      expect([verb, res.status]).toEqual([verb, 404]);
    }
    const src = read('src/routes/agents-room.routes.ts');
    expect(src).not.toMatch(/router\.(post|put|patch|delete)\(/);
    // Declared before /:agentId, so it is never read as an agent id.
    expect(src.indexOf("router.get('/orchestration'")).toBeLessThan(src.indexOf("router.get('/:agentId'"));
  });
});

// ── 7. Isolation ────────────────────────────────────────────────────────────
describe('production reads the evidence and never runs the Lab', () => {
  it('the reader reaches no database, provider, network or lab module, and runs nothing', () => {
    for (const f of ['src/platform/agents/orchestration-evidence.ts', 'src/platform/agents/trace-chain.ts']) {
      const src = read(f);
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect([f, imports.filter((i) => !['fs', 'path', 'zod', 'crypto', './registry', './trace-chain', '../../security/ai-read-policy'].includes(i))]).toEqual([f, []]);
      expect([f, /lab\/|child_process|\bfetch\(|https?\.request\(|\beval\(|new Function|require\(/.test(src.replace(/\/\/.*$/gm, ''))]).toEqual([f, false]);
      expect([f, /writeFile|appendFile|mkdir|unlink|rmSync/.test(src)]).toEqual([f, false]);
    }
  });

  it('the build ships the evidence beside the reader, and the generator is a lab script only', () => {
    const copy = read('scripts/copy-runtime-assets.js');
    expect(copy).toContain('src/platform/agents/generated/orchestration-evidence.json');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['lab:orchestrator:evidence']).toBe('ts-node --transpile-only lab/orchestrator/evidence-cli.ts');
    for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) {
      if (/^(start|build|postinstall|prestart|predeploy)/.test(name)) expect([name, /lab\//.test(cmd)]).toEqual([name, false]);
    }
  });
});
