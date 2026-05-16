import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as aiService from '../services/ai.service';
import { sendSuccess } from '../utils/response';

const analyzeSchema = z.object({
  body: z.object({
    prompt:   z.string().min(3).max(2000),
    type:     z.enum(['player','team','match','training','medical','transfer','financial']).default('team'),
    playerId: z.string().uuid().optional(),
  }),
});

export async function analyze(req: Request, res: Response, next: NextFunction) {
  try {
    await analyzeSchema.parseAsync({ body: req.body });
    const result = await aiService.analyzeWithAI({
      prompt:   req.body.prompt,
      type:     req.body.type,
      clubId:   req.user!.clubId,
      userId:   req.user!.id,
      playerId: req.body.playerId,
    });
    return sendSuccess(res, result, 'Analysis complete');
  } catch (err) { return next(err); }
}

export async function analyzePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await aiService.analyzePlayer(
      req.params.id,
      req.user!.clubId,
      req.user!.id
    );
    return sendSuccess(res, result, 'Player analysis complete');
  } catch (err) { return next(err); }
}

export async function getHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = req.query.page  ? parseInt(req.query.page  as string) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const data  = await aiService.getInsightHistory(req.user!.clubId, page, limit);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}
