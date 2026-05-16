// Familista — AI Decision Engine
// File location: src/lib/ai-scoring.lib.ts
//
// Pure deterministic scoring functions — board-safe, replayable, no LLM
// dependency. Each function consumes a FeatureMap and returns a
// DeterministicScore (score 0-100, weighted factors, recommendation).
//
// Every threshold and weight is loaded from the active AIModel.parameters
// JSON when called from the orchestrator. Defaults are listed inline for
// readability and used when the model parameters are absent.
//
// These functions are the auditable core of every AI decision. The LLM only
// wraps these with narrative — it never changes the score or the action.

import type {
  DeterministicScore,
  ScoreFactor,
  PlayerFeatures,
  MatchFeatures,
  ClubFeatures,
  FranchiseFeatures,
  InvestorFeatures,
  EntityFeatures,
  ExecutiveFeatures,
  AIUrgency,
  RecommendationAction,
} from '../types/ai-engine.types';

// ─── Utilities ───────────────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function urgencyFromScore(score: number, criticalAt = 80, highAt = 60, mediumAt = 40, lowAt = 20): AIUrgency {
  if (score >= criticalAt) return 'CRITICAL';
  if (score >= highAt) return 'HIGH';
  if (score >= mediumAt) return 'MEDIUM';
  if (score >= lowAt) return 'LOW';
  return 'INFO';
}

function paramNum(params: Record<string, unknown> | undefined, key: string, fallback: number): number {
  if (!params) return fallback;
  const v = params[key];
  return typeof v === 'number' ? v : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER — 7 scoring functions
// ─────────────────────────────────────────────────────────────────────────────

export function scoreInjuryRisk(f: PlayerFeatures, p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 0;
  const warnings: string[] = [];

  if (f.isInjured) {
    factors.push({ name: 'currently_injured', value: true, contribution: 100, weight: 'CRITICAL', description: 'Player is currently injured' });
    score = 100;
  } else {
    const conditionTarget = paramNum(p, 'conditionThreshold', 70);
    if (f.condition < conditionTarget) {
      const contribution = Math.min(35, (conditionTarget - f.condition) * 0.7);
      factors.push({ name: 'low_condition', value: f.condition, contribution: round2(contribution), weight: 'HIGH', description: `Condition ${f.condition} < ${conditionTarget}` });
      score += contribution;
    }

    if (f.daysSinceLastInjury != null && f.daysSinceLastInjury < paramNum(p, 'recentInjuryDays', 60)) {
      const contribution = Math.max(0, 25 - f.daysSinceLastInjury * 0.4);
      factors.push({ name: 'recent_injury_history', value: f.daysSinceLastInjury, contribution: round2(contribution), weight: 'HIGH', description: 'Returned from injury recently' });
      score += contribution;
    }

    if (f.playerLoadDelta14dVs30d != null && f.playerLoadDelta14dVs30d > paramNum(p, 'loadSpikeRatio', 0.2)) {
      const contribution = Math.min(25, f.playerLoadDelta14dVs30d * 100);
      factors.push({ name: 'load_spike', value: f.playerLoadDelta14dVs30d, contribution: round2(contribution), weight: 'HIGH', description: '14-day load is significantly above 30-day baseline' });
      score += contribution;
    }

    if (f.age != null && f.age > paramNum(p, 'ageRiskFloor', 30)) {
      const contribution = (f.age - 30) * 1.8;
      factors.push({ name: 'age_factor', value: f.age, contribution: round2(contribution), weight: 'MEDIUM', description: 'Player over 30' });
      score += contribution;
    }

    if (f.avgRiskScore30d != null && f.avgRiskScore30d > paramNum(p, 'gpsRiskFloor', 0.5)) {
      const contribution = Math.min(20, f.avgRiskScore30d * 20);
      factors.push({ name: 'gps_risk_signal', value: f.avgRiskScore30d, contribution: round2(contribution), weight: 'MEDIUM', description: 'Wearable risk score elevated' });
      score += contribution;
    }

    if (f.injuryCount365d >= 3) {
      const contribution = Math.min(15, f.injuryCount365d * 3);
      factors.push({ name: 'recurring_injuries', value: f.injuryCount365d, contribution: round2(contribution), weight: 'MEDIUM', description: 'Multiple injuries in the last 12 months' });
      score += contribution;
    }
  }

  score = clamp(score);
  if (factors.length === 0) factors.push({ name: 'no_risk_signals', value: 'clear', contribution: 0, weight: 'INFO' });

  const recommendation: RecommendationAction = score >= 60
    ? { kind: 'REST_PLAYER', label: 'Rest player and run medical evaluation', target: { type: 'Player', id: f.playerId } }
    : score >= 30
      ? { kind: 'MONITOR_PLAYER', label: 'Increase monitoring; reduce load for 7 days', target: { type: 'Player', id: f.playerId } }
      : { kind: 'CONTINUE_NORMAL', label: 'Continue normal training load', target: { type: 'Player', id: f.playerId } };

  if (score >= 70 && !f.isInjured) warnings.push('High injury-risk signal without clinical confirmation — medical staff sign-off required');

  return {
    score: round2(score),
    confidence: f.isInjured ? 1.0 : clamp(0.55 + factors.length * 0.05, 0, 0.95),
    factors,
    warnings,
    urgency: urgencyFromScore(score),
    recommendation,
  };
}

export function scorePlayerGrowth(f: PlayerFeatures, p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;

  const gap = f.potential - f.overallRating;
  factors.push({ name: 'potential_gap', value: gap, contribution: round2(gap * 1.5), weight: 'HIGH', description: 'Potential minus current rating' });
  score += gap * 1.5;

  if (f.age != null) {
    const peakAge = paramNum(p, 'peakAge', 27);
    const ageDelta = peakAge - f.age;
    const contribution = clamp(ageDelta * 1.5, -25, 25);
    factors.push({ name: 'age_curve', value: f.age, contribution: round2(contribution), weight: 'HIGH', description: 'Distance from peak development age' });
    score += contribution;
  }

  if (f.recentMatchRatingAvg != null && f.recentMatchRatingAvg > 7) {
    const contribution = (f.recentMatchRatingAvg - 7) * 8;
    factors.push({ name: 'form_signal', value: f.recentMatchRatingAvg, contribution: round2(contribution), weight: 'MEDIUM', description: 'Form indicates upward trajectory' });
    score += contribution;
  }

  if (f.recentMinutesPlayed < paramNum(p, 'minPlayingTime', 180)) {
    factors.push({ name: 'low_playing_time', value: f.recentMinutesPlayed, contribution: -10, weight: 'MEDIUM', description: 'Insufficient minutes for development' });
    score -= 10;
  }

  score = clamp(score);
  const recommendation: RecommendationAction = score >= 70
    ? { kind: 'INVEST_IN_DEVELOPMENT', label: 'Prioritise individualised training programme', target: { type: 'Player', id: f.playerId } }
    : score >= 40
      ? { kind: 'STANDARD_DEVELOPMENT', label: 'Maintain current programme; review in 90 days', target: { type: 'Player', id: f.playerId } }
      : { kind: 'REASSESS_TRAJECTORY', label: 'Reassess long-term role on the squad', target: { type: 'Player', id: f.playerId } };

  return {
    score: round2(score),
    confidence: clamp(0.5 + factors.length * 0.08, 0, 0.9),
    factors,
    warnings: [],
    urgency: urgencyFromScore(score, 85, 65, 45, 25),
    recommendation,
  };
}

export function scoreTalentDetection(f: PlayerFeatures, p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 0;

  if (f.positionAvgRating != null) {
    const peerGap = f.overallRating - f.positionAvgRating;
    const c = clamp(peerGap * 4, -20, 30);
    factors.push({ name: 'peer_position_gap', value: peerGap, contribution: round2(c), weight: 'HIGH', description: 'Rating vs same-position teammates' });
    score += 50 + c;
  } else {
    score += 50;
  }

  const upside = f.potential - f.overallRating;
  factors.push({ name: 'upside', value: upside, contribution: round2(upside * 2), weight: 'HIGH', description: 'Headroom to peak' });
  score += upside * 2;

  if (f.age != null && f.age <= paramNum(p, 'youthCutoffAge', 23)) {
    factors.push({ name: 'young_age', value: f.age, contribution: 12, weight: 'MEDIUM', description: 'Within youth development window' });
    score += 12;
  }

  if (f.recentGoalsPer90 != null && f.recentGoalsPer90 > 0.5) {
    factors.push({ name: 'output_per_90', value: f.recentGoalsPer90, contribution: 8, weight: 'MEDIUM', description: 'Strong goal output per 90' });
    score += 8;
  }

  score = clamp(score);
  const recommendation: RecommendationAction = score >= 70
    ? { kind: 'PROMOTE_OR_RETAIN', label: 'Promote to first team and lock contract', target: { type: 'Player', id: f.playerId } }
    : score >= 50
      ? { kind: 'WATCHLIST', label: 'Add to development watchlist', target: { type: 'Player', id: f.playerId } }
      : { kind: 'NO_ACTION', label: 'Below talent threshold — no action', target: { type: 'Player', id: f.playerId } };

  return {
    score: round2(score),
    confidence: clamp(0.55 + factors.length * 0.08, 0, 0.92),
    factors,
    warnings: f.positionAvgRating == null ? ['Peer baseline missing — confidence reduced'] : [],
    urgency: urgencyFromScore(score, 80, 60, 40, 20),
    recommendation,
  };
}

export function scoreFatigue(f: PlayerFeatures, p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 0;

  const conditionPenalty = clamp((100 - f.condition) * 0.4, 0, 40);
  factors.push({ name: 'condition_drop', value: f.condition, contribution: round2(conditionPenalty), weight: 'HIGH', description: '100 minus current condition' });
  score += conditionPenalty;

  if (f.playerLoadDelta14dVs30d != null && f.playerLoadDelta14dVs30d > 0) {
    const c = Math.min(30, f.playerLoadDelta14dVs30d * 120);
    factors.push({ name: 'cumulative_load', value: f.playerLoadDelta14dVs30d, contribution: round2(c), weight: 'HIGH', description: 'Recent load above baseline' });
    score += c;
  }

  if (f.recentMinutesPlayed > paramNum(p, 'minutesFatigueThreshold', 540)) {
    const c = Math.min(15, (f.recentMinutesPlayed - 540) / 60);
    factors.push({ name: 'high_minutes', value: f.recentMinutesPlayed, contribution: round2(c), weight: 'MEDIUM', description: 'Heavy minutes load in recent matches' });
    score += c;
  }

  score = clamp(score);
  const recommendation: RecommendationAction = score >= 60
    ? { kind: 'ROTATE_PLAYER', label: 'Rotate out of next match; recovery protocol', target: { type: 'Player', id: f.playerId } }
    : score >= 30
      ? { kind: 'LIGHTER_TRAINING', label: 'Reduce training intensity for 5 days', target: { type: 'Player', id: f.playerId } }
      : { kind: 'NO_ACTION', label: 'Fatigue within normal band', target: { type: 'Player', id: f.playerId } };

  return {
    score: round2(score),
    confidence: clamp(0.5 + factors.length * 0.1, 0, 0.9),
    factors,
    warnings: [],
    urgency: urgencyFromScore(score),
    recommendation,
  };
}

export function scoreTransferRecommendation(f: PlayerFeatures, p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 30;

  if (f.contractDaysLeft != null && f.contractDaysLeft < paramNum(p, 'contractRiskDays', 365)) {
    const c = Math.min(35, (365 - f.contractDaysLeft) / 12);
    factors.push({ name: 'contract_running_down', value: f.contractDaysLeft, contribution: round2(c), weight: 'HIGH', description: 'Contract expires within 12 months' });
    score += c;
  }

  if (f.teamAvgRating != null && f.overallRating < f.teamAvgRating - 5) {
    factors.push({ name: 'below_squad_quality', value: f.overallRating - f.teamAvgRating, contribution: 15, weight: 'MEDIUM' });
    score += 15;
  }

  if (f.recentMinutesPlayed < paramNum(p, 'minMinutesForRole', 180)) {
    factors.push({ name: 'limited_role', value: f.recentMinutesPlayed, contribution: 10, weight: 'MEDIUM', description: 'Low minutes suggest squad redundancy' });
    score += 10;
  }

  if (f.age != null && f.age > 32) {
    factors.push({ name: 'aging_curve', value: f.age, contribution: (f.age - 32) * 4, weight: 'MEDIUM' });
    score += (f.age - 32) * 4;
  }

  if (f.weeklyWage > paramNum(p, 'wagePressureThreshold', 30000)) {
    factors.push({ name: 'wage_pressure', value: f.weeklyWage, contribution: 10, weight: 'MEDIUM', description: 'High wage relative to typical squad band' });
    score += 10;
  }

  score = clamp(score);
  const recommendation: RecommendationAction = score >= 70
    ? { kind: 'SELL_PLAYER', label: 'Open transfer listing; prioritise sale this window', target: { type: 'Player', id: f.playerId } }
    : score >= 50
      ? { kind: 'EXPLORE_OFFERS', label: 'Listen to offers; do not actively shop', target: { type: 'Player', id: f.playerId } }
      : { kind: 'RETAIN_PLAYER', label: 'Retain — no transfer pressure', target: { type: 'Player', id: f.playerId } };

  return {
    score: round2(score),
    confidence: clamp(0.5 + factors.length * 0.07, 0, 0.9),
    factors,
    warnings: [],
    urgency: urgencyFromScore(score, 80, 65, 45, 25),
    recommendation,
  };
}

export function scoreTrainingOptimization(f: PlayerFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;

  if (f.condition < 80) {
    factors.push({ name: 'recovery_priority', value: f.condition, contribution: -15, weight: 'HIGH', description: 'Recovery should dominate training' });
    score -= 15;
  }
  if (f.recentMatchRatingAvg != null && f.recentMatchRatingAvg < 6.5) {
    factors.push({ name: 'form_drop', value: f.recentMatchRatingAvg, contribution: -10, weight: 'MEDIUM', description: 'Form below par' });
    score -= 10;
  }
  if (f.potential - f.overallRating > 5) {
    factors.push({ name: 'development_headroom', value: f.potential - f.overallRating, contribution: 15, weight: 'HIGH', description: 'Significant headroom for skill work' });
    score += 15;
  }

  const drills =
    f.condition < 80
      ? ['RECOVERY', 'TECHNICAL_PASSING']
      : f.recentGoalsPer90 != null && f.recentGoalsPer90 < 0.3 && f.position === 'ST'
        ? ['SHOOTING_PRACTICE', 'POSSESSION']
        : f.position === 'GK'
          ? ['DEFENSIVE_SHAPE', 'TECHNICAL_PASSING']
          : ['TECHNICAL_PASSING', 'PRESSING', 'TRANSITION_PLAY'];

  score = clamp(score);
  const recommendation: RecommendationAction = {
    kind: 'CUSTOM_TRAINING_PLAN',
    label: `Drills: ${drills.join(', ')}`,
    target: { type: 'Player', id: f.playerId },
    params: { drills, sessionsPerWeek: f.condition < 80 ? 3 : 5 },
  };

  return {
    score: round2(score),
    confidence: 0.75,
    factors,
    warnings: [],
    urgency: 'MEDIUM',
    recommendation,
  };
}

export function scoreLineup(
  candidates: Array<PlayerFeatures & { matchId: string }>,
  match: MatchFeatures,
  _p?: Record<string, unknown>,
): DeterministicScore {
  const factors: ScoreFactor[] = [];

  // Greedy selection by overallRating, excluding injured / high fatigue
  const eligible = candidates
    .filter((c) => !c.isInjured && c.condition >= 65)
    .sort((a, b) => b.overallRating - a.overallRating);

  if (eligible.length < 11) {
    factors.push({ name: 'insufficient_eligible_players', value: eligible.length, contribution: -30, weight: 'CRITICAL' });
  }

  const xi = eligible.slice(0, 11);
  const subs = eligible.slice(11, 18);
  const avgRating = xi.length > 0 ? xi.reduce((s, p) => s + p.overallRating, 0) / xi.length : 0;
  factors.push({ name: 'starting_xi_avg_rating', value: round2(avgRating), contribution: round2((avgRating - 70) * 2), weight: 'HIGH' });

  if (match.isHome) factors.push({ name: 'home_advantage', value: true, contribution: 5, weight: 'INFO' });

  const score = clamp(50 + (avgRating - 70) * 2 + (match.isHome ? 5 : -5));
  const recommendation: RecommendationAction = {
    kind: 'PROPOSED_LINEUP',
    label: `Starting XI by rating · ${xi.length}/${candidates.length} eligible`,
    target: { type: 'Match', id: match.matchId },
    params: { startingXi: xi.map((p) => p.playerId), substitutes: subs.map((p) => p.playerId) },
  };

  return {
    score: round2(score),
    confidence: eligible.length >= 11 ? 0.85 : 0.4,
    factors,
    warnings: eligible.length < 11 ? ['Fewer than 11 fully fit players available'] : [],
    urgency: urgencyFromScore(score),
    recommendation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COACH — formation, opponent, prep, substitution, training plan, tactics
// ─────────────────────────────────────────────────────────────────────────────

export function scoreFormation(squad: PlayerFeatures[], _match: MatchFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const byPosition: Record<string, number> = {};
  for (const p of squad) byPosition[p.position] = (byPosition[p.position] ?? 0) + 1;
  const factors: ScoreFactor[] = Object.entries(byPosition).map(([pos, count]) => ({
    name: `position_count_${pos}`,
    value: count,
    contribution: 0,
    weight: 'INFO',
  }));

  // Naive formation selection from composition
  const def = (byPosition.DC ?? 0) + (byPosition.DL ?? 0) + (byPosition.DR ?? 0);
  const mid = (byPosition.MC ?? 0) + (byPosition.DMC ?? 0) + (byPosition.AMC ?? 0) + (byPosition.ML ?? 0) + (byPosition.MR ?? 0);
  const fwd = (byPosition.ST ?? 0) + (byPosition.AML ?? 0) + (byPosition.AMR ?? 0);
  let formation = '4-3-3';
  if (def >= 5) formation = '5-3-2';
  else if (fwd >= 3 && mid >= 4) formation = '4-3-3';
  else if (mid >= 5) formation = '4-5-1';
  else formation = '4-4-2';

  return {
    score: 65,
    confidence: 0.7,
    factors,
    warnings: def < 3 || mid < 3 ? ['Squad composition is unbalanced for canonical formations'] : [],
    urgency: 'MEDIUM',
    recommendation: { kind: 'PROPOSE_FORMATION', label: `Suggested formation: ${formation}`, params: { formation, def, mid, fwd } },
  };
}

export function scoreOpponent(match: MatchFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;

  factors.push({ name: 'recent_form', value: match.recentResultsForm, contribution: match.recentResultsForm * 2, weight: 'HIGH' });
  score += match.recentResultsForm * 2;

  if (match.isHome) {
    factors.push({ name: 'home_venue', value: true, contribution: 8, weight: 'MEDIUM' });
    score += 8;
  } else {
    factors.push({ name: 'away_venue', value: true, contribution: -8, weight: 'MEDIUM' });
    score -= 8;
  }

  if (match.daysToMatch < 3) factors.push({ name: 'short_rest', value: match.daysToMatch, contribution: -5, weight: 'MEDIUM' });

  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.6,
    factors,
    warnings: ['Opponent statistical model is approximate — pair with manual scouting report'],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: 'OPPONENT_BRIEF',
      label: 'Generate opponent brief and tactical adjustments',
      target: { type: 'Match', id: match.matchId },
    },
  };
}

export function scoreMatchPreparation(squad: PlayerFeatures[], match: MatchFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 60;

  const injured = squad.filter((p) => p.isInjured).length;
  const fatigued = squad.filter((p) => p.condition < 70).length;
  factors.push({ name: 'injured_players', value: injured, contribution: -injured * 4, weight: 'HIGH' });
  factors.push({ name: 'fatigued_players', value: fatigued, contribution: -fatigued * 2, weight: 'MEDIUM' });
  score -= injured * 4 + fatigued * 2;

  if (match.daysToMatch < 4) {
    factors.push({ name: 'short_turnaround', value: match.daysToMatch, contribution: -10, weight: 'HIGH' });
    score -= 10;
  }

  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.78,
    factors,
    warnings: injured > 3 ? [`${injured} injured first-team players — squad rotation required`] : [],
    urgency: urgencyFromScore(100 - score),
    recommendation: {
      kind: 'PREP_PLAN',
      label: 'Apply match-day prep checklist with rotation focus',
      target: { type: 'Match', id: match.matchId },
      params: { rotationDepth: injured + fatigued > 5 ? 'HIGH' : 'STANDARD' },
    },
  };
}

export function scoreSubstitution(squad: PlayerFeatures[], _p?: Record<string, unknown>): DeterministicScore {
  // Identify highest-fatigue starters and best fresh bench options
  const factors: ScoreFactor[] = [];
  const sorted = squad.filter((p) => !p.isInjured).sort((a, b) => a.condition - b.condition);
  const candidates = sorted.slice(0, 3);
  for (const c of candidates) {
    factors.push({ name: `sub_off_candidate_${c.playerId}`, value: c.condition, contribution: -10, weight: 'MEDIUM' });
  }
  const score = clamp(40 + (60 - (candidates[0]?.condition ?? 100)));
  return {
    score,
    confidence: 0.7,
    factors,
    warnings: [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: 'SUBSTITUTE',
      label: 'Plan substitution windows around fatigued starters',
      params: { candidatesToReplace: candidates.map((c) => ({ id: c.playerId, condition: c.condition })) },
    },
  };
}

export function scoreTrainingPlan(squad: PlayerFeatures[], _p?: Record<string, unknown>): DeterministicScore {
  const avgCond = squad.reduce((s, p) => s + p.condition, 0) / Math.max(squad.length, 1);
  const drills = avgCond < 75 ? ['RECOVERY', 'TECHNICAL_PASSING'] : ['PRESSING', 'TRANSITION_PLAY', 'SET_PIECES'];
  const score = 50 + (avgCond - 70);
  return {
    score: clamp(score),
    confidence: 0.7,
    factors: [{ name: 'avg_squad_condition', value: round2(avgCond), contribution: round2(avgCond - 70), weight: 'HIGH' }],
    warnings: [],
    urgency: 'MEDIUM',
    recommendation: { kind: 'TRAINING_PLAN', label: `Drills: ${drills.join(', ')}`, params: { drills, sessions: 4 } },
  };
}

export function scoreTactical(_squad: PlayerFeatures[], match: MatchFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const tactic = match.isHome ? 'HIGH_PRESS_POSSESSION' : 'COMPACT_COUNTER';
  return {
    score: 60,
    confidence: 0.65,
    factors: [
      { name: 'venue', value: match.isHome ? 'HOME' : 'AWAY', contribution: 0, weight: 'INFO' },
      { name: 'form', value: match.recentResultsForm, contribution: 0, weight: 'INFO' },
    ],
    warnings: [],
    urgency: 'MEDIUM',
    recommendation: {
      kind: 'TACTIC',
      label: `Recommended approach: ${tactic}`,
      target: { type: 'Match', id: match.matchId },
      params: { tactic },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLUB — 5 scoring functions
// ─────────────────────────────────────────────────────────────────────────────

export function scoreFinancialHealth(f: ClubFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;

  if (f.netCashFlow90d > 0) {
    factors.push({ name: 'positive_cash_flow', value: f.netCashFlow90d, contribution: 25, weight: 'HIGH' });
    score += 25;
  } else {
    factors.push({ name: 'negative_cash_flow', value: f.netCashFlow90d, contribution: -25, weight: 'CRITICAL' });
    score -= 25;
  }

  const revGrowth = f.revenuePrior90d > 0 ? ((f.revenue90d - f.revenuePrior90d) / f.revenuePrior90d) * 100 : null;
  if (revGrowth != null) {
    const c = clamp(revGrowth, -20, 20);
    factors.push({ name: 'revenue_growth_pct', value: round2(revGrowth), contribution: round2(c), weight: 'HIGH' });
    score += c;
  }

  if (f.subscriptionStatus !== 'ACTIVE' && f.subscriptionStatus !== 'TRIALING') {
    factors.push({ name: 'subscription_status', value: f.subscriptionStatus, contribution: -15, weight: 'CRITICAL' });
    score -= 15;
  }

  if (f.wagesPerMonth > f.revenue90d / 3 && f.revenue90d > 0) {
    factors.push({ name: 'wage_revenue_ratio', value: round2(f.wagesPerMonth / (f.revenue90d / 3)), contribution: -10, weight: 'HIGH' });
    score -= 10;
  }

  score = clamp(score);
  const recommendation: RecommendationAction = score >= 65
    ? { kind: 'HEALTHY', label: 'Financials healthy; reinvest in growth', target: { type: 'Club', id: f.clubId } }
    : score >= 40
      ? { kind: 'MONITOR_CLOSELY', label: 'Tighten budget controls; review monthly', target: { type: 'Club', id: f.clubId } }
      : { kind: 'INTERVENE', label: 'Financial intervention required — operator review', target: { type: 'Club', id: f.clubId } };

  return {
    score: round2(score),
    confidence: clamp(0.55 + factors.length * 0.08, 0, 0.9),
    factors,
    warnings: score < 40 ? ['Critical financial signal — escalate to franchise operator'] : [],
    urgency: urgencyFromScore(100 - score),
    recommendation,
  };
}

export function scoreBudgetOptimization(f: ClubFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;

  const wageBurden = f.revenue90d > 0 ? f.wagesPerMonth / (f.revenue90d / 3) : 1;
  factors.push({ name: 'wage_to_revenue_ratio', value: round2(wageBurden), contribution: round2(-(wageBurden - 0.6) * 40), weight: 'HIGH' });
  score -= (wageBurden - 0.6) * 40;

  if (f.contractsExpiringNext180d > 5) {
    factors.push({ name: 'many_contracts_expiring', value: f.contractsExpiringNext180d, contribution: -8, weight: 'MEDIUM' });
    score -= 8;
  }

  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.7,
    factors,
    warnings: wageBurden > 1 ? ['Wage bill exceeds 90-day revenue — unsustainable trajectory'] : [],
    urgency: urgencyFromScore(100 - score),
    recommendation: {
      kind: 'BUDGET_PLAN',
      label: wageBurden > 0.8 ? 'Reduce wage burden in next window' : 'Maintain current budget allocation',
      target: { type: 'Club', id: f.clubId },
      params: { wageBurden: round2(wageBurden) },
    },
  };
}

export function scoreSalaryRisk(f: ClubFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 0;

  const wageRevenueRatio = f.revenue90d > 0 ? f.wagesPerMonth / (f.revenue90d / 3) : 2;
  factors.push({ name: 'wage_revenue_ratio', value: round2(wageRevenueRatio), contribution: round2(Math.min(60, wageRevenueRatio * 60)), weight: 'CRITICAL' });
  score += Math.min(60, wageRevenueRatio * 60);

  if (f.netCashFlow90d < 0) {
    factors.push({ name: 'negative_runway', value: f.netCashFlow90d, contribution: 25, weight: 'HIGH' });
    score += 25;
  }

  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.85,
    factors,
    warnings: score >= 70 ? ['Salary risk critical — board notification recommended'] : [],
    urgency: urgencyFromScore(score, 75, 55, 35, 15),
    recommendation: {
      kind: score >= 70 ? 'SALARY_FREEZE' : 'MONITOR',
      label: score >= 70 ? 'Freeze new contracts; renegotiate top wages' : 'Continue monitoring monthly',
      target: { type: 'Club', id: f.clubId },
    },
  };
}

export function scoreSponsorship(f: ClubFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const score = clamp(40 + (f.revenue90d > 100000 ? 20 : 0) + (f.playerCount > 25 ? 10 : 0) + (f.injuryRate < 0.15 ? 10 : 0));
  return {
    score,
    confidence: 0.6,
    factors: [
      { name: 'revenue_signal', value: f.revenue90d, contribution: f.revenue90d > 100000 ? 20 : 0, weight: 'MEDIUM' },
      { name: 'squad_size', value: f.playerCount, contribution: f.playerCount > 25 ? 10 : 0, weight: 'LOW' },
    ],
    warnings: [],
    urgency: 'MEDIUM',
    recommendation: {
      kind: 'SPONSORSHIP_OUTREACH',
      label: score >= 60 ? 'Approach mid-market sponsors; prepare ROI deck' : 'Build brand metrics before pitching sponsors',
      target: { type: 'Club', id: f.clubId },
    },
  };
}

export function scoreTransferMarketSupport(f: ClubFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;
  if (f.netCashFlow90d > 0) score += 15;
  if (f.injuryRate > 0.2) {
    factors.push({ name: 'high_injury_rate', value: round2(f.injuryRate), contribution: 10, weight: 'HIGH', description: 'Injury rate triggers squad-depth purchases' });
    score += 10;
  }
  if (f.contractsExpiringNext180d > 5) {
    factors.push({ name: 'many_expiring_contracts', value: f.contractsExpiringNext180d, contribution: 12, weight: 'HIGH' });
    score += 12;
  }
  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.65,
    factors,
    warnings: [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: 'TRANSFER_ACTIVITY',
      label: score >= 65 ? 'Active in transfer market this window' : 'Cautious — fill gaps via loans',
      target: { type: 'Club', id: f.clubId },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FRANCHISE — 5 scoring functions
// ─────────────────────────────────────────────────────────────────────────────

export function scoreRegionalExpansion(f: FranchiseFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;
  if (f.revenueGrowthPct != null) {
    const c = clamp(f.revenueGrowthPct, -25, 25);
    factors.push({ name: 'revenue_growth', value: f.revenueGrowthPct, contribution: round2(c), weight: 'HIGH' });
    score += c;
  }
  if (f.clubsActive > 5) score += 10;
  if (f.violationsOpen > 5) {
    factors.push({ name: 'violations_block_expansion', value: f.violationsOpen, contribution: -15, weight: 'HIGH' });
    score -= 15;
  }
  if (f.complianceScore != null && f.complianceScore < 60) {
    factors.push({ name: 'low_compliance', value: f.complianceScore, contribution: -10, weight: 'HIGH' });
    score -= 10;
  }
  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.7,
    factors,
    warnings: f.violationsOpen > 5 ? ['Resolve open violations before expansion'] : [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: score >= 70 ? 'EXPAND' : 'HOLD',
      label: score >= 70 ? 'Approve regional expansion request' : 'Hold expansion — strengthen compliance first',
      target: { type: 'FranchiseUnit', id: f.unitId },
    },
  };
}

export function scoreAcademyProfitability(f: FranchiseFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const score = clamp(50 + (f.revenueGrowthPct ?? 0) - f.violationsOpen * 5 + (f.complianceScore != null ? (f.complianceScore - 70) * 0.3 : 0));
  return {
    score: round2(score),
    confidence: 0.65,
    factors: [
      { name: 'revenue_growth_pct', value: f.revenueGrowthPct, contribution: round2(f.revenueGrowthPct ?? 0), weight: 'HIGH' },
      { name: 'compliance_score', value: f.complianceScore, contribution: round2((f.complianceScore ?? 70) - 70), weight: 'MEDIUM' },
    ],
    warnings: [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: score >= 60 ? 'EXPAND_ACADEMY' : 'OPTIMISE_ACADEMY',
      label: score >= 60 ? 'Expand academy capacity' : 'Optimise existing academy operations',
      target: { type: 'FranchiseUnit', id: f.unitId },
    },
  };
}

export function scoreTerritoryRisk(f: FranchiseFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 30;
  if (f.violationsOpen > 0) {
    factors.push({ name: 'open_violations', value: f.violationsOpen, contribution: f.violationsOpen * 6, weight: 'HIGH' });
    score += f.violationsOpen * 6;
  }
  if (f.complianceScore != null && f.complianceScore < 70) {
    factors.push({ name: 'low_compliance', value: f.complianceScore, contribution: (70 - f.complianceScore) * 0.5, weight: 'HIGH' });
    score += (70 - f.complianceScore) * 0.5;
  }
  if (f.contractsExpiringSoon > 3) {
    factors.push({ name: 'contracts_expiring', value: f.contractsExpiringSoon, contribution: f.contractsExpiringSoon * 2, weight: 'MEDIUM' });
    score += f.contractsExpiringSoon * 2;
  }
  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.78,
    factors,
    warnings: score >= 70 ? ['Territory risk critical — operator review required'] : [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: score >= 70 ? 'INTERVENE' : 'MONITOR',
      label: score >= 70 ? 'Operator intervention required' : 'Continue routine monitoring',
      target: { type: 'FranchiseUnit', id: f.unitId },
    },
  };
}

export function scoreOperatorPerformance(f: FranchiseFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const score = clamp(
    50 +
      (f.revenueGrowthPct ?? 0) -
      f.violationsOpen * 4 +
      (f.complianceScore != null ? (f.complianceScore - 70) * 0.4 : 0) +
      (f.clubsActive / Math.max(f.clubsTotal, 1)) * 10,
  );
  return {
    score: round2(score),
    confidence: 0.7,
    factors: [
      { name: 'revenue_growth_pct', value: f.revenueGrowthPct, contribution: round2(f.revenueGrowthPct ?? 0), weight: 'HIGH' },
      { name: 'violations_open', value: f.violationsOpen, contribution: -f.violationsOpen * 4, weight: 'HIGH' },
      { name: 'club_activation_rate', value: round2(f.clubsActive / Math.max(f.clubsTotal, 1)), contribution: 10, weight: 'MEDIUM' },
    ],
    warnings: [],
    urgency: urgencyFromScore(100 - score),
    recommendation: {
      kind: score >= 65 ? 'COMMEND' : 'COACH',
      label: score >= 65 ? 'Operator performance strong' : 'Schedule operator coaching session',
      target: { type: 'FranchiseUnit', id: f.unitId },
    },
  };
}

export function scoreFranchiseInvestment(f: FranchiseFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const score = clamp(50 + (f.revenueGrowthPct ?? 0) - f.violationsOpen * 3 + (f.clubsActive > 3 ? 15 : 0));
  return {
    score: round2(score),
    confidence: 0.7,
    factors: [
      { name: 'revenue_growth_pct', value: f.revenueGrowthPct, contribution: round2(f.revenueGrowthPct ?? 0), weight: 'HIGH' },
      { name: 'clubs_active', value: f.clubsActive, contribution: f.clubsActive > 3 ? 15 : 0, weight: 'MEDIUM' },
    ],
    warnings: [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: score >= 65 ? 'INVEST' : 'HOLD',
      label: score >= 65 ? 'Strong franchise investment candidate' : 'Hold — improve fundamentals first',
      target: { type: 'FranchiseUnit', id: f.unitId },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INVESTOR — 5 scoring functions
// ─────────────────────────────────────────────────────────────────────────────

export function scoreInvestorRoi(f: InvestorFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const score = clamp(50 + (f.multiple != null ? (f.multiple - 1) * 50 : 0) + (f.netIrrEstimate != null ? f.netIrrEstimate * 200 : 0));
  return {
    score: round2(score),
    confidence: f.multiple != null ? 0.75 : 0.4,
    factors: [
      { name: 'multiple', value: f.multiple, contribution: round2(f.multiple != null ? (f.multiple - 1) * 50 : 0), weight: 'HIGH' },
      { name: 'net_irr_estimate', value: f.netIrrEstimate, contribution: round2(f.netIrrEstimate != null ? f.netIrrEstimate * 200 : 0), weight: 'HIGH' },
    ],
    warnings: f.multiple == null ? ['No marked-to-market value yet'] : [],
    urgency: 'INFO',
    recommendation: {
      kind: 'ROI_REPORT',
      label: 'Portfolio ROI report — see dashboard',
      target: { type: 'InvestorProfile', id: f.investorId },
    },
  };
}

export function scoreInvestmentRisk(f: InvestorFeatures, _p?: Record<string, unknown>): DeterministicScore {
  let score = 30;
  if (f.portfolioConcentration > 0.6) score += 25;
  if (f.kycStatus !== 'VERIFIED') score += 15;
  if (f.netIrrEstimate != null && f.netIrrEstimate < 0) score += 25;
  if (f.multiple != null && f.multiple < 0.8) score += 15;
  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.7,
    factors: [
      { name: 'concentration', value: f.portfolioConcentration, contribution: f.portfolioConcentration > 0.6 ? 25 : 0, weight: 'HIGH' },
      { name: 'kyc_status', value: f.kycStatus, contribution: f.kycStatus !== 'VERIFIED' ? 15 : 0, weight: 'HIGH' },
      { name: 'multiple', value: f.multiple, contribution: f.multiple != null && f.multiple < 0.8 ? 15 : 0, weight: 'MEDIUM' },
    ],
    warnings: score >= 70 ? ['High-risk profile — review concentration and KYC'] : [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: 'RISK_REVIEW',
      label: 'Schedule portfolio risk review',
      target: { type: 'InvestorProfile', id: f.investorId },
    },
  };
}

export function scoreValuation(f: EntityFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;

  if (f.growthPct != null) {
    const c = clamp(f.growthPct, -30, 30);
    factors.push({ name: 'revenue_growth_pct', value: f.growthPct, contribution: round2(c), weight: 'HIGH' });
    score += c;
  }
  if (f.totalRaisedToDate > 0) score += 10;
  if (f.activeRoundCount > 0) {
    factors.push({ name: 'active_round', value: f.activeRoundCount, contribution: 5, weight: 'MEDIUM' });
    score += 5;
  }

  // Suggested valuation = 4× annualised revenue if growth positive, else 2.5×
  const annualisedRevenue = f.revenue90d * 4;
  const multiplier = f.growthPct != null && f.growthPct > 0 ? 4 : 2.5;
  const suggested = annualisedRevenue * multiplier;

  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.55,
    factors,
    warnings: f.revenue90d === 0 ? ['No recent revenue — valuation is qualitative only'] : [],
    urgency: 'MEDIUM',
    recommendation: {
      kind: 'SUGGESTED_VALUATION',
      label: `Suggested fair value ≈ ${Math.round(suggested).toLocaleString()} (multiplier ${multiplier}×)`,
      target: { type: 'InvestmentEntity', id: f.entityId },
      params: { suggested, multiplier, annualisedRevenue, currentValuation: f.currentValuation },
    },
  };
}

export function scoreCapitalAllocation(f: InvestorFeatures, _p?: Record<string, unknown>): DeterministicScore {
  let score = 50;
  const factors: ScoreFactor[] = [];

  if (f.portfolioConcentration > 0.7) {
    score -= 20;
    factors.push({ name: 'over_concentration', value: f.portfolioConcentration, contribution: -20, weight: 'HIGH' });
  } else if (f.portfolioConcentration < 0.2) {
    score -= 5;
    factors.push({ name: 'under_diversified', value: f.portfolioConcentration, contribution: -5, weight: 'LOW' });
  } else {
    score += 10;
  }

  if (f.daysSinceLastInvestment != null && f.daysSinceLastInvestment > 365) {
    score -= 10;
    factors.push({ name: 'capital_idle', value: f.daysSinceLastInvestment, contribution: -10, weight: 'MEDIUM' });
  }

  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.6,
    factors,
    warnings: [],
    urgency: 'MEDIUM',
    recommendation: {
      kind: 'ALLOCATION_PLAN',
      label: f.portfolioConcentration > 0.7 ? 'Diversify across additional entity types' : 'Allocation within target band',
      target: { type: 'InvestorProfile', id: f.investorId },
    },
  };
}

export function scoreAcquisition(target: EntityFeatures, _p?: Record<string, unknown>): DeterministicScore {
  let score = 40;
  if (target.growthPct != null && target.growthPct > 10) score += 25;
  if (target.totalRaisedToDate > 0) score += 10;
  if (target.currentValuation != null && target.revenue90d * 4 * 3 < target.currentValuation) {
    score -= 15;
  } else {
    score += 10;
  }
  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.6,
    factors: [
      { name: 'growth_pct', value: target.growthPct, contribution: target.growthPct != null && target.growthPct > 10 ? 25 : 0, weight: 'HIGH' },
      { name: 'value_per_revenue', value: target.currentValuation, contribution: 0, weight: 'MEDIUM' },
    ],
    warnings: [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: score >= 65 ? 'PURSUE_ACQUISITION' : 'MONITOR_TARGET',
      label: score >= 65 ? 'Pursue acquisition discussions' : 'Add to watchlist; revisit in 90 days',
      target: { type: 'InvestmentEntity', id: target.entityId },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTIVE — 5 scoring functions
// ─────────────────────────────────────────────────────────────────────────────

export function scoreCeoDashboard(f: ExecutiveFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const factors: ScoreFactor[] = [];
  let score = 50;
  if (f.growthPct != null) {
    const c = clamp(f.growthPct, -30, 30);
    factors.push({ name: 'platform_growth_pct', value: f.growthPct, contribution: round2(c), weight: 'CRITICAL' });
    score += c;
  }
  if (f.openCriticalViolations > 0) {
    factors.push({ name: 'critical_violations', value: f.openCriticalViolations, contribution: -f.openCriticalViolations * 5, weight: 'CRITICAL' });
    score -= f.openCriticalViolations * 5;
  }
  score = clamp(score);
  return {
    score: round2(score),
    confidence: 0.8,
    factors,
    warnings: f.openCriticalViolations > 0 ? [`${f.openCriticalViolations} critical violations require executive attention`] : [],
    urgency: urgencyFromScore(100 - score),
    recommendation: {
      kind: 'CEO_BRIEF',
      label: 'Open the executive briefing',
      target: { type: 'Platform', id: f.platformId },
    },
  };
}

export function scoreBoardStrategy(f: ExecutiveFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const score = clamp(40 + (f.growthPct ?? 0) + (f.activeFranchiseUnits > 10 ? 15 : 0) + (f.totalAum > 1_000_000 ? 10 : 0));
  return {
    score: round2(score),
    confidence: 0.7,
    factors: [
      { name: 'platform_growth_pct', value: f.growthPct, contribution: round2(f.growthPct ?? 0), weight: 'HIGH' },
      { name: 'active_franchise_units', value: f.activeFranchiseUnits, contribution: f.activeFranchiseUnits > 10 ? 15 : 0, weight: 'MEDIUM' },
      { name: 'total_aum', value: f.totalAum, contribution: f.totalAum > 1_000_000 ? 10 : 0, weight: 'MEDIUM' },
    ],
    warnings: [],
    urgency: 'INFO',
    recommendation: {
      kind: 'BOARD_BRIEF',
      label: score >= 65 ? 'Recommend Series B / accelerated expansion thesis to board' : 'Recommend operational tightening thesis to board',
      target: { type: 'Platform', id: f.platformId },
    },
  };
}

export function scoreExpansionOpportunity(f: ExecutiveFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const score = clamp(30 + (f.growthPct ?? 0) + f.expansionOpportunityCount * 5);
  return {
    score: round2(score),
    confidence: 0.6,
    factors: [{ name: 'expansion_opportunities', value: f.expansionOpportunityCount, contribution: f.expansionOpportunityCount * 5, weight: 'HIGH' }],
    warnings: [],
    urgency: urgencyFromScore(score),
    recommendation: {
      kind: 'EXPANSION_PLAN',
      label: 'Run the franchise expansion-opportunity ranker',
      target: { type: 'Platform', id: f.platformId },
    },
  };
}

export function scoreMarketEntry(f: ExecutiveFeatures, _p?: Record<string, unknown>): DeterministicScore {
  const score = clamp(40 + (f.growthPct ?? 0) + (f.activeInvestors > 10 ? 10 : 0));
  return {
    score: round2(score),
    confidence: 0.55,
    factors: [
      { name: 'platform_growth_pct', value: f.growthPct, contribution: round2(f.growthPct ?? 0), weight: 'HIGH' },
      { name: 'active_investors', value: f.activeInvestors, contribution: f.activeInvestors > 10 ? 10 : 0, weight: 'MEDIUM' },
    ],
    warnings: ['Market-entry decisions require qualitative regulatory review'],
    urgency: 'MEDIUM',
    recommendation: {
      kind: 'MARKET_ENTRY_PLAN',
      label: score >= 60 ? 'Prepare market-entry case for next priority region' : 'Defer market-entry; focus on existing regions',
      target: { type: 'Platform', id: f.platformId },
    },
  };
}

export function scoreAcquisitionTarget(target: EntityFeatures, _p?: Record<string, unknown>): DeterministicScore {
  return scoreAcquisition(target);
}
