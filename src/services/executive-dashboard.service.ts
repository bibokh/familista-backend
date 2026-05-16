// Familista — Executive OS · Integration Layer
// File location: src/services/executive-dashboard.service.ts
//
// The strategic growth control center. Composes a single CEO-grade view by
// calling the aggregator + workflow + board + sponsor + risk + forecast
// services in parallel. Pure read path — no writes, no logic duplication.

import { prisma } from '../lib/prisma';
import {
  aggregatePlatformMetrics,
  aggregateWorkflowSummary,
  aggregateBoardSummary,
  aggregateRiskSummary,
  aggregateSponsorSummary,
  aggregateAIInsights,
  aggregateExpansionOpportunities,
} from './executive-aggregator.service';
import type { ExecutiveActor, ExecutiveDashboard } from '../types/executive.types';

function nextPeriodKey(): { key: string; startAt: Date; endAt: Date } {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3); // 0-3 for current
  const nextQuarter = quarter + 1;
  const year = nextQuarter > 3 ? now.getFullYear() + 1 : now.getFullYear();
  const startQuarter = nextQuarter % 4;
  const startMonth = startQuarter * 3;
  const startAt = new Date(year, startMonth, 1);
  const endAt = new Date(year, startMonth + 3, 0);
  return { key: `${year}-Q${startQuarter + 1}`, startAt, endAt };
}

export async function buildDashboard(actor: ExecutiveActor): Promise<ExecutiveDashboard> {
  const [platform, workflows, board, risks, sponsors, ai, opportunities] = await Promise.all([
    aggregatePlatformMetrics(),
    aggregateWorkflowSummary(actor.userId),
    aggregateBoardSummary(actor.userId),
    aggregateRiskSummary(),
    aggregateSponsorSummary(),
    aggregateAIInsights(),
    aggregateExpansionOpportunities(),
  ]);

  const period = nextPeriodKey();
  const forecasts = await prisma.revenueForecast.findMany({
    where: { scope: 'PLATFORM', periodKey: period.key },
    select: { scenario: true, totalRevenue: true, confidence: true, currency: true },
  });

  const byScenario = Object.fromEntries(forecasts.map((f) => [f.scenario, f]));
  const forecast = forecasts.length > 0
    ? {
        nextPeriodKey: period.key,
        base: byScenario['BASE']?.totalRevenue ?? 0,
        optimistic: byScenario['OPTIMISTIC']?.totalRevenue ?? 0,
        pessimistic: byScenario['PESSIMISTIC']?.totalRevenue ?? 0,
        stress: byScenario['STRESS']?.totalRevenue ?? 0,
        confidence: Math.round((byScenario['BASE']?.confidence ?? 0.6) * 100) / 100,
        currency: byScenario['BASE']?.currency ?? 'EUR',
      }
    : null;

  return {
    asOf: new Date().toISOString(),
    platform: {
      activeClubs: platform.activeClubs,
      activeFranchiseUnits: platform.activeFranchiseUnits,
      activeInvestors: platform.activeInvestors,
      totalAum: platform.totalAum,
      revenue90d: platform.revenue90d,
      revenuePrior90d: platform.revenuePrior90d,
      growthPct: platform.growthPct,
      currency: platform.currency,
    },
    workflows,
    board,
    risks,
    sponsors,
    forecast,
    aiInsights: ai,
    expansionOpportunities: opportunities.slice(0, 10).map((o) => ({
      territoryId: o.territoryId,
      territoryName: o.territoryName,
      fullPath: o.fullPath,
      opportunityScore: o.opportunityScore,
      reasons: o.reasons,
    })),
  };
}
