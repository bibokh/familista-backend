// Familista — Workload Science Engine (Phase Q)
// ─────────────────────────────────────────────────────────────────────────────
// Implements Catapult-equivalent training load science:
//   • GPS session recording + zone breakdown
//   • ATL/CTL/TSB via exponentially weighted averages
//   • ACWR (Acute:Chronic Workload Ratio) — injury risk threshold at 1.5
//   • Monotony + strain indices (Foster 1996)
//   • Injury risk scoring (rule-based v1; ML model in Phase R)
//
// ATL  = sum of sessions in last 7 days weighted by e^(-day/7)
// CTL  = sum of sessions in last 28 days weighted by e^(-day/28)
// TSB  = CTL - ATL   (training stress balance = freshness)
// ACWR = ATL / CTL   (>1.5 = danger zone; <0.8 = undertraining)
// Monotony = mean_daily_load / SD_daily_load
// Strain   = sum_weekly_load × monotony

import { Prisma, GPSTrackingSession, WorkloadRecord, InjuryRecord } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface WorkloadActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GPS session ingest
// ─────────────────────────────────────────────────────────────────────────────

export interface GPSSessionDto {
  playerId:           string;
  matchId?:           string;
  trainingSessionId?: string;
  deviceSerial?:      string;
  startedAt:          string;
  endedAt?:           string;
  durationMin?:       number;
  totalDistanceM:     number;
  highSpeedDistanceM?: number;
  veryHighSpeedDistM?: number;
  sprintDistanceM?:   number;
  maxSpeedKph:        number;
  avgSpeedKph?:       number;
  accelerations?:     number;
  decelerations?:     number;
  highAccelerations?: number;
  playerLoad?:        number;
  zoneBreakdown?:     Record<string, number>;  // { Z1: metres, ... }
  heartRateAvg?:      number;
  heartRateMax?:      number;
  hrZoneBreakdown?:   Record<string, number>;
  rawDataRef?:        string;
}

export async function ingestGPSSession(actor: WorkloadActor, dto: GPSSessionDto): Promise<GPSTrackingSession> {
  if (!dto.playerId || !dto.startedAt || dto.totalDistanceM === undefined)
    throw new BadRequestError('playerId + startedAt + totalDistanceM required');

  const player = await prisma.player.findUnique({ where: { id: dto.playerId }, select: { clubId: true } });
  if (!player) throw new NotFoundError('Player');
  if (player.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  // Compute playerLoad if not provided — simplified 3D acc estimate from distance + speed.
  const playerLoad = dto.playerLoad ?? estimatePlayerLoad(dto);

  const row = await prisma.gPSTrackingSession.create({
    data: {
      clubId:             actor.clubId,
      playerId:           dto.playerId,
      matchId:            dto.matchId ?? null,
      trainingSessionId:  dto.trainingSessionId ?? null,
      deviceSerial:       dto.deviceSerial ?? null,
      startedAt:          new Date(dto.startedAt),
      endedAt:            dto.endedAt ? new Date(dto.endedAt) : null,
      durationMin:        dto.durationMin ?? 0,
      totalDistanceM:     dto.totalDistanceM,
      highSpeedDistanceM: dto.highSpeedDistanceM ?? 0,
      veryHighSpeedDistM: dto.veryHighSpeedDistM ?? 0,
      sprintDistanceM:    dto.sprintDistanceM ?? 0,
      maxSpeedKph:        dto.maxSpeedKph,
      avgSpeedKph:        dto.avgSpeedKph ?? 0,
      accelerations:      dto.accelerations ?? 0,
      decelerations:      dto.decelerations ?? 0,
      highAccelerations:  dto.highAccelerations ?? 0,
      playerLoad,
      zoneBreakdown:      (dto.zoneBreakdown ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      heartRateAvg:       dto.heartRateAvg ?? null,
      heartRateMax:       dto.heartRateMax ?? null,
      hrZoneBreakdown:    (dto.hrZoneBreakdown ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      rawDataRef:         dto.rawDataRef ?? null,
    },
  });

  // Trigger async workload recomputation for this player.
  recomputeWorkloadAsync(actor, dto.playerId).catch(() => {});

  return row;
}

/** Estimate PlayerLoad from distance and acceleration count when vest data unavailable. */
function estimatePlayerLoad(dto: GPSSessionDto): number {
  // Simplified: ~10 arbitrary units per km + 0.3 per high-speed km + 0.05 per accel
  const distKm   = dto.totalDistanceM / 1000;
  const hsKm     = (dto.highSpeedDistanceM ?? 0) / 1000;
  const accels   = dto.accelerations ?? 0;
  return +(distKm * 10 + hsKm * 30 + accels * 0.05).toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// ATL / CTL / TSB computation
// ─────────────────────────────────────────────────────────────────────────────

export async function recomputeWorkloadAsync(actor: WorkloadActor, playerId: string): Promise<void> {
  try { await recomputeWorkload(actor, playerId); } catch { /* swallowed — best effort */ }
}

export async function recomputeWorkload(actor: WorkloadActor, playerId: string): Promise<WorkloadRecord> {
  const now       = new Date();
  const weekStart = getMonday(now);

  // Fetch 28 days of sessions (CTL window).
  const since28 = new Date(now.getTime() - 28 * 24 * 60 * 60_000);
  const sessions = await prisma.gPSTrackingSession.findMany({
    where:   { playerId, startedAt: { gte: since28 } },
    orderBy: { startedAt: 'asc' },
    select:  { startedAt: true, playerLoad: true },
  });

  // Bin sessions into daily loads.
  const dailyLoad = new Map<number, number>(); // dayIndex → sum playerLoad
  for (const s of sessions) {
    const day = dayIndex(s.startedAt, now);  // 0=today, 27=28 days ago
    dailyLoad.set(day, (dailyLoad.get(day) ?? 0) + s.playerLoad);
  }

  // EWA for ATL (7d) and CTL (28d).
  let atl = 0, ctl = 0;
  for (let d = 0; d < 28; d++) {
    const load = dailyLoad.get(d) ?? 0;
    atl += load * Math.exp(-d / 7);
    ctl += load * Math.exp(-d / 28);
  }
  // Normalise by window area under exponential.
  const atlNorm = (1 - Math.exp(-1 / 7));
  const ctlNorm = (1 - Math.exp(-1 / 28));
  atl = atl * atlNorm;
  ctl = ctl * ctlNorm;

  const tsb  = ctl - atl;
  const acwr = ctl > 0 ? atl / ctl : 0;

  // Monotony + Strain (Foster 1996).
  const last7     = [...Array(7)].map((_, i) => dailyLoad.get(i) ?? 0);
  const mean7     = last7.reduce((s, v) => s + v, 0) / 7;
  const sd7       = Math.sqrt(last7.reduce((s, v) => s + (v - mean7) ** 2, 0) / 7);
  const monotony  = sd7 > 0 ? mean7 / sd7 : 0;
  const strain    = mean7 * 7 * monotony;  // weekly load × monotony

  // Risk flags.
  const isHighRisk    = acwr > 1.5 || tsb < -20;
  const injuryRiskScore = computeInjuryRiskScore(acwr, tsb, monotony);

  const riskFlags: Record<string, boolean> = {
    acwr_spike:         acwr > 1.5,
    acwr_low:           acwr < 0.8,
    tsb_overreached:    tsb < -20,
    high_monotony:      monotony > 2.0,
    sudden_spike:       acwr > 1.3 && sessions.length > 0,
  };

  const record = await prisma.workloadRecord.upsert({
    where:  { playerId_weekStart: { playerId, weekStart } },
    create: { clubId: actor.clubId, playerId, weekStart, acuteLoad: +atl.toFixed(2), chronicLoad: +ctl.toFixed(2), trainingStressBalance: +tsb.toFixed(2), acwr: +acwr.toFixed(3), monotony: +monotony.toFixed(3), strain: +strain.toFixed(2), isHighRisk, injuryRiskScore: +injuryRiskScore.toFixed(3), riskFlags: riskFlags as Prisma.InputJsonValue, computedAt: new Date(), updatedAt: new Date() },
    update: { acuteLoad: +atl.toFixed(2), chronicLoad: +ctl.toFixed(2), trainingStressBalance: +tsb.toFixed(2), acwr: +acwr.toFixed(3), monotony: +monotony.toFixed(3), strain: +strain.toFixed(2), isHighRisk, injuryRiskScore: +injuryRiskScore.toFixed(3), riskFlags: riskFlags as Prisma.InputJsonValue, computedAt: new Date(), updatedAt: new Date() },
  });

  if (isHighRisk) {
    appendAuditEventAsync({
      actor:  { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
      action: 'WORKLOAD_HIGH_RISK_FLAG',
      entityType: 'WorkloadRecord', entityId: record.id,
      payload: { playerId, acwr, tsb, injuryRiskScore },
    });
  }
  return record;
}

function computeInjuryRiskScore(acwr: number, tsb: number, monotony: number): number {
  // Rule-based score 0..1. Calibrated against Gabbett 2016 research.
  let score = 0;
  if (acwr > 1.5) score += 0.40;
  else if (acwr > 1.3) score += 0.20;
  else if (acwr > 1.1) score += 0.08;
  if (tsb < -20) score += 0.25;
  else if (tsb < -10) score += 0.10;
  if (monotony > 2.0) score += 0.15;
  else if (monotony > 1.5) score += 0.07;
  return Math.min(1, score);
}

/** ISO Monday for a given date. */
function getMonday(d: Date): Date {
  const dt = new Date(d);
  const day = dt.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  dt.setUTCDate(dt.getUTCDate() + diff);
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
}

/** Days ago: 0 = today, 1 = yesterday, … */
function dayIndex(d: Date, now: Date): number {
  const msPerDay = 24 * 60 * 60_000;
  return Math.round((now.getTime() - d.getTime()) / msPerDay);
}

// ─────────────────────────────────────────────────────────────────────────────
// Squad readiness dashboard
// ─────────────────────────────────────────────────────────────────────────────

export async function squadReadiness(actor: WorkloadActor, teamId: string): Promise<{
  generatedAt: string;
  highRisk:    Array<{ playerId: string; acwr: number; tsb: number; injuryRiskScore: number }>;
  available:   number;
  total:       number;
}> {
  const players = await prisma.player.findMany({
    where: { clubId: actor.clubId, teamId, isActive: true },
    select: { id: true },
  });
  const playerIds = players.map((p) => p.id);
  const weekStart = getMonday(new Date());

  const records = await prisma.workloadRecord.findMany({
    where: { playerId: { in: playerIds }, weekStart },
    orderBy: { injuryRiskScore: 'desc' },
  });

  const injuries = await prisma.injuryRecord.findMany({
    where: { playerId: { in: playerIds }, returnDate: null },
    select: { playerId: true },
  });
  const injuredIds = new Set(injuries.map((i) => i.playerId));

  const highRisk = records.filter((r) => r.isHighRisk).map((r) => ({
    playerId: r.playerId, acwr: r.acwr, tsb: +r.trainingStressBalance, injuryRiskScore: r.injuryRiskScore,
  }));

  return {
    generatedAt: new Date().toISOString(),
    highRisk,
    available: playerIds.length - injuredIds.size,
    total:     playerIds.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Injury records
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateInjuryDto {
  playerId:      string;
  injuryDate:    string;
  bodyLocation:  string;
  bodyLocationCode?: string;
  osicsCategory?: string;
  mechanism?:    string;
  severity?:     string;
  isContactInjury?: boolean;
  isRecurrence?: boolean;
  matchId?:      string;
  trainingId?:   string;
  notes?:        string;
}

export async function recordInjury(actor: WorkloadActor, dto: CreateInjuryDto): Promise<InjuryRecord> {
  if (!dto.playerId || !dto.injuryDate || !dto.bodyLocation)
    throw new BadRequestError('playerId + injuryDate + bodyLocation required');

  const player = await prisma.player.findUnique({ where: { id: dto.playerId }, select: { clubId: true } });
  if (!player) throw new NotFoundError('Player');
  if (player.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  // Capture ACWR at time of injury for post-hoc analysis.
  const weekStart = getMonday(new Date(dto.injuryDate));
  const workload  = await prisma.workloadRecord.findUnique({ where: { playerId_weekStart: { playerId: dto.playerId, weekStart } } });

  const row = await prisma.injuryRecord.create({
    data: {
      clubId:          actor.clubId,
      playerId:        dto.playerId,
      recordedBy:      actor.userId,
      injuryDate:      new Date(dto.injuryDate),
      bodyLocation:    dto.bodyLocation,
      bodyLocationCode: dto.bodyLocationCode ?? null,
      osicsCategory:   dto.osicsCategory ?? null,
      mechanism:       (dto.mechanism as any) ?? 'UNKNOWN',
      severity:        (dto.severity as any) ?? null,
      isContactInjury: !!dto.isContactInjury,
      isRecurrence:    !!dto.isRecurrence,
      matchId:         dto.matchId ?? null,
      trainingId:      dto.trainingId ?? null,
      workloadAtInjury: workload?.acwr ?? null,
      notes:           dto.notes ?? null,
    },
  });

  appendAuditEventAsync({
    actor:  { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'INJURY_RECORDED',
    entityType: 'InjuryRecord', entityId: row.id,
    payload: { playerId: dto.playerId, bodyLocation: dto.bodyLocation, severity: dto.severity ?? null, acwrAtInjury: workload?.acwr ?? null },
  });
  return row;
}

// Bug fixed: was receiving the full req.body object; now accepts a proper string.
export async function updateInjuryReturn(actor: WorkloadActor, id: string, returnDate: string): Promise<InjuryRecord> {
  const row = await prisma.injuryRecord.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('InjuryRecord');
  if (row.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  const rd   = new Date(returnDate);
  if (Number.isNaN(rd.getTime())) throw new BadRequestError('returnDate must be a valid ISO date string');
  const days = Math.round((rd.getTime() - row.injuryDate.getTime()) / (24 * 60 * 60_000));
  return prisma.injuryRecord.update({
    where: { id },
    data: { returnDate: rd, daysAbsent: days, updatedAt: new Date() },
  });
}

export async function getInjuryById(actor: WorkloadActor, id: string): Promise<InjuryRecord & { player: { id: string; firstName: string; lastName: string; number: number | null; position: string | null } }> {
  const row = await prisma.injuryRecord.findUnique({
    where: { id },
    include: { player: { select: { id: true, firstName: true, lastName: true, number: true, position: true } } },
  });
  if (!row) throw new NotFoundError('InjuryRecord');
  if (row.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return row as any;
}

export interface UpdateInjuryDto {
  injuryDate?:      string;
  bodyLocation?:    string;
  osicsCategory?:   string;
  mechanism?:       string;
  severity?:        string;
  isContactInjury?: boolean;
  isRecurrence?:    boolean;
  notes?:           string;
  returnDate?:      string | null;
}

export async function updateInjury(actor: WorkloadActor, id: string, dto: UpdateInjuryDto): Promise<InjuryRecord> {
  const row = await prisma.injuryRecord.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('InjuryRecord');
  if (row.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  const data: Record<string, unknown> = { updatedAt: new Date() };
  if (dto.injuryDate    !== undefined) data.injuryDate    = new Date(dto.injuryDate);
  if (dto.bodyLocation  !== undefined) data.bodyLocation  = dto.bodyLocation;
  if (dto.osicsCategory !== undefined) data.osicsCategory = dto.osicsCategory;
  if (dto.mechanism     !== undefined) data.mechanism     = dto.mechanism;
  if (dto.severity      !== undefined) data.severity      = dto.severity;
  if (dto.isContactInjury !== undefined) data.isContactInjury = dto.isContactInjury;
  if (dto.isRecurrence  !== undefined) data.isRecurrence  = dto.isRecurrence;
  if (dto.notes         !== undefined) data.notes         = dto.notes;
  if (dto.returnDate    !== undefined) {
    if (dto.returnDate === null) {
      data.returnDate = null;
      data.daysAbsent = null;
    } else {
      const rd = new Date(dto.returnDate);
      if (Number.isNaN(rd.getTime())) throw new BadRequestError('returnDate must be a valid ISO date string');
      const injDate = (data.injuryDate as Date) ?? row.injuryDate;
      data.returnDate = rd;
      data.daysAbsent = Math.round((rd.getTime() - injDate.getTime()) / (24 * 60 * 60_000));
    }
  }

  return prisma.injuryRecord.update({ where: { id }, data: data as Prisma.InjuryRecordUpdateInput });
}

export async function deleteInjury(actor: WorkloadActor, id: string): Promise<void> {
  const row = await prisma.injuryRecord.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('InjuryRecord');
  if (row.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  await prisma.injuryRecord.delete({ where: { id } });
}

// Bug fixed: added include: { player } so callers don't need a separate player lookup.
export async function listInjuries(
  actor: WorkloadActor,
  opts: { playerId?: string; teamId?: string; activeOnly?: boolean } = {},
): Promise<(InjuryRecord & { player: { id: string; firstName: string; lastName: string; number: number | null; position: string | null } })[]> {
  let playerIds: string[] | undefined;
  if (opts.teamId) {
    const players = await prisma.player.findMany({ where: { clubId: actor.clubId, teamId: opts.teamId }, select: { id: true } });
    playerIds = players.map((p) => p.id);
  }
  return prisma.injuryRecord.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.playerId   ? { playerId: opts.playerId }     : {}),
      ...(playerIds       ? { playerId: { in: playerIds } } : {}),
      ...(opts.activeOnly ? { returnDate: null }            : {}),
    },
    include: { player: { select: { id: true, firstName: true, lastName: true, number: true, position: true } } },
    orderBy: { injuryDate: 'desc' },
  }) as any;
}

export async function getPlayerMedicalProfile(
  actor: WorkloadActor,
  playerId: string,
): Promise<{
  player: { id: string; firstName: string; lastName: string; medicalStatus: string | null; isInjured: boolean; condition: number };
  injuries: InjuryRecord[];
  workload: { acwr: number; isHighRisk: boolean; injuryRiskScore: number } | null;
}> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, firstName: true, lastName: true, medicalStatus: true, isInjured: true, condition: true, clubId: true },
  });
  if (!player) throw new NotFoundError('Player');
  if (player.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  const [injuries, workloadRow] = await Promise.all([
    prisma.injuryRecord.findMany({
      where: { playerId, clubId: actor.clubId },
      orderBy: { injuryDate: 'desc' },
    }),
    prisma.workloadRecord.findFirst({
      where: { playerId },
      orderBy: { weekStart: 'desc' },
      select: { acwr: true, isHighRisk: true, injuryRiskScore: true },
    }),
  ]);

  return {
    player: { id: player.id, firstName: player.firstName, lastName: player.lastName, medicalStatus: player.medicalStatus, isInjured: player.isInjured, condition: player.condition },
    injuries,
    workload: workloadRow ? { acwr: workloadRow.acwr, isHighRisk: workloadRow.isHighRisk, injuryRiskScore: workloadRow.injuryRiskScore } : null,
  };
}
