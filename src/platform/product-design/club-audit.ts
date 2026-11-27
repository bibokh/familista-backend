/**
 * Familista Design Studio — one audit entry for a change a tenant makes to its own Design Studio or manufacturing records
 * (a club: its brand kit, M2c; its team rosters, M3; a creator: the same, P2). Written in the change's own transaction,
 * with the owner, the actor and the request's correlation id. A club's change names the club and its user; a creator's
 * names the creator alone, never as a club user. Callers put sizes, counts and hashes in `metadata`, never an image or a
 * person's name.
 */
import { PlatformAuditCategory, Prisma } from '@prisma/client';
import { currentEnvironment } from '../environment';
import type { Tenant } from '../tenancy/tenant';
import type { DesignActor } from './service';

export async function tenantAudit(
  tx: Prisma.TransactionClient, tenant: Tenant, actor: DesignActor,
  entry: { action: string; resourceType: string; resourceId: string; metadata: Record<string, unknown>; message: string },
): Promise<void> {
  const owner = tenant.kind === 'club' ? { userId: actor.userId, clubId: tenant.clubId, creatorId: null } : { userId: null, clubId: null, creatorId: tenant.creatorId };
  // P4: on a creator's record, an action by another creator (a collaborator's note) names who took it.
  const by = tenant.kind === 'creator' && actor.userId && actor.userId !== tenant.creatorId ? { actorCreatorId: actor.userId } : {};
  await tx.platformAuditLog.create({
    data: {
      adminId: null, ...owner, action: entry.action, category: PlatformAuditCategory.ASSET,
      resourceType: entry.resourceType, resourceId: entry.resourceId,
      ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      metadata: { ...entry.metadata, ...by, environment: currentEnvironment(), correlationId: actor.correlationId ?? null } as Prisma.InputJsonValue,
      message: entry.message,
    },
  });
}
