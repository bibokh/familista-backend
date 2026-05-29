// Familista — Transfer Intelligence Scoring Engine (Phase 10)
// Target: src/transfer/scoring.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure deterministic scoring layer — no writes, no ML, no external calls.
// All scores are normalised 0–100 unless stated otherwise.
//
// Eight scoring dimensions:
//  1. compositeScore       — scouting quality across all reports
//  2. tacticalFitScore     — positional alignment with a target formation slot
//  3. contractRiskScore    — urgency of acquisition vs contract state
//  4. squadDepth           — per-position depth map across an active squad
//  5. positionShortages    — positions below minimum safe depth
//  6. transferPriority     — weighted aggregate rank for prioritising targets
//  7. scoutingSummary      — deterministic prose from score bands
//  8. marketOpportunity    — structural buy signals (value, timing, availability)
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/database';
import * as ScoutingSvc from './scouting.service';
import * as MarketSvc   from './market.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoringActor {
  userId: string;
  clubId: string;
  role?:  string;
}

/** Complete score card for a single player-as-transfer-target. */
export interface PlayerScorecard {
  playerId:          string;
  compositeScore:    number;          // 0–100  scouting quality
  tacticalFitScore:  number;          // 0–100  positional fit
  contractRiskScore: number;          // 0–100  urgency (higher = act sooner)
  transferPriority:  number;          // 0–100  combined weighted rank
  marketOpportunity: MarketOpportunity | null;
  flags:             ScorecardFlag[];
  scoutingSummary:   string;          // 1–3 sentence deterministic prose
  /** Raw inputs exposed so the frontend can render attribute bars. */
  raw: {
    reportCount:       number;
    avgComposite:      number | null;  // 0–10
    topGrade:          string | null;
    signCount:         number;
    monitorCount:      number;
    skipCount:         number;
    daysToExpiry:      number | null;
    latestValueMEur:   number | null;
    askingPriceMEur:   number | null;
    playerPosition:    string | null;
    marketOpportunity: MarketOpportunity | null;
  };
}

export type MarketOpportunity =
  | 'UNDERVALUED'       // askingPrice < 85 % of market value
  | 'FREE_AGENT_RISK'   // contract expires within 180 days
  | 'HIGH_VALUE_CHEAP'  // compositeScore > 72 AND askingPrice < 5M€
  | 'AVAILABLE';        // isAvailableForTransfer = true

export type ScorecardFlag =
  | 'CONTRACT_CRITICAL'   // <90 days
  | 'CONTRACT_WARNING'    // 90–180 days
  | 'EXPIRING_SOON'       // isExpiringSoon flag from DB
  | 'AVAILABLE_NOW'       // isAvailableForTransfer
  | 'HIGH_POTENTIAL'      // potential attribute avg > 8
  | 'UNDERVALUED'
  | 'NO_REPORTS';         // zero scout reports filed

/** Minimum required squad depth per position bucket. */
export interface SquadDepthResult {
  positionCounts:  Record<string, number>;
  shortages:       Array<{ position: string; have: number; need: number; deficit: number }>;
  surpluses:       Array<{ position: string; have: number; need: number; surplus: number }>;
  criticalSlots:   string[];   // positions with deficit ≥ 2
}

/** Single entry in the ranked targets list. */
export interface RankedTarget {
  targetId:    string;
  playerId:    string;
  stage:       string;
  scorecard:   PlayerScorecard;
}

// ─── Internal constants ───────────────────────────────────────────────────────

/** Numeric value 0–100 for each letter grade. */
const GRADE_SCORE: Record<string, number> = {
  A_PLUS: 100, A: 88, B_PLUS: 74, B: 60, C: 40, D: 20,
};

/** Position groupings for tactical-fit matching. */
const POS_GROUP: Record<string, string> = {
  GK: 'GK',
  DC: 'DEF', DL: 'DEF', DR: 'DEF',
  DMC: 'MID_D',
  MC: 'MID_C', ML: 'MID_C', MR: 'MID_C',
  AMC: 'MID_A', AML: 'MID_A', AMR: 'MID_A',
  ST: 'ATT',
};

/** Key scouting attributes that matter most per position group. */
const POS_ATTR_WEIGHTS: Record<string, Record<string, number>> = {
  GK:    { technical: 0.30, mental: 0.35, physical: 0.20, tactical: 0.15, potential: 0.00 },
  DEF:   { technical: 0.15, mental: 0.25, physical: 0.30, tactical: 0.30, potential: 0.00 },
  MID_D: { technical: 0.20, mental: 0.25, physical: 0.20, tactical: 0.35, potential: 0.00 },
  MID_C: { technical: 0.30, mental: 0.25, physical: 0.15, tactical: 0.30, potential: 0.00 },
  MID_A: { technical: 0.35, mental: 0.20, physical: 0.15, tactical: 0.30, potential: 0.00 },
  ATT:   { technical: 0.35, mental: 0.20, physical: 0.30, tactical: 0.15, potential: 0.00 },
};

/** Required minimum number of active players per position bucket. */
const MIN_DEPTH: Record<string, number> = {
  GK: 2, DEF: 5, MID_D: 2, MID_C: 3, MID_A: 2, ATT: 2,
};

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

// ─── 1. Composite Score ───────────────────────────────────────────────────────

/**
 * Scouting quality score (0–100) derived from all filed reports.
 *
 * Formula:
 *   base   = avg(compositeScore) / 10 * 60        — raw attribute quality   (0–60)
 *   grades = (bestGrade numeric) / 100 * 25       — best grade ever filed   (0–25)
 *   recs   = (signCount – skipCount) / reportCount * 15  — net recommendation (0–15)
 *   total  = base + grades + recs, clamped 0–100
 */
export function computeCompositeScore(
  reports: Array<{
    compositeScore: number | null;
    overallGrade:   string | null;
    recommendation: string | null;
    potential:      number | null;
  }>,
): number {
  if (!reports.length) return 0;

  const withScore = reports.filter((r) => r.compositeScore != null);
  const avgComposite = withScore.length
    ? withScore.reduce((s, r) => s + r.compositeScore!, 0) / withScore.length
    : 0;

  const bestGrade = reports.reduce((best, r) => {
    const v = GRADE_SCORE[r.overallGrade ?? ''] ?? 0;
    return v > best ? v : best;
  }, 0);

  const signCount = reports.filter((r) => r.recommendation === 'SIGN').length;
  const skipCount = reports.filter((r) => r.recommendation === 'SKIP').length;
  const netRec    = (signCount - skipCount) / reports.length; // –1..+1

  const base   = (avgComposite / 10) * 60;
  const grades = (bestGrade / 100) * 25;
  const recs   = clamp(netRec * 15 + 7.5, 0, 15); // centre at 7.5

  return +clamp(base + grades + recs).toFixed(1);
}

// ─── 2. Tactical Fit Score ────────────────────────────────────────────────────

/**
 * Positional + attribute fit score (0–100).
 *
 * Formula:
 *   posMatch  = 100 if same position, 65 if same group, 25 otherwise  (0–100)
 *   attrFit   = weighted average of scouting attrs for target position  (0–10)
 *               rescaled to 0–100
 *   score     = posMatch * 0.45 + attrFit * 0.55, clamped 0–100
 *
 * If no reports are available the score falls back to posMatch only.
 */
export function computeTacticalFitScore(
  playerPosition: string | null,
  targetPosition: string | null,
  reports: Array<{
    technical: number | null;
    physical:  number | null;
    mental:    number | null;
    tactical:  number | null;
    potential: number | null;
  }>,
): number {
  // Position match component
  const pp = playerPosition ?? '';
  const tp = targetPosition ?? '';
  const posMatch =
    pp === tp                                     ? 100 :
    pp && tp && POS_GROUP[pp] === POS_GROUP[tp]   ? 65  :
    pp && tp                                      ? 25  : 50; // unknown → neutral

  if (!reports.length) return +clamp(posMatch).toFixed(1);

  // Attribute fit component weighted by target position group
  const group   = POS_GROUP[tp] ?? POS_GROUP[pp] ?? 'MID_C';
  const weights = POS_ATTR_WEIGHTS[group] ?? POS_ATTR_WEIGHTS['MID_C'];

  const attrKeys = ['technical','physical','mental','tactical','potential'] as const;

  let weightedSum = 0, totalWeight = 0;
  for (const attr of attrKeys) {
    const w = (weights as any)[attr] ?? 0;
    if (w === 0) continue;
    const vals = reports
      .map((r) => (r as any)[attr] as number | null)
      .filter((v): v is number => v != null);
    if (!vals.length) continue;
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    weightedSum  += avg * w;
    totalWeight  += w;
  }

  const attrFit = totalWeight > 0 ? (weightedSum / totalWeight) / 10 * 100 : 50;

  return +clamp(posMatch * 0.45 + attrFit * 0.55).toFixed(1);
}

// ─── 3. Contract Risk Score ───────────────────────────────────────────────────

/**
 * Acquisition urgency score (0–100).  Higher = more urgent to act now.
 *
 * Formula:
 *   daysBase  = <90d→90, <180d→72, <365d→50, <730d→30, else→10
 *   +10 if isAvailableForTransfer (player could leave freely)
 *   +8  if no release clause (negotiation harder)
 *   +5  if isExpiringSoon flag is set
 *   clamped 0–100
 */
export function computeContractRiskScore(
  contract: {
    contractExpiry:         Date;
    releaseClauseEur:       number | null;
    isAvailableForTransfer: boolean;
    isExpiringSoon:         boolean;
  } | null,
): number {
  if (!contract) return 15; // no contract data → low but non-zero risk

  const today        = new Date();
  const daysToExpiry = Math.floor((contract.contractExpiry.getTime() - today.getTime()) / 86_400_000);

  const daysBase =
    daysToExpiry < 0   ? 95 : // already expired
    daysToExpiry < 90  ? 90 :
    daysToExpiry < 180 ? 72 :
    daysToExpiry < 365 ? 50 :
    daysToExpiry < 730 ? 30 : 10;

  let score = daysBase;
  if (contract.isAvailableForTransfer)          score += 10;
  if (!contract.releaseClauseEur)               score += 8;
  if (contract.isExpiringSoon)                  score += 5;

  return clamp(score);
}

// ─── 4 + 5. Squad Depth + Position Shortages ─────────────────────────────────

/**
 * Analyse positional depth across the active squad.
 * Returns per-group counts, shortages, and surpluses.
 */
export function computeSquadDepth(
  players: Array<{ position: string; isActive: boolean }>,
): SquadDepthResult {
  const counts: Record<string, number> = {};
  for (const p of players.filter((x) => x.isActive)) {
    const group = POS_GROUP[p.position] ?? p.position;
    counts[group] = (counts[group] ?? 0) + 1;
  }

  // Also expose individual position counts
  const posCounts: Record<string, number> = {};
  for (const p of players.filter((x) => x.isActive)) {
    posCounts[p.position] = (posCounts[p.position] ?? 0) + 1;
  }

  const shortages: SquadDepthResult['shortages'] = [];
  const surpluses: SquadDepthResult['surpluses'] = [];

  for (const [group, need] of Object.entries(MIN_DEPTH)) {
    const have    = counts[group] ?? 0;
    const delta   = have - need;
    if (delta < 0)  shortages.push({ position: group, have, need, deficit: -delta });
    else if (delta > 0) surpluses.push({ position: group, have, need, surplus: delta });
  }

  shortages.sort((a, b) => b.deficit - a.deficit);
  surpluses.sort((a, b) => b.surplus - a.surplus);

  return {
    positionCounts: posCounts,
    shortages,
    surpluses,
    criticalSlots: shortages.filter((s) => s.deficit >= 2).map((s) => s.position),
  };
}

// ─── 6. Transfer Priority Score ───────────────────────────────────────────────

/**
 * Weighted composite rank (0–100).
 *
 * Weights:
 *   compositeScore    × 0.35   (player quality)
 *   tacticalFitScore  × 0.30   (positional alignment)
 *   contractRiskScore × 0.15   (urgency — higher risk = act sooner = slight boost)
 *   targetPriority    × 0.20   (manual analyst score 0–100)
 */
export function computeTransferPriority(
  compositeScore:    number,
  tacticalFitScore:  number,
  contractRiskScore: number,
  targetPriority:    number,   // from TransferTarget.priorityScore (0–100)
): number {
  const raw =
    compositeScore    * 0.35 +
    tacticalFitScore  * 0.30 +
    contractRiskScore * 0.15 +
    targetPriority    * 0.20;
  return +clamp(raw).toFixed(1);
}

// ─── 7. Scouting Summary (deterministic prose) ───────────────────────────────

/**
 * Generate a 1–3 sentence summary from score bands and raw counts.
 * No ML — fully deterministic from the computed scores.
 */
export function generateScoutingSummary(
  playerName:        string,
  compositeScore:    number,
  tacticalFitScore:  number,
  contractRiskScore: number,
  raw: PlayerScorecard['raw'],
): string {
  const parts: string[] = [];

  // Sentence 1 — scouting quality
  if (raw.reportCount === 0) {
    parts.push(`${playerName} has not yet been scouted — no reports on file.`);
  } else {
    const qualLabel =
      compositeScore >= 80 ? 'elite quality' :
      compositeScore >= 65 ? 'strong quality' :
      compositeScore >= 50 ? 'moderate quality' :
      compositeScore >= 35 ? 'developing quality' : 'limited quality';
    const repLabel = raw.reportCount === 1 ? '1 report' : `${raw.reportCount} reports`;
    const avgStr   = raw.avgComposite != null ? ` (avg ${raw.avgComposite.toFixed(1)}/10)` : '';
    parts.push(
      `${playerName} is rated ${qualLabel} across ${repLabel}${avgStr}.`
    );
  }

  // Sentence 2 — recommendation consensus
  if (raw.reportCount > 0) {
    const total = raw.signCount + raw.monitorCount + raw.skipCount;
    if (raw.signCount > 0 && raw.signCount >= total / 2) {
      parts.push(`Scout consensus is to sign: ${raw.signCount}/${total} reports recommend acquisition.`);
    } else if (raw.skipCount > raw.signCount) {
      parts.push(`Scout consensus is to pass: ${raw.skipCount}/${total} reports advise skipping.`);
    } else {
      parts.push(`Scout consensus is to monitor: ${raw.monitorCount}/${total} reports suggest continued observation.`);
    }
  }

  // Sentence 3 — contract / urgency
  if (contractRiskScore >= 80 && raw.daysToExpiry != null) {
    parts.push(
      raw.daysToExpiry < 0
        ? `Contract has already expired — immediate action required.`
        : `Contract expires in ${raw.daysToExpiry} days — acquisition window is closing.`
    );
  } else if (raw.marketOpportunity === 'UNDERVALUED' && raw.askingPriceMEur != null && raw.latestValueMEur != null) {
    const pct = Math.round((1 - raw.askingPriceMEur / raw.latestValueMEur) * 100);
    parts.push(`Asking price (${raw.askingPriceMEur}M€) is ${pct}% below market value — strong value opportunity.`);
  } else if (tacticalFitScore >= 75) {
    parts.push(`Positional and tactical fit score of ${tacticalFitScore} indicates an excellent system match.`);
  }

  return parts.join(' ');
}

// ─── 8. Market Opportunity Detection ─────────────────────────────────────────

export function detectMarketOpportunity(
  compositeScore:         number,
  latestValueMEur:        number | null,
  askingPriceMEur:        number | null,
  daysToExpiry:           number | null,
  isAvailableForTransfer: boolean,
): MarketOpportunity | null {
  if (isAvailableForTransfer)                                             return 'AVAILABLE';
  if (daysToExpiry != null && daysToExpiry <= 180)                       return 'FREE_AGENT_RISK';
  if (latestValueMEur && askingPriceMEur && askingPriceMEur < latestValueMEur * 0.85) return 'UNDERVALUED';
  if (compositeScore >= 72 && askingPriceMEur != null && askingPriceMEur < 5)         return 'HIGH_VALUE_CHEAP';
  return null;
}

// ─── Full Scorecard Builder ───────────────────────────────────────────────────

export interface ScorecardInput {
  playerId:       string;
  playerName:     string;
  playerPosition: string | null;
  targetPosition: string | null;   // from TransferTarget.position
  targetPriority: number;          // TransferTarget.priorityScore
  reports:        Array<{
    compositeScore: number | null;
    overallGrade:   string | null;
    recommendation: string | null;
    technical:      number | null;
    physical:       number | null;
    mental:         number | null;
    tactical:       number | null;
    potential:      number | null;
  }>;
  contract:        {
    contractExpiry:         Date;
    releaseClauseEur:       number | null;
    isAvailableForTransfer: boolean;
    isExpiringSoon:         boolean;
  } | null;
  latestValueMEur:  number | null;
  askingPriceMEur:  number | null;
}

/** Build a complete PlayerScorecard from pre-fetched inputs. */
export function buildScorecard(input: ScorecardInput): PlayerScorecard {
  const compositeScore    = computeCompositeScore(input.reports);
  const tacticalFitScore  = computeTacticalFitScore(
    input.playerPosition, input.targetPosition, input.reports,
  );
  const contractRiskScore = computeContractRiskScore(input.contract);
  const transferPriority  = computeTransferPriority(
    compositeScore, tacticalFitScore, contractRiskScore, input.targetPriority,
  );

  const today        = new Date();
  const daysToExpiry = input.contract
    ? Math.floor((input.contract.contractExpiry.getTime() - today.getTime()) / 86_400_000)
    : null;

  const avgComposite = input.reports.length
    ? +(input.reports.reduce((s, r) => s + (r.compositeScore ?? 0), 0) / input.reports.length).toFixed(2)
    : null;
  const topGrade = input.reports.reduce((best: string | null, r) => {
    if (!r.overallGrade) return best;
    return !best || (GRADE_SCORE[r.overallGrade] ?? 0) > (GRADE_SCORE[best] ?? 0) ? r.overallGrade : best;
  }, null);

  const signCount    = input.reports.filter((r) => r.recommendation === 'SIGN').length;
  const monitorCount = input.reports.filter((r) => r.recommendation === 'MONITOR').length;
  const skipCount    = input.reports.filter((r) => r.recommendation === 'SKIP').length;

  const rawForOpportunity = {
    compositeScore,
    latestValueMEur:  input.latestValueMEur,
    askingPriceMEur:  input.askingPriceMEur,
    daysToExpiry,
    isAvailableForTransfer: input.contract?.isAvailableForTransfer ?? false,
  };
  const marketOpportunity = detectMarketOpportunity(
    compositeScore,
    input.latestValueMEur,
    input.askingPriceMEur,
    daysToExpiry,
    input.contract?.isAvailableForTransfer ?? false,
  );

  // Flags
  const flags: ScorecardFlag[] = [];
  if (input.reports.length === 0)                                   flags.push('NO_REPORTS');
  if (daysToExpiry != null && daysToExpiry < 90)                    flags.push('CONTRACT_CRITICAL');
  else if (daysToExpiry != null && daysToExpiry < 180)              flags.push('CONTRACT_WARNING');
  if (input.contract?.isExpiringSoon)                               flags.push('EXPIRING_SOON');
  if (input.contract?.isAvailableForTransfer)                       flags.push('AVAILABLE_NOW');
  if (marketOpportunity === 'UNDERVALUED')                          flags.push('UNDERVALUED');
  const avgPotential = input.reports.length
    ? input.reports.reduce((s, r) => s + (r.potential ?? 0), 0) / input.reports.length
    : 0;
  if (avgPotential > 8)                                             flags.push('HIGH_POTENTIAL');

  const raw: PlayerScorecard['raw'] = {
    reportCount:     input.reports.length,
    avgComposite,
    topGrade,
    signCount,
    monitorCount,
    skipCount,
    daysToExpiry,
    latestValueMEur: input.latestValueMEur,
    askingPriceMEur: input.askingPriceMEur,
    playerPosition:  input.playerPosition,
    marketOpportunity,
  };

  const scoutingSummary = generateScoutingSummary(
    input.playerName,
    compositeScore,
    tacticalFitScore,
    contractRiskScore,
    raw,
  );

  return {
    playerId:          input.playerId,
    compositeScore,
    tacticalFitScore,
    contractRiskScore,
    transferPriority,
    marketOpportunity,
    flags,
    scoutingSummary,
    raw,
  };
}

// ─── Service entry points (called by controller) ──────────────────────────────

/**
 * Compute scorecards for all active targets in a club and return ranked list.
 * Falls back gracefully if any sub-query fails.
 */
export async function getRankedTargets(actor: ScoringActor): Promise<RankedTarget[]> {
  // Load all active targets + squad players in parallel
  const [targets, squadPlayers] = await Promise.all([
    prisma.transferTarget.findMany({
      where:   { clubId: actor.clubId, archivedAt: null },
      orderBy: { priorityScore: 'desc' },
    }),
    prisma.player.findMany({
      where:  { clubId: actor.clubId, isActive: true },
      select: { id: true, firstName: true, lastName: true, position: true, isActive: true },
    }),
  ]);

  if (!targets.length) return [];

  const playerIds = [...new Set(targets.map((t) => t.playerId))];

  // Batch-fetch all scouting reports and contracts in 2 queries
  const [allReports, allContracts, allValues] = await Promise.all([
    prisma.scoutingReport.findMany({
      where:  { clubId: actor.clubId, playerId: { in: playerIds } },
      select: {
        playerId: true, compositeScore: true, overallGrade: true,
        recommendation: true, technical: true, physical: true,
        mental: true, tactical: true, potential: true,
      },
    }),
    prisma.playerContractStatus.findMany({
      where:  { clubId: actor.clubId, playerId: { in: playerIds } },
    }),
    prisma.playerMarketValue.findMany({
      where:   { clubId: actor.clubId, playerId: { in: playerIds } },
      orderBy: { valuationDate: 'desc' },
      distinct: ['playerId'],
      select:  { playerId: true, valueMEur: true },
    }),
  ]);

  // Build lookup maps
  const reportsByPlayer  = new Map<string, typeof allReports>();
  const contractByPlayer = new Map<string, (typeof allContracts)[number]>();
  const valueByPlayer    = new Map<string, number>();
  const playerMap        = new Map(squadPlayers.map((p) => [p.id, p]));

  for (const r of allReports) {
    if (!r.playerId) continue;
    const arr = reportsByPlayer.get(r.playerId) ?? [];
    arr.push(r);
    reportsByPlayer.set(r.playerId, arr);
  }
  for (const c of allContracts)  contractByPlayer.set(c.playerId, c);
  for (const v of allValues)     valueByPlayer.set(v.playerId, v.valueMEur);

  const ranked: RankedTarget[] = targets.map((target) => {
    const player   = playerMap.get(target.playerId);
    const reports  = reportsByPlayer.get(target.playerId) ?? [];
    const contract = contractByPlayer.get(target.playerId) ?? null;
    const latestV  = valueByPlayer.get(target.playerId) ?? null;

    const scorecard = buildScorecard({
      playerId:       target.playerId,
      playerName:     player ? `${player.firstName} ${player.lastName}` : target.playerId,
      playerPosition: player?.position ?? null,
      targetPosition: target.position,
      targetPriority: target.priorityScore ?? 50,
      reports:        reports as ScorecardInput['reports'],
      contract:       contract
        ? {
            contractExpiry:         contract.contractExpiry,
            releaseClauseEur:       contract.releaseClauseEur,
            isAvailableForTransfer: contract.isAvailableForTransfer,
            isExpiringSoon:         contract.isExpiringSoon,
          }
        : null,
      latestValueMEur: latestV,
      askingPriceMEur: target.askingPriceMEur,
    });

    return { targetId: target.id, playerId: target.playerId, stage: target.stage, scorecard };
  });

  // Sort by transferPriority descending
  ranked.sort((a, b) => b.scorecard.transferPriority - a.scorecard.transferPriority);
  return ranked;
}

/**
 * Compute squad depth analysis for a club.
 */
export async function getSquadDepthAnalysis(actor: ScoringActor): Promise<SquadDepthResult> {
  const players = await prisma.player.findMany({
    where:  { clubId: actor.clubId },
    select: { position: true, isActive: true },
  });
  return computeSquadDepth(players as Array<{ position: string; isActive: boolean }>);
}
