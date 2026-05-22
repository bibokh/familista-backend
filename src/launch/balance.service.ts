// Familista — Phase P · Payer balance + payment history
// ─────────────────────────────────────────────────────────────────────────────
// Aggregates Phase O OperationsPayment rows into per-payer balances. No new
// writes. Currency stays as recorded on the payment row — mixed currencies
// are reported separately rather than summed.

import { OperationsPaymentState, Prisma } from '@prisma/client';
import { prisma } from '../config/database';

export interface LaunchActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface PayerBalance {
  payerKind:    'USER' | 'PLAYER';
  payerId:      string;
  totalsByCurrency: Array<{
    currency:        string;
    outstandingCents: number;
    paidCents:       number;
    overdueCents:    number;
    refundedCents:   number;
  }>;
  paymentCount: number;
  oldestDueAt:  string | null;
  lastPaidAt:   string | null;
}

const OUTSTANDING: OperationsPaymentState[] = ['PENDING', 'OVERDUE'];

export async function payerBalance(actor: LaunchActor, opts: { payerPlayerId?: string; payerUserId?: string }): Promise<PayerBalance> {
  const where: Prisma.OperationsPaymentWhereInput = {
    clubId: actor.clubId,
    ...(opts.payerPlayerId ? { payerPlayerId: opts.payerPlayerId } : {}),
    ...(opts.payerUserId ? { payerUserId: opts.payerUserId } : {}),
  };
  const [rows, count] = await Promise.all([
    prisma.operationsPayment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.operationsPayment.count({ where }),
  ]);
  const byCcy = new Map<string, { outstandingCents: number; paidCents: number; overdueCents: number; refundedCents: number }>();
  let oldestDueAt: Date | null = null;
  let lastPaidAt:  Date | null = null;
  for (const r of rows) {
    const slot = byCcy.get(r.currency) ?? { outstandingCents: 0, paidCents: 0, overdueCents: 0, refundedCents: 0 };
    if (OUTSTANDING.includes(r.state)) slot.outstandingCents += r.amountCents;
    if (r.state === 'OVERDUE') slot.overdueCents += r.amountCents;
    if (r.state === 'PAID')    slot.paidCents += r.amountCents;
    if (r.state === 'REFUNDED') slot.refundedCents += r.amountCents;
    byCcy.set(r.currency, slot);
    if (OUTSTANDING.includes(r.state) && r.dueDate) {
      if (!oldestDueAt || r.dueDate < oldestDueAt) oldestDueAt = r.dueDate;
    }
    if (r.state === 'PAID' && r.paidAt) {
      if (!lastPaidAt || r.paidAt > lastPaidAt) lastPaidAt = r.paidAt;
    }
  }
  return {
    payerKind: opts.payerPlayerId ? 'PLAYER' : 'USER',
    payerId:   opts.payerPlayerId ?? opts.payerUserId ?? '',
    totalsByCurrency: [...byCcy.entries()].map(([currency, t]) => ({ currency, ...t })),
    paymentCount: count,
    oldestDueAt: oldestDueAt?.toISOString() ?? null,
    lastPaidAt:  lastPaidAt?.toISOString() ?? null,
  };
}

export async function paymentHistory(actor: LaunchActor, opts: { payerPlayerId?: string; payerUserId?: string; limit?: number }) {
  const limit = Math.min(opts.limit ?? 100, 500);
  return prisma.operationsPayment.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.payerPlayerId ? { payerPlayerId: opts.payerPlayerId } : {}),
      ...(opts.payerUserId ? { payerUserId: opts.payerUserId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** Mark payments overdue when dueDate passes — safe to call as a cron. */
export async function sweepOverdue(): Promise<{ flagged: number }> {
  const res = await prisma.operationsPayment.updateMany({
    where: { state: 'PENDING', dueDate: { lt: new Date() } },
    data:  { state: 'OVERDUE' },
  });
  return { flagged: res.count };
}

export interface ClubOpsSummary {
  paymentTotalsByCurrency: Array<{ currency: string; outstandingCents: number; paidCents: number; overdueCents: number }>;
  paymentCount:    number;
  activeMembers:   number;
  activePlayers:   number;
}

export async function clubOpsSummary(actor: LaunchActor): Promise<ClubOpsSummary> {
  const [allPayments, activeMembers, activePlayers] = await Promise.all([
    prisma.operationsPayment.findMany({ where: { clubId: actor.clubId }, select: { state: true, currency: true, amountCents: true } }),
    prisma.membership.count({ where: { clubId: actor.clubId, isActive: true } }),
    prisma.player.count({ where: { clubId: actor.clubId, isActive: true } }),
  ]);
  const byCcy = new Map<string, { outstandingCents: number; paidCents: number; overdueCents: number }>();
  for (const p of allPayments) {
    const slot = byCcy.get(p.currency) ?? { outstandingCents: 0, paidCents: 0, overdueCents: 0 };
    if (p.state === 'PENDING' || p.state === 'OVERDUE') slot.outstandingCents += p.amountCents;
    if (p.state === 'OVERDUE') slot.overdueCents += p.amountCents;
    if (p.state === 'PAID')    slot.paidCents += p.amountCents;
    byCcy.set(p.currency, slot);
  }
  return {
    paymentTotalsByCurrency: [...byCcy.entries()].map(([currency, t]) => ({ currency, ...t })),
    paymentCount: allPayments.length,
    activeMembers, activePlayers,
  };
}
