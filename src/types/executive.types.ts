// Familista — Executive OS · Integration Layer
// File location: src/types/executive.types.ts
//
// Types for the executive orchestration layer. Workflow steps and dashboard
// aggregates are the most JSON-heavy structures — strict types are enforced
// at the application boundary.

import type {
  BoardResolution,
  BoardResolutionStatus,
  BoardVote,
  BoardVoteDecision,
  ExecutiveAssignment,
  ExecutiveAudit,
  ExecutiveAuditCategory,
  ExecutiveAuditResult,
  ExecutivePriority,
  ExecutiveRole,
  ExecutiveStepStatus,
  ExecutiveWorkflow,
  ExecutiveWorkflowKind,
  ExecutiveWorkflowStatus,
  ForecastScenario,
  ForecastScope,
  RevenueForecast,
  RiskAlert,
  RiskAlertStatus,
  RiskCategory,
  RiskSeverity,
  SponsorOpportunity,
  SponsorPipelineEvent,
  SponsorPipelineStage,
  SponsorTier,
  WorkflowAttestation,
  WorkflowStep,
  AttestationDecision,
  PlatformRole,
} from '@prisma/client';

// ─── Access scope ────────────────────────────────────────────────────────────

export type ExecutiveAccessScope = {
  isPlatformAdmin: boolean;
  platformRole: PlatformRole | null;
  userId: string;
  clubId: string | null;
  executiveRole: ExecutiveRole | null;
  voteWeight: number;
  executiveAssignmentId: string | null;
};

export type ExecutiveActor = {
  userId: string;
  scope: ExecutiveAccessScope;
  ipAddress: string | null;
  userAgent: string | null;
};

// ─── Step executor contract ──────────────────────────────────────────────────

export type StepEngine =
  | 'FRANCHISE'
  | 'INVESTOR'
  | 'AI'
  | 'WHITELABEL'
  | 'ADMIN'
  | 'STRIPE'
  | 'VISION'
  | 'EXECUTIVE'
  | 'CUSTOM';

export type StepActionId =
  // Franchise
  | 'FRANCHISE.CREATE_EXPANSION_REQUEST'
  | 'FRANCHISE.DECIDE_EXPANSION_REQUEST'
  | 'FRANCHISE.COMPLETE_EXPANSION_REQUEST'
  | 'FRANCHISE.CREATE_ACQUISITION_REQUEST'
  | 'FRANCHISE.SUBMIT_ACQUISITION'
  | 'FRANCHISE.DECIDE_ACQUISITION'
  | 'FRANCHISE.INITIATE_TRANSFER'
  | 'FRANCHISE.EXECUTE_TRANSFER'
  | 'FRANCHISE.GENERATE_SNAPSHOT'
  | 'FRANCHISE.UPSERT_COMPLIANCE_CHECK'
  // Investor
  | 'INVESTOR.CREATE_INVESTMENT'
  | 'INVESTOR.FUND_INVESTMENT'
  | 'INVESTOR.CREATE_ROUND'
  | 'INVESTOR.OPEN_ROUND'
  | 'INVESTOR.CLOSE_ROUND'
  | 'INVESTOR.CONVERT_SAFES'
  | 'INVESTOR.SET_VALUATION'
  | 'INVESTOR.CREATE_EXIT'
  | 'INVESTOR.EXECUTE_EXIT'
  | 'INVESTOR.RECORD_DISTRIBUTION'
  // AI
  | 'AI.SCORE_INJURY_RISK'
  | 'AI.SCORE_FRANCHISE_INVESTMENT'
  | 'AI.SCORE_TERRITORY_RISK'
  | 'AI.SCORE_REGIONAL_EXPANSION'
  | 'AI.SCORE_ACQUISITION'
  | 'AI.SCORE_VALUATION'
  | 'AI.SCORE_FINANCIAL_HEALTH'
  | 'AI.SCORE_SPONSORSHIP'
  | 'AI.REVIEW_DECISION'
  // White-label
  | 'WHITELABEL.UPDATE_BRAND'
  | 'WHITELABEL.APPLY_PALETTE'
  // Admin
  | 'ADMIN.CREATE_SUBSCRIPTION_OVERRIDE'
  | 'ADMIN.REVOKE_SUBSCRIPTION_OVERRIDE'
  | 'ADMIN.UPDATE_LIMITS'
  // Executive (internal)
  | 'EXECUTIVE.OPEN_BOARD_RESOLUTION'
  | 'EXECUTIVE.AWAIT_BOARD_RESOLUTION'
  | 'EXECUTIVE.SET_SPONSOR_STAGE'
  // Custom (human-completed step)
  | 'CUSTOM.HUMAN_REVIEW'
  | 'CUSTOM.NOOP';

export type StepExecutionResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  requiresHuman?: boolean;
};

// ─── Workflow templates ─────────────────────────────────────────────────────

export type WorkflowTemplateStep = {
  order: number;
  name: string;
  description?: string;
  engine: StepEngine;
  action: StepActionId;
  paramsSchema: Record<string, unknown>;
  requiresHuman?: boolean;
  conditionalOn?: { stepOrder: number; resultPath: string; equals: unknown };
};

export type WorkflowTemplate = {
  slug: string;
  kind: ExecutiveWorkflowKind;
  title: string;
  description: string;
  requiredAttestations: ExecutiveRole[];
  defaultPriority: ExecutivePriority;
  defaultDueInDays: number | null;
  steps: WorkflowTemplateStep[];
};

// ─── Dashboard composites ───────────────────────────────────────────────────

export type ExecutiveDashboard = {
  asOf: string;

  platform: {
    activeClubs: number;
    activeFranchiseUnits: number;
    activeInvestors: number;
    totalAum: number;
    revenue90d: number;
    revenuePrior90d: number;
    growthPct: number | null;
    currency: string;
  };

  workflows: {
    open: number;
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
    stalled: number;
    dueThisWeek: number;
    requiringAttestationFromActor: number;
  };

  board: {
    activeResolutions: number;
    pendingVotesFromActor: number;
    closedThisQuarter: number;
  };

  risks: {
    open: number;
    critical: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    overdue: number;
  };

  sponsors: {
    totalOpportunities: number;
    byStage: Record<string, number>;
    contractedValueActive: number;
    pipelineValue: number;
    currency: string;
  };

  forecast: {
    nextPeriodKey: string;
    base: number;
    optimistic: number;
    pessimistic: number;
    stress: number;
    confidence: number;
    currency: string;
  } | null;

  aiInsights: {
    criticalLast7d: number;
    highLast7d: number;
    topDecisions: Array<{ id: string; domain: string; decisionType: string; score: number; urgency: string; createdAt: string }>;
  };

  expansionOpportunities: Array<{
    territoryId: string;
    territoryName: string;
    fullPath: string;
    opportunityScore: number;
    reasons: string[];
  }>;
};

export type RiskFeed = {
  open: RiskAlert[];
  ackedToday: number;
  resolvedToday: number;
};

export type RevenueForecastResult = {
  forecast: RevenueForecast;
  comparison: {
    priorPeriodActual: number | null;
    deltaPct: number | null;
  };
};

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type {
  ExecutiveAssignment,
  ExecutiveRole,
  ExecutiveWorkflow,
  ExecutiveWorkflowKind,
  ExecutiveWorkflowStatus,
  ExecutivePriority,
  ExecutiveStepStatus,
  WorkflowStep,
  WorkflowAttestation,
  AttestationDecision,
  BoardResolution,
  BoardResolutionStatus,
  BoardVote,
  BoardVoteDecision,
  SponsorOpportunity,
  SponsorTier,
  SponsorPipelineStage,
  SponsorPipelineEvent,
  RevenueForecast,
  ForecastScope,
  ForecastScenario,
  RiskAlert,
  RiskCategory,
  RiskSeverity,
  RiskAlertStatus,
  ExecutiveAudit,
  ExecutiveAuditCategory,
  ExecutiveAuditResult,
};
