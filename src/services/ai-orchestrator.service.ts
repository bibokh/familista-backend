// Familista — AI Decision Engine
// File location: src/services/ai-orchestrator.service.ts
//
// The orchestrator runs every AI decision end-to-end:
//   1. Resolve the active versioned model for (domain, decisionType).
//   2. Run the supplied deterministic scoring function over the features.
//   3. Wrap the score with a narrative via the explainability service.
//   4. Persist an immutable AIDecision row with full lineage.
//   5. Audit + return a DecisionResult.
//
// Domain services (player / coach / club / franchise / investor / executive)
// each compose the orchestrator with a specific feature extractor + scoring
// function. The orchestrator never inspects domain logic — it owns governance
// (audit, expiry, visibility, hashing), not analytics.

import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type { AIDecision, AIDecisionVisibility, AIDomain, AIDecisionType } from '@prisma/client';
import { BadRequestError } from '../utils/errors';
import { resolveModel } from './ai-model-registry.service';
import { explain } from './ai-explainability.service';
import { writeAIAudit } from './ai-audit.service';
import type {
  AIActor,
  AISubjectRef,
  DecisionResult,
  DeterministicScore,
  FeatureMap,
} from '../types/ai-engine.types';

export type OrchestrateInput<F extends FeatureMap = FeatureMap> = {
  domain: AIDomain;
  decisionType: AIDecisionType;
  subject: AISubjectRef;
  features: F;
  deterministic: DeterministicScore;
  scopeContext: {
    clubId?: string | null;
    franchiseUnitId?: string | null;
    investorId?: string | null;
    entityId?: string | null;
  };
  options?: {
    useLlm?: boolean;
    forceModelSlug?: string;
    forceModelVersion?: string;
    persist?: boolean;
    cacheTtlSec?: number;
    visibility?: AIDecisionVisibility;
  };
};

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`);
  return `{${parts.join(',')}}`;
}

function hashFeatures(domain: string, decisionType: string, subject: AISubjectRef, features: FeatureMap): string {
  const input = canonicalize({ domain, decisionType, subject, features });
  return crypto.createHash('sha256').update(input).digest('hex');
}

function defaultVisibilityFor(domain: AIDomain): AIDecisionVisibility {
  switch (domain) {
    case 'INVESTOR':   return 'INVESTOR';
    case 'EXECUTIVE':  return 'PLATFORM';
    case 'FRANCHISE':  return 'FRANCHISE';
    default:           return 'CLUB';
  }
}

function defaultExpiryMs(decisionType: AIDecisionType): number {
  switch (decisionType) {
    case 'LINEUP_RECOMMENDATION':
    case 'SUBSTITUTION_RECOMMENDATION':
    case 'MATCH_PREPARATION':
    case 'OPPONENT_ANALYSIS':
      return 3 * 24 * 60 * 60 * 1000;          // 3 days
    case 'FATIGUE_PREDICTION':
    case 'INJURY_RISK':
      return 7 * 24 * 60 * 60 * 1000;          // 1 week
    case 'TRANSFER_RECOMMENDATION':
    case 'FINANCIAL_HEALTH_PREDICTION':
    case 'BUDGET_OPTIMIZATION':
    case 'SALARY_RISK_ALERT':
      return 30 * 24 * 60 * 60 * 1000;         // 1 month
    case 'TERRITORY_RISK_ANALYSIS':
    case 'ACADEMY_PROFITABILITY_PREDICTION':
    case 'REGIONAL_EXPANSION_RECOMMENDATION':
    case 'OPERATOR_PERFORMANCE_SCORING':
    case 'FRANCHISE_INVESTMENT_SCORING':
      return 90 * 24 * 60 * 60 * 1000;         // 3 months
    default:
      return 60 * 24 * 60 * 60 * 1000;         // 2 months
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache lookup — short-circuit re-running an identical decision
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCached(
  domain: AIDomain,
  decisionType: AIDecisionType,
  inputHash: string,
  ttlSec: number,
): Promise<AIDecision | null> {
  if (ttlSec <= 0) return null;
  const cutoff = new Date(Date.now() - ttlSec * 1000);
  return await prisma.aIDecision.findFirst({
    where: {
      domain,
      decisionType,
      inputHash,
      createdAt: { gte: cutoff },
      status: { not: 'REJECTED' },
    },
    orderBy: { createdAt: 'desc' },
  });
}

function rowToResult(row: AIDecision): DecisionResult {
  return {
    id: row.id,
    domain: row.domain,
    decisionType: row.decisionType,
    modelSlug: row.modelSlug,
    modelVersion: row.modelVersion,
    subject: { type: row.subjectType as AISubjectRef['type'], id: row.subjectId },
    score: row.score,
    confidence: row.confidence,
    urgency: row.urgency,
    features: row.features as FeatureMap,
    evidence: (row.evidence as DeterministicScore['factors']) ?? [],
    recommendation: row.recommendation as DecisionResult['recommendation'],
    alternatives: (row.alternatives as DecisionResult['alternatives']) ?? [],
    warnings: row.warnings,
    rationale: row.rationale,
    status: row.status,
    visibility: row.visibility,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    inputHash: row.inputHash,
    llm: {
      used: row.llmDurationMs != null,
      tokensIn: row.llmTokensIn,
      tokensOut: row.llmTokensOut,
      durationMs: row.llmDurationMs,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export async function orchestrate<F extends FeatureMap>(
  actor: AIActor,
  input: OrchestrateInput<F>,
): Promise<DecisionResult<F>> {
  if (!input.features || typeof input.features !== 'object') {
    throw new BadRequestError('features payload required');
  }

  const model = await resolveModel(
    input.domain,
    input.decisionType,
    input.options?.forceModelSlug,
    input.options?.forceModelVersion,
  );

  const inputHash = hashFeatures(input.domain, input.decisionType, input.subject, input.features);

  const ttlSec = input.options?.cacheTtlSec;
  if (ttlSec !== undefined && ttlSec > 0) {
    const cached = await fetchCached(input.domain, input.decisionType, inputHash, ttlSec);
    if (cached) {
      await writeAIAudit({
        decisionId: cached.id,
        modelId: model.id,
        userId: actor.userId,
        action: 'DECISION_CACHE_HIT',
        category: 'DECISION',
        metadata: { domain: input.domain, decisionType: input.decisionType, inputHash, ttlSec },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      return rowToResult(cached) as DecisionResult<F>;
    }
  }

  const narrative = await explain({
    domain: input.domain,
    decisionType: input.decisionType,
    subject: input.subject,
    deterministic: input.deterministic,
    features: input.features,
    useLlm: input.options?.useLlm,
  });

  const visibility = input.options?.visibility ?? defaultVisibilityFor(input.domain);
  const expiresAt = new Date(Date.now() + defaultExpiryMs(input.decisionType));
  const persist = input.options?.persist !== false;

  if (!persist) {
    return {
      id: 'transient',
      domain: input.domain,
      decisionType: input.decisionType,
      modelSlug: model.slug,
      modelVersion: model.version,
      subject: input.subject,
      score: input.deterministic.score,
      confidence: narrative.confidence,
      urgency: input.deterministic.urgency,
      features: input.features,
      evidence: input.deterministic.factors,
      recommendation: input.deterministic.recommendation,
      alternatives: narrative.alternatives,
      warnings: narrative.warnings,
      rationale: narrative.rationale,
      status: 'GENERATED',
      visibility,
      expiresAt,
      createdAt: new Date(),
      inputHash,
      llm: narrative.llm,
    } as DecisionResult<F>;
  }

  const row = await prisma.aIDecision.create({
    data: {
      domain: input.domain,
      decisionType: input.decisionType,
      modelId: model.id,
      modelSlug: model.slug,
      modelVersion: model.version,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      clubId: input.scopeContext.clubId ?? null,
      franchiseUnitId: input.scopeContext.franchiseUnitId ?? null,
      investorId: input.scopeContext.investorId ?? null,
      entityId: input.scopeContext.entityId ?? null,
      features: input.features as Prisma.InputJsonValue,
      inputHash,
      score: input.deterministic.score,
      confidence: narrative.confidence,
      urgency: input.deterministic.urgency,
      recommendation: input.deterministic.recommendation as unknown as Prisma.InputJsonValue,
      evidence: input.deterministic.factors as unknown as Prisma.InputJsonValue,
      rationale: narrative.rationale,
      alternatives: narrative.alternatives as unknown as Prisma.InputJsonValue,
      warnings: narrative.warnings,
      status: 'GENERATED',
      visibility,
      expiresAt,
      generatedByUserId: actor.userId,
      generatedByRole: actor.scope.userRole ?? (actor.scope.isPlatformAdmin ? 'PLATFORM_ADMIN' : 'SYSTEM'),
      llmTokensIn: narrative.llm.tokensIn,
      llmTokensOut: narrative.llm.tokensOut,
      llmDurationMs: narrative.llm.durationMs,
    },
  });

  await writeAIAudit({
    decisionId: row.id,
    modelId: model.id,
    userId: actor.userId,
    action: 'DECISION_GENERATED',
    category: 'DECISION',
    metadata: {
      domain: input.domain,
      decisionType: input.decisionType,
      score: row.score,
      urgency: row.urgency,
      llmUsed: narrative.llm.used,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return rowToResult(row) as DecisionResult<F>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review + state transitions on existing decisions
// ─────────────────────────────────────────────────────────────────────────────

export async function reviewDecision(
  actor: AIActor,
  decisionId: string,
  newStatus: 'REVIEWED' | 'ACCEPTED' | 'REJECTED' | 'OVERRIDDEN',
  notes: string,
): Promise<AIDecision> {
  const existing = await prisma.aIDecision.findUnique({ where: { id: decisionId } });
  if (!existing) throw new BadRequestError('Decision not found');
  if (existing.status === 'EXPIRED') throw new BadRequestError('Cannot review an expired decision');

  const updated = await prisma.aIDecision.update({
    where: { id: decisionId },
    data: {
      status: newStatus,
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
      reviewNotes: notes,
    },
  });

  await writeAIAudit({
    decisionId,
    modelId: existing.modelId,
    userId: actor.userId,
    action: `DECISION_${newStatus}`,
    category: 'REVIEW',
    metadata: { previousStatus: existing.status, notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}
