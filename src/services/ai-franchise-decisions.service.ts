// Familista — AI Decision Engine
// File location: src/services/ai-franchise-decisions.service.ts
//
// The 5 franchise intelligence decisions. Each runs against a FranchiseUnit
// (typically a regional or master unit so the roll-up is meaningful).

import { extractFranchiseFeatures } from './ai-feature-extraction.service';
import {
  scoreRegionalExpansion,
  scoreAcademyProfitability,
  scoreTerritoryRisk,
  scoreOperatorPerformance,
  scoreFranchiseInvestment,
} from '../lib/ai-scoring.lib';
import { orchestrate } from './ai-orchestrator.service';
import { getActiveModel } from './ai-model-registry.service';
import type { AIActor, DecisionResult, FranchiseFeatures } from '../types/ai-engine.types';

type FranchiseDecisionType =
  | 'REGIONAL_EXPANSION_RECOMMENDATION'
  | 'ACADEMY_PROFITABILITY_PREDICTION'
  | 'TERRITORY_RISK_ANALYSIS'
  | 'OPERATOR_PERFORMANCE_SCORING'
  | 'FRANCHISE_INVESTMENT_SCORING';

type CallOptions = { useLlm?: boolean; persist?: boolean; cacheTtlSec?: number };

async function modelParams(decisionType: FranchiseDecisionType) {
  const m = await getActiveModel('FRANCHISE', decisionType);
  return (m?.parameters as Record<string, unknown> | undefined) ?? undefined;
}

export async function recommendRegionalExpansion(
  actor: AIActor,
  unitId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<FranchiseFeatures>> {
  const features = await extractFranchiseFeatures(unitId);
  const deterministic = scoreRegionalExpansion(features, await modelParams('REGIONAL_EXPANSION_RECOMMENDATION'));
  return await orchestrate<FranchiseFeatures>(actor, {
    domain: 'FRANCHISE',
    decisionType: 'REGIONAL_EXPANSION_RECOMMENDATION',
    subject: { type: 'FranchiseUnit', id: unitId },
    features,
    deterministic,
    scopeContext: { franchiseUnitId: unitId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}

export async function predictAcademyProfitability(
  actor: AIActor,
  unitId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<FranchiseFeatures>> {
  const features = await extractFranchiseFeatures(unitId);
  const deterministic = scoreAcademyProfitability(features, await modelParams('ACADEMY_PROFITABILITY_PREDICTION'));
  return await orchestrate<FranchiseFeatures>(actor, {
    domain: 'FRANCHISE',
    decisionType: 'ACADEMY_PROFITABILITY_PREDICTION',
    subject: { type: 'FranchiseUnit', id: unitId },
    features,
    deterministic,
    scopeContext: { franchiseUnitId: unitId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 30 * 24 * 60 * 60 },
  });
}

export async function analyzeTerritoryRisk(
  actor: AIActor,
  unitId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<FranchiseFeatures>> {
  const features = await extractFranchiseFeatures(unitId);
  const deterministic = scoreTerritoryRisk(features, await modelParams('TERRITORY_RISK_ANALYSIS'));
  return await orchestrate<FranchiseFeatures>(actor, {
    domain: 'FRANCHISE',
    decisionType: 'TERRITORY_RISK_ANALYSIS',
    subject: { type: 'FranchiseUnit', id: unitId },
    features,
    deterministic,
    scopeContext: { franchiseUnitId: unitId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}

export async function scoreOperatorPerf(
  actor: AIActor,
  unitId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<FranchiseFeatures>> {
  const features = await extractFranchiseFeatures(unitId);
  const deterministic = scoreOperatorPerformance(features, await modelParams('OPERATOR_PERFORMANCE_SCORING'));
  return await orchestrate<FranchiseFeatures>(actor, {
    domain: 'FRANCHISE',
    decisionType: 'OPERATOR_PERFORMANCE_SCORING',
    subject: { type: 'FranchiseUnit', id: unitId },
    features,
    deterministic,
    scopeContext: { franchiseUnitId: unitId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 14 * 24 * 60 * 60 },
  });
}

export async function scoreFranchiseInvestmentOpportunity(
  actor: AIActor,
  unitId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<FranchiseFeatures>> {
  const features = await extractFranchiseFeatures(unitId);
  const deterministic = scoreFranchiseInvestment(features, await modelParams('FRANCHISE_INVESTMENT_SCORING'));
  return await orchestrate<FranchiseFeatures>(actor, {
    domain: 'FRANCHISE',
    decisionType: 'FRANCHISE_INVESTMENT_SCORING',
    subject: { type: 'FranchiseUnit', id: unitId },
    features,
    deterministic,
    scopeContext: { franchiseUnitId: unitId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 14 * 24 * 60 * 60 },
  });
}
