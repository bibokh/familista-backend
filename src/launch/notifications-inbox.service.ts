// Familista — Phase P · In-app notification inbox
// ─────────────────────────────────────────────────────────────────────────────
// Writes UserNotification rows and serves the inbox. No external dispatch.
// Per-user reads, tenant-scoped club anchor. Composes with Phase O
// UserNotificationChannel (which is the dispatch registry for a future
// worker; the inbox itself is the read fallback when no channel responds).

import { Prisma, UserNotification, UserNotificationKind } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface InboxActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface CreateNotificationDto {
  userId:   string;
  kind?:    UserNotificationKind;
  title:    string;
  body?:    string;
  payload?: Prisma.InputJsonValue;
}

export async function notify(actor: InboxActor, dto: CreateNotificationDto): Promise<UserNotification> {
  if (!dto.userId || !dto.title) throw new BadRequestError('userId + title required');
  // Recipient must belong to actor's club (or actor is SUPER_ADMIN).
  const recipient = await prisma.user.findUnique({ where: { id: dto.userId }, select: { clubId: true, currentClubId: true } });
  if (!recipient) throw new NotFoundError('User');
  const ok = recipient.clubId === actor.clubId || recipient.currentClubId === actor.clubId || actor.role === 'SUPER_ADMIN';
  if (!ok) throw new ForbiddenError();
  const row = await prisma.userNotification.create({
    data: {
      clubId:  actor.clubId,
      userId:  dto.userId,
      kind:    dto.kind ?? 'SYSTEM',
      title:   dto.title,
      body:    dto.body ?? null,
      payload: (dto.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'NOTIFICATION_SENT', entityType: 'UserNotification', entityId: row.id,
    payload: { kind: row.kind, recipient: dto.userId },
  });
  return row;
}

/** Bulk fan-out — e.g. attendance reminders to every parent in a team. */
export async function notifyMany(actor: InboxActor, recipients: string[], template: Omit<CreateNotificationDto, 'userId'>): Promise<{ sent: number }> {
  if (!Array.isArray(recipients) || recipients.length === 0) return { sent: 0 };
  // Limit fan-out to avoid surprise blasts.
  const capped = recipients.slice(0, 500);
  let sent = 0;
  for (const userId of capped) {
    try { await notify(actor, { ...template, userId }); sent++; } catch { /* skip silently — single failure shouldn't block batch */ }
  }
  return { sent };
}

export interface InboxQuery {
  unreadOnly?: boolean;
  kind?:       UserNotificationKind;
  limit?:      number;
}

export async function listInbox(actor: InboxActor, opts: InboxQuery = {}): Promise<UserNotification[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  return prisma.userNotification.findMany({
    where: {
      userId:   actor.userId,
      archived: false,
      ...(opts.unreadOnly ? { readAt: null } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function inboxCounts(actor: InboxActor): Promise<{ total: number; unread: number }> {
  const [total, unread] = await Promise.all([
    prisma.userNotification.count({ where: { userId: actor.userId, archived: false } }),
    prisma.userNotification.count({ where: { userId: actor.userId, archived: false, readAt: null } }),
  ]);
  return { total, unread };
}

export async function markRead(actor: InboxActor, id: string): Promise<UserNotification> {
  const row = await prisma.userNotification.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('UserNotification');
  if (row.userId !== actor.userId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (row.readAt) return row;
  return prisma.userNotification.update({ where: { id }, data: { readAt: new Date() } });
}

export async function markAllRead(actor: InboxActor): Promise<{ updated: number }> {
  const res = await prisma.userNotification.updateMany({
    where: { userId: actor.userId, readAt: null, archived: false },
    data:  { readAt: new Date() },
  });
  return { updated: res.count };
}

export async function archive(actor: InboxActor, id: string): Promise<UserNotification> {
  const row = await prisma.userNotification.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('UserNotification');
  if (row.userId !== actor.userId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.userNotification.update({ where: { id }, data: { archived: true } });
}
