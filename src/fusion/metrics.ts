// Familista — Fusion metrics: BLI + TAI (Phase D-IP)
// ─────────────────────────────────────────────────────────────────────────
// Pure functions only. NO database access. NO Express types. All inputs
// are pre-aggregated arrays of normalised packets; outputs are scalars
// + component breakdowns for transparency / auditability.
//
// Reproducibility: every weight + constant is named and exported, so a
// regulator or third-party scientific reviewer can reproduce the score
// from raw inputs without reading the implementation.

import type {
  GlobalTimestampMs,
  BiomechanicalLoadIndex,
  TacticalAttritionIndex,
} from './types';

// ─────────────────────────────────────────────────────────────────────────
// Constants (versioned — bump the version when weights change)
// ─────────────────────────────────────────────────────────────────────────

export const FUSION_METRICS_VERSION = 'v1.0';

/** Biomechanical Load Index weights — sum to 1.0. */
export const BLI_WEIGHTS = {
  accelLoad:      0.30,
  sprintLoad:     0.25,
  hrStress:       0.20,
  jointStrain:    0.15,
  mechanicalWork: 0.10,
} as const;

/** Tactical Attrition Index weights — sum to 1.0. */
export const TAI_WEIGHTS = {
  bliZ:                 0.35,
  biochemFatigueDelta:  0.15,
  tacticalDelaySec:     0.10,
  positionalDeviationM: 0.10,
  recoveryLagSec:       0.10,
  sprintDegradation:    0.10,
  injuryRiskP:          0.10,
} as const;

/** Sprint threshold (m/s). UEFA-style: > 7 m/s ≈ 25.2 km/h. */
export const SPRINT_THRESHOLD_MPS = 7.0;

/** HR stress threshold — anything above this is counted as stress load. */
export const HR_STRESS_THRESHOLD_BPM = 160;

/** Safe sigmoid for [0,1] scaling. */
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

/** Clamp helper. */
function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

/** Z-score against a baseline mean + std. Capped at ±3 to suppress outliers. */
function zscore(value: number, baselineMean: number, baselineStd: number): number {
  if (baselineStd <= 0) return 0;
  const z = (value - baselineMean) / baselineStd;
  return clamp(z, -3, 3);
}

// ─────────────────────────────────────────────────────────────────────────
// BLI inputs + computation
// ─────────────────────────────────────────────────────────────────────────

export interface BLIInputs {
  playerId: string;
  windowMs: number;

  /** Time-aligned accelerometer magnitude squared, summed over window. */
  accelMagSqSum:     number;
  /** Time-aligned sprint-time integral of v² (m²/s², ∫v² · 1{v>SPRINT}). */
  sprintVsqIntegral: number;
  /** ∫max(0, HR - HR_threshold)² dt (bpm² · s). */
  hrStressIntegral:  number;
  /** Joint strain proxy: ∫|ω|² · limb_mass dt. */
  jointStrainIntegral: number;
  /** Mechanical work proxy (J): ½ m Σ Δv². */
  mechanicalWork:    number;

  /** Player baseline distributions (from last 7 days of training). */
  baseline: {
    accelMagSqMean:    number; accelMagSqStd:    number;
    sprintVsqMean:     number; sprintVsqStd:     number;
    hrStressMean:      number; hrStressStd:      number;
    jointStrainMean:   number; jointStrainStd:   number;
    mechanicalWorkMean:number; mechanicalWorkStd:number;
  };

  computedAt?: GlobalTimestampMs;
}

/**
 * Biomechanical Load Index
 *
 *   BLI(p, t, W) = Σ_k w_k · zscore(X_k, μ_k, σ_k)
 *
 * where X_k are the five components above and (μ_k, σ_k) are the
 * player's last-7-days baseline. Result is approximately bounded in
 * [-3, +5] (because z-scores are clamped to ±3 and weights sum to 1,
 * but mechanical work can mildly exceed in extreme cases).
 */
export function biomechanicalLoadIndex(input: BLIInputs): BiomechanicalLoadIndex {
  const aZ = zscore(input.accelMagSqSum,       input.baseline.accelMagSqMean,    input.baseline.accelMagSqStd);
  const sZ = zscore(input.sprintVsqIntegral,   input.baseline.sprintVsqMean,     input.baseline.sprintVsqStd);
  const hZ = zscore(input.hrStressIntegral,    input.baseline.hrStressMean,      input.baseline.hrStressStd);
  const jZ = zscore(input.jointStrainIntegral, input.baseline.jointStrainMean,   input.baseline.jointStrainStd);
  const mZ = zscore(input.mechanicalWork,      input.baseline.mechanicalWorkMean,input.baseline.mechanicalWorkStd);

  const value =
      BLI_WEIGHTS.accelLoad      * aZ
    + BLI_WEIGHTS.sprintLoad     * sZ
    + BLI_WEIGHTS.hrStress       * hZ
    + BLI_WEIGHTS.jointStrain    * jZ
    + BLI_WEIGHTS.mechanicalWork * mZ;

  return {
    playerId:   input.playerId,
    windowMs:   input.windowMs,
    components: { accelLoad: aZ, sprintLoad: sZ, hrStress: hZ, jointStrain: jZ, mechanicalWork: mZ },
    value:      Number(value.toFixed(4)),
    computedAt: input.computedAt ?? Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// TAI inputs + computation
// ─────────────────────────────────────────────────────────────────────────

export interface TAIInputs {
  playerId: string;
  windowMs: number;

  /** Output of BLI for the same window. */
  bli: BiomechanicalLoadIndex;

  /**
   * Biochemical fatigue gradient (1/min). Positive = worsening.
   * Computed as (lactate_now - lactate_window_start) / window_min.
   * If patch unavailable, set to NaN — the helper will substitute a
   * BLI-derived proxy and emit a diagnostic note.
   */
  biochemDeltaPerMin:   number;

  /** Mean reaction time (seconds) between opponent action and our tactical response. */
  tacticalDelaySec:     number;

  /**
   * L2 distance (m) between player's expected position (formation
   * template) and actual position, averaged over the window.
   */
  positionalDeviationM: number;

  /** Mean recovery time between sprints (seconds). Higher = more attrition. */
  recoveryLagSec:       number;

  /**
   * Sprint degradation: ratio of peak v_max in the recent window vs first
   * 15 min of the match. 1.0 = no degradation; 0.7 = lost 30 % of peak.
   */
  sprintMaxRatio:       number;

  /**
   * Injury risk probability (0..1) from external model. Optional — if
   * absent we substitute a sigmoid(BLI.value) approximation.
   */
  injuryRiskP?:         number;

  /** Baselines for the non-BLI components (player-specific). */
  baseline: {
    biochemDeltaMean:        number; biochemDeltaStd:        number;
    tacticalDelayMean:       number; tacticalDelayStd:       number;
    positionalDeviationMean: number; positionalDeviationStd: number;
    recoveryLagMean:         number; recoveryLagStd:         number;
  };

  computedAt?: GlobalTimestampMs;
}

/**
 * Tactical Attrition Index
 *
 *   TAI(p, t) = Σ_k w_k · norm_k
 *
 * where the normalised components are:
 *   • bliZ                 = sigmoid(BLI.value)        ∈ (0,1)
 *   • biochemFatigueDelta  = sigmoid(zscore)           ∈ (0,1)
 *   • tacticalDelaySec     = sigmoid(zscore)           ∈ (0,1)
 *   • positionalDeviationM = sigmoid(zscore)           ∈ (0,1)
 *   • recoveryLagSec       = sigmoid(zscore)           ∈ (0,1)
 *   • sprintDegradation    = 1 - sprintMaxRatio        ∈ [0,1]
 *   • injuryRiskP          = direct probability        ∈ [0,1]
 *
 * All components mapped to [0,1]; weights sum to 1 ⇒ TAI ∈ [0,1].
 * Higher TAI = closer to substitution / injury / tactical breakdown.
 */
export function tacticalAttritionIndex(input: TAIInputs): TacticalAttritionIndex {
  const biochemAvailable = !Number.isNaN(input.biochemDeltaPerMin) && Number.isFinite(input.biochemDeltaPerMin);

  // Map each component into [0,1].
  const c = {
    bliZ:                 sigmoid(input.bli.value),
    biochemFatigueDelta:  biochemAvailable
                            ? sigmoid(zscore(input.biochemDeltaPerMin, input.baseline.biochemDeltaMean, input.baseline.biochemDeltaStd))
                            : sigmoid(input.bli.value), // proxy
    tacticalDelaySec:     sigmoid(zscore(input.tacticalDelaySec,     input.baseline.tacticalDelayMean,       input.baseline.tacticalDelayStd)),
    positionalDeviationM: sigmoid(zscore(input.positionalDeviationM, input.baseline.positionalDeviationMean, input.baseline.positionalDeviationStd)),
    recoveryLagSec:       sigmoid(zscore(input.recoveryLagSec,       input.baseline.recoveryLagMean,         input.baseline.recoveryLagStd)),
    sprintDegradation:    clamp(1 - input.sprintMaxRatio, 0, 1),
    injuryRiskP:          clamp(input.injuryRiskP ?? sigmoid(input.bli.value - 1), 0, 1),
  };

  const value =
      TAI_WEIGHTS.bliZ                 * c.bliZ
    + TAI_WEIGHTS.biochemFatigueDelta  * c.biochemFatigueDelta
    + TAI_WEIGHTS.tacticalDelaySec     * c.tacticalDelaySec
    + TAI_WEIGHTS.positionalDeviationM * c.positionalDeviationM
    + TAI_WEIGHTS.recoveryLagSec       * c.recoveryLagSec
    + TAI_WEIGHTS.sprintDegradation    * c.sprintDegradation
    + TAI_WEIGHTS.injuryRiskP          * c.injuryRiskP;

  return {
    playerId:   input.playerId,
    windowMs:   input.windowMs,
    components: c,
    value:      Number(clamp(value, 0, 1).toFixed(4)),
    computedAt: input.computedAt ?? Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: synthesise a sensible baseline when we have no history yet.
// Used by the read-only fusion service so the endpoint always returns
// numbers even on a brand-new club with zero historical data.
// ─────────────────────────────────────────────────────────────────────────

export function defaultBaseline(): BLIInputs['baseline'] & TAIInputs['baseline'] {
  return {
    accelMagSqMean:    100, accelMagSqStd:    40,
    sprintVsqMean:     600, sprintVsqStd:     200,
    hrStressMean:      8000, hrStressStd:     3500,
    jointStrainMean:   25,  jointStrainStd:   10,
    mechanicalWorkMean:18000, mechanicalWorkStd: 7000,
    biochemDeltaMean:  0.4,  biochemDeltaStd: 0.3,    // mmol/min lactate proxy
    tacticalDelayMean: 1.2,  tacticalDelayStd: 0.5,   // seconds
    positionalDeviationMean: 3.5, positionalDeviationStd: 2.0, // metres
    recoveryLagMean:   18,   recoveryLagStd:   8,     // seconds between sprints
  };
}
