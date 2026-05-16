// Familista — Executive OS · Integration Layer
// File location: src/services/executive-sponsor.service.ts
//
// Sponsor pipeline CRUD + stage transition machine. Sponsor contracts may
// also drive revenue distribution (via the existing franchise revenue
// engine), but that wiring is operator-triggered, not automatic — sponsors
// move through the pipeline here, and the operator separately records the
// resulting Financial / RevenueDistribution events when money lands.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  SponsorOpportunity,
  SponsorPipelineStage,
  SponsorTier,
} from '@prisma/client';
import {
  BadRequestError,
  NotFoundError,
} from '../utils/errors';
import { writeExecutiveAudit } from './executive-audit.service';
import type {
  CreateSponsorInput,
  UpdateSponsorInput,
  TransitionSponsorStageInput,
} from '../utils/executive.validators';
import type { ExecutiveActor } from '../types/executive.types';

const STAGE_TRANSITIONS: Record<SponsorPipelineStage, ReadonlyArray<SponsorPipelineStage>> = {
  PROSPECT:        ['QUALIFIED', 'REJECTED'],
  QUALIFIED:       ['PROPOSAL_SENT', 'REJECTED'],
  PROPOSAL_SENT:   ['IN_NEGOTIATION', 'REJECTED'],
  IN_NEGOTIATION:  ['CONTRACT_SIGNED', 'REJECTED'],
  CONTRACT_SIGNED: ['ACTIVE', 'REJECTED'],
  ACTIVE:          ['RENEWAL', 'CHURNED'],
  RENEWAL:         ['ACTIVE', 'CHURNED'],
  CHURNED:         [],
  REJECTED:        [],
};

function assertStageTransition(from: SponsorPipelineStage, to: SponsorPipelineStage): void {
  if (from === to) return;
  if (!STAGE_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Sponsor stage transition ${from} → ${to} not allowed`);
  }
}

export async function createSponsor(actor: ExecutiveActor, input: CreateSponsorInput): Promise<SponsorOpportunity> {
  const created = await prisma.sponsorOpportunity.create({
    data: {
      name: input.name,
      tier: input.tier,
      clubId: input.clubId ?? null,
      franchiseUnitId: input.franchiseUnitId ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      websiteUrl: input.websiteUrl ?? null,
      industry: input.industry ?? null,
      countryCode: input.countryCode ?? null,
      proposedValue: input.proposedValue ?? null,
      currency: input.currency ?? 'EUR',
      termMonths: input.termMonths ?? null,
      ownedBy: actor.userId,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeExecutiveAudit({
    opportunityId: created.id,
    userId: actor.userId,
    action: 'SPONSOR_CREATED',
    category: 'SPONSOR',
    resourceType: 'SponsorOpportunity',
    resourceId: created.id,
    metadata: { tier: created.tier, clubId: created.clubId, franchiseUnitId: created.franchiseUnitId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateSponsor(
  actor: ExecutiveActor,
  id: string,
  input: UpdateSponsorInput,
): Promise<SponsorOpportunity> {
  const existing = await prisma.sponsorOpportunity.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Sponsor opportunity not found');

  const updated = await prisma.sponsorOpportunity.update({
    where: { id },
    data: {
      name: input.name,
      tier: input.tier,
      contactName: input.contactName ?? undefined,
      contactEmail: input.contactEmail ?? undefined,
      contactPhone: input.contactPhone ?? undefined,
      websiteUrl: input.websiteUrl ?? undefined,
      industry: input.industry ?? undefined,
      countryCode: input.countryCode ?? undefined,
      proposedValue: input.proposedValue ?? undefined,
      contractedValue: input.contractedValue ?? undefined,
      currency: input.currency,
      termMonths: input.termMonths ?? undefined,
      startsAt: input.startsAt === undefined ? undefined : input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt === undefined ? undefined : input.endsAt ? new Date(input.endsAt) : null,
      agreementUrl: input.agreementUrl ?? undefined,
      agreementChecksum: input.agreementChecksum ?? undefined,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeExecutiveAudit({
    opportunityId: id,
    userId: actor.userId,
    action: 'SPONSOR_UPDATED',
    category: 'SPONSOR',
    resourceType: 'SponsorOpportunity',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function transitionSponsorStage(
  actor: ExecutiveActor,
  id: string,
  input: TransitionSponsorStageInput,
): Promise<SponsorOpportunity> {
  const existing = await prisma.sponsorOpportunity.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Sponsor opportunity not found');

  assertStageTransition(existing.stage, input.stage);

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.sponsorOpportunity.update({
      where: { id },
      data: { stage: input.stage },
    });
    await tx.sponsorPipelineEvent.create({
      data: {
        opportunityId: id,
        fromStage: existing.stage,
        toStage: input.stage,
        notes: input.notes ?? null,
        changedBy: actor.userId,
      },
    });
    return next;
  });

  await writeExecutiveAudit({
    opportunityId: id,
    userId: actor.userId,
    action: 'SPONSOR_STAGE_CHANGED',
    category: 'SPONSOR',
    resourceType: 'SponsorOpportunity',
    resourceId: id,
    metadata: { from: existing.stage, to: input.stage, notes: input.notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listSponsors(opts: {
  stage?: SponsorPipelineStage;
  tier?: SponsorTier;
  clubId?: string;
  franchiseUnitId?: string;
  ownedBy?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.sponsorOpportunity.findMany({
    where: {
      ...(opts.stage ? { stage: opts.stage } : {}),
      ...(opts.tier ? { tier: opts.tier } : {}),
      ...(opts.clubId ? { clubId: opts.clubId } : {}),
      ...(opts.franchiseUnitId ? { franchiseUnitId: opts.franchiseUnitId } : {}),
      ...(opts.ownedBy ? { ownedBy: opts.ownedBy } : {}),
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getSponsor(id: string) {
  const sponsor = await prisma.sponsorOpportunity.findUnique({
    where: { id },
    include: { events: { orderBy: { createdAt: 'desc' } } },
  });
  if (!sponsor) throw new NotFoundError('Sponsor opportunity not found');
  return sponsor;
}
