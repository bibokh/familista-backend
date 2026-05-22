// Familista — Distributed infrastructure controller (Phase J)

import type { Request, Response, NextFunction } from 'express';
import * as region from '../distributed/region.service';
import { sendSuccess } from '../utils/response';

export async function listRegions(_req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await region.listRegions()); }
  catch (err) { return next(err); }
}

export async function snapshotHealth(_req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await region.snapshotHealth()); }
  catch (err) { return next(err); }
}

export async function whoami(_req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, {
      nodeId:     region.getThisNodeId(),
      regionCode: region.getThisRegionCode(),
    });
  } catch (err) { return next(err); }
}

export async function resolveForClub(req: Request, res: Response, next: NextFunction) {
  try {
    const code = await region.resolveRegionForClub(req.user!.clubId);
    return sendSuccess(res, { clubId: req.user!.clubId, regionCode: code });
  } catch (err) { return next(err); }
}
