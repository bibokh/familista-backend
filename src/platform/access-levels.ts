// The four human access levels, in one place
// ─────────────────────────────────────────────────────────────────────────────
// Familista has exactly four kinds of person, and they are not a hierarchy of
// one enum. They are three independent facts about somebody, combined:
//
//   PLATFORM ROLE       who they are to Familista itself
//   CLUB MEMBERSHIPS    which clubs they work for, in what role, on what teams
//   NOTHING AT ALL      a person with an account and no membership
//
//   1. PLATFORM_OWNER   owns Familista. Above every club owner, and NOT a club
//                       owner: administering the platform is not the same job
//                       as running a football club, and the two must never be
//                       the same grant.
//   2. CLUB_OWNER       owns one club. Cannot reach another club, ever.
//   3. CLUB_STAFF       works on that club's teams, scoped by membership.
//   4. VIEWER           has a Familista account and no operational membership.
//                       May browse what is PUBLIC across the platform. May
//                       write nothing.
//
// The same person moves between 2, 3 and 4 over their career without ever
// changing account: membership rows appear and disappear; the identity does not.
//
// This file decides which of the four a request is, and nothing else. What each
// may then DO with a given team is `identity/team-access.service.ts`, which is
// unchanged and remains the only answer to that question.

import { UserRole } from '@prisma/client';
import { prisma } from '../config/database';

export type AccessLevel = 'PLATFORM_OWNER' | 'CLUB_OWNER' | 'CLUB_STAFF' | 'VIEWER';

export interface PlatformActor {
  userId: string;
  /** The club the session is acting for, when there is one. */
  clubId?: string | null;
  /** The account-level role, as the token carries it. */
  role?: UserRole | string | null;
}

/**
 * The platform owner.
 *
 * Deliberately expressed over the roles that already exist rather than by a new
 * enum value: `SUPER_ADMIN` is what this platform has always called the account
 * above every club, and a `PlatformAdmin` row is the newer, richer statement of
 * the same thing. Renaming either would be a destructive migration bought for
 * nothing.
 */
export function isPlatformRole(role: UserRole | string | null | undefined): boolean {
  return role === 'SUPER_ADMIN';
}

export async function isPlatformOwner(actor: PlatformActor): Promise<boolean> {
  if (isPlatformRole(actor.role)) return true;
  if (!actor.userId) return false;
  const admin = await prisma.platformAdmin.findUnique({
    where: { userId: actor.userId },
    select: { isActive: true },
  });
  return !!admin?.isActive;
}

/**
 * Which of the four this person is, for the club they are acting in.
 *
 * Read from live rows every time. A membership revoked a second ago changes
 * this answer on the next request, which is the property the whole model rests
 * on.
 */
export async function accessLevelOf(actor: PlatformActor): Promise<AccessLevel> {
  if (await isPlatformOwner(actor)) return 'PLATFORM_OWNER';
  if (!actor.userId || !actor.clubId) return 'VIEWER';

  const rows = await prisma.membership.findMany({
    where: { userId: actor.userId, clubId: actor.clubId, isActive: true },
    select: { role: true },
  });
  if (!rows.length) return 'VIEWER';
  if (rows.some((r) => r.role === 'CLUB_OWNER')) return 'CLUB_OWNER';
  return 'CLUB_STAFF';
}

/**
 * A platform owner is not thereby a club owner.
 *
 * They may INSPECT and ADMINISTER a club under platform governance — that is
 * what owning the platform means — but the two authorities are recorded
 * separately, audited separately, and a club's own screens must never present a
 * platform administrator as one of the club's people.
 */
export interface AuthorityDescription {
  level: AccessLevel;
  /** True only for a membership-granted club ownership. */
  isClubOwner: boolean;
  /** True only for platform authority, which is never a club membership. */
  isPlatformOwner: boolean;
  /** May act on club operational data at all. A viewer may not. */
  canOperate: boolean;
}

export async function describeAuthority(actor: PlatformActor): Promise<AuthorityDescription> {
  const level = await accessLevelOf(actor);
  return {
    level,
    isClubOwner: level === 'CLUB_OWNER',
    isPlatformOwner: level === 'PLATFORM_OWNER',
    canOperate: level === 'CLUB_OWNER' || level === 'CLUB_STAFF' || level === 'PLATFORM_OWNER',
  };
}
