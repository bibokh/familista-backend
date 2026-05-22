// Familista — Active-context controller (Phase A)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/context.service';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const switchSchema = z.object({
  body: z.object({
    clubId: z.string().uuid(),
    teamId: z.string().uuid().nullable().optional(),
  }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

export async function getMe(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = await svc.getContext(req.user!.id);
    return sendSuccess(res, ctx);
  } catch (err) { return next(err); }
}

export async function switchMe(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = switchSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const xff = req.headers['x-forwarded-for'];
    const ip  = typeof xff === 'string' ? xff.split(',')[0]?.trim() : req.ip;
    const ctx = await svc.switchContext(
      { userId: req.user!.id, ipAddress: ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null },
      parsed.data.body.clubId,
      parsed.data.body.teamId ?? null,
    );
    return sendSuccess(res, ctx, 'Context updated');
  } catch (err) { return next(err); }
}
