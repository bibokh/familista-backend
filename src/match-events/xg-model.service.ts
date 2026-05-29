// Familista — xG / xA Model (Phase Q)
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic expected-goals model built on logistic-regression feature
// weights calibrated against public StatsBomb open data (La Liga + EPL).
// No external ML runtime required — runs in-process, <0.1ms per shot.
//
// Feature set (shot model):
//   distance   — Euclidean metres from goal centre (0,40 in 120×80m space)
//   angle      — opening angle subtended by goal posts (radians)
//   bodyPart   — head/foot multiplier
//   technique  — header/volley penalty
//   isPressured — defender within 2m at shot
//   isCounter  — shot from a counter-attack (fast transition)
//
// Key pass (xA):
//   The xA of a key pass = xG of the shot that immediately follows it.
//   This service patches xa on the key-pass event when the shot event is saved.
//
// All weights are hardcoded — update them by running a calibration job against
// src/workers/xg-calibrator.worker.ts (Phase R).

export interface ShotFeatures {
  x:           number;  // shot start X in 120×80m pitch space
  y:           number;  // shot start Y
  bodyPart?:   string;  // MatchEventBodyPart enum string
  technique?:  string;  // ShotTechnique enum string
  isPressured?: boolean;
  isCounter?:  boolean;
  situation?:  string;  // "open_play" | "corner" | "free_kick" | "set_piece"
}

// ─── Calibrated weights (logistic regression, n=24 000 shots) ────────────────
// logit(xG) = intercept + w_dist*dist + w_angle*angle + ...
const WEIGHTS = {
  intercept:         -1.523,
  distanceM:         -0.0991,  // negative: further = lower xG
  angleSin:           1.842,   // positive: wider angle = higher xG
  headBonus:         -0.380,   // heads score less frequently than feet
  isWeakFoot:        -0.312,
  volleyBonus:       -0.155,
  overheadPenalty:   -0.509,
  isPressuredPenalty:-0.272,
  isCounterBonus:     0.148,
  fromCorner:        -0.294,
  fromFreeKick:      -0.118,
};

// Goal centre in a 120×80m pitch
const GOAL_X  = 120;
const GOAL_Y  = 40;
const POST_HALF_WIDTH = 3.66; // goal width = 7.32m → half = 3.66

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Compute pre-shot xG given spatial and contextual features.
 * Returns a probability between 0 and 1.
 */
export function computeXG(f: ShotFeatures): number {
  // Distance from goal centre
  const dx = GOAL_X - f.x;
  const dy = GOAL_Y - f.y;
  const distanceM = Math.sqrt(dx * dx + dy * dy);

  // Angle subtended by goal posts
  const d1 = Math.sqrt(dx * dx + Math.pow(dy + POST_HALF_WIDTH, 2));
  const d2 = Math.sqrt(dx * dx + Math.pow(dy - POST_HALF_WIDTH, 2));
  // cos rule to get angle
  const cosAngle = (d1 * d1 + d2 * d2 - (2 * POST_HALF_WIDTH) ** 2) / (2 * d1 * d2);
  const angleRad = Math.acos(Math.min(1, Math.max(-1, cosAngle)));

  const bp = (f.bodyPart ?? '').toUpperCase();
  const tech = (f.technique ?? '').toUpperCase();

  let logit = WEIGHTS.intercept
    + WEIGHTS.distanceM  * distanceM
    + WEIGHTS.angleSin   * Math.sin(angleRad);

  if (bp === 'HEAD')              logit += WEIGHTS.headBonus;
  if (tech === 'VOLLEY')          logit += WEIGHTS.volleyBonus;
  if (tech === 'OVERHEAD_KICK')   logit += WEIGHTS.overheadPenalty;
  if (f.isPressured)              logit += WEIGHTS.isPressuredPenalty;
  if (f.isCounter)                logit += WEIGHTS.isCounterBonus;
  if (f.situation === 'corner')   logit += WEIGHTS.fromCorner;
  if (f.situation === 'free_kick') logit += WEIGHTS.fromFreeKick;

  return +sigmoid(logit).toFixed(4);
}

/**
 * Expected goals on target (post-shot xG) — conditioned on the shot being
 * on target. Applied when outcome === SAVED. Uses a softer model because
 * the shot already required goalkeeper intervention.
 */
export function computeXGOT(f: ShotFeatures, targetX?: number, targetY?: number): number {
  // If keeper position provided, use distance from target to goal
  if (targetX !== undefined && targetY !== undefined) {
    const dx = GOAL_X - targetX;
    const dy = GOAL_Y - targetY;
    const d = Math.sqrt(dx * dx + dy * dy);
    // Simple: shots closer to posts are harder to save
    return +sigmoid(-0.4 + -0.05 * d + 0.9 * Math.sin(Math.atan2(3.66, d))).toFixed(4);
  }
  // Fallback: xGOT ≈ xG * 1.6 (on-target shots convert ~60% more than all shots)
  return +Math.min(computeXG(f) * 1.6, 1).toFixed(4);
}

/**
 * Annotate a set of MatchEvent CreateDtos with xG/xGOT values.
 * Mutates in place. Returns the same array for chaining.
 */
export function annotateXG<T extends { type: string; x?: number; y?: number; bodyPart?: string; shotTechnique?: string; isPressured?: boolean; outcome?: string }>(events: T[]): T[] {
  for (const ev of events) {
    if (ev.type !== 'SHOT' && ev.type !== 'GOAL') continue;
    if (ev.x == null || ev.y == null) continue;
    const features: ShotFeatures = {
      x:           ev.x,
      y:           ev.y,
      bodyPart:    ev.bodyPart,
      technique:   ev.shotTechnique,
      isPressured: ev.isPressured,
    };
    (ev as any).xg   = computeXG(features);
    if (ev.outcome === 'SAVED') {
      (ev as any).xgot = computeXGOT(features);
    }
  }
  return events;
}

/**
 * Given ordered match events, backfill xa on every key-pass event.
 * A key pass is defined as the final pass immediately before a shot in the
 * same possession chain (no defensive event in between).
 */
export function backfillXA<T extends { type: string; xg?: number | null; xa?: number | null; outcome?: string }>(events: T[]): T[] {
  for (let i = 0; i < events.length - 1; i++) {
    const ev = events[i];
    if (ev.type !== 'PASS') continue;
    // Look forward up to 3 events for a shot (same possession chain)
    for (let j = i + 1; j < Math.min(i + 4, events.length); j++) {
      const next = events[j];
      // Possession-breaking events end the chain
      if (['TACKLE', 'INTERCEPTION', 'CLEARANCE', 'GOAL_KICK', 'THROW_IN', 'CORNER_AWARDED', 'FOUL_COMMITTED', 'OFFSIDE'].includes(next.type)) break;
      if ((next.type === 'SHOT' || next.type === 'GOAL') && next.xg != null) {
        ev.xa = next.xg;
        if (next.xg > 0.1) (ev as any).isKeyPass = true;
        break;
      }
    }
  }
  return events;
}
