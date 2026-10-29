// The Agent Registry — the one list of agents the platform has
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Foundation, AI-0.1. A manifest enters the registry only if
// it validates (manifest.ts), only once per id, and is frozen on the way in, so
// what the registry holds is exactly what was reviewed. The registry is a value,
// not a service: no database, no network, no clock. Two registries built from
// the same manifests, in any order, have the same digest — the anchor the
// Operations Room shows and an audit can compare.
//
// It starts nothing. The runtime reads it once, through the catalog
// (intelligence/agent-jobs.ts): a RUNNING manifest is what lets a runtime agent
// run, and its tools are what it may call. The registry itself reaches no
// worker, database or provider, and imports nothing that runs an agent.

import { createHash } from 'crypto';
import type { AIAgent } from '@prisma/client';
import { AgentManifestError, validateManifest, type AgentDomain, type AgentManifest, type AgentScope } from './manifest';

export type RegisteredAgent = Readonly<AgentManifest> & { readonly digest: string };

/** A canonical form: object keys sorted, arrays as given, so equal manifests hash equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export class AgentRegistry {
  private readonly entries = new Map<string, RegisteredAgent>();

  /** Validate, copy, freeze and keep a manifest; refuse it with every reason otherwise. */
  register(manifest: AgentManifest): RegisteredAgent {
    const issues = validateManifest(manifest);
    if (this.entries.has(manifest.id)) issues.push({ code: 'ID_DUPLICATE', message: `"${manifest.id}" is already registered` });
    if (manifest.binding) {
      const bound = this.forLegacyAgent(manifest.binding.legacyAgent);
      if (bound) issues.push({ code: 'BINDING_DUPLICATE', message: `"${manifest.binding.legacyAgent}" is already described by "${bound.id}"` });
    }
    if (issues.length > 0) throw new AgentManifestError(manifest.id, issues);
    const copy = JSON.parse(JSON.stringify(manifest)) as AgentManifest;
    const entry = deepFreeze({ ...copy, digest: sha256(canonical(copy)) });
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): RegisteredAgent | undefined { return this.entries.get(id); }

  /** Every agent, ordered by id. */
  list(): RegisteredAgent[] { return [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }

  byDomain(domain: AgentDomain): RegisteredAgent[] { return this.list().filter((a) => a.domain === domain); }
  byScope(scope: AgentScope): RegisteredAgent[] { return this.list().filter((a) => a.scope === scope); }

  /** The manifest that describes an agent the platform already runs. */
  forLegacyAgent(agent: AIAgent | string): RegisteredAgent | undefined {
    return this.list().find((a) => a.binding?.legacyAgent === agent);
  }

  get size(): number { return this.entries.size; }

  /** One hash over every manifest, independent of registration order. */
  digest(): string { return sha256(this.list().map((a) => `${a.id}@${a.version}:${a.digest}`).join('\n')); }
}
