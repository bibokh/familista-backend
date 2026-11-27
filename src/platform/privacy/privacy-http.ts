/**
 * Familista Design Studio — the HTTP handlers of the studio's privacy controls (P1).
 *
 *   club   POST /club-design/privacy/erase-person              a club administrator erases a person's name (preview first)
 *   owner  GET  /system/product-design/privacy/retention       the retention rules, none set by default
 *          PUT  /system/product-design/privacy/retention       set or clear one rule
 *          POST /system/product-design/privacy/retention/apply preview what the rules reach (dryRun), or apply them
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import type { DesignActor, DesignScope } from '../product-design/service';
import { ErasureInvalidError, erasePerson } from './erasure.service';
import { RetentionInvalidError, applyRetention, listRetention, setRetention } from './retention.service';

const EraseBody = z.object({ name: z.string().max(200), confirm: z.boolean().default(false) }).strict();
const RetentionBody = z.object({ kind: z.string().max(60), days: z.number().int().nullable() }).strict();
const ApplyBody = z.object({ dryRun: z.boolean().default(true) }).strict();

function actorOf(req: Request): DesignActor & { role?: UserRole } {
  const ua = req.headers['user-agent'];
  return { userId: req.user?.id ?? '', role: req.user?.role as UserRole | undefined, ipAddress: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null, correlationId: req.requestId ?? null };
}
function refused(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof ErasureInvalidError || err instanceof RetentionInvalidError) { res.status(400).json({ success: false, code: err.code, message: err.message }); return; }
  next(err);
}
function handler(work: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req, res, next) => { try { await work(req, res); } catch (err) { refused(err, res, next); } };
}
function clubOf(res: Response): string {
  const s = res.locals.designScope as DesignScope | undefined;
  if (!s || s.kind !== 'CLUB') throw new Error('A club privacy route was reached without a club scope');
  return s.clubId;
}

export const clubErasePerson = handler(async (req, res) => { res.json({ success: true, data: await erasePerson(clubOf(res), actorOf(req), EraseBody.parse(req.body ?? {})) }); });
export const ownerReadRetention = handler(async (_req, res) => { res.json({ success: true, data: await listRetention() }); });
export const ownerSetRetention = handler(async (req, res) => {
  const { kind, days } = RetentionBody.parse(req.body ?? {});
  res.json({ success: true, data: await setRetention(actorOf(req), kind, days) });
});
export const ownerApplyRetention = handler(async (req, res) => { res.json({ success: true, data: await applyRetention(actorOf(req), ApplyBody.parse(req.body ?? {}).dryRun) }); });
