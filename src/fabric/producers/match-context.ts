// What tells one match context from another
// ─────────────────────────────────────────────────────────────────────────────
// A Match is written by the club's Match Centre, by the Familista League, by
// the fixture change-request flow and by the lineup editor. All of it is one
// Data Fabric source; what distinguishes an academy friendly from a first-team
// league fixture is three tokens and an id, resolved here so every producer
// answers the question the same way.
//
// Kept apart from `matches.producer.ts` because it is the only piece of the
// Matches integration that reads the database, and the producer modules are
// deliberately free of Prisma — a registry of contracts should not need a
// connection to describe itself.

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import {
  publishMatchTimeChanged, publishMatchVenueChanged, type MatchContext,
} from './matches.producer';

/** The columns the context is derived from. Everything a caller already holds. */
export interface MatchLike {
  id: string;
  clubId: string;
  teamId: string | null;
  status: string;
  scheduledAt: Date | string;
  venue: string | null;
  competition: string | null;
  homeScore: number | null;
  awayScore: number | null;
  result: string | null;
}

/**
 * Resolve a match's fabric context.
 *
 * Two indexed lookups at most, both optional: the squad's kind, and the league
 * competition the match is played as a fixture of. A club's own friendly needs
 * neither and costs one miss on an indexed column.
 *
 * Always called from inside a detached publish, never on a request path.
 */
export async function matchContext(
  match: MatchLike,
  actorUserId: string | null,
): Promise<MatchContext> {
  const [team, fixture] = await Promise.all([
    match.teamId
      ? prisma.team.findUnique({ where: { id: match.teamId }, select: { kind: true } })
      : Promise.resolve(null),
    // A match played as a Familista League fixture carries that competition's
    // identity; the overwhelming majority of matches are not, and answer null
    // from a single indexed lookup.
    prisma.fixture.findFirst({ where: { matchId: match.id }, select: { competitionId: true } })
      .catch(() => null),
  ]);

  return {
    matchId: match.id,
    clubId: match.clubId,
    teamId: match.teamId ?? null,
    actorUserId,
    teamKind: team?.kind ?? null,
    competition: match.competition ?? null,
    competitionId: fixture?.competitionId ?? null,
  };
}


/**
 * Announce that a match was rescheduled, from whichever route moved it.
 *
 * THREE routes move a kickoff: a Match Centre edit (which goes through
 * `updateMatch` and publishes from the funnel there), an approved fixture
 * change request, and a League administrator's reschedule. The last two write
 * the Match row directly, so they announce through here — one helper, so the
 * two cannot drift into describing the same fact differently.
 *
 * `route` is carried because it is the operationally interesting part: a
 * kickoff that moved because a club asked and an opponent agreed is a different
 * thing from one an administrator moved, and an operator looking at a cluster
 * of reschedules wants to know which.
 *
 * Detached, self-reading, and never able to fail the reschedule it describes —
 * the match has already moved by the time this runs.
 */
export function announceReschedule(
  matchId: string,
  actorUserId: string | null,
  route: 'REQUEST_APPROVED' | 'LEAGUE_ADMIN',
  venueAlsoMoved: boolean,
): void {
  void (async () => {
    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return;
    const ctx = await matchContext(match as unknown as MatchLike, actorUserId);
    publishMatchTimeChanged(ctx, route);
    // A League administrator may move the ground in the same call. The Match
    // Centre's request flow moves only the time, and says so by passing false.
    if (venueAlsoMoved && route === 'LEAGUE_ADMIN') publishMatchVenueChanged(ctx, 'LEAGUE_ADMIN');
  })().catch((err) => logger.warn('[fabric] a reschedule could not be recorded', {
    matchId, err: (err as Error)?.message,
  }));
}
