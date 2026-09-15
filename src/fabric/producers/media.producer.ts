// The Media domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// ONE SOURCE. Images, video, audio, documents, match footage, training footage,
// thumbnails and the transcode pipeline are one source and one lane. They are
// told apart by their event NAME and by `mediaCategory`, never by a card of
// their own.
//
// WHAT NEVER TRAVELS
//
// No bytes, obviously. But the interesting half of this producer is the things
// that look like metadata and are not:
//
//   · a STORAGE KEY, a bucket, a CDN base, an HLS manifest key, a thumbnail key
//     or a signed URL. None of them travel, in any form. The fabric must not
//     become a second way to reach an object that the read path authorises.
//   · a CHECKSUM. The event this producer replaces carried one. A content hash
//     is a confirmation oracle: anybody holding a file can ask the stream
//     whether this club holds that exact file, and get an answer. It is gone.
//   · a FILENAME. `Tomas-U15-knee-scan.mp4` is a child's name, an age group and
//     a medical fact in one string, and it is the field most likely to hold one.
//   · a TITLE, a DESCRIPTION, TAGS or a metadata blob. All user-entered, and on
//     a video asset they are frequently private tactical analysis.
//   · an ERROR MESSAGE from the transcoder, which quotes paths and filenames.
//   · a raw SIZE or DURATION. Both are permitted as BUCKETS and travel as
//     buckets: an exact byte count is a fingerprint in the same way a checksum
//     is, and an exact duration identifies a specific recording.
//
// MEDIA IS NOT AI
//
// A video being uploaded, transcoded and made ready is Media. A model watching
// it is not, and none of `media.analysis.*` is registered here — that family
// belongs to `source = ai`, and registering it under Media would settle a
// question this change has no business settling. The two already meet cleanly
// in the code: the vision ingest pipeline has its own job model and its own
// service, and nothing in this file touches either.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const MEDIA_SOURCE_ID = 'media';

const token = (max = 40) => z.string().min(1).max(max).nullable();

/** What kind of thing it is. `MediaType`, or `VIDEO` for a video asset. */
const mediaCategory = token();

/** What it is FOR. `MediaPurpose` — a crest, an avatar, match footage. */
const purpose = token();

/** `video/mp4`. Technical, and says nothing about whoever is in it. */
const mimeType = token(120);

/** Where a video came from. `MATCH`, `TRAINING` — the shape, not the fixture. */
const sourceKind = token();

/** SENIOR, ACADEMY_U17. From the team, never from a person. */
const teamKind = token();

/**
 * How big, as a BUCKET.
 *
 * §3 permits a file-size bucket and this is one. An exact byte count is not a
 * bucket: it identifies a specific file about as well as a checksum does, which
 * is why the exact figure stays in the row.
 */
const sizeBucket = z.enum(['UNDER_1MB', 'UNDER_10MB', 'UNDER_100MB', 'UNDER_1GB', 'OVER_1GB']).nullable();

/** How long, as a BUCKET, for the same reason. */
const durationBucket = z.enum(['UNDER_1MIN', 'UNDER_10MIN', 'UNDER_1HR', 'OVER_1HR']).nullable();

/** Which step of the pipeline. One today; the enum is where a second goes. */
const processingStage = z.enum(['TRANSCODE']);

const context = { teamKind };

export function registerMediaProducer(): void {
  // `media.created`, `media.processed` and `media.deleted` are already in
  // `event-taxonomy.ts`. Two of them are produced here.
  //
  // BOTH MOVE TO SCHEMA VERSION 2, and their v1 shapes stay registered in
  // `core-schemas.ts`. A payload shape is a historical contract: the events
  // already written to the outbox were validated against v1, and editing that
  // registration would retroactively describe them as something they are not.
  // The registry refuses it outright, which is the correct answer — so the
  // narrower shape is a NEW VERSION, and an older consumer reading v1 events
  // is unaffected.

  registerFabricSchema({
    eventType: 'media.created', version: 2,
    // What it is, what it is for, roughly how big. Never the key, the
    // checksum, the provider or the filename — the event this replaces
    // carried a checksum and a storage provider, and both are gone.
    describes: 'What kind of asset exists. Never where it is or what is in it',
    schema: z.object({ mediaCategory, purpose, mimeType, sizeBucket, ...context }).strict(),
  });

  registerFabricSchema({
    eventType: 'media.deleted', version: 2,
    describes: 'That an asset was withdrawn, and whether its bytes went with it',
    schema: z.object({ mediaCategory, purgedObject: z.boolean(), ...context }).strict(),
  });

  registerFabricEvent({
    type: 'media.updated',
    describes: 'A media asset’s details were amended',
    classification: 'INTERNAL',
    entityType: 'MEDIA_ASSET',
  });
  registerFabricSchema({
    eventType: 'media.updated', version: 1,
    // Field NAMES, as every other producer does — `title` and `description`
    // are innocuous as names and forbidden as values. This is not the medical
    // case, where the name itself is a clinical hint.
    describes: 'Which fields moved. Never what they moved to',
    schema: z.object({
      changedFields: z.array(z.string().min(1).max(40)).max(24),
      ...context,
    }).strict(),
  });

  // ── the upload ─────────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'media.upload.started',
    describes: 'An upload slot was opened for a new asset',
    classification: 'INTERNAL',
    entityType: 'MEDIA_ASSET',
  });
  registerFabricSchema({
    eventType: 'media.upload.started', version: 1,
    // The signed upload URL this step produces is the single most dangerous
    // string in the module: it is a time-limited write credential for the
    // bucket. It is not on the event, and the schema has nowhere to put one.
    describes: 'That an upload began. Never the URL it was given',
    schema: z.object({ mediaCategory, sourceKind, sizeBucket, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'media.upload.completed',
    describes: 'An upload was confirmed and queued for processing',
    classification: 'INTERNAL',
    entityType: 'MEDIA_ASSET',
  });
  registerFabricSchema({
    eventType: 'media.upload.completed', version: 1,
    describes: 'That the bytes arrived and work was queued',
    schema: z.object({ mediaCategory, sourceKind, ...context }).strict(),
  });

  // Declared, not produced. Familista records no failed upload: the checks that
  // can reject one — an extension, a size, a wrong state — all throw BEFORE
  // anything is written, so there is no persisted failure for an event to
  // describe. Publishing one from a thrown error would report a client mistake
  // as a platform occurrence. §6 allows this event only where the failure state
  // is genuinely observable, and here it is not.
  registerFabricEvent({
    type: 'media.upload.failed',
    describes: 'An upload was abandoned or rejected after it began',
    classification: 'INTERNAL',
    entityType: 'MEDIA_ASSET',
    produced: false,
  });
  registerFabricSchema({
    eventType: 'media.upload.failed', version: 1,
    describes: 'That an upload did not complete. Never the reason text',
    schema: z.object({ mediaCategory, ...context }).strict(),
  });

  // ── processing ─────────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'media.processing.started',
    describes: 'A worker claimed a transcode job',
    classification: 'INTERNAL',
    entityType: 'MEDIA_ASSET',
  });
  registerFabricSchema({
    eventType: 'media.processing.started', version: 1,
    // Published on the ATOMIC CLAIM, not on the intent to claim. Two workers
    // racing for one job produce one event, because only one `updateMany`
    // matches a row still QUEUED.
    describes: 'That work began, and on which attempt',
    schema: z.object({ processingStage, attempt: z.number().int().min(1).max(100), ...context }).strict(),
  });

  registerFabricEvent({
    type: 'media.processing.completed',
    describes: 'A media asset finished processing and is ready',
    classification: 'INTERNAL',
    entityType: 'MEDIA_ASSET',
  });
  registerFabricSchema({
    eventType: 'media.processing.completed', version: 1,
    // Not the HLS manifest key, not the thumbnail key, not the CDN base, not
    // the pixel dimensions of the master. A duration bucket and nothing else.
    describes: 'That it is ready, and roughly how long it runs',
    schema: z.object({ processingStage, durationBucket, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'media.processing.failed',
    describes: 'Processing of a media asset failed',
    classification: 'INTERNAL',
    entityType: 'MEDIA_ASSET',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'media.processing.failed', version: 1,
    // The transcoder's error text quotes storage paths and original filenames.
    // It stays in `VideoTranscodeJob.errorMsg`, read under authorisation.
    describes: 'That it failed. Never the error text',
    schema: z.object({ processingStage, ...context }).strict(),
  });

  // ── declared, produced by nothing ──────────────────────────────────────────

  // A media asset's subject is chosen when it is created and there is no flow
  // that moves one afterwards — no re-attach, no detach, no re-parent. The
  // names exist so the day such a flow is built it registers nothing new.
  for (const [type, describes] of [
    ['media.attached', 'A media asset was attached to a subject'],
    ['media.detached', 'A media asset was detached from its subject'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'INTERNAL', entityType: 'MEDIA_ASSET', produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'Which kind of thing moved, and to what kind of subject',
      schema: z.object({ mediaCategory, subjectKind: token(), ...context }).strict(),
    });
  }

  // Every transition an asset makes — uploaded, processing, ready, failed —
  // already has its own name above. A generic status event beside them would
  // be a second name for facts that already have one, which is the thing the
  // taxonomy's own doctrine warns about. Registered because it was asked for;
  // produced by nothing, on purpose.
  registerFabricEvent({
    type: 'media.status.changed',
    describes: 'A media asset’s processing status moved',
    classification: 'INTERNAL',
    entityType: 'MEDIA_ASSET',
    produced: false,
  });
  registerFabricSchema({
    eventType: 'media.status.changed', version: 1,
    describes: 'Which way the status went, as tokens',
    schema: z.object({ from: token(), to: token(), ...context }).strict(),
  });
}

registerMediaProducer();

// ── the helpers the Media flows call ─────────────────────────────────────────

/**
 * Which asset, and whose.
 *
 * `mediaId` is the asset — a file, not a person — and it is the one subject id
 * this change adds to the board's safe kinds. Without it an upload is four
 * unrelated dots instead of one story, and §3 names an opaque mediaId as
 * permitted metadata. An id is not a route: the read path still checks the
 * caller's club and still signs its own URLs.
 */
export interface MediaContext {
  mediaId: string;
  clubId: string | null;
  teamId?: string | null;
  /** SENIOR, ACADEMY_U17. Resolved by `media-context.ts` when not already known. */
  teamKind?: string | null;
  actorUserId?: string | null;
  sourceType?: EventSourceType;
}

function publish(
  eventType: string,
  ctx: MediaContext,
  extra: Record<string, unknown> = {},
): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId ?? null,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MEDIA_ASSET',
    subjectId: ctx.mediaId,
    sourceType: ctx.sourceType ?? 'SERVICE',
    payload: { ...extra, teamKind: ctx.teamKind ?? null },
  });
}

export type SizeBucket = z.infer<typeof sizeBucket>;
export type DurationBucket = z.infer<typeof durationBucket>;

/**
 * How big, roughly.
 *
 * Deliberately coarse, and deliberately not a number. A bucket answers "is this
 * a crest or a full match" — which is every operational question a board asks —
 * without identifying the file.
 */
export function bucketSize(bytes: number | bigint | null | undefined): SizeBucket {
  if (bytes === null || bytes === undefined) return null;
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024 * 1024) return 'UNDER_1MB';
  if (n < 10 * 1024 * 1024) return 'UNDER_10MB';
  if (n < 100 * 1024 * 1024) return 'UNDER_100MB';
  if (n < 1024 * 1024 * 1024) return 'UNDER_1GB';
  return 'OVER_1GB';
}

/** How long, roughly. Seconds in; a bucket out. */
export function bucketDuration(seconds: number | null | undefined): DurationBucket {
  if (seconds === null || seconds === undefined) return null;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 60) return 'UNDER_1MIN';
  if (n < 600) return 'UNDER_10MIN';
  if (n < 3600) return 'UNDER_1HR';
  return 'OVER_1HR';
}

export interface MediaFacts {
  mediaCategory?: string | null;
  purpose?: string | null;
  mimeType?: string | null;
  sourceKind?: string | null;
}

export function publishMediaCreated(
  ctx: MediaContext, facts: MediaFacts, bytes: number | bigint | null | undefined,
): void {
  publish('media.created', ctx, {
    mediaCategory: facts.mediaCategory ?? null,
    purpose: facts.purpose ?? null,
    mimeType: facts.mimeType ?? null,
    sizeBucket: bucketSize(bytes),
  });
}

export function publishMediaUpdated(ctx: MediaContext, changedFields: string[]): void {
  publish('media.updated', ctx, {
    changedFields: changedFields.filter((f) => typeof f === 'string').slice(0, 24),
  });
}

export function publishMediaDeleted(
  ctx: MediaContext, mediaCategory: string | null, purgedObject: boolean,
): void {
  publish('media.deleted', ctx, { mediaCategory, purgedObject });
}

export function publishMediaUploadStarted(
  ctx: MediaContext, facts: MediaFacts, bytes: number | bigint | null | undefined,
): void {
  publish('media.upload.started', ctx, {
    mediaCategory: facts.mediaCategory ?? null,
    sourceKind: facts.sourceKind ?? null,
    sizeBucket: bucketSize(bytes),
  });
}

export function publishMediaUploadCompleted(ctx: MediaContext, facts: MediaFacts): void {
  publish('media.upload.completed', ctx, {
    mediaCategory: facts.mediaCategory ?? null,
    sourceKind: facts.sourceKind ?? null,
  });
}

export function publishMediaProcessingStarted(ctx: MediaContext, attempt: number): void {
  publish('media.processing.started', ctx, {
    processingStage: 'TRANSCODE',
    attempt: Math.max(1, Math.min(100, Math.round(attempt))),
  });
}

export function publishMediaProcessingCompleted(
  ctx: MediaContext, seconds: number | null | undefined,
): void {
  publish('media.processing.completed', ctx, {
    processingStage: 'TRANSCODE', durationBucket: bucketDuration(seconds),
  });
}

export function publishMediaProcessingFailed(ctx: MediaContext): void {
  publish('media.processing.failed', ctx, { processingStage: 'TRANSCODE' });
}
