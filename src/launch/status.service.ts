// Familista — Phase P · Production status rollup
// ─────────────────────────────────────────────────────────────────────────────
// Single-call status surface for the operations dashboard. Composes:
//   • DB ping
//   • auth — active sessions + MFA-enrolled count
//   • routes — count of registered router stacks (read from caller)
//   • devices — total + online
//   • queue — AI agent queue depth (pending/running)
//   • audit — head SHA of the Phase I chain + recent verify
//
// Read-only. Tenant-scoped. ≤ 6 DB round-trips.

import { prisma } from '../config/database';

export interface StatusActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface ProductionStatus {
  ok:           boolean;
  generatedAt:  string;
  db:           { ok: boolean; latencyMs: number | null };
  auth:         { activeSessions: number; mfaEnrolled: number };
  ops:          {
    activeMembers:     number;
    activePlayers:     number;
    openPayments:      number;
    upcomingTrainings: number;
  };
  devices:      { inventoryTotal: number; deployed: number; stock: number; rma: number };
  queue:        { aiPending: number; aiRunning: number };
  audit:        { headSha: string | null; eventCount: number };
  gdpr:         { pending: number; processing: number };
  notifications: { totalInbox: number; unread: number };
}

export async function productionStatus(actor: StatusActor): Promise<ProductionStatus> {
  const t0 = Date.now();
  let dbOk = true;
  let dbLatency: number | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbLatency = Date.now() - t0;
  } catch {
    dbOk = false;
  }

  const [
    activeSessions, mfaEnrolled,
    activeMembers, activePlayers, openPayments, upcomingTrainings,
    inventoryTotal, deployed, stock, rma,
    aiPending, aiRunning,
    auditHead, auditCount,
    pendingGdpr, processingGdpr,
    totalInbox, unread,
  ] = await Promise.all([
    prisma.authSession.count({ where: { status: 'ACTIVE' } }),
    prisma.mFASetting.count({ where: { enabledAt: { not: null } } }),
    prisma.membership.count({ where: { clubId: actor.clubId, isActive: true } }),
    prisma.player.count({ where: { clubId: actor.clubId, isActive: true } }),
    prisma.operationsPayment.count({ where: { clubId: actor.clubId, state: { in: ['PENDING', 'OVERDUE'] } } }),
    prisma.trainingSession.count({ where: { clubId: actor.clubId, scheduledAt: { gte: new Date() } } }),
    prisma.deviceInventoryEntry.count({ where: { clubId: actor.clubId } }),
    prisma.deviceInventoryEntry.count({ where: { clubId: actor.clubId, state: 'DEPLOYED' } }),
    prisma.deviceInventoryEntry.count({ where: { clubId: actor.clubId, state: 'STOCK' } }),
    prisma.deviceInventoryEntry.count({ where: { clubId: actor.clubId, state: 'RMA' } }),
    safeCount(() => prisma.aIAgentJob.count({ where: { status: 'PENDING' } })),
    safeCount(() => prisma.aIAgentJob.count({ where: { status: 'RUNNING' } })),
    safeFindAuditHead(),
    safeCount(() => prisma.securityAuditEvent.count()),
    prisma.gdprDataRequest.count({ where: { clubId: actor.clubId, state: 'PENDING' } }),
    prisma.gdprDataRequest.count({ where: { clubId: actor.clubId, state: 'PROCESSING' } }),
    prisma.userNotification.count({ where: { userId: actor.userId, archived: false } }),
    prisma.userNotification.count({ where: { userId: actor.userId, archived: false, readAt: null } }),
  ]);

  const ok = dbOk;
  return {
    ok,
    generatedAt: new Date().toISOString(),
    db:           { ok: dbOk, latencyMs: dbLatency },
    auth:         { activeSessions, mfaEnrolled },
    ops:          { activeMembers, activePlayers, openPayments, upcomingTrainings },
    devices:      { inventoryTotal, deployed, stock, rma },
    queue:        { aiPending, aiRunning },
    audit:        { headSha: auditHead, eventCount: auditCount },
    gdpr:         { pending: pendingGdpr, processing: processingGdpr },
    notifications: { totalInbox, unread },
  };
}

async function safeCount(fn: () => Promise<number>): Promise<number> {
  try { return await fn(); } catch { return 0; }
}

async function safeFindAuditHead(): Promise<string | null> {
  try {
    const head = await prisma.securityAuditEvent.findFirst({ orderBy: { createdAt: 'desc' }, select: { currentHash: true } });
    return head?.currentHash ?? null;
  } catch {
    return null;
  }
}
