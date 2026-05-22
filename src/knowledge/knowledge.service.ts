// Familista — Sports Knowledge Engine (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// 4 knowledge stores. KnowledgeDocument supports per-club + platform-wide
// docs; the medical / tactical libraries are catalog-style.

import { KnowledgeDocument, KnowledgeGraph, KnowledgeNodeKind, MedicalKnowledgeNode, Prisma, SportKind, TacticalPatternLibrary } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export interface KnowledgeActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── KnowledgeDocument ───────────────────────────────────────────────────

export interface CreateDocDto {
  kind:   KnowledgeNodeKind;
  title:  string;
  body:   string;
  tags?:  Prisma.InputJsonValue;
  /** If true, doc is global (clubId = null) — only SUPER_ADMIN. */
  global?: boolean;
}

export async function createDocument(actor: KnowledgeActor, dto: CreateDocDto): Promise<KnowledgeDocument> {
  if (!dto.kind || !dto.title || !dto.body) throw new BadRequestError('kind + title + body required');
  if (dto.global && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError('Only SUPER_ADMIN may publish global knowledge');
  return prisma.knowledgeDocument.create({
    data: {
      clubId:      dto.global ? null : actor.clubId,
      kind:        dto.kind,
      title:       dto.title,
      body:        dto.body,
      tags:        (dto.tags ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      createdById: actor.userId,
    },
  });
}

export async function listDocuments(actor: KnowledgeActor, opts: { kind?: KnowledgeNodeKind; includeGlobal?: boolean; limit?: number } = {}): Promise<KnowledgeDocument[]> {
  // Visible: docs in my club OR (if includeGlobal) global docs.
  const where: Prisma.KnowledgeDocumentWhereInput = {
    isActive: true,
    OR: [
      { clubId: actor.clubId },
      ...(opts.includeGlobal === false ? [] : [{ clubId: null }]),
    ],
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
  return prisma.knowledgeDocument.findMany({ where, orderBy: { updatedAt: 'desc' }, take: Math.min(opts.limit ?? 50, 500) });
}

export async function deactivateDocument(actor: KnowledgeActor, id: string): Promise<KnowledgeDocument> {
  const d = await prisma.knowledgeDocument.findUnique({ where: { id } });
  if (!d)                                                                                          throw new NotFoundError('KnowledgeDocument');
  if (d.clubId && d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')                       throw new ForbiddenError();
  if (d.clubId === null && actor.role !== 'SUPER_ADMIN')                                           throw new ForbiddenError('Only SUPER_ADMIN may deactivate global');
  return prisma.knowledgeDocument.update({ where: { id }, data: { isActive: false } });
}

// ── KnowledgeGraph ──────────────────────────────────────────────────────

export async function recordKnowledgeGraph(actor: KnowledgeActor, snapshot: Prisma.InputJsonValue): Promise<KnowledgeGraph> {
  if (snapshot === undefined) throw new BadRequestError('snapshot required');
  return prisma.knowledgeGraph.create({ data: { clubId: actor.clubId, snapshot } });
}

// ── TacticalPatternLibrary (catalog) ────────────────────────────────────

export async function publishTacticalPattern(actor: KnowledgeActor, dto: { sport: SportKind; pluginCode?: string; patternName: string; payload: Prisma.InputJsonValue; tags?: Prisma.InputJsonValue }): Promise<TacticalPatternLibrary> {
  if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'CLUB_ADMIN' && actor.role !== 'HEAD_COACH') {
    throw new ForbiddenError('Insufficient role to publish tactical pattern');
  }
  return prisma.tacticalPatternLibrary.upsert({
    where:  { sport_pluginCode_patternName: { sport: dto.sport, pluginCode: dto.pluginCode ?? null, patternName: dto.patternName } as never },
    create: { sport: dto.sport, pluginCode: dto.pluginCode ?? null, patternName: dto.patternName, payload: dto.payload, tags: (dto.tags ?? Prisma.JsonNull) as Prisma.InputJsonValue, isActive: true },
    update: { payload: dto.payload, tags: (dto.tags ?? Prisma.JsonNull) as Prisma.InputJsonValue, isActive: true },
  });
}

export async function listTacticalPatterns(sport?: SportKind): Promise<TacticalPatternLibrary[]> {
  return prisma.tacticalPatternLibrary.findMany({ where: { isActive: true, ...(sport ? { sport } : {}) }, orderBy: [{ sport: 'asc' }, { patternName: 'asc' }] });
}

// ── MedicalKnowledgeNode (catalog) ──────────────────────────────────────

export async function publishMedicalNode(actor: KnowledgeActor, dto: { kind: string; title: string; body: string; tags?: Prisma.InputJsonValue; global?: boolean }): Promise<MedicalKnowledgeNode> {
  if (!dto.kind || !dto.title || !dto.body) throw new BadRequestError('kind + title + body required');
  if (dto.global && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError('Only SUPER_ADMIN may publish global medical knowledge');
  return prisma.medicalKnowledgeNode.create({
    data: {
      clubId: dto.global ? null : actor.clubId,
      kind:   dto.kind,
      title:  dto.title,
      body:   dto.body,
      tags:   (dto.tags ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listMedicalNodes(actor: KnowledgeActor, kind?: string): Promise<MedicalKnowledgeNode[]> {
  return prisma.medicalKnowledgeNode.findMany({
    where: {
      isActive: true,
      OR: [{ clubId: actor.clubId }, { clubId: null }],
      ...(kind ? { kind } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take:    200,
  });
}
