import { Request, Response, NextFunction } from 'express';
import * as analyticsService from '../services/analytics.service';
import { sendSuccess } from '../utils/response';

export async function getOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await analyticsService.getClubAnalytics(req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

export async function getPerformanceTrend(req: Request, res: Response, next: NextFunction) {
  try {
    const weeks = req.query.weeks ? parseInt(req.query.weeks as string) : 8;
    const data  = await analyticsService.getPerformanceTrend(req.user!.clubId, weeks);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

export async function getGpsLoadTrend(req: Request, res: Response, next: NextFunction) {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 14;
    const data  = await analyticsService.getGpsLoadTrend(req.user!.clubId, days);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}
