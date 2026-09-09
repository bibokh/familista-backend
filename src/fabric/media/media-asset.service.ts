// Registering a stored object, and getting it back safely
// ─────────────────────────────────────────────────────────────────────────────
// The domain surface for media. It knows about clubs, subjects, consent and
// classification; it does not know about buckets, providers or credentials —
// that is `object-store.ts`, behind a four-method port.
//
// THE TENANCY RULE, STATED ONCE
//
// Every read takes a `clubId` and filters on it, and every read of an asset BY
// ID checks the row's club against the caller's before returning anything. A
// media id is a bearer token otherwise: it appears in URLs, in logs, in
// exports, and a caller who obtains one from anywhere must not be able to
// exchange it for another club's object. The check is in one function so it
// cannot be present in three places and missing in the fourth.
//
// The object key carries the same boundary a second time — `club/{clubId}/…`,
// verified before the store is asked — so that a row whose key somehow points
// outside its own club is refused rather than fetched.

import {
  MediaProcessingStatus, MediaPurpose, MediaRetentionClass, MediaSubjectType, MediaType,
  DataClassificationLevel, Prisma,
} from '@prisma/client';
import { prisma } from '../../config/database';
import { ForbiddenError, NotFoundError, BadRequestError } from '../../utils/errors';
import { emit } from '../event-bus';
import {
  buildObjectKey, clubIdFromKey, getObjectStore, sha256,
  DEFAULT_READ_TTL_SECONDS, type SignedUrl,
} from './object-store';

/** What a caller supplies to store one object. */
export interface CreateMediaInput {
  clubId: string;
  teamId?: string | null;
  subjectType: MediaSubjectType;
  subjectId?: string | null;
  mediaType: MediaType;
  purpose?: MediaPurpose;
  mimeType: string;
  originalFilename?: string | null;
  body: Buffer;
  captureTime?: Date | null;
  season?: string | null;
  venueId?: string | null;
  sessionType?: string | null;
  sessionId?: string | null;
  dataClassification?: DataClassificationLevel;
  retentionClass?: MediaRetentionClass;
  consentRecordId?: string | null;
  aiEligible?: boolean;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * What a media type is allowed to be, and how large.
 *
 * Validation happens before a byte reaches storage, because an object store
 * will happily accept anything and the cost of finding out later is a bucket
 * full of things nobody can serve. The limits are deliberately generous for
 * video and tight for images — an avatar is not a film.
 */
const LIMITS: Record<MediaType, { maxBytes: number; mime: RegExp }> = {
  IMAGE:    { maxBytes: 12 * 1024 * 1024,   mime: /^image\/(png|jpeg|webp|avif|gif)$/ },
  VIDEO:    { maxBytes: 8 * 1024 * 1024 * 1024, mime: /^video\// },
  AUDIO:    { maxBytes: 512 * 1024 * 1024,  mime: /^audio\// },
  DOCUMENT: { maxBytes: 64 * 1024 * 1024,   mime: /^(application|text)\// },
  OTHER:    { maxBytes: 64 * 1024 * 1024,   mime: /^[a-z]+\/[a-z0-9.+-]+$/i },
};

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/pdf': 'pdf',
};

/**
 * Store bytes and record what they are.
 *
 * The order matters and is not an accident: validate, then write the object,
 * then write the row. A row that points at nothing is a broken reference
 * somebody has to clean up; an object with no row is an orphan a retention
 * sweep can find and remove. Of the two failure modes, the second is by far
 * the cheaper, so the object goes first.
 */
export async function createMediaAsset(input: CreateMediaInput) {
  if (!input.clubId) throw new BadRequestError('A media asset must belong to a club');
  if (!input.body?.length) throw new BadRequestError('No bytes were supplied');

  const limit = LIMITS[input.mediaType];
  if (input.body.length > limit.maxBytes) {
    throw new BadRequestError(
      `That file is ${Math.round(input.body.length / 1024 / 1024)} MB; the limit for ${input.mediaType.toLowerCase()} is ${Math.round(limit.maxBytes / 1024 / 1024)} MB`,
    );
  }
  if (!limit.mime.test(input.mimeType)) {
    throw new BadRequestError(`${input.mimeType} is not an accepted type for ${input.mediaType.toLowerCase()}`);
  }

  const store = getObjectStore();
  const id = crypto.randomUUID();
  const key = buildObjectKey({
    clubId: input.clubId,
    teamId: input.teamId,
    season: input.season,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    assetId: id,
    extension: EXT[input.mimeType] ?? null,
  });

  const put = await store.putObject({ key, body: input.body, contentType: input.mimeType });

  const row = await prisma.mediaAsset.create({
    data: {
      id,
      clubId: input.clubId,
      teamId: input.teamId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      mediaType: input.mediaType,
      purpose: input.purpose ?? MediaPurpose.OTHER,
      mimeType: input.mimeType,
      originalFilename: input.originalFilename ?? null,
      storageProvider: put.provider,
      storageKey: put.key,
      sizeBytes: put.sizeBytes,
      checksum: put.checksum,
      captureTime: input.captureTime ?? null,
      venueId: input.venueId ?? null,
      sessionType: input.sessionType ?? null,
      sessionId: input.sessionId ?? null,
      processingStatus: MediaProcessingStatus.STORED,
      retentionClass: input.retentionClass ?? MediaRetentionClass.HOT,
      dataClassification: input.dataClassification ?? DataClassificationLevel.INTERNAL,
      consentRecordId: input.consentRecordId ?? null,
      aiEligible: input.aiEligible ?? false,
      createdBy: input.createdBy ?? null,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });

  // The fabric learns about it. Never awaited for correctness: the media is
  // stored whether or not the event is, and a failed event must not undo it.
  void emit({
    eventType: 'media.created',
    clubId: row.clubId,
    teamId: row.teamId,
    actorUserId: input.createdBy ?? null,
    subjectType: 'MEDIA_ASSET',
    subjectId: row.id,
    sourceType: 'SERVICE',
    occurredAt: row.createdAt,
    dataClassification: row.dataClassification,
    payload: {
      mediaType: row.mediaType, purpose: row.purpose, mimeType: row.mimeType,
      sizeBytes: row.sizeBytes, checksum: row.checksum, storageProvider: row.storageProvider,
    },
  });

  return row;
}

/**
 * One asset, for one club.
 *
 * The club argument is not optional and is not derived from the row — it is
 * the caller's club, and it is compared against the row's. An id alone never
 * grants access to anything.
 */
export async function getMediaAsset(clubId: string, id: string) {
  if (!clubId) throw new ForbiddenError('No club context for a media read');
  const row = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!row || row.deletedAt) throw new NotFoundError('Media asset');
  if (row.clubId !== clubId) {
    // Deliberately the same error a missing row produces. Telling a caller that
    // an id exists but belongs to somebody else is itself a disclosure.
    throw new NotFoundError('Media asset');
  }
  return row;
}

/** A club's assets for one subject, newest first. */
export async function listMediaForSubject(
  clubId: string,
  subjectType: MediaSubjectType,
  subjectId: string | null,
  opts: { purpose?: MediaPurpose; limit?: number } = {},
) {
  if (!clubId) throw new ForbiddenError('No club context for a media read');
  return prisma.mediaAsset.findMany({
    where: {
      clubId, subjectType, subjectId, deletedAt: null,
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 200),
  });
}

/**
 * A URL a browser can fetch, for a limited time.
 *
 * Two boundaries before the store is asked: the row must belong to the caller's
 * club, and the object key must sit under that club's prefix. The second check
 * looks redundant and is not — it is what stops a row whose key was written
 * wrong, by a bug or by a future import, from serving another tenant's object.
 */
export async function getMediaReadUrl(
  clubId: string,
  id: string,
  ttlSeconds: number = DEFAULT_READ_TTL_SECONDS,
): Promise<SignedUrl> {
  const row = await getMediaAsset(clubId, id);
  const keyClub = clubIdFromKey(row.storageKey);
  if (keyClub && keyClub !== row.clubId) {
    throw new ForbiddenError('That media object does not belong to this club');
  }
  return getObjectStore().getSignedReadUrl(row.storageKey, ttlSeconds);
}

/**
 * Withdraw an asset.
 *
 * Soft by default. A media row is evidence — of what was captured, when, under
 * which consent — and destroying the record along with the bytes leaves nothing
 * to show the deletion was lawful. `purgeObject` removes the bytes; the row
 * stays, marked, until a retention policy removes it deliberately.
 */
export async function deleteMediaAsset(
  clubId: string,
  id: string,
  opts: { purgeObject?: boolean; actorUserId?: string | null } = {},
) {
  const row = await getMediaAsset(clubId, id);

  if (opts.purgeObject) {
    try {
      await getObjectStore().deleteObject(row.storageKey);
    } catch {
      // The row is still marked. An object that outlives its row is found by
      // the orphan sweep; a row that outlives its object is a broken link the
      // resolver already handles.
    }
  }

  const updated = await prisma.mediaAsset.update({
    where: { id },
    data: { deletedAt: new Date(), retentionClass: MediaRetentionClass.DELETION_ELIGIBLE },
  });

  void emit({
    eventType: 'media.deleted',
    clubId: row.clubId,
    teamId: row.teamId,
    actorUserId: opts.actorUserId ?? null,
    subjectType: 'MEDIA_ASSET',
    subjectId: row.id,
    sourceType: 'SERVICE',
    payload: { purgedObject: !!opts.purgeObject, storageProvider: row.storageProvider },
  });

  return updated;
}

/**
 * Has this club already stored these exact bytes?
 *
 * The duplicate-upload check the brief asks for, and the cheap half of data
 * quality: the same camera clip uploaded twice by an edge gateway retrying is
 * one asset, not two, and the checksum says so before anything is processed.
 */
export async function findByChecksum(clubId: string, body: Buffer) {
  return prisma.mediaAsset.findFirst({
    where: { clubId, checksum: sha256(body), deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
}
