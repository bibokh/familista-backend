// The Medical domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// The strictest producer in the platform, and the only one whose payloads were
// designed by asking what must be REMOVED rather than what could usefully be
// added.
//
// WHAT A MEDICAL EVENT IS ALLOWED TO SAY
//
// That something happened, to somebody in a named club, in a squad of a named
// kind, at a time. Nothing else.
//
// Not the diagnosis. Not the body part. Not the mechanism, the severity, the
// symptoms, the treatment, the medication, the physiotherapist's notes, the
// test results, the measurements, the expected return, the days absent, or the
// reasoning behind a clearance. Not the medical status's VALUE. Not the kind of
// record. None of it is on any event here, and the schemas are `.strict()`, so
// none of it can be added by accident later.
//
// The rule is not "redact the obvious ones". A body location is obviously
// clinical; `daysAbsent` is a health measurement wearing an operational
// disguise, `severity` is a diagnosis in one word, and `recordKind: 'SURGERY'`
// is a medical history in a token. All of them are withheld.
//
// WHY THERE ARE NO FIELD NAMES
//
// Every other producer here reports `changedFields` — the NAMES of what moved,
// never the values — and the board draws them. That is right for a squad
// update and wrong for a medical record: "severity" and "bodyLocation" on a
// public operations board are clinical hints about an identifiable person, and
// frequently about a child. So Medical reports `changedFieldCount` instead. The
// key is deliberately not `changedFields`, which is the one key `project()`
// reads out of a payload.
//
// WHY NOTHING IS ADDED TO THE BOARD'S SAFE SUBJECT IDS
//
// Every event here is about a PLAYER and carries his id as the envelope's
// subject, because an Audit Center, a consent rule or a retention job needs to
// know WHOSE record this was. `PLAYER` is deliberately absent from
// `SAFE_SUBJECT_IDS`, so `project()` replaces that id with null and the
// observability surface never learns who. The link survives for a consumer
// with the authority to read it; it does not survive onto a screen.
//
// The envelope's `teamId` is null for the same reason: the board prints a
// team id, and a team id beside a medical event narrows the subject to one
// squad. `teamKind` — SENIOR, ACADEMY_U17 — travels in the payload instead,
// where the board cannot reach it. That is what tells First Team from Academy
// without telling anybody which child.
//
// ACADEMY
//
// Academy medical events use this same source and these same payloads. There is
// no separate academy card and no relaxation: a child's name, date of birth,
// guardian, condition, note and safeguarding record are absent here in exactly
// the way they are absent for a senior professional, which is to say the schema
// has nowhere to put them.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const MEDICAL_SOURCE_ID = 'medical';

const id = z.string().min(1).max(64);

/**
 * Which squad, as a KIND.
 *
 * `SENIOR`, `ACADEMY_U17`. Comes from the Team row, not from anything about a
 * person, and is the whole of the team context a medical event carries.
 */
const teamKind = z.string().min(1).max(40).nullable();

/**
 * How many fields an amendment touched.
 *
 * A COUNT, and deliberately not the key `changedFields` that every other
 * producer uses: that key is the one thing `project()` lifts out of a payload
 * and draws, and "severity" or "bodyLocation" on the board is a clinical hint
 * about an identifiable person. One number says an amendment happened and says
 * nothing about a body.
 */
const changedFieldCount = z.number().int().min(0).max(200);

/**
 * Where an injury was sustained, as one of three tokens.
 *
 * `MATCH`, `TRAINING` or `UNSPECIFIED`. The operational category, never the
 * match or the session — an occasion plus a squad is a small enough set of
 * people to be an identification.
 */
const injuryContext = z.enum(['MATCH', 'TRAINING', 'UNSPECIFIED']);

/** On every event in this file. */
const context = { teamKind };

export function registerMedicalProducer(): void {
  // ── injuries ───────────────────────────────────────────────────────────────
  //
  // `injury` is a declared event domain of the `medical` source, so these carry
  // no card of their own. There is one injury family, not one per surface.

  registerFabricEvent({
    type: 'injury.created',
    describes: 'An injury was recorded for a player',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'injury.created', version: 1,
    describes: 'That a record exists and where it happened. Never what the injury is',
    schema: z.object({ injuryId: id, injuryContext, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'injury.updated',
    describes: 'An injury record was amended',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'injury.updated', version: 1,
    describes: 'How many fields moved. Never which, and never to what',
    schema: z.object({ injuryId: id, changedFieldCount, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'injury.closed',
    describes: 'An injury record was given a return date',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'injury.closed', version: 1,
    // Not the date, and not `daysAbsent`. How long somebody was out is a
    // measurement of their health, and a duration is a diagnosis to anyone who
    // knows the sport.
    describes: 'That the record was closed. Never the date and never the days absent',
    schema: z.object({ injuryId: id, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'injury.deleted',
    describes: 'An injury record was removed',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'injury.deleted', version: 1,
    // A medical record being destroyed is the event an audit trail most needs
    // and the one a system most easily forgets to record.
    describes: 'That a medical record was destroyed, and whose it was',
    schema: z.object({ injuryId: id, ...context }).strict(),
  });

  // ── the medical record ─────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'medical.record.created',
    describes: 'A medical history record was appended for an athlete',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'medical.record.created', version: 1,
    // NOT `recordKind`. The store's own categories are INJURY, SURGERY,
    // RECOVERY_MILESTONE and ASSESSMENT, and "this athlete had surgery" is a
    // medical history whether it arrives as a paragraph or as one word.
    // Neither the payload nor its hash travels: a hash of a plain medical
    // payload is a confirmation oracle, not an anonymisation.
    describes: 'That a record was appended. Never its kind, its payload or its hash',
    schema: z.object({ recordId: id, ...context }).strict(),
  });

  // Declared, not produced. `AthleteMedicalHistory` is append-only by design —
  // `recordMedical` writes and `listMedical` reads, and there is no update
  // path. The name exists so the day a correction flow is built it registers
  // nothing new; until then the catalogue says plainly that it does not occur.
  registerFabricEvent({
    type: 'medical.record.updated',
    describes: 'A medical history record was corrected',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
    produced: false,
  });
  registerFabricSchema({
    eventType: 'medical.record.updated', version: 1,
    describes: 'How many fields moved. Never which, and never to what',
    schema: z.object({ recordId: id, changedFieldCount, ...context }).strict(),
  });

  // ── status and availability ────────────────────────────────────────────────

  registerFabricEvent({
    type: 'medical.status.updated',
    describes: 'A player’s medical status moved',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'medical.status.updated', version: 1,
    // THE VALUE IS THE WHOLE POINT OF WITHHOLDING. `HEALTHY`, `INJURED`,
    // `RECOVERING`, `SUSPENDED`, `UNAVAILABLE` — four of the five say something
    // about a person's health, so neither the old one nor the new one is on
    // this event, in either direction.
    describes: 'That the status moved. Never what it was and never what it became',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricEvent({
    type: 'medical.availability.changed',
    describes: 'A player became available, or stopped being available',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
  });
  registerFabricSchema({
    eventType: 'medical.availability.changed', version: 1,
    // A BOOLEAN, and it cannot be read back as a diagnosis: the same statuses
    // that make a player unavailable include suspension, which is a
    // disciplinary fact and not a medical one. Whether a squad member can be
    // selected is operational — it is on the team sheet every coach already
    // reads — and the REASON never travels.
    describes: 'Whether he can be selected. Never why',
    schema: z.object({ available: z.boolean(), ...context }).strict(),
  });

  // Declared, not produced. Familista has no clearance flow: nothing writes a
  // medical sign-off distinct from the status field above.
  registerFabricEvent({
    type: 'medical.clearance.updated',
    describes: 'A medical clearance decision was recorded',
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
    produced: false,
  });
  registerFabricSchema({
    eventType: 'medical.clearance.updated', version: 1,
    describes: 'That a clearance decision was recorded. Never the decision or its reasoning',
    schema: z.object({ ...context }).strict(),
  });

  // ── rehabilitation and return to play ──────────────────────────────────────
  //
  // Declared, produced by nothing. Familista has no rehabilitation programme
  // and no return-to-play protocol today: there is no model, no service and no
  // route for either, and a producer for one would be fiction.
  //
  // They are registered anyway because §10's audit, consent and retention work
  // needs a stable contract to be built against, and because a name added later
  // by the flow that fills it is a name no consumer was ever told about. Each
  // carries the same safe context as everything above, so the flow that arrives
  // inherits the privacy rather than choosing it.
  //
  // The prefix is `medical.` rather than `return_to_play.`: an event name's
  // first segment may not contain an underscore, and a `rehabilitation` domain
  // of its own would be a second source card for a family that belongs to this
  // one.

  for (const [type, describes] of [
    ['medical.rehabilitation.started',   'A rehabilitation programme began'],
    ['medical.rehabilitation.updated',   'A rehabilitation programme was amended'],
    ['medical.rehabilitation.completed', 'A rehabilitation programme finished'],
    ['medical.return_to_play.started',   'A return-to-play protocol began'],
    ['medical.return_to_play.updated',   'A return-to-play protocol was amended'],
    ['medical.return_to_play.cleared',   'A player was cleared to return to play'],
  ] as const) {
    registerFabricEvent({
      type,
      describes,
      classification: 'RESTRICTED',
      entityType: 'PLAYER',
      auditRelevant: true,
      produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'That the stage was reached. Never the protocol, the notes or the reasoning',
      schema: z.object({ programmeId: id.nullable(), ...context }).strict(),
    });
  }
}

registerMedicalProducer();

// ── the helpers the Medical flows call ───────────────────────────────────────

/**
 * Whose record, and in whose club.
 *
 * `playerId` is the envelope's subject and never appears in a payload. It is
 * carried so a consent rule, a retention job or an Audit Center can answer
 * "whose record was this" — and it is redacted out of every observability frame
 * by `project()`, because `PLAYER` is not a safe subject kind.
 */
export interface MedicalContext {
  playerId: string;
  clubId: string;
  /** SENIOR, ACADEMY_U17. From the team, never from the person. */
  teamKind?: string | null;
  actorUserId?: string | null;
  sourceType?: EventSourceType;
}

function publish(
  eventType: string,
  ctx: MedicalContext,
  extra: Record<string, unknown> = {},
): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId,
    // NULL, deliberately. `project()` prints a team id, and a team id beside a
    // medical event narrows its subject to one squad. The kind travels in the
    // payload, which the board cannot read.
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'PLAYER',
    subjectId: ctx.playerId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: { ...extra, teamKind: ctx.teamKind ?? null },
  });
}

/** Where an injury happened, from the ids the record already holds. */
export function injuryContextOf(
  matchId: string | null | undefined, trainingId: string | null | undefined,
): z.infer<typeof injuryContext> {
  if (matchId) return 'MATCH';
  if (trainingId) return 'TRAINING';
  return 'UNSPECIFIED';
}

export function publishInjuryCreated(
  ctx: MedicalContext, injuryId: string, where: z.infer<typeof injuryContext>,
): void {
  publish('injury.created', ctx, { injuryId, injuryContext: where });
}

export function publishInjuryUpdated(
  ctx: MedicalContext, injuryId: string, fieldsTouched: number,
): void {
  publish('injury.updated', ctx, {
    injuryId, changedFieldCount: Math.max(0, Math.min(200, Math.round(fieldsTouched))),
  });
}

export function publishInjuryClosed(ctx: MedicalContext, injuryId: string): void {
  publish('injury.closed', ctx, { injuryId });
}

export function publishInjuryDeleted(ctx: MedicalContext, injuryId: string): void {
  publish('injury.deleted', ctx, { injuryId });
}

export function publishMedicalRecordCreated(ctx: MedicalContext, recordId: string): void {
  publish('medical.record.created', ctx, { recordId });
}

export function publishMedicalStatusUpdated(ctx: MedicalContext): void {
  publish('medical.status.updated', ctx);
}

export function publishMedicalAvailabilityChanged(ctx: MedicalContext, available: boolean): void {
  publish('medical.availability.changed', ctx, { available });
}

/**
 * Can this player be selected?
 *
 * The one reading of `MedicalStatus` this file makes, and it is deliberately
 * lossy: five statuses collapse to a boolean, and the boolean is the only part
 * that leaves. `SUSPENDED` sits in the same enum as `INJURED`, which is why an
 * unavailability on the record cannot be read back as an injury.
 *
 * An unrecognised status counts as AVAILABLE. A value this build has never
 * heard of is not evidence that somebody is hurt, and guessing in the other
 * direction would invent a health fact from a typo.
 */
export function availableForSelection(status: string | null | undefined): boolean {
  const s = String(status ?? 'HEALTHY').toUpperCase();
  return s !== 'INJURED' && s !== 'RECOVERING' && s !== 'SUSPENDED' && s !== 'UNAVAILABLE';
}
