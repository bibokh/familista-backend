// Watching real events move, without becoming a way to read them
// ─────────────────────────────────────────────────────────────────────────────
// Data Pulse is an observability surface, not a query API. It answers "is the
// platform alive, and what is moving through it right now" — and it must answer
// that without becoming a second, unguarded route to the contents of an event.
//
// So there are two hard rules here, and the rest of the file is their
// consequences.
//
// ONE · A PULSE IS A SHAPE, NOT A PAYLOAD
//
// `project()` builds a frame from an ALLOW-LIST of envelope fields. It never
// touches `payload` and never touches `metadata` — not redacted, not
// summarised, not key-counted. Those two are where a producer puts the actual
// content, and an allow-list that starts with "everything except" is an
// allow-list that leaks the day somebody adds a field. A frame carries names,
// ids, times and classifications; that is enough to draw a moving dot and to
// inspect what kind of thing moved.
//
// TWO · NOTHING HERE IS INVENTED
//
// Every number this module reports is counted from something that happened. A
// metric it cannot compute is returned as `null` and the interface says "Not
// instrumented yet" — never 0, because 0 is a measurement and "I do not know"
// is not. The distinction matters most for the metrics that look easiest:
// `failed` and `pending` describe the outbox's own processing state, which
// nothing currently sets, so they are honestly absent rather than dishonestly
// zero.
//
// WHY A RING BUFFER AND NOT A TABLE
//
// The buffer is bounded and in-process. It is deliberately NOT durable: this is
// a live view, and making it durable would mean a second copy of every event's
// metadata, in a second place, with its own retention question. Replay reads
// the outbox — the real record — which is why `replayWindow` exists below and
// why LIVE and REPLAY can share one frame shape.
//
// LOAD
//
// A visualiser must not be able to hurt the thing it is watching. The subscriber
// is synchronous and does no I/O; frames are handed to listeners in batches on
// a fixed tick rather than one call per event, so a burst of a thousand events
// costs one flush rather than a thousand; and when a burst exceeds what a
// browser can draw, frames are SAMPLED and the frame count that was skipped is
// reported, so the screen says "showing 1 in 4" instead of quietly lying.

import { logger } from '../../utils/logger';
import { isRegisteredEventType } from '../event-taxonomy';
import type { FamilistaEvent } from '../event-envelope';

// ── what a pulse looks like on the wire ──────────────────────────────────────

/**
 * One event, reduced to what may safely be shown.
 *
 * Every field is either a name, an identifier, a timestamp or a classification.
 * There is no field here whose value is content a user typed or a producer
 * measured — see rule one above.
 */
export interface PulseFrame {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  recordedAt: string;
  /** recordedAt − occurredAt, in ms. How long the platform took to write it down. */
  latencyMs: number | null;
  clubId: string | null;
  teamId: string | null;
  subjectType: string | null;
  /** Only for subject kinds where an id is not itself personal. See `SAFE_SUBJECT_IDS`. */
  subjectId: string | null;
  sourceType: string;
  correlationId: string | null;
  causationId: string | null;
  dataClassification: string;
  /** Which lane on the left the dot starts in. Derived from the type's domain. */
  source: string;
  /** Which lane on the right it travels to. Derived from what really consumes it. */
  destination: string;
  /** False for a name this build does not know — drawn, but marked unknown. */
  registered: boolean;
  /** `STORED` or `DUPLICATE`. A frame only exists for an event that persisted. */
  status: string;

  // ── the three fields that make a frame readable ───────────────────────────
  //
  // Added deliberately and narrowly. Everything above is a name, an id, a time
  // or a classification; these three are the smallest additions that turn "a
  // player was updated somewhere" into an answer, and each is bounded:

  /** The club's name. Filled server-side from `clubId`. */
  clubLabel: string | null;
  /** The subject's name — a player's, a team's, a club's. Never an id. */
  subjectLabel: string | null;
  /**
   * WHICH fields changed, by name. Never their values.
   *
   * The producer already writes only field names into this payload key — see
   * `emitPlayerEvent` — so allow-listing the key by name cannot surface a
   * value. A date of birth's NAME is not a date of birth.
   */
  changedFields: string[];

  /**
   * The subject id, for the label lookup, and stripped before the wire.
   *
   * Present on the object between `project()` and `resolveSubjects()` and
   * `delete`d there, so a person's identifier is used server-side and never
   * serialised. Optional in the type because a frame that has reached a client
   * does not have it.
   */
  resolveId?: string;
}

/**
 * Subject kinds whose id may travel to the visualiser.
 *
 * A club or team id is an opaque tenant identifier the owner already sees
 * everywhere in SYSTEM. A USER or PLAYER id identifies a person, and a medical
 * record id identifies a person's medical record — so those are withheld even
 * from the platform owner, because "the owner could look it up anyway" is an
 * argument for using the screen that has an access log, not for putting
 * personal identifiers into a firehose that has none.
 */
const SAFE_SUBJECT_IDS = new Set(['CLUB', 'TEAM', 'COMPETITION', 'FIXTURE', 'MATCH', 'PLATFORM', 'PLATFORM_SECRET', 'MODEL', 'DATASET']);

// ── the lanes, derived from what actually exists ─────────────────────────────

/**
 * The left-hand lane for an event type, by its domain prefix.
 *
 * A map rather than a guess, so a type with no home is `System` instead of a
 * lane invented from the first word of its name.
 */
const SOURCE_LANE: Record<string, string> = {
  club: 'Clubs', membership: 'Users', user: 'Users',
  player: 'Players', training: 'Training', attendance: 'Training',
  match: 'Matches', transfer: 'Transfers', medical: 'Medical',
  media: 'Media', ai: 'AI', model: 'AI',
  device: 'System', telemetry: 'System', camera: 'System', secret: 'System',
};

/**
 * The right-hand lane, by what genuinely consumes the event today.
 *
 * This map is the part of the visualiser most at risk of becoming a lie, so it
 * is derived from the taxonomy's own classification and domain rather than from
 * a wish. `Operational Data` means the event describes a change to a row that
 * the application already reads back. `Audit` means its value is the record
 * that it happened. `Media` means an object store holds the bytes. `Analytics`
 * appears only for events something actually aggregates.
 */
const DESTINATION_LANE: Record<string, string> = {
  club: 'Audit', membership: 'Audit', user: 'Audit', secret: 'Audit',
  device: 'Audit', camera: 'Audit',
  player: 'Operational Data', training: 'Operational Data', attendance: 'Operational Data',
  match: 'Operational Data', transfer: 'Operational Data', medical: 'Operational Data',
  media: 'Media',
  ai: 'Analytics', model: 'Analytics', telemetry: 'Analytics',
};

/** Lanes that exist as architecture but consume nothing. Drawn as FUTURE. */
export const FUTURE_DESTINATIONS = Object.freeze([
  'ML Pipeline', 'Feature Store', 'Data Lake', 'Cameras', 'GPS', 'Edge',
]);

export const SOURCE_LANES = Object.freeze([
  'Clubs', 'Users', 'Players', 'Training', 'Matches',
  'Transfers', 'Medical', 'Media', 'AI', 'System',
]);

export const LIVE_DESTINATIONS = Object.freeze(['Operational Data', 'Media', 'Audit', 'Analytics']);

function domainOf(eventType: string): string {
  return String(eventType ?? '').split('.')[0] ?? '';
}

export function sourceLaneFor(eventType: string): string {
  return SOURCE_LANE[domainOf(eventType)] ?? 'System';
}

export function destinationLaneFor(eventType: string): string {
  return DESTINATION_LANE[domainOf(eventType)] ?? 'Audit';
}

// ── the safe projection ──────────────────────────────────────────────────────

function iso(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/**
 * Build a frame from an event.
 *
 * Written as an explicit field list, and it must stay that way. A spread of the
 * event with deletions would ship every field a future producer adds; this
 * ships exactly the fields somebody chose to ship.
 *
 * Never throws. A malformed event still produces a drawable frame, because the
 * alternative is that one bad producer takes the owner's live view down.
 */
export function project(event: FamilistaEvent, status = 'STORED'): PulseFrame {
  const eventType = String(event?.eventType ?? 'unknown');
  const occurredAt = iso(event?.occurredAt);
  const recordedAt = iso(event?.recordedAt);
  const latency = new Date(recordedAt).getTime() - new Date(occurredAt).getTime();
  const subjectType = event?.subjectType ? String(event.subjectType) : null;

  return {
    eventId: String(event?.eventId ?? ''),
    eventType,
    schemaVersion: Number(event?.schemaVersion ?? 1),
    occurredAt,
    recordedAt,
    // Negative would mean a producer's clock is ahead of the server's. Reported
    // as unknown rather than as a negative duration nobody can interpret.
    latencyMs: Number.isFinite(latency) && latency >= 0 ? latency : null,
    clubId: event?.clubId ? String(event.clubId) : null,
    teamId: event?.teamId ? String(event.teamId) : null,
    subjectType,
    subjectId: subjectType && SAFE_SUBJECT_IDS.has(subjectType) && event?.subjectId
      ? String(event.subjectId)
      : null,
    sourceType: String(event?.sourceType ?? 'SERVICE'),
    correlationId: event?.correlationId ? String(event.correlationId) : null,
    causationId: event?.causationId ? String(event.causationId) : null,
    dataClassification: String(event?.dataClassification ?? 'INTERNAL'),
    source: sourceLaneFor(eventType),
    destination: destinationLaneFor(eventType),
    registered: isRegisteredEventType(eventType),
    status,

    // Resolved later, in one batched read for the whole page.
    clubLabel: null,
    subjectLabel: null,
    // ONE key, by name, and only its strings. Not a spread, not a filter over
    // whatever the payload happens to contain.
    changedFields: changedFieldNames(event),
    // Server-side only. `resolveSubjects` deletes it.
    resolveId: event?.subjectId ? String(event.subjectId) : undefined,
  };
}

/**
 * The `changedFields` array, if the producer supplied one.
 *
 * Reads exactly that key, accepts only strings, caps the count and the length
 * of each name. A producer that put a value in there would still surface a
 * string — so the cap is what keeps a mistake to a truncated field name rather
 * than a paragraph of notes.
 */
function changedFieldNames(event: FamilistaEvent): string[] {
  const payload = event?.payload as Record<string, unknown> | null | undefined;
  const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).changedFields : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string')
    .slice(0, 24)
    .map((v) => v.slice(0, 40));
}

// ── the bounded live buffer ──────────────────────────────────────────────────

/** Frames kept for a client that has just connected. Small on purpose. */
export const BUFFER_LIMIT = 300;

/** How often batched frames are handed to listeners. */
export const FLUSH_MS = 250;

/** Above this many frames per flush, frames are sampled rather than all sent. */
export const SAMPLE_THRESHOLD = 40;

export interface PulseBatch {
  frames: PulseFrame[];
  /** How many frames the window actually held, before sampling. */
  observed: number;
  /** 1 means every frame; 4 means one in four. */
  sampling: number;
}

export type PulseListener = (batch: PulseBatch) => void;

const buffer: PulseFrame[] = [];
const listeners = new Set<PulseListener>();
let pending: PulseFrame[] = [];
let timer: NodeJS.Timeout | null = null;
let running = false;
/** eventIds already buffered, so a re-read from a cursor cannot double-count. */
const ingested = new Set<string>();
const ingestedOrder: string[] = [];

/** Every frame the platform has produced since this process started. */
let totalFrames = 0;
/** Recorded arrival times, for the rate windows. Trimmed to one minute. */
const arrivals: number[] = [];
/** clubId → last time that club produced an event. */
const clubsSeen = new Map<string, number>();
/** Observed write-down latencies, bounded, for the average. */
const latencies: number[] = [];

const MINUTE = 60_000;

function trim(now: number): void {
  while (arrivals.length && now - arrivals[0] > MINUTE) arrivals.shift();
  for (const [club, at] of clubsSeen) if (now - at > MINUTE) clubsSeen.delete(club);
  while (latencies.length > BUFFER_LIMIT) latencies.shift();
}

function flush(): void {
  timer = null;
  if (!pending.length) return;

  const observed = pending.length;
  // Sample rather than drop silently. A visualiser that quietly discards half
  // a burst is showing a rate it is not measuring.
  const sampling = observed > SAMPLE_THRESHOLD ? Math.ceil(observed / SAMPLE_THRESHOLD) : 1;
  const frames = sampling === 1 ? pending : pending.filter((_, i) => i % sampling === 0);
  pending = [];

  const batch: PulseBatch = { frames, observed, sampling };
  for (const listener of listeners) {
    try { listener(batch); } catch (err) {
      logger.warn('[pulse] listener threw', { err: (err as Error).message });
    }
  }
}

function record(frame: PulseFrame): void {
  const now = Date.now();
  totalFrames += 1;
  arrivals.push(now);
  if (frame.clubId) clubsSeen.set(frame.clubId, now);
  if (frame.latencyMs != null) latencies.push(frame.latencyMs);
  trim(now);

  buffer.push(frame);
  while (buffer.length > BUFFER_LIMIT) buffer.shift();

  pending.push(frame);
  if (!timer) {
    timer = setTimeout(flush, FLUSH_MS);
    // Never hold the process open for a visualiser.
    timer.unref?.();
  }
}

/**
 * Open the buffer for business.
 *
 * There used to be a `subscribe('*')` here, and it was the bug: a frame only
 * reached the screen when the `emit()` that made it ran in THIS process, so on
 * a multi-instance service the owner watched an idle map while another instance
 * served the writes. Live now comes from the outbox tail — see
 * `outbox-tail.service.ts` — and this module is the buffer and the metrics over
 * whatever the tail hands it.
 *
 * The bus subscription is not kept alongside the tail. Two sources would
 * deliver every same-process event twice and, worse, would make the screen
 * appear to work in single-instance testing while still failing in production.
 */
export function startPulse(): void {
  running = true;
}

export function stopPulse(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  pending = [];
}

export function isPulseRunning(): boolean {
  return running;
}

/**
 * Take a page of frames from the tail.
 *
 * The one way a frame enters the buffer. Deduped on `eventId` here as well as
 * in the browser: a reconnect re-reads from a cursor the client supplied, and
 * two owners watching at once must not make one event two.
 */
export function ingestFrames(frames: PulseFrame[]): PulseFrame[] {
  const fresh: PulseFrame[] = [];
  for (const frame of frames) {
    if (!frame?.eventId || ingested.has(frame.eventId)) continue;
    ingested.add(frame.eventId);
    ingestedOrder.push(frame.eventId);
    record(frame);
    fresh.push(frame);
  }
  while (ingestedOrder.length > BUFFER_LIMIT * 4) {
    const id = ingestedOrder.shift();
    if (id) ingested.delete(id);
  }
  return fresh;
}

/** Listen for batched frames. Returns an unsubscribe. */
export function onPulse(listener: PulseListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The recent frames a newly connected client is caught up with. */
export function recentFrames(limit = 60): PulseFrame[] {
  const n = Math.min(Math.max(limit, 1), BUFFER_LIMIT);
  return buffer.slice(-n);
}

/** Tests, and a deliberate reset. */
export function resetPulse(): void {
  stopPulse();
  listeners.clear();
  ingested.clear();
  ingestedOrder.length = 0;
  buffer.length = 0;
  arrivals.length = 0;
  latencies.length = 0;
  clubsSeen.clear();
  totalFrames = 0;
}

/** Flush now instead of on the tick. Tests, and a client that just connected. */
export function flushNow(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  flush();
}

// ── metrics, every one of them counted ───────────────────────────────────────

/**
 * A measured number, or an honest absence.
 *
 * `null` means "not instrumented yet" and the interface renders it as those
 * words. It is a different statement from 0, and conflating the two is how a
 * dashboard comes to be trusted for something it never measured.
 */
export interface PulseMetrics {
  eventsPerSecond: number;
  eventsPerMinute: number;
  activeClubs: number;
  totalObserved: number;
  /** Average write-down latency across observed events, ms. */
  averageLatencyMs: number | null;
  lastEventAt: string | null;
  /** Events the outbox has marked processed. Null until something marks them. */
  processed: number | null;
  failed: number | null;
  pending: number | null;
  /** Which of the above could not be computed, and are shown as unavailable. */
  notInstrumented: string[];
}

/**
 * What is measurable right now.
 *
 * The rate windows come from arrival times this process observed, so they are
 * true for this instance and are labelled as such in the interface — a
 * multi-instance deployment would need the outbox to answer platform-wide, and
 * claiming otherwise from one process's memory would be a fabrication.
 */
export function pulseMetrics(): PulseMetrics {
  const now = Date.now();
  trim(now);

  const lastSecond = arrivals.filter((t) => now - t <= 1_000).length;
  const notInstrumented: string[] = [];

  // Nothing in Familista currently sets `processedAt`, `failedAt` or advances
  // `retryCount` on an outbox row — the fan-out publisher writes and forgets.
  // So these three are absent rather than zero, and stay absent until a
  // consumer exists to move them.
  notInstrumented.push('processed', 'failed', 'pending');

  return {
    eventsPerSecond: lastSecond,
    eventsPerMinute: arrivals.length,
    activeClubs: clubsSeen.size,
    totalObserved: totalFrames,
    averageLatencyMs: latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null,
    lastEventAt: buffer.length ? buffer[buffer.length - 1].recordedAt : null,
    processed: null,
    failed: null,
    pending: null,
    notInstrumented,
  };
}

// ── the map the interface draws ──────────────────────────────────────────────

export interface PulseTopology {
  sources: string[];
  destinations: Array<{ name: string; live: true }>;
  future: Array<{ name: string; live: false; note: string }>;
  /** Registered types with a producer in this build, and their lanes. */
  instrumented: Array<{ eventType: string; source: string; destination: string }>;
  /** Registered types nothing emits yet. Named so the screen can say so. */
  notInstrumented: string[];
}

/**
 * Which event types this build actually produces.
 *
 * Hand-maintained and deliberately so: it is a claim about the code, and a
 * claim about the code should be reviewable in a diff. A test walks the source
 * for `emit({ eventType: … })` and fails if this list drifts, which is what
 * keeps it honest without making it magic.
 */
export const INSTRUMENTED_EVENT_TYPES = Object.freeze([
  'player.created',
  'player.updated',
  'player.photo.attached',
  'media.created',
  'media.deleted',
  'device.credential.created',
  'device.credential.rotated',
  'device.credential.revoked',
  'secret.kek.activated',
  'secret.kek.rewrapped',
  'secret.kek.retired',
]);

export function pulseTopology(): PulseTopology {
  const { registeredEventTypes } = require('../event-taxonomy') as typeof import('../event-taxonomy');
  const all: string[] = registeredEventTypes();
  const live = new Set<string>(INSTRUMENTED_EVENT_TYPES);

  return {
    sources: [...SOURCE_LANES],
    destinations: LIVE_DESTINATIONS.map((name) => ({ name, live: true as const })),
    future: FUTURE_DESTINATIONS.map((name) => ({
      name, live: false as const,
      note: 'Architecture only — nothing is connected to this yet',
    })),
    instrumented: INSTRUMENTED_EVENT_TYPES.map((eventType) => ({
      eventType,
      source: sourceLaneFor(eventType),
      destination: destinationLaneFor(eventType),
    })),
    notInstrumented: all.filter((t) => !live.has(t)).sort(),
  };
}
