/**
 * tests/platform-architecture.unit.test.ts
 *
 * The permanent boundaries, held by code rather than by intention.
 *
 * SYSTEM is not CLUBS. An experiment is invisible until somebody targets it. An
 * agent cannot reach the database. An unknown jurisdiction is not permission. A
 * dashboard says "not instrumented" rather than inventing a number. Each of
 * those is a property somebody could undo without noticing, so each is pinned.
 */

import { SYSTEM_MODULES, CLUB_MODULES, systemModule } from '../src/platform/system-modules';
import { currentEnvironment, isProduction, isLab } from '../src/platform/environment';
import { publish, subscribe, resetSubscribers, streamOf } from '../src/platform/events/bus';
import { EVENT_NAMES, assertPublishable, EVENT_STREAM } from '../src/platform/events/contracts';
import {
  AutonomyLevel, TOOLS, authorizeTool, engageKillSwitch, releaseKillSwitch, killSwitchEngaged,
  type AgentIdentity,
} from '../src/platform/intelligence/agents';
import {
  registerModel, registerProvider, resetGateway, route, complete, listModels,
} from '../src/platform/intelligence/gateway';
import { decide, listPacks, resetPacks } from '../src/platform/governance/policy';
import { defineFlag, isEnabled, resetFlags } from '../src/platform/innovation/flags';
import {
  registerExperiment, decideExperiment, listExperiments, resetExperiments,
} from '../src/platform/innovation/experiments';

// ─────────────────────────────────────────────────────────────────────────────
describe('SYSTEM and CLUBS are two products, and never mix', () => {
  it('no module appears in both', () => {
    const system = new Set(SYSTEM_MODULES.map((m) => m.key));
    const overlap = CLUB_MODULES.filter((k) => system.has(k));
    expect(overlap).toEqual([]);
  });

  it('every SYSTEM module declares what actually backs it', () => {
    for (const m of SYSTEM_MODULES) {
      expect(`${m.key}:${!!m.backing}`).toBe(`${m.key}:true`);
      expect(['LIVE', 'PARTIAL', 'NOT_INSTRUMENTED']).toContain(m.readiness);
    }
    // The ones that cannot yet be measured say so, rather than being omitted or
    // quietly claiming to be live.
    expect(systemModule('platform-analytics')!.readiness).toBe('NOT_INSTRUMENTED');
    expect(systemModule('product-analytics')!.readiness).toBe('NOT_INSTRUMENTED');
    expect(systemModule('overview')!.readiness).toBe('LIVE');
  });

  it('and the contract\'s module list is present', () => {
    for (const key of ['overview', 'clubs', 'people', 'security', 'audit', 'intelligence',
                       'agents', 'governance', 'lab', 'experiments', 'flags', 'releases', 'settings']) {
      expect(`${key}:${!!systemModule(key)}`).toBe(`${key}:true`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the environment is a fact about the process, not a header', () => {
  it('defaults away from LAB and away from PRODUCTION when unlabelled', () => {
    expect(currentEnvironment({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('PRODUCTION');
    expect(currentEnvironment({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe('PREVIEW');
    expect(currentEnvironment({ FAMILISTA_ENV: 'LAB' } as NodeJS.ProcessEnv)).toBe('LAB');
    // Nonsense is not the Lab either.
    expect(currentEnvironment({ FAMILISTA_ENV: 'whatever' } as NodeJS.ProcessEnv)).toBe('PREVIEW');
    expect(isProduction({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isLab({ FAMILISTA_ENV: 'LAB' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('events: two streams, and nothing secret in either', () => {
  beforeEach(resetSubscribers);

  it('audit and analytics are declared per event, never merged', () => {
    expect(streamOf('MembershipRevoked')).toBe('AUDIT');
    expect(streamOf('FeatureUsed')).toBe('ANALYTICS');
    expect(streamOf('MatchFinished')).toBe('BOTH');
    // Every declared name has a stream: a new event cannot be added without
    // deciding which question it answers.
    for (const name of EVENT_NAMES) expect(`${name}:${!!EVENT_STREAM[name]}`).toBe(`${name}:true`);
  });

  it('refuses to publish a payload carrying a credential', () => {
    for (const key of ['password', 'passwordHash', 'refreshToken', 'apiKey', 'userToken']) {
      expect(() => assertPublishable({ [key]: 'x' })).toThrow(/must not carry/);
    }
    expect(() => assertPublishable({ playerId: 'p1', minutes: 90 })).not.toThrow();
  });

  it('delivers to subscribers and never fails the caller when one throws', () => {
    const seen: string[] = [];
    subscribe('MatchFinished', (e) => { seen.push(e.name); });
    subscribe('*', () => { throw new Error('sink is down'); });
    const event = publish({ name: 'MatchFinished', payload: { matchId: 'm1' }, scope: { clubId: 'c1' } });
    expect(seen).toEqual(['MatchFinished']);
    expect(event.version).toBe(1);
    expect(event.environment).toBeTruthy();
    expect(event.occurredAt).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an agent is an identity with tools, not a privileged user', () => {
  const agent = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
    agentId: 'a-1', type: 'ANALYST', name: 'Opponent analyst', status: 'ACTIVE',
    environment: currentEnvironment(), scope: {}, tools: ['getClub', 'getPlayers', 'analyzeOpponent'],
    autonomy: AutonomyLevel.RECOMMEND, ownerUserId: 'u-owner', ...over,
  });

  afterEach(releaseKillSwitch);

  it('holds only the tools it was given', () => {
    expect(authorizeTool(agent(), 'getPlayers').allowed).toBe(true);
    expect(authorizeTool(agent(), 'sendNotification')).toMatchObject({ allowed: false });
    expect(authorizeTool(agent(), 'nonexistent').reason).toMatch(/No tool is registered/);
  });

  it('can never call a protected tool, at any autonomy', () => {
    for (const key of ['deleteClub', 'changeClubOwner', 'deleteUser', 'changeGlobalPermissions']) {
      const decision = authorizeTool(agent({ tools: [key], autonomy: AutonomyLevel.PROTECTED }), key);
      expect(`${key}:${decision.allowed}`).toBe(`${key}:false`);
      expect(decision.reason).toMatch(/protected/i);
    }
  });

  it('autonomy gates what it may do', () => {
    const drafting = agent({ tools: ['createTrainingDraft'], autonomy: AutonomyLevel.RECOMMEND });
    expect(authorizeTool(drafting, 'createTrainingDraft').allowed).toBe(false);
    expect(authorizeTool(agent({ tools: ['createTrainingDraft'], autonomy: AutonomyLevel.PREPARE }), 'createTrainingDraft').allowed).toBe(true);
    // Level 4 prepares and waits for a person.
    const approving = agent({ tools: ['sendNotification'], autonomy: AutonomyLevel.APPROVE });
    expect(authorizeTool(approving, 'sendNotification')).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it('a LAB agent cannot act in production, and the reverse', () => {
    const lab = agent({ environment: 'LAB', tools: ['getPlayers'] });
    expect(authorizeTool(lab, 'getPlayers', 'PRODUCTION').allowed).toBe(false);
    expect(authorizeTool(lab, 'getPlayers', 'LAB').allowed).toBe(true);
  });

  it('the kill switch stops actions and leaves reading alone', () => {
    const actor = agent({ tools: ['getPlayers', 'sendNotification'], autonomy: AutonomyLevel.ACT });
    expect(authorizeTool(actor, 'sendNotification').allowed).toBe(true);
    engageKillSwitch('incident 42');
    expect(killSwitchEngaged()).toBe(true);
    expect(authorizeTool(actor, 'sendNotification')).toMatchObject({ allowed: false });
    expect(authorizeTool(actor, 'sendNotification').reason).toMatch(/incident 42/);
    // Reading continues: the switch stops autonomous action, not the platform.
    expect(authorizeTool(actor, 'getPlayers').allowed).toBe(true);
    releaseKillSwitch();
    expect(authorizeTool(actor, 'sendNotification').allowed).toBe(true);
  });

  it('a paused agent does nothing at all', () => {
    expect(authorizeTool(agent({ status: 'PAUSED' }), 'getClub').allowed).toBe(false);
  });

  it('and every tool declares its effect and its ceiling', () => {
    for (const t of TOOLS) {
      expect(['READ', 'DRAFT', 'WRITE', 'PROTECTED']).toContain(t.effect);
      expect(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']).toContain(t.classification);
      // A read can never require approval, which is what minAutonomy encodes.
      if (t.effect === 'READ') expect(t.minAutonomy).toBeLessThanOrEqual(AutonomyLevel.RECOMMEND);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the AI gateway is the only door to a provider', () => {
  beforeEach(() => {
    resetGateway();
    registerProvider({ id: 'anthropic', available: () => true, complete: async () => ({ text: 'ok' }) });
    registerProvider({ id: 'openai', available: () => false, complete: async () => ({ text: 'never' }) });
    registerModel({ id: 'tactics-v1', provider: 'anthropic', providerModel: 'x', purposes: ['tactics'] });
    registerModel({ id: 'eu-forbidden', provider: 'anthropic', providerModel: 'y', purposes: ['scouting'], restrictedIn: ['DE'] });
    registerModel({ id: 'unavailable', provider: 'openai', providerModel: 'z', purposes: ['medical'] });
  });

  it('routes by purpose and refuses rather than guessing', async () => {
    expect(route({ caller: 'e', purpose: 'tactics', prompt: '' }).model?.id).toBe('tactics-v1');
    expect(route({ caller: 'e', purpose: 'nothing-serves-this', prompt: '' }).model).toBeNull();
    // A provider that is not configured is not a fallback.
    expect(route({ caller: 'e', purpose: 'medical', prompt: '' }).model).toBeNull();
  });

  it('honours a jurisdiction restriction rather than silently substituting', () => {
    const denied = route({ caller: 'e', purpose: 'scouting', prompt: '', model: 'eu-forbidden', jurisdiction: 'DE' });
    expect(denied.model).toBeNull();
    expect(denied.why).toMatch(/may not be used in DE/);
    expect(route({ caller: 'e', purpose: 'scouting', prompt: '', model: 'eu-forbidden', jurisdiction: 'GB' }).model?.id).toBe('eu-forbidden');
  });

  it('an unconfigured platform is a refusal, not an error', async () => {
    resetGateway();
    const out = await complete({ caller: 'ai-coach', purpose: 'tactics', prompt: 'hello' });
    expect(out.ok).toBe(false);
    expect(out.refusedBecause).toMatch(/No configured model/);
    expect(listModels()).toEqual([]);
  });

  it('and a successful call records which model answered', async () => {
    const out = await complete({ caller: 'ai-coach', purpose: 'tactics', prompt: 'hello' });
    expect(out).toMatchObject({ ok: true, text: 'ok', model: 'tactics-v1', provider: 'anthropic' });
    expect(out.environment).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('governance: silence is not permission', () => {
  beforeEach(resetPacks);

  it('an unknown jurisdiction is NOT_VALIDATED, never ALLOW', () => {
    const unknown = decide({ actorLevel: 'CLUB_OWNER', jurisdiction: 'ZZ', resource: 'squad.roster', action: 'READ' });
    expect(unknown.outcome).toBe('NOT_VALIDATED');
    expect(unknown.reason).toMatch(/not validated for commercial launch/i);
    const missing = decide({ actorLevel: 'CLUB_OWNER', resource: 'squad.roster', action: 'READ' });
    expect(missing.outcome).toBe('NOT_VALIDATED');
  });

  it('a minor\'s data needs recorded consent where the pack says so', () => {
    const denied = decide({ actorLevel: 'CLUB_STAFF', jurisdiction: 'DE', resource: 'player.minor-detail', action: 'READ', subjectIsMinor: true });
    expect(denied.outcome).toBe('DENY');
    expect(denied.reason).toMatch(/guardian consent/i);
    const allowed = decide({ actorLevel: 'CLUB_STAFF', jurisdiction: 'DE', resource: 'squad.roster', action: 'READ', subjectIsMinor: true, consentGiven: true });
    expect(allowed.outcome).toBe('ALLOW');
  });

  it('restricted data cannot be exported out of a pack that forbids it', () => {
    expect(decide({ actorLevel: 'CLUB_OWNER', jurisdiction: 'DE', resource: 'medical.record', action: 'EXPORT' }).outcome).toBe('DENY');
  });

  it('a viewer reaches public data and nothing else, in every jurisdiction', () => {
    expect(decide({ actorLevel: 'VIEWER', jurisdiction: 'GB', resource: 'competition.standings', action: 'READ' }).outcome).toBe('ALLOW');
    expect(decide({ actorLevel: 'VIEWER', jurisdiction: 'GB', resource: 'training.session', action: 'READ' }).outcome).toBe('DENY');
  });

  it('an AI decision about a person takes human oversight where required', () => {
    const eu = decide({ actorLevel: 'AI_AGENT', jurisdiction: 'FR', resource: 'analytics.team', action: 'WRITE', aiInvolved: true });
    expect(eu.outcome).toBe('REQUIRE_APPROVAL');
    expect(eu.policyPack).toBe('EU-GDPR');
    expect(listPacks().map((p) => p.id).sort()).toEqual(['EU-GDPR', 'UK', 'US']);
  });

  it('and every decision names the pack and version that made it', () => {
    const d = decide({ actorLevel: 'CLUB_OWNER', jurisdiction: 'GB', resource: 'squad.roster', action: 'READ' });
    expect(d.policyPack).toBe('UK');
    expect(d.policyVersion).toBeTruthy();
    expect(d.classification).toBe('INTERNAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('experiments are invisible until somebody targets them', () => {
  beforeEach(() => { resetFlags(); resetExperiments(); });

  it('an unknown or undefined flag is off', () => {
    expect(isEnabled('never-defined', { isPlatformOwner: true })).toBe(false);
  });

  it('owner-only means the owner and nobody else', () => {
    defineFlag({ key: 'new_ai_coach', environments: ['PRODUCTION', 'LAB'], audience: 'OWNER_ONLY', enabled: true });
    expect(isEnabled('new_ai_coach', { isPlatformOwner: true }, 'PRODUCTION')).toBe(true);
    for (const actor of [{ userId: 'president' }, { userId: 'coach', clubId: 'c1' }, {}]) {
      expect(isEnabled('new_ai_coach', actor, 'PRODUCTION')).toBe(false);
    }
  });

  it('a Lab feature does not exist in production', () => {
    defineFlag({ key: 'experimental_super_ai', environments: ['LAB'], audience: 'PUBLIC', enabled: true });
    expect(isEnabled('experimental_super_ai', { userId: 'anyone' }, 'LAB')).toBe(true);
    expect(isEnabled('experimental_super_ai', { userId: 'anyone' }, 'PRODUCTION')).toBe(false);
    expect(isEnabled('experimental_super_ai', { isPlatformOwner: true }, 'PRODUCTION')).toBe(false);
  });

  it('club and user targeting reach exactly who was named', () => {
    defineFlag({ key: 'new_match_center', environments: ['PRODUCTION'], audience: 'SELECTED_CLUBS', clubIds: ['club-pilot'], enabled: true });
    expect(isEnabled('new_match_center', { clubId: 'club-pilot' }, 'PRODUCTION')).toBe(true);
    expect(isEnabled('new_match_center', { clubId: 'club-other' }, 'PRODUCTION')).toBe(false);
    defineFlag({ key: 'beta', environments: ['PRODUCTION'], audience: 'SELECTED_USERS', userIds: ['u-1'], enabled: true });
    expect(isEnabled('beta', { userId: 'u-1' }, 'PRODUCTION')).toBe(true);
    expect(isEnabled('beta', { userId: 'u-2' }, 'PRODUCTION')).toBe(false);
  });

  it('a percentage rollout is stable per person and switchable off instantly', () => {
    defineFlag({ key: 'canary', environments: ['PRODUCTION'], audience: 'PERCENTAGE_ROLLOUT', percentage: 50, enabled: true });
    const first = isEnabled('canary', { userId: 'u-stable' }, 'PRODUCTION');
    for (let i = 0; i < 20; i++) expect(isEnabled('canary', { userId: 'u-stable' }, 'PRODUCTION')).toBe(first);
    // 0% reaches nobody but the owner; disabling reaches nobody at all.
    defineFlag({ key: 'canary', environments: ['PRODUCTION'], audience: 'PERCENTAGE_ROLLOUT', percentage: 0, enabled: true });
    expect(isEnabled('canary', { userId: 'u-stable' }, 'PRODUCTION')).toBe(false);
    defineFlag({ key: 'canary', environments: ['PRODUCTION'], audience: 'PUBLIC', enabled: false });
    expect(isEnabled('canary', { isPlatformOwner: true }, 'PRODUCTION')).toBe(false);
  });

  it('a rejected experiment keeps its history', () => {
    registerExperiment({
      id: 'exp-1', title: 'AI lineup suggestions', hypothesis: 'Coaches accept 30% of suggestions',
      successMetrics: ['acceptance rate'], ownerUserId: 'u-owner', flagKey: 'new_ai_coach',
      environment: 'LAB', modelVersions: ['tactics-v1'],
    });
    decideExperiment('exp-1', 'RUNNING');
    const rejected = decideExperiment('exp-1', 'REJECTED', 'acceptance was 4%');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.decision).toBe('acceptance was 4%');
    expect(rejected.endedAt).toBeTruthy();
    // Still there, still readable, after the feature is gone.
    expect(listExperiments({ status: 'REJECTED' }).map((e) => e.id)).toEqual(['exp-1']);
    // And it cannot be quietly resurrected into a running state.
    expect(() => decideExperiment('exp-1', 'RUNNING')).toThrow(/cannot go from REJECTED/);
    expect(decideExperiment('exp-1', 'ARCHIVED').status).toBe('ARCHIVED');
  });

  it('and a Lab experiment stays a Lab experiment', () => {
    registerExperiment({ id: 'exp-2', title: 'x', hypothesis: 'y', successMetrics: [], ownerUserId: 'u', environment: 'LAB' });
    expect(listExperiments({ environment: 'PRODUCTION' })).toEqual([]);
    expect(listExperiments({ environment: 'LAB' }).map((e) => e.id)).toEqual(['exp-2']);
  });
});
