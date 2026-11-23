/**
 * Familista Design Studio — one audit entry for a change a club makes to its own Design Studio records (its brand kit,
 * M2c; its team rosters, M3). Written in the change's own transaction, with the club, the actor and the request's
 * correlation id. Callers put sizes, counts and hashes in `metadata`, never an image or a person's name.
 */
import { PlatformAuditCategory, Prisma } from '@prisma/client';
import { currentEnvironment } from '../environment';
import type { DesignActor } from './service';

export async function clubAudit(
  tx: Prisma.TransactionClient, clubId: string, actor: DesignActor,
  entry: { action: string; resourceType: string; resourceId: string; metadata: Record<string, unknown>; message: string },
): Promise<void> {
  await tx.platformAuditLog.create({
    data: {
      adminId: null, userId: actor.userId, clubId, action: entry.action, category: PlatformAuditCategory.ASSET,
      resourceType: entry.resourceType, resourceId: entry.resourceId,
      ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      metadata: { ...entry.metadata, environment: currentEnvironment(), correlationId: actor.correlationId ?? null } as Prisma.InputJsonValue,
      message: entry.message,
    },
  });
}
