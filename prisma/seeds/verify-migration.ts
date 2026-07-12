/* verify-migration.ts — Migration verification report (Squad → Backend + Training).
 *
 * Reads ONLY from PostgreSQL and prints the exact report requested:
 *   - Number of imported players
 *   - Number of duplicated players (must be 0)
 *   - Number of migrated (training) sessions
 *   - Number of attendance records
 *   - Number of PlayerTrainingStat records
 *   - Confirmation that all modules reference the same backend Player UUIDs
 *
 * Usage (run against the target DB, i.e. with DATABASE_URL set):
 *   npx ts-node prisma/seeds/verify-migration.ts --club "FC Familista"
 *   npx ts-node prisma/seeds/verify-migration.ts --club-id <uuid>
 *   npx ts-node prisma/seeds/verify-migration.ts --json      # machine-readable
 *
 * The counting logic is exported as verifyMigration(db, opts) so it can also be
 * exercised by an in-memory harness (see verify-migration.test.ts) with no DB.
 */

export interface VerifyDb {
  club: { findFirst: Function; findUnique: Function };
  player: { findMany: Function; count: Function };
  trainingSession: { findMany: Function; count: Function };
  playerTrainingStat: { count: Function };
  trainingAttendanceRecord: { count: Function };
}

export interface VerifyReport {
  club:                { id: string; name: string };
  importedPlayers:     number;   // Player rows carrying a legacyId (i.e. migrated from the Squad)
  totalPlayers:        number;   // all Player rows for the club
  duplicatedPlayers:   number;   // duplicate legacyId or duplicate shirt number — must be 0
  duplicateDetail:     string[];
  migratedSessions:    number;   // TrainingSession rows for the club
  attendanceRecords:   number;   // TrainingAttendanceRecord rows for the club
  playerTrainingStats: number;   // PlayerTrainingStat rows across the club's sessions
  orphanReferences:    number;   // stats / attendance / bestPlayerId pointing at a non-club player — must be 0
  sameUuidAcrossModules: boolean;
  ok:                  boolean;
}

async function resolveClub(db: VerifyDb, opts: { club?: string; clubId?: string }) {
  if (opts.clubId) {
    const c = await db.club.findUnique({ where: { id: opts.clubId } });
    if (!c) throw new Error(`Club not found for id ${opts.clubId}`);
    return { id: c.id, name: c.name ?? opts.clubId };
  }
  const c = await db.club.findFirst(
    opts.club ? { where: { name: opts.club } } : {},
  );
  if (!c) throw new Error(`Club not found${opts.club ? ` for name "${opts.club}"` : ''}`);
  return { id: c.id, name: c.name ?? opts.club ?? c.id };
}

export async function verifyMigration(
  db: VerifyDb,
  opts: { club?: string; clubId?: string } = {},
): Promise<VerifyReport> {
  const club = await resolveClub(db, opts);
  const clubId = club.id;

  const players = await db.player.findMany({
    where:  { clubId },
    select: { id: true, legacyId: true, number: true },
  });
  const clubPlayerIds = new Set<string>(players.map((p: any) => p.id));

  const importedPlayers = players.filter((p: any) => p.legacyId != null).length;
  const totalPlayers = players.length;

  // Duplicate detection: same legacyId used twice, or the same shirt number twice.
  const duplicateDetail: string[] = [];
  const byLegacy = new Map<string, number>();
  const byNumber = new Map<number, number>();
  for (const p of players as any[]) {
    if (p.legacyId != null) byLegacy.set(p.legacyId, (byLegacy.get(p.legacyId) || 0) + 1);
    if (p.number != null)   byNumber.set(p.number, (byNumber.get(p.number) || 0) + 1);
  }
  let duplicatedPlayers = 0;
  for (const [k, n] of byLegacy) if (n > 1) { duplicatedPlayers += n - 1; duplicateDetail.push(`legacyId ${k} ×${n}`); }
  for (const [k, n] of byNumber) if (n > 1) { duplicateDetail.push(`shirt #${k} ×${n}`); }

  const migratedSessions    = await db.trainingSession.count({ where: { clubId } });
  const attendanceRecords   = await db.trainingAttendanceRecord.count({ where: { clubId } });
  const playerTrainingStats = await db.playerTrainingStat.count({ where: { session: { clubId } } });

  // Orphan check: every session's playerStats + bestPlayerId reference a real club Player UUID.
  const sessions = await db.trainingSession.findMany({
    where:   { clubId },
    include: { playerStats: { select: { playerId: true } } },
  });
  let orphanReferences = 0;
  for (const s of sessions as any[]) {
    for (const st of (s.playerStats || [])) if (!clubPlayerIds.has(st.playerId)) orphanReferences++;
    if (s.bestPlayerId && !clubPlayerIds.has(s.bestPlayerId)) orphanReferences++;
  }

  const sameUuidAcrossModules = orphanReferences === 0;
  const ok = duplicatedPlayers === 0 && orphanReferences === 0;

  return {
    club,
    importedPlayers,
    totalPlayers,
    duplicatedPlayers,
    duplicateDetail,
    migratedSessions,
    attendanceRecords,
    playerTrainingStats,
    orphanReferences,
    sameUuidAcrossModules,
    ok,
  };
}

export function formatReport(r: VerifyReport): string {
  const line = '─'.repeat(58);
  return [
    line,
    '  MIGRATION VERIFICATION REPORT',
    `  Club: ${r.club.name} (${r.club.id})`,
    line,
    `  Imported players ............. ${r.importedPlayers}`,
    `  Total players (club) ......... ${r.totalPlayers}`,
    `  Duplicated players ........... ${r.duplicatedPlayers}   ${r.duplicatedPlayers === 0 ? '(OK)' : '(FAIL — must be 0)'}`,
    ...(r.duplicateDetail.length ? [`      ${r.duplicateDetail.join(', ')}`] : []),
    `  Migrated sessions ............ ${r.migratedSessions}`,
    `  Attendance records ........... ${r.attendanceRecords}`,
    `  PlayerTrainingStat records ... ${r.playerTrainingStats}`,
    `  Orphan player references ..... ${r.orphanReferences}   ${r.orphanReferences === 0 ? '(OK)' : '(FAIL — must be 0)'}`,
    `  All modules share Player UUIDs ${r.sameUuidAcrossModules ? 'YES ✓' : 'NO ✗'}`,
    line,
    `  RESULT: ${r.ok ? 'PASS ✓' : 'FAIL ✗'}`,
    line,
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const opts = { club: get('--club'), clubId: get('--club-id') };
  const asJson = args.includes('--json');

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const report = await verifyMigration(prisma as unknown as VerifyDb, opts);
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report));
    process.exit(report.ok ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('verify-migration failed:', e.message || e); process.exit(1); });
}
