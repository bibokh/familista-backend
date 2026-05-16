// Familista — AI Decision Engine
// File location: src/services/ai-feature-extraction.service.ts
//
// Pure feature extractors that snapshot the relevant signals from the existing
// Familista graph for each decision subject. These run before any model is
// invoked and the resulting FeatureMap is frozen onto the AIDecision row so
// the decision can be re-explained months later.

import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { getDescendantUnitIds } from './franchise-unit.service';
import type {
  PlayerFeatures,
  ClubFeatures,
  FranchiseFeatures,
  InvestorFeatures,
  EntityFeatures,
  ExecutiveFeatures,
  MatchFeatures,
} from '../types/ai-engine.types';

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round2(n: number | null): number | null {
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

const SEVERITY_SCORE: Record<string, number> = {
  MINOR: 1,
  MODERATE: 2,
  SERIOUS: 3,
  CRITICAL: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// Player features
// ─────────────────────────────────────────────────────────────────────────────

export async function extractPlayerFeatures(playerId: string): Promise<PlayerFeatures> {
  const now = new Date();
  const threshold30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const threshold14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const threshold365 = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: {
      attributes: { orderBy: { recordedAt: 'desc' }, take: 1 },
      gpsData: { where: { recordedAt: { gte: threshold30 } }, orderBy: { recordedAt: 'desc' } },
      matchStats: {
        where: { match: { playedAt: { gte: threshold30 } } },
        include: { match: { select: { playedAt: true } } },
      },
      injuries: { orderBy: { injuredAt: 'desc' } },
    },
  });
  if (!player) throw new NotFoundError('Player not found');

  const club = await prisma.club.findUnique({
    where: { id: player.clubId },
    include: {
      players: {
        select: { id: true, overallRating: true, position: true },
      },
    },
  });

  const age = player.dateOfBirth ? Math.floor(daysBetween(player.dateOfBirth, now) / 365.25) : null;
  const contractDaysLeft = player.contractUntil ? Math.max(0, daysBetween(now, player.contractUntil)) : null;

  // Recent match stats
  const recentMatches = player.matchStats.filter((s) => s.match.playedAt != null);
  const recentMinutes = recentMatches.reduce((s, m) => s + (m.minutesPlayed ?? 0), 0);
  const recentGoals = recentMatches.reduce((s, m) => s + (m.goals ?? 0), 0);
  const recentAssists = recentMatches.reduce((s, m) => s + (m.assists ?? 0), 0);
  const recentRatings = recentMatches.map((m) => m.rating).filter((r): r is number => r != null);

  // GPS load
  const gps30d = player.gpsData;
  const gps14d = gps30d.filter((g) => g.recordedAt >= threshold14);
  const avgLoad30 = avg(gps30d.map((g) => g.playerLoad));
  const maxLoad30 = gps30d.length > 0 ? Math.max(...gps30d.map((g) => g.playerLoad)) : null;
  const avgLoad14 = avg(gps14d.map((g) => g.playerLoad));
  const loadDelta =
    avgLoad14 != null && avgLoad30 != null && avgLoad30 > 0
      ? (avgLoad14 - avgLoad30) / avgLoad30
      : null;
  const riskAvg = avg(gps30d.map((g) => g.riskScore));

  // Injury history
  const injuries365 = player.injuries.filter((i) => i.injuredAt >= threshold365);
  const lastInjury = player.injuries[0];
  const daysSinceLastInjury = lastInjury ? daysBetween(lastInjury.injuredAt, now) : null;
  const avgInjurySeverity =
    injuries365.length > 0
      ? injuries365.reduce((s, i) => s + (SEVERITY_SCORE[i.severity] ?? 0), 0) / injuries365.length
      : null;

  // Peer comparisons
  const teamRatings = club?.players.map((p) => p.overallRating) ?? [];
  const positionRatings = club?.players.filter((p) => p.position === player.position).map((p) => p.overallRating) ?? [];
  const teamAvg = avg(teamRatings);
  const positionAvg = avg(positionRatings);

  return {
    playerId,
    age,
    position: player.position,
    overallRating: player.overallRating,
    potential: player.potential,
    condition: player.condition,
    isInjured: player.isInjured,
    contractDaysLeft,
    marketValue: player.marketValue,
    weeklyWage: player.weeklyWage,
    recentMatchCount: recentMatches.length,
    recentMatchRatingAvg: round2(avg(recentRatings)),
    recentGoalsPer90: recentMinutes > 0 ? round2((recentGoals / recentMinutes) * 90) : null,
    recentAssistsPer90: recentMinutes > 0 ? round2((recentAssists / recentMinutes) * 90) : null,
    recentMinutesPlayed: recentMinutes,
    avgPlayerLoad30d: round2(avgLoad30),
    maxPlayerLoad30d: round2(maxLoad30),
    playerLoadDelta14dVs30d: round2(loadDelta),
    avgRiskScore30d: round2(riskAvg),
    daysSinceLastInjury,
    injuryCount365d: injuries365.length,
    avgInjurySeverityScore: round2(avgInjurySeverity),
    teamAvgRating: round2(teamAvg),
    positionAvgRating: round2(positionAvg),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Match features
// ─────────────────────────────────────────────────────────────────────────────

export async function extractMatchFeatures(matchId: string): Promise<MatchFeatures> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { club: { select: { id: true, name: true } } },
  });
  if (!match) throw new NotFoundError('Match not found');

  const now = new Date();
  const recentMatches = await prisma.match.findMany({
    where: {
      clubId: match.clubId,
      playedAt: { lt: now, not: null },
      result: { not: null },
    },
    orderBy: { playedAt: 'desc' },
    take: 5,
  });
  const formScore = recentMatches.reduce((s, m) => {
    if (m.result === 'WIN') return s + 3;
    if (m.result === 'DRAW') return s + 1;
    return s;
  }, 0);

  const opponentName = match.isHome ? match.awayTeam : match.homeTeam;

  return {
    matchId,
    competition: match.competition,
    scheduledAt: match.scheduledAt.toISOString(),
    isHome: match.isHome,
    daysToMatch: daysBetween(now, match.scheduledAt),
    opponentName,
    recentResultsForm: formScore,
    opponentRecentForm: null, // external data — left null in production-grade form
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Club features
// ─────────────────────────────────────────────────────────────────────────────

export async function extractClubFeatures(clubId: string): Promise<ClubFeatures> {
  const now = new Date();
  const window90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const windowPrior90 = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const window180Fwd = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    include: {
      players: { select: { id: true, isInjured: true, dateOfBirth: true, weeklyWage: true, contractUntil: true } },
    },
  });
  if (!club) throw new NotFoundError('Club not found');

  const financials90 = await prisma.financial.findMany({
    where: { clubId, date: { gte: window90, lte: now } },
    select: { amount: true, type: true },
  });
  const financialsPrior = await prisma.financial.findMany({
    where: { clubId, date: { gte: windowPrior90, lt: window90 } },
    select: { amount: true, type: true },
  });

  const revenue90 = financials90.filter((f) => f.type === 'INCOME').reduce((s, f) => s + f.amount, 0);
  const expense90 = financials90.filter((f) => f.type === 'EXPENSE').reduce((s, f) => s + f.amount, 0);
  const revenuePrior90 = financialsPrior.filter((f) => f.type === 'INCOME').reduce((s, f) => s + f.amount, 0);

  const playerCount = club.players.length;
  const injuredCount = club.players.filter((p) => p.isInjured).length;
  const injuryRate = playerCount > 0 ? injuredCount / playerCount : 0;
  const ages = club.players
    .map((p) => (p.dateOfBirth ? Math.floor(daysBetween(p.dateOfBirth, now) / 365.25) : null))
    .filter((a): a is number => a != null);
  const wagesPerWeek = club.players.reduce((s, p) => s + (p.weeklyWage ?? 0), 0);
  const wagesPerMonth = wagesPerWeek * 4.33;
  const contractsExpiring = club.players.filter(
    (p) => p.contractUntil && p.contractUntil >= now && p.contractUntil <= window180Fwd,
  ).length;

  // Soft references — works whether or not the franchise engine is migrated
  const violationsOpen = await prisma.franchiseViolation
    .count({
      where: {
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] },
        unit: { clubs: { some: { id: clubId } } } as never,
      },
    })
    .catch(() => 0);

  return {
    clubId,
    plan: club.plan,
    subscriptionStatus: club.subscriptionStatus,
    revenue90d: round2(revenue90) ?? 0,
    revenuePrior90d: round2(revenuePrior90) ?? 0,
    expense90d: round2(expense90) ?? 0,
    netCashFlow90d: round2(revenue90 - expense90) ?? 0,
    playerCount,
    injuredCount,
    injuryRate: round2(injuryRate) ?? 0,
    averageSquadAge: round2(avg(ages)),
    wagesPerMonth: round2(wagesPerMonth) ?? 0,
    contractsExpiringNext180d: contractsExpiring,
    overdueViolations: violationsOpen,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Franchise features
// ─────────────────────────────────────────────────────────────────────────────

export async function extractFranchiseFeatures(unitId: string): Promise<FranchiseFeatures> {
  const now = new Date();
  const window90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const windowPrior90 = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const window180Fwd = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

  const unit = await prisma.franchiseUnit.findUnique({
    where: { id: unitId },
    include: { _count: { select: { childUnits: true, territoryRights: true } } },
  });
  if (!unit) throw new NotFoundError('Franchise unit not found');

  const descendants = await getDescendantUnitIds([unitId]);
  const descendantIds = Array.from(descendants);

  const [clubs, revenueAgg, revenuePriorAgg, openViolations, expiring, lastSnapshot, exclusiveRights] = await Promise.all([
    prisma.club.findMany({
      where: ({ franchiseUnitId: { in: descendantIds } } as unknown) as Record<string, unknown> as never,
      select: { id: true, subscriptionStatus: true },
    }),
    prisma.revenueDistribution.aggregate({
      where: { unitId: { in: descendantIds }, status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: window90 } },
      _sum: { sourceAmount: true },
    }),
    prisma.revenueDistribution.aggregate({
      where: { unitId: { in: descendantIds }, status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: windowPrior90, lt: window90 } },
      _sum: { sourceAmount: true },
    }),
    prisma.franchiseViolation.count({
      where: { unitId: { in: descendantIds }, status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] } },
    }),
    prisma.franchiseContract.count({
      where: { unitId: { in: descendantIds }, status: 'ACTIVE', effectiveTo: { gte: now, lte: window180Fwd } },
    }),
    prisma.franchisePerformanceSnapshot.findFirst({
      where: { unitId },
      orderBy: { periodStartAt: 'desc' },
    }),
    prisma.territoryRight.count({
      where: { unitId, type: 'EXCLUSIVE', isActive: true },
    }),
  ]);

  const revenue90 = revenueAgg._sum.sourceAmount ?? 0;
  const revenuePrior = revenuePriorAgg._sum.sourceAmount ?? 0;
  const growthPct = revenuePrior > 0 ? ((revenue90 - revenuePrior) / revenuePrior) * 100 : null;
  const clubsActive = clubs.filter((c) => c.subscriptionStatus === 'ACTIVE' || c.subscriptionStatus === 'TRIALING').length;

  return {
    unitId,
    level: unit.level,
    status: unit.status,
    clubsActive,
    clubsTotal: clubs.length,
    revenue90d: round2(revenue90) ?? 0,
    revenuePrior90d: round2(revenuePrior) ?? 0,
    revenueGrowthPct: round2(growthPct),
    violationsOpen: openViolations,
    contractsExpiringSoon: expiring,
    complianceScore: lastSnapshot?.complianceScore ?? null,
    childUnits: unit._count.childUnits,
    hasExclusiveRights: exclusiveRights > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Investor features
// ─────────────────────────────────────────────────────────────────────────────

export async function extractInvestorFeatures(investorId: string): Promise<InvestorFeatures> {
  const now = new Date();
  const investor = await prisma.investorProfile.findUnique({ where: { id: investorId } });
  if (!investor) throw new NotFoundError('Investor not found');

  const investments = await prisma.investment.findMany({
    where: { investorId },
    select: {
      committedAmount: true,
      fundedAmount: true,
      currency: true,
      status: true,
      commitDate: true,
      entityId: true,
      entity: { select: { type: true, currentValuation: true, totalSharesIssued: true, fullyDilutedShares: true } },
    },
  });

  const distributions = await prisma.investorDistribution.aggregate({
    where: { investorId, status: { in: ['COMPUTED', 'PAID'] } },
    _sum: { amount: true },
  });
  const realized = distributions._sum.amount ?? 0;

  const captable = await prisma.capTableEntry.findMany({
    where: { investorId, effectiveTo: null },
    select: { entityId: true, shares: true, totalCost: true, currency: true },
  });

  const totalCommitted = investments.reduce((s, i) => s + i.committedAmount, 0);
  const totalFunded = investments.reduce((s, i) => s + i.fundedAmount, 0);

  // Mark-to-market by aggregating shares per entity at current valuation / fully diluted
  const sharesByEntity = new Map<string, { shares: number; valuation: number; fd: number }>();
  for (const c of captable) {
    const entity = investments.find((i) => i.entityId === c.entityId)?.entity;
    if (!entity || !entity.currentValuation) continue;
    const fd = Math.max(entity.fullyDilutedShares, entity.totalSharesIssued, 1);
    const existing = sharesByEntity.get(c.entityId) ?? { shares: 0, valuation: entity.currentValuation, fd };
    existing.shares += c.shares;
    sharesByEntity.set(c.entityId, existing);
  }
  let currentValue = 0;
  for (const v of sharesByEntity.values()) {
    currentValue += (v.shares / v.fd) * v.valuation;
  }

  const multiple = totalFunded > 0 ? round2((currentValue + realized) / totalFunded) : null;

  const entityTypeCounts: Record<string, number> = {};
  for (const i of investments) entityTypeCounts[i.entity.type] = (entityTypeCounts[i.entity.type] ?? 0) + 1;
  const distinctEntities = new Set(investments.map((i) => i.entityId)).size;
  const portfolioConcentration =
    distinctEntities > 0 && totalFunded > 0
      ? 1 -
        1 /
          Math.max(
            1,
            distinctEntities *
              (Math.min(...investments.map((i) => (i.fundedAmount > 0 ? i.fundedAmount / totalFunded : 0)).filter((x) => x > 0)) || 1),
          )
      : 0;

  const lastInvestment = investments.length > 0
    ? investments.reduce((latest, i) => (i.commitDate > latest ? i.commitDate : latest), investments[0].commitDate)
    : null;
  const daysSinceLastInvestment = lastInvestment ? daysBetween(lastInvestment, now) : null;

  const yearsHeld =
    totalFunded > 0 && investments.length > 0
      ? investments.reduce((s, i) => s + daysBetween(i.commitDate, now) / 365.25 * (i.fundedAmount / totalFunded), 0)
      : null;
  const netIrr =
    multiple != null && yearsHeld != null && yearsHeld > 0 ? Math.pow(multiple, 1 / yearsHeld) - 1 : null;

  return {
    investorId,
    type: investor.type,
    kycStatus: investor.kycStatus,
    totalCommitted: round2(totalCommitted) ?? 0,
    totalFunded: round2(totalFunded) ?? 0,
    totalRealized: round2(realized) ?? 0,
    currentValue: round2(currentValue) ?? 0,
    multiple,
    netIrrEstimate: round2(netIrr),
    portfolioConcentration: round2(portfolioConcentration) ?? 0,
    exposureByEntityType: JSON.stringify(entityTypeCounts),
    daysSinceLastInvestment,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Investment entity features
// ─────────────────────────────────────────────────────────────────────────────

export async function extractEntityFeatures(entityId: string): Promise<EntityFeatures> {
  const now = new Date();
  const window90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const windowPrior90 = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  const [activeRounds, allInvestments, currentRevenue, priorRevenue] = await Promise.all([
    prisma.investmentRound.count({ where: { entityId, status: 'OPEN' } }),
    prisma.investment.aggregate({
      where: { entityId, status: { in: ['FUNDED', 'CONVERTED'] } },
      _sum: { fundedAmount: true },
    }),
    entity.clubId
      ? prisma.revenueDistribution.aggregate({
          where: { clubId: entity.clubId, status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: window90 } },
          _sum: { sourceAmount: true },
        })
      : entity.franchiseUnitId
        ? prisma.revenueDistribution.aggregate({
            where: { unitId: entity.franchiseUnitId, status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: window90 } },
            _sum: { sourceAmount: true },
          })
        : Promise.resolve({ _sum: { sourceAmount: 0 } }),
    entity.clubId
      ? prisma.revenueDistribution.aggregate({
          where: { clubId: entity.clubId, status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: windowPrior90, lt: window90 } },
          _sum: { sourceAmount: true },
        })
      : entity.franchiseUnitId
        ? prisma.revenueDistribution.aggregate({
            where: { unitId: entity.franchiseUnitId, status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: windowPrior90, lt: window90 } },
            _sum: { sourceAmount: true },
          })
        : Promise.resolve({ _sum: { sourceAmount: 0 } }),
  ]);

  const revenue90 = currentRevenue._sum.sourceAmount ?? 0;
  const revenuePrior = priorRevenue._sum.sourceAmount ?? 0;
  const growthPct = revenuePrior > 0 ? ((revenue90 - revenuePrior) / revenuePrior) * 100 : null;

  return {
    entityId,
    entityType: entity.type,
    currentValuation: entity.currentValuation,
    totalSharesIssued: entity.totalSharesIssued,
    fullyDilutedShares: entity.fullyDilutedShares,
    activeRoundCount: activeRounds,
    totalRaisedToDate: round2(allInvestments._sum.fundedAmount ?? 0) ?? 0,
    revenue90d: round2(revenue90) ?? 0,
    growthPct: round2(growthPct),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Executive (platform-wide) features
// ─────────────────────────────────────────────────────────────────────────────

export async function extractExecutiveFeatures(platformEntityId?: string | null): Promise<ExecutiveFeatures> {
  const now = new Date();
  const window90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const windowPrior90 = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

  const platform = platformEntityId
    ? await prisma.investmentEntity.findUnique({ where: { id: platformEntityId } })
    : await prisma.investmentEntity.findFirst({ where: { type: 'PLATFORM' } });

  const [revAgg, revPriorAgg, activeClubs, activeUnits, activeInvestors, aumAgg, criticalViolations] = await Promise.all([
    prisma.revenueDistribution.aggregate({
      where: { status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: window90 } },
      _sum: { sourceAmount: true },
    }),
    prisma.revenueDistribution.aggregate({
      where: { status: { in: ['COMPUTED', 'EXECUTED'] }, computedAt: { gte: windowPrior90, lt: window90 } },
      _sum: { sourceAmount: true },
    }),
    prisma.club.count({ where: { subscriptionStatus: { in: ['ACTIVE', 'TRIALING'] } } }),
    prisma.franchiseUnit.count({ where: { status: 'ACTIVE' } }),
    prisma.investorProfile.count({ where: { isActive: true, kycStatus: 'VERIFIED' } }),
    prisma.investment.aggregate({ where: { status: { in: ['FUNDED', 'CONVERTED'] } }, _sum: { fundedAmount: true } }),
    prisma.franchiseViolation.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] }, severity: 'CRITICAL' },
    }),
  ]);

  const revenue90 = revAgg._sum.sourceAmount ?? 0;
  const revenuePrior = revPriorAgg._sum.sourceAmount ?? 0;
  const growthPct = revenuePrior > 0 ? ((revenue90 - revenuePrior) / revenuePrior) * 100 : null;

  return {
    platformId: platform?.id ?? 'platform',
    platformName: platform?.name ?? 'Familista OS',
    totalRevenue90d: round2(revenue90) ?? 0,
    totalRevenuePrior90d: round2(revenuePrior) ?? 0,
    growthPct: round2(growthPct),
    activeClubs,
    activeFranchiseUnits: activeUnits,
    activeInvestors,
    totalAum: round2(aumAgg._sum.fundedAmount ?? 0) ?? 0,
    openCriticalViolations: criticalViolations,
    expansionOpportunityCount: 0, // computed on demand by the franchise engine
  };
}
