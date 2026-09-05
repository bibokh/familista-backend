// SYSTEM — HTTP shim over platform/system.service.ts
//
// Every handler is platform-owner only, checked in the service as well as at
// the route. Nothing here is club-scoped, and nothing club-scoped belongs here.

import { Request, Response, NextFunction } from 'express';
import * as system from '../platform/system.service';
import { SYSTEM_MODULES } from '../platform/system-modules';
import { describeAuthority } from '../platform/access-levels';
import { sendSuccess } from '../utils/response';

function actorOf(req: Request): { userId: string; clubId: string | null; role?: string } {
  const u = req.user as unknown as { id?: string; role?: string; clubId?: string } | undefined;
  return { userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role };
}

/** Who the caller is, in platform terms. The SYSTEM shell asks before drawing. */
export async function whoAmI(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await describeAuthority(actorOf(req)));
  } catch (err) { return next(err); }
}

export async function modules(req: Request, res: Response, next: NextFunction) {
  try {
    await system.assertPlatformOwner(actorOf(req));
    return sendSuccess(res, { modules: SYSTEM_MODULES });
  } catch (err) { return next(err); }
}

export async function overview(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await system.platformOverview(actorOf(req)));
  } catch (err) { return next(err); }
}

export async function clubs(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, { clubs: await system.listClubs(actorOf(req)) });
  } catch (err) { return next(err); }
}

export async function people(req: Request, res: Response, next: NextFunction) {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const clubId = typeof req.query.clubId === 'string' ? req.query.clubId : undefined;
    return sendSuccess(res, { people: await system.listPeople(actorOf(req), { search, clubId }) });
  } catch (err) { return next(err); }
}
