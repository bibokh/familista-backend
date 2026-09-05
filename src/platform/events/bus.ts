// The event bus — in-process today, a queue tomorrow, the same contract either way
// ─────────────────────────────────────────────────────────────────────────────
// Domain code calls `publish`. It does not know, and must never learn, whether
// the event was handled in this process, put on a queue or written to a
// warehouse. That ignorance is the whole point: changing the transport later is
// then a change to this file rather than to every service that emits.
//
// Two rules the transport must always keep:
//
//   1. Publishing never fails the caller. A training session was still created
//      even if an analytics sink was down; an event is a record of something
//      that happened, not a step in making it happen.
//   2. Nothing forbidden is published. `assertPublishable` runs before any
//      subscriber sees the payload — see contracts.ts for why.

import { logger } from '../../utils/logger';
import {
  assertPublishable, EVENT_STREAM, type PlatformEvent, type PlatformEventName,
} from './contracts';
import { currentEnvironment } from '../environment';

export type Subscriber = (event: PlatformEvent) => void | Promise<void>;

const subscribers = new Map<string, Set<Subscriber>>();
const ALL = '*';

export function subscribe(name: PlatformEventName | '*', fn: Subscriber): () => void {
  const key = name ?? ALL;
  const set = subscribers.get(key) ?? new Set<Subscriber>();
  set.add(fn);
  subscribers.set(key, set);
  return () => { set.delete(fn); };
}

export function subscriberCount(name?: PlatformEventName): number {
  return (subscribers.get(name ?? ALL)?.size ?? 0) + (name ? (subscribers.get(ALL)?.size ?? 0) : 0);
}

/** For tests, and for a process that wants to start from a known state. */
export function resetSubscribers(): void {
  subscribers.clear();
}

export interface PublishInput {
  name: PlatformEventName;
  payload?: Record<string, unknown>;
  actor?: PlatformEvent['actor'];
  scope?: PlatformEvent['scope'];
  correlationId?: string | null;
}

/**
 * Record that something happened.
 *
 * Returns the event so a caller can log or test it. Never throws for a
 * subscriber's sake: a failing sink is logged and the caller carries on.
 */
export function publish(input: PublishInput): PlatformEvent {
  const payload = input.payload ?? {};
  assertPublishable(payload);

  const event: PlatformEvent = {
    name: input.name,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: input.correlationId ?? null,
    environment: currentEnvironment(),
    actor: input.actor ?? { type: 'SYSTEM' },
    scope: input.scope ?? {},
    payload,
  };

  const targets = [...(subscribers.get(event.name) ?? []), ...(subscribers.get(ALL) ?? [])];
  for (const fn of targets) {
    try {
      const out = fn(event);
      if (out && typeof (out as Promise<void>).catch === 'function') {
        (out as Promise<void>).catch((err) => logger.warn('event subscriber failed', { name: event.name, err: String(err) }));
      }
    } catch (err) {
      logger.warn('event subscriber threw', { name: event.name, err: String(err) });
    }
  }
  return event;
}

/** Which stream this event belongs to — audit, analytics, or both. */
export function streamOf(name: PlatformEventName): 'AUDIT' | 'ANALYTICS' | 'BOTH' {
  return EVENT_STREAM[name];
}
