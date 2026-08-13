// Familista — club-to-club transfer market controller
// Delegates every decision to transfer-market.service.ts

import { Request, Response, NextFunction } from 'express';
import * as svc from '../transfer-market/transfer-market.service';
import { sendSuccess, sendCreated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUUID(id: string | undefined, name: string): string {
  if (!id || !UUID_RE.test(id)) throw new BadRequestError(`${name} must be a valid UUID`);
  return id;
}
function actor(req: Request): svc.MarketActor {
  return { userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role };
}

export async function readMarket(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = req.query.page  ? parseInt(String(req.query.page), 10)  : 1;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    return sendSuccess(res, await svc.readMarket(actor(req), { page, limit }));
  } catch (err) { return next(err); }
}

export async function readOwnListings(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.readOwnListings(actor(req))); }
  catch (err) { return next(err); }
}

export async function getBalance(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.getBalance(req.user!.clubId)); }
  catch (err) { return next(err); }
}

export async function listPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = req.body as svc.ListDto;
    requireUUID(dto?.playerId, 'playerId');
    return sendCreated(res, await svc.listPlayer(actor(req), dto));
  } catch (err) { return next(err); }
}

export async function delistPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendSuccess(res, await svc.delistPlayer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function purchase(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendSuccess(res, await svc.purchase(actor(req), id));
  } catch (err) { return next(err); }
}

export async function bootstrapRoster(req: Request, res: Response, next: NextFunction) {
  try {
    const teams = (req.body?.teams ?? []) as svc.BootstrapTeamDto[];
    return sendSuccess(res, await svc.bootstrapRoster(actor(req), teams));
  } catch (err) { return next(err); }
}
