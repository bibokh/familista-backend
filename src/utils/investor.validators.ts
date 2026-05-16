// Familista — Global Investor Layer
// File location: src/utils/investor.validators.ts
//
// Zod input validators. Strict mode — unknown keys rejected.

import { z } from 'zod';

const cuidOrUuid = z.string().min(8).max(64);
const iso8601 = z.string().datetime();
const isoCountry = z.string().length(2).regex(/^[A-Z]{2}$/);
const currency = z.string().length(3).regex(/^[A-Z]{3}$/);
const percent = z.number().min(0).max(100);
const positiveAmount = z.number().min(0).max(1_000_000_000_000);
const positiveInt = z.number().int().min(0);

const optionalText = (max: number) => z.string().max(max).optional().nullable();
const optionalEmail = z.string().email().optional().nullable();
const optionalUrl = z.string().url().optional().nullable();

// ─── Enums (mirror Prisma) ───────────────────────────────────────────────────

export const INVESTOR_TYPES = ['PRIVATE', 'ANGEL', 'STRATEGIC', 'INSTITUTIONAL', 'VENTURE_CAPITAL', 'SOVEREIGN', 'SPORTS_HOLDING'] as const;
export const INVESTOR_ENTITY_TYPES = ['PERSON', 'COMPANY', 'FUND', 'FAMILY_OFFICE', 'SOVEREIGN_FUND', 'HOLDING'] as const;
export const KYC_STATUSES = ['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED'] as const;
export const INVESTMENT_ENTITY_TYPES = ['PLATFORM', 'FRANCHISE_UNIT', 'CLUB', 'ACADEMY'] as const;
export const ROUND_TYPES = ['PRE_SEED', 'SEED', 'SERIES_A', 'SERIES_B', 'SERIES_C', 'SERIES_D', 'GROWTH', 'BRIDGE', 'EXPANSION', 'STRATEGIC', 'ACQUISITION'] as const;
export const ROUND_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'CANCELLED'] as const;
export const INSTRUMENT_TYPES = ['EQUITY', 'SAFE', 'CONVERTIBLE_NOTE', 'REVENUE_SHARE', 'FRANCHISE', 'ACADEMY', 'DIRECT_DEBT'] as const;
export const INVESTMENT_STATUSES = ['COMMITTED', 'FUNDED', 'CONVERTED', 'EXITED', 'DEFAULTED', 'CANCELLED'] as const;
export const SHARE_CLASS_CATEGORIES = ['COMMON', 'PREFERRED', 'FOUNDER', 'OPTION_POOL', 'WARRANT'] as const;
export const ANTI_DILUTION_TYPES = ['NONE', 'FULL_RATCHET', 'WEIGHTED_AVERAGE_BROAD', 'WEIGHTED_AVERAGE_NARROW'] as const;
export const TRANSFER_REASONS = ['SECONDARY_SALE', 'INHERITANCE', 'COURT_ORDER', 'CORPORATE_RESTRUCTURE', 'EXERCISE', 'REPURCHASE'] as const;
export const RIGHT_TYPES = ['BOARD_SEAT', 'OBSERVER_SEAT', 'PRO_RATA', 'ROFR', 'DRAG_ALONG', 'TAG_ALONG', 'INFORMATION', 'VETO', 'LIQUIDATION_PREFERENCE', 'ANTI_DILUTION', 'REDEMPTION', 'MFN'] as const;
export const BOARD_ROLES = ['CHAIR', 'DIRECTOR', 'OBSERVER', 'INDEPENDENT'] as const;
export const AGREEMENT_TYPES = ['TERM_SHEET', 'SAFE', 'CONVERTIBLE_NOTE', 'STOCK_PURCHASE_AGREEMENT', 'SHAREHOLDER_AGREEMENT', 'INVESTORS_RIGHTS', 'VOTING_AGREEMENT', 'ROFR_AGREEMENT', 'SIDE_LETTER', 'EXIT_AGREEMENT', 'REVENUE_SHARE_AGREEMENT'] as const;
export const EXIT_EVENT_TYPES = ['IPO', 'ACQUISITION', 'MERGER', 'BUYBACK', 'SECONDARY_SALE', 'DIVIDEND', 'DISTRIBUTION', 'LIQUIDATION', 'RECAPITALIZATION'] as const;
export const DISTRIBUTION_TYPES = ['REVENUE_SHARE', 'DIVIDEND', 'INTEREST', 'EXIT_PROCEEDS', 'RETURN_OF_CAPITAL'] as const;

// ─── Investor profile ────────────────────────────────────────────────────────

export const createInvestorProfileSchema = z
  .object({
    type: z.enum(INVESTOR_TYPES),
    entityType: z.enum(INVESTOR_ENTITY_TYPES),
    displayName: z.string().min(1).max(160),
    legalName: optionalText(200),
    userId: cuidOrUuid.optional().nullable(),
    linkedFranchiseOwnerId: cuidOrUuid.optional().nullable(),
    contactName: optionalText(160),
    contactEmail: optionalEmail,
    contactPhone: optionalText(40),
    countryCode: isoCountry.optional().nullable(),
    taxId: optionalText(64),
    legalAddress: optionalText(500),
    accredited: z.boolean().optional().default(false),
    aumUsd: positiveAmount.optional().nullable(),
    targetSectors: z.array(z.string().min(1).max(60)).max(50).optional().default([]),
    targetGeographies: z.array(z.string().min(1).max(60)).max(50).optional().default([]),
    notes: optionalText(2000),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const updateInvestorProfileSchema = createInvestorProfileSchema.partial().strict().extend({
  isActive: z.boolean().optional(),
});

export const updateKycStatusSchema = z
  .object({
    kycStatus: z.enum(KYC_STATUSES),
    kycVerifiedAt: iso8601.optional().nullable(),
    kycExpiresAt: iso8601.optional().nullable(),
    notes: optionalText(2000),
  })
  .strict();

// ─── Investment entity ───────────────────────────────────────────────────────

export const createInvestmentEntitySchema = z
  .object({
    type: z.enum(INVESTMENT_ENTITY_TYPES),
    name: z.string().min(1).max(160),
    code: z.string().min(3).max(40).regex(/^[A-Z0-9-]+$/).optional().nullable(),
    description: optionalText(2000),
    franchiseUnitId: cuidOrUuid.optional().nullable(),
    clubId: cuidOrUuid.optional().nullable(),
    currency: currency.optional().default('EUR'),
    currentValuation: positiveAmount.optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.type === 'FRANCHISE_UNIT' ? !!v.franchiseUnitId
      : v.type === 'CLUB' ? !!v.clubId
      : true,
    'franchiseUnitId or clubId required for FRANCHISE_UNIT / CLUB entities',
  );

export const updateInvestmentEntitySchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    description: optionalText(2000),
    currency: currency.optional(),
    metadata: z.record(z.unknown()).optional().nullable(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const setValuationSchema = z
  .object({
    valuation: positiveAmount.refine((v) => v > 0, 'must be > 0'),
    valuationDate: iso8601.optional(),
    notes: optionalText(2000),
  })
  .strict();

// ─── Share classes ───────────────────────────────────────────────────────────

export const createShareClassSchema = z
  .object({
    name: z.string().min(1).max(100),
    code: z.string().min(1).max(40).regex(/^[A-Z0-9_-]+$/),
    category: z.enum(SHARE_CLASS_CATEGORIES),
    seniority: z.number().int().min(0).max(100).optional().default(0),
    liquidationPreference: z.number().min(0).max(10).optional().default(1.0),
    participating: z.boolean().optional().default(false),
    participationCap: z.number().min(1).max(20).optional().nullable(),
    votingMultiple: z.number().min(0).max(100).optional().default(1.0),
    dividendRate: percent.optional().nullable(),
    cumulativeDividends: z.boolean().optional().default(false),
    convertibleToCode: optionalText(40),
    antiDilutionType: z.enum(ANTI_DILUTION_TYPES).optional().default('NONE'),
    totalAuthorized: positiveInt.optional().default(0),
  })
  .strict();

export const updateShareClassSchema = createShareClassSchema.partial().strict();

// ─── Investment rounds ───────────────────────────────────────────────────────

export const createRoundSchema = z
  .object({
    type: z.enum(ROUND_TYPES),
    name: z.string().min(1).max(120),
    currency: currency.optional().default('EUR'),
    targetRaise: positiveAmount.refine((v) => v > 0, 'must be > 0'),
    preMoneyValuation: positiveAmount.optional().nullable(),
    pricePerShare: positiveAmount.optional().nullable(),
    sharesAuthorized: positiveInt.optional().nullable(),
    shareClassId: cuidOrUuid.optional().nullable(),
    leadInvestorId: cuidOrUuid.optional().nullable(),
    terms: z.record(z.unknown()).optional().nullable(),
    notes: optionalText(5000),
  })
  .strict();

export const updateRoundSchema = createRoundSchema.partial().strict();

export const openRoundSchema = z
  .object({ openedAt: iso8601.optional() })
  .strict();

export const closeRoundSchema = z
  .object({
    closedAt: iso8601.optional(),
    notes: optionalText(2000),
  })
  .strict();

// ─── Investments ─────────────────────────────────────────────────────────────

export const createInvestmentSchema = z
  .object({
    investorId: cuidOrUuid,
    entityId: cuidOrUuid,
    roundId: cuidOrUuid.optional().nullable(),
    instrumentType: z.enum(INSTRUMENT_TYPES),
    committedAmount: positiveAmount.refine((v) => v > 0, 'must be > 0'),
    currency: currency.optional().default('EUR'),

    shareClassId: cuidOrUuid.optional().nullable(),
    sharesIssued: positiveInt.optional().nullable(),
    pricePerShare: positiveAmount.optional().nullable(),

    valuationCap: positiveAmount.optional().nullable(),
    discountPercent: percent.optional().nullable(),
    mostFavoredNation: z.boolean().optional().default(false),
    interestRate: percent.optional().nullable(),
    maturityDate: iso8601.optional().nullable(),

    revenueSharePercent: percent.optional().nullable(),
    revenueShareCap: positiveAmount.optional().nullable(),
    revenueShareUntil: iso8601.optional().nullable(),
    revenueCategories: z.array(z.string().min(1).max(40)).max(20).optional().default([]),

    linkedFranchiseUnitId: cuidOrUuid.optional().nullable(),
    linkedClubId: cuidOrUuid.optional().nullable(),

    notes: optionalText(5000),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict()
  .refine(
    (v) => {
      if (v.instrumentType === 'EQUITY' && !v.shareClassId) return false;
      if (v.instrumentType === 'SAFE' && !v.valuationCap && !v.discountPercent) return false;
      if (v.instrumentType === 'CONVERTIBLE_NOTE' && v.interestRate == null) return false;
      if (v.instrumentType === 'REVENUE_SHARE' && v.revenueSharePercent == null) return false;
      return true;
    },
    { message: 'instrument-specific fields missing (shareClassId / valuationCap / interestRate / revenueSharePercent)' },
  );

export const fundInvestmentSchema = z
  .object({
    amount: positiveAmount.refine((v) => v > 0, 'must be > 0'),
    fundedDate: iso8601.optional(),
    paymentRef: optionalText(120),
  })
  .strict();

export const cancelInvestmentSchema = z
  .object({ reason: z.string().min(4).max(500) })
  .strict();

// ─── Share transfers ─────────────────────────────────────────────────────────

export const initiateShareTransferSchema = z
  .object({
    fromInvestorId: cuidOrUuid,
    toInvestorId: cuidOrUuid,
    shareClassId: cuidOrUuid,
    shares: positiveInt.refine((v) => v > 0, 'must be > 0'),
    pricePerShare: positiveAmount.optional().nullable(),
    totalAmount: positiveAmount.optional().nullable(),
    currency: currency.optional().default('EUR'),
    reason: z.enum(TRANSFER_REASONS),
    notes: optionalText(2000),
  })
  .strict()
  .refine((v) => v.fromInvestorId !== v.toInvestorId, 'investors must differ');

export const cancelShareTransferSchema = z
  .object({ reason: z.string().min(4).max(500) })
  .strict();

// ─── Rights + board ──────────────────────────────────────────────────────────

export const grantRightSchema = z
  .object({
    investorId: cuidOrUuid,
    type: z.enum(RIGHT_TYPES),
    terms: z.record(z.unknown()).optional().nullable(),
    effectiveFrom: iso8601.optional(),
    effectiveTo: iso8601.optional().nullable(),
  })
  .strict();

export const updateRightSchema = z
  .object({
    terms: z.record(z.unknown()).optional().nullable(),
    effectiveTo: iso8601.optional().nullable(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const appointBoardSeatSchema = z
  .object({
    investorId: cuidOrUuid.optional().nullable(),
    holderName: z.string().min(1).max(160),
    holderEmail: optionalEmail,
    holderUserId: cuidOrUuid.optional().nullable(),
    role: z.enum(BOARD_ROLES),
    votingPower: z.number().min(0).max(100).optional().default(1.0),
    appointedAt: iso8601.optional(),
    notes: optionalText(2000),
  })
  .strict();

export const vacateBoardSeatSchema = z
  .object({
    departedAt: iso8601.optional(),
    reason: z.string().min(4).max(500),
  })
  .strict();

// ─── Agreements ──────────────────────────────────────────────────────────────

export const createAgreementSchema = z
  .object({
    type: z.enum(AGREEMENT_TYPES),
    investmentId: cuidOrUuid.optional().nullable(),
    roundId: cuidOrUuid.optional().nullable(),
    investorId: cuidOrUuid.optional().nullable(),
    documentUrl: optionalUrl,
    documentChecksum: optionalText(128),
    effectiveFrom: iso8601.optional().nullable(),
    effectiveTo: iso8601.optional().nullable(),
    governingLaw: optionalText(120),
    jurisdiction: optionalText(120),
    terms: z.record(z.unknown()).optional().nullable(),
    notes: optionalText(5000),
  })
  .strict();

export const updateAgreementSchema = createAgreementSchema.partial().strict();

export const signAgreementSchema = z
  .object({
    signedByName: z.string().min(1).max(160),
    signedByTitle: optionalText(120),
    signedAt: iso8601.optional(),
  })
  .strict();

// ─── Exits ───────────────────────────────────────────────────────────────────

export const createExitSchema = z
  .object({
    type: z.enum(EXIT_EVENT_TYPES),
    eventDate: iso8601.optional().nullable(),
    proceedsAmount: positiveAmount.optional().nullable(),
    currency: currency.optional().default('EUR'),
    pricePerShare: positiveAmount.optional().nullable(),
    acquirerName: optionalText(160),
    terms: z.record(z.unknown()).optional().nullable(),
    notes: optionalText(5000),
  })
  .strict();

export const decideExitSchema = z
  .object({
    decision: z.enum(['APPROVED', 'CANCELLED']),
    notes: optionalText(2000),
  })
  .strict();

// ─── Distributions ──────────────────────────────────────────────────────────

export const recordInvestorDistributionSchema = z
  .object({
    investorId: cuidOrUuid,
    investmentId: cuidOrUuid.optional().nullable(),
    type: z.enum(DISTRIBUTION_TYPES),
    period: z.string().min(4).max(20).optional().nullable(),
    periodStartAt: iso8601.optional().nullable(),
    periodEndAt: iso8601.optional().nullable(),
    amount: positiveAmount.refine((v) => v > 0, 'must be > 0'),
    currency: currency.optional().default('EUR'),
    sourceRef: optionalText(120),
    notes: optionalText(2000),
  })
  .strict();

export const computeRevenueShareSchema = z
  .object({
    entityId: cuidOrUuid,
    sourceAmount: positiveAmount.refine((v) => v > 0, 'must be > 0'),
    currency: currency.optional().default('EUR'),
    category: z.string().min(1).max(40),
    sourceRef: optionalText(120),
    period: z.string().min(4).max(20).optional(),
    periodStartAt: iso8601.optional(),
    periodEndAt: iso8601.optional(),
  })
  .strict();

// ─── Audit query ─────────────────────────────────────────────────────────────

export const auditQuerySchema = z
  .object({
    investorId: cuidOrUuid.optional(),
    entityId: cuidOrUuid.optional(),
    action: z.string().min(1).max(80).optional(),
    category: z
      .enum(['PROFILE', 'ENTITY', 'ROUND', 'INVESTMENT', 'CAP_TABLE', 'TRANSFER', 'GOVERNANCE', 'AGREEMENT', 'EXIT', 'DISTRIBUTION', 'OTHER'])
      .optional(),
    from: iso8601.optional(),
    to: iso8601.optional(),
    cursor: cuidOrUuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

// ─── Inferred input types ────────────────────────────────────────────────────

export type CreateInvestorProfileInput = z.infer<typeof createInvestorProfileSchema>;
export type UpdateInvestorProfileInput = z.infer<typeof updateInvestorProfileSchema>;
export type UpdateKycStatusInput = z.infer<typeof updateKycStatusSchema>;
export type CreateInvestmentEntityInput = z.infer<typeof createInvestmentEntitySchema>;
export type UpdateInvestmentEntityInput = z.infer<typeof updateInvestmentEntitySchema>;
export type SetValuationInput = z.infer<typeof setValuationSchema>;
export type CreateShareClassInput = z.infer<typeof createShareClassSchema>;
export type UpdateShareClassInput = z.infer<typeof updateShareClassSchema>;
export type CreateRoundInput = z.infer<typeof createRoundSchema>;
export type UpdateRoundInput = z.infer<typeof updateRoundSchema>;
export type OpenRoundInput = z.infer<typeof openRoundSchema>;
export type CloseRoundInput = z.infer<typeof closeRoundSchema>;
export type CreateInvestmentInput = z.infer<typeof createInvestmentSchema>;
export type FundInvestmentInput = z.infer<typeof fundInvestmentSchema>;
export type CancelInvestmentInput = z.infer<typeof cancelInvestmentSchema>;
export type InitiateShareTransferInput = z.infer<typeof initiateShareTransferSchema>;
export type CancelShareTransferInput = z.infer<typeof cancelShareTransferSchema>;
export type GrantRightInput = z.infer<typeof grantRightSchema>;
export type UpdateRightInput = z.infer<typeof updateRightSchema>;
export type AppointBoardSeatInput = z.infer<typeof appointBoardSeatSchema>;
export type VacateBoardSeatInput = z.infer<typeof vacateBoardSeatSchema>;
export type CreateAgreementInput = z.infer<typeof createAgreementSchema>;
export type UpdateAgreementInput = z.infer<typeof updateAgreementSchema>;
export type SignAgreementInput = z.infer<typeof signAgreementSchema>;
export type CreateExitInput = z.infer<typeof createExitSchema>;
export type DecideExitInput = z.infer<typeof decideExitSchema>;
export type RecordInvestorDistributionInput = z.infer<typeof recordInvestorDistributionSchema>;
export type ComputeRevenueShareInput = z.infer<typeof computeRevenueShareSchema>;
export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
