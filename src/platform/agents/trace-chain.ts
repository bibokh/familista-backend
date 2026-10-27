// The orchestration trace's hash chain — one rule for whoever writes or checks it
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence. The LAB orchestrator (lab/orchestrator/trace.ts)
// chains every event it records to the one before it; the server checks the
// same chain when it reads published LAB evidence (orchestration-evidence.ts).
// Both use this file, so a trace the Lab wrote is verified by exactly the rule
// it was written with. Pure: no clock, no I/O.

import { createHash } from 'crypto';
import { canonical } from './registry';

/** The plan contract a trace belongs to; its hash is the chain's first `prev`. */
export const ORCHESTRATION_CONTRACT = 'familista.orchestration/v1' as const;

export interface ChainedEvent {
  seq: number;
  type: string;
  taskId: string | null;
  agentId: string | null;
  code: string | null;
  detail: string;
  prev: string;
  hash: string;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const GENESIS = sha256(ORCHESTRATION_CONTRACT);

/** The hash of an event: its fields, in canonical form, after the previous event's hash. */
export const chainHash = (e: Omit<ChainedEvent, 'hash'>): string =>
  sha256(`${e.prev}\n${canonical({ seq: e.seq, type: e.type, taskId: e.taskId, agentId: e.agentId, code: e.code, detail: e.detail })}`);

/** Whether a trace is the chain it claims to be; the first event that is not, if any. */
export function verifyChain(events: readonly ChainedEvent[]): { ok: boolean; brokenAt: number | null } {
  return verifyChainFrom(events, GENESIS);
}

/** The same rule for a chain with a genesis of its own (AI-0.4's execution log starts from its contract's hash). */
export function verifyChainFrom(events: readonly ChainedEvent[], genesis: string): { ok: boolean; brokenAt: number | null } {
  let prev = genesis;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1 || e.prev !== prev || e.hash !== chainHash(e)) return { ok: false, brokenAt: i + 1 };
    prev = e.hash;
  }
  return { ok: true, brokenAt: null };
}

export const digestOf = (value: unknown): string => sha256(canonical(value));
