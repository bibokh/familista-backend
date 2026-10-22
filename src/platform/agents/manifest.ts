// The Agent Manifest — what an agent IS, declared before it may exist
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Foundation, AI-0.1. Every agent on the platform — a club's
// coaching agent, a medical agent, an education tutor, a commerce assistant, a
// platform operations agent — is described by one manifest, and a manifest that
// does not validate is not an agent. The manifest says, in units the platform
// already enforces elsewhere:
//
//   identity    a namespaced id (`club.…` or `platform.…`) and a semver version;
//   scope       CLUB    acts inside one club's tenancy, for that club's people;
//               PLATFORM acts on the platform itself, under the Platform Owner,
//               and never inside a Club Workspace;
//   domain      which part of Familista it serves (AGENT_DOMAINS);
//   autonomy    its ceiling on the scale of agents.ts — never above APPROVE, so
//               every action it could take waits for a person;
//   tools       keys of the tool registry (agents.ts); a PROTECTED tool, or one
//               above its ceiling, is refused here, before anything runs;
//   data        the data classes it reads and writes (data-classes.ts), which
//               must cover what its tools reach; RESTRICTED (health, minors)
//               belongs to the medical domain alone;
//   outputs     the AI records it writes, each a kind the read policy has
//               classified (ai-read-policy.ts DECLARED_KINDS) — an agent cannot
//               write a record nobody has decided who may read;
//   supervisor  the person accountable: the Platform Owner for a platform agent,
//               a club role able to read everything the agent writes otherwise;
//   lifecycle   DRAFT / LAB / RUNNING / RETIRED. RUNNING is only for an agent the
//               platform already runs (a `binding` to the AIAgent enum): the
//               registry describes what runs, it starts nothing.
//
// Validation is pure and deterministic. Every refusal carries a stable code and
// says why, because a manifest rejected with "invalid" cannot be fixed.

import type { AIAgent, UserRole } from '@prisma/client';
import { AutonomyLevel, tool } from '../intelligence/agents';
import { highest, type DataClass } from '../intelligence/data-classes';
import {
  AI_READ_MATRIX, DECLARED_KINDS, classify, type AIRecordClass, type AIRecordType,
} from '../../security/ai-read-policy';

export const AGENT_DOMAINS = [
  'CLUB_OPERATIONS', 'TACTICS', 'TRAINING', 'MATCH_OPERATIONS', 'MEDICAL', 'SCOUTING', 'FINANCE',
  'COMMUNICATIONS', 'DEVICES', 'DATA', 'VISION', 'EDUCATION', 'COMMERCE', 'MEDIA', 'PLATFORM_OPERATIONS',
] as const;
export type AgentDomain = typeof AGENT_DOMAINS[number];

export type AgentScope = 'CLUB' | 'PLATFORM';
export type AgentLifecycle = 'DRAFT' | 'LAB' | 'RUNNING' | 'RETIRED';
export type AgentSupervisor = 'PLATFORM_OWNER' | UserRole;

export interface AgentOutput { type: AIRecordType; kind: string }

export interface AgentManifest {
  id:              string;
  version:         string;
  title:           string;
  purpose:         string;
  domain:          AgentDomain;
  scope:           AgentScope;
  lifecycle:       AgentLifecycle;
  autonomyCeiling: AutonomyLevel;
  tools:           string[];
  data:            { reads: DataClass[]; writes: DataClass[] };
  outputs:         AgentOutput[];
  supervisor:      AgentSupervisor;
  /** An agent the platform already runs, by its AIAgent enum value. */
  binding?:        { legacyAgent: AIAgent };
}

export type ManifestIssueCode =
  | 'ID_FORMAT' | 'ID_SCOPE_PREFIX' | 'ID_DUPLICATE' | 'VERSION_FORMAT' | 'TEXT_REQUIRED'
  | 'DOMAIN_UNKNOWN' | 'SCOPE_UNKNOWN' | 'LIFECYCLE_UNKNOWN' | 'LIFECYCLE_RUNNING_UNBOUND'
  | 'AUTONOMY_CEILING' | 'TOOL_UNKNOWN' | 'TOOL_PROTECTED' | 'TOOL_ABOVE_CEILING' | 'TOOL_DUPLICATE'
  | 'DATA_CLASS_UNKNOWN' | 'DATA_DOES_NOT_COVER_TOOLS' | 'DATA_RESTRICTED_OUTSIDE_MEDICAL' | 'DATA_PLATFORM_PERSONAL'
  | 'OUTPUT_UNDECLARED' | 'OUTPUT_UNBOUND' | 'OUTPUT_MEDICAL_UNCLEARED'
  | 'SUPERVISOR_SCOPE' | 'SUPERVISOR_CANNOT_READ' | 'SUPERVISOR_MEDICAL'
  | 'BINDING_UNKNOWN' | 'BINDING_SCOPE' | 'BINDING_DUPLICATE';

export interface ManifestIssue { code: ManifestIssueCode; message: string }

const ID = /^(club|platform)\.[a-z][a-z0-9-]{1,40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATA_CLASSES: readonly DataClass[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const ORDER: Record<DataClass, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };
const LIFECYCLES: readonly AgentLifecycle[] = ['DRAFT', 'LAB', 'RUNNING', 'RETIRED'];
/** The club roles that may answer for an agent. Players and parents answer for none. */
const CLUB_SUPERVISORS: readonly string[] = ['CLUB_ADMIN', 'MANAGER', 'HEAD_COACH', 'ASSISTANT_COACH', 'COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT'];
const LEGACY_AGENTS: ReadonlySet<string> = new Set(['CLUB_MANAGER', 'TACTICAL', 'MEDICAL', 'SCOUTING', 'FINANCE', 'TRAINING', 'MATCH_OPS', 'COMMS', 'DEVICE_MGMT', 'BIG_DATA']);

/** The read-policy classes an output holds, for the agent that writes it. */
export function outputClasses(m: Pick<AgentManifest, 'binding'>, o: AgentOutput): AIRecordClass[] {
  return classify(o.type, m.binding?.legacyAgent ?? null, o.kind).classes;
}

/** Every reason this manifest is not an agent. Empty means it is one. */
export function validateManifest(m: AgentManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const fail = (code: ManifestIssueCode, message: string) => issues.push({ code, message });

  // ── identity
  if (!ID.test(m.id)) fail('ID_FORMAT', `"${m.id}" is not <club|platform>.<lowercase-name>`);
  else if (!m.id.startsWith(`${m.scope === 'PLATFORM' ? 'platform' : 'club'}.`)) fail('ID_SCOPE_PREFIX', `A ${m.scope} agent's id starts with "${m.scope === 'PLATFORM' ? 'platform' : 'club'}."`);
  if (!SEMVER.test(m.version)) fail('VERSION_FORMAT', `"${m.version}" is not a MAJOR.MINOR.PATCH version`);
  for (const [field, value, max] of [['title', m.title, 80], ['purpose', m.purpose, 400]] as const) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) fail('TEXT_REQUIRED', `${field} must be 1–${max} characters`);
  }
  if (!(AGENT_DOMAINS as readonly string[]).includes(m.domain)) fail('DOMAIN_UNKNOWN', `"${m.domain}" is not a platform domain`);
  if (m.scope !== 'CLUB' && m.scope !== 'PLATFORM') fail('SCOPE_UNKNOWN', `"${m.scope}" is neither CLUB nor PLATFORM`);
  if (!LIFECYCLES.includes(m.lifecycle)) fail('LIFECYCLE_UNKNOWN', `"${m.lifecycle}" is not a lifecycle state`);
  else if (m.lifecycle === 'RUNNING' && !m.binding) fail('LIFECYCLE_RUNNING_UNBOUND', 'Only an agent the platform already runs is RUNNING; the registry starts nothing');

  // ── autonomy and tools
  const ceiling = m.autonomyCeiling;
  if (!Number.isInteger(ceiling) || ceiling < AutonomyLevel.OBSERVE || ceiling > AutonomyLevel.APPROVE) {
    fail('AUTONOMY_CEILING', 'The autonomy ceiling is OBSERVE to APPROVE: every action waits for a person');
  }
  const seen = new Set<string>();
  for (const key of m.tools) {
    if (seen.has(key)) { fail('TOOL_DUPLICATE', `"${key}" is listed twice`); continue; }
    seen.add(key);
    const t = tool(key);
    if (!t) { fail('TOOL_UNKNOWN', `No tool is registered as "${key}"`); continue; }
    if (t.effect === 'PROTECTED') fail('TOOL_PROTECTED', `"${key}" is protected: a person does this, or nobody does`);
    else if (t.minAutonomy > ceiling) fail('TOOL_ABOVE_CEILING', `"${key}" needs ${AutonomyLevel[t.minAutonomy]}, above the ceiling ${AutonomyLevel[ceiling] ?? ceiling}`);
  }

  // ── data
  const all = [...m.data.reads, ...m.data.writes];
  for (const c of all) if (!DATA_CLASSES.includes(c)) fail('DATA_CLASS_UNKNOWN', `"${c}" is not a data class`);
  const known = (cs: DataClass[]) => cs.filter((c) => DATA_CLASSES.includes(c));
  const readCeiling = highest(known(m.data.reads));
  for (const key of m.tools) {
    const t = tool(key);
    if (t && t.effect !== 'PROTECTED' && ORDER[t.classification] > ORDER[readCeiling]) {
      fail('DATA_DOES_NOT_COVER_TOOLS', `"${key}" reaches ${t.classification} data, above what the agent declares it reads (${readCeiling})`);
    }
  }
  if (m.domain !== 'MEDICAL' && known(all).includes('RESTRICTED')) fail('DATA_RESTRICTED_OUTSIDE_MEDICAL', 'RESTRICTED data (health, minors) belongs to the medical domain alone');
  if (m.scope === 'PLATFORM' && ORDER[highest(known(all))] > ORDER.INTERNAL) fail('DATA_PLATFORM_PERSONAL', 'A platform agent reads and writes no personal data: INTERNAL at most');

  // ── outputs
  if (m.outputs.length > 0 && !m.binding) fail('OUTPUT_UNBOUND', 'An agent writes AI records only once it is bound to a runtime agent the read policy knows');
  for (const o of m.outputs) {
    const declared = DECLARED_KINDS[o.type]?.some((d) => d.kind === o.kind && d.agent === (m.binding?.legacyAgent ?? null));
    if (!declared) { fail('OUTPUT_UNDECLARED', `${o.type} "${o.kind}" is not a kind the read policy has classified for this agent`); continue; }
    if (outputClasses(m, o).includes('MEDICAL') && !known(m.data.writes).includes('RESTRICTED')) {
      fail('OUTPUT_MEDICAL_UNCLEARED', `${o.type} "${o.kind}" is medical, so the agent must declare it writes RESTRICTED data`);
    }
  }

  // ── supervisor
  if (m.scope === 'PLATFORM' && m.supervisor !== 'PLATFORM_OWNER') fail('SUPERVISOR_SCOPE', 'A platform agent answers to the Platform Owner');
  if (m.scope === 'CLUB' && !CLUB_SUPERVISORS.includes(m.supervisor)) fail('SUPERVISOR_SCOPE', `A club agent answers to a club staff role, not "${m.supervisor}"`);
  if (m.domain === 'MEDICAL' && m.supervisor !== 'MEDICAL_STAFF') fail('SUPERVISOR_MEDICAL', 'A medical agent answers to medical staff');
  if (m.scope === 'CLUB' && CLUB_SUPERVISORS.includes(m.supervisor)) {
    const row = AI_READ_MATRIX[m.supervisor as UserRole];
    for (const o of m.outputs) {
      const unreadable = outputClasses(m, o).filter((c) => row[c] !== 'FULL');
      if (unreadable.length > 0) fail('SUPERVISOR_CANNOT_READ', `${m.supervisor} cannot read ${o.type} "${o.kind}" (${unreadable.join(', ')}), so cannot answer for it`);
    }
  }

  // ── binding
  if (m.binding) {
    if (!LEGACY_AGENTS.has(m.binding.legacyAgent)) fail('BINDING_UNKNOWN', `"${m.binding.legacyAgent}" is not an agent the platform runs`);
    if (m.scope !== 'CLUB') fail('BINDING_SCOPE', 'The agents the platform runs today act inside a club');
  }
  return issues;
}

/** A manifest that did not validate, with every reason. */
export class AgentManifestError extends Error {
  constructor(readonly agentId: string, readonly issues: ManifestIssue[]) {
    super(`Agent manifest "${agentId}" is not valid: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'AgentManifestError';
  }
}
