// Familista — Global Investor Layer
// File location: src/services/investor-profile.service.ts
//
// InvestorProfile CRUD + KYC state machine. Links optional User and
// FranchiseOwner records for cross-system continuity.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type { InvestorProfile, InvestorType, KycStatus } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import type {
  CreateInvestorProfileInput,
  UpdateInvestorProfileInput,
  UpdateKycStatusInput,
} from '../utils/investor.validators';
import type { InvestorActor } from '../types/investor.types';

const KYC_TRANSITIONS: Record<KycStatus, ReadonlyArray<KycStatus>> = {
  PENDING:    ['IN_REVIEW', 'VERIFIED', 'REJECTED'],
  IN_REVIEW:  ['VERIFIED', 'REJECTED', 'PENDING'],
  VERIFIED:   ['EXPIRED', 'REJECTED'],
  REJECTED:   ['PENDING', 'IN_REVIEW'],
  EXPIRED:    ['IN_REVIEW', 'VERIFIED'],
};

function assertKycTransition(from: KycStatus, to: KycStatus): void {
  if (from === to) return;
  if (!KYC_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`KYC transition ${from} → ${to} not allowed`);
  }
}

export async function createProfile(
  actor: InvestorActor,
  input: CreateInvestorProfileInput,
): Promise<InvestorProfile> {
  if (input.userId) {
    const collision = await prisma.investorProfile.findUnique({ where: { userId: input.userId } });
    if (collision) throw new ConflictError('An investor profile already exists for that user');
  }

  if (input.linkedFranchiseOwnerId) {
    const collision = await prisma.investorProfile.findFirst({
      where: { linkedFranchiseOwnerId: input.linkedFranchiseOwnerId },
    });
    if (collision) throw new ConflictError('That franchise owner is already linked to an investor profile');
  }

  const created = await prisma.investorProfile.create({
    data: {
      type: input.type,
      entityType: input.entityType,
      displayName: input.displayName,
      legalName: input.legalName ?? null,
      userId: input.userId ?? null,
      linkedFranchiseOwnerId: input.linkedFranchiseOwnerId ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      countryCode: input.countryCode ?? null,
      taxId: input.taxId ?? null,
      legalAddress: input.legalAddress ?? null,
      accredited: input.accredited ?? false,
      aumUsd: input.aumUsd ?? null,
      targetSectors: input.targetSectors ?? [],
      targetGeographies: input.targetGeographies ?? [],
      notes: input.notes ?? null,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeInvestorAudit({
    investorId: created.id,
    userId: actor.userId,
    action: 'INVESTOR_PROFILE_CREATED',
    category: 'PROFILE',
    resourceType: 'InvestorProfile',
    resourceId: created.id,
    metadata: { type: created.type, entityType: created.entityType, displayName: created.displayName },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateProfile(
  actor: InvestorActor,
  id: string,
  input: UpdateInvestorProfileInput,
): Promise<InvestorProfile> {
  const existing = await prisma.investorProfile.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Investor profile not found');

  if (input.userId && input.userId !== existing.userId) {
    const collision = await prisma.investorProfile.findUnique({ where: { userId: input.userId } });
    if (collision && collision.id !== id) {
      throw new ConflictError('That user is already linked to another investor profile');
    }
  }

  const updated = await prisma.investorProfile.update({
    where: { id },
    data: {
      type: input.type,
      entityType: input.entityType,
      displayName: input.displayName,
      legalName: input.legalName ?? undefined,
      userId: input.userId === undefined ? undefined : input.userId,
      linkedFranchiseOwnerId: input.linkedFranchiseOwnerId === undefined ? undefined : input.linkedFranchiseOwnerId,
      contactName: input.contactName ?? undefined,
      contactEmail: input.contactEmail ?? undefined,
      contactPhone: input.contactPhone ?? undefined,
      countryCode: input.countryCode ?? undefined,
      taxId: input.taxId ?? undefined,
      legalAddress: input.legalAddress ?? undefined,
      accredited: input.accredited,
      aumUsd: input.aumUsd ?? undefined,
      targetSectors: input.targetSectors,
      targetGeographies: input.targetGeographies,
      notes: input.notes ?? undefined,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
      isActive: input.isActive,
    },
  });

  await writeInvestorAudit({
    investorId: id,
    userId: actor.userId,
    action: 'INVESTOR_PROFILE_UPDATED',
    category: 'PROFILE',
    resourceType: 'InvestorProfile',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function getProfile(id: string) {
  const profile = await prisma.investorProfile.findUnique({
    where: { id },
    include: {
      _count: {
        select: { investments: true, capTableEntries: true, rights: true, boardSeats: true, distributions: true },
      },
    },
  });
  if (!profile) throw new NotFoundError('Investor profile not found');
  return profile;
}

export async function getProfileByUserId(userId: string): Promise<InvestorProfile | null> {
  return await prisma.investorProfile.findUnique({ where: { userId } });
}

export async function listProfiles(opts: {
  type?: InvestorType;
  kycStatus?: KycStatus;
  countryCode?: string;
  search?: string;
  activeOnly?: boolean;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.investorProfile.findMany({
    where: {
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.kycStatus ? { kycStatus: opts.kycStatus } : {}),
      ...(opts.countryCode ? { countryCode: opts.countryCode } : {}),
      ...(opts.activeOnly !== false ? { isActive: true } : {}),
      ...(opts.search
        ? {
            OR: [
              { displayName: { contains: opts.search, mode: 'insensitive' as const } },
              { legalName: { contains: opts.search, mode: 'insensitive' as const } },
              { contactEmail: { contains: opts.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ displayName: 'asc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function updateKycStatus(
  actor: InvestorActor,
  id: string,
  input: UpdateKycStatusInput,
): Promise<InvestorProfile> {
  const existing = await prisma.investorProfile.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Investor profile not found');

  assertKycTransition(existing.kycStatus, input.kycStatus);

  const updated = await prisma.investorProfile.update({
    where: { id },
    data: {
      kycStatus: input.kycStatus,
      kycVerifiedAt:
        input.kycStatus === 'VERIFIED'
          ? input.kycVerifiedAt
            ? new Date(input.kycVerifiedAt)
            : new Date()
          : input.kycVerifiedAt === undefined
            ? undefined
            : input.kycVerifiedAt
              ? new Date(input.kycVerifiedAt)
              : null,
      kycExpiresAt: input.kycExpiresAt === undefined ? undefined : input.kycExpiresAt ? new Date(input.kycExpiresAt) : null,
      notes: input.notes ?? undefined,
    },
  });

  await writeInvestorAudit({
    investorId: id,
    userId: actor.userId,
    action: 'KYC_STATUS_CHANGED',
    category: 'PROFILE',
    resourceType: 'InvestorProfile',
    resourceId: id,
    metadata: { from: existing.kycStatus, to: input.kycStatus, notes: input.notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: input.kycStatus === 'REJECTED' ? 'REJECTED' : 'SUCCESS',
  });

  return updated;
}

export async function expireStaleKyc(): Promise<{ expired: number }> {
  const now = new Date();
  const result = await prisma.investorProfile.updateMany({
    where: { kycStatus: 'VERIFIED', kycExpiresAt: { lt: now } },
    data: { kycStatus: 'EXPIRED' },
  });
  return { expired: result.count };
}
