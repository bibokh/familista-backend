// src/tactical/tactical-ai.service.ts
// Phase 13 — Tactical AI Engine + Match Intelligence
// Pure computation from real DB data. No mocks, no ML calls.
// All scores 0–100. Deterministic text from threshold bands.

import { prisma } from '../config/database';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FormationAnalysis {
  detectedFormation: string | null;
  width:             number;  // 0–100: spread of outfield player x coords on pitch
  compactness:       number;  // 0–100: 100 = very compact (narrow y-spread)
  leftBalance:       number;  // % of outfield players in left third  (x < 33)
  centerBalance:     number;  // % in center third  (33 ≤ x ≤ 66)
  rightBalance:      number;  // % in right third   (x > 66)
}

export interface TacticalScores {
  attackStructure:    number;  // xG efficiency + shot quality + progressive passes
  defensiveStructure: number;  // press success + defensive duels + possession retention
  transitionQuality:  number;  // progressive carries + carry-to-danger ratio + xA
  pressingEfficiency: number;  // pressures successful / pressures total
  tacticalDiscipline: number;  // aerial duels, fouls, card exposure
  overall:            number;  // weighted aggregate (0–100)
}

export type RecommendationType =
  | 'FORMATION'
  | 'PRESSING'
  | 'TRANSITION'
  | 'WIDTH'
  | 'DISCIPLINE'
  | 'WORKLOAD';

export type RecommendationPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface TacticalRecommendation {
  type:     RecommendationType;
  priority: RecommendationPriority;
  finding:  string;   // "Pressing efficiency below 40%"
  action:   string;   // "Increase press trigger line"
  drill?:   string;   // "Gegenpressing rondo 5v5+2"
}

export type DataQuality = 'RICH' | 'PARTIAL' | 'LIMITED';

export interface MatchTacticalAnalysis {
  matchId:         string;
  homeTeam:        string;
  awayTeam:        string;
  formation:       FormationAnalysis | null;
  scores:          TacticalScores;
  recommendations: TacticalRecommendation[];
  workloadFlags:   number;   // count of high-risk players (0 at match level; set at team level)
  dataQuality:     DataQuality;
}

export interface PlayerWorkloadRisk {
  playerId:   string;
  name:       string;
  acwr:       number;
  isHighRisk: boolean;
}

export interface TeamTacticalSummary {
  teamId:               string;
  matchesAnalyzed:      number;
  avgScores:            TacticalScores;
  formationTrend:       string[];  // most-used formations, ranked
  topRecommendations:   TacticalRecommendation[];
  playerWorkloadRisk:   PlayerWorkloadRisk[];
  recentMatches:        MatchTacticalAnalysis[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// ── Formation analysis ────────────────────────────────────────────────────────
// Reads MatchLineup.positions (Json) — expected shape:
//   [{ playerId?, name?, position?, x?: number, y?: number, isStarter?: boolean }, ...]

export function analyzeFormation(
  lineup: { formation: string | null; positions: unknown },
): FormationAnalysis | null {
  if (!lineup) return null;

  const raw = lineup.positions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      detectedFormation: lineup.formation,
      width: 0, compactness: 50,
      leftBalance: 33, centerBalance: 34, rightBalance: 33,
    };
  }

  type Pos = { x?: number; y?: number; position?: string; isStarter?: boolean };
  const outfield = (raw as Pos[]).filter(
    p => p.isStarter !== false && p.position !== 'GK'
      && typeof p.x === 'number' && typeof p.y === 'number',
  );

  if (outfield.length === 0) {
    return {
      detectedFormation: lineup.formation,
      width: 0, compactness: 50,
      leftBalance: 33, centerBalance: 34, rightBalance: 33,
    };
  }

  const xs = outfield.map(p => p.x as number);
  const ys = outfield.map(p => p.y as number);

  const width      = clamp((Math.max(...xs) - Math.min(...xs)));
  const ySpread    = Math.max(...ys) - Math.min(...ys);
  const compactness = clamp(100 - ySpread);

  const total  = outfield.length;
  const left   = outfield.filter(p => (p.x as number) < 33).length;
  const center = outfield.filter(p => (p.x as number) >= 33 && (p.x as number) <= 66).length;
  const right  = outfield.filter(p => (p.x as number) > 66).length;

  return {
    detectedFormation: lineup.formation,
    width,
    compactness,
    leftBalance:   Math.round((left   / total) * 100),
    centerBalance: Math.round((center / total) * 100),
    rightBalance:  Math.round((right  / total) * 100),
  };
}

// ── Score computations (exported for unit tests) ──────────────────────────────

export function computeAttackStructure(params: {
  shotsOnTarget:        number;
  shots:                number;
  avgXg:                number;  // mean xG per player this match
  avgProgressivePasses: number;  // mean progressive passes per player
}): number {
  const { shotsOnTarget, shots, avgXg, avgProgressivePasses } = params;
  const shotAcc = shots > 0 ? shotsOnTarget / shots : 0;
  const shotComp = shotAcc * 40;                        // 0–40
  const xgComp   = Math.min(avgXg / 0.5,  1) * 30;     // 0–30 (0.5 xG/player = full)
  const ppComp   = Math.min(avgProgressivePasses / 5, 1) * 30; // 0–30 (5 pp/player = full)
  return clamp(shotComp + xgComp + ppComp);
}

export function computeDefensiveStructure(params: {
  avgPressures:       number;
  avgPressureSuccess: number;
  avgTacklesWon:      number;
  avgClearances:      number;
  possessionConceded: number;   // 100 - own possession
}): number {
  const { avgPressures, avgPressureSuccess, avgTacklesWon, avgClearances, possessionConceded } = params;
  const pressVol    = Math.min(avgPressures / 10, 1) * 25;  // 0–25 (10 press/player = full)
  const defActions  = Math.min((avgTacklesWon + avgClearances) / 5, 1) * 25; // 0–25
  const posScore    = 50 - Math.min(possessionConceded / 100, 1) * 50;       // 0–50
  const successRate = avgPressures > 0 ? avgPressureSuccess / avgPressures : 0;
  const multiplier  = 0.8 + successRate * 0.4;  // 0.8–1.2
  return clamp((pressVol + defActions + posScore) * multiplier);
}

export function computeTransitionQuality(params: {
  avgCarries:            number;
  avgProgressiveCarries: number;
  avgXa:                 number;  // mean xA per player (chance-creation from carries)
}): number {
  const { avgCarries, avgProgressiveCarries, avgXa } = params;
  const progRate = avgCarries > 0 ? avgProgressiveCarries / avgCarries : 0;
  const progComp = Math.min(progRate / 0.5, 1) * 40;   // 0–40 (50% progressive = full)
  const volComp  = Math.min(avgCarries / 5,  1) * 30;  // 0–30 (5 carries/player = full)
  const xaComp   = Math.min(avgXa    / 0.3,  1) * 30;  // 0–30 (0.3 xA/player = full)
  return clamp(progComp + volComp + xaComp);
}

export function computePressingEfficiency(params: {
  totalPressures:       number;
  totalPressSuccessful: number;
}): number {
  const { totalPressures, totalPressSuccessful } = params;
  if (totalPressures === 0) return 40;  // neutral when no data
  // 0.67 success rate = 100; 0.4 = 60; 0.2 = 30
  return clamp((totalPressSuccessful / totalPressures) * 150);
}

export function computeTacticalDiscipline(params: {
  avgFoulsCommitted: number;
  avgYellowCards:    number;
  avgRedCards:       number;
  avgAerialDuelsWon: number;
  avgAerialDuels:    number;
}): number {
  const { avgFoulsCommitted, avgYellowCards, avgRedCards, avgAerialDuelsWon, avgAerialDuels } = params;
  const foulPenalty = Math.min(avgFoulsCommitted / 3,         1) * 30;  // 0–30
  const cardPenalty = Math.min((avgYellowCards + avgRedCards * 3) / 0.2, 1) * 20;  // 0–20
  const aerialRate  = avgAerialDuels > 0 ? avgAerialDuelsWon / avgAerialDuels : 0.5;
  const aerialComp  = aerialRate * 50;  // 0–50
  return clamp(aerialComp + (50 - foulPenalty - cardPenalty));
}

export function computeOverallScore(scores: Omit<TacticalScores, 'overall'>): number {
  return clamp(
    scores.attackStructure    * 0.25 +
    scores.defensiveStructure * 0.25 +
    scores.transitionQuality  * 0.20 +
    scores.pressingEfficiency * 0.15 +
    scores.tacticalDiscipline * 0.15,
  );
}

// ── Recommendation engine ─────────────────────────────────────────────────────

export function generateRecommendations(
  scores:        TacticalScores,
  formation:     FormationAnalysis | null,
  workloadFlags: number,
): TacticalRecommendation[] {
  const recs: TacticalRecommendation[] = [];

  // ── Pressing ──────────────────────────────────────────────────────────────
  if (scores.pressingEfficiency < 40) {
    recs.push({
      type: 'PRESSING', priority: 'HIGH',
      finding: `Press success rate critically low (score: ${scores.pressingEfficiency}/100)`,
      action:  'Lower block and reduce press triggers — re-establish shape before pressing higher',
      drill:   'Shadow-pressing shape work — 6v6 zonal press patterns',
    });
  } else if (scores.pressingEfficiency < 60) {
    recs.push({
      type: 'PRESSING', priority: 'MEDIUM',
      finding: `Pressing efficiency below optimal (score: ${scores.pressingEfficiency}/100)`,
      action:  'Sharpen press triggers — focus on back-pass and GK distribution scenarios',
      drill:   'Gegenpressing rondo 5v5+2 — immediate pressure on loss of possession',
    });
  }

  // ── Attack structure ──────────────────────────────────────────────────────
  if (scores.attackStructure < 40) {
    recs.push({
      type: 'FORMATION', priority: 'HIGH',
      finding: `Attack structure weak — low xG conversion and shot quality (score: ${scores.attackStructure}/100)`,
      action:  'Increase progressive passing lanes and final-third entries per possession cycle',
      drill:   'Positional play pattern — 8v5 build-out with progressive-pass trigger',
    });
  } else if (scores.attackStructure < 60) {
    recs.push({
      type: 'FORMATION', priority: 'MEDIUM',
      finding: `Attack structure developing — shots created but xG below target`,
      action:  'Improve shot selection quality and increase penalty-box entries per attack',
      drill:   'Finishing circuit — crossing + cutback combinations (3-station rotation)',
    });
  }

  // ── Transition quality ────────────────────────────────────────────────────
  if (scores.transitionQuality < 45) {
    recs.push({
      type: 'TRANSITION', priority: 'HIGH',
      finding: `Transition quality low — progressive carry rate insufficient (score: ${scores.transitionQuality}/100)`,
      action:  'Drill vertical ball-carrying and counter-attack decision sequences',
      drill:   'Counter-attack simulation — 4v3 with designated ball-carrier channels',
    });
  } else if (scores.transitionQuality < 65) {
    recs.push({
      type: 'TRANSITION', priority: 'MEDIUM',
      finding: `Transition speed moderate — progressive carry-to-chance conversion needs improvement`,
      action:  'Focus on ball-carrier decisions in the half-space — third-man runs',
      drill:   'Half-space transition drill — 3v2 progression into final-third entry',
    });
  }

  // ── Width balance ─────────────────────────────────────────────────────────
  if (formation) {
    const imbalance = Math.abs(formation.leftBalance - formation.rightBalance);
    if (imbalance > 25) {
      const overloaded  = formation.leftBalance > formation.rightBalance ? 'left' : 'right';
      const underloaded = overloaded === 'left' ? 'right' : 'left';
      recs.push({
        type: 'WIDTH', priority: 'MEDIUM',
        finding: `${overloaded.charAt(0).toUpperCase() + overloaded.slice(1)} side overloaded — ${imbalance}% width imbalance in player distribution`,
        action:  `Redistribute attacking shape — increase ${underloaded} fullback overlap and ${underloaded} winger inside runs`,
        drill:   'Wide overload patterns — 3v2 overlap drill in underused wide channels',
      });
    }

    if (formation.compactness < 40) {
      recs.push({
        type: 'FORMATION', priority: 'MEDIUM',
        finding: `Defensive shape too stretched — compactness score ${formation.compactness}/100`,
        action:  'Tighten defensive block width and enforce press-trigger distances between lines',
        drill:   'Compact mid-block shape — 4-4-2 defensive structure walk-through + live rondo',
      });
    }
  }

  // ── Discipline ────────────────────────────────────────────────────────────
  if (scores.tacticalDiscipline < 50) {
    recs.push({
      type: 'DISCIPLINE',
      priority: scores.tacticalDiscipline < 35 ? 'HIGH' : 'MEDIUM',
      finding: `Tactical discipline concerns — foul rate and card exposure elevated (score: ${scores.tacticalDiscipline}/100)`,
      action:  'Review aerial duel positioning and challenge technique to reduce unnecessary fouls',
      drill:   'Aerial duel technique — guided heading + footwork positioning circuits',
    });
  }

  // ── Workload risk ─────────────────────────────────────────────────────────
  if (workloadFlags > 0) {
    recs.push({
      type: 'WORKLOAD',
      priority: workloadFlags > 3 ? 'HIGH' : 'MEDIUM',
      finding: `${workloadFlags} player${workloadFlags > 1 ? 's' : ''} in high ACWR risk zone — injury exposure elevated`,
      action:  'Rotate high-risk players from XI or reduce training volume before next fixture',
      drill:   'Recovery session — pool work + mobility + 15-min light technical ball-work only',
    });
  }

  // Sort HIGH → MEDIUM → LOW
  const order: Record<RecommendationPriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return recs.sort((a, b) => order[a.priority] - order[b.priority]);
}

// ── Match-level tactical analysis ─────────────────────────────────────────────

export async function analyzeMatch(matchId: string, clubId: string): Promise<MatchTacticalAnalysis> {
  const match = await prisma.match.findFirst({
    where:  { id: matchId, clubId },
    select: {
      id:            true,
      homeTeam:      true,
      awayTeam:      true,
      possession:    true,
      shots:         true,
      shotsOnTarget: true,
      lineups: {
        select: { side: true, formation: true, positions: true },
      },
      playerMatchStats: {
        select: {
          xg:                  true,
          xa:                  true,
          pressures:           true,
          pressuresSuccessful: true,
          progressivePasses:   true,
          carries:             true,
          progressiveCarries:  true,
          tacklesWon:          true,
          clearances:          true,
          foulsCommitted:      true,
          yellowCards:         true,
          redCards:            true,
          aerialDuels:         true,
          aerialDuelsWon:      true,
        },
      },
    },
  });

  if (!match) {
    const err = Object.assign(new Error('Match not found'), { status: 404 });
    throw err;
  }

  const stats = match.playerMatchStats;
  const n     = stats.length || 1;
  const avg   = <K extends keyof typeof stats[0]>(key: K): number =>
    stats.reduce((s, r) => s + (Number(r[key]) || 0), 0) / n;

  // Formation: use HOME side (the club's lineup)
  const homeLineup = match.lineups.find(l => l.side === 'HOME');
  const formation  = homeLineup ? analyzeFormation(homeLineup) : null;

  const possession = match.possession ?? 50;

  const attackStructure    = computeAttackStructure({
    shotsOnTarget:        match.shotsOnTarget ?? 0,
    shots:                match.shots ?? 0,
    avgXg:                avg('xg'),
    avgProgressivePasses: avg('progressivePasses'),
  });
  const defensiveStructure = computeDefensiveStructure({
    avgPressures:       avg('pressures'),
    avgPressureSuccess: avg('pressuresSuccessful'),
    avgTacklesWon:      avg('tacklesWon'),
    avgClearances:      avg('clearances'),
    possessionConceded: 100 - possession,
  });
  const transitionQuality  = computeTransitionQuality({
    avgCarries:            avg('carries'),
    avgProgressiveCarries: avg('progressiveCarries'),
    avgXa:                 avg('xa'),
  });
  const pressingEfficiency = computePressingEfficiency({
    totalPressures:       stats.reduce((s, r) => s + r.pressures, 0),
    totalPressSuccessful: stats.reduce((s, r) => s + r.pressuresSuccessful, 0),
  });
  const tacticalDiscipline = computeTacticalDiscipline({
    avgFoulsCommitted: avg('foulsCommitted'),
    avgYellowCards:    avg('yellowCards'),
    avgRedCards:       avg('redCards'),
    avgAerialDuelsWon: avg('aerialDuelsWon'),
    avgAerialDuels:    avg('aerialDuels'),
  });

  const partial: Omit<TacticalScores, 'overall'> = {
    attackStructure, defensiveStructure, transitionQuality, pressingEfficiency, tacticalDiscipline,
  };
  const scores: TacticalScores = { ...partial, overall: computeOverallScore(partial) };

  const dataQuality: DataQuality =
    stats.length >= 8 && (match.shots ?? 0) > 0 ? 'RICH'    :
    stats.length >= 3                            ? 'PARTIAL' : 'LIMITED';

  const recommendations = generateRecommendations(scores, formation, 0);

  return {
    matchId:  match.id,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    formation,
    scores,
    recommendations,
    workloadFlags: 0,
    dataQuality,
  };
}

// ── Team-level tactical summary (last N matches) ──────────────────────────────

export async function analyzeTeam(
  teamId:     string,
  clubId:     string,
  matchLimit  = 5,
): Promise<TeamTacticalSummary> {
  const matches = await prisma.match.findMany({
    where:   { teamId, clubId, status: { in: ['FT', 'LIVE'] } },
    orderBy: { scheduledAt: 'desc' },
    take:    matchLimit,
    select:  { id: true },
  });

  const analyses = await Promise.all(
    matches.map(m => analyzeMatch(m.id, clubId).catch(() => null)),
  );
  const valid = analyses.filter((a): a is MatchTacticalAnalysis => a !== null);

  // Average score fields
  const avgField = (field: keyof TacticalScores): number => {
    if (valid.length === 0) return 50;
    return clamp(valid.reduce((s, a) => s + a.scores[field], 0) / valid.length);
  };
  const avgScores: TacticalScores = {
    attackStructure:    avgField('attackStructure'),
    defensiveStructure: avgField('defensiveStructure'),
    transitionQuality:  avgField('transitionQuality'),
    pressingEfficiency: avgField('pressingEfficiency'),
    tacticalDiscipline: avgField('tacticalDiscipline'),
    overall:            avgField('overall'),
  };

  // Formation trend
  const formationCounts: Record<string, number> = {};
  for (const a of valid) {
    const f = a.formation?.detectedFormation;
    if (f) formationCounts[f] = (formationCounts[f] ?? 0) + 1;
  }
  const formationTrend = Object.entries(formationCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);

  // Deduplicated recommendations across matches (highest priority wins per type)
  const recMap = new Map<RecommendationType, TacticalRecommendation>();
  const order: Record<RecommendationPriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  for (const a of valid) {
    for (const r of a.recommendations) {
      const existing = recMap.get(r.type);
      if (!existing || order[r.priority] < order[existing.priority]) {
        recMap.set(r.type, r);
      }
    }
  }
  const topRecommendations = [...recMap.values()]
    .sort((a, b) => order[a.priority] - order[b.priority])
    .slice(0, 6);

  // Workload risk players (last 7 days, scoped to this club)
  const oneWeekAgo = new Date(Date.now() - 7 * 86_400_000);
  const workloadRecs = await prisma.workloadRecord.findMany({
    where:   { clubId, isHighRisk: true, weekStart: { gte: oneWeekAgo } },
    orderBy: { acwr: 'desc' },
    take:    10,
    select: {
      playerId: true,
      acwr:     true,
      player:   { select: { firstName: true, lastName: true, teamId: true } },
    },
  });
  const playerWorkloadRisk: PlayerWorkloadRisk[] = workloadRecs
    .filter(r => !teamId || r.player.teamId === teamId)
    .map(r => ({
      playerId:   r.playerId,
      name:       `${r.player.firstName} ${r.player.lastName}`,
      acwr:       Math.round(r.acwr * 100) / 100,
      isHighRisk: true,
    }));

  // Attach workload flag count to each match analysis
  const workloadFlags = playerWorkloadRisk.length;
  const recentMatches = valid.map(a => ({ ...a, workloadFlags }));

  return {
    teamId,
    matchesAnalyzed: valid.length,
    avgScores,
    formationTrend,
    topRecommendations,
    playerWorkloadRisk,
    recentMatches,
  };
}
