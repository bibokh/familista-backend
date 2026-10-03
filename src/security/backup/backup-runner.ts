// Cyber Defense, Step 10 — take one encrypted, signed, off-site backup
// ─────────────────────────────────────────────────────────────────────────────
//   pg_dump (custom format) ─► SHA-256 ─► FBK1 encryption ─► SHA-256 ─► temp file
//   ─► upload backup ─► sign + upload manifest ─► BackupRecord
//
// Plaintext never touches the disk: it exists only in the pipe between
// pg_dump and the cipher. The temporary file holds ciphertext, sits in a
// 0700 directory with mode 0600, and is removed whatever happens. A run that
// fails for any reason exits non-zero and records a failed BackupRecord
// (best effort) so a missing backup is visible, not silent.
//
// The database is reached only through the PostgreSQL client tools, never
// through the application: the backup job needs a database URL and its backup
// keys, and none of the application's own secrets.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, createPublicKey, randomBytes, randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import { createEncryptStream, keyId, signManifest, BackupManifest } from './backup-crypto';
import { pgConnection, PgConnection, RunnerConfig } from './backup-config';
import { BackupStore, storeFor } from './backup-store';
import { lowestPriority, psqlQuery, psqlScript, requirePgDump, scrub, spawnPg } from './pg-process';

export interface BackupResult {
  ok: true;
  objectKey: string;
  location: string;
  ciphertextSha256: string;
  ciphertextBytes: number;
  encryptionKeyId: string;
  migrationHead: string | null;
}

function tap(): { stream: PassThrough; digest: () => { sha256: string; bytes: number } } {
  const h = createHash('sha256');
  let bytes = 0;
  const stream = new PassThrough();
  stream.on('data', (d: Buffer) => { h.update(d); bytes += d.length; });
  return { stream, digest: () => ({ sha256: h.digest('hex'), bytes }) };
}

export function objectKeyFor(now: Date): string {
  const iso = now.toISOString();
  const [y, m, d] = [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)];
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${y}/${m}/${d}/familista-${stamp}-${randomBytes(4).toString('hex')}.fbk`;
}

/** One row of BackupRecord, as the run writes it. */
export interface BackupRecordRow {
  ok: boolean;
  startedAt: Date;
  finishedAt: Date;
  ref?: string;
  sizeBytes?: number;
  sha256?: string;
  notes: string;
}

/**
 * pg_dump's arguments. --enable-row-security: without it pg_dump refuses a
 * table under forced row-level security (R14); with it, the dump reads under
 * the system context pgEnv sets, so every club's rows are in it.
 */
export function pgDumpArgs(database: string): string[] {
  return ['--format=custom', '--no-owner', '--no-acl', '--compress=1', '--enable-row-security', `--dbname=${database}`];
}

/** What the run needs from the database besides pg_dump. */
export interface BackupDb {
  migrationHead(): Promise<string | null>;
  record(row: BackupRecordRow): Promise<void>;
}

const INSERT_RECORD = `SET TIME ZONE 'UTC';
INSERT INTO "BackupRecord" ("id", "kind", "ref", "sizeBytes", "sha256", "notes", "startedAt", "finishedAt", "ok")
VALUES (:'id', 'SCHEDULED', NULLIF(:'ref', ''), NULLIF(:'size_bytes', '')::bigint, NULLIF(:'sha256', ''), :'notes',
        :'started_at'::timestamptz AT TIME ZONE 'UTC', :'finished_at'::timestamptz AT TIME ZONE 'UTC', :'ok'::boolean);
`;

/** BackupDb over psql: the schema head from the dumped database, the record into the application's. */
export function psqlBackupDb(psqlBin: string, dumped: PgConnection, records: PgConnection): BackupDb {
  return {
    async migrationHead() {
      try {
        const [name] = await psqlQuery(psqlBin, dumped,
          'SELECT coalesce(max(migration_name), \'\') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
        return name || null;
      } catch { return null; }
    },
    async record(row) {
      await psqlScript(psqlBin, records, INSERT_RECORD, {
        id: randomUUID(),
        ref: row.ref ?? '',
        size_bytes: row.sizeBytes === undefined ? '' : String(row.sizeBytes),
        sha256: row.sha256 ?? '',
        notes: row.notes,
        started_at: row.startedAt.toISOString(),
        finished_at: row.finishedAt.toISOString(),
        ok: row.ok ? 'true' : 'false',
      });
    },
  };
}

export async function runBackup(cfg: RunnerConfig, deps: { db?: BackupDb; store?: BackupStore; now?: () => Date } = {}): Promise<BackupResult> {
  const conn = pgConnection(cfg.databaseUrl, 'BACKUP_DATABASE_URL');
  const recordConn = pgConnection(cfg.recordUrl, 'DATABASE_URL');
  const db = deps.db ?? psqlBackupDb(cfg.psqlBin, conn, recordConn);
  const store = deps.store ?? storeFor(cfg.store);
  const startedAt = (deps.now ?? (() => new Date()))();
  const objectKey = objectKeyFor(startedAt);
  const encryptionKeyId = keyId(cfg.encryptionPublicKey);
  const signingKeyId = keyId(createPublicKey(cfg.signingPrivateKey));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-backup-'));
  fs.chmodSync(work, 0o700);
  const cipherPath = path.join(work, 'backup.fbk');
  const manifestPath = path.join(work, 'backup.manifest.json');

  try {
    // A pg_dump older than the server fails part-way; refuse before starting.
    await requirePgDump(cfg.pgDumpBin);
    const head = await db.migrationHead();
    // Compression 1: the web service may be the host, and its CPU belongs to
    // requests. The ciphertext does not compress further, so a higher level
    // buys little but time.
    const dump = spawnPg(cfg.pgDumpBin, pgDumpArgs(conn.database), conn);
    lowestPriority(dump.child);
    const plain = tap();
    const cipher = tap();
    await Promise.all([
      pipeline(dump.child.stdout!, plain.stream, createEncryptStream(cfg.encryptionPublicKey), cipher.stream,
        fs.createWriteStream(cipherPath, { mode: 0o600 })),
      dump.done,
    ]);
    const p = plain.digest();
    const c = cipher.digest();
    if (p.bytes === 0) throw new Error('pg_dump produced no output');

    const manifest: BackupManifest = {
      format: 'FBK1',
      createdAt: startedAt.toISOString(),
      objectKey,
      ciphertextSha256: c.sha256,
      ciphertextBytes: c.bytes,
      plaintextSha256: p.sha256,
      plaintextBytes: p.bytes,
      encryptionKeyId,
      signingKeyId,
      dumpFormat: 'pg_dump-custom',
      migrationHead: head,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(signManifest(manifest, cfg.signingPrivateKey), null, 2), { mode: 0o600 });

    // Backup first, manifest last: a manifest only ever points at an object that exists.
    await store.putFile(objectKey, cipherPath, 'application/octet-stream');
    await store.putFile(`${objectKey}.manifest.json`, manifestPath, 'application/json');

    await db.record({
      ok: true,
      ref: store.describe(objectKey),
      sizeBytes: c.bytes,
      sha256: c.sha256,
      startedAt,
      finishedAt: new Date(),
      notes: JSON.stringify({ format: 'FBK1', encryptionKeyId, signingKeyId, manifest: `${objectKey}.manifest.json`, migrationHead: head }),
    });
    return { ok: true, objectKey, location: store.describe(objectKey), ciphertextSha256: c.sha256, ciphertextBytes: c.bytes, encryptionKeyId, migrationHead: head };
  } catch (err) {
    const message = scrub(scrub((err as Error)?.message ?? String(err), conn), recordConn);
    try {
      await db.record({ ok: false, startedAt, finishedAt: new Date(), notes: JSON.stringify({ format: 'FBK1', error: message }) });
    } catch { /* the database may be what failed; the non-zero exit still reports it */ }
    throw new Error(message);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
