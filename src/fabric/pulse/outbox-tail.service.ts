// Tailing the outbox, so Live is the database and not this process's memory
// ─────────────────────────────────────────────────────────────────────────────
// The bug this replaces was architectural, not a typo. Live was fed by
// `subscribe('*')` on the in-process event bus, so a frame only reached the
// screen when the `emit()` that produced it happened inside the SAME Node
// process as the open SSE connection. On a service with more than one instance
// — or one that restarted between the save and the watch — those are different
// processes, and the subscriber was simply never called. Two real
// `player.updated` rows sat in Postgres while the panel said the platform was
// idle.
//
// So Live now reads the same thing Replay reads: `EventOutbox`. The row is the
// truth, it is written by whichever instance served the request, and any
// instance can see it.
//
//   Replay  = a historical window,        ordered ascending by (createdAt, id)
//   Live    = everything after a cursor,  ordered ascending by (createdAt, id)
//
// One table, one projection, one ordering. The only difference is where the
// window starts and whether it keeps asking.
//
// WHY THE CURSOR IS A PAIR AND NOT A TIMESTAMP
//
// `createdAt` is `timestamp(3)`. A player update emits `player.updated` and
// `player.photo.attached` inside the same millisecond, so a cursor of
// "createdAt > t" would either replay one of them for ever or skip one,
// depending on which side of the comparison it fell. The cursor is therefore
// the composite `(createdAt, id)` and the predicate is the lexicographic
// "greater than that pair", which is total: no two rows share both.
//
// WHY IT SEEDS AT THE END
//
// Opening the panel seeds the cursor at `MAX(createdAt, id)` — the newest row
// that already exists — so history does NOT come flooding down the traces the
// moment the screen opens. Old rows are Replay's job. Live means "after I
// started watching", and a screen that animated ten minutes of backlog on open
// would be lying about what is happening now.
//
// WHAT THIS IS NOT
//
// Not a queue, not a consumer group, not a work claim. Nothing here marks a row
// processed or takes a lock; several owners can tail the same table at once and
// none of them affects the others or the rows. It is a read.

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { canonicalNameForLegacyKind } from '../event-taxonomy';
import { eventFromRow, isFabricRow } from '../outbox-transport';
import {
  destinationLaneFor, project, sourceLaneFor, type PulseFrame,
} from './pulse.service';
import { resolveSubjects } from './subject-resolver.service';

/**
 * A position in the outbox, as a pair.
 *
 * Serialised for the wire as `<iso>|<id>` so a reconnecting client can hand
 * back exactly where it stopped. Both halves are non-secret: a timestamp and a
 * row id.
 */
export interface OutboxCursor {
  createdAt: Date;
  id: string;
}

/** How many rows one tail poll may take. Bounded so a burst cannot flood. */
export const TAIL_BATCH = 200;

/** How often the server asks. One second is the visual-latency target. */
export const TAIL_INTERVAL_MS = 1_000;

export function formatCursor(cursor: OutboxCursor | null): string | null {
  return cursor ? `${cursor.createdAt.toISOString()}|${cursor.id}` : null;
}

/** Parse a cursor from a client. Null for anything unparseable — never throws. */
export function parseCursor(value: string | null | undefined): OutboxCursor | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const at = raw.lastIndexOf('|');
  if (at <= 0) return null;
  const when = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);
  if (Number.isNaN(when.getTime()) || !id) return null;
  return { createdAt: when, id };
}

/** The columns a frame is built from. Never `payload` beyond the envelope. */
const TAIL_SELECT = {
  id: true, clubId: true, kind: true, payload: true, source: true,
  createdAt: true, idempotencyKey: true, processedAt: true, failedAt: true,
} as const;

/**
 * The newest row that exists, as a cursor.
 *
 * Ordered by the same pair the tail advances on, so "where Live starts" and
 * "where Live continues" are the same expression and cannot drift apart.
 */
export async function latestCursor(): Promise<OutboxCursor | null> {
  const [row] = await prisma.eventOutbox.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { id: true, createdAt: true },
  });
  return row ? { createdAt: row.createdAt, id: row.id } : null;
}

/**
 * Every row strictly after the cursor, oldest first.
 *
 * The predicate is the lexicographic pair comparison, written as Prisma's OR of
 * "a later millisecond" and "the same millisecond, a later id". Postgres serves
 * it from `EventOutbox_createdAt_id_idx`.
 *
 * With no cursor this returns nothing rather than everything. A tail that
 * defaulted to the beginning of time would replay the whole table on the first
 * poll, which is precisely the flood the seed exists to prevent.
 */
export async function tailAfter(
  cursor: OutboxCursor | null,
  limit = TAIL_BATCH,
): Promise<{ rows: Array<Record<string, unknown>>; cursor: OutboxCursor | null; more: boolean }> {
  if (!cursor) return { rows: [], cursor: null, more: false };

  const take = Math.min(Math.max(limit, 1), TAIL_BATCH);
  const rows = await prisma.eventOutbox.findMany({
    where: {
      OR: [
        { createdAt: { gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: take + 1,
    select: TAIL_SELECT,
  });

  const more = rows.length > take;
  const page = more ? rows.slice(0, take) : rows;
  const last = page[page.length - 1];

  return {
    rows: page as unknown as Array<Record<string, unknown>>,
    // Advance only as far as was actually read. A cursor moved past unread
    // rows loses them silently, which is the one failure a tail must not have.
    cursor: last ? { createdAt: last.createdAt as Date, id: last.id as string } : cursor,
    more,
  };
}

/**
 * A frame for a row written before the canonical envelope existed.
 *
 * Built from columns only: a legacy row's `payload` is an arbitrary producer
 * bag with no schema and no classification, so opening it would put
 * unclassified content into the one surface that promised not to carry any.
 */
function frameFromLegacyRow(row: Record<string, unknown>): PulseFrame {
  const kind = String(row.kind ?? '');
  const eventType = canonicalNameForLegacyKind(kind) ?? `legacy.${(kind || 'unknown').toLowerCase()}`;
  const at = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt));
  return {
    eventId: String(row.id ?? ''),
    eventType,
    schemaVersion: 1,
    occurredAt: at.toISOString(),
    recordedAt: at.toISOString(),
    latencyMs: null,
    clubId: row.clubId ? String(row.clubId) : null,
    teamId: null,
    subjectType: null,
    subjectId: null,
    sourceType: 'SERVICE',
    correlationId: null,
    causationId: null,
    // Unknown, so treated as the most sensitive thing it could be.
    dataClassification: 'RESTRICTED',
    source: sourceLaneFor(eventType),
    destination: destinationLaneFor(eventType),
    registered: !!canonicalNameForLegacyKind(kind),
    status: row.failedAt ? 'FAILED' : row.processedAt ? 'PROCESSED' : 'STORED',
    subjectLabel: null,
    clubLabel: null,
    changedFields: [],
  };
}

/** The status a row's own columns report. */
function statusOf(row: Record<string, unknown>): string {
  return row.failedAt ? 'FAILED' : row.processedAt ? 'PROCESSED' : 'STORED';
}

/**
 * Rows → frames, the one conversion Live and Replay share.
 *
 * Subject labels are resolved in ONE batched read for the whole page rather
 * than per row, so a burst of two hundred events is two queries and not four
 * hundred.
 */
export async function framesFromRows(rows: Array<Record<string, unknown>>): Promise<PulseFrame[]> {
  const frames: PulseFrame[] = [];

  for (const row of rows) {
    if (isFabricRow(row.payload)) {
      const event = eventFromRow(row as never);
      if (!event) continue;   // an envelope that will not parse is skipped, not guessed at
      frames.push(project(event, statusOf(row)));
    } else {
      frames.push(frameFromLegacyRow(row));
    }
  }

  await resolveSubjects(frames);
  return frames;
}

/**
 * One tail step: read, convert, report where to continue.
 *
 * Deliberately a single step rather than a loop. The caller decides the cadence
 * and can stop between steps, which is what makes this safe to drive from an
 * SSE connection that may close at any moment.
 */
export async function tailStep(
  cursor: OutboxCursor | null,
  limit = TAIL_BATCH,
): Promise<{ frames: PulseFrame[]; cursor: OutboxCursor | null; more: boolean }> {
  try {
    const { rows, cursor: next, more } = await tailAfter(cursor, limit);
    if (!rows.length) return { frames: [], cursor: next, more: false };
    return { frames: await framesFromRows(rows), cursor: next, more };
  } catch (err) {
    // A failed poll must not close the stream. The cursor is unchanged, so the
    // next tick asks for exactly the same rows and nothing is lost.
    logger.warn('[pulse] outbox tail step failed; the cursor is unchanged', {
      err: (err as Error).message,
    });
    return { frames: [], cursor, more: false };
  }
}
