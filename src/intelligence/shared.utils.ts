// Familista — Intelligence Shared Utilities (Phase 11)
// Target: src/intelligence/shared.utils.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure functions shared across unified intelligence, tactical, and succession
// services. Zero external dependencies — fully testable without DB stubs.

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConfidenceLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface ConfidenceInput {
  reportCount:     number;
  hasContract:     boolean;
  hasMarketValue:  boolean;
  hasWorkloadData: boolean;
  hasVideoClips:   boolean;
}

export interface ScoreComponent {
  label:    string;
  score:    number;   // 0–100
  weight:   number;   // 0–1
  evidence: string;   // 1-sentence proof
}

// ─── normalize ────────────────────────────────────────────────────────────────

/** Maps a raw value to 0–100. Clamps on both ends. */
export function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

// ─── weightedSum ──────────────────────────────────────────────────────────────

/**
 * Returns a weighted average normalised to 0–100.
 * Weights do not need to sum to 1 — they are re-normalised internally.
 */
export function weightedSum(
  components: ReadonlyArray<{ score: number; weight: number }>,
): number {
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;
  const raw = components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
  return +Math.min(100, Math.max(0, raw)).toFixed(1);
}

// ─── computeConfidence ────────────────────────────────────────────────────────

/**
 * Returns a four-level confidence rating based on available data density.
 *   NONE   — zero data
 *   LOW    — minimal scouting, contract unknown
 *   MEDIUM — some reports + at least one module populated
 *   HIGH   — rich multi-module data set
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceLevel {
  const points =
    (input.reportCount >= 7 ? 3 : input.reportCount >= 3 ? 2 : input.reportCount >= 1 ? 1 : 0) +
    (input.hasContract     ? 1 : 0) +
    (input.hasMarketValue  ? 1 : 0) +
    (input.hasWorkloadData ? 1 : 0) +
    (input.hasVideoClips   ? 1 : 0);

  if (points >= 6) return 'HIGH';
  if (points >= 3) return 'MEDIUM';
  if (points >= 1) return 'LOW';
  return 'NONE';
}

// ─── explainComponents ────────────────────────────────────────────────────────

/**
 * Produces 3–4 plain-English bullet strings from the top-contributing score
 * components, preceded by an overall summary sentence.
 */
export function explainComponents(
  components: ReadonlyArray<ScoreComponent>,
  overallScore: number,
): string[] {
  const band =
    overallScore >= 75 ? 'strong' :
    overallScore >= 55 ? 'moderate' :
    overallScore >= 40 ? 'limited' : 'weak';

  const lines: string[] = [
    `Overall intelligence score ${overallScore.toFixed(0)}/100 (${band}).`,
  ];

  const sorted = components
    .slice()
    .sort((a, b) => b.score * b.weight - a.score * a.weight);

  for (const c of sorted.slice(0, 3)) {
    const quality = c.score >= 75 ? 'strong' : c.score >= 50 ? 'moderate' : 'low';
    const contrib = (c.score * c.weight).toFixed(0);
    lines.push(
      `${c.label}: ${c.score.toFixed(0)}/100 (${quality}) — ${c.evidence} [contributes ${contrib} pts].`,
    );
  }

  return lines;
}

// ─── trendDirection ───────────────────────────────────────────────────────────

/** Compares first-half average vs second-half average of a value series. */
export function trendDirection(values: ReadonlyArray<number>): 'UP' | 'DOWN' | 'FLAT' {
  if (values.length < 2) return 'FLAT';
  const mid   = Math.ceil(values.length / 2);
  const first = values.slice(0, mid);
  const last  = values.slice(Math.floor(values.length / 2));
  const avg   = (arr: ReadonlyArray<number>) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const delta = avg(last) - avg(first);
  if (delta > 2)  return 'UP';
  if (delta < -2) return 'DOWN';
  return 'FLAT';
}

// ─── ageDecayFactor ───────────────────────────────────────────────────────────

/**
 * Returns a 0–1 future-value multiplier based on age.
 *   ≤27 → 1.0 (peak window)
 *   28–33 → linear decay 1.0 → 0.70
 *   ≥34 → 0.50 (late career)
 */
export function ageDecayFactor(age: number): number {
  if (age <= 27) return 1.0;
  if (age >= 34) return 0.5;
  return +(1.0 - ((age - 27) / 6) * 0.30).toFixed(3);
}

// ─── computeMedicalRiskScore ──────────────────────────────────────────────────

/**
 * Returns 0–100. Higher score = player is less available / higher injury risk.
 * Inverted before contributing to the overall score (inversion done externally).
 */
export function computeMedicalRiskScore(input: {
  activeInjuryCount: number;
  totalInjuryCount:  number;
  recentReturnDays:  number | null;   // days since most recent return-to-play; null = never injured
  acwr:              number | null;   // Acute:Chronic Workload Ratio; null = no GPS data
}): number {
  let score = 0;

  // Active injuries (dominant factor)
  if (input.activeInjuryCount >= 2) score += 70;
  else if (input.activeInjuryCount === 1) score += 40;

  // Injury history burden (3 pts per past injury, capped 20)
  score += Math.min(20, input.totalInjuryCount * 3);

  // ACWR risk zone (Foster 1996: >1.5 = danger, <0.8 = undertraining)
  if (input.acwr !== null) {
    if (input.acwr > 1.5)      score += 25;
    else if (input.acwr > 1.3) score += 12;
    else if (input.acwr < 0.8) score += 5;
  }

  // Recent return-to-play (<14 days = still fragile)
  if (input.recentReturnDays !== null) {
    if (input.recentReturnDays <= 14) score += 20;
    else if (input.recentReturnDays <= 30) score += 10;
  }

  return Math.min(100, score);
}

// ─── computeVideoInfluenceScore ───────────────────────────────────────────────

/**
 * Returns 0–100. Measures strength of video evidence supporting scouting.
 * Clip-type weights:
 *   GOAL / ASSIST / KEY_CHANCE → ×3
 *   KEY_PASS / SAVE            → ×2
 *   (all others)               → ×1
 * Each annotation on a clip adds 0.5 weighted points (capped 3 per clip).
 */
export function computeVideoInfluenceScore(
  clips: ReadonlyArray<{ clipType?: string | null; annotationCount: number }>,
): number {
  if (!clips.length) return 0;

  const WEIGHT: Record<string, number> = {
    GOAL: 3, ASSIST: 3, KEY_CHANCE: 3,
    KEY_PASS: 2, SAVE: 2,
  };

  let weighted = 0;
  for (const c of clips) {
    const w = WEIGHT[c.clipType ?? ''] ?? 1;
    weighted += w + Math.min(3, c.annotationCount * 0.5);
  }

  // Scale: 0 clips → 0, 5 clips (all neutral) → 10, 20 clips (good mix) → 80+
  return Math.min(100, +normalize(weighted, 0, 60).toFixed(1));
}
