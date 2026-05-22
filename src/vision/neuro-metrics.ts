// Familista — Neuromorphic Tactical Metrics (Phase K)
// ─────────────────────────────────────────────────────────────────────────
// 8 deterministic pure-function metrics. Each carries a `version` so any
// behaviour change requires a deliberate bump. All inputs are explicit;
// no module-level state, no clock reads, no randomness.
//
// All metrics are tenant-safe by virtue of being PURE — the caller must
// already have resolved tenant-bound data. Replay-safe by definition.
//
// Reference: Phase D-IP fusion-protocol.md (BLI / TAI). These extend the
// pattern with event-camera-aware metrics.

export interface MetricResult {
  value:   number;
  version: string;
  components?: Record<string, number | null>;
}

const V = 'k1';

// ─────────────────────────────────────────────────────────────────────────
// 1. EventMotionLoad — total event mass over a window per player.
//    L = α · log(1 + N_events) + β · density + γ · sprintCount
// ─────────────────────────────────────────────────────────────────────────

export interface EventMotionLoadInput {
  events:       number;
  meanDensity:  number;     // events / cell-area
  sprintCount:  number;     // distinct sprint starts in window
}

export function eventMotionLoad(i: EventMotionLoadInput): MetricResult {
  const alpha = 0.6, beta = 0.25, gamma = 0.15;
  const v = alpha * Math.log10(1 + Math.max(0, i.events))
          + beta  * Math.max(0, i.meanDensity / 1000)
          + gamma * Math.min(1, i.sprintCount / 6);
  return { value: Number(v.toFixed(3)), version: V, components: { events: i.events, density: i.meanDensity, sprints: i.sprintCount } };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. VisionReactionDelay — μs between event burst onset and player motion.
// ─────────────────────────────────────────────────────────────────────────

export interface VisionReactionDelayInput {
  burstStartUs:   number;    // event-camera burst onset
  playerMotionUs: number;    // player joint motion onset (later)
}

export function visionReactionDelay(i: VisionReactionDelayInput): MetricResult {
  const dUs = Math.max(0, i.playerMotionUs - i.burstStartUs);
  // Score 0..1 where 1 = instant; saturates at 250ms (= 250_000 μs).
  const score = Math.max(0, Math.min(1, 1 - dUs / 250_000));
  return { value: Number(score.toFixed(3)), version: V, components: { delayUs: dUs } };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. TacticalVisualDelay — ms between visual cue (e.g. ball arrival) and
//    tactical formation response (centroid shift).
// ─────────────────────────────────────────────────────────────────────────

export interface TacticalVisualDelayInput {
  cueMs:           number;
  centroidShiftMs: number;
}

export function tacticalVisualDelay(i: TacticalVisualDelayInput): MetricResult {
  const dMs = Math.max(0, i.centroidShiftMs - i.cueMs);
  const score = Math.max(0, Math.min(1, 1 - dMs / 1500));
  return { value: Number(score.toFixed(3)), version: V, components: { delayMs: dMs } };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. BallPressureGradient — ∂(opp player count near ball) / ∂t over window.
// ─────────────────────────────────────────────────────────────────────────

export interface BallPressureGradientInput {
  samples: Array<{ tMs: number; oppNear: number }>;
  /** Radius (m) considered "near ball" — informational only. */
  radiusM?: number;
}

export function ballPressureGradient(i: BallPressureGradientInput): MetricResult {
  if (i.samples.length < 2) return { value: 0, version: V };
  const sorted = [...i.samples].sort((a, b) => a.tMs - b.tMs);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const dtSec = Math.max(0.001, (last.tMs - first.tMs) / 1000);
  const grad = (last.oppNear - first.oppNear) / dtSec;
  // Normalize to [-1..1] assuming 3 opp/sec is extreme.
  const norm = Math.max(-1, Math.min(1, grad / 3));
  return { value: Number(norm.toFixed(3)), version: V, components: { rawGrad: Number(grad.toFixed(3)), windowSec: Number(dtSec.toFixed(2)) } };
}

// ─────────────────────────────────────────────────────────────────────────
// 5. SpatialCollapseIndex — sudden contraction of team spread over time.
// ─────────────────────────────────────────────────────────────────────────

export interface SpatialCollapseIndexInput {
  /** Sequential spread samples: { tMs, spreadX, spreadY } */
  samples: Array<{ tMs: number; spreadX: number; spreadY: number }>;
}

export function spatialCollapseIndex(i: SpatialCollapseIndexInput): MetricResult {
  if (i.samples.length < 2) return { value: 0, version: V };
  const sorted = [...i.samples].sort((a, b) => a.tMs - b.tMs);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const dX = last.spreadX - first.spreadX;
  const dY = last.spreadY - first.spreadY;
  // Collapse = NEGATIVE delta (contraction). Map to 0..1.
  const collapseRaw = Math.max(0, -(dX + dY));
  const v = Math.max(0, Math.min(1, collapseRaw / 30));
  return { value: Number(v.toFixed(3)), version: V, components: { dSpreadX: Number(dX.toFixed(2)), dSpreadY: Number(dY.toFixed(2)) } };
}

// ─────────────────────────────────────────────────────────────────────────
// 6. TransitionSharpnessScore — magnitude of centroid velocity change.
// ─────────────────────────────────────────────────────────────────────────

export interface TransitionSharpnessInput {
  vBefore: { vx: number; vy: number };
  vAfter:  { vx: number; vy: number };
}

export function transitionSharpnessScore(i: TransitionSharpnessInput): MetricResult {
  const dvx = i.vAfter.vx - i.vBefore.vx, dvy = i.vAfter.vy - i.vBefore.vy;
  const mag = Math.sqrt(dvx * dvx + dvy * dvy);
  // Normalize against 5 m/s shift = max sharpness.
  const v = Math.max(0, Math.min(1, mag / 5));
  return { value: Number(v.toFixed(3)), version: V, components: { dvx: Number(dvx.toFixed(3)), dvy: Number(dvy.toFixed(3)) } };
}

// ─────────────────────────────────────────────────────────────────────────
// 7. DefensiveLineStability — inverse of std-dev of back-line Y over time.
// ─────────────────────────────────────────────────────────────────────────

export interface DefensiveLineStabilityInput {
  samples: Array<{ tMs: number; lineX: number; spreadY: number }>;
}

export function defensiveLineStability(i: DefensiveLineStabilityInput): MetricResult {
  if (i.samples.length === 0) return { value: 0, version: V };
  const xs = i.samples.map((s) => s.lineX);
  const ys = i.samples.map((s) => s.spreadY);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const stdX  = Math.sqrt(xs.reduce((s, v) => s + (v - meanX) ** 2, 0) / xs.length);
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  // Stable line: small stdX + low meanY.
  const stability = Math.max(0, Math.min(1, 1 - (stdX / 10) - (meanY / 60)));
  return { value: Number(stability.toFixed(3)), version: V, components: { stdLineX: Number(stdX.toFixed(2)), meanSpreadY: Number(meanY.toFixed(2)) } };
}

// ─────────────────────────────────────────────────────────────────────────
// 8. PressingSynchronyIndex — fraction of HOME sprinters within same window.
// ─────────────────────────────────────────────────────────────────────────

export interface PressingSynchronyInput {
  homeSprinters:  number;
  homeTotal:      number;
  /** Optional std-dev of sprint-start times — lower = more synchronous. */
  sprintStartStdMs?: number;
}

export function pressingSynchronyIndex(i: PressingSynchronyInput): MetricResult {
  const base = i.homeTotal === 0 ? 0 : i.homeSprinters / i.homeTotal;
  const tightness = typeof i.sprintStartStdMs === 'number' ? Math.max(0, Math.min(1, 1 - i.sprintStartStdMs / 2000)) : 0.5;
  const v = Math.max(0, Math.min(1, 0.7 * base + 0.3 * tightness));
  return { value: Number(v.toFixed(3)), version: V, components: { ratio: Number(base.toFixed(3)), tightness: Number(tightness.toFixed(3)) } };
}

// ─────────────────────────────────────────────────────────────────────────
// Composite snapshot helper — returns all 8 in one call given the inputs.
// ─────────────────────────────────────────────────────────────────────────

export interface NeuroMetricSnapshotInput {
  motion:    EventMotionLoadInput;
  reaction:  VisionReactionDelayInput;
  visual:    TacticalVisualDelayInput;
  pressure:  BallPressureGradientInput;
  collapse:  SpatialCollapseIndexInput;
  transition: TransitionSharpnessInput;
  defense:    DefensiveLineStabilityInput;
  synchrony:  PressingSynchronyInput;
}

export function neuroMetricSnapshot(i: NeuroMetricSnapshotInput): Record<string, MetricResult> {
  return {
    eventMotionLoad:         eventMotionLoad(i.motion),
    visionReactionDelay:     visionReactionDelay(i.reaction),
    tacticalVisualDelay:     tacticalVisualDelay(i.visual),
    ballPressureGradient:    ballPressureGradient(i.pressure),
    spatialCollapseIndex:    spatialCollapseIndex(i.collapse),
    transitionSharpnessScore: transitionSharpnessScore(i.transition),
    defensiveLineStability:  defensiveLineStability(i.defense),
    pressingSynchronyIndex:  pressingSynchronyIndex(i.synchrony),
  };
}

export const NEURO_METRICS_VERSION = V;
