// Familista — Vision Intelligence Engine
// File location: src/services/vision-audit.service.ts
//
// Audit log for the vision stack. Every ingest stage transition, inference
// callback, analytics run, fusion run, clip request, scouting generation,
// event override, and live publish writes a row here. Reads support
// filter + cursor pagination + summary aggregates.

import { prisma } from '../lib/prisma';
import type {
  VisionAudit,
  VisionAuditCategory,
  VisionAuditResult,
  Prisma,
} from '@prisma/client';
import type { VisionAuditQueryInput } from '../utils/vision.validators';

export type WriteVisionAuditOpts = {
  analysisId?: string | null;
  videoAssetId?: string | null;
  matchId?: string | null;
  userId?: string | null;
  action: string;
  category: VisionAuditCategory;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  result?: VisionAuditResult;
  message?: string | null;
};

export async function writeVisionAudit(opts: WriteVisionAuditOpts): Promise<void> {
  try {
    await prisma.visionAudit.create({
      data: {
        analysisId: opts.analysisId ?? null,
        videoAssetId: opts.videoAssetId ?? null,
        matchId: opts.matchId ?? null,
        userId: opts.userId ?? null,
        action: opts.action,
        category: opts.category,
        resourceType: opts.resourceType ?? null,
        resourceId: opts.resourceId ?? null,
        metadata:
          opts.metadata === undefined || opts.metadata === null
            ? undefined
            : (opts.metadata as Prisma.InputJsonValue),
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
        result: opts.result ?? 'SUCCESS',
        message: opts.message ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('vision audit write failed', err);
  }
}

export type VisionAuditPage = {
  items: VisionAudit[];
  nextCursor: string | null;
};

function buildWhere(q: VisionAuditQueryInput): Prisma.VisionAuditWhereInput {
  const where: Prisma.VisionAuditWhereInput = {};
  if (q.analysisId) where.analysisId = q.analysisId;
  if (q.matchId) where.matchId = q.matchId;
  if (q.userId) where.userId = q.userId;
  if (q.action) where.action = q.action;
  if (q.category) where.category = q.category as VisionAuditCategory;
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  return where;
}

export async function searchVisionAudit(q: VisionAuditQueryInput): Promise<VisionAuditPage> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const items = await prisma.visionAudit.findMany({
    where: buildWhere(q),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function summarizeVisionAudit(q: VisionAuditQueryInput) {
  const where = buildWhere(q);
  const [total, byCategory, byResult, recentFailures] = await Promise.all([
    prisma.visionAudit.count({ where }),
    prisma.visionAudit.groupBy({ where, by: ['category'], _count: { _all: true } }),
    prisma.visionAudit.groupBy({ where, by: ['result'], _count: { _all: true } }),
    prisma.visionAudit.findMany({
      where: { ...where, result: { in: ['FAILURE', 'REJECTED'] } },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
  ]);

  return {
    total,
    byCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._count._all])),
    byResult: Object.fromEntries(byResult.map((r) => [r.result, r._count._all])),
    recentFailures,
  };
}
