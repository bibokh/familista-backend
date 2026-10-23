// Routing — which registry agent may perform a task
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.2 (LAB). The orchestrator holds no list
// of agents. It asks the Agent Registry (src/platform/agents) every time, and
// an agent is a candidate for an operation only if all of these hold:
//
//   lifecycle  LAB or RUNNING — a DRAFT is still being designed, a RETIRED one
//              is gone, and neither is ever routed to;
//   scope      a club plan routes to club agents, a platform plan to platform
//              agents, never across;
//   domain     the operation's domain, when it names one;
//   tool       the agent's manifest holds the operation's tool, at or under its
//              autonomy ceiling;
//   data       the agent may write the class the operation produces and read
//              the class its tool reaches.
//
// Among the candidates the least-privileged wins: the lowest read ceiling, then
// the fewest tools, then the id. Every candidate is recorded with the reason it
// was taken or passed over, so a routing decision can be reviewed.

import { tool } from '../../src/platform/intelligence/agents';
import { highest, withinCeiling, type DataClass } from '../../src/platform/intelligence/data-classes';
import type { AgentRegistry, RegisteredAgent } from '../../src/platform/agents/registry';
import type { AgentDomain } from '../../src/platform/agents/manifest';
import { AGENT_RECORD_CLASS, type AIRecordClass } from '../../src/security/ai-read-policy';
import type { PlanScope } from './contracts';
import type { LabOperation } from './operations';

export const ROUTABLE_LIFECYCLES: ReadonlySet<string> = new Set(['LAB', 'RUNNING']);

const ORDER: Record<DataClass, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };

export const readCeiling = (a: RegisteredAgent): DataClass => highest(a.data.reads);
export const writeCeiling = (a: RegisteredAgent): DataClass => highest(a.data.writes);

/**
 * What an agent's records are about, for the read policy. A bound agent's class
 * is the read policy's own (AGENT_RECORD_CLASS); an unbound LAB agent's follows
 * its domain by the same rule.
 */
const DOMAIN_RECORD_CLASS: Partial<Record<AgentDomain, AIRecordClass>> = { MEDICAL: 'MEDICAL', SCOUTING: 'SCOUTING', FINANCE: 'FINANCE' };
export function recordClassOf(a: RegisteredAgent): AIRecordClass {
  if (a.binding) return AGENT_RECORD_CLASS[a.binding.legacyAgent];
  return DOMAIN_RECORD_CLASS[a.domain] ?? 'OPERATIONAL';
}

export interface Candidate { agentId: string; eligible: boolean; reason: string }
export interface RouteDecision { agent: RegisteredAgent | null; ranked: string[]; candidates: Candidate[] }

function why(a: RegisteredAgent, op: LabOperation, scope: PlanScope): string | null {
  if (!ROUTABLE_LIFECYCLES.has(a.lifecycle)) return `lifecycle ${a.lifecycle} is never routed to`;
  const wanted = scope.kind === 'CLUB' ? 'CLUB' : 'PLATFORM';
  if (a.scope !== wanted) return `a ${a.scope} agent does not act in a ${wanted} plan`;
  if (op.domain !== null && a.domain !== op.domain) return `domain ${a.domain}, not ${op.domain}`;
  if (!a.tools.includes(op.tool)) return `does not hold "${op.tool}"`;
  const t = tool(op.tool);
  if (!t || t.effect === 'PROTECTED') return `"${op.tool}" may not be exercised by an agent`;
  if (t.minAutonomy > a.autonomyCeiling) return `"${op.tool}" is above its autonomy ceiling`;
  if (!withinCeiling(op.output, writeCeiling(a))) return `may not write ${op.output} data (writes up to ${writeCeiling(a)})`;
  if (!withinCeiling(t.classification, readCeiling(a))) return `may not read the ${t.classification} data "${op.tool}" reaches`;
  return null;
}

/** Route one operation in one scope, over whatever the registry holds now. */
export function route(registry: AgentRegistry, op: LabOperation, scope: PlanScope): RouteDecision {
  const candidates: Candidate[] = registry.list().map((a) => {
    const reason = why(a, op, scope);
    return { agentId: a.id, eligible: reason === null, reason: reason ?? 'eligible' };
  });
  const eligible = registry.list().filter((a) => why(a, op, scope) === null).sort((x, y) =>
    ORDER[readCeiling(x)] - ORDER[readCeiling(y)] || x.tools.length - y.tools.length || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { agent: eligible[0] ?? null, ranked: eligible.map((a) => a.id), candidates };
}

/** Every routable agent's tools: what the registry can be asked to do, discovered rather than listed. */
export function capabilityIndex(registry: AgentRegistry): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const a of registry.list()) {
    if (!ROUTABLE_LIFECYCLES.has(a.lifecycle)) continue;
    for (const t of a.tools) (index[t] ??= []).push(a.id);
  }
  return Object.fromEntries(Object.keys(index).sort().map((k) => [k, index[k]]));
}
