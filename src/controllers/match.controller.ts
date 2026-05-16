import { Request, Response, NextFunction } from 'express';
import * as matchService from '../services/match.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';

export async function getMatches(req: Request, res: Response, next: NextFunction) {
  try {
    const { competition, page, limit } = req.query;
    const result = await matchService.getMatches(req.user!.clubId, {
      competition: competition as never,
      page:  page  ? parseInt(page  as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    return sendPaginated(res, result.matches, result.total, result.page, result.limit);
  } catch (err) { return next(err); }
}

export async function getMatch(req: Request, res: Response, next: NextFunction) {
  try {
    const match = await matchService.getMatchById(req.params.id, req.user!.clubId);
    return sendSuccess(res, match);
  } catch (err) { return next(err); }
}

export async function createMatch(req: Request, res: Response, next: NextFunction) {
  try {
    const match = await matchService.createMatch(req.user!.clubId, req.body);
    return sendCreated(res, match, 'Match created');
  } catch (err) { return next(err); }
}

export async function updateMatch(req: Request, res: Response, next: NextFunction) {
  try {
    const match = await matchService.updateMatch(req.params.id, req.user!.clubId, req.body);
    return sendSuccess(res, match, 'Match updated');
  } catch (err) { return next(err); }
}

export async function deleteMatch(req: Request, res: Response, next: NextFunction) {
  try {
    await matchService.deleteMatch(req.params.id, req.user!.clubId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function getResults(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await matchService.getMatchResults(req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}
