// Familista — Spatial controller (Phase G)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { buildSpatialFrame } from '../spatial/cognitive-engine';
import { twinAt, listAnchors } from '../spatial/digital-twin-engine';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || 'query'}: ${e.message}`).join(', '));
}

const frameSchema = z.object({
  query: z.object({
    monotonicMs: z.coerce.number().int().min(0).optional(),
    persist:     z.enum(['true','false']).optional(),
  }),
});

export async function getSpatialFrame(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = frameSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const frame = await buildSpatialFrame(req.params.id, req.user!.clubId, {
      monotonicMs: parsed.data.query.monotonicMs,
      persist:     parsed.data.query.persist === 'true',
    });
    // BigInt-safe: monotonicMs is already a JS number in SpatialFrame.
    return sendSuccess(res, frame);
  } catch (err) { return next(err); }
}

const twinSchema = z.object({
  query: z.object({
    atMs:          z.coerce.number().int().min(0),
    maxLookbackMs: z.coerce.number().int().min(0).max(86_400_000).optional(),
  }),
});

export async function getTwinAt(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = twinSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await twinAt(req.params.id, req.user!.clubId, parsed.data.query);
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

const anchorsSchema = z.object({
  query: z.object({
    fromMs: z.coerce.number().int().min(0).optional(),
    toMs:   z.coerce.number().int().min(0).optional(),
    limit:  z.coerce.number().int().min(1).max(5000).optional(),
  }),
});

export async function getTwinAnchors(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = anchorsSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await listAnchors(req.params.id, req.user!.clubId, parsed.data.query);
    return sendSuccess(res, out.map((r) => ({ ...r, monotonicMs: r.monotonicMs.toString() })));
  } catch (err) { return next(err); }
}
