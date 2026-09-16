// Envelope → historical record: the redaction boundary
// ─────────────────────────────────────────────────────────────────────────────
// One function, and it is the whole privacy story of the historical store.
//
// THE RULE
//
// History is an INDEX of what happened, not a second copy of what it happened
// to. A historical store is the longest-lived surface the platform has: a
// mistake on the live board is visible for five minutes, and a mistake here is
// a permanent record of a child's medical status that outlives the employment
// of everybody who could have caught it.
//
// So this builds an explicit field list, the way `project()` does, and it must
// stay that way. A spread of the event with deletions would ship every field a
// future producer adds; this ships exactly the fields somebody chose to ship.
//
// WHAT IS NOT HERE, AND WILL NOT BE
//
// The PAYLOAD. Not a redacted copy of it, not a filtered subset, not "just the
// safe keys". Every producer already writes safe payloads — counts, tokens,
// field names — but "safe to draw on an operator's screen for five minutes" is
// not the same judgement as "safe to keep for a decade", and nobody has made
// the second one yet. Until they have, the answer is no.
//
// The one exception is `changedFields`, and only because the platform has
// ALREADY decided that array is safe to display: `project()` reads exactly that
// key by name, caps it at 24 entries of 40 characters, and draws it. Reusing
// that decision is not a new judgement; adding a second key would be.
//
// Concretely absent by construction: passwords, tokens, API keys, connection
// strings, private messages, addresses, child personal details, safeguarding
// notes, diagnoses, medical notes, prompts, model responses, media bytes,
// storage URLs, salaries, contract clauses, negotiation text and private
// tactical or scouting notes. None of them is reachable from here, because the
// payload is not read.
//
// IDS
//
// `entityId` is written only for subject kinds the platform already treats as
// safe to name — `safeSubjectId` in `pulse.service`, the same allow-list the
// live board uses. A PLAYER or a STAFF id is not on that list, so a historical
// record about a person says what kind of thing happened and never to whom.
//
// Not a hash, either. A stable pseudonym in a permanent store is still a
// pseudonym that links every event about one child across a decade, which is
// most of what the identifier would have cost us in the first place.

import type { FamilistaEvent } from '../event-envelope';
import { safeSubjectId } from '../pulse/pulse.service';
import { fabricEvent } from '../registry/event-registry';
import { retentionClassFor, type RetentionClass } from './retention-classes';

/** A row, ready for the historical store. Every field is named deliberately. */
export interface HistoricalRecord {
  eventId: string;
  eventType: string;
  source: string;
  schemaVersion: number;
  occurredAt: Date;
  entityType: string | null;
  entityId: string | null;
  clubId: string | null;
  teamContext: { teamId: string | null } | null;
  ageGroup: string | null;
  correlationId: string | null;
  requestId: string | null;
  status: string;
  metadata: { changedFields: string[] } | null;
  privacyClassification: string;
  retentionClass: RetentionClass;
}

/** A date that is really a date, or the epoch. Never `Invalid Date` in a column. */
function when(value: unknown): Date {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * The ONE payload key this store reads, by name.
 *
 * Identical treatment to `project()`'s `changedFieldNames`: only strings, capped
 * in count and in length. A producer that put a value here rather than a name
 * would still be truncated to something that cannot carry a sentence.
 */
function changedFieldNames(event: FamilistaEvent): string[] {
  const payload = event?.payload as Record<string, unknown> | null | undefined;
  const raw = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).changedFields
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string')
    .slice(0, 24)
    .map((v) => v.slice(0, 40));
}

/** A string, bounded. A column is not a place to discover how long an id can be. */
function bounded(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Build the historical record for an event.
 *
 * Never throws. A malformed event still produces a storable row, because losing
 * the fact that something happened is worse than storing it with an unknown
 * field — and because this runs on the publisher's path, where an exception
 * would be an observability bug reaching a business transaction.
 */
export function historicalRecord(event: FamilistaEvent, status = 'STORED'): HistoricalRecord {
  const eventType = String(event?.eventType ?? 'unknown');
  const spec = fabricEvent(eventType);
  const subjectType = bounded(event?.subjectType, 48);
  const teamId = bounded(event?.teamId, 64);
  const changed = changedFieldNames(event);

  return {
    eventId: String(event?.eventId ?? ''),
    eventType,
    source: bounded(spec?.source, 48) ?? 'unknown',
    schemaVersion: Number.isFinite(Number(event?.schemaVersion)) ? Number(event.schemaVersion) : 1,
    occurredAt: when(event?.occurredAt),
    entityType: subjectType,
    // The allow-list, borrowed rather than copied.
    entityId: safeSubjectId(subjectType, bounded(event?.subjectId, 64)),
    clubId: bounded(event?.clubId, 64),
    // An object rather than a column, so a future context field does not need a
    // migration. Null when the producer named no team — several deliberately do
    // not, and a null here is that decision surviving into history.
    teamContext: teamId ? { teamId } : null,
    // Reserved. The envelope carries no age group, and deriving one would mean
    // reading a payload. Null is the honest answer until the envelope carries it.
    ageGroup: null,
    correlationId: bounded(event?.correlationId, 64),
    // The envelope's causation id is the nearest thing this build has to a
    // request id: it names the event that caused this one.
    requestId: bounded(event?.causationId, 64),
    status: bounded(status, 24) ?? 'STORED',
    metadata: changed.length ? { changedFields: changed } : null,
    privacyClassification: bounded(event?.dataClassification, 24) ?? 'INTERNAL',
    retentionClass: retentionClassFor(
      { eventType, dataClassification: String(event?.dataClassification ?? 'INTERNAL') } as FamilistaEvent,
      spec ? { source: spec.source, auditRelevant: spec.auditRelevant } : null,
    ),
  };
}
