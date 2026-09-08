#!/usr/bin/env node
// Who owns the platform, who owns each club, and where the two have met
// ─────────────────────────────────────────────────────────────────────────────
//   node dist/scripts/audit-identity.js
//
// READ-ONLY. It opens no transaction, writes no row, and has no code that
// could: every query below is a `findMany` or a `count`. Run it against
// production as often as you like.
//
// It answers the questions an identity audit has to answer with data rather
// than with reasoning:
//
//   · which accounts hold platform authority, and how they hold it
//   · what club memberships each of those accounts also holds
//   · which clubs have a president who is NOT a platform account, and which
//     have one who is — the second is the contamination worth seeing
//   · which clubs have no active president at all
//
// It prints an id, an address and a name. It never prints a password, a hash,
// a token, or anything else that could be used to sign in as anybody.

import { prisma } from '../config/database';

const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(76));

async function main(): Promise<number> {
  line('');
  line('════════════════════════════════════════════════════════════════════════');
  line('  Familista — identity audit (read-only)');
  line('════════════════════════════════════════════════════════════════════════');

  // ── 1 · platform authority ────────────────────────────────────────────────
  //
  // Two sources, and the audit shows them separately because they are not the
  // same thing: a PlatformAdmin row is the explicit assignment, and
  // UserRole.SUPER_ADMIN is the account-level field that also satisfies
  // isPlatformOwner. An account holding one and not the other is worth seeing.
  const [admins, superAdmins] = await Promise.all([
    prisma.platformAdmin.findMany({
      select: {
        userId: true, role: true, isActive: true, acceptedAt: true, lastSeenAt: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true, role: true, clubId: true, currentClubId: true } },
      },
    }),
    prisma.user.findMany({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, clubId: true, currentClubId: true },
    }),
  ]);

  line('');
  line('1 · PLATFORM AUTHORITY');
  rule();
  line(`  PlatformAdmin rows            ${admins.length} (${admins.filter((a) => a.isActive).length} active)`);
  for (const a of admins) {
    const u = a.user;
    line(`    · ${u?.email ?? a.userId}`);
    line(`        userId          ${a.userId}`);
    line(`        platform role   ${a.role}${a.isActive ? '' : '   [INACTIVE]'}`);
    line(`        account role    ${u?.role ?? '—'}   (User.role — legacy, not platform authority)`);
    line(`        accepted        ${a.acceptedAt ? a.acceptedAt.toISOString() : '—'}`);
    line(`        last seen       ${a.lastSeenAt ? a.lastSeenAt.toISOString() : '—'}`);
  }
  line(`  User.role = SUPER_ADMIN       ${superAdmins.length} account(s)`);
  for (const u of superAdmins) {
    const alsoAdmin = admins.some((a) => a.userId === u.id);
    line(`    · ${u.email}   userId ${u.id}${alsoAdmin ? '' : '   [no PlatformAdmin row]'}`);
  }

  // ── 2 · what those accounts also are, inside clubs ────────────────────────
  const platformUserIds = [...new Set([...admins.map((a) => a.userId), ...superAdmins.map((u) => u.id)])];
  const platformMemberships = platformUserIds.length
    ? await prisma.membership.findMany({
      where: { userId: { in: platformUserIds } },
      select: {
        id: true, userId: true, clubId: true, teamId: true, role: true, isActive: true, status: true, joinedAt: true,
        club: { select: { name: true } },
        team: { select: { name: true } },
        user: { select: { email: true } },
      },
      orderBy: [{ userId: 'asc' }, { clubId: 'asc' }],
    })
    : [];

  line('');
  line('2 · CLUB MEMBERSHIPS HELD BY PLATFORM ACCOUNTS');
  rule();
  if (!platformMemberships.length) {
    line('  none — platform authority and club membership are fully separate here.');
  }
  for (const m of platformMemberships) {
    const flag = m.isActive && m.role === 'CLUB_OWNER'
      ? '   ← this is what renders as "President"'
      : '';
    line(`    · ${m.user?.email}`);
    line(`        club            ${m.club?.name ?? m.clubId}  (${m.clubId})`);
    line(`        membership      ${m.role}${m.isActive ? '' : '   [INACTIVE]'}  status=${m.status}${flag}`);
    line(`        team scope      ${m.team?.name ?? (m.teamId ? m.teamId : 'club-wide (teamId null)')}`);
    line(`        membershipId    ${m.id}`);
    line(`        joined          ${m.joinedAt ? m.joinedAt.toISOString() : '—'}`);
  }

  // ── 3 · every club's president, and whether it is a platform account ──────
  const owners = await prisma.membership.findMany({
    where: { role: 'CLUB_OWNER', isActive: true },
    select: {
      clubId: true, userId: true,
      club: { select: { name: true } },
      user: { select: { email: true } },
    },
    orderBy: { clubId: 'asc' },
  });
  const clubs = await prisma.club.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });

  line('');
  line('3 · CLUB PRESIDENTS (active CLUB_OWNER memberships)');
  rule();
  for (const c of clubs) {
    const mine = owners.filter((o) => o.clubId === c.id);
    if (!mine.length) {
      line(`    · ${c.name}   — NO ACTIVE PRESIDENT`);
      continue;
    }
    for (const o of mine) {
      const isPlatform = platformUserIds.includes(o.userId);
      line(`    · ${c.name}   president ${o.user?.email}${isPlatform ? '   ← ALSO A PLATFORM ACCOUNT' : ''}`);
    }
  }

  // ── 4 · the shape of the estate, for scale ────────────────────────────────
  const [userCount, membershipCount, activeMemberships] = await Promise.all([
    prisma.user.count(),
    prisma.membership.count(),
    prisma.membership.count({ where: { isActive: true } }),
  ]);
  line('');
  line('4 · SCALE');
  rule();
  line(`  users                         ${userCount}`);
  line(`  memberships                   ${membershipCount} (${activeMemberships} active)`);
  line(`  clubs                         ${clubs.length}`);

  line('');
  line('  Nothing was written. This script has no write path.');
  line('');
  return 0;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (err) => {
    console.error('audit failed:', err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
