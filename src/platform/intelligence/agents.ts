// AI agents — identity, tools, autonomy, and the switch that stops them
// ─────────────────────────────────────────────────────────────────────────────
// An agent is not a privileged user. It is an identity with a scope, a list of
// tools it may call and a level of autonomy, and every action it takes goes:
//
//   agent → tool registry → authorization → governance → domain service → audit
//
// There is no path from an agent to the database. Not "there should not be":
// the tools are the only callable surface, each tool declares the permission it
// needs, and the registry refuses a tool the agent does not hold.
//
// ── Autonomy
//
//   0 OBSERVE   read and analyse.
//   1 RECOMMEND produce a recommendation for a person.
//   2 PREPARE   produce a draft — a plan, a lineup, a report — that commits
//               nothing.
//   3 ACT       perform an explicitly allowlisted low-risk action.
//   4 APPROVE   prepare an action a person must approve before it happens.
//   5 PROTECTED never autonomous. Deleting a club, moving platform ownership,
//               removing a club's last owner, mass deletion, changing
//               authorization: a person does these or nobody does.

import { currentEnvironment, type FamilistaEnvironment } from '../environment';

export enum AutonomyLevel {
  OBSERVE = 0,
  RECOMMEND = 1,
  PREPARE = 2,
  ACT = 3,
  APPROVE = 4,
  PROTECTED = 5,
}

export interface AgentIdentity {
  agentId: string;
  type: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'RETIRED';
  /** The environment this agent belongs to. A LAB agent never runs elsewhere. */
  environment: FamilistaEnvironment;
  scope: { clubId?: string | null; teamId?: string | null };
  /** Tool keys this agent may call. Anything not listed is refused. */
  tools: string[];
  autonomy: AutonomyLevel;
  ownerUserId: string | null;
}

export interface ToolDefinition {
  key: string;
  description: string;
  /** What calling it does to the world. Read tools can never need approval. */
  effect: 'READ' | 'DRAFT' | 'WRITE' | 'PROTECTED';
  /** The lowest autonomy that may call it. */
  minAutonomy: AutonomyLevel;
  /** The data classification this tool can reach at most. */
  classification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
}

/**
 * The tool registry.
 *
 * Deliberately small and deliberately explicit. An analytical agent holds
 * `getClub` and `analyzeOpponent`; nothing in this list lets it hold
 * `deleteClub`, because that tool is PROTECTED and PROTECTED tools are not
 * callable by an agent at any autonomy level.
 */
export const TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  { key: 'getClub',            description: 'Read a club\'s public identity',        effect: 'READ',      minAutonomy: AutonomyLevel.OBSERVE,   classification: 'PUBLIC' },
  { key: 'getTeam',            description: 'Read a team\'s identity',               effect: 'READ',      minAutonomy: AutonomyLevel.OBSERVE,   classification: 'PUBLIC' },
  { key: 'getPlayers',         description: 'Read a team\'s squad',                  effect: 'READ',      minAutonomy: AutonomyLevel.OBSERVE,   classification: 'INTERNAL' },
  { key: 'getMatch',           description: 'Read a match and its events',           effect: 'READ',      minAutonomy: AutonomyLevel.OBSERVE,   classification: 'INTERNAL' },
  { key: 'analyzeOpponent',    description: 'Analyse an opponent from recorded data', effect: 'READ',     minAutonomy: AutonomyLevel.RECOMMEND, classification: 'INTERNAL' },
  { key: 'createTrainingDraft', description: 'Draft a training session, committing nothing', effect: 'DRAFT', minAutonomy: AutonomyLevel.PREPARE, classification: 'INTERNAL' },
  { key: 'createReport',       description: 'Write a report for a person to read',   effect: 'DRAFT',     minAutonomy: AutonomyLevel.PREPARE,   classification: 'INTERNAL' },
  { key: 'sendNotification',   description: 'Notify a person',                       effect: 'WRITE',     minAutonomy: AutonomyLevel.ACT,       classification: 'INTERNAL' },
  { key: 'updateAllowedResource', description: 'Update a resource on an allowlist',  effect: 'WRITE',     minAutonomy: AutonomyLevel.ACT,       classification: 'INTERNAL' },
  // Named so that they can be refused by name rather than by absence.
  { key: 'deleteClub',            description: 'Delete a club',                      effect: 'PROTECTED', minAutonomy: AutonomyLevel.PROTECTED, classification: 'RESTRICTED' },
  { key: 'changeClubOwner',       description: 'Change who owns a club',             effect: 'PROTECTED', minAutonomy: AutonomyLevel.PROTECTED, classification: 'RESTRICTED' },
  { key: 'deleteUser',            description: 'Delete a person\'s account',         effect: 'PROTECTED', minAutonomy: AutonomyLevel.PROTECTED, classification: 'RESTRICTED' },
  { key: 'changeGlobalPermissions', description: 'Change platform authorization',    effect: 'PROTECTED', minAutonomy: AutonomyLevel.PROTECTED, classification: 'RESTRICTED' },
]);

export function tool(key: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.key === key);
}

// ── the kill switch ─────────────────────────────────────────────────────────
//
// One flag, and it stops autonomous ACTION only. Reading and recommending
// continue, and Familista itself stays up: taking the platform offline to stop
// an agent would mean the switch is never used.

let actionsDisabled = false;
let disabledReason: string | null = null;

export function killSwitchEngaged(): boolean { return actionsDisabled; }
export function killSwitchReason(): string | null { return disabledReason; }

export function engageKillSwitch(reason: string): void {
  actionsDisabled = true;
  disabledReason = reason;
}

export function releaseKillSwitch(): void {
  actionsDisabled = false;
  disabledReason = null;
}

export interface ToolDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

/**
 * May this agent call this tool, right now?
 *
 * Every refusal names itself. An agent that is told only "no" cannot be
 * debugged, and an audit trail that records only "refused" cannot be reviewed.
 */
export function authorizeTool(agent: AgentIdentity, toolKey: string, env = currentEnvironment()): ToolDecision {
  const definition = tool(toolKey);
  if (!definition) return { allowed: false, requiresApproval: false, reason: `No tool is registered as "${toolKey}"` };

  if (definition.effect === 'PROTECTED') {
    return { allowed: false, requiresApproval: false, reason: `"${toolKey}" is protected: a person does this, or nobody does` };
  }
  if (agent.status !== 'ACTIVE') {
    return { allowed: false, requiresApproval: false, reason: `The agent is ${agent.status.toLowerCase()}` };
  }
  if (!agent.tools.includes(toolKey)) {
    return { allowed: false, requiresApproval: false, reason: `The agent does not hold "${toolKey}"` };
  }
  // A LAB agent cannot reach production, and a production agent cannot be run
  // from the Lab: the environment is part of the identity, not a setting.
  if (agent.environment !== env) {
    return { allowed: false, requiresApproval: false, reason: `The agent belongs to ${agent.environment}; this is ${env}` };
  }
  if (agent.autonomy < definition.minAutonomy) {
    return { allowed: false, requiresApproval: false, reason: `"${toolKey}" needs autonomy ${definition.minAutonomy}; the agent has ${agent.autonomy}` };
  }
  const writes = definition.effect === 'WRITE';
  if (writes && actionsDisabled) {
    return { allowed: false, requiresApproval: false, reason: `Autonomous actions are stopped: ${disabledReason ?? 'kill switch engaged'}` };
  }
  if (writes && agent.autonomy === AutonomyLevel.APPROVE) {
    return { allowed: true, requiresApproval: true, reason: 'A person must approve this before it happens' };
  }
  return { allowed: true, requiresApproval: false };
}
