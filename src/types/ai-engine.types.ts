// Familista — AI Decision Engine
// File location: src/types/ai-engine.types.ts
//
// Shared types for the AI Decision Engine. Defines the strict shape of the
// JSON columns on AIDecision (features / evidence / recommendation /
// alternatives) so the wire format is enforced at the application layer
// while the database stays schemaless on those payloads.

import type {
  AIDomain,
  AIDecisionType,
  AIDecisionStatus,
  AIDecisionVisibility,
  AIUrgency,
  AIOutcome,
  AIModelProvider,
  AIFeedbackType,
  AIAuditCategory,
  AIAuditResult,
  PlatformRole,
} from '@prisma/client';

// ─── Subject + scope ─────────────────────────────────────────────────────────

export type AISubjectType =
  | 'Player'
  | 'Match'
  | 'Club'
  | 'FranchiseUnit'
  | 'InvestorProfile'
  | 'InvestmentEntity'
  | 'TrainingSession'
  | 'Platform';

export type AISubjectRef = { type: AISubjectType; id: string };

export type AIActorRole =
  | 'CLUB_ADMIN'
  | 'HEAD_COACH'
  | 'ASSISTANT_COACH'
  | 'ANALYST'
  | 'MEDICAL_STAFF'
  | 'SCOUT'
  | 'INVESTOR'
  | 'PLATFORM_ADMIN'
  | 'SYSTEM';

export type AIAccessScope = {
  isPlatformAdmin: boolean;
  platformRole: PlatformRole | null;
  userId: string;
  clubId: string | null;
  userRole: AIActorRole | null;
  investorId: string | null;
  franchiseUnitIds: Set<string>;
  entityIds: Set<string>;
};

export type AIActor = {
  userId: string;
  scope: AIAccessScope;
  ipAddress: string | null;
  userAgent: string | null;
};

// ─── Feature / evidence / recommendation contracts ──────────────────────────

export type FeatureValue = number | boolean | string | null;
export type FeatureMap = Record<string, FeatureValue>;

export type ScoreFactor = {
  name: string;
  description?: string;
  value: FeatureValue;
  contribution: number;          // -100 to +100, signed
  weight?: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
};

export type RecommendationAction = {
  kind: string;                   // e.g. 'REST_PLAYER' | 'BUY_PLAYER' | 'OPEN_ROUND'
  target?: { type: AISubjectType; id: string; label?: string };
  params?: Record<string, unknown>;
  label: string;                  // human-readable
};

export type Alternative = {
  action: RecommendationAction;
  score: number;
  rationale: string;
};

// ─── Decision request / result ──────────────────────────────────────────────

export type DecisionRequest<F extends FeatureMap = FeatureMap> = {
  decisionType: AIDecisionType;
  subject: AISubjectRef;
  scopeContext: {
    clubId?: string | null;
    franchiseUnitId?: string | null;
    investorId?: string | null;
    entityId?: string | null;
  };
  inputs?: F;                     // optional overrides; falls back to extracted features
  options?: {
    useLlm?: boolean;             // default true if adapter is configured
    forceModelSlug?: string;
    forceModelVersion?: string;
    persist?: boolean;            // default true
    cacheTtlSec?: number;
    visibility?: AIDecisionVisibility;
  };
};

export type DecisionResult<F extends FeatureMap = FeatureMap> = {
  id: string;
  domain: AIDomain;
  decisionType: AIDecisionType;
  modelSlug: string;
  modelVersion: string;
  subject: AISubjectRef;

  score: number;
  confidence: number;
  urgency: AIUrgency;

  features: F;
  evidence: ScoreFactor[];
  recommendation: RecommendationAction;
  alternatives: Alternative[];
  warnings: string[];

  rationale: string;
  status: AIDecisionStatus;
  visibility: AIDecisionVisibility;

  expiresAt: Date | null;
  createdAt: Date;
  inputHash: string;
  llm: {
    used: boolean;
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number | null;
  };
};

// ─── Scoring primitives ─────────────────────────────────────────────────────

export type DeterministicScore = {
  score: number;                  // 0-100
  confidence: number;             // 0-1
  factors: ScoreFactor[];
  warnings: string[];
  urgency: AIUrgency;
  recommendation: RecommendationAction;
  alternatives?: Alternative[];
};

// ─── Domain feature shapes ──────────────────────────────────────────────────

export type PlayerFeatures = FeatureMap & {
  playerId: string;
  age: number | null;
  position: string;
  overallRating: number;
  potential: number;
  condition: number;
  isInjured: boolean;
  contractDaysLeft: number | null;
  marketValue: number;
  weeklyWage: number;
  recentMatchCount: number;
  recentMatchRatingAvg: number | null;
  recentGoalsPer90: number | null;
  recentAssistsPer90: number | null;
  recentMinutesPlayed: number;
  avgPlayerLoad30d: number | null;
  maxPlayerLoad30d: number | null;
  playerLoadDelta14dVs30d: number | null;
  avgRiskScore30d: number | null;
  daysSinceLastInjury: number | null;
  injuryCount365d: number;
  avgInjurySeverityScore: number | null;
  teamAvgRating: number | null;
  positionAvgRating: number | null;
};

export type MatchFeatures = FeatureMap & {
  matchId: string;
  competition: string;
  scheduledAt: string;
  isHome: boolean;
  daysToMatch: number;
  opponentName: string;
  recentResultsForm: number;
  opponentRecentForm: number | null;
};

export type ClubFeatures = FeatureMap & {
  clubId: string;
  plan: string;
  subscriptionStatus: string;
  revenue90d: number;
  revenuePrior90d: number;
  expense90d: number;
  netCashFlow90d: number;
  playerCount: number;
  injuredCount: number;
  injuryRate: number;
  averageSquadAge: number | null;
  wagesPerMonth: number;
  contractsExpiringNext180d: number;
  overdueViolations: number;
};

export type FranchiseFeatures = FeatureMap & {
  unitId: string;
  level: string;
  status: string;
  clubsActive: number;
  clubsTotal: number;
  revenue90d: number;
  revenuePrior90d: number;
  revenueGrowthPct: number | null;
  violationsOpen: number;
  contractsExpiringSoon: number;
  complianceScore: number | null;
  childUnits: number;
  hasExclusiveRights: boolean;
};

export type InvestorFeatures = FeatureMap & {
  investorId: string;
  type: string;
  kycStatus: string;
  totalCommitted: number;
  totalFunded: number;
  totalRealized: number;
  currentValue: number;
  multiple: number | null;
  netIrrEstimate: number | null;
  portfolioConcentration: number;
  exposureByEntityType: string;
  daysSinceLastInvestment: number | null;
};

export type EntityFeatures = FeatureMap & {
  entityId: string;
  entityType: string;
  currentValuation: number | null;
  totalSharesIssued: number;
  fullyDilutedShares: number;
  activeRoundCount: number;
  totalRaisedToDate: number;
  revenue90d: number;
  growthPct: number | null;
};

export type ExecutiveFeatures = FeatureMap & {
  platformId: string;
  platformName: string;
  totalRevenue90d: number;
  totalRevenuePrior90d: number;
  growthPct: number | null;
  activeClubs: number;
  activeFranchiseUnits: number;
  activeInvestors: number;
  totalAum: number;
  openCriticalViolations: number;
  expansionOpportunityCount: number;
};

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type {
  AIDomain,
  AIDecisionType,
  AIDecisionStatus,
  AIDecisionVisibility,
  AIUrgency,
  AIOutcome,
  AIModelProvider,
  AIFeedbackType,
  AIAuditCategory,
  AIAuditResult,
};
