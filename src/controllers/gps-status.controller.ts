// src/controllers/gps-status.controller.ts
// Phase 14 — GPS Fleet Status controller

import type { Request, Response, NextFunction } from 'express';
import { sendSuccess }    from '../utils/response';
import * as svc           from '../gps/gps-status.service';

export async function getFleetStatus(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const data = await svc.getFleetStatus(req.user!.clubId);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}
