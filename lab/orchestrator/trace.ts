// The run trace — every decision, in order, chained so none can be changed unseen
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.2 (LAB). Each event hashes the one
// before it, so editing, dropping or reordering an event breaks the chain at
// that point, and `verifyTrace` says where. Time is a sequence number, not a
// clock: the same plan over the same registry produces the same trace, byte
// for byte, which is what lets a LAB run be compared, reviewed and repeated.
// The trace holds decisions and digests, never an operation's output.
//
// The chain's rule is src/platform/agents/trace-chain.ts, the same file the
// server checks published evidence with (AI-0.3).

import { chainHash, digestOf, GENESIS, verifyChain, type ChainedEvent } from '../../src/platform/agents/trace-chain';
import { LIMITS } from './contracts';

export { digestOf, GENESIS };

export type TraceType =
  | 'PLAN_RECEIVED' | 'PLAN_REFUSED' | 'PLAN_ACCEPTED'
  | 'TASK_ROUTED' | 'TASK_REFUSED' | 'APPROVAL_REQUIRED' | 'APPROVAL_DECIDED' | 'APPROVAL_DECISION_REFUSED'
  | 'HANDOFF_ACCEPTED' | 'HANDOFF_BLOCKED' | 'TASK_SUCCEEDED' | 'TASK_FAILED' | 'TASK_SKIPPED' | 'RUN_SETTLED';

export interface TraceEvent extends ChainedEvent { type: TraceType }

export class Trace {
  private readonly list: TraceEvent[];

  constructor(events: readonly TraceEvent[] = []) { this.list = [...events]; }

  append(type: TraceType, at: { taskId?: string | null; agentId?: string | null; code?: string | null; detail: string }): TraceEvent {
    if (this.list.length >= LIMITS.maxTraceEvents) throw new Error('The trace is full: the run exceeded its bound');
    const prev = this.list.length ? this.list[this.list.length - 1].hash : GENESIS;
    const base = { seq: this.list.length + 1, type, taskId: at.taskId ?? null, agentId: at.agentId ?? null, code: at.code ?? null, detail: at.detail, prev };
    const event = Object.freeze({ ...base, hash: chainHash(base) });
    this.list.push(event);
    return event;
  }

  get events(): readonly TraceEvent[] { return Object.freeze([...this.list]); }
  get head(): string { return this.list.length ? this.list[this.list.length - 1].hash : GENESIS; }
}

/** Whether a trace is the chain it claims to be; the first event that is not, if any. */
export const verifyTrace = (events: readonly TraceEvent[]) => verifyChain(events);
