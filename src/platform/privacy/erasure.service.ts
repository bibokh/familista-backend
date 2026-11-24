/**
 * Familista Design Studio — erasing a person's name from a club's design data (P1).
 *
 * A club administrator erases one person's name wherever the club's Design Studio holds it: its rosters (the entries are
 * removed, as a new version of each roster) and the names kept apart from its requests' frozen specifications. A name in
 * an order already with its supplier (ordered, in production or shipped) is not erased by the club: it is reported, and
 * can be erased once the order is closed. Always previewed first; the audit records counts, never the name.
 */
import { ManufacturingPersonState, ManufacturingRequestStatus as S, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../config/database';
import { ForbiddenError } from '../../utils/errors';
import { clubAudit } from '../product-design/club-audit';
import { validateRosterEntries } from '../product-design/roster-core';
import type { DesignActor } from '../product-design/service';

/** An order already with its supplier: its names are what the supplier is printing. */
const WITH_SUPPLIER: ReadonlySet<S> = new Set([S.ORDERED, S.IN_PRODUCTION, S.SHIPPED]);

export class ErasureInvalidError extends Error {
  readonly code = 'ERASURE_INVALID';
  constructor(message: string) { super(message); this.name = 'ErasureInvalidError'; }
}

/** The same name, however it was typed: Unicode-normalised, spaces collapsed, case ignored. */
export function sameName(v: string | null | undefined): string {
  return String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('und');
}

export interface ErasureCount { rosters: number; rosterEntries: number; requestNames: number; withSupplier: number }

export async function erasePerson(clubId: string, actor: DesignActor & { role?: UserRole }, input: { name: string; confirm: boolean }) {
  if (actor.role !== UserRole.CLUB_ADMIN) throw new ForbiddenError('Only a club administrator erases a person’s name');
  const target = sameName(input.name);
  if (!target || target.length > 40) throw new ErasureInvalidError('Give the name as it appears in the roster');
  return prisma.$transaction(async (tx) => {
    const rosters = await tx.designRoster.findMany({ where: { clubId }, select: { id: true, entries: true, version: true } });
    const hits = rosters.map((r) => {
      const entries = validateRosterEntries(r.entries);
      const keep = entries.filter((e) => sameName(e.name) !== target);
      return { id: r.id, version: r.version, keep, removed: entries.length - keep.length };
    }).filter((r) => r.removed > 0);
    const persons = (await tx.manufacturingRequestPerson.findMany({
      where: { clubId, state: ManufacturingPersonState.KEPT }, select: { id: true, name: true, request: { select: { status: true } } },
    })).filter((p) => sameName(p.name) === target);
    const erasable = persons.filter((p) => !WITH_SUPPLIER.has(p.request.status));
    const count: ErasureCount = { rosters: hits.length, rosterEntries: hits.reduce((n, r) => n + r.removed, 0), requestNames: erasable.length, withSupplier: persons.length - erasable.length };
    if (!input.confirm) return { preview: count };
    for (const r of hits) {
      await tx.designRoster.updateMany({
        where: { id: r.id, clubId, version: r.version },
        data: { entries: r.keep as unknown as Prisma.InputJsonValue, entryCount: r.keep.length, version: { increment: 1 }, updatedById: actor.userId },
      });
    }
    if (erasable.length) {
      await tx.manufacturingRequestPerson.updateMany({
        where: { clubId, id: { in: erasable.map((p) => p.id) }, state: ManufacturingPersonState.KEPT },
        data: { state: ManufacturingPersonState.ERASED, name: null, erasedAt: new Date() },
      });
    }
    await clubAudit(tx, clubId, actor, { action: 'privacy.person.erased', resourceType: 'Club', resourceId: clubId,
      metadata: { ...count }, message: 'A person’s name was erased from the club’s design data' });
    return { erased: count };
  });
}
