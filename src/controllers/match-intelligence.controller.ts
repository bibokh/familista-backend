// Familista — Match Intelligence controller (Phase B)
// Surfaces: lineups, timeline events, tactical snapshots, AI feature bundle.

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/match-intelligence.service';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import type { MatchActor } from '../services/match.service';

const SIDE  = ['HOME','AWAY'] as const;
const PHASE = ['OPEN_PLAY','ATTACKING_TRANSITION','DEFENSIVE_TRANSITION','ATTACKING_ORGANIZATION','DEFENSIVE_ORGANIZATION','SET_PIECE_FOR','SET_PIECE_AGAINST'] as const;
const KIND  = ['GOAL','OWN_GOAL','ASSIST','SHOT','SHOT_ON_TARGET','SHOT_OFF_TARGET','SAVE','YELLOW_CARD','SECOND_YELLOW','RED_CARD','SUBSTITUTION','INJURY','FOUL','CORNER','OFFSIDE','PENALTY_AWARDED','PENALTY_SCORED','PENALTY_MISSED','POSSESSION_TICK','TACTICAL_NOTE','AI_INSIGHT','CUSTOM'] as const;
const SOURCE= ['MANUAL','AUTO_INTERVAL','AI_AGENT','VISION'] as const;

const positionSchema = z.union([
  z.object({
    playerId:     z.string().uuid(),
    position:     z.string().max(8).optional(),
    x:            z.number().min(0).max(100).optional(),
    y:            z.number().min(0).max(100).optional(),
    isStarter:    z.boolean(),
    captainBand:  z.boolean().optional(),
    jerseyNumber: z.number().int().min(0).max(99).optional(),
  }),
  z.object({
    name:         z.string().min(1).max(120),
    position:     z.string().max(8).optional(),
    x:            z.number().min(0).max(100).optional(),
    y:            z.number().min(0).max(100).optional(),
    isStarter:    z.boolean(),
    jerseyNumber: z.number().int().min(0).max(99).optional(),
  }),
]);

const setLineupSchema = z.object({
  body: z.object({
    side:      z.enum(SIDE),
    formation: z.string().regex(/^\d-\d(-\d){1,2}$/).optional(),
    notes:     z.string().max(2000).optional(),
    positions: z.array(positionSchema).min(1).max(40),
  }),
});

const addTimelineSchema = z.object({
  body: z.object({
    occurredAtMin:     z.number().int().min(0).max(130),
    occurredAtSec:     z.number().int().min(0).max(59).optional(),
    period:            z.number().int().min(1).max(5).optional(),
    kind:              z.enum(KIND),
    side:              z.enum(SIDE),
    primaryPlayerId:   z.string().uuid().nullable().optional(),
    secondaryPlayerId: z.string().uuid().nullable().optional(),
    opponentName:      z.string().max(120).nullable().optional(),
    pitchX:            z.number().min(0).max(100).nullable().optional(),
    pitchY:            z.number().min(0).max(100).nullable().optional(),
    notes:             z.string().max(1000).nullable().optional(),
    payload:           z.any().optional(),
  }),
});

const editTimelineSchema = z.object({
  body: addTimelineSchema.shape.body.partial()
    .refine((b) => Object.keys(b).length > 0, { message: 'No fields supplied to update' }),
});

const snapshotSchema = z.object({
  body: z.object({
    takenAtMin: z.number().int().min(0).max(130),
    period:     z.number().int().min(1).max(5).optional(),
    phase:      z.enum(PHASE).optional(),
    formation:  z.string().regex(/^\d-\d(-\d){1,2}$/).optional(),
    possession: z.number().min(0).max(100).optional(),
    positions:  z.any(),
    notes:      z.string().max(2000).optional(),
    source:     z.enum(SOURCE).optional(),
  }),
});

const reasonSchema = z.object({ body: z.object({ reason: z.string().max(500).optional() }) });

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}
function actorOf(req: Request): MatchActor {
  if (!req.user) throw new BadRequestError('Authentication context missing');
  const xff = req.headers['x-forwarded-for'];
  const ip  = typeof xff === 'string' ? xff.split(',')[0]?.trim() : req.ip;
  return {
    userId:    req.user.id,
    clubId:    req.user.clubId,
    role:      req.user.role,
    ipAddress: ip ?? null,
    userAgent: (req.headers['user-agent'] as string) ?? null,
  };
}

// ── Lineups ──────────────────────────────────────────────────────────────

export async function getLineups(req: Request, res: Response, next: NextFunction) {
  try {
    const items = await svc.getLineups(req.params.id, req.user!.clubId);
    return sendSuccess(res, items);
  } catch (err) { return next(err); }
}

export async function setLineup(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = setLineupSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const l = await svc.setLineup(actorOf(req), req.params.id, parsed.data.body);
    return sendCreated(res, l, 'Lineup saved');
  } catch (err) { return next(err); }
}

// ── Timeline ─────────────────────────────────────────────────────────────

export async function listTimeline(req: Request, res: Response, next: NextFunction) {
  try {
    const items = await svc.listTimeline(req.params.id, req.user!.clubId, {
      kind:           req.query.kind  as never,
      side:           req.query.side  as never,
      includeDeleted: req.query.includeDeleted === 'true',
    });
    return sendSuccess(res, items);
  } catch (err) { return next(err); }
}

export async function addTimeline(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = addTimelineSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const evt = await svc.addTimelineEvent(actorOf(req), req.params.id, parsed.data.body);
    return sendCreated(res, evt, 'Timeline event recorded');
  } catch (err) { return next(err); }
}

export async function editTimeline(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = editTimelineSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const evt = await svc.editTimelineEvent(actorOf(req), req.params.id, req.params.eventId, parsed.data.body);
    return sendSuccess(res, evt, 'Timeline event updated');
  } catch (err) { return next(err); }
}

export async function deleteTimeline(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reasonSchema.safeParse({ body: req.body || {} });
    const reason = parsed.success ? parsed.data.body.reason : undefined;
    await svc.deleteTimelineEvent(actorOf(req), req.params.id, req.params.eventId, reason);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ── Tactical snapshots ───────────────────────────────────────────────────

export async function listSnapshots(req: Request, res: Response, next: NextFunction) {
  try {
    const items = await svc.listSnapshots(req.params.id, req.user!.clubId);
    return sendSuccess(res, items);
  } catch (err) { return next(err); }
}

export async function takeSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = snapshotSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const snap = await svc.takeSnapshot(actorOf(req), req.params.id, parsed.data.body as never);
    return sendCreated(res, snap, 'Tactical snapshot recorded');
  } catch (err) { return next(err); }
}

// ── AI feature bundle (read-only) ────────────────────────────────────────

export async function getFeatureBundle(req: Request, res: Response, next: NextFunction) {
  try {
    const bundle = await svc.getMatchFeatureBundle(req.params.id, req.user!.clubId);
    return sendSuccess(res, bundle);
  } catch (err) { return next(err); }
}
