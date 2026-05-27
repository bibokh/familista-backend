import { Request, Response, NextFunction } from 'express';
import * as analyticsService from '../services/analytics.service';
import { sendSuccess } from '../utils/response';
import { BadRequestError, NotFoundError } from '../utils/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse an integer query param safely; returns `fallback` on NaN/missing. */
function safeInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(raw as string, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export async function getOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await analyticsService.getClubAnalytics(req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

export async function getPerformanceTrend(req: Request, res: Response, next: NextFunction) {
  try {
    // BUG 3 FIX: parseInt may produce NaN for non-numeric strings — use safeInt.
    const weeks = safeInt(req.query.weeks, 8, 1, 52);
    const data  = await analyticsService.getPerformanceTrend(req.user!.clubId, weeks);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

export async function getGpsLoadTrend(req: Request, res: Response, next: NextFunction) {
  try {
    // BUG 3 FIX: same NaN-safe treatment for days.
    const days = safeInt(req.query.days, 14, 1, 90);
    const data  = await analyticsService.getGpsLoadTrend(req.user!.clubId, days);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

export async function getPlayerAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const { playerId } = req.params;
    if (!UUID_RE.test(playerId)) {
      return next(new BadRequestError('playerId must be a valid UUID'));
    }
    const data = await analyticsService.getPlayerAnalytics(req.user!.clubId, playerId);
    if (!data) return next(new NotFoundError('Player'));
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

export async function getTeamAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await analyticsService.getTeamAnalytics(req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

export async function getReadinessScores(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await analyticsService.getReadinessScores(req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

export async function getRiskAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await analyticsService.getRiskAlerts(req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}
