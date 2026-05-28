// src/live-intelligence/live-intelligence.service.ts
// Phase 15 — Live Match Intelligence
//
// Single composite endpoint that aggregates all real match data into a
// structured intelligence bundle. No mock data. No invented metrics.
// Pure deterministic scoring from real DB columns.
//
// Data sources:
//   Match           — score, status, formation, possession, shots, liveMinute
//   MatchTimeline   — all non-deleted events (kinds, minute, side, pitchX/Y)
//   PlayerMatchStats— Phase Q rich stats: xg, xa, pressures, tackles, ratings
//   MatchLineup     — formations + position grid for tactical board
//   WorkloadRecord  — ACWR per player for fatigue index (weekStart-based)
//   buildMatchBrain — Phase F momentum, possession %, pressure zones (reused)

import { prisma }           from '../config/database';
import { buildMatchBrain }  from '../realtime/match-brain';
import { ForbiddenError, NotFoundError } from '../utils/errors';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TimelineSummary {
  totalEvents:    number;
  goals:          number;
  shotsOnTarget:  number;
  shots:          number;
  corners:        number;
  fouls:          number;
  yellowCards:    number;
  redCards:       number;
  byMinute:       Array<{ minute: number; kind: string; side: string }>;
}

export interface TacticalBoardData {
  formationHome:  string | null;
  formationAway:  string | null;
  positions:      Array<{
    playerId:      string | null;
    playerName:    string | null;
    jerseyNumber:  number | null;
    position:      string | null;
    x:             number;
    y:             number;
    isStarter:     boolean;
    side:          string;
    rating:        number | null;
  }>;
  possession:     number; // 0-100 our %
}

export interface CoachRecommendation {
  priority:    'HIGH' | 'MEDIUM' | 'LOW';
  area:        string;
  finding:     string;
  action:      string;
}

export interface PlayerRatingRow {
  playerId:         string;
  name:             string;
  position:         string | null;
  jerseyNumber:     number | null;
  minutesPlayed:    number;
  rating:           number;   // 1.0–10.0
  goals:            number;
  assists:          number;
  xg:               number;
  xa:               number;
  keyPasses:        number;
  tacklesWon:       number;
  pressures:        number;
  isRatingComputed: boolean; // true = fallback formula; false = stored ratingFamilista
}

export interface DominanceWindow {
  fromMin:   number;
  toMin:     number;
  homeScore: number;  // 0-100; 50 = level
  label:     string;
}

export interface FatigueRow {
  playerId:        string;
  name:            string;
  position:        string | null;
  minutesPlayed:   number;
  fatigueIndex:    number;   // 0-100
  pressureSuccess: number;   // 0-100 %
  acwr:            number | null;
  riskLevel:       'HIGH' | 'MEDIUM' | 'LOW';
}

export interface LiveIntelligenceBundle {
  matchId:              string;
  clubId:               string;
  status:               string;
  liveMinute:           number | null;
  score:                { home: number | null; away: number | null };
  homeTeam:             string;
  awayTeam:             string;
  formationHome:        string | null;
  formationAway:        string | null;
  computedAt:           string;
  timelineSummary:      TimelineSummary;
  momentum:             { index: number; windowSec: number; notes: string[] };
  possession:           { ourPct: number; windowSec: number };
  tacticalBoard:        TacticalBoardData;
  coachRecommendations: CoachRecommendation[];
  playerRatings:        PlayerRatingRow[];
  dominanceSeries:      DominanceWindow[];
  fatigueIndicators:    FatigueRow[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DOMINANCE_BIN_MIN = 5; // 5-minute windows

// Event weight map for dominance computation (our side = positive)
const DOMINANCE_WEIGHTS: Record<string, number> = {
  GOAL:             25,
  PENALTY_SCORED:   25,
  SHOT_ON_TARGET:    6,
  SHOT:              3,
  CORNER:            2,
  POSSESSION_TICK:   1,
  FOUL:             -1,  // negative always hurts our dominance
  YELLOW_CARD:      -3,
  RED_CARD:         -8,
};

// ── Pure exported functions (unit-testable, no DB) ─────────────────────────────

/**
 * Compute Familista player rating (1.0–10.0) from raw match stats.
 * Used as fallback when ratingFamilista is null.
 */
export function computePlayerRating(stats: {
  goals:           number;
  assists:         number;
  shotsOnTarget:   number;
  xa:              number;
  foulsCommitted:  number;
  yellowCards:     number;
  redCards:        number;
  tackles:         number;
  tacklesWon:      number;
  passes:          number;
  passAccuracy:    number;
  minutesPlayed:   number;
}): number {
  let r = 6.0;
  r += stats.goals   * 1.5;
  r += stats.assists * 1.0;
  r += stats.shotsOnTarget * 0.15;
  if (stats.xa > 0) r += stats.xa * 0.8;
  r -= stats.foulsCommitted * 0.1;
  r -= stats.yellowCards * 0.5;
  r -= stats.redCards * 2.0;
  if (stats.tackles > 0) r += (stats.tacklesWon / stats.tackles) * 0.5;
  if (stats.passes > 5)  r += ((stats.passAccuracy - 70) / 100);
  if (stats.minutesPlayed < 15) r = Math.min(r, 6.5);
  return Math.max(1.0, Math.min(10.0, Math.round(r * 10) / 10));
}

/**
 * Compute fatigue index (0–100) from minutes, pressure efficiency, and ACWR.
 */
export function computeFatigueIndex(
  minutesPlayed:       number,
  pressures:           number,
  pressuresSuccessful: number,
  acwr:                number | null,
): number {
  const base          = (minutesPlayed / 90) * 85;
  const pressureRate  = pressures > 0 ? pressuresSuccessful / pressures : 1;
  const pressureDrain = pressureRate < 0.4 ? 8 : 0;
  const acwrBonus     = acwr == null ? 0 : acwr > 1.5 ? 20 : acwr > 1.3 ? 12 : 0;
  return Math.min(100, Math.round(base + pressureDrain + acwrBonus));
}

/**
 * Build per-minute dominance bins from timeline events.
 * Returns one entry per DOMINANCE_BIN_MIN-minute block up to maxMinute.
 * homeScore 50 = even; >50 = home dominant; <50 = away dominant.
 */
export function buildDominanceSeries(
  events:    Array<{ occurredAtMin: number; kind: string; side: 'HOME' | 'AWAY' }>,
  maxMinute: number,
): DominanceWindow[] {
  if (maxMinute <= 0) return [];
  const bins = Math.ceil(maxMinute / DOMINANCE_BIN_MIN);
  const nets = new Array<number>(bins).fill(0);

  for (const e of events) {
    const bin    = Math.min(bins - 1, Math.floor(e.occurredAtMin / DOMINANCE_BIN_MIN));
    const weight = DOMINANCE_WEIGHTS[e.kind] ?? 0;
    if (weight === 0) continue;
    if (weight < 0) {
      nets[bin] += weight; // negative weights always hurt our (home) dominance
    } else {
      nets[bin] += e.side === 'HOME' ? weight : -weight;
    }
  }

  return nets.map((net, i) => {
    const fromMin   = i * DOMINANCE_BIN_MIN;
    const toMin     = fromMin + DOMINANCE_BIN_MIN;
    const homeScore = Math.max(0, Math.min(100, 50 + net * 2));
    return { fromMin, toMin, homeScore, label: `${fromMin}'–${toMin}'` };
  });
}

// ── Deterministic coach recommendations from match data ─────────────────────

function buildCoachRecommendations(
  ts:      TimelineSummary,
  mom:     { index: number; notes: string[] },
  ratings: PlayerRatingRow[],
  fatigue: FatigueRow[],
): CoachRecommendation[] {
  const recs: CoachRecommendation[] = [];

  if (mom.index < -0.3) {
    recs.push({
      priority: 'HIGH', area: 'Momentum',
      finding:  'Opposition holds significant momentum — index ' + mom.index.toFixed(2),
      action:   'Compact the midfield block. Switch to lower-block shape to reset the game.',
    });
  } else if (mom.index > 0.4) {
    recs.push({
      priority: 'MEDIUM', area: 'Momentum',
      finding:  'We hold positive momentum — index ' + mom.index.toFixed(2),
      action:   'Maintain high press and exploit wide channels before opposition adjusts.',
    });
  }

  if (ts.shotsOnTarget > 3 && ts.goals === 0) {
    recs.push({
      priority: 'HIGH', area: 'Attack',
      finding:  `${ts.shotsOnTarget} shots on target with no goal — conversion issue`,
      action:   'Adjust striker positioning. Target far-post runs and cut-backs from wide areas.',
    });
  }

  if (ts.yellowCards >= 2) {
    recs.push({
      priority: 'HIGH', area: 'Discipline',
      finding:  `${ts.yellowCards} yellow cards — team at risk of a red card`,
      action:   'Reduce aerial contest frequency. Track opponents without lunging.',
    });
  }

  if (ts.corners >= 4) {
    recs.push({
      priority: 'MEDIUM', area: 'Set Pieces',
      finding:  `${ts.corners} corners earned — set piece opportunity`,
      action:   'Deploy near-post flick routine. Rotate corner delivery to exploit defensive shape.',
    });
  }

  const highFatigue = fatigue.filter(r => r.riskLevel === 'HIGH');
  if (highFatigue.length > 0) {
    recs.push({
      priority: 'HIGH', area: 'Fitness',
      finding:  `${highFatigue.length} player(s) at high fatigue risk: ${highFatigue.map(r => r.name.split(' ').pop() ?? r.name).join(', ')}`,
      action:   'Consider substitution. Reduce high-intensity pressing duties for affected players.',
    });
  }

  const lowRated = ratings.filter(r => r.minutesPlayed >= 30 && r.rating < 5.5);
  if (lowRated.length > 0) {
    recs.push({
      priority: 'MEDIUM', area: 'Performance',
      finding:  `${lowRated.length} player(s) underperforming (rating <5.5): ${lowRated.map(r => r.name.split(' ').pop() ?? r.name).join(', ')}`,
      action:   'Positional adjustment or substitution. Target their zones with increased support runs.',
    });
  }

  if (recs.length === 0) {
    recs.push({
      priority: 'LOW', area: 'General',
      finding:  'No critical issues detected',
      action:   'Maintain current shape and intensity. Continue pressing high and recycling possession.',
    });
  }

  return recs.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return order[a.priority] - order[b.priority];
  });
}

// ── Main DB query + composition ────────────────────────────────────────────────

export async function getLiveIntelligence(
  matchId: string,
  clubId:  string,
): Promise<LiveIntelligenceBundle> {
  // ── 1. Match + lineups ─────────────────────────────────────────────────
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true, clubId: true, status: true, liveMinute: true,
      homeTeam: true, awayTeam: true, homeScore: true, awayScore: true,
      formationHome: true, formationAway: true, possession: true,
      lineups: { select: { side: true, formation: true, positions: true } },
    },
  });
  if (!match)              throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();

  // ── 2. Timeline events ─────────────────────────────────────────────────
  const rawTimeline = await prisma.matchTimeline.findMany({
    where:   { matchId, isDeleted: false },
    orderBy: { occurredAtMin: 'asc' },
    select:  { occurredAtMin: true, kind: true, side: true },
  });

  // ── 3. Phase Q PlayerMatchStats + player info ──────────────────────────
  const rawStats = await prisma.playerMatchStats.findMany({
    where: { matchId },
    include: {
      player: {
        select: {
          id: true, firstName: true, lastName: true,
          position: true, number: true,
        },
      },
    },
  });

  // Fallback: Phase B PlayerMatchStat if Phase Q empty
  const legacyStats = rawStats.length === 0
    ? await prisma.playerMatchStat.findMany({
        where: { matchId },
        include: {
          player: {
            select: { id: true, firstName: true, lastName: true, position: true, number: true },
          },
        },
      })
    : [];

  // ── 4. WorkloadRecord — ACWR via latest weekStart per player ──────────
  const playerIds = rawStats.length > 0
    ? rawStats.map(s => s.playerId)
    : legacyStats.map(s => s.playerId);

  const workloadMap = new Map<string, number>();
  if (playerIds.length > 0) {
    const workloads = await prisma.workloadRecord.findMany({
      where:   { playerId: { in: playerIds } },
      orderBy: { weekStart: 'desc' },
      select:  { playerId: true, acwr: true },
    });
    for (const w of workloads) {
      if (!workloadMap.has(w.playerId)) workloadMap.set(w.playerId, w.acwr);
    }
  }

  // ── 5. Match Brain (Phase F — reused) ─────────────────────────────────
  let brain: Awaited<ReturnType<typeof buildMatchBrain>> | null = null;
  try { brain = await buildMatchBrain(matchId, clubId); } catch (_) { /* graceful */ }

  // ── 6. Timeline summary ────────────────────────────────────────────────
  const kc = (k: string) => rawTimeline.filter(e => e.kind === k).length;
  const timelineSummary: TimelineSummary = {
    totalEvents:   rawTimeline.length,
    goals:         kc('GOAL') + kc('OWN_GOAL') + kc('PENALTY_SCORED'),
    shotsOnTarget: kc('SHOT_ON_TARGET'),
    shots:         kc('SHOT') + kc('SHOT_ON_TARGET') + kc('SHOT_OFF_TARGET'),
    corners:       kc('CORNER'),
    fouls:         kc('FOUL'),
    yellowCards:   kc('YELLOW_CARD') + kc('SECOND_YELLOW'),
    redCards:      kc('RED_CARD'),
    byMinute:      rawTimeline.map(e => ({ minute: e.occurredAtMin, kind: e.kind, side: e.side })),
  };

  // ── 7. Player ratings ──────────────────────────────────────────────────
  const playerRatings: PlayerRatingRow[] = [];

  if (rawStats.length > 0) {
    for (const s of rawStats) {
      const stored   = s.ratingFamilista;
      const computed = stored != null
        ? stored
        : computePlayerRating({
            goals: s.goals, assists: s.assists, shotsOnTarget: s.shotsOnTarget,
            xa: s.xa, foulsCommitted: s.foulsCommitted, yellowCards: s.yellowCards,
            redCards: s.redCards, tackles: s.tackles, tacklesWon: s.tacklesWon,
            passes: s.passes, passAccuracy: s.passAccuracy, minutesPlayed: s.minutesPlayed,
          });
      playerRatings.push({
        playerId:         s.playerId,
        name:             `${s.player.firstName} ${s.player.lastName}`.trim(),
        position:         String(s.player.position ?? ''),
        jerseyNumber:     s.player.number ?? null,
        minutesPlayed:    s.minutesPlayed,
        rating:           computed,
        goals:            s.goals,
        assists:          s.assists,
        xg:               Math.round(s.xg * 100) / 100,
        xa:               Math.round(s.xa * 100) / 100,
        keyPasses:        s.keyPasses,
        tacklesWon:       s.tacklesWon,
        pressures:        s.pressures,
        isRatingComputed: stored == null,
      });
    }
  } else {
    for (const s of legacyStats) {
      const computed = s.rating != null
        ? s.rating
        : computePlayerRating({
            goals: s.goals, assists: s.assists, shotsOnTarget: 0,
            xa: 0, foulsCommitted: 0, yellowCards: 0, redCards: 0,
            tackles: s.tackles, tacklesWon: 0, passes: s.passes,
            passAccuracy: s.passAccuracy, minutesPlayed: s.minutesPlayed,
          });
      playerRatings.push({
        playerId: s.playerId,
        name: `${s.player.firstName} ${s.player.lastName}`.trim(),
        position: String(s.player.position ?? ''),
        jerseyNumber: s.player.number ?? null,
        minutesPlayed: s.minutesPlayed,
        rating: computed,
        goals: s.goals, assists: s.assists, xg: 0, xa: 0,
        keyPasses: 0, tacklesWon: 0, pressures: 0,
        isRatingComputed: s.rating == null,
      });
    }
  }
  playerRatings.sort((a, b) => b.rating - a.rating);

  // ── 8. Dominance series ────────────────────────────────────────────────
  const maxMin = rawTimeline.length > 0
    ? Math.max(match.liveMinute ?? 0, rawTimeline[rawTimeline.length - 1]?.occurredAtMin ?? 0)
    : (match.liveMinute ?? 45);
  const dominanceSeries = buildDominanceSeries(
    rawTimeline.map(e => ({ occurredAtMin: e.occurredAtMin, kind: e.kind, side: e.side as 'HOME' | 'AWAY' })),
    Math.max(maxMin, 45),
  );

  // ── 9. Fatigue indicators ─────────────────────────────────────────────
  const fatigueIndicators: FatigueRow[] = [];
  if (rawStats.length > 0) {
    for (const s of rawStats) {
      const acwr        = workloadMap.get(s.playerId) ?? null;
      const fi          = computeFatigueIndex(s.minutesPlayed, s.pressures, s.pressuresSuccessful, acwr);
      const successPct  = s.pressures > 0
        ? Math.round((s.pressuresSuccessful / s.pressures) * 100)
        : 100;
      fatigueIndicators.push({
        playerId:        s.playerId,
        name:            `${s.player.firstName} ${s.player.lastName}`.trim(),
        position:        String(s.player.position ?? ''),
        minutesPlayed:   s.minutesPlayed,
        fatigueIndex:    fi,
        pressureSuccess: successPct,
        acwr,
        riskLevel:       fi >= 80 ? 'HIGH' : fi >= 60 ? 'MEDIUM' : 'LOW',
      });
    }
    fatigueIndicators.sort((a, b) => b.fatigueIndex - a.fatigueIndex);
  }

  // ── 10. Tactical board ────────────────────────────────────────────────
  const ratingById = new Map(playerRatings.map(r => [r.playerId, r.rating]));
  const boardPositions: TacticalBoardData['positions'] = [];
  for (const lineup of match.lineups) {
    const pos = Array.isArray(lineup.positions) ? lineup.positions as Array<Record<string, unknown>> : [];
    for (const p of pos) {
      boardPositions.push({
        playerId:    typeof p.playerId === 'string' ? p.playerId : null,
        playerName:  typeof p.name === 'string' ? p.name : null,
        jerseyNumber:typeof p.jerseyNumber === 'number' ? p.jerseyNumber : null,
        position:    typeof p.position === 'string' ? p.position : null,
        x:           typeof p.x === 'number' ? p.x : 50,
        y:           typeof p.y === 'number' ? p.y : 30,
        isStarter:   typeof p.isStarter === 'boolean' ? p.isStarter : true,
        side:        String(lineup.side),
        rating:      typeof p.playerId === 'string' ? (ratingById.get(p.playerId) ?? null) : null,
      });
    }
  }
  const tacticalBoard: TacticalBoardData = {
    formationHome: match.formationHome ?? (match.lineups.find(l => l.side === 'HOME')?.formation ?? null),
    formationAway: match.formationAway ?? (match.lineups.find(l => l.side === 'AWAY')?.formation ?? null),
    positions:     boardPositions,
    possession:    brain?.possession.ourPct ?? (match.possession ?? 50),
  };

  // ── 11. Momentum + possession (brain or match fallback) ───────────────
  const momentum   = brain?.momentum  ?? { index: 0, windowSec: 300, notes: [] as string[] };
  const possession = brain?.possession ?? { ourPct: match.possession ?? 50, windowSec: 300 };

  // ── 12. Coach recommendations ─────────────────────────────────────────
  const coachRecommendations = buildCoachRecommendations(
    timelineSummary, momentum, playerRatings, fatigueIndicators,
  );

  return {
    matchId:  match.id, clubId, status: match.status, liveMinute: match.liveMinute,
    score:    { home: match.homeScore, away: match.awayScore },
    homeTeam: match.homeTeam, awayTeam: match.awayTeam,
    formationHome: match.formationHome, formationAway: match.formationAway,
    computedAt:    new Date().toISOString(),
    timelineSummary, momentum, possession,
    tacticalBoard, coachRecommendations, playerRatings, dominanceSeries, fatigueIndicators,
  };
}
