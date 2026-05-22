// Familista — Anomaly Detector (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// Cross-domain anomaly surface. Aggregates signals from:
//   - Rules engine     (per-match)
//   - Device sessions  (stale / offline streams)
//   - AI agent jobs    (failure streaks)
//   - Outbox health    (unpublished backlog)
//
// Calls are bounded and read-only. Result is a structured report — NOT
// alerts directly. Callers decide whether to materialise alerts via
// ai-ops.createAlert(). This separation prevents alert flooding when the
// detector runs on a schedule.

import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import * as aiOps from './ai-ops.service';

export interface Anomaly {
  kind:      string;
  severity:  'INFO' | 'WARN' | 'CRITICAL';
  title:     string;
  detail:    string;
  payload:   Record<string, unknown>;
}

export interface AnomalyReport {
  clubId:    string;
  scannedAt: number;
  anomalies: Anomaly[];
}

const DEVICE_OFFLINE_MS = 5 * 60 * 1000;
const OUTBOX_BACKLOG    = 5_000;
const JOB_FAIL_WINDOW_MIN = 60;
const JOB_FAIL_THRESHOLD  = 5;

export async function scanClub(clubId: string): Promise<AnomalyReport> {
  const out: Anomaly[] = [];
  const now = Date.now();

  const [staleSessions, recentFailedJobs, outboxBacklog] = await Promise.all([
    findStaleDevices(clubId, now - DEVICE_OFFLINE_MS),
    prisma.aIAgentJob.count({
      where: {
        clubId,
        status: 'FAILED',
        finishedAt: { gte: new Date(now - JOB_FAIL_WINDOW_MIN * 60_000) },
      },
    }),
    prisma.eventOutbox.count({ where: { clubId, publishedAt: null } }),
  ]);

  if (staleSessions.length > 0) {
    out.push({
      kind:    'DEVICE_FLEET_STALE',
      severity: staleSessions.length > 3 ? 'CRITICAL' : 'WARN',
      title:   `${staleSessions.length} device session(s) silent > 5 min`,
      detail:  `Sessions: ${staleSessions.map((s) => s.id.slice(0, 8)).join(', ')}`,
      payload: { sessions: staleSessions },
    });
  }

  if (recentFailedJobs >= JOB_FAIL_THRESHOLD) {
    out.push({
      kind:    'AI_JOB_FAILURE_CLUSTER',
      severity: 'CRITICAL',
      title:   `${recentFailedJobs} AI agent jobs failed in last ${JOB_FAIL_WINDOW_MIN} min`,
      detail:  'Possible upstream (LLM API) or downstream (DB) outage.',
      payload: { count: recentFailedJobs, windowMin: JOB_FAIL_WINDOW_MIN },
    });
  }

  if (outboxBacklog > OUTBOX_BACKLOG) {
    out.push({
      kind:    'BIGDATA_OUTBOX_BACKLOG',
      severity: 'WARN',
      title:   `Outbox backlog ${outboxBacklog} rows`,
      detail:  'Big-data adapters may be offline or slow; replay-safe but downstream is lagging.',
      payload: { backlog: outboxBacklog, threshold: OUTBOX_BACKLOG },
    });
  }

  return { clubId, scannedAt: now, anomalies: out };
}

/** Returns the device sessions whose last packet is older than `before`. */
async function findStaleDevices(clubId: string, before: number) {
  const sessions = await prisma.deviceSession.findMany({
    where:  { clubId, endedAt: null },
    select: { id: true, deviceModel: true, deviceSerial: true, startedAt: true },
  });
  const stale: Array<{ id: string; deviceModel: string; lastMs: number | null }> = [];
  for (const s of sessions) {
    const last = await prisma.sensorPacket.findFirst({
      where:   { deviceSessionId: s.id },
      orderBy: { capturedAt: 'desc' },
      select:  { capturedAt: true },
    });
    const ts = last?.capturedAt?.getTime() ?? s.startedAt.getTime();
    if (ts < before) stale.push({ id: s.id, deviceModel: s.deviceModel, lastMs: ts });
  }
  return stale;
}

/** Convenience: materialise anomalies as AIAlert rows (one per anomaly). */
export async function materialiseAlerts(clubId: string, report: AnomalyReport): Promise<{ created: number }> {
  let created = 0;
  for (const a of report.anomalies) {
    try {
      await aiOps.createAlert({
        clubId,
        kind:     a.kind,
        severity: a.severity,
        title:    a.title,
        message:  a.detail,
        payload:  a.payload as never,
        agent:    'CLUB_MANAGER',
      });
      created++;
    } catch (err) {
      logger.warn('[anomaly] alert materialise failed', { kind: a.kind, err: (err as Error).message });
    }
  }
  return { created };
}
