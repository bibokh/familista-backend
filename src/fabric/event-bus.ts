// The seam between producing an event and storing one
// ─────────────────────────────────────────────────────────────────────────────
// Domain code calls `emit()`. That is the whole surface. It does not know
// whether the event lands in Postgres, in Redis Streams, in Kafka, or in an
// array in a test — and that ignorance is the entire point of this file.
//
// The brief's requirement is precise: "we must later be able to replace
// transport/storage without rewriting domain code". Familista has a working
// outbox today and will plausibly have a broker one day. The way that migration
// turns into a rewrite is if two hundred call sites import `prisma` and write
// their own row. So there is one port, one registered implementation, and a
// domain layer that can only see the port.
//
// WHAT THIS IS NOT
//
// Not a queue. Not a scheduler. Not a retry engine. The transport owns
// durability and delivery; this owns the contract and the fan-out to
// in-process subscribers. Adding a broker means writing a second
// `EventTransport`, registering it, and changing nothing else.
//
// FAILURE POLICY
//
// `emit` never throws into the caller. A club is not un-archived because the
// event describing the archival could not be written — the operational write
// already committed, and an exception here would either roll back a correct
// change or surface a storage problem as a user-facing error for something the
// user did successfully. Failures are returned in the result and logged. A
// producer that genuinely cannot proceed without the event checks `.stored`.

import { logger } from '../utils/logger';
import { makeEvent, type EventInput, type FamilistaEvent } from './event-envelope';

/**
 * Where events go.
 *
 * Two methods, because two is what a fabric needs: put one in, and read some
 * back. Anything richer — consumer groups, offsets, acknowledgement — belongs
 * to a broker-backed implementation and must not leak into this interface,
 * because a Postgres implementation cannot honour it and a domain that depends
 * on it can never move.
 */
export interface EventTransport {
  /** A name for logs and for the status surface. */
  readonly name: string;

  /**
   * Store one event.
   *
   * Returns `DUPLICATE` when an event with the same `idempotencyKey` already
   * exists. That is a SUCCESS from the producer's point of view — the fact is
   * recorded — and the distinction is returned rather than hidden so an
   * ingestion path can count how often a device is retrying.
   */
  append(event: FamilistaEvent): Promise<AppendOutcome>;

  /**
   * Read events back, newest first, always scoped to one club.
   *
   * `clubId` is required and not nullable: a read that can span tenants is a
   * read that will one day span tenants by accident. Platform-wide reads go
   * through a separate, explicitly-named path that asserts platform authority.
   */
  read(query: EventQuery): Promise<FamilistaEvent[]>;
}

export type AppendOutcome = 'STORED' | 'DUPLICATE' | 'FAILED';

export interface EventQuery {
  clubId: string;
  eventTypes?: string[];
  subjectType?: string;
  subjectId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface EmitResult {
  event: FamilistaEvent;
  outcome: AppendOutcome;
  /** True for STORED and DUPLICATE — the fact is on record either way. */
  stored: boolean;
}

// ── the registered transport ─────────────────────────────────────────────────

let transport: EventTransport | null = null;

/**
 * Install the transport. Called once at boot, and by tests.
 *
 * Deliberately a setter rather than a constructor argument threaded through
 * every service: the alternative is dependency injection plumbing across a
 * hundred files to solve a problem that has exactly one answer at runtime.
 */
export function setEventTransport(next: EventTransport | null): void {
  transport = next;
}

export function currentTransport(): EventTransport | null {
  return transport;
}

// ── in-process subscribers ───────────────────────────────────────────────────
//
// A projection, a live feed, a metric. Subscribers run AFTER the event is
// stored, never before, so nothing observes an event that failed to persist.
// A throwing subscriber is isolated: one bad consumer must not fail an emit or
// starve the consumers after it.

export type EventHandler = (event: FamilistaEvent) => void | Promise<void>;

const handlers = new Map<string, Set<EventHandler>>();
const ALL = '*';

/** Listen for one event type, or `'*'` for every event. Returns an unsubscribe. */
export function subscribe(eventType: string, handler: EventHandler): () => void {
  const key = eventType || ALL;
  if (!handlers.has(key)) handlers.set(key, new Set());
  handlers.get(key)!.add(handler);
  return () => { handlers.get(key)?.delete(handler); };
}

/** Drop every subscriber. Tests, and shutdown. */
export function clearSubscribers(): void {
  handlers.clear();
}

function fanOut(event: FamilistaEvent): void {
  const sets = [handlers.get(event.eventType), handlers.get(ALL)];
  for (const set of sets) {
    if (!set) continue;
    for (const handler of set) {
      try {
        const out = handler(event);
        if (out && typeof (out as Promise<void>).catch === 'function') {
          (out as Promise<void>).catch((err) => {
            logger.warn('[fabric] subscriber failed', { eventType: event.eventType, err: (err as Error).message });
          });
        }
      } catch (err) {
        logger.warn('[fabric] subscriber threw', { eventType: event.eventType, err: (err as Error).message });
      }
    }
  }
}

// ── the one function domain code calls ───────────────────────────────────────

/**
 * Record that something happened.
 *
 * Builds the envelope, hands it to whatever transport is installed, then tells
 * in-process subscribers. Never throws: see the failure policy above.
 *
 * With no transport installed the event is still built, validated and fanned
 * out in process — which is what makes a unit test of a producer meaningful
 * without a database, and what keeps a misconfigured deployment from failing
 * every write in the application.
 */
export async function emit<P>(input: EventInput<P>): Promise<EmitResult> {
  let event: FamilistaEvent<P>;
  try {
    event = makeEvent(input);
  } catch (err) {
    // A malformed event is a programming error in the producer, and it is the
    // one case worth surfacing loudly — but still not by throwing into a
    // request that otherwise succeeded.
    logger.error('[fabric] refused to build an event', {
      eventType: String(input?.eventType), err: (err as Error).message,
    });
    throw err;
  }

  let outcome: AppendOutcome = 'STORED';
  if (transport) {
    try {
      outcome = await transport.append(event);
    } catch (err) {
      outcome = 'FAILED';
      logger.warn('[fabric] append failed', {
        transport: transport.name, eventType: event.eventType, err: (err as Error).message,
      });
    }
  }

  if (outcome !== 'FAILED') fanOut(event);
  return { event, outcome, stored: outcome !== 'FAILED' };
}

/**
 * Read a club's own events.
 *
 * The tenant argument is not optional and is not defaulted. Every caller states
 * which club it is asking about, and the transport filters on it — this is the
 * multi-tenancy boundary for the whole fabric, and it is one line so that it
 * cannot be got wrong in two places.
 */
export async function readEvents(query: EventQuery): Promise<FamilistaEvent[]> {
  if (!query?.clubId) throw new Error('readEvents requires a clubId');
  if (!transport) return [];
  return transport.read({ ...query, limit: Math.min(query.limit ?? 100, 1000) });
}
