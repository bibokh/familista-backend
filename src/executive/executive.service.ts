// Familista — AI Executive Agents + Decisions (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// 7 executive roles. Each ExecutiveDecision is hashed into Phase I audit
// chain. High-impact decisions parallel the Phase L coaching approval
// pattern but are kept on a distinct table so executive vs. coaching
// histories stay separable.

import { createHash } from 'crypto';
import { AIDecisionImpact, ExecAgentRole, ExecutiveAgent, ExecutiveDecision, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { requestApproval } from '../security/ai-approval.service';

export interface ExecActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const HIGH_IMPACT_KINDS = new Set([
  'TRANSFER_APPROVAL', 'CONTRACT_EXTENSION', 'CONTRACT_TERMINATION',
  'MASS_RELEASE', 'BUDGET_REALLOCATION', 'SPONSORSHIP_AGREEMENT',
  'ACADEMY_RESTRUCTURE', 'COACH_DISMISSAL',
]);

// ── Agent lifecycle ─────────────────────────────────────────────────────

export interface RegisterExecutiveDto {
  role:   ExecAgentRole;
  label:  string;
  config?: Prisma.InputJsonValue;
}

export async function registerExecutive(actor: ExecActor, dto: RegisterExecutiveDto): Promise<ExecutiveAgent> {
  if (!dto.role || !dto.label) throw new BadRequestError('role + label required');
  return prisma.executiveAgent.create({
    data: {
      clubId: actor.clubId,
      role:   dto.role,
      label:  dto.label,
      config: (dto.config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listExecutives(actor: ExecActor): Promise<ExecutiveAgent[]> {
  return prisma.executiveAgent.findMany({ where: { clubId: actor.clubId, isActive: true }, orderBy: { role: 'asc' } });
}

export async function deactivateExecutive(actor: ExecActor, id: string): Promise<ExecutiveAgent> {
  const a = await prisma.executiveAgent.findUnique({ where: { id } });
  if (!a)                                                       throw new NotFoundError('ExecutiveAgent');
  if (a.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.executiveAgent.update({ where: { id }, data: { isActive: false } });
}

// ── Decisions ──────────────────────────────────────────────────────────

export interface IssueDecisionDto {
  agentId?:        string | null;
  kind:            string;
  rationale:       string;
  payload:         Prisma.InputJsonValue;
  confidence?:     number;
  tacticalImpact?: AIDecisionImpact;
}

export async function issueDecision(actor: ExecActor, dto: IssueDecisionDto): Promise<ExecutiveDecision> {
  if (!dto.kind || !dto.rationale) throw new BadRequestError('kind + rationale required');
  const isHighImpact = HIGH_IMPACT_KINDS.has(dto.kind.toUpperCase());

  let approvalRequestId: string | null = null;
  if (isHighImpact) {
    const approval = await requestApproval(
      { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
      { agent: 'CLUB_MANAGER', kind: 'OTHER', payload: { execKind: dto.kind, payload: dto.payload } as Prisma.InputJsonValue, jobId: null, ttlMs: 48 * 60 * 60_000 },
    );
    approvalRequestId = approval.id;
  }

  const hash = createHash('sha256').update(JSON.stringify(dto.payload ?? null)).digest('hex');
  const row = await prisma.executiveDecision.create({
    data: {
      clubId:           actor.clubId,
      agentId:          dto.agentId ?? null,
      kind:             dto.kind,
      rationale:        dto.rationale,
      payload:          dto.payload,
      confidence:       Math.max(0, Math.min(1, dto.confidence ?? 0.5)),
      tacticalImpact:   dto.tacticalImpact ?? (isHighImpact ? 'HIGH' : 'LOW'),
      approvalRequestId,
      payloadHash:      hash,
      modelVersion:     'm1',
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `EXEC_DECISION:${dto.kind}`,
    entityType: 'ExecutiveDecision', entityId: row.id,
    payload: { kind: dto.kind, confidence: row.confidence, payloadHash: hash, approvalRequestId },
  });
  return row;
}

export async function listDecisions(actor: ExecActor, opts: { kind?: string; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.ExecutiveDecisionWhereInput = {
    clubId: actor.clubId,
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.executiveDecision.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 500) }),
    prisma.executiveDecision.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function ackDecision(actor: ExecActor, id: string): Promise<ExecutiveDecision> {
  const d = await prisma.executiveDecision.findUnique({ where: { id } });
  if (!d)                                                       throw new NotFoundError('ExecutiveDecision');
  if (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.executiveDecision.update({ where: { id }, data: { status: 'ACK', ackedAt: new Date(), ackedBy: actor.userId } });
}
