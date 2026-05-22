// Familista — Global Sports Knowledge Graph (Phase N)
// ─────────────────────────────────────────────────────────────────────────
// Polymorphic node + typed edge model. Each mutation hashes into the
// Phase I audit chain. Snapshot anchors are sha256 over sorted ids.

import { createHash } from 'crypto';
import { CryptographicGraphAnchor, GlobalKnowledgeEdge, GlobalKnowledgeNode, KnowledgeEdgeType, KnowledgeNodeType, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface KGActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Node lifecycle ──────────────────────────────────────────────────────

export interface CreateNodeDto {
  nodeKind:    KnowledgeNodeType;
  label:       string;
  payload:     Prisma.InputJsonValue;
  externalRef?: string;
  /** Set true to publish a platform-wide (clubId=null) node. SUPER_ADMIN only. */
  global?:     boolean;
}

export async function createNode(actor: KGActor, dto: CreateNodeDto): Promise<GlobalKnowledgeNode> {
  if (!dto.nodeKind || !dto.label || dto.payload === undefined) throw new BadRequestError('nodeKind + label + payload required');
  if (dto.global && actor.role !== 'SUPER_ADMIN')              throw new ForbiddenError('Only SUPER_ADMIN may publish global nodes');
  const row = await prisma.globalKnowledgeNode.create({
    data: {
      clubId:      dto.global ? null : actor.clubId,
      nodeKind:    dto.nodeKind,
      externalRef: dto.externalRef ?? null,
      label:       dto.label,
      payload:     dto.payload,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `KG_NODE_CREATED:${dto.nodeKind}`,
    entityType: 'GlobalKnowledgeNode', entityId: row.id,
    payload: { nodeKind: dto.nodeKind, label: dto.label, external: dto.externalRef ?? null },
  });
  return row;
}

export async function listNodes(actor: KGActor, opts: { nodeKind?: KnowledgeNodeType; includeGlobal?: boolean; externalRef?: string; limit?: number } = {}): Promise<GlobalKnowledgeNode[]> {
  const where: Prisma.GlobalKnowledgeNodeWhereInput = {
    isActive: true,
    OR: [
      { clubId: actor.clubId },
      ...(opts.includeGlobal === false ? [] : [{ clubId: null }]),
    ],
    ...(opts.nodeKind   ? { nodeKind: opts.nodeKind }       : {}),
    ...(opts.externalRef ? { externalRef: opts.externalRef } : {}),
  };
  return prisma.globalKnowledgeNode.findMany({ where, orderBy: { updatedAt: 'desc' }, take: Math.min(opts.limit ?? 100, 1000) });
}

export async function getNode(actor: KGActor, id: string): Promise<GlobalKnowledgeNode> {
  const n = await prisma.globalKnowledgeNode.findUnique({ where: { id } });
  if (!n)                                                                                          throw new NotFoundError('GlobalKnowledgeNode');
  if (n.clubId && n.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')                       throw new ForbiddenError();
  return n;
}

export async function deactivateNode(actor: KGActor, id: string): Promise<GlobalKnowledgeNode> {
  const n = await getNode(actor, id);
  if (n.clubId === null && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError('Only SUPER_ADMIN may deactivate global');
  return prisma.globalKnowledgeNode.update({ where: { id: n.id }, data: { isActive: false } });
}

// ── Edge lifecycle ──────────────────────────────────────────────────────

export interface CreateEdgeDto {
  fromNodeId: string;
  toNodeId:   string;
  edgeKind:   KnowledgeEdgeType;
  weight?:    number;
  metadata?:  Prisma.InputJsonValue;
  global?:    boolean;
}

export async function createEdge(actor: KGActor, dto: CreateEdgeDto): Promise<GlobalKnowledgeEdge> {
  if (!dto.fromNodeId || !dto.toNodeId || !dto.edgeKind) throw new BadRequestError('fromNodeId + toNodeId + edgeKind required');
  if (dto.fromNodeId === dto.toNodeId)                   throw new BadRequestError('self-loops not allowed');
  if (dto.global && actor.role !== 'SUPER_ADMIN')        throw new ForbiddenError('Only SUPER_ADMIN may publish global edges');
  // Verify both nodes are visible to this actor.
  await Promise.all([getNode(actor, dto.fromNodeId), getNode(actor, dto.toNodeId)]);
  const row = await prisma.globalKnowledgeEdge.upsert({
    where:  { fromNodeId_toNodeId_edgeKind: { fromNodeId: dto.fromNodeId, toNodeId: dto.toNodeId, edgeKind: dto.edgeKind } },
    create: {
      clubId:     dto.global ? null : actor.clubId,
      fromNodeId: dto.fromNodeId,
      toNodeId:   dto.toNodeId,
      edgeKind:   dto.edgeKind,
      weight:     Math.max(0, Math.min(1, dto.weight ?? 1.0)),
      metadata:   (dto.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
    update: {
      weight:   Math.max(0, Math.min(1, dto.weight ?? 1.0)),
      metadata: (dto.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      isActive: true,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `KG_EDGE_LINKED:${dto.edgeKind}`,
    entityType: 'GlobalKnowledgeEdge', entityId: row.id,
    payload: { fromNodeId: dto.fromNodeId, toNodeId: dto.toNodeId, edgeKind: dto.edgeKind, weight: row.weight },
  });
  return row;
}

export async function listEdges(actor: KGActor, opts: { fromNodeId?: string; toNodeId?: string; edgeKind?: KnowledgeEdgeType; limit?: number } = {}): Promise<GlobalKnowledgeEdge[]> {
  const where: Prisma.GlobalKnowledgeEdgeWhereInput = {
    isActive: true,
    OR: [{ clubId: actor.clubId }, { clubId: null }],
    ...(opts.fromNodeId ? { fromNodeId: opts.fromNodeId } : {}),
    ...(opts.toNodeId   ? { toNodeId: opts.toNodeId } : {}),
    ...(opts.edgeKind   ? { edgeKind: opts.edgeKind } : {}),
  };
  return prisma.globalKnowledgeEdge.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(opts.limit ?? 200, 5000) });
}

// ── Cryptographic anchor over a graph snapshot ──────────────────────────

/**
 * Computes a deterministic sha256 anchor over the current visible
 * knowledge graph snapshot for the club. Persists into
 * CryptographicGraphAnchor + Phase I audit chain.
 *
 * Formula:
 *   sha256( sorted-nodeIds.join("|") + "::" + sorted-edgeIds.join("|") + "::" + asOf )
 */
export async function anchorGraph(actor: KGActor, asOfIso?: string): Promise<CryptographicGraphAnchor> {
  const asOf = asOfIso ? new Date(asOfIso) : new Date();
  const [nodes, edges] = await Promise.all([
    prisma.globalKnowledgeNode.findMany({
      where: { isActive: true, OR: [{ clubId: actor.clubId }, { clubId: null }] },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 50_000,
    }),
    prisma.globalKnowledgeEdge.findMany({
      where: { isActive: true, OR: [{ clubId: actor.clubId }, { clubId: null }] },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 200_000,
    }),
  ]);
  const cardinality = nodes.length + edges.length;
  const body = nodes.map((n) => n.id).join('|') + '::' + edges.map((e) => e.id).join('|') + '::' + asOf.toISOString();
  const sha = createHash('sha256').update(body).digest('hex');
  const row = await prisma.cryptographicGraphAnchor.create({
    data: {
      clubId:     actor.clubId,
      anchorKind: 'KNOWLEDGE_GRAPH',
      sha256:     sha,
      cardinality,
      asOf,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'KG_ANCHOR_PUBLISHED',
    entityType: 'CryptographicGraphAnchor', entityId: row.id,
    payload: { sha256: sha, cardinality, asOf: asOf.toISOString() },
  });
  return row;
}

export async function listAnchors(actor: KGActor, kind?: string, limit = 50): Promise<CryptographicGraphAnchor[]> {
  return prisma.cryptographicGraphAnchor.findMany({
    where: { clubId: actor.clubId, ...(kind ? { anchorKind: kind } : {}) },
    orderBy: { asOf: 'desc' },
    take: Math.min(limit, 500),
  });
}

/** Re-verify an anchor by recomputing the sha256 against current graph state. */
export async function verifyAnchor(actor: KGActor, anchorId: string): Promise<{ ok: boolean; expected: string; actual: string; asOf: string }> {
  const anchor = await prisma.cryptographicGraphAnchor.findUnique({ where: { id: anchorId } });
  if (!anchor)                                                       throw new NotFoundError('CryptographicGraphAnchor');
  if (anchor.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  // Recompute over current visible graph. NOTE: if rows were added since
  // `asOf`, recomputed sha will differ — this verifies the snapshot was
  // valid AT that time only if asOf was the snapshot moment. We expose
  // this as informational, not as a tamper alert (use audit chain for
  // tamper evidence).
  const [nodes, edges] = await Promise.all([
    prisma.globalKnowledgeNode.findMany({
      where: { isActive: true, OR: [{ clubId: actor.clubId }, { clubId: null }], createdAt: { lte: anchor.asOf } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 50_000,
    }),
    prisma.globalKnowledgeEdge.findMany({
      where: { isActive: true, OR: [{ clubId: actor.clubId }, { clubId: null }], createdAt: { lte: anchor.asOf } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 200_000,
    }),
  ]);
  const body = nodes.map((n) => n.id).join('|') + '::' + edges.map((e) => e.id).join('|') + '::' + anchor.asOf.toISOString();
  const actual = createHash('sha256').update(body).digest('hex');
  return { ok: actual === anchor.sha256, expected: anchor.sha256, actual, asOf: anchor.asOf.toISOString() };
}
