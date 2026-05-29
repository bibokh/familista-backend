// Familista — Video Annotation / Telestration Engine (Phase Q)
// Target: src/video/video-annotation.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Telestration annotations attached to VideoClips.
// Shapes: ARROW, CIRCLE, RECTANGLE, FREEHAND, TEXT, ZONE.
// Coordinates are normalised 0–1 relative to the video frame so they are
// resolution-independent and can be rendered on any player viewport.
//
// replaceAnnotations() is the primary "save session" entry point — the
// frontend sends the full annotation set after an edit session and this
// atomically swaps all existing annotations in one transaction.

import { Prisma, VideoAnnotation } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export interface AnnotationActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface CreateAnnotationDto {
  clipId:        string;
  frameTimeSec:  number;        // timestamp within the clip (seconds)
  shape:         string;        // AnnotationShape enum: ARROW | CIRCLE | RECTANGLE | FREEHAND | TEXT | ZONE
  x:             number;        // normalised 0–1
  y:             number;        // normalised 0–1
  x2?:           number;        // endpoint for ARROW / RECTANGLE
  y2?:           number;
  points?:       number[][];    // [[x,y],...] for FREEHAND
  color?:        string;        // hex e.g. "#FF0000"
  text?:         string;        // body text for TEXT shape
  labelText?:    string;        // caption overlay on any shape
  strokeWidth?:  number;
  opacity?:      number;        // 0–1
  durationSec?:  number;        // how long annotation remains visible (null = rest of clip)
}

export interface UpdateAnnotationDto {
  x?:           number;
  y?:           number;
  x2?:          number;
  y2?:          number;
  points?:      number[][];
  color?:       string;
  text?:        string;
  labelText?:   string;
  strokeWidth?: number;
  opacity?:     number;
  durationSec?: number;
}

// ─── Single annotation CRUD ───────────────────────────────────────────────────

export async function createAnnotation(
  actor: AnnotationActor,
  dto: CreateAnnotationDto,
): Promise<VideoAnnotation> {
  _validateCoords(dto.x, dto.y);
  if (dto.x2 !== undefined && dto.y2 !== undefined) _validateCoords(dto.x2, dto.y2);
  if (dto.opacity !== undefined && (dto.opacity < 0 || dto.opacity > 1)) {
    throw new BadRequestError('opacity must be between 0 and 1');
  }
  if (dto.color && !/^#[0-9A-Fa-f]{6}$/.test(dto.color)) {
    throw new BadRequestError('color must be a 6-digit hex string, e.g. #FF0000');
  }

  const clip = await prisma.videoClip.findUnique({
    where:  { id: dto.clipId },
    select: { clubId: true, durationSec: true },
  });
  if (!clip) throw new NotFoundError('VideoClip');
  if (clip.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (dto.frameTimeSec < 0) throw new BadRequestError('frameTimeSec must be ≥ 0');
  if (clip.durationSec && dto.frameTimeSec > clip.durationSec) {
    throw new BadRequestError(`frameTimeSec ${dto.frameTimeSec} exceeds clip duration ${clip.durationSec}`);
  }

  return prisma.videoAnnotation.create({
    data: _buildData(actor, dto),
  });
}

export async function updateAnnotation(
  actor: AnnotationActor,
  id: string,
  dto: UpdateAnnotationDto,
): Promise<VideoAnnotation> {
  await _assertOwner(actor, id);

  if (dto.x !== undefined || dto.y !== undefined) {
    _validateCoords(dto.x ?? 0, dto.y ?? 0);
  }
  if (dto.opacity !== undefined && (dto.opacity < 0 || dto.opacity > 1)) {
    throw new BadRequestError('opacity must be between 0 and 1');
  }

  return prisma.videoAnnotation.update({
    where: { id },
    data: {
      ...(dto.x           !== undefined ? { x: dto.x }                                       : {}),
      ...(dto.y           !== undefined ? { y: dto.y }                                       : {}),
      ...(dto.x2          !== undefined ? { x2: dto.x2 }                                     : {}),
      ...(dto.y2          !== undefined ? { y2: dto.y2 }                                     : {}),
      ...(dto.points      !== undefined ? { points: dto.points as unknown as Prisma.InputJsonValue } : {}),
      ...(dto.color       !== undefined ? { color: dto.color }                               : {}),
      ...(dto.text        !== undefined ? { text: dto.text }                                 : {}),
      ...(dto.labelText   !== undefined ? { labelText: dto.labelText }                       : {}),
      ...(dto.strokeWidth !== undefined ? { strokeWidth: dto.strokeWidth }                   : {}),
      ...(dto.opacity     !== undefined ? { opacity: dto.opacity }                           : {}),
      ...(dto.durationSec !== undefined ? { durationSec: dto.durationSec }                   : {}),
    },
  });
}

export async function listAnnotations(
  actor: AnnotationActor,
  clipId: string,
): Promise<VideoAnnotation[]> {
  const clip = await prisma.videoClip.findUnique({ where: { id: clipId }, select: { clubId: true } });
  if (!clip) throw new NotFoundError('VideoClip');
  if (clip.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  return prisma.videoAnnotation.findMany({
    where:   { clipId, clubId: actor.clubId },
    orderBy: { frameTimeSec: 'asc' },
  });
}

export async function deleteAnnotation(actor: AnnotationActor, id: string): Promise<void> {
  await _assertOwner(actor, id);
  await prisma.videoAnnotation.delete({ where: { id } });
}

// ─── Bulk replace (used by editor "save session") ─────────────────────────────

/**
 * Atomically replace all annotations on a clip.
 * The frontend sends the full annotation set after a telestration session;
 * stale annotations are removed and the new set is inserted in one transaction.
 */
export async function replaceAnnotations(
  actor: AnnotationActor,
  clipId: string,
  dtos: CreateAnnotationDto[],
): Promise<VideoAnnotation[]> {
  const clip = await prisma.videoClip.findUnique({ where: { id: clipId }, select: { clubId: true } });
  if (!clip) throw new NotFoundError('VideoClip');
  if (clip.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  if (dtos.length > 500) {
    throw new BadRequestError('Cannot save more than 500 annotations per clip');
  }

  return prisma.$transaction(async (tx) => {
    await tx.videoAnnotation.deleteMany({ where: { clipId, clubId: actor.clubId } });
    return Promise.all(
      dtos.map((dto) =>
        tx.videoAnnotation.create({ data: _buildData(actor, { ...dto, clipId }) }),
      ),
    );
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _validateCoords(x: number, y: number): void {
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    throw new BadRequestError('Annotation coordinates must be normalised between 0 and 1');
  }
}

function _buildData(
  actor: AnnotationActor,
  dto: CreateAnnotationDto,
): Prisma.VideoAnnotationCreateInput {
  return {
    clip:        { connect: { id: dto.clipId } },
    clubId:      actor.clubId,
    createdBy:   actor.userId,
    frameTimeSec: dto.frameTimeSec,
    shape:       dto.shape as any,
    x:           dto.x,
    y:           dto.y,
    x2:          dto.x2          ?? null,
    y2:          dto.y2          ?? null,
    points:      dto.points      ? (dto.points as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    color:       dto.color       ?? '#FF0000',
    text:        dto.text        ?? null,
    labelText:   dto.labelText   ?? null,
    strokeWidth: dto.strokeWidth ?? 2,
    opacity:     dto.opacity     ?? 1.0,
    durationSec: dto.durationSec ?? null,
  };
}

async function _assertOwner(actor: AnnotationActor, id: string): Promise<VideoAnnotation> {
  const ann = await prisma.videoAnnotation.findUnique({ where: { id } });
  if (!ann) throw new NotFoundError('VideoAnnotation');
  if (ann.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return ann;
}
