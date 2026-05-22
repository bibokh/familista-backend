// Familista — AI Approval Gate (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// High-risk AI actions (delete data, change tactics live, mass message,
// approve transfer, medical recommendation, payment) must be human-approved
// before the worker executes them.
//
// Flow:
//   1. Caller enqueues AIAgentJob with `input.requiresApproval = true` and
//      `input.approvalKind = "DELETE_DATA" | …` (or sets it via this svc).
//   2. We create an AIApprovalRequest row (status=PENDING, expiresAt=now+24h).
//   3. The worker, on picking up that job, calls `getJobApproval(jobId)` —
//      if status != APPROVED, the job is left in PENDING and re-tried later.
//   4. A DIFFERENT user (not the requester) calls approve(). The worker
//      then sees status=APPROVED on its next tick and runs the job.
//
// Auditability: every state transition appends a SecurityAuditEvent
// AND logs a SecurityEvent. The chain hash records the approver identity.

import { AIAgent, AIApprovalKind, AIApprovalRequest, AIApprovalStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from './audit-chain.service';
import { logSecurityEvent } from './security-event.service';

const TTL_MS = 24 * 60 * 60_000;

export interface ApprovalActor {
  userId:    string;
  clubId:    string;
  role?:     string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreateApprovalDto {
  agent:   AIAgent;
  kind:    AIApprovalKind;
  payload: Prisma.InputJsonValue;
  jobId?:  string | null;
  /** Custom TTL in ms (default 24h). */
  ttlMs?:  number;
}

export async function requestApproval(actor: ApprovalActor, dto: CreateApprovalDto): Promise<AIApprovalRequest> {
  const row = await prisma.aIApprovalRequest.create({
    data: {
      clubId:      actor.clubId,
      requesterId: actor.userId,
      agent:       dto.agent,
      kind:        dto.kind,
      jobId:       dto.jobId ?? null,
      payload:     dto.payload,
      status:      'PENDING',
      expiresAt:   new Date(Date.now() + (dto.ttlMs ?? TTL_MS)),
    },
  });
  appendAuditEventAsync({
    actor:      { userId: actor.userId, clubId: actor.clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    action:     'AI_APPROVAL_REQUESTED',
    entityType: 'AIApprovalRequest',
    entityId:   row.id,
    payload:    { agent: row.agent, kind: row.kind, jobId: row.jobId },
  });
  logSecurityEvent({
    kind:       'APPROVAL_REQUESTED',
    severity:   'INFO',
    clubId:     actor.clubId,
    actorId:    actor.userId,
    ipAddress:  actor.ipAddress,
    userAgent:  actor.userAgent,
    payload:    { id: row.id, agent: row.agent, kind: row.kind },
  });
  return row;
}

export async function approve(actor: ApprovalActor, id: string): Promise<AIApprovalRequest> {
  const r = await prisma.aIApprovalRequest.findUnique({ where: { id } });
  if (!r)                                                        throw new NotFoundError('AIApprovalRequest');
  if (r.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (r.requesterId === actor.userId && actor.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('Approver must be different from requester (segregation of duties)');
  }
  if (r.status !== 'PENDING') throw new BadRequestError(`Approval is ${r.status}`);
  if (r.expiresAt < new Date()) {
    await prisma.aIApprovalRequest.update({ where: { id }, data: { status: 'EXPIRED' } });
    throw new BadRequestError('Approval expired');
  }
  const updated = await prisma.aIApprovalRequest.update({
    where: { id },
    data:  { status: 'APPROVED', approvedBy: actor.userId, approvedAt: new Date() },
  });
  appendAuditEventAsync({
    actor:      { userId: actor.userId, clubId: actor.clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    action:     'AI_APPROVAL_GRANTED',
    entityType: 'AIApprovalRequest',
    entityId:   updated.id,
    payload:    { agent: updated.agent, kind: updated.kind, requesterId: updated.requesterId },
  });
  logSecurityEvent({
    kind:      'APPROVAL_GRANTED',
    severity:  'INFO',
    clubId:    actor.clubId,
    actorId:   actor.userId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    payload:   { id: updated.id, kind: updated.kind, requesterId: updated.requesterId },
  });
  return updated;
}

export async function reject(actor: ApprovalActor, id: string, reason?: string): Promise<AIApprovalRequest> {
  const r = await prisma.aIApprovalRequest.findUnique({ where: { id } });
  if (!r)                                                        throw new NotFoundError('AIApprovalRequest');
  if (r.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (r.status !== 'PENDING') throw new BadRequestError(`Approval is ${r.status}`);
  const updated = await prisma.aIApprovalRequest.update({
    where: { id },
    data:  { status: 'REJECTED', approvedBy: actor.userId, approvedAt: new Date(), rejectedReason: reason ?? null },
  });
  appendAuditEventAsync({
    actor:      { userId: actor.userId, clubId: actor.clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    action:     'AI_APPROVAL_REJECTED',
    entityType: 'AIApprovalRequest',
    entityId:   updated.id,
    payload:    { kind: updated.kind, reason: reason ?? null },
  });
  logSecurityEvent({
    kind:      'APPROVAL_REJECTED',
    severity:  'WARN',
    clubId:    actor.clubId,
    actorId:   actor.userId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    payload:   { id: updated.id, reason: reason ?? null },
  });
  return updated;
}

export async function getStatus(id: string): Promise<AIApprovalStatus | null> {
  const r = await prisma.aIApprovalRequest.findUnique({ where: { id }, select: { status: true } });
  return r?.status ?? null;
}

export async function getJobApproval(jobId: string): Promise<AIApprovalRequest | null> {
  return prisma.aIApprovalRequest.findFirst({
    where:   { jobId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listApprovals(clubId: string, opts: { status?: AIApprovalStatus; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.AIApprovalRequestWhereInput = {
    clubId,
    ...(opts.status ? { status: opts.status } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.aIApprovalRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
    }),
    prisma.aIApprovalRequest.count({ where }),
  ]);
  return { items, total, page, limit };
}

/** Sweep expired approvals — call from a scheduled tick if desired. */
export async function sweepExpired(): Promise<{ swept: number }> {
  const res = await prisma.aIApprovalRequest.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    data:  { status: 'EXPIRED' },
  });
  return { swept: res.count };
}

/** Match an AI job kind / payload against the HIGH-RISK whitelist. */
export function classifyRisk(jobKind: string, input: unknown): AIApprovalKind | null {
  const lk = String(jobKind || '').toUpperCase();
  if (lk.startsWith('DELETE') || lk === 'DATA_PURGE')                 return 'DELETE_DATA';
  if (lk.startsWith('CHANGE_TACTICS') || lk === 'TACTICS_LIVE')       return 'CHANGE_TACTICS_LIVE';
  if (lk.startsWith('MASS_MESSAGE') || lk === 'COMMS_BROADCAST')      return 'MASS_MESSAGE';
  if (lk.startsWith('APPROVE_TRANSFER') || lk === 'TRANSFER_FINALISE') return 'APPROVE_TRANSFER';
  if (lk.startsWith('MEDICAL') && lk.includes('RECOMMENDATION'))      return 'MEDICAL_RECOMMENDATION';
  if (lk.startsWith('PAYMENT') || lk.startsWith('PAYOUT'))            return 'PAYMENT_ACTION';
  // Inspect input.payload for explicit flag.
  if (input && typeof input === 'object' && (input as { requiresApproval?: boolean }).requiresApproval) {
    const k = (input as { approvalKind?: string }).approvalKind;
    if (k && ['DELETE_DATA','CHANGE_TACTICS_LIVE','MASS_MESSAGE','APPROVE_TRANSFER','MEDICAL_RECOMMENDATION','PAYMENT_ACTION','OTHER'].includes(k)) {
      return k as AIApprovalKind;
    }
    return 'OTHER';
  }
  return null;
}
