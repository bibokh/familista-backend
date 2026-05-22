// Familista — Observability extensions (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// Aggregators that read Phase J observability + Phase L tables and write
// rolling snapshots. Append-only.

import { AIConsensusHealth, DeviceFleetHealth, FederatedAggregationHealth, Prisma, RegionalHealthSnapshot, SimulationQueueHealth } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ── Regional snapshot ───────────────────────────────────────────────────

export async function captureRegionalSnapshot(regionId: string): Promise<RegionalHealthSnapshot | null> {
  try {
    const since = new Date(Date.now() - 5 * 60_000);
    const [beats, nodes, recentMetrics] = await Promise.all([
      prisma.regionHeartbeat.count({ where: { regionId, capturedAt: { gte: since } } }),
      prisma.regionNode.count({ where: { regionId, status: 'ACTIVE' } }),
      prisma.systemMetric.count({ where: { regionId, capturedAt: { gte: since } } }),
    ]);
    return prisma.regionalHealthSnapshot.create({
      data: {
        regionId,
        snapshot: { heartbeats5m: beats, activeNodes: nodes, metrics5m: recentMetrics, ts: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.warn('[obs-l] captureRegionalSnapshot failed', { regionId, err: (err as Error).message });
    return null;
  }
}

// ── Device fleet ────────────────────────────────────────────────────────

export async function captureDeviceFleetHealth(clubId: string | null, model: string): Promise<DeviceFleetHealth | null> {
  try {
    const totalWhere = { model, ...(clubId ? { clubId } : {}) };
    const [total, active, recentHealth] = await Promise.all([
      prisma.device.count({ where: totalWhere }),
      prisma.device.count({ where: { ...totalWhere, status: 'ACTIVE' } }),
      prisma.deviceHealth.findMany({
        where:   { capturedAt: { gte: new Date(Date.now() - 10 * 60_000) } },
        select:  { score: true, deviceId: true },
        take:    5000,
      }),
    ]);
    const stale = recentHealth.filter((h) => h.score < 0.6).length;
    const meanScore = recentHealth.length === 0 ? 1.0 : recentHealth.reduce((s, h) => s + h.score, 0) / recentHealth.length;
    return prisma.deviceFleetHealth.create({
      data: {
        clubId,
        model,
        totalDevices:  total,
        activeDevices: active,
        staleDevices:  stale,
        meanScore:     Number(meanScore.toFixed(3)),
      },
    });
  } catch (err) {
    logger.warn('[obs-l] captureDeviceFleetHealth failed', { err: (err as Error).message });
    return null;
  }
}

// ── AI consensus ───────────────────────────────────────────────────────

export async function captureAIConsensusHealth(matchId: string | null): Promise<AIConsensusHealth | null> {
  try {
    const since = new Date(Date.now() - 5 * 60_000);
    const decisions = await prisma.aIAgentDecision.findMany({
      where: { ...(matchId ? { matchId } : {}), createdAt: { gte: since } },
      select: { confidence: true, backend: true },
      take: 5000,
    });
    if (decisions.length === 0) {
      return prisma.aIConsensusHealth.create({ data: { matchId, agreementRate: 1, divergenceCount: 0 } });
    }
    // Crude consensus: ratio of decisions with confidence > 0.6.
    const high = decisions.filter((d) => d.confidence >= 0.6).length;
    const agreement = high / decisions.length;
    const divergence = decisions.length - high;
    return prisma.aIConsensusHealth.create({
      data: { matchId, agreementRate: Number(agreement.toFixed(3)), divergenceCount: divergence },
    });
  } catch (err) {
    logger.warn('[obs-l] captureAIConsensusHealth failed', { err: (err as Error).message });
    return null;
  }
}

// ── Federated aggregation ──────────────────────────────────────────────

export async function captureFederatedHealth(jobId: string): Promise<FederatedAggregationHealth | null> {
  try {
    const envs = await prisma.federatedGradientEnvelope.findMany({ where: { jobId }, select: { normValue: true, acceptedAt: true, rejectedReason: true } });
    const accepted = envs.filter((e) => e.acceptedAt && !e.rejectedReason).length;
    const rejected = envs.filter((e) => e.rejectedReason).length;
    const meanNorm = envs.length === 0 ? null : envs.reduce((s, e) => s + (e.normValue ?? 0), 0) / envs.length;
    return prisma.federatedAggregationHealth.create({
      data: { jobId, participants: envs.length, acceptedCount: accepted, rejectedCount: rejected, meanNorm },
    });
  } catch (err) {
    logger.warn('[obs-l] captureFederatedHealth failed', { err: (err as Error).message });
    return null;
  }
}

// ── Simulation queue ───────────────────────────────────────────────────

export async function captureSimulationQueueHealth(): Promise<SimulationQueueHealth | null> {
  try {
    const since = new Date(Date.now() - 60 * 60_000);
    const [pending, running, completed1h, failed1h] = await Promise.all([
      prisma.twinSimulationSession.count({ where: { status: 'DRAFT' } }),
      prisma.twinSimulationSession.count({ where: { status: 'RUNNING' } }),
      prisma.twinSimulationSession.count({ where: { status: 'COMPLETED', completedAt: { gte: since } } }),
      prisma.twinSimulationSession.count({ where: { status: 'FAILED', completedAt: { gte: since } } }),
    ]);
    return prisma.simulationQueueHealth.create({
      data: { pending, running, completed1h, failed1h },
    });
  } catch (err) {
    logger.warn('[obs-l] captureSimulationQueueHealth failed', { err: (err as Error).message });
    return null;
  }
}

// ── Snapshot endpoint (single-call rollup) ─────────────────────────────

export async function snapshotPhaseL(): Promise<{
  ts:       string;
  region:   { active: number; heartbeats5m: number };
  devices:  { fleetRows: number };
  ai:       { recentDecisions: number };
  federated: { activeJobs: number };
  simulation: { active: number };
}> {
  const since = new Date(Date.now() - 5 * 60_000);
  const [activeRegions, beats, fleetRows, decisions, activeJobs, activeSims] = await Promise.all([
    prisma.region.count({ where: { status: 'ACTIVE' } }),
    prisma.regionHeartbeat.count({ where: { capturedAt: { gte: since } } }),
    prisma.deviceFleetHealth.count(),
    prisma.aIAgentDecision.count({ where: { createdAt: { gte: since } } }),
    prisma.federatedTrainingJob.count({ where: { status: { in: ['PENDING', 'RUNNING', 'AGGREGATING'] } } }),
    prisma.twinSimulationSession.count({ where: { status: { in: ['DRAFT', 'RUNNING'] } } }),
  ]);
  return {
    ts:       new Date().toISOString(),
    region:   { active: activeRegions, heartbeats5m: beats },
    devices:  { fleetRows },
    ai:       { recentDecisions: decisions },
    federated: { activeJobs },
    simulation: { active: activeSims },
  };
}
