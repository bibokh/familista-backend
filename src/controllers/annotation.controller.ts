// Familista — Tactical Annotation controller (Phase G)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/annotation.service';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError } from '../utils/errors';

function actorOf(req: Request): svc.AnnotationActor {
  if (!req.user) throw new BadRequestError('Auth context missing');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role };
}

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '));
}

const createSchema = z.object({
  body: z.object({
    atMs:       z.number().int().min(0),
    kind:       z.enum(['ARROW','ZONE','NOTE','DRAW','TAG_PLAYER']),
    payload:    z.any(),
    visibility: z.enum(['CLUB','COACHES','PRIVATE']).optional(),
  }).refine((v) => v.payload !== undefined, { message: 'payload required' }),
});

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    const row = await svc.createAnnotation(actorOf(req), { matchId: req.params.id, atMs: body.atMs, kind: body.kind, payload: body.payload, visibility: body.visibility });
    return sendCreated(res, { ...row, atMs: row.atMs.toString() });
  } catch (err) { return next(err); }
}

const listSchema = z.object({
  query: z.object({
    fromMs: z.coerce.number().int().min(0).optional(),
    toMs:   z.coerce.number().int().min(0).optional(),
    limit:  z.coerce.number().int().min(1).max(5000).optional(),
  }),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const rows = await svc.listAnnotations(actorOf(req), req.params.id, parsed.data.query);
    return sendSuccess(res, rows.map((r) => ({ ...r, atMs: r.atMs.toString() })));
  } catch (err) { return next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body ?? {};
    const row = await svc.updateAnnotation(actorOf(req), req.params.annotationId, {
      payload:    body.payload,
      visibility: typeof body.visibility === 'string' ? body.visibility : undefined,
    });
    return sendSuccess(res, { ...row, atMs: row.atMs.toString() });
  } catch (err) { return next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    await svc.deleteAnnotation(actorOf(req), req.params.annotationId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}
