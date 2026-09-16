// Reading history
// ─────────────────────────────────────────────────────────────────────────────
// Two functions. One answers "what happened in this window", the other hands
// back the same rows in the order they happened so something can walk them.
//
// BOUNDED, ALWAYS
//
// There is no call here that can return the whole table. Every query takes a
// limit, the limit is clamped, and the caller continues with a cursor. A
// historical store whose API can be asked for everything is a historical store
// that will one day be asked for everything, by a UI that did not mean to, on
// the day the table is largest.
//
// THE CURSOR IS A PAIR
//
// `(occurredAt, id)`, not a timestamp. Two events inside one millisecond are
// ordinary — a squad edit emits several — and a cursor on time alone either
// replays one for ever or skips one. The pair is total and matches the index,
// so paging is a range scan rather than an offset walk that gets slower the
// deeper it goes.

import { prisma } from '../../config/database';
import type { RetentionClass } from './retention-classes';

/** The upper bound on any single page, whatever a caller asks for. */
export const HISTORY_MAX_PAGE = 200;
const HISTORY_DEFAULT_PAGE = 50;

export interface HistoryQuery {
  /** Inclusive lower bound on `occurredAt`. */
  from?: Date | null;
  /** Inclusive upper bound on `occurredAt`. */
  to?: Date | null;
  source?: string | null;
  eventType?: string | null;
  clubId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  correlationId?: string | null;
  retentionClass?: RetentionClass | null;
  limit?: number;
  /** From a previous page's `nextCursor`. */
  cursor?: string | null;
}

export interface HistoryRow {
  id: string;
  eventId: string;
  eventType: string;
  source: string;
  schemaVersion: number;
  occurredAt: string;
  persistedAt: string;
  entityType: string | null;
  entityId: string | null;
  clubId: string | null;
  teamContext: unknown;
  ageGroup: string | null;
  correlationId: string | null;
  requestId: string | null;
  status: string;
  metadata: unknown;
  privacyClassification: string;
  retentionClass: string;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Pass back as `cursor` for the next page. Null when the window is exhausted. */
  nextCursor: string | null;
  /** True when a further page exists. */
  more: boolean;
}

/** `<iso>|<id>`. Opaque to a caller, and parsed back defensively. */
export function formatHistoryCursor(occurredAt: Date, id: string): string {
  return `${occurredAt.toISOString()}|${id}`;
}

export function parseHistoryCursor(raw: string | null | undefined): { occurredAt: Date; id: string } | null {
  if (!raw) return null;
  const [iso, id] = String(raw).split('|');
  if (!iso || !id) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { occurredAt: at, id };
}

function clampLimit(value: unknown): number {
  const n = Number(value ?? HISTORY_DEFAULT_PAGE);
  if (!Number.isFinite(n)) return HISTORY_DEFAULT_PAGE;
  return Math.min(Math.max(Math.trunc(n), 1), HISTORY_MAX_PAGE);
}

/** The `where` every read here shares, built from the filters a caller gave. */
function whereFrom(query: HistoryQuery): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const range: Record<string, Date> = {};
  if (query.from instanceof Date && !Number.isNaN(query.from.getTime())) range.gte = query.from;
  if (query.to instanceof Date && !Number.isNaN(query.to.getTime())) range.lte = query.to;
  if (Object.keys(range).length) where.occurredAt = range;

  if (query.source) where.source = String(query.source);
  if (query.eventType) where.eventType = String(query.eventType);
  if (query.clubId) where.clubId = String(query.clubId);
  if (query.entityType) where.entityType = String(query.entityType);
  if (query.entityId) where.entityId = String(query.entityId);
  if (query.correlationId) where.correlationId = String(query.correlationId);
  if (query.retentionClass) where.retentionClass = String(query.retentionClass);
  return where;
}

function shape(row: Record<string, unknown>): HistoryRow {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));
  return {
    id: String(row.id),
    eventId: String(row.eventId),
    eventType: String(row.eventType),
    source: String(row.source),
    schemaVersion: Number(row.schemaVersion ?? 1),
    occurredAt: iso(row.occurredAt),
    persistedAt: iso(row.persistedAt),
    entityType: (row.entityType as string) ?? null,
    entityId: (row.entityId as string) ?? null,
    clubId: (row.clubId as string) ?? null,
    teamContext: row.teamContext ?? null,
    ageGroup: (row.ageGroup as string) ?? null,
    correlationId: (row.correlationId as string) ?? null,
    requestId: (row.requestId as string) ?? null,
    status: String(row.status ?? 'STORED'),
    metadata: row.metadata ?? null,
    privacyClassification: String(row.privacyClassification ?? 'INTERNAL'),
    retentionClass: String(row.retentionClass ?? 'OPERATIONAL'),
  };
}

/**
 * One page of history, oldest first.
 *
 * Ascending, because a historical question is asked forwards: "what happened in
 * May" reads from the first of the month. That is the opposite of the live
 * board's replay window, which is descending because it is showing you the most
 * recent of a burst — two different questions, two different orders, and each
 * says which it is.
 */
export async function queryHistory(query: HistoryQuery = {}): Promise<HistoryPage> {
  const limit = clampLimit(query.limit);
  const where = whereFrom(query);
  const after = parseHistoryCursor(query.cursor);

  if (after) {
    // Strictly after the pair, expressed as a range the composite index serves:
    // a later instant, or the same instant with a later id.
    where.OR = [
      { occurredAt: { gt: after.occurredAt } },
      { occurredAt: after.occurredAt, id: { gt: after.id } },
    ];
    // `occurredAt` may already hold the window's own bounds; the OR narrows
    // within them rather than replacing them, so both still apply.
  }

  const rows = await prisma.fabricEventHistory.findMany({
    where,
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });

  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page.map((r) => shape(r as unknown as Record<string, unknown>)),
    nextCursor: last && more ? formatHistoryCursor(last.occurredAt as Date, String(last.id)) : null,
    more,
  };
}

/** How many events a window holds, without fetching them. */
export async function countHistory(query: HistoryQuery = {}): Promise<number> {
  return prisma.fabricEventHistory.count({ where: whereFrom(query) });
}

// ── replay ───────────────────────────────────────────────────────────────────

export interface ReplayRequest extends Omit<HistoryQuery, 'limit' | 'cursor'> {
  limit?: number;
  cursor?: string | null;
}

/**
 * Named `HistoryReplayResult` rather than `ReplayResult`, which the live board's
 * own five-minute replay window already owns. Two different questions — a
 * window of the last few minutes, and a range of the last few years — and
 * conflating their names would be the first step toward conflating them.
 */
export interface HistoryReplayResult extends HistoryPage {
  /** Stated on every result, because the guarantee is the point of the feature. */
  readOnly: true;
  sideEffects: 'NONE';
}

/**
 * Replay a window of history.
 *
 * READ-ONLY EVENT RECONSTRUCTION, and nothing else. It retrieves what happened,
 * in the order it happened, and hands it back.
 *
 * WHAT IT DOES NOT DO, AND MUST NEVER DO
 *
 * Re-run a business action. Write to any table. Send an email, a notification,
 * a transfer, an AI request or anything else with a consequence. Publish an
 * event — a replay that republished would create a second history of the first
 * one and grow the store every time somebody looked at it.
 *
 * That is not a promise this comment makes; it is a property of the code. This
 * function calls `queryHistory` and returns its rows. There is no writer in
 * this module and no transport, and a test reads the source to keep it that way.
 *
 * The board's existing Replay control is unchanged by this PR. This is the
 * foundation it can be pointed at later, when somebody decides to — which is a
 * UI change and belongs in a UI change.
 */
export async function replayHistory(request: ReplayRequest = {}): Promise<HistoryReplayResult> {
  const page = await queryHistory(request);
  return { ...page, readOnly: true, sideEffects: 'NONE' };
}

/**
 * The window a historical store actually holds.
 *
 * Both ends are real reads, so an operator asking "how far back does this go"
 * gets the answer from the data rather than from a configured intention. Null
 * on both when the store is empty, which is what a platform that has just
 * deployed this genuinely knows about its own past.
 */
export async function historyWindow(): Promise<{ earliest: string | null; latest: string | null; total: number }> {
  const [first, last, total] = await Promise.all([
    prisma.fabricEventHistory.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    prisma.fabricEventHistory.findFirst({ orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
    prisma.fabricEventHistory.count(),
  ]);
  const iso = (v: { occurredAt: Date } | null) => (v ? v.occurredAt.toISOString() : null);
  return { earliest: iso(first), latest: iso(last), total };
}
