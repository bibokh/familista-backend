// The AI ledger — reservations, settlements and the switch, in PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────
// The execution gate (execution-gate.ts) decides; this file makes the decision
// atomic. A reservation is one transaction that:
//
//   1. takes one transaction-scoped advisory lock (AI_LEDGER_LOCK), the same
//      lock the owner's switch takes, so reservations and switch changes happen
//      one at a time across every process and instance;
//   2. reads the switch row and the usage the budgets count, under that lock;
//   3. asks `decide`, and writes either the STARTED record holding the
//      reservation or the REFUSED record saying why.
//
// Two calls therefore cannot both fit into the last of a budget, and a call
// admitted after the switch went OFF cannot exist. The lock is held for one
// small aggregate and one insert, never for the provider call.

import { budgetWindows, decide, IN_FLIGHT_WINDOW_MS, type AiLimits, type ReservationAsk, type UsageSnapshot, type Verdict } from './execution-gate';
import type { EgressRecord, EgressRecorder } from './gateway';

/** Every reservation and every switch change holds this. Arbitrary, fixed, and used nowhere else. */
export const AI_LEDGER_LOCK = 7_301_775_204_219_001n;

export const CONTROL_ID = 'global';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = () => (require('../../config/database') as typeof import('../../config/database')).prisma;

type Tx = Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0];

/**
 * An instant as the UTC wall-clock text the "timestamp" columns hold. Raw SQL
 * compares against this, cast to timestamp, so a session in any time zone reads
 * the same window; a Date parameter would be shifted by the session's zone.
 */
const utc = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');

async function lock(tx: Tx): Promise<void> {
  // $executeRaw: the function returns void, which a query result cannot carry.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AI_LEDGER_LOCK})`;
}

function rowData(r: EgressRecord) {
  return {
    caller: r.caller, purpose: r.purpose, clubId: r.clubId, model: r.model, provider: r.provider,
    dataClasses: r.dataClasses, pseudonymised: r.pseudonymised, outcome: r.outcome, reason: r.reason ?? null,
    reservedTokens: r.reservedTokens ?? null, reservedCostMicros: r.reservedCostMicros ?? null,
    workflowId: r.workflowId ?? null, agentRunId: r.agentRunId ?? null, agent: r.agent ?? null, origin: r.origin ?? null,
  };
}

/** The usage the budgets count, read inside the reservation lock. Same figures as `snapshotOf`. */
async function snapshot(
  tx: Tx,
  q: { clubId: string | null; workflowId: string | null; agentRunId: string | null },
  enabled: boolean,
  now: Date,
): Promise<UsageSnapshot> {
  const { day, month } = budgetWindows(now);
  const inFlightSince = new Date(now.getTime() - IN_FLIGHT_WINDOW_MS);
  const rows = await tx.$queryRaw<Array<Record<string, bigint | number>>>`
    WITH r AS (
      SELECT "createdAt", "clubId", "workflowId", "agentRunId", "outcome",
        CASE WHEN "tokensIn" IS NOT NULL OR "tokensOut" IS NOT NULL
             THEN COALESCE("tokensIn", 0) + COALESCE("tokensOut", 0)
             ELSE COALESCE("reservedTokens", 0) END AS tok,
        CASE WHEN "costMicros" IS NOT NULL THEN "costMicros" ELSE COALESCE("reservedCostMicros", 0) END AS cost
      FROM "AiEgressRecord"
      WHERE "createdAt" >= ${utc(month)}::timestamp OR "createdAt" >= ${utc(inFlightSince)}::timestamp
         OR "workflowId" = ${q.workflowId}::text OR "agentRunId" = ${q.agentRunId}::text
    )
    SELECT
      COALESCE(SUM(tok)  FILTER (WHERE "createdAt" >= ${utc(day)}::timestamp), 0)::bigint   AS "dayTokens",
      COALESCE(SUM(tok)  FILTER (WHERE "createdAt" >= ${utc(month)}::timestamp), 0)::bigint AS "monthTokens",
      COALESCE(SUM(cost) FILTER (WHERE "createdAt" >= ${utc(day)}::timestamp), 0)::bigint   AS "dayCost",
      COALESCE(SUM(cost) FILTER (WHERE "createdAt" >= ${utc(month)}::timestamp), 0)::bigint AS "monthCost",
      COALESCE(SUM(tok)  FILTER (WHERE "createdAt" >= ${utc(day)}::timestamp AND "clubId" IS NOT DISTINCT FROM ${q.clubId}::text), 0)::bigint AS "clubDayTokens",
      COALESCE(SUM(tok)  FILTER (WHERE "workflowId" = ${q.workflowId}::text), 0)::bigint AS "workflowTokens",
      COALESCE(SUM(tok)  FILTER (WHERE "agentRunId" = ${q.agentRunId}::text), 0)::bigint AS "agentRunTokens",
      COUNT(*)           FILTER (WHERE "outcome" = 'STARTED' AND "createdAt" >= ${utc(inFlightSince)}::timestamp)::bigint AS "inFlight"
    FROM r`;
  const s = rows[0] ?? {};
  const n = (k: string) => Number(s[k] ?? 0);
  return {
    enabled,
    dayTokens: n('dayTokens'), monthTokens: n('monthTokens'),
    dayCostMicros: n('dayCost'), monthCostMicros: n('monthCost'),
    clubDayTokens: n('clubDayTokens'), workflowTokens: n('workflowTokens'), agentRunTokens: n('agentRunTokens'),
    inFlight: n('inFlight'),
  };
}

/** The snapshot a reservation reads, in a transaction of its own. Read-only; the integration tests hold it to `snapshotOf`. */
export async function readUsageSnapshot(
  q: { clubId: string | null; workflowId: string | null; agentRunId: string | null },
  now: Date = new Date(),
): Promise<UsageSnapshot> {
  return db().$transaction(async (tx) => snapshot(tx, q, false, now));
}

export const prismaAiLedger: EgressRecorder = {
  async start(r) {
    const row = await db().aiEgressRecord.create({ data: rowData(r), select: { id: true } });
    return row.id;
  },

  async reserve(r, ask, limits, now = new Date()) {
    return db().$transaction(async (tx) => {
      await lock(tx);
      const control = await tx.aiExecutionControl.findUnique({ where: { id: CONTROL_ID }, select: { enabled: true } });
      const s = await snapshot(tx, { clubId: r.clubId, workflowId: ask.workflowId, agentRunId: ask.agentRunId }, control?.enabled === true, now);
      const verdict: Verdict = decide(s, ask, limits);
      if (!verdict.ok) {
        await tx.aiEgressRecord.create({ data: { ...rowData(r), outcome: 'REFUSED', reason: verdict.refusal }, select: { id: true } });
        return { refused: verdict };
      }
      const row = await tx.aiEgressRecord.create({
        data: { ...rowData(r), outcome: 'STARTED', reservedTokens: ask.tokens, reservedCostMicros: ask.costMicros },
        select: { id: true },
      });
      return { id: row.id };
    });
  },

  async finish(id, r) {
    await db().aiEgressRecord.update({
      where: { id },
      data: {
        outcome: r.outcome, reason: r.reason ?? null,
        tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null, costMicros: r.costMicros ?? null,
        durationMs: r.durationMs ?? null,
      },
    });
  },

  async executionEnabled() {
    const control = await db().aiExecutionControl.findUnique({ where: { id: CONTROL_ID }, select: { enabled: true } });
    return control?.enabled === true;
  },
};

// ── the switch ──────────────────────────────────────────────────────────────

export interface ExecutionControlState {
  enabled: boolean;
  reason: string | null;
  changedAt: string | null;
}

/** The switch as stored. No row is OFF; the caller decides what an unreadable one means (OFF). */
export async function readExecutionControl(): Promise<ExecutionControlState> {
  const row = await db().aiExecutionControl.findUnique({ where: { id: CONTROL_ID } });
  return { enabled: row?.enabled === true, reason: row?.reason ?? null, changedAt: row ? row.changedAt.toISOString() : null };
}

/**
 * Turns paid AI execution on or off. The Platform Owner's alone (the caller has
 * checked); under the ledger lock, so no reservation straddles the change; and
 * audited in the same transaction, so the change and its record stand or fall
 * together. A call already sent finishes, bounded by the provider timeout.
 */
export async function setExecutionControl(a: { enabled: boolean; reason: string; actorUserId: string }): Promise<ExecutionControlState> {
  return db().$transaction(async (tx) => {
    await lock(tx);
    const before = await tx.aiExecutionControl.findUnique({ where: { id: CONTROL_ID }, select: { enabled: true } });
    const row = await tx.aiExecutionControl.upsert({
      where: { id: CONTROL_ID },
      create: { id: CONTROL_ID, enabled: a.enabled, reason: a.reason, changedBy: a.actorUserId },
      update: { enabled: a.enabled, reason: a.reason, changedBy: a.actorUserId, changedAt: new Date() },
    });
    await tx.platformAuditLog.create({
      data: {
        userId: a.actorUserId,
        action: a.enabled ? 'AI_EXECUTION_ENABLED' : 'AI_EXECUTION_DISABLED',
        category: 'LIMITS',
        resourceType: 'AiExecutionControl',
        resourceId: CONTROL_ID,
        metadata: { enabled: a.enabled, wasEnabled: before?.enabled === true, reason: a.reason },
        message: a.reason,
      },
    });
    return { enabled: row.enabled, reason: row.reason, changedAt: row.changedAt.toISOString() };
  });
}

// ── the owner's report ──────────────────────────────────────────────────────

export interface UsageWindow {
  /** Tokens the budgets count: reported usage, and full reservations where none was reported. */
  chargedTokens: number;
  /** Provider-reported input and output tokens, for calls that reported them. */
  reportedTokensIn: number;
  reportedTokensOut: number;
  /** Estimated cost the budgets count, and the part of it from reported usage. */
  chargedCostMicros: number;
  reportedCostMicros: number;
  calls: number;
  refused: number;
}

export interface UsageReport {
  day: UsageWindow;
  month: UsageWindow;
  inFlight: number;
  /** Over the month. Grouped by the provider's model name, and by agent (or the engine that called, for non-agent calls). */
  byModel: Array<{ model: string; calls: number; tokensIn: number; tokensOut: number; costMicros: number }>;
  byAgent: Array<{ agent: string; calls: number; tokens: number; costMicros: number }>;
  /** Over the month: how many calls each rule refused. */
  refusals: Array<{ reason: string; count: number }>;
  /** The latest budget-limit refusals, newest first: when and which rule. Nothing about who or which club. */
  budgetEvents: Array<{ at: string; reason: string }>;
  /** Calls whose reported usage exceeded their reservation this month. */
  overruns: number;
}

/**
 * Platform-wide figures for the owner's room. Grouped by model, agent and
 * rule only: nothing names a club, a person or a prompt, so nothing here can
 * disclose one club's usage to anybody.
 */
export async function usageReport(budgetReasons: ReadonlyArray<string>, now: Date = new Date()): Promise<UsageReport> {
  const p = db();
  const { day, month } = budgetWindows(now);
  const inFlightSince = new Date(now.getTime() - IN_FLIGHT_WINDOW_MS);
  const windowSql = (since: Date) => p.$queryRaw<Array<Record<string, bigint | number | null>>>`
    SELECT
      COALESCE(SUM(CASE WHEN "tokensIn" IS NOT NULL OR "tokensOut" IS NOT NULL
                        THEN COALESCE("tokensIn", 0) + COALESCE("tokensOut", 0)
                        ELSE COALESCE("reservedTokens", 0) END), 0)::bigint AS "chargedTokens",
      COALESCE(SUM("tokensIn"), 0)::bigint AS "reportedTokensIn",
      COALESCE(SUM("tokensOut"), 0)::bigint AS "reportedTokensOut",
      COALESCE(SUM(CASE WHEN "costMicros" IS NOT NULL THEN "costMicros" ELSE COALESCE("reservedCostMicros", 0) END), 0)::bigint AS "chargedCost",
      COALESCE(SUM("costMicros"), 0)::bigint AS "reportedCost",
      COUNT(*) FILTER (WHERE "outcome" <> 'REFUSED')::bigint AS "calls",
      COUNT(*) FILTER (WHERE "outcome" = 'REFUSED')::bigint AS "refused"
    FROM "AiEgressRecord" WHERE "createdAt" >= ${utc(since)}::timestamp`;
  const toWindow = (rows: Array<Record<string, bigint | number | null>>): UsageWindow => {
    const s = rows[0] ?? {};
    const n = (k: string) => { const x = Number(s[k] ?? 0); return Number.isFinite(x) && x > 0 ? x : 0; };
    return {
      chargedTokens: n('chargedTokens'), reportedTokensIn: n('reportedTokensIn'), reportedTokensOut: n('reportedTokensOut'),
      chargedCostMicros: n('chargedCost'), reportedCostMicros: n('reportedCost'), calls: n('calls'), refused: n('refused'),
    };
  };

  const [dayRows, monthRows, inFlight, byModel, byAgent, refusals, events, overruns] = await Promise.all([
    windowSql(day),
    windowSql(month),
    p.aiEgressRecord.count({ where: { outcome: 'STARTED', createdAt: { gte: inFlightSince } } }),
    p.$queryRaw<Array<{ model: string; calls: bigint; tokensIn: bigint; tokensOut: bigint; cost: bigint }>>`
      SELECT COALESCE("model", '—') AS "model", COUNT(*)::bigint AS "calls",
             COALESCE(SUM("tokensIn"), 0)::bigint AS "tokensIn", COALESCE(SUM("tokensOut"), 0)::bigint AS "tokensOut",
             COALESCE(SUM(CASE WHEN "costMicros" IS NOT NULL THEN "costMicros" ELSE COALESCE("reservedCostMicros", 0) END), 0)::bigint AS "cost"
      FROM "AiEgressRecord" WHERE "createdAt" >= ${utc(month)}::timestamp AND "outcome" <> 'REFUSED'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    p.$queryRaw<Array<{ agent: string; calls: bigint; tokens: bigint; cost: bigint }>>`
      SELECT COALESCE("agent", "caller") AS "agent", COUNT(*)::bigint AS "calls",
             COALESCE(SUM(CASE WHEN "tokensIn" IS NOT NULL OR "tokensOut" IS NOT NULL
                               THEN COALESCE("tokensIn", 0) + COALESCE("tokensOut", 0)
                               ELSE COALESCE("reservedTokens", 0) END), 0)::bigint AS "tokens",
             COALESCE(SUM(CASE WHEN "costMicros" IS NOT NULL THEN "costMicros" ELSE COALESCE("reservedCostMicros", 0) END), 0)::bigint AS "cost"
      FROM "AiEgressRecord" WHERE "createdAt" >= ${utc(month)}::timestamp AND "outcome" <> 'REFUSED'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    p.$queryRaw<Array<{ reason: string; count: bigint }>>`
      SELECT COALESCE("reason", '—') AS "reason", COUNT(*)::bigint AS "count"
      FROM "AiEgressRecord" WHERE "createdAt" >= ${utc(month)}::timestamp AND "outcome" = 'REFUSED'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    p.aiEgressRecord.findMany({
      where: { outcome: 'REFUSED', reason: { in: [...budgetReasons] } },
      orderBy: { createdAt: 'desc' }, take: 20, select: { createdAt: true, reason: true },
    }),
    p.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS "n" FROM "AiEgressRecord"
      WHERE "createdAt" >= ${utc(month)}::timestamp AND "reservedTokens" IS NOT NULL
        AND COALESCE("tokensIn", 0) + COALESCE("tokensOut", 0) > "reservedTokens"`,
  ]);

  const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) && x > 0 ? x : 0; };
  const named = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  return {
    day: toWindow(dayRows),
    month: toWindow(monthRows),
    inFlight,
    // A row without its group's name is not a group: it is dropped rather than drawn as a blank.
    byModel: byModel.filter((m) => named(m.model))
      .map((m) => ({ model: m.model, calls: n(m.calls), tokensIn: n(m.tokensIn), tokensOut: n(m.tokensOut), costMicros: n(m.cost) })),
    byAgent: byAgent.filter((a) => named(a.agent))
      .map((a) => ({ agent: a.agent, calls: n(a.calls), tokens: n(a.tokens), costMicros: n(a.cost) })),
    refusals: refusals.filter((r) => named(r.reason)).map((r) => ({ reason: r.reason, count: n(r.count) })),
    budgetEvents: (Array.isArray(events) ? events : []).filter((e) => e?.createdAt instanceof Date && named(e.reason))
      .map((e) => ({ at: e.createdAt.toISOString(), reason: e.reason as string })),
    overruns: n(overruns[0]?.n),
  };
}

export type { AiLimits, ReservationAsk };
