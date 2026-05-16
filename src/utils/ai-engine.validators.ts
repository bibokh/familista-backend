// Familista — AI Decision Engine
// File location: src/utils/ai-engine.validators.ts
//
// Zod schemas for AI engine endpoints. Strict mode — unknown keys rejected.

import { z } from 'zod';

const cuidOrUuid = z.string().min(8).max(64);
const iso8601 = z.string().datetime();

export const AI_DOMAINS = ['PLAYER', 'COACH', 'CLUB', 'FRANCHISE', 'INVESTOR', 'EXECUTIVE'] as const;

export const AI_DECISION_TYPES = [
  'PLAYER_GROWTH', 'TALENT_DETECTION', 'INJURY_RISK', 'FATIGUE_PREDICTION',
  'TRANSFER_RECOMMENDATION', 'TRAINING_OPTIMIZATION', 'LINEUP_RECOMMENDATION',
  'TACTICAL_RECOMMENDATION', 'FORMATION_OPTIMIZATION', 'OPPONENT_ANALYSIS',
  'MATCH_PREPARATION', 'SUBSTITUTION_RECOMMENDATION', 'TRAINING_PLAN_GENERATION',
  'FINANCIAL_HEALTH_PREDICTION', 'BUDGET_OPTIMIZATION', 'SALARY_RISK_ALERT',
  'SPONSORSHIP_RECOMMENDATION', 'TRANSFER_MARKET_SUPPORT',
  'REGIONAL_EXPANSION_RECOMMENDATION', 'ACADEMY_PROFITABILITY_PREDICTION',
  'TERRITORY_RISK_ANALYSIS', 'OPERATOR_PERFORMANCE_SCORING', 'FRANCHISE_INVESTMENT_SCORING',
  'INVESTOR_ROI_PREDICTION', 'INVESTMENT_RISK_SCORING', 'VALUATION_ENGINE',
  'CAPITAL_ALLOCATION_OPTIMIZATION', 'ACQUISITION_RECOMMENDATION',
  'CEO_DASHBOARD_RECOMMENDATION', 'BOARD_STRATEGIC_SUGGESTION',
  'EXPANSION_OPPORTUNITY', 'MARKET_ENTRY_PREDICTION', 'ACQUISITION_TARGET',
] as const;

export const SUBJECT_TYPES = [
  'Player', 'Match', 'Club', 'FranchiseUnit', 'InvestorProfile',
  'InvestmentEntity', 'TrainingSession', 'Platform',
] as const;

export const AI_DECISION_STATUSES = ['GENERATED', 'REVIEWED', 'ACCEPTED', 'REJECTED', 'OVERRIDDEN', 'EXPIRED'] as const;
export const AI_OUTCOMES = ['PENDING', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'UNKNOWN'] as const;
export const AI_URGENCIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const AI_VISIBILITIES = ['CLUB', 'FRANCHISE', 'PLATFORM', 'INVESTOR'] as const;
export const AI_MODEL_PROVIDERS = ['RULE_BASED', 'CLAUDE', 'HYBRID', 'EXTERNAL'] as const;
export const AI_FEEDBACK_TYPES = ['ACCEPTANCE', 'OVERRIDE', 'CORRECTION', 'OUTCOME_REPORT', 'RATING'] as const;

// ─── Model registry ──────────────────────────────────────────────────────────

export const createModelSchema = z
  .object({
    slug: z.string().min(2).max(80).regex(/^[a-z0-9._-]+$/, 'lowercase, digits, ._-'),
    name: z.string().min(1).max(200),
    domain: z.enum(AI_DOMAINS),
    decisionType: z.enum(AI_DECISION_TYPES),
    version: z.string().min(1).max(40).regex(/^[\d.a-zA-Z+-]+$/),
    provider: z.enum(AI_MODEL_PROVIDERS),
    description: z.string().max(5000).optional().nullable(),
    inputSchema: z.record(z.unknown()),
    outputSchema: z.record(z.unknown()),
    parameters: z.record(z.unknown()),
  })
  .strict();

export const updateModelSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional().nullable(),
    parameters: z.record(z.unknown()).optional(),
    isActive: z.boolean().optional(),
    deprecatedAt: iso8601.optional().nullable(),
  })
  .strict();

export const activateModelSchema = z
  .object({
    deactivatePeers: z.boolean().optional().default(true),
    notes: z.string().max(2000).optional().nullable(),
  })
  .strict();

// ─── Decision request ────────────────────────────────────────────────────────

export const decisionRequestSchema = z
  .object({
    decisionType: z.enum(AI_DECISION_TYPES),
    subject: z
      .object({
        type: z.enum(SUBJECT_TYPES),
        id: z.string().min(1).max(64),
      })
      .strict(),
    scopeContext: z
      .object({
        clubId: cuidOrUuid.optional().nullable(),
        franchiseUnitId: cuidOrUuid.optional().nullable(),
        investorId: cuidOrUuid.optional().nullable(),
        entityId: cuidOrUuid.optional().nullable(),
      })
      .strict()
      .optional()
      .default({}),
    inputs: z.record(z.union([z.number(), z.boolean(), z.string(), z.null()])).optional(),
    options: z
      .object({
        useLlm: z.boolean().optional(),
        forceModelSlug: z.string().min(2).max(80).optional(),
        forceModelVersion: z.string().min(1).max(40).optional(),
        persist: z.boolean().optional(),
        cacheTtlSec: z.number().int().min(0).max(86400).optional(),
        visibility: z.enum(AI_VISIBILITIES).optional(),
      })
      .strict()
      .optional()
      .default({}),
  })
  .strict();

// ─── Review / feedback ───────────────────────────────────────────────────────

export const reviewDecisionSchema = z
  .object({
    status: z.enum(['REVIEWED', 'ACCEPTED', 'REJECTED', 'OVERRIDDEN']),
    notes: z.string().min(1).max(5000),
  })
  .strict();

export const recordOutcomeSchema = z
  .object({
    outcome: z.enum(AI_OUTCOMES),
    notes: z.string().max(5000).optional().nullable(),
    occurredAt: iso8601.optional(),
  })
  .strict();

export const submitFeedbackSchema = z
  .object({
    type: z.enum(AI_FEEDBACK_TYPES),
    rating: z.number().int().min(1).max(5).optional().nullable(),
    notes: z.string().max(5000).optional().nullable(),
    correctedAction: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

// ─── History query ───────────────────────────────────────────────────────────

export const historyQuerySchema = z
  .object({
    domain: z.enum(AI_DOMAINS).optional(),
    decisionType: z.enum(AI_DECISION_TYPES).optional(),
    subjectType: z.enum(SUBJECT_TYPES).optional(),
    subjectId: z.string().min(1).max(64).optional(),
    clubId: cuidOrUuid.optional(),
    franchiseUnitId: cuidOrUuid.optional(),
    investorId: cuidOrUuid.optional(),
    entityId: cuidOrUuid.optional(),
    status: z.enum(AI_DECISION_STATUSES).optional(),
    outcome: z.enum(AI_OUTCOMES).optional(),
    urgency: z.enum(AI_URGENCIES).optional(),
    minScore: z.coerce.number().min(0).max(100).optional(),
    from: iso8601.optional(),
    to: iso8601.optional(),
    cursor: cuidOrUuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

// ─── Audit query ─────────────────────────────────────────────────────────────

export const aiAuditQuerySchema = z
  .object({
    decisionId: cuidOrUuid.optional(),
    modelId: cuidOrUuid.optional(),
    action: z.string().min(1).max(80).optional(),
    category: z.enum(['MODEL', 'DECISION', 'REVIEW', 'FEEDBACK', 'INFRA', 'ACCESS']).optional(),
    from: iso8601.optional(),
    to: iso8601.optional(),
    cursor: cuidOrUuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

// ─── Inferred input types ────────────────────────────────────────────────────

export type CreateModelInput = z.infer<typeof createModelSchema>;
export type UpdateModelInput = z.infer<typeof updateModelSchema>;
export type ActivateModelInput = z.infer<typeof activateModelSchema>;
export type DecisionRequestInput = z.infer<typeof decisionRequestSchema>;
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
export type RecordOutcomeInput = z.infer<typeof recordOutcomeSchema>;
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;
export type HistoryQueryInput = z.infer<typeof historyQuerySchema>;
export type AIAuditQueryInput = z.infer<typeof aiAuditQuerySchema>;
