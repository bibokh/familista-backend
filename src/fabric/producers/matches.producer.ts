// The Matches domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// The fourth domain migrated, and the widest: a Match is written by the club's
// own Match Centre, by the Familista League's administration, by the fixture
// change-request flow, by the lineup editor and by the live event feed. All of
// it is ONE source and one lane. A competition is a property of a match, not a
// producer of its own, so adding a cup or a tournament later adds rows to the
// board rather than a card beside it.
//
// WHAT TELLS THE CONTEXTS APART
//
//   teamKind       SENIOR, RESERVES, ACADEMY_U17 — first team from academy,
//                  and the age group with it.
//   competition    LEAGUE, CUP, FRIENDLY, ELITE, ASSOCIATION — the platform's
//                  own enum, so a friendly and a league match are told apart
//                  without a second source.
//   competitionId  The Familista League competition a fixture belongs to, when
//                  the match is played as one. Null for a club's own fixture.
//
// Every one of those is an id or an enum token. None of them is about a person.
//
// WHAT NEVER TRAVELS
//
// A match row carries `opponentNotes` and `aiInsights`; a lineup carries
// `positions` — an array of player ids and opponent names — and `notes`, which
// is where a coach writes what he actually thinks. A match event carries a
// player, a minute and sometimes a description.
//
// So: `opponentNotes` and `aiInsights` never travel, because scouting analysis
// is the club's own. `positions` travels as a COUNT, because a list of ids is a
// list of children. Lineup `notes` never travel at all. `venue` never travels
// as a value — a ground plus a kickoff time is where a named squad will be, the
// same rule training grounds get. And a match event carries its TYPE and its
// period, never its description and never the player it was about.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const MATCHES_SOURCE_ID = 'matches';

/** A `TeamKind` token, or null for a match attached to no team. */
const teamKind = z.string().min(1).max(40).nullable();
/** A `CompetitionType` token — LEAGUE, CUP, FRIENDLY, ELITE, ASSOCIATION. */
const competition = z.string().min(1).max(40).nullable();
/** The competition id, when the match is played as a registered fixture. */
const competitionId = z.string().min(1).max(64).nullable();
/**
 * The competition's own registered CODE, when it has one.
 *
 * `Competition.code` is part of the `[clubId, code, season]` unique key — a
 * short structured identifier, not prose. It travels; `Competition.name` and
 * `Match.competitionName` do not, because those are free text somebody typed
 * and an observability surface is not where free text belongs.
 *
 * Null for a match that names a competition only in free text. In that case the
 * generic `competition` type below — CUP, FRIENDLY — is all that is known, and
 * all that is said. Nothing here invents or normalises a name.
 */
const competitionCode = z.string().min(1).max(64).nullable();
/** A `MatchStatus` token. */
const statusToken = z.string().min(1).max(32).nullable();
const changedFields = z.array(z.string().min(1).max(40)).max(32);
const count = z.number().int().nonnegative().max(1_000_000);

/**
 * The context every Matches event carries.
 *
 * Present on all of them rather than on some, so a consumer filtering academy
 * fixtures out of a firehose can do it with one field test whatever the event
 * is. Three tokens and an id; nothing here describes a person.
 */
const context = { teamKind, competition, competitionId, competitionCode };

export function registerMatchesProducer(): void {
  // `match.started`, `match.completed` and `match.event.recorded` are already
  // registered in `event-taxonomy.ts` — the last of them carrying the legacy
  // `MATCH_EVENT` outbox kind. Registering any of them again with different
  // settings would be refused, correctly. Their payload SHAPES are declared
  // here, because this is the file that builds them.

  registerFabricEvent({
    type: 'match.created',
    describes: 'A fixture was put in the calendar',
    classification: 'INTERNAL',
    entityType: 'MATCH',
  });
  registerFabricSchema({
    eventType: 'match.created', version: 1,
    describes: 'The competition and squad it was created for. Never the opponent notes',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricEvent({
    type: 'match.updated',
    describes: 'A match record changed',
    classification: 'INTERNAL',
    entityType: 'MATCH',
  });
  registerFabricSchema({
    eventType: 'match.updated', version: 1,
    describes: 'Which fields the caller asked to change, by name',
    schema: z.object({ changedFields, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'match.deleted',
    describes: 'A match was removed from the calendar',
    classification: 'INTERNAL',
    entityType: 'MATCH',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'match.deleted', version: 1,
    describes: 'The competition and squad whose fixture it was',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricEvent({
    type: 'match.cancelled',
    describes: 'A match will not produce a result — called off or abandoned',
    classification: 'INTERNAL',
    entityType: 'MATCH',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'match.cancelled', version: 1,
    describes: 'Which of the two it was. Never the reason somebody typed',
    schema: z.object({ status: statusToken, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'match.status.changed',
    describes: 'A match moved between lifecycle states',
    classification: 'INTERNAL',
    entityType: 'MATCH',
  });
  registerFabricSchema({
    eventType: 'match.status.changed', version: 1,
    describes: 'The status token before and after',
    schema: z.object({ from: statusToken, to: statusToken, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'match.time.changed',
    describes: 'A match kickoff was moved',
    classification: 'INTERNAL',
    entityType: 'MATCH',
  });
  registerFabricSchema({
    eventType: 'match.time.changed', version: 1,
    // How it was moved, not when to. A kickoff time is not itself sensitive —
    // it is published in every calendar — but it is half of "where a named
    // squad of children will be", and the other half is the venue below. The
    // pair is withheld rather than the weaker of the two.
    describes: 'That the kickoff moved, and through which route',
    schema: z.object({ route: z.enum(['EDIT', 'REQUEST_APPROVED', 'LEAGUE_ADMIN']), ...context }).strict(),
  });

  registerFabricEvent({
    type: 'match.venue.changed',
    describes: 'A match was moved to a different ground',
    // RESTRICTED for the reason training venues are: a ground plus a kickoff
    // time is where a named squad will physically be.
    classification: 'RESTRICTED',
    entityType: 'MATCH',
  });
  registerFabricSchema({
    eventType: 'match.venue.changed', version: 1,
    describes: 'That the ground changed. Deliberately not to where',
    schema: z.object({ route: z.enum(['EDIT', 'LEAGUE_ADMIN']), ...context }).strict(),
  });

  registerFabricEvent({
    type: 'match.lineup.updated',
    describes: 'A team sheet was set or changed for a match',
    // CONFIDENTIAL: the underlying row holds player ids and a coach's own
    // notes. The event carries a side and a count.
    classification: 'CONFIDENTIAL',
    entityType: 'MATCH',
  });
  registerFabricSchema({
    eventType: 'match.lineup.updated', version: 1,
    describes: 'Which side, and how many positions. Never who, never the notes',
    schema: z.object({
      side: z.enum(['HOME', 'AWAY']), players: count, ...context,
    }).strict(),
  });

  registerFabricEvent({
    type: 'match.result.updated',
    describes: 'A score or result was recorded',
    classification: 'INTERNAL',
    entityType: 'MATCH',
  });
  registerFabricSchema({
    eventType: 'match.result.updated', version: 1,
    // A score IS public — it is the point of the fixture, printed in every
    // table. Carried because an operator watching results arrive is the whole
    // reason this event exists.
    describes: 'The score as recorded, and the result token',
    schema: z.object({
      homeScore: z.number().int().nullable(),
      awayScore: z.number().int().nullable(),
      result: z.string().min(1).max(16).nullable(),
      ...context,
    }).strict(),
  });

  // ── the three already in the taxonomy ──────────────────────────────────────

  registerFabricSchema({
    eventType: 'match.started', version: 1,
    describes: 'The competition and squad whose match kicked off',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricSchema({
    eventType: 'match.completed', version: 1,
    describes: 'The score at full time, and the context it was played in',
    schema: z.object({
      homeScore: z.number().int().nullable(),
      awayScore: z.number().int().nullable(),
      result: z.string().min(1).max(16).nullable(),
      ...context,
    }).strict(),
  });

  // ── the two aggregates ─────────────────────────────────────────────────────
  //
  // Both exist because the alternative is a flood. Generating a season's
  // fixtures writes a Match per pairing — a twenty-team league is 380 rows —
  // and a provider feed arrives five thousand events at a time. An event per
  // row would drown the board in exactly the moment an operator most needs to
  // read it, and would say nothing a single count does not.

  registerFabricEvent({
    type: 'match.fixtures.generated',
    describes: 'A competition’s fixture list was turned into matches',
    classification: 'INTERNAL',
    // The subject is the COMPETITION, not any one of the matches — which is
    // also why its id may travel: a competition is not a person.
    entityType: 'COMPETITION',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'match.fixtures.generated', version: 1,
    describes: 'How many matches the generation created, and for which competition',
    schema: z.object({ generatedCount: count, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'match.events.batch.ingested',
    describes: 'A batch of match events was taken from a provider feed',
    classification: 'INTERNAL',
    entityType: 'MATCH',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'match.events.batch.ingested', version: 1,
    // Counts and a provider CATEGORY. Not one raw provider payload, not a
    // scorer, not a description — the same rule the single-event form follows,
    // applied to five thousand of them at once.
    describes: 'How many arrived, how many were taken, how many refused, and from which provider',
    schema: z.object({
      provider: z.string().min(1).max(40),
      receivedCount: count,
      acceptedCount: count,
      rejectedCount: count,
      status: z.enum(['COMPLETE', 'FAILED']),
      ...context,
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'match.event.recorded', version: 1,
    // A goal, a card, a substitution. The TYPE and the period travel; the
    // description does not, and neither does the player it was about — a
    // scorer is a named person who is often a child.
    describes: 'What kind of thing happened and in which period. Never who, never the description',
    schema: z.object({
      kind: z.string().min(1).max(40),
      period: z.number().int().min(1).max(5).nullable(),
      source: z.enum(['MANUAL', 'FEED', 'BATCH']),
      events: count,
      ...context,
    }).strict(),
  });
}

registerMatchesProducer();

// ── the helpers the Matches services call ────────────────────────────────────

/** The context every helper needs, resolved once by its caller. */
export interface MatchContext {
  matchId: string;
  clubId: string;
  teamId?: string | null;
  actorUserId?: string | null;
  sourceType?: EventSourceType;
  teamKind?: string | null;
  competition?: string | null;
  competitionId?: string | null;
  competitionCode?: string | null;
}

function ctxPayload(ctx: MatchContext): Record<string, unknown> {
  return {
    teamKind: ctx.teamKind ?? null,
    competition: ctx.competition ?? null,
    competitionId: ctx.competitionId ?? null,
    competitionCode: ctx.competitionCode ?? null,
  };
}

function publish(eventType: string, ctx: MatchContext, extra: Record<string, unknown> = {}): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MATCH',
    subjectId: ctx.matchId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: { ...extra, ...ctxPayload(ctx) },
  });
}

/** Field names, cleaned to names. Capped in count and in length. */
export function fieldNames(fields: readonly string[]): string[] {
  return [...new Set(fields.map((f) => String(f).trim()).filter(Boolean))]
    .slice(0, 32)
    .map((f) => f.slice(0, 40));
}

export function publishMatchCreated(ctx: MatchContext): void {
  publish('match.created', ctx);
}

export function publishMatchUpdated(ctx: MatchContext, fields: readonly string[]): void {
  publish('match.updated', ctx, { changedFields: fieldNames(fields) });
}

export function publishMatchDeleted(ctx: MatchContext): void {
  publish('match.deleted', ctx);
}

export function publishMatchStatusChanged(
  ctx: MatchContext, from: string | null, to: string | null,
): void {
  publish('match.status.changed', ctx, { from: from ?? null, to: to ?? null });
}

export function publishMatchStarted(ctx: MatchContext): void {
  publish('match.started', ctx);
}

export function publishMatchCompleted(
  ctx: MatchContext, homeScore: number | null, awayScore: number | null, result: string | null,
): void {
  publish('match.completed', ctx, { homeScore, awayScore, result: result ?? null });
}

export function publishMatchCancelled(ctx: MatchContext, status: string | null): void {
  publish('match.cancelled', ctx, { status: status ?? null });
}

export function publishMatchTimeChanged(
  ctx: MatchContext, route: 'EDIT' | 'REQUEST_APPROVED' | 'LEAGUE_ADMIN',
): void {
  publish('match.time.changed', ctx, { route });
}

export function publishMatchVenueChanged(
  ctx: MatchContext, route: 'EDIT' | 'LEAGUE_ADMIN',
): void {
  publish('match.venue.changed', ctx, { route });
}

export function publishMatchLineupUpdated(
  ctx: MatchContext, side: 'HOME' | 'AWAY', players: number,
): void {
  publish('match.lineup.updated', ctx, { side, players: Math.max(0, players) });
}

export function publishMatchResultUpdated(
  ctx: MatchContext, homeScore: number | null, awayScore: number | null, result: string | null,
): void {
  publish('match.result.updated', ctx, { homeScore, awayScore, result: result ?? null });
}

/**
 * One event for a whole fixture generation.
 *
 * The subject is the competition, so the envelope's `clubId` is the
 * competition's owner — null for the Familista League, which belongs to the
 * platform rather than to any club.
 */
export function publishMatchFixturesGenerated(
  ctx: Omit<MatchContext, 'matchId' | 'clubId'> & { competitionId: string; clubId: string | null },
  generatedCount: number,
): void {
  publishFabricEventDetached({
    eventType: 'match.fixtures.generated',
    clubId: ctx.clubId,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'COMPETITION',
    subjectId: ctx.competitionId,
    sourceType: ctx.sourceType ?? 'USER',
    payload: {
      generatedCount: Math.max(0, generatedCount),
      teamKind: ctx.teamKind ?? null,
      competition: ctx.competition ?? null,
      competitionId: ctx.competitionId,
      competitionCode: ctx.competitionCode ?? null,
    },
  });
}

/** One event for a whole provider batch, however many rows it carried. */
export function publishMatchEventsBatchIngested(
  ctx: MatchContext,
  provider: string,
  counts: { received: number; accepted: number; rejected: number },
  status: 'COMPLETE' | 'FAILED',
): void {
  publish('match.events.batch.ingested', ctx, {
    provider: String(provider).slice(0, 40),
    receivedCount: Math.max(0, counts.received),
    acceptedCount: Math.max(0, counts.accepted),
    rejectedCount: Math.max(0, counts.rejected),
    status,
  });
}

export function publishMatchEventRecorded(
  ctx: MatchContext,
  kind: string,
  period: number | null,
  source: 'MANUAL' | 'FEED' | 'BATCH',
  events = 1,
): void {
  publish('match.event.recorded', ctx, {
    kind: String(kind).slice(0, 40), period, source, events: Math.max(0, events),
  });
}
