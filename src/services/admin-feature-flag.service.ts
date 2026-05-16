// Familista — Super Admin White-label Control Panel
// File location: src/services/admin-feature-flag.service.ts
//
// Feature flag CRUD + plan matrix. Per-organization overrides live on
// OrganizationLimits.featuresEnabled / featuresDisabled (managed by
// admin-organization.service).

import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { writePlatformAudit } from '../middleware/admin-rbac.middleware';
import type { UpsertFeatureFlagInput } from '../utils/admin.validators';
import type { PlatformActor } from '../types/admin.types';
import type { FeatureFlag, SubscriptionPlan } from '@prisma/client';

const BUILTIN_FLAGS: ReadonlyArray<Omit<UpsertFeatureFlagInput, 'description'> & { description: string }> = [
  {
    key: 'whitelabel',
    name: 'White-label branding',
    description: 'Per-tenant branding, theming, and custom domains.',
    defaultEnabled: false,
    enabledForPlans: ['PRO', 'ACADEMY', 'ENTERPRISE'],
    isInternal: false,
  },
  {
    key: 'investor_module',
    name: 'Investor module',
    description: 'Investor dashboards and reports.',
    defaultEnabled: false,
    enabledForPlans: ['ENTERPRISE'],
    isInternal: false,
  },
  {
    key: 'pdf_executive_reports',
    name: 'Executive PDF reports',
    description: 'Branded PDF report generation.',
    defaultEnabled: false,
    enabledForPlans: ['PRO', 'ACADEMY', 'ENTERPRISE'],
    isInternal: false,
  },
  {
    key: 'ai_insights',
    name: 'AI insights',
    description: 'Claude-powered analytics and recommendations.',
    defaultEnabled: false,
    enabledForPlans: ['PRO', 'ACADEMY', 'ENTERPRISE'],
    isInternal: false,
  },
  {
    key: 'quantum_twin',
    name: 'Quantum Development Twin',
    description: 'Quantum twin player simulations.',
    defaultEnabled: false,
    enabledForPlans: ['ACADEMY', 'ENTERPRISE'],
    isInternal: false,
  },
  {
    key: 'custom_smtp',
    name: 'Custom SMTP',
    description: 'Send platform emails from tenant-owned SMTP.',
    defaultEnabled: false,
    enabledForPlans: ['ENTERPRISE'],
    isInternal: false,
  },
  {
    key: 'impersonation',
    name: 'Operator impersonation',
    description: 'Allow platform admins to impersonate users in this org.',
    defaultEnabled: true,
    enabledForPlans: ['BASIC', 'PRO', 'ACADEMY', 'ENTERPRISE'],
    isInternal: true,
  },
];

export async function seedBuiltinFlags(actor?: PlatformActor): Promise<number> {
  for (const flag of BUILTIN_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      create: {
        key: flag.key,
        name: flag.name,
        description: flag.description,
        defaultEnabled: flag.defaultEnabled,
        enabledForPlans: flag.enabledForPlans as SubscriptionPlan[],
        isInternal: flag.isInternal,
      },
      update: {
        name: flag.name,
        description: flag.description,
        enabledForPlans: flag.enabledForPlans as SubscriptionPlan[],
        isInternal: flag.isInternal,
      },
    });
  }
  if (actor) {
    await writePlatformAudit({
      adminId: actor.adminId,
      userId: actor.userId,
      action: 'FEATURE_FLAGS_SEEDED',
      category: 'FEATURE_FLAG',
      metadata: { count: BUILTIN_FLAGS.length },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }
  return BUILTIN_FLAGS.length;
}

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  return await prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
}

export async function getFeatureFlag(key: string): Promise<FeatureFlag> {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  if (!flag) throw new NotFoundError('Feature flag not found');
  return flag;
}

export async function upsertFeatureFlag(
  actor: PlatformActor,
  input: UpsertFeatureFlagInput,
): Promise<FeatureFlag> {
  const existing = await prisma.featureFlag.findUnique({ where: { key: input.key } });

  const upserted = await prisma.featureFlag.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      defaultEnabled: input.defaultEnabled ?? false,
      enabledForPlans: input.enabledForPlans ?? [],
      isInternal: input.isInternal ?? false,
    },
    update: {
      name: input.name,
      description: input.description ?? null,
      defaultEnabled: input.defaultEnabled,
      enabledForPlans: input.enabledForPlans,
      isInternal: input.isInternal,
    },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: existing ? 'FEATURE_FLAG_UPDATED' : 'FEATURE_FLAG_CREATED',
    category: 'FEATURE_FLAG',
    resourceType: 'FeatureFlag',
    resourceId: upserted.id,
    metadata: { key: upserted.key, changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return upserted;
}

export async function deleteFeatureFlag(actor: PlatformActor, key: string): Promise<void> {
  const existing = await prisma.featureFlag.findUnique({ where: { key } });
  if (!existing) throw new NotFoundError('Feature flag not found');

  await prisma.featureFlag.delete({ where: { key } });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: 'FEATURE_FLAG_DELETED',
    category: 'FEATURE_FLAG',
    resourceType: 'FeatureFlag',
    resourceId: existing.id,
    metadata: { key },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}
