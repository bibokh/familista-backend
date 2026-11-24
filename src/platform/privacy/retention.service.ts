/**
 * Familista Design Studio — retention of the personal data the studio keeps (P1).
 *
 * Rules are the platform's DataRetentionPolicy rows (global: clubId null), one per kind of data the studio keeps. None
 * is set by default and none is invented here: until the Owner sets a period, nothing is erased. The Owner previews
 * what a rule would do and applies it; the platform's retention worker (src/workers/retention.worker.ts) carries the
 * same sweepers for the day it is started, which has not happened.
 *
 *   ManufacturingRequestPerson   the names kept apart from closed requests' specifications: erased (the entries stay)
 *   DesignReviewComment          resolved review comments: deleted
 */
import { ManufacturingPersonState, ManufacturingRequestStatus as S } from '@prisma/client';
import { prisma } from '../../config/database';
import { ownerAudit } from '../manufacturing/supplier.service';
import type { DesignActor } from '../product-design/service';
import { retentionStatus } from '../../workers/retention.worker';

export const DESIGN_RETENTION_KINDS = ['ManufacturingRequestPerson', 'DesignReviewComment'] as const;
export type DesignRetentionKind = (typeof DESIGN_RETENTION_KINDS)[number];
const CLOSED: S[] = [S.DELIVERED, S.CANCELLED, S.DECLINED, S.REFUSED];
export const RETENTION_MAX_DAYS = 3650;
const DAY = 86_400_000;

export class RetentionInvalidError extends Error {
  readonly code = 'RETENTION_INVALID';
  constructor(message: string) { super(message); this.name = 'RetentionInvalidError'; }
}

/** What a rule would reach, before the cutoff: counted, or done. */
export const SWEEP: Record<DesignRetentionKind, (cutoff: Date, limit: number, dryRun: boolean) => Promise<number>> = {
  ManufacturingRequestPerson: async (cutoff, limit, dryRun) => {
    const where = { state: ManufacturingPersonState.KEPT, request: { status: { in: CLOSED }, updatedAt: { lt: cutoff } } };
    if (dryRun) return prisma.manufacturingRequestPerson.count({ where });
    const rows = await prisma.manufacturingRequestPerson.findMany({ where, take: limit, select: { id: true } });
    if (!rows.length) return 0;
    const r = await prisma.manufacturingRequestPerson.updateMany({ where: { id: { in: rows.map((x) => x.id) }, state: ManufacturingPersonState.KEPT },
      data: { state: ManufacturingPersonState.ERASED, name: null, erasedAt: new Date() } });
    return r.count;
  },
  DesignReviewComment: async (cutoff, limit, dryRun) => {
    const where = { resolvedAt: { lt: cutoff } };
    if (dryRun) return prisma.designReviewComment.count({ where });
    const rows = await prisma.designReviewComment.findMany({ where, take: limit, select: { id: true } });
    if (!rows.length) return 0;
    return (await prisma.designReviewComment.deleteMany({ where: { id: { in: rows.map((x) => x.id) } } })).count;
  },
};

export async function listRetention() {
  const rows = await prisma.dataRetentionPolicy.findMany({ where: { clubId: null, entityType: { in: [...DESIGN_RETENTION_KINDS] } },
    select: { entityType: true, retentionDays: true, isActive: true, publishedAt: true } });
  return { rules: DESIGN_RETENTION_KINDS.map((kind) => {
    const r = rows.find((x) => x.entityType === kind && x.isActive);
    return { kind, days: r ? r.retentionDays : null, setAt: r ? r.publishedAt : null };
  }), maxDays: RETENTION_MAX_DAYS, automatic: retentionStatus().running };
}

/** Set a rule's period in days, or clear it (null): cleared, nothing of that kind is erased. */
export async function setRetention(actor: DesignActor, kind: string, days: number | null) {
  if (!(DESIGN_RETENTION_KINDS as readonly string[]).includes(kind)) throw new RetentionInvalidError('Not a kind of data the studio keeps');
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > RETENTION_MAX_DAYS)) throw new RetentionInvalidError(`A period is 1 to ${RETENTION_MAX_DAYS} days`);
  await prisma.$transaction(async (tx) => {
    const current = await tx.dataRetentionPolicy.findFirst({ where: { clubId: null, entityType: kind }, select: { id: true, retentionDays: true, isActive: true } });
    if (days === null) { if (current) await tx.dataRetentionPolicy.delete({ where: { id: current.id } }); }
    else if (current) await tx.dataRetentionPolicy.update({ where: { id: current.id }, data: { retentionDays: days, isActive: true, publishedBy: actor.userId, publishedAt: new Date() } });
    else await tx.dataRetentionPolicy.create({ data: { clubId: null, entityType: kind, retentionDays: days, isActive: true, publishedBy: actor.userId } });
    await ownerAudit(tx, actor, { action: 'privacy.retention.set', resourceType: 'DataRetentionPolicy', resourceId: kind,
      metadata: { kind, from: current && current.isActive ? current.retentionDays : null, to: days }, message: 'A Design Studio retention rule was set' });
  });
  return listRetention();
}

/** Each rule that is set: what it reaches now (dry run), or what it did. */
export async function applyRetention(actor: DesignActor, dryRun: boolean, now: Date = new Date()) {
  const { rules } = await listRetention();
  const results: Array<{ kind: DesignRetentionKind; days: number; cutoff: string; affected: number }> = [];
  for (const r of rules) {
    if (r.days === null) continue;
    const cutoff = new Date(now.getTime() - r.days * DAY);
    let affected = 0;
    if (dryRun) affected = await SWEEP[r.kind](cutoff, 0, true);
    else for (let n = 1; n > 0;) { n = await SWEEP[r.kind](cutoff, 1000, false); affected += n; }
    results.push({ kind: r.kind, days: r.days, cutoff: cutoff.toISOString(), affected });
  }
  if (!dryRun) {
    await prisma.$transaction((tx) => ownerAudit(tx, actor, { action: 'privacy.retention.applied', resourceType: 'DataRetentionPolicy', resourceId: 'product-design',
      metadata: { results }, message: 'Design Studio retention rules were applied' }));
  }
  return { dryRun, results };
}
