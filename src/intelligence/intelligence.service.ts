// Familista — AI Intelligence Service (Phase S.2)
// Target: src/intelligence/intelligence.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Assembles rich domain context from existing platform data, creates
// AIAgentJob rows (picked up by the ai-agent.worker), and exposes typed
// read APIs for the frontend Intelligence Center.
//
// Five intelligence domains:
//   1. MATCH_ANALYSIS   — post-match LLM report (MATCH_OPS agent)
//   2. TACTICAL_ADVISOR — formation/system recommendations (TACTICAL agent)
//   3. RECRUITMENT      — transfer target ranking + squad gaps (SCOUTING agent)
//   4. TRAINING_PLANNER — 7-day microcycle from squad state (TRAINING agent)
//   5. INJURY_RISK_SCAN — risk prediction from workload (MEDICAL agent)
//
// Design:
//   • Context assembly is best-effort — missing Phase Q data degrades the
//     prompt gracefully rather than throwing.
//   • Jobs are returned immediately (status PENDING); the frontend polls.
//   • Deduplication: if a SUCCESS job for the same (clubId, domain, entityId)
//     was completed in the last 30 min, it is returned directly (no new job).

import { Prisma } from '@prisma/client';
import { prisma }  from '../config/database';
import { NotFoundError } from '../utils/errors';

export interface IntelligenceActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─── Domain constants ─────────────────────────────────────────────────────────

const KIND = {
  MATCH_ANALYSIS:   'INTELLIGENCE.MATCH_ANALYSIS',
  TACTICAL_ADVISOR: 'INTELLIGENCE.TACTICAL_ADVISOR',
  RECRUITMENT:      'INTELLIGENCE.RECRUITMENT',
  TRAINING_PLANNER: 'INTELLIGENCE.TRAINING_PLANNER',
  INJURY_RISK:      'INTELLIGENCE.INJURY_RISK_SCAN',
} as const;

const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 min

// ─────────────────────────────────────────────────────────────────────────────
// 1. Match Analysis
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerMatchAnalysis(
  actor:   IntelligenceActor,
  matchId: string,
) {
  // Dedup check.
  const recent = await _findRecentJob(actor.clubId, KIND.MATCH_ANALYSIS, matchId);
  if (recent) return recent;

  // Assemble context.
  const match = await prisma.match.findFirst({
    where: { id: matchId },
  });
  if (!match) throw new NotFoundError('Match');

  const playerStats = await prisma.playerMatchStat.findMany({
    where:   { matchId },
    include: {
      player: {
        select: { firstName: true, lastName: true, position: true },
      },
    },
    take: 30,
  });

  // Try to get Phase Q events if available (graceful — table may not exist yet).
  let eventSummary: unknown = null;
  try {
    const events = await (prisma as any).matchEvent?.findMany?.({
      where: { matchId },
      take:  50,
    });
    if (events?.length) {
      eventSummary = events.reduce((acc: Record<string, number>, e: { type: string }) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1; return acc;
      }, {});
    }
  } catch { /* Phase Q not yet applied */ }

  const context = {
    match: {
      id:        match.id,
      homeTeam:  (match as any).homeTeam  ?? (match as any).title ?? 'Home',
      awayTeam:  (match as any).awayTeam  ?? 'Away',
      date:      (match as any).date      ?? (match as any).startTime ?? null,
      homeScore: (match as any).homeScore ?? null,
      awayScore: (match as any).awayScore ?? null,
      status:    (match as any).status    ?? null,
      competition: (match as any).competition ?? null,
    },
    playerStats: playerStats.map((ps) => ({
      player:       ps.player ? `${ps.player.firstName} ${ps.player.lastName}` : ps.playerId,
      position:     ps.player?.position ?? null,
      minutes:      ps.minutesPlayed,
      goals:        ps.goals,
      assists:      ps.assists,
      shots:        ps.shots,
      passes:       ps.passes,
      passAccuracy: ps.passAccuracy,
      tackles:      ps.tackles,
      rating:       ps.rating,
    })),
    eventSummary,
  };

  return _createJob(actor, 'MATCH_OPS', KIND.MATCH_ANALYSIS, context, matchId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tactical Advisor
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerTacticalAdvisor(
  actor:  IntelligenceActor,
  teamId: string,
) {
  const recent = await _findRecentJob(actor.clubId, KIND.TACTICAL_ADVISOR, teamId);
  if (recent) return recent;

  const team = await prisma.team.findFirst({
    where:   { id: teamId, clubId: actor.clubId },
    include: {
      players: {
        where:  { isActive: true },
        select: { id: true, firstName: true, lastName: true, position: true, number: true },
        take:   30,
      },
    },
  });
  if (!team) throw new NotFoundError('Team');

  const recentMatches = await prisma.match.findMany({
    where:   { clubId: actor.clubId },
    orderBy: { createdAt: 'desc' },
    take:    5,
    select: {
      id:        true,
      status:    true,
      createdAt: true,
    },
  });

  const context = {
    team: {
      id:       team.id,
      name:     team.name,
      kind:     team.kind,
      squad:    team.players.map((p) => ({
        name:     `${p.firstName} ${p.lastName}`,
        position: p.position,
        number:   p.number,
      })),
    },
    recentMatches: recentMatches.map((m) => ({
      id:        m.id,
      homeTeam:  (m as any).homeTeam  ?? null,
      awayTeam:  (m as any).awayTeam  ?? null,
      homeScore: (m as any).homeScore ?? null,
      awayScore: (m as any).awayScore ?? null,
      date:      (m as any).date      ?? m.createdAt,
    })),
    request: 'Analyse current squad composition, recent results, and recommend tactical system + formation with rationale.',
  };

  return _createJob(actor, 'TACTICAL', KIND.TACTICAL_ADVISOR, context, teamId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Recruitment Advisor
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerRecruitmentAdvisor(actor: IntelligenceActor) {
  const recent = await _findRecentJob(actor.clubId, KIND.RECRUITMENT, actor.clubId);
  if (recent) return recent;

  // Squad composition — understand what positions are thin.
  const players = await prisma.player.findMany({
    where:  { clubId: actor.clubId, isActive: true },
    select: { firstName: true, lastName: true, position: true, dateOfBirth: true, nationality: true },
    take:   50,
  });

  // Transfer targets if Phase Q is available.
  let transferTargets: unknown[] = [];
  try {
    const targets = await (prisma as any).transferTarget?.findMany?.({
      where: { clubId: actor.clubId },
      take:  20,
    });
    if (targets) transferTargets = targets;
  } catch { /* Phase Q not applied */ }

  // Scouting reports if available.
  let scoutingReports: unknown[] = [];
  try {
    const reports = await (prisma as any).scoutingReport?.findMany?.({
      where:   { clubId: actor.clubId },
      orderBy: { createdAt: 'desc' },
      take:    10,
    });
    if (reports) scoutingReports = reports;
  } catch { /* Phase Q not applied */ }

  // Position gap analysis.
  const positionCounts: Record<string, number> = {};
  for (const p of players) {
    const pos = String(p.position);
    positionCounts[pos] = (positionCounts[pos] ?? 0) + 1;
  }

  const context = {
    squadSize:       players.length,
    positionCounts,
    ageProfile:      _ageProfile(players),
    transferTargets: (transferTargets as any[]).map((t) => ({
      name:        t.externalPlayerName ?? null,
      position:    t.position    ?? null,
      age:         t.age         ?? null,
      stage:       t.stage       ?? null,
      priority:    t.priority    ?? null,
      marketValue: t.marketValue ?? null,
    })),
    scoutingReports: (scoutingReports as any[]).map((r) => ({
      player:         r.externalPlayerName ?? null,
      overallScore:   r.overallScore       ?? null,
      technicalScore: r.technicalScore     ?? null,
      physicalScore:  r.physicalScore      ?? null,
      mentalScore:    r.mentalScore        ?? null,
      recommendation: r.recommendation    ?? null,
    })),
  };

  return _createJob(actor, 'SCOUTING', KIND.RECRUITMENT, context, actor.clubId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Training Planner
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerTrainingPlanner(
  actor:  IntelligenceActor,
  teamId: string,
) {
  const recent = await _findRecentJob(actor.clubId, KIND.TRAINING_PLANNER, teamId);
  if (recent) return recent;

  const team = await prisma.team.findFirst({
    where:   { id: teamId, clubId: actor.clubId },
    include: {
      players: {
        where:  { isActive: true },
        select: { id: true, firstName: true, lastName: true, position: true },
        take:   30,
      },
    },
  });
  if (!team) throw new NotFoundError('Team');

  // Squad readiness from Phase Q workload (graceful degradation).
  let workloadData: unknown[] = [];
  try {
    const records = await (prisma as any).workloadRecord?.findMany?.({
      where:    { playerId: { in: team.players.map((p: { id: string }) => p.id) } },
      orderBy:  { recordedAt: 'desc' },
      take:     team.players.length,
      distinct: ['playerId'],
    });
    if (records) workloadData = records;
  } catch { /* Phase Q not yet applied */ }

  // Upcoming matches in next 7 days.
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const upcomingMatches = await prisma.match.findMany({
    where: {
      clubId:    actor.clubId,
      createdAt: { lte: nextWeek },
      status:    'SCHEDULED' as any,
    },
    orderBy: { createdAt: 'asc' },
    take:    3,
    select:  { id: true, createdAt: true },
  });

  const context = {
    team: {
      name:    team.name,
      players: team.players.map((p: { id: string; firstName: string; lastName: string; position: string }) => ({
        name:     `${p.firstName} ${p.lastName}`,
        position: p.position,
        workload: (workloadData as any[]).find((w) => w.playerId === p.id),
      })),
    },
    upcomingMatches: upcomingMatches.map((m) => ({
      homeTeam: (m as any).homeTeam ?? null,
      awayTeam: (m as any).awayTeam ?? null,
      date:     (m as any).date     ?? m.createdAt,
    })),
    request: 'Generate a 7-day training microcycle (Mon-Sun) with session types, intensities, durations, and focus areas. Account for upcoming matches and player workload where available.',
  };

  return _createJob(actor, 'TRAINING', KIND.TRAINING_PLANNER, context, teamId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Injury Risk Scan
// ─────────────────────────────────────────────────────────────────────────────

export async function triggerInjuryRiskScan(
  actor:  IntelligenceActor,
  teamId: string,
) {
  const recent = await _findRecentJob(actor.clubId, KIND.INJURY_RISK, teamId);
  if (recent) return recent;

  const team = await prisma.team.findFirst({
    where:   { id: teamId, clubId: actor.clubId },
    include: {
      players: {
        where:  { isActive: true },
        select: { id: true, firstName: true, lastName: true, position: true, dateOfBirth: true },
        take:   30,
      },
    },
  });
  if (!team) throw new NotFoundError('Team');

  // ACWR/workload data from Phase Q.
  let workloadRecords: unknown[] = [];
  try {
    const recs = await (prisma as any).workloadRecord?.findMany?.({
      where:    { playerId: { in: team.players.map((p: { id: string }) => p.id) } },
      orderBy:  { recordedAt: 'desc' },
      take:     team.players.length,
      distinct: ['playerId'],
      select:   { playerId: true, acwr: true, isHighRisk: true, acuteLoad: true, chronicLoad: true, trainingStressBalance: true },
    });
    if (recs) workloadRecords = recs;
  } catch { /* Phase Q not applied */ }

  // Active injuries.
  let activeInjuries: unknown[] = [];
  try {
    const injuries = await (prisma as any).injuryRecord?.findMany?.({
      where:   { clubId: actor.clubId, actualReturn: null },
      orderBy: { dateOccurred: 'desc' },
      take:    20,
    });
    if (injuries) activeInjuries = injuries;
  } catch { /* Phase Q not applied */ }

  const context = {
    team:    team.name,
    players: team.players.map((p: { id: string; firstName: string; lastName: string; position: string; dateOfBirth: Date }) => {
      const wl = (workloadRecords as any[]).find((w) => w.playerId === p.id);
      return {
        name:       `${p.firstName} ${p.lastName}`,
        position:   p.position,
        age:        p.dateOfBirth ? _ageFromDob(p.dateOfBirth) : null,
        acwr:       wl?.acwr      ?? null,
        isHighRisk: wl?.isHighRisk ?? null,
        atl:        wl?.acuteLoad  ?? null,
        ctl:        wl?.chronicLoad ?? null,
        tsb:        wl?.trainingStressBalance ?? null,
      };
    }),
    activeInjuries: (activeInjuries as any[]).map((i) => ({
      player:         i.playerId       ?? null,
      injuryType:     i.injuryType     ?? null,
      severity:       i.severity       ?? null,
      dateOccurred:   i.dateOccurred   ?? null,
      expectedReturn: i.expectedReturn ?? null,
    })),
    request: 'Identify players at elevated injury risk, explain the mechanism, and recommend protective measures (load reduction, rest, targeted conditioning).',
  };

  return _createJob(actor, 'MEDICAL', KIND.INJURY_RISK, context, teamId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read APIs
// ─────────────────────────────────────────────────────────────────────────────

export async function listJobs(
  actor:  IntelligenceActor,
  domain: string,
  limit = 20,
) {
  const kindMap: Record<string, string> = {
    match_analysis:   KIND.MATCH_ANALYSIS,
    tactical_advisor: KIND.TACTICAL_ADVISOR,
    recruitment:      KIND.RECRUITMENT,
    training_planner: KIND.TRAINING_PLANNER,
    injury_risk:      KIND.INJURY_RISK,
  };
  const kind = domain ? (kindMap[domain.toLowerCase()] ?? domain) : undefined;

  return prisma.aIAgentJob.findMany({
    where: {
      clubId: actor.clubId,
      ...(kind ? { kind } : { kind: { startsWith: 'INTELLIGENCE.' } }),
    },
    orderBy: { createdAt: 'desc' },
    take:    Math.min(limit, 50),
  });
}

export async function getJob(actor: IntelligenceActor, jobId: string) {
  const job = await prisma.aIAgentJob.findUnique({ where: { id: jobId } });
  if (!job || job.clubId !== actor.clubId) throw new NotFoundError('AIAgentJob');
  return job;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _createJob(
  actor:    IntelligenceActor,
  agent:    string,
  kind:     string,
  context:  unknown,
  entityId: string,
) {
  return prisma.aIAgentJob.create({
    data: {
      clubId: actor.clubId,
      agent:  agent as any,
      kind,
      input: {
        entityId,
        triggeredBy: actor.userId,
        context,
        requestedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
}

async function _findRecentJob(clubId: string, kind: string, entityId: string) {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
  return prisma.aIAgentJob.findFirst({
    where: {
      clubId,
      kind,
      status:    'SUCCESS',
      createdAt: { gte: cutoff },
      input:     { path: ['entityId'], equals: entityId },
    },
    orderBy: { createdAt: 'desc' },
  });
}

function _ageFromDob(dob: Date | string): number {
  const birth = dob instanceof Date ? dob : new Date(dob);
  return Math.floor((Date.now() - birth.getTime()) / (365.25 * 24 * 3600 * 1000));
}

function _ageProfile(players: Array<{ dateOfBirth: Date | string | null }>): Record<string, number> {
  const profile: Record<string, number> = { U18: 0, U21: 0, U25: 0, U30: 0, '30+': 0, unknown: 0 };
  for (const p of players) {
    if (!p.dateOfBirth) { profile.unknown++; continue; }
    const age = _ageFromDob(p.dateOfBirth);
    if      (age < 18) profile.U18++;
    else if (age < 21) profile.U21++;
    else if (age < 25) profile.U25++;
    else if (age < 30) profile.U30++;
    else               profile['30+']++;
  }
  return profile;
}
