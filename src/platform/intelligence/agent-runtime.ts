// The agent runtime, observed: what the platform's agents actually did
// ─────────────────────────────────────────────────────────────────────────────
// The Operations Room shows what the Agent Registry declares. This shows what
// the runtime did with it: whether it is enforcing the registry, and, for each
// agent the platform can be asked to run, the jobs queued in the last 24 hours
// and what became of them — succeeded, failed (and why), cancelled, still in
// flight — the queue now, the approvals waiting on a person, and when it last
// succeeded. It is the Observe and Measure steps of the agent lifecycle, for
// the agents that run in production. Every window is read on createdAt, the
// column the job table indexes.
//
// Totals only, across every club. No club, team, person, job input or output
// ever leaves this file, and neither does a job's error text: a failure is
// counted by what kind it is, read from the fixed prefixes the worker writes
// (workers/ai-agent.worker.ts) and the reasons agent-jobs.ts gives.
//
// It reads and never writes. When job history cannot be read it says so,
// rather than answering zero: a zero here would read as "nothing went wrong".

import type { AIAgent } from '@prisma/client';
import { prisma } from '../../config/database';
import { killSwitchEngaged } from './agents';
import { RUNTIME_AGENTS, registryRefusalCode, runtimeRegistryState, type RegistryRefusal, type RuntimeRegistryState } from './agent-jobs';

/** The window every count covers. */
export const RUNTIME_WINDOW_HOURS = 24;
/** A job RUNNING longer than this is stalled. The worker's reaper fails such jobs (STALE_RUNNING_MS in workers/ai-agent.worker.ts). */
export const STALLED_AFTER_MS = 10 * 60 * 1000;
/** A queue whose oldest job has waited longer than this is not draining. The worker takes up to five jobs every four seconds. */
export const BACKLOG_AFTER_MS = 5 * 60 * 1000;
/** How many failed jobs are read to tell their kinds apart. Beyond it the kinds describe the most recent ones. */
export const FAILURE_SAMPLE_LIMIT = 2000;
/** How far back "last succeeded" looks. Every read is bounded by createdAt, the indexed column. */
export const LAST_SUCCESS_DAYS = 30;

export const FAILURE_KINDS = ['registry', 'authorization', 'approval', 'stalled', 'execution'] as const;
export type FailureKind = typeof FAILURE_KINDS[number];

/**
 * What kind of failure a failed job's error records. The prefixes are the
 * worker's own: "Not authorised: " for a refusal before the job ran (the
 * registry's reasons are recognised by agent-jobs.ts), "Approval " for an
 * approval a person rejected or let expire, the reaper's "Stalled", and
 * anything else, a handler's or a model's error, is the job itself failing.
 */
export function failureKind(error: string | null | undefined): FailureKind {
  const e = typeof error === 'string' ? error : '';
  if (e.startsWith('Not authorised: ')) return registryRefusalCode(e.slice('Not authorised: '.length)) ? 'registry' : 'authorization';
  if (e.startsWith('Approval ')) return 'approval';
  if (e.startsWith('Stalled')) return 'stalled';
  return 'execution';
}

export interface AgentRuntimeRow {
  agent: AIAgent;
  /** Whether the registry lets it run, and if not, why. */
  runs: boolean;
  refusedCode: RegistryRefusal | null;
  /** Jobs queued in the window, and where each of them is now. */
  queued: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** Queued in the window and not finished: PENDING or RUNNING. */
  inFlight: number;
  /** The window's failed jobs (or the most recent sample of them), by kind. */
  failures: Record<FailureKind, number>;
  /** Approvals waiting on a person, not yet expired. */
  approvalsPending: number;
  /** The last success of a job queued in the last 30 days, or null. */
  lastSucceededAt: string | null;
}

export interface AgentRuntimeView {
  generatedAt: string;
  windowHours: number;
  registry: RuntimeRegistryState;
  killSwitch: { engaged: boolean };
  /** The work queue now. Null when job history cannot be read. */
  queue: {
    pending: number;
    oldestPendingSeconds: number | null;
    running: number;
    stalled: number;
    state: 'CLEAR' | 'DRAINING' | 'BACKLOG';
  } | null;
  /** One row per agent the runtime can be asked to run, in the AIAgent order. Null when job history cannot be read. */
  agents: AgentRuntimeRow[] | null;
  totals: { queued: number; succeeded: number; failed: number; cancelled: number; inFlight: number; approvalsPending: number; failures: Record<FailureKind, number> } | null;
  /** How many failed jobs were read to tell their kinds apart, and whether that was all of them. */
  failureSample: { read: number; limit: number; complete: boolean } | null;
  unavailable: string | null;
}

const zeroKinds = (): Record<FailureKind, number> => ({ registry: 0, authorization: 0, approval: 0, stalled: 0, execution: 0 });
const countOf = (row: { _count?: { _all?: number } | number }) => (typeof row._count === 'number' ? row._count : row._count?._all ?? 0);

/** The agent runtime over the last 24 hours. Aggregates only; reads, never writes. */
export async function agentRuntimeView(now: Date = new Date()): Promise<AgentRuntimeView> {
  const since = new Date(now.getTime() - RUNTIME_WINDOW_HOURS * 3600 * 1000);
  const successSince = new Date(now.getTime() - LAST_SUCCESS_DAYS * 24 * 3600 * 1000);
  const registry = runtimeRegistryState();
  const base = {
    generatedAt: now.toISOString(),
    windowHours: RUNTIME_WINDOW_HOURS,
    registry,
    killSwitch: { engaged: killSwitchEngaged() },
  };
  try {
    const [byStatus, failedRows, pending, oldest, running, stalled, approvals, lastSuccess] = await Promise.all([
      prisma.aIAgentJob.groupBy({ by: ['agent', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.aIAgentJob.findMany({
        where: { status: 'FAILED', createdAt: { gte: since } },
        select: { agent: true, error: true },
        orderBy: { createdAt: 'desc' },
        take: FAILURE_SAMPLE_LIMIT,
      }),
      prisma.aIAgentJob.count({ where: { status: 'PENDING' } }),
      prisma.aIAgentJob.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.aIAgentJob.count({ where: { status: 'RUNNING' } }),
      prisma.aIAgentJob.count({ where: { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - STALLED_AFTER_MS) } } }),
      prisma.aIApprovalRequest.groupBy({ by: ['agent'], where: { status: 'PENDING', expiresAt: { gt: now } }, _count: { _all: true } }),
      prisma.aIAgentJob.groupBy({ by: ['agent'], where: { status: 'SUCCESS', createdAt: { gte: successSince } }, _max: { finishedAt: true } }),
    ]);

    const runs = new Set(registry.running);
    const refused = new Map(registry.refused.map((r) => [r.agent, r.code]));
    const rows = new Map<AIAgent, AgentRuntimeRow>(RUNTIME_AGENTS.map((agent) => [agent, {
      agent, runs: runs.has(agent), refusedCode: refused.get(agent) ?? null,
      queued: 0, succeeded: 0, failed: 0, cancelled: 0, inFlight: 0, failures: zeroKinds(), approvalsPending: 0, lastSucceededAt: null,
    }]));
    // Only agents the platform knows are counted: a row naming anything else is not one of its agents.
    const rowOf = (agent: unknown) => rows.get(agent as AIAgent);

    for (const r of byStatus) {
      const row = rowOf(r.agent);
      if (!row) continue;
      const n = countOf(r);
      row.queued += n;
      if (r.status === 'SUCCESS') row.succeeded += n;
      else if (r.status === 'FAILED') row.failed += n;
      else if (r.status === 'CANCELLED') row.cancelled += n;
      else if (r.status === 'PENDING' || r.status === 'RUNNING') row.inFlight += n;
    }
    for (const j of failedRows) { const row = rowOf(j.agent); if (row) row.failures[failureKind(j.error)] += 1; }
    for (const r of approvals) { const row = rowOf(r.agent); if (row) row.approvalsPending += countOf(r); }
    for (const r of lastSuccess) {
      const row = rowOf(r.agent);
      const at = r._max?.finishedAt;
      if (row && at instanceof Date) row.lastSucceededAt = at.toISOString();
    }

    const agents = [...rows.values()];
    const sum = (k: 'queued' | 'succeeded' | 'failed' | 'cancelled' | 'inFlight' | 'approvalsPending') => agents.reduce((n, a) => n + a[k], 0);
    const failures = zeroKinds();
    for (const a of agents) for (const k of FAILURE_KINDS) failures[k] += a.failures[k];
    const failedTotal = sum('failed');
    const oldestPendingSeconds = oldest?.createdAt instanceof Date ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1000)) : null;
    return {
      ...base,
      queue: {
        pending, oldestPendingSeconds, running, stalled,
        state: pending === 0 ? 'CLEAR' : oldestPendingSeconds !== null && oldestPendingSeconds * 1000 > BACKLOG_AFTER_MS ? 'BACKLOG' : 'DRAINING',
      },
      agents,
      totals: { queued: sum('queued'), succeeded: sum('succeeded'), failed: failedTotal, cancelled: sum('cancelled'), inFlight: sum('inFlight'), approvalsPending: sum('approvalsPending'), failures },
      failureSample: { read: failedRows.length, limit: FAILURE_SAMPLE_LIMIT, complete: failedRows.length < FAILURE_SAMPLE_LIMIT || failedRows.length >= failedTotal },
      unavailable: null,
    };
  } catch {
    return { ...base, queue: null, agents: null, totals: null, failureSample: null, unavailable: 'Agent job history is not readable in this deployment.' };
  }
}
