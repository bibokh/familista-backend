// Familista — Realtime controller (Phase E)
// ─────────────────────────────────────────────────────────────────────────
// REST handlers for the live tactical surface. SSE itself lives in
// src/realtime/match-sse.ts; this file handles the REST cousins.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import { getState } from '../realtime/tactical-state';
import { buildMatchBrain } from '../realtime/match-brain';
import { buildReplay, ReplayKind } from '../services/replay.service';
import { evaluateMatch } from '../services/rules-engine.service';

const REPLAY_KIND_VALUES = ['TIMELINE', 'SNAPSHOT', 'ALERT', 'TWIN_FRAME'] as const;

const replayQuery = z.object({
  query: z.object({
    fromMs: z.coerce.number().int().min(0).optional(),
    toMs:   z.coerce.number().int().min(0).optional(),
    limit:  z.coerce.number().int().min(1).max(5000).optional(),
    kinds:  z.string().optional(),  // comma list
  }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || 'query'}: ${e.message}`).join(', '),
  );
}

export async function getTacticalState(req: Request, res: Response, next: NextFunction) {
  try {
    const state = await getState(req.params.id, req.user!.clubId);
    return sendSuccess(res, state);
  } catch (err) { return next(err); }
}

export async function getMatchBrain(req: Request, res: Response, next: NextFunction) {
  try {
    const brain = await buildMatchBrain(req.params.id, req.user!.clubId);
    return sendSuccess(res, brain);
  } catch (err) { return next(err); }
}

export async function getReplay(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = replayQuery.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const kinds = q.kinds
      ? q.kinds.split(',').map((s) => s.trim().toUpperCase()).filter((k): k is ReplayKind => (REPLAY_KIND_VALUES as readonly string[]).includes(k))
      : undefined;
    const out = await buildReplay(req.params.id, req.user!.clubId, {
      fromMs: q.fromMs, toMs: q.toMs, limit: q.limit, kinds,
    });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

export async function triggerRulesEvaluation(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await evaluateMatch(req.params.id, req.user!.clubId);
    return sendSuccess(res, out, `Generated ${out.alerts.length} alerts (${out.suppressed} suppressed by debounce)`);
  } catch (err) { return next(err); }
}
