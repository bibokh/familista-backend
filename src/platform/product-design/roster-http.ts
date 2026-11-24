/**
 * Familista Design Studio — the HTTP handlers of a club's team rosters (M3), mounted by src/routes/club-design.routes.ts
 * behind its gate (authenticate, the club roles that design kits, the club's entitlement). The club is the one the gate
 * resolved from the session (`res.locals.designScope`); a handler reached without a club scope refuses, never serves.
 * Rosters carry names of people, so every answer is `no-store` (set by the gate) and nothing here logs an entry.
 */
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { RosterInvalidError } from './roster-core';
import {
  createRoster, deleteRoster, getRoster, listRosters, saveRoster, setRosterArchived, squadNames, RosterConflictError, RosterRefusedError,
} from './roster.service';
import type { DesignActor, DesignScope } from './service';

const RosterId = z.string().guid();
const ListQuery = z.object({ state: z.enum(['active', 'archived']).default('active') }).strict();
const CreateBody = z.object({ name: z.unknown(), entries: z.unknown().default([]), includesMinors: z.boolean().optional() }).strict();
const SaveBody = z.object({ name: z.unknown(), entries: z.unknown(), version: z.number().int().min(1).max(1_000_000), includesMinors: z.boolean().optional() }).strict();

function clubOf(res: Response): string {
  const s = res.locals.designScope as DesignScope | undefined;
  if (!s || s.kind !== 'CLUB') throw new Error('A roster route was reached without a club scope');
  return s.clubId;
}
function actorOf(req: Request): DesignActor {
  const ua = req.headers['user-agent'];
  return { userId: req.user?.id ?? '', ipAddress: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null, correlationId: req.requestId ?? null };
}
function handler(work: (req: Request, res: Response, clubId: string) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try { await work(req, res, clubOf(res)); } catch (err) {
      if (err instanceof RosterInvalidError) {
        res.status(400).json({ success: false, code: 'ROSTER_INVALID', reason: err.code, path: err.path, message: `The roster was refused: ${err.message}` });
        return;
      }
      if (err instanceof RosterConflictError) { res.status(409).json({ success: false, code: err.code, message: err.message, data: { version: err.version } }); return; }
      if (err instanceof RosterRefusedError) { res.status(409).json({ success: false, code: err.code, message: err.message }); return; }
      next(err);
    }
  };
}

export const listTeamRosters = handler(async (req, res, clubId) => {
  const { state } = ListQuery.parse(req.query);
  res.json({ success: true, data: await listRosters(clubId, { archived: state === 'archived' }) });
});
export const createTeamRoster = handler(async (req, res, clubId) => {
  const body = CreateBody.parse(req.body);
  res.status(201).json({ success: true, data: await createRoster(clubId, actorOf(req), body) });
});
export const openTeamRoster = handler(async (req, res, clubId) => {
  res.json({ success: true, data: await getRoster(clubId, RosterId.parse(req.params.rosterId)) });
});
export const saveTeamRoster = handler(async (req, res, clubId) => {
  const id = RosterId.parse(req.params.rosterId);
  const body = SaveBody.parse(req.body);
  res.json({ success: true, data: await saveRoster(clubId, actorOf(req), id, body) });
});
export const archiveTeamRoster = handler(async (req, res, clubId) => {
  res.json({ success: true, data: await setRosterArchived(clubId, actorOf(req), RosterId.parse(req.params.rosterId), true) });
});
export const unarchiveTeamRoster = handler(async (req, res, clubId) => {
  res.json({ success: true, data: await setRosterArchived(clubId, actorOf(req), RosterId.parse(req.params.rosterId), false) });
});
export const deleteTeamRoster = handler(async (req, res, clubId) => {
  res.json({ success: true, data: await deleteRoster(clubId, actorOf(req), RosterId.parse(req.params.rosterId)) });
});
export const readSquadNames = handler(async (_req, res, clubId) => {
  res.json({ success: true, data: await squadNames(clubId) });
});
