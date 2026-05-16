// Familista — AI Decision Engine
// File location: src/services/ai-investor-decisions.service.ts
//
// The 5 investor intelligence decisions. ROI prediction, risk scoring and
// capital allocation run against an InvestorProfile; valuation and
// acquisition run against an InvestmentEntity.

import { extractInvestorFeatures, extractEntityFeatures } from './ai-feature-extraction.service';
import {
  scoreInvestorRoi,
  scoreInvestmentRisk,
  scoreValuation,
  scoreCapitalAllocation,
  scoreAcquisition,
} from '../lib/ai-scoring.lib';
import { orchestrate } from './ai-orchestrator.service';
import { getActiveModel } from './ai-model-registry.service';
import type { AIActor, DecisionResult, InvestorFeatures, EntityFeatures } from '../types/ai-engine.types';

type InvestorDecisionType =
  | 'INVESTOR_ROI_PREDICTION'
  | 'INVESTMENT_RISK_SCORING'
  | 'VALUATION_ENGINE'
  | 'CAPITAL_ALLOCATION_OPTIMIZATION'
  | 'ACQUISITION_RECOMMENDATION';

type CallOptions = { useLlm?: boolean; persist?: boolean; cacheTtlSec?: number };

async function modelParams(decisionType: InvestorDecisionType) {
  const m = await getActiveModel('INVESTOR', decisionType);
  return (m?.parameters as Record<string, unknown> | undefined) ?? undefined;
}

export async function predictInvestorRoi(
  actor: AIActor,
  investorId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<InvestorFeatures>> {
  const features = await extractInvestorFeatures(investorId);
  const deterministic = scoreInvestorRoi(features, await modelParams('INVESTOR_ROI_PREDICTION'));
  return await orchestrate<InvestorFeatures>(actor, {
    domain: 'INVESTOR',
    decisionType: 'INVESTOR_ROI_PREDICTION',
    subject: { type: 'InvestorProfile', id: investorId },
    features,
    deterministic,
    scopeContext: { investorId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}

export async function scoreInvestmentRiskFor(
  actor: AIActor,
  investorId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<InvestorFeatures>> {
  const features = await extractInvestorFeatures(investorId);
  const deterministic = scoreInvestmentRisk(features, await modelParams('INVESTMENT_RISK_SCORING'));
  return await orchestrate<InvestorFeatures>(actor, {
    domain: 'INVESTOR',
    decisionType: 'INVESTMENT_RISK_SCORING',
    subject: { type: 'InvestorProfile', id: investorId },
    features,
    deterministic,
    scopeContext: { investorId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}

export async function suggestValuation(
  actor: AIActor,
  entityId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<EntityFeatures>> {
  const features = await extractEntityFeatures(entityId);
  const deterministic = scoreValuation(features, await modelParams('VALUATION_ENGINE'));
  return await orchestrate<EntityFeatures>(actor, {
    domain: 'INVESTOR',
    decisionType: 'VALUATION_ENGINE',
    subject: { type: 'InvestmentEntity', id: entityId },
    features,
    deterministic,
    scopeContext: { entityId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}

export async function optimizeCapitalAllocation(
  actor: AIActor,
  investorId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<InvestorFeatures>> {
  const features = await extractInvestorFeatures(investorId);
  const deterministic = scoreCapitalAllocation(features, await modelParams('CAPITAL_ALLOCATION_OPTIMIZATION'));
  return await orchestrate<InvestorFeatures>(actor, {
    domain: 'INVESTOR',
    decisionType: 'CAPITAL_ALLOCATION_OPTIMIZATION',
    subject: { type: 'InvestorProfile', id: investorId },
    features,
    deterministic,
    scopeContext: { investorId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}

export async function recommendAcquisition(
  actor: AIActor,
  entityId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<EntityFeatures>> {
  const features = await extractEntityFeatures(entityId);
  const deterministic = scoreAcquisition(features, await modelParams('ACQUISITION_RECOMMENDATION'));
  return await orchestrate<EntityFeatures>(actor, {
    domain: 'INVESTOR',
    decisionType: 'ACQUISITION_RECOMMENDATION',
    subject: { type: 'InvestmentEntity', id: entityId },
    features,
    deterministic,
    scopeContext: { entityId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}
