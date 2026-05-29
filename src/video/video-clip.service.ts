// Familista — Video Clip & Playlist Engine (Phase Q)
// Target: src/video/video-clip.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// VideoClips are time-bounded segments of a VideoAsset.
// Share tokens enable external (unauthenticated) clip access with optional expiry.
// Playlists aggregate ordered clips for team presentations and dossiers.

import { Prisma, VideoClip, VideoPlaylist, VideoPlaylistItem } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import crypto from 'crypto';

export interface ClipActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

export interface CreateClipDto {
  assetId:      string;
  title:        string;
  description?: string;
  startSec:     number;
  endSec:       number;
  teamId?:      string;
  playerId?:    string;
  matchId?:     string;
  tags?:        string[];
}

export interface UpdateClipDto {
  title?:       string;
  description?: string;
  startSec?:    number;
  endSec?:      number;
  tags?:        string[];
}

export interface ShareClipDto {
  clipId:         string;
  sharedWithIds?: string[];   // userId[] who can view
  expiresAt?:     string;     // ISO datetime
}

export interface CreatePlaylistDto {
  title:        string;
  description?: string;
  teamId?:      string;
  clipIds?:     string[];     // initial ordered clip IDs
}

// ─── Clips ───────────────────────────────────────────────────────────────────

export async function createClip(actor: ClipActor, dto: CreateClipDto): Promise<VideoClip> {
  if (dto.startSec < 0) throw new BadRequestError('startSec must be ≥ 0');
  if (dto.endSec <= dto.startSec) throw new BadRequestError('endSec must be > startSec');
  if (dto.endSec - dto.startSec > 7200) throw new BadRequestError('Clip duration cannot exceed 2 hours');

  const asset = await prisma.videoAsset.findUnique({
    where:  { id: dto.assetId },
    select: { clubId: true, durationSec: true, status: true },
  });
  if (!asset) throw new NotFoundError('VideoAsset');
  if (asset.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (asset.status !== 'READY') throw new BadRequestError('VideoAsset must be READY before clipping');
  if (asset.durationSec && dto.endSec > asset.durationSec) {
    throw new BadRequestError(`endSec ${dto.endSec} exceeds asset duration ${asset.durationSec}`);
  }

  return prisma.videoClip.create({
    data: {
      assetId:     dto.assetId,
      clubId:      actor.clubId,
      title:       dto.title.trim(),
      description: dto.description?.trim() ?? null,
      startSec:    dto.startSec,
      endSec:      dto.endSec,
      durationSec: +(dto.endSec - dto.startSec).toFixed(3),
      teamId:      dto.teamId   ?? null,
      playerId:    dto.playerId ?? null,
      matchId:     dto.matchId  ?? null,
      tags:        dto.tags ?? [],
      createdBy:   actor.userId,
    },
  });
}

export async function updateClip(actor: ClipActor, clipId: string, dto: UpdateClipDto): Promise<VideoClip> {
  const clip = await _assertClipOwner(actor, clipId);

  const newStart = dto.startSec ?? clip.startSec;
  const newEnd   = dto.endSec   ?? clip.endSec;
  if (newEnd <= newStart) throw new BadRequestError('endSec must be > startSec');

  return prisma.videoClip.update({
    where: { id: clipId },
    data: {
      ...(dto.title       !== undefined ? { title: dto.title.trim() }             : {}),
      ...(dto.description !== undefined ? { description: dto.description?.trim() } : {}),
      ...(dto.startSec    !== undefined ? { startSec: dto.startSec }              : {}),
      ...(dto.endSec      !== undefined ? { endSec: dto.endSec }                  : {}),
      ...(dto.startSec !== undefined || dto.endSec !== undefined
        ? { durationSec: +(newEnd - newStart).toFixed(3) }
        : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
    },
  });
}

export async function getClip(actor: ClipActor, clipId: string): Promise<VideoClip> {
  return _assertClipOwner(actor, clipId);
}

export async function listClips(
  actor: ClipActor,
  opts: { assetId?: string; playerId?: string; matchId?: string; limit?: number; offset?: number } = {},
): Promise<{ items: VideoClip[]; total: number }> {
  const { limit = 50, offset = 0 } = opts;
  const where: Prisma.VideoClipWhereInput = {
    clubId: actor.clubId,
    ...(opts.assetId  ? { assetId:  opts.assetId }  : {}),
    ...(opts.playerId ? { playerId: opts.playerId } : {}),
    ...(opts.matchId  ? { matchId:  opts.matchId }  : {}),
  };
  const [items, total] = await Promise.all([
    prisma.videoClip.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      skip: offset,
    }),
    prisma.videoClip.count({ where }),
  ]);
  return { items, total };
}

export async function deleteClip(actor: ClipActor, clipId: string): Promise<void> {
  await _assertClipOwner(actor, clipId);
  await prisma.videoClip.delete({ where: { id: clipId } });
}

// ─── Share tokens ─────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random share token for external (unauthenticated) access.
 * Returns the updated clip with shareToken populated.
 */
export async function shareClip(actor: ClipActor, dto: ShareClipDto): Promise<VideoClip> {
  await _assertClipOwner(actor, dto.clipId);

  const shareToken = crypto.randomBytes(24).toString('base64url');

  return prisma.videoClip.update({
    where: { id: dto.clipId },
    data: {
      shareToken,
      shareExpiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      sharedWithIds:  dto.sharedWithIds ?? [],
    },
  });
}

/** Revoke the share token. Clip becomes private again. */
export async function revokeShare(actor: ClipActor, clipId: string): Promise<VideoClip> {
  await _assertClipOwner(actor, clipId);
  return prisma.videoClip.update({
    where: { id: clipId },
    data:  { shareToken: null, shareExpiresAt: null, sharedWithIds: [] },
  });
}

/** Resolve a clip by share token — used by the unauthenticated public route. */
export async function getClipByShareToken(shareToken: string): Promise<VideoClip> {
  const clip = await prisma.videoClip.findFirst({
    where: {
      shareToken,
      OR: [{ shareExpiresAt: null }, { shareExpiresAt: { gt: new Date() } }],
    },
  });
  if (!clip) throw new NotFoundError('VideoClip (token expired or invalid)');
  return clip;
}

// ─── Playlists ────────────────────────────────────────────────────────────────

export async function createPlaylist(
  actor: ClipActor,
  dto: CreatePlaylistDto,
): Promise<VideoPlaylist> {
  const playlist = await prisma.videoPlaylist.create({
    data: {
      clubId:      actor.clubId,
      title:       dto.title.trim(),
      description: dto.description?.trim() ?? null,
      teamId:      dto.teamId ?? null,
      createdBy:   actor.userId,
    },
  });

  if (dto.clipIds && dto.clipIds.length > 0) {
    await prisma.videoPlaylistItem.createMany({
      data: dto.clipIds.map((clipId, i) => ({
        playlistId: playlist.id,
        clipId,
        position:   i + 1,
        clubId:     actor.clubId,
      })),
      skipDuplicates: true,
    });
  }

  return playlist;
}

export async function addClipToPlaylist(
  actor: ClipActor,
  playlistId: string,
  clipId: string,
): Promise<VideoPlaylistItem> {
  await _assertPlaylistOwner(actor, playlistId);
  await _assertClipOwner(actor, clipId);

  const agg = await prisma.videoPlaylistItem.aggregate({
    where:  { playlistId },
    _max:   { position: true },
  });
  const position = (agg._max.position ?? 0) + 1;

  return prisma.videoPlaylistItem.create({
    data: { playlistId, clipId, position, clubId: actor.clubId },
  });
}

export async function removeClipFromPlaylist(
  actor: ClipActor,
  playlistId: string,
  clipId: string,
): Promise<void> {
  await _assertPlaylistOwner(actor, playlistId);
  await prisma.videoPlaylistItem.deleteMany({ where: { playlistId, clipId } });
}

export async function reorderPlaylist(
  actor: ClipActor,
  playlistId: string,
  orderedClipIds: string[],
): Promise<void> {
  await _assertPlaylistOwner(actor, playlistId);
  await prisma.$transaction(
    orderedClipIds.map((clipId, i) =>
      prisma.videoPlaylistItem.updateMany({
        where: { playlistId, clipId },
        data:  { position: i + 1 },
      }),
    ),
  );
}

export async function getPlaylist(
  actor: ClipActor,
  playlistId: string,
): Promise<VideoPlaylist & { items: VideoPlaylistItem[] }> {
  const playlist = await _assertPlaylistOwner(actor, playlistId);
  const items    = await prisma.videoPlaylistItem.findMany({
    where:   { playlistId },
    orderBy: { position: 'asc' },
  });
  return { ...playlist, items };
}

export async function listPlaylists(
  actor: ClipActor,
  opts: { teamId?: string; limit?: number; offset?: number } = {},
): Promise<{ items: VideoPlaylist[]; total: number }> {
  const { limit = 20, offset = 0 } = opts;
  const where: Prisma.VideoPlaylistWhereInput = {
    clubId: actor.clubId,
    ...(opts.teamId ? { teamId: opts.teamId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.videoPlaylist.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: Math.min(limit, 100),
      skip: offset,
    }),
    prisma.videoPlaylist.count({ where }),
  ]);
  return { items, total };
}

export async function deletePlaylist(actor: ClipActor, playlistId: string): Promise<void> {
  await _assertPlaylistOwner(actor, playlistId);
  await prisma.$transaction([
    prisma.videoPlaylistItem.deleteMany({ where: { playlistId } }),
    prisma.videoPlaylist.delete({ where: { id: playlistId } }),
  ]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _assertClipOwner(actor: ClipActor, clipId: string): Promise<VideoClip> {
  const clip = await prisma.videoClip.findUnique({ where: { id: clipId } });
  if (!clip) throw new NotFoundError('VideoClip');
  if (clip.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return clip;
}

async function _assertPlaylistOwner(actor: ClipActor, playlistId: string): Promise<VideoPlaylist> {
  const pl = await prisma.videoPlaylist.findUnique({ where: { id: playlistId } });
  if (!pl) throw new NotFoundError('VideoPlaylist');
  if (pl.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return pl;
}
