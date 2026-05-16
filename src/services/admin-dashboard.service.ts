// Familista — Platform Admin Dashboard
// File location: src/services/admin-dashboard.service.ts
//
// Read-only cross-engine aggregates for the Admin Control Center.
// No writes. No mutation. Everything in this file is a pure DB read with
// counters / groupings to feed the operator overview screens.
//
// Audit policy: dashboard reads are NOT audited (volume too high). Only
// destructive management calls are audited — see admin-management.service.

import { prisma } from '../lib/prisma';
import type {
  Prisma,
  SubscriptionPlan,
  SubscriptionStatus,
  UserRole,
  TransactionType,
  FranchiseStatus,
  KycStatus,
  AIDomain,
  IngestStatus,
} from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Types — explicit shapes so the controller layer doesn't need to peek inside.
// ─────────────────────────────────────────────────────────────────────────────

export type DashboardWindow = '24h' | '7d' | '30d' | '90d' | 'all';

export type DashboardOverview = {
  generatedAt: string;
  window: DashboardWindow;
  counts: {
    organizations: number;
    organizationsActive: number;
    academies: number;
    users: number;
    usersActive: number;
    players: number;
    coaches: number;
    managers: number;
    investors: number;
    investorsActive: number;
    franchiseUnits: number;
    franchiseUnitsActive: number;
    subscriptionsActive: number;
    subscriptionsTrialing: number;
    subscriptionsPastDue: number;
    payments: number;
    aiDecisions: number;
    aiModelsActive: number;
    visionRuns: number;
    visionRunsFailed: number;
    auditEntries: number;
    auditFailures: number;
  };
  revenue: {
    currency: string;
    income: number;
    expense: number;
    net: number;
    transactions: number;
    byCurrency: Array<{ currency: string; income: number; expense: number; net: number; transactions: number }>;
  };
  recentActivity: Array<{
    id: string;
    action: string;
    category: string;
    result: string;
    adminId: string | null;
    userId: string | null;
    clubId: string | null;
    resourceType: string | null;
    resourceId: string | null;
    message: string | null;
    createdAt: string;
  }>;
};

export type EngineStatusReport = {
  generatedAt: string;
  engines: Array<{
    engine: 'whitelabel' | 'admin' | 'franchise' | 'investor' | 'ai' | 'vision' | 'executive';
    healthy: boolean;
    metrics: Record<string, number | string | null>;
    lastActivityAt: string | null;
  }>;
};

export type SubscriptionBreakdown = {
  generatedAt: string;
  totals: {
    organizations: number;
    overrides: number;
  };
  byPlan: Array<{ plan: SubscriptionPlan; count: number }>;
  byStatus: Array<{ status: SubscriptionStatus; count: number }>;
  trialEndingSoon: Array<{ clubId: string; clubName: string; trialEndsAt: string }>;
  pastDue: Array<{ clubId: string; clubName: string; currentPeriodEnd: string | null }>;
};

export type SystemAlerts = {
  generatedAt: string;
  alerts: Array<{
    severity: 'info' | 'warning' | 'critical';
    code: string;
    message: string;
    count?: number;
    sampleIds?: string[];
  }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Window helpers
// ─────────────────────────────────────────────────────────────────────────────

function windowToDate(window: DashboardWindow): Date | null {
  if (window === 'all') return null;
  const now = Date.now();
  const ms =
    window === '24h' ? 24 * 3600 * 1000 :
    window === '7d'  ? 7  * 24 * 3600 * 1000 :
    window === '30d' ? 30 * 24 * 3600 * 1000 :
    /* 90d */          90 * 24 * 3600 * 1000;
  return new Date(now - ms);
}

const COACH_ROLES: UserRole[] = ['HEAD_COACH', 'ASSISTANT_COACH'];
const MANAGER_ROLES: UserRole[] = ['CLUB_ADMIN'];

// ─────────────────────────────────────────────────────────────────────────────
// Overview — single roundtrip-batched dashboard payload
// ─────────────────────────────────────────────────────────────────────────────

export async function getOverview(
  window: DashboardWindow = '30d',
  opts: { defaultCurrency?: string } = {},
): Promise<DashboardOverview> {
  const since = windowToDate(window);
  const sinceFilter: Prisma.DateTimeFilter | undefined = since ? { gte: since } : undefined;

  const [
    organizations,
    organizationsActive,
    academies,
    users,
    usersActive,
    players,
    coaches,
    managers,
    investors,
    investorsActive,
    franchiseUnits,
    franchiseUnitsActive,
    subsActive,
    subsTrial,
    subsPastDue,
    paymentRows,
    aiDecisions,
    aiModelsActive,
    visionRuns,
    visionRunsFailed,
    auditEntries,
    auditFailures,
    recentAudit,
  ] = await Promise.all([
    prisma.club.count(),
    prisma.club.count({ where: { subscriptionStatus: { in: ['ACTIVE', 'TRIALING'] } } }),
    prisma.club.count({ where: { plan: 'ACADEMY' } }),
    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.player.count(),
    prisma.user.count({ where: { role: { in: COACH_ROLES } } }),
    prisma.user.count({ where: { role: { in: MANAGER_ROLES } } }),
    prisma.investorProfile.count(),
    prisma.investorProfile.count({ where: { isActive: true } }),
    prisma.franchiseUnit.count(),
    prisma.franchiseUnit.count({ where: { status: 'ACTIVE' satisfies FranchiseStatus } }),
    prisma.club.count({ where: { subscriptionStatus: 'ACTIVE' } }),
    prisma.club.count({ where: { subscriptionStatus: 'TRIALING' } }),
    prisma.club.count({ where: { subscriptionStatus: 'PAST_DUE' } }),
    prisma.financial.findMany({
      where: sinceFilter ? { date: sinceFilter } : undefined,
      select: { type: true, amount: true, currency: true },
    }),
    prisma.aIDecision.count({ where: sinceFilter ? { createdAt: sinceFilter } : undefined }),
    prisma.aIModel.count({ where: { isActive: true } }),
    prisma.visionAnalysisRun.count({ where: sinceFilter ? { createdAt: sinceFilter } : undefined }),
    prisma.visionAnalysisRun.count({
      where: {
        status: 'FAILED' satisfies IngestStatus,
        ...(sinceFilter ? { createdAt: sinceFilter } : {}),
      },
    }),
    prisma.platformAuditLog.count({ where: sinceFilter ? { createdAt: sinceFilter } : undefined }),
    prisma.platformAuditLog.count({
      where: {
        result: { in: ['FAILURE', 'REJECTED'] },
        ...(sinceFilter ? { createdAt: sinceFilter } : {}),
      },
    }),
    prisma.platformAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);

  // ── Revenue rollup (by currency) ─────────────────────────────────────────
  const defaultCurrency = (opts.defaultCurrency ?? 'EUR').toUpperCase();
  const byCurrencyMap = new Map<string, { income: number; expense: number; transactions: number }>();
  for (const row of paymentRows) {
    const cur = (row.currency ?? defaultCurrency).toUpperCase();
    const acc = byCurrencyMap.get(cur) ?? { income: 0, expense: 0, transactions: 0 };
    if ((row.type as TransactionType) === 'INCOME') acc.income += row.amount;
    else acc.expense += row.amount;
    acc.transactions += 1;
    byCurrencyMap.set(cur, acc);
  }
  const byCurrency = Array.from(byCurrencyMap.entries())
    .map(([currency, v]) => ({
      currency,
      income: round2(v.income),
      expense: round2(v.expense),
      net: round2(v.income - v.expense),
      transactions: v.transactions,
    }))
    .sort((a, b) => b.transactions - a.transactions);

  const primary = byCurrencyMap.get(defaultCurrency) ?? { income: 0, expense: 0, transactions: 0 };

  return {
    generatedAt: new Date().toISOString(),
    window,
    counts: {
      organizations,
      organizationsActive,
      academies,
      users,
      usersActive,
      players,
      coaches,
      managers,
      investors,
      investorsActive,
      franchiseUnits,
      franchiseUnitsActive,
      subscriptionsActive: subsActive,
      subscriptionsTrialing: subsTrial,
      subscriptionsPastDue: subsPastDue,
      payments: paymentRows.length,
      aiDecisions,
      aiModelsActive,
      visionRuns,
      visionRunsFailed,
      auditEntries,
      auditFailures,
    },
    revenue: {
      currency: defaultCurrency,
      income: round2(primary.income),
      expense: round2(primary.expense),
      net: round2(primary.income - primary.expense),
      transactions: primary.transactions,
      byCurrency,
    },
    recentActivity: recentAudit.map((row) => ({
      id: row.id,
      action: row.action,
      category: row.category,
      result: row.result,
      adminId: row.adminId,
      userId: row.userId,
      clubId: row.clubId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-engine status — health-ish snapshots
// ─────────────────────────────────────────────────────────────────────────────

export async function getEngineStatus(): Promise<EngineStatusReport> {
  const [
    whitelabelConfigs,
    whitelabelDomainsVerified,
    whitelabelLastAsset,
    platformAdmins,
    lastAudit,
    franchiseUnits,
    franchiseActive,
    franchiseTerritories,
    investorProfiles,
    investorActive,
    investorKycPending,
    aiModelsActive,
    aiModelsTotal,
    aiDecisionsLast,
    visionRunsTotal,
    visionRunsRunning,
    visionRunsLast,
    executiveRecentAudit,
  ] = await Promise.all([
    prisma.whiteLabelConfig.count(),
    prisma.whiteLabelDomain.count({ where: { status: 'ACTIVE' } }),
    prisma.whiteLabelAsset.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.platformAdmin.count({ where: { isActive: true } }),
    prisma.platformAuditLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.franchiseUnit.count(),
    prisma.franchiseUnit.count({ where: { status: 'ACTIVE' } }),
    prisma.territory.count(),
    prisma.investorProfile.count(),
    prisma.investorProfile.count({ where: { isActive: true } }),
    prisma.investorProfile.count({ where: { kycStatus: 'PENDING' satisfies KycStatus } }),
    prisma.aIModel.count({ where: { isActive: true } }),
    prisma.aIModel.count(),
    prisma.aIDecision.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.visionAnalysisRun.count(),
    prisma.visionAnalysisRun.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
    prisma.visionAnalysisRun.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.platformAuditLog.findFirst({
      where: { category: 'OTHER' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    engines: [
      {
        engine: 'whitelabel',
        healthy: true,
        metrics: {
          configs: whitelabelConfigs,
          activeDomains: whitelabelDomainsVerified,
        },
        lastActivityAt: whitelabelLastAsset?.createdAt.toISOString() ?? null,
      },
      {
        engine: 'admin',
        healthy: platformAdmins > 0,
        metrics: {
          activeAdmins: platformAdmins,
        },
        lastActivityAt: lastAudit?.createdAt.toISOString() ?? null,
      },
      {
        engine: 'franchise',
        healthy: franchiseUnits > 0 || franchiseTerritories > 0,
        metrics: {
          units: franchiseUnits,
          unitsActive: franchiseActive,
          territories: franchiseTerritories,
        },
        lastActivityAt: null,
      },
      {
        engine: 'investor',
        healthy: true,
        metrics: {
          profiles: investorProfiles,
          active: investorActive,
          kycPending: investorKycPending,
        },
        lastActivityAt: null,
      },
      {
        engine: 'ai',
        healthy: aiModelsActive > 0,
        metrics: {
          modelsActive: aiModelsActive,
          modelsTotal: aiModelsTotal,
        },
        lastActivityAt: aiDecisionsLast?.createdAt.toISOString() ?? null,
      },
      {
        engine: 'vision',
        healthy: true,
        metrics: {
          runs: visionRunsTotal,
          inFlight: visionRunsRunning,
        },
        lastActivityAt: visionRunsLast?.createdAt.toISOString() ?? null,
      },
      {
        engine: 'executive',
        healthy: true,
        metrics: {},
        lastActivityAt: executiveRecentAudit?.createdAt.toISOString() ?? null,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription breakdown — used by the billing tile on the dashboard
// ─────────────────────────────────────────────────────────────────────────────

export async function getSubscriptionBreakdown(): Promise<SubscriptionBreakdown> {
  const soon = new Date(Date.now() + 7 * 24 * 3600 * 1000);

  const [orgCount, overrideCount, byPlan, byStatus, trialEnding, pastDue] = await Promise.all([
    prisma.club.count(),
    prisma.subscriptionOverride.count({ where: { isActive: true, revokedAt: null } }),
    prisma.club.groupBy({ by: ['plan'], _count: { _all: true } }),
    prisma.club.groupBy({ by: ['subscriptionStatus'], _count: { _all: true } }),
    prisma.club.findMany({
      where: { trialEndsAt: { lte: soon, gte: new Date() } },
      orderBy: { trialEndsAt: 'asc' },
      take: 25,
      select: { id: true, name: true, trialEndsAt: true },
    }),
    prisma.club.findMany({
      where: { subscriptionStatus: 'PAST_DUE' },
      orderBy: { currentPeriodEnd: 'asc' },
      take: 25,
      select: { id: true, name: true, currentPeriodEnd: true },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    totals: { organizations: orgCount, overrides: overrideCount },
    byPlan:   byPlan.map((r) => ({ plan: r.plan, count: r._count._all })),
    byStatus: byStatus.map((r) => ({ status: r.subscriptionStatus, count: r._count._all })),
    trialEndingSoon: trialEnding
      .filter((r) => r.trialEndsAt)
      .map((r) => ({ clubId: r.id, clubName: r.name, trialEndsAt: r.trialEndsAt!.toISOString() })),
    pastDue: pastDue.map((r) => ({
      clubId: r.id,
      clubName: r.name,
      currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI / Vision engine status — finer-grained per-engine reports
// ─────────────────────────────────────────────────────────────────────────────

export async function getAiEngineDetail() {
  const [byDomain, totalDecisions, recentDecisions, modelsActive, modelsTotal] = await Promise.all([
    prisma.aIDecision.groupBy({ by: ['domain'], _count: { _all: true } }),
    prisma.aIDecision.count(),
    prisma.aIDecision.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        domain: true,
        decisionType: true,
        createdAt: true,
      },
    }),
    prisma.aIModel.count({ where: { isActive: true } }),
    prisma.aIModel.count(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    models: { active: modelsActive, total: modelsTotal },
    decisions: { total: totalDecisions },
    byDomain: byDomain.map((r) => ({ domain: r.domain as AIDomain, count: r._count._all })),
    recent: recentDecisions.map((r) => ({
      id: r.id,
      domain: r.domain,
      decisionType: r.decisionType,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function getVisionEngineDetail() {
  const [byStatus, totalRuns, lastFailed, framesAgg] = await Promise.all([
    prisma.visionAnalysisRun.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.visionAnalysisRun.count(),
    prisma.visionAnalysisRun.findFirst({
      where: { status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, errorsCount: true, createdAt: true },
    }),
    prisma.visionAnalysisRun.aggregate({
      _sum: { framesProcessed: true, errorsCount: true, warningsCount: true },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    runs: { total: totalRuns },
    byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
    framesProcessed: framesAgg._sum.framesProcessed ?? 0,
    errors: framesAgg._sum.errorsCount ?? 0,
    warnings: framesAgg._sum.warningsCount ?? 0,
    lastFailed: lastFailed
      ? { id: lastFailed.id, errorsCount: lastFailed.errorsCount, at: lastFailed.createdAt.toISOString() }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// System alerts — anomalies surfaced on the dashboard front page
// ─────────────────────────────────────────────────────────────────────────────

export async function getSystemAlerts(): Promise<SystemAlerts> {
  const out: SystemAlerts['alerts'] = [];

  // Past-due subscriptions
  const pastDue = await prisma.club.findMany({
    where: { subscriptionStatus: 'PAST_DUE' },
    select: { id: true },
    take: 25,
  });
  if (pastDue.length > 0) {
    out.push({
      severity: 'warning',
      code: 'BILLING_PAST_DUE',
      message: `${pastDue.length} organization(s) past due on subscription`,
      count: pastDue.length,
      sampleIds: pastDue.slice(0, 5).map((r) => r.id),
    });
  }

  // Audit failures last 24h
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const failures = await prisma.platformAuditLog.count({
    where: { result: { in: ['FAILURE', 'REJECTED'] }, createdAt: { gte: since } },
  });
  if (failures > 0) {
    out.push({
      severity: failures >= 25 ? 'critical' : 'warning',
      code: 'AUDIT_FAILURES_24H',
      message: `${failures} platform audit failure(s) in the last 24 hours`,
      count: failures,
    });
  }

  // Vision runs failed in last 24h
  const visionFailed = await prisma.visionAnalysisRun.count({
    where: { status: 'FAILED', createdAt: { gte: since } },
  });
  if (visionFailed > 0) {
    out.push({
      severity: visionFailed >= 10 ? 'critical' : 'warning',
      code: 'VISION_FAILURES_24H',
      message: `${visionFailed} vision analysis run(s) failed in the last 24 hours`,
      count: visionFailed,
    });
  }

  // KYC pending older than 30 days
  const kycCutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const stuckKyc = await prisma.investorProfile.count({
    where: { kycStatus: 'PENDING', createdAt: { lt: kycCutoff } },
  });
  if (stuckKyc > 0) {
    out.push({
      severity: 'warning',
      code: 'KYC_STUCK',
      message: `${stuckKyc} investor(s) with KYC pending > 30 days`,
      count: stuckKyc,
    });
  }

  // No active AI models
  const activeModels = await prisma.aIModel.count({ where: { isActive: true } });
  if (activeModels === 0) {
    out.push({
      severity: 'critical',
      code: 'AI_NO_ACTIVE_MODELS',
      message: 'AI engine has zero active models — run bootstrap seed',
    });
  }

  // No platform admins (should never happen post-bootstrap)
  const admins = await prisma.platformAdmin.count({ where: { isActive: true } });
  if (admins === 0) {
    out.push({
      severity: 'critical',
      code: 'NO_PLATFORM_ADMINS',
      message: 'No active PlatformAdmin records — bootstrap required',
    });
  }

  if (out.length === 0) {
    out.push({ severity: 'info', code: 'OK', message: 'No active alerts.' });
  }

  return { generatedAt: new Date().toISOString(), alerts: out };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
