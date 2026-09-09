// The fabric, stored in the outbox Familista already has
// ─────────────────────────────────────────────────────────────────────────────
// One implementation of `EventTransport`, over `EventOutbox`. It is the only
// file in the fabric that knows Postgres exists.
//
// WHY THE ENVELOPE LIVES IN `payload` RATHER THAN IN COLUMNS
//
// The obvious move is to add twelve columns to `EventOutbox`. It is the wrong
// one, for now. `EventOutbox` is live: match events, fusion packets, AI alerts
// and sensor packets are written to it in production today, and every one of
// those rows would get twelve nulls it can never fill. More importantly, a
// column set is a schema commitment — changing it later is a migration on a
// table that by then holds millions of rows.
//
// So the envelope is stored whole, under a reserved key, inside the `payload`
// column that already exists, and the columns the table DOES have are populated
// so existing queries and indexes keep working: `clubId` for tenancy, `kind`
// for the type, `idempotencyKey` for deduplication, `source` for provenance,
// `createdAt` for arrival. A reader that knows nothing about the fabric sees a
// well-formed outbox row. A reader that does gets the full envelope.
//
// The cost is that `occurredAt` and `teamId` are not indexable today. That is
// acceptable while the fabric is young and the volumes are small, and the fix
// when it stops being acceptable is a migration that promotes the hot fields to
// columns — with this file as the only thing that changes.
//
// DEDUPLICATION IS THE DATABASE'S JOB
//
// `EventOutbox.idempotencyKey` is `@unique`. A duplicate append does not race,
// does not check-then-write, and does not depend on the caller: it hits the
// index and comes back as a constraint violation, which this file reports as
// `DUPLICATE`. That is the property a device on a flaky link needs, and it is
// the reason the key is derived from the occurrence rather than the arrival.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import type { AppendOutcome, EventQuery, EventTransport } from './event-bus';
import type { FamilistaEvent } from './event-envelope';
import { serialiseEvent } from './event-envelope';

/** The key the whole envelope is stored under, inside the payload column. */
export const ENVELOPE_KEY = '__familista_event';

/** Recognise a row this transport wrote, as opposed to a legacy outbox row. */
export function isFabricRow(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && ENVELOPE_KEY in (payload as object);
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2002';
  const msg = (err as Error)?.message ?? '';
  return msg.includes('Unique constraint') || msg.includes('idempotencyKey');
}

/**
 * Rebuild an event from a stored row.
 *
 * Tolerant on purpose. A row written by a future build may carry fields this
 * one has never heard of, and a row written by an older build may be missing
 * ones added since — neither may break a historical read. Unknown fields are
 * preserved as they are; missing ones get the value they would have had.
 */
export function eventFromRow(row: {
  id: string; clubId: string | null; kind: string; payload: unknown;
  source: string | null; createdAt: Date; idempotencyKey: string | null;
}): FamilistaEvent | null {
  const payload = row.payload as Record<string, unknown> | null;
  const stored = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)[ENVELOPE_KEY] as Record<string, unknown> | undefined
    : undefined;

  if (!stored) {
    // A legacy row — a match event, a sensor packet — written before the
    // envelope existed or by a producer that still uses `publishMatchEvent`.
    // It is projected into the envelope rather than skipped, so one reader can
    // read the whole log. Nothing is invented: the fields the old row cannot
    // answer come back null, and `occurredAt` falls back to arrival time
    // because arrival is genuinely all that row recorded.
    return {
      eventId: row.id,
      eventType: row.kind,
      schemaVersion: 0,
      occurredAt: row.createdAt,
      recordedAt: row.createdAt,
      clubId: row.clubId,
      teamId: null,
      actorUserId: null,
      subjectType: null,
      subjectId: null,
      sourceType: 'SERVICE',
      sourceId: row.source,
      correlationId: null,
      causationId: null,
      jurisdiction: null,
      dataClassification: 'INTERNAL',
      payload: row.payload,
      metadata: { legacyOutboxRow: true },
      idempotencyKey: row.idempotencyKey ?? row.id,
    };
  }

  const date = (v: unknown, fallback: Date): Date => {
    if (v instanceof Date) return v;
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return fallback;
  };

  return {
    ...(stored as unknown as FamilistaEvent),
    eventId: String(stored.eventId ?? row.id),
    eventType: String(stored.eventType ?? row.kind),
    schemaVersion: Number(stored.schemaVersion ?? 1),
    occurredAt: date(stored.occurredAt, row.createdAt),
    recordedAt: date(stored.recordedAt, row.createdAt),
    // The COLUMN is authoritative for tenancy, not the payload: the column is
    // what the query filtered on, and a payload that disagreed with it would be
    // a way to read one club's event through another club's filter.
    clubId: row.clubId,
    idempotencyKey: row.idempotencyKey ?? String(stored.idempotencyKey ?? row.id),
  };
}

export class OutboxEventTransport implements EventTransport {
  readonly name = 'OUTBOX';

  async append(event: FamilistaEvent): Promise<AppendOutcome> {
    try {
      await prisma.eventOutbox.create({
        data: {
          // Tenancy in the column the index is on. An event with no club is a
          // platform event and is stored with none — it is not smuggled into
          // some club's stream by a default.
          clubId: event.clubId,
          matchId: event.subjectType === 'MATCH' ? event.subjectId : null,
          kind: event.eventType,
          topic: event.eventType,
          idempotencyKey: event.idempotencyKey,
          source: event.sourceId ? `${event.sourceType}:${event.sourceId}` : event.sourceType,
          payload: { [ENVELOPE_KEY]: serialiseEvent(event) } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return 'STORED';
    } catch (err) {
      // The unique index did its job. The fact is on record from the first
      // attempt, so this is a success the caller may want to count, not an
      // error it needs to handle.
      if (isUniqueViolation(err)) return 'DUPLICATE';
      throw err;
    }
  }

  async read(query: EventQuery): Promise<FamilistaEvent[]> {
    const where: Prisma.EventOutboxWhereInput = { clubId: query.clubId };
    if (query.eventTypes?.length) where.kind = { in: query.eventTypes };
    if (query.since || query.until) {
      where.createdAt = {
        ...(query.since ? { gte: query.since } : {}),
        ...(query.until ? { lte: query.until } : {}),
      };
    }

    const rows = await prisma.eventOutbox.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? 100, 1000),
      select: {
        id: true, clubId: true, kind: true, payload: true,
        source: true, createdAt: true, idempotencyKey: true,
      },
    });

    let events = rows
      .map((r) => eventFromRow(r))
      .filter((e): e is FamilistaEvent => !!e);

    // Subject filtering happens here rather than in SQL because the subject
    // lives in the envelope rather than in a column. It is a filter over one
    // page, never over the table, so it cannot become a sequential scan.
    if (query.subjectType) events = events.filter((e) => e.subjectType === query.subjectType);
    if (query.subjectId) events = events.filter((e) => e.subjectId === query.subjectId);

    // The tenancy guarantee, restated where it is cheapest to check. The query
    // already filtered on the column; this refuses anything that somehow got
    // past it rather than trusting that it could not.
    return events.filter((e) => e.clubId === query.clubId);
  }
}

export const outboxTransport = new OutboxEventTransport();
