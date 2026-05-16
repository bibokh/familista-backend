// Familista — AI Decision Engine
// File location: src/services/ai-club-decisions.service.ts
//
// The 5 club-management decisions.

import { prisma } from '../lib/prisma';
import { extractClubFeatures } from './ai-feature-extraction.service';
import {
  scoreFinancialHealth,
  scoreBudgetOptimization,
  scoreSalaryRisk,
  scoreSponsorship,
  scoreTransferMarketSupport,
} from '../lib/ai-scoring.lib';
import { orchestrate } from './ai-orchestrator.service';
import { getActiveModel } from './ai-model-registry.service';
import type { AIActor, DecisionResult, ClubFeatures } from '../types/ai-engine.types';

type ClubDecisionType =
  | 'FINANCIAL_HEALTH_PREDICTION'
  | 'BUDGET_OPTIMIZATION'
  | 'SALARY_RISK_ALERT'
  | 'SPONSORSHIP_RECOMMENDATION'
  | 'TRANSFER_MARKET_SUPPORT';

type CallOptions = { useLlm?: boolean; persist?: boolean; cacheTtlSec?: number };

async function modelParams(decisionType: ClubDecisionType) {
  const m = await getActiveModel('CLUB', decisionType);
  return (m?.parameters as Record<string, unknown> | undefined) ?? undefined;
}

async function clubScope(clubId: string) {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { franchiseUnitId: true as never },
  });
  const fuId =
    (club as unknown as { franchiseUnitId?: string | null } | null | undefined)?.franchiseUnitId ?? null;
  return { clubId, franchiseUnitId: fuId };
}

export async function predictFinancialHealth(
  actor: AIActor,
  clubId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<ClubFeatures>> {
  const features = await extractClubFeatures(clubId);
  const deterministic = scoreFinancialHealth(features, await modelParams('FINANCIAL_HEALTH_PREDICTION'));
  return await orchestrate<ClubFeatures>(actor, {
    domain: 'CLUB',
    decisionType: 'FINANCIAL_HEALTH_PREDICTION',
    subject: { type: 'Club', id: clubId },
    features,
    deterministic,
    scopeContext: await clubScope(clubId),
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}

export async function optimizeBudget(
  actor: AIActor,
  clubId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<ClubFeatures>> {
  const features = await extractClubFeatures(clubId);
  const deterministic = scoreBudgetOptimization(features, await modelParams('BUDGET_OPTIMIZATION'));
  return await orchestrate<ClubFeatures>(actor, {
    domain: 'CLUB',
    decisionType: 'BUDGET_OPTIMIZATION',
    subject: { type: 'Club', id: clubId },
    features,
    deterministic,
    scopeContext: await clubScope(clubId),
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}

export async function alertSalaryRisk(
  actor: AIActor,
  clubId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<ClubFeatures>> {
  const features = await extractClubFeatures(clubId);
  const deterministic = scoreSalaryRisk(features, await modelParams('SALARY_RISK_ALERT'));
  return await orchestrate<ClubFeatures>(actor, {
    domain: 'CLUB',
    decisionType: 'SALARY_RISK_ALERT',
    subject: { type: 'Club', id: clubId },
    features,
    deterministic,
    scopeContext: await clubScope(clubId),
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 12 * 60 * 60 },
  });
}

export async function recommendSponsorship(
  actor: AIActor,
  clubId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<ClubFeatures>> {
  const features = await extractClubFeatures(clubId);
  const deterministic = scoreSponsorship(features, await modelParams('SPONSORSHIP_RECOMMENDATION'));
  return await orchestrate<ClubFeatures>(actor, {
    domain: 'CLUB',
    decisionType: 'SPONSORSHIP_RECOMMENDATION',
    subject: { type: 'Club', id: clubId },
    features,
    deterministic,
    scopeContext: await clubScope(clubId),
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}

export async function supportTransferMarket(
  actor: AIActor,
  clubId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<ClubFeatures>> {
  const features = await extractClubFeatures(clubId);
  const deterministic = scoreTransferMarketSupport(features, await modelParams('TRANSFER_MARKET_SUPPORT'));
  return await orchestrate<ClubFeatures>(actor, {
    domain: 'CLUB',
    decisionType: 'TRANSFER_MARKET_SUPPORT',
    subject: { type: 'Club', id: clubId },
    features,
    deterministic,
    scopeContext: await clubScope(clubId),
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}
