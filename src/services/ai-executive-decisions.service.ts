// Familista — AI Decision Engine
// File location: src/services/ai-executive-decisions.service.ts
//
// The 5 executive-layer decisions. These roll up across the entire platform
// rather than any single tenant — only platform admins may invoke them.

import { extractExecutiveFeatures, extractEntityFeatures } from './ai-feature-extraction.service';
import {
  scoreCeoDashboard,
  scoreBoardStrategy,
  scoreExpansionOpportunity,
  scoreMarketEntry,
  scoreAcquisitionTarget,
} from '../lib/ai-scoring.lib';
import { orchestrate } from './ai-orchestrator.service';
import { getActiveModel } from './ai-model-registry.service';
import type { AIActor, DecisionResult, ExecutiveFeatures, EntityFeatures } from '../types/ai-engine.types';

type ExecDecisionType =
  | 'CEO_DASHBOARD_RECOMMENDATION'
  | 'BOARD_STRATEGIC_SUGGESTION'
  | 'EXPANSION_OPPORTUNITY'
  | 'MARKET_ENTRY_PREDICTION'
  | 'ACQUISITION_TARGET';

type CallOptions = { useLlm?: boolean; persist?: boolean; cacheTtlSec?: number };

async function modelParams(decisionType: ExecDecisionType) {
  const m = await getActiveModel('EXECUTIVE', decisionType);
  return (m?.parameters as Record<string, unknown> | undefined) ?? undefined;
}

export async function generateCeoDashboard(
  actor: AIActor,
  opts: CallOptions = {},
): Promise<DecisionResult<ExecutiveFeatures>> {
  const features = await extractExecutiveFeatures();
  const deterministic = scoreCeoDashboard(features, await modelParams('CEO_DASHBOARD_RECOMMENDATION'));
  return await orchestrate<ExecutiveFeatures>(actor, {
    domain: 'EXECUTIVE',
    decisionType: 'CEO_DASHBOARD_RECOMMENDATION',
    subject: { type: 'Platform', id: features.platformId },
    features,
    deterministic,
    scopeContext: {},
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 6 * 60 * 60 },
  });
}

export async function generateBoardStrategy(
  actor: AIActor,
  opts: CallOptions = {},
): Promise<DecisionResult<ExecutiveFeatures>> {
  const features = await extractExecutiveFeatures();
  const deterministic = scoreBoardStrategy(features, await modelParams('BOARD_STRATEGIC_SUGGESTION'));
  return await orchestrate<ExecutiveFeatures>(actor, {
    domain: 'EXECUTIVE',
    decisionType: 'BOARD_STRATEGIC_SUGGESTION',
    subject: { type: 'Platform', id: features.platformId },
    features,
    deterministic,
    scopeContext: {},
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}

export async function rankExpansionOpportunities(
  actor: AIActor,
  opts: CallOptions = {},
): Promise<DecisionResult<ExecutiveFeatures>> {
  const features = await extractExecutiveFeatures();
  const deterministic = scoreExpansionOpportunity(features, await modelParams('EXPANSION_OPPORTUNITY'));
  return await orchestrate<ExecutiveFeatures>(actor, {
    domain: 'EXECUTIVE',
    decisionType: 'EXPANSION_OPPORTUNITY',
    subject: { type: 'Platform', id: features.platformId },
    features,
    deterministic,
    scopeContext: {},
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 14 * 24 * 60 * 60 },
  });
}

export async function predictMarketEntry(
  actor: AIActor,
  opts: CallOptions = {},
): Promise<DecisionResult<ExecutiveFeatures>> {
  const features = await extractExecutiveFeatures();
  const deterministic = scoreMarketEntry(features, await modelParams('MARKET_ENTRY_PREDICTION'));
  return await orchestrate<ExecutiveFeatures>(actor, {
    domain: 'EXECUTIVE',
    decisionType: 'MARKET_ENTRY_PREDICTION',
    subject: { type: 'Platform', id: features.platformId },
    features,
    deterministic,
    scopeContext: {},
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 14 * 24 * 60 * 60 },
  });
}

export async function evaluateAcquisitionTarget(
  actor: AIActor,
  entityId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<EntityFeatures>> {
  const features = await extractEntityFeatures(entityId);
  const deterministic = scoreAcquisitionTarget(features, await modelParams('ACQUISITION_TARGET'));
  return await orchestrate<EntityFeatures>(actor, {
    domain: 'EXECUTIVE',
    decisionType: 'ACQUISITION_TARGET',
    subject: { type: 'InvestmentEntity', id: entityId },
    features,
    deterministic,
    scopeContext: { entityId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}
