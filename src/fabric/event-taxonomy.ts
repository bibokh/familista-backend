// The names Familista events are allowed to have
// ─────────────────────────────────────────────────────────────────────────────
// A registry, not a rule. Registration buys three things: a consumer can switch
// on a name and know the set is finite; a name carries a default sensitivity so
// a producer that forgets to classify still classifies correctly; and adding a
// name is a visible, reviewable act rather than a string typed at a call site.
//
// What registration does NOT buy is a veto. `makeEvent` accepts an unregistered
// name and marks it in metadata, because a device firmware in the field will
// one day emit a name this build has never heard of, and refusing to store it
// would lose the event to protect a list. The consumer decides what to do with
// a name it does not know; the producer is never blocked by our deploy cadence.
//
// NAMING
//
//   <domain>.<entity>.<past-tense-verb>   player.photo.attached
//   <domain>.<past-tense-verb>            club.created
//
// Lower case, dots, past tense. An event is something that HAS HAPPENED — a
// name in the imperative is a command, and a command in an event log is a bug
// waiting for somebody to replay it.
//
// REUSE, NOT DUPLICATION
//
// Familista already emits events through `big-data/publisher.ts` under
// `OutboxKind` names — MATCH_EVENT, SENSOR_PACKET, AI_ALERT and so on. Those
// are not renamed and not deprecated here; they are MAPPED, below, so that one
// occurrence has one canonical name whichever producer wrote it. Inventing
// `match.event.recorded` alongside a live `MATCH_EVENT` would give the same
// fact two names, which is how a consumer comes to count it twice.

import type { DataClassification } from '../platform/data-classification';
import { registerFabricEvent, type FabricEventSpec } from './registry/event-registry';

export interface EventTypeSpec {
  /** The canonical dotted name. */
  type: string;
  /** One line: what has happened, in the words a person would use. */
  describes: string;
  /** Default sensitivity when a producer does not classify explicitly. */
  classification: DataClassification;
  /** The current payload shape version for this type. */
  schemaVersion: number;
  /**
   * The legacy `OutboxKind` this name replaces, where one exists. Present so
   * a reader of either name can find the other, and so nothing is emitted
   * twice under two names.
   */
  legacyKind?: string;
  /**
   * False for a name that ships but that nothing in this build publishes.
   * Defaults to true. See `FabricEventSpec.produced` for why it is stated.
   */
  produced?: boolean;
}

/**
 * The registered types.
 *
 * Grouped by domain and deliberately short. A taxonomy that tries to name every
 * possible occurrence up front names most of them wrong; this covers what the
 * platform actually does today plus the four future producers the fabric has to
 * be able to accept without a rewrite — media, devices, cameras and models.
 */
export const EVENT_TYPES: readonly EventTypeSpec[] = Object.freeze([
  // ── club and tenancy ──────────────────────────────────────────────────────
  { type: 'club.created',            describes: 'A club row was created and is awaiting a president', classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'club.lifecycle.changed',  describes: 'A club moved between lifecycle states',              classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'club.president.invited',  describes: 'A CLUB_OWNER invitation was issued for a club',      classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'club.deleted',            describes: 'A club was permanently deleted',                     classification: 'INTERNAL',     schemaVersion: 1 },

  // ── people and access ─────────────────────────────────────────────────────
  { type: 'membership.granted',      describes: 'Somebody was given a role in a club',                classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'membership.changed',      describes: 'A membership role or team scope changed',            classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'membership.revoked',      describes: 'A membership was ended',                             classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'user.context.switched',   describes: 'A session changed the club or team it acts for',     classification: 'INTERNAL',     schemaVersion: 1 },

  // ── squad ─────────────────────────────────────────────────────────────────
  { type: 'player.created',          describes: 'A player was added to a squad',                      classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'player.updated',          describes: 'A player record changed',                            classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'player.photo.attached',   describes: 'A photograph was attached to a player',              classification: 'RESTRICTED',   schemaVersion: 1 },
  { type: 'player.transferred',      describes: 'A player moved between clubs',                       classification: 'CONFIDENTIAL', schemaVersion: 1 },

  // ── football operations ───────────────────────────────────────────────────
  { type: 'training.started',        describes: 'A training session began',                           classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'training.completed',      describes: 'A training session finished',                         classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'attendance.recorded',     describes: 'Attendance was taken for a session or match',        classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'match.started',           describes: 'A match kicked off',                                 classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'match.event.recorded',    describes: 'One event within a match was recorded',              classification: 'INTERNAL',     schemaVersion: 1, legacyKind: 'MATCH_EVENT' },
  { type: 'match.completed',         describes: 'A match finished',                                   classification: 'INTERNAL',     schemaVersion: 1 },

  // ── medical ───────────────────────────────────────────────────────────────
  // Both predate the Medical producer, which publishes the injury lifecycle as
  // `injury.created`, `injury.updated` and `injury.closed` — one family, under
  // the `injury` domain the Medical source already declares. Neither of these
  // has ever been emitted. Kept registered, because a name that shipped is a
  // published contract; marked unproduced, so the catalogue does not imply an
  // event that never arrives.
  { type: 'medical.injury.created',  describes: 'An injury was recorded for a player',                classification: 'RESTRICTED',   schemaVersion: 1, produced: false },
  { type: 'medical.injury.resolved', describes: 'A player was cleared from an injury',                classification: 'RESTRICTED',   schemaVersion: 1, produced: false },

  // ── recruitment ───────────────────────────────────────────────────────────
  // `transfer.offered` predates the Transfers producer, which publishes the
  // five states of an offer under their own names. Nothing emits this one, and
  // the catalogue now says so rather than leaving a consumer to subscribe to a
  // name that never arrives. Kept registered, because a name that shipped is a
  // published contract and withdrawing it is not this change's job.
  { type: 'transfer.offered',        describes: 'An offer was made for a player',                     classification: 'CONFIDENTIAL', schemaVersion: 1, produced: false },
  { type: 'transfer.completed',      describes: 'A transfer was concluded',                           classification: 'CONFIDENTIAL', schemaVersion: 1 },

  // ── media ─────────────────────────────────────────────────────────────────
  // v2. The v1 payload carried a CHECKSUM and a STORAGE PROVIDER; a content
  // hash is a confirmation oracle and a provider is infrastructure detail, so
  // the Media producer publishes a narrower shape. The v1 schema stays
  // registered in `core-schemas.ts` — it is the contract the events already in
  // the outbox were written against, and a historical contract is not edited.
  { type: 'media.created',           describes: 'A media asset was registered and its bytes stored',  classification: 'INTERNAL',     schemaVersion: 2 },
  // Replaced by `media.processing.completed` and `media.processing.failed`,
  // which say which of the two happened. Never emitted, and the catalogue now
  // says so rather than implying an event that does not arrive.
  { type: 'media.processed',         describes: 'Processing of a media asset finished',               classification: 'INTERNAL',     schemaVersion: 1, produced: false },
  // v2, for the same reason: the v1 payload named the storage provider.
  { type: 'media.deleted',           describes: 'A media asset was withdrawn or expired',             classification: 'INTERNAL',     schemaVersion: 2 },

  // ── devices and capture · not implemented, registered so producers exist ──
  { type: 'device.registered',       describes: 'A device was enrolled to a club',                    classification: 'INTERNAL',     schemaVersion: 1, legacyKind: 'DEVICE_STATUS' },
  { type: 'device.connected',        describes: 'A device opened a session',                          classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'device.disconnected',     describes: 'A device session ended',                             classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'telemetry.batch.received', describes: 'A batch of sensor samples was ingested',            classification: 'RESTRICTED',   schemaVersion: 1, legacyKind: 'SENSOR_PACKET' },
  { type: 'camera.stream.started',   describes: 'A camera began producing a stream',                  classification: 'INTERNAL',     schemaVersion: 1 },
  // Credential lifecycle. The payload of every one of these carries the
  // REFERENCE and never the secret — a reference is safe in an event, a log and
  // a backup, which is the entire reason references exist.
  { type: 'device.credential.created', describes: 'A credential was minted for a device or camera',    classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'device.credential.rotated', describes: 'A credential was rotated to a new version',         classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'device.credential.revoked', describes: 'A credential version was revoked',                  classification: 'CONFIDENTIAL', schemaVersion: 1 },
  // Key-encryption key lifecycle. The payload of every one of these carries
  // key NAMES — a kid is not key material and cannot open anything — plus the
  // reference of the secret that moved and who moved it. Never the KEK, never
  // the derived key, never the credential.
  { type: 'secret.kek.activated',    describes: 'A key-encryption key became the one sealing new writes', classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'secret.kek.rewrapped',    describes: 'A sealed secret was re-keyed onto another KEK version',  classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'secret.kek.retired',      describes: 'A key-encryption key was withdrawn from use',            classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'camera.stream.ended',     describes: 'A camera stream finished',                           classification: 'INTERNAL',     schemaVersion: 1 },

  // ── intelligence ──────────────────────────────────────────────────────────
  { type: 'ai.analysis.completed',   describes: 'A model finished analysing something',               classification: 'INTERNAL',     schemaVersion: 1, legacyKind: 'AI_RECOMMENDATION' },
  { type: 'ai.alert.raised',         describes: 'A model raised an alert',                            classification: 'INTERNAL',     schemaVersion: 1, legacyKind: 'AI_ALERT' },
  { type: 'model.evaluation.completed', describes: 'A model version was evaluated against a dataset', classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'model.deployment.completed', describes: 'A model version was put into service',            classification: 'INTERNAL',     schemaVersion: 1 },
]);

export type FamilistaEventType = (typeof EVENT_TYPES)[number]['type'];

// ── the seed ─────────────────────────────────────────────────────────────────
//
// The list above is what this BUILD ships with. The live set is held in
// `registry/event-registry.ts`, which a module arriving later can add to
// without editing this file — that is the whole point of the registry, and it
// is why every lookup below now delegates rather than reading the literal.
//
// The dependency runs one way: this file imports the registry and seeds it, the
// registry imports nothing from here at load. Anything that can reach a lookup
// has already evaluated this module, so there is no order in which the answers
// come back empty.
//
// Which entityType a name is about is stated here rather than guessed from the
// name: `medical.injury.created` is about a PLAYER, not an injury, and no
// amount of string-splitting produces that.

const ENTITY_TYPES: Record<string, string> = {
  club: 'CLUB', membership: 'MEMBERSHIP', user: 'USER',
  player: 'PLAYER', training: 'TRAINING_SESSION', attendance: 'TRAINING_SESSION',
  match: 'MATCH', transfer: 'TRANSFER', medical: 'PLAYER',
  media: 'MEDIA_ASSET', device: 'DEVICE', camera: 'CAMERA',
  telemetry: 'DEVICE', secret: 'PLATFORM_SECRET',
  ai: 'MODEL', model: 'MODEL',
};

/**
 * Types whose record is the point, as opposed to types that describe a change
 * the application reads back from a row anyway.
 *
 * Kept in step with the board's `Audit` destination lane — a type that travels
 * to Audit is a type whose value IS the record that it happened.
 */
const AUDIT_DOMAINS = new Set(['club', 'membership', 'user', 'secret', 'device', 'camera']);

/** Put this build's names into the registry. Called once, at module load. */
export function seedTaxonomy(): void {
  for (const spec of EVENT_TYPES) {
    const domain = spec.type.split('.')[0] ?? '';
    registerFabricEvent({
      type: spec.type,
      describes: spec.describes,
      classification: spec.classification,
      schemaVersion: spec.schemaVersion,
      legacyKind: spec.legacyKind,
      entityType: ENTITY_TYPES[domain] ?? null,
      auditRelevant: AUDIT_DOMAINS.has(domain),
      produced: spec.produced ?? true,
      // Every name this build ships with was already drawn by the live board
      // before the registry existed. Withholding one now would be a silent
      // change to what an operator sees, so all of them stay exposed and a
      // future type opts out explicitly.
      exposeInLiveStream: true,
    });
  }
}

seedTaxonomy();

// ── lookups · delegated, so a later registration is visible everywhere ───────

export {
  isRegisteredEventType, registeredEventTypes, classificationForEventType,
  canonicalNameForLegacyKind, registerFabricEvent,
} from './registry/event-registry';

/**
 * One type's spec.
 *
 * Returns the registry's record, which carries everything `EventTypeSpec` did
 * plus the fields the registry adds. Callers that only read the original four
 * fields are unaffected.
 */
export function eventTypeSpec(type: string): FabricEventSpec | undefined {
  const { fabricEvent } = require('./registry/event-registry') as typeof import('./registry/event-registry');
  return fabricEvent(type);
}
