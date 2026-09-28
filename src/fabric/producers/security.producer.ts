// The Security domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// Registers the `security.*` names and their payload schema (Cyber Defense
// Security Event Schema v1, `cyber-defense/security-event-schema.ts`) in the
// Fabric registry, and publishes them for the collectors.
//
// PRODUCED AND DECLARED
//
// A name is `produced: true` only when `cyber-defense/collectors.ts` has a
// collector for it; the rest are declared ahead of theirs. The one publish
// helper below refuses a name that is not declared produced, so a collector
// cannot quietly start emitting a type the catalogue says nothing emits.
//
// WHERE THEY GO
//
// Owned by the existing System source, which already carries credential and key
// handling (`secret.*`); no new source card, lane or board appears. Withheld from
// the live stream (`exposeInLiveStream: false`): a security signal is recorded
// and readable by whoever has authority, and is not drawn on a firehose. The
// historical store files them under the SECURITY retention class.
//
// PUBLISHING NEVER FAILS A REQUEST
//
// Fire-and-forget through `publishFabricEventDetached`, like every other
// producer: a refused sign-in must not become a failed sign-in because an event
// could not be recorded.

import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import {
  SECURITY_EVENT_SCHEMA_VERSION,
  SECURITY_EVENT_TYPES,
  securityPayloadSchemaFor,
  type SecurityEventPayloadV1,
} from '../../cyber-defense/security-event-schema';

/** The source the `security.*` names belong to. Registered in `source-registry`. */
export const SECURITY_EVENTS_SOURCE_ID = 'system';

/** Built once, so a repeated registration presents the same schema object and is idempotent. */
const SCHEMAS = new Map(SECURITY_EVENT_TYPES.map((d) => [d.type, securityPayloadSchemaFor(d)]));

/** The names a collector may publish. */
const PRODUCED = new Map(SECURITY_EVENT_TYPES.filter((d) => d.produced).map((d) => [d.type, d]));

export function registerSecurityProducer(): void {
  for (const d of SECURITY_EVENT_TYPES) {
    registerFabricEvent({
      type: d.type,
      describes: d.describes,
      classification: 'CONFIDENTIAL',
      schemaVersion: SECURITY_EVENT_SCHEMA_VERSION,
      source: SECURITY_EVENTS_SOURCE_ID,
      entityType: 'PLATFORM',
      exposeInLiveStream: false,
      auditRelevant: d.auditRelevant,
      produced: d.produced,
    });
    registerFabricSchema({
      eventType: d.type,
      version: SECURITY_EVENT_SCHEMA_VERSION,
      describes: `Security Event Schema v1, category ${d.category}. Never a credential, a full IP or free text`,
      schema: SCHEMAS.get(d.type)!,
    });
  }
}

registerSecurityProducer();

/** Who and where, from the envelope's side. Everything else is in the payload. */
export interface SecurityEventContext {
  /** The authenticated user who caused it, when there is one. Never a claimed identity. */
  actorUserId?: string | null;
  clubId?: string | null;
  /** The request id, carried as the envelope's correlation id. */
  correlationId?: string | null;
}

/**
 * Publish one security event.
 *
 * `category` is taken from the declaration rather than from the caller, so a
 * payload cannot be filed under the wrong category. A name with no collector
 * is refused (returns false) rather than published.
 */
export function publishSecurityEvent(
  type: string,
  ctx: SecurityEventContext,
  payload: Omit<SecurityEventPayloadV1, 'category'>,
): boolean {
  const d = PRODUCED.get(type);
  if (!d) return false;
  publishFabricEventDetached({
    eventType: d.type,
    clubId: ctx.clubId ?? null,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'PLATFORM',
    subjectId: payload.source.component,
    sourceType: 'SERVICE',
    correlationId: ctx.correlationId ?? null,
    payload: { category: d.category, ...payload },
  });
  return true;
}
