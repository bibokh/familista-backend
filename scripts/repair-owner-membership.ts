// Target: scripts/repair-owner-membership.ts
//
// One-time idempotent repair: grants khatab@familista.io an active
// CLUB_OWNER Membership for FC Familista and syncs currentClubId.
//
// Run in production:
//   npx ts-node scripts/repair-owner-membership.ts
//   (or: node -r ts-node/register scripts/repair-owner-membership.ts)
//
// Safe to re-run — exits cleanly with a log message if the membership
// already exists and is active.

import { PrismaClient, MembershipRole, MembershipAuditAction } from '@prisma/client';

const prisma = new PrismaClient();

const TARGET_EMAIL   = 'khatab@familista.io';
const TARGET_CLUB    = 'FC Familista';
const ACTOR_LABEL    = 'repair-owner-membership-script';

async function main() {
  // ── 1. Resolve club ──────────────────────────────────────────────────────
  const club = await prisma.club.findFirst({
    where:  { name: TARGET_CLUB },
    select: { id: true, name: true },
  });
  if (!club) {
    console.error(`[repair] Club "${TARGET_CLUB}" not found in database. Aborting.`);
    process.exit(1);
  }
  console.log(`[repair] Club  : ${club.name} (${club.id})`);

  // ── 2. Resolve user ──────────────────────────────────────────────────────
  const user = await prisma.user.findUnique({
    where:  { email: TARGET_EMAIL },
    select: { id: true, email: true, isActive: true },
  });
  if (!user) {
    console.error(`[repair] User "${TARGET_EMAIL}" not found. Aborting.`);
    process.exit(1);
  }
  if (!user.isActive) {
    console.error(`[repair] User "${TARGET_EMAIL}" is deactivated. Aborting.`);
    process.exit(1);
  }
  console.log(`[repair] User  : ${user.email} (${user.id})`);

  // ── 3. Check existing membership ─────────────────────────────────────────
  const existing = await prisma.membership.findFirst({
    where: { userId: user.id, clubId: club.id, teamId: null, role: MembershipRole.CLUB_OWNER },
  });

  await prisma.$transaction(async (tx) => {
    let membershipId: string;
    let action: MembershipAuditAction;

    if (existing) {
      if (existing.isActive) {
        console.log(`[repair] Membership already active (${existing.id}). Nothing to do.`);
        return;
      }
      // Reactivate a previously revoked row.
      const updated = await tx.membership.update({
        where: { id: existing.id },
        data:  { isActive: true, leftAt: null },
      });
      membershipId = updated.id;
      action       = MembershipAuditAction.REACTIVATE;
      console.log(`[repair] Reactivated existing CLUB_OWNER membership (${updated.id}).`);
    } else {
      // Create fresh row.
      const created = await tx.membership.create({
        data: {
          userId:   user.id,
          clubId:   club.id,
          teamId:   null,
          role:     MembershipRole.CLUB_OWNER,
          isActive: true,
        },
      });
      membershipId = created.id;
      action       = MembershipAuditAction.GRANT;
      console.log(`[repair] Created new CLUB_OWNER membership (${created.id}).`);
    }

    await tx.membershipAuditLog.create({
      data: {
        membershipId,
        clubId:      club.id,
        actorUserId: null,           // script actor, no user session
        action,
        after: {
          script:    ACTOR_LABEL,
          userId:    user.id,
          clubId:    club.id,
          role:      MembershipRole.CLUB_OWNER,
          isActive:  true,
        },
        reason: 'repair-owner-membership: seed.ts had coach declared after membershipSpecs; membership loop never ran',
      },
    });
  });

  // ── 4. Sync currentClubId so JWT context resolves on next login ──────────
  await prisma.user.update({
    where: { id: user.id },
    data:  { currentClubId: club.id },
  });
  console.log(`[repair] Set currentClubId → ${club.id}`);
  console.log('[repair] Done.');
}

main()
  .catch((e) => { console.error('[repair] Fatal:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
