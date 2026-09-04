// Team scope, at the door
// ─────────────────────────────────────────────────────────────────────────────
// `identity/team-access.service.ts` decides who may do what with a team. This
// file is how a ROUTE asks it, so that a module which is private to one team is
// refused before its controller runs rather than after its query has already
// read the row.
//
// Nothing here decides anything. Every function below resolves a team id — from
// the URL, from the query string, from the body, or from the row a `:id` names
// — and hands it to team-access. A team id that arrives from the browser is
// never trusted: it is the QUESTION, and the membership is the answer.
//
// The gates, in the order they get stricter:
//
//   requireTeamPrivate    the team's own operational content: squad, lineup,
//                         formation, tactics, preparation, analysis, medical.
//   requireTeamManage     changing any of it.
//   requireAnyTeamPrivate a module private to the club's teams that the schema
//                         keeps against the CLUB rather than against one team —
//                         the training calendar is the case today. It refuses
//                         the ordinary club member, and does not pretend to a
//                         per-team separation the data cannot express.

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import * as teamAccess from '../identity/team-access.service';
import { ForbiddenError } from '../utils/errors';

/** Whether the request carries a session at all. A route that authenticates
 *  itself — the live SSE stream takes its token in the query string — must not
 *  be pre-empted here; it is refused by its own auth, not by a team rule. */
export function isAuthenticated(req: Request): boolean {
  const u = (req as Request & { user?: { id?: string; userId?: string } }).user;
  return !!(u && (u.id || u.userId));
}

export function actorOfRequest(req: Request): teamAccess.TeamActor {
  const u = (req as Request & {
    user?: { id?: string; userId?: string; role?: string; currentClubId?: string; clubId?: string };
  }).user;
  return {
    userId: u?.id ?? u?.userId ?? '',
    clubId: u?.currentClubId ?? u?.clubId ?? '',
    role: u?.role,
  };
}

/** Where a team id may legitimately arrive from, in the order it is looked for. */
function teamIdFrom(req: Request, params: string[]): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const key of params) {
    const fromParam = req.params?.[key];
    if (typeof fromParam === 'string' && fromParam) return fromParam;
    const fromQuery = req.query?.[key];
    if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
    const fromBody = body[key];
    if (typeof fromBody === 'string' && fromBody) return fromBody;
  }
  return null;
}

/**
 * The team ids a request may name. `teamId` covers the common case; the academy
 * screens send the same thing under their own names, and a route that accepts a
 * team id under any of them must check it under all of them.
 */
export const TEAM_ID_KEYS = ['teamId', 'academyTeamId', 'ageGroupTeamId'];

type Mode = 'view' | 'private' | 'manage';

async function enforce(actor: teamAccess.TeamActor, teamId: string, mode: Mode): Promise<void> {
  if (mode === 'manage') { await teamAccess.assertCanManageTeam(actor, teamId); return; }
  if (mode === 'private') { await teamAccess.assertCanViewTeamPrivate(actor, teamId); return; }
  await teamAccess.assertCanViewTeam(actor, teamId);
}

/**
 * Refuse unless the caller may read this team's private content.
 *
 * `required: false` — the default — means a request that names no team is left
 * alone: those routes have their own club scope, and this middleware exists to
 * check a named team rather than to invent one.
 */
export function requireTeamPrivate(opts: { keys?: string[]; required?: boolean } = {}) {
  const keys = opts.keys ?? TEAM_ID_KEYS;
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const teamId = teamIdFrom(req, keys);
      if (!teamId) {
        if (opts.required) throw new ForbiddenError('A team must be named for this request');
        return next();
      }
      await enforce(actorOfRequest(req), teamId, 'private');
      next();
    } catch (err) { next(err); }
  };
}

/** Refuse unless the caller is assigned to manage the team the request names. */
export function requireTeamManage(opts: { keys?: string[]; required?: boolean } = {}) {
  const keys = opts.keys ?? TEAM_ID_KEYS;
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const teamId = teamIdFrom(req, keys);
      if (!teamId) {
        if (opts.required) throw new ForbiddenError('A team must be named for this request');
        return next();
      }
      await enforce(actorOfRequest(req), teamId, 'manage');
      next();
    } catch (err) { next(err); }
  };
}

/**
 * Refuse the club member who works on none of the club's teams.
 *
 * For a module that is private to the club's teams but whose rows carry a club
 * and not a team. It is the honest gate for that shape: the ordinary member is
 * refused, and nobody is told the data is separated per team when it is not.
 */
export function requireAnyTeamPrivate() {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      await teamAccess.assertAnyTeamPrivateAccess(actorOfRequest(req));
      next();
    } catch (err) { next(err); }
  };
}

/**
 * The gate for a route addressed by PLAYER: `/players/:id`, and everything
 * under it.
 *
 * A player belongs to a team, and a player's record — his profile, his
 * attributes, his statistics, his attendance, his medical availability — is
 * that team's private content. Reading takes private sight of his team;
 * changing him takes an assignment to manage it. A player on no team at all
 * belongs to no team workspace, so there is no team rule to apply and the
 * club scope the service already enforces is the whole of it.
 */
export function requirePlayerTeamAccess(param = 'id') {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const playerId = req.params?.[param];
      if (!playerId) return next();
      const player = await prisma.player.findUnique({
        where: { id: playerId },
        select: { clubId: true, teamId: true },
      });
      // No such player, or one in another club: the service answers that — 404
      // and the tenant guard respectively — and this gate does not pre-empt it.
      if (!player || !player.teamId) return next();
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      await enforce(actorOfRequest(req), player.teamId, write ? 'manage' : 'private');
      next();
    } catch (err) { next(err); }
  };
}

/**
 * The gate for a route addressed by TEAM: `/teams/:id`, and everything under it.
 *
 * Reading a team's own row is the club's shell — its name, its age group, its
 * crest — and every member of the club may. Changing it is team control.
 */
export function requireTeamRowAccess(param = 'id') {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const teamId = req.params?.[param];
      if (!teamId) return next();
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      await enforce(actorOfRequest(req), teamId, write ? 'manage' : 'view');
      next();
    } catch (err) { next(err); }
  };
}


/**
 * The gate for a route addressed by TRAINING SESSION: `/training/:id`, and
 * everything under it — attendance, performance, completion.
 *
 * A session belongs to a team, and a team's training week is private to the
 * people assigned to it. Reading one takes private sight of its team; changing
 * one takes an assignment to manage it.
 *
 * A session with no team is a legacy club session — the migration could not
 * attribute it without guessing, and did not. It stays readable by anybody who
 * works on one of the club's teams, because it is nobody else's team's week,
 * and changeable only by somebody who administers the club's teams as a whole.
 * Adopting one by naming a team is an ordinary update, and the team named is
 * checked by `requireTeamManage` on the same route.
 */
export function requireTrainingSessionAccess(param = 'id') {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const sessionId = req.params?.[param];
      if (!sessionId) return next();
      const row = await prisma.trainingSession.findUnique({
        where: { id: sessionId },
        select: { clubId: true, teamId: true },
      });
      // No such session: the service answers that with a 404, and this gate
      // does not pre-empt it or confirm the id's existence to a stranger.
      if (!row) return next();
      const actor = actorOfRequest(req);
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      if (!row.teamId) {
        if (write) await teamAccess.assertClubWideManageAuthority(actor);
        else await teamAccess.assertAnyTeamPrivateAccess(actor);
        return next();
      }
      await enforce(actor, row.teamId, write ? 'manage' : 'private');
      next();
    } catch (err) { next(err); }
  };
}

/**
 * The gate for CREATING something that belongs to a team.
 *
 * The team is named in the body. Naming one takes an assignment to manage it;
 * naming none creates a club-level row, which takes the authority to
 * administer the club's teams as a whole rather than one of them.
 */
export function requireTeamManageForCreate(opts: { keys?: string[] } = {}) {
  const keys = opts.keys ?? TEAM_ID_KEYS;
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const teamId = teamIdFrom(req, keys);
      const actor = actorOfRequest(req);
      if (teamId) { await enforce(actor, teamId, 'manage'); return next(); }
      // No team named. Somebody who manages exactly one team is naming it by
      // implication, and the controller resolves it the same way — from their
      // memberships, never from the request. Anybody else is creating a row
      // that belongs to the club rather than to a team, which takes the
      // authority to administer the club's teams as a whole.
      if (await teamAccess.soleManagedTeamId(actor)) return next();
      await teamAccess.assertClubWideManageAuthority(actor);
      next();
    } catch (err) { next(err); }
  };
}


/**
 * The gate for a route addressed by MATCH: `/matches/:id`, and everything
 * under it.
 *
 * A match belongs to a team — the Under-15s' fixtures are not the First Team's
 * — and its preparation, its lineup, its events and its analysis are that
 * team's private work. Reading takes private sight of its team; changing it
 * takes an assignment to manage that team. A match filed against no team is
 * the club's own and keeps the club scope the service already enforces.
 */
export function requireMatchTeamAccess(param = 'id') {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isAuthenticated(req)) return next();
      const matchId = req.params?.[param];
      if (!matchId) return next();
      const row = await prisma.match.findUnique({
        where: { id: matchId },
        select: { clubId: true, teamId: true },
      });
      if (!row || !row.teamId) return next();
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      await enforce(actorOfRequest(req), row.teamId, write ? 'manage' : 'private');
      next();
    } catch (err) { next(err); }
  };
}
