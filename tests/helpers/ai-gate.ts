/**
 * Test helpers for the AI execution gate (src/platform/intelligence/execution-gate.ts).
 *
 *   asUser(id, fn)   runs fn as an authenticated API request, the origin the
 *                    gateway requires; without one every call is refused
 *   memoryLedger()   an EgressRecorder in memory with the same rules as the
 *                    PostgreSQL ledger: one reservation at a time (a mutex in
 *                    place of the advisory lock), the switch read inside it,
 *                    and the budgets computed by snapshotOf + decide
 */
import type { Request, Response } from 'express';
import { aiRequestScope, decide, snapshotOf, type LedgerRow } from '../../src/platform/intelligence/execution-gate';
import type { EgressRecord, EgressRecorder } from '../../src/platform/intelligence/gateway';

export function asUser<T>(userId: string | null, fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = { user: userId ? { id: userId } : undefined } as unknown as Request;
    aiRequestScope(req, {} as Response, () => { Promise.resolve().then(fn).then(resolve, reject); });
  });
}

export type MemoryRow = EgressRecord & LedgerRow & { id: string };

export interface MemoryLedger extends EgressRecorder {
  rows: MemoryRow[];
  enabled: boolean;
  down: boolean;
  /** How many reservations were inside the critical section at once, at most. Must stay 1. */
  maxOverlap: number;
}

export function memoryLedger(init: { enabled?: boolean; now?: () => Date } = {}): MemoryLedger {
  let chain: Promise<unknown> = Promise.resolve();
  let inside = 0;
  const now = init.now ?? (() => new Date());
  const row = (r: EgressRecord, id: string): MemoryRow => ({
    ...r, id, createdAt: now(), clubId: r.clubId ?? null, workflowId: r.workflowId ?? null, agentRunId: r.agentRunId ?? null,
    tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null, reservedTokens: r.reservedTokens ?? null,
    costMicros: r.costMicros ?? null, reservedCostMicros: r.reservedCostMicros ?? null,
  });
  const ledger: MemoryLedger = {
    rows: [],
    enabled: init.enabled ?? false,
    down: false,
    maxOverlap: 0,
    async start(r) {
      if (ledger.down) throw new Error('ledger down');
      const id = `rec-${ledger.rows.length + 1}`;
      ledger.rows.push(row(r, id));
      return id;
    },
    reserve(r, ask, limits) {
      const run = async () => {
        inside += 1; ledger.maxOverlap = Math.max(ledger.maxOverlap, inside);
        try {
          if (ledger.down) throw new Error('ledger down');
          // Yield inside the critical section, as a database round trip would: a
          // missing lock would let a second reservation read the same snapshot.
          await new Promise((res) => setImmediate(res));
          const s = snapshotOf(ledger.rows, { clubId: r.clubId, workflowId: ask.workflowId, agentRunId: ask.agentRunId }, ledger.enabled, now());
          const v = decide(s, ask, limits);
          const id = `rec-${ledger.rows.length + 1}`;
          if (!v.ok) { ledger.rows.push(row({ ...r, outcome: 'REFUSED', reason: v.refusal }, id)); return { refused: v }; }
          ledger.rows.push(row({ ...r, outcome: 'STARTED', reservedTokens: ask.tokens, reservedCostMicros: ask.costMicros }, id));
          return { id };
        } finally { inside -= 1; }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
    async finish(id, r) {
      const x = ledger.rows.find((y) => y.id === id);
      if (x) Object.assign(x, r);
    },
    async executionEnabled() {
      if (ledger.down) throw new Error('ledger down');
      return ledger.enabled;
    },
  };
  return ledger;
}

/** A price for the test model names the suites register. */
export const TEST_PRICING = JSON.stringify({
  'test-model': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  x: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  y: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
});
