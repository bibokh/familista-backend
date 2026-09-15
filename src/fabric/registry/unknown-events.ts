// What happens when a producer emits a name nobody registered
// ─────────────────────────────────────────────────────────────────────────────
// The wrong answers are both tempting. Throwing turns an observability mistake
// into a failed user action — somebody cannot save a player because a telemetry
// name was mistyped, which is an absurd trade. Ignoring it means the mistake
// lives forever, because nothing ever says so.
//
// So: never throw, always count, and be loud exactly where loud is free.
//
//   development and test  the registry is editable in the same session, so a
//                         missing registration is a thing you fix in the next
//                         thirty seconds. Logged at ERROR, once per name.
//
//   production            the name is in the field and the fix is a deploy.
//                         Logged at WARN, once per name, and counted so the
//                         platform can show a number rather than asking
//                         somebody to read logs.
//
// ONCE PER NAME, NOT ONCE PER EVENT. A device with bad firmware emitting ten a
// second must not be able to fill the log with the same sentence — the counter
// carries the volume, the log carries the fact.

import { logger } from '../../utils/logger';

export interface RegistryHealth {
  /** Distinct unregistered names seen since this process started. */
  unknownEventTypes: string[];
  /** Total events seen carrying an unregistered name. */
  unknownEventCount: number;
  /** Distinct types whose payload failed its declared schema. */
  schemaFailureTypes: string[];
  /** Total events whose payload failed its declared schema. */
  schemaFailureCount: number;
  /** Events withheld from the live stream because their payload was invalid. */
  quarantinedCount: number;
}

const unknownSeen = new Map<string, number>();
const schemaFailures = new Map<string, number>();
let quarantined = 0;

/** Is this process one where a missing registration is fixable right now? */
function loud(): boolean {
  const env = process.env.NODE_ENV ?? 'development';
  return env !== 'production';
}

/**
 * Record an event carrying a name no one registered.
 *
 * Returns nothing and throws nothing. The caller publishes the event either
 * way — see the module note.
 */
export function noteUnknownEventType(eventType: string): void {
  const type = String(eventType ?? '(empty)');
  const seen = unknownSeen.get(type) ?? 0;
  unknownSeen.set(type, seen + 1);

  if (seen > 0) return; // once per name

  const message = '[fabric] event type is not registered';
  const detail = {
    eventType: type,
    hint: 'register it with registerFabricEvent() — see src/fabric/registry/README.md',
  };
  if (loud()) logger.error(message, detail);
  else logger.warn(message, detail);
}

/**
 * Record a payload that failed the schema its own version declares.
 *
 * Logged with the ISSUE PATHS and never the payload: a validation failure on a
 * medical or identity event would otherwise put the content into the log, which
 * is the one place this fabric is built to keep it out of.
 */
export function noteSchemaFailure(eventType: string, version: number, issues: string[]): void {
  const key = `${eventType}@${version}`;
  const seen = schemaFailures.get(key) ?? 0;
  schemaFailures.set(key, seen + 1);

  if (seen > 0) return;

  const message = '[fabric] event payload does not match its declared schema';
  const detail = { eventType, schemaVersion: version, issues: issues.slice(0, 5) };
  if (loud()) logger.error(message, detail);
  else logger.warn(message, detail);
}

/** Record that an event was withheld from the live stream. */
export function noteQuarantine(): void {
  quarantined += 1;
}

/** What the registry has seen go wrong. For a status panel or a test. */
export function registryHealth(): RegistryHealth {
  let unknownEventCount = 0;
  for (const n of unknownSeen.values()) unknownEventCount += n;
  let schemaFailureCount = 0;
  for (const n of schemaFailures.values()) schemaFailureCount += n;

  return {
    unknownEventTypes: [...unknownSeen.keys()].sort(),
    unknownEventCount,
    schemaFailureTypes: [...schemaFailures.keys()].sort(),
    schemaFailureCount,
    quarantinedCount: quarantined,
  };
}

/** Clear the counters. Tests only. */
export function resetRegistryHealth(): void {
  unknownSeen.clear();
  schemaFailures.clear();
  quarantined = 0;
}
