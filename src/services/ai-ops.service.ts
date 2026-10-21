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
import {
  AIReader, accessTier, assertAIReader, assertMayAct, listConditions, presentAlert, presentList,
  presentRecommendation, presentReport,
} from '../security/ai-read-policy';
import { publish } from '../realtime/match-channel';
import { logger } from '../utils/logger';
import type { AlertSeverity, AlertStatus, AIAgent, Prisma } from '@prisma/client';
import {
  publishAIAlertRaised, publishAIAnalysisCompleted, confidenceBand, scopeOf,
} from '../fabric/producers/ai.producer';

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
        // `agent` travels so each subscriber's stream can apply the AI read
        // policy (presentMatchEvent): a medical alert's text is not for everyone.
        payload: { id: row.id, kind: row.kind, agent: row.agent, severity: row.severity, title: row.title, message: row.message, createdAt: row.createdAt },
      });
    } catch (err) { logger.warn('[ai-ops] alert publish failed', { err: (err as Error).message }); }
  }

  // After the row exists. The fan-out above is a websocket message to one match
  // channel and reaches nobody who is not watching it; this is the record.
  //
  // The kind, the severity and which agent raised it. Not the title, not the
  // message, not the payload, and above all not `playerId` — a fatigue alert
  // about an identifiable person is a health disclosure, and on an academy
  // squad it is one about a child. `scope` says a player was the subject
  // without saying which.
  publishAIAlertRaised(
    { alertId: row.id, clubId: row.clubId },
    {
      alertKind: String(row.kind),
      severity: String(row.severity),
      agent: row.agent ? String(row.agent) : null,
      scope: scopeOf(row),
    },
  );

  return row;
}

export async function listAlerts(
  reader: AIReader,
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
  // Who may see which alerts: src/security/ai-read-policy.ts.
  assertAIReader(reader);
  const readable = listConditions(reader, 'alert', { agentNullable: true });
  if (!readable || !reader.clubId) return { items: [], total: 0, page, limit };
  const where = {
    clubId: reader.clubId,
    ...(matchId  && { matchId }),
    ...(status   && { status }),
    ...(severity && { severity }),
    ...(kind     && { kind }),
    AND: readable,
  } as Prisma.AIAlertWhereInput;
  const [rows, total] = await Promise.all([
    prisma.aIAlert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
    }),
    prisma.aIAlert.count({ where }),
  ]);
  const items = presentList(reader, 'alert', rows, (a, tier) => presentAlert(a, tier));
  return { items, total, page, limit };
}

// Acknowledging says "seen": anyone who may see the alert at all. Resolving
// closes it: only someone who may read all of it. Muting silences it: on an
// alert that may hold medical data, medical staff; on any other, the roles the
// route has always allowed.
const OPERATIONAL_MUTE_ROLES = ['CLUB_ADMIN', 'HEAD_COACH', 'ANALYST'] as const;

export async function ackAlert(actor: AlertActor, alertId: string) {
  const a = await prisma.aIAlert.findUnique({ where: { id: alertId } });
  if (!a)                       throw new NotFoundError('AIAlert');
  const tier = accessTier(actor, 'alert', a, 'AIAlert');
  if (a.status !== 'OPEN') return presentAlert(a, tier);
  return presentAlert(await prisma.aIAlert.update({
    where: { id: alertId },
    data:  { status: 'ACK', ackedAt: new Date(), ackedBy: actor.userId },
  }), tier);
}

export async function resolveAlert(actor: AlertActor, alertId: string) {
  const a = await prisma.aIAlert.findUnique({ where: { id: alertId } });
  if (!a)                       throw new NotFoundError('AIAlert');
  if (accessTier(actor, 'alert', a, 'AIAlert') !== 'FULL') throw new ForbiddenError('Only someone who may read this alert in full may resolve it');
  if (a.status === 'RESOLVED') return a;
  return prisma.aIAlert.update({
    where: { id: alertId },
    data:  { status: 'RESOLVED', resolvedAt: new Date(), ackedBy: a.ackedBy ?? actor.userId },
  });
}

export async function muteAlert(actor: AlertActor, alertId: string) {
  const a = await prisma.aIAlert.findUnique({ where: { id: alertId } });
  if (!a)                       throw new NotFoundError('AIAlert');
  assertMayAct(actor, 'alert', a, accessTier(actor, 'alert', a, 'AIAlert'), OPERATIONAL_MUTE_ROLES, 'mute');
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

  // After the row exists. `content` IS the recommendation and is not passed;
  // `score` travels as a band, because a precise confidence attached to a named
  // player is a judgement about that person.
  publishAIAnalysisCompleted(
    { recommendationId: row.id, clubId: row.clubId },
    {
      analysisKind: String(row.kind),
      agent: row.agent ? String(row.agent) : null,
      scope: scopeOf(row),
      confidence: confidenceBand(row.score),
    },
  );

  return row;
}

export async function listRecommendations(
  reader: AIReader,
  opts: {
    matchId?: string;
    status?:  AlertStatus;
    agent?:   AIAgent;
    page?:    number;
    limit?:   number;
  } = {},
) {
  const { matchId, status, agent, page = 1, limit = 50 } = opts;
  assertAIReader(reader);
  const readable = listConditions(reader, 'recommendation', { agentNullable: false });
  if (!readable || !reader.clubId) return { items: [], total: 0, page, limit };
  const where = {
    clubId: reader.clubId,
    ...(matchId && { matchId }),
    ...(status  && { status }),
    ...(agent   && { agent }),
    AND: readable,
  } as Prisma.AIRecommendationWhereInput;
  const [rows, total] = await Promise.all([
    prisma.aIRecommendation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
    }),
    prisma.aIRecommendation.count({ where }),
  ]);
  const items = presentList(reader, 'recommendation', rows, (r, tier) => presentRecommendation(r, tier));
  return { items, total, page, limit };
}

export async function ackRecommendation(actor: AlertActor, id: string) {
  const r = await prisma.aIRecommendation.findUnique({ where: { id } });
  if (!r)                                                  throw new NotFoundError('AIRecommendation');
  const tier = accessTier(actor, 'recommendation', r, 'AIRecommendation');
  return presentRecommendation(await prisma.aIRecommendation.update({
    where: { id },
    data:  { status: 'ACK', ackedAt: new Date(), ackedBy: actor.userId },
  }), tier);
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

// A list carries a report's title, never its body: the body is the model's
// output and comes from getReport, at FULL only.
export async function listReports(
  reader: AIReader,
  opts: { matchId?: string; agent?: AIAgent; kind?: string; page?: number; limit?: number } = {},
) {
  const { matchId, agent, kind, page = 1, limit = 50 } = opts;
  assertAIReader(reader);
  const readable = listConditions(reader, 'report', { agentNullable: false });
  if (!readable || !reader.clubId) return { items: [], total: 0, page, limit };
  const where = {
    clubId: reader.clubId,
    ...(matchId && { matchId }),
    ...(agent   && { agent }),
    ...(kind    && { kind }),
    AND: readable,
  } as Prisma.AIReportWhereInput;
  const [rows, total] = await Promise.all([
    prisma.aIReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
    }),
    prisma.aIReport.count({ where }),
  ]);
  const items = presentList(reader, 'report', rows, (r, tier) => presentReport(r, tier, 'list'));
  return { items, total, page, limit };
}

export async function getReport(actor: AlertActor, id: string) {
  const r = await prisma.aIReport.findUnique({ where: { id } });
  if (!r)                                                   throw new NotFoundError('AIReport');
  return presentReport(r, accessTier(actor, 'report', r, 'AIReport'), 'detail');
}
