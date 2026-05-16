// Familista — Super Admin White-label Control Panel
// File location: src/lib/storage/storage-local.adapter.ts
//
// Local-disk storage adapter for white-label assets. Default in dev and on
// single-instance production deployments. For multi-instance or CDN-fronted
// production, swap in the S3 adapter (same interface).

import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';

import type { StorageAdapter, StoragePutResult } from './storage.adapter';

const DEFAULT_ROOT = path.resolve(process.cwd(), 'uploads');
const DEFAULT_PUBLIC_PREFIX = '/uploads';

export type LocalAdapterOptions = {
  rootDir?: string;
  publicPrefix?: string;
  publicBaseUrl?: string;
};

export class LocalStorageAdapter implements StorageAdapter {
  readonly kind = 'LOCAL' as const;

  private readonly rootDir: string;
  private readonly publicPrefix: string;
  private readonly publicBaseUrl: string | null;

  constructor(opts: LocalAdapterOptions = {}) {
    this.rootDir = path.resolve(opts.rootDir ?? process.env.WL_ASSETS_DIR ?? DEFAULT_ROOT);
    this.publicPrefix = (opts.publicPrefix ?? process.env.WL_ASSETS_PUBLIC_PREFIX ?? DEFAULT_PUBLIC_PREFIX).replace(/\/+$/, '');
    const base = opts.publicBaseUrl ?? process.env.WL_ASSETS_PUBLIC_BASE_URL ?? null;
    this.publicBaseUrl = base ? base.replace(/\/+$/, '') : null;
  }

  private safeResolve(key: string): string {
    const normalized = path.posix.normalize(key).replace(/^[./\\]+/, '');
    if (normalized.includes('..')) throw new Error('Invalid storage key');
    const abs = path.resolve(this.rootDir, normalized);
    if (!abs.startsWith(this.rootDir + path.sep) && abs !== this.rootDir) {
      throw new Error('Storage key escapes root');
    }
    return abs;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoragePutResult> {
    const dest = this.safeResolve(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, data);
    return {
      key,
      bytes: data.byteLength,
      checksum: crypto.createHash('sha256').update(data).digest('hex'),
      contentType,
      url: this.urlFor(key),
      storage: 'LOCAL',
      bucket: null,
    };
  }

  async delete(key: string): Promise<void> {
    const target = this.safeResolve(key);
    try {
      await fsp.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  urlFor(key: string): string {
    const safeKey = key.replace(/^\/+/, '');
    const pathPart = `${this.publicPrefix}/${safeKey}`;
    return this.publicBaseUrl ? `${this.publicBaseUrl}${pathPart}` : pathPart;
  }
}
