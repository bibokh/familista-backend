// Familista — Tactical Annotations service (Phase G)
// Coach collaboration channel — append, edit, soft-delete, list.

import { Prisma, TacticalAnnotation } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { publish } from '../realtime/match-channel';

export interface AnnotationActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface CreateAnnotationDto {
  matchId:    string;
  atMs:       number;
  kind:       string;
  payload:    Prisma.InputJsonValue;
  visibility?: string;
}

export async function createAnnotation(actor: AnnotationActor, dto: CreateAnnotationDto): Promise<TacticalAnnotation> {
  if (!dto.matchId || !dto.kind) throw new BadRequestError('matchId, kind required');
  // Tenant gate on the match.
  const m = await prisma.match.findUnique({ where: { id: dto.matchId }, select: { clubId: true } });
  if (!m)                       throw new NotFoundError('Match');
  if (m.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  const row = await prisma.tacticalAnnotation.create({
    data: {
      clubId:    actor.clubId,
      matchId:   dto.matchId,
      authorId:  actor.userId,
      atMs:      BigInt(dto.atMs),
      kind:      dto.kind,
      payload:   dto.payload,
      visibility: dto.visibility ?? 'CLUB',
    },
  });
  try {
    publish({
      kind:    'AI_INSIGHT',
      matchId: dto.matchId,
      clubId:  actor.clubId,
      payload: { what: 'ANNOTATION', annotationId: row.id, authorId: actor.userId, kind: row.kind, atMs: dto.atMs },
    });
  } catch (_) {/* swallow */}
  return row;
}

export async function listAnnotations(actor: AnnotationActor, matchId: string, opts: { fromMs?: number; toMs?: number; limit?: number } = {}) {
  const m = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!m)                       throw new NotFoundError('Match');
  if (m.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.tacticalAnnotation.findMany({
    where: {
      matchId,
      isDeleted: false,
      ...(opts.fromMs ? { atMs: { gte: BigInt(opts.fromMs) } } : {}),
      ...(opts.toMs   ? { atMs: { lte: BigInt(opts.toMs) } }   : {}),
    },
    orderBy: { atMs: 'asc' },
    take:    Math.min(opts.limit ?? 500, 5000),
  });
}

export async function updateAnnotation(actor: AnnotationActor, id: string, patch: Partial<{ payload: Prisma.InputJsonValue; visibility: string }>) {
  const a = await prisma.tacticalAnnotation.findUnique({ where: { id } });
  if (!a)                                                       throw new NotFoundError('Annotation');
  if (a.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (a.authorId !== actor.userId && actor.role !== 'SUPER_ADMIN' && actor.role !== 'CLUB_ADMIN' && actor.role !== 'HEAD_COACH') {
    throw new ForbiddenError('Only the author or club admins can edit');
  }
  return prisma.tacticalAnnotation.update({
    where: { id },
    data:  { ...(patch.payload !== undefined ? { payload: patch.payload } : {}), ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}) },
  });
}

export async function deleteAnnotation(actor: AnnotationActor, id: string): Promise<void> {
  const a = await prisma.tacticalAnnotation.findUnique({ where: { id } });
  if (!a)                                                       throw new NotFoundError('Annotation');
  if (a.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  await prisma.tacticalAnnotation.update({ where: { id }, data: { isDeleted: true } });
}
