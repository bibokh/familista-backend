// Familista — Franchise Expansion Engine
// File location: src/services/franchise-performance.service.ts
//
// Live performance metrics + period snapshots for the franchise dashboard.
// Reads aggregate from existing tables (Club, Player, User, RevenueDistribution,
// FranchiseViolation, FranchiseContract) — no extra persistence beyond the
// optional FranchisePerformanceSnapshot for time-series.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type { FranchisePerformanceSnapshot } from '@prisma/client';
import { NotFoundError } from '../utils/errors';
import { writeFranchiseAudit } from './franchise-audit.service';
import { getDescendantUnitIds } from './franchise-unit.service';
import { getComplianceSummary } from './franchise-compliance.service';
import type { GenerateSnapshotInput } from '../utils/franchise.validators';
import type { FranchiseActor, PerformanceMetrics } from '../types/franchise.types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live metrics — computes against current data over an arbitrary window
// ─────────────────────────────────────────────────────────────────────────────

export async function getLivePerformance(
  unitId: string,
  opts: { period: string; periodStartAt: Date; periodEndAt: Date; includeDescendants?: boolean },
): Promise<PerformanceMetrics> {
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Unit not found');

  const scopedUnitIds = opts.includeDescendants
    ? Array.from(await getDescendantUnitIds([unitId]))
    : [unitId];

  const periodMs = opts.periodEndAt.getTime() - opts.periodStartAt.getTime();
  const priorStart = new Date(opts.periodStartAt.getTime() - periodMs);
  const priorEnd = opts.periodStartAt;

  const [distributions, priorDistributions, clubs, playersTotal, usersTotal, violations, activeContracts, expiringContracts, complianceSummary] = await Promise.all([
    prisma.revenueDistribution.findMany({
      where: {
        unitId: { in: scopedUnitIds },
        status: { in: ['COMPUTED', 'EXECUTED'] },
        computedAt: { gte: opts.periodStartAt, lte: opts.periodEndAt },
      },
      select: { sourceAmount: true, category: true, sourceCurrency: true, computedAt: true },
    }),
    prisma.revenueDistribution.aggregate({
      where: {
        unitId: { in: scopedUnitIds },
        status: { in: ['COMPUTED', 'EXECUTED'] },
        computedAt: { gte: priorStart, lt: priorEnd },
      },
      _sum: { sourceAmount: true },
    }),
    prisma.club.findMany({
      where: ({ franchiseUnitId: { in: scopedUnitIds } } as unknown) as Prisma.ClubWhereInput,
      select: { id: true, createdAt: true, subscriptionStatus: true },
    }),
    prisma.player.count({
      where: { club: ({ franchiseUnitId: { in: scopedUnitIds } } as unknown) as Prisma.ClubWhereInput },
    }),
    prisma.user.count({
      where: { club: ({ franchiseUnitId: { in: scopedUnitIds } } as unknown) as Prisma.ClubWhereInput },
    }),
    prisma.franchiseViolation.findMany({
      where: { unitId: { in: scopedUnitIds }, status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] } },
      select: { severity: true },
    }),
    prisma.franchiseContract.count({
      where: { unitId: { in: scopedUnitIds }, status: 'ACTIVE' },
    }),
    prisma.franchiseContract.count({
      where: {
        unitId: { in: scopedUnitIds },
        status: 'ACTIVE',
        effectiveTo: {
          gte: new Date(),
          lte: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
      },
    }),
    getComplianceSummary(unitId).catch(() => null),
  ]);

  const revenueTotal = distributions.reduce((s, d) => s + d.sourceAmount, 0);
  const priorTotal = priorDistributions._sum.sourceAmount ?? 0;
  const growthPct = priorTotal > 0 ? round2(((revenueTotal - priorTotal) / priorTotal) * 100) : null;

  const bySource: Record<string, number> = {};
  for (const d of distributions) {
    bySource[d.category] = round2((bySource[d.category] ?? 0) + d.sourceAmount);
  }

  const clubsActive = clubs.filter((c) => c.subscriptionStatus === 'ACTIVE' || c.subscriptionStatus === 'TRIALING').length;
  const clubsAddedInPeriod = clubs.filter((c) => c.createdAt >= opts.periodStartAt && c.createdAt <= opts.periodEndAt).length;

  const criticalCount = violations.filter((v) => v.severity === 'CRITICAL').length;
  const licensingHealth = activeContracts === 0
    ? 0
    : Math.max(0, 100 - violations.length * 5 - criticalCount * 10 - expiringContracts * 2);

  return {
    unitId,
    unitCode: unit.code,
    unitName: unit.name,
    level: unit.level,
    status: unit.status,
    period: opts.period,
    periodStartAt: opts.periodStartAt,
    periodEndAt: opts.periodEndAt,

    revenue: {
      total: round2(revenueTotal),
      currency: unit.currency,
      growthPct,
      priorPeriodTotal: priorTotal > 0 ? round2(priorTotal) : null,
      bySource,
    },

    growth: {
      clubsActive,
      clubsTotal: clubs.length,
      clubsAddedInPeriod,
      playersTotal,
      usersTotal,
    },

    performance: {
      netMargin: null,
      expensesTotal: 0,
    },

    compliance: {
      score: complianceSummary?.averageScore ?? null,
      status: complianceSummary?.overallStatus ?? 'NOT_ASSESSED',
      openViolations: violations.length,
      criticalViolations: criticalCount,
    },

    licensing: {
      health: licensingHealth,
      contractsActive: activeContracts,
      contractsExpiringSoon: expiringContracts,
    },

    generatedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot persistence
// ─────────────────────────────────────────────────────────────────────────────

export async function generateSnapshot(
  actor: FranchiseActor,
  unitId: string,
  input: GenerateSnapshotInput,
): Promise<FranchisePerformanceSnapshot> {
  const metrics = await getLivePerformance(unitId, {
    period: input.period,
    periodStartAt: new Date(input.periodStartAt),
    periodEndAt: new Date(input.periodEndAt),
    includeDescendants: true,
  });

  const upserted = await prisma.franchisePerformanceSnapshot.upsert({
    where: { unitId_period: { unitId, period: input.period } },
    create: {
      unitId,
      period: input.period,
      periodStartAt: metrics.periodStartAt,
      periodEndAt: metrics.periodEndAt,
      revenueTotal: metrics.revenue.total,
      revenuePriorPeriod: metrics.revenue.priorPeriodTotal,
      revenueGrowthPct: metrics.revenue.growthPct,
      expensesTotal: metrics.performance.expensesTotal,
      netMargin: metrics.performance.netMargin,
      clubsActive: metrics.growth.clubsActive,
      clubsTotal: metrics.growth.clubsTotal,
      playersTotal: metrics.growth.playersTotal,
      usersTotal: metrics.growth.usersTotal,
      complianceScore: metrics.compliance.score,
      licensingHealth: metrics.licensing.health,
      violationsOpen: metrics.compliance.openViolations,
      contractsActive: metrics.licensing.contractsActive,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
      generatedBy: actor.userId,
    },
    update: {
      periodStartAt: metrics.periodStartAt,
      periodEndAt: metrics.periodEndAt,
      revenueTotal: metrics.revenue.total,
      revenuePriorPeriod: metrics.revenue.priorPeriodTotal,
      revenueGrowthPct: metrics.revenue.growthPct,
      expensesTotal: metrics.performance.expensesTotal,
      netMargin: metrics.performance.netMargin,
      clubsActive: metrics.growth.clubsActive,
      clubsTotal: metrics.growth.clubsTotal,
      playersTotal: metrics.growth.playersTotal,
      usersTotal: metrics.growth.usersTotal,
      complianceScore: metrics.compliance.score,
      licensingHealth: metrics.licensing.health,
      violationsOpen: metrics.compliance.openViolations,
      contractsActive: metrics.licensing.contractsActive,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
      generatedAt: new Date(),
      generatedBy: actor.userId,
    },
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'PERFORMANCE_SNAPSHOT_GENERATED',
    category: 'PERFORMANCE',
    resourceType: 'FranchisePerformanceSnapshot',
    resourceId: upserted.id,
    metadata: {
      period: upserted.period,
      revenueTotal: upserted.revenueTotal,
      clubsActive: upserted.clubsActive,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return upserted;
}

export async function listSnapshots(unitId: string, limit = 24): Promise<FranchisePerformanceSnapshot[]> {
  return await prisma.franchisePerformanceSnapshot.findMany({
    where: { unitId },
    orderBy: { periodStartAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 120),
  });
}

export async function getNetworkHealth(): Promise<{
  unitsTotal: number;
  unitsActive: number;
  unitsSuspended: number;
  unitsByLevel: Record<string, number>;
  contractsExpiringSoon: number;
  criticalViolations: number;
}> {
  const [unitsTotal, byStatus, byLevel, expiringContracts, criticalViolations] = await Promise.all([
    prisma.franchiseUnit.count(),
    prisma.franchiseUnit.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.franchiseUnit.groupBy({ by: ['level'], _count: { _all: true } }),
    prisma.franchiseContract.count({
      where: {
        status: 'ACTIVE',
        effectiveTo: { gte: new Date(), lte: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.franchiseViolation.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] }, severity: 'CRITICAL' },
    }),
  ]);

  const unitsActive = byStatus.find((s) => s.status === 'ACTIVE')?._count._all ?? 0;
  const unitsSuspended = byStatus.find((s) => s.status === 'SUSPENDED')?._count._all ?? 0;
  const unitsByLevel = Object.fromEntries(byLevel.map((l) => [l.level, l._count._all]));

  return {
    unitsTotal,
    unitsActive,
    unitsSuspended,
    unitsByLevel,
    contractsExpiringSoon: expiringContracts,
    criticalViolations,
  };
}
