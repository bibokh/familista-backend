// Familista — Super Admin White-label Control Panel
// File location: src/utils/admin.validators.ts
//
// Zod input validators. Strict mode everywhere.

import { z } from 'zod';

const cuidOrUuid = z.string().min(8).max(64);
const hex = z.string().regex(/^#(?:[0-9a-fA-F]{3,8})$/, 'Invalid hex color');
const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'Must be http(s) URL');
const optionalHttpUrl = httpUrl.optional().nullable();
const optionalEmail = z.string().email().optional().nullable();
const optionalText = (max: number) => z.string().max(max).optional().nullable();

// ── Platform admin RBAC ─────────────────────────────────────────────────────

export const PLATFORM_ROLES = [
  'PLATFORM_OWNER',
  'PLATFORM_ADMIN',
  'PLATFORM_SUPPORT',
  'PLATFORM_BILLING',
  'PLATFORM_READ_ONLY',
] as const;

export const createPlatformAdminSchema = z
  .object({
    userId: cuidOrUuid,
    role: z.enum(PLATFORM_ROLES),
    ipAllowlist: z.array(z.string().min(1).max(64)).max(50).optional().default([]),
    mfaEnforced: z.boolean().optional().default(true),
    notes: optionalText(2000),
  })
  .strict();

export const updatePlatformAdminSchema = z
  .object({
    role: z.enum(PLATFORM_ROLES).optional(),
    ipAllowlist: z.array(z.string().min(1).max(64)).max(50).optional(),
    mfaEnforced: z.boolean().optional(),
    isActive: z.boolean().optional(),
    notes: optionalText(2000),
  })
  .strict();

// ── Branding ────────────────────────────────────────────────────────────────

export const adminUpsertBrandingSchema = z
  .object({
    productName: optionalText(80),
    tagline: optionalText(160),
    logoUrl: optionalHttpUrl,
    logoDarkUrl: optionalHttpUrl,
    faviconUrl: optionalHttpUrl,
    ogImageUrl: optionalHttpUrl,
    primaryColor: hex.optional(),
    secondaryColor: hex.optional(),
    accentColor: hex.optional(),
    backgroundColor: hex.optional(),
    surfaceColor: hex.optional(),
    textColor: hex.optional(),
    mutedTextColor: hex.optional(),
    borderColor: hex.optional(),
    errorColor: hex.optional(),
    successColor: hex.optional(),
    warningColor: hex.optional(),
    fontFamily: z.string().min(1).max(200).optional(),
    fontHeadingUrl: optionalHttpUrl,
    fontBodyUrl: optionalHttpUrl,
    supportEmail: optionalEmail,
    supportUrl: optionalHttpUrl,
    termsUrl: optionalHttpUrl,
    privacyUrl: optionalHttpUrl,
    marketingUrl: optionalHttpUrl,
    emailFromName: optionalText(80),
    emailFromEmail: optionalEmail,
    emailReplyTo: optionalEmail,
    emailHeaderHtml: optionalText(8000),
    emailFooterHtml: optionalText(8000),
    hidePoweredBy: z.boolean().optional(),
    hideInvestor: z.boolean().optional(),
    hideMarketplace: z.boolean().optional(),
    customCss: optionalText(50_000),
    customHeadHtml: optionalText(8000),
    defaultLocale: z.string().min(2).max(8).optional(),
    isActive: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

// ── Palette templates ───────────────────────────────────────────────────────

export const paletteTokensSchema = z
  .object({
    primary: hex,
    secondary: hex,
    accent: hex,
    background: hex,
    surface: hex,
    text: hex,
    mutedText: hex,
    border: hex,
    error: hex,
    success: hex,
    warning: hex,
  })
  .strict();

export const createPaletteSchema = z
  .object({
    slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, 'lowercase, digits, hyphens'),
    name: z.string().min(1).max(120),
    description: optionalText(500),
    category: z.enum(['system', 'league', 'club', 'custom']).optional().default('custom'),
    isPublic: z.boolean().optional().default(true),
    tokens: paletteTokensSchema,
    preview: optionalHttpUrl,
  })
  .strict();

export const updatePaletteSchema = createPaletteSchema.partial().strict();

export const applyPaletteSchema = z
  .object({
    paletteId: cuidOrUuid.optional(),
    paletteSlug: z.string().min(2).max(60).optional(),
  })
  .strict()
  .refine((v) => !!(v.paletteId || v.paletteSlug), 'paletteId or paletteSlug required');

// ── Domain ──────────────────────────────────────────────────────────────────

export const forceVerifyDomainSchema = z
  .object({
    reason: z.string().min(8).max(500),
    bypassDns: z.boolean().optional().default(false),
  })
  .strict();

export const setDomainStatusSchema = z
  .object({
    status: z.enum(['PENDING', 'VERIFYING', 'ACTIVE', 'FAILED', 'DISABLED']),
    reason: z.string().min(4).max(500),
  })
  .strict();

// ── Limits ──────────────────────────────────────────────────────────────────

const optionalPositiveInt = z.number().int().min(0).max(10_000_000).optional().nullable();

export const updateLimitsSchema = z
  .object({
    maxUsers: optionalPositiveInt,
    maxPlayers: optionalPositiveInt,
    maxGpsDevices: optionalPositiveInt,
    maxStorageMb: optionalPositiveInt,
    maxApiCallsPerDay: optionalPositiveInt,
    maxAiInsightsPerMonth: optionalPositiveInt,
    maxCustomDomains: optionalPositiveInt,
    maxPdfReportsPerMonth: optionalPositiveInt,
    maxImpersonationsPerDay: optionalPositiveInt,
    featuresEnabled: z.array(z.string().min(1).max(60)).max(200).optional(),
    featuresDisabled: z.array(z.string().min(1).max(60)).max(200).optional(),
    notes: optionalText(2000),
  })
  .strict();

// ── Subscription override ───────────────────────────────────────────────────

export const SUBSCRIPTION_PLANS = ['BASIC', 'PRO', 'ACADEMY', 'ENTERPRISE'] as const;
export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING', 'INCOMPLETE'] as const;

export const createOverrideSchema = z
  .object({
    plan: z.enum(SUBSCRIPTION_PLANS),
    status: z.enum(SUBSCRIPTION_STATUSES).optional().default('ACTIVE'),
    reason: z.string().min(8).max(2000),
    expiresAt: z.string().datetime().optional().nullable(),
    bypassStripe: z.boolean().optional().default(false),
  })
  .strict();

export const revokeOverrideSchema = z
  .object({
    reason: z.string().min(8).max(2000),
  })
  .strict();

// ── Feature flags ───────────────────────────────────────────────────────────

export const upsertFeatureFlagSchema = z
  .object({
    key: z.string().min(2).max(60).regex(/^[a-z0-9_.-]+$/, 'lowercase, digits, ._-'),
    name: z.string().min(1).max(120),
    description: optionalText(1000),
    defaultEnabled: z.boolean().optional().default(false),
    enabledForPlans: z.array(z.enum(SUBSCRIPTION_PLANS)).optional().default([]),
    isInternal: z.boolean().optional().default(false),
  })
  .strict();

// ── Impersonation ───────────────────────────────────────────────────────────

export const startImpersonationSchema = z
  .object({
    targetUserId: cuidOrUuid,
    reason: z.string().min(12).max(1000),
    ttlMinutes: z.number().int().min(5).max(240).optional().default(60),
  })
  .strict();

// ── Asset upload ────────────────────────────────────────────────────────────

export const ASSET_TYPES = [
  'LOGO_LIGHT',
  'LOGO_DARK',
  'FAVICON',
  'OG_IMAGE',
  'PDF_HEADER',
  'PDF_FOOTER',
  'EMAIL_HEADER_BG',
] as const;

export const ASSET_MIME_WHITELIST: Record<typeof ASSET_TYPES[number], readonly string[]> = {
  LOGO_LIGHT: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
  LOGO_DARK: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
  FAVICON: ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml'],
  OG_IMAGE: ['image/png', 'image/jpeg', 'image/webp'],
  PDF_HEADER: ['image/png', 'image/jpeg'],
  PDF_FOOTER: ['image/png', 'image/jpeg'],
  EMAIL_HEADER_BG: ['image/png', 'image/jpeg'],
};

export const ASSET_MAX_BYTES: Record<typeof ASSET_TYPES[number], number> = {
  LOGO_LIGHT: 2 * 1024 * 1024,
  LOGO_DARK: 2 * 1024 * 1024,
  FAVICON: 256 * 1024,
  OG_IMAGE: 4 * 1024 * 1024,
  PDF_HEADER: 1 * 1024 * 1024,
  PDF_FOOTER: 1 * 1024 * 1024,
  EMAIL_HEADER_BG: 1 * 1024 * 1024,
};

export const assetUploadMetaSchema = z
  .object({
    type: z.enum(ASSET_TYPES),
    setAsActive: z.boolean().optional().default(true),
  })
  .strict();

// ── Audit query ─────────────────────────────────────────────────────────────

export const auditQuerySchema = z
  .object({
    clubId: cuidOrUuid.optional(),
    adminId: cuidOrUuid.optional(),
    action: z.string().min(1).max(80).optional(),
    category: z
      .enum([
        'BRANDING', 'DOMAIN', 'ASSET', 'PALETTE', 'BILLING', 'LICENSE',
        'LIMITS', 'ACCESS', 'IMPERSONATION', 'FEATURE_FLAG', 'PLATFORM_ADMIN', 'OTHER',
      ])
      .optional(),
    result: z.enum(['SUCCESS', 'FAILURE', 'REJECTED']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

// ── Common ──────────────────────────────────────────────────────────────────

export const clubIdParamSchema = z.object({ clubId: cuidOrUuid });

export type CreatePlatformAdminInput = z.infer<typeof createPlatformAdminSchema>;
export type UpdatePlatformAdminInput = z.infer<typeof updatePlatformAdminSchema>;
export type AdminUpsertBrandingInput = z.infer<typeof adminUpsertBrandingSchema>;
export type CreatePaletteInput = z.infer<typeof createPaletteSchema>;
export type UpdatePaletteInput = z.infer<typeof updatePaletteSchema>;
export type ApplyPaletteInput = z.infer<typeof applyPaletteSchema>;
export type UpdateLimitsInput = z.infer<typeof updateLimitsSchema>;
export type CreateOverrideInput = z.infer<typeof createOverrideSchema>;
export type RevokeOverrideInput = z.infer<typeof revokeOverrideSchema>;
export type UpsertFeatureFlagInput = z.infer<typeof upsertFeatureFlagSchema>;
export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>;
export type AssetUploadMetaInput = z.infer<typeof assetUploadMetaSchema>;
export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
export type ForceVerifyDomainInput = z.infer<typeof forceVerifyDomainSchema>;
export type SetDomainStatusInput = z.infer<typeof setDomainStatusSchema>;
