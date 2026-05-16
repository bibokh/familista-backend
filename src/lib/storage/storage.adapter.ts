// Familista — Super Admin White-label Control Panel
// File location: src/lib/storage/storage.adapter.ts
//
// Storage adapter interface + factory. Switch backend via env WL_ASSETS_BACKEND
// = "LOCAL" | "S3". Defaults to LOCAL.

import type { AssetStorage } from '@prisma/client';

export type StoragePutResult = {
  key: string;
  bytes: number;
  checksum: string;
  contentType: string;
  url: string;
  storage: AssetStorage;
  bucket: string | null;
};

export interface StorageAdapter {
  readonly kind: AssetStorage;
  put(key: string, data: Buffer, contentType: string): Promise<StoragePutResult>;
  delete(key: string): Promise<void>;
  urlFor(key: string): string;
}

let cached: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (cached) return cached;

  const backend = (process.env.WL_ASSETS_BACKEND ?? 'LOCAL').toUpperCase();
  if (backend === 'S3') {
    // Lazy require so the S3 SDK isn't loaded when not in use.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { S3StorageAdapter } = require('./storage-s3.adapter') as typeof import('./storage-s3.adapter');
    cached = new S3StorageAdapter();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LocalStorageAdapter } = require('./storage-local.adapter') as typeof import('./storage-local.adapter');
    cached = new LocalStorageAdapter();
  }

  return cached;
}

export function _resetStorageAdapterForTests(): void {
  cached = null;
}
