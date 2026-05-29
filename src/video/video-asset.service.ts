// Familista — Video Asset Engine (Phase Q)
// Target: src/video/video-asset.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Full lifecycle for VideoAsset:
//   1. requestUpload  → presigned PUT URL so the client writes directly to S3
//   2. confirmUpload  → mark UPLOADED, enqueue VideoTranscodeJob
//   3. handleTranscodeCallback → set HLS manifest key, CDN URL, READY status
//   4. getStreamUrl   → signed HLS + thumbnail URLs for playback
//
// Storage layout (S3 / R2 / MinIO):
//   Raw   : clubs/{clubId}/videos/{assetId}/raw.{ext}
//   HLS   : clubs/{clubId}/videos/{assetId}/hls/manifest.m3u8
//   Thumb : clubs/{clubId}/videos/{assetId}/thumb.jpg
//
// Env vars required:
//   VIDEO_S3_REGION, VIDEO_S3_ENDPOINT (optional, for R2/MinIO)
//   VIDEO_S3_ACCESS_KEY_ID, VIDEO_S3_SECRET_ACCESS_KEY
//   VIDEO_BUCKET, VIDEO_CDN_BASE_URL

import type { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Prisma, VideoAsset } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface VideoActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─── S3 client (singleton) ───────────────────────────────────────────────────

let _s3: S3Client | null = null;

function s3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region:   process.env.VIDEO_S3_REGION   ?? 'auto',
      endpoint: process.env.VIDEO_S3_ENDPOINT ?? undefined,
      credentials: {
        accessKeyId:     process.env.VIDEO_S3_ACCESS_KEY_ID     ?? '',
        secretAccessKey: process.env.VIDEO_S3_SECRET_ACCESS_KEY ?? '',
      },
    });
  }
  return _s3;
}

const BUCKET     = () => process.env.VIDEO_BUCKET       ?? 'familista-video';
const CDN_BASE   = () => (process.env.VIDEO_CDN_BASE_URL ?? '').replace(/\/$/, '');
const UPLOAD_TTL = 3600;     // presigned URL valid 1 hour
const STREAM_TTL = 300;      // presigned GET valid 5 min (fallback when no CDN)
const MAX_MB     = 2048;     // 2 GB per upload
const ALLOWED    = ['mp4', 'mov', 'avi', 'mkv', 'webm'];

// ─── DTOs ────────────────────────────────────────────────────────────────────

export interface RequestUploadDto {
  title:        string;
  description?: string;
  sourceKind:   string;   // VideoSourceKind
  matchId?:     string;
  teamId?:      string;
  filename:     string;   // e.g. "match-vs-city.mp4"
  fileSizeMb?:  number;
  tags?:        string[];
}

export interface ConfirmUploadDto {
  assetId: string;
  etag?:   string;
}

export interface TranscodeCallbackDto {
  assetId:         string;
  hlsManifestKey?: string;
  thumbStorageKey?: string;
  durationSec?:    number;
  widthPx?:        number;
  heightPx?:       number;
  errorMessage?:   string;
}

// ─── Phase 1: request upload ─────────────────────────────────────────────────

export async function requestUpload(
  actor: VideoActor,
  dto: RequestUploadDto,
): Promise<{ asset: VideoAsset; uploadUrl: string; uploadKey: string }> {
  const ext = dto.filename.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED.includes(ext)) {
    throw new BadRequestError(`Extension .${ext} not allowed. Accepted: ${ALLOWED.join(', ')}`);
  }
  if (dto.fileSizeMb && dto.fileSizeMb > MAX_MB) {
    throw new BadRequestError(`File size exceeds ${MAX_MB} MB limit`);
  }

  // Create asset row to obtain a stable ID for the storage key.
  const asset = await prisma.videoAsset.create({
    data: {
      clubId:      actor.clubId,
      title:       dto.title.trim(),
      description: dto.description?.trim() ?? null,
      sourceKind:  dto.sourceKind as any,
      matchId:     dto.matchId ?? null,
      teamId:      dto.teamId  ?? null,
      status:      'PENDING',
      tags:        dto.tags ?? [],
      uploadedBy:  actor.userId,
    },
  });

  const rawKey = `clubs/${actor.clubId}/videos/${asset.id}/raw.${ext}`;

  const cmd = new PutObjectCommand({
    Bucket:      BUCKET(),
    Key:         rawKey,
    ContentType: _extToMime(ext),
    Metadata:    { assetId: asset.id, clubId: actor.clubId },
  });
  const uploadUrl = await getSignedUrl(s3(), cmd, { expiresIn: UPLOAD_TTL });

  const updated = await prisma.videoAsset.update({
    where: { id: asset.id },
    data:  { rawStorageKey: rawKey },
  });

  return { asset: updated, uploadUrl, uploadKey: rawKey };
}

// ─── Phase 2: confirm upload ─────────────────────────────────────────────────

export async function confirmUpload(actor: VideoActor, dto: ConfirmUploadDto): Promise<VideoAsset> {
  const asset = await _assertOwner(actor, dto.assetId);
  if (asset.status !== 'PENDING') {
    throw new BadRequestError(`Asset is in ${asset.status} state — expected PENDING`);
  }

  const updated = await prisma.videoAsset.update({
    where: { id: asset.id },
    data:  { status: 'UPLOADED', uploadedAt: new Date() },
  });

  // Enqueue transcode job for VideoTranscodeWorker (Phase R).
  await prisma.videoTranscodeJob.create({
    data: {
      assetId:  asset.id,
      clubId:   actor.clubId,
      status:   'QUEUED',
      priority: 5,
      queuedAt: new Date(),
    },
  });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action:     'VIDEO_UPLOAD_CONFIRMED',
    entityType: 'VideoAsset',
    entityId:   asset.id,
    payload:    { rawStorageKey: asset.rawStorageKey },
  });

  return updated;
}

// ─── Phase 3: transcode callback (called by worker) ──────────────────────────

export async function handleTranscodeCallback(dto: TranscodeCallbackDto): Promise<VideoAsset> {
  const asset = await prisma.videoAsset.findUnique({ where: { id: dto.assetId } });
  if (!asset) throw new NotFoundError('VideoAsset');

  if (dto.errorMessage) {
    return prisma.videoAsset.update({
      where: { id: dto.assetId },
      data:  { status: 'FAILED', transcodedAt: new Date() },
    });
  }

  return prisma.videoAsset.update({
    where: { id: dto.assetId },
    data:  {
      status:          'READY',
      hlsManifestKey:  dto.hlsManifestKey  ?? null,
      cdnBaseUrl:      CDN_BASE() || null,
      durationSec:     dto.durationSec     ?? null,
      widthPx:         dto.widthPx         ?? null,
      heightPx:        dto.heightPx        ?? null,
      thumbStorageKey: dto.thumbStorageKey ?? null,
      transcodedAt:    new Date(),
    },
  });
}

// ─── Streaming ───────────────────────────────────────────────────────────────

export async function getStreamUrl(
  actor: VideoActor,
  assetId: string,
): Promise<{ hlsUrl: string; thumbUrl: string }> {
  const asset = await _assertOwner(actor, assetId);
  if (asset.status !== 'READY') {
    throw new BadRequestError(`Video is not ready for streaming (status: ${asset.status})`);
  }

  const hlsKey   = asset.hlsManifestKey!;
  const thumbKey = asset.thumbStorageKey;

  if (CDN_BASE()) {
    return {
      hlsUrl:   `${CDN_BASE()}/${hlsKey}`,
      thumbUrl: thumbKey ? `${CDN_BASE()}/${thumbKey}` : '',
    };
  }

  // Fallback: short-lived presigned GET URLs.
  const hlsUrl = await getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: BUCKET(), Key: hlsKey }),
    { expiresIn: STREAM_TTL },
  );
  const thumbUrl = thumbKey
    ? await getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET(), Key: thumbKey }), { expiresIn: STREAM_TTL })
    : '';

  return { hlsUrl, thumbUrl };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export interface ListAssetsOpts {
  matchId?:    string;
  teamId?:     string;
  sourceKind?: string;
  status?:     string;
  limit?:      number;
  offset?:     number;
}

export async function listAssets(
  actor: VideoActor,
  opts: ListAssetsOpts = {},
): Promise<{ items: VideoAsset[]; total: number }> {
  const { limit = 20, offset = 0 } = opts;
  const where: Prisma.VideoAssetWhereInput = {
    clubId: actor.clubId,
    ...(opts.matchId    ? { matchId:    opts.matchId }          : {}),
    ...(opts.teamId     ? { teamId:     opts.teamId }           : {}),
    ...(opts.sourceKind ? { sourceKind: opts.sourceKind as any } : {}),
    ...(opts.status     ? { status:     opts.status as any }    : {}),
  };
  const [items, total] = await Promise.all([
    prisma.videoAsset.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      skip: offset,
    }),
    prisma.videoAsset.count({ where }),
  ]);
  return { items, total };
}

export async function getAsset(actor: VideoActor, assetId: string): Promise<VideoAsset> {
  return _assertOwner(actor, assetId);
}

export async function deleteAsset(actor: VideoActor, assetId: string): Promise<void> {
  const asset = await _assertOwner(actor, assetId);

  // Best-effort S3 cleanup.
  if (asset.rawStorageKey) {
    s3().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: asset.rawStorageKey })).catch(() => {});
  }

  await prisma.videoAsset.delete({ where: { id: assetId } });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'VIDEO_ASSET_DELETED', entityType: 'VideoAsset', entityId: assetId,
    payload: {},
  });
}

// ─── HLS streaming proxy ─────────────────────────────────────────────────────
// Used by the /video/assets/:assetId/hls/:filename route.
// Proxies HLS manifest + segment bytes through Express so the client
// never needs to hit S3 directly (no CORS / presigned URL complexity).

export interface HlsFileStream {
  body:        Readable;
  contentType: string;
}

export async function streamHlsFile(
  actor:    VideoActor,
  assetId:  string,
  filename: string,
): Promise<HlsFileStream> {
  // Validate filename is a safe HLS filename.
  if (!/^[\w.\-]+$/.test(filename)) throw new BadRequestError('Invalid HLS filename');
  if (!filename.endsWith('.m3u8') && !filename.endsWith('.ts')) {
    throw new BadRequestError('Only .m3u8 and .ts files are served via this endpoint');
  }

  const asset = await _assertOwner(actor, assetId);
  if (asset.status !== 'READY') throw new BadRequestError('Video is not ready for streaming');

  const key = `clubs/${actor.clubId}/videos/${assetId}/hls/${filename}`;
  const cmd = new GetObjectCommand({ Bucket: BUCKET(), Key: key });
  const obj = await s3().send(cmd);

  return {
    body:        obj.Body as Readable,
    contentType: filename.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : 'video/mp2t',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _assertOwner(actor: VideoActor, assetId: string): Promise<VideoAsset> {
  const asset = await prisma.videoAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new NotFoundError('VideoAsset');
  if (asset.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return asset;
}

function _extToMime(ext: string): string {
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
  };
  return map[ext] ?? 'application/octet-stream';
}
