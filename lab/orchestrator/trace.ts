// The run trace — every decision, in order, chained so none can be changed unseen
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.2 (LAB). Each event hashes the one
// before it, so editing, dropping or reordering an event breaks the chain at
// that point, and `verifyTrace` says where. Time is a sequence number, not a
// clock: the same plan over the same registry produces the same trace, byte
// for byte, which is what lets a LAB run be compared, reviewed and repeated.
// The trace holds decisions and digests, never an operation's output.

import { createHash } from 'crypto';
import { canonical } from '../../src/platform/agents/registry';
import { LIMITS, ORCHESTRATION_CONTRACT } from './contracts';

export type TraceType =
  | 'PLAN_RECEIVED' | 'PLAN_REFUSED' | 'PLAN_ACCEPTED'
  | 'TASK_ROUTED' | 'TASK_REFUSED' | 'APPROVAL_REQUIRED' | 'APPROVAL_DECIDED' | 'APPROVAL_DECISION_REFUSED'
  | 'HANDOFF_ACCEPTED' | 'HANDOFF_BLOCKED' | 'TASK_SUCCEEDED' | 'TASK_FAILED' | 'TASK_SKIPPED' | 'RUN_SETTLED';

export interface TraceEvent {
  seq: number;
  type: TraceType;
  taskId: string | null;
  agentId: string | null;
  code: string | null;
  detail: string;
  prev: string;
  hash: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const GENESIS = sha256(ORCHESTRATION_CONTRACT);

const hashOf = (e: Omit<TraceEvent, 'hash'>) =>
  sha256(`${e.prev}\n${canonical({ seq: e.seq, type: e.type, taskId: e.taskId, agentId: e.agentId, code: e.code, detail: e.detail })}`);

export class Trace {
  private readonly list: TraceEvent[];

  constructor(events: readonly TraceEvent[] = []) { this.list = [...events]; }

  append(type: TraceType, at: { taskId?: string | null; agentId?: string | null; code?: string | null; detail: string }): TraceEvent {
    if (this.list.length >= LIMITS.maxTraceEvents) throw new Error('The trace is full: the run exceeded its bound');
    const prev = this.list.length ? this.list[this.list.length - 1].hash : GENESIS;
    const base = { seq: this.list.length + 1, type, taskId: at.taskId ?? null, agentId: at.agentId ?? null, code: at.code ?? null, detail: at.detail, prev };
    const event = Object.freeze({ ...base, hash: hashOf(base) });
    this.list.push(event);
    return event;
  }

  get events(): readonly TraceEvent[] { return Object.freeze([...this.list]); }
  get head(): string { return this.list.length ? this.list[this.list.length - 1].hash : GENESIS; }
}

/** Whether a trace is the chain it claims to be; the first event that is not, if any. */
export function verifyTrace(events: readonly TraceEvent[]): { ok: boolean; brokenAt: number | null } {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1 || e.prev !== prev || e.hash !== hashOf(e)) return { ok: false, brokenAt: i + 1 };
    prev = e.hash;
  }
  return { ok: true, brokenAt: null };
}

export const digestOf = (value: unknown) => sha256(canonical(value));
