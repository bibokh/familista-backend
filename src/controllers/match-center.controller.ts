// Match Center — the club's calendar, one fixture, and the reschedule workflow.
//
// Reads are scoped to the caller's own club: this is the club's calendar, not
// the platform's. The League's own routes are unchanged and still serve a league
// match to any participant — the two are different questions and stay separate.
//
// Every write here goes through the service, which validates the kickoff against
// the competition's own policy in the venue's own time zone. Nothing is trusted
// from the request beyond the fixture id, the proposed instant and the words the
// requester typed.

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as mc from '../competition/match-center.service';
import * as teamAccess from '../identity/team-access.service';

function actorOf(req: Request): mc.MatchCenterActor {
  const u = (req as Request & {
    user?: { id?: string; userId?: string; role?: string; currentClubId?: string; clubId?: string };
  }).user;
  return {
    userId: u?.id ?? u?.userId ?? '',
    clubId: u?.currentClubId ?? u?.clubId ?? '',
    role: u?.role,
  };
}

const calendarSchema = z.object({
  from: z.string().trim().min(4).max(40).optional(),
  to: z.string().trim().min(4).max(40).optional(),
  competitionId: z.string().uuid().optional(),
  // The team whose calendar this is. Validated as a uuid here and checked
  // against this caller's assignments in the service — the parse says the shape
  // is possible, team-access says the answer is theirs to have.
  teamId: z.string().uuid().optional(),
});

export async function getCalendar(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = calendarSchema.parse(req.query);
    const data = await mc.getCalendar(actorOf(req), q);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

/**
 * The club's team contexts and what this caller may do with each — the First
 * Team and every academy age group, in one answer.
 *
 * A workspace picker reads this: a team the caller cannot manage is still shown,
 * because a locked card is information, and the level on it is what the screen
 * turns into a read-only state rather than an ambiguous one.
 */
export async function getTeamContexts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const teams = await teamAccess.listTeamContexts(actorOf(req));
    res.json({ success: true, data: { teams } });
  } catch (err) { next(err); }
}

const fixtureSchema = z.object({ fixtureId: z.string().uuid() });

export async function getFixture(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { fixtureId } = fixtureSchema.parse(req.params);
    const data = await mc.getFixtureDetail(actorOf(req), fixtureId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

export async function getSchedulingPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { fixtureId } = fixtureSchema.parse(req.params);
    const data = await mc.policyFor(actorOf(req), fixtureId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

export async function listRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { fixtureId } = fixtureSchema.parse(req.params);
    // Reading the history is reading the fixture, so it is scoped the same way.
    await mc.policyFor(actorOf(req), fixtureId);
    const requests = await mc.listRequests(fixtureId);
    res.json({ success: true, data: { requests } });
  } catch (err) { next(err); }
}

const createSchema = z.object({
  proposedKickoff: z.string().trim().min(8).max(64),
  reason: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).nullable().optional(),
  submit: z.boolean().optional(),
});

export async function createRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { fixtureId } = fixtureSchema.parse(req.params);
    const body = createSchema.parse(req.body ?? {});
    const request = await mc.createRequest(actorOf(req), { fixtureId, ...body });
    res.status(201).json({ success: true, data: { request } });
  } catch (err) { next(err); }
}

const actSchema = z.object({
  action: z.enum(['SUBMIT', 'ACCEPT', 'REJECT', 'APPROVE', 'DECLINE', 'CANCEL']),
  note: z.string().trim().max(2000).nullable().optional(),
});

export async function actOnRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(req.params);
    const body = actSchema.parse(req.body ?? {});
    const request = await mc.actOnRequest(actorOf(req), requestId, body.action, body.note);
    res.json({ success: true, data: { request } });
  } catch (err) { next(err); }
}
