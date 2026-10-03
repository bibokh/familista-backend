// Cyber Defense, Step 10 — backup configuration, checked before anything runs
// ─────────────────────────────────────────────────────────────────────────────
// Fails closed: a missing or malformed key, bucket or credential stops the run
// with a message that names the setting and never its value. The runner also
// refuses to start if the DECRYPTION key is in its environment — a backup host
// that can read its own backups defeats the point of encrypting them.

import type { KeyObject } from 'crypto';
import {
  importEncryptionPrivateKey, importEncryptionPublicKey, importSigningPrivateKey, importSigningPublicKey,
} from './backup-crypto';

export class BackupConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupConfigError'; }
}

type Env = Record<string, string | undefined>;

export interface S3StoreConfig {
  kind: 's3';
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}
export interface FileStoreConfig { kind: 'file'; dir: string }
export type StoreConfig = S3StoreConfig | FileStoreConfig;

export interface RunnerConfig {
  /** The database pg_dump reads. */
  databaseUrl: string;
  /** The application database, where the BackupRecord is written. */
  recordUrl: string;
  encryptionPublicKey: KeyObject;
  signingPrivateKey: KeyObject;
  store: StoreConfig;
  pgDumpBin: string;
  psqlBin: string;
}

export interface DrillConfig {
  targetUrl: string;
  encryptionPrivateKey: KeyObject;
  signingPublicKey: KeyObject;
  store: StoreConfig;
  pgRestoreBin: string;
  psqlBin: string;
  /** Databases the drill must never touch (production), compared by host, port and name. */
  protectedUrls: string[];
}

const need = (env: Env, name: string): string => {
  const v = (env[name] ?? '').trim();
  if (!v) throw new BackupConfigError(`${name} is required`);
  return v;
};

/** Where the object store lives. `file` exists for drills and tests and is refused in production. */
export function storeFromEnv(env: Env): StoreConfig {
  const kind = (env.BACKUP_STORE ?? 's3').trim();
  if (kind === 'file') {
    if (env.NODE_ENV === 'production') throw new BackupConfigError('BACKUP_STORE=file is not allowed in production: backups must leave the host');
    return { kind: 'file', dir: need(env, 'BACKUP_FILE_DIR') };
  }
  if (kind !== 's3') throw new BackupConfigError('BACKUP_STORE must be s3 or file');
  const endpoint = (env.BACKUP_S3_ENDPOINT ?? '').trim() || undefined;
  if (endpoint && !/^https:\/\//.test(endpoint) && env.NODE_ENV === 'production') {
    throw new BackupConfigError('BACKUP_S3_ENDPOINT must use https in production');
  }
  const prefix = (env.BACKUP_S3_PREFIX ?? 'familista/postgres/').trim();
  if (!/^[A-Za-z0-9._\-/]*$/.test(prefix) || prefix.includes('..')) throw new BackupConfigError('BACKUP_S3_PREFIX has unsafe characters');
  return {
    kind: 's3',
    bucket: need(env, 'BACKUP_S3_BUCKET'),
    region: (env.BACKUP_S3_REGION ?? '').trim() || 'auto',
    endpoint,
    forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === 'true',
    accessKeyId: need(env, 'BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: need(env, 'BACKUP_S3_SECRET_ACCESS_KEY'),
    prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
  };
}

export function runnerConfigFromEnv(env: Env): RunnerConfig {
  if ((env.BACKUP_ENCRYPTION_PRIVATE_KEY ?? '').trim()) {
    throw new BackupConfigError('BACKUP_ENCRYPTION_PRIVATE_KEY must not be present where backups are taken; keep it offline');
  }
  const databaseUrl = (env.BACKUP_DATABASE_URL ?? '').trim() || need(env, 'DATABASE_URL');
  pgConnection(databaseUrl, 'BACKUP_DATABASE_URL');
  const recordUrl = (env.DATABASE_URL ?? '').trim() || databaseUrl;
  pgConnection(recordUrl, 'DATABASE_URL');
  return {
    databaseUrl,
    recordUrl,
    encryptionPublicKey: importEncryptionPublicKey(need(env, 'BACKUP_ENCRYPTION_PUBLIC_KEY')),
    signingPrivateKey: importSigningPrivateKey(need(env, 'BACKUP_SIGNING_PRIVATE_KEY')),
    store: storeFromEnv(env),
    pgDumpBin: (env.BACKUP_PG_DUMP ?? '').trim() || 'pg_dump',
    psqlBin: (env.BACKUP_PSQL ?? '').trim() || 'psql',
  };
}

export function drillConfigFromEnv(env: Env): DrillConfig {
  if (env.NODE_ENV === 'production') {
    throw new BackupConfigError('a restore drill never runs in a production environment; use an isolated machine');
  }
  if (env.DRILL_CONFIRM_ISOLATED !== 'yes') {
    throw new BackupConfigError('DRILL_CONFIRM_ISOLATED=yes is required: confirm the target is an isolated, empty database');
  }
  const targetUrl = need(env, 'DRILL_DATABASE_URL');
  pgConnection(targetUrl, 'DRILL_DATABASE_URL');
  return {
    targetUrl,
    encryptionPrivateKey: importEncryptionPrivateKey(need(env, 'BACKUP_ENCRYPTION_PRIVATE_KEY')),
    signingPublicKey: importSigningPublicKey(need(env, 'BACKUP_SIGNING_PUBLIC_KEY')),
    store: storeFromEnv(env),
    pgRestoreBin: (env.BACKUP_PG_RESTORE ?? '').trim() || 'pg_restore',
    psqlBin: (env.BACKUP_PSQL ?? '').trim() || 'psql',
    protectedUrls: ['DATABASE_URL', 'DIRECT_URL', 'BACKUP_DATABASE_URL'].map((k) => (env[k] ?? '').trim()).filter(Boolean),
  };
}

// ── connections ──────────────────────────────────────────────────────────────

export interface PgConnection { host: string; port: string; user: string; password: string; database: string; sslmode?: string }

/** Parses a postgres URL. The error names the setting, never the value. */
export function pgConnection(url: string, label: string): PgConnection {
  let u: URL;
  try { u = new URL(url); } catch { throw new BackupConfigError(`${label} is not a valid URL`); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new BackupConfigError(`${label} must be a postgres:// URL`);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new BackupConfigError(`${label} names no database`);
  const hostParam = u.searchParams.get('host');
  return {
    host: hostParam || u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    sslmode: u.searchParams.get('sslmode') ?? undefined,
  };
}

/** The database context every backup tool runs under: the system path, named. */
export const BACKUP_PG_OPTIONS = '-c familista.rls_mode=system';

/**
 * The environment for pg_dump / pg_restore / psql. The password travels in
 * PGPASSWORD, never on the command line, where every process on the machine
 * could read it.
 */
export function pgEnv(c: PgConnection, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // PGOPTIONS: backup, restore and their checks are a system path (Cyber
  // Defense R14). Under row-level security they read every club's rows, on
  // purpose and by name, rather than none of them.
  const env: NodeJS.ProcessEnv = { PATH: base.PATH, HOME: base.HOME, LANG: 'C', PGHOST: c.host, PGPORT: c.port, PGUSER: c.user, PGDATABASE: c.database, PGCONNECT_TIMEOUT: '15', PGOPTIONS: BACKUP_PG_OPTIONS };
  if (c.password) env.PGPASSWORD = c.password;
  if (c.sslmode) env.PGSSLMODE = c.sslmode;
  return env;
}

/** Same server and database? Hostnames compared case-insensitively. */
export function sameDatabase(a: PgConnection, b: PgConnection): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.database === b.database;
}
