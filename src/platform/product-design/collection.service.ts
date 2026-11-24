/**
 * Familista Design Studio — a club's collections (M3b): its designs gathered as one kit, and the order sheet a roster
 * makes of it.
 *
 * Every function takes the club it acts for, which the club routes resolve from the session, never from a request.
 * Every query is filtered by that club, and the database holds the same line three times underneath: row-level security
 * on both tables, composite foreign keys that hold an item to its own club's collection and project, and a trigger that
 * holds a collection's roster to its club (20261123210000). A collection, a design or a roster of another club is not
 * found, whatever its id.
 *
 * A save names the version it was based on and is refused when the collection has moved on. Every change writes its
 * audit entry in the same transaction: counts, never a design's or a person's name.
 *
 * The order sheet counts a roster's sets per size for each design's garment form, by the editor's own rule
 * (pd-roster.js summary, through roster-core.ts) and the released template's form (core.ts). It writes nothing.
 */
import { DesignCollectionRole, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { clubAudit } from './club-audit';
import { templateForm } from './core';
import { rosterSummary, validateRosterEntries, type RosterSummary, youthEntries } from './roster-core';
import { approvalsFor, type ApprovalState } from './review.service';
import type { DesignActor } from './service';

/** At most this many collections in a club at once (archived ones do not count). */
export const ACTIVE_COLLECTION_LIMIT = 100;
/** At most this many designs in one collection. */
export const COLLECTION_ITEM_LIMIT = 12;
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export interface CollectionInput { name: string; season: string | null; rosterId: string | null; items: Array<{ projectId: string; role: DesignCollectionRole }> }
export interface CollectionItemView {
  projectId: string; role: DesignCollectionRole; position: number; name: string; templateKey: string; templateVersion: number;
  form: 'top' | 'shorts' | 'socks' | null; archived: boolean;
  /** M7b: the newest version's current decision by a club administrator, or null when it has none. */
  revision: number; approval: ApprovalState | null;
}
export interface CollectionSummaryView { id: string; name: string; season: string | null; rosterId: string | null; version: number; archivedAt: Date | null; updatedAt: Date; items: number }
export interface CollectionView extends Omit<CollectionSummaryView, 'items'> { createdAt: Date; items: CollectionItemView[] }

/** A collection the service will not keep as sent: its code and the path it is about. */
export class CollectionInvalidError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, at: string) { super(`${code} at ${at}`); this.name = 'CollectionInvalidError'; this.code = code; this.path = at; }
}
/** A change the collection cannot take as asked. */
export class CollectionRefusedError extends ConflictError {
  readonly code: 'COLLECTION_LIMIT' | 'COLLECTION_ARCHIVED';
  constructor(code: 'COLLECTION_LIMIT' | 'COLLECTION_ARCHIVED', message: string) { super(message); this.code = code; }
}
/** A save based on a version the collection has moved on from. */
export class CollectionConflictError extends ConflictError {
  readonly code = 'COLLECTION_CONFLICT';
  readonly version: number;
  constructor(version: number) { super(`This collection has a newer version (${version}) than the one this save was based on`); this.version = version; }
}

const SUMMARY_SELECT = { id: true, name: true, season: true, rosterId: true, version: true, archivedAt: true, updatedAt: true, _count: { select: { items: true } } } as const;
const FULL_SELECT = {
  id: true, name: true, season: true, rosterId: true, version: true, archivedAt: true, updatedAt: true, createdAt: true,
  items: { orderBy: { position: 'asc' as const }, select: { projectId: true, role: true, position: true, project: { select: { name: true, templateKey: true, templateVersion: true, archivedAt: true, headRevision: true } } } },
};
type FullRow = Prisma.DesignCollectionGetPayload<{ select: typeof FULL_SELECT }>;

async function view(tx: Prisma.TransactionClient, clubId: string, row: FullRow): Promise<CollectionView> {
  const { items, ...rest } = row;
  const approvals = await approvalsFor(tx, clubId, items.map((i) => ({ projectId: i.projectId, revision: i.project.headRevision })));
  return {
    ...rest,
    items: items.map((i) => ({
      projectId: i.projectId, role: i.role, position: i.position, name: i.project.name, templateKey: i.project.templateKey,
      templateVersion: i.project.templateVersion, form: templateForm(i.project.templateKey, i.project.templateVersion), archived: !!i.project.archivedAt,
      revision: i.project.headRevision, approval: approvals.get(`${i.projectId}@${i.project.headRevision}`) ?? null,
    })),
  };
}
function summary(row: Prisma.DesignCollectionGetPayload<{ select: typeof SUMMARY_SELECT }>): CollectionSummaryView {
  const { _count, ...rest } = row;
  return { ...rest, items: _count.items };
}
function audit(tx: Prisma.TransactionClient, clubId: string, actor: DesignActor, action: string, id: string, metadata: Record<string, unknown>, message: string) {
  return clubAudit(tx, clubId, actor, { action, resourceType: 'DesignCollection', resourceId: id, metadata, message });
}

/** The name and season as kept: NFC, trimmed, inner spaces single; the season empty is none. */
function clean(input: CollectionInput): CollectionInput {
  const tidy = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
  const name = tidy(input.name);
  if (!name || Array.from(name).length > 80 || CONTROL.test(name)) throw new CollectionInvalidError('bad-collection-name', 'name');
  const season = input.season === null ? null : tidy(input.season) || null;
  if (season !== null && (Array.from(season).length > 20 || CONTROL.test(season))) throw new CollectionInvalidError('bad-season', 'season');
  if (input.items.length > COLLECTION_ITEM_LIMIT) throw new CollectionInvalidError('too-many-designs', 'items');
  const seen = new Set<string>();
  input.items.forEach((i, n) => {
    if (seen.has(i.projectId)) throw new CollectionInvalidError('duplicate-design', `items[${n}].projectId`);
    seen.add(i.projectId);
  });
  return { name, season, rosterId: input.rosterId, items: input.items };
}

/** Every design and the roster a collection names are this club's: asked with the club, under the request's context. */
async function checkReferences(tx: Prisma.TransactionClient, clubId: string, input: CollectionInput): Promise<void> {
  if (input.items.length) {
    const found = await tx.designProject.findMany({ where: { clubId, id: { in: input.items.map((i) => i.projectId) } }, select: { id: true } });
    const ids = new Set(found.map((p) => p.id));
    const missing = input.items.findIndex((i) => !ids.has(i.projectId));
    if (missing !== -1) throw new CollectionInvalidError('unknown-design', `items[${missing}].projectId`);
  }
  if (input.rosterId && !(await tx.designRoster.findFirst({ where: { id: input.rosterId, clubId }, select: { id: true } }))) {
    throw new CollectionInvalidError('unknown-roster', 'rosterId');
  }
}
async function writeItems(tx: Prisma.TransactionClient, clubId: string, collectionId: string, items: CollectionInput['items']): Promise<void> {
  await tx.designCollectionItem.deleteMany({ where: { collectionId, clubId } });
  if (items.length) await tx.designCollectionItem.createMany({ data: items.map((i, position) => ({ clubId, collectionId, projectId: i.projectId, role: i.role, position })) });
}

/** The club's collections, most recently changed first: active ones, or archived ones when asked. */
export async function listCollections(clubId: string, opts: { archived?: boolean } = {}): Promise<{ collections: CollectionSummaryView[]; limit: number }> {
  const rows = await prisma.designCollection.findMany({
    where: { clubId, archivedAt: opts.archived ? { not: null } : null },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: ACTIVE_COLLECTION_LIMIT * 2, select: SUMMARY_SELECT,
  });
  return { collections: rows.map(summary), limit: ACTIVE_COLLECTION_LIMIT };
}

/** One of the club's collections, with its designs in order. */
export async function getCollection(clubId: string, id: string): Promise<{ collection: CollectionView }> {
  const row = await prisma.designCollection.findFirst({ where: { id, clubId }, select: FULL_SELECT });
  if (!row) throw new NotFoundError('Collection');
  return { collection: await view(prisma, clubId, row) };
}

/** A new collection. */
export async function createCollection(clubId: string, actor: DesignActor, raw: CollectionInput): Promise<{ collection: CollectionView }> {
  const input = clean(raw);
  return prisma.$transaction(async (tx) => {
    if ((await tx.designCollection.count({ where: { clubId, archivedAt: null } })) >= ACTIVE_COLLECTION_LIMIT) {
      throw new CollectionRefusedError('COLLECTION_LIMIT', `A club keeps at most ${ACTIVE_COLLECTION_LIMIT} collections; archive one first`);
    }
    await checkReferences(tx, clubId, input);
    const created = await tx.designCollection.create({
      data: { clubId, name: input.name, season: input.season, rosterId: input.rosterId, createdById: actor.userId, updatedById: actor.userId }, select: { id: true },
    });
    await writeItems(tx, clubId, created.id, input.items);
    await audit(tx, clubId, actor, 'design.collection.created', created.id, { designs: input.items.length, roster: !!input.rosterId }, 'A design collection was created');
    return { collection: await view(tx, clubId, await tx.designCollection.findFirstOrThrow({ where: { id: created.id, clubId }, select: FULL_SELECT })) };
  });
}

/** Replace a collection's name, season, roster and designs, if it is still at the version the save was based on. */
export async function saveCollection(clubId: string, actor: DesignActor, id: string, raw: CollectionInput & { version: number }): Promise<{ collection: CollectionView }> {
  const input = clean(raw);
  return prisma.$transaction(async (tx) => {
    const current = await tx.designCollection.findFirst({ where: { id, clubId }, select: { version: true, archivedAt: true } });
    if (!current) throw new NotFoundError('Collection');
    if (current.archivedAt) throw new CollectionRefusedError('COLLECTION_ARCHIVED', 'This collection is archived; return it to the list before saving it');
    await checkReferences(tx, clubId, input);
    // The version is part of the write's own condition, so two saves racing on one version cannot both succeed.
    const moved = await tx.designCollection.updateMany({
      where: { id, clubId, version: raw.version, archivedAt: null },
      data: { name: input.name, season: input.season, rosterId: input.rosterId, version: { increment: 1 }, updatedById: actor.userId },
    });
    if (moved.count !== 1) throw new CollectionConflictError(current.version);
    await writeItems(tx, clubId, id, input.items);
    const row = await tx.designCollection.findFirstOrThrow({ where: { id, clubId }, select: FULL_SELECT });
    await audit(tx, clubId, actor, 'design.collection.saved', id, { designs: input.items.length, roster: !!input.rosterId, version: row.version }, 'A design collection was saved');
    return { collection: await view(tx, clubId, row) };
  });
}

/** Archive a collection, or return it to the list. Its designs stay where they are either way. */
export async function setCollectionArchived(clubId: string, actor: DesignActor, id: string, archived: boolean): Promise<{ collection: CollectionSummaryView }> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.designCollection.findFirst({ where: { id, clubId }, select: SUMMARY_SELECT });
    if (!current) throw new NotFoundError('Collection');
    if (!!current.archivedAt === archived) return { collection: summary(current) };
    if (!archived && (await tx.designCollection.count({ where: { clubId, archivedAt: null } })) >= ACTIVE_COLLECTION_LIMIT) {
      throw new CollectionRefusedError('COLLECTION_LIMIT', `A club keeps at most ${ACTIVE_COLLECTION_LIMIT} collections; archive one first`);
    }
    await tx.designCollection.updateMany({ where: { id, clubId }, data: { archivedAt: archived ? new Date() : null } });
    const row = await tx.designCollection.findFirstOrThrow({ where: { id, clubId }, select: SUMMARY_SELECT });
    await audit(tx, clubId, actor, archived ? 'design.collection.archived' : 'design.collection.unarchived', id, { designs: row._count.items },
      archived ? 'A design collection was archived' : 'A design collection was returned to the list');
    return { collection: summary(row) };
  });
}

/** Delete a collection, archived first. Its designs are not touched: only the gathering goes. */
export async function deleteCollection(clubId: string, actor: DesignActor, id: string): Promise<{ deleted: true }> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.designCollection.findFirst({ where: { id, clubId }, select: { archivedAt: true, _count: { select: { items: true } } } });
    if (!current) throw new NotFoundError('Collection');
    if (!current.archivedAt) throw new CollectionRefusedError('COLLECTION_ARCHIVED', 'Archive this collection before deleting it');
    await tx.designCollection.deleteMany({ where: { id, clubId } });
    await audit(tx, clubId, actor, 'design.collection.deleted', id, { designs: current._count.items }, 'A design collection was deleted');
    return { deleted: true };
  });
}

export interface OrderSheet {
  collection: { id: string; name: string; season: string | null; version: number };
  /** P1: minors, as the request would count them (the club's mark, or a child's size). */
  roster: { id: string; name: string; version: number; entries: number; sets: number; minors: boolean } | null;
  garments: Array<{ projectId: string; name: string; role: DesignCollectionRole; form: 'top' | 'shorts' | 'socks' | null; sizes: Array<{ size: string; sets: number }>; unsized: number; sets: number }>;
}

/**
 * What a roster asks of a collection: for each design, the sets per size of its garment form. The roster is the one asked
 * for, or else the collection's own; with neither, every design is listed with no sizes. Writes nothing.
 */
export async function orderSheet(clubId: string, id: string, rosterId?: string): Promise<{ sheet: OrderSheet }> {
  const { collection } = await getCollection(clubId, id);
  const rid = rosterId ?? collection.rosterId;
  let roster: OrderSheet['roster'] = null;
  let sum: RosterSummary | null = null;
  if (rid) {
    const row = await prisma.designRoster.findFirst({ where: { id: rid, clubId }, select: { id: true, name: true, version: true, entries: true, includesMinors: true } });
    if (!row) throw new NotFoundError('Roster');
    const entries = validateRosterEntries(row.entries);
    sum = rosterSummary(entries);
    roster = { id: row.id, name: row.name, version: row.version, entries: sum.entries, sets: sum.sets, minors: row.includesMinors || youthEntries(entries) > 0 };
  }
  return {
    sheet: {
      collection: { id: collection.id, name: collection.name, season: collection.season, version: collection.version },
      roster,
      garments: collection.items.map((i) => ({
        projectId: i.projectId, name: i.name, role: i.role, form: i.form,
        sizes: sum && i.form ? sum.sizes[i.form] : [], unsized: sum && i.form ? sum.unsized[i.form] : 0, sets: sum && i.form ? sum.sets : 0,
      })),
    },
  };
}
