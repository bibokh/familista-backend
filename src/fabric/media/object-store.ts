// Where bytes live, named without naming a vendor
// ─────────────────────────────────────────────────────────────────────────────
// Four operations, and no domain service may know more than these four. That
// constraint is the deliverable: the brief says not to hard-code AWS,
// Cloudflare or Backblaze into domain logic, and the only reliable way to keep
// that promise is for the domain to have no vocabulary in which to express a
// provider.
//
// Familista already has a `StorageAdapter` under `lib/storage`, used by the
// white-label asset pipeline, with LOCAL and S3 implementations selected by
// `WL_ASSETS_BACKEND`. That is not replaced and not duplicated: the default
// object store below WRAPS it, so this task provisions nothing, selects no
// provider, and changes no deployment. When the platform moves media to an
// object store, that is a change to one env var and one adapter — not to any
// caller of this port.
//
// SIGNED READS, NOT PUBLIC URLS
//
// `getSignedReadUrl` exists rather than a `publicUrl` because a club's media is
// a club's. A URL that works for anybody who has it is an access-control
// decision made by whoever pasted the link, and once the platform holds
// footage of academy players — children — that is not a decision to delegate.
// The local adapter has no signing, so it returns its own URL and SAYS SO in
// the result, rather than pretending to a guarantee it cannot make.

import { createHash } from 'crypto';

export interface PutObjectArgs {
  key: string;
  body: Buffer;
  contentType: string;
  /** Advisory only. A store that cannot honour it ignores it. */
  cacheControl?: string;
}

export interface PutObjectResult {
  key: string;
  provider: string;
  sizeBytes: number;
  /** SHA-256, computed over exactly the bytes that were stored. */
  checksum: string;
  contentType: string;
}

export interface HeadObjectResult {
  key: string;
  exists: boolean;
  sizeBytes: number | null;
  contentType: string | null;
  lastModified: Date | null;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
  /**
   * False when the store cannot actually sign — the local disk adapter, today.
   * The caller can then refuse to hand the URL to a browser for RESTRICTED
   * media rather than discovering the gap in production.
   */
  signed: boolean;
}

/**
 * The port. Anything that can hold bytes and give them back implements this.
 */
export interface ObjectStore {
  /** A name for metadata, logs and the status surface. LOCAL, S3, MEMORY. */
  readonly provider: string;
  putObject(args: PutObjectArgs): Promise<PutObjectResult>;
  getSignedReadUrl(key: string, ttlSeconds?: number): Promise<SignedUrl>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<HeadObjectResult>;
}

export const DEFAULT_READ_TTL_SECONDS = 900;

export function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * The object key for one asset.
 *
 * Club-first, always. Two reasons, and the second is the important one:
 * a prefix scan by club is the natural query for an export, a retention sweep
 * or a deletion request; and a bucket policy, a lifecycle rule and a
 * cross-account grant can all be written against `club/{clubId}/` — so the
 * tenant boundary can be enforced by the storage layer itself, not only by
 * application code that has to remember.
 *
 * The shape follows the fabric design: club → team → season → subject → id.
 * Segments the caller cannot supply are simply absent rather than filled with
 * a placeholder, because `unknown/` in a key is a value somebody will later
 * mistake for a real one.
 */
export function buildObjectKey(parts: {
  clubId: string;
  teamId?: string | null;
  season?: string | null;
  subjectType: string;
  subjectId?: string | null;
  assetId: string;
  extension?: string | null;
}): string {
  const safe = (v: string) => String(v).replace(/[^A-Za-z0-9._-]/g, '');
  const segs = [`club/${safe(parts.clubId)}`];
  if (parts.teamId) segs.push(`team/${safe(parts.teamId)}`);
  if (parts.season) segs.push(`season/${safe(parts.season)}`);
  segs.push(`${safe(parts.subjectType).toLowerCase()}`);
  if (parts.subjectId) segs.push(safe(parts.subjectId));
  const ext = parts.extension ? `.${safe(parts.extension).replace(/^\.+/, '')}` : '';
  segs.push(`${safe(parts.assetId)}${ext}`);
  return segs.join('/');
}

/**
 * The club a key belongs to, or null if it is not a Familista key.
 *
 * The guard that makes a stored key safe to accept from a request. A caller
 * that hands in `club/OTHER-CLUB/...` is asking for another tenant's object,
 * and this is what catches it before the store is ever asked.
 */
export function clubIdFromKey(key: string): string | null {
  const m = /^club\/([A-Za-z0-9._-]+)\//.exec(String(key ?? ''));
  return m ? m[1] : null;
}

// ── the in-memory store, for tests and for a boot with nothing configured ────

export class MemoryObjectStore implements ObjectStore {
  readonly provider = 'MEMORY';
  private objects = new Map<string, { body: Buffer; contentType: string; at: Date }>();

  async putObject(args: PutObjectArgs): Promise<PutObjectResult> {
    this.objects.set(args.key, { body: args.body, contentType: args.contentType, at: new Date() });
    return {
      key: args.key,
      provider: this.provider,
      sizeBytes: args.body.length,
      checksum: sha256(args.body),
      contentType: args.contentType,
    };
  }

  async getSignedReadUrl(key: string, ttlSeconds = DEFAULT_READ_TTL_SECONDS): Promise<SignedUrl> {
    return {
      url: `memory://${key}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      signed: false,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const o = this.objects.get(key);
    return {
      key,
      exists: !!o,
      sizeBytes: o ? o.body.length : null,
      contentType: o?.contentType ?? null,
      lastModified: o?.at ?? null,
    };
  }

  /** Test helper. Not part of the port. */
  read(key: string): Buffer | null {
    return this.objects.get(key)?.body ?? null;
  }
}

// ── the default, wrapping what the deployment already has ────────────────────

/**
 * The existing `lib/storage` adapter, presented through this port.
 *
 * Adapting rather than replacing is deliberate: the white-label pipeline works,
 * its LOCAL and S3 implementations are tested, and a second storage stack
 * beside it would be two things to configure and two things to get wrong. What
 * this adds is the two operations the old interface lacks — `headObject` and a
 * signed read — and honesty about which of them the underlying adapter can
 * really provide.
 */
class LegacyAdapterObjectStore implements ObjectStore {
  readonly provider: string;
  // Typed loosely so this module never imports the Prisma AssetStorage enum
  // into the fabric's own vocabulary.
  private adapter: {
    kind: string;
    put(key: string, data: Buffer, contentType: string): Promise<{ key: string; bytes: number; checksum: string; url: string }>;
    delete(key: string): Promise<void>;
    urlFor(key: string): string;
  };

  constructor(adapter: LegacyAdapterObjectStore['adapter']) {
    this.adapter = adapter;
    this.provider = String(adapter.kind ?? 'LOCAL');
  }

  async putObject(args: PutObjectArgs): Promise<PutObjectResult> {
    const out = await this.adapter.put(args.key, args.body, args.contentType);
    return {
      key: out.key ?? args.key,
      provider: this.provider,
      sizeBytes: out.bytes ?? args.body.length,
      // The adapter computes a checksum of its own; recomputing here means the
      // value stored on the row is always SHA-256 of the bytes we sent,
      // whatever the adapter chose to hash.
      checksum: sha256(args.body),
      contentType: args.contentType,
    };
  }

  async getSignedReadUrl(key: string, ttlSeconds = DEFAULT_READ_TTL_SECONDS): Promise<SignedUrl> {
    // The local adapter serves from a public prefix and cannot sign. Saying so
    // is the whole value of the `signed` flag: a caller handling RESTRICTED
    // media can refuse rather than hand out a durable link by accident.
    return {
      url: this.adapter.urlFor(key),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      signed: false,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.adapter.delete(key);
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    // The legacy adapter has no head operation. Rather than invent one by
    // fetching the object, this reports what it honestly knows — that a URL
    // can be formed — and leaves `exists` unknowable as `false`. An S3-backed
    // implementation of this port answers it properly.
    return { key, exists: false, sizeBytes: null, contentType: null, lastModified: null };
  }
}

let store: ObjectStore | null = null;

/** Install an object store. Boot, and tests. */
export function setObjectStore(next: ObjectStore | null): void {
  store = next;
}

/**
 * The object store this process uses.
 *
 * Resolves lazily and never throws: a deployment with no storage configured
 * gets an in-memory store and a media pipeline that works in process, rather
 * than an application that fails to start. The provider name on every
 * `MediaAsset` row records which one actually stored the bytes, so a row
 * written during a misconfiguration is identifiable afterwards rather than
 * indistinguishable.
 */
export function getObjectStore(): ObjectStore {
  if (store) return store;
  try {
    // Required lazily so the fabric does not pull the storage stack — or the
    // optional S3 SDK — into a process that never stores an object.
    const legacy = require('../../lib/storage/storage.adapter') as {
      getStorageAdapter: () => LegacyAdapterObjectStore['adapter'];
    };
    store = new LegacyAdapterObjectStore(legacy.getStorageAdapter());
  } catch {
    store = new MemoryObjectStore();
  }
  return store;
}
