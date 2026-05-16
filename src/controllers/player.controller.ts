import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as playerService from '../services/player.service';
import * as aiService from '../services/ai.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const createPlayerSchema = z.object({
  body: z.object({
    firstName:    z.string().min(1),
    lastName:     z.string().min(1),
    number:       z.number().int().min(1).max(99),
    position:     z.enum(['GK','DC','DL','DR','DMC','ML','MR','MC','AMC','AML','AMR','ST']),
    nationality:  z.string().min(1),
    flag:         z.string().min(1),
    dateOfBirth:  z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    height:       z.number().int().min(140).max(220),
    weight:       z.number().int().min(50).max(130),
    overallRating:z.number().int().min(40).max(140).optional(),
    potential:    z.number().int().min(40).max(140).optional(),
    marketValue:  z.number().min(0).optional(),
    weeklyWage:   z.number().int().min(0).optional(),
    contractUntil:z.string().optional(),
  }),
});

export async function getPlayers(req: Request, res: Response, next: NextFunction) {
  try {
    const { position, isInjured, search, page, limit } = req.query;
    const result = await playerService.getPlayers(req.user!.clubId, {
      position: position as never,
      isInjured: isInjured !== undefined ? isInjured === 'true' : undefined,
      search: search as string,
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    return sendPaginated(res, result.players, result.total, result.page, result.limit);
  } catch (err) { return next(err); }
}

export async function getPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const player = await playerService.getPlayerById(req.params.id, req.user!.clubId);
    return sendSuccess(res, player);
  } catch (err) { return next(err); }
}

export async function createPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    await createPlayerSchema.parseAsync({ body: req.body });
    const player = await playerService.createPlayer(req.user!.clubId, req.body);
    return sendCreated(res, player, 'Player created');
  } catch (err) { return next(err); }
}

export async function updatePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const player = await playerService.updatePlayer(req.params.id, req.user!.clubId, req.body);
    return sendSuccess(res, player, 'Player updated');
  } catch (err) { return next(err); }
}

export async function deletePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    await playerService.deletePlayer(req.params.id, req.user!.clubId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function addGpsData(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await playerService.addGpsData(req.params.id, req.user!.clubId, req.body);
    return sendCreated(res, data, 'GPS data recorded');
  } catch (err) { return next(err); }
}

export async function getPlayerStats(req: Request, res: Response, next: NextFunction) {
  try {
    const stats = await playerService.getPlayerSeasonStats(req.params.id, req.user!.clubId);
    return sendSuccess(res, stats);
  } catch (err) { return next(err); }
}

export async function analyzePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await aiService.analyzePlayer(
      req.params.id,
      req.user!.clubId,
      req.user!.id
    );
    return sendSuccess(res, result, 'AI analysis complete');
  } catch (err) { return next(err); }
}
