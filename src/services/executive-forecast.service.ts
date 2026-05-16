// Familista — Executive OS · Integration Layer
// File location: src/services/executive-forecast.service.ts
//
// Revenue forecasting. Pulls historical RevenueDistribution + sponsor pipeline
// signal to project the next period under four scenarios (BASE, OPTIMISTIC,
// PESSIMISTIC, STRESS). Forecasts are deterministic — same input → same
// output — so they're board-safe and replayable.
//
// Method (BASE):
//   • Trend = average of last 4 same-length periods, weighted toward recent.
//   • Adjust by recent growth pct (last vs prior).
//   • Add active sponsor pipeline expected contribution (proposedValue ×
//     stage-conversion factor, prorated by termMonths within the period).
//
// Scenarios apply ±15% (OPT/PESS) and -30% (STRESS) on top.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  ForecastScenario,
  ForecastScope,
  RevenueForecast,
  SponsorPipelineStage,
} from '@prisma/client';
import {
  BadRequestError,
} from '../utils/errors';
import { writeExecutiveAudit } from './executive-audit.service';
import type { GenerateForecastInput } from '../utils/executive.validators';
import type { ExecutiveActor } from '../types/executive.types';

const MODEL_VERSION = '1.0.0';

const SCENARIO_FACTORS: Record<ForecastScenario, number> = {
  BASE: 1.0,
  OPTIMISTIC: 1.15,
  PESSIMISTIC: 0.85,
  STRESS: 0.7,
};

const SPONSOR_CONVERSION: Record<SponsorPipelineStage, number> = {
  PROSPECT: 0.05,
  QUALIFIED: 0.2,
  PROPOSAL_SENT: 0.35,
  IN_NEGOTIATION: 0.55,
  CONTRACT_SIGNED: 0.95,
  ACTIVE: 1.0,
  RENEWAL: 0.8,
  CHURNED: 0,
  REJECTED: 0,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function historicalRevenue(
  scope: ForecastScope,
  scopeId: string | null,
  from: Date,
  to: Date,
): Promise<number> {
  const where: Prisma.RevenueDistributionWhereInput = {
    status: { in: ['COMPUTED', 'EXECUTED'] },
    computedAt: { gte: from, lt: to },
  };
  if (scope === 'CLUB' && scopeId) where.clubId = scopeId;
  else if (scope === 'FRANCHISE_UNIT' && scopeId) where.unitId = scopeId;
  else if (scope === 'INVESTMENT_ENTITY' && scopeId) {
    const entity = await prisma.investmentEntity.findUnique({ where: { id: scopeId } });
    if (entity?.clubId) where.clubId = entity.clubId;
    else if (entity?.franchiseUnitId) where.unitId = entity.franchiseUnitId;
    else return 0;
  }
  const agg = await prisma.revenueDistribution.aggregate({ where, _sum: { sourceAmount: true } });
  return agg._sum.sourceAmount ?? 0;
}

async function sponsorContribution(
  scope: ForecastScope,
  scopeId: string | null,
  periodStartAt: Date,
  periodEndAt: Date,
): Promise<{ amount: number; lineItems: Array<{ name: string; expected: number; stage: SponsorPipelineStage }> }> {
  const where: Prisma.SponsorOpportunityWhereInput = {};
  if (scope === 'CLUB' && scopeId) where.clubId = scopeId;
  if (scope === 'FRANCHISE_UNIT' && scopeId) where.franchiseUnitId = scopeId;

  const sponsors = await prisma.sponsorOpportunity.findMany({
    where: {
      ...where,
      stage: { notIn: ['CHURNED', 'REJECTED'] },
    },
  });

  let total = 0;
  const lineItems: Array<{ name: string; expected: number; stage: SponsorPipelineStage }> = [];
  const periodDays = Math.max(1, (periodEndAt.getTime() - periodStartAt.getTime()) / (24 * 60 * 60 * 1000));

  for (const s of sponsors) {
    const value = s.contractedValue ?? s.proposedValue ?? 0;
    if (value <= 0) continue;
    const annualised = s.termMonths ? (value * 12) / s.termMonths : value;
    const prorated = (annualised * periodDays) / 365;
    const expected = prorated * SPONSOR_CONVERSION[s.stage];
    if (expected > 0) {
      total += expected;
      lineItems.push({ name: s.name, expected: round2(expected), stage: s.stage });
    }
  }

  return { amount: total, lineItems };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry — produce one forecast row per requested scenario
// ─────────────────────────────────────────────────────────────────────────────

export async function generateForecast(
  actor: ExecutiveActor,
  input: GenerateForecastInput,
): Promise<RevenueForecast[]> {
  const periodStartAt = new Date(input.periodStartAt);
  const periodEndAt = new Date(input.periodEndAt);
  if (periodEndAt <= periodStartAt) {
    throw new BadRequestError('periodEndAt must be after periodStartAt');
  }
  const periodMs = periodEndAt.getTime() - periodStartAt.getTime();

  // Pull last 4 same-length windows
  const historical: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const fromAt = new Date(periodStartAt.getTime() - i * periodMs);
    const toAt = new Date(periodStartAt.getTime() - (i - 1) * periodMs);
    historical.push(await historicalRevenue(input.scope, input.scopeId ?? null, fromAt, toAt));
  }
  // Weighted average — more weight to recent periods
  const weights = [0.45, 0.3, 0.15, 0.1];
  const weightedAvg = historical.reduce((s, h, i) => s + h * weights[i], 0);

  // Growth signal
  const recent = historical[0];
  const prior = historical[1];
  const growthAdj = prior > 0 ? Math.min(0.5, Math.max(-0.5, (recent - prior) / prior)) : 0;
  const trendBaseline = weightedAvg * (1 + growthAdj * 0.5);

  // Sponsor contribution
  const sponsor = await sponsorContribution(input.scope, input.scopeId ?? null, periodStartAt, periodEndAt);

  const baseRevenue = trendBaseline + sponsor.amount;

  // Confidence — more data + lower variance ⇒ higher confidence
  const sumDeltas = historical.length > 1
    ? historical.reduce((s, h, i, arr) => (i === 0 ? s : s + Math.abs(h - arr[i - 1])), 0) / Math.max(historical.length - 1, 1)
    : 0;
  const noise = recent > 0 ? Math.min(1, sumDeltas / recent) : 0.5;
  const confidence = Math.max(0.4, Math.min(0.92, 0.85 - noise * 0.3));

  const created: RevenueForecast[] = [];

  for (const scenario of input.scenarios) {
    const factor = SCENARIO_FACTORS[scenario as ForecastScenario];
    const revenue = baseRevenue * factor;

    const breakdown = {
      historicalRevenue: historical.map(round2),
      weightedHistoricalAvg: round2(weightedAvg),
      growthAdjustmentPct: round2(growthAdj * 100),
      trendBaseline: round2(trendBaseline),
      sponsorExpected: round2(sponsor.amount),
      sponsorLineItems: sponsor.lineItems,
      scenarioFactor: factor,
    };

    const assumptions = {
      weights,
      sponsorConversionByStage: SPONSOR_CONVERSION,
      modelDescription:
        'Weighted historical trend with growth correction + sponsor pipeline contribution, scenario-multiplied',
      ...((input.assumptions as Record<string, unknown>) ?? {}),
    };

    const row = await prisma.revenueForecast.upsert({
      where: {
        scope_scopeId_periodKey_scenario_modelVersion: {
          scope: input.scope,
          scopeId: input.scopeId ?? '',
          periodKey: input.periodKey,
          scenario: scenario as ForecastScenario,
          modelVersion: MODEL_VERSION,
        },
      },
      create: {
        scope: input.scope,
        scopeId: input.scopeId ?? null,
        periodKey: input.periodKey,
        periodStartAt,
        periodEndAt,
        scenario: scenario as ForecastScenario,
        totalRevenue: round2(revenue),
        currency: input.currency ?? 'EUR',
        confidence: round2(confidence),
        modelVersion: MODEL_VERSION,
        assumptions: assumptions as Prisma.InputJsonValue,
        breakdown: breakdown as Prisma.InputJsonValue,
        generatedBy: actor.userId,
      },
      update: {
        periodStartAt,
        periodEndAt,
        totalRevenue: round2(revenue),
        confidence: round2(confidence),
        assumptions: assumptions as Prisma.InputJsonValue,
        breakdown: breakdown as Prisma.InputJsonValue,
        generatedAt: new Date(),
        generatedBy: actor.userId,
      },
    });
    created.push(row);
  }

  await writeExecutiveAudit({
    userId: actor.userId,
    action: 'FORECAST_GENERATED',
    category: 'FORECAST',
    resourceType: 'RevenueForecast',
    metadata: {
      scope: input.scope,
      scopeId: input.scopeId,
      periodKey: input.periodKey,
      scenarios: input.scenarios,
      baseRevenue: round2(baseRevenue),
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function listForecasts(opts: {
  scope?: ForecastScope;
  scopeId?: string;
  periodKey?: string;
  scenario?: ForecastScenario;
  limit?: number;
}) {
  return await prisma.revenueForecast.findMany({
    where: {
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.scopeId ? { scopeId: opts.scopeId } : {}),
      ...(opts.periodKey ? { periodKey: opts.periodKey } : {}),
      ...(opts.scenario ? { scenario: opts.scenario } : {}),
    },
    orderBy: [{ periodStartAt: 'desc' }, { scenario: 'asc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}
