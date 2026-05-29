// Familista — Scouting & Recruitment Center controller
// Delegates all business logic to scouting.service.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from 'express';
import * as svc from '../services/scouting.service';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUUID(id: string | undefined, name: string): string {
  if (!id || !UUID_RE.test(id)) {
    throw new BadRequestError(`${name} must be a valid UUID`);
  }
  return id;
}

function actor(req: Request): svc.ScoutActor {
  return { userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createProspect(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = req.body as svc.CreateProspectDto;
    const prospect = await svc.createProspect(actor(req), dto);
    return sendCreated(res, prospect);
  } catch (err) { return next(err); }
}

export async function getProspect(req: Request, res: Response, next: NextFunction) {
  try {
    const prospectId = requireUUID(req.params.prospectId, 'prospectId');
    const prospect = await svc.getProspect(actor(req), prospectId);
    return sendSuccess(res, prospect);
  } catch (err) { return next(err); }
}

export async function listProspects(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      status, position, recommendation, search,
      watchlistCategory, sortBy, sortDir,
    } = req.query as Record<string, string | undefined>;

    const isOnWatchlist = req.query.isOnWatchlist !== undefined
      ? req.query.isOnWatchlist === 'true'
      : undefined;

    const limit  = Math.min(parseInt(req.query.limit  as string, 10) || 20, 200);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const result = await svc.listProspects(actor(req), {
      status, position, recommendation,
      isOnWatchlist, watchlistCategory,
      search, limit, offset,
      sortBy,
      sortDir: (sortDir === 'asc' || sortDir === 'desc') ? sortDir : undefined,
    });

    return sendSuccess(res, result.items, 'Success', 200, {
      total:  result.total,
      limit,
      offset,
    });
  } catch (err) { return next(err); }
}

export async function updateProspect(req: Request, res: Response, next: NextFunction) {
  try {
    const prospectId = requireUUID(req.params.prospectId, 'prospectId');
    const dto = req.body as svc.UpdateProspectDto;
    const prospect = await svc.updateProspect(actor(req), prospectId, dto);
    return sendSuccess(res, prospect);
  } catch (err) { return next(err); }
}

export async function deleteProspect(req: Request, res: Response, next: NextFunction) {
  try {
    const prospectId = requireUUID(req.params.prospectId, 'prospectId');
    await svc.deleteProspect(actor(req), prospectId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export async function advancePipelineStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const prospectId = requireUUID(req.params.prospectId, 'prospectId');
    const { status } = req.body as { status: string };
    if (!status) throw new BadRequestError('status is required');
    const prospect = await svc.advancePipelineStatus(actor(req), prospectId, status);
    return sendSuccess(res, prospect);
  } catch (err) { return next(err); }
}

export async function getPipelineBoard(req: Request, res: Response, next: NextFunction) {
  try {
    const board = await svc.getPipelineBoard(actor(req));
    return sendSuccess(res, board);
  } catch (err) { return next(err); }
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export async function updateWatchlist(req: Request, res: Response, next: NextFunction) {
  try {
    const prospectId = requireUUID(req.params.prospectId, 'prospectId');
    const dto = req.body as svc.WatchlistUpdateDto;
    if (typeof dto.isOnWatchlist !== 'boolean') {
      throw new BadRequestError('isOnWatchlist (boolean) is required');
    }
    const prospect = await svc.updateWatchlist(actor(req), prospectId, dto);
    return sendSuccess(res, prospect);
  } catch (err) { return next(err); }
}

export async function getWatchlist(req: Request, res: Response, next: NextFunction) {
  try {
    const { category } = req.query as { category?: string };
    const items = await svc.getWatchlist(actor(req), category);
    return sendSuccess(res, items);
  } catch (err) { return next(err); }
}

// ── Comparison ────────────────────────────────────────────────────────────────

export async function compareProspects(req: Request, res: Response, next: NextFunction) {
  try {
    const { prospectA, prospectB } = req.query as { prospectA?: string; prospectB?: string };
    const idA = requireUUID(prospectA, 'prospectA');
    const idB = requireUUID(prospectB, 'prospectB');
    if (idA === idB) throw new BadRequestError('prospectA and prospectB must be different');
    const result = await svc.compareProspects(actor(req), idA, idB);
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export async function getScoutDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await svc.getScoutDashboard(actor(req));
    return sendSuccess(res, data);
  } catch (err) { return next(err); }
}
