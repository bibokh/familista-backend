// Familista — Data Governance (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// Retention policies + GDPR (export / delete / rectification / portability)
// + per-user / per-player consent records. Every action is audit-anchored.

import { createHash } from 'crypto';
import { ConsentScope, DataRetentionPolicy, GdprDataRequest, GdprRequestKind, GdprRequestState, Prisma, UserConsentRecord } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface GovActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Retention policies ──────────────────────────────────────────────────

export interface UpsertPolicyDto {
  entityType:    string;
  retentionDays: number;
  global?:       boolean;
}

export async function upsertRetention(actor: GovActor, dto: UpsertPolicyDto): Promise<DataRetentionPolicy> {
  if (!dto.entityType || !Number.isInteger(dto.retentionDays) || dto.retentionDays < 0) throw new BadRequestError('entityType + retentionDays (>=0) required');
  if (dto.global && actor.role !== 'SUPER_ADMIN')                                       throw new ForbiddenError('Only SUPER_ADMIN may set global policy');
  return prisma.dataRetentionPolicy.upsert({
    where:  { clubId_entityType: { clubId: dto.global ? null : actor.clubId, entityType: dto.entityType } as never },
    create: { clubId: dto.global ? null : actor.clubId, entityType: dto.entityType, retentionDays: dto.retentionDays, publishedBy: actor.userId },
    update: { retentionDays: dto.retentionDays, isActive: true, publishedBy: actor.userId, publishedAt: new Date() },
  });
}

export async function listRetention(actor: GovActor): Promise<DataRetentionPolicy[]> {
  return prisma.dataRetentionPolicy.findMany({
    where: { isActive: true, OR: [{ clubId: actor.clubId }, { clubId: null }] },
    orderBy: [{ clubId: 'asc' }, { entityType: 'asc' }],
  });
}

// ── GDPR ────────────────────────────────────────────────────────────────

export interface OpenRequestDto {
  kind:            GdprRequestKind;
  subjectUserId?:  string;
  subjectPlayerId?: string;
  scope?:          Prisma.InputJsonValue;
}

export async function openRequest(actor: GovActor, dto: OpenRequestDto): Promise<GdprDataRequest> {
  if (!dto.kind) throw new BadRequestError('kind required');
  if (!dto.subjectUserId && !dto.subjectPlayerId) throw new BadRequestError('subjectUserId or subjectPlayerId required');
  const payloadHash = createHash('sha256').update(JSON.stringify({ kind: dto.kind, subjectUserId: dto.subjectUserId ?? null, subjectPlayerId: dto.subjectPlayerId ?? null, scope: dto.scope ?? null })).digest('hex');
  const row = await prisma.gdprDataRequest.create({
    data: {
      clubId:          actor.clubId,
      requestingUserId: actor.userId,
      subjectUserId:   dto.subjectUserId ?? null,
      subjectPlayerId: dto.subjectPlayerId ?? null,
      kind:            dto.kind,
      state:           'PENDING',
      scope:           (dto.scope ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      payloadHash,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `GDPR_REQUEST_OPENED:${dto.kind}`, entityType: 'GdprDataRequest', entityId: row.id,
    payload: { kind: dto.kind, subjectUserId: dto.subjectUserId ?? null, subjectPlayerId: dto.subjectPlayerId ?? null, payloadHash },
  });
  return row;
}

export async function transitionRequestState(actor: GovActor, id: string, state: GdprRequestState, opts: { resultRef?: string; rejectedReason?: string } = {}): Promise<GdprDataRequest> {
  const r = await prisma.gdprDataRequest.findUnique({ where: { id } });
  if (!r)                                                       throw new NotFoundError('GdprDataRequest');
  if (r.clubId && r.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  const data: Prisma.GdprDataRequestUpdateInput = { state };
  if (state === 'COMPLETED') { data.completedAt = new Date(); data.resultRef = opts.resultRef ?? null; }
  if (state === 'REJECTED')  { data.rejectedReason = opts.rejectedReason ?? null; }
  const updated = await prisma.gdprDataRequest.update({ where: { id }, data });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `GDPR_REQUEST_${state}`, entityType: 'GdprDataRequest', entityId: id,
    payload: { kind: r.kind, state, resultRef: opts.resultRef ?? null, rejectedReason: opts.rejectedReason ?? null },
  });
  return updated;
}

export async function listRequests(actor: GovActor, opts: { kind?: GdprRequestKind; state?: GdprRequestState; limit?: number } = {}): Promise<GdprDataRequest[]> {
  return prisma.gdprDataRequest.findMany({
    where: { clubId: actor.clubId, ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.state ? { state: opts.state } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 1000),
  });
}

// ── Consent ─────────────────────────────────────────────────────────────

export interface GrantConsentDto {
  scope:    ConsentScope;
  granted?: boolean;
  userId?:  string;
  playerId?: string;
  payload?: Prisma.InputJsonValue;
}

export async function recordConsent(actor: GovActor, dto: GrantConsentDto): Promise<UserConsentRecord> {
  if (!dto.scope) throw new BadRequestError('scope required');
  if (!dto.userId && !dto.playerId) throw new BadRequestError('userId or playerId required');
  const granted = dto.granted !== false;
  const row = await prisma.userConsentRecord.create({
    data: {
      clubId:    actor.clubId,
      userId:    dto.userId ?? null,
      playerId:  dto.playerId ?? null,
      scope:     dto.scope,
      granted,
      payload:   (dto.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      revokedAt: granted ? null : new Date(),
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: granted ? 'CONSENT_GRANTED' : 'CONSENT_REVOKED', entityType: 'UserConsentRecord', entityId: row.id,
    payload: { scope: dto.scope, userId: dto.userId ?? null, playerId: dto.playerId ?? null, granted },
  });
  return row;
}

export async function listConsent(actor: GovActor, opts: { userId?: string; playerId?: string; scope?: ConsentScope } = {}): Promise<UserConsentRecord[]> {
  return prisma.userConsentRecord.findMany({
    where: {
      OR: [{ clubId: actor.clubId }, ...(actor.role === 'SUPER_ADMIN' ? [{}] : [])],
      ...(opts.userId   ? { userId: opts.userId } : {}),
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.scope    ? { scope: opts.scope } : {}),
    },
    orderBy: { grantedAt: 'desc' },
    take: 500,
  });
}
