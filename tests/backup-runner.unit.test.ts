/**
 * tests/backup-runner.unit.test.ts
 *
 * Cyber Defense, Step 10 — the backup run, the restore drill and the command
 * line, end to end against stand-in pg_dump / pg_restore / psql binaries.
 *
 * The run must leave only ciphertext behind, sign what it wrote, record the
 * outcome (including a failure), and clean up. The drill must check the
 * signature, the hash, the key and the target before a single byte is
 * restored, and must refuse production and any non-empty database. The
 * command line must never print key material.
 *
 * The same path runs against a real PostgreSQL in
 * tests/backup-restore-drill.integration.test.ts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  HEADER_LENGTH, MAGIC, createDecryptStream, generateBackupKeys, importEncryptionPrivateKey, importSigningPrivateKey,
  importSigningPublicKey, signManifest, verifyManifest,
} from '../src/security/backup/backup-crypto';
import { drillConfigFromEnv, runnerConfigFromEnv } from '../src/security/backup/backup-config';
import { fileStore, BackupStore } from '../src/security/backup/backup-store';
import { BackupDb, BackupRecordRow, objectKeyFor, psqlBackupDb, runBackup } from '../src/security/backup/backup-runner';
import { pgConnection } from '../src/security/backup/backup-config';
import { runRestoreDrill } from '../src/security/backup/restore-drill';
import { main } from '../src/scripts/backup';

const keys = generateBackupKeys();
const PW = ['s3', 'cr', 'Et', 'Pw9'].join('');
const PROD_URL = `postgresql://fam_user:${PW}@db.internal:5432/familista`;
const DRILL_URL = 'postgresql://drill@localhost:5433/familista_drill';
const HEAD = '20260901000000_head';

let work: string;
let bin: string;
let storeDir: string;
let dump: Buffer;

function script(name: string, body: string): string {
  const p = path.join(bin, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return p;
}

function fakeDb(opts: { failRecord?: boolean } = {}) {
  const records: BackupRecordRow[] = [];
  const db: BackupDb = {
    migrationHead: jest.fn(async () => HEAD),
    record: jest.fn(async (row: BackupRecordRow) => {
      if (opts.failRecord) throw new Error('db down');
      records.push(row);
    }),
  };
  return { db, records };
}

const runnerEnv = (extra: Record<string, string> = {}) => ({
  DATABASE_URL: PROD_URL,
  BACKUP_ENCRYPTION_PUBLIC_KEY: keys.encryptionPublicKey,
  BACKUP_SIGNING_PRIVATE_KEY: keys.signingPrivateKey,
  BACKUP_STORE: 'file',
  BACKUP_FILE_DIR: storeDir,
  BACKUP_PG_DUMP: path.join(bin, 'pg_dump'),
  ...extra,
});

const drillEnv = (extra: Record<string, string> = {}) => ({
  DRILL_CONFIRM_ISOLATED: 'yes',
  DRILL_DATABASE_URL: DRILL_URL,
  DATABASE_URL: PROD_URL,
  BACKUP_ENCRYPTION_PRIVATE_KEY: keys.encryptionPrivateKey,
  BACKUP_SIGNING_PUBLIC_KEY: keys.signingPublicKey,
  BACKUP_STORE: 'file',
  BACKUP_FILE_DIR: storeDir,
  BACKUP_PG_RESTORE: path.join(bin, 'pg_restore'),
  ...extra,
});

const tmpLeftovers = (prefix: string) => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix));

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-runner-test-'));
  bin = path.join(work, 'bin');
  storeDir = path.join(work, 'store');
  fs.mkdirSync(bin);
  dump = Buffer.concat([Buffer.from('PGDMP'), randomBytes(150_000)]);
  fs.writeFileSync(path.join(work, 'dump.bin'), dump);
  // pg_dump: emits the fixture, records its argv and whether a password reached it.
  script('pg_dump', `printf '%s\\n' "$@" > '${work}/pg_dump.argv'\n[ -n "$PGPASSWORD" ] && echo set > '${work}/pg_dump.pw'\ncat '${work}/dump.bin'`);
  // pg_restore: consumes stdin into restored.bin, then the target "has tables".
  script('pg_restore', `printf '%s\\n' "$@" > '${work}/pg_restore.argv'\ncat > '${work}/restored.bin'\necho 7 > '${work}/tables'`);
  // psql: answers the drill's fixed queries from the state above.
  script('psql', `for a; do sql="$a"; done
case "$sql" in
  *"NOT IN ('pg_catalog'"*) if [ -f '${work}/tables' ]; then cat '${work}/tables'; else echo 0; fi ;;
  *max\\(migration_name\\)*) if [ -f '${work}/head' ]; then cat '${work}/head'; else echo '${HEAD}'; fi ;;
  *"tablename ="*) echo 1 ;;
  *'FROM public."'*) echo 3 ;;
  *) echo "unexpected query" >&2; exit 3 ;;
esac`);
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

async function decryptFile(p: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  await pipeline(fs.createReadStream(p), createDecryptStream(importEncryptionPrivateKey(keys.encryptionPrivateKey)),
    new Writable({ write(c, _e, cb) { parts.push(Buffer.from(c)); cb(); } }));
  return Buffer.concat(parts);
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const psql = () => path.join(bin, 'psql');

describe('backup run', () => {
  it('names objects by date, uniquely', () => {
    const d = new Date('2026-09-29T03:04:05.678Z');
    expect(objectKeyFor(d)).toMatch(/^2026\/09\/29\/familista-20260929T030405Z-[0-9a-f]{8}\.fbk$/);
    expect(objectKeyFor(d)).not.toBe(objectKeyFor(d));
  });

  it('stores only authenticated ciphertext and a signed manifest, and records the backup', async () => {
    const before = tmpLeftovers('fam-backup-');
    const { db, records } = fakeDb();
    const res = await runBackup(runnerConfigFromEnv(runnerEnv()), { db, now: () => new Date('2026-09-29T03:00:00Z') });

    const stored = path.join(storeDir, res.objectKey);
    const cipher = fs.readFileSync(stored);
    expect(cipher.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(cipher.includes(dump.subarray(0, 64))).toBe(false);
    expect(fs.statSync(stored).mode & 0o777).toBe(0o600);
    expect((await decryptFile(stored)).equals(dump)).toBe(true);

    const manifest = verifyManifest(fs.readFileSync(`${stored}.manifest.json`, 'utf8'), importSigningPublicKey(keys.signingPublicKey));
    expect(manifest).toMatchObject({
      objectKey: res.objectKey, ciphertextSha256: sha(cipher), ciphertextBytes: cipher.length,
      plaintextSha256: sha(dump), plaintextBytes: dump.length, migrationHead: HEAD, createdAt: '2026-09-29T03:00:00.000Z',
    });
    expect(res).toMatchObject({ ok: true, ciphertextSha256: sha(cipher), ciphertextBytes: cipher.length, migrationHead: HEAD });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: true, sha256: sha(cipher), sizeBytes: cipher.length, ref: `file://${stored}` });
    expect(String(records[0].notes)).not.toContain(PW);

    // pg_dump gets the custom format, no owner/ACL, the database by name — and its password only via the environment.
    expect(fs.readFileSync(path.join(work, 'pg_dump.argv'), 'utf8').trim().split('\n'))
      .toEqual(['--format=custom', '--no-owner', '--no-acl', '--compress=6', '--dbname=familista']);
    expect(fs.existsSync(path.join(work, 'pg_dump.pw'))).toBe(true);
    // Nothing is left in the temporary directory.
    expect(tmpLeftovers('fam-backup-')).toEqual(before);
  });

  it('records a failure, scrubbed, stores nothing, and cleans up when pg_dump fails', async () => {
    script('pg_dump', `echo "FATAL: password authentication failed for fam_user@db.internal ($PGPASSWORD) ${PROD_URL}" >&2\nexit 1`);
    const before = tmpLeftovers('fam-backup-');
    const { db, records } = fakeDb();
    const err = await runBackup(runnerConfigFromEnv(runnerEnv()), { db }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/pg_dump failed \(exit 1\)/);
    expect(err?.message).not.toContain(PW);
    expect(err?.message).not.toContain('db.internal');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: false });
    expect(String(records[0].notes)).not.toContain(PW);
    expect(fs.existsSync(storeDir)).toBe(false);
    expect(tmpLeftovers('fam-backup-')).toEqual(before);
  });

  it('refuses an empty dump', async () => {
    script('pg_dump', 'exit 0');
    const { db, records } = fakeDb();
    await expect(runBackup(runnerConfigFromEnv(runnerEnv()), { db })).rejects.toThrow(/no output/);
    expect(records[0]).toMatchObject({ ok: false });
  });

  it('fails (non-zero) when the upload fails, and records that', async () => {
    const store: BackupStore = { describe: (k) => k, putFile: async () => { throw new Error('bucket refused'); }, getToFile: async () => undefined };
    const { db, records } = fakeDb();
    await expect(runBackup(runnerConfigFromEnv(runnerEnv()), { db, store })).rejects.toThrow(/bucket refused/);
    expect(records[0]).toMatchObject({ ok: false });
  });

  it('still reports the failure when the database cannot record it', async () => {
    script('pg_dump', 'exit 1');
    const { db } = fakeDb({ failRecord: true });
    await expect(runBackup(runnerConfigFromEnv(runnerEnv()), { db })).rejects.toThrow(/pg_dump failed/);
  });

  it('uploads the backup before the manifest, so a manifest never points at nothing', async () => {
    const order: string[] = [];
    const inner = fileStore(storeDir);
    const store: BackupStore = { ...inner, putFile: async (k, p, t) => { order.push(k); return inner.putFile(k, p, t); } };
    const { db } = fakeDb();
    const res = await runBackup(runnerConfigFromEnv(runnerEnv()), { db, store });
    expect(order).toEqual([res.objectKey, `${res.objectKey}.manifest.json`]);
  });
  it('writes the record through psql with every value as a psql variable, never spliced into the SQL', async () => {
    script('psql', `printf '%s\\n' "$@" > '${work}/psql.argv'\ncat > '${work}/psql.stdin'`);
    const hostile = "x'); DROP TABLE \"User\"; --";
    const conn = pgConnection(PROD_URL, 'X');
    await psqlBackupDb(psql(), conn, conn).record({
      ok: false, startedAt: new Date('2026-09-29T03:00:00Z'), finishedAt: new Date('2026-09-29T03:01:00Z'), notes: hostile,
    });
    const sql = fs.readFileSync(path.join(work, 'psql.stdin'), 'utf8');
    const argv = fs.readFileSync(path.join(work, 'psql.argv'), 'utf8').split('\n');
    expect(sql).toMatch(/INSERT INTO "BackupRecord"/);
    expect(sql).toContain(":'notes'");
    expect(sql).not.toContain('DROP TABLE');
    expect(argv).toContain(`notes=${hostile}`);
    expect(argv).toContain('ok=false');
    expect(argv).toContain('ON_ERROR_STOP=1');
    expect(argv.join(' ')).not.toContain(PW);
  });

  it('the command-line run needs no application secret and no Prisma client', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'backup.ts'), 'utf8')
      + fs.readFileSync(path.join(__dirname, '..', 'src', 'security', 'backup', 'backup-runner.ts'), 'utf8');
    expect(src).not.toMatch(/@prisma\/client|config\/database|from '\.\.\/config'/);
  });
});

describe('restore drill', () => {
  async function backup(): Promise<string> {
    const { db } = fakeDb();
    return (await runBackup(runnerConfigFromEnv(runnerEnv()), { db })).objectKey;
  }

  it('restores a verified backup into an empty isolated database and proves it', async () => {
    const key = await backup();
    const before = tmpLeftovers('fam-drill-');
    const report = await runRestoreDrill(drillConfigFromEnv(drillEnv()), key, { psqlBin: psql() });
    expect(report).toMatchObject({ ok: true, objectKey: key, migrationHead: HEAD, restoredMigrationHead: HEAD, tables: 7 });
    expect(report.rowCounts).toEqual({ User: 3, Club: 3, Team: 3, Player: 3, Membership: 3, _prisma_migrations: 3 });
    expect(fs.readFileSync(path.join(work, 'restored.bin')).equals(dump)).toBe(true);
    expect(fs.readFileSync(path.join(work, 'pg_restore.argv'), 'utf8').trim().split('\n'))
      .toEqual(['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname=familista_drill']);
    expect(tmpLeftovers('fam-drill-')).toEqual(before);
  });

  const restored = () => fs.existsSync(path.join(work, 'restored.bin'));

  it.each(['DATABASE_URL', 'DIRECT_URL', 'BACKUP_DATABASE_URL'])('refuses a target that is the production database (%s) before fetching anything', async (name) => {
    const store: BackupStore = { describe: (k) => k, putFile: jest.fn(), getToFile: jest.fn() };
    const prodLike = 'postgresql://someone:else@DB.internal:5432/familista';
    const env = drillEnv({ DATABASE_URL: '', [name]: PROD_URL, DRILL_DATABASE_URL: prodLike });
    await expect(runRestoreDrill(drillConfigFromEnv(env), '2026/09/29/x.fbk', { store, psqlBin: psql() }))
      .rejects.toThrow(/production database/);
    expect(store.getToFile).not.toHaveBeenCalled();
  });

  it('refuses a target that is not empty', async () => {
    const key = await backup();
    fs.writeFileSync(path.join(work, 'tables'), '4\n');
    await expect(runRestoreDrill(drillConfigFromEnv(drillEnv()), key, { psqlBin: psql() })).rejects.toThrow(/not empty/);
    expect(restored()).toBe(false);
  });

  it('refuses a backup whose bytes do not match the signed manifest', async () => {
    const key = await backup();
    const p = path.join(storeDir, key);
    fs.chmodSync(p, 0o600);
    const b = fs.readFileSync(p); b[HEADER_LENGTH + 10] ^= 1; fs.writeFileSync(p, b);
    await expect(runRestoreDrill(drillConfigFromEnv(drillEnv()), key, { psqlBin: psql() })).rejects.toThrow(/does not match its signed manifest/);
    expect(restored()).toBe(false);
  });

  it('refuses a backup and manifest both replaced by someone without the signing key', async () => {
    const key = await backup();
    const m = JSON.parse(fs.readFileSync(path.join(storeDir, `${key}.manifest.json`), 'utf8'));
    const other = generateBackupKeys();
    const forged = signManifest(m.manifest, importSigningPrivateKey(other.signingPrivateKey));
    fs.writeFileSync(path.join(storeDir, `${key}.manifest.json`), JSON.stringify(forged));
    await expect(runRestoreDrill(drillConfigFromEnv(drillEnv()), key, { psqlBin: psql() })).rejects.toThrow(/signature is invalid/);
    expect(restored()).toBe(false);
  });

  it('refuses a genuine manifest moved onto another object', async () => {
    const a = await backup();
    const b = await backup();
    fs.copyFileSync(path.join(storeDir, `${a}.manifest.json`), path.join(storeDir, `${b}.manifest.json`));
    await expect(runRestoreDrill(drillConfigFromEnv(drillEnv()), b, { psqlBin: psql() })).rejects.toThrow(/different backup/);
    expect(restored()).toBe(false);
  });

  it('refuses the wrong decryption key before restoring anything', async () => {
    const key = await backup();
    const other = generateBackupKeys();
    const env = drillEnv({ BACKUP_ENCRYPTION_PRIVATE_KEY: other.encryptionPrivateKey });
    await expect(runRestoreDrill(drillConfigFromEnv(env), key, { psqlBin: psql() })).rejects.toThrow(/different key/);
    expect(restored()).toBe(false);
  });

  it('refuses a restore whose schema head does not match the manifest', async () => {
    const key = await backup();
    fs.writeFileSync(path.join(work, 'head'), '20200101000000_old\n');
    await expect(runRestoreDrill(drillConfigFromEnv(drillEnv()), key, { psqlBin: psql() })).rejects.toThrow(/schema head/);
  });

  it('fails when pg_restore fails, without leaking the connection', async () => {
    const key = await backup();
    script('pg_restore', `cat > /dev/null\necho "error connecting to $PGHOST as $PGUSER" >&2\nexit 1`);
    const err = await runRestoreDrill(drillConfigFromEnv(drillEnv()), key, { psqlBin: psql() }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/pg_restore failed/);
    expect(err?.message).not.toContain('localhost');
  });

  it.each(['../x.fbk', 'x.sql', '/abs/x.fbk', 'a b.fbk'])('refuses the object key %p', async (key) => {
    await expect(runRestoreDrill(drillConfigFromEnv(drillEnv()), key, { psqlBin: psql() })).rejects.toThrow(/not a backup/);
  });
});

describe('command line', () => {
  let printed: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    printed = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { printed.push(String(s)); return true; });
  });
  afterEach(() => spy.mockRestore());
  const last = () => JSON.parse(printed[printed.length - 1]);

  it('keygen writes two 0600 files into an empty directory and prints no key', async () => {
    const dir = path.join(work, 'keys');
    expect(await main(['keygen', dir], {})).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(['offline-restore.env', 'runner.env']);
    for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    const runner = fs.readFileSync(path.join(dir, 'runner.env'), 'utf8');
    const offline = fs.readFileSync(path.join(dir, 'offline-restore.env'), 'utf8');
    expect(runner).toMatch(/^BACKUP_ENCRYPTION_PUBLIC_KEY=\S+\nBACKUP_SIGNING_PRIVATE_KEY=\S+\n$/);
    expect(offline).toMatch(/^BACKUP_ENCRYPTION_PRIVATE_KEY=\S+\nBACKUP_SIGNING_PUBLIC_KEY=\S+\n$/);
    // The runner file never carries the decryption key.
    expect(runner).not.toContain('BACKUP_ENCRYPTION_PRIVATE_KEY');
    const values = [...runner.split('\n'), ...offline.split('\n')].filter(Boolean).map((l) => l.split('=').slice(1).join('='));
    for (const v of values) expect(printed.join('')).not.toContain(v);
    expect(last()).toEqual({ ok: true, wrote: ['runner.env', 'offline-restore.env'], dir });
  });

  it('keygen refuses a directory that already holds files', async () => {
    const dir = path.join(work, 'keys');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'runner.env'), 'existing');
    expect(await main(['keygen', dir], {})).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'runner.env'), 'utf8')).toBe('existing');
    expect(last()).toMatchObject({ ok: false, error: expect.stringMatching(/non-empty/) });
  });

  it('run refuses, exit 1, where the decryption key is present, and does not print it', async () => {
    const env = { ...runnerEnv(), BACKUP_ENCRYPTION_PRIVATE_KEY: keys.encryptionPrivateKey };
    expect(await main(['run'], env)).toBe(1);
    expect(printed.join('')).not.toContain(keys.encryptionPrivateKey);
    expect(last().error).toMatch(/must not be present/);
  });

  it('drill refuses, exit 1, in production', async () => {
    expect(await main(['drill', 'x.fbk'], { ...drillEnv(), NODE_ENV: 'production' })).toBe(1);
    expect(last().error).toMatch(/production/);
  });

  it('an unknown command or a missing argument exits 1 with usage', async () => {
    expect(await main([], {})).toBe(1);
    expect(await main(['drill'], {})).toBe(1);
    expect(await main(['keygen'], {})).toBe(1);
    expect(last().error).toMatch(/usage/);
  });
});
