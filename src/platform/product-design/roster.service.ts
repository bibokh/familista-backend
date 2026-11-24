/**
 * Familista Design Studio — a club's team rosters (M3): the names, numbers and sizes a kit is made for.
 *
 * Every function takes the club it acts for, which the club routes resolve from the session, never from a request;
 * every query is filtered by that club, and the database holds the same line underneath (row-level security,
 * 20261123200000). A roster of another club is not found, whatever its id.
 *
 * Entries are validated by the editor's own core (pd-roster.js, through roster-core.ts). A save names the version it
 * was based on and is refused when the roster has moved on, so two people editing one roster cannot overwrite each
 * other unseen. Every change writes its audit entry in the same transaction: counts, never a name.
 *
 * The squad's names are read for one purpose: to start a roster from the club's own active players. Only the surname
 * and the shirt number are read; nothing else of a player's record leaves this module.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { clubAudit } from './club-audit';
import { validateRosterEntries, validateRosterName, type RosterEntry, youthEntries } from './roster-core';
import type { DesignActor } from './service';

/** At most this many rosters in a club at once (archived ones do not count). */
export const ACTIVE_ROSTER_LIMIT = 100;

export interface RosterSummaryView { id: string; name: string; entryCount: number; version: number; archivedAt: Date | null; updatedAt: Date }
export interface RosterView extends RosterSummaryView {
  entries: RosterEntry[]; createdAt: Date;
  /** P1: what the club says (includesMinors), the entries in a children's size, and so whether it counts as including minors. */
  includesMinors: boolean; youthEntries: number; minors: boolean;
}

const SUMMARY_SELECT = { id: true, name: true, entryCount: true, version: true, archivedAt: true, updatedAt: true } as const;
const FULL_SELECT = { ...SUMMARY_SELECT, entries: true, createdAt: true, includesMinors: true } as const;

/** A change the roster cannot take as asked. */
export class RosterRefusedError extends ConflictError {
  readonly code: 'ROSTER_LIMIT' | 'ROSTER_ARCHIVED';
  constructor(code: 'ROSTER_LIMIT' | 'ROSTER_ARCHIVED', message: string) { super(message); this.code = code; }
}
/** A save based on a version the roster has moved on from. */
export class RosterConflictError extends ConflictError {
  readonly code = 'ROSTER_CONFLICT';
  readonly version: number;
  constructor(version: number) { super(`This roster has a newer version (${version}) than the one this save was based on`); this.version = version; }
}

function view(row: { entries: Prisma.JsonValue; includesMinors: boolean } & Omit<RosterView, 'entries' | 'includesMinors' | 'youthEntries' | 'minors'>): RosterView {
  // What was stored passed the core; reading it through the core again means a row changed underneath is refused, not shown.
  const entries = validateRosterEntries(row.entries), youth = youthEntries(entries);
  return { ...row, entries, youthEntries: youth, minors: row.includesMinors || youth > 0 };
}
const sets = (entries: RosterEntry[]) => entries.reduce((n, e) => n + e.qty, 0);
function audit(tx: Prisma.TransactionClient, clubId: string, actor: DesignActor, action: string, id: string, metadata: Record<string, unknown>, message: string) {
  return clubAudit(tx, clubId, actor, { action, resourceType: 'DesignRoster', resourceId: id, metadata, message });
}

/** The club's rosters, most recently changed first: active ones, or archived ones when asked. */
export async function listRosters(clubId: string, opts: { archived?: boolean } = {}): Promise<{ rosters: RosterSummaryView[]; limit: number }> {
  const rosters = await prisma.designRoster.findMany({
    where: { clubId, archivedAt: opts.archived ? { not: null } : null },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: ACTIVE_ROSTER_LIMIT * 2, select: SUMMARY_SELECT,
  });
  return { rosters, limit: ACTIVE_ROSTER_LIMIT };
}

/** One of the club's rosters, with its entries. */
export async function getRoster(clubId: string, id: string): Promise<{ roster: RosterView }> {
  const row = await prisma.designRoster.findFirst({ where: { id, clubId }, select: FULL_SELECT });
  if (!row) throw new NotFoundError('Roster');
  return { roster: view(row) };
}

/** A new roster, with the entries given (none is fine). */
export async function createRoster(clubId: string, actor: DesignActor, input: { name: unknown; entries: unknown; includesMinors?: boolean }): Promise<{ roster: RosterView }> {
  const name = validateRosterName(input.name);
  const entries = validateRosterEntries(input.entries);
  return prisma.$transaction(async (tx) => {
    if ((await tx.designRoster.count({ where: { clubId, archivedAt: null } })) >= ACTIVE_ROSTER_LIMIT) {
      throw new RosterRefusedError('ROSTER_LIMIT', `A club keeps at most ${ACTIVE_ROSTER_LIMIT} rosters; archive one first`);
    }
    const row = await tx.designRoster.create({
      data: { clubId, name, entries: entries as unknown as Prisma.InputJsonValue, entryCount: entries.length, includesMinors: input.includesMinors === true, createdById: actor.userId, updatedById: actor.userId },
      select: FULL_SELECT,
    });
    await audit(tx, clubId, actor, 'design.roster.created', row.id, { entries: entries.length, sets: sets(entries) }, 'A team roster was created');
    return { roster: view(row) };
  });
}

/** Replace a roster's name and entries, if it is still at the version the save was based on. */
export async function saveRoster(clubId: string, actor: DesignActor, id: string, input: { name: unknown; entries: unknown; version: number; includesMinors?: boolean }): Promise<{ roster: RosterView }> {
  const name = validateRosterName(input.name);
  const entries = validateRosterEntries(input.entries);
  return prisma.$transaction(async (tx) => {
    const current = await tx.designRoster.findFirst({ where: { id, clubId }, select: { version: true, archivedAt: true, entryCount: true } });
    if (!current) throw new NotFoundError('Roster');
    if (current.archivedAt) throw new RosterRefusedError('ROSTER_ARCHIVED', 'This roster is archived; return it to the list before saving it');
    // The version is part of the write's own condition, so two saves racing on one version cannot both succeed.
    const moved = await tx.designRoster.updateMany({
      where: { id, clubId, version: input.version, archivedAt: null },
      data: { name, entries: entries as unknown as Prisma.InputJsonValue, entryCount: entries.length, version: { increment: 1 }, updatedById: actor.userId,
        ...(typeof input.includesMinors === 'boolean' ? { includesMinors: input.includesMinors } : {}) },
    });
    if (moved.count !== 1) throw new RosterConflictError(current.version);
    const row = await tx.designRoster.findFirstOrThrow({ where: { id, clubId }, select: FULL_SELECT });
    await audit(tx, clubId, actor, 'design.roster.saved', id,
      { entries: entries.length, sets: sets(entries), previousEntries: current.entryCount, version: row.version }, 'A team roster was saved');
    return { roster: view(row) };
  });
}

/** Archive a roster, or return it to the list. Its entries are kept either way. */
export async function setRosterArchived(clubId: string, actor: DesignActor, id: string, archived: boolean): Promise<{ roster: RosterSummaryView }> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.designRoster.findFirst({ where: { id, clubId }, select: SUMMARY_SELECT });
    if (!current) throw new NotFoundError('Roster');
    if (!!current.archivedAt === archived) return { roster: current };
    if (!archived && (await tx.designRoster.count({ where: { clubId, archivedAt: null } })) >= ACTIVE_ROSTER_LIMIT) {
      throw new RosterRefusedError('ROSTER_LIMIT', `A club keeps at most ${ACTIVE_ROSTER_LIMIT} rosters; archive one first`);
    }
    await tx.designRoster.updateMany({ where: { id, clubId }, data: { archivedAt: archived ? new Date() : null } });
    const roster = await tx.designRoster.findFirstOrThrow({ where: { id, clubId }, select: SUMMARY_SELECT });
    await audit(tx, clubId, actor, archived ? 'design.roster.archived' : 'design.roster.unarchived', id, { entries: roster.entryCount },
      archived ? 'A team roster was archived' : 'A team roster was returned to the list');
    return { roster };
  });
}

/** Erase a roster: its entries are names of people, and a club may remove them for good. Archived first, so a slip cannot. */
export async function deleteRoster(clubId: string, actor: DesignActor, id: string): Promise<{ deleted: true }> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.designRoster.findFirst({ where: { id, clubId }, select: { archivedAt: true, entryCount: true } });
    if (!current) throw new NotFoundError('Roster');
    if (!current.archivedAt) throw new RosterRefusedError('ROSTER_ARCHIVED', 'Archive this roster before deleting it');
    await tx.designRoster.deleteMany({ where: { id, clubId } });
    await audit(tx, clubId, actor, 'design.roster.deleted', id, { entries: current.entryCount }, 'A team roster was deleted');
    return { deleted: true };
  });
}

/**
 * The club's active players as a roster's starting point: each one's surname and shirt number, and nothing else of
 * their record. In number order. The editor reads them through the same import as a spreadsheet, so a surname the
 * roster cannot print is shown as a problem to fix, never stored as it is.
 */
export async function squadNames(clubId: string): Promise<{ players: Array<{ name: string; number: number | null }> }> {
  const rows = await prisma.player.findMany({
    where: { clubId, isActive: true }, orderBy: [{ number: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
    take: 150, select: { lastName: true, number: true },
  });
  return { players: rows.map((p) => ({ name: p.lastName, number: Number.isInteger(p.number) && p.number >= 0 && p.number <= 99 ? p.number : null })) };
}
