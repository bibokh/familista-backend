// The Players domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// The second domain migrated, and the first with an existing producer to
// REPLACE rather than add to. `player.service.ts` has emitted `player.created`,
// `player.updated` and `player.photo.attached` through the raw `emit()` since
// the fabric existed. Those calls are rerouted through `publishFabricEvent`
// here, not supplemented — adding a second publish beside the first would
// double every squad edit on the board, which is the single thing most likely
// to go wrong in a migration like this and the thing a test pins hardest.
//
// WHAT COUNTS AS A SEPARATE EVENT
//
// `player.updated` is the umbrella: it fires for every successful update and
// names the fields the caller asked to change. Alongside it, a handful of
// SPECIFIC facts get their own name, and each fires only when that specific
// thing actually changed VALUE — not merely when it appeared in the request.
// A change of shirt number is one event; a transfer to the academy that also
// changes his position is three, because three different things are true and a
// consumer subscribing to squad moves should not have to parse an array of
// field names to find them.
//
// This is the pattern the file already used — `player.photo.attached` has
// always fired alongside `player.updated`, at its own classification, so a
// consumer filtering on sensitivity can tell a photograph from a rating.
//
// WHY THERE IS NO VALUE IN ANY PAYLOAD
//
// A player row carries a date of birth, a parent's name, email and telephone,
// a medical status, a wage, a release clause and free-text notes. Every one of
// those is either a child's personal data, safeguarding-adjacent, or
// commercially confidential. So the payloads here carry FIELD NAMES, POSITION
// TOKENS and TEAM KINDS, and nothing else.
//
// `medicalStatus` is the sharpest case and it is worth being explicit: a change
// to it produces `player.status.changed` with `changedFields: ['medicalStatus']`
// and NEVER the status itself. "He was injured and is now fit" is medical
// information about a person who may be a child. "A medical field changed" is
// not. The difference is the whole point of the boundary.
//
// TEAM CONTEXT
//
// Academy and First Team players are one source and one lane — a club's squad
// is its squad. They are told apart by `teamKind`, an enum token from the
// platform's own `TeamKind`, carried in the payload alongside the `teamId` the
// envelope already has. `ACADEMY_U17` and `SENIOR` are facts about a team, not
// about a person, and a consumer that wants only academy movement can filter on
// one field instead of resolving every team id it sees.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const PLAYERS_SOURCE_ID = 'players';

/** Field NAMES that changed. Never values — see the module note. */
const changedFields = z.array(z.string().min(1).max(40)).min(1).max(24);

/** A `TeamKind` token, or null for a player attached to no team. */
const teamKind = z.string().min(1).max(40).nullable();

/** A position token — `CF`, `GK`. Public football data, not personal data. */
const positionToken = z.string().min(1).max(20).nullable();

/** A club id. A tenant identifier, which the envelope already carries. */
const clubRef = z.string().min(1).max(64);

export function registerPlayersProducer(): void {
  // `player.created`, `player.updated`, `player.photo.attached` and
  // `player.transferred` are already registered TYPES — they are in
  // `event-taxonomy.ts` and registering them again would be refused, correctly.
  // Their payload SHAPES are declared here, because this is now the file that
  // builds them; they used to sit in `core-schemas.ts` alongside the other
  // shapes laid over raw `emit()` producers, and they moved when their producer
  // did.

  registerFabricSchema({
    eventType: 'player.created', version: 1,
    describes: 'The kind of squad he arrived into, if any',
    schema: z.object({ teamKind }).strict(),
  });

  registerFabricSchema({
    eventType: 'player.updated', version: 1,
    // Empty is allowed here and nowhere else: an update requested with no
    // fields is a no-op the caller still asked for, and the umbrella event
    // reports it honestly rather than being suppressed into silence.
    describes: 'Which fields the caller asked to change, by name, and the squad he is in',
    schema: z.object({
      changedFields: z.array(z.string().min(1).max(40)).max(24),
      teamKind,
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'player.photo.attached', version: 1,
    describes: 'The squad he is in. The photograph itself is a media reference on the row',
    schema: z.object({ teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'player.profile.updated',
    describes: 'A personal detail on a player record changed',
    // RESTRICTED, one step above an ordinary update, because this is the group
    // of fields that holds a date of birth and a parent's contact details. The
    // event never carries them; the classification says what kind of record
    // moved, so a consumer can refuse it without reading it.
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'player.profile.updated', version: 1,
    describes: 'Which personal fields changed, by name, and the squad he is in',
    schema: z.object({ changedFields, teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'player.position.changed',
    describes: 'A player was moved to a different position',
    classification: 'INTERNAL',
    entityType: 'PLAYER',
  });
  registerFabricSchema({
    eventType: 'player.position.changed', version: 1,
    describes: 'The position token before and after',
    schema: z.object({ from: positionToken, to: positionToken, teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'player.status.changed',
    describes: 'A player’s availability or standing changed',
    // The NAMES of medical and payment fields travel; their values never do.
    // The classification is what tells a consumer that a medical field is in
    // play at all.
    classification: 'RESTRICTED',
    entityType: 'PLAYER',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'player.status.changed', version: 1,
    describes: 'Which status fields changed, by name. Never a medical value',
    schema: z.object({ changedFields, teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'player.team.changed',
    describes: 'A player moved between two squads at the same club',
    classification: 'CONFIDENTIAL',
    entityType: 'PLAYER',
  });
  registerFabricSchema({
    eventType: 'player.team.changed', version: 1,
    describes: 'The kind of squad he left and the kind he joined',
    schema: z.object({ from: teamKind, to: teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'player.squad.added',
    describes: 'A player who belonged to no squad joined one',
    classification: 'CONFIDENTIAL',
    entityType: 'PLAYER',
  });
  registerFabricSchema({
    eventType: 'player.squad.added', version: 1,
    describes: 'The kind of squad he joined',
    schema: z.object({ teamKind }).strict(),
  });

  registerFabricEvent({
    type: 'player.squad.removed',
    describes: 'A player left a squad and remains at the club without one',
    classification: 'CONFIDENTIAL',
    entityType: 'PLAYER',
  });
  registerFabricSchema({
    eventType: 'player.squad.removed', version: 1,
    describes: 'The kind of squad he left',
    schema: z.object({ teamKind }).strict(),
  });

  // Registered in the taxonomy since the fabric existed, and unproduced until
  // now. Three settlement paths reach it: a direct purchase, an accepted offer
  // and a settled auction.
  registerFabricSchema({
    eventType: 'player.transferred', version: 1,
    // No fee, no wage, no release clause. What a club paid for a player is
    // commercially confidential and belongs in the transfer record, which is
    // read under authorisation; an observability surface gets the fact that he
    // moved and the two clubs between which he moved.
    describes: 'The club he left, how the move was settled, and the squad he joined',
    schema: z.object({
      fromClubId: clubRef,
      settledBy: z.enum(['PURCHASE', 'OFFER_ACCEPTED', 'AUCTION']),
      teamKind,
    }).strict(),
  });
}

registerPlayersProducer();

// ── the helpers the Players services call ────────────────────────────────────

/** Who did it and to whom. Common to every helper below. */
export interface PlayerContext {
  playerId: string;
  clubId: string;
  teamId?: string | null;
  actorUserId?: string | null;
  sourceType?: EventSourceType;
}

function publish(
  eventType: string,
  ctx: PlayerContext,
  payload: Record<string, unknown>,
): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'PLAYER',
    subjectId: ctx.playerId,
    sourceType: ctx.sourceType ?? 'USER',
    payload,
  });
}

/**
 * Field names, cleaned to names.
 *
 * Trimmed, de-duplicated, capped in count and length — the same shape the
 * schema declares and the same cap `project()` applies when it puts the array
 * on a frame. A caller that passed a value rather than a name would still be
 * truncated to something that cannot carry a sentence.
 */
export function fieldNames(fields: readonly string[]): string[] {
  return [...new Set(fields.map((f) => String(f).trim()).filter(Boolean))]
    .slice(0, 24)
    .map((f) => f.slice(0, 40));
}

export function publishPlayerCreated(ctx: PlayerContext, kind: string | null): void {
  publish('player.created', ctx, { teamKind: kind ?? null });
}

export function publishPlayerUpdated(
  ctx: PlayerContext, fields: readonly string[], kind: string | null,
): void {
  publish('player.updated', ctx, { changedFields: fieldNames(fields), teamKind: kind ?? null });
}

export function publishPlayerPhotoAttached(ctx: PlayerContext, kind: string | null): void {
  publish('player.photo.attached', ctx, { teamKind: kind ?? null });
}

export function publishPlayerProfileUpdated(
  ctx: PlayerContext, fields: readonly string[], kind: string | null,
): void {
  if (!fields.length) return;
  publish('player.profile.updated', ctx, { changedFields: fieldNames(fields), teamKind: kind ?? null });
}

export function publishPlayerPositionChanged(
  ctx: PlayerContext, from: string | null, to: string | null, kind: string | null,
): void {
  publish('player.position.changed', ctx, { from: from ?? null, to: to ?? null, teamKind: kind ?? null });
}

export function publishPlayerStatusChanged(
  ctx: PlayerContext, fields: readonly string[], kind: string | null,
): void {
  if (!fields.length) return;
  publish('player.status.changed', ctx, { changedFields: fieldNames(fields), teamKind: kind ?? null });
}

export function publishPlayerTeamChanged(
  ctx: PlayerContext, from: string | null, to: string | null,
): void {
  publish('player.team.changed', ctx, { from: from ?? null, to: to ?? null });
}

export function publishPlayerSquadAdded(ctx: PlayerContext, kind: string | null): void {
  publish('player.squad.added', ctx, { teamKind: kind ?? null });
}

export function publishPlayerSquadRemoved(ctx: PlayerContext, kind: string | null): void {
  publish('player.squad.removed', ctx, { teamKind: kind ?? null });
}

export function publishPlayerTransferred(
  ctx: PlayerContext,
  fromClubId: string,
  settledBy: 'PURCHASE' | 'OFFER_ACCEPTED' | 'AUCTION',
  kind: string | null,
): void {
  // `ctx.clubId` is the ACQUIRING club — the tenant the player now belongs to,
  // and the one whose squad changed. The club he left is named in the payload
  // rather than in the envelope because an event has one tenant and the
  // player's tenant is, from the moment this commits, the buyer.
  publish('player.transferred', ctx, {
    fromClubId: String(fromClubId), settledBy, teamKind: kind ?? null,
  });
}
