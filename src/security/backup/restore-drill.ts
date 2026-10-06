// Cyber Defense, Step 10 — restore a backup into an isolated database and prove it
// ─────────────────────────────────────────────────────────────────────────────
// Order matters, and nothing reaches the target until every check passes:
//
//   1. fetch the manifest and the backup to a 0700 temp directory
//   2. verify the manifest's Ed25519 signature and that it names this object
//   3. verify the backup's SHA-256 and size against the signed manifest
//   4. refuse a target that is production, or that is not empty
//   5. decrypt (every chunk authenticated) straight into pg_restore, in one
//      transaction — a failure anywhere rolls the whole restore back
//   6. prove the restore: schema head, table count, core row counts
//
// It never writes to production and never records anything there: its
// output is a report for the operator.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, createPublicKey } from 'crypto';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import { createDecryptStream, keyId, verifyManifest, BackupCryptoError } from './backup-crypto';
import { DrillConfig, pgConnection, sameDatabase, BackupConfigError } from './backup-config';
import { BackupStore, storeFor } from './backup-store';
import { psqlQuery, scrub, spawnPg } from './pg-process';

export interface DrillReport {
  ok: true;
  objectKey: string;
  createdAt: string;
  migrationHead: string | null;
  restoredMigrationHead: string | null;
  tables: number;
  rowCounts: Record<string, number>;
  durationMs: number;
  /** What was proven, with the values it was proven against (hashes, sizes and key ids; never a key). */
  ciphertextSha256: string;
  ciphertextBytes: number;
  plaintextSha256: string;
  plaintextBytes: number;
  encryptionKeyId: string;
  signingKeyId: string;
}

const CORE_TABLES = ['User', 'Club', 'Team', 'Player', 'Membership', '_prisma_migrations'];

function sha256File(p: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let bytes = 0;
    fs.createReadStream(p).on('data', (d) => { h.update(d as Buffer); bytes += (d as Buffer).length; })
      .on('end', () => resolve({ sha256: h.digest('hex'), bytes })).on('error', reject);
  });
}

export async function runRestoreDrill(cfg: DrillConfig, objectKey: string,
  deps: { store?: BackupStore; psqlBin?: string } = {}): Promise<DrillReport> {
  const started = Date.now();
  if (!/^[A-Za-z0-9._\-/]+\.fbk$/.test(objectKey) || objectKey.includes('..') || objectKey.startsWith('/')) throw new BackupConfigError('object key is not a backup (.fbk) key');
  const target = pgConnection(cfg.targetUrl, 'DRILL_DATABASE_URL');
  for (const url of cfg.protectedUrls) {
    let prot;
    try { prot = pgConnection(url, 'protected database URL'); } catch { continue; }
    if (sameDatabase(prot, target)) throw new BackupConfigError('DRILL_DATABASE_URL is a production database; a drill only restores into an isolated one');
  }
  const store = deps.store ?? storeFor(cfg.store);
  const psqlBin = deps.psqlBin ?? cfg.psqlBin;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-drill-'));
  fs.chmodSync(work, 0o700);
  const cipherPath = path.join(work, 'backup.fbk');
  const manifestPath = path.join(work, 'backup.manifest.json');

  try {
    // 1–3: authenticity before anything else.
    await store.getToFile(`${objectKey}.manifest.json`, manifestPath);
    const manifest = verifyManifest(fs.readFileSync(manifestPath, 'utf8'), cfg.signingPublicKey);
    if (manifest.objectKey !== objectKey) throw new BackupCryptoError('manifest belongs to a different backup');
    if (manifest.encryptionKeyId !== keyId(createPublicKey(cfg.encryptionPrivateKey))) {
      throw new BackupCryptoError('backup was encrypted to a different key than the one provided');
    }
    await store.getToFile(objectKey, cipherPath);
    const got = await sha256File(cipherPath);
    if (got.sha256 !== manifest.ciphertextSha256 || got.bytes !== manifest.ciphertextBytes) {
      throw new BackupCryptoError('backup does not match its signed manifest');
    }

    // 4: the target must be empty — a drill never merges into existing data.
    const [tables] = await psqlQuery(psqlBin, target,
      "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')");
    if (Number(tables) !== 0) throw new BackupConfigError('DRILL_DATABASE_URL is not empty; a drill restores only into a fresh database');

    // 5: decrypt into pg_restore, one transaction.
    const restore = spawnPg(cfg.pgRestoreBin,
      ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${target.database}`], target, ['pipe', 'pipe', 'pipe']);
    restore.child.stdout?.resume();
    const h = createHash('sha256');
    let plainBytes = 0;
    const measure = new PassThrough();
    measure.on('data', (d: Buffer) => { h.update(d); plainBytes += d.length; });
    try {
      await Promise.all([
        pipeline(fs.createReadStream(cipherPath), createDecryptStream(cfg.encryptionPrivateKey), measure, restore.child.stdin!),
        restore.done,
      ]);
    } catch (e) {
      restore.child.kill('SIGTERM');
      throw e;
    }
    if (h.digest('hex') !== manifest.plaintextSha256 || plainBytes !== manifest.plaintextBytes) {
      throw new BackupCryptoError('decrypted backup does not match its signed manifest');
    }

    // 6: prove it.
    const [restoredHead] = await psqlQuery(psqlBin, target,
      'SELECT coalesce(max(migration_name), \'\') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
    const [tableCount] = await psqlQuery(psqlBin, target,
      "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')");
    const rowCounts: Record<string, number> = {};
    for (const t of CORE_TABLES) {
      const [exists] = await psqlQuery(psqlBin, target, `SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = '${t}'`);
      if (Number(exists) === 1) rowCounts[t] = Number((await psqlQuery(psqlBin, target, `SELECT count(*) FROM public."${t}"`))[0]);
    }
    const restoredMigrationHead = restoredHead || null;
    if (manifest.migrationHead && restoredMigrationHead !== manifest.migrationHead) {
      throw new Error('restored schema head does not match the backup manifest');
    }
    if (Number(tableCount) === 0) throw new Error('restore produced no tables');
    return {
      ok: true, objectKey, createdAt: manifest.createdAt, migrationHead: manifest.migrationHead,
      restoredMigrationHead, tables: Number(tableCount), rowCounts, durationMs: Date.now() - started,
      ciphertextSha256: manifest.ciphertextSha256, ciphertextBytes: manifest.ciphertextBytes,
      plaintextSha256: manifest.plaintextSha256, plaintextBytes: manifest.plaintextBytes,
      encryptionKeyId: manifest.encryptionKeyId, signingKeyId: keyId(cfg.signingPublicKey),
    };
  } catch (err) {
    if (err instanceof BackupCryptoError || err instanceof BackupConfigError) throw err;
    throw new Error(scrub((err as Error)?.message ?? String(err), target));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
