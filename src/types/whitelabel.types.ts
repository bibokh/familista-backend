// Familista — White-label Engine
// File location: src/types/whitelabel.types.ts
//
// Type definitions used by the controller, service, and the SPA bootstrap client.

import type { WhiteLabelConfig, WhiteLabelDomain, WhiteLabelDomainStatus } from '@prisma/client';

export type PublicTheme = {
  productName: string;
  tagline: string | null;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;

  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    mutedText: string;
    border: string;
    error: string;
    success: string;
    warning: string;
  };

  typography: {
    fontFamily: string;
    fontHeadingUrl: string | null;
    fontBodyUrl: string | null;
  };

  links: {
    supportEmail: string | null;
    supportUrl: string | null;
    termsUrl: string | null;
    privacyUrl: string | null;
    marketingUrl: string | null;
  };

  flags: {
    hidePoweredBy: boolean;
    hideInvestor: boolean;
    hideMarketplace: boolean;
  };

  defaultLocale: string;
  customCss: string | null;
  customHeadHtml: string | null;

  resolvedAt: string;
  resolvedFrom: 'host' | 'club' | 'default';
};

export type AdminConfigView = WhiteLabelConfig & {
  domains: WhiteLabelDomain[];
};

export type DomainStatus = WhiteLabelDomainStatus;

export type AuditChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type WhiteLabelEvent =
  | { action: 'CONFIG_CREATED'; changes: AuditChange[] }
  | { action: 'CONFIG_UPDATED'; changes: AuditChange[] }
  | { action: 'CONFIG_RESET' }
  | { action: 'DOMAIN_ADDED'; hostname: string }
  | { action: 'DOMAIN_REMOVED'; hostname: string }
  | { action: 'DOMAIN_VERIFIED'; hostname: string }
  | { action: 'DOMAIN_FAILED'; hostname: string; reason: string }
  | { action: 'DOMAIN_PROMOTED'; hostname: string };
