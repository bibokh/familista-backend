// Familista — AI Operations service (Phase E)
// ─────────────────────────────────────────────────────────────────────────
// CRUD over AIAlert / AIRecommendation / AIReport with tenant scoping.
//
// These tables are write-light append-mostly streams: rules engine + agent
// workers write here, the panel reads. We never delete, only transition
// status (OPEN → ACK | RESOLVED | MUTED).
//
// Tenant rule: every read/write checks clubId. The rules engine MUST pass
// the clubId resolved from the match row, NEVER from device input.

import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { publish } from '../realtime/match-channel';
import { logger } from '../utils/logger';
import type { AlertSeverity, AlertStatus, AIAgent, Prisma } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────

export interface CreateAlertDto {
  clubId:    string;
  matchId?:  string | null;
  teamId?:   string | null;
  playerId?: string | null;
  agent?:    AIAgent | null;
  kind:      string;
  severity?: AlertSeverity;
  title?:    string;
  message?:  string;
  payload?:  Prisma.InputJsonValue;
}

export interface CreateRecommendationDto {
  clubId:    string;
  matchId?:  string | null;
  teamId?:   string | null;
  playerId?: string | null;
  agent:     AIAgent;
  kind:      string;
  title?:    string;
  content:   Prisma.InputJsonValue;
  score?:    number;
}

export interface CreateReportDto {
  clubId:   string;
  matchId?: string | null;
  teamId?:  string | null;
  agent:    AIAgent;
  kind:     string;
  title:    string;
  content:  string;
  payload?: Prisma.InputJsonValue;
}

export interface AlertActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─────────────────────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────────────────────

export async function createAlert(dto: CreateAlertDto) {
  const row = await prisma.aIAlert.create({
    data: {
      clubId:    dto.clubId,
      matchId:   dto.matchId ?? null,
      teamId:    dto.teamId ?? null,
      playerId:  dto.playerId ?? null,
      agent:     dto.agent ?? null,
      kind:      dto.kind,
      severity:  dto.severity ?? 'INFO',
      title:     dto.title ?? dto.kind,
      message:   dto.message ?? null,
      payload:   (dto.payload ?? null) as Prisma.InputJsonValue,
    },
  });
  // Realtime fan-out — best-effort.
  if (row.matchId) {
    try {
      publish({
        kind:    'RULES_ALERT',
        matchId: row.matchId,
        clubId:  row.clubId,
        payload: { id: row.id, kind: row.kind, severity: row.severity, title: row.title, message: row.message, createdAt: row.createdAt },
      });
    } catch (err) { logger.warn('[ai-ops] alert publish failed', { err: (err as Error).message }); }
  }
  return row;
}

export async function listAlerts(
  clubId: string,
  opts: {
    matchId?:  string;
    status?:   AlertStatus;
    severity?: AlertSeverity;
    kind?:     string;
    page?:     number;
    limit?:    number;
  } = {},
) {
  const { matchId, status, severity, kind, page = 1, limit = 50 } = opts;
  const where: Prisma.AIAlertWhereInput = {
    clubId,
    ...(matchId  && { matchId }),
    ...(status   && { status }),
    ...(severity && { severity }),
    ...(kind     && { kind }),
  };
  const [items, total] = await Promise.all([
    prisma.aIAlert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
    }),
    prisma.aIAlert.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function ackAlert(actor: AlertActor, alertId: string) {
  const a = await prisma.aIAlert.findUnique({ where: { id: alertId } });
  if (!a)                       throw new NotFoundError('AIAlert');
  if (a.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (a.status !== 'OPEN') return a;
  return prisma.aIAlert.update({
    where: { id: alertId },
    data:  { status: 'ACK', ackedAt: new Date(), ackedBy: actor.userId },
  });
}

export async function resolveAlert(actor: AlertActor, alertId: string) {
  const a = await prisma.aIAlert.findUnique({ where: { id: alertId } });
  if (!a)                       throw new NotFoundError('AIAlert');
  if (a.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (a.status === 'RESOLVED') return a;
  return prisma.aIAlert.update({
    where: { id: alertId },
    data:  { status: 'RESOLVED', resolvedAt: new Date(), ackedBy: a.ackedBy ?? actor.userId },
  });
}

export async function muteAlert(actor: AlertActor, alertId: string) {
  const a = await prisma.aIAlert.findUnique({ where: { id: alertId } });
  if (!a)                       throw new NotFoundError('AIAlert');
  if (a.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.aIAlert.update({
    where: { id: alertId },
    data:  { status: 'MUTED', ackedBy: actor.userId },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Recommendations
// ─────────────────────────────────────────────────────────────────────────

export async function createRecommendation(dto: CreateRecommendationDto) {
  const row = await prisma.aIRecommendation.create({
    data: {
      clubId:   dto.clubId,
      matchId:  dto.matchId ?? null,
      teamId:   dto.teamId ?? null,
      playerId: dto.playerId ?? null,
      agent:    dto.agent,
      kind:     dto.kind,
      title:    dto.title ?? dto.kind,
      content:  dto.content,
      score:    typeof dto.score === 'number' ? dto.score : null,
    },
  });
  if (row.matchId) {
    try {
      publish({
        kind:    'AI_RECOMMENDATION',
        matchId: row.matchId,
        clubId:  row.clubId,
        payload: { id: row.id, kind: row.kind, agent: row.agent, title: row.title, score: row.score, createdAt: row.createdAt },
      });
    } catch (err) { logger.warn('[ai-ops] recommendation publish failed', { err: (err as Error).message }); }
  }
  return row;
}

export async function listRecommendations(
  clubId: string,
  opts: {
    matchId?: string;
    status?:  AlertStatus;
    agent?:   AIAgent;
    page?:    number;
    limit?:   number;
  } = {},
) {
  const { matchId, status, agent, page = 1, limit = 50 } = opts;
  const where: Prisma.AIRecommendationWhereInput = {
    clubId,
    ...(matchId && { matchId }),
    ...(status  && { status }),
    ...(agent   && { agent }),
  };
  const [items, total] = await Promise.all([
    prisma.aIRecommendation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
    }),
    prisma.aIRecommendation.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function ackRecommendation(actor: AlertActor, id: string) {
  const r = await prisma.aIRecommendation.findUnique({ where: { id } });
  if (!r)                                                  throw new NotFoundError('AIRecommendation');
  if (r.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.aIRecommendation.update({
    where: { id },
    data:  { status: 'ACK', ackedAt: new Date(), ackedBy: actor.userId },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────

export async function createReport(dto: CreateReportDto) {
  const row = await prisma.aIReport.create({
    data: {
      clubId:  dto.clubId,
      matchId: dto.matchId ?? null,
      teamId:  dto.teamId ?? null,
      agent:   dto.agent,
      kind:    dto.kind,
      title:   dto.title,
      content: dto.content,
      payload: (dto.payload ?? null) as Prisma.InputJsonValue,
    },
  });
  if (row.matchId) {
    try {
      publish({
        kind:    'AI_REPORT',
        matchId: row.matchId,
        clubId:  row.clubId,
        payload: { id: row.id, agent: row.agent, kind: row.kind, title: row.title, createdAt: row.createdAt },
      });
    } catch (err) { logger.warn('[ai-ops] report publish failed', { err: (err as Error).message }); }
  }
  return row;
}

export async function listReports(
  clubId: string,
  opts: { matchId?: string; agent?: AIAgent; kind?: string; page?: number; limit?: number } = {},
) {
  const { matchId, agent, kind, page = 1, limit = 50 } = opts;
  const where: Prisma.AIReportWhereInput = {
    clubId,
    ...(matchId && { matchId }),
    ...(agent   && { agent }),
    ...(kind    && { kind }),
  };
  const [items, total] = await Promise.all([
    prisma.aIReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
    }),
    prisma.aIReport.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getReport(actor: AlertActor, id: string) {
  const r = await prisma.aIReport.findUnique({ where: { id } });
  if (!r)                                                   throw new NotFoundError('AIReport');
  if (r.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return r;
}
