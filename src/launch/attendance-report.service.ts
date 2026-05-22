// Familista — Phase P · Attendance reports
// ─────────────────────────────────────────────────────────────────────────────
// Read-side rollups composed on top of Phase O TrainingAttendanceRecord +
// MatchAttendanceRecord. No new writes. Tenant-scoped.

import { AttendanceMark, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError } from '../utils/errors';

export interface LaunchActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const ALL_MARKS: AttendanceMark[] = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'];

export interface AttendanceRollup {
  scope:      { kind: 'TRAINING' | 'MATCH'; teamId?: string; playerId?: string };
  windowDays: number;
  total:      number;
  byMark:     Record<AttendanceMark, number>;
  rate:       number;            // 0..1 (present + late)/total
  recent:     Array<{ id: string; mark: AttendanceMark; recordedAt: string; sessionOrMatchId: string }>;
}

function startOfWindow(days: number): Date {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

export async function trainingAttendanceReport(actor: LaunchActor, opts: { teamId?: string; playerId?: string; windowDays?: number } = {}): Promise<AttendanceRollup> {
  const windowDays = Math.min(Math.max(opts.windowDays ?? 30, 1), 365);
  const since = startOfWindow(windowDays);
  const where: Prisma.TrainingAttendanceRecordWhereInput = {
    clubId: actor.clubId,
    recordedAt: { gte: since },
    ...(opts.playerId ? { playerId: opts.playerId } : {}),
    ...(opts.teamId ? { trainingSession: { is: { clubId: actor.clubId } } } : {}),
  };
  const [rows, byMark] = await Promise.all([
    prisma.trainingAttendanceRecord.findMany({ where, orderBy: { recordedAt: 'desc' }, take: 200 }),
    prisma.trainingAttendanceRecord.groupBy({ by: ['mark'], where, _count: { _all: true } }),
  ]);
  const tallies: Record<AttendanceMark, number> = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
  for (const r of byMark) tallies[r.mark] = r._count._all;
  const total = ALL_MARKS.reduce((s, m) => s + tallies[m], 0);
  const rate = total ? (tallies.PRESENT + tallies.LATE) / total : 0;
  return {
    scope: { kind: 'TRAINING', teamId: opts.teamId, playerId: opts.playerId },
    windowDays, total, byMark: tallies, rate,
    recent: rows.slice(0, 50).map((r) => ({
      id: r.id, mark: r.mark, recordedAt: r.recordedAt.toISOString(), sessionOrMatchId: r.trainingSessionId,
    })),
  };
}

export async function matchAttendanceReport(actor: LaunchActor, opts: { teamId?: string; playerId?: string; windowDays?: number } = {}): Promise<AttendanceRollup> {
  const windowDays = Math.min(Math.max(opts.windowDays ?? 90, 1), 365);
  const since = startOfWindow(windowDays);
  const where: Prisma.MatchAttendanceRecordWhereInput = {
    clubId: actor.clubId,
    recordedAt: { gte: since },
    ...(opts.playerId ? { playerId: opts.playerId } : {}),
  };
  const [rows, byMark] = await Promise.all([
    prisma.matchAttendanceRecord.findMany({ where, orderBy: { recordedAt: 'desc' }, take: 200 }),
    prisma.matchAttendanceRecord.groupBy({ by: ['mark'], where, _count: { _all: true } }),
  ]);
  const tallies: Record<AttendanceMark, number> = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
  for (const r of byMark) tallies[r.mark] = r._count._all;
  const total = ALL_MARKS.reduce((s, m) => s + tallies[m], 0);
  const rate = total ? (tallies.PRESENT + tallies.LATE) / total : 0;
  return {
    scope: { kind: 'MATCH', teamId: opts.teamId, playerId: opts.playerId },
    windowDays, total, byMark: tallies, rate,
    recent: rows.slice(0, 50).map((r) => ({
      id: r.id, mark: r.mark, recordedAt: r.recordedAt.toISOString(), sessionOrMatchId: r.matchId,
    })),
  };
}

export async function combinedAttendanceReport(actor: LaunchActor, playerId: string, windowDays = 60) {
  if (!playerId) throw new BadRequestError('playerId required');
  const [training, match] = await Promise.all([
    trainingAttendanceReport(actor, { playerId, windowDays }),
    matchAttendanceReport(actor, { playerId, windowDays }),
  ]);
  return { playerId, windowDays, training, match };
}
