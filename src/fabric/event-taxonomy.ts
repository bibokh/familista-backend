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
  { type: 'medical.injury.created',  describes: 'An injury was recorded for a player',                classification: 'RESTRICTED',   schemaVersion: 1 },
  { type: 'medical.injury.resolved', describes: 'A player was cleared from an injury',                classification: 'RESTRICTED',   schemaVersion: 1 },

  // ── recruitment ───────────────────────────────────────────────────────────
  { type: 'transfer.offered',        describes: 'An offer was made for a player',                     classification: 'CONFIDENTIAL', schemaVersion: 1 },
  { type: 'transfer.completed',      describes: 'A transfer was concluded',                           classification: 'CONFIDENTIAL', schemaVersion: 1 },

  // ── media ─────────────────────────────────────────────────────────────────
  { type: 'media.created',           describes: 'A media asset was registered and its bytes stored',  classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'media.processed',         describes: 'Processing of a media asset finished',               classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'media.deleted',           describes: 'A media asset was withdrawn or expired',             classification: 'INTERNAL',     schemaVersion: 1 },

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
  { type: 'camera.stream.ended',     describes: 'A camera stream finished',                           classification: 'INTERNAL',     schemaVersion: 1 },

  // ── intelligence ──────────────────────────────────────────────────────────
  { type: 'ai.analysis.completed',   describes: 'A model finished analysing something',               classification: 'INTERNAL',     schemaVersion: 1, legacyKind: 'AI_RECOMMENDATION' },
  { type: 'ai.alert.raised',         describes: 'A model raised an alert',                            classification: 'INTERNAL',     schemaVersion: 1, legacyKind: 'AI_ALERT' },
  { type: 'model.evaluation.completed', describes: 'A model version was evaluated against a dataset', classification: 'INTERNAL',     schemaVersion: 1 },
  { type: 'model.deployment.completed', describes: 'A model version was put into service',            classification: 'INTERNAL',     schemaVersion: 1 },
]);

export type FamilistaEventType = (typeof EVENT_TYPES)[number]['type'];

const BY_TYPE = new Map<string, EventTypeSpec>(EVENT_TYPES.map((s) => [s.type, s]));
const BY_LEGACY = new Map<string, EventTypeSpec>(
  EVENT_TYPES.filter((s) => s.legacyKind).map((s) => [s.legacyKind as string, s]),
);

export function isRegisteredEventType(type: string): boolean {
  return BY_TYPE.has(type);
}

export function eventTypeSpec(type: string): EventTypeSpec | undefined {
  return BY_TYPE.get(type);
}

/** The default sensitivity for a registered type; undefined for an unknown one. */
export function classificationForEventType(type: string): DataClassification | undefined {
  return BY_TYPE.get(type)?.classification;
}

/**
 * The canonical name for a legacy `OutboxKind`, where one exists.
 *
 * The bridge that stops one occurrence acquiring two names. A producer still
 * calling `publishMatchEvent` writes `MATCH_EVENT`; a reader asking this gets
 * `match.event.recorded` back and can treat both as the same fact.
 */
export function canonicalNameForLegacyKind(kind: string): string | undefined {
  return BY_LEGACY.get(kind)?.type;
}

/** Every registered name. For a status surface, a test, or a consumer's switch. */
export function registeredEventTypes(): string[] {
  return EVENT_TYPES.map((s) => s.type);
}
