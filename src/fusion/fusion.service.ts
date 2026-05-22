// Familista — Fusion service (Phase D-IP, read-only)
// ─────────────────────────────────────────────────────────────────────────
// Computes a FusionFrame for one match without writing any persistent state.
// Reads:
//   - Match (tenant check)
//   - Players of the match's club + team
//   - DeviceSession[] tied to the match
//   - SensorPacket[] from those sessions
//   - MatchTimeline[] for tactical events
//
// Aggregates them into PlayerSpatialState + BLI + TAI per player, plus
// diagnostics. This is the patentable INTEGRATION LAYER — every existing
// sensor stream collapses into one frame.

import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import {
  biomechanicalLoadIndex, tacticalAttritionIndex, defaultBaseline,
  SPRINT_THRESHOLD_MPS, HR_STRESS_THRESHOLD_BPM, FUSION_METRICS_VERSION,
} from './metrics';
import type {
  FusionFrame, FusionFrameRow, PlayerSpatialState,
  GlobalTimestampMs,
} from './types';

interface SessionPackets {
  sessionId:    string;
  deviceModel:  string;
  packets:      Array<{ kind: string; capturedAt: Date; payload: unknown }>;
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────

export async function computeFusionFrameForMatch(matchId: string, clubId: string): Promise<FusionFrame> {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match)                  throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();

  const [players, sessions, timeline] = await Promise.all([
    prisma.player.findMany({
      where: { clubId, ...(match.teamId ? { teamId: match.teamId } : {}), isActive: true },
      select: { id: true, firstName: true, lastName: true, number: true, position: true },
      orderBy: { overallRating: 'desc' },
    }),
    prisma.deviceSession.findMany({
      where: { clubId, matchId },
      select: { id: true, deviceModel: true, startedAt: true, endedAt: true },
    }),
    prisma.matchTimeline.findMany({
      where: { matchId, isDeleted: false },
      orderBy: { occurredAtMin: 'asc' },
    }),
  ]);

  // Pull packets for every session in parallel — cap per session so we
  // don't OOM if a match has high-frequency IMU data.
  const sessionPackets: SessionPackets[] = await Promise.all(
    sessions.map(async (s) => ({
      sessionId:   s.id,
      deviceModel: s.deviceModel,
      packets: await prisma.sensorPacket.findMany({
        where:   { deviceSessionId: s.id },
        orderBy: { capturedAt: 'asc' },
        take:    20_000,            // hard cap per session for one fusion call
        select:  { kind: true, capturedAt: true, payload: true },
      }),
    })),
  );

  // Bucket packets by kind for quick access.
  const packetsByKind = new Map<string, Array<{ ts: number; payload: any }>>();
  let totalPackets = 0;
  let fusedNowMs: GlobalTimestampMs | null = null;
  for (const s of sessionPackets) {
    for (const p of s.packets) {
      const ts = p.capturedAt.getTime();
      const arr = packetsByKind.get(p.kind) ?? [];
      arr.push({ ts, payload: p.payload as any });
      packetsByKind.set(p.kind, arr);
      totalPackets++;
      if (fusedNowMs === null || ts > fusedNowMs) fusedNowMs = ts;
    }
  }

  // Window for BLI/TAI: last 5 minutes of available data, or whole window if shorter.
  const WINDOW_MS = 5 * 60 * 1000;
  const cutoff = (fusedNowMs ?? Date.now()) - WINDOW_MS;

  // ── Per-player roll-ups ─────────────────────────────────────────────
  const rows: FusionFrameRow[] = players.map((p) => {
    const state = rollupPlayerState(p.id, packetsByKind, fusedNowMs);
    const bli   = rollupBLI(p.id, packetsByKind, cutoff, WINDOW_MS);
    const tai   = rollupTAI(p.id, bli, packetsByKind, timeline, cutoff, WINDOW_MS);
    return { player: p, state, bli, tai };
  });

  return {
    matchId,
    clubId,
    generatedAt: Date.now(),
    fusedNowMs,
    packetCounts: Object.fromEntries(
      [...packetsByKind.entries()].map(([k, v]) => [k, v.length]),
    ),
    rows,
    teamMetrics: { totalPackets, players: players.length, sessions: sessions.length },
    diagnostics: {
      sessions: sessions.map((s) => ({
        id: s.id, deviceModel: s.deviceModel,
        offsetMs: 0,            // populated once GlobalTimestampSynchronizer is wired live
        packets:  sessionPackets.find((sp) => sp.sessionId === s.id)?.packets.length ?? 0,
      })),
      notes: buildDiagnosticNotes(packetsByKind, fusedNowMs, FUSION_METRICS_VERSION),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-player roll-ups (pure functions — no DB)
// ─────────────────────────────────────────────────────────────────────────

function rollupPlayerState(
  playerId: string,
  byKind: Map<string, Array<{ ts: number; payload: any }>>,
  fusedNowMs: GlobalTimestampMs | null,
): PlayerSpatialState | null {
  const gps = (byKind.get('GPS') ?? []).filter((p) => p.payload?.playerId === playerId);
  const hr  = (byKind.get('HEART_RATE') ?? []).filter((p) => p.payload?.playerId === playerId);
  const imu = (byKind.get('IMU') ?? []).filter((p) => p.payload?.playerId === playerId);

  if (gps.length === 0 && imu.length === 0) return null;

  const latest = gps[gps.length - 1];
  const speed  = latest?.payload?.speed ?? 0;
  const sprint = (speed > SPRINT_THRESHOLD_MPS ? 1 : 0) as 0 | 1;
  const latestHr = hr[hr.length - 1]?.payload?.bpm ?? null;

  // Cumulative distance: integrate v · dt across the gps stream.
  let distM = 0;
  for (let i = 1; i < gps.length; i++) {
    const dt = (gps[i].ts - gps[i - 1].ts) / 1000;
    const v  = ((gps[i].payload?.speed ?? 0) + (gps[i - 1].payload?.speed ?? 0)) / 2;
    if (dt > 0 && dt < 5) distM += v * dt;
  }

  return {
    playerId,
    ts:         latest?.ts ?? fusedNowMs ?? Date.now(),
    x:          latest?.payload?.x ?? 0,
    y:          latest?.payload?.y ?? 0,
    vx:         undefined,
    vy:         undefined,
    sprint,
    hr:         latestHr ?? undefined,
    distM:      Number(distM.toFixed(1)),
    source:     gps.length && imu.length ? 'FUSED' : gps.length ? 'GPS' : 'IMU',
    confidence: gps.length ? 0.9 : imu.length ? 0.6 : 0.3,
  };
}

function rollupBLI(
  playerId: string,
  byKind: Map<string, Array<{ ts: number; payload: any }>>,
  cutoffMs: number,
  windowMs: number,
) {
  const imu = (byKind.get('IMU') ?? []).filter((p) => p.payload?.playerId === playerId && p.ts >= cutoffMs);
  const gps = (byKind.get('GPS') ?? []).filter((p) => p.payload?.playerId === playerId && p.ts >= cutoffMs);
  const hr  = (byKind.get('HEART_RATE') ?? []).filter((p) => p.payload?.playerId === playerId && p.ts >= cutoffMs);

  // Accel magnitude squared sum (m²/s⁴)
  let accelMagSqSum = 0;
  for (const p of imu) {
    const ax = p.payload?.ax ?? 0, ay = p.payload?.ay ?? 0, az = p.payload?.az ?? 0;
    accelMagSqSum += ax * ax + ay * ay + az * az;
  }

  // Sprint v² integral
  let sprintVsqIntegral = 0;
  for (let i = 1; i < gps.length; i++) {
    const v = gps[i].payload?.speed ?? 0;
    if (v > SPRINT_THRESHOLD_MPS) {
      const dt = (gps[i].ts - gps[i - 1].ts) / 1000;
      if (dt > 0 && dt < 5) sprintVsqIntegral += v * v * dt;
    }
  }

  // HR stress ∫(HR - threshold)² dt
  let hrStressIntegral = 0;
  for (let i = 1; i < hr.length; i++) {
    const bpm = hr[i].payload?.bpm ?? 0;
    const dt  = (hr[i].ts - hr[i - 1].ts) / 1000;
    if (bpm > HR_STRESS_THRESHOLD_BPM && dt > 0 && dt < 5) {
      const excess = bpm - HR_STRESS_THRESHOLD_BPM;
      hrStressIntegral += excess * excess * dt;
    }
  }

  // Joint strain proxy: ∫|ω|² · m dt — use unit limb mass since we have no biomechanical model yet
  let jointStrainIntegral = 0;
  for (const p of imu) {
    const gx = p.payload?.gx ?? 0, gy = p.payload?.gy ?? 0, gz = p.payload?.gz ?? 0;
    jointStrainIntegral += gx * gx + gy * gy + gz * gz;
  }
  jointStrainIntegral *= 0.5;   // dimensionless unit mass

  // Mechanical work proxy: 0.5 · m_player · ΣΔv²
  let mechanicalWork = 0;
  for (let i = 1; i < gps.length; i++) {
    const dv = (gps[i].payload?.speed ?? 0) - (gps[i - 1].payload?.speed ?? 0);
    mechanicalWork += dv * dv;
  }
  mechanicalWork *= 0.5 * 75;   // assume 75 kg until per-player mass is known

  return biomechanicalLoadIndex({
    playerId,
    windowMs,
    accelMagSqSum,
    sprintVsqIntegral,
    hrStressIntegral,
    jointStrainIntegral,
    mechanicalWork,
    baseline: defaultBaseline(),
  });
}

function rollupTAI(
  playerId: string,
  bli: ReturnType<typeof biomechanicalLoadIndex>,
  byKind: Map<string, Array<{ ts: number; payload: any }>>,
  timeline: Array<{ occurredAtMin: number; kind: string; side: string; primaryPlayerId: string | null }>,
  cutoffMs: number,
  windowMs: number,
) {
  // Biochemical fatigue gradient (per minute) — pulled from BIOCHEM_PATCH if present.
  const patch = (byKind.get('BIOCHEM_PATCH') ?? []).filter((p) => p.payload?.playerId === playerId && p.ts >= cutoffMs);
  let biochemDeltaPerMin = NaN;
  if (patch.length >= 2) {
    const first = patch[0], last = patch[patch.length - 1];
    const dtMin = Math.max(1, (last.ts - first.ts) / 60000);
    const dL = (last.payload?.lactateMmol ?? 0) - (first.payload?.lactateMmol ?? 0);
    biochemDeltaPerMin = dL / dtMin;
  }

  // Tactical delay (sec) — placeholder: median Δt between consecutive
  // timeline events involving this player. Without vision events we can
  // only approximate it from human-entered timeline ladder.
  const mine = timeline
    .filter((e) => e.primaryPlayerId === playerId)
    .map((e) => e.occurredAtMin * 60);
  let tacticalDelaySec = 1.2;
  if (mine.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < mine.length; i++) gaps.push(mine[i] - mine[i - 1]);
    gaps.sort((a, b) => a - b);
    tacticalDelaySec = gaps[Math.floor(gaps.length / 2)] / Math.max(1, mine.length);
  }

  // Positional deviation proxy — Phase E will use the formation template;
  // for now use std-dev of the player's x,y positions in the window.
  const gps = (byKind.get('GPS') ?? []).filter((p) => p.payload?.playerId === playerId && p.ts >= cutoffMs);
  let posDevM = 0;
  if (gps.length > 1) {
    const xs = gps.map((p) => p.payload?.x ?? 0);
    const ys = gps.map((p) => p.payload?.y ?? 0);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const std  = (a: number[]) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
    posDevM = Math.sqrt(std(xs) ** 2 + std(ys) ** 2);
  }

  // Recovery lag — average time between sprints in the window.
  let recoveryLagSec = 18;
  const sprintTimes: number[] = [];
  for (let i = 1; i < gps.length; i++) {
    const prev = gps[i - 1].payload?.speed ?? 0;
    const cur  = gps[i].payload?.speed ?? 0;
    if (prev <= SPRINT_THRESHOLD_MPS && cur > SPRINT_THRESHOLD_MPS) sprintTimes.push(gps[i].ts);
  }
  if (sprintTimes.length >= 2) {
    let sum = 0;
    for (let i = 1; i < sprintTimes.length; i++) sum += (sprintTimes[i] - sprintTimes[i - 1]) / 1000;
    recoveryLagSec = sum / (sprintTimes.length - 1);
  }

  // Sprint degradation: ratio of late-window v_max vs first 15-min v_max.
  // Without the first 15 min, set to 1.0 (no degradation evidence).
  const vMaxLate = gps.reduce((m, p) => Math.max(m, p.payload?.speed ?? 0), 0);
  const sprintMaxRatio = vMaxLate > 0 ? Math.min(1, vMaxLate / 9.5) : 1.0;

  return tacticalAttritionIndex({
    playerId,
    windowMs,
    bli,
    biochemDeltaPerMin,
    tacticalDelaySec,
    positionalDeviationM: posDevM,
    recoveryLagSec,
    sprintMaxRatio,
    baseline: defaultBaseline(),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Diagnostic notes — surfaced in the response so the frontend can show
// "low-confidence" badges when input data is sparse.
// ─────────────────────────────────────────────────────────────────────────

function buildDiagnosticNotes(
  byKind: Map<string, Array<unknown>>,
  fusedNowMs: GlobalTimestampMs | null,
  metricsVersion: string,
): string[] {
  const notes: string[] = [`metrics_version=${metricsVersion}`];
  if (!fusedNowMs)                  notes.push('No sensor packets ingested for this match yet.');
  if (!byKind.has('GPS'))           notes.push('No GPS packets — spatial state defaults to (0,0).');
  if (!byKind.has('IMU'))           notes.push('No IMU packets — joint strain estimated from defaults.');
  if (!byKind.has('HEART_RATE') &&
      !byKind.has('ECG'))           notes.push('No cardiovascular packets — HR stress component disabled.');
  if (!byKind.has('BIOCHEM_PATCH')) notes.push('No biochemical patch data — TAI substitutes BLI-derived proxy.');
  if (!byKind.has('NEURO_VISION_EVENT')) notes.push('No neuromorphic vision events — tactical delay measured from timeline ladder only.');
  if (!byKind.has('POSE_KEYPOINTS')) notes.push('No 3D pose stream — biomechanical model uses IMU-only inputs.');
  return notes;
}
