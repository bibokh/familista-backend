// Familista — Global Investor Layer
// File location: src/types/investor.types.ts
//
// Shared types for investor services / controllers / middleware and any
// external consumer (Stripe webhook, PDF generator, analytics).

import type {
  InvestorProfile,
  InvestorType,
  InvestorEntityType,
  KycStatus,
  InvestmentEntity,
  InvestmentEntityType,
  InvestmentRound,
  InvestmentRoundType,
  InvestmentRoundStatus,
  Investment,
  InstrumentType,
  InvestmentStatus,
  ShareClass,
  ShareClassCategory,
  CapTableEntry,
  ShareTransfer,
  ShareTransferStatus,
  InvestorRight,
  InvestorRightType,
  BoardSeat,
  BoardSeatRole,
  InvestmentAgreement,
  AgreementType,
  AgreementStatus,
  ExitEvent,
  ExitEventType,
  ExitStatus,
  ExitDistribution,
  InvestorDistribution,
  InvestorDistributionType,
  InvestorDistributionStatus,
  InvestorAudit,
  InvestorAuditCategory,
  PlatformRole,
} from '@prisma/client';

// ─── Access scope ────────────────────────────────────────────────────────────

export type InvestorAccessMode = 'read' | 'write' | 'admin';

export type InvestorScope = {
  isPlatformAdmin: boolean;
  platformRole: PlatformRole | null;
  investorId: string | null;
  ownedEntityIds: Set<string>; // entities the investor has positions in
};

export type InvestorActor = {
  userId: string;
  scope: InvestorScope;
  ipAddress: string | null;
  userAgent: string | null;
};

// ─── Cap table ───────────────────────────────────────────────────────────────

export type CapTablePosition = {
  investor: InvestorProfile;
  shareClass: ShareClass;
  shares: number;
  equityPercent: number;
  fullyDilutedPercent: number;
  votingPercent: number;
  totalCost: number;
  currency: string;
  acquiredVia: string;
  effectiveFrom: Date;
};

export type EntityCapTable = {
  entityId: string;
  entityName: string;
  asOf: Date;
  totalSharesIssued: number;
  fullyDilutedShares: number;
  totalVotingShares: number;
  byInvestor: CapTablePosition[];
  byShareClass: Array<{
    shareClass: ShareClass;
    sharesIssued: number;
    sharesAuthorized: number;
    equityPercent: number;
    votingPercent: number;
  }>;
  isFullyAllocated: boolean;
  currentValuation: number | null;
};

// ─── Round dilution preview ──────────────────────────────────────────────────

export type DilutionPreview = {
  roundId: string | null;
  entityId: string;
  preMoneyValuation: number | null;
  postMoneyValuation: number | null;
  sharesIssuedThisRound: number;
  newTotalShares: number;
  pricePerShare: number | null;
  preRoundPositions: Array<{
    investorId: string;
    investorName: string;
    sharesBefore: number;
    equityBefore: number;
    sharesAfter: number;
    equityAfter: number;
    dilutionPct: number;
  }>;
};

// ─── Exit waterfall ──────────────────────────────────────────────────────────

export type WaterfallAllocation = {
  investorId: string;
  investorName: string;
  shareClassId: string;
  shareClassName: string;
  shares: number;
  liquidationPrefAmount: number;
  participationAmount: number;
  commonAmount: number;
  totalAmount: number;
  currency: string;
};

export type WaterfallResult = {
  exitId: string | null;
  entityId: string;
  proceedsAmount: number;
  currency: string;
  totalDistributed: number;
  remainingProceeds: number;
  allocations: WaterfallAllocation[];
};

// ─── Performance / dashboard ─────────────────────────────────────────────────

export type InvestorPortfolioPosition = {
  investmentId: string;
  entityId: string;
  entityName: string;
  entityType: InvestmentEntityType;
  instrumentType: InstrumentType;
  status: InvestmentStatus;
  committedAmount: number;
  fundedAmount: number;
  currency: string;
  currentValue: number | null;
  unrealizedGain: number | null;
  realizedDistributions: number;
  netIrr: number | null;
  multiple: number | null;
  commitDate: Date;
  shareClass: string | null;
  shares: number | null;
  equityPercent: number | null;
};

export type InvestorDashboard = {
  investorId: string;
  investorName: string;
  asOf: Date;

  totals: {
    committed: number;
    funded: number;
    currentValue: number;
    realizedDistributions: number;
    unrealizedGain: number;
    netReturn: number;
    multiple: number | null;
    currency: string;
  };

  positions: InvestorPortfolioPosition[];

  cashFlow: {
    inflowsTotal: number;
    inflowsCount: number;
    lastDistributionAt: Date | null;
    nextEstimatedAt: Date | null;
  };

  governance: {
    boardSeats: number;
    rights: number;
    activeAgreements: number;
  };

  expansion: {
    franchiseUnits: number;
    clubs: number;
    academies: number;
  };
};

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type {
  InvestorProfile,
  InvestorType,
  InvestorEntityType,
  KycStatus,
  InvestmentEntity,
  InvestmentEntityType,
  InvestmentRound,
  InvestmentRoundType,
  InvestmentRoundStatus,
  Investment,
  InstrumentType,
  InvestmentStatus,
  ShareClass,
  ShareClassCategory,
  CapTableEntry,
  ShareTransfer,
  ShareTransferStatus,
  InvestorRight,
  InvestorRightType,
  BoardSeat,
  BoardSeatRole,
  InvestmentAgreement,
  AgreementType,
  AgreementStatus,
  ExitEvent,
  ExitEventType,
  ExitStatus,
  ExitDistribution,
  InvestorDistribution,
  InvestorDistributionType,
  InvestorDistributionStatus,
  InvestorAudit,
  InvestorAuditCategory,
};
