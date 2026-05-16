// Familista — Super Admin White-label Control Panel
// File location: src/services/email-branding.service.ts
//
// Adapter consumed by the existing email service (nodemailer / SendGrid / etc).
// Returns the resolved sender identity + HTML template wrappers for a club.

import { prisma } from '../lib/prisma';
import type { EmailBranding } from '../types/admin.types';

const CACHE_TTL_MS = 60 * 1000;
type CachedBranding = { value: EmailBranding; expiresAt: number };
const cache = new Map<string, CachedBranding>();

const DEFAULT_FROM_NAME = 'Familista';
const DEFAULT_FROM_EMAIL = process.env.MAIL_DEFAULT_FROM ?? 'no-reply@familista.app';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function defaultHeader(productName: string, logoUrl: string | null, primary: string): string {
  const logoBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(productName)}" style="max-height:42px;display:block;border:0;" />`
    : `<strong style="color:${escapeHtml(primary)};font-size:18px;">${escapeHtml(productName)}</strong>`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-bottom:1px solid #e2e8f0;">
      <tr><td style="padding:20px 24px;">${logoBlock}</td></tr>
    </table>`;
}

function defaultFooter(productName: string, supportUrl: string | null, supportEmail: string | null, hidePoweredBy: boolean): string {
  const support = supportEmail
    ? `<a href="mailto:${escapeHtml(supportEmail)}" style="color:#64748b;">${escapeHtml(supportEmail)}</a>`
    : supportUrl
      ? `<a href="${escapeHtml(supportUrl)}" style="color:#64748b;">${escapeHtml(supportUrl)}</a>`
      : '';
  const poweredBy = hidePoweredBy ? '' : `<div style="margin-top:8px;color:#94a3b8;font-size:11px;">Powered by Familista</div>`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border-top:1px solid #e2e8f0;">
      <tr><td style="padding:16px 24px;color:#64748b;font-size:12px;">
        ${escapeHtml(productName)} ${support ? ` · ${support}` : ''}
        ${poweredBy}
      </td></tr>
    </table>`;
}

export async function getEmailBranding(clubId: string): Promise<EmailBranding> {
  const cached = cache.get(clubId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const cfg = await prisma.whiteLabelConfig.findUnique({ where: { clubId } });
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });

  const productName = cfg?.productName ?? club?.name ?? DEFAULT_FROM_NAME;
  const logoUrl = cfg?.logoUrl ?? null;
  const primary = cfg?.primaryColor ?? '#0f172a';
  const accent = cfg?.accentColor ?? '#22c55e';
  const text = cfg?.textColor ?? '#0f172a';

  const branding: EmailBranding = {
    fromName: cfg?.emailFromName ?? productName,
    fromEmail: cfg?.emailFromEmail ?? DEFAULT_FROM_EMAIL,
    replyTo: cfg?.emailReplyTo ?? null,
    productName,
    logoUrl,
    primaryColor: primary,
    accentColor: accent,
    textColor: text,
    headerHtml: cfg?.emailHeaderHtml ?? defaultHeader(productName, logoUrl, primary),
    footerHtml:
      cfg?.emailFooterHtml ??
      defaultFooter(productName, cfg?.supportUrl ?? null, cfg?.supportEmail ?? null, cfg?.hidePoweredBy ?? false),
    supportEmail: cfg?.supportEmail ?? null,
    supportUrl: cfg?.supportUrl ?? null,
  };

  cache.set(clubId, { value: branding, expiresAt: Date.now() + CACHE_TTL_MS });
  return branding;
}

export function wrapEmailHtml(branding: EmailBranding, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(branding.productName)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${escapeHtml(branding.textColor)};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <tr><td>${branding.headerHtml}</td></tr>
        <tr><td style="padding:24px;">${bodyHtml}</td></tr>
        <tr><td>${branding.footerHtml}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function invalidateEmailBrandingCache(clubId?: string): void {
  if (clubId) cache.delete(clubId);
  else cache.clear();
}
