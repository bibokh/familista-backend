// Familista — telling a club what happened to it
// ─────────────────────────────────────────────────────────────────────────────
// This lived inside the negotiation service, which was fine while negotiation
// was the only thing that had news. It no longer is: a fixed-price purchase
// completes a transfer too, and the module that owns purchases cannot import
// the module that owns negotiations — negotiation already imports it back for
// the balance. So the one implementation moved here, where both can reach it,
// and negotiation re-exports it so nothing that already imported it has to
// change.
//
// There is still exactly one notifyClub.

import { Prisma, UserNotificationKind } from '@prisma/client';
import { prisma } from '../config/database';

// Transfers talk to a club, and a club is people: every active member of the
// receiving club gets the row, so whoever is logged in sees it. The payload
// carries what the UI needs to open the right thing and nothing more — no
// budgets, no scouting, no internal notes.
export async function notifyClub(
  clubId: string,
  kind: UserNotificationKind,
  title: string,
  body: string | null,
  payload: Record<string, unknown>,
) {
  const members = await prisma.membership.findMany({
    where: { clubId, isActive: true }, select: { userId: true }, take: 200,
  });
  const legacy = await prisma.user.findMany({
    where: { OR: [{ clubId }, { currentClubId: clubId }], isActive: true },
    select: { id: true }, take: 200,
  });
  const ids = Array.from(new Set(members.map((m) => m.userId).concat(legacy.map((u) => u.id))));
  if (!ids.length) return 0;
  await prisma.userNotification.createMany({
    data: ids.map((userId) => ({
      clubId, userId, kind, title, body,
      payload: payload as Prisma.InputJsonValue,
    })),
  });
  return ids.length;
}

export const fmt = (eur: number) =>
  eur >= 1_000_000 ? '€' + (eur / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
    : eur >= 1_000 ? '€' + Math.round(eur / 1_000) + 'K' : '€' + eur;
