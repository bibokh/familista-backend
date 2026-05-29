// Familista — Transfer Intelligence: Scouting (Phase Q)
// Target: src/transfer/scouting.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Scouting reports (per-player, per-observation) with attribute grades 1–10,
// a letter grade (A+→D), and a written recommendation.
//
// Transfer pipeline: Kanban-style stage progression
//   LONGLIST → SHORTLIST → APPROACH → NEGOTIATION → SIGNED | LOAN | REJECTED
//
// compositeScore = mean of (technical, physical, mental, tactical, potential).
// Stage transitions are guarded — forward-only except REJECTED / revert to LONGLIST.

import { Prisma, ScoutingReport, TransferTarget } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface ScoutingActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─── Grade validation ─────────────────────────────────────────────────────────

const GRADE_KEYS = ['technical', 'physical', 'mental', 'tactical', 'potential'] as const;

function _validateGrades(dto: Partial<Record<(typeof GRADE_KEYS)[number], number>>): void {
  for (const key of GRADE_KEYS) {
    const v = dto[key];
    if (v === undefined) continue;
    if (v < 1 || v > 10) throw new BadRequestError(`${key} must be between 1 and 10`);
    // Allow half-point increments (e.g. 7.5) but reject finer fractions.
    if (!Number.isInteger(v * 2)) throw new BadRequestError(`${key} must use 0.5 increments (e.g. 7.5)`);
  }
}

function _compositeScore(r: Record<string, number>): number {
  return +(GRADE_KEYS.reduce((s, k) => s + (r[k] as number), 0) / GRADE_KEYS.length).toFixed(2);
}

// ─── Scouting Reports ─────────────────────────────────────────────────────────

export interface CreateScoutingReportDto {
  playerId:         string;
  matchId?:         string;
  observedAt:       string;   // ISO date
  overallGrade:     string;   // ScoutingGrade: A_PLUS | A | B_PLUS | B | C | D
  recommendation:   string;   // ScoutRecommendation: SIGN | MONITOR | REJECT | LOAN
  technical:        number;
  physical:         number;
  mental:           number;
  tactical:         number;
  potential:        number;
  strengthsNotes?:  string;
  weaknessesNotes?: string;
  summaryNotes?:    string;
}

export interface UpdateScoutingReportDto {
  overallGrade?:    string;
  recommendation?:  string;
  technical?:       number;
  physical?:        number;
  mental?:          number;
  tactical?:        number;
  potential?:       number;
  strengthsNotes?:  string;
  weaknessesNotes?: string;
  summaryNotes?:    string;
}

export async function createScoutingReport(
  actor: ScoutingActor,
  dto: CreateScoutingReportDto,
): Promise<ScoutingReport> {
  _validateGrades(dto);

  const player = await prisma.player.findUnique({ where: { id: dto.playerId }, select: { id: true } });
  if (!player) throw new NotFoundError('Player');

  const compositeScore = _compositeScore(dto as any);

  const report = await prisma.scoutingReport.create({
    data: {
      clubId:          actor.clubId,
      scoutId:         actor.userId,
      playerId:        dto.playerId,
      matchId:         dto.matchId    ?? null,
      observedAt:      new Date(dto.observedAt),
      overallGrade:    dto.overallGrade    as any,
      recommendation:  dto.recommendation as any,
      technical:       dto.technical,
      physical:        dto.physical,
      mental:          dto.mental,
      tactical:        dto.tactical,
      potential:       dto.potential,
      compositeScore,
      strengthsNotes:  dto.strengthsNotes  ?? null,
      weaknessesNotes: dto.weaknessesNotes ?? null,
      summaryNotes:    dto.summaryNotes    ?? null,
    },
  });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action:     'SCOUTING_REPORT_CREATED',
    entityType: 'ScoutingReport',
    entityId:   report.id,
    payload:    { playerId: dto.playerId, overallGrade: dto.overallGrade, recommendation: dto.recommendation },
  });

  return report;
}

export async function updateScoutingReport(
  actor: ScoutingActor,
  reportId: string,
  dto: UpdateScoutingReportDto,
): Promise<ScoutingReport> {
  const report = await _assertReportOwner(actor, reportId);
  _validateGrades(dto as any);

  // Merge with existing grades to recompute composite.
  const merged = Object.fromEntries(
    GRADE_KEYS.map((k) => [k, (dto as any)[k] ?? (report as any)[k]]),
  );
  const compositeScore = _compositeScore(merged);

  return prisma.scoutingReport.update({
    where: { id: reportId },
    data: {
      ...(dto.overallGrade    !== undefined ? { overallGrade: dto.overallGrade as any }       : {}),
      ...(dto.recommendation  !== undefined ? { recommendation: dto.recommendation as any }   : {}),
      ...(dto.technical       !== undefined ? { technical: dto.technical }                    : {}),
      ...(dto.physical        !== undefined ? { physical: dto.physical }                      : {}),
      ...(dto.mental          !== undefined ? { mental: dto.mental }                          : {}),
      ...(dto.tactical        !== undefined ? { tactical: dto.tactical }                      : {}),
      ...(dto.potential       !== undefined ? { potential: dto.potential }                    : {}),
      ...(dto.strengthsNotes  !== undefined ? { strengthsNotes: dto.strengthsNotes }          : {}),
      ...(dto.weaknessesNotes !== undefined ? { weaknessesNotes: dto.weaknessesNotes }        : {}),
      ...(dto.summaryNotes    !== undefined ? { summaryNotes: dto.summaryNotes }              : {}),
      compositeScore,
    },
  });
}

export async function getScoutingReport(
  actor: ScoutingActor,
  reportId: string,
): Promise<ScoutingReport> {
  return _assertReportOwner(actor, reportId);
}

export async function listScoutingReports(
  actor: ScoutingActor,
  opts: {
    playerId?:       string;
    scoutId?:        string;
    recommendation?: string;
    overallGrade?:   string;
    limit?:          number;
    offset?:         number;
  } = {},
): Promise<{ items: ScoutingReport[]; total: number }> {
  const { limit = 20, offset = 0 } = opts;
  const where: Prisma.ScoutingReportWhereInput = {
    clubId: actor.clubId,
    ...(opts.playerId       ? { playerId: opts.playerId }                     : {}),
    ...(opts.scoutId        ? { scoutId: opts.scoutId }                       : {}),
    ...(opts.recommendation ? { recommendation: opts.recommendation as any }  : {}),
    ...(opts.overallGrade   ? { overallGrade: opts.overallGrade as any }      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.scoutingReport.findMany({
      where,
      orderBy: { observedAt: 'desc' },
      take: Math.min(limit, 100),
      skip: offset,
    }),
    prisma.scoutingReport.count({ where }),
  ]);
  return { items, total };
}

export async function deleteScoutingReport(actor: ScoutingActor, reportId: string): Promise<void> {
  await _assertReportOwner(actor, reportId);
  await prisma.scoutingReport.delete({ where: { id: reportId } });
}

// ─── Transfer Targets ─────────────────────────────────────────────────────────

const STAGE_ORDER: Record<string, number> = {
  LONGLIST: 0, SHORTLIST: 1, APPROACH: 2, NEGOTIATION: 3,
  SIGNED: 4, REJECTED: 4, LOAN: 4,
};

export interface CreateTransferTargetDto {
  playerId:          string;
  position?:         string;
  preferredFoot?:    string;
  nationality?:      string;
  currentClubName?:  string;
  askingPriceMEur?:  number;
  budgetCapMEur?:    number;
  priorityScore?:    number;    // 0–100
  notes?:            string;
}

export interface UpdateTransferTargetDto {
  askingPriceMEur?: number;
  budgetCapMEur?:   number;
  priorityScore?:   number;
  notes?:           string;
}

export async function createTransferTarget(
  actor: ScoutingActor,
  dto: CreateTransferTargetDto,
): Promise<TransferTarget> {
  const player = await prisma.player.findUnique({ where: { id: dto.playerId }, select: { id: true } });
  if (!player) throw new NotFoundError('Player');

  const existing = await prisma.transferTarget.findFirst({
    where: { clubId: actor.clubId, playerId: dto.playerId, archivedAt: null },
  });
  if (existing) {
    throw new BadRequestError('An active transfer target already exists for this player');
  }
  if (dto.priorityScore !== undefined && (dto.priorityScore < 0 || dto.priorityScore > 100)) {
    throw new BadRequestError('priorityScore must be 0–100');
  }

  return prisma.transferTarget.create({
    data: {
      clubId:           actor.clubId,
      playerId:         dto.playerId,
      stage:            'LONGLIST',
      position:         dto.position        ?? null,
      preferredFoot:    dto.preferredFoot   ?? null,
      nationality:      dto.nationality     ?? null,
      currentClubName:  dto.currentClubName ?? null,
      askingPriceMEur:  dto.askingPriceMEur ?? null,
      budgetCapMEur:    dto.budgetCapMEur   ?? null,
      priorityScore:    dto.priorityScore   ?? 50,
      notes:            dto.notes           ?? null,
      createdBy:        actor.userId,
    },
  });
}

/**
 * Advance the transfer pipeline stage.
 * Terminal stages (SIGNED, LOAN, REJECTED) automatically archive the target.
 */
export async function advanceTransferStage(
  actor: ScoutingActor,
  targetId: string,
  newStage: string,
  note?: string,
): Promise<TransferTarget> {
  const target = await _assertTargetOwner(actor, targetId);

  const currentOrder = STAGE_ORDER[target.stage] ?? 0;
  const nextOrder    = STAGE_ORDER[newStage];
  if (nextOrder === undefined) throw new BadRequestError(`Unknown stage: ${newStage}`);

  // Only REJECTED and LONGLIST (reset) are allowed as backward moves.
  if (nextOrder < currentOrder && !['REJECTED', 'LONGLIST'].includes(newStage)) {
    throw new BadRequestError(`Cannot move from ${target.stage} back to ${newStage}`);
  }

  const isTerminal = ['SIGNED', 'LOAN', 'REJECTED'].includes(newStage);

  const updated = await prisma.transferTarget.update({
    where: { id: targetId },
    data: {
      stage:      newStage as any,
      notes:      note !== undefined ? note : target.notes,
      archivedAt: isTerminal ? new Date() : null,
    },
  });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action:     'TRANSFER_STAGE_ADVANCED',
    entityType: 'TransferTarget',
    entityId:   targetId,
    payload:    { from: target.stage, to: newStage },
  });

  return updated;
}

export async function updateTransferTarget(
  actor: ScoutingActor,
  targetId: string,
  dto: UpdateTransferTargetDto,
): Promise<TransferTarget> {
  await _assertTargetOwner(actor, targetId);

  if (dto.priorityScore !== undefined && (dto.priorityScore < 0 || dto.priorityScore > 100)) {
    throw new BadRequestError('priorityScore must be 0–100');
  }

  return prisma.transferTarget.update({
    where: { id: targetId },
    data: {
      ...(dto.askingPriceMEur !== undefined ? { askingPriceMEur: dto.askingPriceMEur } : {}),
      ...(dto.budgetCapMEur   !== undefined ? { budgetCapMEur:   dto.budgetCapMEur   } : {}),
      ...(dto.priorityScore   !== undefined ? { priorityScore:   dto.priorityScore   } : {}),
      ...(dto.notes           !== undefined ? { notes:           dto.notes           } : {}),
    },
  });
}

export async function listTransferTargets(
  actor: ScoutingActor,
  opts: {
    stage?:    string;
    archived?: boolean;
    limit?:    number;
    offset?:   number;
  } = {},
): Promise<{ items: TransferTarget[]; total: number }> {
  const { limit = 20, offset = 0 } = opts;
  const where: Prisma.TransferTargetWhereInput = {
    clubId: actor.clubId,
    ...(opts.stage    ? { stage: opts.stage as any }                        : {}),
    ...(opts.archived !== undefined
      ? { archivedAt: opts.archived ? { not: null } : null }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.transferTarget.findMany({
      where,
      orderBy: [{ priorityScore: 'desc' }, { updatedAt: 'desc' }],
      take: Math.min(limit, 200),
      skip: offset,
    }),
    prisma.transferTarget.count({ where }),
  ]);
  return { items, total };
}

/** Return the full pipeline board grouped by stage (for Kanban UI). */
export async function getPipelineBoard(
  actor: ScoutingActor,
): Promise<Record<string, TransferTarget[]>> {
  const targets = await prisma.transferTarget.findMany({
    where:   { clubId: actor.clubId, archivedAt: null },
    orderBy: { priorityScore: 'desc' },
  });

  const board: Record<string, TransferTarget[]> = {
    LONGLIST:    [],
    SHORTLIST:   [],
    APPROACH:    [],
    NEGOTIATION: [],
  };

  for (const t of targets) {
    if (board[t.stage]) board[t.stage].push(t);
  }

  return board;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _assertReportOwner(actor: ScoutingActor, reportId: string): Promise<ScoutingReport> {
  const r = await prisma.scoutingReport.findUnique({ where: { id: reportId } });
  if (!r) throw new NotFoundError('ScoutingReport');
  if (r.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return r;
}

async function _assertTargetOwner(actor: ScoutingActor, targetId: string): Promise<TransferTarget> {
  const t = await prisma.transferTarget.findUnique({ where: { id: targetId } });
  if (!t) throw new NotFoundError('TransferTarget');
  if (t.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return t;
}
