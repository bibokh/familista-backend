/**
 * tests/backup-config.unit.test.ts
 *
 * Cyber Defense, Step 10 — backup configuration, the object store and the
 * PostgreSQL process boundary.
 *
 * Configuration fails closed and never echoes a value; the runner refuses to
 * start with the decryption key present; production refuses a local store and
 * plain-http endpoints; a drill refuses production outright. The store never
 * overwrites a backup and never follows a path out of its directory. The
 * database password never reaches a command line, and nothing a pg tool prints
 * carries a connection string or password out.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { generateBackupKeys } from '../src/security/backup/backup-crypto';
import {
  BackupConfigError, drillConfigFromEnv, pgConnection, pgEnv, runnerConfigFromEnv, sameDatabase, storeFromEnv,
} from '../src/security/backup/backup-config';
import { fileStore, s3ClientFor, s3Store } from '../src/security/backup/backup-store';
import { createHash } from 'crypto';
import { scrub, spawnPg } from '../src/security/backup/pg-process';

const keys = generateBackupKeys();
// Built at runtime so no credential-looking literal sits in the repository.
const PW = ['pw', 'Zq7', 'x9', 'Lm2'].join('');
const DB_URL = `postgresql://fam_user:${PW}@db.internal:5432/familista`;
const S3 = { BACKUP_S3_BUCKET: 'fam-backups', BACKUP_S3_ACCESS_KEY_ID: 'AKID', BACKUP_S3_SECRET_ACCESS_KEY: 'SAK' };
const runnerEnv = (extra: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: DB_URL,
  BACKUP_ENCRYPTION_PUBLIC_KEY: keys.encryptionPublicKey,
  BACKUP_SIGNING_PRIVATE_KEY: keys.signingPrivateKey,
  ...S3,
  ...extra,
});
const drillEnv = (extra: Record<string, string | undefined> = {}) => ({
  DRILL_CONFIRM_ISOLATED: 'yes',
  DRILL_DATABASE_URL: 'postgresql://drill@localhost:5433/familista_drill',
  BACKUP_ENCRYPTION_PRIVATE_KEY: keys.encryptionPrivateKey,
  BACKUP_SIGNING_PUBLIC_KEY: keys.signingPublicKey,
  ...S3,
  ...extra,
});

function messageOf(fn: () => unknown): string {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
}

describe('runner configuration', () => {
  it('accepts a complete configuration', () => {
    const c = runnerConfigFromEnv(runnerEnv());
    expect(c.databaseUrl).toBe(DB_URL);
    expect(c.store).toMatchObject({ kind: 's3', bucket: 'fam-backups', region: 'auto', prefix: 'familista/postgres/' });
    expect(c.pgDumpBin).toBe('pg_dump');
  });

  it('prefers BACKUP_DATABASE_URL over DATABASE_URL', () => {
    const other = 'postgresql://ro@replica:5432/familista';
    expect(runnerConfigFromEnv(runnerEnv({ BACKUP_DATABASE_URL: other })).databaseUrl).toBe(other);
  });

  it('refuses to run where the decryption key is present', () => {
    const msg = messageOf(() => runnerConfigFromEnv(runnerEnv({ BACKUP_ENCRYPTION_PRIVATE_KEY: keys.encryptionPrivateKey })));
    expect(msg).toMatch(/must not be present/);
    expect(msg).not.toContain(keys.encryptionPrivateKey);
  });

  it.each(['BACKUP_ENCRYPTION_PUBLIC_KEY', 'BACKUP_SIGNING_PRIVATE_KEY', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'])(
    'fails closed without %s', (name) => {
      expect(() => runnerConfigFromEnv(runnerEnv({ [name]: undefined }))).toThrow(new BackupConfigError(`${name} is required`));
    });

  it('fails closed without a database URL, and on a malformed one without echoing it', () => {
    expect(() => runnerConfigFromEnv(runnerEnv({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL is required/);
    const bad = `mysql://u:${PW}@h/db`;
    const msg = messageOf(() => runnerConfigFromEnv(runnerEnv({ DATABASE_URL: bad })));
    expect(msg).toMatch(/postgres/);
    expect(msg).not.toContain(PW);
  });

  it('refuses keys swapped between roles', () => {
    expect(() => runnerConfigFromEnv(runnerEnv({ BACKUP_ENCRYPTION_PUBLIC_KEY: keys.signingPublicKey }))).toThrow(/BACKUP_ENCRYPTION_PUBLIC_KEY/);
    expect(() => runnerConfigFromEnv(runnerEnv({ BACKUP_SIGNING_PRIVATE_KEY: keys.encryptionPrivateKey }))).toThrow(/BACKUP_SIGNING_PRIVATE_KEY/);
  });
});

describe('store configuration', () => {
  it('refuses a local file store in production: backups must leave the host', () => {
    expect(() => storeFromEnv({ NODE_ENV: 'production', BACKUP_STORE: 'file', BACKUP_FILE_DIR: '/tmp/x' })).toThrow(/not allowed in production/);
    expect(storeFromEnv({ BACKUP_STORE: 'file', BACKUP_FILE_DIR: '/tmp/x' })).toEqual({ kind: 'file', dir: '/tmp/x' });
  });

  it('refuses a plain-http endpoint in production', () => {
    expect(() => storeFromEnv({ ...S3, NODE_ENV: 'production', BACKUP_S3_ENDPOINT: 'http://minio:9000' })).toThrow(/https/);
    expect(storeFromEnv({ ...S3, NODE_ENV: 'production', BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' }))
      .toMatchObject({ endpoint: 'https://acct.r2.cloudflarestorage.com' });
  });

  it('refuses an unknown store kind and an unsafe prefix, and normalises the prefix', () => {
    expect(() => storeFromEnv({ BACKUP_STORE: 'ftp' })).toThrow(/s3 or file/);
    expect(() => storeFromEnv({ ...S3, BACKUP_S3_PREFIX: '../other' })).toThrow(/unsafe/);
    expect(() => storeFromEnv({ ...S3, BACKUP_S3_PREFIX: 'a b' })).toThrow(/unsafe/);
    expect(storeFromEnv({ ...S3, BACKUP_S3_PREFIX: 'fam/db' })).toMatchObject({ prefix: 'fam/db/' });
  });
});

describe('drill configuration', () => {
  it('accepts a complete isolated configuration and protects the production URLs', () => {
    const c = drillConfigFromEnv(drillEnv({ DATABASE_URL: DB_URL, DIRECT_URL: DB_URL }));
    expect(c.protectedUrls).toEqual([DB_URL, DB_URL]);
    expect(c.pgRestoreBin).toBe('pg_restore');
  });

  it('never runs in a production environment', () => {
    expect(() => drillConfigFromEnv(drillEnv({ NODE_ENV: 'production' }))).toThrow(/never runs in a production/);
  });

  it('requires the explicit isolation confirmation', () => {
    expect(() => drillConfigFromEnv(drillEnv({ DRILL_CONFIRM_ISOLATED: undefined }))).toThrow(/DRILL_CONFIRM_ISOLATED=yes/);
    expect(() => drillConfigFromEnv(drillEnv({ DRILL_CONFIRM_ISOLATED: 'true' }))).toThrow(/DRILL_CONFIRM_ISOLATED=yes/);
  });

  it.each(['DRILL_DATABASE_URL', 'BACKUP_ENCRYPTION_PRIVATE_KEY', 'BACKUP_SIGNING_PUBLIC_KEY'])('fails closed without %s', (name) => {
    expect(() => drillConfigFromEnv(drillEnv({ [name]: undefined }))).toThrow(`${name} is required`);
  });
});

describe('PostgreSQL connections', () => {
  it('parses a URL, including a socket host parameter', () => {
    expect(pgConnection(DB_URL, 'X')).toEqual({ host: 'db.internal', port: '5432', user: 'fam_user', password: PW, database: 'familista', sslmode: undefined });
    expect(pgConnection('postgresql://postgres@localhost:55432/fam?host=/tmp/sock&sslmode=disable', 'X'))
      .toMatchObject({ host: '/tmp/sock', port: '55432', database: 'fam', sslmode: 'disable' });
  });

  it('refuses a URL without a database, naming the setting only', () => {
    const msg = messageOf(() => pgConnection(`postgresql://u:${PW}@h:5432/`, 'DRILL_DATABASE_URL'));
    expect(msg).toBe('DRILL_DATABASE_URL names no database');
  });

  it('the child environment carries the password in PGPASSWORD and nothing else from the parent', () => {
    const env = pgEnv(pgConnection(DB_URL, 'X'), { PATH: '/bin', HOME: '/h', DATABASE_URL: DB_URL, JWT_SECRET: 'x', AWS_SECRET_ACCESS_KEY: 'y' });
    expect(env).toEqual({
      PATH: '/bin', HOME: '/h', LANG: 'C', PGHOST: 'db.internal', PGPORT: '5432', PGUSER: 'fam_user',
      PGDATABASE: 'familista', PGCONNECT_TIMEOUT: '15', PGPASSWORD: PW,
    });
  });

  it('compares databases by host, port and name', () => {
    const a = pgConnection(DB_URL, 'A');
    expect(sameDatabase(a, pgConnection('postgresql://other:x@DB.INTERNAL:5432/familista', 'B'))).toBe(true);
    expect(sameDatabase(a, pgConnection('postgresql://other:x@db.internal:5432/familista_drill', 'B'))).toBe(false);
    expect(sameDatabase(a, pgConnection('postgresql://other:x@db.internal:6432/familista', 'B'))).toBe(false);
  });
});

describe('pg process boundary', () => {
  const conn = pgConnection(DB_URL, 'X');
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-pgproc-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('scrubs URLs, the password, the user and the host from messages, and caps their length', () => {
    const s = scrub(`connection to ${DB_URL} failed: password ${PW} for fam_user at db.internal ${'x'.repeat(900)}`, conn);
    expect(s).not.toContain(PW);
    expect(s).not.toContain('fam_user');
    expect(s).not.toContain('db.internal');
    expect(s).not.toMatch(/postgres(ql)?:\/\//);
    expect(s.length).toBeLessThanOrEqual(500);
  });

  it('never puts the password on the command line, and scrubs what the tool prints on failure', async () => {
    const seen = path.join(dir, 'seen.txt');
    const bin = path.join(dir, 'fake-pg');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > '${seen}'\nprintf 'pw=%s\\n' "$PGPASSWORD" >> '${seen}'\necho "FATAL: password authentication failed for user $PGUSER at $PGHOST using $PGPASSWORD" >&2\nexit 2\n`, { mode: 0o700 });
    const { done } = spawnPg(bin, ['--dbname=familista'], conn);
    const err = await done.then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/exit 2/);
    expect(err!.message).not.toContain(PW);
    expect(err!.message).not.toContain('db.internal');
    const [argv, pw] = fs.readFileSync(seen, 'utf8').trim().split('\n');
    expect(argv).toBe('--dbname=familista');
    expect(pw).toBe(`pw=${PW}`);
  });

  it('reports a tool that cannot start', async () => {
    const { done } = spawnPg(path.join(dir, 'missing-binary'), [], conn);
    await expect(done).rejects.toThrow(/could not start/);
  });
});

describe('file store', () => {
  let root: string;
  let src: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-store-'));
    src = path.join(root, 'src.bin');
    fs.writeFileSync(src, 'ciphertext');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('stores with mode 0600 and reads back', async () => {
    const store = fileStore(path.join(root, 'b'));
    await store.putFile('2026/09/29/x.fbk', src, 'application/octet-stream');
    const stored = path.join(root, 'b', '2026/09/29/x.fbk');
    expect(fs.statSync(stored).mode & 0o777).toBe(0o600);
    const back = path.join(root, 'back.bin');
    await store.getToFile('2026/09/29/x.fbk', back);
    expect(fs.readFileSync(back, 'utf8')).toBe('ciphertext');
    expect(fs.statSync(back).mode & 0o777).toBe(0o600);
    expect(store.describe('2026/09/29/x.fbk')).toBe(`file://${stored}`);
  });

  it('never overwrites an existing backup', async () => {
    const store = fileStore(path.join(root, 'b'));
    await store.putFile('x.fbk', src, 'application/octet-stream');
    await expect(store.putFile('x.fbk', src, 'application/octet-stream')).rejects.toThrow();
  });

  it.each(['../escape.fbk', '/abs.fbk', 'a/../../b.fbk', 'sp ace.fbk', 'semi;colon.fbk', ''])('refuses the unsafe key %p', async (key) => {
    const store = fileStore(path.join(root, 'b'));
    await expect(store.putFile(key, src, 'x')).rejects.toThrow(/unsafe/);
  });
});

describe('s3 store', () => {
  const cfg = { kind: 's3' as const, bucket: 'fam-backups', region: 'auto', forcePathStyle: false, accessKeyId: 'a', secretAccessKey: 'b', prefix: 'familista/postgres/' };

  it('uploads under the prefix with an explicit length and content type', async () => {
    const sent: unknown[] = [];
    const bodies: string[] = [];
    const client = { send: jest.fn(async (cmd: PutObjectCommand) => {
      sent.push(cmd);
      const chunks: Buffer[] = [];
      for await (const c of cmd.input.Body as Readable) chunks.push(Buffer.from(c));
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      return {};
    }) } as unknown as S3Client;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-s3-'));
    const f = path.join(dir, 'x');
    fs.writeFileSync(f, 'abcdef');
    try {
      await s3Store(cfg, client).putFile('2026/x.fbk', f, 'application/octet-stream');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'fam-backups', Key: 'familista/postgres/2026/x.fbk', ContentLength: 6, ContentType: 'application/octet-stream',
    });
    expect(bodies).toEqual(['abcdef']);
    expect(s3Store(cfg, client).describe('2026/x.fbk')).toBe('s3://fam-backups/familista/postgres/2026/x.fbk');
  });

  it('downloads to a 0600 file', async () => {
    const client = { send: jest.fn(async (cmd: unknown) => {
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      expect((cmd as GetObjectCommand).input).toEqual({ Bucket: 'fam-backups', Key: 'familista/postgres/2026/x.fbk' });
      return { Body: Readable.from([Buffer.from('payload')]) };
    }) } as unknown as S3Client;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-s3-'));
    const f = path.join(dir, 'out');
    try {
      await s3Store(cfg, client).getToFile('2026/x.fbk', f);
      expect(fs.readFileSync(f, 'utf8')).toBe('payload');
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses unsafe keys before calling S3', async () => {
    const client = { send: jest.fn() } as unknown as S3Client;
    await expect(s3Store(cfg, client).getToFile('../x.fbk', '/tmp/never')).rejects.toThrow(/unsafe/);
    expect((client.send as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe('s3 store on the wire — Backblaze B2 S3-compatible API', () => {
  // The real client configuration, with a request handler that records the
  // signed HTTP request instead of sending it. No network, no credentials:
  // the key pair below is a placeholder that signs nothing anyone accepts.
  const B2 = {
    kind: 's3' as const, bucket: 'familista-backups-2026-739261', region: 'eu-central-003',
    endpoint: 'https://s3.eu-central-003.backblazeb2.com', forcePathStyle: false,
    accessKeyId: 'placeholder-key-id', secretAccessKey: 'placeholder-not-a-secret', prefix: 'familista/postgres/',
  };
  type Req = { method: string; protocol: string; hostname: string; path: string; headers: Record<string, string>; body?: unknown };

  function capture(cfg: typeof B2) {
    const seen: Req[] = [];
    const requestHandler = {
      handle: async (req: Req) => {
        seen.push(req);
        const body = req.body as { on?: unknown } | undefined;
        if (body && typeof body.on === 'function') for await (const _ of body as AsyncIterable<unknown>) { /* drain */ }
        return { response: { statusCode: 200, headers: {}, body: Readable.from([Buffer.from('ciphertext')]) } };
      },
    };
    return { store: s3Store(cfg, s3ClientFor(cfg, requestHandler as never)), seen };
  }

  let dir: string;
  let file: string;
  const payload = Buffer.from('FBK1-ciphertext-bytes');
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-b2-'));
    file = path.join(dir, 'x.fbk');
    fs.writeFileSync(file, payload);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const checksumHeaders = (h: Record<string, string>) => Object.keys(h).filter((k) => /^x-amz-(sdk-)?checksum|^x-amz-trailer$|^x-amz-decoded-content-length$/i.test(k));

  it('uploads virtual-hosted to the B2 endpoint, signed for eu-central-003, under the prefix', async () => {
    const { store, seen } = capture(B2);
    await store.putFile('2026/09/29/x.fbk', file, 'application/octet-stream');
    const [req] = seen;
    expect(req.method).toBe('PUT');
    expect(req.protocol).toBe('https:');
    expect(req.hostname).toBe('familista-backups-2026-739261.s3.eu-central-003.backblazeb2.com');
    expect(req.path).toBe('/familista/postgres/2026/09/29/x.fbk');
    expect(req.headers.authorization).toMatch(/Credential=placeholder-key-id\/\d{8}\/eu-central-003\/s3\/aws4_request/);
  });

  it('sends no flexible-checksum headers and no aws-chunked body — a plain, length-framed upload', async () => {
    const { store, seen } = capture(B2);
    await store.putFile('x.fbk', file, 'application/octet-stream');
    const h = seen[0].headers;
    expect(checksumHeaders(h)).toEqual([]);
    expect(h['content-encoding']).toBeUndefined();
    expect(h['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(h['content-length']).toBe(String(payload.length));
  });

  it('sends Content-MD5 of the exact bytes (required by B2 under default Object Lock retention)', async () => {
    const { store, seen } = capture(B2);
    await store.putFile('x.fbk', file, 'application/octet-stream');
    expect(seen[0].headers['content-md5']).toBe(createHash('md5').update(payload).digest('base64'));
  });

  it('downloads without asking for checksum mode', async () => {
    const { store, seen } = capture(B2);
    const out = path.join(dir, 'back.fbk');
    await store.getToFile('x.fbk', out);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].hostname).toBe('familista-backups-2026-739261.s3.eu-central-003.backblazeb2.com');
    expect(checksumHeaders(seen[0].headers)).toEqual([]);
    expect(fs.readFileSync(out, 'utf8')).toBe('ciphertext');
  });

  it('switches to path-style only when BACKUP_S3_FORCE_PATH_STYLE is set (for a bucket name with dots)', async () => {
    const { store, seen } = capture({ ...B2, bucket: 'fam.backups', forcePathStyle: true });
    await store.putFile('x.fbk', file, 'application/octet-stream');
    expect(seen[0].hostname).toBe('s3.eu-central-003.backblazeb2.com');
    expect(seen[0].path).toBe('/fam.backups/familista/postgres/x.fbk');
  });

  it('the runner configuration carries the endpoint and region through from the environment', () => {
    const c = storeFromEnv({ ...S3, NODE_ENV: 'production', BACKUP_S3_REGION: 'eu-central-003', BACKUP_S3_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com' });
    expect(c).toMatchObject({ kind: 's3', region: 'eu-central-003', endpoint: 'https://s3.eu-central-003.backblazeb2.com', forcePathStyle: false });
  });
});
