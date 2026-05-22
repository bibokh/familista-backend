// Familista — Enterprise observability (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// Bounded-cardinality metric writer + health snapshot.
//
// Cardinality control: we whitelist `name` strings in METRIC_NAMES. Anything
// else is bucketed into "custom" with the original name moved to `label`.
// This prevents adversarial / typo'd metric names from exploding the table.

import { Prisma, MetricKind, SystemMetric, DeviceHealth, RealtimeHealth, AIWorkerHealth, ReplayIntegrityMetric } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const METRIC_NAMES = new Set([
  'sse.active_subs',
  'ws.active_conns',
  'outbox.pending',
  'outbox.published_total',
  'ai_worker.jobs_per_min',
  'ai_worker.failures_per_min',
  'rate_limit.hit',
  'audit_chain.head_position',
  'security.events_total',
  'region.heartbeats_total',
  'replay.integrity_checks',
  'custom',
]);

// ─────────────────────────────────────────────────────────────────────────
// Writers (best-effort)
// ─────────────────────────────────────────────────────────────────────────

export interface RecordMetricInput {
  name:      string;
  value:     number;
  kind?:     MetricKind;
  label?:    string;
  regionId?: string | null;
}

export function recordMetric(input: RecordMetricInput): void {
  const safeName = METRIC_NAMES.has(input.name) ? input.name : 'custom';
  const safeLabel = safeName === 'custom' ? [input.label, input.name].filter(Boolean).join('|') : input.label;
  prisma.systemMetric.create({
    data: {
      name:     safeName,
      value:    input.value,
      kind:     input.kind ?? 'GAUGE',
      label:    safeLabel ?? null,
      regionId: input.regionId ?? null,
    },
  }).catch((err) => {
    logger.warn('[metrics] write failed', { name: input.name, err: (err as Error).message });
  });
}

export async function listMetrics(opts: { name?: string; regionId?: string; fromTs?: Date; toTs?: Date; limit?: number } = {}): Promise<SystemMetric[]> {
  return prisma.systemMetric.findMany({
    where: {
      ...(opts.name     ? { name:     opts.name } : {}),
      ...(opts.regionId ? { regionId: opts.regionId } : {}),
      ...((opts.fromTs || opts.toTs) ? {
        capturedAt: {
          ...(opts.fromTs ? { gte: opts.fromTs } : {}),
          ...(opts.toTs   ? { lte: opts.toTs }   : {}),
        },
      } : {}),
    },
    orderBy: { capturedAt: 'desc' },
    take: Math.min(opts.limit ?? 500, 5000),
  });
}

// ── Device health ───────────────────────────────────────────────────────

export interface RecordDeviceHealthInput {
  deviceId:     string;
  score:        number;
  lastPacketAt?: Date | null;
  batteryPct?:  number | null;
  signalDbm?:   number | null;
  notes?:       string;
}

export function recordDeviceHealth(input: RecordDeviceHealthInput): void {
  prisma.deviceHealth.create({
    data: {
      deviceId:     input.deviceId,
      score:        Math.max(0, Math.min(1, input.score)),
      lastPacketAt: input.lastPacketAt ?? null,
      batteryPct:   input.batteryPct ?? null,
      signalDbm:    input.signalDbm ?? null,
      notes:        input.notes ?? null,
    },
  }).catch((err) => logger.warn('[metrics] deviceHealth failed', { deviceId: input.deviceId, err: (err as Error).message }));
}

export async function listDeviceHealth(deviceId: string, limit = 100): Promise<DeviceHealth[]> {
  return prisma.deviceHealth.findMany({
    where: { deviceId },
    orderBy: { capturedAt: 'desc' },
    take: Math.min(limit, 500),
  });
}

// ── Realtime health ────────────────────────────────────────────────────

export function recordRealtimeHealth(input: { kind: string; activeSubs?: number; queueDepth?: number; errors1m?: number; regionId?: string | null }): void {
  prisma.realtimeHealth.create({
    data: {
      kind:       input.kind,
      activeSubs: input.activeSubs ?? 0,
      queueDepth: input.queueDepth ?? 0,
      errors1m:   input.errors1m ?? 0,
      regionId:   input.regionId ?? null,
    },
  }).catch((err) => logger.warn('[metrics] realtimeHealth failed', { err: (err as Error).message }));
}

// ── AI worker health ───────────────────────────────────────────────────

export function recordAIWorkerHealth(input: { workerId: string; lastTickAt?: Date | null; jobsPerMin?: number; failuresPerMin?: number; regionId?: string | null }): void {
  prisma.aIWorkerHealth.create({
    data: {
      workerId:       input.workerId,
      lastTickAt:     input.lastTickAt ?? new Date(),
      jobsPerMin:     input.jobsPerMin ?? 0,
      failuresPerMin: input.failuresPerMin ?? 0,
      regionId:       input.regionId ?? null,
    },
  }).catch((err) => logger.warn('[metrics] aiWorkerHealth failed', { err: (err as Error).message }));
}

// ── Replay integrity ───────────────────────────────────────────────────

export async function checkReplayIntegrity(matchId: string): Promise<ReplayIntegrityMetric> {
  const seqRow = await prisma.matchEventSequence.findUnique({ where: { matchId } });
  const actualCount = await prisma.eventOutbox.count({ where: { matchId } });
  const expectedSeq = seqRow ? Number(seqRow.next) : 0;
  const actualSeq   = actualCount;
  const ok = expectedSeq === actualSeq;
  return prisma.replayIntegrityMetric.create({
    data: {
      matchId,
      expectedSeq: BigInt(expectedSeq),
      actualSeq:   BigInt(actualSeq),
      ok,
      brokenAt:    ok ? null : BigInt(Math.min(expectedSeq, actualSeq)),
    },
  });
}

export async function listReplayIntegrity(matchId: string, limit = 20): Promise<ReplayIntegrityMetric[]> {
  return prisma.replayIntegrityMetric.findMany({
    where: { matchId },
    orderBy: { capturedAt: 'desc' },
    take: Math.min(limit, 200),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Snapshot endpoint payload
// ─────────────────────────────────────────────────────────────────────────

export async function snapshot(opts: { regionId?: string } = {}): Promise<{
  generatedAt: string;
  region: string | null;
  outbox: { pending: number; published: number };
  ai:     { recentJobs: number; failures: number };
  security: { events1h: number };
  realtime: { rows1h: number };
}> {
  const since = new Date(Date.now() - 60 * 60_000);
  const [outboxPending, outboxPublished, recentJobs, failures, secEvents, rtRows] = await Promise.all([
    prisma.eventOutbox.count({ where: { publishedAt: null } }),
    prisma.eventOutbox.count({ where: { publishedAt: { not: null } } }),
    prisma.aIAgentJob.count({ where: { createdAt: { gte: since } } }),
    prisma.aIAgentJob.count({ where: { status: 'FAILED', finishedAt: { gte: since } } }),
    prisma.securityEvent.count({ where: { createdAt: { gte: since } } }),
    prisma.realtimeHealth.count({ where: { capturedAt: { gte: since }, ...(opts.regionId ? { regionId: opts.regionId } : {}) } }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    region: opts.regionId ?? null,
    outbox: { pending: outboxPending, published: outboxPublished },
    ai:     { recentJobs, failures },
    security: { events1h: secEvents },
    realtime: { rows1h: rtRows },
  };
}
