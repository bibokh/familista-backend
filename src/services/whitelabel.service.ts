// Familista — White-label Engine
// File location: src/services/whitelabel.service.ts
//
// Service layer: per-club configuration, custom-domain lifecycle, DNS verification,
// public theme resolution with in-process LRU cache, and full audit trail.
//
// Assumes existing modules (adjust paths if your layout differs):
//   ../lib/prisma          → exports `prisma` (PrismaClient singleton)
//   ../utils/errors        → exports BadRequestError, NotFoundError, ConflictError

import { promises as dnsPromises } from 'dns';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type {
  WhiteLabelConfig,
  WhiteLabelDomain,
  WhiteLabelAuditAction,
} from '@prisma/client';

import { prisma } from '../lib/prisma';
import {
  BadRequestError,
  NotFoundError,
  ConflictError,
} from '../utils/errors';
import type {
  PublicTheme,
  AdminConfigView,
  AuditChange,
} from '../types/whitelabel.types';
import type { UpsertConfigInput, AddDomainInput } from '../utils/whitelabel.validators';

// ─────────────────────────────────────────────────────────────────────────────
// Cache: hostname → resolved theme. Bounded LRU with TTL.
// Cleared on writes for the affected club.
// ─────────────────────────────────────────────────────────────────────────────

const THEME_CACHE_TTL_MS = 5 * 60 * 1000;
const THEME_CACHE_MAX = 1024;

type CacheEntry = { theme: PublicTheme; expiresAt: number; clubId: string | null };
const themeCache = new Map<string, CacheEntry>();

function cacheGet(key: string): PublicTheme | null {
  const hit = themeCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    themeCache.delete(key);
    return null;
  }
  themeCache.delete(key);
  themeCache.set(key, hit);
  return hit.theme;
}

function cacheSet(key: string, theme: PublicTheme, clubId: string | null): void {
  if (themeCache.size >= THEME_CACHE_MAX) {
    const oldest = themeCache.keys().next().value;
    if (oldest) themeCache.delete(oldest);
  }
  themeCache.set(key, { theme, expiresAt: Date.now() + THEME_CACHE_TTL_MS, clubId });
}

function cacheInvalidateClub(clubId: string): void {
  for (const [key, entry] of themeCache.entries()) {
    if (entry.clubId === clubId) themeCache.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default theme: returned when no host matches.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_THEME: PublicTheme = {
  productName: 'Familista',
  tagline: 'Football Intelligence Platform',
  logoUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
  ogImageUrl: null,
  colors: {
    primary: '#0f172a',
    secondary: '#64748b',
    accent: '#22c55e',
    background: '#ffffff',
    surface: '#f8fafc',
    text: '#0f172a',
    mutedText: '#64748b',
    border: '#e2e8f0',
    error: '#ef4444',
    success: '#22c55e',
    warning: '#f59e0b',
  },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontHeadingUrl: null,
    fontBodyUrl: null,
  },
  links: {
    supportEmail: null,
    supportUrl: null,
    termsUrl: null,
    privacyUrl: null,
    marketingUrl: null,
  },
  flags: {
    hidePoweredBy: false,
    hideInvestor: true,
    hideMarketplace: false,
  },
  defaultLocale: 'en',
  customCss: null,
  customHeadHtml: null,
  resolvedAt: '',
  resolvedFrom: 'default',
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const VERIFY_HOST_PREFIX = '_familista-verify';

function newVerifyToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function buildVerifyHost(hostname: string): string {
  return `${VERIFY_HOST_PREFIX}.${hostname}`;
}

function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignore: ReadonlySet<string> = new Set(['updatedAt', 'createdAt', 'id', 'version']),
): AuditChange[] {
  const changes: AuditChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (ignore.has(k)) continue;
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ field: k, before: a, after: b });
    }
  }
  return changes;
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  configId: string,
  action: WhiteLabelAuditAction,
  opts: { userId?: string | null; changes?: unknown; ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  await tx.whiteLabelAudit.create({
    data: {
      configId,
      userId: opts.userId ?? null,
      action,
      changes: opts.changes === undefined ? Prisma.JsonNull : (opts.changes as Prisma.InputJsonValue),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    },
  });
}

function toPublicTheme(
  cfg: WhiteLabelConfig,
  resolvedFrom: PublicTheme['resolvedFrom'],
): PublicTheme {
  return {
    productName: cfg.productName ?? DEFAULT_THEME.productName,
    tagline: cfg.tagline,
    logoUrl: cfg.logoUrl,
    logoDarkUrl: cfg.logoDarkUrl,
    faviconUrl: cfg.faviconUrl,
    ogImageUrl: cfg.ogImageUrl,
    colors: {
      primary: cfg.primaryColor,
      secondary: cfg.secondaryColor,
      accent: cfg.accentColor,
      background: cfg.backgroundColor,
      surface: cfg.surfaceColor,
      text: cfg.textColor,
      mutedText: cfg.mutedTextColor,
      border: cfg.borderColor,
      error: cfg.errorColor,
      success: cfg.successColor,
      warning: cfg.warningColor,
    },
    typography: {
      fontFamily: cfg.fontFamily,
      fontHeadingUrl: cfg.fontHeadingUrl,
      fontBodyUrl: cfg.fontBodyUrl,
    },
    links: {
      supportEmail: cfg.supportEmail,
      supportUrl: cfg.supportUrl,
      termsUrl: cfg.termsUrl,
      privacyUrl: cfg.privacyUrl,
      marketingUrl: cfg.marketingUrl,
    },
    flags: {
      hidePoweredBy: cfg.hidePoweredBy,
      hideInvestor: cfg.hideInvestor,
      hideMarketplace: cfg.hideMarketplace,
    },
    defaultLocale: cfg.defaultLocale,
    customCss: cfg.customCss,
    customHeadHtml: cfg.customHeadHtml,
    resolvedAt: new Date().toISOString(),
    resolvedFrom,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin-facing operations (tenant-isolated; clubId comes from auth context)
// ─────────────────────────────────────────────────────────────────────────────

export async function getConfig(clubId: string): Promise<AdminConfigView> {
  const cfg = await prisma.whiteLabelConfig.findUnique({
    where: { clubId },
    include: { domains: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
  });
  if (!cfg) {
    return await createDefaultConfig(clubId);
  }
  return cfg;
}

async function createDefaultConfig(clubId: string): Promise<AdminConfigView> {
  return await prisma.$transaction(async (tx) => {
    const club = await tx.club.findUnique({ where: { id: clubId } });
    if (!club) throw new NotFoundError('Club not found');

    const cfg = await tx.whiteLabelConfig.create({
      data: {
        clubId,
        productName: club.name,
        isActive: true,
      },
      include: { domains: true },
    });
    await writeAudit(tx, cfg.id, 'CONFIG_CREATED', { changes: { productName: club.name } });
    return cfg;
  });
}

export async function upsertConfig(
  clubId: string,
  input: UpsertConfigInput,
  ctx: { userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<AdminConfigView> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.whiteLabelConfig.findUnique({ where: { clubId } });

    const data: Prisma.WhiteLabelConfigUncheckedUpdateInput = {
      ...input,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
      updatedBy: ctx.userId,
    };

    if (!existing) {
      const club = await tx.club.findUnique({ where: { id: clubId } });
      if (!club) throw new NotFoundError('Club not found');

      const created = await tx.whiteLabelConfig.create({
        data: {
          ...(data as Prisma.WhiteLabelConfigUncheckedCreateInput),
          clubId,
          productName: input.productName ?? club.name,
        },
        include: { domains: true },
      });
      await writeAudit(tx, created.id, 'CONFIG_CREATED', {
        userId: ctx.userId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        changes: input,
      });
      return created;
    }

    const updated = await tx.whiteLabelConfig.update({
      where: { clubId },
      data: { ...data, version: { increment: 1 } },
      include: { domains: true },
    });

    const changes = diffChanges(
      existing as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
    );
    if (changes.length > 0) {
      await writeAudit(tx, updated.id, 'CONFIG_UPDATED', {
        userId: ctx.userId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        changes,
      });
    }
    return updated;
  });

  cacheInvalidateClub(clubId);
  return result;
}

export async function resetConfig(
  clubId: string,
  ctx: { userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<AdminConfigView> {
  const result = await prisma.$transaction(async (tx) => {
    const club = await tx.club.findUnique({ where: { id: clubId } });
    if (!club) throw new NotFoundError('Club not found');

    await tx.whiteLabelConfig.deleteMany({ where: { clubId } });

    const fresh = await tx.whiteLabelConfig.create({
      data: { clubId, productName: club.name, isActive: true },
      include: { domains: true },
    });
    await writeAudit(tx, fresh.id, 'CONFIG_RESET', {
      userId: ctx.userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return fresh;
  });

  cacheInvalidateClub(clubId);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function addDomain(
  clubId: string,
  input: AddDomainInput,
  ctx: { userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<WhiteLabelDomain> {
  const hostname = input.hostname;

  const result = await prisma.$transaction(async (tx) => {
    let cfg = await tx.whiteLabelConfig.findUnique({ where: { clubId } });
    if (!cfg) {
      const club = await tx.club.findUnique({ where: { id: clubId } });
      if (!club) throw new NotFoundError('Club not found');
      cfg = await tx.whiteLabelConfig.create({
        data: { clubId, productName: club.name, isActive: true },
      });
      await writeAudit(tx, cfg.id, 'CONFIG_CREATED', { userId: ctx.userId });
    }

    const collision = await tx.whiteLabelDomain.findUnique({ where: { hostname } });
    if (collision) {
      if (collision.configId === cfg.id) {
        throw new ConflictError('Domain already attached to this club');
      }
      throw new ConflictError('Domain is already claimed by another tenant');
    }

    if (input.isPrimary) {
      await tx.whiteLabelDomain.updateMany({
        where: { configId: cfg.id, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const domain = await tx.whiteLabelDomain.create({
      data: {
        configId: cfg.id,
        hostname,
        isPrimary: input.isPrimary ?? false,
        verifyToken: newVerifyToken(),
        verifyHost: buildVerifyHost(hostname),
        status: 'PENDING',
      },
    });

    await writeAudit(tx, cfg.id, 'DOMAIN_ADDED', {
      userId: ctx.userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      changes: { hostname, isPrimary: domain.isPrimary },
    });

    return domain;
  });

  cacheInvalidateClub(clubId);
  return result;
}

export async function listDomains(clubId: string): Promise<WhiteLabelDomain[]> {
  const cfg = await prisma.whiteLabelConfig.findUnique({
    where: { clubId },
    include: { domains: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
  });
  return cfg?.domains ?? [];
}

export async function removeDomain(
  clubId: string,
  domainId: string,
  ctx: { userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const domain = await tx.whiteLabelDomain.findUnique({
      where: { id: domainId },
      include: { config: true },
    });
    if (!domain || domain.config.clubId !== clubId) {
      throw new NotFoundError('Domain not found');
    }
    await tx.whiteLabelDomain.delete({ where: { id: domain.id } });
    await writeAudit(tx, domain.configId, 'DOMAIN_REMOVED', {
      userId: ctx.userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      changes: { hostname: domain.hostname },
    });
  });

  cacheInvalidateClub(clubId);
}

export async function promoteDomain(
  clubId: string,
  domainId: string,
  ctx: { userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<WhiteLabelDomain> {
  const result = await prisma.$transaction(async (tx) => {
    const domain = await tx.whiteLabelDomain.findUnique({
      where: { id: domainId },
      include: { config: true },
    });
    if (!domain || domain.config.clubId !== clubId) {
      throw new NotFoundError('Domain not found');
    }
    if (domain.status !== 'ACTIVE') {
      throw new BadRequestError('Only ACTIVE domains can be promoted to primary');
    }

    await tx.whiteLabelDomain.updateMany({
      where: { configId: domain.configId, isPrimary: true },
      data: { isPrimary: false },
    });
    const updated = await tx.whiteLabelDomain.update({
      where: { id: domain.id },
      data: { isPrimary: true },
    });

    await writeAudit(tx, domain.configId, 'DOMAIN_PROMOTED', {
      userId: ctx.userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      changes: { hostname: domain.hostname },
    });

    return updated;
  });

  cacheInvalidateClub(clubId);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// DNS verification
// ─────────────────────────────────────────────────────────────────────────────

async function resolveTxtSafe(host: string): Promise<string[][]> {
  try {
    return await dnsPromises.resolveTxt(host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw err;
  }
}

export async function verifyDomain(
  clubId: string,
  domainId: string,
  ctx: { userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<WhiteLabelDomain> {
  const domain = await prisma.whiteLabelDomain.findUnique({
    where: { id: domainId },
    include: { config: true },
  });
  if (!domain || domain.config.clubId !== clubId) {
    throw new NotFoundError('Domain not found');
  }
  if (domain.status === 'DISABLED') {
    throw new BadRequestError('Domain is disabled');
  }

  await prisma.whiteLabelDomain.update({
    where: { id: domain.id },
    data: { status: 'VERIFYING', lastCheckedAt: new Date() },
  });

  const verifyHost = domain.verifyHost ?? buildVerifyHost(domain.hostname);
  const records = await resolveTxtSafe(verifyHost);
  const flat = records.map((r) => r.join('').trim());
  const matched = flat.some((r) => r === domain.verifyToken);

  const result = await prisma.$transaction(async (tx) => {
    if (matched) {
      const updated = await tx.whiteLabelDomain.update({
        where: { id: domain.id },
        data: {
          status: 'ACTIVE',
          verifiedAt: new Date(),
          lastCheckedAt: new Date(),
          failureReason: null,
        },
      });
      await writeAudit(tx, domain.configId, 'DOMAIN_VERIFIED', {
        userId: ctx.userId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        changes: { hostname: domain.hostname },
      });
      return updated;
    } else {
      const reason = flat.length === 0
        ? `No TXT record found at ${verifyHost}`
        : `TXT record at ${verifyHost} did not match expected token`;
      const updated = await tx.whiteLabelDomain.update({
        where: { id: domain.id },
        data: {
          status: 'FAILED',
          lastCheckedAt: new Date(),
          failureReason: reason,
        },
      });
      await writeAudit(tx, domain.configId, 'DOMAIN_FAILED', {
        userId: ctx.userId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        changes: { hostname: domain.hostname, reason },
      });
      return updated;
    }
  });

  if (matched) cacheInvalidateClub(clubId);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public theme resolution (unauthenticated, cached)
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveThemeByHost(host: string): Promise<PublicTheme> {
  const normalized = host.toLowerCase().replace(/:\d+$/, '').trim();
  if (!normalized) return { ...DEFAULT_THEME, resolvedAt: new Date().toISOString() };

  const cached = cacheGet(normalized);
  if (cached) return cached;

  const domain = await prisma.whiteLabelDomain.findUnique({
    where: { hostname: normalized },
    include: { config: true },
  });

  if (!domain || domain.status !== 'ACTIVE' || !domain.config.isActive) {
    const theme = { ...DEFAULT_THEME, resolvedAt: new Date().toISOString() };
    cacheSet(normalized, theme, null);
    return theme;
  }

  const theme = toPublicTheme(domain.config, 'host');
  cacheSet(normalized, theme, domain.config.clubId);
  return theme;
}

export async function resolveThemeByClub(clubId: string): Promise<PublicTheme> {
  const cfg = await prisma.whiteLabelConfig.findUnique({ where: { clubId } });
  if (!cfg || !cfg.isActive) {
    return { ...DEFAULT_THEME, resolvedAt: new Date().toISOString() };
  }
  return toPublicTheme(cfg, 'club');
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit reads
// ─────────────────────────────────────────────────────────────────────────────

export async function listAudits(clubId: string, limit = 50) {
  const cfg = await prisma.whiteLabelConfig.findUnique({ where: { clubId } });
  if (!cfg) return [];
  return await prisma.whiteLabelAudit.findMany({
    where: { configId: cfg.id },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance
// ─────────────────────────────────────────────────────────────────────────────

export async function recheckStaleDomains(staleAfterMinutes = 60): Promise<{
  checked: number;
  promoted: number;
  failed: number;
}> {
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000);
  const candidates = await prisma.whiteLabelDomain.findMany({
    where: {
      status: { in: ['PENDING', 'VERIFYING', 'FAILED'] },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: cutoff } }],
    },
    include: { config: true },
    take: 100,
  });

  let promoted = 0;
  let failed = 0;
  for (const d of candidates) {
    try {
      const verified = await verifyDomain(d.config.clubId, d.id, { userId: 'system' });
      if (verified.status === 'ACTIVE') promoted++;
      else failed++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`whitelabel.recheck failed for ${d.hostname}: ${(err as Error).message}`);
      failed++;
    }
  }
  return { checked: candidates.length, promoted, failed };
}

export function _clearThemeCacheForTests(): void {
  themeCache.clear();
}
