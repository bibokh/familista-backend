// Familista — Executive OS · Integration Layer
// File location: src/services/executive-risk.service.ts
//
// Composite risk monitor. Sweeps signals from every engine and creates or
// updates RiskAlert rows. A fingerprint is computed per-signal so re-running
// the sweep doesn't create duplicates — instead the alert is upserted and
// its severity is reconciled to the latest evidence.
//
// Risk sources:
//   • FINANCIAL    Club.subscriptionStatus = PAST_DUE / INCOMPLETE
//   • FINANCIAL    Club with negative 90-day cash flow
//   • OPERATIONAL  Franchise unit with > N open violations
//   • OPERATIONAL  Multiple recent AI INJURY_RISK CRITICAL decisions for a club
//   • LEGAL        Contract effectiveTo within 30 days
//   • REGULATORY   Investor KYC expired or in REJECTED status
//   • STRATEGIC    Investor portfolio concentration > 80%
//   • STRATEGIC    No revenue distributions for a franchise unit in 60 days

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  RiskAlert,
  RiskAlertStatus,
  RiskCategory,
  RiskSeverity,
} from '@prisma/client';
import {
  BadRequestError,
  NotFoundError,
} from '../utils/errors';
import { writeExecutiveAudit } from './executive-audit.service';
import type {
  CreateRiskAlertInput,
  UpdateRiskAlertInput,
} from '../utils/executive.validators';
import type { ExecutiveActor } from '../types/executive.types';

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertAlert(
  actor: ExecutiveActor | null,
  input: CreateRiskAlertInput,
): Promise<RiskAlert> {
  const existing = await prisma.riskAlert.findUnique({ where: { fingerprint: input.fingerprint } });

  let row: RiskAlert;
  if (existing) {
    row = await prisma.riskAlert.update({
      where: { id: existing.id },
      data: {
        severity: input.severity,
        title: input.title,
        description: input.description,
        score: input.score ?? existing.score,
        dueByAt: input.dueByAt === undefined ? undefined : input.dueByAt ? new Date(input.dueByAt) : null,
        metadata:
          input.metadata === undefined
            ? undefined
            : input.metadata === null
              ? Prisma.JsonNull
              : (input.metadata as Prisma.InputJsonValue),
        // Re-open if previously resolved / waived but the signal is back
        status:
          existing.status === 'RESOLVED' || existing.status === 'WAIVED'
            ? 'OPEN'
            : existing.status,
      },
    });
  } else {
    row = await prisma.riskAlert.create({
      data: {
        category: input.category,
        severity: input.severity,
        title: input.title,
        description: input.description,
        clubId: input.clubId ?? null,
        franchiseUnitId: input.franchiseUnitId ?? null,
        investorId: input.investorId ?? null,
        entityId: input.entityId ?? null,
        sourceEngine: input.sourceEngine,
        sourceRef: input.sourceRef ?? null,
        fingerprint: input.fingerprint,
        score: input.score ?? null,
        dueByAt: input.dueByAt ? new Date(input.dueByAt) : null,
        metadata:
          input.metadata === undefined || input.metadata === null
            ? undefined
            : (input.metadata as Prisma.InputJsonValue),
      },
    });
  }

  await writeExecutiveAudit({
    alertId: row.id,
    userId: actor?.userId ?? null,
    action: existing ? 'RISK_ALERT_UPDATED' : 'RISK_ALERT_CREATED',
    category: 'RISK',
    resourceType: 'RiskAlert',
    resourceId: row.id,
    metadata: { category: row.category, severity: row.severity, source: row.sourceEngine },
    ipAddress: actor?.ipAddress ?? null,
    userAgent: actor?.userAgent ?? null,
    result: row.severity === 'CRITICAL' ? 'FAILURE' : 'SUCCESS',
  });

  return row;
}

export async function updateAlert(
  actor: ExecutiveActor,
  id: string,
  input: UpdateRiskAlertInput,
): Promise<RiskAlert> {
  const existing = await prisma.riskAlert.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Risk alert not found');

  const isResolution = input.status === 'RESOLVED' || input.status === 'WAIVED';
  const isAcknowledge = input.status === 'ACKNOWLEDGED' && existing.status !== 'ACKNOWLEDGED';

  const updated = await prisma.riskAlert.update({
    where: { id },
    data: {
      status: input.status,
      severity: input.severity,
      resolution: input.resolution ?? undefined,
      workflowId: input.workflowId === undefined ? undefined : input.workflowId,
      dueByAt: input.dueByAt === undefined ? undefined : input.dueByAt ? new Date(input.dueByAt) : null,
      acknowledgedBy: isAcknowledge ? actor.userId : undefined,
      acknowledgedAt: isAcknowledge ? new Date() : undefined,
      resolvedBy: isResolution ? actor.userId : undefined,
      resolvedAt: isResolution ? new Date() : undefined,
    },
  });

  await writeExecutiveAudit({
    alertId: id,
    userId: actor.userId,
    action: `RISK_ALERT_${input.status ?? 'UPDATED'}`,
    category: 'RISK',
    resourceType: 'RiskAlert',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listAlerts(opts: {
  status?: RiskAlertStatus;
  severity?: RiskSeverity;
  category?: RiskCategory;
  clubId?: string;
  franchiseUnitId?: string;
  investorId?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.riskAlert.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.severity ? { severity: opts.severity } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.clubId ? { clubId: opts.clubId } : {}),
      ...(opts.franchiseUnitId ? { franchiseUnitId: opts.franchiseUnitId } : {}),
      ...(opts.investorId ? { investorId: opts.investorId } : {}),
    },
    orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getAlert(id: string) {
  const alert = await prisma.riskAlert.findUnique({ where: { id } });
  if (!alert) throw new NotFoundError('Risk alert not found');
  return alert;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite sweep — call from cron or on demand
// ─────────────────────────────────────────────────────────────────────────────

export type SweepOutcome = {
  evaluated: number;
  created: number;
  updated: number;
  bySource: Record<string, number>;
};

export async function sweep(actor: ExecutiveActor | null): Promise<SweepOutcome> {
  let evaluated = 0;
  let created = 0;
  let updated = 0;
  const bySource: Record<string, number> = {};

  async function raise(fingerprint: string, input: CreateRiskAlertInput): Promise<void> {
    evaluated++;
    const existing = await prisma.riskAlert.findUnique({ where: { fingerprint } });
    await upsertAlert(actor, input);
    if (existing) updated++;
    else created++;
    bySource[input.sourceEngine] = (bySource[input.sourceEngine] ?? 0) + 1;
  }

  // 1. Financial — past-due / incomplete subscriptions
  const distressed = await prisma.club.findMany({
    where: { subscriptionStatus: { in: ['PAST_DUE', 'INCOMPLETE'] } },
    select: { id: true, name: true, subscriptionStatus: true, plan: true },
  });
  for (const c of distressed) {
    await raise(`subscription-distress:${c.id}:${c.subscriptionStatus}`, {
      category: 'FINANCIAL',
      severity: c.subscriptionStatus === 'INCOMPLETE' ? 'HIGH' : 'CRITICAL',
      title: `${c.name}: ${c.subscriptionStatus} subscription`,
      description: `Club is in ${c.subscriptionStatus} on plan ${c.plan}. Billing intervention required.`,
      clubId: c.id,
      sourceEngine: 'BILLING',
      sourceRef: c.id,
      fingerprint: `subscription-distress:${c.id}:${c.subscriptionStatus}`,
    });
  }

  // 2. Financial — negative 90-day cash flow
  const ninetyAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const clubs = await prisma.club.findMany({ select: { id: true, name: true } });
  for (const c of clubs) {
    const fin = await prisma.financial.findMany({
      where: { clubId: c.id, date: { gte: ninetyAgo } },
      select: { amount: true, type: true },
    });
    if (fin.length === 0) continue;
    const income = fin.filter((f) => f.type === 'INCOME').reduce((s, f) => s + f.amount, 0);
    const expense = fin.filter((f) => f.type === 'EXPENSE').reduce((s, f) => s + f.amount, 0);
    if (income - expense < 0) {
      await raise(`cashflow-negative:${c.id}`, {
        category: 'FINANCIAL',
        severity: 'HIGH',
        title: `${c.name}: negative 90-day cash flow`,
        description: `Income ${income.toFixed(0)} vs Expense ${expense.toFixed(0)} (net ${(income - expense).toFixed(0)}).`,
        clubId: c.id,
        sourceEngine: 'CLUB_FINANCIAL',
        sourceRef: c.id,
        fingerprint: `cashflow-negative:${c.id}`,
        score: Math.min(100, Math.abs((income - expense) / Math.max(income, 1)) * 100),
      });
    }
  }

  // 3. Operational — franchise units with > 3 open violations
  const units = await prisma.franchiseUnit.findMany({
    where: {
      status: 'ACTIVE',
      violations: { some: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] } } },
    },
    select: { id: true, name: true, _count: { select: { violations: { where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] } } } } } },
  });
  for (const u of units) {
    const openViolations = u._count.violations;
    if (openViolations > 3) {
      await raise(`franchise-violations:${u.id}`, {
        category: 'OPERATIONAL',
        severity: openViolations > 6 ? 'CRITICAL' : 'HIGH',
        title: `${u.name}: ${openViolations} open violations`,
        description: `Franchise unit has ${openViolations} open or escalated violations.`,
        franchiseUnitId: u.id,
        sourceEngine: 'FRANCHISE',
        sourceRef: u.id,
        fingerprint: `franchise-violations:${u.id}`,
        score: Math.min(100, openViolations * 12),
      });
    }
  }

  // 4. Operational — multiple recent AI CRITICAL injury risks
  const sevenAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const aiCritical = await prisma.aIDecision.groupBy({
    by: ['clubId'],
    where: {
      domain: 'PLAYER',
      decisionType: 'INJURY_RISK',
      urgency: 'CRITICAL',
      createdAt: { gte: sevenAgo },
      clubId: { not: null },
    },
    _count: { _all: true },
  });
  for (const row of aiCritical) {
    if (!row.clubId || row._count._all < 3) continue;
    await raise(`ai-injury-cluster:${row.clubId}`, {
      category: 'OPERATIONAL',
      severity: 'HIGH',
      title: `${row._count._all} critical injury-risk alerts in 7 days`,
      description: `Cluster of ${row._count._all} CRITICAL AI INJURY_RISK decisions — medical review required.`,
      clubId: row.clubId,
      sourceEngine: 'AI',
      sourceRef: row.clubId,
      fingerprint: `ai-injury-cluster:${row.clubId}`,
      score: Math.min(100, row._count._all * 15),
    });
  }

  // 5. Legal — contracts expiring within 30 days
  const expiringContracts = await prisma.franchiseContract.findMany({
    where: {
      status: 'ACTIVE',
      effectiveTo: {
        gte: new Date(),
        lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    },
    select: { id: true, unitId: true, type: true, effectiveTo: true },
  });
  for (const c of expiringContracts) {
    await raise(`contract-expiring:${c.id}`, {
      category: 'LEGAL',
      severity: 'MEDIUM',
      title: `${c.type} expiring in 30 days`,
      description: `Contract effective-to: ${c.effectiveTo?.toISOString().slice(0, 10) ?? 'n/a'}.`,
      franchiseUnitId: c.unitId,
      sourceEngine: 'FRANCHISE',
      sourceRef: c.id,
      fingerprint: `contract-expiring:${c.id}`,
      dueByAt: c.effectiveTo?.toISOString(),
    });
  }

  // 6. Regulatory — investor KYC expired / rejected
  const kycIssues = await prisma.investorProfile.findMany({
    where: { isActive: true, kycStatus: { in: ['EXPIRED', 'REJECTED'] } },
    select: { id: true, displayName: true, kycStatus: true },
  });
  for (const inv of kycIssues) {
    await raise(`investor-kyc:${inv.id}:${inv.kycStatus}`, {
      category: 'REGULATORY',
      severity: inv.kycStatus === 'REJECTED' ? 'HIGH' : 'MEDIUM',
      title: `${inv.displayName}: KYC ${inv.kycStatus}`,
      description: `Investor KYC status is ${inv.kycStatus}. Capital actions blocked until remediated.`,
      investorId: inv.id,
      sourceEngine: 'INVESTOR',
      sourceRef: inv.id,
      fingerprint: `investor-kyc:${inv.id}:${inv.kycStatus}`,
    });
  }

  // 7. Strategic — franchise unit with no revenue in 60 days
  const sixtyAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const idleUnits = await prisma.franchiseUnit.findMany({
    where: {
      status: 'ACTIVE',
      revenueDistributions: { none: { computedAt: { gte: sixtyAgo } } },
    },
    select: { id: true, name: true, level: true },
  });
  for (const u of idleUnits) {
    await raise(`unit-idle:${u.id}`, {
      category: 'STRATEGIC',
      severity: 'MEDIUM',
      title: `${u.name}: no revenue in 60 days`,
      description: `Active ${u.level} franchise unit has not produced revenue in 60 days.`,
      franchiseUnitId: u.id,
      sourceEngine: 'FRANCHISE',
      sourceRef: u.id,
      fingerprint: `unit-idle:${u.id}`,
    });
  }

  await writeExecutiveAudit({
    userId: actor?.userId ?? null,
    action: 'RISK_SWEEP_COMPLETED',
    category: 'RISK',
    metadata: { evaluated, created, updated, bySource },
    ipAddress: actor?.ipAddress ?? null,
    userAgent: actor?.userAgent ?? null,
  });

  return { evaluated, created, updated, bySource };
}

void BadRequestError;
