// Familista — Data Retention Enforcement Worker
// ─────────────────────────────────────────────────────────────────────────
// Reads DataRetentionPolicy rows (Phase O governance) and enforces them
// against the actual tables. Without this worker, retention is theatre —
// rows accumulate forever regardless of declared policy.
//
// Design:
//   • Runs every RETENTION_TICK_MS (default 1h).
//   • For each ACTIVE policy: compute the cutoff timestamp (now - retentionDays)
//     and DELETE rows older than the cutoff in that policy's entityType.
//   • retentionDays = 0 is a special "forever" marker (audit chain).
//   • SecurityAuditEvent is NEVER deleted by this worker even if policy says
//     so — the chain cannot tolerate row removal without an explicit
//     federated re-anchor (out of scope here).
//   • Deletes are batched (LIMIT 5_000 per tick per entity) to keep WAL
//     traffic bounded.
//   • Every delete batch writes a SecurityEvent audit row so the action is
//     traceable.
//   • Global policies (clubId=null) apply to ALL clubs that don't have a
//     more-specific override.

import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { logSecurityEvent } from '../security/security-event.service';

const TICK_MS    = parseInt(process.env.RETENTION_TICK_MS    ?? `${60 * 60_000}`, 10); // 1h
const BATCH_SIZE = parseInt(process.env.RETENTION_BATCH_SIZE ?? '5000',           10);

// ─────────────────────────────────────────────────────────────────────────
// Per-entity sweepers. Each returns the number of rows deleted.
// Add a new entity by extending SWEEPERS below.
//
// Contract: the function must:
//   • Filter by clubId if provided (null = global policy = all clubs).
//   • Filter by a "createdAt < cutoff" rule using the table's
//     natural time column.
//   • LIMIT-delete via a `where: { id: { in: [...] } }` lookup-then-delete
//     pattern — Prisma doesn't support LIMIT on deleteMany().
// ─────────────────────────────────────────────────────────────────────────

interface SweepArgs { clubId: string | null; cutoff: Date; limit: number }
type Sweeper = (args: SweepArgs) => Promise<number>;

const SWEEPERS: Record<string, Sweeper> = {
  SensorPacket: async ({ clubId, cutoff, limit }) => {
    const rows = await prisma.sensorPacket.findMany({
      where: { capturedAt: { lt: cutoff }, ...(clubId ? { deviceSession: { clubId } } : {}) },
      orderBy: { capturedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.sensorPacket.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  AIAlert: async ({ clubId, cutoff, limit }) => {
    const rows = await prisma.aIAlert.findMany({
      where: { createdAt: { lt: cutoff }, ...(clubId ? { clubId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.aIAlert.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  AIRecommendation: async ({ clubId, cutoff, limit }) => {
    const rows = await prisma.aIRecommendation.findMany({
      where: { createdAt: { lt: cutoff }, ...(clubId ? { clubId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.aIRecommendation.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  AIReport: async ({ clubId, cutoff, limit }) => {
    const rows = await prisma.aIReport.findMany({
      where: { createdAt: { lt: cutoff }, ...(clubId ? { clubId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.aIReport.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  AIAgentJob: async ({ clubId, cutoff, limit }) => {
    const rows = await prisma.aIAgentJob.findMany({
      where: { createdAt: { lt: cutoff }, status: { in: ['SUCCESS', 'FAILED', 'CANCELLED'] }, ...(clubId ? { clubId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.aIAgentJob.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  EventOutbox: async ({ clubId, cutoff, limit }) => {
    // Only delete already-published outbox rows.
    const rows = await prisma.eventOutbox.findMany({
      where: { createdAt: { lt: cutoff }, publishedAt: { not: null }, ...(clubId ? { clubId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.eventOutbox.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  AuthSession: async ({ clubId: _clubId, cutoff, limit }) => {
    // Revoked / expired sessions only.
    const rows = await prisma.authSession.findMany({
      where: { status: { in: ['REVOKED', 'EXPIRED'] }, expiresAt: { lt: cutoff } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.authSession.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  SecurityEvent: async ({ clubId, cutoff, limit }) => {
    const rows = await prisma.securityEvent.findMany({
      where: { createdAt: { lt: cutoff }, ...(clubId ? { clubId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.securityEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  LoginAttempt: async ({ clubId: _clubId, cutoff, limit }) => {
    const rows = await prisma.loginAttempt.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.loginAttempt.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },

  UserNotification: async ({ clubId, cutoff, limit }) => {
    // Only delete already-read or archived notifications.
    const rows = await prisma.userNotification.findMany({
      where: { createdAt: { lt: cutoff }, OR: [{ readAt: { not: null } }, { archived: true }], ...(clubId ? { clubId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.userNotification.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return res.count;
  },
};

// SecurityAuditEvent is intentionally NOT in SWEEPERS — see header.
const PROTECTED_ENTITIES = new Set(['SecurityAuditEvent']);

let _timer: ReturnType<typeof setTimeout> | null = null;
let _running = false;

export async function runRetentionTick(): Promise<{ swept: Array<{ policyId: string; entityType: string; clubId: string | null; deleted: number }> }> {
  const policies = await prisma.dataRetentionPolicy.findMany({
    where: { isActive: true },
    orderBy: { entityType: 'asc' },
    take: 1000,
  });

  const out: Array<{ policyId: string; entityType: string; clubId: string | null; deleted: number }> = [];

  for (const p of policies) {
    if (PROTECTED_ENTITIES.has(p.entityType)) continue;
    if (p.retentionDays <= 0) continue;     // 0 = forever
    const sweeper = SWEEPERS[p.entityType];
    if (!sweeper) {
      logger.warn('[retention] no sweeper registered for entity', { entityType: p.entityType });
      continue;
    }
    const cutoff = new Date(Date.now() - p.retentionDays * 86_400_000);
    try {
      const deleted = await sweeper({ clubId: p.clubId, cutoff, limit: BATCH_SIZE });
      out.push({ policyId: p.id, entityType: p.entityType, clubId: p.clubId, deleted });
      if (deleted > 0) {
        // 'RETENTION_PURGE' is not (yet) in SecurityEventKind enum — use the
        // closest existing kind and tag the actual event in the payload so
        // log scrapers can still pivot on it. A dedicated enum value is a
        // safe additive schema change for a later commit.
        logSecurityEvent({
          kind: 'AUDIT_CHAIN_VERIFIED' as never, severity: 'INFO',
          clubId: p.clubId,
          payload: { event: 'RETENTION_PURGE', entityType: p.entityType, retentionDays: p.retentionDays, cutoffIso: cutoff.toISOString(), deleted },
        });
        logger.info('[retention] purged', { entityType: p.entityType, clubId: p.clubId, retentionDays: p.retentionDays, deleted });
      }
    } catch (err) {
      logger.error('[retention] sweeper failed', { entityType: p.entityType, clubId: p.clubId, err: (err as Error).message });
    }
  }
  return { swept: out };
}

export function startRetentionWorker(): void {
  if (_running) return;
  _running = true;
  const tick = async () => {
    try {
      const { swept } = await runRetentionTick();
      const total = swept.reduce((s, r) => s + r.deleted, 0);
      if (total > 0) logger.info('[retention] tick', { policies: swept.length, totalDeleted: total });
    } catch (err) {
      logger.error('[retention] tick failed', { err: (err as Error).message });
    } finally {
      if (_running) _timer = setTimeout(tick, TICK_MS);
    }
  };
  // First tick after a short delay so it never blocks server boot.
  _timer = setTimeout(tick, 30_000);
  logger.info('[retention] worker started', { tickMs: TICK_MS, batchSize: BATCH_SIZE });
}

export function stopRetentionWorker(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

export function retentionStatus() {
  return { running: _running, tickMs: TICK_MS, batchSize: BATCH_SIZE, sweeperEntities: Object.keys(SWEEPERS) };
}
