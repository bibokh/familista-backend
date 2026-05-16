// Familista — Franchise Expansion Engine
// File location: src/utils/franchise.validators.ts
//
// Zod schemas for every franchise endpoint. Strict mode — unknown keys rejected.

import { z } from 'zod';

const cuidOrUuid = z.string().min(8).max(64);
const iso8601 = z.string().datetime();
const isoCountry = z.string().length(2).regex(/^[A-Z]{2}$/);
const currency = z.string().length(3).regex(/^[A-Z]{3}$/);
const percent = z.number().min(0).max(100);
const positiveAmount = z.number().min(0).max(1_000_000_000_000);

const optionalText = (max: number) => z.string().max(max).optional().nullable();
const optionalEmail = z.string().email().optional().nullable();

// ─── Enums (mirror Prisma) ───────────────────────────────────────────────────

export const TERRITORY_TYPES = ['COUNTRY', 'STATE', 'REGION', 'CITY', 'DISTRICT'] as const;
export const FRANCHISE_LEVELS = ['MASTER', 'REGIONAL', 'LOCAL', 'ACADEMY'] as const;
export const FRANCHISE_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'IN_RENEWAL', 'TERMINATED'] as const;
export const OWNERSHIP_MODELS = ['SINGLE_OWNER', 'MULTI_OWNER', 'INVESTOR_GROUP', 'HOLDING_COMPANY', 'JOINT_VENTURE'] as const;
export const OWNER_TYPES = ['INDIVIDUAL', 'ENTITY', 'INVESTOR_GROUP'] as const;
export const TERRITORY_RIGHT_TYPES = ['EXCLUSIVE', 'NON_EXCLUSIVE', 'FIRST_REFUSAL'] as const;
export const TRANSFER_REASONS = ['VOLUNTARY', 'ACQUISITION', 'INHERITANCE', 'COURT_ORDER', 'DEFAULT', 'CORPORATE_RESTRUCTURE'] as const;
export const REVENUE_CATEGORIES = ['SUBSCRIPTION', 'TRANSFER', 'SPONSORSHIP', 'MERCHANDISE', 'ACADEMY_FEE', 'MATCH_REVENUE', 'BROADCAST', 'OTHER', 'ALL'] as const;
export const REVENUE_TRIGGERS = ['PAYMENT_RECEIVED', 'INVOICE_ISSUED', 'MANUAL'] as const;
export const REVENUE_RECIPIENT_TYPES = ['HEADQUARTERS', 'MASTER', 'REGIONAL', 'LOCAL', 'ACADEMY', 'INVESTOR', 'SPONSOR', 'OTHER'] as const;
export const CONTRACT_TYPES = ['FRANCHISE_AGREEMENT', 'AREA_DEVELOPMENT', 'OPERATING_AGREEMENT', 'SUB_FRANCHISE', 'AMENDMENT'] as const;
export const TERMINATION_REASONS = ['VOLUNTARY', 'BREACH', 'NON_PAYMENT', 'PERFORMANCE', 'MUTUAL', 'EXPIRATION'] as const;
export const VIOLATION_SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export const VIOLATION_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED', 'WAIVED'] as const;
export const COMPLIANCE_CATEGORIES = ['FINANCIAL', 'OPERATIONAL', 'LEGAL', 'BRAND', 'TRAINING', 'LICENSING'] as const;
export const COMPLIANCE_STATUSES = ['COMPLIANT', 'AT_RISK', 'NON_COMPLIANT', 'NOT_ASSESSED'] as const;

// ─── Territory ───────────────────────────────────────────────────────────────

export const createTerritorySchema = z
  .object({
    type: z.enum(TERRITORY_TYPES),
    code: z.string().min(2).max(16).optional().nullable(),
    name: z.string().min(1).max(160),
    parentId: cuidOrUuid.optional().nullable(),
    population: z.number().int().min(0).optional().nullable(),
    currency: currency.optional().nullable(),
    timezone: optionalText(64),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const updateTerritorySchema = createTerritorySchema.partial().strict();

// ─── Franchise unit ──────────────────────────────────────────────────────────

export const createFranchiseUnitSchema = z
  .object({
    code: z.string().min(3).max(40).regex(/^[A-Z0-9-]+$/, 'uppercase letters, digits, hyphens'),
    name: z.string().min(1).max(160),
    level: z.enum(FRANCHISE_LEVELS),
    parentUnitId: cuidOrUuid.optional().nullable(),
    territoryId: cuidOrUuid.optional().nullable(),
    ownershipModel: z.enum(OWNERSHIP_MODELS).optional().default('SINGLE_OWNER'),
    legalName: optionalText(160),
    taxId: optionalText(64),
    registrationNo: optionalText(64),
    address: optionalText(500),
    countryCode: isoCountry.optional().nullable(),
    currency: currency.optional().default('EUR'),
    foundedAt: iso8601.optional().nullable(),
    launchedAt: iso8601.optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const updateFranchiseUnitSchema = createFranchiseUnitSchema
  .omit({ code: true, level: true })
  .partial()
  .extend({
    status: z.enum(FRANCHISE_STATUSES).optional(),
  })
  .strict();

export const setUnitStatusSchema = z
  .object({
    status: z.enum(FRANCHISE_STATUSES),
    reason: z.string().min(4).max(2000),
  })
  .strict();

// ─── Owner / ownership ──────────────────────────────────────────────────────

export const createOwnerSchema = z
  .object({
    type: z.enum(OWNER_TYPES),
    displayName: z.string().min(1).max(160),
    userId: cuidOrUuid.optional().nullable(),
    contactEmail: optionalEmail,
    contactPhone: optionalText(40),
    legalName: optionalText(160),
    taxId: optionalText(64),
    legalAddress: optionalText(500),
    countryCode: isoCountry.optional().nullable(),
    notes: optionalText(2000),
  })
  .strict();

export const updateOwnerSchema = createOwnerSchema.partial().strict().extend({
  isActive: z.boolean().optional(),
});

export const grantOwnershipSchema = z
  .object({
    ownerId: cuidOrUuid,
    equityPercent: percent,
    controlPercent: percent.optional().nullable(),
    isPrimary: z.boolean().optional().default(false),
    effectiveFrom: iso8601.optional(),
    acquiredVia: z.string().min(2).max(40).optional().default('INITIAL'),
  })
  .strict();

export const revokeOwnershipSchema = z
  .object({
    effectiveTo: iso8601.optional(),
    reason: z.string().min(4).max(500),
  })
  .strict();

// ─── Transfer ────────────────────────────────────────────────────────────────

export const initiateTransferSchema = z
  .object({
    fromOwnerId: cuidOrUuid,
    toOwnerId: cuidOrUuid,
    equityPercent: percent.refine((v) => v > 0, 'must be > 0'),
    controlPercent: percent.optional().nullable(),
    amount: positiveAmount.optional().nullable(),
    currency: currency.optional().default('EUR'),
    reason: z.enum(TRANSFER_REASONS),
    acquisitionRequestId: cuidOrUuid.optional().nullable(),
    notes: optionalText(2000),
  })
  .strict()
  .refine((v) => v.fromOwnerId !== v.toOwnerId, 'fromOwnerId and toOwnerId must differ');

export const cancelTransferSchema = z
  .object({ reason: z.string().min(4).max(500) })
  .strict();

// ─── Territory rights ───────────────────────────────────────────────────────

export const grantTerritoryRightSchema = z
  .object({
    territoryId: cuidOrUuid,
    type: z.enum(TERRITORY_RIGHT_TYPES).optional().default('NON_EXCLUSIVE'),
    level: z.enum(FRANCHISE_LEVELS).optional().nullable(),
    effectiveFrom: iso8601.optional(),
    effectiveTo: iso8601.optional().nullable(),
    notes: optionalText(2000),
  })
  .strict();

export const updateTerritoryRightSchema = z
  .object({
    type: z.enum(TERRITORY_RIGHT_TYPES).optional(),
    level: z.enum(FRANCHISE_LEVELS).optional().nullable(),
    effectiveTo: iso8601.optional().nullable(),
    isActive: z.boolean().optional(),
    notes: optionalText(2000),
  })
  .strict();

// ─── Expansion + acquisition ─────────────────────────────────────────────────

export const createExpansionRequestSchema = z
  .object({
    requestingUnitId: cuidOrUuid,
    targetTerritoryId: cuidOrUuid,
    targetLevel: z.enum(FRANCHISE_LEVELS),
    proposedName: optionalText(160),
    proposedCode: z.string().min(3).max(40).regex(/^[A-Z0-9-]+$/).optional().nullable(),
    businessPlan: z.record(z.unknown()).optional().nullable(),
    financialProjection: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const decideExpansionRequestSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED', 'ESCALATED']),
    notes: z.string().min(4).max(2000),
  })
  .strict();

export const completeExpansionRequestSchema = z
  .object({
    unitCode: z.string().min(3).max(40).regex(/^[A-Z0-9-]+$/),
    unitName: z.string().min(1).max(160),
    notes: optionalText(2000),
  })
  .strict();

export const createAcquisitionRequestSchema = z
  .object({
    targetUnitId: cuidOrUuid,
    acquirerOwnerId: cuidOrUuid.optional().nullable(),
    acquirerName: optionalText(160),
    acquirerEmail: optionalEmail,
    proposedEquity: percent.refine((v) => v > 0, 'must be > 0'),
    proposedAmount: positiveAmount,
    currency: currency.optional().default('EUR'),
    dueDiligence: z.record(z.unknown()).optional().nullable(),
  })
  .strict()
  .refine(
    (v) => !!(v.acquirerOwnerId || (v.acquirerName && v.acquirerEmail)),
    'acquirerOwnerId OR (acquirerName + acquirerEmail) is required',
  );

export const decideAcquisitionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    notes: z.string().min(4).max(2000),
  })
  .strict();

// ─── Revenue split rules ─────────────────────────────────────────────────────

const recipientSchema = z
  .object({
    type: z.enum(REVENUE_RECIPIENT_TYPES),
    recipientUnitId: cuidOrUuid.optional().nullable(),
    recipientOwnerId: cuidOrUuid.optional().nullable(),
    recipientLabel: optionalText(120),
    percent: percent.refine((v) => v > 0, 'percent must be > 0'),
  })
  .strict()
  .refine(
    (v) =>
      v.type === 'INVESTOR'
        ? !!v.recipientOwnerId
        : v.type === 'SPONSOR' || v.type === 'OTHER'
          ? !!v.recipientLabel
          : !!v.recipientUnitId,
    'recipient identifier required: unitId for unit types, ownerId for INVESTOR, label for SPONSOR/OTHER',
  );

export const upsertRevenueSplitRuleSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: optionalText(2000),
    category: z.enum(REVENUE_CATEGORIES).optional().default('ALL'),
    trigger: z.enum(REVENUE_TRIGGERS).optional().default('PAYMENT_RECEIVED'),
    priority: z.number().int().min(0).max(10_000).optional().default(0),
    effectiveFrom: iso8601.optional(),
    effectiveTo: iso8601.optional().nullable(),
    isActive: z.boolean().optional().default(true),
    recipients: z.array(recipientSchema).min(1).max(50),
  })
  .strict()
  .refine(
    (v) => {
      const total = v.recipients.reduce((s, r) => s + r.percent, 0);
      return Math.abs(total - 100) < 0.01;
    },
    { message: 'recipients.percent must sum to 100' },
  );

// ─── Revenue distribution ────────────────────────────────────────────────────

export const recordDistributionSchema = z
  .object({
    unitId: cuidOrUuid,
    category: z.enum(REVENUE_CATEGORIES),
    sourceAmount: positiveAmount.refine((v) => v > 0, 'must be > 0'),
    sourceCurrency: currency.optional().default('EUR'),
    clubId: cuidOrUuid.optional().nullable(),
    sourceFinancialId: cuidOrUuid.optional().nullable(),
    sourceRef: optionalText(120),
    ruleId: cuidOrUuid.optional().nullable(),
    notes: optionalText(2000),
    trigger: z.enum(REVENUE_TRIGGERS).optional().default('PAYMENT_RECEIVED'),
  })
  .strict();

export const reverseDistributionSchema = z
  .object({ reason: z.string().min(4).max(500) })
  .strict();

export const distributionQuerySchema = z
  .object({
    unitId: cuidOrUuid.optional(),
    clubId: cuidOrUuid.optional(),
    category: z.enum(REVENUE_CATEGORIES).optional(),
    status: z.enum(['COMPUTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'REVERSED']).optional(),
    from: iso8601.optional(),
    to: iso8601.optional(),
    cursor: cuidOrUuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

// ─── Contracts ───────────────────────────────────────────────────────────────

export const createContractSchema = z
  .object({
    type: z.enum(CONTRACT_TYPES),
    documentUrl: z.string().url().optional().nullable(),
    documentChecksum: optionalText(128),
    effectiveFrom: iso8601.optional().nullable(),
    effectiveTo: iso8601.optional().nullable(),
    autoRenew: z.boolean().optional().default(false),
    renewalNoticeMonths: z.number().int().min(0).max(60).optional().default(6),
    governingLaw: optionalText(120),
    jurisdiction: optionalText(120),
    terms: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const updateContractSchema = createContractSchema.partial().strict();

export const signContractSchema = z
  .object({
    signedByName: z.string().min(1).max(160),
    signedByTitle: optionalText(120),
    signedAt: iso8601.optional(),
  })
  .strict();

export const requestRenewalSchema = z
  .object({
    effectiveFrom: iso8601,
    effectiveTo: iso8601.optional().nullable(),
    termsDelta: z.record(z.unknown()).optional().nullable(),
    notes: optionalText(2000),
  })
  .strict();

export const decideRenewalSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    notes: optionalText(2000),
  })
  .strict();

export const initiateTerminationSchema = z
  .object({
    reason: z.enum(TERMINATION_REASONS),
    effectiveDate: iso8601.optional().nullable(),
    severance: positiveAmount.optional().nullable(),
    currency: currency.optional().default('EUR'),
    notes: optionalText(2000),
  })
  .strict();

export const decideTerminationSchema = z
  .object({
    decision: z.enum(['APPROVED', 'CANCELLED']),
    notes: optionalText(2000),
  })
  .strict();

// ─── Violations + compliance ─────────────────────────────────────────────────

export const reportViolationSchema = z
  .object({
    contractId: cuidOrUuid.optional().nullable(),
    clauseRef: optionalText(120),
    severity: z.enum(VIOLATION_SEVERITIES),
    category: z.string().min(2).max(60),
    title: z.string().min(4).max(200),
    description: z.string().min(8).max(5000),
    dueByAt: iso8601.optional().nullable(),
    assignedTo: cuidOrUuid.optional().nullable(),
    evidence: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const updateViolationSchema = z
  .object({
    severity: z.enum(VIOLATION_SEVERITIES).optional(),
    status: z.enum(VIOLATION_STATUSES).optional(),
    assignedTo: cuidOrUuid.optional().nullable(),
    dueByAt: iso8601.optional().nullable(),
    resolution: optionalText(5000),
  })
  .strict();

export const upsertComplianceCheckSchema = z
  .object({
    category: z.enum(COMPLIANCE_CATEGORIES),
    period: z.string().min(4).max(20).regex(/^\d{4}(-(Q[1-4]|\d{2}))?$/, 'expected YYYY, YYYY-MM, or YYYY-Q[1-4]'),
    periodStartAt: iso8601,
    periodEndAt: iso8601,
    status: z.enum(COMPLIANCE_STATUSES).optional(),
    score: z.number().min(0).max(100).optional().nullable(),
    findings: z.record(z.unknown()).optional().nullable(),
    remediation: optionalText(5000),
    dueByAt: iso8601.optional().nullable(),
  })
  .strict();

// ─── Performance ─────────────────────────────────────────────────────────────

export const generateSnapshotSchema = z
  .object({
    period: z.string().min(4).max(20).regex(/^\d{4}(-(Q[1-4]|\d{2}))?$/),
    periodStartAt: iso8601,
    periodEndAt: iso8601,
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

// ─── Audit query ─────────────────────────────────────────────────────────────

export const auditQuerySchema = z
  .object({
    unitId: cuidOrUuid.optional(),
    userId: cuidOrUuid.optional(),
    action: z.string().min(1).max(80).optional(),
    category: z
      .enum([
        'HIERARCHY', 'OWNERSHIP', 'TRANSFER', 'ACQUISITION', 'TERRITORY',
        'EXPANSION', 'REVENUE', 'CONTRACT', 'COMPLIANCE', 'PERFORMANCE', 'OTHER',
      ])
      .optional(),
    from: iso8601.optional(),
    to: iso8601.optional(),
    cursor: cuidOrUuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

// ─── Inferred input types ────────────────────────────────────────────────────

export type CreateTerritoryInput = z.infer<typeof createTerritorySchema>;
export type UpdateTerritoryInput = z.infer<typeof updateTerritorySchema>;
export type CreateFranchiseUnitInput = z.infer<typeof createFranchiseUnitSchema>;
export type UpdateFranchiseUnitInput = z.infer<typeof updateFranchiseUnitSchema>;
export type SetUnitStatusInput = z.infer<typeof setUnitStatusSchema>;
export type CreateOwnerInput = z.infer<typeof createOwnerSchema>;
export type UpdateOwnerInput = z.infer<typeof updateOwnerSchema>;
export type GrantOwnershipInput = z.infer<typeof grantOwnershipSchema>;
export type RevokeOwnershipInput = z.infer<typeof revokeOwnershipSchema>;
export type InitiateTransferInput = z.infer<typeof initiateTransferSchema>;
export type CancelTransferInput = z.infer<typeof cancelTransferSchema>;
export type GrantTerritoryRightInput = z.infer<typeof grantTerritoryRightSchema>;
export type UpdateTerritoryRightInput = z.infer<typeof updateTerritoryRightSchema>;
export type CreateExpansionRequestInput = z.infer<typeof createExpansionRequestSchema>;
export type DecideExpansionRequestInput = z.infer<typeof decideExpansionRequestSchema>;
export type CompleteExpansionRequestInput = z.infer<typeof completeExpansionRequestSchema>;
export type CreateAcquisitionRequestInput = z.infer<typeof createAcquisitionRequestSchema>;
export type DecideAcquisitionInput = z.infer<typeof decideAcquisitionSchema>;
export type UpsertRevenueSplitRuleInput = z.infer<typeof upsertRevenueSplitRuleSchema>;
export type RecordDistributionInput = z.infer<typeof recordDistributionSchema>;
export type ReverseDistributionInput = z.infer<typeof reverseDistributionSchema>;
export type DistributionQueryInput = z.infer<typeof distributionQuerySchema>;
export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractInput = z.infer<typeof updateContractSchema>;
export type SignContractInput = z.infer<typeof signContractSchema>;
export type RequestRenewalInput = z.infer<typeof requestRenewalSchema>;
export type DecideRenewalInput = z.infer<typeof decideRenewalSchema>;
export type InitiateTerminationInput = z.infer<typeof initiateTerminationSchema>;
export type DecideTerminationInput = z.infer<typeof decideTerminationSchema>;
export type ReportViolationInput = z.infer<typeof reportViolationSchema>;
export type UpdateViolationInput = z.infer<typeof updateViolationSchema>;
export type UpsertComplianceCheckInput = z.infer<typeof upsertComplianceCheckSchema>;
export type GenerateSnapshotInput = z.infer<typeof generateSnapshotSchema>;
export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
