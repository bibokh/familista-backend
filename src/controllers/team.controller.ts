// Familista — Team controller (Phase A)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as teamService from '../services/team.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const TEAM_KINDS = ['SENIOR','RESERVES','ACADEMY_U23','ACADEMY_U21','ACADEMY_U19','ACADEMY_U17','ACADEMY_U15','ACADEMY_U13','ACADEMY_U11','ACADEMY_U9','ACADEMY_U7','WOMEN','WOMEN_U19','WOMEN_U17','FUTSAL','OTHER'] as const;
const GENDERS    = ['MEN','WOMEN','MIXED'] as const;

// Plain (non-refined) body shape — reused for both create + update so we can
// call .partial() on it. The age-range refine is layered separately.
const teamBodyShape = z.object({
  name:      z.string().trim().min(1).max(120),
  shortName: z.string().trim().max(20).optional().or(z.literal('')),
  kind:      z.enum(TEAM_KINDS).optional(),
  gender:    z.enum(GENDERS).optional(),
  ageMin:    z.number().int().min(3).max(70).optional(),
  ageMax:    z.number().int().min(3).max(99).optional(),
  color:     z.string().regex(/^#?[0-9a-fA-F]{3,8}$/).optional().or(z.literal('')),
  emblem:    z.string().url().optional().or(z.literal('')),
  notes:     z.string().max(2000).optional().or(z.literal('')),
  isActive:  z.boolean().optional(),
});

const ageRangeOk = (b: { ageMin?: number; ageMax?: number }) =>
  b.ageMin === undefined || b.ageMax === undefined || b.ageMax >= b.ageMin;

const createTeamSchema = z.object({
  body: teamBodyShape.refine(ageRangeOk, { message: 'ageMax must be ≥ ageMin' }),
});

const updateTeamSchema = z.object({
  body: teamBodyShape.partial()
    .refine((b) => Object.keys(b).length > 0, { message: 'No fields supplied to update' })
    .refine(ageRangeOk, { message: 'ageMax must be ≥ ageMin' }),
});

const listQuerySchema = z.object({
  query: z.object({
    search:   z.string().trim().max(100).optional(),
    kind:     z.enum(TEAM_KINDS).optional(),
    isActive: z.enum(['true','false']).optional(),
    page:     z.coerce.number().int().min(1).max(10_000).optional(),
    limit:    z.coerce.number().int().min(1).max(200).optional(),
  }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

function stripEmpty<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const k in obj) {
    const v = obj[k as keyof T];
    if (v === '' || v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const out = await teamService.listTeams(req.user!.clubId, {
      search:   q.search,
      kind:     q.kind,
      isActive: q.isActive === undefined ? undefined : q.isActive === 'true',
      page:     q.page,
      limit:    q.limit,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const team = await teamService.getTeam(req.params.id, req.user!.clubId);
    return sendSuccess(res, team);
  } catch (err) { return next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createTeamSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const team = await teamService.createTeam(req.user!.clubId, stripEmpty(parsed.data.body) as teamService.CreateTeamDto);
    return sendCreated(res, team, 'Team created');
  } catch (err) { return next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updateTeamSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const team = await teamService.updateTeam(req.params.id, req.user!.clubId, stripEmpty(parsed.data.body) as teamService.UpdateTeamDto);
    return sendSuccess(res, team, 'Team updated');
  } catch (err) { return next(err); }
}

export async function archive(req: Request, res: Response, next: NextFunction) {
  try {
    await teamService.archiveTeam(req.params.id, req.user!.clubId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function reactivate(req: Request, res: Response, next: NextFunction) {
  try {
    const team = await teamService.reactivateTeam(req.params.id, req.user!.clubId);
    return sendSuccess(res, team, 'Team reactivated');
  } catch (err) { return next(err); }
}
