import { prisma } from '../config/database';

export async function getClubAnalytics(clubId: string) {
  const [
    playerCount,
    injuredCount,
    recentMatches,
    gpsAverages,
    topPerformers,
    highRiskPlayers,
  ] = await Promise.all([
    // Total players
    prisma.player.count({ where: { clubId } }),

    // Injured players
    prisma.player.count({ where: { clubId, isInjured: true } }),

    // Last 8 match results
    prisma.match.findMany({
      where: { clubId, result: { not: null } },
      orderBy: { scheduledAt: 'desc' },
      take: 8,
      select: {
        id: true, homeTeam: true, awayTeam: true,
        homeScore: true, awayScore: true, result: true,
        competition: true, scheduledAt: true, isHome: true,
      },
    }),

    // Team GPS averages (last 30 days)
    prisma.playerGpsData.aggregate({
      where: {
        player: { clubId },
        recordedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _avg: {
        topSpeed: true,
        avgSpeed: true,
        distance: true,
        heartRateAvg: true,
        playerLoad: true,
        sprintCount: true,
      },
    }),

    // Top performers by rating
    prisma.player.findMany({
      where: { clubId },
      orderBy: { overallRating: 'desc' },
      take: 5,
      select: {
        id: true, firstName: true, lastName: true,
        number: true, position: true, overallRating: true,
        condition: true, flag: true,
      },
    }),

    // High GPS risk players
    prisma.playerGpsData.findMany({
      where: {
        player: { clubId },
        riskScore: { gte: 70 },
        recordedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      include: {
        player: { select: { id: true, firstName: true, lastName: true, position: true } },
      },
      orderBy: { riskScore: 'desc' },
      take: 5,
    }),
  ]);

  // Win/Draw/Loss counts
  const results = await prisma.match.groupBy({
    by: ['result'],
    where: { clubId, result: { not: null } },
    _count: { id: true },
  });

  const resultMap = Object.fromEntries(
    results.map((r) => [r.result!, r._count.id])
  );

  // Average team condition
  const conditionAvg = await prisma.player.aggregate({
    where: { clubId },
    _avg: { condition: true, overallRating: true },
  });

  return {
    overview: {
      playerCount,
      injuredCount,
      teamCondition: Math.round(conditionAvg._avg.condition ?? 0),
      teamRating: Math.round((conditionAvg._avg.overallRating ?? 0) * 10) / 10,
      wins:   resultMap['WIN']  ?? 0,
      draws:  resultMap['DRAW'] ?? 0,
      losses: resultMap['LOSS'] ?? 0,
    },
    recentMatches,
    gpsAverages,
    topPerformers,
    highRiskPlayers,
  };
}

export async function getPerformanceTrend(clubId: string, weeks = 8) {
  const since = new Date();
  since.setDate(since.getDate() - weeks * 7);

  const matches = await prisma.match.findMany({
    where: { clubId, scheduledAt: { gte: since }, result: { not: null } },
    orderBy: { scheduledAt: 'asc' },
    include: {
      playerStats: {
        select: { goals: true, assists: true, rating: true },
      },
    },
  });

  return matches.map((m) => ({
    date: m.scheduledAt,
    result: m.result,
    goalsScored:   m.homeScore ?? 0,
    goalsConceded: m.awayScore ?? 0,
    avgRating:
      m.playerStats.length > 0
        ? m.playerStats.reduce((s, p) => s + (p.rating ?? 0), 0) / m.playerStats.length
        : null,
  }));
}

export async function getGpsLoadTrend(clubId: string, days = 14) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const data = await prisma.playerGpsData.findMany({
    where: {
      player: { clubId },
      recordedAt: { gte: since },
    },
    orderBy: { recordedAt: 'asc' },
    include: {
      player: { select: { firstName: true, lastName: true, position: true } },
    },
  });

  return data;
}
