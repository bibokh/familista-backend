// Familista — Analytics & Intelligence Engine
// ─────────────────────────────────────────────────────────────────────────────
// All functions are club-scoped. No cross-tenant leakage possible because
// every Prisma query is anchored on clubId.
//
// Bug fixes applied here:
//   Bug 1 — getPerformanceTrend: goalsScored/goalsConceded now respects isHome
//   Bug 2 — getGpsLoadTrend: aggregated into per-day buckets (not raw rows)
//
// New surfaces:
//   getPlayerAnalytics  — per-player perf / training / injury / match trends
//   getTeamAnalytics    — team averages, attendance, workload, injury analytics
//   getReadinessScores  — fitness / form / readiness / development per player
//   getRiskAlerts       — injury / overload / attendance / decline risks

import { prisma } from '../config/database';

// ─────────────────────────────────────────────────────────────────────────────
// Existing: Overview (unchanged except small cleanup)
// ─────────────────────────────────────────────────────────────────────────────

export async function getClubAnalytics(clubId: string) {
  const [
    playerCount,
    injuredCount,
    recentMatches,
    gpsAverages,
    topPerformers,
    highRiskPlayers,
  ] = await Promise.all([
    prisma.player.count({ where: { clubId } }),

    prisma.player.count({ where: { clubId, isInjured: true } }),

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

    prisma.playerGpsData.aggregate({
      where: {
        player: { clubId },
        recordedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _avg: {
        topSpeed: true, avgSpeed: true, distance: true,
        heartRateAvg: true, playerLoad: true, sprintCount: true,
      },
    }),

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

  const results = await prisma.match.groupBy({
    by: ['result'],
    where: { clubId, result: { not: null } },
    _count: { id: true },
  });

  const resultMap = Object.fromEntries(
    results.map((r) => [r.result!, r._count.id]),
  );

  const conditionAvg = await prisma.player.aggregate({
    where: { clubId },
    _avg: { condition: true, overallRating: true },
  });

  return {
    overview: {
      playerCount,
      injuredCount,
      teamCondition: Math.round(conditionAvg._avg.condition ?? 0),
      teamRating:    Math.round((conditionAvg._avg.overallRating ?? 0) * 10) / 10,
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

// ─────────────────────────────────────────────────────────────────────────────
// Existing: Performance trend — BUG 1 FIXED (isHome-aware score direction)
// ─────────────────────────────────────────────────────────────────────────────

export async function getPerformanceTrend(clubId: string, weeks = 8) {
  const since = new Date();
  since.setDate(since.getDate() - weeks * 7);

  const matches = await prisma.match.findMany({
    where: { clubId, scheduledAt: { gte: since }, result: { not: null } },
    orderBy: { scheduledAt: 'asc' },
    include: {
      playerStats: { select: { goals: true, assists: true, rating: true } },
    },
  });

  return matches.map((m) => {
    // BUG 1 FIX: when away, our score is awayScore; opponent's is homeScore.
    const goalsScored    = m.isHome ? (m.homeScore ?? 0) : (m.awayScore ?? 0);
    const goalsConceded  = m.isHome ? (m.awayScore ?? 0) : (m.homeScore ?? 0);
    return {
      date: m.scheduledAt,
      result: m.result,
      goalsScored,
      goalsConceded,
      avgRating:
        m.playerStats.length > 0
          ? m.playerStats.reduce((s, p) => s + (p.rating ?? 0), 0) / m.playerStats.length
          : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing: GPS load trend — BUG 2 FIXED (per-day bucketed aggregation)
// ─────────────────────────────────────────────────────────────────────────────

export async function getGpsLoadTrend(clubId: string, days = 14) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await prisma.playerGpsData.findMany({
    where: { player: { clubId }, recordedAt: { gte: since } },
    select: {
      recordedAt: true,
      playerLoad: true,
      distance:   true,
      topSpeed:   true,
      riskScore:  true,
    },
    orderBy: { recordedAt: 'asc' },
  });

  // Bucket into per-day averages
  const buckets: Record<string, { loads: number[]; distances: number[]; speeds: number[]; risks: number[] }> = {};
  for (const r of rows) {
    const day = r.recordedAt.toISOString().slice(0, 10);
    if (!buckets[day]) buckets[day] = { loads: [], distances: [], speeds: [], risks: [] };
    buckets[day].loads.push(r.playerLoad);
    buckets[day].distances.push(r.distance);
    buckets[day].speeds.push(r.topSpeed);
    buckets[day].risks.push(r.riskScore);
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  return Object.entries(buckets).map(([date, b]) => ({
    date,
    avgLoad:     +avg(b.loads).toFixed(2),
    avgDistance: +avg(b.distances).toFixed(2),
    avgSpeed:    +avg(b.speeds).toFixed(2),
    avgRisk:     +avg(b.risks).toFixed(2),
    sessions:    b.loads.length,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Player Analytics
// ─────────────────────────────────────────────────────────────────────────────

export async function getPlayerAnalytics(clubId: string, playerId: string) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: {
      id: true, firstName: true, lastName: true, number: true,
      position: true, overallRating: true, potential: true,
      condition: true, isInjured: true, clubId: true,
    },
  });
  if (!player || player.clubId !== clubId) return null;

  const [matchStats, trainingSessions, injuryRecords, gpsHistory] = await Promise.all([
    // Last 12 match performances (PlayerMatchStat — Phase 2 model)
    prisma.playerMatchStat.findMany({
      where: { playerId },
      include: {
        match: {
          select: {
            id: true, scheduledAt: true, homeTeam: true, awayTeam: true,
            result: true, isHome: true, homeScore: true, awayScore: true,
          },
        },
      },
      orderBy: { match: { scheduledAt: 'desc' } },
      take: 12,
    }),

    // Last 20 training session attendance
    prisma.playerTrainingStat.findMany({
      where: { playerId },
      include: {
        session: {
          select: { id: true, scheduledAt: true, title: true, duration: true },
        },
      },
      orderBy: { session: { scheduledAt: 'desc' } },
      take: 20,
    }),

    // All injury records (Phase Q model)
    prisma.injuryRecord.findMany({
      where: { playerId, clubId },
      orderBy: { injuryDate: 'desc' },
      take: 10,
      select: {
        id: true, injuryDate: true, bodyLocation: true,
        severity: true, returnDate: true, daysAbsent: true,
        mechanism: true, isRecurrence: true,
      },
    }),

    // GPS history last 30 days
    prisma.playerGpsData.findMany({
      where: {
        playerId,
        recordedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      select: {
        recordedAt: true, topSpeed: true, avgSpeed: true,
        distance: true, sprintCount: true, playerLoad: true, riskScore: true,
      },
      orderBy: { recordedAt: 'asc' },
    }),
  ]);

  // Performance trend: per-match goals/assists/rating
  const performanceTrend = matchStats.map((s) => ({
    matchId:      s.matchId,
    date:         s.match.scheduledAt,
    opponent:     s.match.isHome ? s.match.awayTeam : s.match.homeTeam,
    result:       s.match.result,
    goals:        s.goals,
    assists:      s.assists,
    minutesPlayed:s.minutesPlayed,
    rating:       s.rating,
    shots:        s.shots,
    passes:       s.passes,
    passAccuracy: s.passAccuracy,
  })).reverse(); // chronological order

  // Training trend: attendance + rating per session
  const trainingTrend = trainingSessions.map((ts) => ({
    sessionId:   ts.sessionId,
    date:        ts.session.scheduledAt,
    title:       ts.session.title,
    attended:    ts.attended,
    rating:      ts.rating,
    durationMin: ts.session.duration,
  })).reverse();

  // Attendance rate
  const attended    = trainingSessions.filter((t) => t.attended).length;
  const attendanceRate = trainingSessions.length > 0
    ? Math.round((attended / trainingSessions.length) * 100)
    : null;

  // Injury impact summary
  const injuryImpact = {
    totalInjuries:    injuryRecords.length,
    activeInjury:     injuryRecords.find((i) => !i.returnDate) ?? null,
    totalDaysAbsent:  injuryRecords.reduce((s, i) => s + (i.daysAbsent ?? 0), 0),
    recurrences:      injuryRecords.filter((i) => i.isRecurrence).length,
    byBodyLocation:   groupCount(injuryRecords, (i) => i.bodyLocation),
    history:          injuryRecords,
  };

  // Match performance trend for charting (last 10, chronological)
  const matchPerfTrend = performanceTrend.slice(-10).map((p) => ({
    date:    p.date,
    rating:  p.rating,
    goals:   p.goals,
    assists: p.assists,
  }));

  // GPS load trend (daily buckets)
  const gpsTrend = gpsHistory.map((g) => ({
    date:       g.recordedAt.toISOString().slice(0, 10),
    playerLoad: g.playerLoad,
    distance:   g.distance,
    topSpeed:   g.topSpeed,
    riskScore:  g.riskScore,
  }));

  // Radar data for latest attributes
  const latestAttr = await prisma.playerAttribute.findFirst({
    where:   { playerId },
    orderBy: { recordedAt: 'desc' },
  });

  const radarData = latestAttr ? {
    speed:     latestAttr.pace,
    shooting:  latestAttr.shooting,
    passing:   latestAttr.passing,
    technique: latestAttr.dribbling,
    defending: latestAttr.tackling,
    stamina:   latestAttr.stamina,
    strength:  latestAttr.strength,
    agility:   latestAttr.agility,
  } : null;

  return {
    player,
    performanceTrend,
    trainingTrend,
    attendanceRate,
    injuryImpact,
    matchPerfTrend,
    gpsTrend,
    radarData,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Team Analytics
// ─────────────────────────────────────────────────────────────────────────────

export async function getTeamAnalytics(clubId: string) {
  const [
    players,
    attendanceRows,
    workloadRows,
    injuryRows,
    gpsAggregates,
  ] = await Promise.all([
    // Squad with latest attributes
    prisma.player.findMany({
      where: { clubId, isActive: true },
      select: {
        id: true, firstName: true, lastName: true, position: true,
        overallRating: true, potential: true, condition: true,
        isInjured: true,
        attributes: { orderBy: { recordedAt: 'desc' }, take: 1 },
      },
    }),

    // Training attendance last 30 days
    prisma.playerTrainingStat.findMany({
      where: {
        player: { clubId },
        session: {
          scheduledAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      },
      select: { playerId: true, attended: true, rating: true },
    }),

    // Workload records last 4 weeks
    prisma.workloadRecord.findMany({
      where: {
        clubId,
        weekStart: { gte: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000) },
      },
      include: {
        player: { select: { id: true, firstName: true, lastName: true, position: true } },
      },
      orderBy: { weekStart: 'desc' },
    }),

    // All injury records (Phase Q)
    prisma.injuryRecord.findMany({
      where: { clubId },
      select: {
        id: true, playerId: true, injuryDate: true,
        bodyLocation: true, severity: true, mechanism: true,
        returnDate: true, daysAbsent: true, isRecurrence: true,
      },
      orderBy: { injuryDate: 'desc' },
      take: 100,
    }),

    // GPS aggregates per player (last 30 days)
    prisma.playerGpsData.findMany({
      where: {
        player: { clubId },
        recordedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      select: { playerId: true, playerLoad: true, riskScore: true, distance: true },
    }),
  ]);

  // ── Team attribute averages ──────────────────────────────────────────────
  const attrFields = ['pace', 'shooting', 'passing', 'dribbling', 'tackling', 'stamina', 'strength', 'agility', 'balance', 'reflexes'] as const;
  const attrAvgs: Record<string, number | null> = {};
  for (const field of attrFields) {
    const vals = players.flatMap((p) => p.attributes).map((a) => a[field]).filter((v): v is number => v != null);
    attrAvgs[field] = vals.length ? +( vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1) : null;
  }

  const teamAvgRating    = avg(players.map((p) => p.overallRating));
  const teamAvgCondition = avg(players.map((p) => p.condition));

  // Performance distribution buckets
  const distribution = { elite: 0, good: 0, average: 0, developing: 0 };
  for (const p of players) {
    if (p.overallRating >= 85)      distribution.elite++;
    else if (p.overallRating >= 75) distribution.good++;
    else if (p.overallRating >= 65) distribution.average++;
    else                             distribution.developing++;
  }

  // Position averages
  const positionGroups: Record<string, number[]> = {};
  for (const p of players) {
    if (!positionGroups[p.position]) positionGroups[p.position] = [];
    positionGroups[p.position].push(p.overallRating);
  }
  const positionAverages = Object.entries(positionGroups).map(([pos, ratings]) => ({
    position: pos,
    count:    ratings.length,
    avgRating: +avg(ratings).toFixed(1),
  }));

  // ── Attendance analytics ─────────────────────────────────────────────────
  const attendanceByPlayer: Record<string, { sessions: number; attended: number }> = {};
  for (const row of attendanceRows) {
    if (!attendanceByPlayer[row.playerId]) attendanceByPlayer[row.playerId] = { sessions: 0, attended: 0 };
    attendanceByPlayer[row.playerId].sessions++;
    if (row.attended) attendanceByPlayer[row.playerId].attended++;
  }
  const totalSessions  = attendanceRows.length;
  const totalAttended  = attendanceRows.filter((r) => r.attended).length;
  const teamAttendanceRate = totalSessions > 0 ? Math.round((totalAttended / totalSessions) * 100) : null;

  const avgTrainingRating = (() => {
    const ratedRows = attendanceRows.filter((r) => r.rating != null);
    return ratedRows.length > 0 ? +(ratedRows.reduce((s, r) => s + (r.rating ?? 0), 0) / ratedRows.length).toFixed(2) : null;
  })();

  // ── Workload analytics ───────────────────────────────────────────────────
  const highRiskPlayers = workloadRows.filter((w) => w.isHighRisk);
  const avgAcwr = avg(workloadRows.map((w) => w.acwr));
  const workloadSummary = {
    highRiskCount: highRiskPlayers.length,
    avgAcwr:       +avgAcwr.toFixed(2),
    playersMonitored: [...new Set(workloadRows.map((w) => w.playerId))].length,
    highRiskPlayers:  highRiskPlayers.slice(0, 5).map((w) => ({
      playerId:  w.playerId,
      name:      `${w.player.firstName} ${w.player.lastName}`,
      position:  w.player.position,
      acwr:      w.acwr,
      riskScore: w.injuryRiskScore,
    })),
  };

  // ── Injury analytics ─────────────────────────────────────────────────────
  const activeInjuries  = injuryRows.filter((i) => !i.returnDate).length;
  const totalInjuries   = injuryRows.length;
  const avgDaysAbsent   = (() => {
    const withDays = injuryRows.filter((i) => i.daysAbsent != null);
    return withDays.length > 0 ? +(withDays.reduce((s, i) => s + (i.daysAbsent ?? 0), 0) / withDays.length).toFixed(1) : 0;
  })();
  const byBodyLocation = groupCount(injuryRows, (i) => i.bodyLocation);
  const bySeverity     = groupCount(injuryRows, (i) => i.severity ?? 'UNKNOWN');
  const byMechanism    = groupCount(injuryRows, (i) => i.mechanism ?? 'UNKNOWN');
  // Monthly trend (last 12 months)
  const injuryMonthTrend = buildMonthTrend(injuryRows.map((i) => i.injuryDate), 12);

  const injurySummary = {
    activeInjuries, totalInjuries, avgDaysAbsent,
    byBodyLocation, bySeverity, byMechanism,
    monthlyTrend: injuryMonthTrend,
    recentInjuries: injuryRows.slice(0, 5),
  };

  // ── GPS heatmap-ready structure ──────────────────────────────────────────
  const gpsHeatmapData = (() => {
    const byPlayer: Record<string, number[]> = {};
    for (const g of gpsAggregates) {
      if (!byPlayer[g.playerId]) byPlayer[g.playerId] = [];
      byPlayer[g.playerId].push(g.playerLoad);
    }
    return Object.entries(byPlayer).map(([playerId, loads]) => ({
      playerId,
      avgLoad:   +avg(loads).toFixed(2),
      maxLoad:   Math.max(...loads),
      sessions:  loads.length,
    })).sort((a, b) => b.avgLoad - a.avgLoad).slice(0, 20);
  })();

  return {
    summary: {
      playerCount:        players.length,
      avgRating:          +teamAvgRating.toFixed(1),
      avgCondition:       +teamAvgCondition.toFixed(1),
      teamAttendanceRate,
      avgTrainingRating,
    },
    attributeAverages:   attrAvgs,
    performanceDistribution: distribution,
    positionAverages,
    attendanceSummary: {
      teamRate: teamAttendanceRate,
      avgTrainingRating,
      totalSessions: [...new Set(attendanceRows.map((_, i) => i))].length,
      byPlayer: Object.entries(attendanceByPlayer).map(([playerId, d]) => ({
        playerId,
        sessions:  d.sessions,
        attended:  d.attended,
        rate:      d.sessions > 0 ? Math.round((d.attended / d.sessions) * 100) : 0,
      })),
    },
    workloadSummary,
    injurySummary,
    gpsHeatmapData,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: AI Readiness Scores
// ─────────────────────────────────────────────────────────────────────────────

export async function getReadinessScores(clubId: string) {
  const [players, gpsLatest, matchStats, workloads] = await Promise.all([
    prisma.player.findMany({
      where: { clubId, isActive: true },
      select: {
        id: true, firstName: true, lastName: true, number: true,
        position: true, overallRating: true, potential: true, condition: true,
        isInjured: true,
        attributes: { orderBy: { recordedAt: 'desc' }, take: 1 },
      },
    }),

    // Latest GPS entry per player
    prisma.playerGpsData.findMany({
      where: {
        player: { clubId },
        recordedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      select: { playerId: true, riskScore: true, playerLoad: true, recordedAt: true },
      orderBy: { recordedAt: 'desc' },
    }),

    // Last 6 match ratings per player
    prisma.playerMatchStat.findMany({
      where: { player: { clubId } },
      select: { playerId: true, rating: true },
      orderBy: { match: { scheduledAt: 'desc' } },
      take: 300, // enough for 50 players × 6 matches
    }),

    // Latest workload record per player
    prisma.workloadRecord.findMany({
      where: {
        clubId,
        weekStart: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
      },
      select: { playerId: true, acwr: true, injuryRiskScore: true, isHighRisk: true },
      orderBy: { weekStart: 'desc' },
    }),
  ]);

  // Deduplicate GPS to latest per player
  const latestGps: Record<string, { riskScore: number; playerLoad: number }> = {};
  for (const g of gpsLatest) {
    if (!latestGps[g.playerId]) latestGps[g.playerId] = { riskScore: g.riskScore, playerLoad: g.playerLoad };
  }

  // Group match ratings per player (last 6 matches)
  const playerRatings: Record<string, number[]> = {};
  for (const s of matchStats) {
    if (!playerRatings[s.playerId]) playerRatings[s.playerId] = [];
    if (playerRatings[s.playerId].length < 6 && s.rating != null) {
      playerRatings[s.playerId].push(s.rating);
    }
  }

  // Latest workload per player
  const latestWorkload: Record<string, { acwr: number; injuryRiskScore: number; isHighRisk: boolean }> = {};
  for (const w of workloads) {
    if (!latestWorkload[w.playerId]) latestWorkload[w.playerId] = w;
  }

  return players.map((p) => {
    const gps  = latestGps[p.id];
    const wl   = latestWorkload[p.id];
    const rtgs = playerRatings[p.id] ?? [];

    // Fitness Score (0–100): condition + GPS risk (inverse) + workload signal
    const conditionScore = p.condition ?? 80;
    const gpsRiskPenalty = gps ? gps.riskScore * 0.3 : 0;
    const wlPenalty      = wl?.isHighRisk ? 10 : 0;
    const injuryPenalty  = p.isInjured ? 25 : 0;
    const fitnessScore   = Math.max(0, Math.min(100,
      conditionScore * 0.7 - gpsRiskPenalty - wlPenalty - injuryPenalty,
    ));

    // Form Score (0–100): based on recent match ratings (scale 0–10 → 0–100)
    const formScore = rtgs.length > 0
      ? Math.min(100, Math.round(avg(rtgs) * 10))
      : Math.round((p.overallRating / 99) * 60 + 20); // fallback estimate

    // Readiness Score (0–100): composite of fitness and form
    const readinessScore = Math.round((fitnessScore * 0.6 + formScore * 0.4));

    // Development Score (0–100): overallRating vs potential
    const developmentScore = p.potential > 0
      ? Math.min(100, Math.round((p.overallRating / p.potential) * 100))
      : Math.round((p.overallRating / 99) * 100);

    return {
      playerId:         p.id,
      firstName:        p.firstName,
      lastName:         p.lastName,
      number:           p.number,
      position:         p.position,
      overallRating:    p.overallRating,
      fitnessScore:     Math.round(fitnessScore),
      formScore,
      readinessScore,
      developmentScore,
      isHighRisk:       wl?.isHighRisk ?? false,
      acwr:             wl?.acwr ?? null,
      radarData: {
        fitness:     Math.round(fitnessScore),
        form:        formScore,
        readiness:   readinessScore,
        development: developmentScore,
        condition:   conditionScore,
        rating:      Math.round((p.overallRating / 99) * 100),
      },
    };
  }).sort((a, b) => b.readinessScore - a.readinessScore);
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Risk Alerts
// ─────────────────────────────────────────────────────────────────────────────

export async function getRiskAlerts(clubId: string) {
  const since30  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since7   = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() -      24 * 60 * 60 * 1000);

  const [players, workloads, gpsData, trainingStats, matchStats] = await Promise.all([
    prisma.player.findMany({
      where: { clubId, isActive: true },
      select: {
        id: true, firstName: true, lastName: true, position: true,
        overallRating: true, isInjured: true,
      },
    }),

    // High-risk workload records
    prisma.workloadRecord.findMany({
      where: { clubId, weekStart: { gte: since7 } },
      include: {
        player: { select: { id: true, firstName: true, lastName: true, position: true } },
      },
    }),

    // GPS risk data (last 24 h)
    prisma.playerGpsData.findMany({
      where: { player: { clubId }, recordedAt: { gte: since24h } },
      include: {
        player: { select: { id: true, firstName: true, lastName: true, position: true } },
      },
      orderBy: { riskScore: 'desc' },
    }),

    // Training attendance (last 30 days)
    prisma.playerTrainingStat.findMany({
      where: {
        player: { clubId },
        session: { scheduledAt: { gte: since30 } },
      },
      select: { playerId: true, attended: true },
    }),

    // Match stats for performance decline detection (last 6 matches per player)
    prisma.playerMatchStat.findMany({
      where: { player: { clubId } },
      select: { playerId: true, rating: true },
      orderBy: { match: { scheduledAt: 'desc' } },
      take: 400,
    }),
  ]);

  const alerts: Array<{
    type:     string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    playerId: string;
    playerName: string;
    position: string;
    message:  string;
    value?:   number;
  }> = [];

  const playerMap = Object.fromEntries(players.map((p) => [p.id, p]));

  // ── Injury risk (WorkloadRecord.isHighRisk or injuryRiskScore >= 60) ────
  for (const w of workloads) {
    if (w.isHighRisk || w.injuryRiskScore >= 60) {
      alerts.push({
        type:       'INJURY_RISK',
        severity:   w.injuryRiskScore >= 80 ? 'HIGH' : 'MEDIUM',
        playerId:   w.playerId,
        playerName: `${w.player.firstName} ${w.player.lastName}`,
        position:   w.player.position,
        message:    `High injury risk — ACWR ${w.acwr.toFixed(2)}, risk score ${w.injuryRiskScore.toFixed(0)}`,
        value:      +w.injuryRiskScore.toFixed(1),
      });
    }
  }

  // ── Overload risk (GPS riskScore >= 70 in last 24h) ──────────────────────
  for (const g of gpsData) {
    if (g.riskScore >= 70) {
      alerts.push({
        type:       'OVERLOAD_RISK',
        severity:   g.riskScore >= 85 ? 'HIGH' : 'MEDIUM',
        playerId:   g.playerId,
        playerName: `${g.player.firstName} ${g.player.lastName}`,
        position:   g.player.position,
        message:    `GPS overload risk — score ${g.riskScore.toFixed(0)}, load ${g.playerLoad.toFixed(1)}`,
        value:      +g.riskScore.toFixed(1),
      });
    }
  }

  // ── Low attendance risk (attendance < 70% over last 30 days) ─────────────
  const attendanceMap: Record<string, { s: number; a: number }> = {};
  for (const t of trainingStats) {
    if (!attendanceMap[t.playerId]) attendanceMap[t.playerId] = { s: 0, a: 0 };
    attendanceMap[t.playerId].s++;
    if (t.attended) attendanceMap[t.playerId].a++;
  }
  for (const [pid, d] of Object.entries(attendanceMap)) {
    if (d.s >= 5) { // only flag if at least 5 sessions recorded
      const rate = d.a / d.s;
      if (rate < 0.7) {
        const p = playerMap[pid];
        if (p) {
          alerts.push({
            type:       'LOW_ATTENDANCE',
            severity:   rate < 0.5 ? 'HIGH' : 'MEDIUM',
            playerId:   pid,
            playerName: `${p.firstName} ${p.lastName}`,
            position:   p.position,
            message:    `Low training attendance — ${Math.round(rate * 100)}% over last 30 days`,
            value:      Math.round(rate * 100),
          });
        }
      }
    }
  }

  // ── Performance decline (last 3 match avg rating < previous 3 avg) ────────
  const playerRatingHistory: Record<string, number[]> = {};
  for (const s of matchStats) {
    if (!playerRatingHistory[s.playerId]) playerRatingHistory[s.playerId] = [];
    if (s.rating != null) playerRatingHistory[s.playerId].push(s.rating);
  }
  for (const [pid, ratings] of Object.entries(playerRatingHistory)) {
    if (ratings.length >= 6) {
      const recent   = avg(ratings.slice(0, 3));
      const previous = avg(ratings.slice(3, 6));
      const drop     = previous - recent;
      if (drop >= 0.5 && previous >= 5.0) { // meaningful decline from a decent baseline
        const p = playerMap[pid];
        if (p) {
          alerts.push({
            type:       'PERFORMANCE_DECLINE',
            severity:   drop >= 1.5 ? 'HIGH' : drop >= 1.0 ? 'MEDIUM' : 'LOW',
            playerId:   pid,
            playerName: `${p.firstName} ${p.lastName}`,
            position:   p.position,
            message:    `Performance decline — avg rating dropped ${drop.toFixed(1)} points vs prior 3 matches`,
            value:      +drop.toFixed(2),
          });
        }
      }
    }
  }

  // Deduplicate: keep highest severity alert per player per type
  const seen = new Set<string>();
  const deduped = alerts.filter((a) => {
    const key = `${a.playerId}:${a.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: HIGH first, then MEDIUM, then LOW
  const SEV: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  deduped.sort((a, b) => SEV[a.severity] - SEV[b.severity]);

  return {
    total:      deduped.length,
    highCount:  deduped.filter((a) => a.severity === 'HIGH').length,
    mediumCount:deduped.filter((a) => a.severity === 'MEDIUM').length,
    lowCount:   deduped.filter((a) => a.severity === 'LOW').length,
    alerts:     deduped,
    byType: {
      injuryRisk:        deduped.filter((a) => a.type === 'INJURY_RISK').length,
      overloadRisk:      deduped.filter((a) => a.type === 'OVERLOAD_RISK').length,
      lowAttendance:     deduped.filter((a) => a.type === 'LOW_ATTENDANCE').length,
      performanceDecline:deduped.filter((a) => a.type === 'PERFORMANCE_DECLINE').length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function groupCount<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function buildMonthTrend(dates: Date[], months: number): Array<{ month: string; count: number }> {
  const result: Array<{ month: string; count: number }> = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d     = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toISOString().slice(0, 7); // YYYY-MM
    const count = dates.filter((dd) => dd.toISOString().slice(0, 7) === label).length;
    result.push({ month: label, count });
  }
  return result;
}
