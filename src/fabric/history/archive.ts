// The long-term cold archive — interface, manifest, and a disabled exporter
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS, AND WHAT IT IS NOT
//
// It is the contract for moving history off hot PostgreSQL and into object
// storage, and the manifest format that makes such a move verifiable. It is NOT
// a working exporter, and it will not become one by accident: `archiveEnabled()`
// returns false unless a bucket and credentials are configured, and every entry
// point refuses while it does.
//
// STORAGE IS NOT THIS FILE'S TO INVENT
//
// Familista already has an object-storage port — `fabric/media/object-store.ts`
// — with four operations, a `MemoryObjectStore`, a `setObjectStore`/
// `getObjectStore` pair and an adapter that wraps the existing `lib/storage`
// stack. An archive that defined its own storage interface beside it would be a
// second port to configure, a second provider to select and a second thing to
// get wrong, and the day somebody built the exporter they would have to throw
// one of them away.
//
// So `ArchiveExporter` is ORCHESTRATION — batching, partitioning, manifests,
// integrity — and the bytes go through `ObjectStore`. The exporter decides what
// a batch is and what proves it arrived; the port decides where bytes live and
// which vendor holds them. Neither knows the other's business.
//
// The exporter is still not implemented, and that is deliberate: writing one
// that pretends to work would produce an archive nobody could restore from and
// a green job that proves nothing.
//
// THREE THINGS THAT ARE NOT EACH OTHER
//
//   HISTORICAL STORE   `FabricEventHistory` in PostgreSQL. Queryable. Answers
//                      "what happened on this day". Hot, indexed, expensive
//                      per row, and the only one of the three a person reads.
//
//   COLD ARCHIVE       Parquet in object storage, partitioned by date and
//                      source. Answers "keep a decade of history for the price
//                      of a month of it". Cheap, analytic, not queryable
//                      row-by-row without a reader. This file's subject.
//
//   DATABASE BACKUP    The provider's snapshot of the whole database. Answers
//                      "the database is gone, put it back". Not a feature of
//                      this platform at all — it is the database provider's, it covers every
//                      table rather than this one, and it is restored to a
//                      point in time rather than queried.
//
// None substitutes for another. An archive is not a backup: it holds one
// table's history and cannot restore a club. A backup is not an archive: it is
// a whole-database image that nobody can run an analytic query against. And
// neither is the historical store, which is the only one that answers a
// question about a particular day.
//
// See `docs/FABRIC_HISTORICAL_STORE.md`.

import type { RetentionClass } from './retention-classes';
import { getObjectStore, type ObjectStore, type PutObjectResult } from '../media/object-store';

/** Where an archive batch lands, and what proves it arrived intact. */
export interface ArchiveManifest {
  /** Unique per batch. The name of the object, and the key of the record. */
  batchId: string;
  /** How many historical records the batch contains. */
  recordCount: number;
  /** The window the batch covers, from the records themselves. */
  minOccurredAt: string;
  maxOccurredAt: string;
  /** SHA-256 over the serialized batch, so a restore can prove what it read. */
  checksum: string;
  /** Which hash produced it. Stated so a future algorithm change is legible. */
  checksumAlgorithm: 'sha256';
  /** The manifest format's own version, not the events'. */
  manifestVersion: 1;
  /** Every distinct event schema version in the batch. */
  schemaVersions: number[];
  /** Every distinct source, so a reader can skip a partition it does not want. */
  sources: string[];
  /** Every distinct retention class, so a policy can act on a whole batch. */
  retentionClasses: RetentionClass[];
  /** The storage key the batch was written to. */
  objectKey: string;
  format: 'parquet';
  createdAt: string;
}

/**
 * Where a batch belongs in the bucket.
 *
 * Hive-style partitioning, which is what every analytic reader — DuckDB, Spark,
 * Athena, a pandas script — already understands without being told:
 *
 *   year=2030/month=05/day=14/source=matches/<batchId>.parquet
 *
 * Date first because the commonest archive question is a range, and a reader
 * that can skip whole directories on a date predicate reads a thousandth of the
 * bytes. Source last because it is the commonest second filter.
 */
export function archivePartitionKey(occurredAt: Date, source: string, batchId: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = occurredAt.getUTCFullYear();
  const m = pad(occurredAt.getUTCMonth() + 1);
  const d = pad(occurredAt.getUTCDate());
  const safeSource = String(source).replace(/[^a-z0-9-]/gi, '-').slice(0, 48) || 'unknown';
  return `year=${y}/month=${m}/day=${d}/source=${safeSource}/${batchId}.parquet`;
}

/**
 * The storage the archive would write through.
 *
 * `getObjectStore()` is the platform's one port and resolves lazily: a
 * deployment with nothing configured gets an in-memory store rather than a
 * process that will not start. That is exactly why `archiveEnabled()` below
 * does NOT ask the port whether it works — an in-memory store answers yes to
 * `putObject` and loses the bytes at the next restart. Configuration is a
 * separate question from capability, and conflating them is how an archive
 * comes to exist only in a test.
 */
export function archiveObjectStore(): ObjectStore {
  return getObjectStore();
}

/** The configuration an archive needs before it can run. */
export interface ArchiveConfiguration {
  bucket: string | null;
  endpoint: string | null;
  region: string | null;
  hasCredentials: boolean;
}

export function archiveConfiguration(): ArchiveConfiguration {
  return {
    bucket: process.env.FABRIC_ARCHIVE_BUCKET ?? null,
    endpoint: process.env.FABRIC_ARCHIVE_S3_ENDPOINT ?? null,
    region: process.env.FABRIC_ARCHIVE_S3_REGION ?? null,
    hasCredentials: Boolean(
      process.env.FABRIC_ARCHIVE_S3_ACCESS_KEY_ID
      && process.env.FABRIC_ARCHIVE_S3_SECRET_ACCESS_KEY,
    ),
  };
}

/**
 * Whether an archive could run at all.
 *
 * A bucket AND credentials. Either alone is a misconfiguration, and the honest
 * response to a misconfiguration is to stay switched off rather than to fail
 * halfway through a batch.
 *
 * Deliberately does not consult `getObjectStore()`. That port always returns
 * something — an in-memory store when nothing is configured — so asking it
 * would always say yes and an archive would appear to work while writing to a
 * buffer that a restart discards.
 */
export function archiveEnabled(): boolean {
  const c = archiveConfiguration();
  return Boolean(c.bucket && c.hasCredentials);
}

export interface ArchiveStatus {
  enabled: boolean;
  /** `NOT_CONFIGURED` until a bucket and credentials exist. */
  state: 'NOT_CONFIGURED' | 'READY';
  bucket: string | null;
  /** What is missing, named, so an operator knows what to set. */
  missing: string[];
  format: 'parquet';
  partitioning: string;
  /** Which port the bytes would go through, and which provider it resolved to. */
  objectStore: { port: 'fabric/media/object-store'; provider: string };
  /** Nothing has ever been exported, and this build cannot export. */
  lastBatch: null;
}

export function archiveStatus(): ArchiveStatus {
  const c = archiveConfiguration();
  const missing: string[] = [];
  if (!c.bucket) missing.push('FABRIC_ARCHIVE_BUCKET');
  if (!c.hasCredentials) {
    missing.push('FABRIC_ARCHIVE_S3_ACCESS_KEY_ID', 'FABRIC_ARCHIVE_S3_SECRET_ACCESS_KEY');
  }
  return {
    enabled: archiveEnabled(),
    state: archiveEnabled() ? 'READY' : 'NOT_CONFIGURED',
    bucket: c.bucket,
    missing,
    // Reported so an operator can see WHICH store would receive the bytes
    // before anything is written — `MEMORY` here says the platform has no
    // durable object storage configured at all, whatever the bucket says.
    objectStore: { port: 'fabric/media/object-store', provider: archiveObjectStore().provider },
    format: 'parquet',
    partitioning: 'year=YYYY/month=MM/day=DD/source=<source>/<batchId>.parquet',
    lastBatch: null,
  };
}

/**
 * What an exporter must implement when one is built.
 *
 * ORCHESTRATION, not storage. An implementation batches historical rows,
 * serialises them to Parquet, computes the manifest, and hands the bytes to an
 * `ObjectStore` — the platform's existing port, injected rather than chosen, so
 * the exporter never names a vendor and a test can pass a `MemoryObjectStore`
 * without a bucket in sight.
 */
export interface ArchiveExporter {
  /** Where the bytes go. The port, never a provider. */
  readonly store: ObjectStore;
  /** Write one batch and return the manifest that proves what was written. */
  export(batch: readonly unknown[]): Promise<ArchiveManifest>;
}

/**
 * The manifest for a batch whose bytes are already stored.
 *
 * Split out from any exporter so the integrity format is testable on its own
 * and identical whichever implementation eventually calls it: the checksum and
 * the size come from the `PutObjectResult` the PORT returned — what the store
 * says it actually wrote — rather than from what the exporter believed it sent.
 * A manifest built from the caller's own intention proves nothing.
 */
export function manifestFor(args: {
  batchId: string;
  stored: PutObjectResult;
  recordCount: number;
  minOccurredAt: Date;
  maxOccurredAt: Date;
  schemaVersions: readonly number[];
  sources: readonly string[];
  retentionClasses: readonly RetentionClass[];
}): ArchiveManifest {
  return {
    batchId: args.batchId,
    recordCount: args.recordCount,
    minOccurredAt: args.minOccurredAt.toISOString(),
    maxOccurredAt: args.maxOccurredAt.toISOString(),
    checksum: args.stored.checksum,
    checksumAlgorithm: 'sha256',
    manifestVersion: 1,
    schemaVersions: [...new Set(args.schemaVersions)].sort((a, b) => a - b),
    sources: [...new Set(args.sources)].sort(),
    retentionClasses: [...new Set(args.retentionClasses)].sort(),
    objectKey: args.stored.key,
    format: 'parquet',
    createdAt: new Date().toISOString(),
  };
}

/**
 * The exporter, which refuses.
 *
 * Deliberately not a stub that silently succeeds. A no-op export is how a
 * platform comes to believe it has an archive it has never written a byte to,
 * and then deletes the hot rows.
 */
export async function exportArchiveBatch(): Promise<never> {
  const status = archiveStatus();
  throw new Error(
    status.enabled
      ? 'Fabric archive exporter is not implemented in this build'
      : `Fabric archive is not configured — set ${status.missing.join(', ')}`,
  );
}

/**
 * Whether an object may be written at all.
 *
 * One gate, so there is exactly one place an exporter has to consult and
 * exactly one place a test has to point at. No byte leaves this platform for an
 * archive while this returns false, and it returns false in this build.
 */
export function archiveWritesPermitted(): boolean {
  return archiveEnabled();
}

/**
 * Whether hot rows may be removed after an export.
 *
 * Always false here, and it is the more important half of the archive design.
 * An export STARTING is not an archive existing; a batch is only safe to
 * forget once its manifest has been read back and its checksum verified
 * against the bytes in the bucket, AND a retention policy has said that class
 * of record may go. This build has neither, so nothing is ever deleted.
 */
export function mayPurgeAfterArchive(): boolean {
  return false;
}
