// Familista — Live Tactical State engine (Phase E)
// ─────────────────────────────────────────────────────────────────────────
// Pure-function projection of "what's happening on the pitch right now".
//
// Cost model: ONE call to getState() = bounded DB read (4 queries, all
// indexed, all with explicit `take` caps). No caching, no write-amp.
// Safe to call once per SSE tick — typical p95 < 60ms.
//
// Output shape is the public contract consumed by:
//   - GET /matches/:id/tactical-state  (REST poll)
//   - SSE stream `event: LIVE_STATE_UPDATE` (push)
//   - Frontend Match Center "Live" tab
//
// Design rule: NEVER throw from inside the engine — sparse data is the
// normal case (a new match has no sensor data yet). Missing inputs
// degrade gracefully to nulls.

import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { SPRINT_THRESHOLD_MPS } from '../fusion/metrics';

// ─────────────────────────────────────────────────────────────────────────
// Public types — the SSE / REST contract.
// ─────────────────────────────────────────────────────────────────────────

export type LiveAlertLevel = 'OK' | 'CAUTION' | 'CRITICAL';

export interface PlayerLiveState {
  playerId:  string;
  number:    number | null;
  name:      string;
  position:  string | null;
  /** Pitch coords (0..100). null when no spatial data yet. */
  x:         number | null;
  y:         number | null;
  /** Last known heart-rate in BPM. */
  hr:        number | null;
  /** 1 if speed > sprint threshold at the latest tick. */
  sprint:    0 | 1;
  /** Latest TAI bucket — null if not enough sensor data. */
  tai:       number | null;
  alert:     LiveAlertLevel;
  /** ms since last sensor packet for this player. */
  staleMs:   number | null;
}

export interface TeamShapeState {
  /** Centroid of all PLAYERS with positions on our team. */
  centroidX:     number | null;
  centroidY:     number | null;
  /** Mean x of the back-most third — a rough defensive line proxy. */
  defensiveLineX: number | null;
  spreadX:       number | null;
  spreadY:       number | null;
  /** 0..1 — higher = more compact / higher line / more pressing. */
  pressingIndex: number | null;
}

export interface TacticalPhaseState {
  phase:        string;       // OPEN_PLAY | DEFENSIVE_BLOCK | HIGH_PRESS | …
  formation:    string | null;
  changedAtMs:  number;
  notes:        string | null;
  possession:   number | null;
}

export interface DeviceStreamStatus {
  sessionId:     string;
  deviceModel:   string;
  startedAt:     string;
  endedAt:       string | null;
  /** ms since last packet — null if never any. */
  lastPacketMs:  number | null;
  /** OK <30s, STALE 30-60s, OFFLINE >60s, ENDED if session closed. */
  health:        'OK' | 'STALE' | 'OFFLINE' | 'ENDED';
}

export interface TacticalState {
  matchId:      string;
  clubId:       string;
  generatedAt:  number;       // server epoch ms
  players:      PlayerLiveState[];
  teamShape:    TeamShapeState;
  phase:        TacticalPhaseState;
  devices:      DeviceStreamStatus[];
  /** Last 10 timeline events, newest first. */
  recentEvents: Array<{
    minute:  number;
    kind:    string;
    side:    string;
    notes:   string | null;
    payload: unknown;
  }>;
  /** Last 10 OPEN alerts, newest first. */
  openAlerts: Array<{
    id:        string;
    kind:      string;
    severity:  'INFO' | 'WARN' | 'CRITICAL';
    title:     string;
    createdAt: string;
  }>;
  /** Aggregate quality of the picture. */
  diagnostics: {
    haveLineup:   boolean;
    haveSnapshot: boolean;
    haveSensors:  boolean;
    sensorPackets60s: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────

const SENSOR_WINDOW_MS = 60_000;     // last 60s of GPS/HR for liveness
const ALERT_TAI_WARN   = 0.75;
const ALERT_TAI_CRIT   = 0.90;

export async function getState(matchId: string, clubId: string): Promise<TacticalState> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, clubId: true, teamId: true },
  });
  if (!match)                  throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();

  const now      = Date.now();
  const sinceTs  = new Date(now - SENSOR_WINDOW_MS);

  // Five parallel reads — all indexed.
  const [players, latestSnapshot, recentTimeline, sessions, openAlerts] = await Promise.all([
    prisma.player.findMany({
      where: { clubId, ...(match.teamId ? { teamId: match.teamId } : {}), isActive: true },
      select: {
        id: true, firstName: true, lastName: true, number: true, position: true,
      },
      orderBy: { number: 'asc' },
      take: 50,
    }),
    prisma.matchTacticalSnapshot.findFirst({
      where:   { matchId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.matchTimeline.findMany({
      where:   { matchId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      take:    10,
    }),
    prisma.deviceSession.findMany({
      where:  { clubId, matchId },
      select: { id: true, deviceModel: true, startedAt: true, endedAt: true },
    }),
    safeFindAlerts(clubId, matchId),
  ]);

  // Recent sensor packets for the last 60s only — used for sprint/hr/tai
  // estimation. We pull only GPS + HEART_RATE to keep the read small.
  const sessionIds = sessions.map((s) => s.id);
  const recentPackets = sessionIds.length === 0
    ? []
    : await prisma.sensorPacket.findMany({
        where: {
          deviceSessionId: { in: sessionIds },
          kind:            { in: ['GPS', 'HEART_RATE'] },
          capturedAt:      { gte: sinceTs },
        },
        orderBy: { capturedAt: 'desc' },
        take:    2000,                  // hard cap for one tick
        select:  { kind: true, capturedAt: true, payload: true, deviceSessionId: true },
      });

  // ── Per-player roll-ups ─────────────────────────────────────────────
  const snapshotPositions: Record<string, { x: number; y: number; role?: string }> = {};
  if (latestSnapshot?.positions) {
    const arr = (latestSnapshot.positions as unknown[]) ?? [];
    for (const p of arr as Array<{ playerId?: string; x?: number; y?: number; role?: string }>) {
      if (p?.playerId && typeof p.x === 'number' && typeof p.y === 'number') {
        snapshotPositions[p.playerId] = { x: p.x, y: p.y, role: p.role };
      }
    }
  }

  const playerStates: PlayerLiveState[] = players.map((p) => {
    const gps = recentPackets
      .filter((r) => r.kind === 'GPS' && safePlayerId(r.payload) === p.id)
      .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
    const hr  = recentPackets
      .filter((r) => r.kind === 'HEART_RATE' && safePlayerId(r.payload) === p.id);

    const latestGps = gps[gps.length - 1];
    const latestHr  = hr[hr.length - 1];
    const fromSnap  = snapshotPositions[p.id] ?? null;

    const lat = latestGps?.payload as { speed?: number; x?: number; y?: number } | undefined;
    const speed = typeof lat?.speed === 'number' ? lat.speed : 0;
    const sprint: 0 | 1 = speed > SPRINT_THRESHOLD_MPS ? 1 : 0;

    const tai = estimateTAI(speed, latestHr?.payload as { bpm?: number } | undefined);
    const alert: LiveAlertLevel =
      tai !== null && tai >= ALERT_TAI_CRIT ? 'CRITICAL'
      : tai !== null && tai >= ALERT_TAI_WARN ? 'CAUTION'
      : 'OK';

    const lastTs = latestGps?.capturedAt?.getTime() ?? latestHr?.capturedAt?.getTime() ?? null;

    return {
      playerId: p.id,
      number:   p.number ?? null,
      name:     `${p.firstName} ${p.lastName}`,
      position: p.position ?? null,
      x:        typeof lat?.x === 'number' ? lat.x : (fromSnap?.x ?? null),
      y:        typeof lat?.y === 'number' ? lat.y : (fromSnap?.y ?? null),
      hr:       typeof (latestHr?.payload as { bpm?: number })?.bpm === 'number'
                  ? (latestHr!.payload as { bpm: number }).bpm
                  : null,
      sprint,
      tai,
      alert,
      staleMs:  lastTs !== null ? now - lastTs : null,
    };
  });

  // ── Team shape (only counts players with positions) ─────────────────
  const positioned = playerStates.filter((p) => p.x !== null && p.y !== null) as Array<
    PlayerLiveState & { x: number; y: number }
  >;
  const teamShape: TeamShapeState = positioned.length === 0
    ? { centroidX: null, centroidY: null, defensiveLineX: null, spreadX: null, spreadY: null, pressingIndex: null }
    : computeTeamShape(positioned);

  // ── Phase ───────────────────────────────────────────────────────────
  const phase: TacticalPhaseState = {
    phase:       latestSnapshot?.phase ?? 'OPEN_PLAY',
    formation:   latestSnapshot?.formation ?? null,
    changedAtMs: latestSnapshot?.createdAt?.getTime() ?? now,
    notes:       latestSnapshot?.notes ?? null,
    possession:  latestSnapshot?.possession ?? null,
  };

  // ── Device health ───────────────────────────────────────────────────
  const lastPacketBySession: Record<string, number> = {};
  for (const r of recentPackets) {
    const t = r.capturedAt.getTime();
    if (!lastPacketBySession[r.deviceSessionId] || lastPacketBySession[r.deviceSessionId] < t) {
      lastPacketBySession[r.deviceSessionId] = t;
    }
  }
  const devices: DeviceStreamStatus[] = sessions.map((s) => {
    const last = lastPacketBySession[s.id] ?? null;
    const age  = last !== null ? now - last : null;
    let health: DeviceStreamStatus['health'] = 'OFFLINE';
    if (s.endedAt) health = 'ENDED';
    else if (age === null) health = 'OFFLINE';
    else if (age <= 30_000) health = 'OK';
    else if (age <= 60_000) health = 'STALE';
    else health = 'OFFLINE';
    return {
      sessionId:    s.id,
      deviceModel:  s.deviceModel,
      startedAt:    s.startedAt.toISOString(),
      endedAt:      s.endedAt?.toISOString() ?? null,
      lastPacketMs: last,
      health,
    };
  });

  // ── Recent events ───────────────────────────────────────────────────
  const recentEvents = recentTimeline.map((e) => ({
    minute:  e.occurredAtMin,
    kind:    e.kind,
    side:    e.side,
    notes:   e.notes,
    payload: e.payload,
  }));

  return {
    matchId,
    clubId,
    generatedAt: now,
    players:     playerStates,
    teamShape,
    phase,
    devices,
    recentEvents,
    openAlerts: openAlerts.map((a) => ({
      id:        a.id,
      kind:      a.kind,
      severity:  a.severity as 'INFO' | 'WARN' | 'CRITICAL',
      title:     a.title,
      createdAt: a.createdAt.toISOString(),
    })),
    diagnostics: {
      haveLineup:       false,           // computed on demand by listLineups, not part of fast path
      haveSnapshot:     !!latestSnapshot,
      haveSensors:      recentPackets.length > 0,
      sensorPackets60s: recentPackets.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers (no DB)
// ─────────────────────────────────────────────────────────────────────────

function computeTeamShape(
  ps: Array<{ x: number; y: number }>,
): TeamShapeState {
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const std  = (a: number[]) => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  const cx = mean(xs), cy = mean(ys);
  const sx = std(xs),  sy  = std(ys);
  // Back-most third of x — "back-most" depends on attacking direction;
  // we use min third as a coordinate-frame-agnostic proxy.
  const sorted = [...xs].sort((a, b) => a - b);
  const bottomThird = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 3)));
  const defensiveLineX = mean(bottomThird);

  // Pressing index — compact and high → 1.0; sparse and low → 0.0.
  // Crude heuristic, but it's deterministic, bounded, and additive.
  const compactness = Math.max(0, 1 - (sx + sy) / 200);     // 0 spread → 1, large spread → 0
  const lineHeight  = Math.min(1, defensiveLineX / 100);    // higher line → 1
  const pressingIndex = Number(((compactness + lineHeight) / 2).toFixed(3));

  return {
    centroidX:      Number(cx.toFixed(2)),
    centroidY:      Number(cy.toFixed(2)),
    defensiveLineX: Number(defensiveLineX.toFixed(2)),
    spreadX:        Number(sx.toFixed(2)),
    spreadY:        Number(sy.toFixed(2)),
    pressingIndex,
  };
}

function estimateTAI(speed: number, hr: { bpm?: number } | undefined): number | null {
  // Lightweight TAI proxy for the per-tick path. Heavy BLI/TAI math runs
  // in /matches/:id/fusion; this is a "good enough" caution indicator.
  if (typeof hr?.bpm !== 'number' && !Number.isFinite(speed)) return null;
  const hrComp = typeof hr?.bpm === 'number'
    ? Math.max(0, Math.min(1, (hr.bpm - 140) / 60))         // 140 → 0, 200 → 1
    : 0;
  const speedComp = speed > 0 ? Math.max(0, Math.min(1, speed / 9.5)) : 0;
  const tai = 0.6 * hrComp + 0.4 * speedComp;
  return Number(tai.toFixed(3));
}

function safePlayerId(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'playerId' in (payload as Record<string, unknown>)) {
    const id = (payload as Record<string, unknown>).playerId;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/** AIAlert may not be in the live Prisma client during a half-deployed
 * release window — fall back gracefully so /live still works.
 */
async function safeFindAlerts(clubId: string, matchId: string) {
  try {
    const anyPrisma = prisma as unknown as {
      aIAlert?: { findMany: (args: unknown) => Promise<Array<{
        id: string; kind: string; severity: string; title: string; createdAt: Date;
      }>> };
    };
    if (!anyPrisma.aIAlert) return [];
    return await anyPrisma.aIAlert.findMany({
      where:   { clubId, matchId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take:    10,
    } as unknown as never);
  } catch {
    return [];
  }
}
