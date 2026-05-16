// Familista — Super Admin White-label Control Panel
// File location: src/services/admin-rbac.service.ts
//
// Platform administrator CRUD. Only PLATFORM_OWNER may modify roles, deactivate
// admins, or change another owner's allowlist (enforced at controller layer).

import { prisma } from '../lib/prisma';
import { NotFoundError, ConflictError, BadRequestError } from '../utils/errors';
import { writePlatformAudit } from '../middleware/admin-rbac.middleware';
import type {
  CreatePlatformAdminInput,
  UpdatePlatformAdminInput,
} from '../utils/admin.validators';
import type { PlatformActor, PlatformAdminView } from '../types/admin.types';

const PLATFORM_ADMIN_INCLUDE = {
  user: {
    select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
  },
} as const;

export async function listPlatformAdmins(actor: PlatformActor): Promise<PlatformAdminView[]> {
  void actor;
  return await prisma.platformAdmin.findMany({
    include: PLATFORM_ADMIN_INCLUDE,
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function getPlatformAdmin(id: string): Promise<PlatformAdminView> {
  const admin = await prisma.platformAdmin.findUnique({
    where: { id },
    include: PLATFORM_ADMIN_INCLUDE,
  });
  if (!admin) throw new NotFoundError('Platform admin not found');
  return admin;
}

export async function createPlatformAdmin(
  actor: PlatformActor,
  input: CreatePlatformAdminInput,
): Promise<PlatformAdminView> {
  if (actor.role !== 'PLATFORM_OWNER' && input.role === 'PLATFORM_OWNER') {
    throw new BadRequestError('Only owners can grant the owner role');
  }

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new NotFoundError('Target user does not exist');

  const existing = await prisma.platformAdmin.findUnique({ where: { userId: input.userId } });
  if (existing) throw new ConflictError('User is already a platform admin');

  const created = await prisma.platformAdmin.create({
    data: {
      userId: input.userId,
      role: input.role,
      ipAllowlist: input.ipAllowlist ?? [],
      mfaEnforced: input.mfaEnforced ?? true,
      invitedBy: actor.userId,
      notes: input.notes ?? null,
    },
    include: PLATFORM_ADMIN_INCLUDE,
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: 'PLATFORM_ADMIN_CREATED',
    category: 'PLATFORM_ADMIN',
    resourceType: 'PlatformAdmin',
    resourceId: created.id,
    metadata: { role: created.role, targetUserId: created.userId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updatePlatformAdmin(
  actor: PlatformActor,
  id: string,
  input: UpdatePlatformAdminInput,
): Promise<PlatformAdminView> {
  const existing = await prisma.platformAdmin.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Platform admin not found');

  if (input.role && input.role !== existing.role) {
    if (actor.role !== 'PLATFORM_OWNER') {
      throw new BadRequestError('Only owners can change roles');
    }
    if (existing.role === 'PLATFORM_OWNER' && input.role !== 'PLATFORM_OWNER') {
      const ownersLeft = await prisma.platformAdmin.count({
        where: { role: 'PLATFORM_OWNER', isActive: true, id: { not: id } },
      });
      if (ownersLeft === 0) {
        throw new BadRequestError('Cannot demote the last active platform owner');
      }
    }
  }

  if (input.isActive === false && existing.role === 'PLATFORM_OWNER') {
    const ownersLeft = await prisma.platformAdmin.count({
      where: { role: 'PLATFORM_OWNER', isActive: true, id: { not: id } },
    });
    if (ownersLeft === 0) {
      throw new BadRequestError('Cannot deactivate the last active platform owner');
    }
  }

  const updated = await prisma.platformAdmin.update({
    where: { id },
    data: {
      role: input.role,
      ipAllowlist: input.ipAllowlist,
      mfaEnforced: input.mfaEnforced,
      isActive: input.isActive,
      notes: input.notes ?? undefined,
    },
    include: PLATFORM_ADMIN_INCLUDE,
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: 'PLATFORM_ADMIN_UPDATED',
    category: 'PLATFORM_ADMIN',
    resourceType: 'PlatformAdmin',
    resourceId: updated.id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function deletePlatformAdmin(actor: PlatformActor, id: string): Promise<void> {
  const existing = await prisma.platformAdmin.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Platform admin not found');

  if (existing.role === 'PLATFORM_OWNER') {
    const ownersLeft = await prisma.platformAdmin.count({
      where: { role: 'PLATFORM_OWNER', isActive: true, id: { not: id } },
    });
    if (ownersLeft === 0) {
      throw new BadRequestError('Cannot remove the last active platform owner');
    }
  }
  if (existing.id === actor.adminId) {
    throw new BadRequestError('You cannot remove your own platform admin record');
  }

  await prisma.platformAdmin.delete({ where: { id } });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: 'PLATFORM_ADMIN_REMOVED',
    category: 'PLATFORM_ADMIN',
    resourceType: 'PlatformAdmin',
    resourceId: id,
    metadata: { removedRole: existing.role, removedUserId: existing.userId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}
