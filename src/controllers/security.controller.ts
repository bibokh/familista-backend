// Familista — Security controller (Phase I)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as chain    from '../security/audit-chain.service';
import * as events   from '../security/security-event.service';
import * as approval from '../security/ai-approval.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import { rateLimitStats } from '../middleware/rate-limit.middleware';
import { nonceCacheStats } from '../security/device-nonce.service';
import type { AIApprovalStatus, SecurityEventKind, SecuritySeverity } from '@prisma/client';

const KINDS: SecurityEventKind[] = ['LOGIN_SUCCESS','LOGIN_FAILED','LOGIN_LOCKED','TENANT_MISMATCH','RATE_LIMITED','SUSPICIOUS_PAYLOAD','DEVICE_REJECTED','DEVICE_REPLAY','DEVICE_TS_SKEW','PROMPT_INJECTION_SUSPECT','UNAUTHORIZED_AI_ATTEMPT','AUDIT_CHAIN_VERIFIED','AUDIT_CHAIN_BROKEN','APPROVAL_REQUESTED','APPROVAL_GRANTED','APPROVAL_REJECTED','APPROVAL_EXPIRED','CUSTOM'];
const SEV:   SecuritySeverity[]  = ['INFO','WARN','CRITICAL'];
const APPROVAL_STATUS: AIApprovalStatus[] = ['PENDING','APPROVED','REJECTED','EXPIRED','EXECUTED'];

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '));
}

function ipOf(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  return typeof xff === 'string' ? xff.split(',')[0].trim() : (req.ip ?? null);
}

// ─────────────────────────────────────────────────────────────────────────
// Audit chain
// ─────────────────────────────────────────────────────────────────────────

const verifySchema = z.object({
  query: z.object({
    fromPosition: z.coerce.number().int().min(0).optional(),
    limit:        z.coerce.number().int().min(1).max(10_000).optional(),
  }),
});

export async function verifyChain(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = verifySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const result = await chain.verifyAuditChain(req.user!.clubId, parsed.data.query);
    // Log the verification itself in the chain — but only when result.ok.
    if (result.ok) {
      events.logSecurityEvent({
        kind: 'AUDIT_CHAIN_VERIFIED', severity: 'INFO',
        clubId: req.user!.clubId, actorId: req.user!.id, ipAddress: ipOf(req),
        payload: { totalChecked: result.totalChecked, headHash: result.headHash },
      });
    } else {
      events.logSecurityEvent({
        kind: 'AUDIT_CHAIN_BROKEN', severity: 'CRITICAL',
        clubId: req.user!.clubId, actorId: req.user!.id, ipAddress: ipOf(req),
        payload: { brokenAt: result.brokenAt },
      });
    }
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

// Full-chain verifier (bounded memory). Safe on chains with millions of rows.
const verifyFullSchema = z.object({
  query: z.object({
    batchSize:  z.coerce.number().int().min(100).max(10_000).optional(),
    maxBatches: z.coerce.number().int().min(1).max(100_000).optional(),
  }),
});

export async function verifyChainComplete(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = verifyFullSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const result = await chain.verifyAuditChainComplete(req.user!.clubId, parsed.data.query);
    events.logSecurityEvent({
      kind:     result.ok ? 'AUDIT_CHAIN_VERIFIED' : 'AUDIT_CHAIN_BROKEN',
      severity: result.ok ? 'INFO' : 'CRITICAL',
      clubId:   req.user!.clubId, actorId: req.user!.id, ipAddress: ipOf(req),
      payload:  { totalChecked: result.totalChecked, headHash: result.headHash, brokenAt: result.brokenAt ?? null, full: true },
    });
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

const listAuditSchema = z.object({
  query: z.object({
    fromPosition: z.coerce.number().int().min(0).optional(),
    limit:        z.coerce.number().int().min(1).max(1000).optional(),
  }),
});

export async function listAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listAuditSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await chain.listAuditEvents(req.user!.clubId, parsed.data.query);
    // BigInt → string for JSON-safe output.
    return sendSuccess(res, {
      items: out.items.map((r) => ({ ...r, chainPosition: r.chainPosition.toString() })),
      nextPosition: out.nextPosition,
    });
  } catch (err) { return next(err); }
}

export async function getAuditHead(req: Request, res: Response, next: NextFunction) {
  try {
    const h = await chain.getChainHead(req.user!.clubId);
    return sendSuccess(res, h);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Security events
// ─────────────────────────────────────────────────────────────────────────

const eventsSchema = z.object({
  query: z.object({
    kind:     z.enum(KINDS as [SecurityEventKind, ...SecurityEventKind[]]).optional(),
    severity: z.enum(SEV   as [SecuritySeverity,  ...SecuritySeverity[]]).optional(),
    actorId:  z.string().uuid().optional(),
    fromTs:   z.string().datetime().optional(),
    toTs:     z.string().datetime().optional(),
    page:     z.coerce.number().int().min(1).max(10_000).optional(),
    limit:    z.coerce.number().int().min(1).max(500).optional(),
  }),
});

export async function listEventsCtrl(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = eventsSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const out = await events.listSecurityEvents({
      clubId:   req.user!.clubId,
      kind:     q.kind,
      severity: q.severity,
      actorId:  q.actorId,
      fromTs:   q.fromTs ? new Date(q.fromTs) : null,
      toTs:     q.toTs   ? new Date(q.toTs)   : null,
      page:     q.page,
      limit:    q.limit,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// AI Approvals
// ─────────────────────────────────────────────────────────────────────────

const listApprovalsSchema = z.object({
  query: z.object({
    status: z.enum(APPROVAL_STATUS as [AIApprovalStatus, ...AIApprovalStatus[]]).optional(),
    page:   z.coerce.number().int().min(1).max(10_000).optional(),
    limit:  z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function listApprovals(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listApprovalsSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await approval.listApprovals(req.user!.clubId, parsed.data.query);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const approveSchema = z.object({ body: z.object({ id: z.string().uuid() }) });

export async function approveOne(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.approvalId;
    const out = await approval.approve({
      userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role,
      ipAddress: ipOf(req), userAgent: req.headers['user-agent'] as string | undefined,
    }, id);
    return sendSuccess(res, out, 'Approved');
  } catch (err) { return next(err); }
}

export async function rejectOne(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.approvalId;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const out = await approval.reject({
      userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role,
      ipAddress: ipOf(req), userAgent: req.headers['user-agent'] as string | undefined,
    }, id, reason);
    return sendSuccess(res, out, 'Rejected');
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Health / stats
// ─────────────────────────────────────────────────────────────────────────

export async function securityHealth(_req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, {
      rate:  rateLimitStats(),
      nonce: nonceCacheStats(),
      ts:    Date.now(),
    });
  } catch (err) { return next(err); }
}
