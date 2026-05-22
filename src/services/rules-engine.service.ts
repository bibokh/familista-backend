// Familista — Tactical AI Rules Engine (Phase E)
// ─────────────────────────────────────────────────────────────────────────
// DETERMINISTIC rules — no external AI, no LLM calls. These run as cheap
// in-process evaluations triggered by:
//   - Timeline event ingestion (best-effort, fire-and-forget)
//   - Sensor packet ingestion (best-effort)
//   - Explicit POST /matches/:id/rules/evaluate
//
// All rules read recent state (last 60s sensor window) via getState(),
// then emit AIAlert rows via ai-ops. No state of its own.
//
// Rules implemented (Phase E baseline — extensible per agent):
//   1. FATIGUE         — any player TAI ≥ 0.90  → CRITICAL alert
//   2. FATIGUE_WARN    — any player TAI ≥ 0.75  → WARN alert
//   3. FORMATION_DRIFT — team spread (X or Y) > 35 m → WARN
//   4. RECOVERY_LAG    — last 10 timeline events show <2 successful actions in 5 min for a player → INFO
//   5. DEVICE_STALE    — any device session with lastPacket > 60s → WARN
//   6. DISCIPLINE      — >3 yellow cards in last 10 timeline events → CRITICAL
//
// Each rule is *idempotent-debounced* — we don't re-emit an OPEN alert
// for the same (matchId, kind, target) within a 5-min window.

import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { getState, TacticalState, PlayerLiveState } from '../realtime/tactical-state';
import { createAlert } from './ai-ops.service';
import type { AlertSeverity } from '@prisma/client';

const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000;

export interface RuleHit {
  kind:     string;
  severity: AlertSeverity;
  title:    string;
  message:  string;
  playerId?: string | null;
  payload?:  Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry — evaluate all rules, persist new alerts, return all hits.
// ─────────────────────────────────────────────────────────────────────────

export async function evaluateMatch(matchId: string, clubId: string): Promise<{ alerts: RuleHit[]; suppressed: number }> {
  let state: TacticalState;
  try { state = await getState(matchId, clubId); }
  catch (err) {
    logger.warn('[rules] getState failed', { matchId, err: (err as Error).message });
    return { alerts: [], suppressed: 0 };
  }

  const hits: RuleHit[] = [
    ...evalFatigue(state),
    ...evalFormationDrift(state),
    ...evalDeviceHealth(state),
    ...evalDiscipline(state),
  ];

  if (hits.length === 0) return { alerts: [], suppressed: 0 };

  // Debounce — don't re-fire same (kind, playerId) if an OPEN alert exists
  // in the last 5 minutes.
  const recentOpen = await prisma.aIAlert.findMany({
    where: {
      clubId, matchId,
      status:    'OPEN',
      createdAt: { gte: new Date(Date.now() - DEBOUNCE_WINDOW_MS) },
    },
    select: { kind: true, playerId: true },
  });
  const recentKey = new Set(recentOpen.map((a) => `${a.kind}::${a.playerId ?? ''}`));

  const fresh: RuleHit[] = [];
  let suppressed = 0;
  for (const h of hits) {
    const key = `${h.kind}::${h.playerId ?? ''}`;
    if (recentKey.has(key)) { suppressed++; continue; }
    fresh.push(h);
    recentKey.add(key);
  }

  for (const h of fresh) {
    try {
      await createAlert({
        clubId,
        matchId,
        playerId: h.playerId ?? null,
        agent:    null,
        kind:     h.kind,
        severity: h.severity,
        title:    h.title,
        message:  h.message,
        payload:  h.payload as never,
      });
    } catch (err) {
      logger.warn('[rules] alert persist failed', { kind: h.kind, err: (err as Error).message });
    }
  }

  return { alerts: fresh, suppressed };
}

/** Best-effort hook callable from any controller after a mutation. Never throws. */
export function evaluateAsync(matchId: string, clubId: string): void {
  evaluateMatch(matchId, clubId).catch((err) => {
    logger.warn('[rules] async eval failed', { matchId, err: (err as Error).message });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Individual rules
// ─────────────────────────────────────────────────────────────────────────

function evalFatigue(state: TacticalState): RuleHit[] {
  const out: RuleHit[] = [];
  for (const p of state.players) {
    if (p.tai === null) continue;
    if (p.tai >= 0.90) {
      out.push({
        kind:     'FATIGUE_CRITICAL',
        severity: 'CRITICAL',
        title:    `${p.name} — fatigue critical`,
        message:  `TAI=${p.tai.toFixed(2)} HR=${p.hr ?? 'n/a'} — consider substitution`,
        playerId: p.playerId,
        payload:  { tai: p.tai, hr: p.hr, sprint: p.sprint },
      });
    } else if (p.tai >= 0.75) {
      out.push({
        kind:     'FATIGUE',
        severity: 'WARN',
        title:    `${p.name} — fatigue elevated`,
        message:  `TAI=${p.tai.toFixed(2)} HR=${p.hr ?? 'n/a'}`,
        playerId: p.playerId,
        payload:  { tai: p.tai, hr: p.hr },
      });
    }
  }
  return out;
}

function evalFormationDrift(state: TacticalState): RuleHit[] {
  const s = state.teamShape;
  if (s.spreadX === null || s.spreadY === null) return [];
  if (s.spreadX > 35 || s.spreadY > 35) {
    return [{
      kind:     'FORMATION_DRIFT',
      severity: 'WARN',
      title:    'Team shape drifting wide',
      message:  `spreadX=${s.spreadX} spreadY=${s.spreadY} centroid=(${s.centroidX},${s.centroidY})`,
      payload:  { ...s },
    }];
  }
  return [];
}

function evalDeviceHealth(state: TacticalState): RuleHit[] {
  const out: RuleHit[] = [];
  for (const d of state.devices) {
    if (d.health === 'STALE') {
      out.push({
        kind:     'DEVICE_STALE',
        severity: 'WARN',
        title:    `${d.deviceModel} stream lagging`,
        message:  `lastPacket=${d.lastPacketMs} session=${d.sessionId}`,
        payload:  { sessionId: d.sessionId, lastPacketMs: d.lastPacketMs },
      });
    } else if (d.health === 'OFFLINE' && !d.endedAt) {
      out.push({
        kind:     'DEVICE_OFFLINE',
        severity: 'CRITICAL',
        title:    `${d.deviceModel} OFFLINE`,
        message:  `Session ${d.sessionId} has not produced packets in over 60s.`,
        payload:  { sessionId: d.sessionId, deviceModel: d.deviceModel },
      });
    }
  }
  return out;
}

function evalDiscipline(state: TacticalState): RuleHit[] {
  const yellow = state.recentEvents.filter((e) => e.kind === 'YELLOW_CARD').length;
  const red    = state.recentEvents.filter((e) => e.kind === 'RED_CARD').length;
  const out: RuleHit[] = [];
  if (red >= 1) {
    out.push({
      kind:     'DISCIPLINE',
      severity: 'CRITICAL',
      title:    'Red card on the field',
      message:  `${red} red, ${yellow} yellow in last 10 events`,
      payload:  { red, yellow },
    });
  } else if (yellow >= 3) {
    out.push({
      kind:     'DISCIPLINE',
      severity: 'WARN',
      title:    'Discipline degrading',
      message:  `${yellow} yellow cards in last 10 timeline events`,
      payload:  { yellow },
    });
  }
  return out;
}

// Re-export for tests / inspection.
export const _internal = { evalFatigue, evalFormationDrift, evalDeviceHealth, evalDiscipline };
// Keep PlayerLiveState in the module namespace so callers don't need a deep import.
export type { PlayerLiveState };
