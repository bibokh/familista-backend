// Retention classes for the historical event store
// ─────────────────────────────────────────────────────────────────────────────
// A CLASSIFICATION, not a schedule. Every historical record is stamped with the
// class of thing it is, and nothing in this build deletes a historical record
// on the strength of that stamp.
//
// The distinction matters. A duration is a legal judgement that varies by
// jurisdiction, by the age of the person a record is about, and by whether a
// dispute is open; inventing "audit records are kept for seven years" here
// would be a lawyer's decision taken by a programmer. What this file does is
// the part that IS an engineering decision: say which bucket a record falls in,
// so that Global Governance can later attach a duration to a bucket and have it
// apply consistently to every source at once.
//
// Until such a policy exists, the historical store keeps everything. That is the
// safe default: a record kept too long can be deleted later, and a record
// deleted too early cannot be recovered.

import type { FamilistaEvent } from '../event-envelope';

/**
 * The six buckets.
 *
 * Deliberately the ones the platform can actually tell apart from what it
 * already knows about an event, rather than a taxonomy borrowed from a
 * compliance framework the platform has not adopted.
 */
export const RETENTION_CLASSES = [
  /** The ordinary record of something the platform did. The default. */
  'OPERATIONAL',
  /** The record IS the point: tenancy, access, membership, club lifecycle. */
  'AUDIT',
  /** Credential and key handling. Kept apart so a security review can find it. */
  'SECURITY',
  /** Assigned by governance, never derived. Nothing here produces it. */
  'COMPLIANCE',
  /** Volume telemetry and model activity, whose value is aggregate. */
  'ANALYTICS',
  /** Anything the envelope itself classified RESTRICTED. */
  'RESTRICTED',
] as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Domains whose events are credential or key handling. */
const SECURITY_DOMAINS = new Set(['secret']);

/** Domains whose value is aggregate rather than individual. */
const ANALYTICS_DOMAINS = new Set(['ai', 'model', 'telemetry', 'agent']);

/**
 * An override table, so governance can move a source or a type between classes
 * without a deploy touching this file's logic.
 *
 * Read from the environment as `FABRIC_RETENTION_OVERRIDES`, a comma-separated
 * list of `eventTypeOrSource=CLASS` pairs. An unparseable entry is ignored
 * rather than crashing the publisher — a malformed environment variable must
 * not stop the platform recording what happened.
 */
function overrides(): Map<string, RetentionClass> {
  const raw = String(process.env.FABRIC_RETENTION_OVERRIDES ?? '').trim();
  const out = new Map<string, RetentionClass>();
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const [key, value] = pair.split('=').map((s) => s.trim());
    if (!key || !value) continue;
    const upper = value.toUpperCase() as RetentionClass;
    if ((RETENTION_CLASSES as readonly string[]).includes(upper)) out.set(key, upper);
  }
  return out;
}

/**
 * Which class a historical record belongs to.
 *
 * Order matters and is stated rather than implied:
 *
 *   1. an explicit governance override, by event type then by source;
 *   2. RESTRICTED, because the envelope's own classification outranks a guess
 *      made from its name;
 *   3. SECURITY, for credential and key handling;
 *   4. AUDIT, for the types the registry already marks `auditRelevant` — the
 *      same flag the board uses to route an event to its Audit destination, so
 *      the two answers cannot drift apart;
 *   5. ANALYTICS, for the aggregate domains;
 *   6. OPERATIONAL.
 */
export function retentionClassFor(
  event: Pick<FamilistaEvent, 'eventType' | 'dataClassification'>,
  spec?: { source?: string | null; auditRelevant?: boolean } | null,
): RetentionClass {
  const type = String(event?.eventType ?? '');
  const domain = type.split('.')[0] ?? '';
  const source = String(spec?.source ?? '');

  const table = overrides();
  const explicit = table.get(type) ?? (source ? table.get(source) : undefined);
  if (explicit) return explicit;

  if (String(event?.dataClassification ?? '') === 'RESTRICTED') return 'RESTRICTED';
  if (SECURITY_DOMAINS.has(domain)) return 'SECURITY';
  if (spec?.auditRelevant) return 'AUDIT';
  if (ANALYTICS_DOMAINS.has(domain)) return 'ANALYTICS';
  return 'OPERATIONAL';
}

/**
 * Whether a purge is permitted at all.
 *
 * Always false in this build, and a function rather than a constant so the day
 * governance defines durations there is one place that has to start returning
 * true — and one place a test can point at to prove it currently does not.
 */
export function retentionPolicyConfigured(): boolean {
  return false;
}
