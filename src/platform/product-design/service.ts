/**
 * Familista Design Studio — designs saved on the server (DS-1b).
 *
 * A project, and the immutable revisions of its canonical document. Every
 * operation here is the platform owner's (the routes guard it on the server
 * before any of this runs) and reaches only PLATFORM-owned projects: a query
 * that does not name `ownerKind: PLATFORM` is not written here, so a CLUB or
 * PERSONAL project — which the database does not admit yet anyway — could never
 * be read or changed through these routes.
 *
 * Saving is optimistic. A save names the revision it was based on; the head
 * moves from that number to the next in one conditional update, and a save
 * based on anything older is refused with the head it lost to (409). Nothing
 * is overwritten: the losing document is still the caller's to save again.
 *
 * Every change writes its PlatformAuditLog entry inside the same transaction,
 * so a change without its record cannot exist. The record holds numbers and a
 * hash, never the document.
 */
import { DesignOrigin, DesignOwnerKind, DesignRevisionKind, PlatformAuditCategory, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { currentEnvironment } from '../environment';
import { formatVersion, validateDesignDocument, type DesignDocument } from './core';

/** Who is acting, as the routes resolved it. */
export interface DesignActor {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface DesignProjectView {
  id: string;
  name: string;
  templateKey: string;
  templateVersion: number;
  headRevision: number;
  origin: DesignOrigin;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DesignRevisionMeta {
  number: number;
  kind: DesignRevisionKind;
  restoredFrom: number | null;
  sha256: string;
  bytes: number;
  createdAt: Date;
}

export interface DesignRevisionView extends DesignRevisionMeta {
  document: DesignDocument;
}

/** At most this many projects in one list, newest first. */
export const PROJECT_LIST_LIMIT = 200;
/** At most this many revisions in one list, newest first. */
export const REVISION_LIST_LIMIT = 500;

/** The one ownership these routes reach. The phase that activates CLUB or PERSONAL adds its own scope. */
const SCOPE = { ownerKind: DesignOwnerKind.PLATFORM } as const;

const PROJECT_SELECT = {
  id: true, name: true, templateKey: true, templateVersion: true, headRevision: true,
  origin: true, archivedAt: true, createdAt: true, updatedAt: true,
} as const;
const REVISION_META_SELECT = { number: true, kind: true, restoredFrom: true, sha256: true, bytes: true, createdAt: true } as const;

/** A save or a restore based on a revision that is no longer the newest. */
export class DesignRevisionConflictError extends ConflictError {
  readonly code = 'DESIGN_REVISION_CONFLICT';
  readonly headRevision: number;
  constructor(headRevision: number) {
    super(`This design has a newer revision (${headRevision}) than the one this save was based on`);
    this.headRevision = headRevision;
  }
}

/** A change to an archived project, which must be restored to the list first. */
export class DesignProjectArchivedError extends ConflictError {
  readonly code = 'DESIGN_PROJECT_ARCHIVED';
  constructor() { super('This design is archived; return it to the list before saving it'); }
}

type Tx = Prisma.TransactionClient;

async function audit(tx: Tx, actor: DesignActor, action: string, projectId: string, metadata: Record<string, unknown>, message: string): Promise<void> {
  const admin = await tx.platformAdmin.findUnique({ where: { userId: actor.userId }, select: { id: true } });
  await tx.platformAuditLog.create({
    data: {
      adminId: admin?.id ?? null,
      userId: actor.userId,
      action,
      category: PlatformAuditCategory.ASSET,
      resourceType: 'DesignProject',
      resourceId: projectId,
      ipAddress: actor.ipAddress ?? undefined,
      userAgent: actor.userAgent ?? undefined,
      metadata: { ...metadata, environment: currentEnvironment(), correlationId: actor.correlationId ?? null } as Prisma.InputJsonValue,
      message,
    },
  });
}

async function projectOrNotFound(db: Tx | typeof prisma, id: string): Promise<DesignProjectView> {
  const project = await db.designProject.findFirst({ where: { id, ...SCOPE }, select: PROJECT_SELECT });
  if (!project) throw new NotFoundError('Design project');
  return project;
}

/** The projects, newest change first: the active ones, or the archived ones. */
export async function listProjects(state: 'active' | 'archived'): Promise<{ projects: DesignProjectView[]; limit: number; truncated: boolean }> {
  const rows = await prisma.designProject.findMany({
    where: { ...SCOPE, archivedAt: state === 'archived' ? { not: null } : null },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: PROJECT_LIST_LIMIT + 1,
    select: PROJECT_SELECT,
  });
  return { projects: rows.slice(0, PROJECT_LIST_LIMIT), limit: PROJECT_LIST_LIMIT, truncated: rows.length > PROJECT_LIST_LIMIT };
}

/** A new project, its document as revision 1. */
export async function createProject(actor: DesignActor, input: { document: unknown; origin: DesignOrigin }): Promise<{ project: DesignProjectView; revision: DesignRevisionMeta }> {
  const v = validateDesignDocument(input.document);
  return prisma.$transaction(async (tx) => {
    const project = await tx.designProject.create({
      data: {
        ...SCOPE, name: v.document.name, templateKey: v.document.template.key, templateVersion: v.document.template.version,
        headRevision: 1, origin: input.origin, createdById: actor.userId,
      },
      select: PROJECT_SELECT,
    });
    const revision = await tx.designRevision.create({
      data: {
        projectId: project.id, number: 1, kind: DesignRevisionKind.CREATE, document: v.document as unknown as Prisma.InputJsonValue,
        sha256: v.sha256, bytes: v.bytes, formatVersion: formatVersion(), authorUserId: actor.userId,
      },
      select: REVISION_META_SELECT,
    });
    await audit(tx, actor, 'design.project.created', project.id, { revision: 1, origin: input.origin, sha256: v.sha256, bytes: v.bytes },
      'A Design Studio project was created');
    return { project, revision };
  });
}

/** A project and its newest revision's document. */
export async function getProject(id: string): Promise<{ project: DesignProjectView; revision: DesignRevisionView }> {
  const project = await projectOrNotFound(prisma, id);
  const revision = await prisma.designRevision.findUnique({
    where: { projectId_number: { projectId: id, number: project.headRevision } },
    select: { ...REVISION_META_SELECT, document: true },
  });
  if (!revision) throw new NotFoundError('Design revision');
  return { project, revision: { ...revision, document: revision.document as unknown as DesignDocument } };
}

/**
 * Move the head from `base` to `base + 1` and write that revision, or explain
 * why not: the project is not there, it is archived, or `base` is no longer the
 * head. A retry of a save that already landed (the next revision is this very
 * document) answers that revision instead of a conflict.
 */
async function advance(
  actor: DesignActor, id: string, base: number,
  next: { document: DesignDocument; sha256: string; bytes: number; kind: DesignRevisionKind; restoredFrom: number | null },
  action: string, message: string,
): Promise<{ project: DesignProjectView; revision: DesignRevisionMeta; replayed: boolean }> {
  const done = await prisma.$transaction(async (tx) => {
    const moved = await tx.designProject.updateMany({
      where: { id, ...SCOPE, headRevision: base, archivedAt: null },
      data: { headRevision: base + 1, name: next.document.name, templateKey: next.document.template.key, templateVersion: next.document.template.version },
    });
    if (moved.count !== 1) return null;
    const revision = await tx.designRevision.create({
      data: {
        projectId: id, number: base + 1, kind: next.kind, restoredFrom: next.restoredFrom,
        document: next.document as unknown as Prisma.InputJsonValue, sha256: next.sha256, bytes: next.bytes,
        formatVersion: formatVersion(), authorUserId: actor.userId,
      },
      select: REVISION_META_SELECT,
    });
    await audit(tx, actor, action, id, { revision: base + 1, basedOn: base, kind: next.kind, restoredFrom: next.restoredFrom, sha256: next.sha256, bytes: next.bytes }, message);
    const project = await tx.designProject.findFirstOrThrow({ where: { id, ...SCOPE }, select: PROJECT_SELECT });
    return { project, revision, replayed: false };
  });
  if (done) return done;

  const project = await projectOrNotFound(prisma, id);
  if (project.archivedAt) throw new DesignProjectArchivedError();
  if (project.headRevision === base + 1 && next.kind === DesignRevisionKind.SAVE) {
    const head = await prisma.designRevision.findUnique({
      where: { projectId_number: { projectId: id, number: base + 1 } }, select: REVISION_META_SELECT,
    });
    if (head && head.kind === DesignRevisionKind.SAVE && head.sha256 === next.sha256) return { project, revision: head, replayed: true };
  }
  throw new DesignRevisionConflictError(project.headRevision);
}

/** Save a document as the project's next revision, if `baseRevision` is still the newest. */
export async function saveRevision(actor: DesignActor, id: string, input: { baseRevision: number; document: unknown }) {
  const v = validateDesignDocument(input.document);
  return advance(actor, id, input.baseRevision, { ...v, kind: DesignRevisionKind.SAVE, restoredFrom: null },
    'design.revision.saved', 'A Design Studio revision was saved');
}

/** Copy revision `number` into a new revision, if `baseRevision` is still the newest. The head never moves back. */
export async function restoreRevision(actor: DesignActor, id: string, number: number, input: { baseRevision: number }) {
  await projectOrNotFound(prisma, id);
  const source = await prisma.designRevision.findFirst({
    where: { projectId: id, number, project: SCOPE }, select: { document: true },
  });
  if (!source) throw new NotFoundError('Design revision');
  // Stored documents were valid when saved; validating again keeps a restore to what the editor can open now.
  const v = validateDesignDocument(source.document);
  return advance(actor, id, input.baseRevision, { ...v, kind: DesignRevisionKind.RESTORE, restoredFrom: number },
    'design.revision.restored', `A Design Studio revision was restored from revision ${number}`);
}

/** The project's revisions, newest first, without their documents. */
export async function listRevisions(id: string): Promise<{ project: DesignProjectView; revisions: DesignRevisionMeta[]; limit: number; truncated: boolean }> {
  const project = await projectOrNotFound(prisma, id);
  const rows = await prisma.designRevision.findMany({
    where: { projectId: id }, orderBy: { number: 'desc' }, take: REVISION_LIST_LIMIT + 1, select: REVISION_META_SELECT,
  });
  return { project, revisions: rows.slice(0, REVISION_LIST_LIMIT), limit: REVISION_LIST_LIMIT, truncated: rows.length > REVISION_LIST_LIMIT };
}

/** One revision, with its document. */
export async function getRevision(id: string, number: number): Promise<{ revision: DesignRevisionView }> {
  const revision = await prisma.designRevision.findFirst({
    where: { projectId: id, number, project: SCOPE }, select: { ...REVISION_META_SELECT, document: true },
  });
  if (!revision) throw new NotFoundError('Design revision');
  return { revision: { ...revision, document: revision.document as unknown as DesignDocument } };
}

/** Archive a project, or return it to the list. Its revisions are untouched either way. */
export async function setArchived(actor: DesignActor, id: string, archived: boolean): Promise<{ project: DesignProjectView }> {
  return prisma.$transaction(async (tx) => {
    const current = await projectOrNotFound(tx, id);
    if (!!current.archivedAt === archived) return { project: current };
    const changed = await tx.designProject.updateMany({
      where: { id, ...SCOPE, archivedAt: archived ? null : { not: null } },
      data: { archivedAt: archived ? new Date() : null },
    });
    const project = await projectOrNotFound(tx, id);
    if (changed.count === 1) {
      await audit(tx, actor, archived ? 'design.project.archived' : 'design.project.unarchived', id, { revision: project.headRevision },
        archived ? 'A Design Studio project was archived' : 'A Design Studio project was returned to the list');
    }
    return { project };
  });
}
