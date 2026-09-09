// The images that are already there, and the migration that is not run
// ─────────────────────────────────────────────────────────────────────────────
// EXISTING BEHAVIOUR IS NOT CHANGED BY THIS FILE OR BY ANYTHING NEAR IT.
//
// Familista stores three kinds of image today, in three different ways:
//
//   Club crests      `Club.crestUrl` — an https:// URL, OR a `data:image/…`
//                    base64 string up to 400,000 characters (~300 KB), written
//                    straight into the text column.
//   Player photos    `Player.avatar` — the same two shapes, with NO length cap
//                    at all beyond the 2 MB JSON body limit. The interface
//                    PATCHes `{ avatar: dataUrl }`.
//   User avatars     `User.avatar` — same again.
//
//   White-label      `WhiteLabelAsset` — already correct: a storage key, a
//                    provider, a checksum and a URL, with LOCAL and S3 adapters.
//   Video            `VideoAsset` — already correct: presigned upload straight
//                    to object storage, Postgres holds the reference.
//
// So two of five media paths are right and three put bytes in Postgres. This
// file is the seam that lets new writes take the correct path while every
// existing value keeps working exactly as it does today, with no backfill and
// no production migration.
//
// HOW COMPATIBILITY WORKS
//
// `resolveImageRef` reads BOTH shapes. A legacy `data:` URL or https:// URL is
// returned as it is. A `media:` reference — what new writes produce — is
// resolved through `MediaAsset` to a signed URL. Callers ask this one function
// and never test the shape themselves, so the day the backfill runs, nothing
// downstream notices.
//
// THE MIGRATION THAT IS DESIGNED AND DELIBERATELY NOT RUN
//
// See `LEGACY_IMAGE_MIGRATION` at the bottom. It is a description, not a
// script. Running it is a separate, explicitly approved step.

import { MediaPurpose, MediaSubjectType, MediaType } from '@prisma/client';
import { getMediaReadUrl } from './media-asset.service';

/** The prefix a stored `MediaAsset` reference uses in a legacy column. */
export const MEDIA_REF_PREFIX = 'media:';

export type ImageRefKind = 'EMPTY' | 'DATA_URL' | 'HTTP_URL' | 'MEDIA_REF' | 'UNKNOWN';

export interface ImageRef {
  kind: ImageRefKind;
  /** Set for MEDIA_REF only. */
  mediaAssetId: string | null;
  /** Set for DATA_URL and HTTP_URL — usable by a browser as it stands. */
  directUrl: string | null;
  /** Bytes this value occupies in the database row. 0 for a reference. */
  inlineBytes: number;
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i;

/**
 * What is in this column?
 *
 * Pure, synchronous and side-effect free, so it can be used in a read path, a
 * report, or a migration dry-run without touching the database.
 */
export function classifyImageRef(value: string | null | undefined): ImageRef {
  const v = (value ?? '').trim();
  if (!v) return { kind: 'EMPTY', mediaAssetId: null, directUrl: null, inlineBytes: 0 };

  if (v.startsWith(MEDIA_REF_PREFIX)) {
    const id = v.slice(MEDIA_REF_PREFIX.length).trim();
    return { kind: 'MEDIA_REF', mediaAssetId: id || null, directUrl: null, inlineBytes: 0 };
  }
  if (DATA_URL.test(v)) {
    return { kind: 'DATA_URL', mediaAssetId: null, directUrl: v, inlineBytes: v.length };
  }
  if (/^https?:\/\//i.test(v)) {
    return { kind: 'HTTP_URL', mediaAssetId: null, directUrl: v, inlineBytes: v.length };
  }
  return { kind: 'UNKNOWN', mediaAssetId: null, directUrl: null, inlineBytes: v.length };
}

/**
 * Turn whatever is in the column into something a browser can load.
 *
 * The ONE function every image read should go through. A legacy value comes
 * back untouched — which is what "do not break current player, coach and club
 * images" means in code — and a reference is resolved, tenant-checked, through
 * the media service.
 *
 * Returns null rather than throwing when a reference cannot be resolved: an
 * unreadable crest is a missing picture, not a failed request, and the caller
 * renders its placeholder exactly as it does for a club that never set one.
 */
export async function resolveImageRef(
  clubId: string,
  value: string | null | undefined,
): Promise<string | null> {
  const ref = classifyImageRef(value);
  if (ref.kind === 'DATA_URL' || ref.kind === 'HTTP_URL') return ref.directUrl;
  if (ref.kind !== 'MEDIA_REF' || !ref.mediaAssetId) return null;
  try {
    const signed = await getMediaReadUrl(clubId, ref.mediaAssetId);
    return signed.url;
  } catch {
    return null;
  }
}

/** The reference form to write into a legacy column for a new asset. */
export function mediaRef(mediaAssetId: string): string {
  return `${MEDIA_REF_PREFIX}${mediaAssetId}`;
}

/** Decode a `data:` URL into bytes and a mime type, for the eventual backfill. */
export function decodeDataUrl(value: string): { body: Buffer; mimeType: string } | null {
  const m = DATA_URL.exec(value ?? '');
  if (!m) return null;
  const base64 = value.slice(value.indexOf(',') + 1);
  try {
    return { body: Buffer.from(base64, 'base64'), mimeType: m[1].toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Where each legacy column's contents would go.
 *
 * Read by the migration when it is eventually approved, and by the status
 * surface now, so the work is visible before it is done rather than discovered
 * during it.
 */
export const LEGACY_IMAGE_COLUMNS = Object.freeze([
  {
    table: 'Club',
    column: 'crestUrl',
    subjectType: MediaSubjectType.CLUB,
    mediaType: MediaType.IMAGE,
    purpose: MediaPurpose.CREST,
    cap: '400,000 characters (~300 KB), enforced in club.controller.ts',
  },
  {
    table: 'Player',
    column: 'avatar',
    subjectType: MediaSubjectType.PLAYER,
    mediaType: MediaType.IMAGE,
    purpose: MediaPurpose.PHOTO,
    cap: 'none — bounded only by the 2 MB JSON body limit',
  },
  {
    table: 'User',
    column: 'avatar',
    subjectType: MediaSubjectType.USER,
    mediaType: MediaType.IMAGE,
    purpose: MediaPurpose.AVATAR,
    cap: 'none — bounded only by the 2 MB JSON body limit',
  },
] as const);

/**
 * THE MIGRATION, DESCRIBED. NOT EXECUTED.
 *
 * Recorded here rather than in a document because the thing that goes stale is
 * the document. Every step below is reversible until the last one, and the last
 * one is deliberately separated by a verification window.
 *
 *   1 · READ-ONLY SURVEY. Count rows per column where the value is a `data:`
 *       URL, and sum their lengths. That number is the migration's size and
 *       nobody should start without it. No write.
 *
 *   2 · DUAL WRITE. New uploads create a `MediaAsset` and write `media:<id>`
 *       into the legacy column. Old values are untouched. Reads already handle
 *       both through `resolveImageRef`. Reversible by reverting the writer.
 *
 *   3 · BACKFILL, IN BATCHES, IDEMPOTENT. For each legacy `data:` value:
 *       decode it, store the bytes through the object store, create the
 *       `MediaAsset`, then replace the column with `media:<id>`. Keyed on the
 *       checksum so a re-run finds the existing asset instead of storing a
 *       second copy. A row that fails is skipped and reported, never
 *       half-written. Reversible while step 4 has not run.
 *
 *   4 · VERIFY, THEN RECLAIM. Confirm every column is a reference and every
 *       referenced object heads successfully. Only then does the space come
 *       back — Postgres does not release it on UPDATE alone, so this step is a
 *       `VACUUM FULL` or a table rewrite, and it is the first irreversible one.
 *
 *   5 · TIGHTEN. Only once nothing writes a `data:` URL any more: shorten the
 *       column's accepted shape at the controller, so the old form cannot
 *       return.
 *
 * NOT RUN BY THIS TASK. No production data is read, written or moved.
 */
export const LEGACY_IMAGE_MIGRATION = Object.freeze({
  status: 'DESIGNED_NOT_RUN' as const,
  steps: [
    'Read-only survey of data: URL rows and their total bytes',
    'Dual write: new uploads become MediaAsset + media: reference',
    'Idempotent batched backfill of existing data: URLs, keyed on checksum',
    'Verification, then space reclamation (first irreversible step)',
    'Tighten controller validation so data: URLs cannot return',
  ],
  reversibleUntil: 'step 4',
});
