// Familista — White-label Engine
// File location: src/utils/whitelabel.validators.ts
//
// Zod input validators. Strict by default — additionalProperties rejected.

import { z } from 'zod';

const hex = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Invalid hex color');

const safeUrl = z
  .string()
  .url()
  .refine(
    (u) => {
      try {
        const parsed = new URL(u);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'Only http(s) URLs are allowed' },
  );

const optionalUrl = safeUrl.optional().nullable();
const optionalEmail = z.string().email().optional().nullable();
const optionalText = (max: number) => z.string().max(max).optional().nullable();

export const upsertConfigSchema = z
  .object({
    productName: optionalText(80),
    tagline: optionalText(160),

    logoUrl: optionalUrl,
    logoDarkUrl: optionalUrl,
    faviconUrl: optionalUrl,
    ogImageUrl: optionalUrl,

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
    fontHeadingUrl: optionalUrl,
    fontBodyUrl: optionalUrl,

    supportEmail: optionalEmail,
    supportUrl: optionalUrl,
    termsUrl: optionalUrl,
    privacyUrl: optionalUrl,
    marketingUrl: optionalUrl,

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
    metadata: z.record(z.unknown()).optional().nullable(),

    isActive: z.boolean().optional(),
  })
  .strict();

export type UpsertConfigInput = z.infer<typeof upsertConfigSchema>;

// Hostnames: lowercase, RFC 1035, no protocol, no path, max 253 chars.
const hostnameRegex = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const RESERVED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'familista.app',
  'www.familista.app',
  'api.familista.app',
  'admin.familista.app',
  'investor.familista.app',
  'app.familista.app',
  'docs.familista.app',
  'support.familista.app',
]);

export const RESERVED_SUBDOMAIN_LABELS = new Set([
  'www',
  'api',
  'admin',
  'app',
  'investor',
  'docs',
  'support',
  'mail',
  'smtp',
  'imap',
  'staging',
  'dev',
  'test',
  'mx',
  'ns',
  'ns1',
  'ns2',
]);

export const addDomainSchema = z
  .object({
    hostname: z
      .string()
      .min(4)
      .max(253)
      .transform((s) => s.trim().toLowerCase())
      .refine((s) => hostnameRegex.test(s), 'Invalid hostname (expected e.g. coach.example.com)')
      .refine((s) => !RESERVED_HOSTNAMES.has(s), 'Reserved hostname')
      .refine((s) => {
        const firstLabel = s.split('.')[0];
        if (s.endsWith('.familista.app')) return !RESERVED_SUBDOMAIN_LABELS.has(firstLabel);
        return true;
      }, 'Reserved subdomain on familista.app'),
    isPrimary: z.boolean().optional().default(false),
  })
  .strict();

export type AddDomainInput = z.infer<typeof addDomainSchema>;

export const resolveQuerySchema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .transform((s) => s.trim().toLowerCase().replace(/:\d+$/, '')),
  })
  .strict();
