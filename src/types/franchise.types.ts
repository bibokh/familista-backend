// Familista — Franchise Expansion Engine
// File location: src/types/franchise.types.ts
//
// Shared TypeScript types for franchise services, controllers, middleware,
// and any external consumer (Stripe webhook, PDFKit, scheduled jobs).

import type {
  FranchiseUnit,
  FranchiseLevel,
  FranchiseStatus,
  FranchiseOwner,
  FranchiseOwnership,
  FranchiseOwnershipTransfer,
  Territory,
  TerritoryType,
  TerritoryRight,
  TerritoryRightType,
  ExpansionRequest,
  ExpansionRequestStatus,
  FranchiseAcquisitionRequest,
  AcquisitionStatus,
  RevenueSplitRule,
  RevenueSplitRecipient,
  RevenueDistribution,
  RevenueDistributionAllocation,
  RevenueRecipientType,
  RevenueCategory,
  DistributionStatus,
  AllocationStatus,
  FranchiseContract,
  FranchiseContractRenewal,
  FranchiseContractTermination,
  ContractStatus,
  ContractType,
  FranchiseViolation,
  ViolationStatus,
  ViolationSeverity,
  ComplianceCheck,
  ComplianceCategory,
  ComplianceStatus,
  FranchisePerformanceSnapshot,
  FranchiseAudit,
  FranchiseAuditCategory,
  PlatformRole,
} from '@prisma/client';

// ─── Access scope ────────────────────────────────────────────────────────────

export type AccessMode = 'read' | 'write' | 'primary';

export type FranchiseScope = {
  isPlatformAdmin: boolean;
  platformRole: PlatformRole | null;
  readableUnitIds: Set<string>;
  writableUnitIds: Set<string>;
  primaryUnitIds: Set<string>;
  ownerIds: Set<string>;
};

export type FranchiseActor = {
  userId: string;
  scope: FranchiseScope;
  ipAddress: string | null;
  userAgent: string | null;
};

// ─── Hierarchy view ──────────────────────────────────────────────────────────

export type FranchiseNode = FranchiseUnit & {
  children: FranchiseNode[];
  territory: Territory | null;
  primaryOwner: FranchiseOwner | null;
  totalClubs: number;
  activeViolations: number;
};

export type TerritoryNode = Territory & {
  children: TerritoryNode[];
};

// ─── Ownership cap-table snapshot ────────────────────────────────────────────

export type CapTableEntry = {
  ownership: FranchiseOwnership;
  owner: FranchiseOwner;
};

export type CapTable = {
  unitId: string;
  asOf: Date;
  entries: CapTableEntry[];
  totalEquityPercent: number;
  totalControlPercent: number;
  primaryOwnerId: string | null;
  isFullyAllocated: boolean;
};

// ─── Revenue distribution ────────────────────────────────────────────────────

export type DistributionPreview = {
  ruleId: string | null;
  ruleName: string | null;
  category: RevenueCategory;
  sourceAmount: number;
  sourceCurrency: string;
  allocations: Array<{
    recipientType: RevenueRecipientType;
    recipientUnitId: string | null;
    recipientOwnerId: string | null;
    recipientLabel: string | null;
    percent: number;
    amount: number;
  }>;
  unallocated: number;
};

export type DistributionInput = {
  unitId: string;
  category: RevenueCategory;
  sourceAmount: number;
  sourceCurrency?: string;
  clubId?: string | null;
  sourceFinancialId?: string | null;
  sourceRef?: string | null;
  ruleId?: string | null;
  notes?: string | null;
  trigger?: 'PAYMENT_RECEIVED' | 'INVOICE_ISSUED' | 'MANUAL';
};

// ─── Performance dashboard ───────────────────────────────────────────────────

export type PerformanceMetrics = {
  unitId: string;
  unitCode: string;
  unitName: string;
  level: FranchiseLevel;
  status: FranchiseStatus;
  period: string;
  periodStartAt: Date;
  periodEndAt: Date;

  revenue: {
    total: number;
    currency: string;
    growthPct: number | null;
    priorPeriodTotal: number | null;
    bySource: Record<string, number>;
  };

  growth: {
    clubsActive: number;
    clubsTotal: number;
    clubsAddedInPeriod: number;
    playersTotal: number;
    usersTotal: number;
  };

  performance: {
    netMargin: number | null;
    expensesTotal: number;
  };

  compliance: {
    score: number | null;
    status: ComplianceStatus;
    openViolations: number;
    criticalViolations: number;
  };

  licensing: {
    health: number | null;
    contractsActive: number;
    contractsExpiringSoon: number;
  };

  generatedAt: Date;
};

export type ExpansionOpportunity = {
  territoryId: string;
  territoryName: string;
  territoryType: TerritoryType;
  fullPath: string;
  population: number | null;
  hasActiveUnits: boolean;
  hasExclusiveRight: boolean;
  reservedByUnitId: string | null;
  competitionScore: number;
  opportunityScore: number;
  reasons: string[];
};

// ─── Re-exports (saves import boilerplate elsewhere) ─────────────────────────

export type {
  FranchiseUnit,
  FranchiseLevel,
  FranchiseStatus,
  FranchiseOwner,
  FranchiseOwnership,
  FranchiseOwnershipTransfer,
  Territory,
  TerritoryType,
  TerritoryRight,
  TerritoryRightType,
  ExpansionRequest,
  ExpansionRequestStatus,
  FranchiseAcquisitionRequest,
  AcquisitionStatus,
  RevenueSplitRule,
  RevenueSplitRecipient,
  RevenueDistribution,
  RevenueDistributionAllocation,
  RevenueRecipientType,
  RevenueCategory,
  DistributionStatus,
  AllocationStatus,
  FranchiseContract,
  FranchiseContractRenewal,
  FranchiseContractTermination,
  ContractStatus,
  ContractType,
  FranchiseViolation,
  ViolationStatus,
  ViolationSeverity,
  ComplianceCheck,
  ComplianceCategory,
  ComplianceStatus,
  FranchisePerformanceSnapshot,
  FranchiseAudit,
  FranchiseAuditCategory,
};
