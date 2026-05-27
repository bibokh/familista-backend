// Familista — Player controller (Phase 2)
// Thin HTTP shim over player.service. Every handler:
//   1. Parses input with zod (no manual casts).
//   2. Builds an actor record (userId + clubId + IP + UA) for audit.
//   3. Delegates to player.service and lets errors propagate to errorHandler.

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as playerService from '../services/player.service';
import * as aiService from '../services/ai.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

// ─────────────────────────────────────────────────────────────────────────
// Enums (mirrored — keep in lockstep with prisma/schema.prisma)
// ─────────────────────────────────────────────────────────────────────────

const PLAYER_POSITIONS = ['GK','DC','DL','DR','DMC','ML','MR','MC','AMC','AML','AMR','ST'] as const;
const MEDICAL_STATUSES = ['HEALTHY','INJURED','RECOVERING','SUSPENDED','UNAVAILABLE'] as const;
const PAYMENT_STATUSES = ['PAID','PARTIAL','UNPAID','OVERDUE','EXEMPT'] as const;
const FOOTS            = ['RIGHT','LEFT','BOTH'] as const;
const SORT_KEYS        = ['name','number','position','overallRating','joinedAt','createdAt'] as const;

const DATE_OR_ISO = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

// ─────────────────────────────────────────────────────────────────────────
// Birth-date guard: must be in the past AND at least 5 years ago.
// (5 not 12 — academies have under-7 squads.)
// ─────────────────────────────────────────────────────────────────────────
const dateOfBirthSchema = DATE_OR_ISO.refine((s) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return false;
  const now = Date.now();
  if (d.getTime() >= now) return false;
  const ageMs = now - d.getTime();
  const ageYears = ageMs / (365.25 * 24 * 3600 * 1000);
  return ageYears >= 5 && ageYears <= 70;
}, { message: 'Date of birth must be in the past and within an allowed age range' });

const emailOptional = z.string().email().optional().or(z.literal(''));

// Core field shape — reused for create + update.
const playerCoreShape = {
  firstName:    z.string().trim().min(1).max(100),
  lastName:     z.string().trim().min(1).max(100),
  number:       z.number().int().min(1).max(99),
  position:     z.enum(PLAYER_POSITIONS),
  nationality:  z.string().trim().min(1).max(100),
  flag:         z.string().trim().min(1).max(16),
  dateOfBirth:  dateOfBirthSchema,
  height:       z.number().int().min(120).max(220),
  weight:       z.number().int().min(30).max(140),
  preferredFoot:z.enum(FOOTS).optional(),
  overallRating:z.number().int().min(40).max(140).optional(),
  potential:    z.number().int().min(40).max(140).optional(),
  marketValue:  z.number().min(0).optional(),
  weeklyWage:   z.number().int().min(0).optional(),
  contractUntil:z.string().optional().or(z.literal('')),
  avatar:       z.string().url().optional().or(z.literal('')),

  // Phase 2
  email:        emailOptional,
  parentName:   z.string().trim().max(200).optional().or(z.literal('')),
  parentEmail:  emailOptional,
  parentPhone:  z.string().trim().max(40).optional().or(z.literal('')),
  medicalStatus:z.enum(MEDICAL_STATUSES).optional(),
  paymentStatus:z.enum(PAYMENT_STATUSES).optional(),
  isActive:     z.boolean().optional(),
  notes:        z.string().max(2000).optional().or(z.literal('')),
  joinedAt:     z.string().optional().or(z.literal('')),
  // Phase A — optional team scoping (null = unassign)
  teamId:       z.string().uuid().nullable().optional(),
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
    position:      z.enum(PLAYER_POSITIONS).optional(),
    isInjured:     z.enum(['true','false']).optional(),
    isActive:      z.enum(['true','false']).optional(),
    medicalStatus: z.enum(MEDICAL_STATUSES).optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    search:        z.string().trim().max(100).optional(),
    minRating:     z.coerce.number().int().min(0).max(200).optional(),
    maxRating:     z.coerce.number().int().min(0).max(200).optional(),
    sortBy:        z.enum(SORT_KEYS).optional(),
    sortOrder:     z.enum(['asc','desc']).optional(),
    page:          z.coerce.number().int().min(1).max(10_000).optional(),
    limit:         z.coerce.number().int().min(1).max(200).optional(),
    teamId:        z.string().optional(), // uuid or literal 'NULL' for unassigned
  }),
});

const reasonSchema = z.object({ body: z.object({ reason: z.string().max(500).optional() }) });

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

function actorOf(req: Request): playerService.PlayerActor {
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

// Empty string is NOT a valid value for "no contractUntil"; strip it before
// passing to the service, otherwise Prisma would try to coerce ''.
function stripEmptyStrings<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const k in obj) {
    const v = obj[k as keyof T];
    if (v === '' || v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

// ─────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────

export async function getPlayers(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listPlayersQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const result = await playerService.getPlayers(req.user!.clubId, {
      position:      q.position,
      isInjured:     q.isInjured     === undefined ? undefined : q.isInjured     === 'true',
      isActive:      q.isActive      === undefined ? undefined : q.isActive      === 'true',
      medicalStatus: q.medicalStatus,
      paymentStatus: q.paymentStatus,
      search:        q.search,
      minRating:     q.minRating,
      maxRating:     q.maxRating,
      sortBy:        q.sortBy,
      sortOrder:     q.sortOrder,
      page:          q.page,
      limit:         q.limit,
      teamId:        q.teamId === 'NULL' ? 'NULL' : (q.teamId || undefined),
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
    const dto    = stripEmptyStrings(parsed.data.body) as playerService.CreatePlayerDto;
    const player = await playerService.createPlayer(actorOf(req), dto);
    return sendCreated(res, player, 'Player created');
  } catch (err) { return next(err); }
}

export async function updatePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updatePlayerSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const dto    = stripEmptyStrings(parsed.data.body) as playerService.UpdatePlayerDto;
    const player = await playerService.updatePlayer(actorOf(req), req.params.id, dto);
    return sendSuccess(res, player, 'Player updated');
  } catch (err) { return next(err); }
}

// DELETE = soft-delete (sets isActive=false). Audited.
export async function deletePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reasonSchema.safeParse({ body: req.body || {} });
    const reason = parsed.success ? parsed.data.body.reason : undefined;
    await playerService.softDeletePlayer(actorOf(req), req.params.id, reason);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// Reactivate a soft-deleted player.
export async function reactivatePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reasonSchema.safeParse({ body: req.body || {} });
    const reason = parsed.success ? parsed.data.body.reason : undefined;
    const player = await playerService.reactivatePlayer(actorOf(req), req.params.id, reason);
    return sendSuccess(res, player, 'Player reactivated');
  } catch (err) { return next(err); }
}

// Hard delete — physical removal. Restricted to CLUB_ADMIN at the route level.
export async function deletePlayerHard(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reasonSchema.safeParse({ body: req.body || {} });
    const reason = parsed.success ? parsed.data.body.reason : undefined;
    await playerService.deletePlayerHard(actorOf(req), req.params.id, reason);
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

export async function getPlayerAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await playerService.getPlayerAttendance(req.params.id, req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}

const auditQuerySchema = z.object({
  query: z.object({
    action: z.enum(['CREATE','UPDATE','DEACTIVATE','REACTIVATE','MEDICAL_STATUS_CHANGED','PAYMENT_STATUS_CHANGED','DELETE']).optional(),
    page:   z.coerce.number().int().min(1).max(10_000).optional(),
    limit:  z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function getPlayerAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = auditQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const out = await playerService.getPlayerAudit(req.params.id, req.user!.clubId, {
      action: q.action as never,
      page:   q.page,
      limit:  q.limit,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function analyzePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await aiService.analyzePlayer(req.params.id, req.user!.clubId, req.user!.id);
    return sendSuccess(res, result, 'AI analysis complete');
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Performance / Player Attributes
// ─────────────────────────────────────────────────────────────────────────

const ATTR_INT = z.number().int().min(1).max(130).optional();

const attributeSchema = z.object({
  speed:     ATTR_INT,
  agility:   ATTR_INT,
  stamina:   ATTR_INT,
  strength:  ATTR_INT,
  balance:   ATTR_INT,
  reaction:  ATTR_INT,
  technique: ATTR_INT,
  passing:   ATTR_INT,
  shooting:  ATTR_INT,
  defending: ATTR_INT,
}).refine(
  (b) => Object.values(b).some((v) => v !== undefined),
  { message: 'At least one attribute is required' },
);

export async function recordAttributes(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = attributeSchema.safeParse(req.body);
    if (!parsed.success) throw zerr(parsed.error);
    const result = await playerService.recordPlayerAttributes(actorOf(req), req.params.id, parsed.data);
    return sendCreated(res, result, 'Attributes recorded');
  } catch (err) { return next(err); }
}

export async function getAttributeHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const history = await playerService.getPlayerAttributeHistory(actorOf(req), req.params.id);
    return sendSuccess(res, history);
  } catch (err) { return next(err); }
}

export async function getSquadPerformance(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await playerService.getSquadPerformance(req.user!.clubId);
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}
