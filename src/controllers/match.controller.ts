// Familista — Match controller (Phase B)
// Thin HTTP shim. Every handler builds an actor from req and delegates.

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as matchService from '../services/match.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const COMPETITION = ['LEAGUE','CUP','FRIENDLY','CHAMPIONS_LEAGUE','EUROPA_LEAGUE','TOURNAMENT'] as const;
const STATUS      = ['SCHEDULED','LIVE','HALFTIME','FT','POSTPONED','ABANDONED','CANCELLED'] as const;
const RESULT      = ['WIN','LOSS','DRAW'] as const;

const DATE_OR_ISO = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/));

const createSchema = z.object({
  body: z.object({
    homeTeam:        z.string().trim().min(1).max(120),
    awayTeam:        z.string().trim().min(1).max(120),
    isHome:          z.boolean(),
    competition:     z.enum(COMPETITION),
    competitionName: z.string().trim().max(200).optional(),
    venue:           z.string().trim().max(200).optional(),
    scheduledAt:     DATE_OR_ISO,
    teamId:          z.string().uuid().nullable().optional(),
    formationHome:   z.string().regex(/^\d-\d(-\d){1,2}$/).optional(),
    formationAway:   z.string().regex(/^\d-\d(-\d){1,2}$/).optional(),
    opponentNotes:   z.string().max(4000).optional(),
  }),
});

const updateSchema = z.object({
  body: z.object({
    homeScore:     z.number().int().min(0).max(99).optional(),
    awayScore:     z.number().int().min(0).max(99).optional(),
    result:        z.enum(RESULT).optional(),
    playedAt:      DATE_OR_ISO.optional(),
    possession:    z.number().min(0).max(100).optional(),
    shots:         z.number().int().min(0).max(99).optional(),
    shotsOnTarget: z.number().int().min(0).max(99).optional(),
    corners:       z.number().int().min(0).max(99).optional(),
    fouls:         z.number().int().min(0).max(99).optional(),
    yellowCards:   z.number().int().min(0).max(99).optional(),
    redCards:      z.number().int().min(0).max(99).optional(),
    teamId:        z.string().uuid().nullable().optional(),
    status:        z.enum(STATUS).optional(),
    periodNow:     z.number().int().min(1).max(5).optional(),
    liveMinute:    z.number().int().min(0).max(130).optional(),
    formationHome: z.string().regex(/^\d-\d(-\d){1,2}$/).optional(),
    formationAway: z.string().regex(/^\d-\d(-\d){1,2}$/).optional(),
    opponentNotes: z.string().max(4000).optional(),
    aiInsights:    z.any().optional(),
  }).refine((b) => Object.keys(b).length > 0, { message: 'No fields supplied to update' }),
});

const listQuerySchema = z.object({
  query: z.object({
    competition: z.enum(COMPETITION).optional(),
    status:      z.enum(STATUS).optional(),
    teamId:      z.string().optional(),
    from:        z.string().optional(),
    to:          z.string().optional(),
    search:      z.string().trim().max(100).optional(),
    page:        z.coerce.number().int().min(1).max(10_000).optional(),
    limit:       z.coerce.number().int().min(1).max(200).optional(),
  }),
});

const finalizeSchema = z.object({
  body: z.object({
    homeScore: z.number().int().min(0).max(99).optional(),
    awayScore: z.number().int().min(0).max(99).optional(),
  }),
});

const reasonSchema = z.object({ body: z.object({ reason: z.string().max(500).optional() }) });

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

function actorOf(req: Request): matchService.MatchActor {
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

function parseDateMaybe(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────

export async function getMatches(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const result = await matchService.getMatches(req.user!.clubId, {
      competition: q.competition as never,
      status:      q.status,
      teamId:      q.teamId === 'NULL' ? 'NULL' : (q.teamId || undefined),
      from:        parseDateMaybe(q.from),
      to:          parseDateMaybe(q.to),
      search:      q.search,
      page:        q.page,
      limit:       q.limit,
    });
    return sendPaginated(res, result.matches, result.total, result.page, result.limit);
  } catch (err) { return next(err); }
}

export async function getMatch(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await matchService.getMatchById(req.params.id, req.user!.clubId);
    return sendSuccess(res, m);
  } catch (err) { return next(err); }
}

export async function createMatch(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const m = await matchService.createMatch(actorOf(req), parsed.data.body as never);
    return sendCreated(res, m, 'Match created');
  } catch (err) { return next(err); }
}

export async function updateMatch(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updateSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const m = await matchService.updateMatch(actorOf(req), req.params.id, parsed.data.body);
    return sendSuccess(res, m, 'Match updated');
  } catch (err) { return next(err); }
}

export async function deleteMatch(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reasonSchema.safeParse({ body: req.body || {} });
    const reason = parsed.success ? parsed.data.body.reason : undefined;
    await matchService.deleteMatch(actorOf(req), req.params.id, reason);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function getResults(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await matchService.getMatchResults(req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Live-state transitions
// ─────────────────────────────────────────────────────────────────────────

export async function startLive(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await matchService.startLive(actorOf(req), req.params.id);
    return sendSuccess(res, m, 'Match started');
  } catch (err) { return next(err); }
}
export async function setHalftime(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await matchService.setHalftime(actorOf(req), req.params.id);
    return sendSuccess(res, m, 'Halftime');
  } catch (err) { return next(err); }
}
export async function resumeSecondHalf(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await matchService.resumeSecondHalf(actorOf(req), req.params.id);
    return sendSuccess(res, m, 'Second half resumed');
  } catch (err) { return next(err); }
}
export async function finalize(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = finalizeSchema.safeParse({ body: req.body || {} });
    if (!parsed.success) throw zerr(parsed.error);
    const m = await matchService.finalize(actorOf(req), req.params.id, parsed.data.body.homeScore, parsed.data.body.awayScore);
    return sendSuccess(res, m, 'Match finalized');
  } catch (err) { return next(err); }
}
export async function abandon(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reasonSchema.safeParse({ body: req.body || {} });
    const reason = parsed.success ? parsed.data.body.reason : undefined;
    await matchService.abandonMatch(actorOf(req), req.params.id, reason);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Audit + AI-feature read
// ─────────────────────────────────────────────────────────────────────────

export async function listAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = req.query.page  ? parseInt(req.query.page  as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
    const out = await matchService.listAudit(req.params.id, req.user!.clubId, page, limit);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}
