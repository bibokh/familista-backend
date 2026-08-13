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

// ── TEMPORARY · bootstrap failure diagnostic ─────────────────────────────────
// Production answers "Internal server error" and keeps the exception in a log
// this environment cannot read, so a 500 here is unidentifiable from outside.
// This describes the failure — and only the failure — to the authenticated club
// operator who caused it: what threw, the Prisma code and the model/column it
// names, where in our own source it happened, and who was acting.
//
// It never returns anything that is not already about this request: no
// environment, no connection string, no headers, no cookies, no token, no
// request body. The message is scrubbed of anything URL-shaped with credentials
// and truncated, and the stack is reduced to our own files.
//
// Remove once the failing operation is identified and fixed.
const CREDENTIALS_IN_TEXT = /\b[a-z+]+:\/\/[^\s"']*@[^\s"']*/gi;

function safeDiagnostic(err: unknown, req: Request) {
  const e = err as { name?: string; message?: string; stack?: string;
                     code?: string; meta?: unknown; constructor?: { name?: string } };
  const scrub = (s: string) => s.replace(CREDENTIALS_IN_TEXT, '[redacted-url]');
  const frames = String(e?.stack ?? '')
    .split('\n')
    .filter((l) => l.includes('/src/'))
    .slice(0, 6)
    .map((l) => scrub(l.trim()));
  return {
    name:    e?.constructor?.name ?? e?.name ?? 'Error',
    code:    e?.code ?? null,               // Prisma P-code, e.g. P2022 / P2028
    meta:    e?.meta ?? null,               // Prisma's structured detail: model, column, target
    message: scrub(String(e?.message ?? '')).slice(0, 900),
    frames,                                 // our own source only, file:line
    actor:   { role: req.user?.role ?? null, clubId: req.user?.clubId ?? null },
  };
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
  } catch (err) {
    // Deliberate errors (a bad request, a refusal) keep their normal handling —
    // they already say what went wrong. Only an unexpected failure, the one that
    // would otherwise arrive as a bare "Internal server error", is described.
    const status = (err as { statusCode?: number })?.statusCode;
    if (status && status < 500) return next(err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      diagnostic: safeDiagnostic(err, req),   // TEMPORARY — see safeDiagnostic
    });
  }
}
