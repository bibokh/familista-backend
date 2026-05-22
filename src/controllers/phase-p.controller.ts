// Familista — Phase P bundled controller.
// Real-launch surface for FC Familista operations:
//   • Production status rollup
//   • Attendance reports
//   • Payer balance + payment history
//   • In-app notification inbox

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as att   from '../launch/attendance-report.service';
import * as bal   from '../launch/balance.service';
import * as inbox from '../launch/notifications-inbox.service';
import * as stat  from '../launch/status.service';
import * as seed  from '../launch/seed-fc-familista.service';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError, ForbiddenError } from '../utils/errors';

const NOTIFICATION_KIND = ['SYSTEM','ATTENDANCE_REMINDER','PAYMENT_REMINDER','TRAINING_UPDATE','INJURY_ALERT','DEVICE_ALERT','GDPR_UPDATE'] as const;

function actor<A>(req: Request): A {
  if (!req.user) throw new BadRequestError('auth');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role } as unknown as A;
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '));
}
function bigintSafe<T>(row: T): T {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map(bigintSafe) as unknown as T;
  if (typeof row === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      out[k] = typeof v === 'bigint' ? v.toString() : (v && typeof v === 'object' ? bigintSafe(v) : v);
    }
    return out as unknown as T;
  }
  return row;
}

// ── Status ─────────────────────────────────────────────────────────────

export async function status(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await stat.productionStatus(actor(req))); }
  catch (err) { return next(err); }
}

// ── Attendance reports ─────────────────────────────────────────────────

const reportQuery = z.object({
  teamId:     z.string().uuid().optional(),
  playerId:   z.string().uuid().optional(),
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
});

export async function trainingAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reportQuery.safeParse(req.query); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, await att.trainingAttendanceReport(actor(req), parsed.data));
  } catch (err) { return next(err); }
}

export async function matchAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reportQuery.safeParse(req.query); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, await att.matchAttendanceReport(actor(req), parsed.data));
  } catch (err) { return next(err); }
}

export async function combinedAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const windowDays = req.query.windowDays ? Number(req.query.windowDays) : 60;
    return sendSuccess(res, await att.combinedAttendanceReport(actor(req), req.params.playerId, windowDays));
  } catch (err) { return next(err); }
}

// ── Balance + history ──────────────────────────────────────────────────

const balanceQuery = z.object({
  payerPlayerId: z.string().uuid().optional(),
  payerUserId:   z.string().uuid().optional(),
}).refine((v) => v.payerPlayerId || v.payerUserId, { message: 'payerPlayerId or payerUserId required' });

export async function balanceFor(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = balanceQuery.safeParse(req.query); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, bigintSafe(await bal.payerBalance(actor(req), parsed.data)));
  } catch (err) { return next(err); }
}

export async function history(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = balanceQuery.safeParse(req.query); if (!parsed.success) throw zerr(parsed.error);
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;
    const rows = await bal.paymentHistory(actor(req), { ...parsed.data, limit });
    return sendSuccess(res, rows.map(bigintSafe));
  } catch (err) { return next(err); }
}

export async function opsSummary(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, bigintSafe(await bal.clubOpsSummary(actor(req)))); }
  catch (err) { return next(err); }
}

// ── Inbox ──────────────────────────────────────────────────────────────

const notifySchema = z.object({
  body: z.object({
    userId:  z.string().uuid(),
    kind:    z.enum(NOTIFICATION_KIND).optional(),
    title:   z.string().trim().min(1).max(200),
    body:    z.string().trim().max(5000).optional(),
    payload: z.any().optional(),
  }),
});

export async function sendNotification(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = notifySchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await inbox.notify(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

const notifyManySchema = z.object({
  body: z.object({
    userIds: z.array(z.string().uuid()).min(1).max(500),
    kind:    z.enum(NOTIFICATION_KIND).optional(),
    title:   z.string().trim().min(1).max(200),
    body:    z.string().trim().max(5000).optional(),
    payload: z.any().optional(),
  }),
});

export async function sendNotificationBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = notifyManySchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const { userIds, ...tpl } = parsed.data.body;
    return sendCreated(res, await inbox.notifyMany(actor(req), userIds, tpl as never));
  } catch (err) { return next(err); }
}

export async function inboxList(req: Request, res: Response, next: NextFunction) {
  try {
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const kind = typeof req.query.kind === 'string' ? req.query.kind as never : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
    const rows = await inbox.listInbox(actor(req), { unreadOnly, kind, limit });
    return sendSuccess(res, rows.map(bigintSafe));
  } catch (err) { return next(err); }
}

export async function inboxCounts(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await inbox.inboxCounts(actor(req))); }
  catch (err) { return next(err); }
}

export async function inboxMarkRead(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, bigintSafe(await inbox.markRead(actor(req), req.params.id))); }
  catch (err) { return next(err); }
}

export async function inboxMarkAllRead(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await inbox.markAllRead(actor(req))); }
  catch (err) { return next(err); }
}

export async function inboxArchive(req: Request, res: Response, next: NextFunction) {
  try { await inbox.archive(actor(req), req.params.id); return sendNoContent(res); }
  catch (err) { return next(err); }
}

// ── Seed (SUPER_ADMIN only) ────────────────────────────────────────────

export async function runSeed(req: Request, res: Response, next: NextFunction) {
  try {
    const a = actor<{ userId: string; clubId: string; role?: string }>(req);
    if (a.role !== 'SUPER_ADMIN') throw new ForbiddenError('SUPER_ADMIN only');
    const adminEmail = typeof req.body?.adminEmail === 'string' ? req.body.adminEmail : undefined;
    return sendCreated(res, await seed.seedFcFamilista({ adminEmail }), 'FC Familista seed executed');
  } catch (err) { return next(err); }
}
