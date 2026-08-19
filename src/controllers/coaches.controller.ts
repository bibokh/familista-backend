// Familista — coaches directory controller
// Thin: the club is taken from the session, never from the request.

import { Request, Response, NextFunction } from 'express';
import * as svc from '../staff-market/staff-market.service';
import { sendSuccess } from '../utils/response';

const actor = (req: Request): svc.StaffActor => ({
  userId: req.user!.id,
  clubId: (req.user as { currentClubId?: string; clubId: string }).currentClubId || req.user!.clubId,
  role: req.user!.role,
});

export async function directory(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.coachesDirectory(actor(req))); }
  catch (err) { return next(err); }
}
