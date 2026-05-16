// Familista — Executive OS · Integration Layer
// File location: src/utils/executive.validators.ts
//
// Zod schemas for every executive endpoint. Strict mode — unknown keys rejected.

import { z } from 'zod';

const cuidOrUuid = z.string().min(8).max(64);
const iso8601 = z.string().datetime();
const currency = z.string().length(3).regex(/^[A-Z]{3}$/);

export const EXECUTIVE_ROLES = ['CEO', 'CFO', 'COO', 'CHAIR', 'BOARD_MEMBER', 'INVESTOR_LEAD', 'COUNSEL', 'STRATEGIC_ADVISOR'] as const;
export const WORKFLOW_KINDS = [
  'SPONSOR_ONBOARDING', 'ACQUISITION', 'TERRITORY_EXPANSION', 'CAPITAL_DEPLOYMENT',
  'RISK_INTERVENTION', 'PARTNERSHIP', 'PLATFORM_LAUNCH', 'STRATEGIC_INITIATIVE',
  'GOVERNANCE_ACTION', 'CUSTOM',
] as const;
export const WORKFLOW_STATUSES = ['DRAFT', 'IN_REVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'IN_EXECUTION', 'COMPLETED', 'REJECTED', 'CANCELLED', 'STALLED'] as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const STEP_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED', 'BLOCKED', 'REQUIRES_HUMAN'] as const;
export const ATTESTATION_DECISIONS = ['APPROVE', 'REJECT', 'ABSTAIN'] as const;
export const RESOLUTION_STATUSES = ['DRAFT', 'CIRCULATING', 'VOTING', 'PASSED', 'FAILED', 'WITHDRAWN'] as const;
export const VOTE_DECISIONS = ['FOR', 'AGAINST', 'ABSTAIN'] as const;
export const SPONSOR_TIERS = ['PRINCIPAL', 'PLATINUM', 'GOLD', 'SILVER', 'BRONZE', 'COMMUNITY'] as const;
export const SPONSOR_STAGES = ['PROSPECT', 'QUALIFIED', 'PROPOSAL_SENT', 'IN_NEGOTIATION', 'CONTRACT_SIGNED', 'ACTIVE', 'RENEWAL', 'CHURNED', 'REJECTED'] as const;
export const RISK_CATEGORIES = ['FINANCIAL', 'OPERATIONAL', 'LEGAL', 'REPUTATIONAL', 'STRATEGIC', 'TECHNICAL', 'REGULATORY'] as const;
export const RISK_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const RISK_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'WAIVED', 'ESCALATED'] as const;
export const FORECAST_SCOPES = ['PLATFORM', 'FRANCHISE_UNIT', 'CLUB', 'INVESTMENT_ENTITY'] as const;
export const FORECAST_SCENARIOS = ['BASE', 'OPTIMISTIC', 'PESSIMISTIC', 'STRESS'] as const;
export const AUDIT_CATEGORIES = ['WORKFLOW', 'ATTESTATION', 'BOARD', 'SPONSOR', 'FORECAST', 'RISK', 'ACCESS', 'AGGREGATE', 'OTHER'] as const;

// ─── Executive RBAC ──────────────────────────────────────────────────────────

export const upsertAssignmentSchema = z
  .object({
    userId: cuidOrUuid,
    role: z.enum(EXECUTIVE_ROLES),
    voteWeight: z.number().min(0).max(10).optional().default(1.0),
    effectiveFrom: iso8601.optional(),
    effectiveTo: iso8601.optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .strict();

// ─── Workflows ───────────────────────────────────────────────────────────────

export const createWorkflowSchema = z
  .object({
    kind: z.enum(WORKFLOW_KINDS),
    templateSlug: z.string().min(2).max(80).optional().nullable(),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional().nullable(),
    priority: z.enum(PRIORITIES).optional().default('NORMAL'),
    clubId: cuidOrUuid.optional().nullable(),
    franchiseUnitId: cuidOrUuid.optional().nullable(),
    investorId: cuidOrUuid.optional().nullable(),
    entityId: cuidOrUuid.optional().nullable(),
    sponsorOpportunityId: cuidOrUuid.optional().nullable(),
    matchId: cuidOrUuid.optional().nullable(),
    decisionIds: z.array(cuidOrUuid).max(50).optional().default([]),
    dueByAt: iso8601.optional().nullable(),
    payload: z.record(z.unknown()).optional().default({}),
    customSteps: z
      .array(
        z
          .object({
            name: z.string().min(1).max(160),
            description: z.string().max(2000).optional().nullable(),
            engine: z.string().min(2).max(40),
            action: z.string().min(2).max(80),
            params: z.record(z.unknown()).optional().default({}),
          })
          .strict(),
      )
      .max(40)
      .optional(),
  })
  .strict();

export const transitionWorkflowSchema = z
  .object({
    status: z.enum(WORKFLOW_STATUSES),
    notes: z.string().max(2000).optional().nullable(),
  })
  .strict();

export const updateStepSchema = z
  .object({
    status: z.enum(STEP_STATUSES).optional(),
    result: z.record(z.unknown()).optional().nullable(),
    error: z.string().max(5000).optional().nullable(),
    blockedReason: z.string().max(2000).optional().nullable(),
  })
  .strict();

export const attestSchema = z
  .object({
    decision: z.enum(ATTESTATION_DECISIONS),
    notes: z.string().max(5000).optional().nullable(),
    signatureRef: z.string().max(200).optional().nullable(),
  })
  .strict();

// ─── Board ───────────────────────────────────────────────────────────────────

export const createResolutionSchema = z
  .object({
    title: z.string().min(1).max(200),
    resolutionText: z.string().min(10).max(20_000),
    workflowId: cuidOrUuid.optional().nullable(),
    quorumRequired: z.number().int().min(1).max(50).optional().default(3),
    passingMajority: z.number().min(0.5).max(1).optional().default(0.5),
    votingClosesAt: iso8601.optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const transitionResolutionSchema = z
  .object({
    status: z.enum(RESOLUTION_STATUSES),
    notes: z.string().max(2000).optional().nullable(),
    effectiveAt: iso8601.optional().nullable(),
  })
  .strict();

export const castVoteSchema = z
  .object({
    decision: z.enum(VOTE_DECISIONS),
    rationale: z.string().max(5000).optional().nullable(),
    signatureRef: z.string().max(200).optional().nullable(),
  })
  .strict();

// ─── Sponsor ────────────────────────────────────────────────────────────────

export const createSponsorSchema = z
  .object({
    name: z.string().min(1).max(200),
    tier: z.enum(SPONSOR_TIERS),
    clubId: cuidOrUuid.optional().nullable(),
    franchiseUnitId: cuidOrUuid.optional().nullable(),
    contactName: z.string().max(160).optional().nullable(),
    contactEmail: z.string().email().optional().nullable(),
    contactPhone: z.string().max(40).optional().nullable(),
    websiteUrl: z.string().url().optional().nullable(),
    industry: z.string().max(80).optional().nullable(),
    countryCode: z.string().length(2).regex(/^[A-Z]{2}$/).optional().nullable(),
    proposedValue: z.number().min(0).max(1_000_000_000).optional().nullable(),
    currency: currency.optional().default('EUR'),
    termMonths: z.number().int().min(1).max(120).optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const updateSponsorSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    tier: z.enum(SPONSOR_TIERS).optional(),
    contactName: z.string().max(160).optional().nullable(),
    contactEmail: z.string().email().optional().nullable(),
    contactPhone: z.string().max(40).optional().nullable(),
    websiteUrl: z.string().url().optional().nullable(),
    industry: z.string().max(80).optional().nullable(),
    countryCode: z.string().length(2).regex(/^[A-Z]{2}$/).optional().nullable(),
    proposedValue: z.number().min(0).optional().nullable(),
    contractedValue: z.number().min(0).optional().nullable(),
    currency: currency.optional(),
    termMonths: z.number().int().min(1).max(120).optional().nullable(),
    startsAt: iso8601.optional().nullable(),
    endsAt: iso8601.optional().nullable(),
    agreementUrl: z.string().url().optional().nullable(),
    agreementChecksum: z.string().max(128).optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const transitionSponsorStageSchema = z
  .object({
    stage: z.enum(SPONSOR_STAGES),
    notes: z.string().max(5000).optional().nullable(),
  })
  .strict();

// ─── Forecast ────────────────────────────────────────────────────────────────

export const generateForecastSchema = z
  .object({
    scope: z.enum(FORECAST_SCOPES),
    scopeId: cuidOrUuid.optional().nullable(),
    periodKey: z.string().min(4).max(20).regex(/^\d{4}(-(Q[1-4]|\d{2}))?$/),
    periodStartAt: iso8601,
    periodEndAt: iso8601,
    scenarios: z.array(z.enum(FORECAST_SCENARIOS)).min(1).max(FORECAST_SCENARIOS.length).optional().default(['BASE', 'OPTIMISTIC', 'PESSIMISTIC', 'STRESS']),
    currency: currency.optional().default('EUR'),
    assumptions: z.record(z.unknown()).optional().default({}),
  })
  .strict();

// ─── Risk ────────────────────────────────────────────────────────────────────

export const createRiskAlertSchema = z
  .object({
    category: z.enum(RISK_CATEGORIES),
    severity: z.enum(RISK_SEVERITIES),
    title: z.string().min(1).max(200),
    description: z.string().min(4).max(5000),
    clubId: cuidOrUuid.optional().nullable(),
    franchiseUnitId: cuidOrUuid.optional().nullable(),
    investorId: cuidOrUuid.optional().nullable(),
    entityId: cuidOrUuid.optional().nullable(),
    sourceEngine: z.string().min(2).max(40),
    sourceRef: z.string().max(120).optional().nullable(),
    fingerprint: z.string().min(4).max(160),
    score: z.number().min(0).max(100).optional().nullable(),
    dueByAt: iso8601.optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const updateRiskAlertSchema = z
  .object({
    status: z.enum(RISK_STATUSES).optional(),
    severity: z.enum(RISK_SEVERITIES).optional(),
    resolution: z.string().max(5000).optional().nullable(),
    workflowId: cuidOrUuid.optional().nullable(),
    dueByAt: iso8601.optional().nullable(),
  })
  .strict();

// ─── Audit query ─────────────────────────────────────────────────────────────

export const executiveAuditQuerySchema = z
  .object({
    workflowId: cuidOrUuid.optional(),
    resolutionId: cuidOrUuid.optional(),
    alertId: cuidOrUuid.optional(),
    userId: cuidOrUuid.optional(),
    action: z.string().min(1).max(80).optional(),
    category: z.enum(AUDIT_CATEGORIES).optional(),
    from: iso8601.optional(),
    to: iso8601.optional(),
    cursor: cuidOrUuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

// ─── Inferred types ──────────────────────────────────────────────────────────

export type UpsertAssignmentInput = z.infer<typeof upsertAssignmentSchema>;
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type TransitionWorkflowInput = z.infer<typeof transitionWorkflowSchema>;
export type UpdateStepInput = z.infer<typeof updateStepSchema>;
export type AttestInput = z.infer<typeof attestSchema>;
export type CreateResolutionInput = z.infer<typeof createResolutionSchema>;
export type TransitionResolutionInput = z.infer<typeof transitionResolutionSchema>;
export type CastVoteInput = z.infer<typeof castVoteSchema>;
export type CreateSponsorInput = z.infer<typeof createSponsorSchema>;
export type UpdateSponsorInput = z.infer<typeof updateSponsorSchema>;
export type TransitionSponsorStageInput = z.infer<typeof transitionSponsorStageSchema>;
export type GenerateForecastInput = z.infer<typeof generateForecastSchema>;
export type CreateRiskAlertInput = z.infer<typeof createRiskAlertSchema>;
export type UpdateRiskAlertInput = z.infer<typeof updateRiskAlertSchema>;
export type ExecutiveAuditQueryInput = z.infer<typeof executiveAuditQuerySchema>;
