/**
 * Familista Design Studio — reviews and approvals of a club's designs (M7b).
 *
 * A club's administrators and managers comment on a saved version of a design, on the whole garment or on one of its
 * surfaces, and resolve comments. A club administrator, and nobody else, approves a version or requests changes to it:
 * the decision is pinned to that version's revision number and SHA-256, so it says nothing about the next version, and
 * it is never changed or removed (the database holds that). The newest decision on a version is its current one.
 *
 * Every function takes the club the routes resolved from the session; every query is filtered by it, and row-level
 * security holds the same line underneath (20261124100000). Audited with the club: revisions, surfaces and counts, never
 * a comment's text.
 */
import { DesignReviewDecision, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { tenantAudit } from './club-audit';
import { ownerColumns, tenantWhere, type Tenant } from '../tenancy/tenant';
import { templateSurfaces } from './core';
import type { DesignActor } from './service';

export const COMMENT_LIMIT = 500;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** A comment or decision the service will not keep as sent. */
export class ReviewInvalidError extends Error {
  readonly code: string; readonly path: string;
  constructor(code: string, at: string) { super(`${code} at ${at}`); this.name = 'ReviewInvalidError'; this.code = code; this.path = at; }
}
/** A decision on a version that is no longer the design's newest. */
export class ReviewStaleError extends ConflictError {
  readonly code = 'REVIEW_STALE';
  readonly headRevision: number;
  constructor(head: number) { super(`This design has a newer version (${head}): review that one`); this.headRevision = head; }
}

export interface ApprovalState { revision: number; decision: DesignReviewDecision; at: Date }

function text(v: string | null | undefined, at: string, required: boolean): string | null {
  const s = typeof v === 'string' ? v.normalize('NFC').trim() : '';
  if (!s) { if (required) throw new ReviewInvalidError('required', at); return null; }
  if (Array.from(s).length > 1000 || CONTROL.test(s)) throw new ReviewInvalidError('bad-text', at);
  return s;
}
async function projectOf(tx: Prisma.TransactionClient, tenant: Tenant, projectId: string) {
  const p = await tx.designProject.findFirst({ where: { id: projectId, ...tenantWhere(tenant) }, select: { id: true, headRevision: true, templateKey: true, templateVersion: true } });
  if (!p) throw new NotFoundError('Design');
  return p;
}

/** The current decision of each (design, revision) asked for: the newest, or none. Asked in the caller's context. */
export async function approvalsFor(tx: Prisma.TransactionClient, tenant: Tenant, wanted: Array<{ projectId: string; revision: number }>): Promise<Map<string, ApprovalState>> {
  const out = new Map<string, ApprovalState>();
  if (!wanted.length) return out;
  const rows = await tx.designApproval.findMany({
    where: { ...tenantWhere(tenant), OR: wanted.map((w) => ({ projectId: w.projectId, revision: w.revision })) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { projectId: true, revision: true, decision: true, createdAt: true },
  });
  for (const r of rows) {
    const k = `${r.projectId}@${r.revision}`;
    if (!out.has(k)) out.set(k, { revision: r.revision, decision: r.decision, at: r.createdAt });
  }
  return out;
}

/** A design's review: its newest version and that version's current decision, every comment, every decision. */
export async function getReview(tenant: Tenant, projectId: string) {
  const p = await projectOf(prisma, tenant, projectId);
  const [comments, decisions] = await Promise.all([
    prisma.designReviewComment.findMany({
      where: { ...tenantWhere(tenant), projectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: COMMENT_LIMIT,
      select: { id: true, revision: true, surface: true, body: true, authorId: true, createdAt: true, resolvedAt: true },
    }),
    prisma.designApproval.findMany({
      where: { ...tenantWhere(tenant), projectId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
      select: { id: true, revision: true, decision: true, note: true, decidedById: true, createdAt: true },
    }),
  ]);
  const ids = [...new Set([...comments.map((c) => c.authorId), ...decisions.map((d) => d.decidedById)])];
  // A club's reviewers are its own users; a creator's are creators (the owner, and P4's collaborators), by display name.
  const name = new Map<string, string>(tenant.kind === 'club'
    ? (await prisma.user.findMany({ where: { id: { in: ids }, clubId: tenant.clubId }, select: { id: true, firstName: true, lastName: true } }))
      .map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()])
    : (await prisma.creatorAccount.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }))
      .filter((c) => c.displayName).map((c) => [c.id, c.displayName as string]));
  const current = decisions.find((d) => d.revision === p.headRevision) ?? null;
  return {
    review: {
      projectId, headRevision: p.headRevision, surfaces: templateSurfaces(p.templateKey, p.templateVersion) ?? [],
      current: current ? { revision: current.revision, decision: current.decision, at: current.createdAt, by: name.get(current.decidedById) ?? null } : null,
      comments: comments.map(({ authorId, ...c }) => ({ ...c, by: name.get(authorId) ?? null })),
      decisions: decisions.map(({ decidedById, ...d }) => ({ ...d, by: name.get(decidedById) ?? null })),
    },
  };
}

/** A comment on one saved version, on the whole garment or one of its template's surfaces. */
export async function addComment(tenant: Tenant, actor: DesignActor, projectId: string, input: { revision: number; surface: string | null; body: string }) {
  const body = text(input.body, 'body', true) as string;
  return prisma.$transaction(async (tx) => {
    const p = await projectOf(tx, tenant, projectId);
    if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > p.headRevision) throw new ReviewInvalidError('unknown-revision', 'revision');
    if (input.surface !== null && !(templateSurfaces(p.templateKey, p.templateVersion) ?? []).includes(input.surface)) throw new ReviewInvalidError('unknown-surface', 'surface');
    if ((await tx.designReviewComment.count({ where: { ...tenantWhere(tenant), projectId } })) >= COMMENT_LIMIT) throw new ReviewInvalidError('too-many-comments', 'body');
    const c = await tx.designReviewComment.create({ data: { ...tenantWhere(tenant), projectId, revision: input.revision, surface: input.surface, body, authorId: actor.userId }, select: { id: true } });
    await tenantAudit(tx, tenant, actor, { action: 'design.review.commented', resourceType: 'DesignProject', resourceId: projectId,
      metadata: { commentId: c.id, revision: input.revision, surface: input.surface }, message: 'A design was commented on' });
    return { commentId: c.id };
  });
}

/** Resolve a comment, or open it again. */
export async function setCommentResolved(tenant: Tenant, actor: DesignActor, projectId: string, commentId: string, resolved: boolean) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.designReviewComment.findFirst({ where: { id: commentId, projectId, ...tenantWhere(tenant) }, select: { resolvedAt: true } });
    if (!c) throw new NotFoundError('Comment');
    if (!!c.resolvedAt !== resolved) {
      await tx.designReviewComment.updateMany({ where: { id: commentId, ...tenantWhere(tenant) }, data: resolved ? { resolvedAt: new Date(), resolvedById: actor.userId } : { resolvedAt: null, resolvedById: null } });
      await tenantAudit(tx, tenant, actor, { action: resolved ? 'design.review.resolved' : 'design.review.reopened', resourceType: 'DesignProject', resourceId: projectId,
        metadata: { commentId }, message: resolved ? 'A design comment was resolved' : 'A design comment was reopened' });
    }
    return { commentId, resolved };
  });
}

/**
 * A club administrator's decision on the design's newest version: approved, or changes requested (with what to change).
 * A manager is refused; a decision on an older version is refused with the newest one's number.
 */
export async function decide(tenant: Tenant, actor: DesignActor & { role?: UserRole }, projectId: string, input: { revision: number; decision: DesignReviewDecision; note: string | null }) {
  // A club's decision is its administrator's; a creator decides on their own designs.
  if (tenant.kind === 'club' && actor.role !== UserRole.CLUB_ADMIN) throw new ForbiddenError('Only a club administrator approves a design or requests changes to it');
  const note = text(input.note, 'note', input.decision === DesignReviewDecision.CHANGES_REQUESTED);
  return prisma.$transaction(async (tx) => {
    const p = await projectOf(tx, tenant, projectId);
    if (input.revision !== p.headRevision) throw new ReviewStaleError(p.headRevision);
    const rev = await tx.designRevision.findUnique({ where: { projectId_number: { projectId, number: p.headRevision } }, select: { sha256: true } });
    if (!rev) throw new NotFoundError('Design revision');
    await tx.designApproval.create({ data: { ...tenantWhere(tenant), projectId, revision: p.headRevision, sha256: rev.sha256, decision: input.decision, note, decidedById: actor.userId } });
    await tenantAudit(tx, tenant, actor, {
      action: input.decision === DesignReviewDecision.APPROVED ? 'design.review.approved' : 'design.review.changes-requested', resourceType: 'DesignProject', resourceId: projectId,
      metadata: { revision: p.headRevision, sha256: rev.sha256 }, message: input.decision === DesignReviewDecision.APPROVED ? 'A design version was approved' : 'Changes to a design version were requested',
    });
    return { revision: p.headRevision, decision: input.decision };
  });
}
