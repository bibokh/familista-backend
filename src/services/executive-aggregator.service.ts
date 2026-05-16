// Familista — Executive OS · Integration Layer
// File location: src/services/executive-aggregator.service.ts
//
// Cross-engine read aggregator. The executive dashboard composes its single
// view from every operational engine — this service is the single read path
// and never duplicates data. It composes existing services + lean Prisma
// queries; every figure is traceable back to the originating engine.

import { prisma } from '../lib/prisma';
import { listExpansionOpportunities } from './franchise-territory.service';
import { getNetworkHealth } from './franchise-performance.service';
import type { ExpansionOpportunity } from '../types/franchise.types';

type WindowOpts = { fromAt?: Date; toAt?: Date };

function defaultWindow(opts?: WindowOpts) {
  const to = opts?.toAt ?? new Date();
  const from = opts?.fromAt ?? new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform-wide metrics
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregatePlatformMetrics(opts?: WindowOpts) {
  const { from, to } = defaultWindow(opts);
  const priorFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));

  const [networkHealth, totalAumAgg, revenueAgg, priorRevenueAgg] = await Promise.all([
    getNetworkHealth(),
    prisma.investment.aggregate({
      where: { status: { in: ['FUNDED', 'CONVERTED'] } },
      _sum: { fundedAmount: true },
    }),
    prisma.revenueDistribution.aggregate({
      where: { status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: from, lte: to } },
      _sum: { sourceAmount: true },
    }),
    prisma.revenueDistribution.aggregate({
      where: { status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: priorFrom, lt: from } },
      _sum: { sourceAmount: true },
    }),
  ]);

  const activeClubs = await prisma.club.count({ where: { subscriptionStatus: { in: ['ACTIVE', 'TRIALING'] } } });
  const activeInvestors = await prisma.investorProfile.count({ where: { isActive: true, kycStatus: 'VERIFIED' } });

  const revenue90d = revenueAgg._sum.sourceAmount ?? 0;
  const revenuePrior = priorRevenueAgg._sum.sourceAmount ?? 0;
  const growthPct = revenuePrior > 0 ? ((revenue90d - revenuePrior) / revenuePrior) * 100 : null;

  return {
    activeClubs,
    activeFranchiseUnits: networkHealth.unitsActive,
    totalFranchiseUnits: networkHealth.unitsTotal,
    activeInvestors,
    totalAum: Math.round((totalAumAgg._sum.fundedAmount ?? 0) * 100) / 100,
    revenue90d: Math.round(revenue90d * 100) / 100,
    revenuePrior90d: Math.round(revenuePrior * 100) / 100,
    growthPct: growthPct == null ? null : Math.round(growthPct * 100) / 100,
    criticalViolations: networkHealth.criticalViolations,
    contractsExpiringSoon: networkHealth.contractsExpiringSoon,
    currency: 'EUR',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI insights summary — recent high-urgency decisions
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateAIInsights() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [critical, high, topDecisions] = await Promise.all([
    prisma.aIDecision.count({ where: { urgency: 'CRITICAL', createdAt: { gte: since } } }),
    prisma.aIDecision.count({ where: { urgency: 'HIGH', createdAt: { gte: since } } }),
    prisma.aIDecision.findMany({
      where: { urgency: { in: ['HIGH', 'CRITICAL'] }, createdAt: { gte: since } },
      orderBy: [{ urgency: 'desc' }, { score: 'desc' }, { createdAt: 'desc' }],
      take: 12,
      select: { id: true, domain: true, decisionType: true, score: true, urgency: true, createdAt: true },
    }),
  ]);

  return {
    criticalLast7d: critical,
    highLast7d: high,
    topDecisions: topDecisions.map((d) => ({
      id: d.id,
      domain: d.domain,
      decisionType: d.decisionType,
      score: d.score,
      urgency: d.urgency,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top expansion opportunities (from franchise territories)
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateExpansionOpportunities(): Promise<ExpansionOpportunity[]> {
  return await listExpansionOpportunities({ limit: 10 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow summary — by status, by kind, stalled count, due-this-week,
// pending attestation from the supplied user
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateWorkflowSummary(actorUserId: string) {
  const [byStatus, byKind, stalled, dueThisWeek, attestations] = await Promise.all([
    prisma.executiveWorkflow.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.executiveWorkflow.groupBy({ by: ['kind'], _count: { _all: true } }),
    prisma.executiveWorkflow.count({ where: { status: 'STALLED' } }),
    prisma.executiveWorkflow.count({
      where: {
        status: { in: ['IN_REVIEW', 'AWAITING_APPROVAL', 'IN_EXECUTION'] },
        dueByAt: { gte: new Date(), lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.executiveWorkflow.findMany({
      where: {
        status: 'AWAITING_APPROVAL',
        attestations: { none: { attesterUserId: actorUserId } },
      },
      select: { id: true },
    }),
  ]);

  const open =
    (byStatus.find((s) => s.status === 'IN_REVIEW')?._count._all ?? 0) +
    (byStatus.find((s) => s.status === 'AWAITING_APPROVAL')?._count._all ?? 0) +
    (byStatus.find((s) => s.status === 'IN_EXECUTION')?._count._all ?? 0);

  return {
    open,
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    byKind: Object.fromEntries(byKind.map((k) => [k.kind, k._count._all])),
    stalled,
    dueThisWeek,
    requiringAttestationFromActor: attestations.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Board summary — open resolutions, pending votes for actor
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateBoardSummary(actorUserId: string) {
  const quarterStart = new Date();
  quarterStart.setMonth(quarterStart.getMonth() - 3);

  const [active, pendingForActor, closed] = await Promise.all([
    prisma.boardResolution.count({ where: { status: { in: ['CIRCULATING', 'VOTING'] } } }),
    prisma.boardResolution.findMany({
      where: { status: 'VOTING', votes: { none: { voterUserId: actorUserId } } },
      select: { id: true },
    }),
    prisma.boardResolution.count({
      where: { status: { in: ['PASSED', 'FAILED'] }, decidedAt: { gte: quarterStart } },
    }),
  ]);

  return {
    activeResolutions: active,
    pendingVotesFromActor: pendingForActor.length,
    closedThisQuarter: closed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk summary
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateRiskSummary() {
  const now = new Date();
  const [open, critical, byCategory, bySeverity, overdue] = await Promise.all([
    prisma.riskAlert.count({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] } } }),
    prisma.riskAlert.count({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] }, severity: 'CRITICAL' } }),
    prisma.riskAlert.groupBy({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] } },
      by: ['category'],
      _count: { _all: true },
    }),
    prisma.riskAlert.groupBy({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] } },
      by: ['severity'],
      _count: { _all: true },
    }),
    prisma.riskAlert.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] }, dueByAt: { lt: now, not: null } },
    }),
  ]);

  return {
    open,
    critical,
    byCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._count._all])),
    bySeverity: Object.fromEntries(bySeverity.map((s) => [s.severity, s._count._all])),
    overdue,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sponsor pipeline summary
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateSponsorSummary() {
  const [totals, contracted, pipelineActive] = await Promise.all([
    prisma.sponsorOpportunity.groupBy({ by: ['stage'], _count: { _all: true } }),
    prisma.sponsorOpportunity.aggregate({
      where: { stage: { in: ['CONTRACT_SIGNED', 'ACTIVE', 'RENEWAL'] } },
      _sum: { contractedValue: true },
    }),
    prisma.sponsorOpportunity.aggregate({
      where: { stage: { in: ['QUALIFIED', 'PROPOSAL_SENT', 'IN_NEGOTIATION'] } },
      _sum: { proposedValue: true },
    }),
  ]);

  return {
    totalOpportunities: totals.reduce((s, t) => s + t._count._all, 0),
    byStage: Object.fromEntries(totals.map((t) => [t.stage, t._count._all])),
    contractedValueActive: Math.round((contracted._sum.contractedValue ?? 0) * 100) / 100,
    pipelineValue: Math.round((pipelineActive._sum.proposedValue ?? 0) * 100) / 100,
    currency: 'EUR',
  };
}
