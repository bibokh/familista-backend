/**
 * Cyber Defense, R14 — row-level security pilot, proven on real PostgreSQL
 *
 * The application connects as the owner of its tables, so the test does too:
 * a fresh LOGIN role that is NOT a superuser and does NOT bypass RLS (a
 * superuser skips every policy and would prove nothing). It owns a freshly
 * migrated database, seeds two clubs, and then asks:
 *
 *   enforcement off (as shipped)   everything behaves exactly as before
 *   enforcement on                 no context and wrong context see nothing
 *                                  and change nothing; a club sees its own;
 *                                  the named system path sees everything;
 *                                  the transfer market can still read players
 *   the application's client       carries the context per query, inside
 *                                  interactive and batch transactions
 *   backup and restore             the real pg_dump / pg_restore, under
 *                                  enforcement, keep every club's rows
 *
 * Runs when RLS_DB_DATABASE_URL names a server where the test may create a
 * role and a database (a superuser URL). CI sets RLS_DB_REQUIRED=1:
 *
 *   RLS_DB_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx jest --runInBand tests/rls-pilot.integration.test.ts
 */

import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';

import { runAsSystem, runInClubContext } from '../src/security/db-context';
import { withRlsContext } from '../src/security/rls-client';
import { pgDumpArgs } from '../src/security/backup/backup-runner';
import { pgConnection, pgEnv } from '../src/security/backup/backup-config';

const ADMIN_URL = process.env.RLS_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.RLS_DB_REQUIRED === '1') {
  throw new Error('RLS_DB_REQUIRED=1 but RLS_DB_DATABASE_URL is not set');
}
const suite = ADMIN_URL ? describe : describe.skip;
const PG_DUMP = process.env.BACKUP_PG_DUMP || 'pg_dump';
const PG_RESTORE = process.env.BACKUP_PG_RESTORE || 'pg_restore';

const tag = randomBytes(4).toString('hex');
const ROLE = `fam_rls_owner_${tag}`;
const PASSWORD = `pw_${randomBytes(12).toString('hex')}`;
const DB = `fam_rls_${tag}`;
const RESTORED = `fam_rls_restored_${tag}`;

function urlFor(database: string, user?: string, password?: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = password ?? ''; }
  return u.toString();
}

type Tx = Prisma.TransactionClient;
const CLUB_A = `club-a-${tag}`;
const CLUB_B = `club-b-${tag}`;
const CLUB_C = `club-c-${tag}`;
const ids = {
  userA: `user-a-${tag}`, userB: `user-b-${tag}`, userA2: `user-a2-${tag}`, userB2: `user-b2-${tag}`,
  playerA: `player-a-${tag}`, playerB: `player-b-${tag}`, playerC: `player-c-${tag}`,
  injuryA: `injury-a-${tag}`, injuryB: `injury-b-${tag}`,
  videoA: `video-a-${tag}`, videoB: `video-b-${tag}`, videoNone: `video-none-${tag}`,
};
const refused = /row-level security|violates row-level/i;

// The club-private tables (20261005100000_rls_club_private_tables): each one
// row per club, written with SQL on its migrated columns only (as VideoAsset
// is, for the same drift reason). `cols` and `vals` are the NOT NULL columns
// beyond "id" and "clubId"; :club and :player stand for the row's club and a
// player of that club, :user for a user of it.
type PrivateTable = { table: string; model: string; cols: string; vals: string };
const PRIVATE_TABLES: PrivateTable[] = [
  { table: 'BiochemicalSignal', model: 'biochemicalSignal', cols: '"kind", "value", "monotonicMs"', vals: "'LACTATE', 4.2, 1000" },
  { table: 'HydrationEstimate', model: 'hydrationEstimate', cols: '"playerId", "monotonicMs"', vals: ':player, 1000' },
  { table: 'StressIndex', model: 'stressIndex', cols: '"playerId", "monotonicMs"', vals: ':player, 1000' },
  { table: 'NeuromuscularLoad', model: 'neuromuscularLoad', cols: '"playerId", "monotonicMs"', vals: ':player, 1000' },
  { table: 'TendonRiskEstimate', model: 'tendonRiskEstimate', cols: '"playerId", "monotonicMs"', vals: ':player, 1000' },
  { table: 'PlayerGuardianLink', model: 'playerGuardianLink', cols: '"playerId", "guardianUserId", "relationship"', vals: ":player, :user, 'PARENT'" },
  { table: 'PlayerContractRecord', model: 'playerContractRecord', cols: '"playerId", "startsAt", "updatedAt"', vals: ':player, now(), now()' },
  { table: 'PlayerEvaluationRecord', model: 'playerEvaluationRecord', cols: '"playerId", "kind", "payload"', vals: ":player, 'TECHNICAL', '{}'::jsonb" },
  { table: 'PlayerOnboardingStep', model: 'playerOnboardingStep', cols: '"playerId", "step", "updatedAt"', vals: ":player, 'MEDICAL', now()" },
  { table: 'TrainingAttendanceRecord', model: 'trainingAttendanceRecord', cols: '"trainingSessionId", "playerId"', vals: ":id, :player" },
  { table: 'MatchAttendanceRecord', model: 'matchAttendanceRecord', cols: '"matchId", "playerId"', vals: ":id, :player" },
  { table: 'OperationsPayment', model: 'operationsPayment', cols: '"amountCents", "category", "updatedAt"', vals: "1500, 'MEMBERSHIP', now()" },
  { table: 'ClubCalendarEntry', model: 'clubCalendarEntry', cols: '"title", "startsAt", "updatedAt"', vals: "'Training', now(), now()" },
  { table: 'StaffClubNote', model: 'staffClubNote', cols: '"staffUserId", "body"', vals: ":user, 'private note'" },
];
const privateId = (t: PrivateTable, club: 'a' | 'b' | 'x') => `${t.table.toLowerCase()}-${club}-${tag}`;

suite('row-level security pilot on real PostgreSQL', () => {
  let admin: PrismaClient;
  let owner: PrismaClient;

  /** Run `fn` in one transaction with the database context PostgreSQL reads. */
  const as = <T>(mode: string, clubId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', ${mode}, true), set_config('familista.club_id', ${clubId}, true)`;
      return fn(tx);
    });
  // familista_rls_enforced() is IMMUTABLE, so PostgreSQL folds its answer into
  // the plan of every prepared statement: a pooled connection that planned a
  // query before the switch keeps the old answer for that query. Flipping it
  // therefore takes fresh connections — here a reconnect, in production the
  // restart of the deploy that carries the migration (docs/security/row-level-security.md).
  const setEnforced = async (on: boolean) => {
    await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION familista_rls_enforced() RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ${on} $$`);
    await owner.$disconnect();
  };

  const player = (id: string, clubId: string, n: number) => ({
    id, clubId, firstName: 'Test', lastName: id, number: n, position: 'GK' as const,
    nationality: 'XX', flag: 'xx', dateOfBirth: new Date('2004-01-01'), height: 180, weight: 75,
  });
  // VideoAsset rows are written with SQL on its migrated columns only: the
  // Prisma model carries columns no migration creates (the pre-existing
  // schema/migration drift, out of scope here), so a full-row Prisma write
  // fails on a database built from migrations. The policies read "clubId",
  // which every migration has.
  const insertVideo = (db: PrismaClient | Tx, id: string, clubId: string | null) =>
    db.$executeRaw`INSERT INTO "VideoAsset" ("id", "source", "format", "url", "clubId", "updatedAt")
      VALUES (${id}, 'UPLOAD', 'MP4', ${`https://videos.test.invalid/${id}.mp4`}, ${clubId}, now())`;

  /**
   * One club-private row for `clubId`, as plain SQL on its migrated columns.
   * A second row in the same club (`another`) names a different player and
   * user, so the tables' unique keys are not what refuses it.
   */
  const insertPrivate = (db: PrismaClient | Tx, t: PrivateTable, id: string, clubId: string, another = false) => {
    const [playerId, userId] = clubId === CLUB_A
      ? [another ? `p-${id}` : ids.playerA, another ? ids.userA2 : ids.userA]
      : [another ? `p-${id}` : ids.playerB, another ? ids.userB2 : ids.userB];
    const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
    const vals = t.vals.replace(/:player/g, lit(playerId)).replace(/:user/g, lit(userId)).replace(/:id/g, lit(`ref-${id}`));
    return db.$executeRawUnsafe(`INSERT INTO "${t.table}" ("id", "clubId", ${t.cols}) VALUES (${lit(id)}, ${lit(clubId)}, ${vals})`);
  };
  const countPrivate = (db: PrismaClient | Tx, t: PrivateTable) =>
    db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${t.table}"`).then((r) => r[0].n);
  const idsPrivate = (db: PrismaClient | Tx, t: PrivateTable) =>
    db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "${t.table}" ORDER BY "id"`).then((r) => r.map((x) => x.id));

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.$executeRawUnsafe(`CREATE ROLE "${ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD '${PASSWORD}'`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB}" OWNER "${ROLE}"`);
    const url = urlFor(DB, ROLE, PASSWORD);
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', timeout: 180_000,
    });
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed (exit ${migrate.status}): ${migrate.stderr}`);
    owner = new PrismaClient({ datasources: { db: { url } } });

    // Seeded with enforcement off — exactly as the migration ships.
    for (const [id, name] of [[CLUB_A, 'A'], [CLUB_B, 'B'], [CLUB_C, 'C']]) {
      await owner.club.create({ data: { id, name: `RLS ${name}`, city: 'Test' } });
    }
    for (const [id, clubId] of [[ids.userA, CLUB_A], [ids.userB, CLUB_B], [ids.userA2, CLUB_A], [ids.userB2, CLUB_B]]) {
      await owner.user.create({ data: { id, clubId, email: `${id}@test.invalid`, passwordHash: 'x', firstName: 'T', lastName: id } });
    }
    await owner.player.create({ data: player(ids.playerA, CLUB_A, 1) });
    await owner.player.create({ data: player(ids.playerB, CLUB_B, 2) });
    await owner.player.create({ data: player(ids.playerC, CLUB_C, 3) });
    await owner.playerInjury.create({ data: { id: ids.injuryA, playerId: ids.playerA, bodyPart: 'knee', injuryType: 'sprain', severity: 'MINOR' } });
    await owner.playerInjury.create({ data: { id: ids.injuryB, playerId: ids.playerB, bodyPart: 'ankle', injuryType: 'sprain', severity: 'MODERATE' } });
    await insertVideo(owner, ids.videoA, CLUB_A);
    await insertVideo(owner, ids.videoB, CLUB_B);
    await insertVideo(owner, ids.videoNone, null);
    await owner.membership.create({ data: { userId: ids.userA, clubId: CLUB_A, role: 'CLUB_ADMIN' } });
    await owner.membership.create({ data: { userId: ids.userB, clubId: CLUB_B, role: 'CLUB_ADMIN' } });
    for (const t of PRIVATE_TABLES) {
      await insertPrivate(owner, t, privateId(t, 'a'), CLUB_A);
      await insertPrivate(owner, t, privateId(t, 'b'), CLUB_B);
    }
  }, 240_000);

  afterAll(async () => {
    await owner?.$disconnect();
    for (const d of [DB, RESTORED]) await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await admin?.$disconnect();
  });

  it('runs as a role PostgreSQL holds to its policies, on tables forced under RLS', async () => {
    const [me] = await owner.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(me).toEqual({ rolsuper: false, rolbypassrls: false });
    const tables = await owner.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('Player', 'Membership', 'PlayerInjury', 'VideoAsset') ORDER BY relname`;
    expect(tables).toEqual(['Membership', 'Player', 'PlayerInjury', 'VideoAsset'].map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
  });

  it('every club-private table is forced under RLS with exactly one fail-closed club policy', async () => {
    const names = PRIVATE_TABLES.map((t) => t.table);
    const rows = await owner.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relkind = 'r' AND relname = ANY(${names}) ORDER BY relname`;
    expect(rows).toEqual([...names].sort().map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
    const policies = await owner.$queryRaw<Array<{ tablename: string; policyname: string; cmd: string; permissive: string; qual: string; with_check: string }>>`
      SELECT tablename, policyname, cmd, permissive, qual, with_check FROM pg_policies WHERE tablename = ANY(${names}) ORDER BY tablename`;
    expect(policies.map((p) => p.tablename)).toEqual([...names].sort());
    for (const p of policies) {
      expect(p).toMatchObject({ policyname: `${p.tablename}_club_isolation`, cmd: 'ALL', permissive: 'PERMISSIVE' });
      expect(p.qual).toBe('familista_rls_club_ok("clubId")');
      expect(p.with_check).toBe('familista_rls_club_ok("clubId")');
    }
  });

  describe('as shipped: enforcement off', () => {
    it('changes nothing — no context still sees and writes every club, as before', async () => {
      expect(await owner.playerInjury.count()).toBe(2);
      expect(await owner.videoAsset.count()).toBe(3);
      expect((await owner.player.updateMany({ where: { id: ids.playerB }, data: { height: 181 } })).count).toBe(1);
    });

    it('changes nothing on the club-private tables either: no context sees both clubs', async () => {
      for (const t of PRIVATE_TABLES) expect([t.table, await countPrivate(owner, t)]).toEqual([t.table, 2]);
    });
  });

  describe('enforcement on', () => {
    beforeAll(() => setEnforced(true));
    afterAll(() => setEnforced(false));

    it('no context: no medical record, no video, and no write — fail closed', async () => {
      expect(await owner.playerInjury.count()).toBe(0);
      expect(await owner.videoAsset.count()).toBe(0);
      expect((await owner.player.updateMany({ where: {}, data: { height: 182 } })).count).toBe(0);
      expect((await owner.membership.deleteMany({})).count).toBe(0);
      await expect(owner.player.create({ data: player(`p-none-${tag}`, CLUB_A, 9) })).rejects.toThrow(refused);
    });

    it('an unknown mode, or club mode without a club, is no context', async () => {
      for (const [mode, club] of [['admin', CLUB_A], ['club', ''], ['', CLUB_A]]) {
        expect(await as(mode, club, (tx) => tx.playerInjury.count())).toBe(0);
        expect(await as(mode, club, (tx) => tx.videoAsset.count())).toBe(0);
      }
    });

    it('a club sees its own medical records and videos, and no other club\'s', async () => {
      const injuries = await as('club', CLUB_A, (tx) => tx.playerInjury.findMany({ select: { id: true } }));
      expect(injuries.map((r) => r.id)).toEqual([ids.injuryA]);
      const videos = await as('club', CLUB_A, (tx) => tx.videoAsset.findMany({ select: { id: true } }));
      expect(videos.map((r) => r.id)).toEqual([ids.videoA]);
      expect(await as('club', CLUB_A, (tx) => tx.playerInjury.findUnique({ where: { id: ids.injuryB } }))).toBeNull();
      expect(await as('club', CLUB_A, (tx) => tx.videoAsset.count({ where: { id: { in: [ids.videoB, ids.videoNone] } } }))).toBe(0);
    });

    it('a club cannot write another club\'s rows, or write a row into another club', async () => {
      expect(await as('club', CLUB_A, (tx) => tx.player.updateMany({ where: { id: ids.playerB }, data: { height: 182 } }).then((r) => r.count))).toBe(0);
      expect(await as('club', CLUB_A, (tx) => tx.membership.deleteMany({ where: { clubId: CLUB_B } }).then((r) => r.count))).toBe(0);
      expect(await as('club', CLUB_A, (tx) => tx.videoAsset.deleteMany({}).then((r) => r.count))).toBe(1); // its own only
      await expect(as('club', CLUB_A, (tx) => tx.playerInjury.create({ data: { playerId: ids.playerB, bodyPart: 'x', injuryType: 'x', severity: 'MINOR' } }))).rejects.toThrow(refused);
      await expect(as('club', CLUB_A, (tx) => insertVideo(tx, `v-x-${tag}`, CLUB_B))).rejects.toThrow(refused);
      await expect(as('club', CLUB_A, (tx) => tx.player.update({ where: { id: ids.playerA }, data: { clubId: CLUB_B } }))).rejects.toThrow(refused);
      await expect(as('club', CLUB_A, (tx) => tx.membership.create({ data: { userId: ids.userA, clubId: CLUB_B, role: 'HEAD_COACH' } }))).rejects.toThrow(refused);
      // ...and its own writes work.
      expect(await as('club', CLUB_A, (tx) => tx.player.updateMany({ where: { id: ids.playerA }, data: { height: 183 } }).then((r) => r.count))).toBe(1);
      expect(await as('club', CLUB_A, (tx) => insertVideo(tx, ids.videoA, CLUB_A))).toBe(1);
    });

    it('players and memberships stay readable across clubs: the transfer and staff markets depend on it', async () => {
      expect(await as('club', CLUB_A, (tx) => tx.player.count({ where: { id: { in: [ids.playerA, ids.playerB, ids.playerC] } } }))).toBe(3);
      expect(await as('club', CLUB_A, (tx) => tx.membership.count({ where: { clubId: { in: [CLUB_A, CLUB_B] } } }))).toBe(2);
    });

    it('the named system path sees every club, including an asset with no club', async () => {
      expect(await as('system', '', (tx) => tx.playerInjury.count())).toBe(2);
      expect(await as('system', '', (tx) => tx.videoAsset.count())).toBe(3);
    });

    it('deleting a club still cascades through the protected tables', async () => {
      await owner.club.delete({ where: { id: CLUB_C } });
      expect(await as('system', '', (tx) => tx.player.count({ where: { id: ids.playerC } }))).toBe(0);
    });

    describe.each(PRIVATE_TABLES)('club-private table $table', (t) => {
      const sameClub = (sql: string) => as('club', CLUB_A, (tx) => tx.$executeRawUnsafe(sql));

      it('same club: reads its own row, and only its own', async () => {
        expect(await as('club', CLUB_A, (tx) => idsPrivate(tx, t))).toEqual([privateId(t, 'a')]);
        expect(await as('club', CLUB_B, (tx) => idsPrivate(tx, t))).toEqual([privateId(t, 'b')]);
      });

      it('same club: writes its own rows', async () => {
        const id = `${privateId(t, 'a')}-new`;
        expect(await as('club', CLUB_A, (tx) => insertPrivate(tx, t, id, CLUB_A, true))).toBe(1);
        expect(await sameClub(`UPDATE "${t.table}" SET "id" = "id" WHERE "id" = '${id}'`)).toBe(1);
        expect(await sameClub(`DELETE FROM "${t.table}" WHERE "id" = '${id}'`)).toBe(1);
      });

      it('cross club: another club\'s row cannot be read, even by its id', async () => {
        const rows = await as('club', CLUB_A, (tx) => tx.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${t.table}" WHERE "id" = '${privateId(t, 'b')}'`));
        expect(rows).toHaveLength(0);
      });

      it('cross club: another club\'s row cannot be changed, deleted, or moved into', async () => {
        expect(await sameClub(`UPDATE "${t.table}" SET "id" = "id" WHERE "id" = '${privateId(t, 'b')}'`)).toBe(0);
        expect(await sameClub(`DELETE FROM "${t.table}" WHERE "id" = '${privateId(t, 'b')}'`)).toBe(0);
        await expect(as('club', CLUB_A, (tx) => insertPrivate(tx, t, privateId(t, 'x'), CLUB_B))).rejects.toThrow(refused);
        await expect(sameClub(`UPDATE "${t.table}" SET "clubId" = '${CLUB_B}' WHERE "id" = '${privateId(t, 'a')}'`)).rejects.toThrow(refused);
        expect(await as('system', '', (tx) => countPrivate(tx, t))).toBe(2);
      });

      it('missing context: no rows, no writes — fail closed', async () => {
        expect(await countPrivate(owner, t)).toBe(0);
        expect(await owner.$executeRawUnsafe(`DELETE FROM "${t.table}"`)).toBe(0);
        await expect(insertPrivate(owner, t, privateId(t, 'x'), CLUB_A)).rejects.toThrow(refused);
      });

      it('invalid context: an unknown mode, club mode with no or an unknown club, a club without a mode', async () => {
        for (const [mode, club] of [['admin', CLUB_A], ['SYSTEM', ''], ['club', ''], ['club', `no-such-club-${tag}`], ['', CLUB_A]]) {
          expect([mode, club, await as(mode, club, (tx) => countPrivate(tx, t))]).toEqual([mode, club, 0]);
          expect(await as(mode, club, (tx) => tx.$executeRawUnsafe(`DELETE FROM "${t.table}"`))).toBe(0);
          await expect(as(mode, club, (tx) => insertPrivate(tx, t, privateId(t, 'x'), CLUB_A))).rejects.toThrow(refused);
        }
      });

      it('the explicit system path sees and writes every club', async () => {
        expect(await as('system', '', (tx) => idsPrivate(tx, t))).toEqual([privateId(t, 'a'), privateId(t, 'b')].sort());
        const id = `${privateId(t, 'b')}-sys`;
        expect(await as('system', '', (tx) => insertPrivate(tx, t, id, CLUB_B, true))).toBe(1);
        expect(await as('system', '', (tx) => tx.$executeRawUnsafe(`DELETE FROM "${t.table}" WHERE "id" = '${id}'`))).toBe(1);
      });

      it('through the application\'s client: the request\'s club, the named system path, and nothing without a context', async () => {
        const missing = jest.fn();
        const app = withRlsContext(owner, 'on', missing);
        const model = (app as unknown as Record<string, { count: () => Promise<number> }>)[t.model];
        expect(await runInClubContext(CLUB_A, ids.userA, async () => await model.count())).toBe(1);
        expect(await runAsSystem('rls-integration-test', async () => await model.count())).toBe(2);
        expect(await model.count()).toBe(0);
        expect(missing).toHaveBeenCalledWith(t.table, 'count');
      });
    });

    describe('the application\'s client', () => {
      const missing = jest.fn();
      let app: PrismaClient;
      beforeAll(() => { app = withRlsContext(owner, 'on', missing); });

      it('carries a request\'s club to the database for each query', async () => {
        const rows = await runInClubContext(CLUB_A, ids.userA, async () => await app.playerInjury.findMany({ select: { id: true } }));
        expect(rows.map((r) => r.id)).toEqual([ids.injuryA]);
        expect(await runInClubContext(CLUB_B, ids.userB, async () => await app.videoAsset.count())).toBe(1);
      });

      it('a query runs under the context it is awaited in (Prisma queries are lazy)', async () => {
        // Built inside, awaited outside: it runs outside, so it gets nothing.
        const lazy = runInClubContext(CLUB_A, ids.userA, () => app.playerInjury.count());
        expect(await lazy).toBe(0);
      });

      it('with no context it gets nothing, and reports the path', async () => {
        expect(await app.playerInjury.count()).toBe(0);
        expect(missing).toHaveBeenCalledWith('PlayerInjury', 'count');
      });

      it('the system path is explicit and named', async () => {
        expect(await runAsSystem('rls-integration-test', async () => await app.playerInjury.count())).toBe(2);
        expect(() => runAsSystem('', () => 0)).toThrow(/literal reason/);
      });

      it('inside an interactive transaction the context is the transaction\'s', async () => {
        const out = await runInClubContext(CLUB_A, ids.userA, () => app.$transaction(async (tx) => ({
          injuries: await tx.playerInjury.count(), videos: await tx.videoAsset.count(), players: await tx.player.count({ where: { id: { in: [ids.playerA, ids.playerB] } } }),
        })));
        expect(out).toEqual({ injuries: 1, videos: 1, players: 2 });
      });

      it('in a batch transaction too, and the results line up with the queries', async () => {
        const out = await runInClubContext(CLUB_B, ids.userB, () => app.$transaction([app.playerInjury.count(), app.videoAsset.count()]));
        expect(out).toEqual([1, 1]);
      });

      it('a cross-club write through the application is refused by the database', async () => {
        await expect(runInClubContext(CLUB_A, ids.userA, async () => await app.player.update({ where: { id: ids.playerB }, data: { lastName: 'moved' } })))
          .rejects.toThrow();
        expect((await runAsSystem('rls-integration-test', async () => await app.player.findUnique({ where: { id: ids.playerB }, select: { lastName: true } })))?.lastName).toBe(ids.playerB);
      });

      it('settings do not leak to the next query on a pooled connection', async () => {
        await runInClubContext(CLUB_A, ids.userA, async () => await app.playerInjury.count());
        const [row] = await owner.$queryRaw<Array<{ mode: string | null }>>`SELECT current_setting('familista.rls_mode', true) AS mode`;
        expect(row.mode ?? '').toBe('');
      });
    });

    it('a backup under enforcement keeps every club\'s rows, and restores them', async () => {
      const src = pgConnection(urlFor(DB, ROLE, PASSWORD), 'RLS_DB');
      const dumpFile = `${require('os').tmpdir()}/fam-rls-${tag}.dump`;
      const dump = spawnSync(PG_DUMP, [...pgDumpArgs(src.database), `--file=${dumpFile}`], { env: pgEnv(src), encoding: 'utf8' });
      expect(dump.stderr).toBe('');
      expect(dump.status).toBe(0);
      // Without --enable-row-security pg_dump refuses these tables outright.
      const plain = spawnSync(PG_DUMP, ['--format=custom', `--dbname=${src.database}`, '--file=/dev/null'], { env: pgEnv(src), encoding: 'utf8' });
      expect(plain.status).not.toBe(0);

      await admin.$executeRawUnsafe(`CREATE DATABASE "${RESTORED}" OWNER "${ROLE}"`);
      const target = pgConnection(urlFor(RESTORED, ROLE, PASSWORD), 'RLS_RESTORED');
      const restore = spawnSync(PG_RESTORE, ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${target.database}`, dumpFile], { env: pgEnv(target), encoding: 'utf8' });
      expect(restore.stderr).toBe('');
      expect(restore.status).toBe(0);
      const restored = new PrismaClient({ datasources: { db: { url: urlFor(RESTORED, ROLE, PASSWORD) } } });
      try {
        const counts = await restored.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
          return { injuries: await tx.playerInjury.count(), videos: await tx.videoAsset.count() };
        });
        expect(counts).toEqual({ injuries: 2, videos: 3 });
        // The restored database carries the policies and is still enforced.
        expect(await restored.playerInjury.count()).toBe(0);
      } finally {
        await restored.$disconnect();
        require('fs').rmSync(dumpFile, { force: true });
      }
    });
  });
});
