import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as playerService from '../services/player.service';
import * as aiService from '../services/ai.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

// ── Validation schemas ────────────────────────────────────────────────────

const PLAYER_POSITIONS = ['GK','DC','DL','DR','DMC','ML','MR','MC','AMC','AML','AMR','ST'] as const;
const DATE_OR_ISO = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

const playerCoreShape = {
  firstName:    z.string().trim().min(1).max(100),
  lastName:     z.string().trim().min(1).max(100),
  number:       z.number().int().min(1).max(99),
  position:     z.enum(PLAYER_POSITIONS),
  nationality:  z.string().trim().min(1).max(100),
  flag:         z.string().trim().min(1).max(16),
  dateOfBirth:  DATE_OR_ISO,
  height:       z.number().int().min(140).max(220),
  weight:       z.number().int().min(50).max(130),
  preferredFoot: z.enum(['RIGHT','LEFT','BOTH']).optional(),
  overallRating:z.number().int().min(40).max(140).optional(),
  potential:    z.number().int().min(40).max(140).optional(),
  marketValue:  z.number().min(0).optional(),
  weeklyWage:   z.number().int().min(0).optional(),
  contractUntil:z.string().optional(),
  avatar:       z.string().url().optional().or(z.literal('')),
};

const createPlayerSchema = z.object({ body: z.object(playerCoreShape) });

const updatePlayerSchema = z.object({
  body: z.object({
    ...Object.fromEntries(Object.entries(playerCoreShape).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
    condition: z.number().int().min(0).max(100).optional(),
    isInjured: z.boolean().optional(),
  }).refine((b) => Object.keys(b).length > 0, { message: 'No fields supplied to update' }),
});

const listPlayersQuerySchema = z.object({
  query: z.object({
    position:  z.enum(PLAYER_POSITIONS).optional(),
    isInjured: z.enum(['true','false']).optional(),
    search:    z.string().trim().max(100).optional(),
    page:      z.coerce.number().int().min(1).max(10_000).optional(),
    limit:     z.coerce.number().int().min(1).max(200).optional(),
  }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

export async function getPlayers(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listPlayersQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const result = await playerService.getPlayers(req.user!.clubId, {
      position: q.position,
      isInjured: q.isInjured === undefined ? undefined : q.isInjured === 'true',
      search: q.search,
      page:  q.page,
      limit: q.limit,
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
    const parsed = createPlayerSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const player = await playerService.createPlayer(req.user!.clubId, parsed.data.body);
    return sendCreated(res, player, 'Player created');
  } catch (err) { return next(err); }
}

export async function updatePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updatePlayerSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const player = await playerService.updatePlayer(req.params.id, req.user!.clubId, parsed.data.body);
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
