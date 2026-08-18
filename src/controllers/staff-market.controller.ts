// Familista — coaches & technical staff market controller
// Thin by design: every decision about who may see or do what is made in the
// service, from the session's club, never from anything the request carries.

import { Request, Response, NextFunction } from 'express';
import * as svc from '../staff-market/staff-market.service';
import { sendSuccess, sendCreated } from '../utils/response';

const actor = (req: Request): svc.StaffActor => ({
  userId: req.user!.id,
  clubId: (req.user as { currentClubId?: string; clubId: string }).currentClubId || req.user!.clubId,
  role: req.user!.role,
});

export async function discover(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.discover(actor(req), req.query as svc.DiscoverQuery)); }
  catch (err) { return next(err); }
}

export async function summary(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.marketSummary(actor(req))); }
  catch (err) { return next(err); }
}

export async function readStaff(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.readStaff(actor(req), String(req.params.staffUserId))); }
  catch (err) { return next(err); }
}

export async function clubs(_req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.clubsOnTheMarket()); }
  catch (err) { return next(err); }
}

// ── recruitment ─────────────────────────────────────────────────────────────
export async function approach(req: Request, res: Response, next: NextFunction) {
  try { return sendCreated(res, await svc.approach(actor(req), req.body as svc.ApproachDto)); }
  catch (err) { return next(err); }
}

export async function readApproach(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.readApproach(actor(req), String(req.params.approachId))); }
  catch (err) { return next(err); }
}

export async function counter(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.counterApproach(actor(req), String(req.params.approachId), req.body)); }
  catch (err) { return next(err); }
}

export async function accept(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.acceptApproach(actor(req), String(req.params.approachId))); }
  catch (err) { return next(err); }
}

export async function reject(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.rejectApproach(actor(req), String(req.params.approachId))); }
  catch (err) { return next(err); }
}

export async function withdraw(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.withdrawApproach(actor(req), String(req.params.approachId))); }
  catch (err) { return next(err); }
}

// ── the club's own desk ─────────────────────────────────────────────────────
export async function activity(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.myActivity(actor(req))); }
  catch (err) { return next(err); }
}

export async function myStaff(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.myStaff(actor(req))); }
  catch (err) { return next(err); }
}

export async function readNeeds(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.readNeeds(actor(req), { mine: req.query.mine === 'true' })); }
  catch (err) { return next(err); }
}

export async function createNeed(req: Request, res: Response, next: NextFunction) {
  try { return sendCreated(res, await svc.createNeed(actor(req), req.body)); }
  catch (err) { return next(err); }
}

export async function closeNeed(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.closeNeed(actor(req), String(req.params.needId))); }
  catch (err) { return next(err); }
}

// ── keeping the record ──────────────────────────────────────────────────────
export async function upsertProfile(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.upsertProfile(actor(req), String(req.params.staffUserId), req.body)); }
  catch (err) { return next(err); }
}

export async function bootstrapStaff(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.ensureProfilesForClub(actor(req))); }
  catch (err) { return next(err); }
}
