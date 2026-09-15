// The Training domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// The third domain migrated, and the first with nothing to replace: training has
// never published to the fabric. `training.started` and `training.completed`
// have sat registered and unproduced in the taxonomy since it was written.
//
// WHAT A TRAINING SESSION CONTAINS, AND WHY ALMOST NONE OF IT TRAVELS
//
// A session row carries a title and a description a coach typed, a LOCATION, a
// closing coach note, and a roster of player ids. Its attendance records carry
// a mark per player and a free-text note against each one. Every one of those
// is either something an adult wrote about children, or a place children will
// physically be at a known time.
//
// So the payloads here are COUNTS, FIELD NAMES, STATUS TOKENS and TEAM KINDS.
// Three cases are worth stating outright because they look harmless and are
// not:
//
//   · `location` NEVER travels, not even as a from/to. A training ground is an
//     address, and an address plus a scheduled time is where a named squad of
//     children will be. `training.location.changed` says a location changed and
//     does not say to what.
//
//   · Player IDS never travel. A roster change is reported as a COUNT —
//     `{ count: 3 }` — because three ids is three children.
//
//   · Attendance NOTES never travel, and neither does the present/absent split.
//     A mark against a child is a fact about that child's day, and an
//     attendance reason is the sort of thing safeguarding exists to protect.
//     What travels is how many marks were saved.
//
// TEAM CONTEXT
//
// First-team and academy training are one source and one lane — a club's
// training is its training. They are told apart by `teamKind`, a token from the
// platform's own `TeamKind`, which for an academy side also carries the age
// group (`ACADEMY_U17`). That is the "age group where appropriate" the brief
// asks for, and it comes from the team rather than from anything about a child.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const TRAINING_SOURCE_ID = 'training';

/** A `TeamKind` token, or null for a club-wide session attached to no team. */
const teamKind = z.string().min(1).max(40).nullable();

/** Field NAMES that changed. Never values. */
const changedFields = z.array(z.string().min(1).max(40)).max(24);

/** A count of people or things. Never the things themselves. */
const count = z.number().int().nonnegative().max(1_000_000);

/** A session status token — `planned`, `in_progress`, `completed`. */
const statusToken = z.string().min(1).max(32).nullable();

export function registerTrainingProducer(): void {
  registerFabricEvent({
    type: 'training.session.created',
    describes: 'A training session was scheduled',
    classification: 'INTERNAL',
    entityType: 'TRAINING_SESSION',
  });
  registerFabricSchema({
    eventType: 'training.session.created', version: 1,
    describes: 'How many players were rostered and how many drills planned. No names, no place',
    schema: z.object({ players: count, drills: count, teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'training.session.updated',
    describes: 'A scheduled training session changed',
    classification: 'INTERNAL',
    entityType: 'TRAINING_SESSION',
  });
  registerFabricSchema({
    eventType: 'training.session.updated', version: 1,
    describes: 'Which session fields the caller asked to change, by name',
    schema: z.object({ changedFields, teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'training.session.deleted',
    describes: 'A training session was removed',
    classification: 'INTERNAL',
    entityType: 'TRAINING_SESSION',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'training.session.deleted', version: 1,
    describes: 'The squad whose session it was',
    schema: z.object({ teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'training.attendance.saved',
    describes: 'Attendance was recorded for a training session',
    // RESTRICTED because the underlying records are about named children on a
    // named day. The event carries a count; the classification carries the
    // warning, so a consumer can refuse the category without reading it.
    classification: 'RESTRICTED',
    entityType: 'TRAINING_SESSION',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'training.attendance.saved', version: 1,
    describes: 'How many marks were saved. Never who, never the mark, never the reason',
    schema: z.object({ marked: count, teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'training.location.changed',
    describes: 'A training session was moved to a different place',
    // RESTRICTED, and the sharpest case in this file. The VALUE is never on the
    // event: a training ground is an address, and an address with a scheduled
    // time is where a named squad of children will physically be.
    classification: 'RESTRICTED',
    entityType: 'TRAINING_SESSION',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'training.location.changed', version: 1,
    describes: 'That the place changed. Deliberately not to what',
    schema: z.object({ teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'training.status.changed',
    describes: 'A training session moved between lifecycle states',
    classification: 'INTERNAL',
    entityType: 'TRAINING_SESSION',
  });
  registerFabricSchema({
    eventType: 'training.status.changed', version: 1,
    describes: 'The status token before and after',
    schema: z.object({ from: statusToken, to: statusToken, teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'training.player.added',
    describes: 'Players were added to a session roster',
    classification: 'CONFIDENTIAL',
    entityType: 'TRAINING_SESSION',
  });
  registerFabricSchema({
    eventType: 'training.player.added', version: 1,
    describes: 'How many joined the roster. Never which',
    schema: z.object({ count, teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'training.player.removed',
    describes: 'Players were taken off a session roster',
    classification: 'CONFIDENTIAL',
    entityType: 'TRAINING_SESSION',
  });
  registerFabricSchema({
    eventType: 'training.player.removed', version: 1,
    describes: 'How many left the roster. Never which',
    schema: z.object({ count, teamKind }).strict(),
  });
}

registerTrainingProducer();

// ── the helpers the Training service calls ───────────────────────────────────

export interface TrainingContext {
  sessionId: string;
  clubId: string;
  teamId?: string | null;
  actorUserId?: string | null;
  sourceType?: EventSourceType;
}

function publish(eventType: string, ctx: TrainingContext, payload: Record<string, unknown>): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'TRAINING_SESSION',
    subjectId: ctx.sessionId,
    sourceType: ctx.sourceType ?? 'USER',
    payload,
  });
}

/** Field names, cleaned to names. Capped in count and in length. */
export function fieldNames(fields: readonly string[]): string[] {
  return [...new Set(fields.map((f) => String(f).trim()).filter(Boolean))]
    .slice(0, 24)
    .map((f) => f.slice(0, 40));
}

export function publishTrainingSessionCreated(
  ctx: TrainingContext, players: number, drills: number, kind: string | null,
): void {
  publish('training.session.created', ctx, {
    players: Math.max(0, players), drills: Math.max(0, drills), teamKind: kind ?? null,
  });
}

export function publishTrainingSessionUpdated(
  ctx: TrainingContext, fields: readonly string[], kind: string | null,
): void {
  publish('training.session.updated', ctx, {
    changedFields: fieldNames(fields), teamKind: kind ?? null,
  });
}

export function publishTrainingSessionDeleted(ctx: TrainingContext, kind: string | null): void {
  publish('training.session.deleted', ctx, { teamKind: kind ?? null });
}

export function publishTrainingAttendanceSaved(
  ctx: TrainingContext, marked: number, kind: string | null,
): void {
  publish('training.attendance.saved', ctx, { marked: Math.max(0, marked), teamKind: kind ?? null });
}

export function publishTrainingLocationChanged(ctx: TrainingContext, kind: string | null): void {
  publish('training.location.changed', ctx, { teamKind: kind ?? null });
}

export function publishTrainingStatusChanged(
  ctx: TrainingContext, from: string | null, to: string | null, kind: string | null,
): void {
  publish('training.status.changed', ctx, {
    from: from ?? null, to: to ?? null, teamKind: kind ?? null,
  });
}

export function publishTrainingPlayerAdded(
  ctx: TrainingContext, howMany: number, kind: string | null,
): void {
  if (howMany <= 0) return;
  publish('training.player.added', ctx, { count: howMany, teamKind: kind ?? null });
}

export function publishTrainingPlayerRemoved(
  ctx: TrainingContext, howMany: number, kind: string | null,
): void {
  if (howMany <= 0) return;
  publish('training.player.removed', ctx, { count: howMany, teamKind: kind ?? null });
}
