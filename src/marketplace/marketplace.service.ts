// Familista — Digital Marketplace Foundation (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// Unified MarketplaceItem table with 5 kinds. NO payment integration in
// Phase M — listings only. Approval gate triggers on ACTIVE transitions
// of high-impact kinds.

import { MarketplaceItem, MarketplaceItemKind, MarketplaceItemStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { requestApproval } from '../security/ai-approval.service';

export interface MarketActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const HIGH_IMPACT_KINDS = new Set<MarketplaceItemKind>(['TRANSFER_LISTING']);

export interface CreateListingDto {
  kind:        MarketplaceItemKind;
  title:       string;
  description?: string;
  payload:     Prisma.InputJsonValue;
  validFrom?:  string;
  validUntil?: string;
}

export async function createListing(actor: MarketActor, dto: CreateListingDto): Promise<MarketplaceItem> {
  if (!dto.kind || !dto.title || dto.payload === undefined) throw new BadRequestError('kind + title + payload required');
  const row = await prisma.marketplaceItem.create({
    data: {
      clubId:      actor.clubId,
      kind:        dto.kind,
      title:       dto.title,
      description: dto.description ?? null,
      payload:     dto.payload,
      status:      'DRAFT',
      validFrom:   dto.validFrom ? new Date(dto.validFrom) : null,
      validUntil:  dto.validUntil ? new Date(dto.validUntil) : null,
      createdById: actor.userId,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `MARKETPLACE_LISTED:${dto.kind}`, entityType: 'MarketplaceItem', entityId: row.id,
    payload: { kind: dto.kind, title: dto.title },
  });
  return row;
}

export async function activateListing(actor: MarketActor, id: string): Promise<MarketplaceItem> {
  const item = await prisma.marketplaceItem.findUnique({ where: { id } });
  if (!item)                                                       throw new NotFoundError('MarketplaceItem');
  if (item.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  // High-impact kinds require approval before going ACTIVE.
  if (HIGH_IMPACT_KINDS.has(item.kind)) {
    await requestApproval(
      { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
      { agent: 'CLUB_MANAGER', kind: 'APPROVE_TRANSFER', payload: { listingId: id, kind: item.kind } as Prisma.InputJsonValue, jobId: null, ttlMs: 48 * 60 * 60_000 },
    );
    // Stay in DRAFT — the worker / manual operator flips to ACTIVE after approval.
    return item;
  }
  return prisma.marketplaceItem.update({ where: { id }, data: { status: 'ACTIVE' } });
}

export async function closeListing(actor: MarketActor, id: string): Promise<MarketplaceItem> {
  const item = await prisma.marketplaceItem.findUnique({ where: { id } });
  if (!item)                                                       throw new NotFoundError('MarketplaceItem');
  if (item.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.marketplaceItem.update({ where: { id }, data: { status: 'CLOSED' } });
}

export async function listMarketplace(actor: MarketActor, opts: { kind?: MarketplaceItemKind; status?: MarketplaceItemStatus; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.MarketplaceItemWhereInput = {
    clubId: actor.clubId,
    ...(opts.kind   ? { kind: opts.kind } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.marketplaceItem.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 200) }),
    prisma.marketplaceItem.count({ where }),
  ]);
  return { items, total, page, limit };
}
