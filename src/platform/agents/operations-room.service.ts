// The AI Agents Operations Room — the Platform Owner's view of every agent
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Foundation, AI-0.1. The room lives in SYSTEM, behind the
// platform owner's guard (routes/agents-room.routes.ts), and never inside a
// Club Workspace: agents are the platform's, and so is the place they are
// governed from. It reads the registry and the controls the platform already
// enforces, and nothing else — no database, no club's records, no person.
//
// What it answers: which agents exist, what each may do and touch, who answers
// for each, whether the registry still agrees with what actually runs (the
// egress profiles and the read policy), and that AI-0.1 activates nothing.
// It changes nothing either: a manifest changes in a reviewed pull request.

import type { AIAgent, UserRole } from '@prisma/client';
import { AutonomyLevel, killSwitchEngaged, tool } from '../intelligence/agents';
import { AGENT_PROFILES } from '../intelligence/agent-jobs';
import { highest, type DataClass } from '../intelligence/data-classes';
import { currentEnvironment, type FamilistaEnvironment } from '../environment';
import { AI_READ_MATRIX, DECLARED_KINDS, type AIRecordClass } from '../../security/ai-read-policy';
import { platformAgentRegistry } from './catalog';
import { AGENT_DOMAINS, outputClasses, validateManifest, type AgentDomain, type AgentLifecycle, type AgentScope, type ManifestIssue } from './manifest';
import type { AgentRegistry, RegisteredAgent } from './registry';

export interface AgentSummary {
  id: string; version: string; title: string; domain: AgentDomain; scope: AgentScope; lifecycle: AgentLifecycle;
  autonomyCeiling: string; tools: number; dataCeiling: DataClass; outputs: number; supervisor: string;
  runtimeAgent: string | null; digest: string;
}

export interface Invariant { id: string; holds: boolean; detail: string }

export interface OperationsRoomOverview {
  environment: FamilistaEnvironment;
  /** AI-0.1 starts no agent: the registry describes the ones that run. */
  activation: { newAgentsActive: 0; labRuntime: 'NOT_PRESENT' };
  killSwitch: { engaged: boolean };
  registry: {
    digest: string;
    agents: number;
    byScope: Record<AgentScope, number>;
    byLifecycle: Record<AgentLifecycle, number>;
    byDomain: Record<AgentDomain, number>;
  };
  invariants: Invariant[];
  agents: AgentSummary[];
}

export interface AgentDetail {
  agent: RegisteredAgent;
  autonomyCeiling: string;
  tools: Array<{ key: string; effect: string; minAutonomy: string; classification: string }>;
  outputs: Array<{ type: string; kind: string; classes: AIRecordClass[]; readableBy: string[] }>;
  issues: ManifestIssue[];
}

const ROLES = Object.keys(AI_READ_MATRIX) as UserRole[];
const count = <K extends string>(keys: readonly K[], of: (k: K) => number) => Object.fromEntries(keys.map((k) => [k, of(k)])) as Record<K, number>;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

function summary(a: RegisteredAgent): AgentSummary {
  return {
    id: a.id, version: a.version, title: a.title, domain: a.domain, scope: a.scope, lifecycle: a.lifecycle,
    autonomyCeiling: AutonomyLevel[a.autonomyCeiling], tools: a.tools.length, dataCeiling: highest([...a.data.reads, ...a.data.writes]),
    outputs: a.outputs.length, supervisor: a.supervisor, runtimeAgent: a.binding?.legacyAgent ?? null, digest: a.digest.slice(0, 12),
  };
}

/** Whether the registry still agrees with everything the platform enforces. Computed, never stored. */
export function invariants(registry: AgentRegistry): Invariant[] {
  const agents = registry.list();
  const runtime = Object.keys(AGENT_PROFILES) as AIAgent[];
  const undescribed = runtime.filter((r) => !registry.forLegacyAgent(r));
  const profileDrift = runtime.filter((r) => {
    const m = registry.forLegacyAgent(r);
    if (!m) return false;
    const p = AGENT_PROFILES[r];
    return !sameSet(m.tools, p.tools) || highest(m.data.reads) !== p.dataClass;
  });
  const outputDrift = runtime.filter((r) => {
    const m = registry.forLegacyAgent(r);
    if (!m) return false;
    const declared = Object.entries(DECLARED_KINDS).flatMap(([type, list]) => list.filter((d) => d.agent === r).map((d) => `${type}:${d.kind}`));
    return !sameSet(m.outputs.map((o) => `${o.type}:${o.kind}`), declared);
  });
  const invalid = agents.filter((a) => validateManifest(a).length > 0);
  const protectedTools = agents.filter((a) => a.tools.some((k) => tool(k)?.effect === 'PROTECTED'));
  const aboveApprove = agents.filter((a) => a.autonomyCeiling > AutonomyLevel.APPROVE);
  const platformPersonal = agents.filter((a) => a.scope === 'PLATFORM' && highest([...a.data.reads, ...a.data.writes]) !== 'PUBLIC' && highest([...a.data.reads, ...a.data.writes]) !== 'INTERNAL');
  const runningUnbound = agents.filter((a) => a.lifecycle === 'RUNNING' && !a.binding);
  // A drift is named by its manifest, the thing the owner reviews; an agent with no manifest by its runtime name.
  const names = (xs: Array<{ id: string } | string>) => xs.map((x) => (typeof x === 'string' ? registry.forLegacyAgent(x)?.id ?? x : x.id)).join(', ');
  return [
    { id: 'manifests-valid', holds: invalid.length === 0, detail: invalid.length ? `Not valid: ${names(invalid)}` : `All ${agents.length} manifests validate` },
    { id: 'runtime-agents-described', holds: undescribed.length === 0, detail: undescribed.length ? `Running without a manifest: ${names(undescribed)}` : `All ${runtime.length} running agents have a manifest` },
    { id: 'profiles-agree', holds: profileDrift.length === 0, detail: profileDrift.length ? `Tools or data class differ from the egress profile: ${names(profileDrift)}` : 'Tools and data classes match the egress profiles' },
    { id: 'outputs-agree', holds: outputDrift.length === 0, detail: outputDrift.length ? `Outputs differ from the read policy: ${names(outputDrift)}` : 'Outputs match the record kinds the read policy declares' },
    { id: 'no-protected-tools', holds: protectedTools.length === 0, detail: protectedTools.length ? `Hold a protected tool: ${names(protectedTools)}` : 'No agent holds a protected tool' },
    { id: 'ceiling-approve', holds: aboveApprove.length === 0, detail: aboveApprove.length ? `Above APPROVE: ${names(aboveApprove)}` : 'Every action waits for a person' },
    { id: 'platform-agents-no-personal-data', holds: platformPersonal.length === 0, detail: platformPersonal.length ? `Platform agents with personal data: ${names(platformPersonal)}` : 'Platform agents touch no personal data' },
    { id: 'nothing-activated', holds: runningUnbound.length === 0, detail: runningUnbound.length ? `Running without a runtime binding: ${names(runningUnbound)}` : 'Only agents the platform already runs are RUNNING' },
  ];
}

export function operationsRoomOverview(registry: AgentRegistry = platformAgentRegistry()): OperationsRoomOverview {
  const agents = registry.list();
  return {
    environment: currentEnvironment(),
    activation: { newAgentsActive: 0, labRuntime: 'NOT_PRESENT' },
    killSwitch: { engaged: killSwitchEngaged() },
    registry: {
      digest: registry.digest(),
      agents: agents.length,
      byScope: count(['CLUB', 'PLATFORM'] as const, (s) => agents.filter((a) => a.scope === s).length),
      byLifecycle: count(['DRAFT', 'LAB', 'RUNNING', 'RETIRED'] as const, (l) => agents.filter((a) => a.lifecycle === l).length),
      byDomain: count(AGENT_DOMAINS, (d) => agents.filter((a) => a.domain === d).length),
    },
    invariants: invariants(registry),
    agents: agents.map(summary),
  };
}

/** One agent in full, or null for an id the registry does not hold. */
export function operationsRoomAgent(id: string, registry: AgentRegistry = platformAgentRegistry()): AgentDetail | null {
  const a = registry.get(id);
  if (!a) return null;
  return {
    agent: a,
    autonomyCeiling: AutonomyLevel[a.autonomyCeiling],
    tools: a.tools.map((k) => {
      const t = tool(k)!;
      return { key: k, effect: t.effect, minAutonomy: AutonomyLevel[t.minAutonomy], classification: t.classification };
    }),
    outputs: a.outputs.map((o) => {
      const classes = outputClasses(a, o);
      return { type: o.type, kind: o.kind, classes, readableBy: ROLES.filter((r) => classes.every((c) => AI_READ_MATRIX[r][c] === 'FULL')) };
    }),
    issues: validateManifest(a),
  };
}
