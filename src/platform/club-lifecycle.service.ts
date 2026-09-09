// A club's operational state, and who may change it
// ─────────────────────────────────────────────────────────────────────────────
// Familista already had a lifecycle: PENDING_SETUP → PRESIDENT_INVITED →
// ACTIVE, which is the story of a club being ONBOARDED. This adds the other
// story — a club that exists and is running being SUSPENDED or PUT AWAY — to
// the same column rather than beside it, because two columns that both claim
// to say whether a club is usable will eventually disagree, and the day they
// disagree is the day somebody is locked out of a club that looks fine.
//
// The two new states are soft, and that word is load-bearing:
//
//   DEACTIVATED  Every row the club owns is exactly where it was. Players,
//                teams, academy sides, memberships and their roles, training,
//                matches, tactics, transfers, coach-market history, media,
//                medical records, settings, history. Nothing is deleted,
//                nothing is rewritten, nothing is anonymised. What changes is
//                one enum on one row, and what that enum does is refuse the
//                club's own people the ability to OPERATE it.
//
//   ARCHIVED     The same preservation, plus the club leaves the ordinary
//                listings. A club the platform is keeping, rather than one
//                anybody is running.
//
// Both are reversible, and reversing them restores what the club WAS rather
// than assuming it was active: `previousLifecycle` is written on the way out
// and read on the way back, so a club suspended while it was still waiting for
// its president comes back still waiting for its president.
//
// Permanent deletion is the only operation here that destroys anything, and it
// is deliberately the one that almost always refuses. See `deleteClubForever`.

import { ClubLifecycle, Prisma, PlatformAuditCategory } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors';
import type { PlatformActor } from './access-levels';
import { assertPlatformOwner } from './system.service';
import { currentEnvironment } from './environment';

export interface LifecycleActor extends PlatformActor {
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

/**
 * The states in which a club may be OPERATED by its own people.
 *
 * A club being set up is operable: its incoming president has to be able to
 * accept an invitation and start work, and refusing them would make onboarding
 * impossible. Suspension and archival are the two states that are not, and
 * they are the whole point of this file.
 *
 * Written as a set of the states that ARE operable rather than the two that are
 * not, so that a lifecycle value added later is refused by default. That is the
 * safe direction for this particular list to be wrong in.
 */
export const OPERABLE_LIFECYCLES: ReadonlySet<ClubLifecycle> = new Set<ClubLifecycle>([
  ClubLifecycle.PENDING_SETUP,
  ClubLifecycle.PRESIDENT_INVITED,
  ClubLifecycle.ACTIVE,
]);

export function isOperableLifecycle(lifecycle: ClubLifecycle | string | null | undefined): boolean {
  return !!lifecycle && OPERABLE_LIFECYCLES.has(lifecycle as ClubLifecycle);
}

/** The two states the platform puts a club INTO, as opposed to it arriving there. */
export function isSuspendedLifecycle(lifecycle: ClubLifecycle | string | null | undefined): boolean {
  return lifecycle === ClubLifecycle.DEACTIVATED || lifecycle === ClubLifecycle.ARCHIVED;
}

// ── the club-state memo ──────────────────────────────────────────────────────
//
// Every authenticated request asks whether the club it is acting for may be
// operated, so this is read as often as the identity itself. It is held for a
// few seconds and dropped the instant a lifecycle changes — by the transition
// functions below, which are the only thing that writes it.
//
// Keyed by club rather than by user, deliberately: suspending a club must take
// effect for every one of its people at once, and a per-user cache would expire
// at a different moment for each of them.
const STATE_TTL_MS = parseInt(process.env.CLUB_STATE_TTL_MS ?? '5000', 10);
const stateMemo = new Map<string, { at: number; lifecycle: ClubLifecycle | null }>();

/** Drop a memoised club state. Called by every transition below. */
export function forgetClubState(clubId?: string | null): void {
  if (clubId) stateMemo.delete(clubId);
  else stateMemo.clear();
}

/** The club's lifecycle, or null when there is no such club. */
export async function clubLifecycleOf(clubId: string): Promise<ClubLifecycle | null> {
  if (!clubId) return null;
  const hit = stateMemo.get(clubId);
  const now = Date.now();
  if (hit && now - hit.at < STATE_TTL_MS) return hit.lifecycle;

  const row = await prisma.club.findUnique({ where: { id: clubId }, select: { lifecycle: true } });
  const lifecycle = row ? row.lifecycle : null;
  if (stateMemo.size >= 5000) stateMemo.clear();
  stateMemo.set(clubId, { at: Date.now(), lifecycle });
  return lifecycle;
}

// ── the transitions ──────────────────────────────────────────────────────────

export interface ClubLifecycleState {
  clubId: string;
  name: string;
  lifecycle: ClubLifecycle;
  previousLifecycle: ClubLifecycle | null;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  archivedAt: Date | null;
  reactivatedAt: Date | null;
  restoredAt: Date | null;
  lifecycleChangedAt: Date | null;
  lifecycleChangedByUserId: string | null;
  lifecycleReason: string | null;
}

const STATE_SELECT = {
  id: true, name: true, lifecycle: true, previousLifecycle: true,
  activatedAt: true, deactivatedAt: true, archivedAt: true,
  reactivatedAt: true, restoredAt: true,
  lifecycleChangedAt: true, lifecycleChangedByUserId: true, lifecycleReason: true,
} as const;

type StateRow = {
  id: string; name: string; lifecycle: ClubLifecycle; previousLifecycle: ClubLifecycle | null;
  activatedAt: Date | null; deactivatedAt: Date | null; archivedAt: Date | null;
  reactivatedAt: Date | null; restoredAt: Date | null;
  lifecycleChangedAt: Date | null; lifecycleChangedByUserId: string | null; lifecycleReason: string | null;
};

const view = (c: StateRow): ClubLifecycleState => ({
  clubId: c.id,
  name: c.name,
  lifecycle: c.lifecycle,
  previousLifecycle: c.previousLifecycle,
  activatedAt: c.activatedAt,
  deactivatedAt: c.deactivatedAt,
  archivedAt: c.archivedAt,
  reactivatedAt: c.reactivatedAt,
  restoredAt: c.restoredAt,
  lifecycleChangedAt: c.lifecycleChangedAt,
  lifecycleChangedByUserId: c.lifecycleChangedByUserId,
  lifecycleReason: c.lifecycleReason,
});

const REASON_MAX = 500;
function reasonOf(reason?: string | null): string | null {
  const r = (reason ?? '').trim();
  if (!r) return null;
  if (r.length > REASON_MAX) throw new BadRequestError(`A reason may be at most ${REASON_MAX} characters`);
  return r;
}

/**
 * One transition, written once.
 *
 * Every lifecycle change is the same five things in the same order: refuse
 * anybody who is not the platform owner, read the club, check the move is legal
 * FROM where it actually is, write the new state with its timestamps, and
 * record what happened. Writing that five times over would be five chances for
 * one of them to lose the authorization check.
 *
 * The update is conditional on the lifecycle the read saw, so two administrators
 * clicking at once produce one transition and one audit row rather than two.
 */
async function transition(
  actor: LifecycleActor,
  clubId: string,
  opts: {
    action: string;
    to: ClubLifecycle | 'PREVIOUS';
    legalFrom: (from: ClubLifecycle) => boolean;
    refusal: (from: ClubLifecycle) => string;
    stamp: (now: Date) => Prisma.ClubUpdateInput;
    reason?: string | null;
  },
): Promise<ClubLifecycleState> {
  await assertPlatformOwner(actor);

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: STATE_SELECT });
  if (!club) throw new NotFoundError('Club');

  const from = club.lifecycle;
  if (!opts.legalFrom(from)) throw new ConflictError(opts.refusal(from));

  // Coming back means coming back to what it was. A club suspended while it was
  // still waiting for a president must not return as one that has one.
  const to = opts.to === 'PREVIOUS'
    ? (club.previousLifecycle ?? ClubLifecycle.ACTIVE)
    : opts.to;

  const now = new Date();
  const reason = reasonOf(opts.reason);

  const updated = await prisma.$transaction(async (tx) => {
    const moved = await tx.club.updateMany({
      // Conditional on what was read: whoever gets here second changes nothing.
      where: { id: clubId, lifecycle: from },
      data: {
        lifecycle: to,
        // Written centrally, because it is the one field whose value is a
        // consequence of the transition rather than a choice the caller makes:
        // going INTO a suspended state records where the club came from, and
        // coming back out clears it. A per-transition `stamp` that had to
        // remember this is a per-transition chance to forget it.
        previousLifecycle: isSuspendedLifecycle(to) ? from : null,
        ...opts.stamp(now),
        lifecycleChangedAt: now,
        lifecycleChangedByUserId: actor.userId,
        lifecycleReason: reason,
      },
    });
    if (moved.count !== 1) {
      throw new ConflictError('That club changed state while this was being applied. Read it again.');
    }

    const admin = await tx.platformAdmin.findUnique({
      where: { userId: actor.userId }, select: { id: true },
    });
    await tx.platformAuditLog.create({
      data: {
        adminId: admin?.id ?? null,
        userId: actor.userId,
        clubId,
        action: opts.action,
        category: PlatformAuditCategory.CLUB_MANAGEMENT,
        resourceType: 'Club',
        resourceId: clubId,
        ipAddress: actor.ipAddress ?? undefined,
        userAgent: actor.userAgent ?? undefined,
        metadata: {
          from: String(from),
          to: String(to),
          reason,
          environment: currentEnvironment(),
          correlationId: actor.correlationId ?? null,
        } as Prisma.InputJsonValue,
        message: `${club.name}: ${String(from)} → ${String(to)}`,
      },
    });

    return tx.club.findUniqueOrThrow({ where: { id: clubId }, select: STATE_SELECT });
  });

  // Every request that asks whether this club may be operated must get the new
  // answer, not the one cached a second ago.
  forgetClubState(clubId);
  return view(updated);
}

/**
 * Suspend a club. Nothing it owns is touched.
 *
 * Legal from any state a club can actually be in EXCEPT archived — a club that
 * has been put away is not suspended, it is put away, and going straight from
 * one to the other would lose the state it was in before it was archived.
 */
export function deactivateClub(actor: LifecycleActor, clubId: string, reason?: string | null) {
  return transition(actor, clubId, {
    action: 'ClubDeactivated',
    to: ClubLifecycle.DEACTIVATED,
    legalFrom: (from) => isOperableLifecycle(from),
    refusal: (from) => from === ClubLifecycle.DEACTIVATED
      ? 'That club is already deactivated'
      : 'An archived club is not suspended. Restore it first, then deactivate it.',
    stamp: (now) => ({ deactivatedAt: now }),
    reason,
  });
}

export function reactivateClub(actor: LifecycleActor, clubId: string, reason?: string | null) {
  return transition(actor, clubId, {
    action: 'ClubReactivated',
    to: 'PREVIOUS',
    legalFrom: (from) => from === ClubLifecycle.DEACTIVATED,
    refusal: (from) => from === ClubLifecycle.ARCHIVED
      ? 'That club is archived rather than deactivated. Restore it instead.'
      : 'That club is not deactivated',
    stamp: (now) => ({ reactivatedAt: now }),
    reason,
  });
}

export function archiveClub(actor: LifecycleActor, clubId: string, reason?: string | null) {
  return transition(actor, clubId, {
    action: 'ClubArchived',
    to: ClubLifecycle.ARCHIVED,
    legalFrom: (from) => from !== ClubLifecycle.ARCHIVED,
    refusal: () => 'That club is already archived',
    stamp: (now) => ({ archivedAt: now }),
    reason,
  });
}

export function restoreClub(actor: LifecycleActor, clubId: string, reason?: string | null) {
  return transition(actor, clubId, {
    action: 'ClubRestored',
    to: 'PREVIOUS',
    legalFrom: (from) => from === ClubLifecycle.ARCHIVED,
    refusal: () => 'That club is not archived',
    stamp: (now) => ({ restoredAt: now }),
    reason,
  });
}

export async function clubLifecycleState(actor: PlatformActor, clubId: string): Promise<ClubLifecycleState> {
  await assertPlatformOwner(actor);
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: STATE_SELECT });
  if (!club) throw new NotFoundError('Club');
  return view(club);
}

// ── the history ──────────────────────────────────────────────────────────────

export interface LifecycleEvent {
  id: string;
  action: string;
  from: string | null;
  to: string | null;
  reason: string | null;
  changedByUserId: string | null;
  changedByEmail: string | null;
  changedByName: string | null;
  at: Date;
}

const LIFECYCLE_ACTIONS = [
  'ClubCreated', 'ClubPresidentInvited', 'ClubPresidentInviteResent',
  'ClubPresidentInviteRevoked', 'ClubPresidentInviteReplaced', 'ClubActivated',
  'ClubDeactivated', 'ClubReactivated', 'ClubArchived', 'ClubRestored',
];

/**
 * Who changed this club's state, when, from what, to what.
 *
 * Read from PlatformAuditLog rather than from a second table of its own: the
 * platform already records every club-management event there, including the
 * onboarding ones, so a history built here would be a partial duplicate of a
 * complete record. The club's own columns are a denormalisation of the newest
 * row in this list.
 */
export async function clubLifecycleHistory(
  actor: PlatformActor,
  clubId: string,
  opts: { limit?: number } = {},
): Promise<LifecycleEvent[]> {
  await assertPlatformOwner(actor);

  const rows = await prisma.platformAuditLog.findMany({
    where: { clubId, action: { in: LIFECYCLE_ACTIONS } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 500),
    select: { id: true, action: true, userId: true, metadata: true, createdAt: true },
  });
  if (!rows.length) return [];

  const userIds = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u))];
  const users = userIds.length
    ? await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, firstName: true, lastName: true },
    })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const who = r.userId ? byId.get(r.userId) : undefined;
    return {
      id: r.id,
      action: r.action,
      from: typeof meta.from === 'string' ? meta.from : null,
      to: typeof meta.to === 'string' ? meta.to : null,
      reason: typeof meta.reason === 'string' ? meta.reason : null,
      changedByUserId: r.userId ?? null,
      changedByEmail: who?.email ?? null,
      changedByName: who ? `${who.firstName} ${who.lastName}`.trim() : null,
      at: r.createdAt,
    };
  });
}

// ── permanent deletion ───────────────────────────────────────────────────────

export interface ClubDependencies {
  clubId: string;
  name: string;
  lifecycle: ClubLifecycle;
  counts: Record<string, number>;
  total: number;
  /** True only when every count is zero. */
  deletable: boolean;
  /** What stands in the way, named, when it is not. */
  blockers: Array<{ kind: string; count: number }>;
}

/**
 * Everything that would have to go with the club.
 *
 * Counted, named and returned BEFORE anything is destroyed, because the only
 * honest way to ask somebody to confirm an irreversible act is to show them
 * what it costs. The counts are also the refusal: a club with anything in it
 * cannot be permanently deleted, and this is what says why.
 */
export async function clubDependencies(actor: PlatformActor, clubId: string): Promise<ClubDependencies> {
  await assertPlatformOwner(actor);
  const club = await prisma.club.findUnique({
    where: { id: clubId }, select: { id: true, name: true, lifecycle: true },
  });
  if (!club) throw new NotFoundError('Club');

  const where = { clubId };
  const [
    teams, memberships, players, matches, invitations, trainingSessions,
    users, announcements, staffEngagements, financials, devices, scoutReports,
  ] = await Promise.all([
    prisma.team.count({ where }),
    prisma.membership.count({ where }),
    prisma.player.count({ where }),
    prisma.match.count({ where }),
    prisma.clubInvitation.count({ where }),
    prisma.trainingSession.count({ where }),
    prisma.user.count({ where: { clubId } }),
    prisma.announcement.count({ where }),
    prisma.staffEngagement.count({ where }),
    prisma.financial.count({ where }),
    prisma.gpsDevice.count({ where }),
    prisma.scoutReport.count({ where }),
  ]);

  const counts: Record<string, number> = {
    teams, memberships, players, matches, invitations, trainingSessions,
    users, announcements, staffEngagements, financials, devices, scoutReports,
  };
  const blockers = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return { clubId: club.id, name: club.name, lifecycle: club.lifecycle, counts, total, deletable: total === 0, blockers };
}

/**
 * Destroy a club permanently. The only irreversible operation in this file, and
 * the one written to refuse.
 *
 * Three gates, all of them server-side, because a confirmation dialog is a
 * courtesy and not a control:
 *
 *   1 · The platform owner, and nobody else. A club's own president cannot
 *       reach this at all, at any URL, with any payload.
 *   2 · The exact club name, typed. Not the id — an id can be copied out of the
 *       address bar without ever reading what it names.
 *   3 * Nothing depending on it. A club with a single player, membership,
 *       match, invitation or training session is REFUSED, and the refusal says
 *       what is in the way.
 *
 * The third gate is the important one, and it is deliberately not negotiable
 * from the request. There is no `force`, no `cascade` and no `deleteRelated`,
 * because the way this operation destroys a season's work is by being given
 * one. Emptying a club is a decision made record by record, by the people whose
 * records they are; deletion here removes a club that is already empty.
 *
 * Suspension is what "we want this club gone for now" actually means, and it is
 * reversible, which is why it is the operation this one points at.
 */
export async function deleteClubForever(
  actor: LifecycleActor,
  clubId: string,
  confirmation: { name: string },
): Promise<{ clubId: string; name: string; deleted: true }> {
  await assertPlatformOwner(actor);

  const club = await prisma.club.findUnique({
    where: { id: clubId }, select: { id: true, name: true },
  });
  if (!club) throw new NotFoundError('Club');

  const typed = (confirmation?.name ?? '').trim();
  if (!typed || typed !== club.name) {
    throw new BadRequestError('Type the club\'s exact name to confirm permanent deletion');
  }

  const deps = await clubDependencies(actor, clubId);
  if (!deps.deletable) {
    const named = deps.blockers.map((b) => `${b.count} ${b.kind}`).join(', ');
    throw new ConflictError(
      `That club cannot be permanently deleted: ${named} still belong to it. `
      + 'Deactivate or archive it instead — both keep every record exactly as it is.',
    );
  }

  await prisma.$transaction(async (tx) => {
    const admin = await tx.platformAdmin.findUnique({
      where: { userId: actor.userId }, select: { id: true },
    });
    // The audit row is written FIRST and deliberately keeps no foreign key to
    // the club: PlatformAuditLog.clubId is ON DELETE SET NULL, so the record
    // that this club was deleted survives the club's deletion. A history that
    // disappears with the thing it describes is not a history.
    await tx.platformAuditLog.create({
      data: {
        adminId: admin?.id ?? null,
        userId: actor.userId,
        clubId,
        action: 'ClubDeletedPermanently',
        category: PlatformAuditCategory.CLUB_MANAGEMENT,
        resourceType: 'Club',
        resourceId: clubId,
        ipAddress: actor.ipAddress ?? undefined,
        userAgent: actor.userAgent ?? undefined,
        metadata: {
          clubName: club.name,
          dependencies: deps.counts,
          environment: currentEnvironment(),
          correlationId: actor.correlationId ?? null,
        } as Prisma.InputJsonValue,
        message: `${club.name} was permanently deleted`,
      },
    });
    await tx.club.delete({ where: { id: clubId } });
  });

  forgetClubState(clubId);
  return { clubId: club.id, name: club.name, deleted: true };
}
