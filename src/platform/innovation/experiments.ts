// The experiment registry — what was tried, and what was decided about it
// ─────────────────────────────────────────────────────────────────────────────
// A feature that was rejected disappears from the product. Its experiment does
// not: the hypothesis, the metrics, the models involved and the decision remain
// readable, because the most valuable thing about a rejected idea is the record
// of why it was rejected — and because the same idea will be proposed again.
//
// Kept deliberately in-process and pluggable: a registry that persists is a
// table, and adding one before there is a second experiment would be
// infrastructure bought early. The contract is what matters now.

import { currentEnvironment, type FamilistaEnvironment } from '../environment';

export type ExperimentStatus = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'APPROVED' | 'REJECTED' | 'ROLLED_OUT' | 'ARCHIVED';

export interface ExperimentRecord {
  id: string;
  /** The flag this experiment is gated behind, when it is gated by one. */
  flagKey?: string | null;
  title: string;
  hypothesis: string;
  successMetrics: string[];
  ownerUserId: string;
  environment: FamilistaEnvironment;
  status: ExperimentStatus;
  startedAt?: Date | null;
  endedAt?: Date | null;
  /** Model or agent versions involved, so a result can be reproduced. */
  modelVersions?: string[];
  costNote?: string | null;
  result?: string | null;
  decision?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const registry = new Map<string, ExperimentRecord>();

export function resetExperiments(): void { registry.clear(); }

export function registerExperiment(input: Omit<ExperimentRecord, 'status' | 'createdAt' | 'updatedAt' | 'environment'> & {
  status?: ExperimentStatus;
  environment?: FamilistaEnvironment;
}): ExperimentRecord {
  const now = new Date();
  const record: ExperimentRecord = {
    ...input,
    // An experiment belongs to the environment it was created in. One created
    // in the Lab is a Lab experiment for good.
    environment: input.environment ?? currentEnvironment(),
    status: input.status ?? 'DRAFT',
    createdAt: now,
    updatedAt: now,
  };
  registry.set(record.id, record);
  return record;
}

export function getExperiment(id: string): ExperimentRecord | undefined { return registry.get(id); }
export function listExperiments(filter: { status?: ExperimentStatus; environment?: FamilistaEnvironment } = {}): ExperimentRecord[] {
  return [...registry.values()].filter((e) =>
    (!filter.status || e.status === filter.status)
    && (!filter.environment || e.environment === filter.environment));
}

/** The transitions an experiment may make. Anything else is refused. */
const TRANSITIONS: Readonly<Record<ExperimentStatus, ExperimentStatus[]>> = Object.freeze({
  DRAFT: ['RUNNING', 'ARCHIVED'],
  RUNNING: ['PAUSED', 'APPROVED', 'REJECTED'],
  PAUSED: ['RUNNING', 'REJECTED', 'ARCHIVED'],
  APPROVED: ['ROLLED_OUT', 'ARCHIVED'],
  REJECTED: ['ARCHIVED'],
  ROLLED_OUT: ['ARCHIVED'],
  // The end. A rejected experiment's history stays readable here forever.
  ARCHIVED: [],
});

export function decideExperiment(id: string, next: ExperimentStatus, note?: string): ExperimentRecord {
  const record = registry.get(id);
  if (!record) throw new Error(`No experiment "${id}"`);
  if (!TRANSITIONS[record.status].includes(next)) {
    throw new Error(`An experiment cannot go from ${record.status} to ${next}`);
  }
  record.status = next;
  record.updatedAt = new Date();
  if (next === 'RUNNING' && !record.startedAt) record.startedAt = new Date();
  if (next === 'APPROVED' || next === 'REJECTED') {
    record.endedAt = new Date();
    record.decision = note ?? record.decision ?? null;
  }
  return record;
}
