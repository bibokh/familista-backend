// Historical aggregates — counted by the database, never by a browser
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL
//
// The Data Vault asks four questions the existing history API could only answer
// by shipping rows: how many events are there, how many arrived today, which
// sources hold them, and when did each source first and last say something.
//
// A client could compute every one of those by paging the table and counting in
// JavaScript. That is exactly the design this store was built to avoid. At ten
// thousand rows it works, at ten million it downloads a database into a laptop,
// and the day it stops working is the day somebody is looking at an incident.
//
// So aggregation lives here, in SQL, on the indexes the store already has:
//
//   `(source, occurredAt)`  serves the per-source rollup and its today window
//   `(clubId, occurredAt)`  serves the per-club summary
//   `(occurredAt)`          serves the calendar buckets
//
// Every function below is a fixed, small number of aggregate queries whose cost
// does not grow with the answer. None of them returns a row of history.
//
// WHAT IS NOT HERE
//
// No payload, no entity ids, no event bodies. These are counts and timestamps.
// The redaction boundary in `history-record.ts` is upstream of this file — the
// columns it never wrote cannot be aggregated here — and nothing in this module
// reaches past the columns the historical table actually holds.
//
// NO INVENTED ACTIVITY
//
// A source with no historical rows reports `total: 0` and `earliest: null`. A
// measured zero and an absent figure are different answers and are returned as
// different values, so the interface can draw `0` where it means none and `—`
// where it means unknown. Nothing here estimates, extrapolates or fills a gap.

import { prisma } from '../../config/database';
import { fabricSources } from '../registry/source-registry';
import { fabricEventsForSource } from '../registry/event-registry';

/** One source's historical footprint. Counted, never sampled. */
export interface SourceHistoryStat {
  /**
   * The registry's source id. This is the value the historical `source` column
   * holds — `history-record.ts` stores the event spec's `source`, and that is
   * the id (`clubs`), not the display name (`Clubs`). Filtering the history API
   * by anything else returns nothing, so the id is what travels.
   */
  source: string;
  /** The label to draw. Registry metadata, so the UI keeps no second list. */
  name: string;
  icon: string | null;
  category: string | null;
  /** How many event types the registry declares for this source. */
  registeredEventTypes: number;
  /** How many of those the build actually publishes. */
  producedEventTypes: number;
  /** Historical rows. A real zero when the source has never been recorded. */
  total: number;
  /** Rows since 00:00 UTC today. */
  today: number;
  /** The first and last instant this source is recorded at, or null. */
  earliest: string | null;
  latest: string | null;
}

export interface HistoryStats {
  /** Every historical row the store holds. */
  total: number;
  /** Calendar buckets, all UTC. See `boundsUtc`. */
  today: number;
  month: number;
  year: number;
  /** The real window, from the data. Null on both ends when the store is empty. */
  window: { earliest: string | null; latest: string | null };
  /** One entry per REGISTERED source, whether or not it has ever been recorded. */
  sources: SourceHistoryStat[];
  /** Sources holding history that the registry no longer declares. */
  unregisteredSources: { source: string; total: number }[];
  /** When this answer was computed, so a stale panel can say so. */
  generatedAt: string;
}

/**
 * The UTC day, month and year that contain `now`.
 *
 * UTC deliberately, and stated rather than assumed. The store's `occurredAt` is
 * `timestamptz`, the owner reading this dashboard may be in any zone, and a
 * bucket whose boundary moved with the reader would make two people disagree
 * about how many events happened "today". The interface renders these instants
 * in the reader's locale; the arithmetic stays in one zone.
 */
export function boundsUtc(now: Date = new Date()): {
  dayStart: Date; monthStart: Date; yearStart: Date;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return {
    dayStart: new Date(Date.UTC(y, m, d, 0, 0, 0, 0)),
    monthStart: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
    yearStart: new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0)),
  };
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
const count = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number((v as { _all?: number })?._all ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Everything the Data Vault Overview and Sources sections need, in five
 * aggregate queries.
 *
 * Five, and not one per source: a `groupBy` over an indexed column answers the
 * whole rollup in a single pass, where a loop would issue one query per source
 * and grow every time somebody registers another.
 */
export async function historyStats(now: Date = new Date()): Promise<HistoryStats> {
  const { dayStart, monthStart, yearStart } = boundsUtc(now);

  const [total, today, month, year, bySource, bySourceToday] = await Promise.all([
    prisma.fabricEventHistory.count(),
    prisma.fabricEventHistory.count({ where: { occurredAt: { gte: dayStart } } }),
    prisma.fabricEventHistory.count({ where: { occurredAt: { gte: monthStart } } }),
    prisma.fabricEventHistory.count({ where: { occurredAt: { gte: yearStart } } }),
    prisma.fabricEventHistory.groupBy({
      by: ['source'],
      _count: { _all: true },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    }),
    prisma.fabricEventHistory.groupBy({
      by: ['source'],
      where: { occurredAt: { gte: dayStart } },
      _count: { _all: true },
    }),
  ]);

  type Grouped = {
    source: string;
    _count?: { _all?: number } | number;
    _min?: { occurredAt?: Date | null };
    _max?: { occurredAt?: Date | null };
  };

  const rollup = new Map<string, Grouped>();
  for (const row of (bySource ?? []) as Grouped[]) rollup.set(String(row.source), row);

  const todayBy = new Map<string, number>();
  for (const row of (bySourceToday ?? []) as Grouped[]) {
    todayBy.set(String(row.source), count(row._count));
  }

  // The registry is the source list — the interface never keeps its own. A
  // source registered tomorrow appears here with a real zero and no code
  // change, which is the property the Sources section is required to have.
  const registered = fabricSources();
  const sources: SourceHistoryStat[] = registered.map((s) => {
    const hit = rollup.get(s.id);
    const types = fabricEventsForSource(s.id);
    return {
      source: s.id,
      name: s.name,
      icon: s.icon ?? null,
      category: s.category ?? null,
      registeredEventTypes: types.length,
      producedEventTypes: types.filter((e) => e.produced).length,
      total: hit ? count(hit._count) : 0,
      today: todayBy.get(s.id) ?? 0,
      earliest: hit ? iso(hit._min?.occurredAt) : null,
      latest: hit ? iso(hit._max?.occurredAt) : null,
    };
  });

  // A source the registry has since dropped, whose history remains. Reported
  // rather than silently excluded: those rows exist and somebody should be able
  // to see that they do.
  const known = new Set(registered.map((s) => s.id));
  const unregisteredSources = [...rollup.values()]
    .filter((r) => !known.has(String(r.source)))
    .map((r) => ({ source: String(r.source), total: count(r._count) }))
    .sort((a, b) => b.total - a.total);

  // The window comes from the rollup that has already been computed rather than
  // from two more reads: the smallest `_min` and the largest `_max` across
  // every source IS the store's window, so asking again would be a third query
  // for an answer already in hand.
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const r of rollup.values()) {
    const lo = r._min?.occurredAt ?? null;
    const hi = r._max?.occurredAt ?? null;
    if (lo instanceof Date && (!earliest || lo < earliest)) earliest = lo;
    if (hi instanceof Date && (!latest || hi > latest)) latest = hi;
  }

  return {
    total,
    today,
    month,
    year,
    window: { earliest: iso(earliest), latest: iso(latest) },
    sources,
    unregisteredSources,
    generatedAt: new Date().toISOString(),
  };
}

export interface ClubHistorySummary {
  clubId: string;
  total: number;
  earliest: string | null;
  latest: string | null;
  /** Which sources hold this club's history, largest first. */
  sources: { source: string; total: number; earliest: string | null; latest: string | null }[];
}

/**
 * One club's historical footprint.
 *
 * Two aggregates on `(clubId, occurredAt)`. A club with no recorded history
 * returns zero and two nulls — an empty club, honestly reported, rather than an
 * error or an invented first event.
 *
 * This does not decide WHO may ask. Authorization is the route's, as it is for
 * every other historical read: a `clubId` filter narrows a platform owner's
 * view and is not a boundary.
 */
export async function clubHistorySummary(clubId: string): Promise<ClubHistorySummary> {
  const id = String(clubId ?? '').slice(0, 64);
  if (!id) return { clubId: '', total: 0, earliest: null, latest: null, sources: [] };

  const [agg, bySource] = await Promise.all([
    prisma.fabricEventHistory.aggregate({
      where: { clubId: id },
      _count: { _all: true },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    }),
    prisma.fabricEventHistory.groupBy({
      by: ['source'],
      where: { clubId: id },
      _count: { _all: true },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    }),
  ]);

  type Agg = { _count?: { _all?: number } | number; _min?: { occurredAt?: Date | null }; _max?: { occurredAt?: Date | null } };
  const a = (agg ?? {}) as Agg;

  const sources = ((bySource ?? []) as (Agg & { source: string })[])
    .map((r) => ({
      source: String(r.source),
      total: count(r._count),
      earliest: iso(r._min?.occurredAt),
      latest: iso(r._max?.occurredAt),
    }))
    .sort((x, y) => y.total - x.total);

  return {
    clubId: id,
    total: count(a._count),
    earliest: iso(a._min?.occurredAt),
    latest: iso(a._max?.occurredAt),
    sources,
  };
}

/**
 * The entity kinds the historical store can actually be asked about.
 *
 * Derived from what is RECORDED, not from a wish list. `history-record.ts`
 * withholds the id of any subject kind the platform does not treat as safe to
 * name, so a `PLAYER` row carries `entityType: 'PLAYER'` and a null
 * `entityId` — and an Entity History search for a player id would always be
 * empty. Offering it would be offering a lookup that cannot succeed.
 *
 * So this reports both facts per kind: that the type appears in history, and
 * whether it is searchable by id. The interface can then list a kind and say
 * plainly why one of them cannot be looked up individually.
 */
export async function entityTypesInHistory(): Promise<
  { entityType: string; total: number; idSearchable: boolean }[]
> {
  const rows = await prisma.fabricEventHistory.groupBy({
    by: ['entityType'],
    _count: { _all: true },
  });

  type Row = { entityType: string | null; _count?: { _all?: number } | number };
  const out: { entityType: string; total: number; idSearchable: boolean }[] = [];

  for (const r of (rows ?? []) as Row[]) {
    if (!r.entityType) continue;
    out.push({ entityType: String(r.entityType), total: count(r._count), idSearchable: false });
  }

  // Which of them ever carried an id. One more grouped read, over the rows that
  // have one, so "searchable" is a measured property of the data rather than a
  // second copy of the allow-list that could drift from it.
  const withIds = await prisma.fabricEventHistory.groupBy({
    by: ['entityType'],
    where: { entityId: { not: null } },
    _count: { _all: true },
  });
  const searchable = new Set(
    ((withIds ?? []) as Row[]).map((r) => String(r.entityType ?? '')).filter(Boolean),
  );
  for (const row of out) row.idSearchable = searchable.has(row.entityType);

  return out.sort((a, b) => b.total - a.total);
}
