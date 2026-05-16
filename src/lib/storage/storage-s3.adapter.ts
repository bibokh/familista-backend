// Familista — Super Admin White-label Control Panel
// File location: src/lib/storage/storage-s3.adapter.ts
//
// S3-compatible storage adapter (works with AWS S3, Cloudflare R2, Backblaze B2,
// DigitalOcean Spaces). Requires `@aws-sdk/client-s3`.
//   npm i @aws-sdk/client-s3
//
// Configure via env:
//   WL_ASSETS_S3_BUCKET           e.g. familista-assets
//   WL_ASSETS_S3_REGION           e.g. us-east-1
//   WL_ASSETS_S3_ENDPOINT         (optional, for R2/B2/Spaces)
//   WL_ASSETS_S3_ACCESS_KEY_ID
//   WL_ASSETS_S3_SECRET_ACCESS_KEY
//   WL_ASSETS_S3_PUBLIC_BASE_URL  e.g. https://cdn.familista.app
//   WL_ASSETS_S3_FORCE_PATH_STYLE (optional, true for R2)

import crypto from 'crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

import type { StorageAdapter, StoragePutResult } from './storage.adapter';

export type S3AdapterOptions = {
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
};

export class S3StorageAdapter implements StorageAdapter {
  readonly kind = 'S3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(opts: S3AdapterOptions = {}) {
    const bucket = opts.bucket ?? process.env.WL_ASSETS_S3_BUCKET;
    const region = opts.region ?? process.env.WL_ASSETS_S3_REGION ?? 'us-east-1';
    const endpoint = opts.endpoint ?? process.env.WL_ASSETS_S3_ENDPOINT;
    const accessKeyId = opts.accessKeyId ?? process.env.WL_ASSETS_S3_ACCESS_KEY_ID;
    const secretAccessKey = opts.secretAccessKey ?? process.env.WL_ASSETS_S3_SECRET_ACCESS_KEY;
    const publicBaseUrl = (opts.publicBaseUrl ?? process.env.WL_ASSETS_S3_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
    const forcePathStyle = opts.forcePathStyle ?? process.env.WL_ASSETS_S3_FORCE_PATH_STYLE === 'true';

    if (!bucket) throw new Error('S3StorageAdapter: WL_ASSETS_S3_BUCKET required');
    if (!publicBaseUrl) throw new Error('S3StorageAdapter: WL_ASSETS_S3_PUBLIC_BASE_URL required');
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('S3StorageAdapter: access key & secret required');
    }

    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.bucket = bucket;
    this.publicBaseUrl = publicBaseUrl;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoragePutResult> {
    const sanitizedKey = key.replace(/^\/+/, '');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: sanitizedKey,
        Body: data,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return {
      key: sanitizedKey,
      bytes: data.byteLength,
      checksum: crypto.createHash('sha256').update(data).digest('hex'),
      contentType,
      url: this.urlFor(sanitizedKey),
      storage: 'S3',
      bucket: this.bucket,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key.replace(/^\/+/, '') }),
    );
  }

  urlFor(key: string): string {
    return `${this.publicBaseUrl}/${key.replace(/^\/+/, '')}`;
  }
}
