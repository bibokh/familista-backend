// One way to publish an event on Familista
// ─────────────────────────────────────────────────────────────────────────────
// `emit()` already existed and still does everything it did: build the
// envelope, append it to the outbox inside the producing transaction's reach,
// and fan it out. This wraps it with the three things a registry makes
// possible, and adds nothing else.
//
//   1 · is the name registered?         → counted, never refused
//   2 · does the payload match its declared schema for this version?
//                                       → counted, and the LIVE view quarantined
//   3 · may the live board draw it?     → `exposeInLiveStream`, per event type
//
// WHY THIS DOES NOT THROW
//
// A module calls this from inside a business operation — a player was saved, a
// membership was granted. If publishing could throw, every call site would need
// a try/catch to stop an observability problem failing a user's action, and one
// of them would forget. So the contract is: `publishFabricEvent` resolves, and
// the result says what happened. A caller that genuinely wants a hard failure
// passes `strict: true` and gets one.
//
// The one thing that still rejects is a malformed ENVELOPE — a missing type, a
// nonsensical time. `makeEvent` refuses those and always has; they are not
// observability problems, they are a producer calling the function wrong, and
// they surface in development long before a user sees them.

import { logger } from '../../utils/logger';
import { emit } from '../event-bus';
import type { EventInput, FamilistaEvent } from '../event-envelope';
import { fabricEvent, isRegisteredEventType, exposedInLiveStream } from './event-registry';
import { validateEventPayload, type SchemaCheck } from './schema-registry';
import { noteQuarantine, noteSchemaFailure, noteUnknownEventType } from './unknown-events';

export interface PublishOptions {
  /**
   * Reject instead of recording a problem.
   *
   * For a caller that would rather fail than publish something it cannot
   * stand behind — a migration, a test, an importer. Off by default, and it
   * should stay off in request paths.
   */
  strict?: boolean;
}

export interface PublishResult {
  /** The envelope that was built. Present even when the append failed. */
  event: FamilistaEvent;
  /** `STORED`, `DUPLICATE` or `FAILED`, from the transport. */
  outcome: string;
  /** True for STORED and DUPLICATE — the fact is on record either way. */
  stored: boolean;
  /** False when the name is not in the event registry. */
  registered: boolean;
  /** What the schema check concluded. */
  schema: SchemaCheck;
  /**
   * True when the event was withheld from the live monitoring stream.
   *
   * Withheld, not lost. The durable record is unaffected; this only says the
   * board did not draw it — because its payload failed validation, or because
   * its type declares `exposeInLiveStream: false`.
   */
  quarantined: boolean;
}

export class FabricPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FabricPublishError';
  }
}

/**
 * Publish one event.
 *
 * The single entry point a module should use. Modules do not build envelopes,
 * do not touch the transport and do not write to the pulse — they call this,
 * and everything downstream is the fabric's problem.
 */
export async function publishFabricEvent<P>(
  input: EventInput<P>,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const eventType = String(input?.eventType ?? '').trim();
  const spec = fabricEvent(eventType);
  const registered = isRegisteredEventType(eventType);

  if (!registered) {
    noteUnknownEventType(eventType);
    if (options.strict) {
      throw new FabricPublishError(
        `event type "${eventType}" is not registered — call registerFabricEvent() first`,
      );
    }
  }

  // The version the producer claims, defaulting to the one the registry
  // declares current. A producer on an older version says so explicitly and
  // gets validated against that older schema, which is the point of versioning.
  const schemaVersion = input.schemaVersion ?? spec?.schemaVersion ?? 1;
  const schema = validateEventPayload(eventType, schemaVersion, input.payload ?? null);

  if (!schema.ok) {
    noteSchemaFailure(eventType, schemaVersion, schema.issues);
    if (options.strict) {
      throw new FabricPublishError(
        `payload for "${eventType}" v${schemaVersion} failed its schema: ${schema.issues.join('; ')}`,
      );
    }
  }

  // Two reasons to withhold from the live view, and they are different reasons.
  // An invalid payload is withheld so a registered consumer never receives
  // something that does not match the contract it was promised; a type marked
  // `exposeInLiveStream: false` is withheld because it was never meant to be on
  // a firehose. Either way the durable record is untouched.
  const quarantined = !schema.ok || (registered && !exposedInLiveStream(eventType));
  if (quarantined) noteQuarantine();

  const result = await emit({
    ...input,
    schemaVersion,
    metadata: {
      ...(input.metadata ?? {}),
      ...(schema.ok ? {} : { schemaInvalid: true }),
      ...(quarantined ? { liveStreamWithheld: true } : {}),
    },
  });

  if (!result.stored) {
    // The append failed and `emit` already logged the transport's reason. Said
    // again here with the publisher's own framing, because a caller reading
    // this line wants to know its event did not land, not why the transport
    // was unhappy.
    logger.warn('[fabric] event was not recorded', { eventType, outcome: result.outcome });
  }

  return {
    event: result.event,
    outcome: result.outcome,
    stored: result.stored,
    registered,
    schema,
    quarantined,
  };
}

/**
 * Publish without waiting.
 *
 * For a request path that must not add the outbox write to its own latency.
 * The promise is consumed here — an unhandled rejection from a fire-and-forget
 * publish would take the process down in Node 15 and later, which is a
 * spectacular way for observability to break production.
 */
export function publishFabricEventDetached<P>(input: EventInput<P>): void {
  void publishFabricEvent(input).catch((err) => {
    logger.warn('[fabric] detached publish failed', {
      eventType: String(input?.eventType), err: (err as Error).message,
    });
  });
}
