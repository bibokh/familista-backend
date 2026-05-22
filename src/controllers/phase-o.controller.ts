// Familista — Phase O bundled controller.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as sess  from '../auth-prod/session.service';
import * as mfa   from '../auth-prod/mfa.service';
import * as ops   from '../operations/operations.service';
import * as life  from '../player-lifecycle/player-lifecycle.service';
import * as hwd   from '../hardware-deploy/hardware-deploy.service';
import * as notif from '../notifications/notifications.service';
import * as gov   from '../governance/governance.service';
import * as mon   from '../monitoring/monitoring.service';
import { sendSuccess, sendCreated, sendPaginated, sendNoContent } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const ATTENDANCE     = ['PRESENT','ABSENT','LATE','EXCUSED'] as const;
const PAYMENT_STATE  = ['PENDING','PAID','OVERDUE','REFUNDED','CANCELED'] as const;
const EVENT_KIND     = ['TRAINING','MATCH','MEDICAL','MEETING','TRAVEL','OTHER'] as const;
const CONTRACT_STATE = ['DRAFT','ACTIVE','EXPIRED','TERMINATED','RENEWED'] as const;
const INV_STATE      = ['STOCK','DEPLOYED','RMA','RETIRED'] as const;
const GDPR_KIND      = ['EXPORT','DELETE','RECTIFICATION','PORTABILITY'] as const;
const GDPR_STATE     = ['PENDING','PROCESSING','COMPLETED','REJECTED'] as const;
const CONSENT_SCOPE  = ['MEDICAL','MARKETING','DATA_SHARING','RESEARCH','IMAGE_USE','CUSTOM'] as const;
const HEALTH_STATE   = ['OK','DEGRADED','DOWN'] as const;
const ALERT_STATE    = ['ACTIVE','MUTED','ARCHIVED'] as const;
const BACKUP_KIND    = ['SCHEDULED','MANUAL','PRE_DEPLOY','RESTORE_POINT'] as const;

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

// ── Auth: sessions ─────────────────────────────────────────────────────

export async function listAuthSessions(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await sess.listSessions(actor(req), typeof req.query.userId === 'string' ? req.query.userId : undefined)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

export async function revokeAuthSession(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual';
    return sendSuccess(res, bigintSafe(await sess.revoke(actor(req), req.params.sessionId, reason)));
  } catch (err) { return next(err); }
}

export async function revokeAllAuthSessions(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.params.userId;
    return sendSuccess(res, await sess.revokeAllForUser(actor(req), userId));
  } catch (err) { return next(err); }
}

const rotateSchema = z.object({ body: z.object({ refreshToken: z.string().trim().min(8).max(512) }) });

export async function rotateAuthSession(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = rotateSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip;
    const ua = req.headers['user-agent'] as string | undefined;
    const out = await sess.rotateSession(parsed.data.body.refreshToken, ip, ua);
    return sendCreated(res, { session: bigintSafe(out.session), refreshToken: out.refreshToken });
  } catch (err) { return next(err); }
}

// ── Auth: MFA ──────────────────────────────────────────────────────────

export async function mfaEnroll(req: Request, res: Response, next: NextFunction) {
  try {
    const label = typeof req.body?.label === 'string' ? req.body.label : 'Familista';
    return sendCreated(res, await mfa.enrollTOTP(actor(req), label), 'Save the secret immediately. It will not be shown again.');
  } catch (err) { return next(err); }
}

const confirmSchema = z.object({ body: z.object({ code: z.string().trim().length(6) }) });

export async function mfaConfirm(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = confirmSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await mfa.confirmTOTP(actor(req), parsed.data.body.code)), 'Save the backup codes immediately. They will not be shown again.');
  } catch (err) { return next(err); }
}

export async function mfaDisable(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await mfa.disableMFA(actor(req))); }
  catch (err) { return next(err); }
}

const verifySchema = z.object({ body: z.object({ code: z.string().trim().min(4).max(20) }) });

export async function mfaVerify(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = verifySchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, { ok: await mfa.verifyLogin(actor(req), parsed.data.body.code) });
  } catch (err) { return next(err); }
}

// ── Operations: guardians ──────────────────────────────────────────────

const guardianSchema = z.object({ body: z.object({ playerId: z.string().uuid(), guardianUserId: z.string().uuid(), relationship: z.string().trim().max(40).optional(), isPrimary: z.boolean().optional() }) });

export async function linkGuardian(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = guardianSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await ops.linkGuardian(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listGuardians(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await ops.listGuardians(actor(req), req.params.playerId)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

export async function unlinkGuardian(req: Request, res: Response, next: NextFunction) {
  try { await ops.unlinkGuardian(actor(req), req.params.id); return sendNoContent(res); }
  catch (err) { return next(err); }
}

// ── Operations: attendance ─────────────────────────────────────────────

const trainingAttSchema = z.object({ body: z.object({ trainingSessionId: z.string().uuid(), playerId: z.string().uuid(), mark: z.enum(ATTENDANCE).optional(), notes: z.string().trim().max(2000).optional() }) });

export async function markTrainingAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = trainingAttSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await ops.markTrainingAttendance(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listTrainingAttendance(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await ops.listTrainingAttendance(actor(req), req.params.sessionId)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const matchAttSchema = z.object({ body: z.object({ matchId: z.string().uuid(), playerId: z.string().uuid(), mark: z.enum(ATTENDANCE).optional(), minutesOnPitch: z.number().int().min(0).max(200).optional(), notes: z.string().trim().max(2000).optional() }) });

export async function markMatchAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = matchAttSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await ops.markMatchAttendance(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listMatchAttendance(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await ops.listMatchAttendance(actor(req), req.params.matchId)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

// ── Operations: payments / invoice lines ───────────────────────────────

const paymentSchema = z.object({ body: z.object({ payerUserId: z.string().uuid().optional(), payerPlayerId: z.string().uuid().optional(), amountCents: z.number().int().min(0), currency: z.string().trim().max(8).optional(), category: z.string().trim().min(1).max(40), dueDate: z.string().datetime().optional(), invoiceRef: z.string().trim().max(200).optional(), notes: z.string().trim().max(2000).optional() }) });

export async function createPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = paymentSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await ops.createPayment(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const paymentStateSchema = z.object({ body: z.object({ state: z.enum(PAYMENT_STATE), paidAt: z.string().datetime().optional() }) });

export async function setPaymentState(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = paymentStateSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, bigintSafe(await ops.setPaymentState(actor(req), req.params.id, parsed.data.body.state, parsed.data.body.paidAt)));
  } catch (err) { return next(err); }
}

export async function listPayments(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await ops.listPayments(actor(req), {
      state:         typeof req.query.state         === 'string' ? req.query.state as never : undefined,
      payerPlayerId: typeof req.query.payerPlayerId === 'string' ? req.query.payerPlayerId : undefined,
    });
    return sendPaginated(res, out.items.map(bigintSafe), out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const invoiceLineSchema = z.object({ body: z.object({ label: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(10_000).optional(), unitCents: z.number().int().min(0).optional() }) });

export async function addInvoiceLine(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = invoiceLineSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await ops.addInvoiceLine(actor(req), req.params.invoiceDraftId, parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listInvoiceLines(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await ops.listInvoiceLines(req.params.invoiceDraftId)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

// ── Calendar ───────────────────────────────────────────────────────────

const calendarSchema = z.object({ body: z.object({ teamId: z.string().uuid().optional(), kind: z.enum(EVENT_KIND).optional(), title: z.string().trim().min(1).max(200), startsAt: z.string().datetime(), endsAt: z.string().datetime().optional(), location: z.string().trim().max(200).optional(), payload: z.any().optional(), externalRef: z.string().trim().max(200).optional() }) });

export async function createCalendarEntry(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = calendarSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await ops.createCalendarEntry(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function listCalendar(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await ops.listCalendar(actor(req), {
      teamId:  typeof req.query.teamId  === 'string' ? req.query.teamId : undefined,
      fromIso: typeof req.query.fromIso === 'string' ? req.query.fromIso : undefined,
      toIso:   typeof req.query.toIso   === 'string' ? req.query.toIso : undefined,
    });
    return sendSuccess(res, out.map(bigintSafe));
  } catch (err) { return next(err); }
}

// ── Player lifecycle ───────────────────────────────────────────────────

export async function seedOnboarding(req: Request, res: Response, next: NextFunction) {
  try { return sendCreated(res, (await life.seedOnboarding(actor(req), req.params.playerId)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const completeSchema = z.object({ body: z.object({ step: z.string().trim().min(1).max(60), payload: z.any().optional() }) });

export async function completeOnboardingStep(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = completeSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, bigintSafe(await life.completeOnboardingStep(actor(req), req.params.playerId, parsed.data.body.step, parsed.data.body.payload as never)));
  } catch (err) { return next(err); }
}

export async function listOnboarding(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await life.listOnboarding(actor(req), req.params.playerId)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const evaluationSchema = z.object({ body: z.object({ playerId: z.string().uuid(), kind: z.string().trim().min(1).max(40), payload: z.any(), score: z.number().min(0).max(1).optional(), notes: z.string().trim().max(10_000).optional() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function recordEvaluation(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = evaluationSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await life.recordEvaluation(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

export async function listEvaluations(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await life.listEvaluations(actor(req), req.params.playerId, { kind: typeof req.query.kind === 'string' ? req.query.kind : undefined })).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const contractSchema = z.object({ body: z.object({ playerId: z.string().uuid(), startsAt: z.string().datetime(), endsAt: z.string().datetime().optional(), weeklyWageCents: z.number().int().min(0).optional(), signingBonusCents: z.number().int().min(0).optional(), releaseClauseCents: z.number().int().min(0).optional(), payload: z.any().optional() }) });

export async function createContract(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await life.createContract(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

const contractStateSchema = z.object({ body: z.object({ state: z.enum(CONTRACT_STATE) }) });

export async function transitionContract(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = contractStateSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, bigintSafe(await life.transitionContractState(actor(req), req.params.id, parsed.data.body.state)));
  } catch (err) { return next(err); }
}

export async function listContracts(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await life.listContracts(actor(req), {
      playerId: typeof req.query.playerId === 'string' ? req.query.playerId : undefined,
      state:    typeof req.query.state    === 'string' ? req.query.state as never : undefined,
    });
    return sendSuccess(res, out.map(bigintSafe));
  } catch (err) { return next(err); }
}

// ── Hardware deploy ────────────────────────────────────────────────────

const inventorySchema = z.object({ body: z.object({ serial: z.string().trim().min(1).max(120), deviceId: z.string().uuid().optional(), state: z.enum(INV_STATE).optional(), location: z.string().trim().max(200).optional(), shippedAt: z.string().datetime().optional(), receivedAt: z.string().datetime().optional(), rmaReason: z.string().trim().max(500).optional(), notes: z.string().trim().max(2000).optional() }) });

export async function upsertInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = inventorySchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await hwd.upsertInventory(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await hwd.listInventory(actor(req), { state: typeof req.query.state === 'string' ? req.query.state as never : undefined });
    return sendPaginated(res, out.items.map(bigintSafe), out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const diagSchema = z.object({ body: z.object({ deviceId: z.string().uuid(), reportKind: z.string().trim().min(1).max(40), payload: z.any(), score: z.number().min(0).max(1).optional() }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }) });

export async function recordDiagnostic(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = diagSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await hwd.recordDiagnostic(actor(req), { ...body, payload: body.payload as never })));
  } catch (err) { return next(err); }
}

export async function listDiagnostics(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await hwd.listDiagnostics(actor(req), req.params.deviceId)).map(bigintSafe)); }
  catch (err) { return next(err); }
}

// ── Notifications ──────────────────────────────────────────────────────

const channelSchema = z.object({ body: z.object({ channel: z.string().trim().min(1).max(20), target: z.string().trim().min(1).max(400), preferences: z.any().optional() }) });

export async function registerChannel(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = channelSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await notif.registerChannel(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function listChannels(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await notif.listChannels(actor(req))).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const reportTplSchema = z.object({ body: z.object({ code: z.string().trim().min(1).max(120), label: z.string().trim().min(1).max(200), definition: z.any(), global: z.boolean().optional() }).refine((v) => v.definition !== undefined, { message: 'definition required', path: ['definition'] }) });

export async function publishReportTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reportTplSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await notif.publishTemplate(actor(req), { ...body, definition: body.definition as never })));
  } catch (err) { return next(err); }
}

const runSchema = z.object({ body: z.object({ templateId: z.string().uuid(), parameters: z.any(), output: z.any() }).refine((v) => v.output !== undefined, { message: 'output required', path: ['output'] }) });

export async function recordReportRun(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = runSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendCreated(res, bigintSafe(await notif.recordRun(actor(req), { templateId: body.templateId, parameters: (body.parameters ?? null) as never, output: body.output as never })));
  } catch (err) { return next(err); }
}

// ── Governance ─────────────────────────────────────────────────────────

const retentionSchema = z.object({ body: z.object({ entityType: z.string().trim().min(1).max(120), retentionDays: z.number().int().min(0).max(36_500), global: z.boolean().optional() }) });

export async function upsertRetention(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = retentionSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await gov.upsertRetention(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

export async function listRetention(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await gov.listRetention(actor(req))).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const gdprSchema = z.object({ body: z.object({ kind: z.enum(GDPR_KIND), subjectUserId: z.string().uuid().optional(), subjectPlayerId: z.string().uuid().optional(), scope: z.any().optional() }) });

export async function openGdprRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = gdprSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await gov.openRequest(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

const gdprStateSchema = z.object({ body: z.object({ state: z.enum(GDPR_STATE), resultRef: z.string().trim().max(800).optional(), rejectedReason: z.string().trim().max(2000).optional() }) });

export async function transitionGdpr(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = gdprStateSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    return sendSuccess(res, bigintSafe(await gov.transitionRequestState(actor(req), req.params.id, body.state, { resultRef: body.resultRef, rejectedReason: body.rejectedReason })));
  } catch (err) { return next(err); }
}

export async function listGdprRequests(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, (await gov.listRequests(actor(req), {
      kind:  typeof req.query.kind  === 'string' ? req.query.kind as never : undefined,
      state: typeof req.query.state === 'string' ? req.query.state as never : undefined,
    })).map(bigintSafe));
  } catch (err) { return next(err); }
}

const consentSchema = z.object({ body: z.object({ scope: z.enum(CONSENT_SCOPE), granted: z.boolean().optional(), userId: z.string().uuid().optional(), playerId: z.string().uuid().optional(), payload: z.any().optional() }) });

export async function recordConsent(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = consentSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await gov.recordConsent(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function listConsent(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, (await gov.listConsent(actor(req), {
      userId:   typeof req.query.userId   === 'string' ? req.query.userId : undefined,
      playerId: typeof req.query.playerId === 'string' ? req.query.playerId : undefined,
      scope:    typeof req.query.scope    === 'string' ? req.query.scope as never : undefined,
    })).map(bigintSafe));
  } catch (err) { return next(err); }
}

// ── Monitoring ─────────────────────────────────────────────────────────

const healthSchema = z.object({ body: z.object({ service: z.string().trim().min(1).max(60), state: z.enum(HEALTH_STATE), latencyMs: z.number().int().min(0).optional(), payload: z.any().optional() }) });

export async function recordHealth(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = healthSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await mon.recordHealth(parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function healthSnapshot(_req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await mon.healthSnapshot()); }
  catch (err) { return next(err); }
}

const alertRuleSchema = z.object({ body: z.object({ code: z.string().trim().min(1).max(120), label: z.string().trim().min(1).max(200), expression: z.string().trim().min(1).max(2000), threshold: z.number().optional(), channelTargets: z.any().optional(), global: z.boolean().optional() }) });

export async function upsertAlertRule(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = alertRuleSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await mon.upsertAlertRule(actor(req), parsed.data.body)));
  } catch (err) { return next(err); }
}

const alertStateSchema = z.object({ body: z.object({ state: z.enum(ALERT_STATE) }) });

export async function setAlertRuleState(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = alertStateSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, bigintSafe(await mon.setAlertRuleState(actor(req), req.params.id, parsed.data.body.state)));
  } catch (err) { return next(err); }
}

export async function listAlertRules(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await mon.listAlertRules(actor(req))).map(bigintSafe)); }
  catch (err) { return next(err); }
}

const backupSchema = z.object({ body: z.object({ kind: z.enum(BACKUP_KIND), ref: z.string().trim().max(800).optional(), sizeBytes: z.number().int().min(0).optional(), sha256: z.string().trim().length(64).optional(), notes: z.string().trim().max(2000).optional(), ok: z.boolean().optional(), finishedAtIso: z.string().datetime().optional() }) });

export async function recordBackup(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = backupSchema.safeParse({ body: req.body }); if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, bigintSafe(await mon.recordBackup(actor(req), parsed.data.body as never)));
  } catch (err) { return next(err); }
}

export async function listBackups(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, (await mon.listBackups({ kind: typeof req.query.kind === 'string' ? req.query.kind as never : undefined })).map(bigintSafe)); }
  catch (err) { return next(err); }
}

// ── Snapshot ───────────────────────────────────────────────────────────

import { prisma } from '../config/database';

export async function phaseOSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const a = actor<{ userId: string; clubId: string; role?: string }>(req);
    const [sessionCount, mfaEnrolled, attendance, openPayments, pendingGdpr, retentionPolicies, backups] = await Promise.all([
      prisma.authSession.count({ where: { status: 'ACTIVE' } }),
      prisma.mFASetting.count({ where: { enabledAt: { not: null } } }),
      prisma.trainingAttendanceRecord.count({ where: { clubId: a.clubId } }),
      prisma.operationsPayment.count({ where: { clubId: a.clubId, state: { in: ['PENDING', 'OVERDUE'] } } }),
      prisma.gdprDataRequest.count({ where: { clubId: a.clubId, state: { in: ['PENDING', 'PROCESSING'] } } }),
      prisma.dataRetentionPolicy.count({ where: { isActive: true, OR: [{ clubId: a.clubId }, { clubId: null }] } }),
      prisma.backupRecord.count(),
    ]);
    return sendSuccess(res, { ts: new Date().toISOString(), auth: { activeSessions: sessionCount, mfaEnrolled }, ops: { trainingAttendance: attendance, openPayments }, gov: { pendingGdprRequests: pendingGdpr, retentionPolicies }, monitoring: { backupRecords: backups } });
  } catch (err) { return next(err); }
}
