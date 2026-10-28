// Replay — a definition, run again from nothing, to the record and the dossier it produces
// ─────────────────────────────────────────────────────────────────────────────
// The publication gate's reproduction, and the Lab's own check before it
// prepares anything. A definition is parsed, then run through the AI-0.4
// engine in a store of its own, with the platform's real Agent Registry and
// LAB operations, from a released kill switch. The record must verify by the
// Lab's rule, and its dossier by production's. What comes back is the record,
// the dossier, and the dossier's text exactly as a publication file holds it,
// so a comparison is of bytes, not of a summary.
//
// This file is where source.ts starts its walk: everything the replay needs
// is imported from here, so everything it depends on is in the source digest.

import '../../src/config/zod'; // zod 4 with zod 3's messages, as the server has them, before anything validates
import { platformAgentRegistry } from '../../src/platform/agents/catalog';
import type { ExecutionEvidence } from '../../src/platform/agents/execution-evidence';
import type { AgentRegistry } from '../../src/platform/agents/registry';
import { currentEnvironment, type FamilistaEnvironment } from '../../src/platform/environment';
import { killSwitchEngaged, releaseKillSwitch } from '../../src/platform/intelligence/agents';
import { applyDefinition, parseDefinition, type AppliedStep, type ExecutionDefinition } from './definition';
import { MemoryExecutionStore, verifyExecution, type ExecutionRecord } from './execution';
import { labExecutionOperations, type OperationCatalog } from './operations';
import { LAB_OPERATORS, type LabOperator } from './operators';
import { executionPublicationCandidate, serialisePublicationFile } from './publication';

export interface ReplayDeps { registry?: AgentRegistry; operations?: OperationCatalog; operators?: readonly LabOperator[]; environment?: FamilistaEnvironment }

export type ReplayResult =
  | { ok: true; definition: ExecutionDefinition; definitionDigest: string; record: ExecutionRecord; evidence: ExecutionEvidence; dossierText: string; steps: AppliedStep[] }
  | { ok: false; reason: string; steps: AppliedStep[] };

/** Run the definition in `text` (the file at `filePath`) again, from nothing. Writes nothing; leaves the kill switch released, as it must find it. */
export function replayDefinition(text: string, filePath: string, deps: ReplayDeps = {}): ReplayResult {
  const environment = deps.environment ?? currentEnvironment();
  if (environment !== 'LAB') return { ok: false, reason: `a definition is replayed in the Lab only; this process is ${environment}`, steps: [] };
  if (killSwitchEngaged()) return { ok: false, reason: 'the kill switch is engaged: nothing starts, a replay neither', steps: [] };
  const parsed = parseDefinition(text, filePath);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason, steps: [] };

  const registry = deps.registry ?? platformAgentRegistry();
  const operations = deps.operations ?? labExecutionOperations();
  const store = new MemoryExecutionStore();
  let applied: ReturnType<typeof applyDefinition>;
  try {
    applied = applyDefinition(parsed.definition, { registry, operations, store, environment, operators: deps.operators ?? LAB_OPERATORS });
  } finally {
    if (killSwitchEngaged()) releaseKillSwitch(); // a definition may engage it; the replay never leaves it engaged
  }
  if (!applied.ok) return { ok: false, reason: applied.reason, steps: applied.steps };
  if (store.list().length !== 1) return { ok: false, reason: `the definition recorded ${store.list().length} executions; a definition is one`, steps: applied.steps };
  const record = applied.record;
  const check = verifyExecution(record);
  if (!check.ok) return { ok: false, reason: `the replayed record does not verify: ${check.reasons[0]}`, steps: applied.steps };
  const candidate = executionPublicationCandidate(record, { registry, operations });
  if (!candidate.evidence) return { ok: false, reason: `the replayed execution is not a publication candidate: ${candidate.reasons.join('; ')}`, steps: applied.steps };
  return {
    ok: true, definition: parsed.definition, definitionDigest: parsed.digest, record, evidence: candidate.evidence,
    dossierText: serialisePublicationFile(candidate.evidence), steps: applied.steps,
  };
}
