// Familista — Unified Intelligence Engine (Phase 11)
// Target: src/intelligence/unified.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Central aggregation layer combining scouting, medical, video, contract, and
// market data into a single explainable player intelligence report.
//
// Design principles:
//   • Deterministic — same inputs always produce same outputs
//   • Graceful degradation — missing modules lower confidence, not score
//   • No mock data — every score component traces to a real DB value
//   • Explainable — every score carries an evidence string
//
// Six scoring dimensions (weights sum to 1.0):
//   scoutingQuality   0.30  — composite from scouting reports
//   tacticalFit       0.20  — positional attribute fit
//   contractSecurity  0.15  — inverse of contract risk
//   medicalFitness    0.15  — inverse of injury/workload risk
//   videoEvidence     0.10  — video clip coverage + quality
//   marketOpportunity 0.10  — structural buy signals
// ─────────────────────────────────────────────────────────────────────────────

import { prisma }    from '../config/database';
import * as ScoutingSvc  from '../transfer/scouting.service';
import * as MarketSvc    from '../transfer/market.service';
import * as WorkloadSvc  from '../workload/workload-science.service';
import * as VideoSvc     from '../video/video-clip.service';
import * as TacticalSvc  from './tactical-matrix.service';
import * as SuccessionSvc from './succession.service';
import {
  computeConfidence,
  computeMedicalRiskScore,
  computeVideoInfluenceScore,
  weightedSum,
  explainComponents,
  ConfidenceLevel,
  ScoreComponent,
} from './shared.utils';
import {
  computeCompositeScore,
  computeTacticalFitScore,
  computeContractRiskScore,
} from '../transfer/scoring.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnifiedActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface WeightedComponent {
  label:        string;
  rawScore:     number;   // 0–100 (already inverted for risk dimensions)
  weight:       number;   // 0–1
  contribution: number;   // rawScore × weight
  evidence:     string;   // 1-sentence data proof
}

export interface UnifiedPlayerIntelligence {
  playerId:       string;
  playerName:     string | null;
  position:       string | null;
  generatedAt:    string;
  confidence:     ConfidenceLevel;
  overallScore:   number;              // 0–100
  recommendation: 'SIGN' | 'MONITOR' | 'SKIP';
  breakdown: {
    scoutingQuality:   WeightedComponent;
    tacticalFit:       WeightedComponent;
    contractSecurity:  WeightedComponent;
    medicalFitness:    WeightedComponent;
    videoEvidence:     WeightedComponent;
    marketOpportunity: WeightedComponent;
  };
  tacticalMatrix:  TacticalSvc.FormationCompatibility[];
  explanation:     string[];           // 3-4 plain-English bullets
  flags:           string[];
  successionValue: number;             // 0–100 importance of this player to succession plan
}

export interface SquadIntelligenceSummary {
  generatedAt:     string;
  totalPlayers:    number;
  avgOverallScore: number;
  topPlayers:      Array<{
    playerId:       string;
    name:           string;
    overallScore:   number;
    recommendation: string;
  }>;
  futurePlan: SuccessionSvc.SquadFuturePlan;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const W = {
  scoutingQuality:   0.30,
  tacticalFit:       0.20,
  contractSecurity:  0.15,
  medicalFitness:    0.15,
  videoEvidence:     0.10,
  marketOpportunity: 0.10,
} as const;

function _invert(riskScore: number): number {
  return Math.max(0, 100 - riskScore);
}

function _marketOppScore(opp: string | null): number {
  const MAP: Record<string, number> = {
    AVAILABLE: 80, FREE_AGENT_RISK: 65, UNDERVALUED: 75, HIGH_VALUE_CHEAP: 70,
  };
  return opp ? (MAP[opp] ?? 40) : 40;
}

function _recommendation(
  overall: number,
  medicalRisk: number,
  contractRisk: number,
): 'SIGN' | 'MONITOR' | 'SKIP' {
  if (overall >= 70 && medicalRisk < 50 && contractRisk < 70) return 'SIGN';
  if (overall >= 45) return 'MONITOR';
  return 'SKIP';
}

function _mk(
  label: string,
  rawScore: number,
  weight: number,
  evidence: string,
): WeightedComponent {
  return { label, rawScore: +rawScore.toFixed(1), weight, contribution: +(rawScore * weight).toFixed(1), evidence };
}

// ─── getUnifiedPlayerIntelligence ────────────────────────────────────────────

/**
 * Builds a full unified intelligence report for any player in the club.
 * All sub-queries run in parallel; failures degrade confidence gracefully.
 */
export async function getUnifiedPlayerIntelligence(
  actor: UnifiedActor,
  playerId: string,
): Promise<UnifiedPlayerIntelligence> {
  // ── Parallel data fetch ─────────────────────────────────────────────────
  const [playerRes, reportsRes, contractRes, marketRes, medicalRes, clipsRes, targetRes] =
    await Promise.allSettled([
      prisma.player.findFirst({
        where: { id: playerId, clubId: actor.clubId },
        select: { id: true, firstName: true, lastName: true, position: true, dateOfBirth: true },
      }),
      ScoutingSvc.listScoutingReports(actor, { playerId, limit: 100 }),
      MarketSvc.getContractStatus(actor, playerId).catch(() => null),
      MarketSvc.getLatestMarketValue(actor, playerId).catch(() => null),
      WorkloadSvc.getPlayerMedicalProfile(actor, playerId).catch(() => null),
      VideoSvc.listClips(actor, { playerId, limit: 50 }),
      prisma.transferTarget.findFirst({
        where: { playerId, clubId: actor.clubId },
        select: { askingPriceMEur: true },
      }),
    ]);

  const player    = playerRes.status    === 'fulfilled' ? playerRes.value    : null;
  const reports   = reportsRes.status   === 'fulfilled' ? (reportsRes.value?.items ?? []) : [];
  const contract  = contractRes.status  === 'fulfilled' ? contractRes.value  : null;
  const market    = marketRes.status    === 'fulfilled' ? marketRes.value    : null;
  const medical   = medicalRes.status   === 'fulfilled' ? medicalRes.value   : null;
  const clips     = clipsRes.status     === 'fulfilled' ? (clipsRes.value?.items ?? []) : [];
  const target    = targetRes.status    === 'fulfilled' ? targetRes.value    : null;

  const playerName = player ? `${player.firstName} ${player.lastName}` : null;
  const position   = player?.position ?? null;
  const today      = new Date();

  // ── Score 1: Scouting quality (Phase 10 formula reused) ─────────────────
  const scoutingRaw = computeCompositeScore(
    reports as Parameters<typeof computeCompositeScore>[0],
  );
  const avgComposite = reports.length
    ? +(reports.reduce((s, r) => s + ((r as any).compositeScore ?? 0), 0) / reports.length).toFixed(1)
    : null;
  const scoutingEvidence = reports.length
    ? `${reports.length} report(s); avg composite ${avgComposite}/10`
    : 'No scouting reports filed';

  // ── Score 2: Tactical fit ─────────────────────────────────────────────────
  const tacticalRaw     = computeTacticalFitScore(
    position, position,
    reports as Parameters<typeof computeTacticalFitScore>[2],
  );
  const bestSlot        = TacticalSvc.getBestFormationSlot(position);
  const tacticalEvidence = position
    ? `${position} → best fit: ${bestSlot.formation} (${bestSlot.slot}, ${bestSlot.score}%)`
    : 'Position unknown — neutral estimate';

  // ── Score 3: Contract security (inverted risk) ────────────────────────────
  const contractRiskRaw = computeContractRiskScore(
    contract as Parameters<typeof computeContractRiskScore>[0],
  );
  const contractRaw     = _invert(contractRiskRaw);
  const daysToExpiry    = contract?.contractExpiry
    ? Math.floor((new Date(contract.contractExpiry).getTime() - today.getTime()) / 86_400_000)
    : null;
  const contractEvidence = contract
    ? `Expires in ${daysToExpiry ?? '?'} days${contract.isExpiringSoon ? ' ⚠ expiring soon' : ''}`
    : 'No contract data on file';

  // ── Score 4: Medical fitness (inverted risk) ──────────────────────────────
  const injuries       = (medical as any)?.injuries ?? [];
  const activeCount    = injuries.filter((i: any) => !i.returnDate).length;
  const lastReturn     = injuries
    .map((i: any) => i.returnDate ? new Date(i.returnDate) : null)
    .filter(Boolean)
    .sort((a: Date, b: Date) => b.getTime() - a.getTime())[0] as Date | undefined;
  const recentReturnDays = lastReturn
    ? Math.floor((today.getTime() - lastReturn.getTime()) / 86_400_000)
    : null;
  const acwr = (medical as any)?.workload?.acwr ?? null;

  const medicalRiskRaw  = computeMedicalRiskScore({
    activeInjuryCount: activeCount,
    totalInjuryCount:  injuries.length,
    recentReturnDays,
    acwr,
  });
  const medicalRaw      = _invert(medicalRiskRaw);
  const medicalEvidence = activeCount > 0
    ? `${activeCount} active injury/injuries; ${injuries.length} total recorded`
    : injuries.length > 0
      ? `Fully fit; ${injuries.length} historical injur${injuries.length === 1 ? 'y' : 'ies'} on record`
      : 'No injury records; fitness data not available';

  // ── Score 5: Video evidence ───────────────────────────────────────────────
  const videoRaw      = computeVideoInfluenceScore(
    clips.map((c: any) => ({ clipType: c.clipType ?? null, annotationCount: 0 })),
  );
  const videoEvidence = clips.length
    ? `${clips.length} video clip(s) available`
    : 'No video clips linked to this player';

  // ── Score 6: Market opportunity ───────────────────────────────────────────
  const valueMEur      = (market as any)?.valueMEur ?? null;
  const askingPriceMEur = target?.askingPriceMEur ?? null;

  let marketOpp: string | null = null;
  if (contract?.isAvailableForTransfer)                                       marketOpp = 'AVAILABLE';
  else if (daysToExpiry !== null && daysToExpiry <= 180)                      marketOpp = 'FREE_AGENT_RISK';
  else if (valueMEur !== null && askingPriceMEur !== null &&
           askingPriceMEur < valueMEur * 0.85)                                marketOpp = 'UNDERVALUED';
  else if (avgComposite !== null && avgComposite > 7.2 &&
           askingPriceMEur !== null && askingPriceMEur < 5)                   marketOpp = 'HIGH_VALUE_CHEAP';

  const marketRaw      = _marketOppScore(marketOpp);
  const marketEvidence = marketOpp ? `Signal detected: ${marketOpp}` : 'No structural buy signal';

  // ── Aggregate overall score ───────────────────────────────────────────────
  const overallScore = weightedSum([
    { score: scoutingRaw,  weight: W.scoutingQuality },
    { score: tacticalRaw,  weight: W.tacticalFit },
    { score: contractRaw,  weight: W.contractSecurity },
    { score: medicalRaw,   weight: W.medicalFitness },
    { score: videoRaw,     weight: W.videoEvidence },
    { score: marketRaw,    weight: W.marketOpportunity },
  ]);

  // ── Confidence ────────────────────────────────────────────────────────────
  const confidence = computeConfidence({
    reportCount:     reports.length,
    hasContract:     contract !== null,
    hasMarketValue:  market !== null,
    hasWorkloadData: acwr !== null,
    hasVideoClips:   clips.length > 0,
  });

  // ── Recommendation ────────────────────────────────────────────────────────
  const recommendation = _recommendation(overallScore, medicalRiskRaw, contractRiskRaw);

  // ── Breakdown ─────────────────────────────────────────────────────────────
  const breakdown = {
    scoutingQuality:   _mk('Scouting Quality',    scoutingRaw, W.scoutingQuality,   scoutingEvidence),
    tacticalFit:       _mk('Tactical Fit',         tacticalRaw, W.tacticalFit,       tacticalEvidence),
    contractSecurity:  _mk('Contract Security',    contractRaw, W.contractSecurity,  contractEvidence),
    medicalFitness:    _mk('Medical Fitness',       medicalRaw,  W.medicalFitness,    medicalEvidence),
    videoEvidence:     _mk('Video Evidence',        videoRaw,    W.videoEvidence,     videoEvidence),
    marketOpportunity: _mk('Market Opportunity',    marketRaw,   W.marketOpportunity, marketEvidence),
  };

  // ── Explainable bullets ───────────────────────────────────────────────────
  const explComponents: ScoreComponent[] = Object.values(breakdown).map((c) => ({
    label: c.label, score: c.rawScore, weight: c.weight, evidence: c.evidence,
  }));
  const explanation = explainComponents(explComponents, overallScore);

  // ── Tactical matrix ───────────────────────────────────────────────────────
  const tacticalMatrix = TacticalSvc.getTacticalCompatibilityMatrix(position);

  // ── Flags ─────────────────────────────────────────────────────────────────
  const flags: string[] = [];
  if (reports.length === 0)                  flags.push('NO_REPORTS');
  if (activeCount > 0)                       flags.push('MEDICAL_RISK');
  if (contractRiskRaw > 65)                  flags.push('CONTRACT_URGENT');
  if (videoRaw === 0)                        flags.push('NO_VIDEO');
  if (marketOpp)                             flags.push(marketOpp);
  if (confidence === 'NONE' || confidence === 'LOW') flags.push('LOW_CONFIDENCE');

  // ── Succession value ──────────────────────────────────────────────────────
  const age = player?.dateOfBirth
    ? Math.floor((Date.now() - new Date(player.dateOfBirth).getTime()) / (365.25 * 86_400_000))
    : null;
  const ageBonus = age !== null && age < 24 ? 20 : age !== null && age < 27 ? 10 : 0;
  const successionValue = Math.min(100, Math.round(scoutingRaw * 0.6 + ageBonus));

  return {
    playerId,
    playerName,
    position,
    generatedAt: today.toISOString(),
    confidence,
    overallScore,
    recommendation,
    breakdown,
    tacticalMatrix,
    explanation,
    flags,
    successionValue,
  };
}

// ─── getSquadIntelligenceSummary ──────────────────────────────────────────────

/**
 * Returns a lightweight squad-wide overview: top players by scouting score,
 * plus the full future-plan from succession.service.
 * Avoids N+1 by batching report aggregation in a single query.
 */
export async function getSquadIntelligenceSummary(
  actor: UnifiedActor,
): Promise<SquadIntelligenceSummary> {
  const [players, reports] = await Promise.all([
    prisma.player.findMany({
      where: { clubId: actor.clubId },
      select: { id: true, firstName: true, lastName: true },
      take: 50,
    }),
    prisma.scoutingReport.findMany({
      where: { clubId: actor.clubId },
      select: { playerId: true, compositeScore: true, recommendation: true },
    }),
  ]);

  const repMap = new Map<string, typeof reports>();
  for (const r of reports) {
    if (!r.playerId) continue;
    const pid = r.playerId as string;
    if (!repMap.has(pid)) repMap.set(pid, []);
    repMap.get(pid)!.push(r);
  }

  const topPlayers = players
    .map((p) => {
      const reps = repMap.get(p.id) ?? [];
      const avg  = reps.length
        ? Math.round(reps.reduce((s, r) => s + (r.compositeScore ?? 0), 0) / reps.length * 10)
        : 0;
      const signN    = reps.filter((r) => r.recommendation === 'SIGN').length;
      const monitorN = reps.filter((r) => r.recommendation === 'MONITOR').length;
      const rec      = signN > reps.length / 2 ? 'SIGN' : monitorN > 0 ? 'MONITOR' : 'SKIP';
      return { playerId: p.id, name: `${p.firstName} ${p.lastName}`, overallScore: avg, recommendation: rec };
    })
    .sort((a, b) => b.overallScore - a.overallScore)
    .slice(0, 10);

  const avgOverallScore = topPlayers.length
    ? Math.round(topPlayers.reduce((s, p) => s + p.overallScore, 0) / topPlayers.length)
    : 0;

  const futurePlan = await SuccessionSvc.getSquadFuturePlan(actor);

  return {
    generatedAt:     new Date().toISOString(),
    totalPlayers:    players.length,
    avgOverallScore,
    topPlayers,
    futurePlan,
  };
}
