// Establishing the platform's owner — once, explicitly, for one named account
// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM refuses club authority, and it must keep refusing it: a club owner
// running the biggest club on Familista is still not Familista's owner. So the
// platform's owner cannot be inferred from a club role, from a `CLUB_ADMIN`
// account, from being first in the table or from anything else the data happens
// to say. It is an explicit platform-level assignment, made once, for one
// account somebody named.
//
// This file is that assignment, and it is deliberately hard to misuse:
//
//   · it takes exactly ONE identifier — an email or a user id — and refuses if
//     neither is given, or if both are given and disagree.
//   · it refuses an ambiguous match. Two rows, no assignment.
//   · it refuses anything that looks like a demo or test account, by address
//     and by name, so a seeded fixture can never become the owner of the
//     platform. The refusal names the rule it hit.
//   · it is idempotent. Run it once, run it ten times: the second run reports
//     that the owner is already established and writes nothing.
//   · it writes audit evidence — a PlatformAuditLog row — every time it makes
//     or reaffirms the assignment.
//
// And what it never does: it does not read, set or reset a password; it does
// not create, change or remove a Membership; it does not touch a club, a team
// or a player; it does not change `User.role`; and it does not make CLUB_OWNER
// mean anything it did not mean before. Platform ownership is a row in
// PlatformAdmin, and club ownership is a Membership. They stay separate.

import { PlatformAuditCategory, PlatformRole } from '@prisma/client';
import { prisma } from '../config/database';

export interface BootstrapInput {
  email?: string | null;
  userId?: string | null;
  /** What to record as having performed it — a person, or the boot that ran it. */
  performedBy?: string;
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
}

export type BootstrapOutcome =
  | 'ASSIGNED'          // the row was created
  | 'REACTIVATED'       // a retired assignment was made active again
  | 'ALREADY_OWNER'     // nothing to do
  | 'REFUSED';

export interface BootstrapResult {
  outcome: BootstrapOutcome;
  /** Never a password, never a token — an id, an address and a name. */
  user: { id: string; email: string; name: string } | null;
  /** Why, in a sentence. Always present, including on success. */
  reason: string;
  /** The club memberships this account keeps, untouched, as evidence it kept them. */
  membershipsPreserved: number;
  dryRun: boolean;
}

/**
 * Addresses and names that must never become the platform's owner.
 *
 * Deliberately broad and deliberately stated: production carries 132 seeded
 * coach accounts and one known temporary test address, and none of them is a
 * person who owns Familista. A real account caught by this list is a naming
 * problem to fix before the assignment, not a rule to relax.
 */
const DEMO_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^coach@familista\.io$/i,
  /(^|[.@_+-])(demo|test|sample|example|fixture|seed|dummy|qa|staging)([.@_+-]|$)/i,
  /@example\.(com|org|net)$/i,
  /\+test@/i,
]);

function looksLikeDemo(email: string, firstName: string, lastName: string): string | null {
  for (const pattern of DEMO_PATTERNS) {
    if (pattern.test(email)) return `the address matches ${pattern}`;
  }
  const name = `${firstName} ${lastName}`.trim();
  if (/\b(demo|test|sample|fixture|seed|dummy)\b/i.test(name)) return `the name "${name}" reads as a fixture`;
  return null;
}

function refuse(reason: string, dryRun: boolean): BootstrapResult {
  return { outcome: 'REFUSED', user: null, reason, membershipsPreserved: 0, dryRun };
}

/**
 * Establish the platform's owner.
 *
 * Returns rather than throws for every refusal, because this runs from a boot
 * hook: an operator who mistypes an address must see the reason in the log, not
 * a stack trace that takes the API down with it.
 */
export async function bootstrapPlatformOwner(input: BootstrapInput): Promise<BootstrapResult> {
  const dryRun = !!input.dryRun;
  const email = (input.email ?? '').trim().toLowerCase();
  const userId = (input.userId ?? '').trim();

  if (!email && !userId) {
    return refuse('No account was named. Give exactly one email address or user id.', dryRun);
  }

  // ── find exactly one account ───────────────────────────────────────────────
  const matches = await prisma.user.findMany({
    where: email && userId ? { AND: [{ email }, { id: userId }] }
      : email ? { email }
      : { id: userId },
    select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
    take: 5,
  });

  if (matches.length === 0) {
    return refuse(
      email && userId
        ? 'No account has both that email address and that id. They must be the same account.'
        : `No account matches ${email || userId}.`,
      dryRun,
    );
  }
  if (matches.length > 1) {
    return refuse(`${matches.length} accounts match. Name the user id instead — an ambiguous match is never assigned.`, dryRun);
  }

  const user = matches[0];
  const identity = { id: user.id, email: user.email, name: `${user.firstName} ${user.lastName}`.trim() };

  if (!user.isActive) {
    return refuse(`${user.email} is deactivated. Reactivate the account first.`, dryRun);
  }

  const demo = looksLikeDemo(user.email, user.firstName, user.lastName);
  if (demo) {
    return refuse(`${user.email} looks like a demo or test account — ${demo}. Refused.`, dryRun);
  }

  // Counted and reported so the result can PROVE the memberships survived.
  const membershipsPreserved = await prisma.membership.count({ where: { userId: user.id, isActive: true } });

  // ── idempotence ────────────────────────────────────────────────────────────
  const existing = await prisma.platformAdmin.findUnique({
    where: { userId: user.id },
    select: { id: true, isActive: true, role: true },
  });

  if (existing?.isActive) {
    return {
      outcome: 'ALREADY_OWNER',
      user: identity,
      reason: `${user.email} already holds platform authority (${existing.role}). Nothing was written.`,
      membershipsPreserved,
      dryRun,
    };
  }

  if (dryRun) {
    return {
      outcome: existing ? 'REACTIVATED' : 'ASSIGNED',
      user: identity,
      reason: existing
        ? `Would reactivate the retired platform assignment for ${user.email}.`
        : `Would make ${user.email} the platform owner. No password, membership, club or team is touched.`,
      membershipsPreserved,
      dryRun: true,
    };
  }

  // ── the assignment, with its evidence, in one transaction ──────────────────
  const outcome: BootstrapOutcome = existing ? 'REACTIVATED' : 'ASSIGNED';
  await prisma.$transaction(async (tx) => {
    const admin = existing
      ? await tx.platformAdmin.update({
          where: { userId: user.id },
          data: { isActive: true, role: PlatformRole.PLATFORM_OWNER, acceptedAt: new Date() },
        })
      : await tx.platformAdmin.create({
          data: {
            userId: user.id,
            role: PlatformRole.PLATFORM_OWNER,
            ipAllowlist: [],
            mfaEnforced: true,
            acceptedAt: new Date(),
            notes: 'Platform owner established by the one-time bootstrap.',
          },
        });

    await tx.platformAuditLog.create({
      data: {
        adminId: admin.id,
        userId: user.id,
        action: outcome === 'ASSIGNED' ? 'PLATFORM_OWNER_ESTABLISHED' : 'PLATFORM_OWNER_REACTIVATED',
        category: PlatformAuditCategory.PLATFORM_ADMIN,
        resourceType: 'PlatformAdmin',
        resourceId: admin.id,
        metadata: {
          email: user.email,
          performedBy: input.performedBy ?? 'bootstrap',
          membershipsPreserved,
          // Stated in the evidence so a later reader knows what was NOT done.
          untouched: ['password', 'memberships', 'clubs', 'teams', 'User.role'],
        },
        message: 'Platform ownership is a PlatformAdmin row. Club ownership remains a Membership; neither implies the other.',
      },
    });
  });

  return {
    outcome,
    user: identity,
    reason: outcome === 'ASSIGNED'
      ? `${user.email} is now the platform owner. Their ${membershipsPreserved} club membership(s) are untouched.`
      : `${user.email}'s platform assignment was reactivated. Their ${membershipsPreserved} club membership(s) are untouched.`,
    membershipsPreserved,
    dryRun: false,
  };
}

/** Who currently holds platform authority. A read, for the boot log and SYSTEM. */
export async function currentPlatformOwners(): Promise<Array<{ userId: string; email: string; role: string }>> {
  const admins = await prisma.platformAdmin.findMany({
    where: { isActive: true },
    select: { userId: true, role: true, user: { select: { email: true } } },
  });
  return admins.map((a) => ({ userId: a.userId, email: a.user?.email ?? '', role: String(a.role) }));
}
