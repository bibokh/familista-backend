// What an agent JOB may do, decided before it runs (Cyber Defense, R8)
// ─────────────────────────────────────────────────────────────────────────────
// The agent worker (workers/ai-agent.worker.ts) runs AIAgentJob rows. A job's
// kind is free text — "MEDICAL.FATIGUE_SCAN", "MASS_MESSAGE_PARENTS" — so what a
// job IS comes from the approval gate's classifier (`classifyRisk`): a job that
// would act in the world maps to one of the action tools; anything else is
// analysis and maps to `createReport`, which commits nothing.
//
// Every job is then put to the tool registry (agents.ts) as the agent it runs
// as, with that agent's profile (from its manifest, below):
//
//   · an action outside the agent's profile is refused — a COMMS agent cannot
//     ask for a payment, a FINANCE agent cannot message parents — whatever
//     approval exists;
//   · deleting data is PROTECTED and refused for every agent;
//   · every action is WRITE at APPROVE autonomy, so it needs a person's
//     approval first (ai-approval.service), and the kill switch stops it;
//   · the profile's data class is what the job's prompt is declared as when it
//     reaches the AI Gateway.
//
// ── Where a profile comes from: the Agent Registry
//
// A profile is not written here. It is derived from the agent's manifest in
// the validated Agent Registry (platform/agents/catalog.ts): the manifest's
// tools, in its order, and the highest data class it reads. That is the one
// place an agent's permissions are written and reviewed, so what the room
// shows the Platform Owner is what the runtime enforces.
//
//   · only a RUNNING manifest bound to the runtime agent gives it a profile;
//     a job for an agent with no manifest, or a DRAFT, LAB or RETIRED one, is
//     refused before anything else is asked;
//   · if the registry does not validate, no agent has a profile and every job
//     is refused; the server keeps serving, and the reason is logged once and
//     written on every refused job.
//
// The registry is imported, never the other way round: nothing the catalog or
// the registry imports leads back to this file, so there is no import cycle
// (tests/agent-runtime-registry.unit.test.ts).

import { AIAgent } from '@prisma/client';
import type { AIApprovalKind, Prisma } from '@prisma/client';
import { classifyRisk } from '../../security/ai-approval.service';
import { AutonomyLevel, authorizeTool, type AgentIdentity, type ToolDecision } from './agents';
import { currentEnvironment } from '../environment';
import { highest, type DataClass } from './data-classes';
import { platformAgentRegistry } from '../agents/catalog';
import type { AgentRegistry } from '../agents/registry';
import { logger } from '../../utils/logger';

/** The tool each kind of action maps to. */
export const ACTION_TOOLS: Readonly<Record<AIApprovalKind, string>> = Object.freeze({
  DELETE_DATA: 'deleteData',
  CHANGE_TACTICS_LIVE: 'changeTacticsLive',
  MASS_MESSAGE: 'sendNotification',
  APPROVE_TRANSFER: 'approveTransfer',
  MEDICAL_RECOMMENDATION: 'issueMedicalRecommendation',
  PAYMENT_ACTION: 'initiatePayment',
  OTHER: 'updateAllowedResource',
});

export interface AgentProfile { tools: string[]; dataClass: DataClass }

/** Why a runtime agent has no profile. */
export type RegistryRefusal = 'NOT_REGISTERED' | 'NOT_RUNNING' | 'REGISTRY_INVALID';

export interface RuntimeProfiles {
  /** The runtime agents that may run, in the platform's AIAgent order. */
  profiles: Readonly<Partial<Record<AIAgent, AgentProfile>>>;
  /** Every runtime agent that may not, and why. */
  refused: Readonly<Partial<Record<AIAgent, { code: RegistryRefusal; reason: string }>>>;
  /** Set when the registry could not be built: then no agent runs. */
  registryFailure: string | null;
}

/**
 * The runtime profiles, from the registry: one per runtime agent whose manifest
 * is RUNNING. Pure — the same registry gives the same profiles — and it never
 * throws: a registry that cannot be built refuses every agent instead.
 */
export function deriveRuntimeProfiles(load: () => AgentRegistry): RuntimeProfiles {
  const profiles: Partial<Record<AIAgent, AgentProfile>> = {};
  const refused: Partial<Record<AIAgent, { code: RegistryRefusal; reason: string }>> = {};
  let registryFailure: string | null = null;
  try {
    const registry = load();
    for (const agent of Object.values(AIAgent)) {
      const m = registry.forLegacyAgent(agent);
      if (!m) refused[agent] = { code: 'NOT_REGISTERED', reason: `The agent ${agent} has no manifest in the agent registry` };
      else if (m.lifecycle !== 'RUNNING') refused[agent] = { code: 'NOT_RUNNING', reason: `The agent ${m.id} is ${m.lifecycle} in the agent registry; only a RUNNING agent runs` };
      else profiles[agent] = { tools: [...m.tools], dataClass: highest(m.data.reads) };
    }
  } catch (err) {
    registryFailure = err instanceof Error ? err.message : String(err);
    for (const agent of Object.keys(profiles)) delete profiles[agent as AIAgent];
    for (const agent of Object.values(AIAgent)) refused[agent] = { code: 'REGISTRY_INVALID', reason: 'The agent registry did not validate, so no agent runs' };
  }
  for (const p of Object.values(profiles)) { Object.freeze(p!.tools); Object.freeze(p); }
  return Object.freeze({ profiles: Object.freeze(profiles), refused: Object.freeze(refused), registryFailure });
}

const RUNTIME = deriveRuntimeProfiles(platformAgentRegistry);
if (RUNTIME.registryFailure) {
  logger.error('[agents] the agent registry did not validate; every agent job will be refused', { error: RUNTIME.registryFailure });
}

/** Every agent the runtime can be asked to run (the AIAgent enum), in its order. */
export const RUNTIME_AGENTS: readonly AIAgent[] = Object.freeze(Object.values(AIAgent));

/** What each runtime agent may do, derived from its RUNNING manifest. An agent missing here does not run. */
export const AGENT_PROFILES: Readonly<Partial<Record<AIAgent, AgentProfile>>> = RUNTIME.profiles;

/** Why the registry could not be built, or null. While it is set, every job is refused. */
export const AGENT_REGISTRY_FAILURE: string | null = RUNTIME.registryFailure;

export interface AgentJobDecision extends ToolDecision {
  /** The action the job asks for, or null for analysis. */
  actionKind: AIApprovalKind | null;
  toolKey: string;
  dataClass: DataClass;
  /** Set when the job is refused because its agent may not run at all. */
  registry?: RegistryRefusal;
}

/** The identity an agent job runs as. Agents are never above APPROVE autonomy. */
export function agentIdentity(agent: AIAgent, clubId: string): AgentIdentity {
  const profile = AGENT_PROFILES[agent];
  return {
    agentId: `agent:${agent}`,
    type: agent,
    name: agent,
    status: profile ? 'ACTIVE' : 'RETIRED',
    environment: currentEnvironment(),
    scope: { clubId },
    tools: profile?.tools ?? [],
    autonomy: AutonomyLevel.APPROVE,
    ownerUserId: null,
  };
}

export function authorizeAgentJob(job: { agent: AIAgent; kind: string; input: Prisma.JsonValue; clubId: string }): AgentJobDecision {
  const actionKind = classifyRisk(job.kind, job.input);
  const toolKey = actionKind ? ACTION_TOOLS[actionKind] : 'createReport';
  const dataClass = AGENT_PROFILES[job.agent]?.dataClass ?? 'RESTRICTED';
  if (!job.clubId) {
    return { allowed: false, requiresApproval: false, reason: 'An agent job must belong to a club', actionKind, toolKey, dataClass };
  }
  if (!AGENT_PROFILES[job.agent]) {
    const refusal = RUNTIME.refused[job.agent] ?? { code: 'NOT_REGISTERED' as const, reason: `The agent ${String(job.agent)} has no manifest in the agent registry` };
    return { allowed: false, requiresApproval: false, reason: refusal.reason, registry: refusal.code, actionKind, toolKey, dataClass };
  }
  return { ...authorizeTool(agentIdentity(job.agent, job.clubId), toolKey), actionKind, toolKey, dataClass };
}
