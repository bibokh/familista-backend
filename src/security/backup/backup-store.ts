// Cyber Defense, Step 10 — where encrypted backups are kept
// ─────────────────────────────────────────────────────────────────────────────
// Only ciphertext and signed manifests ever pass through here. `s3` is any
// S3-compatible bucket, on credentials separate from the application's own
// storage (ideally write-only for the runner). `file` exists for drills and
// tests; configuration refuses it in production.

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StoreConfig } from './backup-config';

export interface BackupStore {
  /** Human-readable location for the record, e.g. s3://bucket/key. */
  describe(key: string): string;
  putFile(key: string, localPath: string, contentType: string): Promise<void>;
  getToFile(key: string, localPath: string): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9._\-/]+$/;
function checkKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.startsWith('/')) throw new Error('unsafe backup object key');
}

export function fileStore(dir: string): BackupStore {
  const root = path.resolve(dir);
  const full = (key: string) => {
    checkKey(key);
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('unsafe backup object key');
    return p;
  };
  return {
    describe: (key) => `file://${full(key)}`,
    async putFile(key, localPath) {
      const dest = full(key);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      // Never overwrite an existing backup.
      fs.copyFileSync(localPath, dest, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest, 0o600);
    },
    async getToFile(key, localPath) {
      fs.copyFileSync(full(key), localPath);
      fs.chmodSync(localPath, 0o600);
    },
  };
}

export function s3Store(cfg: Extract<StoreConfig, { kind: 's3' }>, client?: S3Client): BackupStore {
  const s3 = client ?? new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const fullKey = (key: string) => { checkKey(key); return `${cfg.prefix}${key}`; };
  return {
    describe: (key) => `s3://${cfg.bucket}/${fullKey(key)}`,
    async putFile(key, localPath, contentType) {
      const { size } = fs.statSync(localPath);
      await s3.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: fullKey(key),
        Body: fs.createReadStream(localPath),
        ContentLength: size,
        ContentType: contentType,
      }));
    },
    async getToFile(key, localPath) {
      const out = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: fullKey(key) }));
      if (!out.Body) throw new Error('backup object is empty');
      await pipeline(out.Body as Readable, fs.createWriteStream(localPath, { mode: 0o600 }));
    },
  };
}

export function storeFor(cfg: StoreConfig): BackupStore {
  return cfg.kind === 'file' ? fileStore(cfg.dir) : s3Store(cfg);
}
