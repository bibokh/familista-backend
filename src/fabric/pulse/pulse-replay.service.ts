// Replaying what already moved, from the record rather than from memory
// ─────────────────────────────────────────────────────────────────────────────
// LIVE reads the in-process ring buffer, which is bounded and dies with the
// process. REPLAY reads `EventOutbox`, which is the actual durable record, and
// produces the SAME frame shape — so the visualiser has one renderer and one
// inspector, and switching mode changes where frames come from and nothing
// else.
//
// That shared shape is the whole design decision here. A replay that returned a
// different object would have grown a second projection, and a second
// projection is a second place for a payload to escape from.
//
// WHY THIS IS NOT AN ANALYTICS ENGINE
//
// One query, one bounded window, one page, ordered by time, capped. No
// aggregation, no rollups, no time bucketing, no retention policy of its own.
// The brief asks for the client to be architected so replay can arrive later;
// this is the smallest server side that makes that true, and it deliberately
// stops there.
//
// LEGACY ROWS
//
// The outbox also holds pre-envelope rows written by `big-data/publisher` under
// `OutboxKind` names — `MATCH_EVENT`, `SENSOR_PACKET`. Those are real platform
// activity and they are shown, mapped through the taxonomy's own
// `canonicalNameForLegacyKind` so one occurrence keeps one name. What is NOT
// done is reading their payloads: a legacy row has no envelope, so its frame is
// built from the row's own columns and its payload is never opened.

import { prisma } from '../../config/database';
import { canonicalNameForLegacyKind } from '../event-taxonomy';
import { eventFromRow, isFabricRow } from '../outbox-transport';
import {
  destinationLaneFor, project, sourceLaneFor, type PulseFrame,
} from './pulse.service';

/** The windows the interface offers. Minutes. */
export const REPLAY_WINDOWS = Object.freeze([1, 5, 15]);

/** Never return more than this, whatever is asked for. */
export const REPLAY_MAX = 500;

export interface ReplayQuery {
  /** How far back, in minutes. Clamped to a day. */
  minutes?: number;
  /** Explicit range, when the interface offers "custom". Overrides `minutes`. */
  from?: Date | null;
  to?: Date | null;
  limit?: number;
}

export interface ReplayResult {
  frames: PulseFrame[];
  from: string;
  to: string;
  /** True when the cap was hit and older frames in the window were not returned. */
  truncated: boolean;
  /** Rows in the window that predate the envelope and were mapped by kind. */
  legacyCount: number;
}

/**
 * A frame for a row written before the canonical envelope existed.
 *
 * Built entirely from columns — id, kind, clubId, createdAt — because a legacy
 * row's `payload` is an arbitrary producer bag with no schema and no
 * classification, and opening it here would put unclassified content into the
 * one surface that promised not to carry any. So the frame says what kind of
 * thing happened and when, and nothing about what it contained.
 */
function frameFromLegacyRow(row: {
  id: string; clubId: string | null; kind: string; createdAt: Date;
  source: string | null; processedAt: Date | null; failedAt: Date | null;
}): PulseFrame {
  const eventType = canonicalNameForLegacyKind(row.kind) ?? `legacy.${String(row.kind || 'unknown').toLowerCase()}`;
  const at = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  return {
    eventId: row.id,
    eventType,
    schemaVersion: 1,
    occurredAt: at.toISOString(),
    recordedAt: at.toISOString(),
    // A legacy row records one timestamp, so the gap between happening and
    // being written down is genuinely unknown rather than zero.
    latencyMs: null,
    clubId: row.clubId ?? null,
    teamId: null,
    subjectType: null,
    subjectId: null,
    sourceType: 'SERVICE',
    correlationId: null,
    causationId: null,
    // Unknown, so treated as the most sensitive thing it could be. A legacy
    // sensor or match row may well carry personal data.
    dataClassification: 'RESTRICTED',
    source: sourceLaneFor(eventType),
    destination: destinationLaneFor(eventType),
    registered: !!canonicalNameForLegacyKind(row.kind),
    status: row.failedAt ? 'FAILED' : row.processedAt ? 'PROCESSED' : 'STORED',
  };
}

const DAY_MINUTES = 24 * 60;

/**
 * The frames from one window of the real record, oldest first.
 *
 * Ordered ascending on return so the client can animate them in the order they
 * happened, but SELECTED descending and reversed — otherwise a window with more
 * rows than the cap would return the oldest and silently omit what just
 * happened, which is the opposite of what somebody watching a replay wants.
 */
export async function replayWindow(query: ReplayQuery = {}): Promise<ReplayResult> {
  const to = query.to instanceof Date ? query.to : new Date();
  const minutes = Math.min(Math.max(Number(query.minutes ?? 5), 1), DAY_MINUTES);
  const from = query.from instanceof Date ? query.from : new Date(to.getTime() - minutes * 60_000);
  const limit = Math.min(Math.max(Number(query.limit ?? REPLAY_MAX), 1), REPLAY_MAX);

  const rows = await prisma.eventOutbox.findMany({
    where: { createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      id: true, clubId: true, kind: true, payload: true, source: true,
      createdAt: true, idempotencyKey: true, processedAt: true, failedAt: true,
    },
  });

  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;

  let legacyCount = 0;
  const frames: PulseFrame[] = [];

  for (const row of page) {
    if (isFabricRow(row.payload)) {
      const event = eventFromRow(row);
      if (!event) continue;   // a row whose envelope will not parse is skipped, not guessed at
      frames.push(project(event, row.failedAt ? 'FAILED' : row.processedAt ? 'PROCESSED' : 'STORED'));
    } else {
      legacyCount += 1;
      frames.push(frameFromLegacyRow(row));
    }
  }

  frames.reverse();
  return { frames, from: from.toISOString(), to: to.toISOString(), truncated, legacyCount };
}

/**
 * Outbox processing counts for the window — or an honest absence.
 *
 * `processedAt` and `failedAt` exist as columns and nothing in Familista sets
 * them, so a count of "0 failed" would be a statement about the column rather
 * than about the platform. This returns null for any counter whose column is
 * uniformly unset across the window, and the interface says "Not instrumented
 * yet" for those.
 */
export async function replayCounts(query: ReplayQuery = {}): Promise<{
  total: number; processed: number | null; failed: number | null; pending: number | null;
}> {
  const to = query.to instanceof Date ? query.to : new Date();
  const minutes = Math.min(Math.max(Number(query.minutes ?? 5), 1), DAY_MINUTES);
  const from = query.from instanceof Date ? query.from : new Date(to.getTime() - minutes * 60_000);
  const where = { createdAt: { gte: from, lte: to } };

  const [total, processed, failed] = await Promise.all([
    prisma.eventOutbox.count({ where }),
    prisma.eventOutbox.count({ where: { ...where, processedAt: { not: null } } }),
    prisma.eventOutbox.count({ where: { ...where, failedAt: { not: null } } }),
  ]);

  // Nothing marks these, so all-zero means "no consumer exists" rather than
  // "everything is fine". Reported as unknown until one of them is ever set.
  const instrumented = processed > 0 || failed > 0;
  return {
    total,
    processed: instrumented ? processed : null,
    failed: instrumented ? failed : null,
    pending: instrumented ? Math.max(total - processed - failed, 0) : null,
  };
}
