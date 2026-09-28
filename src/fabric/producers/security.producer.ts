// The Security domain, as Data Fabric declarations
// ─────────────────────────────────────────────────────────────────────────────
// Registers the `security.*` names and their payload schema (Cyber Defense
// Security Event Schema v1, `cyber-defense/security-event-schema.ts`) in the
// Fabric registry, so the collectors that come later register nothing new and
// break no consumer.
//
// DECLARED, NOT PRODUCED
//
// Every type is `produced: false`. There are no publish helpers in this file
// yet, on purpose: the catalogue says the names exist and the metrics say
// nothing has produced one, which is the honest picture until a reviewed
// collector step adds the first producer.
//
// WHERE THEY GO
//
// Owned by the existing System source, which already carries credential and key
// handling (`secret.*`); no new source card, lane or board appears. Withheld from
// the live stream (`exposeInLiveStream: false`): a security signal is recorded
// and readable by whoever has authority, and is not drawn on a firehose. The
// historical store files them under the SECURITY retention class.

import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import {
  SECURITY_EVENT_SCHEMA_VERSION,
  SECURITY_EVENT_TYPES,
  securityPayloadSchemaFor,
} from '../../cyber-defense/security-event-schema';

/** The source the `security.*` names belong to. Registered in `source-registry`. */
export const SECURITY_EVENTS_SOURCE_ID = 'system';

/** Built once, so a repeated registration presents the same schema object and is idempotent. */
const SCHEMAS = new Map(SECURITY_EVENT_TYPES.map((d) => [d.type, securityPayloadSchemaFor(d)]));

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
      produced: false,
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
