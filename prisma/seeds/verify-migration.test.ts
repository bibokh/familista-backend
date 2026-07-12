/* verify-migration.test.ts — end-to-end pipeline harness (in-memory, no DB).
 *
 * Exercises the REAL importSquad() and verifyMigration() logic against a faithful
 * in-memory Prisma mock that implements the exact query shapes both use, then
 * prints the migration verification report with genuine counts.
 *
 * This proves the pipeline (import → sessions → attendance → stats → report)
 * end-to-end at the code level. It is NOT a production run — no production
 * database access was available. Run against a real DB with:
 *   npx ts-node prisma/seeds/verify-migration.ts --club "FC Familista"
 *
 * Run this harness: npx ts-node prisma/seeds/verify-migration.test.ts
 */
import { importSquad } from './import-squad';
import { verifyMigration, formatReport, VerifyDb } from './verify-migration';

let fails = 0;
function chk(name: string, cond: boolean) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) fails++; }

// In-memory store faithful to the query surface importSquad + verifyMigration use.
function mockDb() {
  const players: any[] = [];              // { id, legacyId, number, clubId, isCaptain, isViceCaptain, ... }
  const sessions: any[] = [];             // { id, clubId, status, bestPlayerId, playerStats:[{playerId,rating,participation}] }
  const attendance: any[] = [];           // { clubId, trainingSessionId, playerId, mark }
  let pseq = 0, sseq = 0;
  const byLegacy = () => new Map(players.filter((p) => p.legacyId != null).map((p) => [p.legacyId, p]));

  const db: any = {
    _players: players, _sessions: sessions, _attendance: attendance,
    club: {
      findFirst:  async () => ({ id: 'club-1', name: 'FC Familista', createdAt: new Date() }),
      findUnique: async ({ where }: any) => ({ id: where.id, name: 'FC Familista' }),
    },
    player: {
      findUnique: async ({ where }: any) => byLegacy().get(where.legacyId) || null,
      findMany:   async ({ where }: any) =>
        players.filter((p) => !where?.clubId || p.clubId === where.clubId),
      upsert: async ({ where, create, update }: any) => {
        const ex = byLegacy().get(where.legacyId);
        if (ex) { Object.assign(ex, update); return ex; }
        const row = { id: 'pl-uuid-' + (++pseq), ...create }; players.push(row); return row;
      },
      count: async ({ where }: any) =>
        players.filter((p) => (!where?.clubId || p.clubId === where.clubId) &&
          (!where?.legacyId?.in || where.legacyId.in.includes(p.legacyId))).length,
      deleteMany: async ({ where }: any) => {
        let n = 0;
        for (let i = players.length - 1; i >= 0; i--) {
          if (where.legacyId.in.includes(players[i].legacyId)) { players.splice(i, 1); n++; }
        }
        return { count: n };
      },
    },
    trainingSession: {
      count:    async ({ where }: any) => sessions.filter((s) => s.clubId === where.clubId).length,
      findMany: async ({ where }: any) => sessions.filter((s) => s.clubId === where.clubId),
    },
    playerTrainingStat: {
      count: async ({ where }: any) => {
        const clubId = where?.session?.clubId;
        return sessions.filter((s) => !clubId || s.clubId === clubId)
          .reduce((n, s) => n + (s.playerStats?.length || 0), 0);
      },
    },
    trainingAttendanceRecord: {
      count: async ({ where }: any) => attendance.filter((a) => a.clubId === where.clubId).length,
    },
  };
  return db;
}

(async () => {
  const db = mockDb();

  // 1) Import the real Squad (16 players → real backend UUIDs).
  const imp = await importSquad(db as any, {});
  chk('import: 16 players created, 0 duplicated', imp.created === 16 && imp.updated === 0);

  const clubId = 'club-1';
  const pids = db._players.map((p: any) => p.id);

  // 2) Create training sessions with playerStats keyed to real Player UUIDs
  //    (mirrors createCleanSession → playerStats.create). 4 sessions, 2 completed.
  function makeSession(i: number, playerIds: string[], completed: boolean) {
    return {
      id: 'ts-' + i, clubId, status: completed ? 'completed' : 'planned',
      bestPlayerId: completed ? playerIds[0] : null,
      sessionRating: completed ? 8 : null,
      playerStats: playerIds.map((pid, k) => ({
        playerId: pid,
        rating: completed ? 7 + (k % 3) : null,
        participation: completed ? (k % 4 === 0 ? 'partial' : 'full') : null,
      })),
    };
  }
  db._sessions.push(makeSession(1, pids.slice(0, 16), true));
  db._sessions.push(makeSession(2, pids.slice(0, 14), true));
  db._sessions.push(makeSession(3, pids.slice(0, 16), false));
  db._sessions.push(makeSession(4, pids.slice(2, 12), false));

  // 3) Attendance records per real player for the two completed sessions.
  const marks = ['PRESENT', 'PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'INJURED'];
  [1, 2].forEach((sid) => {
    pids.forEach((pid: string, k: number) => {
      db._attendance.push({ clubId, trainingSessionId: 'ts-' + sid, playerId: pid, mark: marks[k % marks.length] });
    });
  });

  // 4) Run the REAL verification logic and print the report.
  const report = await verifyMigration(db as VerifyDb, { club: 'FC Familista' });
  console.log('\n' + formatReport(report) + '\n');

  const expectedStats = db._sessions.reduce((n: number, s: any) => n + s.playerStats.length, 0);
  chk('imported players = 16',            report.importedPlayers === 16);
  chk('duplicated players = 0',           report.duplicatedPlayers === 0);
  chk('migrated sessions = 4',            report.migratedSessions === 4);
  chk('attendance records = 32',          report.attendanceRecords === 32);
  chk('PlayerTrainingStat records match', report.playerTrainingStats === expectedStats && expectedStats === 56);
  chk('orphan references = 0',            report.orphanReferences === 0);
  chk('all modules share Player UUIDs',   report.sameUuidAcrossModules === true);
  chk('overall result OK',                report.ok === true);

  // 5) Negative control: an orphan reference must be detected.
  db._sessions.push({ id: 'ts-x', clubId, status: 'completed', bestPlayerId: 'not-a-real-uuid', playerStats: [{ playerId: 'ghost-uuid', rating: 9 }] });
  const bad = await verifyMigration(db as VerifyDb, { club: 'FC Familista' });
  chk('orphan detection works (2 orphans, not OK)', bad.orphanReferences === 2 && bad.ok === false && bad.sameUuidAcrossModules === false);

  console.log(fails === 0 ? '\nALL VERIFY-MIGRATION HARNESS TESTS PASSED' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
