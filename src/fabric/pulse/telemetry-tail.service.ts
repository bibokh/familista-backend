// Tailing product telemetry, so the board shows people as well as records
// ─────────────────────────────────────────────────────────────────────────────
// `EventOutbox` answers "what did the platform record". It cannot answer "is
// anyone using it right now", because a person can read every screen in
// Familista for an hour and write nothing. A board fed only by domain events
// therefore sits dark through a busy afternoon, which is the opposite of what a
// live view is for.
//
// So there is a second tail, over `AnalyticsEvent` — the product-telemetry
// table that already existed, with its own ingest route, its own sanitiser and
// its own retention. This module reads it the same way the outbox tail reads
// the outbox, and hands the same `PulseFrame` shape to the same renderer.
//
// TWO TAILS, ONE STREAM, AND WHY THEY STAY SEPARATE
//
// A domain event is a FACT that must never be lost: it carries an idempotency
// key, a classification and a correlation id, and it is written once and kept.
// A telemetry event is a SIGNAL: high volume, aggregate by construction, and
// worth nothing individually. Forcing the second through the first's table
// would pay a unique-index write per pointer window and drop unclassified
// interaction data into the table domain consumers read.
//
// They are merged at the point of display, not at the point of storage, and
// each carries its own cursor so neither can hold the other up.
//
// THE ORDERING IS THE SAME PROBLEM, BUT NOT THE SAME CLOCK
//
// The outbox tail walks `createdAt`, which Postgres assigns at insert. This
// table has TWO times and they are not interchangeable:
//
//   `occurredAt`  when it happened, by the BROWSER's clock
//   `recordedAt`  when it was stored, by the DATABASE's clock
//
// The tail walks `recordedAt`, and the reason is a bug this cost a production
// afternoon to find. `public/analytics.js` batches for five seconds before it
// posts, so every row is stored 0-5s after the instant it names; and two
// devices disagree about that instant by whatever their clocks disagree by. A
// cursor on `occurredAt` only moves forward, so ANY batch arriving after a row
// that bears a later client timestamp is skipped — and skipped permanently.
//
// In practice that meant: the tab watching the board emitted a continuous
// pointer stream which kept pushing the cursor to its own newest timestamp,
// and every sparse, always-late event from a SECOND device — a navigation, for
// instance — landed behind it and was never seen. Live showed the watcher's own
// mouse and nothing anybody else did.
//
// `recordedAt` is one clock, the database's, monotonic across every Render
// instance in a way a Node-side `new Date()` would not be. The composite
// `(recordedAt, id)` and the lexicographic predicate are then the same keyset
// reasoning as the outbox: a cursor on time alone either repeats a row for ever
// or skips one.
//
// Replay keeps asking `occurredAt`, because "what happened between 10:00 and
// 10:05" is a question about when things happened, not about when they were
// filed.
//
// WHAT NEVER REACHES A FRAME
//
// `AnalyticsEvent` has no column for content — see `contracts.ts`, where
// `ALLOWED_FIELDS` is an allow-list of fourteen names and `sanitize` drops
// everything else before a row is written. So the honest statement is not
// "this module redacts": it is that there is nothing here to redact. The frame
// carries the module key, the feature key, the route SHAPE, the role and the
// tenant ids, and those are the whole of what the table holds.

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import type { PulseFrame } from './pulse.service';
import { resolveSubjects } from './subject-resolver.service';

/**
 * A position in the telemetry table, as a pair.
 *
 * `recordedAt`, NOT `occurredAt` — see the note at the top of this file. The
 * field is named for the column it walks so that nobody reading a cursor has to
 * remember which of the two times it means.
 */
export interface TelemetryCursor {
  recordedAt: Date;
  id: string;
}

/** How many rows one telemetry poll may take. */
export const TELEMETRY_BATCH = 200;

export function formatTelemetryCursor(cursor: TelemetryCursor | null): string | null {
  return cursor ? `${cursor.recordedAt.toISOString()}|${cursor.id}` : null;
}

export function parseTelemetryCursor(value: string | null | undefined): TelemetryCursor | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const at = raw.lastIndexOf('|');
  if (at <= 0) return null;
  const when = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);
  if (Number.isNaN(when.getTime()) || !id) return null;
  return { recordedAt: when, id };
}

/**
 * Which lane on the left a telemetry event starts in.
 *
 * Telemetry is a person doing something, so almost all of it starts at `Users`.
 * The exceptions are the events a person did not cause: a client error or a
 * dropped connection is the platform reporting on itself, and starts at
 * `System` — putting those in `Users` would make an outage look like activity.
 */
const TELEMETRY_SOURCE: Record<string, string> = {
  api_error: 'System', client_error: 'System', reconnected: 'System', offline: 'System',
};

/**
 * Which lane on the right it travels to, by what genuinely consumes it.
 *
 * `Analytics` for the signals that feed the daily rollups — which is most of
 * them, because that is what this table is for. `Audit` for the authentication
 * boundary, because "who signed in and when" is a record rather than a trend.
 */
const TELEMETRY_DESTINATION: Record<string, string> = {
  login_succeeded: 'Audit', login_failed: 'Audit', logout: 'Audit', session_expired: 'Audit',
  api_error: 'Audit', client_error: 'Audit',
};

/**
 * The broad kind a reader filters the activity feed by.
 *
 * Deliberately coarser than the event name: nine categories a person can hold
 * in their head, against forty names they cannot.
 */
export type TelemetryCategory =
  | 'AUTH' | 'NAV' | 'UI' | 'ACTION' | 'POINTER' | 'SCROLL' | 'HOVER' | 'SYSTEM';

/**
 * These eight words are also the eight the board draws, spelled identically.
 *
 * `public/data-pulse.js` derives the same category on the client, because a
 * frame is filtered there and a round trip to ask the server what kind of thing
 * it just received would be absurd. Two derivations of one concept must at
 * least agree on its vocabulary, so the strings here and the chip labels there
 * are the same strings — `tests/data-pulse.unit.test.ts` pins the pair.
 *
 * WHERE THE LINE BETWEEN `UI` AND `ACTION` IS
 *
 * `UI` is a SURFACE changing — a tab, a panel, a modal, a card opening. Nothing
 * about the club is different afterwards. `ACTION` is somebody DOING something
 * — invoking a named action, changing a filter, saving, moving a player. The
 * distinction is what lets an owner filter to "people are changing things" and
 * not drown in "people are looking at things".
 */
const CATEGORY: Record<string, TelemetryCategory> = {
  login_succeeded: 'AUTH', login_failed: 'AUTH', logout: 'AUTH', session_expired: 'AUTH',
  session_started: 'AUTH', session_ended: 'AUTH',

  route_changed: 'NAV', workspace_changed: 'NAV',
  club_entered: 'NAV', club_exited: 'NAV', page_viewed: 'NAV',
  module_opened: 'NAV', module_closed: 'NAV',
  club_opened: 'NAV', team_opened: 'NAV',

  tab_changed: 'UI',
  panel_opened: 'UI', panel_closed: 'UI',
  modal_opened: 'UI', modal_closed: 'UI',
  menu_opened: 'UI', player_card_opened: 'UI', match_card_opened: 'UI',
  form_started: 'UI',

  pointer_active: 'POINTER',
  scroll_depth: 'SCROLL',
  region_dwell: 'HOVER',

  api_error: 'SYSTEM', client_error: 'SYSTEM', reconnected: 'SYSTEM', offline: 'SYSTEM',
};

export function telemetryCategory(eventName: string): TelemetryCategory {
  return CATEGORY[eventName] ?? 'ACTION';
}

export function telemetrySourceLane(eventName: string): string {
  return TELEMETRY_SOURCE[eventName] ?? 'Users';
}

export function telemetryDestinationLane(eventName: string): string {
  return TELEMETRY_DESTINATION[eventName] ?? 'Analytics';
}

/**
 * How sensitive a telemetry frame is.
 *
 * `INTERNAL` throughout, and that is a statement about the table rather than a
 * default: a row here cannot contain content, so no telemetry event can be
 * CONFIDENTIAL. Authentication is the one that carries a little more weight —
 * knowing who signed in and failed is worth marking — so it is CONFIDENTIAL and
 * the board colours it accordingly.
 */
function classificationFor(category: TelemetryCategory): string {
  return category === 'AUTH' ? 'CONFIDENTIAL' : 'INTERNAL';
}

const TELEMETRY_SELECT = {
  id: true, eventName: true, occurredAt: true, recordedAt: true, sessionId: true,
  userId: true, platformRole: true, clubId: true, teamId: true,
  module: true, feature: true, route: true, durationMs: true,
  deviceCategory: true, source: true, schemaVersion: true,
} as const;

/** The newest telemetry row that exists, as a cursor. */
export async function latestTelemetryCursor(): Promise<TelemetryCursor | null> {
  const [row] = await prisma.analyticsEvent.findMany({
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { id: true, recordedAt: true },
  });
  return row ? { recordedAt: row.recordedAt, id: row.id } : null;
}

/**
 * One telemetry row, as a frame the board already knows how to draw.
 *
 * Built by hand, field by field, exactly as the domain projection is. The row
 * cannot carry content, but writing it out rather than spreading it keeps that
 * true the day somebody adds a column.
 */
export function frameFromTelemetryRow(row: Record<string, unknown>): PulseFrame {
  const eventName = String(row.eventName ?? 'unknown');
  const category = telemetryCategory(eventName);
  const at = row.occurredAt instanceof Date ? row.occurredAt : new Date(String(row.occurredAt));
  const iso = Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
  // Stored time, which is a different fact from happened time — and now that
  // the two are both kept, the gap between them is the ingest lag the client's
  // five-second batching creates. That lag was invisible before, which is part
  // of why a cursor walking the wrong one went unnoticed.
  const rec = row.recordedAt instanceof Date ? row.recordedAt : (row.recordedAt ? new Date(String(row.recordedAt)) : at);
  const recIso = Number.isNaN(rec.getTime()) ? iso : rec.toISOString();
  const lag = Number.isNaN(rec.getTime()) || Number.isNaN(at.getTime())
    ? null
    : Math.max(0, rec.getTime() - at.getTime());

  return {
    eventId: String(row.id ?? ''),
    // Namespaced so a telemetry name can never collide with a domain event
    // type, and so a reader can tell at a glance which stream a row came from.
    eventType: `ui.${eventName}`,
    schemaVersion: Number(row.schemaVersion ?? 1),
    occurredAt: iso,
    recordedAt: recIso,
    // Real, not invented: how long the event sat in the browser's queue before
    // it reached the database. A clock-skewed client can make this meaningless
    // for one row, which is why it is a displayed number and never an ordering
    // key.
    latencyMs: lag,
    clubId: row.clubId ? String(row.clubId) : null,
    teamId: row.teamId ? String(row.teamId) : null,
    // The ACTOR's kind, never the actor. A role is a category; a user id is a
    // person, and this board is not a way to follow one around the product.
    subjectType: row.platformRole ? String(row.platformRole) : 'USER',
    subjectId: null,
    sourceType: 'USER',
    // The session ties one person's actions together for the length of a visit
    // without naming them. It is already not a credential — see the model.
    correlationId: row.sessionId ? String(row.sessionId) : null,
    causationId: null,
    dataClassification: classificationFor(category),
    source: telemetrySourceLane(eventName),
    destination: telemetryDestinationLane(eventName),
    registered: true,
    status: 'OBSERVED',
    clubLabel: null,
    subjectLabel: null,
    // The module and feature KEYS — a catalogue value and a region name, never
    // text from a screen. This is what lets the feed say "Squad depth 50%".
    changedFields: [
      row.module ? `module:${String(row.module)}` : null,
      row.feature ? `feature:${String(row.feature)}` : null,
      row.route ? `route:${String(row.route)}` : null,
      row.durationMs != null ? `durationMs:${Number(row.durationMs)}` : null,
    ].filter((v): v is string => v !== null),
  };
}

/**
 * Every telemetry row strictly after the cursor, oldest first.
 *
 * Same keyset predicate as the outbox tail, served by
 * `AnalyticsEvent_recordedAt_id_idx`. With no cursor this returns nothing
 * rather than everything, for the same reason: a tail that defaulted to the
 * beginning of time would replay the table on its first poll.
 */
export async function telemetryAfter(
  cursor: TelemetryCursor | null,
  limit = TELEMETRY_BATCH,
): Promise<{ rows: Array<Record<string, unknown>>; cursor: TelemetryCursor | null; more: boolean }> {
  if (!cursor) return { rows: [], cursor: null, more: false };

  const take = Math.min(Math.max(limit, 1), TELEMETRY_BATCH);
  const rows = await prisma.analyticsEvent.findMany({
    where: {
      OR: [
        { recordedAt: { gt: cursor.recordedAt } },
        { recordedAt: cursor.recordedAt, id: { gt: cursor.id } },
      ],
    },
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    take: take + 1,
    select: TELEMETRY_SELECT,
  });

  const more = rows.length > take;
  const page = more ? rows.slice(0, take) : rows;
  const last = page[page.length - 1];

  return {
    rows: page as unknown as Array<Record<string, unknown>>,
    cursor: last ? { recordedAt: last.recordedAt as Date, id: last.id as string } : cursor,
    more,
  };
}

/**
 * One telemetry tail step: read, convert, report where to continue.
 *
 * Never throws. A failed poll leaves the cursor untouched, so the next tick
 * asks for exactly the same rows — and a telemetry outage must not be able to
 * take the domain stream down with it.
 */
export async function telemetryStep(
  cursor: TelemetryCursor | null,
  limit = TELEMETRY_BATCH,
): Promise<{ frames: PulseFrame[]; cursor: TelemetryCursor | null; more: boolean }> {
  try {
    const { rows, cursor: next, more } = await telemetryAfter(cursor, limit);
    if (!rows.length) return { frames: [], cursor: next, more: false };

    const frames = rows.map(frameFromTelemetryRow);
    // Club names only. A telemetry frame has no person to resolve — that is
    // the point — but knowing WHICH club is being used is most of the value.
    await resolveSubjects(frames);
    return { frames, cursor: next, more };
  } catch (err) {
    logger.warn('[pulse] telemetry tail step failed; the cursor is unchanged', {
      err: (err as Error).message,
    });
    return { frames: [], cursor, more: false };
  }
}

/**
 * Who is active right now, counted from the table rather than guessed.
 *
 * Distinct sessions and distinct users inside a short window. Returned as
 * `null` when the read fails, because a dashboard that shows 0 active users
 * during an outage is worse than one that admits it does not know.
 */
export async function activeCounts(windowMs = 5 * 60_000): Promise<{
  activeUsers: number | null; activeSessions: number | null;
}> {
  try {
    const since = new Date(Date.now() - windowMs);
    const rows = await prisma.analyticsEvent.findMany({
      where: { occurredAt: { gte: since } },
      select: { userId: true, sessionId: true },
      take: 5_000,
    });
    const users = new Set<string>();
    const sessions = new Set<string>();
    for (const r of rows) {
      if (r.userId) users.add(r.userId);
      if (r.sessionId) sessions.add(r.sessionId);
    }
    return { activeUsers: users.size, activeSessions: sessions.size };
  } catch (err) {
    logger.warn('[pulse] could not count active users', { err: (err as Error).message });
    return { activeUsers: null, activeSessions: null };
  }
}
