// Familista — Super Admin White-label Control Panel
// File location: src/types/admin.types.ts
//
// Shared types for the operator control panel. Imported by services, controllers,
// and any consuming module (PDFKit adapter, email service, etc.).

import type {
  PlatformAdmin,
  PlatformRole,
  WhiteLabelAsset,
  AssetType,
  AssetStorage,
  ColorPaletteTemplate,
  OrganizationLimits,
  SubscriptionOverride,
  SubscriptionPlan,
  SubscriptionStatus,
  FeatureFlag,
  ImpersonationSession,
  PlatformAuditLog,
  PlatformAuditCategory,
  PlatformAuditResult,
} from '@prisma/client';

// ── RBAC ────────────────────────────────────────────────────────────────────

export type PlatformActor = {
  adminId: string;
  userId: string;
  role: PlatformRole;
  ipAddress: string | null;
  userAgent: string | null;
  mfaVerifiedAt: Date | null;
};

// Permissions matrix. Each operator role maps to a set of granular caps.
export type Capability =
  | 'branding:read'
  | 'branding:write'
  | 'asset:upload'
  | 'asset:delete'
  | 'palette:read'
  | 'palette:write'
  | 'domain:read'
  | 'domain:write'
  | 'domain:force-verify'
  | 'org:read'
  | 'org:write'
  | 'org:suspend'
  | 'org:restore'
  | 'limits:write'
  | 'billing:read'
  | 'billing:override'
  | 'license:read'
  | 'license:write'
  | 'feature-flag:read'
  | 'feature-flag:write'
  | 'impersonate:start'
  | 'impersonate:end'
  | 'audit:read'
  | 'platform-admin:read'
  | 'platform-admin:write'
  // ── Admin dashboard surface (cross-engine read + targeted write) ──
  | 'dashboard:read'
  | 'players:read'
  | 'coaches:read'
  | 'managers:read'
  | 'investor-profile:read'
  | 'investor-profile:write'
  | 'franchise-unit:read'
  | 'franchise-unit:write'
  | 'subscription:read'
  | 'payment:read'
  | 'payment:adjust'
  | 'ai-engine:read'
  | 'vision-engine:read';

export type CapabilityCheck = {
  ok: true;
} | {
  ok: false;
  missing: Capability;
  reason: string;
};

// ── Branding views ──────────────────────────────────────────────────────────

export type PdfBranding = {
  productName: string;
  tagline: string | null;
  logo: { buffer: Buffer; mime: string } | null;
  logoUrl: string | null;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    text: string;
    mutedText: string;
    border: string;
    background: string;
    surface: string;
  };
  fontFamily: string;
  fontHeadingUrl: string | null;
  footerText: string;
  hidePoweredBy: boolean;
  supportEmail: string | null;
  supportUrl: string | null;
};

export type EmailBranding = {
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  productName: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  textColor: string;
  headerHtml: string;
  footerHtml: string;
  supportEmail: string | null;
  supportUrl: string | null;
};

// ── License / entitlement matrix ────────────────────────────────────────────

export type EntitlementMatrix = {
  clubId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  planSource: 'STRIPE' | 'OVERRIDE';

  override: {
    id: string;
    plan: SubscriptionPlan;
    status: SubscriptionStatus;
    reason: string;
    appliedBy: string;
    expiresAt: Date | null;
    bypassStripe: boolean;
  } | null;

  limits: {
    maxUsers: number | null;
    maxPlayers: number | null;
    maxGpsDevices: number | null;
    maxStorageMb: number | null;
    maxApiCallsPerDay: number | null;
    maxAiInsightsPerMonth: number | null;
    maxCustomDomains: number | null;
    maxPdfReportsPerMonth: number | null;
    maxImpersonationsPerDay: number | null;
  };

  usage: {
    users: number;
    players: number;
    gpsDevices: number;
    customDomains: number;
  };

  features: Record<string, {
    enabled: boolean;
    source: 'override-enabled' | 'override-disabled' | 'plan-default' | 'flag-default';
  }>;

  resolvedAt: string;
};

// ── Platform admin views ────────────────────────────────────────────────────

export type PlatformAdminView = PlatformAdmin & {
  user: { id: string; email: string; firstName: string; lastName: string; isActive: boolean };
};

export type AssetView = WhiteLabelAsset;

export type PaletteView = ColorPaletteTemplate;

export type LimitsView = OrganizationLimits & { club: { id: string; name: string } };

export type OverrideView = SubscriptionOverride;

export type ImpersonationView = ImpersonationSession & {
  admin: { id: string; userId: string };
  targetUser: { id: string; email: string; firstName: string; lastName: string };
};

export type AuditEntry = PlatformAuditLog;

// ── Re-exports ──────────────────────────────────────────────────────────────

export type {
  PlatformRole,
  AssetType,
  AssetStorage,
  PlatformAuditCategory,
  PlatformAuditResult,
  FeatureFlag,
  SubscriptionPlan,
  SubscriptionStatus,
};
