// Familista — Franchise Expansion Engine
// File location: src/services/franchise-compliance.service.ts
//
// Violations + compliance checks (the operational half of the legal layer).
// Tracks contract breaches, brand/operational/training violations, and
// per-period compliance assessments.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  ComplianceCategory,
  ComplianceCheck,
  ComplianceStatus,
  FranchiseViolation,
  ViolationSeverity,
  ViolationStatus,
} from '@prisma/client';
import {
  BadRequestError,
  NotFoundError,
} from '../utils/errors';
import { writeFranchiseAudit } from './franchise-audit.service';
import type {
  ReportViolationInput,
  UpdateViolationInput,
  UpsertComplianceCheckInput,
} from '../utils/franchise.validators';
import type { FranchiseActor } from '../types/franchise.types';

// ─────────────────────────────────────────────────────────────────────────────
// Violations
// ─────────────────────────────────────────────────────────────────────────────

const VIOLATION_TRANSITIONS: Record<ViolationStatus, ReadonlyArray<ViolationStatus>> = {
  OPEN:          ['ACKNOWLEDGED', 'RESOLVED', 'ESCALATED', 'WAIVED'],
  ACKNOWLEDGED:  ['RESOLVED', 'ESCALATED', 'WAIVED'],
  ESCALATED:     ['RESOLVED', 'WAIVED'],
  RESOLVED:      [],
  WAIVED:        [],
};

function assertViolationTransition(from: ViolationStatus, to: ViolationStatus): void {
  if (from === to) return;
  if (!VIOLATION_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Violation status transition ${from} → ${to} not allowed`);
  }
}

export async function reportViolation(
  actor: FranchiseActor,
  unitId: string,
  input: ReportViolationInput,
): Promise<FranchiseViolation> {
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Unit not found');

  if (input.contractId) {
    const contract = await prisma.franchiseContract.findUnique({ where: { id: input.contractId } });
    if (!contract) throw new NotFoundError('Referenced contract not found');
    if (contract.unitId !== unitId) {
      throw new BadRequestError('Referenced contract belongs to a different unit');
    }
  }

  const created = await prisma.franchiseViolation.create({
    data: {
      unitId,
      contractId: input.contractId ?? null,
      clauseRef: input.clauseRef ?? null,
      severity: input.severity,
      category: input.category,
      title: input.title,
      description: input.description,
      status: 'OPEN',
      reportedBy: actor.userId,
      assignedTo: input.assignedTo ?? null,
      dueByAt: input.dueByAt ? new Date(input.dueByAt) : null,
      evidence:
        input.evidence === undefined || input.evidence === null
          ? undefined
          : (input.evidence as Prisma.InputJsonValue),
    },
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'VIOLATION_REPORTED',
    category: 'COMPLIANCE',
    resourceType: 'FranchiseViolation',
    resourceId: created.id,
    metadata: {
      severity: input.severity,
      category: input.category,
      title: input.title,
      contractId: input.contractId,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: input.severity === 'CRITICAL' ? 'FAILURE' : 'SUCCESS',
  });

  return created;
}

export async function updateViolation(
  actor: FranchiseActor,
  id: string,
  input: UpdateViolationInput,
): Promise<FranchiseViolation> {
  const existing = await prisma.franchiseViolation.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Violation not found');

  if (input.status && input.status !== existing.status) {
    assertViolationTransition(existing.status, input.status);
  }

  const willResolve = input.status === 'RESOLVED' && existing.status !== 'RESOLVED';
  const willWaive = input.status === 'WAIVED' && existing.status !== 'WAIVED';

  const updated = await prisma.franchiseViolation.update({
    where: { id },
    data: {
      severity: input.severity,
      status: input.status,
      assignedTo: input.assignedTo ?? undefined,
      dueByAt: input.dueByAt === undefined ? undefined : input.dueByAt ? new Date(input.dueByAt) : null,
      resolution: input.resolution ?? undefined,
      resolvedAt: willResolve || willWaive ? new Date() : undefined,
    },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: input.status === 'RESOLVED'
      ? 'VIOLATION_RESOLVED'
      : input.status === 'ESCALATED'
        ? 'VIOLATION_ESCALATED'
        : input.status === 'WAIVED'
          ? 'VIOLATION_WAIVED'
          : 'VIOLATION_UPDATED',
    category: 'COMPLIANCE',
    resourceType: 'FranchiseViolation',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listViolations(opts: {
  unitId?: string;
  status?: ViolationStatus;
  severity?: ViolationSeverity;
  scopeUnitIds?: Set<string>;
  limit?: number;
}) {
  return await prisma.franchiseViolation.findMany({
    where: {
      ...(opts.unitId ? { unitId: opts.unitId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.severity ? { severity: opts.severity } : {}),
      ...(opts.scopeUnitIds ? { unitId: { in: Array.from(opts.scopeUnitIds) } } : {}),
    },
    include: {
      unit: { select: { id: true, code: true, name: true } },
      contract: { select: { id: true, type: true, version: true } },
    },
    orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Compliance checks (periodic assessments)
// ─────────────────────────────────────────────────────────────────────────────

function deriveStatusFromScore(score: number | null | undefined): ComplianceStatus {
  if (score == null) return 'NOT_ASSESSED';
  if (score >= 85) return 'COMPLIANT';
  if (score >= 60) return 'AT_RISK';
  return 'NON_COMPLIANT';
}

export async function upsertComplianceCheck(
  actor: FranchiseActor,
  unitId: string,
  input: UpsertComplianceCheckInput,
): Promise<ComplianceCheck> {
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Unit not found');

  const periodStart = new Date(input.periodStartAt);
  const periodEnd = new Date(input.periodEndAt);
  if (periodEnd <= periodStart) {
    throw new BadRequestError('periodEndAt must be after periodStartAt');
  }

  const status = input.status ?? deriveStatusFromScore(input.score ?? null);
  const completing = status !== 'NOT_ASSESSED';

  const upserted = await prisma.complianceCheck.upsert({
    where: {
      unitId_category_period: {
        unitId,
        category: input.category,
        period: input.period,
      },
    },
    create: {
      unitId,
      category: input.category,
      period: input.period,
      periodStartAt: periodStart,
      periodEndAt: periodEnd,
      status,
      score: input.score ?? null,
      findings:
        input.findings === undefined || input.findings === null
          ? undefined
          : (input.findings as Prisma.InputJsonValue),
      remediation: input.remediation ?? null,
      dueByAt: input.dueByAt ? new Date(input.dueByAt) : null,
      completedAt: completing ? new Date() : null,
      completedBy: completing ? actor.userId : null,
    },
    update: {
      periodStartAt: periodStart,
      periodEndAt: periodEnd,
      status,
      score: input.score ?? null,
      findings:
        input.findings === undefined
          ? undefined
          : input.findings === null
            ? Prisma.JsonNull
            : (input.findings as Prisma.InputJsonValue),
      remediation: input.remediation ?? undefined,
      dueByAt: input.dueByAt === undefined ? undefined : input.dueByAt ? new Date(input.dueByAt) : null,
      completedAt: completing ? new Date() : null,
      completedBy: completing ? actor.userId : null,
    },
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'COMPLIANCE_CHECK_RECORDED',
    category: 'COMPLIANCE',
    resourceType: 'ComplianceCheck',
    resourceId: upserted.id,
    metadata: { category: input.category, period: input.period, status, score: input.score },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: status === 'NON_COMPLIANT' ? 'FAILURE' : 'SUCCESS',
  });

  return upserted;
}

export async function listComplianceChecks(opts: {
  unitId: string;
  category?: ComplianceCategory;
  period?: string;
}) {
  return await prisma.complianceCheck.findMany({
    where: {
      unitId: opts.unitId,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.period ? { period: opts.period } : {}),
    },
    orderBy: [{ period: 'desc' }, { category: 'asc' }],
  });
}

export async function getComplianceSummary(unitId: string) {
  const checks = await prisma.complianceCheck.findMany({
    where: { unitId },
    orderBy: [{ period: 'desc' }],
    take: 100,
  });
  const openViolations = await prisma.franchiseViolation.findMany({
    where: { unitId, status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] } },
    select: { id: true, severity: true, dueByAt: true },
  });

  const latestPeriod = checks[0]?.period ?? null;
  const latestForPeriod = checks.filter((c) => c.period === latestPeriod);
  const scoreValues = latestForPeriod.map((c) => c.score).filter((s): s is number => s != null);
  const avgScore = scoreValues.length > 0
    ? Math.round((scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length) * 10) / 10
    : null;

  const overallStatus: ComplianceStatus =
    avgScore == null
      ? 'NOT_ASSESSED'
      : avgScore >= 85
        ? 'COMPLIANT'
        : avgScore >= 60
          ? 'AT_RISK'
          : 'NON_COMPLIANT';

  return {
    unitId,
    latestPeriod,
    averageScore: avgScore,
    overallStatus,
    openViolations: openViolations.length,
    criticalViolations: openViolations.filter((v) => v.severity === 'CRITICAL').length,
    overdueViolations: openViolations.filter((v) => v.dueByAt && v.dueByAt < new Date()).length,
    checks: latestForPeriod,
  };
}
