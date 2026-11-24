/**
 * Familista Creator Studio (P3) — a creator's own data: a copy of all of it, and the deletion of the account.
 *
 * Export: everything the platform keeps for the account, as one JSON document — the account, every design with its
 * newest version, the rosters (with the names the creator wrote), the collections, the brand kit's colours and logos'
 * records, and the quotation requests with the names still kept. Read in the creator's own database context, so it can
 * hold nothing of anyone else's. Recorded (counts only).
 *
 * Deletion: confirmed with the password. Refused while an order is with its maker (accepted, ordered, in production or
 * shipped): the order still needs its sizes, and the account its contact, until it is delivered or closed. Otherwise:
 * open requests are cancelled, every name a request kept is erased, the designs (with their versions and reviews), the
 * rosters, the collections and the brand kit are deleted, every session and link ends, and the account becomes a
 * tombstone (no address, name or password). The closed requests stay, nameless, as the record of what was asked: what a
 * commercial record must keep, and for how long, is a decision for the Owner's counsel, not made here.
 */
import { CreatorStatus, ManufacturingPersonState, ManufacturingRequestStatus as S } from '@prisma/client';
import { prisma } from '../../config/database';
import { runAsSystem } from '../../security/db-context';
import { verifyPassword } from '../../utils/password';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../utils/errors';
import { creatorTenant } from '../tenancy/tenant';
import { getProject, listProjects, personalScope } from '../product-design/service';
import { clubStep, getClubRequest, listClubRequests } from '../manufacturing/request.service';
import { creatorAudit, type Ctx } from './account.service';

/** Orders still with their maker: an account cannot be deleted under them. */
const IN_PROGRESS: ReadonlySet<S> = new Set([S.ACCEPTED, S.ORDERED, S.IN_PRODUCTION, S.SHIPPED]);
const OPEN: ReadonlySet<S> = new Set([S.SUBMITTED, S.IN_REVIEW, S.QUOTED]);

export class CreatorDeletionRefused extends ConflictError {
  readonly code = 'CREATOR_DELETION_REFUSED';
  constructor(readonly reason: 'order-in-progress', readonly orders: number) { super('An order is still with its maker; the account can be deleted once it is delivered or closed'); }
}

export async function exportAccount(id: string, ctx: Ctx) {
  const tenant = creatorTenant(id), scope = personalScope(id);
  const account = await runAsSystem('creator-account', () => prisma.creatorAccount.findUnique({
    where: { id }, select: { id: true, email: true, displayName: true, locale: true, emailVerifiedAt: true, ageConfirmedAt: true, ageConfirmedMinimum: true, createdAt: true, lastLoginAt: true },
  }));
  if (!account) throw new NotFoundError('Creator account');
  const projects = [];
  for (const state of ['active', 'archived'] as const) {
    for (const p of (await listProjects(scope, state)).projects) {
      const full = await getProject(scope, p.id);
      projects.push({ ...p, revision: { number: full.revision.number, sha256: full.revision.sha256, document: full.revision.document } });
    }
  }
  const [rosters, collections, kit, assets, requests] = await Promise.all([
    prisma.designRoster.findMany({ where: { creatorId: id }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, entries: true, includesMinors: true, version: true, archivedAt: true, createdAt: true, updatedAt: true } }),
    prisma.designCollection.findMany({ where: { creatorId: id }, orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, season: true, rosterId: true, archivedAt: true, createdAt: true, items: { orderBy: { position: 'asc' }, select: { projectId: true, role: true, position: true } } } }),
    prisma.designBrandKit.findUnique({ where: { creatorId: id }, select: { colours: true } }),
    prisma.designBrandAsset.findMany({ where: { creatorId: id }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, name: true, width: true, height: true, bytes: true, sha256: true, archivedAt: true, createdAt: true } }),
    listClubRequests(tenant),
  ]);
  const detailed = [];
  for (const r of requests.requests) {
    const { request } = await getClubRequest(tenant, r.id);
    const names = await prisma.manufacturingRequestPerson.findMany({ where: { requestId: r.id, creatorId: id }, orderBy: { position: 'asc' }, select: { position: true, name: true, state: true } });
    detailed.push({ ...request, names });
  }
  await prisma.$transaction((tx) => creatorAudit(tx, id, ctx, { action: 'creator.data.exported', resourceId: id,
    metadata: { projects: projects.length, rosters: rosters.length, collections: collections.length, assets: assets.length, requests: detailed.length }, message: 'A creator downloaded a copy of their data' }));
  return {
    export: {
      format: 'familista.creator-export', version: 1, exportedAt: new Date().toISOString(),
      account: { ...account, emailVerified: !!account.emailVerifiedAt },
      designs: projects, rosters, collections, brandKit: { colours: kit?.colours ?? [], logos: assets }, requests: detailed,
      note: 'Logo images are kept as the PNG the platform re-encoded; each is listed with its size and hash, and opens from the brand kit.',
    },
  };
}

export async function deleteAccount(id: string, password: string, ctx: Ctx): Promise<{ deleted: true; cancelled: number; namesErased: number; designs: number }> {
  const row = await runAsSystem('creator-account', () => prisma.creatorAccount.findUnique({ where: { id }, select: { passwordHash: true, status: true } }));
  if (!row || row.status === CreatorStatus.DELETED) throw new NotFoundError('Creator account');
  if (!row.passwordHash || !(await verifyPassword(String(password ?? ''), row.passwordHash))) throw new UnauthorizedError('The password is not correct');
  const tenant = creatorTenant(id);
  const requests = await prisma.manufacturingRequest.findMany({ where: { creatorId: id }, select: { id: true, status: true } });
  const busy = requests.filter((r) => IN_PROGRESS.has(r.status)).length;
  if (busy) throw new CreatorDeletionRefused('order-in-progress', busy);
  const actor = { userId: id, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null, correlationId: ctx.correlationId ?? null };
  let cancelled = 0;
  for (const r of requests.filter((x) => OPEN.has(x.status))) { await clubStep(tenant, actor, r.id, 'cancel', 'The creator deleted their account'); cancelled++; }
  return prisma.$transaction(async (tx) => {
    const erased = await tx.manufacturingRequestPerson.updateMany({ where: { creatorId: id, state: ManufacturingPersonState.KEPT }, data: { state: ManufacturingPersonState.ERASED, name: null, erasedAt: new Date() } });
    const designs = await tx.designProject.deleteMany({ where: { creatorId: id } });
    await tx.designCollection.deleteMany({ where: { creatorId: id } });
    await tx.designRoster.deleteMany({ where: { creatorId: id } });
    await tx.designBrandKit.deleteMany({ where: { creatorId: id } });
    // The account's own tables are not under row-level security: they are reached by the account's id alone.
    await tx.creatorSession.deleteMany({ where: { creatorId: id } });
    await tx.creatorEmailToken.deleteMany({ where: { creatorId: id } });
    await tx.creatorAccount.update({ where: { id }, data: {
      status: CreatorStatus.DELETED, email: `deleted+${id}@invalid`, passwordHash: null, displayName: null, emailVerifiedAt: null,
      deletedAt: new Date(), tokenVersion: { increment: 1 },
    } });
    await creatorAudit(tx, id, ctx, { action: 'creator.account.deleted', resourceId: id,
      metadata: { designs: designs.count, cancelled, namesErased: erased.count, keptRequests: requests.length }, message: 'A creator deleted their account; it is kept as a tombstone with no personal data' });
    return { deleted: true as const, cancelled, namesErased: erased.count, designs: designs.count };
  });
}
