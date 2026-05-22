// Familista — Predictive controller (Phase G)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { predictAll, listPredictions } from '../intel/predictive.service';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const KINDS = ['TACTICAL_COLLAPSE','INJURY_RISK','FATIGUE_TRAJECTORY','POSITIONING_DEGRADATION','MOMENTUM_SHIFT','SUBSTITUTION_WINDOW'] as const;

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '));
}

const runSchema = z.object({
  body: z.object({
    dryRun: z.boolean().optional(),
  }),
});

export async function runPredictors(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = runSchema.safeParse({ body: req.body ?? {} });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await predictAll(req.params.id, req.user!.clubId, { dryRun: parsed.data.body.dryRun });
    return sendSuccess(res, out, `${out.length} predictions generated`);
  } catch (err) { return next(err); }
}

const listSchema = z.object({
  query: z.object({
    matchId:  z.string().uuid().optional(),
    playerId: z.string().uuid().optional(),
    kind:     z.enum(KINDS).optional(),
    page:     z.coerce.number().int().min(1).max(10_000).optional(),
    limit:    z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function listPredictionsCtl(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await listPredictions(req.user!.clubId, parsed.data.query);
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}
