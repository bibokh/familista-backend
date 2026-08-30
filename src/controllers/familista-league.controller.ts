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
import { NotFoundError } from '../utils/errors';

const querySchema = z.object({
  season: z.string().trim().min(1).max(32).optional(),
  code: z.string().trim().min(1).max(64).optional(),
});

/** The caller's active club, as the auth layer resolved it. Never from input. */
function callerClubId(req: Request): string | null {
  const u = (req as Request & { user?: { currentClubId?: string; clubId?: string } }).user;
  return u?.currentClubId ?? u?.clubId ?? null;
}

async function resolveLeague(req: Request) {
  const q = querySchema.parse(req.query);
  const found = await league.getLeague({ season: q.season, code: q.code });
  if (!found) throw new NotFoundError('Familista League');
  return found;
}

/**
 * The league, its season, its configured rules and the reader's own teams in
 * it. One call, because the screen needs all four before it can draw anything.
 */
export async function getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = querySchema.parse(req.query);
    const found = await league.getLeague({ season: q.season, code: q.code });
    // A platform with no league yet is a normal state, not an error: the screen
    // has an empty state for it and says so rather than failing.
    if (!found) {
      res.json({ success: true, data: { league: null, myTeamIds: [] } });
      return;
    }
    const myTeamIds = await league.getMyTeamIds(found.id, callerClubId(req));
    res.json({ success: true, data: { league: found, myTeamIds } });
  } catch (err) { next(err); }
}

export async function getStandings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const found = await resolveLeague(req);
    const [table, myTeamIds] = await Promise.all([
      league.getStandings(found.id),
      league.getMyTeamIds(found.id, callerClubId(req)),
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
