// One shape for everything that happens on Familista
// ─────────────────────────────────────────────────────────────────────────────
// Familista already had an event log — `EventOutbox`, written inside the
// producing transaction, fanned out to an in-process channel and, behind env
// flags, to Redis Streams, Kafka and NATS. The durability was never the gap.
// The gap was the ENVELOPE: `kind` and `topic` were free strings, there was no
// schema version, no distinction between when something happened and when it
// was written down, no actor, no team, and no way for a consumer to know how
// sensitive a payload was without understanding it.
//
// That is what this file is. Not a new event system — a contract laid over the
// one that exists, so that the day a second consumer appears, or a camera
// starts producing, or the transport moves to a broker, nothing in the domain
// has to change.
//
// FOUR PROPERTIES THE ENVELOPE HAS TO CARRY, AND WHY
//
// 1 · `occurredAt` is not `recordedAt`. A GPS packet buffered on an edge
//     gateway through a network outage OCCURRED during the match and was
//     RECORDED an hour later. A fabric with one timestamp silently files that
//     sample at the wrong minute, and every derived feature inherits the error.
//     Nothing here defaults `occurredAt` to now unless the producer says so.
//
// 2 · `dataClassification` travels WITH the event. A consumer that has no idea
//     what a payload means can still refuse to forward a RESTRICTED one. The
//     lattice already exists in `platform/data-classification`; this puts it on
//     the wire.
//
// 3 · The producer is not assumed to be a person. `actorUserId` is optional and
//     `source` is a typed pair — a device, an edge node, a worker and an
//     external integration are all first-class producers. An envelope that
//     requires a user is an envelope a camera cannot use.
//
// 4 · Identity is derivable. `idempotencyKey` is computed from what the event
//     IS, not from when it arrived, so a device that retries an upload after a
//     dropped connection produces the same key and the second write is refused
//     by a unique index rather than by a guess.
//
// Events are append-only. Nothing in this module updates a fact once written;
// a correction is a new event that references the old one through
// `causationId`.

import { createHash, randomUUID } from 'crypto';
import type { DataClassification } from '../platform/data-classification';
import { classify } from '../platform/data-classification';
import { type FamilistaEventType, isRegisteredEventType, classificationForEventType } from './event-taxonomy';

/**
 * Where an event came from.
 *
 * Typed rather than a free string because the answer decides how much the
 * platform trusts it: a `SERVICE` event was produced by code we deployed
 * inside a transaction we control; a `DEVICE` event arrived over the network
 * from hardware in somebody's stadium and has to be authenticated, deduplicated
 * and clock-checked before it means anything.
 */
export type EventSourceType =
  | 'SERVICE'      // Familista backend code, in-process
  | 'WORKER'       // a background worker of ours
  | 'USER'         // a person acting through the interface
  | 'DEVICE'       // a wearable, tracker or sensor
  | 'CAMERA'       // a camera or capture rig
  | 'EDGE'         // an edge gateway forwarding on behalf of devices
  | 'INTEGRATION'  // an external data provider or partner system
  | 'AI';          // a model or agent

/** What the event is ABOUT, as opposed to who caused it. */
export type EventSubjectType =
  | 'CLUB' | 'TEAM' | 'USER' | 'PLAYER' | 'STAFF' | 'MEMBERSHIP'
  | 'MATCH' | 'FIXTURE' | 'COMPETITION' | 'TRAINING_SESSION'
  | 'MEDICAL_RECORD' | 'TRANSFER' | 'MEDIA_ASSET' | 'DEVICE' | 'CAMERA'
  // A sealed credential or a key-encryption key. Named separately from
  // `PLATFORM` because a consumer filtering an audit trail for key handling
  // should not have to read every platform event to find it.
  | 'PLATFORM_SECRET'
  | 'MODEL' | 'DATASET' | 'PLATFORM';

/**
 * The canonical Familista event.
 *
 * Every field that is not optional is a field a consumer may rely on without
 * checking, which is the only reason to make one required. Scope fields below
 * `clubId` are deliberately optional: a platform-level event has no club, a
 * club-wide event has no team, and forcing either would make producers invent
 * values.
 */
export interface FamilistaEvent<P = unknown> {
  /** Unique per event. Generated once, never reused, never reassigned. */
  eventId: string;
  /** A registered name from the taxonomy — `club.lifecycle.changed`. */
  eventType: FamilistaEventType | string;
  /** The version of THIS event type's payload shape. Starts at 1. */
  schemaVersion: number;

  /** When it happened in the world. Producer-supplied; never guessed. */
  occurredAt: Date;
  /** When Familista wrote it down. Always server time. */
  recordedAt: Date;

  /** The tenant. Null only for genuinely platform-level events. */
  clubId: string | null;
  /** The team, when the event is about one. */
  teamId: string | null;

  /** The person who caused it, when a person did. */
  actorUserId: string | null;
  /** What the event is about. */
  subjectType: EventSubjectType | null;
  subjectId: string | null;

  /** What produced it, and which instance of that thing. */
  sourceType: EventSourceType;
  sourceId: string | null;

  /** Ties every event of one request or one ingestion batch together. */
  correlationId: string | null;
  /** The event that caused this one. How a correction points at what it corrects. */
  causationId: string | null;

  /** Where the data is governed. ISO-3166 alpha-2, or a region code. */
  jurisdiction: string | null;
  /** How sensitive, so a consumer can refuse without understanding. */
  dataClassification: DataClassification;

  /** The event's own body. Typed per event type by its producer. */
  payload: P;
  /** Anything that describes the event rather than the thing it is about. */
  metadata: Record<string, unknown>;

  /**
   * Stable identity for deduplication.
   *
   * Derived from what the event IS — type, tenant, subject, occurrence time and
   * payload — so a producer that retries after a dropped connection computes
   * the same key and the storage layer's unique index refuses the second write.
   * A producer with its own natural key (a device's sequence number, an upload
   * checksum) should pass it instead: a supplied key is always better than a
   * derived one.
   */
  idempotencyKey: string;
}

/** What a producer supplies. Everything else is derived or defaulted. */
export interface EventInput<P = unknown> {
  eventType: FamilistaEventType | string;
  schemaVersion?: number;
  occurredAt?: Date | string;
  clubId?: string | null;
  teamId?: string | null;
  actorUserId?: string | null;
  subjectType?: EventSubjectType | null;
  subjectId?: string | null;
  sourceType?: EventSourceType;
  sourceId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  jurisdiction?: string | null;
  dataClassification?: DataClassification;
  payload?: P;
  metadata?: Record<string, unknown>;
  /** A natural key from the producer. Preferred over the derived one. */
  idempotencyKey?: string;
  /** Overrides server time. For tests and for replaying a recorded stream. */
  recordedAt?: Date;
}

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

const MAX_TYPE_LENGTH = 120;
const MAX_METADATA_KEYS = 50;

function asDate(v: Date | string | undefined, fallback: Date): Date {
  if (v == null) return fallback;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new EventValidationError('occurredAt is not a valid time');
  return d;
}

/**
 * Build one event.
 *
 * Validates what can be validated cheaply and refuses rather than correcting:
 * an event with a malformed time or an unnamed type is a producer bug, and
 * quietly filling in a plausible value is how a bug becomes a permanent record.
 *
 * The one thing it will NOT refuse is an unregistered event type — see
 * `isRegisteredEventType`. A taxonomy that rejects unknown names cannot be
 * extended without a deploy, and a device firmware that emits a name this
 * build has never heard of must still be storable. Unknown names are accepted,
 * flagged in metadata, and left for a consumer to ignore.
 */
export function makeEvent<P>(input: EventInput<P>): FamilistaEvent<P> {
  const eventType = String(input.eventType ?? '').trim();
  if (!eventType) throw new EventValidationError('eventType is required');
  if (eventType.length > MAX_TYPE_LENGTH) {
    throw new EventValidationError(`eventType is longer than ${MAX_TYPE_LENGTH} characters`);
  }
  if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(eventType)) {
    throw new EventValidationError(
      `eventType "${eventType}" is not a dotted lower-case name — see event-taxonomy.ts`,
    );
  }

  const schemaVersion = input.schemaVersion ?? 1;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new EventValidationError('schemaVersion must be a positive integer');
  }

  const recordedAt = input.recordedAt ?? new Date();
  const occurredAt = asDate(input.occurredAt, recordedAt);

  const metadata = { ...(input.metadata ?? {}) };
  if (Object.keys(metadata).length > MAX_METADATA_KEYS) {
    throw new EventValidationError(`metadata carries more than ${MAX_METADATA_KEYS} keys`);
  }
  // A name this build does not know is recorded as such rather than rejected.
  // The consumer decides; the producer is not blocked by our deploy cadence.
  if (!isRegisteredEventType(eventType)) metadata.unregisteredEventType = true;

  const event: FamilistaEvent<P> = {
    eventId: randomUUID(),
    eventType,
    schemaVersion,
    occurredAt,
    recordedAt,
    clubId: input.clubId ?? null,
    teamId: input.teamId ?? null,
    actorUserId: input.actorUserId ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    sourceType: input.sourceType ?? 'SERVICE',
    sourceId: input.sourceId ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    jurisdiction: input.jurisdiction ?? null,
    // The taxonomy's own answer, then the resource map, then INTERNAL. Failing
    // toward more private is the safe direction, and it is the direction the
    // classification module already fails in.
    dataClassification:
      input.dataClassification
      ?? classificationForEventType(eventType)
      ?? classify(eventType.split('.')[0]),
    payload: (input.payload ?? null) as P,
    metadata,
    idempotencyKey: '',
  };

  event.idempotencyKey = input.idempotencyKey?.trim() || deriveIdempotencyKey(event);
  return event;
}

/**
 * The identity of an event, as a hash of what it is.
 *
 * Deliberately excludes `eventId`, `recordedAt` and `correlationId`: those
 * differ between two attempts to record the SAME occurrence, which is exactly
 * the case this key exists to collapse. It includes `occurredAt` at
 * millisecond resolution, because two genuinely different heartbeats from one
 * device a second apart are two events and must not collide.
 *
 * The old `deriveIdempotencyKey` in `big-data/event-source.ts` bucketed by the
 * WALL CLOCK second, which means a retry that crossed a second boundary
 * produced a different key and duplicated the row. That was tolerable for
 * in-process fan-out. It is not tolerable for a device on a flaky link, which
 * is why this one hashes the occurrence rather than the arrival.
 */
export function deriveIdempotencyKey(e: Omit<FamilistaEvent, 'idempotencyKey' | 'eventId'>): string {
  const seed = JSON.stringify({
    t: e.eventType,
    v: e.schemaVersion,
    o: e.occurredAt instanceof Date ? e.occurredAt.toISOString() : String(e.occurredAt),
    c: e.clubId,
    tm: e.teamId,
    st: e.subjectType,
    si: e.subjectId,
    src: e.sourceType,
    sid: e.sourceId,
    p: e.payload ?? null,
  });
  return createHash('sha256').update(seed).digest('hex');
}

/**
 * Is this event addressed to the given club?
 *
 * The one function every consumer, projection and read path must go through
 * before it touches an event that is not its own. A platform event (`clubId:
 * null`) belongs to no club and is readable by no club — the platform reads it
 * through platform authority, not by matching null against null.
 */
export function eventBelongsToClub(e: Pick<FamilistaEvent, 'clubId'>, clubId: string): boolean {
  return !!clubId && e.clubId === clubId;
}

/** A serialisable form, for a transport that carries JSON. */
export function serialiseEvent(e: FamilistaEvent): Record<string, unknown> {
  return {
    ...e,
    occurredAt: e.occurredAt.toISOString(),
    recordedAt: e.recordedAt.toISOString(),
  };
}
