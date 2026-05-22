// Familista — Fusion controller (Phase D-IP, read-only)

import { Request, Response, NextFunction } from 'express';
import * as svc from '../fusion/fusion.service';
import { sendSuccess } from '../utils/response';

export async function getFusionFrame(req: Request, res: Response, next: NextFunction) {
  try {
    const frame = await svc.computeFusionFrameForMatch(req.params.id, req.user!.clubId);
    return sendSuccess(res, frame);
  } catch (err) { return next(err); }
}
