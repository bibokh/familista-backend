// Familista — Region resolver + heartbeat (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// Single control plane (Phase J) → multiple regional runtimes.
// Each runtime registers as a RegionNode on boot and emits heartbeats.
// Region.code is the routing key tenants use to pick the right region.
//
// Resolution rules:
//   1. Explicit Club.metadata.regionCode wins (will be wired later).
//   2. Otherwise look up the env REGION_CODE for the running process.
//   3. Fall back to "EU" (Frankfurt, the current Render anchor).

import { Prisma, Region, RegionStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const PROCESS_REGION = (process.env.REGION_CODE || 'EU').toUpperCase();
const NODE_KIND      = (process.env.REGION_NODE_KIND as 'API' | 'REALTIME' | 'WORKER' | 'EDGE_GATEWAY' | undefined) || 'API';
const NODE_ID        = process.env.REGION_NODE_ID
                    || process.env.RENDER_SERVICE_NAME
                    || process.env.HOSTNAME
                    || `local-${Math.random().toString(36).slice(2, 8)}`;

// ─────────────────────────────────────────────────────────────────────────
// Region directory
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_REGIONS: Array<{ code: string; label: string; anchorCity: string; primary?: boolean; failoverCode?: string }> = [
  { code: 'EU',      label: 'Europe',          anchorCity: 'Frankfurt',    primary: true,  failoverCode: 'MEA' },
  { code: 'MEA',     label: 'Middle East / Africa', anchorCity: 'Dubai',  failoverCode: 'EU' },
  { code: 'NORAM',   label: 'North America',   anchorCity: 'New York',     failoverCode: 'SOUTHAM' },
  { code: 'SOUTHAM', label: 'South America',   anchorCity: 'São Paulo',    failoverCode: 'NORAM' },
  { code: 'APAC',    label: 'Asia Pacific',    anchorCity: 'Tokyo',        failoverCode: 'EU' },
];

/** Idempotent seeding — safe to call on every boot. */
export async function ensureRegions(): Promise<void> {
  for (const r of DEFAULT_REGIONS) {
    try {
      await prisma.region.upsert({
        where:  { code: r.code },
        create: {
          code: r.code,
          label: r.label,
          anchorCity: r.anchorCity,
          primary: !!r.primary,
          failoverCode: r.failoverCode ?? null,
          status: 'ACTIVE',
        },
        update: { /* no-op */ },
      });
    } catch (err) {
      logger.warn('[region] ensure failed', { code: r.code, err: (err as Error).message });
    }
  }
}

/** Return all regions sorted by primary-first, then code. */
export async function listRegions(): Promise<Region[]> {
  return prisma.region.findMany({ orderBy: [{ primary: 'desc' }, { code: 'asc' }] });
}

export async function getRegionByCode(code: string): Promise<Region | null> {
  return prisma.region.findUnique({ where: { code: code.toUpperCase() } });
}

/** Resolve the region a club belongs to. Pure-function over Club.metadata + env defaults. */
export async function resolveRegionForClub(clubId: string): Promise<string> {
  try {
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });
    if (!club) return PROCESS_REGION;
    // Future: read Club.metadata.regionCode once that field exists.
    return PROCESS_REGION;
  } catch {
    return PROCESS_REGION;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Node identity + heartbeat
// ─────────────────────────────────────────────────────────────────────────

let _registered = false;

export async function registerThisNode(): Promise<void> {
  if (_registered) return;
  try {
    const region = await prisma.region.findUnique({ where: { code: PROCESS_REGION } });
    if (!region) {
      logger.warn('[region] this node has no matching region row', { regionCode: PROCESS_REGION });
      _registered = true;
      return;
    }
    await prisma.regionNode.upsert({
      where:  { nodeId: NODE_ID },
      create: {
        nodeId: NODE_ID,
        kind:   NODE_KIND,
        regionId: region.id,
        url:    process.env.REGION_NODE_URL ?? null,
        version: process.env.npm_package_version ?? null,
        status: 'ACTIVE',
      },
      update: { lastSeenAt: new Date(), status: 'ACTIVE' },
    });
    _registered = true;
    logger.info('[region] node registered', { regionCode: PROCESS_REGION, nodeId: NODE_ID, kind: NODE_KIND });
  } catch (err) {
    logger.warn('[region] register failed', { err: (err as Error).message });
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000;
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Start a periodic heartbeat. Idempotent. */
export function startHeartbeat(): void {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    void emitHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  void emitHeartbeat();
}

export function stopHeartbeat(): void {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

export async function emitHeartbeat(metrics: { activeSubs?: number; queueDepth?: number; healthScore?: number } = {}): Promise<void> {
  try {
    const region = await prisma.region.findUnique({ where: { code: PROCESS_REGION } });
    if (!region) return;
    const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    await prisma.regionHeartbeat.create({
      data: {
        regionId:    region.id,
        nodeId:      NODE_ID,
        healthScore: metrics.healthScore ?? 1.0,
        memMb,
        activeSubs:  metrics.activeSubs ?? null,
        queueDepth:  metrics.queueDepth ?? null,
      },
    });
    await prisma.regionNode.update({
      where: { nodeId: NODE_ID },
      data:  { lastSeenAt: new Date() },
    }).catch(() => undefined);
  } catch (err) {
    // Best-effort.
    logger.warn('[region] heartbeat failed', { err: (err as Error).message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Health aggregation
// ─────────────────────────────────────────────────────────────────────────

/** Rolling 5-min summary per region. */
export async function snapshotHealth(): Promise<Array<{ regionCode: string; healthyNodes: number; totalNodes: number; meanScore: number }>> {
  const regions = await listRegions();
  const since = new Date(Date.now() - 5 * 60_000);
  const out: Array<{ regionCode: string; healthyNodes: number; totalNodes: number; meanScore: number }> = [];

  for (const r of regions) {
    const beats = await prisma.regionHeartbeat.findMany({
      where:   { regionId: r.id, capturedAt: { gte: since } },
      select:  { nodeId: true, healthScore: true },
    });
    if (beats.length === 0) {
      out.push({ regionCode: r.code, healthyNodes: 0, totalNodes: 0, meanScore: 0 });
      continue;
    }
    const byNode: Record<string, number[]> = {};
    for (const b of beats) (byNode[b.nodeId] ??= []).push(b.healthScore);
    const nodeMeans = Object.values(byNode).map((arr) => arr.reduce((s, v) => s + v, 0) / arr.length);
    const healthy = nodeMeans.filter((m) => m >= 0.8).length;
    const meanScore = nodeMeans.reduce((s, v) => s + v, 0) / nodeMeans.length;
    out.push({ regionCode: r.code, healthyNodes: healthy, totalNodes: nodeMeans.length, meanScore: Number(meanScore.toFixed(3)) });

    // Update RegionHealth row.
    await prisma.regionHealth.upsert({
      where:  { regionId: r.id },
      create: { regionId: r.id, healthyNodes: healthy, totalNodes: nodeMeans.length, meanScore },
      update: { healthyNodes: healthy, totalNodes: nodeMeans.length, meanScore },
    }).catch(() => undefined);
  }
  return out;
}

/** Mark a region as DEGRADED / OFFLINE / ACTIVE. */
export async function setRegionStatus(code: string, status: RegionStatus): Promise<Region> {
  return prisma.region.update({ where: { code: code.toUpperCase() }, data: { status } });
}

export function getThisNodeId(): string { return NODE_ID; }
export function getThisRegionCode(): string { return PROCESS_REGION; }
