/**
 * Global Multi-Agent Foundation, AI-0.1 — the Agent Manifest, the Agent
 * Registry and the AI Agents Operations Room.
 *
 * 1. The catalog: the ten agents the platform runs are described exactly as
 *    the platform already enforces them — egress profile, tools, data class,
 *    the record kinds the read policy declares — and each answers to someone
 *    who can read everything it writes.
 * 2. Every validation rule refuses what it exists to refuse, one at a time,
 *    from a valid synthetic manifest.
 * 3. The registry holds agents for every part of the platform (synthetic LAB
 *    manifests only), refuses duplicates, freezes what it holds and hashes it
 *    the same way in any order.
 * 4. The Operations Room is the platform owner's alone, outside every Club
 *    Workspace, and shows no club, person or record.
 * 5. Nothing is activated: no runtime path reads the registry, and the
 *    registry reaches no database, provider or network.
 * 6. The runtime's behaviour for the ten running agents, against the baseline
 *    recorded on main 86c1ca2 (tests/fixtures/agents/runtime-baseline.json):
 *    profiles, identities, the action map, and 500 decisions.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
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

import { AutonomyLevel } from '../src/platform/intelligence/agents';
import { AGENT_PROFILES } from '../src/platform/intelligence/agent-jobs';
import { highest } from '../src/platform/intelligence/data-classes';
import { AI_READ_MATRIX, DECLARED_KINDS } from '../src/security/ai-read-policy';
import { AGENT_DOMAINS, AgentManifestError, validateManifest, outputClasses, type AgentManifest, type ManifestIssueCode } from '../src/platform/agents/manifest';
import { AgentRegistry } from '../src/platform/agents/registry';
import { PLATFORM_AGENT_MANIFESTS, platformAgentRegistry } from '../src/platform/agents/catalog';
import { invariants, operationsRoomAgent, operationsRoomOverview } from '../src/platform/agents/operations-room.service';
import agentsRoomRoutes from '../src/routes/agents-room.routes';
import { SYNTHETIC_LAB_MANIFESTS, validSynthetic } from './fixtures/agents/synthetic-manifests';
import { runtimeSnapshot, RUNNING_AGENTS, JOB_CASES } from './helpers/agent-runtime-baseline';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codes = (m: AgentManifest) => validateManifest(m).map((i) => i.code);
const sorted = (xs: readonly string[]) => [...xs].sort();

// ── 1. The catalog ──────────────────────────────────────────────────────────
describe('the catalog of the agents the platform runs', () => {
  const registry = platformAgentRegistry();

  it('registers every manifest, and describes every running agent exactly once', () => {
    expect(registry.size).toBe(PLATFORM_AGENT_MANIFESTS.length);
    for (const agent of Object.keys(AGENT_PROFILES)) {
      expect([agent, PLATFORM_AGENT_MANIFESTS.filter((m) => m.binding?.legacyAgent === agent).length]).toEqual([agent, 1]);
    }
    for (const m of PLATFORM_AGENT_MANIFESTS) expect([m.id, codes(m)]).toEqual([m.id, []]);
  });

  it('gives each agent its egress profile: the same tools and the same data class', () => {
    for (const m of PLATFORM_AGENT_MANIFESTS) {
      const p = (AGENT_PROFILES as Row)[m.binding!.legacyAgent];
      expect([m.id, sorted(m.tools)]).toEqual([m.id, sorted(p.tools)]);
      expect([m.id, highest(m.data.reads)]).toEqual([m.id, p.dataClass]);
    }
  });

  it('gives each agent exactly the record kinds the read policy declares for it', () => {
    for (const m of PLATFORM_AGENT_MANIFESTS) {
      const declared = Object.entries(DECLARED_KINDS).flatMap(([type, list]) => list.filter((d) => d.agent === m.binding!.legacyAgent).map((d) => `${type}:${d.kind}`));
      expect([m.id, sorted(m.outputs.map((o) => `${o.type}:${o.kind}`))]).toEqual([m.id, sorted(declared)]);
    }
  });

  it('makes each agent answer to a role that can read everything it writes; the medical agent to medical staff', () => {
    for (const m of PLATFORM_AGENT_MANIFESTS) {
      for (const o of m.outputs) for (const c of outputClasses(m, o)) {
        expect([m.id, o.kind, c, (AI_READ_MATRIX as Row)[m.supervisor][c]]).toEqual([m.id, o.kind, c, 'FULL']);
      }
    }
    expect(registry.forLegacyAgent('MEDICAL')).toMatchObject({ supervisor: 'MEDICAL_STAFF', domain: 'MEDICAL' });
    expect(PLATFORM_AGENT_MANIFESTS.filter((m) => m.data.reads.includes('RESTRICTED')).map((m) => m.id)).toEqual(['club.medical']);
  });

  it('holds every invariant against what the platform enforces', () => {
    expect(invariants(registry).filter((i) => !i.holds)).toEqual([]);
    expect(invariants(registry).map((i) => i.id)).toEqual([
      'manifests-valid', 'runtime-agents-described', 'profiles-agree', 'outputs-agree', 'no-protected-tools',
      'ceiling-approve', 'platform-agents-no-personal-data', 'nothing-activated',
    ]);
  });

  it('(control) an invariant fails when the registry drifts from the egress profile', () => {
    const drifted = new AgentRegistry();
    for (const m of PLATFORM_AGENT_MANIFESTS) {
      drifted.register(m.binding?.legacyAgent === 'TACTICAL' ? { ...m, tools: m.tools.filter((t) => t !== 'changeTacticsLive') } : m);
    }
    expect(invariants(drifted).find((i) => i.id === 'profiles-agree')).toMatchObject({ holds: false, detail: expect.stringContaining('club.tactical') });
  });
});

// ── 2. Every rule, one at a time ────────────────────────────────────────────
describe('manifest validation', () => {
  it('(control) the synthetic starting point is valid', () => {
    expect(codes(validSynthetic())).toEqual([]);
  });

  const cases: Array<[ManifestIssueCode, (m: Row) => void]> = [
    ['ID_FORMAT',                    (m) => { m.id = 'Club.Upper'; }],
    ['ID_SCOPE_PREFIX',              (m) => { m.id = 'platform.synthetic-commerce'; }],
    ['VERSION_FORMAT',               (m) => { m.version = '1.0'; }],
    ['TEXT_REQUIRED',                (m) => { m.purpose = '   '; }],
    ['DOMAIN_UNKNOWN',               (m) => { m.domain = 'GAMBLING'; }],
    ['LIFECYCLE_UNKNOWN',            (m) => { m.lifecycle = 'ACTIVE'; }],
    ['LIFECYCLE_RUNNING_UNBOUND',    (m) => { m.lifecycle = 'RUNNING'; }],
    ['AUTONOMY_CEILING',             (m) => { m.autonomyCeiling = AutonomyLevel.PROTECTED; }],
    ['TOOL_UNKNOWN',                 (m) => { m.tools.push('launchRocket'); }],
    ['TOOL_PROTECTED',               (m) => { m.tools.push('deleteClub'); }],
    ['TOOL_ABOVE_CEILING',           (m) => { m.tools.push('sendNotification'); }],
    ['TOOL_DUPLICATE',               (m) => { m.tools.push('getClub'); }],
    ['DATA_CLASS_UNKNOWN',           (m) => { m.data.reads.push('SECRET'); }],
    ['DATA_DOES_NOT_COVER_TOOLS',    (m) => { m.data.reads = ['PUBLIC']; m.tools.push('getPlayers'); }],
    ['DATA_RESTRICTED_OUTSIDE_MEDICAL', (m) => { m.data.reads.push('RESTRICTED'); }],
    ['OUTPUT_UNBOUND',               (m) => { m.outputs.push({ type: 'alert', kind: 'FINANCE_ANOMALY' }); }],
    ['SUPERVISOR_SCOPE',             (m) => { m.supervisor = 'PARENT'; }],
    ['SUPERVISOR_MEDICAL',           (m) => { m.domain = 'MEDICAL'; }],
  ];
  it.each(cases)('refuses %s', (code, breakIt) => {
    const m = validSynthetic() as Row;
    breakIt(m);
    expect(codes(m as AgentManifest)).toContain(code);
  });

  it('refuses a platform agent with personal data, or one that answers to anyone but the Platform Owner', () => {
    const p = JSON.parse(JSON.stringify(SYNTHETIC_LAB_MANIFESTS.find((m) => m.scope === 'PLATFORM'))) as AgentManifest;
    expect(codes({ ...p, data: { reads: ['CONFIDENTIAL'], writes: [] } })).toContain('DATA_PLATFORM_PERSONAL');
    expect(codes({ ...p, supervisor: 'CLUB_ADMIN' })).toContain('SUPERVISOR_SCOPE');
  });

  it('refuses outputs the read policy has not classified, medical outputs without RESTRICTED, and a supervisor who cannot read them', () => {
    const medical = PLATFORM_AGENT_MANIFESTS.find((m) => m.id === 'club.medical')!;
    expect(codes({ ...medical, outputs: [...medical.outputs, { type: 'alert', kind: 'MADE_UP' }] })).toContain('OUTPUT_UNDECLARED');
    expect(codes({ ...medical, data: { ...medical.data, writes: ['INTERNAL'] } })).toContain('OUTPUT_MEDICAL_UNCLEARED');
    const finance = PLATFORM_AGENT_MANIFESTS.find((m) => m.id === 'club.finance')!;
    expect(codes({ ...finance, supervisor: 'HEAD_COACH' })).toContain('SUPERVISOR_CANNOT_READ');
  });

  it('refuses a binding to an agent the platform does not run, and a running agent outside a club', () => {
    const tactical = PLATFORM_AGENT_MANIFESTS.find((m) => m.id === 'club.tactical')!;
    expect(codes({ ...tactical, binding: { legacyAgent: 'SKYNET' as never } })).toContain('BINDING_UNKNOWN');
    expect(codes({ ...tactical, scope: 'PLATFORM', id: 'platform.tactical', supervisor: 'PLATFORM_OWNER' })).toContain('BINDING_SCOPE');
  });
});

// ── 3. The registry ─────────────────────────────────────────────────────────
describe('the registry', () => {
  it('holds agents for every part of the platform, beside the ones that run (synthetic LAB manifests)', () => {
    const r = new AgentRegistry();
    for (const m of [...PLATFORM_AGENT_MANIFESTS, ...SYNTHETIC_LAB_MANIFESTS]) r.register(m);
    expect(r.size).toBe(PLATFORM_AGENT_MANIFESTS.length + SYNTHETIC_LAB_MANIFESTS.length);
    expect(r.byScope('PLATFORM').map((a) => a.id)).toEqual(['platform.synthetic-registry-auditor']);
    for (const d of ['EDUCATION', 'COMMERCE', 'VISION', 'MEDIA', 'PLATFORM_OPERATIONS'] as const) expect([d, r.byDomain(d).length]).toEqual([d, 1]);
    expect(invariants(r).filter((i) => !i.holds)).toEqual([]);
    expect(r.digest()).not.toBe(platformAgentRegistry().digest());
  });

  it('refuses an invalid manifest with every reason, a duplicate id and a second manifest for one running agent', () => {
    const r = new AgentRegistry();
    const bad = { ...validSynthetic(), version: 'x', tools: ['deleteClub'] };
    expect(() => r.register(bad)).toThrow(AgentManifestError);
    try { r.register(bad); } catch (e) { expect((e as AgentManifestError).issues.map((i) => i.code).sort()).toEqual(['TOOL_PROTECTED', 'VERSION_FORMAT']); }
    r.register(validSynthetic());
    expect(() => r.register(validSynthetic())).toThrow(/ID_DUPLICATE/);
    r.register(PLATFORM_AGENT_MANIFESTS[0]);
    expect(() => r.register({ ...PLATFORM_AGENT_MANIFESTS[0], id: 'club.club-manager-two' })).toThrow(/BINDING_DUPLICATE/);
    expect(r.size).toBe(2);
  });

  it('keeps what was reviewed: entries are frozen copies, unaffected by the caller changing its object', () => {
    const r = new AgentRegistry();
    const m = validSynthetic();
    const entry = r.register(m);
    const before = r.digest();
    m.tools.push('getPlayers');
    m.title = 'changed';
    expect(r.get(m.id)!.tools).not.toContain('getPlayers');
    expect(r.digest()).toBe(before);
    expect(Object.isFrozen(entry) && Object.isFrozen(entry.tools) && Object.isFrozen(entry.data.reads)).toBe(true);
    expect(() => { (entry.tools as string[]).push('x'); }).toThrow();
  });

  it('hashes the same manifests to the same digest in any order, and to a different one when any changes', () => {
    const all = [...PLATFORM_AGENT_MANIFESTS, ...SYNTHETIC_LAB_MANIFESTS];
    const a = new AgentRegistry(); all.forEach((m) => a.register(m));
    const b = new AgentRegistry(); [...all].reverse().forEach((m) => b.register(m));
    expect(a.digest()).toBe(b.digest());
    expect(a.digest()).toMatch(/^[0-9a-f]{64}$/);
    const c = new AgentRegistry(); all.forEach((m) => c.register(m.id === 'club.synthetic-vision-analyst' ? { ...m, version: '0.1.1' } : m));
    expect(c.digest()).not.toBe(a.digest());
  });

  it('knows every platform domain', () => {
    expect(AGENT_DOMAINS).toEqual(expect.arrayContaining(['MEDICAL', 'EDUCATION', 'COMMERCE', 'MEDIA', 'VISION', 'PLATFORM_OPERATIONS']));
  });
});

// ── 4. The Operations Room ──────────────────────────────────────────────────
describe('the AI Agents Operations Room', () => {
  const app = () => {
    const a = express();
    a.use('/system/agents', agentsRoomRoutes);
    a.use((err: Row, _req: Row, res: Row, _next: unknown) => res.status(err?.statusCode || 500).json({ success: false, message: err?.message }));
    return a;
  };
  afterEach(() => { actingAs = null; });

  it('is the platform owner\'s: the owner and a SUPER_ADMIN read it, uncached', async () => {
    for (const who of [{ id: OWNER, clubId: null, role: 'CLUB_ADMIN' }, { id: 'u-super', clubId: null, role: 'SUPER_ADMIN' }]) {
      actingAs = who;
      const res = await request(app()).get('/system/agents');
      expect([who.role, res.status]).toEqual([who.role, 200]);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data.registry.agents).toBe(PLATFORM_AGENT_MANIFESTS.length);
      expect(res.body.data.activation).toEqual({ newAgentsActive: 0, labRuntime: 'NOT_PRESENT' });
      expect(res.body.data.invariants.every((i: Row) => i.holds)).toBe(true);
    }
  });

  it.each(['CLUB_ADMIN', 'MANAGER', 'HEAD_COACH', 'ASSISTANT_COACH', 'COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT', 'PARENT', 'PLAYER'])(
    'negative: a club %s reaches none of it, however senior inside its club', async (role) => {
      actingAs = { id: `u-${role}`, clubId: 'c-1', role };
      for (const url of ['/system/agents', '/system/agents/club.medical']) {
        const res = await request(app()).get(url);
        expect([url, res.status]).toEqual([url, 403]);
        expect(JSON.stringify(res.body)).not.toMatch(/club\.medical|digest|supervisor/);
      }
    });

  it('negative: an unauthenticated request is refused', async () => {
    expect((await request(app()).get('/system/agents')).status).toBe(401);
  });

  it('shows one agent in full, with who may read what it writes; an unknown id is not found', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    const res = await request(app()).get('/system/agents/club.medical');
    expect(res.status).toBe(200);
    expect(res.body.data.agent).toMatchObject({ id: 'club.medical', supervisor: 'MEDICAL_STAFF', lifecycle: 'RUNNING' });
    expect(res.body.data.outputs.find((o: Row) => o.kind === 'INJURY_RISK').readableBy).toEqual(['MEDICAL_STAFF']);
    expect(res.body.data.issues).toEqual([]);
    expect((await request(app()).get('/system/agents/club.nobody')).status).toBe(404);
  });

  it('shows no club, person or record: manifests and computed checks only', () => {
    const body = JSON.stringify(operationsRoomOverview()) + JSON.stringify(operationsRoomAgent('club.tactical'));
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(body).not.toMatch(/clubId|userId|playerId|email/);
  });

  it('is mounted in SYSTEM only, behind the owner guard, and nowhere in a club\'s routes', () => {
    const index = read('src/routes/index.ts');
    expect(index).toContain("router.use('/system/agents', agentsRoomRoutes);");
    expect(index.match(/agentsRoomRoutes/g)).toHaveLength(2);
    expect(read('src/routes/agents-room.routes.ts')).toContain('await assertPlatformOwner(');
    expect(read('src/routes/agents-room.routes.ts')).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });
});

// ── 5. Nothing is activated ─────────────────────────────────────────────────
describe('isolation', () => {
  const MODULE = 'src/platform/agents';
  const files = fs.readdirSync(path.join(ROOT, MODULE)).filter((f) => f.endsWith('.ts')).map((f) => `${MODULE}/${f}`);

  it('the registry reaches no database, provider, worker or network', () => {
    for (const f of files) {
      const src = read(f);
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect([f, imports.filter((i) => /config\/database|lib\/prisma|gateway|provider|anthropic|workers\/|axios|^https?$|^net$|child_process/.test(i))]).toEqual([f, []]);
      expect([f, /new PrismaClient|\bfetch\(|https?\.request\(/.test(src)]).toEqual([f, false]);
    }
  });

  it('nothing that runs an agent reads the registry: only the Operations Room does', () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.startsWith(MODULE) && /platform\/agents\//.test(read(p))) users.push(p);
      }
    };
    walk('src');
    expect(users).toEqual(['src/routes/agents-room.routes.ts']);
  });
});

// ── 6. The runtime's behaviour, against the recorded baseline ──────────────
// tests/fixtures/agents/runtime-baseline.json was recorded on main 86c1ca2,
// from the hand-written egress profiles, before any runtime change: each
// agent's profile and identity, and authorizeAgentJob's decision for 25 shapes
// of job (analysis, every action by kind and by flag, a job with no club) with
// the kill switch released and engaged — 500 decisions. However the profiles
// are produced, every one of those answers must stay the same.
describe('the running agents, against the recorded baseline', () => {
  const BASELINE = JSON.parse(read('tests/fixtures/agents/runtime-baseline.json'));
  const now = runtimeSnapshot();

  it('covers ten agents, 25 shapes of job and both states of the kill switch: 500 decisions', () => {
    expect(BASELINE.runtimeAgents).toEqual(RUNNING_AGENTS);
    for (const state of ['killSwitchReleased', 'killSwitchEngaged']) {
      for (const agent of RUNNING_AGENTS) expect(Object.keys(BASELINE.decisions[state][agent])).toEqual(JOB_CASES.map((c) => c.label));
    }
  });

  it('lists the same running agents, in the same order', () => {
    expect(now.runtimeAgents).toEqual(BASELINE.runtimeAgents);
  });

  it('gives every agent the same tools, in the same order, and the same data class', () => {
    expect(now.profiles).toEqual(BASELINE.profiles);
    for (const agent of RUNNING_AGENTS) expect([agent, Object.keys(now.profiles[agent])]).toEqual([agent, ['tools', 'dataClass']]);
  });

  it('maps every action to the same tool', () => {
    expect(now.actionTools).toEqual(BASELINE.actionTools);
  });

  it('runs every job as the same identity', () => {
    expect(now.identities).toEqual(BASELINE.identities);
  });

  it('reaches the same decision, with the same reason, for every job, with the kill switch released and engaged', () => {
    for (const state of ['killSwitchReleased', 'killSwitchEngaged'] as const) {
      for (const agent of RUNNING_AGENTS) {
        for (const c of JOB_CASES) {
          expect([state, agent, c.label, now.decisions[state][agent][c.label]]).toEqual([state, agent, c.label, BASELINE.decisions[state][agent][c.label]]);
        }
      }
    }
  });
});
