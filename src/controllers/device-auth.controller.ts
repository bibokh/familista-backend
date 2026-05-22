// Familista — Device auth controller (Phase C)
// POST /api/v1/devices/auth/token

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/device-auth.service';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const handshakeSchema = z.object({
  body: z.object({
    deviceSessionId: z.string().uuid(),
    ts:              z.number().int().positive(),
    nonce:           z.string().min(16).max(128),
    sig:             z.string().min(8).max(200),
  }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

export async function issueToken(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = handshakeSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const issued = await svc.issueDeviceToken(parsed.data.body);
    return sendSuccess(res, issued, 'Device token issued');
  } catch (err) { return next(err); }
}
