/**
 * tests/backup-restore-drill.integration.test.ts
 *
 * Cyber Defense, Step 10 — a real backup and a real restore drill against a
 * real PostgreSQL, with the real pg_dump, pg_restore and psql.
 *
 * A backup that has never been restored is a hope, not a backup. This test
 * migrates and seeds a source database, takes an encrypted, signed backup of
 * it, restores that into a fresh database and checks the data came back —
 * and that the drill refuses the source itself and a non-empty target.
 *
 * Runs when BACKUP_DRILL_DATABASE_URL names a server the test may create and
 * drop databases on (a superuser URL; the database in it is only used to
 * connect). CI runs it as its own step with BACKUP_DRILL_REQUIRED=1, so a
 * missing URL there fails rather than skipping.
 *
 *   BACKUP_DRILL_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx jest --runInBand tests/backup-restore-drill.integration.test.ts
 *
 * Client binaries come from PATH, or BACKUP_PG_DUMP / BACKUP_PG_RESTORE /
 * BACKUP_PSQL when set.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { generateBackupKeys } from '../src/security/backup/backup-crypto';
import { drillConfigFromEnv, pgConnection, runnerConfigFromEnv } from '../src/security/backup/backup-config';
import { psqlBackupDb, runBackup } from '../src/security/backup/backup-runner';
import { runRestoreDrill } from '../src/security/backup/restore-drill';
import { psqlQuery } from '../src/security/backup/pg-process';
import { prismaRunStore, recordDbFor } from '../src/security/backup/backup-run-store';
import { startBackupRun, statusOf } from '../src/security/backup/backup-trigger';

const ADMIN_URL = process.env.BACKUP_DRILL_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.BACKUP_DRILL_REQUIRED === '1') {
  throw new Error('BACKUP_DRILL_REQUIRED=1 but BACKUP_DRILL_DATABASE_URL is not set');
}
const suite = ADMIN_URL ? describe : describe.skip;

const PSQL = process.env.BACKUP_PSQL || 'psql';
const PG_DUMP = process.env.BACKUP_PG_DUMP || 'pg_dump';
const PG_RESTORE = process.env.BACKUP_PG_RESTORE || 'pg_restore';

function withDatabase(url: string, db: string): string {
  if (!url) return '';
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

suite('backup and restore drill against real PostgreSQL', () => {
  const tag = randomBytes(4).toString('hex');
  const srcDb = `fam_bk_src_${tag}`;
  const dstDb = `fam_bk_dst_${tag}`;
  const srcUrl = withDatabase(ADMIN_URL, srcDb);
  const dstUrl = withDatabase(ADMIN_URL, dstDb);
  const admin = ADMIN_URL ? pgConnection(ADMIN_URL, 'BACKUP_DRILL_DATABASE_URL') : null;
  const keys = generateBackupKeys();
  let work: string;
  let src: PrismaClient;
  let objectKey: string;

  const baseEnv = () => ({ BACKUP_STORE: 'file', BACKUP_FILE_DIR: path.join(work, 'store') });

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-drill-it-'));
    await psqlQuery(PSQL, admin!, `CREATE DATABASE "${srcDb}"`);
    await psqlQuery(PSQL, admin!, `CREATE DATABASE "${dstDb}"`);
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], {
      env: { ...process.env, DATABASE_URL: srcUrl, DIRECT_URL: srcUrl },
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed (exit ${migrate.status})`);
    src = new PrismaClient({ datasources: { db: { url: srcUrl } } });
    const club = await src.club.create({ data: { name: 'Drill FC', city: 'Drilltown' } });
    await src.user.create({
      data: { email: `drill-${tag}@example.invalid`, passwordHash: 'not-a-real-hash', firstName: 'Drill', lastName: 'Check', clubId: club.id },
    });
  }, 240_000);

  afterAll(async () => {
    await src?.$disconnect();
    if (admin) {
      for (const db of [srcDb, dstDb]) {
        await psqlQuery(PSQL, admin, `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined);
      }
    }
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('takes an encrypted, signed backup with the real pg_dump and records it', async () => {
    const cfg = runnerConfigFromEnv({
      ...baseEnv(),
      DATABASE_URL: srcUrl,
      BACKUP_ENCRYPTION_PUBLIC_KEY: keys.encryptionPublicKey,
      BACKUP_SIGNING_PRIVATE_KEY: keys.signingPrivateKey,
      BACKUP_PG_DUMP: PG_DUMP,
      BACKUP_PSQL: PSQL,
    });
    const res = await runBackup(cfg);
    objectKey = res.objectKey;
    expect(res.ok).toBe(true);
    expect(res.migrationHead).toMatch(/^\d{14}_/);
    const stored = fs.readFileSync(path.join(work, 'store', objectKey));
    expect(stored.subarray(0, 4).toString('ascii')).toBe('FBK1');
    // pg_dump's custom-format magic is in the plaintext and must not be in the file.
    expect(stored.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(stored.includes(Buffer.from('Drill FC'))).toBe(false);
    const records = await src.backupRecord.findMany();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'SCHEDULED', ok: true, sha256: res.ciphertextSha256, sizeBytes: BigInt(res.ciphertextBytes) });
    expect(records[0].finishedAt).toBeInstanceOf(Date);
    expect(Math.abs(records[0].finishedAt!.getTime() - Date.now())).toBeLessThan(60_000);
  }, 120_000);

  const drillEnv = (target: string) => ({
    ...baseEnv(),
    DRILL_CONFIRM_ISOLATED: 'yes',
    DRILL_DATABASE_URL: target,
    DATABASE_URL: srcUrl,
    BACKUP_ENCRYPTION_PRIVATE_KEY: keys.encryptionPrivateKey,
    BACKUP_SIGNING_PUBLIC_KEY: keys.signingPublicKey,
    BACKUP_PG_RESTORE: PG_RESTORE,
  });

  it('refuses to restore into the database it protects', async () => {
    await expect(runRestoreDrill(drillConfigFromEnv(drillEnv(srcUrl)), objectKey, { psqlBin: PSQL }))
      .rejects.toThrow(/production database/);
  });

  it('restores into a fresh database and proves the data came back', async () => {
    const report = await runRestoreDrill(drillConfigFromEnv(drillEnv(dstUrl)), objectKey, { psqlBin: PSQL });
    expect(report.ok).toBe(true);
    expect(report.restoredMigrationHead).toBe(report.migrationHead);
    expect(report.tables).toBeGreaterThan(50);
    expect(report.rowCounts).toMatchObject({ User: 1, Club: 1 });
    expect(report.rowCounts._prisma_migrations).toBeGreaterThan(0);
    const dst = pgConnection(dstUrl, 'target');
    expect(await psqlQuery(PSQL, dst, 'SELECT email FROM public."User"')).toEqual([`drill-${tag}@example.invalid`]);
  }, 120_000);

  it('refuses a second restore into the now non-empty database', async () => {
    await expect(runRestoreDrill(drillConfigFromEnv(drillEnv(dstUrl)), objectKey, { psqlBin: PSQL }))
      .rejects.toThrow(/not empty/);
  }, 60_000);

  it('stores a hostile value verbatim through psql variables, and executes none of it', async () => {
    const hostile = `x'); DROP TABLE "User"; -- :'notes' \\! echo`;
    const conn = pgConnection(srcUrl, 'source');
    await psqlBackupDb(PSQL, conn, conn).record({ ok: false, startedAt: new Date(), finishedAt: new Date(), notes: hostile });
    const row = await src.backupRecord.findFirst({ where: { ok: false } });
    expect(row?.notes).toBe(hostile);
    expect(await src.user.count()).toBe(1);
  }, 60_000);

  // ── the scheduled trigger's path: advisory lock, 12 hours, run state ─────
  const triggerCfg = () => runnerConfigFromEnv({
    ...baseEnv(),
    DATABASE_URL: srcUrl,
    BACKUP_ENCRYPTION_PUBLIC_KEY: keys.encryptionPublicKey,
    BACKUP_SIGNING_PRIVATE_KEY: keys.signingPrivateKey,
    BACKUP_PG_DUMP: PG_DUMP,
    BACKUP_PSQL: PSQL,
  });

  it('refuses a scheduled run within 12 hours of the successful backup above', async () => {
    const res = await startBackupRun({ store: prismaRunStore(src), run: async () => { throw new Error('must not run'); } });
    expect(res.kind).toBe('recent');
  }, 60_000);

  it('runs one backup at a time under a real advisory lock, and records its state', async () => {
    await src.backupRecord.deleteMany({});
    const cfg = triggerCfg();
    let finished!: Promise<unknown>;
    const run = (id: string) => { finished = runBackup(cfg, { db: recordDbFor(src, id) }); return finished; };
    const [a, b] = await Promise.all([
      startBackupRun({ store: prismaRunStore(src), run }),
      startBackupRun({ store: prismaRunStore(src), run, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['running', 'started']);
    const started = [a, b].find((x) => x.kind === 'started') as { id: string };
    expect([a, b].find((x) => x.kind === 'running')).toEqual({ kind: 'running', id: started.id });

    const during = await prismaRunStore(src).find(started.id);
    expect(statusOf(during!, new Date()).state).toBe('running');

    await finished;
    // The lock is released when the holding transaction ends.
    await new Promise((r) => setTimeout(r, 200));
    const rows = await src.backupRecord.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: started.id, kind: 'SCHEDULED', ok: true });
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statusOf((await prismaRunStore(src).find(started.id))!, new Date()).state).toBe('succeeded');

    const [held] = await src.$queryRawUnsafe<Array<{ n: bigint }>>(
      "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 1178749745");
    expect(Number(held.n)).toBe(0);
    expect((await startBackupRun({ store: prismaRunStore(src), run: async () => undefined })).kind).toBe('recent');
  }, 180_000);
});
