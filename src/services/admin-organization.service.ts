// Familista — Super Admin White-label Control Panel
// File location: src/services/admin-organization.service.ts
//
// Per-organization limits, subscription overrides (operator-granted plan/status,
// optionally bypassing Stripe), and the unified entitlement/license matrix.
//
// The override pattern: when an active SubscriptionOverride exists, Club.plan
// AND Club.subscriptionStatus reflect the override and Club.planSource = OVERRIDE.
// The Stripe webhook must check planSource and skip mutation when OVERRIDE.

import { prisma } from '../lib/prisma';
import {
  BadRequestError,
  NotFoundError,
  ConflictError,
} from '../utils/errors';
import { writePlatformAudit } from '../middleware/admin-rbac.middleware';
import type {
  UpdateLimitsInput,
  CreateOverrideInput,
  RevokeOverrideInput,
} from '../utils/admin.validators';
import type { PlatformActor, EntitlementMatrix } from '../types/admin.types';
import type {
  OrganizationLimits,
  SubscriptionOverride,
  SubscriptionPlan,
  SubscriptionStatus,
  FeatureFlag,
} from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────

export async function getLimits(clubId: string): Promise<OrganizationLimits> {
  const existing = await prisma.organizationLimits.findUnique({ where: { clubId } });
  if (existing) return existing;
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club not found');
  return await prisma.organizationLimits.create({ data: { clubId } });
}

export async function updateLimits(
  actor: PlatformActor,
  clubId: string,
  input: UpdateLimitsInput,
): Promise<OrganizationLimits> {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club not found');

  const updated = await prisma.organizationLimits.upsert({
    where: { clubId },
    create: {
      clubId,
      maxUsers: input.maxUsers ?? null,
      maxPlayers: input.maxPlayers ?? null,
      maxGpsDevices: input.maxGpsDevices ?? null,
      maxStorageMb: input.maxStorageMb ?? null,
      maxApiCallsPerDay: input.maxApiCallsPerDay ?? null,
      maxAiInsightsPerMonth: input.maxAiInsightsPerMonth ?? null,
      maxCustomDomains: input.maxCustomDomains ?? null,
      maxPdfReportsPerMonth: input.maxPdfReportsPerMonth ?? null,
      maxImpersonationsPerDay: input.maxImpersonationsPerDay ?? null,
      featuresEnabled: input.featuresEnabled ?? [],
      featuresDisabled: input.featuresDisabled ?? [],
      notes: input.notes ?? null,
      setBy: actor.userId,
    },
    update: {
      ...input,
      featuresEnabled: input.featuresEnabled ?? undefined,
      featuresDisabled: input.featuresDisabled ?? undefined,
      setBy: actor.userId,
    },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId,
    action: 'LIMITS_UPDATED',
    category: 'LIMITS',
    resourceType: 'OrganizationLimits',
    resourceId: updated.id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription overrides
// ─────────────────────────────────────────────────────────────────────────────

export async function listOverrides(clubId: string): Promise<SubscriptionOverride[]> {
  return await prisma.subscriptionOverride.findMany({
    where: { clubId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getActiveOverride(clubId: string): Promise<SubscriptionOverride | null> {
  return await prisma.subscriptionOverride.findFirst({
    where: {
      clubId,
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createOverride(
  actor: PlatformActor,
  clubId: string,
  input: CreateOverrideInput,
): Promise<SubscriptionOverride> {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club not found');

  const active = await getActiveOverride(clubId);
  if (active) {
    throw new ConflictError(
      `Club already has an active override (id=${active.id}). Revoke it first.`,
    );
  }

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new BadRequestError('expiresAt must be in the future');
  }

  const result = await prisma.$transaction(async (tx) => {
    const override = await tx.subscriptionOverride.create({
      data: {
        clubId,
        plan: input.plan,
        status: input.status ?? 'ACTIVE',
        reason: input.reason,
        expiresAt,
        bypassStripe: input.bypassStripe ?? false,
        appliedBy: actor.userId,
        isActive: true,
      },
    });

    await tx.club.update({
      where: { id: clubId },
      data: {
        plan: override.plan,
        subscriptionStatus: override.status,
        ...({ planSource: 'OVERRIDE' } as Record<string, 'OVERRIDE'>),
      },
    });

    return override;
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId,
    action: 'SUBSCRIPTION_OVERRIDE_CREATED',
    category: 'BILLING',
    resourceType: 'SubscriptionOverride',
    resourceId: result.id,
    metadata: {
      plan: result.plan,
      status: result.status,
      bypassStripe: result.bypassStripe,
      expiresAt: result.expiresAt,
      reason: result.reason,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result;
}

export async function revokeOverride(
  actor: PlatformActor,
  clubId: string,
  overrideId: string,
  input: RevokeOverrideInput,
): Promise<SubscriptionOverride> {
  const override = await prisma.subscriptionOverride.findUnique({ where: { id: overrideId } });
  if (!override || override.clubId !== clubId) throw new NotFoundError('Override not found');
  if (!override.isActive) throw new BadRequestError('Override is already inactive');

  const result = await prisma.$transaction(async (tx) => {
    const revoked = await tx.subscriptionOverride.update({
      where: { id: overrideId },
      data: {
        isActive: false,
        revokedBy: actor.userId,
        revokedAt: new Date(),
        revokedReason: input.reason,
      },
    });

    await tx.club.update({
      where: { id: clubId },
      data: { ...({ planSource: 'STRIPE' } as Record<string, 'STRIPE'>) },
    });

    return revoked;
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId,
    action: 'SUBSCRIPTION_OVERRIDE_REVOKED',
    category: 'BILLING',
    resourceType: 'SubscriptionOverride',
    resourceId: result.id,
    metadata: { reason: input.reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result;
}

export async function expireStaleOverrides(): Promise<{ expired: number }> {
  const now = new Date();
  const stale = await prisma.subscriptionOverride.findMany({
    where: { isActive: true, expiresAt: { lt: now } },
    take: 500,
  });

  let expired = 0;
  for (const o of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.subscriptionOverride.update({
        where: { id: o.id },
        data: { isActive: false, revokedAt: now, revokedReason: 'expired' },
      });
      await tx.club.update({
        where: { id: o.clubId },
        data: { ...({ planSource: 'STRIPE' } as Record<string, 'STRIPE'>) },
      });
      await tx.platformAuditLog.create({
        data: {
          clubId: o.clubId,
          action: 'SUBSCRIPTION_OVERRIDE_EXPIRED',
          category: 'BILLING',
          resourceType: 'SubscriptionOverride',
          resourceId: o.id,
          metadata: { expiresAt: o.expiresAt } as object,
          result: 'SUCCESS',
        },
      });
    });
    expired++;
  }

  return { expired };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entitlement matrix (unified license view)
// ─────────────────────────────────────────────────────────────────────────────

export async function getEntitlementMatrix(clubId: string): Promise<EntitlementMatrix> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      id: true,
      plan: true,
      subscriptionStatus: true,
      ...({ planSource: true } as Record<string, true>),
    },
  });
  if (!club) throw new NotFoundError('Club not found');

  const planSource = (club as unknown as { planSource?: 'STRIPE' | 'OVERRIDE' }).planSource ?? 'STRIPE';

  const [limits, override, flags, usage] = await Promise.all([
    prisma.organizationLimits.findUnique({ where: { clubId } }),
    getActiveOverride(clubId),
    prisma.featureFlag.findMany(),
    Promise.all([
      prisma.user.count({ where: { clubId } }),
      prisma.player.count({ where: { clubId } }),
      prisma.gpsDevice.count({ where: { clubId } }),
      countCustomDomains(clubId),
    ]),
  ]);

  const features = resolveFeatures(flags, club.plan, limits);

  return {
    clubId,
    plan: club.plan,
    status: club.subscriptionStatus,
    planSource,
    override: override
      ? {
          id: override.id,
          plan: override.plan,
          status: override.status,
          reason: override.reason,
          appliedBy: override.appliedBy,
          expiresAt: override.expiresAt,
          bypassStripe: override.bypassStripe,
        }
      : null,
    limits: {
      maxUsers: limits?.maxUsers ?? null,
      maxPlayers: limits?.maxPlayers ?? null,
      maxGpsDevices: limits?.maxGpsDevices ?? null,
      maxStorageMb: limits?.maxStorageMb ?? null,
      maxApiCallsPerDay: limits?.maxApiCallsPerDay ?? null,
      maxAiInsightsPerMonth: limits?.maxAiInsightsPerMonth ?? null,
      maxCustomDomains: limits?.maxCustomDomains ?? null,
      maxPdfReportsPerMonth: limits?.maxPdfReportsPerMonth ?? null,
      maxImpersonationsPerDay: limits?.maxImpersonationsPerDay ?? null,
    },
    usage: {
      users: usage[0],
      players: usage[1],
      gpsDevices: usage[2],
      customDomains: usage[3],
    },
    features,
    resolvedAt: new Date().toISOString(),
  };
}

async function countCustomDomains(clubId: string): Promise<number> {
  const cfg = await prisma.whiteLabelConfig.findUnique({ where: { clubId } });
  if (!cfg) return 0;
  return await prisma.whiteLabelDomain.count({ where: { configId: cfg.id } });
}

function resolveFeatures(
  flags: FeatureFlag[],
  plan: SubscriptionPlan,
  limits: OrganizationLimits | null,
): EntitlementMatrix['features'] {
  const out: EntitlementMatrix['features'] = {};
  const enabledSet = new Set(limits?.featuresEnabled ?? []);
  const disabledSet = new Set(limits?.featuresDisabled ?? []);

  for (const f of flags) {
    if (disabledSet.has(f.key)) {
      out[f.key] = { enabled: false, source: 'override-disabled' };
      continue;
    }
    if (enabledSet.has(f.key)) {
      out[f.key] = { enabled: true, source: 'override-enabled' };
      continue;
    }
    if (f.enabledForPlans.includes(plan)) {
      out[f.key] = { enabled: true, source: 'plan-default' };
      continue;
    }
    out[f.key] = { enabled: f.defaultEnabled, source: 'flag-default' };
  }
  return out;
}

// Reusable entitlement check for runtime guards anywhere in the app.
export async function isFeatureEnabled(clubId: string, key: string): Promise<boolean> {
  const limits = await prisma.organizationLimits.findUnique({ where: { clubId } });
  if (limits?.featuresDisabled.includes(key)) return false;
  if (limits?.featuresEnabled.includes(key)) return true;

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { plan: true } });
  if (!club) return false;

  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  if (!flag) return false;
  if (flag.enabledForPlans.includes(club.plan)) return true;
  return flag.defaultEnabled;
}

export async function getQuotaUsage(clubId: string, key: 'users' | 'players' | 'gpsDevices' | 'customDomains'): Promise<number> {
  switch (key) {
    case 'users':
      return await prisma.user.count({ where: { clubId } });
    case 'players':
      return await prisma.player.count({ where: { clubId } });
    case 'gpsDevices':
      return await prisma.gpsDevice.count({ where: { clubId } });
    case 'customDomains':
      return await countCustomDomains(clubId);
  }
}
