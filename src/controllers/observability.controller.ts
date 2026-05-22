// Familista — Observability controller (Phase J)

import type { Request, Response, NextFunction } from 'express';
import * as svc from '../observability/metrics.service';
import { sendSuccess } from '../utils/response';

function tsParam(s?: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function listMetrics(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.listMetrics({
      name:     typeof req.query.name     === 'string' ? req.query.name     : undefined,
      regionId: typeof req.query.regionId === 'string' ? req.query.regionId : undefined,
      fromTs:   tsParam(typeof req.query.fromTs === 'string' ? req.query.fromTs : undefined),
      toTs:     tsParam(typeof req.query.toTs   === 'string' ? req.query.toTs   : undefined),
      limit:    typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined,
    });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

export async function listDeviceHealth(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.listDeviceHealth(req.params.deviceId,
      typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100);
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

export async function checkIntegrity(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.checkReplayIntegrity(req.params.matchId);
    return sendSuccess(res, { ...out, expectedSeq: out.expectedSeq.toString(), actualSeq: out.actualSeq.toString(), brokenAt: out.brokenAt?.toString() ?? null });
  } catch (err) { return next(err); }
}

export async function listIntegrity(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.listReplayIntegrity(req.params.matchId,
      typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 20);
    return sendSuccess(res, out.map((r) => ({ ...r, expectedSeq: r.expectedSeq.toString(), actualSeq: r.actualSeq.toString(), brokenAt: r.brokenAt?.toString() ?? null })));
  } catch (err) { return next(err); }
}

export async function snapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.snapshot({ regionId: typeof req.query.regionId === 'string' ? req.query.regionId : undefined });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}
