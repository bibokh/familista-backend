// src/admin/admin.service.ts
// Phase 12 — Admin Control Center
// Pure database queries; no mocks. All queries are club-scoped (tenant-safe).

import { prisma } from '../config/database';

// ── Data Quality ──────────────────────────────────────────────────────────────
// Completeness score = 5 fields × 20 pts each:
//   email | contractUntil | avatar | GPS device linked | has any match stat

export async function getDataQuality(clubId: string) {
  const players = await prisma.player.findMany({
    where: { clubId, isActive: true },
    select: {
      id:           true,
      firstName:    true,
      lastName:     true,
      position:     true,
      medicalStatus: true,
      email:        true,
      contractUntil: true,
      avatar:       true,
      device: { select: { id: true, isOnline: true } },
      // Phase 2 match stats (legacy)
      matchStats: { select: { id: true }, take: 1 },
      // Phase Q match stats
      playerMatchStats: { select: { id: true }, take: 1 },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });

  const rows = players.map(p => {
    let score = 0;
    const missing: Record<string, boolean> = {};

    if (p.email)         { score += 20; } else { missing.email = true; }
    if (p.contractUntil) { score += 20; } else { missing.contract = true; }
    if (p.avatar)        { score += 20; } else { missing.avatar = true; }
    if (p.device)        { score += 20; } else { missing.device = true; }

    const hasStats = p.matchStats.length > 0 || p.playerMatchStats.length > 0;
    if (hasStats) { score += 20; } else { missing.matchStats = true; }

    return {
      id:           p.id,
      name:         `${p.firstName} ${p.lastName}`,
      position:     p.position,
      medicalStatus: p.medicalStatus,
      score,
      missing,
      deviceOnline: p.device?.isOnline ?? false,
    };
  });

  const total = rows.length;
  const summary = {
    total,
    missingEmail:      rows.filter(r => r.missing['email']).length,
    missingContract:   rows.filter(r => r.missing['contract']).length,
    missingAvatar:     rows.filter(r => r.missing['avatar']).length,
    missingDevice:     rows.filter(r => r.missing['device']).length,
    missingMatchStats: rows.filter(r => r.missing['matchStats']).length,
    avgScore:          total > 0
      ? Math.round(rows.reduce((a, r) => a + r.score, 0) / total)
      : 0,
    belowThreshold:    rows.filter(r => r.score < 60).length,
  };

  return { rows, summary };
}

// ── System Health ─────────────────────────────────────────────────────────────

export async function getSystemHealth(clubId: string) {
  // DB liveness check
  const dbConnected: boolean = await (prisma.$queryRaw`SELECT 1` as Promise<unknown>)
    .then(() => true)
    .catch(() => false);

  const [gpsOnline, gpsTotal, lastDevice, playerCount, matchCount] = await Promise.all([
    prisma.gpsDevice.count({ where: { clubId, isOnline: true } }),
    prisma.gpsDevice.count({ where: { clubId } }),
    prisma.gpsDevice.findFirst({
      where:   { clubId, isOnline: true },
      orderBy: { lastSeenAt: 'desc' },
      select:  { lastSeenAt: true },
    }),
    prisma.player.count({ where: { clubId, isActive: true } }),
    prisma.match.count({ where: { clubId } }),
  ]);

  const mem = process.memoryUsage();

  return {
    db:      { connected: dbConnected },
    gps:     { online: gpsOnline, total: gpsTotal, lastSeenAt: lastDevice?.lastSeenAt ?? null },
    players: playerCount,
    matches: matchCount,
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb:      Math.round(mem.rss / 1024 / 1024),
      nodeVersion:   process.version,
      env:           process.env['NODE_ENV'] ?? 'development',
    },
    timestamp: new Date().toISOString(),
  };
}

// ── Audit Log ─────────────────────────────────────────────────────────────────

export async function getAuditLog(clubId: string, limit = 50) {
  const entries = await prisma.playerAuditLog.findMany({
    where:   { clubId },
    take:    Math.min(limit, 200),
    orderBy: { createdAt: 'desc' },
    select: {
      id:        true,
      action:    true,
      reason:    true,
      userId:    true,
      ipAddress: true,
      createdAt: true,
      player:    { select: { id: true, firstName: true, lastName: true } },
    },
  });
  return entries;
}
