// What an agent JOB may do, decided before it runs (Cyber Defense, R8)
// ─────────────────────────────────────────────────────────────────────────────
// The agent worker (workers/ai-agent.worker.ts) runs AIAgentJob rows. A job's
// kind is free text — "MEDICAL.FATIGUE_SCAN", "MASS_MESSAGE_PARENTS" — so what a
// job IS comes from the approval gate's classifier (`classifyRisk`): a job that
// would act in the world maps to one of the action tools; anything else is
// analysis and maps to `createReport`, which commits nothing.
//
// Every job is then put to the tool registry (agents.ts) as the agent it runs
// as, with that agent's profile below:
//
//   · an action outside the agent's profile is refused — a COMMS agent cannot
//     ask for a payment, a FINANCE agent cannot message parents — whatever
//     approval exists;
//   · deleting data is PROTECTED and refused for every agent;
//   · every action is WRITE at APPROVE autonomy, so it needs a person's
//     approval first (ai-approval.service), and the kill switch stops it;
//   · the profile's data class is what the job's prompt is declared as when it
//     reaches the AI Gateway.

import type { AIAgent, AIApprovalKind, Prisma } from '@prisma/client';
import { classifyRisk } from '../../security/ai-approval.service';
import { AutonomyLevel, authorizeTool, type AgentIdentity, type ToolDecision } from './agents';
import { currentEnvironment } from '../environment';
import type { DataClass } from './data-classes';

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

/** What every agent may do: read, analyse, draft. Nothing here commits anything. */
const ANALYSIS = ['getClub', 'getTeam', 'getPlayers', 'getMatch', 'analyzeOpponent', 'createReport', 'createTrainingDraft'];

export interface AgentProfile { tools: string[]; dataClass: DataClass }

export const AGENT_PROFILES: Readonly<Record<AIAgent, AgentProfile>> = Object.freeze({
  CLUB_MANAGER: { tools: [...ANALYSIS, 'sendNotification', 'updateAllowedResource'], dataClass: 'INTERNAL' },
  TACTICAL:     { tools: [...ANALYSIS, 'changeTacticsLive'],          dataClass: 'INTERNAL' },
  MEDICAL:      { tools: [...ANALYSIS, 'issueMedicalRecommendation'], dataClass: 'RESTRICTED' },
  SCOUTING:     { tools: [...ANALYSIS, 'approveTransfer'],            dataClass: 'CONFIDENTIAL' },
  FINANCE:      { tools: [...ANALYSIS, 'initiatePayment'],            dataClass: 'CONFIDENTIAL' },
  TRAINING:     { tools: [...ANALYSIS],                               dataClass: 'INTERNAL' },
  MATCH_OPS:    { tools: [...ANALYSIS],                               dataClass: 'INTERNAL' },
  COMMS:        { tools: [...ANALYSIS, 'sendNotification'],           dataClass: 'INTERNAL' },
  DEVICE_MGMT:  { tools: [...ANALYSIS, 'updateAllowedResource'],      dataClass: 'INTERNAL' },
  BIG_DATA:     { tools: [...ANALYSIS],                               dataClass: 'INTERNAL' },
});

export interface AgentJobDecision extends ToolDecision {
  /** The action the job asks for, or null for analysis. */
  actionKind: AIApprovalKind | null;
  toolKey: string;
  dataClass: DataClass;
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
  return { ...authorizeTool(agentIdentity(job.agent, job.clubId), toolKey), actionKind, toolKey, dataClass };
}
