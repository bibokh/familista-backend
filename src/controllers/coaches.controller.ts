// Familista — coaches directory controller
// Thin: the club is taken from the session, never from the request.

import { Request, Response, NextFunction } from 'express';
import * as svc from '../staff-market/staff-market.service';
import { sendSuccess, sendCreated } from '../utils/response';

const actor = (req: Request): svc.StaffActor => ({
  userId: req.user!.id,
  clubId: (req.user as { currentClubId?: string; clubId: string }).currentClubId || req.user!.clubId,
  role: req.user!.role,
});

// ── the three levels ────────────────────────────────────────────────────────
// Each one answers for its own level and nothing below it, so opening the page
// never loads the whole organisation.
export async function clubs(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.coachesClubs(actor(req))); }
  catch (err) { return next(err); }
}

export async function clubTeams(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.coachesClubTeams(actor(req), String(req.params.clubId))); }
  catch (err) { return next(err); }
}

export async function teamStaff(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.coachesTeamStaff(actor(req), String(req.params.teamId))); }
  catch (err) { return next(err); }
}

export async function directory(req: Request, res: Response, next: NextFunction) {
  try {
    const clubId = req.query.clubId ? String(req.query.clubId) : undefined;
    return sendSuccess(res, await svc.coachesDirectory(actor(req), clubId ? { clubId } : {}));
  } catch (err) { return next(err); }
}

// ── the club's own staff ────────────────────────────────────────────────────
export async function addStaff(req: Request, res: Response, next: NextFunction) {
  try { return sendCreated(res, await svc.addStaffMember(actor(req), req.body as never)); }
  catch (err) { return next(err); }
}

export async function moveStaff(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.moveStaffMember(actor(req), String(req.params.staffUserId), req.body ?? {})); }
  catch (err) { return next(err); }
}

export async function releaseStaff(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.releaseStaffMember(actor(req), String(req.params.staffUserId))); }
  catch (err) { return next(err); }
}

// ── the record a club keeps ─────────────────────────────────────────────────
export async function saveCareer(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.upsertCareerEntry(actor(req), String(req.params.staffUserId), req.body ?? {})); }
  catch (err) { return next(err); }
}

export async function removeCareer(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.deleteCareerEntry(actor(req), String(req.params.staffUserId), String(req.params.entryId))); }
  catch (err) { return next(err); }
}

export async function saveTrophy(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.upsertTrophy(actor(req), String(req.params.staffUserId), req.body ?? {})); }
  catch (err) { return next(err); }
}

export async function removeTrophy(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.deleteTrophy(actor(req), String(req.params.staffUserId), String(req.params.trophyId))); }
  catch (err) { return next(err); }
}

// ── sample staff, for a platform still being built ──────────────────────────
export async function seedDemo(req: Request, res: Response, next: NextFunction) {
  try {
    // "all" fills every club this session may see; otherwise just the one it
    // is acting for. Neither can reach a club it is not authorised for.
    const scope = String(req.query.scope ?? 'club');
    return sendSuccess(res, await svc.seedDemoStaff(actor(req),
      (scope === 'all' || scope === 'platform') ? { allClubs: true } : { clubId: actor(req).clubId }));
  } catch (err) { return next(err); }
}

export async function clearDemo(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.removeDemoStaff(actor(req))); }
  catch (err) { return next(err); }
}
