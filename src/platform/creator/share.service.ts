/**
 * Familista Creator Studio (P4) — a creator shares one of their designs with another creator, to see it (VIEW) or to
 * comment on it too (COMMENT). The owner alone edits the design, resolves notes and approves versions.
 *
 * The owner names the collaborator by the address of their creator account; there is no other way to name one. A share
 * is only ever revoked, never changed (a trigger), and one design has at most SHARE_LIMIT live shares. Every share and
 * revocation is audited on the owner's account.
 *
 * The database is the line: a grantee's queries run in the grantee's own creator context, and row-level security admits
 * exactly what a live share gives (20261125200000_creator_sharing). These functions check the same share first so a
 * refusal has a clear answer; without them, the database would still return nothing and write nothing.
 */
import { CreatorStatus, DesignShareRole, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { NotFoundError } from '../../utils/errors';
import { tenantAudit } from '../product-design/club-audit';
import type { DesignActor } from '../product-design/service';
import { creatorTenant } from '../tenancy/tenant';
import { normaliseEmail } from './account.service';

export const SHARE_LIMIT = 20;

export class ShareRefusedError extends Error {
  readonly code = 'SHARE_REFUSED';
  constructor(readonly reason: 'bad-email' | 'bad-role' | 'no-creator' | 'self' | 'exists' | 'limit') { super(`share refused: ${reason}`); this.name = 'ShareRefusedError'; }
}

export interface ShareView { id: string; role: DesignShareRole; createdAt: Date; grantee: { id: string; displayName: string | null; email: string | null } }
export interface LiveShare { id: string; creatorId: string; role: DesignShareRole }

async function ownProject(ownerId: string, projectId: string) {
  const p = await prisma.designProject.findFirst({ where: { id: projectId, creatorId: ownerId }, select: { id: true, name: true } });
  if (!p) throw new NotFoundError('Design project');
  return p;
}
async function people(ids: string[]) {
  if (!ids.length) return new Map<string, { displayName: string | null; email: string | null; status: CreatorStatus }>();
  const rows = await prisma.creatorAccount.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, displayName: true, email: true, status: true } });
  return new Map(rows.map((r) => [r.id, { displayName: r.displayName, email: r.status === CreatorStatus.DELETED ? null : r.email, status: r.status }]));
}

/** The design's live shares, for its owner. */
export async function listShares(ownerId: string, projectId: string): Promise<{ shares: ShareView[]; limit: number }> {
  await ownProject(ownerId, projectId);
  const rows = await prisma.designShare.findMany({ where: { projectId, creatorId: ownerId, revokedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, role: true, createdAt: true, granteeId: true } });
  const who = await people(rows.map((r) => r.granteeId));
  return { shares: rows.map((r) => ({ id: r.id, role: r.role, createdAt: r.createdAt, grantee: { id: r.granteeId, displayName: who.get(r.granteeId)?.displayName ?? null, email: who.get(r.granteeId)?.email ?? null } })), limit: SHARE_LIMIT };
}

/** Share the design with the creator whose account uses this address. */
export async function shareProject(ownerId: string, actor: DesignActor, projectId: string, input: { email: unknown; role: unknown }): Promise<{ share: ShareView }> {
  const email = typeof input.email === 'string' ? normaliseEmail(input.email) : '';
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/.test(email)) throw new ShareRefusedError('bad-email');
  if (input.role !== 'VIEW' && input.role !== 'COMMENT') throw new ShareRefusedError('bad-role');
  const role = input.role as DesignShareRole;
  const project = await ownProject(ownerId, projectId);
  const grantee = await prisma.creatorAccount.findUnique({ where: { email }, select: { id: true, displayName: true, email: true, status: true } });
  if (!grantee || grantee.status !== CreatorStatus.ACTIVE) throw new ShareRefusedError('no-creator');
  if (grantee.id === ownerId) throw new ShareRefusedError('self');
  return prisma.$transaction(async (tx) => {
    if ((await tx.designShare.count({ where: { projectId, creatorId: ownerId, revokedAt: null } })) >= SHARE_LIMIT) throw new ShareRefusedError('limit');
    let row;
    try {
      row = await tx.designShare.create({ data: { projectId, creatorId: ownerId, granteeId: grantee.id, role }, select: { id: true, role: true, createdAt: true } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ShareRefusedError('exists');
      throw err;
    }
    await tenantAudit(tx, creatorTenant(ownerId), actor, { action: 'design.share.created', resourceType: 'DesignProject', resourceId: project.id,
      metadata: { shareId: row.id, role, granteeId: grantee.id }, message: 'A design was shared with another creator' });
    return { share: { ...row, grantee: { id: grantee.id, displayName: grantee.displayName, email: grantee.email } } };
  });
}

/** End a share. Its record stays; a share already ended answers as it is. */
export async function revokeShare(ownerId: string, actor: DesignActor, projectId: string, shareId: string): Promise<{ revoked: true }> {
  await ownProject(ownerId, projectId);
  return prisma.$transaction(async (tx) => {
    const n = await tx.designShare.updateMany({ where: { id: shareId, projectId, creatorId: ownerId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (n.count !== 1) {
      if (!(await tx.designShare.findFirst({ where: { id: shareId, projectId, creatorId: ownerId }, select: { id: true } }))) throw new NotFoundError('Share');
      return { revoked: true as const };
    }
    await tenantAudit(tx, creatorTenant(ownerId), actor, { action: 'design.share.revoked', resourceType: 'DesignProject', resourceId: projectId,
      metadata: { shareId }, message: 'A share of a design was revoked' });
    return { revoked: true as const };
  });
}

/** The live share of this design with this creator, or null: what every grantee route checks first. */
export async function liveShare(granteeId: string, projectId: string): Promise<LiveShare | null> {
  return prisma.designShare.findFirst({ where: { projectId, granteeId, revokedAt: null }, select: { id: true, creatorId: true, role: true } });
}

/** Designs other creators have shared with this one, newest change first. An archived design is not offered. */
export async function sharedWithMe(granteeId: string) {
  const rows = await prisma.designShare.findMany({ where: { granteeId, revokedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 200,
    select: { role: true, createdAt: true, creatorId: true, project: { select: { id: true, name: true, templateKey: true, templateVersion: true, headRevision: true, updatedAt: true, archivedAt: true } } } });
  const who = await people(rows.map((r) => r.creatorId));
  return { designs: rows.filter((r) => !r.project.archivedAt).map((r) => ({
    id: r.project.id, name: r.project.name, templateKey: r.project.templateKey, templateVersion: r.project.templateVersion, headRevision: r.project.headRevision,
    updatedAt: r.project.updatedAt, sharedAt: r.createdAt, role: r.role, owner: { displayName: who.get(r.creatorId)?.displayName ?? null },
  })).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()) };
}

/** A shared design at its newest version, for its grantee: read only. */
export async function openShared(share: LiveShare, projectId: string) {
  const p = await prisma.designProject.findFirst({ where: { id: projectId, creatorId: share.creatorId, archivedAt: null },
    select: { id: true, name: true, templateKey: true, templateVersion: true, headRevision: true, updatedAt: true } });
  if (!p) throw new NotFoundError('Design project');
  const rev = await prisma.designRevision.findUnique({ where: { projectId_number: { projectId, number: p.headRevision } }, select: { number: true, sha256: true, createdAt: true, document: true } });
  if (!rev) throw new NotFoundError('Design revision');
  const who = await people([share.creatorId]);
  return { design: { ...p, role: share.role, owner: { displayName: who.get(share.creatorId)?.displayName ?? null }, revision: rev } };
}
