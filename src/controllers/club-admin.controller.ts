// src/controllers/club-admin.controller.ts
// Phase 12 — Club Admin Control Center
// Handlers are CLUB_ADMIN/SUPER_ADMIN gated in the route layer.
// Operates on the caller's clubId only — tenant-safe.

import type { Request, Response, NextFunction } from 'express';
import { sendSuccess }    from '../utils/response';
import * as adminService  from '../admin/admin.service';

export async function getDataQuality(
  req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const data = await adminService.getDataQuality(req.user!.clubId);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function getSystemHealth(
  req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const data = await adminService.getSystemHealth(req.user!.clubId);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function getAuditLog(
  req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    const raw   = req.query['limit'];
    const limit = Math.min(parseInt(typeof raw === 'string' ? raw : '50', 10) || 50, 200);
    const data  = await adminService.getAuditLog(req.user!.clubId, limit);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}
