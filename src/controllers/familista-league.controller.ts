// Familista League — read endpoints for the club-facing screen.
//
// Every handler here reads. There is no write path in this controller, which is
// what keeps a league nobody owns safe to show to everybody: a club may look at
// the table it plays in, and the only way to change that table is through the
// competition engine, whose owner check a null-owner competition can never pass
// except as SUPER_ADMIN.

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as league from '../competition/familista-league.service';
import * as admin from '../competition/familista-league.admin.service';
import * as teamAccess from '../identity/team-access.service';
import { NotFoundError } from '../utils/errors';

const querySchema = z.object({
  season: z.string().trim().min(1).max(32).optional(),
  code: z.string().trim().min(1).max(64).optional(),
  /**
   * The team whose league this is. Naming one scopes every answer below to the
   * competition THAT team is entered in — which is how an academy age group
   * reads its own league. Omitting it is the First Team's path, unchanged: the
   * platform league by code and season, exactly as before.
   */
  teamId: z.string().uuid().optional(),
});

/** The caller's active club, as the auth layer resolved it. Never from input. */
function callerClubId(req: Request): string | null {
  const u = (req as Request & { user?: { currentClubId?: string; clubId?: string } }).user;
  return u?.currentClubId ?? u?.clubId ?? null;
}

function actorOf2(req: Request): teamAccess.TeamActor {
  const u = (req as Request & {
    user?: { id?: string; userId?: string; role?: string; currentClubId?: string; clubId?: string };
  }).user;
  return {
    userId: u?.id ?? u?.userId ?? '',
    clubId: u?.currentClubId ?? u?.clubId ?? '',
    role: u?.role,
  };
}

/**
 * The league a request is about, and — when it named a team — what the caller
 * may do with that team.
 *
 * A team id is checked against this caller's assignments BEFORE it is used to
 * find a competition, so a team id typed into a URL is refused here rather than
 * quietly answered with somebody else's league.
 */
async function resolveScope(req: Request): Promise<{
  found: league.LeagueSummary | null;
  teamId: string | null;
  access: teamAccess.TeamAccess | null;
}> {
  const q = querySchema.parse(req.query);
  if (q.teamId) {
    const access = await teamAccess.assertCanViewTeam(actorOf2(req), q.teamId);
    const found = await league.getLeagueForTeam(q.teamId, { season: q.season });
    return { found, teamId: q.teamId, access };
  }
  const found = await league.getLeague({ season: q.season, code: q.code });
  return { found, teamId: null, access: null };
}

async function resolveLeague(req: Request) {
  const { found } = await resolveScope(req);
  if (!found) throw new NotFoundError('Familista League');
  return found;
}

/**
 * The league, its season, its configured rules and the reader's own teams in
 * it. One call, because the screen needs all four before it can draw anything.
 */
export async function getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { found, teamId, access } = await resolveScope(req);
    // A platform with no league yet — or a team not entered in one — is a
    // normal state, not an error: the screen has an empty state for it and
    // says so rather than failing.
    if (!found) {
      res.json({ success: true, data: { league: null, myTeamIds: [], teamId, access } });
      return;
    }
    // Scoped to a team, "my teams in this league" is that team and nothing
    // else — an age group's table highlights its own row, not its club's
    // senior side sitting in a different competition.
    const myTeamIds = teamId ? [teamId] : await league.getMyTeamIds(found.id, callerClubId(req));
    res.json({ success: true, data: { league: found, myTeamIds, teamId, access } });
  } catch (err) { next(err); }
}

export async function getStandings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { found, teamId } = await resolveScope(req);
    if (!found) throw new NotFoundError('Familista League');
    const [table, myTeamIds] = await Promise.all([
      league.getStandings(found.id),
      teamId ? Promise.resolve([teamId]) : league.getMyTeamIds(found.id, callerClubId(req)),
    ]);
    res.json({ success: true, data: { ...table, myTeamIds, season: found.season } });
  } catch (err) { next(err); }
}

const roundSchema = z.object({ round: z.coerce.number().int().min(1).max(200).optional() });

export async function getMatches(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const { round } = roundSchema.parse(req.query);
    const [view, myTeamIds] = await Promise.all([
      league.getRound(found.id, round),
      league.getMyTeamIds(found.id, callerClubId(req)),
    ]);
    res.json({ success: true, data: { ...view, myTeamIds, season: found.season } });
  } catch (err) { next(err); }
}

const boardSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });

export async function getLeaderboards(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const { limit } = boardSchema.parse(req.query);
    const boards = await league.getLeaderboards(found.id, limit ?? 10);
    res.json({ success: true, data: { ...boards, season: found.season, clubId: callerClubId(req) } });
  } catch (err) { next(err); }
}

const teamSchema = z.object({ teamId: z.string().uuid() });

export async function getTeamRecord(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const { teamId } = teamSchema.parse(req.params);
    const record = await league.getTeamRecord(found.id, teamId);
    res.json({ success: true, data: record });
  } catch (err) { next(err); }
}

export async function getTeamStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const rows = await league.getTeamStats(found.id);
    res.json({ success: true, data: { rows, season: found.season } });
  } catch (err) { next(err); }
}

const fixtureSchema = z.object({ fixtureId: z.string().uuid() });

/**
 * One league match in full — the payload the Match Centre opens with. Readable
 * by any signed-in club because a league match belongs to the competition both
 * of them play in, not to either one of them.
 */
export async function getMatchDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const { fixtureId } = fixtureSchema.parse(req.params);
    const detail = await league.getMatchDetail(found.id, fixtureId);
    res.json({ success: true, data: detail });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Administration — participants and the calendar
// ─────────────────────────────────────────────────────────────────────────────
//
// Every handler below goes through `assertLeagueAdmin` inside the service, so
// the rule holds even if a route is ever mounted without its middleware. The
// actor's club is read from the session, never from the request body.

function actorOf(req: Request): admin.LeagueActor {
  const u = (req as Request & { user?: { id?: string; userId?: string; role?: string; currentClubId?: string; clubId?: string } }).user;
  return {
    userId: u?.id ?? u?.userId ?? '',
    clubId: u?.currentClubId ?? u?.clubId ?? '',
    role: u?.role,
  };
}

/**
 * Whether this caller may manage the league — the screen asks before drawing.
 *
 * Deliberately answers even when no season exists. That is the state a fresh
 * platform is in, and it is exactly when an administrator needs to see the
 * control: refusing here would hide League management behind the very thing it
 * is meant to set up.
 */
export async function getManageContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Through the same resolver every other handler uses, so the screen asking
    // from an age group's workspace is told about THAT team's competition — not
    // the First Team's, which is what a direct getLeague() call answered and
    // would have had an administrator editing the wrong league's participants.
    const { found, teamId, access } = await resolveScope(req);
    let canManage = true;
    try { admin.assertLeagueAdmin(actorOf(req)); } catch (_) { canManage = false; }
    const participants = canManage && found ? await admin.listParticipants(found.id) : [];
    res.json({
      success: true,
      data: {
        // A platform administrator still decides who is in a league; scoped to
        // a team, they must also work on that team. Administering a team's
        // competition — its participants, its calendar, its kickoffs — is the
        // team's own business, so it takes private sight of it and not merely
        // membership of the club it belongs to.
        canManage: canManage && (!teamId || !!access?.canViewPrivate),
        participants,
        season: found?.season ?? null,
        competitionId: found?.id ?? null,
        teamId,
        // No competition means no season has been created yet. The panel says
        // so rather than showing an empty list that looks like a lost one.
        hasSeason: !!found,
      },
    });
  } catch (err) { next(err); }
}

const searchSchema = z.object({
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function getEligibleTeams(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    admin.assertLeagueAdmin(actorOf(req));
    const q = searchSchema.parse(req.query);
    const teams = await admin.listEligibleTeams(found.id, q);
    res.json({ success: true, data: { teams } });
  } catch (err) { next(err); }
}

const addSchema = z.object({ teamId: z.string().uuid() });

export async function addParticipant(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const { teamId } = addSchema.parse(req.body ?? {});
    const participants = await admin.addParticipant(actorOf(req), found.id, teamId);
    res.json({ success: true, data: { participants } });
  } catch (err) { next(err); }
}

export async function removeParticipant(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const { teamId } = teamSchema.parse(req.params);
    const outcome = await admin.removeParticipant(actorOf(req), found.id, teamId);
    res.json({ success: true, data: outcome });
  } catch (err) { next(err); }
}

const scheduleSchema = z.object({
  startDate: z.string().trim().min(8).max(32).optional(),
  intervalDays: z.coerce.number().int().min(1).max(60).optional(),
});

export async function rebuildSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const opts = scheduleSchema.parse(req.body ?? {});
    const outcome = await admin.rebuildSchedule(actorOf(req), found.id, opts);
    res.json({ success: true, data: outcome });
  } catch (err) { next(err); }
}

const rescheduleSchema = z.object({
  scheduledAt: z.string().trim().min(8),
  venue: z.string().trim().max(120).nullable().optional(),
});

export async function rescheduleFixture(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { fixtureId } = fixtureSchema.parse(req.params);
    const body = rescheduleSchema.parse(req.body ?? {});
    const out = await admin.rescheduleFixture(actorOf(req), fixtureId, body.scheduledAt, body.venue);
    res.json({ success: true, data: out });
  } catch (err) { next(err); }
}
