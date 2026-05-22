// Familista — Enterprise billing plans + usage (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// ARCHITECTURE-ONLY. No payment gateway. No external API calls.
//
// We model:
//   - BillingPlanTier         : catalog (e.g. "Club Pro", "Federation",
//                                "Device AI Premium")
//   - BillingAccount          : one row per Club's active subscription
//   - DevicePlanAssignment    : per-device hardware/AI tier
//   - UsageMeter              : append-only usage rows
//   - InvoiceDraft            : placeholder invoice (NO Stripe wiring)
//
// Default tiers are seeded idempotently at boot via ensureDefaultTiers().

import { BillingAccount, BillingAccountStatus, BillingPlanKind, BillingPlanTier, DevicePlanAssignment, InvoiceDraft, Prisma, UsageMeter } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface BillingActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─────────────────────────────────────────────────────────────────────────
// Plan catalog
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_TIERS: Array<{ code: string; kind: BillingPlanKind; label: string; monthlyCents: number; features: Record<string, unknown> }> = [
  { code: 'CLUB_BASIC',    kind: 'CLUB',       label: 'Club Basic',       monthlyCents: 19900,  features: { maxPlayers: 50,  aiJobsPerDay: 50,   sseStreams: 2 } },
  { code: 'CLUB_PRO',      kind: 'CLUB',       label: 'Club Pro',         monthlyCents: 49900,  features: { maxPlayers: 200, aiJobsPerDay: 500,  sseStreams: 10, devices: 50 } },
  { code: 'FEDERATION',    kind: 'FEDERATION', label: 'Federation',       monthlyCents: 249900, features: { clubs: 100, federationDashboard: true } },
  { code: 'ACADEMY',       kind: 'ACADEMY',    label: 'Academy',          monthlyCents: 29900,  features: { maxPlayers: 500, devices: 100, training: true } },
  { code: 'DEVICE_HW_STD', kind: 'DEVICE_HW',  label: 'Hardware Standard', monthlyCents: 2900,  features: { otaChannel: 'stable' } },
  { code: 'DEVICE_AI_PRO', kind: 'DEVICE_AI',  label: 'Edge AI Pro',       monthlyCents: 9900,  features: { edgeInference: true, neuromorphic: true } },
  { code: 'ANALYTICS_PRO', kind: 'ANALYTICS',  label: 'Analytics Pro',     monthlyCents: 14900, features: { predictiveLayer: true, replayRetentionDays: 365 } },
];

export async function ensureDefaultTiers(): Promise<void> {
  for (const t of DEFAULT_TIERS) {
    try {
      await prisma.billingPlanTier.upsert({
        where:  { code: t.code },
        create: { code: t.code, kind: t.kind, label: t.label, monthlyCents: t.monthlyCents, features: t.features as Prisma.InputJsonValue, isActive: true },
        update: { /* no-op — never overwrite operator changes */ },
      });
    } catch (err) {
      logger.warn('[billing] seed tier failed', { code: t.code, err: (err as Error).message });
    }
  }
}

export async function listTiers(opts: { kind?: BillingPlanKind; activeOnly?: boolean } = {}): Promise<BillingPlanTier[]> {
  return prisma.billingPlanTier.findMany({
    where: {
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ kind: 'asc' }, { monthlyCents: 'asc' }],
  });
}

export async function getTierByCode(code: string): Promise<BillingPlanTier | null> {
  return prisma.billingPlanTier.findUnique({ where: { code } });
}

// ─────────────────────────────────────────────────────────────────────────
// Account management (DTO-level only — no gateway side effects)
// ─────────────────────────────────────────────────────────────────────────

export async function getOrCreateAccount(actor: BillingActor, planCode?: string): Promise<BillingAccount> {
  const existing = await prisma.billingAccount.findUnique({ where: { clubId: actor.clubId } });
  if (existing) return existing;
  const tier = planCode
    ? await prisma.billingPlanTier.findUnique({ where: { code: planCode } })
    : await prisma.billingPlanTier.findUnique({ where: { code: 'CLUB_BASIC' } });
  if (!tier) throw new BadRequestError('Plan tier not found');
  return prisma.billingAccount.create({
    data: {
      clubId:     actor.clubId,
      planTierId: tier.id,
      status:     'TRIAL',
    },
  });
}

export async function getAccount(actor: BillingActor): Promise<BillingAccount | null> {
  return prisma.billingAccount.findUnique({ where: { clubId: actor.clubId } });
}

export async function changePlan(actor: BillingActor, planCode: string): Promise<BillingAccount> {
  const tier = await getTierByCode(planCode);
  if (!tier) throw new NotFoundError('BillingPlanTier');
  const acc = await getOrCreateAccount(actor);
  return prisma.billingAccount.update({
    where: { id: acc.id },
    data:  { planTierId: tier.id, status: 'ACTIVE' },
  });
}

export async function cancelAccount(actor: BillingActor): Promise<BillingAccount> {
  const acc = await prisma.billingAccount.findUnique({ where: { clubId: actor.clubId } });
  if (!acc) throw new NotFoundError('BillingAccount');
  return prisma.billingAccount.update({
    where: { id: acc.id },
    data:  { status: 'CANCELED', canceledAt: new Date() },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Device plan assignments
// ─────────────────────────────────────────────────────────────────────────

export async function assignDevicePlan(actor: BillingActor, deviceId: string, planCode: string): Promise<DevicePlanAssignment> {
  const d = await prisma.device.findUnique({ where: { id: deviceId }, select: { clubId: true } });
  if (!d)                                                       throw new NotFoundError('Device');
  if (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  const tier = await getTierByCode(planCode);
  if (!tier) throw new NotFoundError('BillingPlanTier');
  // End previous active assignment, if any.
  await prisma.devicePlanAssignment.updateMany({
    where: { deviceId, status: 'ACTIVE' },
    data:  { status: 'CANCELED', endedAt: new Date() },
  });
  return prisma.devicePlanAssignment.create({
    data: { deviceId, planTierId: tier.id, status: 'ACTIVE' },
  });
}

export async function listDevicePlans(actor: BillingActor, deviceId: string): Promise<DevicePlanAssignment[]> {
  const d = await prisma.device.findUnique({ where: { id: deviceId }, select: { clubId: true } });
  if (!d || (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.devicePlanAssignment.findMany({ where: { deviceId }, orderBy: { startedAt: 'desc' } });
}

// ─────────────────────────────────────────────────────────────────────────
// Usage meter
// ─────────────────────────────────────────────────────────────────────────

/** Append-only usage write. Best-effort — never throws back. */
export async function recordUsage(args: { clubId: string; kind: string; count?: number; period?: string; metadata?: Prisma.InputJsonValue }): Promise<UsageMeter | null> {
  try {
    const period = args.period ?? new Date().toISOString().slice(0, 7);   // yyyy-MM
    return await prisma.usageMeter.create({
      data: {
        clubId:   args.clubId,
        kind:     args.kind,
        count:    BigInt(args.count ?? 1),
        period,
        metadata: (args.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.warn('[billing] recordUsage failed', { kind: args.kind, err: (err as Error).message });
    return null;
  }
}

export async function listUsage(actor: BillingActor, opts: { period?: string; kind?: string; limit?: number } = {}): Promise<UsageMeter[]> {
  return prisma.usageMeter.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.period ? { period: opts.period } : {}),
      ...(opts.kind   ? { kind:   opts.kind } : {}),
    },
    orderBy: { capturedAt: 'desc' },
    take: Math.min(opts.limit ?? 200, 2000),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Invoice drafts (placeholder — no payment gateway)
// ─────────────────────────────────────────────────────────────────────────

export async function createInvoiceDraft(actor: BillingActor, opts: { periodFrom: string; periodTo: string; amountCents?: number; lineItems?: Prisma.InputJsonValue }): Promise<InvoiceDraft> {
  const acc = await getAccount(actor);
  if (!acc) throw new NotFoundError('BillingAccount');
  return prisma.invoiceDraft.create({
    data: {
      billingAccountId: acc.id,
      periodFrom: new Date(opts.periodFrom),
      periodTo:   new Date(opts.periodTo),
      amountCents: opts.amountCents ?? 0,
      lineItems:   (opts.lineItems ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      status:      'TRIAL',
    },
  });
}

export async function listInvoiceDrafts(actor: BillingActor): Promise<InvoiceDraft[]> {
  const acc = await getAccount(actor);
  if (!acc) return [];
  return prisma.invoiceDraft.findMany({
    where: { billingAccountId: acc.id },
    orderBy: { periodFrom: 'desc' },
    take: 100,
  });
}
