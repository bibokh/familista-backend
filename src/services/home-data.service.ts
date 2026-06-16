// Familista — Home Dashboard data service
// Single entry point: getDashboard(clubId, userId) → HomeDashboard
// All DB queries are centralised here; the controller and UI touch nothing else.

import {
  MatchResult,
  MatchStatus,
  PlayerAuditAction,
  MatchAuditAction,
  UserRole,
} from '@prisma/client';
import { prisma } from '../config/database';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HomeActivity {
  icon:    string;
  text:    string;
  time:    string;  // relative ("2h ago")
  rawTime: string;  // ISO-8601
}

export interface HomeAnnouncement {
  id:       string;
  title:    string;
  body:     string;
  priority: string; // "high" | "normal" | "low"
  date:     string;
}

export interface HomeNextMatch {
  id:          string;
  opponent:    string;
  homeTeam:    string;
  awayTeam:    string;
  isHome:      boolean;
  date:        string;
  time:        string;
  status:      string;
  competition: string;
  venue:       string | null;
}

export interface HomeTraining {
  next: {
    id:       string;
    title:    string;
    date:     string;
    time:     string;
    venue:    string | null;
  } | null;
  attendanceRate: number;
  lastSession: {
    id:       string;
    title:    string;
    date:     string;
    attended: number;
    total:    number;
  } | null;
}

export interface HomeStats {
  players: number;
  coaches: number;
  matches: number;
  wins:    number;
  draws:   number;
  losses:  number;
}

export interface HomeInfo {
  founded:  string;
  location: string;
  members:  number;
  teams:    number;
  season:   string;
}

export interface HomeHeader {
  clubId:    string;
  clubName:  string;
  shortName: string | null;
  emblem:    string | null;
  ownerName: string;
  location:  string;
}

export interface HomeDashboard {
  header:        HomeHeader;
  info:          HomeInfo;
  stats:         HomeStats;
  nextMatch:     HomeNextMatch | null;
  training:      HomeTraining;
  activity:      HomeActivity[];
  announcements: HomeAnnouncement[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1d ago' : `${d}d ago`;
}

function _fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

function _fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function _currentSeason(): string {
  const y = new Date().getFullYear();
  return `${y} / ${y + 1}`;
}

const COACH_ROLES = [
  UserRole.HEAD_COACH,
  UserRole.ASSISTANT_COACH,
  UserRole.COACH,
  UserRole.MANAGER,
];

// ── Main query ────────────────────────────────────────────────────────────────

export async function getDashboard(clubId: string, userId: string): Promise<HomeDashboard> {
  const now = new Date();

  const [
    club,
    ownerUser,
    playerCount,
    coachCount,
    matchStats,
    nextMatchRaw,
    nextSessionRaw,
    pastSessions,
    playerLogs,
    matchLogs,
    trainingLogs,
    scoutLogs,
    announcementRows,
    teamCount,
  ] = await Promise.all([
    // 1 — Club basics
    prisma.club.findUniqueOrThrow({
      where:  { id: clubId },
      select: { name: true, shortName: true, emblem: true, city: true, country: true, founded: true },
    }),
    // 2 — Requesting user (shown as "owner" on the header widget)
    prisma.user.findUnique({
      where:  { id: userId },
      select: { firstName: true, lastName: true, email: true },
    }),
    // 3 — Active player count
    prisma.player.count({ where: { clubId, isActive: true } }),
    // 4 — Coaching staff count
    prisma.user.count({ where: { clubId, isActive: true, role: { in: COACH_ROLES } } }),
    // 5 — Match result distribution (for wins / draws / losses)
    prisma.match.groupBy({
      by:    ['result'],
      where: { clubId, result: { not: null } },
      _count: { id: true },
    }),
    // 6 — Nearest upcoming match
    prisma.match.findFirst({
      where:   { clubId, status: MatchStatus.SCHEDULED, scheduledAt: { gte: now } },
      orderBy: { scheduledAt: 'asc' },
      select: {
        id: true, homeTeam: true, awayTeam: true, isHome: true,
        status: true, scheduledAt: true, competition: true, competitionName: true, venue: true,
      },
    }),
    // 7 — Next training session
    prisma.trainingSession.findFirst({
      where:   { clubId, scheduledAt: { gte: now } },
      orderBy: { scheduledAt: 'asc' },
      select:  { id: true, title: true, scheduledAt: true, location: true },
    }),
    // 8 — Last 5 past sessions (for attendance rate + last-session widget)
    prisma.trainingSession.findMany({
      where:   { clubId, scheduledAt: { lt: now } },
      orderBy: { scheduledAt: 'desc' },
      take:    5,
      include: { playerStats: { select: { attended: true } } },
    }),
    // 9 — Recent player audit logs (for activity feed)
    prisma.playerAuditLog.findMany({
      where:   { clubId, action: { in: [PlayerAuditAction.CREATE, PlayerAuditAction.UPDATE] } },
      orderBy: { createdAt: 'desc' },
      take:    10,
      include: { player: { select: { firstName: true, lastName: true } } },
    }),
    // 10 — Recent match creation logs (for activity feed)
    prisma.matchAuditLog.findMany({
      where:   { clubId, action: MatchAuditAction.CREATE },
      orderBy: { createdAt: 'desc' },
      take:    5,
      include: { match: { select: { homeTeam: true, awayTeam: true } } },
    }),
    // 11 — Recently created training sessions (for activity feed)
    prisma.trainingSession.findMany({
      where:   { clubId },
      orderBy: { createdAt: 'desc' },
      take:    5,
      select:  { title: true, createdAt: true },
    }),
    // 12 — Recently added scouting prospects (for activity feed)
    prisma.scoutProspect.findMany({
      where:   { clubId },
      orderBy: { createdAt: 'desc' },
      take:    5,
      select:  { playerName: true, createdAt: true },
    }),
    // 13 — Club announcements
    prisma.announcement.findMany({
      where:   { clubId },
      orderBy: { createdAt: 'desc' },
      take:    5,
      select:  { id: true, title: true, body: true, priority: true, createdAt: true },
    }),
    // 14 — Team count
    prisma.team.count({ where: { clubId } }),
  ]);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const wins   = matchStats.find(m => m.result === MatchResult.WIN)?._count.id   ?? 0;
  const draws  = matchStats.find(m => m.result === MatchResult.DRAW)?._count.id  ?? 0;
  const losses = matchStats.find(m => m.result === MatchResult.LOSS)?._count.id  ?? 0;

  // ── Next match ─────────────────────────────────────────────────────────────
  const nextMatch: HomeNextMatch | null = nextMatchRaw ? {
    id:          nextMatchRaw.id,
    homeTeam:    nextMatchRaw.homeTeam,
    awayTeam:    nextMatchRaw.awayTeam,
    isHome:      nextMatchRaw.isHome,
    opponent:    nextMatchRaw.isHome ? nextMatchRaw.awayTeam : nextMatchRaw.homeTeam,
    date:        _fmtDate(nextMatchRaw.scheduledAt),
    time:        _fmtTime(nextMatchRaw.scheduledAt),
    status:      nextMatchRaw.status,
    competition: nextMatchRaw.competitionName ?? nextMatchRaw.competition,
    venue:       nextMatchRaw.venue ?? null,
  } : null;

  // ── Training ───────────────────────────────────────────────────────────────
  const allStats      = pastSessions.flatMap(s => s.playerStats);
  const attendedCount = allStats.filter(s => s.attended).length;
  const attendanceRate = allStats.length > 0
    ? Math.round((attendedCount / allStats.length) * 100)
    : 0;

  const lastSession = pastSessions[0] ?? null;

  const training: HomeTraining = {
    next: nextSessionRaw ? {
      id:    nextSessionRaw.id,
      title: nextSessionRaw.title,
      date:  _fmtDate(nextSessionRaw.scheduledAt),
      time:  _fmtTime(nextSessionRaw.scheduledAt),
      venue: nextSessionRaw.location ?? null,
    } : null,
    attendanceRate,
    lastSession: lastSession ? {
      id:       lastSession.id,
      title:    lastSession.title,
      date:     _fmtDate(lastSession.scheduledAt),
      attended: lastSession.playerStats.filter(s => s.attended).length,
      total:    lastSession.playerStats.length,
    } : null,
  };

  // ── Activity feed (synthesised from multiple audit sources) ───────────────
  type RawItem = { icon: string; text: string; rawTime: Date };

  const rawItems: RawItem[] = [
    ...playerLogs.map(log => ({
      icon: '👤',
      text: log.action === PlayerAuditAction.CREATE
        ? `${log.player.firstName} ${log.player.lastName} added to squad`
        : `${log.player.firstName} ${log.player.lastName} profile updated`,
      rawTime: log.createdAt,
    })),
    ...matchLogs.map(log => ({
      icon:    '⚽',
      text:    `Match: ${log.match.homeTeam} vs ${log.match.awayTeam} created`,
      rawTime: log.createdAt,
    })),
    ...trainingLogs.map(s => ({
      icon:    '⚡',
      text:    `${s.title} session scheduled`,
      rawTime: s.createdAt,
    })),
    ...scoutLogs.map(p => ({
      icon:    '🔍',
      text:    `${p.playerName} added to scouting`,
      rawTime: p.createdAt,
    })),
  ];

  rawItems.sort((a, b) => b.rawTime.getTime() - a.rawTime.getTime());

  const activity: HomeActivity[] = rawItems.slice(0, 10).map(item => ({
    icon:    item.icon,
    text:    item.text,
    time:    _relTime(item.rawTime.toISOString()),
    rawTime: item.rawTime.toISOString(),
  }));

  // ── Owner display name ─────────────────────────────────────────────────────
  const ownerName = ownerUser
    ? ([ownerUser.firstName, ownerUser.lastName].filter(Boolean).join(' ') || ownerUser.email)
    : 'Club Owner';

  const location = `${club.city}, ${club.country}`;

  return {
    header: {
      clubId,
      clubName:  club.name,
      shortName: club.shortName ?? null,
      emblem:    club.emblem   ?? null,
      ownerName,
      location,
    },
    info: {
      founded:  club.founded ? String(new Date(club.founded).getFullYear()) : 'N/A',
      location,
      members:  playerCount + coachCount,
      teams:    teamCount,
      season:   _currentSeason(),
    },
    stats: {
      players: playerCount,
      coaches: coachCount,
      matches: wins + draws + losses,
      wins,
      draws,
      losses,
    },
    nextMatch,
    training,
    activity,
    announcements: announcementRows.map(a => ({
      id:       a.id,
      title:    a.title,
      body:     a.body,
      priority: a.priority.toLowerCase(),
      date:     _fmtDate(a.createdAt),
    })),
  };
}
