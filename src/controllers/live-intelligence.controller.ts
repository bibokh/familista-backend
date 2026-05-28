// src/controllers/live-intelligence.controller.ts
// Phase 15 — Live Match Intelligence controller

import type { Request, Response, NextFunction } from 'express';
import { sendSuccess }  from '../utils/response';
import * as svc         from '../live-intelligence/live-intelligence.service';

export async function getLiveIntelligence(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const data = await svc.getLiveIntelligence(req.params['id']!, req.user!.clubId);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}
