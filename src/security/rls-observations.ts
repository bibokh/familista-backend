// What the RLS rollout has observed in this process (Cyber Defense, R14)
// ─────────────────────────────────────────────────────────────────────────────
// With DB_RLS_CONTEXT at `observe` or `on`, a query on a pilot table that runs
// with no database context is logged once per model and operation
// (config/database.ts). The log is where an operator reads it; this keeps the
// same record in memory so the Cybersecurity Command Center can show it too.
//
// It records a MODEL name and an OPERATION name, and when it was first seen —
// never a query, an argument, a club, a user or a value. It changes nothing
// about how queries run; recording can never throw into the query path.
// Per process and since start: a restart begins a new observation window, and
// the Command Center says so.

export interface RlsObservation { model: string; operation: string; firstSeenAt: string }

const startedAt = new Date().toISOString();
const seen = new Map<string, RlsObservation>();
const MAX = 500;

export function noteRlsObservation(model: string, operation: string): void {
  try {
    const key = `${model}.${operation}`;
    if (seen.has(key) || seen.size >= MAX) return;
    seen.set(key, { model: String(model), operation: String(operation), firstSeenAt: new Date().toISOString() });
  } catch (_) { /* observation is never allowed to fail a query */ }
}

/** Every pilot-table query shape seen without a context, oldest first. */
export function rlsObservations(): RlsObservation[] {
  return [...seen.values()];
}

/** When this process began observing. */
export function rlsObservationWindowStart(): string { return startedAt; }

/** Tests only. */
export function resetRlsObservations(): void { seen.clear(); }
