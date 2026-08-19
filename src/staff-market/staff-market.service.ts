// Familista — the coaches & technical staff market
// ─────────────────────────────────────────────────────────────────────────────
// A staff member is a User. Not a copy of one, not a market record standing in
// for one: the same row that signs in is the one this market lists, the one a
// club employs, and the one a career history belongs to. Everything here hangs
// off that id, which is what keeps the club's staff list and the market from
// ever disagreeing about who somebody is.
//
// Which clubs take part is not configured. There is no list of clubs in this
// file and no branch on a club's name — the market reads the Club table, so a
// club created after this was written is in it the moment it exists, with its
// staff, its needs and its ability to recruit.
//
// Employment is a Membership, which the platform already uses to decide who is
// active staff at a club and already carries joinedAt, leftAt and isActive.
// This module adds the professional record around it — what a coach holds, what
// he has won, how he plays — and a StaffEngagement per period, which is the
// career history and the contract at the same time. A move closes the open
// engagement and opens a new one; nothing is ever overwritten, so the timeline
// grows by itself.

import { Prisma, MembershipRole, StaffApproachStatus, StaffAvailability, StaffCareerIntent } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface StaffActor { userId: string; clubId: string; role?: string }

// The technical roles this market recruits for. They are the platform's own
// membership roles — no parallel vocabulary — and adding one later is adding it
// to this list, not rebuilding anything.
export const TECHNICAL_ROLES: MembershipRole[] = [
  'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'MEDICAL_STAFF', 'PHYSIO', 'SCOUT',
  'GOALKEEPING_COACH', 'FITNESS_COACH', 'TECHNICAL_COACH', 'TACTICAL_COACH',
  'YOUTH_COACH', 'PERFORMANCE_COACH',
];

const isTechnical = (r: MembershipRole) => TECHNICAL_ROLES.includes(r);

// An approach that is still live. SUBMITTED is what SENT was called before the
// offer states were named in full; both mean the same thing and rows written
// under the old name are never rewritten, so both are read here.
const OPEN_APPROACH: StaffApproachStatus[] = ['SUBMITTED', 'SENT', 'VIEWED', 'NEGOTIATING'];
const isOpenApproach = (s: StaffApproachStatus) => OPEN_APPROACH.includes(s);

// A contract inside this window is ending soon, which the market says out loud
// because it is the single most useful thing about a coach somebody else holds.
const ENDING_SOON_DAYS = 183;
function endingSoon(contractEndsAt: Date | null | undefined) {
  if (!contractEndsAt) return false;
  const days = (contractEndsAt.getTime() - Date.now()) / 86400000;
  return days > 0 && days <= ENDING_SOON_DAYS;
}

// ── the one employment status ────────────────────────────────────────────────
// Derived in one place from the two things that decide it: whether a club holds
// him, and what he has said he wants. Every surface — card, filter, tab, tile —
// reads this function, so the board and the badge can never disagree.
export type EmploymentStatus =
  | 'FREE_AGENT' | 'UNAVAILABLE' | 'ACTIVELY_LOOKING'
  | 'CONTRACT_ENDING_SOON' | 'OPEN_TO_OFFERS' | 'EMPLOYED';

export function employmentStatus(args: {
  hasClub: boolean;
  availability?: StaffAvailability | null;
  careerIntent?: StaffCareerIntent | null;
  contractEndsAt?: Date | null;
}): EmploymentStatus {
  if (args.availability === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (!args.hasClub) return 'FREE_AGENT';
  if (args.careerIntent === 'ACTIVELY_LOOKING') return 'ACTIVELY_LOOKING';
  if (endingSoon(args.contractEndsAt)) return 'CONTRACT_ENDING_SOON';
  if (args.careerIntent === 'OPEN_TO_OFFERS' || args.availability === 'OPEN_TO_OFFERS') return 'OPEN_TO_OFFERS';
  return 'EMPLOYED';
}

// "Available" is a tab, not a status: it is everybody a club could realistically
// move for. Somebody simply employed and not looking is not on it.
const AVAILABLE_STATUSES: EmploymentStatus[] =
  ['FREE_AGENT', 'ACTIVELY_LOOKING', 'OPEN_TO_OFFERS', 'CONTRACT_ENDING_SOON'];
export const isAvailable = (s: EmploymentStatus) => AVAILABLE_STATUSES.includes(s);

// The staff evaluation, in one place. The profile shows all of it; the market
// card names the highest three.
const EVAL_KEYS: Array<[string, string]> = [
  ['tacticalKnowledge', 'Tactical knowledge'], ['trainingQuality', 'Training quality'],
  ['playerDevelopment', 'Player development'], ['manManagement', 'Man management'],
  ['matchPreparation', 'Match preparation'], ['analysis', 'Analysis'], ['leadership', 'Leadership'],
];

// ── what leaves the server ───────────────────────────────────────────────────
// One projection. A staff member is a colleague at another club, not a public
// document: the market publishes the professional record and nothing else —
// never the email address, never the password hash, never the club's private
// contact details.
const publicUserSelect = {
  id: true, firstName: true, lastName: true, avatar: true, isActive: true,
} as const;

const publicClubSelect = { id: true, name: true, shortName: true, emblem: true, country: true } as const;

const profileInclude = {
  licences: { orderBy: { rank: 'desc' } },
  trophies: { orderBy: { season: 'desc' } },
  seasons:  { orderBy: { season: 'desc' } },
} as const;

// ── derived, never stored twice ──────────────────────────────────────────────
// Totals come from the records. A trophy count that is written down separately
// is a number that can disagree with the trophies it counts.
function trophySummary(trophies: Array<{ kind: string }>) {
  const by = (k: string) => trophies.filter((t) => t.kind === k).length;
  return {
    total: trophies.length,
    league: by('LEAGUE'), cup: by('CUP'), continental: by('CONTINENTAL'),
    promotion: by('PROMOTION'), youth: by('YOUTH'), other: by('OTHER'),
  };
}

type SeasonRow = {
  season: string; clubName: string; league: string | null; country: string | null;
  finalPosition: number | null; played: number | null; won: number | null;
  drawn: number | null; lost: number | null; goalsFor: number | null;
  goalsAgainst: number | null; promoted: boolean; relegated: boolean;
  competitionProgress: string | null; role: MembershipRole | null;
};

// Points per match, the way football counts it. Null when nothing was played —
// a season with no record does not get a zero, which would read as a bad one.
function ppm(s: { played: number | null; won: number | null; drawn: number | null }) {
  if (!s.played || s.played <= 0) return null;
  const pts = (s.won ?? 0) * 3 + (s.drawn ?? 0);
  return Math.round((pts / s.played) * 100) / 100;
}

// Best seasons are ranked, not picked. What counts, in order of weight: what
// was won, where the club finished, and how many points a match were taken.
// A season with nothing recorded scores nothing and sinks — it is not dropped,
// because "no data" is itself the truthful answer for it.
function seasonScore(s: SeasonRow, trophiesBySeason: Map<string, number>): number {
  let score = 0;
  score += (trophiesBySeason.get(s.season) ?? 0) * 40;
  if (s.promoted) score += 30;
  if (s.relegated) score -= 25;
  if (s.finalPosition != null) score += Math.max(0, 25 - (s.finalPosition - 1) * 2);
  const p = ppm(s);
  if (p != null) score += p * 12;
  return Math.round(score * 100) / 100;
}

function bestSeasons(seasons: SeasonRow[], trophies: Array<{ season: string }>, take = 5) {
  const bySeason = new Map<string, number>();
  trophies.forEach((t) => bySeason.set(t.season, (bySeason.get(t.season) ?? 0) + 1));
  return seasons
    .map((s) => ({ ...s, ppm: ppm(s), score: seasonScore(s, bySeason) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, take);
}

// Where he has actually worked, read off the engagements rather than typed into
// a field. Country is the club's, not his nationality.
function experienceFromEngagements(engagements: Array<{ country: string | null; league: string | null; teamLabel: string | null; role: MembershipRole }>) {
  const byCountry = new Map<string, Set<string>>();
  engagements.forEach((e) => {
    const c = e.country || 'Unknown';
    if (!byCountry.has(c)) byCountry.set(c, new Set());
    if (e.league) byCountry.get(c)!.add(e.league);
  });
  const youth = engagements.some((e) => /u\s?\d{1,2}|youth|academy/i.test(e.teamLabel || ''));
  const senior = engagements.some((e) => !/u\s?\d{1,2}|youth|academy/i.test(e.teamLabel || ''));
  return {
    countries: [...byCountry.keys()].sort(),
    leaguesByCountry: [...byCountry.entries()].map(([country, set]) => ({ country, leagues: [...set].sort() })),
    youthExperience: youth,
    seniorExperience: senior,
  };
}

// The peak, from the record. Nothing here is a prestige value somebody chose;
// each line is the best entry of its own kind that exists, or absent.
function careerPeak(
  profile: { licences: Array<{ name: string; rank: number }> },
  seasons: SeasonRow[],
  trophies: Array<{ competition: string; kind: string; level: string | null; season: string; clubName: string }>,
  engagements: Array<{ league: string | null; clubName: string | null }>,
) {
  const best = seasons.filter((s) => s.finalPosition != null).sort((a, b) => (a.finalPosition! - b.finalPosition!))[0];
  const order = ['CONTINENTAL', 'LEAGUE', 'PROMOTION', 'CUP', 'YOUTH', 'OTHER'];
  const biggest = [...trophies].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
  const topLicence = profile.licences[0];
  const leagues = [...new Set(engagements.map((e) => e.league).filter(Boolean))] as string[];
  return {
    highestLicence: topLicence ? topLicence.name : null,
    bestLeagueFinish: best ? { position: best.finalPosition, season: best.season, club: best.clubName, league: best.league } : null,
    biggestTrophy: biggest ? { competition: biggest.competition, season: biggest.season, club: biggest.clubName, kind: biggest.kind } : null,
    leaguesCoached: leagues,
  };
}

// The career record, added up from the seasons that have one.
function performanceRecord(seasons: SeasonRow[]) {
  const withPlay = seasons.filter((s) => s.played && s.played > 0);
  if (!withPlay.length) return null;
  const sum = (k: keyof SeasonRow) => withPlay.reduce((a, s) => a + ((s[k] as number) ?? 0), 0);
  const played = sum('played'), won = sum('won'), drawn = sum('drawn'), lost = sum('lost');
  return {
    played, won, drawn, lost,
    goalsFor: sum('goalsFor'), goalsAgainst: sum('goalsAgainst'),
    winPct: played ? Math.round((won / played) * 1000) / 10 : null,
    ppm: played ? Math.round(((won * 3 + drawn) / played) * 100) / 100 : null,
  };
}

const money = (v: bigint | null | undefined) => (v == null ? null : Number(v));


// The job somebody currently holds. An engagement is the richer record, but a
// club's staff list has always been its memberships, and a coach the platform
// has known about for a year may have no engagement row yet. Either answers
// "where does he work"; the engagement is preferred when both exist.
async function currentJob(userId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const engagement = await tx.staffEngagement.findFirst({
    where: { userId, isActive: true },
    include: { club: { select: publicClubSelect } },
  });
  if (engagement) return { clubId: engagement.clubId, role: engagement.role, club: engagement.club, engagement, membership: null };
  const membership = await tx.membership.findFirst({
    where: { userId, isActive: true, role: { in: TECHNICAL_ROLES } },
    include: { club: { select: publicClubSelect } },
  });
  if (membership) return { clubId: membership.clubId, role: membership.role, club: membership.club, engagement: null, membership };
  return null;
}

// ── the market ───────────────────────────────────────────────────────────────

export interface DiscoverQuery {
  search?: string; role?: string; availability?: string; clubId?: string;
  freeAgentsOnly?: string; licence?: string; minLevel?: string; minExperience?: string;
  speciality?: string; philosophy?: string; formation?: string; country?: string;
  league?: string; trophiesMin?: string; page?: string; limit?: string;
  shortlistedOnly?: string; sort?: string; order?: string;
  // the staff database's own reading of the board
  tab?: string;            // all | available | employed | free-agents | shortlisted
  status?: string;         // one EmploymentStatus
  nationality?: string;
  language?: string;
  ageMin?: string; ageMax?: string;
  reputationMin?: string;
  salaryMax?: string;
  contractEndsBefore?: string;
  availableNow?: string;
  openToOffers?: string;
}

export async function discover(actor: StaffActor, q: DiscoverQuery = {}) {
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(String(q.limit ?? '25'), 10) || 25));

  // Who is on this market is decided by employment, not by whether somebody
  // has filled in a profile. A staff member is here because he holds a
  // technical membership at some club — any club, including one created after
  // this was written — or because he has a professional record and no current
  // job, which is what a free agent is.
  //
  // There is no list of clubs anywhere in this query. It reads the memberships
  // that exist.
  const [memberships, orphanProfiles] = await Promise.all([
    prisma.membership.findMany({
      where: { isActive: true, role: { in: TECHNICAL_ROLES }, user: { isActive: true } },
      include: { user: { select: publicUserSelect }, club: { select: publicClubSelect } },
      take: 2000,
    }),
    prisma.staffProfile.findMany({
      where: { user: { isActive: true } },
      include: { ...profileInclude, user: { select: publicUserSelect } },
      take: 2000,
    }),
  ]);

  const profileByUser = new Map(orphanProfiles.map((p) => [p.userId, p]));
  // The club's own shortlist, read once for the whole board rather than per row.
  const shortRows = await prisma.staffShortlist.findMany({
    where: { clubId: actor.clubId },
    select: { staffUserId: true, priority: true, stage: true },
  });
  const shortlisted = new Set(shortRows.map((s) => s.staffUserId));
  const shortlistMeta = new Map(shortRows.map((s) => [s.staffUserId, s]));
  const engagements = await prisma.staffEngagement.findMany({
    where: { userId: { in: [...new Set([...memberships.map((m) => m.userId), ...orphanProfiles.map((p) => p.userId)])] } },
    include: { club: { select: publicClubSelect } },
    orderBy: { startedAt: 'desc' },
  });
  const engByUser = new Map<string, typeof engagements>();
  engagements.forEach((e) => {
    if (!engByUser.has(e.userId)) engByUser.set(e.userId, [] as never);
    engByUser.get(e.userId)!.push(e);
  });

  // One row per person. Somebody holding two technical memberships is still
  // one staff member; the current engagement decides which job is shown.
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];

  const build = (userId: string, user: { firstName: string; lastName: string; avatar: string | null },
                 fallbackRole: MembershipRole | null, fallbackClub: { id: string; name: string; shortName: string | null; emblem: string | null; country: string } | null) => {
    if (seen.has(userId)) return;
    seen.add(userId);
    const p = profileByUser.get(userId) ?? null;
    const mine = engByUser.get(userId) ?? [];
    const current = mine.find((e) => e.isActive) ?? null;
    const exp = experienceFromEngagements(mine);
    const role = current?.role ?? fallbackRole;
    const club = current?.club ?? fallbackClub;
    const licences = p?.licences ?? [];
    const trophies = p?.trophies ?? [];
    rows.push({
      staffUserId: userId,
      name: `${user.firstName} ${user.lastName}`.trim(),
      avatar: user.avatar,
      nationality: p?.nationality ?? null,
      role,
      currentClub: club,
      isFreeAgent: !club,
      level: p?.level ?? null,
      yearsExperience: p?.yearsExperience ?? null,
      availability: p?.availability ?? (club ? 'EMPLOYED' : 'FREE_AGENT'),
      highestLicence: licences[0] ? { code: licences[0].code, name: licences[0].name, issuer: licences[0].issuer } : null,
      trophies: trophies.length,
      primaryPhilosophy: p?.dominantPhilosophy?.[0] ?? p?.philosophy?.[0] ?? null,
      primaryFormation: p?.primaryFormation ?? null,
      mainSpeciality: p?.specialities?.[0] ?? null,
      mainLeague: current?.league ?? mine.find((e) => e.league)?.league ?? null,
      countries: exp.countries.length ? exp.countries : (club ? [club.country] : []),
      contractEndsAt: current?.contractEndsAt ?? null,
      contractStartedAt: current?.startedAt ?? null,
      wageExpectation: money(p?.wageExpectation),
      // What the card shows besides the job. Age is derived from the date of
      // birth the record holds; a record without one has no age rather than a
      // guessed one.
      age: p?.dateOfBirth
        ? Math.floor((Date.now() - p.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000))
        : null,
      languages: p?.languages ?? [],
      reputation: p?.reputation ?? null,
      coachingStyle: p?.coachingStyle ?? null,
      // The three the record scores him highest on, named on the card so the
      // board says what he is good at without opening him. Derived from the
      // same evaluation the profile shows; a record without one has none.
      keyAttributes: p ? EVAL_KEYS
        .map(([k, label]) => ({ key: k, label, value: (p as Record<string, unknown>)[k] as number }))
        .filter((x) => typeof x.value === 'number')
        .sort((a, b) => b.value - a.value)
        .slice(0, 3) : [],
      contractStatus: !club ? 'FREE_AGENT'
        : (current?.contractEndsAt ? 'UNDER_CONTRACT' : 'CONTRACT_NOT_RECORDED'),
      // The one status every surface reads. Derived, never stored.
      employmentStatus: employmentStatus({
        hasClub: !!club,
        availability: p?.availability ?? null,
        careerIntent: p?.careerIntent ?? null,
        contractEndsAt: current?.contractEndsAt ?? null,
      }),
      careerIntent: p?.careerIntent ?? null,
      availableFrom: p?.availableFrom ?? null,
      preferredRoles: p?.preferredRoles ?? [],
      // Where he was last and when he left it. Read off the engagements, so a
      // free agent's history is the same history his profile shows.
      lastClub: club ? null : (mine.find((e) => !e.isActive)?.clubName
        ?? mine.find((e) => !e.isActive)?.club?.name ?? null),
      lastRole: club ? null : (mine.find((e) => !e.isActive)?.role ?? null),
      lastLeftAt: club ? null : (mine.find((e) => !e.isActive)?.endedAt ?? null),
      isShortlisted: shortlisted.has(userId),
      shortlistPriority: shortlistMeta.get(userId)?.priority ?? null,
      shortlistStage: shortlistMeta.get(userId)?.stage ?? null,
      hasProfile: !!p,
      // A club may not recruit somebody it already employs. The row says so
      // rather than disappearing — hiding it would hide the fact.
      isMine: !!club && club.id === actor.clubId,
    });
  };

  memberships.forEach((m) => build(m.userId, m.user, m.role, m.club));
  orphanProfiles.forEach((p) => build(p.userId, p.user, null, null));

  // ── filters ──
  let out = rows;
  const has = (v?: string) => v != null && v !== '';
  if (has(q.availability)) out = out.filter((r) => r.availability === q.availability);
  if (q.freeAgentsOnly === 'true') out = out.filter((r) => r.isFreeAgent);
  if (has(q.role)) out = out.filter((r) => r.role === q.role);
  if (has(q.clubId)) out = out.filter((r) => (r.currentClub as { id?: string } | null)?.id === q.clubId);
  if (has(q.minLevel)) out = out.filter((r) => (r.level as number ?? 0) >= (parseInt(q.minLevel!, 10) || 0));
  if (has(q.minExperience)) out = out.filter((r) => (r.yearsExperience as number ?? 0) >= (parseInt(q.minExperience!, 10) || 0));
  if (has(q.licence)) out = out.filter((r) => (r.highestLicence as { code?: string } | null)?.code === q.licence);
  if (has(q.formation)) out = out.filter((r) => r.primaryFormation === q.formation);
  if (has(q.philosophy)) out = out.filter((r) => r.primaryPhilosophy === q.philosophy);
  if (has(q.speciality)) out = out.filter((r) => r.mainSpeciality === q.speciality);
  if (has(q.country)) out = out.filter((r) => (r.countries as string[]).includes(q.country!));
  if (has(q.league)) out = out.filter((r) => r.mainLeague === q.league);
  if (has(q.trophiesMin)) out = out.filter((r) => (r.trophies as number) >= (parseInt(q.trophiesMin!, 10) || 0));
  if (has(q.search)) {
    const s2 = q.search!.trim().toLowerCase();
    out = out.filter((r) => String(r.name).toLowerCase().includes(s2)
      || String((r.currentClub as { name?: string } | null)?.name ?? '').toLowerCase().includes(s2)
      || String(r.nationality ?? '').toLowerCase().includes(s2));
  }

  if (q.shortlistedOnly === 'true') out = out.filter((r) => r.isShortlisted);
  if (has(q.status)) out = out.filter((r) => r.employmentStatus === q.status);
  if (has(q.nationality)) {
    const n = q.nationality!.toLowerCase();
    out = out.filter((r) => String(r.nationality ?? '').toLowerCase() === n);
  }
  if (has(q.language)) {
    const l = q.language!.toLowerCase();
    out = out.filter((r) => (r.languages as string[]).some((x) => x.toLowerCase() === l));
  }
  if (has(q.ageMin)) out = out.filter((r) => r.age != null && (r.age as number) >= (parseInt(q.ageMin!, 10) || 0));
  if (has(q.ageMax)) out = out.filter((r) => r.age != null && (r.age as number) <= (parseInt(q.ageMax!, 10) || 999));
  if (has(q.reputationMin)) out = out.filter((r) => (r.reputation as number ?? 0) >= (parseInt(q.reputationMin!, 10) || 0));
  if (has(q.salaryMax)) {
    const cap = Number(q.salaryMax);
    // A coach who has not said what he wants is not excluded by a ceiling he
    // has not been measured against.
    out = out.filter((r) => r.wageExpectation == null || Number(r.wageExpectation) <= cap);
  }
  if (has(q.contractEndsBefore)) {
    const before = new Date(q.contractEndsBefore!).getTime();
    out = out.filter((r) => r.contractEndsAt != null && new Date(r.contractEndsAt as Date).getTime() <= before);
  }
  if (q.openToOffers === 'true') {
    out = out.filter((r) => ['OPEN_TO_OFFERS', 'ACTIVELY_LOOKING'].includes(r.employmentStatus as string));
  }
  if (q.availableNow === 'true') {
    out = out.filter((r) => r.employmentStatus === 'FREE_AGENT'
      || (r.availableFrom != null && new Date(r.availableFrom as Date).getTime() <= Date.now()));
  }

  // ── the tabs ──
  // Each one is a reading of the same board, not a different list.
  const tab = String(q.tab ?? 'all');
  if (tab === 'available')   out = out.filter((r) => isAvailable(r.employmentStatus as EmploymentStatus));
  else if (tab === 'employed')     out = out.filter((r) => !!r.currentClub);
  else if (tab === 'free-agents')  out = out.filter((r) => r.isFreeAgent);
  else if (tab === 'shortlisted')  out = out.filter((r) => r.isShortlisted);

  // ── sort ──
  // Best first by default, but somebody with no record yet is not pushed to the
  // bottom as though he were poor — on every numeric key, a value the platform
  // does not have sorts after the ones it does, rather than counting as zero.
  const NUMERIC: Record<string, string> = {
    level: 'level', reputation: 'reputation', experience: 'yearsExperience',
    trophies: 'trophies', age: 'age', wage: 'wageExpectation', salary: 'wageExpectation',
  };
  // Two orderings are over dates rather than figures, and both put "no date"
  // last in either direction rather than treating it as the year zero.
  if (q.sort === 'contract' || q.sort === 'available') {
    const field = q.sort === 'contract' ? 'contractEndsAt' : 'availableFrom';
    const dirD = q.order === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      const av = a[field] as Date | null, bv = b[field] as Date | null;
      if (!av && !bv) return String(a.name).localeCompare(String(b.name));
      if (!av) return 1;
      if (!bv) return -1;
      return (new Date(av).getTime() - new Date(bv).getTime()) * dirD;
    });
    const totalD = out.length;
    return { items: out.slice((page - 1) * limit, page * limit), total: totalD, page, limit, tab };
  }
  const key = String(q.sort ?? 'level');
  const dir = q.order === 'asc' ? 1 : -1;
  const byName = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.name).localeCompare(String(b.name));

  if (key === 'name') {
    out.sort((a, b) => (q.order === 'desc' ? -byName(a, b) : byName(a, b)));
  } else {
    const f = NUMERIC[key] ?? 'level';
    out.sort((a, b) => {
      const av = a[f] as number | null, bv = b[f] as number | null;
      if (av == null && bv == null) return byName(a, b);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return byName(a, b);
      return dir === 1 ? av - bv : bv - av;
    });
  }

  const total = out.length;
  return { items: out.slice((page - 1) * limit, page * limit), total, page, limit, tab };
}

// The summary above the market. Counted across the whole platform, not a list.
export async function marketSummary(actor: StaffActor) {
  // Counted from the same rows the board lists, through the same status
  // function — so a tile and the tab it names can never disagree.
  const all = await discover(actor, { limit: '1', page: '1' });
  const everyone = (await discoverAllRows(actor));
  const by = (f: (r: Record<string, unknown>) => boolean) => everyone.filter(f).length;
  const [openApproaches, needs] = await Promise.all([
    prisma.staffApproach.count({
      where: {
        status: { in: OPEN_APPROACH },
        OR: [{ fromClubId: actor.clubId }, { currentClubId: actor.clubId }],
      },
    }),
    prisma.staffNeed.count({ where: { clubId: actor.clubId, isActive: true } }),
  ]);
  return {
    allStaff: all.total,
    availableStaff: by((r) => isAvailable(r.employmentStatus as EmploymentStatus)),
    currentlyEmployed: by((r) => !!r.currentClub),
    freeAgents: by((r) => !!r.isFreeAgent),
    activelyLooking: by((r) => r.employmentStatus === 'ACTIVELY_LOOKING'),
    contractEndingSoon: by((r) => r.employmentStatus === 'CONTRACT_ENDING_SOON'),
    shortlisted: by((r) => !!r.isShortlisted),
    openNegotiations: openApproaches,
    myStaffNeeds: needs,
    myStaff: by((r) => !!r.isMine),
  };
}

// Every row the board would show, unpaged. Used by the tiles so their figures
// are the board's own and not a second count of a different population.
async function discoverAllRows(actor: StaffActor) {
  const r = await discover(actor, { limit: '50', page: '1' });
  if (r.total <= r.items.length) return r.items;
  const pages = Math.ceil(r.total / 50);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => discover(actor, { limit: '50', page: String(i + 2) })),
  );
  return [r.items, ...rest.map((x) => x.items)].flat();
}

// ── one staff member, in full ────────────────────────────────────────────────
export async function readStaff(actor: StaffActor, staffUserId: string) {
  // Somebody is on this market because he holds a technical job, not because
  // somebody has filled in his record. So a profile that does not exist yet is
  // not a missing person — it is a person whose professional record is empty,
  // and the honest answer is his employment with the rest left blank for his
  // club to complete.
  const user = await prisma.user.findUnique({ where: { id: staffUserId }, select: publicUserSelect });
  if (!user) throw new NotFoundError('Staff member');
  const existing = await prisma.staffProfile.findUnique({
    where: { userId: staffUserId },
    include: { ...profileInclude, user: { select: publicUserSelect } },
  });
  const p = existing ?? {
    userId: staffUserId, user,
    nationality: null, secondNationality: null, dateOfBirth: null,
    level: null as unknown as number, yearsExperience: null as unknown as number,
    availability: null as unknown as StaffAvailability, wageExpectation: null,
    tacticalKnowledge: null, trainingQuality: null, playerDevelopment: null,
    manManagement: null, matchPreparation: null, analysis: null, leadership: null,
    specialities: [] as string[], philosophy: [] as string[], dominantPhilosophy: [] as string[],
    trainingMethods: [] as string[], primaryFormation: null, secondaryFormations: [] as string[],
    notes: null, nationalTeamExperience: false, youthNationalTeamExperience: false,
    languages: [] as string[], reputation: null as unknown as number, coachingStyle: null,
    attackingApproach: null, defensiveApproach: null, transitionApproach: null,
    developmentStyle: null, certifications: [] as string[], education: [] as string[],
    seniorYears: null, academyYears: null, youthAgeGroups: [] as string[],
    careerIntent: null as unknown as StaffCareerIntent, availableFrom: null,
    preferredRoles: [] as MembershipRole[], preferredCountries: [] as string[],
    preferredLeagues: [] as string[], preferredClubLevel: null,
    licences: [] as never[], trophies: [] as never[], seasons: [] as never[],
  } as unknown as NonNullable<typeof existing>;
  const hasProfile = !!existing;

  const engagements = await prisma.staffEngagement.findMany({
    where: { userId: staffUserId },
    include: { club: { select: publicClubSelect } },
    orderBy: [{ isActive: 'desc' }, { startedAt: 'desc' }],
  });
  const current = engagements.find((e) => e.isActive) ?? null;

  const seasons = p.seasons as unknown as SeasonRow[];
  const age = p.dateOfBirth
    ? Math.floor((Date.now() - p.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000))
    : null;

  // Where no engagement has been recorded, the membership still says where he
  // works — the platform has known that all along.
  const membership = current ? null : await prisma.membership.findFirst({
    where: { userId: staffUserId, isActive: true, role: { in: TECHNICAL_ROLES } },
    include: { club: { select: publicClubSelect } },
  });
  const jobRole = current?.role ?? membership?.role ?? null;
  const jobClub = current?.club ?? membership?.club ?? null;

  return {
    staffUserId: p.userId,
    hasProfile,
    name: `${p.user.firstName} ${p.user.lastName}`.trim(),
    firstName: p.user.firstName, lastName: p.user.lastName,
    avatar: p.user.avatar,
    age,
    nationality: p.nationality,
    secondNationality: p.secondNationality,
    role: jobRole,
    currentClub: jobClub,
    isFreeAgent: !jobClub,
    isMine: !!jobClub && jobClub.id === actor.clubId,
    level: p.level,
    yearsExperience: p.yearsExperience,
    availability: p.availability,
    wageExpectation: money(p.wageExpectation),
    languages: p.languages ?? [],
    reputation: p.reputation ?? null,
    coachingStyle: p.coachingStyle ?? null,
    isShortlisted: await isShortlisted(actor.clubId, staffUserId),
    // The one status, from the one function.
    employmentStatus: employmentStatus({
      hasClub: !!jobClub,
      availability: p.availability ?? null,
      careerIntent: p.careerIntent ?? null,
      contractEndsAt: current?.contractEndsAt ?? null,
    }),

    // ── qualifications ──
    certifications: p.certifications ?? [],
    education: p.education ?? [],

    // ── what he wants next ──
    careerIntent: p.careerIntent ?? null,
    availableFrom: p.availableFrom ?? null,
    preferences: {
      roles: p.preferredRoles ?? [],
      countries: p.preferredCountries ?? [],
      leagues: p.preferredLeagues ?? [],
      clubLevel: p.preferredClubLevel ?? null,
    },

    // What this club — and only this club — has written about him.
    clubNote: await readNoteBody(actor.clubId, staffUserId),

    evaluation: {
      tacticalKnowledge: p.tacticalKnowledge, trainingQuality: p.trainingQuality,
      playerDevelopment: p.playerDevelopment, manManagement: p.manManagement,
      matchPreparation: p.matchPreparation, analysis: p.analysis, leadership: p.leadership,
    },
    licences: p.licences.map((l) => ({
      code: l.code, name: l.name, issuer: l.issuer, rank: l.rank, obtainedAt: l.obtainedAt,
    })),
    highestLicence: p.licences[0] ? { code: p.licences[0].code, name: p.licences[0].name, issuer: p.licences[0].issuer } : null,

    tactics: {
      philosophy: p.philosophy,
      dominantPhilosophy: p.dominantPhilosophy,
      primaryFormation: p.primaryFormation,
      secondaryFormations: p.secondaryFormations,
      // Every formation he has actually been recorded using.
      historicalFormations: [...new Set([p.primaryFormation, ...p.secondaryFormations].filter(Boolean))],
    },
    training: { methods: p.trainingMethods },
    approach: {
      attacking:   p.attackingApproach ?? null,
      defensive:   p.defensiveApproach ?? null,
      transition:  p.transitionApproach ?? null,
      development: p.developmentStyle ?? null,
      coachingStyle: p.coachingStyle ?? null,
    },
    specialities: p.specialities,
    notes: p.notes,

    trophies: {
      summary: trophySummary(p.trophies),
      items: p.trophies.map((t) => ({
        competition: t.competition, club: t.clubName, season: t.season,
        kind: t.kind, level: t.level, roleHeld: t.roleHeld,
      })),
    },
    bestSeasons: bestSeasons(seasons, p.trophies),
    seasons: seasons.map((s) => ({ ...s, ppm: ppm(s) })),
    performance: performanceRecord(seasons),

    experience: {
      ...experienceFromEngagements(engagements),
      // Senior and academy are two careers. A club recruiting for its academy
      // is not helped by one combined total, so both are kept apart.
      totalYears:   p.yearsExperience ?? null,
      seniorYears:  p.seniorYears ?? null,
      academyYears: p.academyYears ?? null,
      youthAgeGroups: p.youthAgeGroups ?? [],
    },
    international: {
      nationalTeam: p.nationalTeamExperience,
      youthNationalTeam: p.youthNationalTeamExperience,
    },
    careerPeak: careerPeak(p, seasons, p.trophies, engagements),

    career: engagements.map((e) => ({
      engagementId: e.id,
      club: e.club, clubName: e.clubName ?? e.club.name,
      country: e.country ?? e.club.country, league: e.league,
      role: e.role, teamLabel: e.teamLabel,
      from: e.startedAt, to: e.endedAt, isActive: e.isActive,
      matches: e.matches, points: e.points,
      ppm: e.matches && e.matches > 0 && e.points != null
        ? Math.round((e.points / e.matches) * 100) / 100 : null,
      achievements: e.achievements,
    })),

    contract: current ? {
      club: current.club, role: current.role,
      startedAt: current.startedAt, endsAt: current.contractEndsAt,
      salary: money(current.salary),
      releaseClause: money(current.releaseClause),
      renewalStatus: current.renewalStatus ?? null,
      // Counted from the two dates rather than stored, so it cannot drift.
      durationMonths: current.contractEndsAt
        ? Math.max(0, Math.round((current.contractEndsAt.getTime() - current.startedAt.getTime()) / (30.44 * 86400000)))
        : null,
    } : (membership ? {
      // Employed, with the terms not recorded yet. Saying so is the truthful
      // answer; inventing a salary would not be.
      club: membership.club, role: membership.role,
      startedAt: membership.joinedAt, endsAt: null, salary: null,
      releaseClause: null, renewalStatus: null, durationMonths: null,
    } : null),
  };
}

// ── recruitment ──────────────────────────────────────────────────────────────

export interface ApproachDto {
  staffUserId: string; proposedRole: MembershipRole;
  salary?: number; durationMonths?: number; compensation?: number; message?: string;
  startDate?: string; bonuses?: string; releaseClause?: number;
  submit?: boolean;
}

export async function approach(actor: StaffActor, dto: ApproachDto) {
  if (!dto?.staffUserId) throw new BadRequestError('staffUserId is required');
  if (!dto.proposedRole || !isTechnical(dto.proposedRole)) {
    throw new BadRequestError('proposedRole must be a technical staff role');
  }
  const user = await prisma.user.findUnique({ where: { id: dto.staffUserId } });
  if (!user) throw new NotFoundError('Staff member');
  // The professional record is enrichment, not a precondition for being
  // recruited: somebody the platform employs is on this market whether or not
  // anybody has filled his record in yet. An empty one is created here so the
  // move has somewhere to record availability — it invents nothing.
  const profile = await prisma.staffProfile.upsert({
    where: { userId: dto.staffUserId }, update: {}, create: { userId: dto.staffUserId },
  });

  const current = await currentJob(dto.staffUserId);
  // A club cannot recruit somebody it already employs. This is the rule, and it
  // is enforced here rather than by hiding the row.
  if (current && current.clubId === actor.clubId) {
    throw new ForbiddenError('This staff member is already employed by your club');
  }
  if (profile.availability === 'UNAVAILABLE') {
    throw new ConflictError('This staff member is not open to approaches');
  }
  // One live approach per club per person.
  const existing = await prisma.staffApproach.findFirst({
    where: {
      staffUserId: dto.staffUserId, fromClubId: actor.clubId,
      status: { in: ['DRAFT', ...OPEN_APPROACH] },
    },
  });
  if (existing) throw new ConflictError('An approach for this staff member is already open');

  const created = await prisma.staffApproach.create({
    data: {
      staffUserId: dto.staffUserId,
      fromClubId: actor.clubId,
      currentClubId: current?.clubId ?? null,
      proposedRole: dto.proposedRole,
      salary: dto.salary != null ? BigInt(Math.round(dto.salary)) : null,
      durationMonths: dto.durationMonths ?? null,
      // Compensation is owed only when somebody is under contract elsewhere.
      compensation: current && dto.compensation != null ? BigInt(Math.round(dto.compensation)) : null,
      message: dto.message ?? null,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      bonuses: dto.bonuses ?? null,
      releaseClause: dto.releaseClause != null ? BigInt(Math.round(dto.releaseClause)) : null,
      status: dto.submit === false ? 'DRAFT' : 'SENT',
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'STAFF_APPROACH_CREATED', entityType: 'StaffApproach', entityId: created.id,
    payload: { staffUserId: dto.staffUserId, role: dto.proposedRole },
  });
  return hydrateApproach(created.id);
}

async function hydrateApproach(id: string) {
  const a = await prisma.staffApproach.findUnique({
    where: { id },
    include: {
      staffUser: { select: publicUserSelect },
      fromClub: { select: publicClubSelect },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!a) throw new NotFoundError('Approach');
  const currentClub = a.currentClubId
    ? await prisma.club.findUnique({ where: { id: a.currentClubId }, select: publicClubSelect })
    : null;
  return {
    id: a.id,
    staffUserId: a.staffUserId,
    staffName: `${a.staffUser.firstName} ${a.staffUser.lastName}`.trim(),
    fromClub: a.fromClub,
    currentClub,
    proposedRole: a.proposedRole,
    salary: money(a.salary),
    durationMonths: a.durationMonths,
    compensation: money(a.compensation),
    message: a.message,
    startDate: a.startDate,
    bonuses: a.bonuses,
    releaseClause: money(a.releaseClause),
    status: a.status,
    viewedAt: a.viewedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    decidedAt: a.decidedAt,
    completedAt: a.completedAt,
    messages: a.messages.map((m) => ({
      id: m.id, fromClubId: m.fromClubId, body: m.body,
      salary: money(m.salary), durationMonths: m.durationMonths,
      compensation: money(m.compensation), at: m.createdAt,
    })),
  };
}

// Only the two clubs in an approach may see or move it: the one making it, and
// the one that currently employs the person.
async function loadForParty(actor: StaffActor, approachId: string) {
  const a = await prisma.staffApproach.findUnique({ where: { id: approachId } });
  if (!a) throw new NotFoundError('Approach');
  const isFrom = a.fromClubId === actor.clubId;
  const isHolder = !!a.currentClubId && a.currentClubId === actor.clubId;
  if (!isFrom && !isHolder) throw new ForbiddenError('That approach is not yours');
  return { a, isFrom, isHolder };
}

export async function readApproach(actor: StaffActor, approachId: string) {
  await loadForParty(actor, approachId);
  return hydrateApproach(approachId);
}

export async function counterApproach(
  actor: StaffActor, approachId: string,
  dto: { body?: string; salary?: number; durationMonths?: number; compensation?: number },
) {
  const { a } = await loadForParty(actor, approachId);
  if (!isOpenApproach(a.status)) {
    throw new ConflictError('That approach is not open');
  }
  await prisma.$transaction([
    prisma.staffApproachMessage.create({
      data: {
        approachId,
        fromClubId: actor.clubId,
        body: dto.body ?? '',
        salary: dto.salary != null ? BigInt(Math.round(dto.salary)) : null,
        durationMonths: dto.durationMonths ?? null,
        compensation: dto.compensation != null ? BigInt(Math.round(dto.compensation)) : null,
      },
    }),
    prisma.staffApproach.update({
      where: { id: approachId },
      data: {
        status: 'NEGOTIATING',
        ...(dto.salary != null ? { salary: BigInt(Math.round(dto.salary)) } : {}),
        ...(dto.durationMonths != null ? { durationMonths: dto.durationMonths } : {}),
        ...(dto.compensation != null ? { compensation: BigInt(Math.round(dto.compensation)) } : {}),
      },
    }),
  ]);
  return hydrateApproach(approachId);
}

export async function withdrawApproach(actor: StaffActor, approachId: string) {
  const { a, isFrom } = await loadForParty(actor, approachId);
  if (!isFrom) throw new ForbiddenError('Only the approaching club may withdraw');
  if (['COMPLETED', 'REJECTED', 'WITHDRAWN'].includes(a.status)) {
    throw new ConflictError('That approach is already closed');
  }
  await prisma.staffApproach.update({
    where: { id: approachId },
    data: { status: 'WITHDRAWN', decidedAt: new Date() },
  });
  return hydrateApproach(approachId);
}

export async function rejectApproach(actor: StaffActor, approachId: string) {
  const { a, isFrom } = await loadForParty(actor, approachId);
  if (isFrom) throw new ForbiddenError('The approaching club cannot reject its own approach');
  if (!isOpenApproach(a.status)) throw new ConflictError('That approach is not open');
  await prisma.staffApproach.update({
    where: { id: approachId },
    data: { status: 'REJECTED', decidedAt: new Date() },
  });
  return hydrateApproach(approachId);
}

// Accepting settles the move. Who may accept depends on whether anybody else
// holds him: a club under approach answers for its own employee, and a free
// agent's approach is completed by the club that made it.
export async function acceptApproach(actor: StaffActor, approachId: string) {
  const { a, isFrom, isHolder } = await loadForParty(actor, approachId);
  if (!isOpenApproach(a.status)) throw new ConflictError('That approach is not open');
  if (a.currentClubId && !isHolder) throw new ForbiddenError('Only the employing club may accept');
  if (!a.currentClubId && !isFrom) throw new ForbiddenError('Only the approaching club may complete a free-agent hire');

  return completeMove(actor, approachId);
}

// ── the move ─────────────────────────────────────────────────────────────────
// One transaction. The previous engagement is closed and kept, the previous
// membership is deactivated, and a new engagement and membership are created.
// Nothing is deleted and nothing is overwritten, so the club that had him keeps
// its history and the club that has him now shows him as active staff.
export async function completeMove(actor: StaffActor, approachId: string) {
  const result = await prisma.$transaction(async (tx) => {
    // Claim it: only an open approach can be completed, and only once.
    const claimed = await tx.staffApproach.updateMany({
      where: { id: approachId, status: { in: OPEN_APPROACH } },
      data: { status: 'ACCEPTED', decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictError('That approach is no longer open');

    const a = await tx.staffApproach.findUnique({ where: { id: approachId } });
    if (!a) throw new NotFoundError('Approach');

    const toClub = await tx.club.findUnique({ where: { id: a.fromClubId } });
    if (!toClub) throw new NotFoundError('Club');

    // 1 · close the period he is leaving, and keep it. Whichever record holds
    // him — an engagement, or only the membership the platform has always had —
    // is closed, never deleted.
    const held = await currentJob(a.staffUserId, tx);
    if (held) {
      if (held.clubId === a.fromClubId) throw new ConflictError('Already employed by that club');
      if (held.engagement) {
        await tx.staffEngagement.update({
          where: { id: held.engagement.id },
          data: { isActive: false, endedAt: new Date() },
        });
      } else {
        // No engagement had been recorded for the job he is leaving. One is
        // written now, closed, so the club he came from survives in his
        // career history instead of disappearing with the membership.
        const from = await tx.club.findUnique({ where: { id: held.clubId } });
        await tx.staffEngagement.create({
          data: {
            userId: a.staffUserId, clubId: held.clubId, role: held.role,
            startedAt: held.membership!.joinedAt, endedAt: new Date(), isActive: false,
            clubName: from?.name ?? null, country: from?.country ?? null,
          },
        });
      }
      // 2 · and he is no longer that club's active staff
      await tx.membership.updateMany({
        where: { userId: a.staffUserId, clubId: held.clubId, role: held.role, isActive: true },
        data: { isActive: false, leftAt: new Date() },
      });
    }
    const open = held?.engagement ?? null;

    // 3 · the new period, with its own contract terms
    const endsAt = a.durationMonths
      ? new Date(Date.now() + a.durationMonths * 30 * 24 * 3600 * 1000)
      : null;
    const engagement = await tx.staffEngagement.create({
      data: {
        userId: a.staffUserId,
        clubId: a.fromClubId,
        role: a.proposedRole,
        startedAt: new Date(),
        isActive: true,
        salary: a.salary,
        contractEndsAt: endsAt,
        clubName: toClub.name,
        country: toClub.country,
        league: open?.league ?? null,
      },
    });

    // 4 · and he is that club's active staff, through the same Membership the
    // rest of the platform reads
    // Membership's uniqueness includes teamId, which is null for a club-wide
    // technical role — and a compound unique cannot be addressed with a null
    // component. So the row is looked up and then written, which is the same
    // thing without asking Prisma for a key it cannot build.
    const priorMembership = await tx.membership.findFirst({
      where: { userId: a.staffUserId, clubId: a.fromClubId, teamId: null, role: a.proposedRole },
    });
    if (priorMembership) {
      await tx.membership.update({
        where: { id: priorMembership.id },
        data: { isActive: true, leftAt: null, joinedAt: new Date() },
      });
    } else {
      await tx.membership.create({
        data: { userId: a.staffUserId, clubId: a.fromClubId, role: a.proposedRole, isActive: true },
      });
    }

    // 5 · availability follows employment
    await tx.staffProfile.upsert({
      where: { userId: a.staffUserId },
      update: { availability: 'EMPLOYED' },
      create: { userId: a.staffUserId, availability: 'EMPLOYED' },
    });

    await tx.staffApproach.update({
      where: { id: approachId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    return { engagementId: engagement.id, staffUserId: a.staffUserId, toClubId: a.fromClubId, fromClubId: open?.clubId ?? null };
  });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'STAFF_TRANSFER_COMPLETED', entityType: 'StaffEngagement', entityId: result.engagementId,
    payload: result,
  });
  return hydrateApproach(approachId);
}

// ── this club's own desk ─────────────────────────────────────────────────────
export async function myActivity(actor: StaffActor) {
  const [outgoing, incoming] = await Promise.all([
    prisma.staffApproach.findMany({
      where: { fromClubId: actor.clubId },
      orderBy: { updatedAt: 'desc' }, take: 100,
    }),
    prisma.staffApproach.findMany({
      where: { currentClubId: actor.clubId, NOT: { fromClubId: actor.clubId } },
      orderBy: { updatedAt: 'desc' }, take: 100,
    }),
  ]);
  const ids = [...outgoing, ...incoming].map((a) => a.id);
  const full = await Promise.all(ids.map((id) => hydrateApproach(id)));
  const byId = new Map(full.map((f) => [f.id, f]));

  const hires = await prisma.staffEngagement.findMany({
    where: { clubId: actor.clubId },
    include: { club: { select: publicClubSelect }, user: { select: publicUserSelect } },
    orderBy: { startedAt: 'desc' }, take: 50,
  });

  return {
    outgoing: outgoing.map((a) => byId.get(a.id)).filter(Boolean),
    incoming: incoming.map((a) => byId.get(a.id)).filter(Boolean),
    negotiating: full.filter((f) => f.status === 'NEGOTIATING'),
    completedHires: hires.filter((h) => h.isActive).map((h) => ({
      staffUserId: h.userId, name: `${h.user.firstName} ${h.user.lastName}`.trim(),
      role: h.role, since: h.startedAt, salary: money(h.salary), contractEndsAt: h.contractEndsAt,
    })),
    departures: hires.filter((h) => !h.isActive).map((h) => ({
      staffUserId: h.userId, name: `${h.user.firstName} ${h.user.lastName}`.trim(),
      role: h.role, from: h.startedAt, to: h.endedAt,
    })),
  };
}

// The club's active technical staff, read from Membership — the same list the
// rest of the platform uses, so there is nothing to keep in step.
export async function myStaff(actor: StaffActor) {
  const memberships = await prisma.membership.findMany({
    where: { clubId: actor.clubId, isActive: true, role: { in: TECHNICAL_ROLES } },
    include: { user: { select: publicUserSelect } },
    orderBy: { role: 'asc' },
  });
  const engagements = await prisma.staffEngagement.findMany({
    where: { clubId: actor.clubId, isActive: true },
  });
  const byUser = new Map(engagements.map((e) => [e.userId, e]));
  return {
    items: memberships.map((m) => {
      const e = byUser.get(m.userId);
      return {
        staffUserId: m.userId,
        name: `${m.user.firstName} ${m.user.lastName}`.trim(),
        avatar: m.user.avatar,
        role: m.role,
        since: e?.startedAt ?? m.joinedAt,
        salary: money(e?.salary),
        contractEndsAt: e?.contractEndsAt ?? null,
      };
    }),
  };
}

// ── staff needs ──────────────────────────────────────────────────────────────
export async function readNeeds(actor: StaffActor, opts: { mine?: boolean } = {}) {
  const needs = await prisma.staffNeed.findMany({
    where: { isActive: true, ...(opts.mine ? { clubId: actor.clubId } : {}) },
    include: { club: { select: publicClubSelect } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });
  return {
    items: needs.map((n) => ({
      id: n.id, club: n.club, role: n.role, priority: n.priority,
      minLicence: n.minLicence, minLevel: n.minLevel,
      salaryMin: money(n.salaryMin), salaryMax: money(n.salaryMax),
      minExperience: n.minExperience, contractType: n.contractType,
      startDate: n.startDate, languages: n.languages,
      youthRequired: n.youthRequired, seniorRequired: n.seniorRequired,
      createdAt: n.createdAt,
      note: n.note, isMine: n.clubId === actor.clubId,
    })),
  };
}

export async function createNeed(actor: StaffActor, dto: {
  role: MembershipRole; priority?: string; minLicence?: string; minLevel?: number;
  salaryMin?: number; salaryMax?: number; note?: string;
  minExperience?: number; contractType?: string; startDate?: string;
  languages?: string[]; youthRequired?: boolean; seniorRequired?: boolean;
}) {
  if (!dto?.role || !isTechnical(dto.role)) throw new BadRequestError('role must be a technical staff role');
  const n = await prisma.staffNeed.create({
    data: {
      clubId: actor.clubId,
      role: dto.role,
      priority: (dto.priority as never) ?? 'NORMAL',
      minLicence: dto.minLicence ?? null,
      minLevel: dto.minLevel ?? null,
      salaryMin: dto.salaryMin != null ? BigInt(Math.round(dto.salaryMin)) : null,
      salaryMax: dto.salaryMax != null ? BigInt(Math.round(dto.salaryMax)) : null,
      note: dto.note ?? null,
      minExperience: dto.minExperience ?? null,
      contractType: dto.contractType ?? null,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      languages: Array.isArray(dto.languages) ? dto.languages : [],
      youthRequired: dto.youthRequired === true,
      seniorRequired: dto.seniorRequired === true,
    },
  });
  return { id: n.id };
}

export async function closeNeed(actor: StaffActor, needId: string) {
  const n = await prisma.staffNeed.findUnique({ where: { id: needId } });
  if (!n) throw new NotFoundError('Staff need');
  if (n.clubId !== actor.clubId) throw new ForbiddenError('That need belongs to another club');
  await prisma.staffNeed.update({ where: { id: needId }, data: { isActive: false } });
  return { ok: true };
}

// ── keeping the record ───────────────────────────────────────────────────────
// The professional record is maintained, not generated. A club completes what
// it knows about its own staff; nothing here invents a licence or a trophy.
export async function upsertProfile(actor: StaffActor, staffUserId: string, dto: Record<string, unknown>) {
  const user = await prisma.user.findUnique({ where: { id: staffUserId } });
  if (!user) throw new NotFoundError('User');
  // Only a club that currently employs somebody may edit his record.
  const employed = await prisma.membership.findFirst({
    where: { userId: staffUserId, clubId: actor.clubId, isActive: true },
  });
  if (!employed) throw new ForbiddenError('Only the employing club may edit this record');

  const num = (k: string) => (typeof dto[k] === 'number' ? (dto[k] as number) : undefined);
  const arr = (k: string) => (Array.isArray(dto[k]) ? (dto[k] as string[]) : undefined);
  const str = (k: string) => (typeof dto[k] === 'string' ? (dto[k] as string) : undefined);

  const data = {
    nationality: str('nationality'), secondNationality: str('secondNationality'),
    dateOfBirth: dto.dateOfBirth ? new Date(String(dto.dateOfBirth)) : undefined,
    level: num('level'), yearsExperience: num('yearsExperience'),
    availability: str('availability') as StaffAvailability | undefined,
    wageExpectation: num('wageExpectation') != null ? BigInt(Math.round(num('wageExpectation')!)) : undefined,
    tacticalKnowledge: num('tacticalKnowledge'), trainingQuality: num('trainingQuality'),
    playerDevelopment: num('playerDevelopment'), manManagement: num('manManagement'),
    matchPreparation: num('matchPreparation'), analysis: num('analysis'), leadership: num('leadership'),
    specialities: arr('specialities'), philosophy: arr('philosophy'),
    dominantPhilosophy: arr('dominantPhilosophy'), trainingMethods: arr('trainingMethods'),
    primaryFormation: str('primaryFormation'), secondaryFormations: arr('secondaryFormations'),
    notes: str('notes'),
    nationalTeamExperience: typeof dto.nationalTeamExperience === 'boolean' ? dto.nationalTeamExperience : undefined,
    youthNationalTeamExperience: typeof dto.youthNationalTeamExperience === 'boolean' ? dto.youthNationalTeamExperience : undefined,
    // the rest of the record the staff database keeps
    languages: arr('languages'), reputation: num('reputation'), coachingStyle: str('coachingStyle'),
    attackingApproach: str('attackingApproach'), defensiveApproach: str('defensiveApproach'),
    transitionApproach: str('transitionApproach'), developmentStyle: str('developmentStyle'),
    certifications: arr('certifications'), education: arr('education'),
    seniorYears: num('seniorYears'), academyYears: num('academyYears'),
    youthAgeGroups: arr('youthAgeGroups'),
    careerIntent: str('careerIntent') as StaffCareerIntent | undefined,
    availableFrom: dto.availableFrom ? new Date(String(dto.availableFrom)) : undefined,
    preferredRoles: Array.isArray(dto.preferredRoles)
      ? (dto.preferredRoles as MembershipRole[]).filter(isTechnical) : undefined,
    preferredCountries: arr('preferredCountries'), preferredLeagues: arr('preferredLeagues'),
    preferredClubLevel: str('preferredClubLevel'),
  };
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

  await prisma.staffProfile.upsert({
    where: { userId: staffUserId },
    update: clean,
    create: { userId: staffUserId, ...clean } as never,
  });
  return readStaff(actor, staffUserId);
}

// A club that has staff but no professional records yet gets them created from
// what the platform already knows — the membership, its role and its start
// date. Nothing is invented: the level is the schema's default and every
// professional field is left empty for somebody to complete.
export async function ensureProfilesForClub(actor: StaffActor) {
  const memberships = await prisma.membership.findMany({
    where: { clubId: actor.clubId, isActive: true, role: { in: TECHNICAL_ROLES } },
    include: { club: { select: { id: true, name: true, country: true } } },
  });
  let profiles = 0, engagements = 0;
  for (const m of memberships) {
    const existing = await prisma.staffProfile.findUnique({ where: { userId: m.userId } });
    if (!existing) { await prisma.staffProfile.create({ data: { userId: m.userId } }); profiles++; }
    const open = await prisma.staffEngagement.findFirst({ where: { userId: m.userId, isActive: true } });
    if (!open) {
      await prisma.staffEngagement.create({
        data: {
          userId: m.userId, clubId: m.clubId, role: m.role,
          startedAt: m.joinedAt, isActive: true,
          clubName: m.club.name, country: m.club.country,
        },
      });
      engagements++;
    }
  }
  return { profiles, engagements, staff: memberships.length };
}

// Every club on the platform, for the market's own filters. Read, not listed.
export async function clubsOnTheMarket() {
  const clubs = await prisma.club.findMany({
    select: publicClubSelect, orderBy: { name: 'asc' }, take: 500,
  });
  return { items: clubs, total: clubs.length };
}

// ── the shortlist ────────────────────────────────────────────────────────────
// A club watching somebody. It is the club's, not the browser's: the clubId is
// the session's own, never a value the client sent, so one club cannot read or
// write another's list. Nothing about it reaches the staff member.

async function isShortlisted(clubId: string, staffUserId: string) {
  const row = await prisma.staffShortlist.findUnique({
    where: { clubId_staffUserId: { clubId, staffUserId } },
    select: { id: true },
  });
  return !!row;
}

export async function readShortlist(actor: StaffActor) {
  const rows = await prisma.staffShortlist.findMany({
    where: { clubId: actor.clubId },
    include: {
      staffUser: { select: publicUserSelect },
      addedBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return {
    items: rows.map((r) => ({
      staffUserId: r.staffUserId,
      name: `${r.staffUser.firstName} ${r.staffUser.lastName}`.trim(),
      avatar: r.staffUser.avatar,
      note: r.note,
      priority: r.priority,
      stage: r.stage,
      addedBy: r.addedBy ? `${r.addedBy.firstName} ${r.addedBy.lastName}`.trim() : null,
      addedAt: r.createdAt,
    })),
    total: rows.length,
  };
}

// Idempotent both ways — marking a coach twice is marking him once, and the
// same button unmarks him.
export async function addToShortlist(actor: StaffActor, staffUserId: string, note?: string) {
  const user = await prisma.user.findUnique({ where: { id: staffUserId }, select: { id: true } });
  if (!user) throw new NotFoundError('Staff member');
  await prisma.staffShortlist.upsert({
    where: { clubId_staffUserId: { clubId: actor.clubId, staffUserId } },
    update: { note: note ?? undefined },
    create: { clubId: actor.clubId, staffUserId, addedById: actor.userId, note: note ?? null },
  });
  return { staffUserId, isShortlisted: true };
}

// The club's own judgement on somebody it is watching. Idempotent, and it
// never touches anything the staff member or his club can see.
export async function setShortlistMeta(actor: StaffActor, staffUserId: string, dto: {
  priority?: string; stage?: string; note?: string;
}) {
  const row = await prisma.staffShortlist.findUnique({
    where: { clubId_staffUserId: { clubId: actor.clubId, staffUserId } },
    select: { id: true },
  });
  if (!row) throw new NotFoundError('That staff member is not on our shortlist');
  const PRI = ['HIGH', 'MEDIUM', 'LOW'];
  const STG = ['WATCHING', 'CONTACTED', 'INTERVIEW', 'NEGOTIATION', 'OFFER_SENT'];
  if (dto.priority && !PRI.includes(dto.priority)) throw new BadRequestError('Unknown priority');
  if (dto.stage && !STG.includes(dto.stage)) throw new BadRequestError('Unknown recruitment stage');
  const updated = await prisma.staffShortlist.update({
    where: { id: row.id },
    data: {
      priority: (dto.priority as never) ?? undefined,
      stage: (dto.stage as never) ?? undefined,
      note: dto.note !== undefined ? (String(dto.note).trim() || null) : undefined,
    },
    select: { staffUserId: true, priority: true, stage: true, note: true },
  });
  return updated;
}

export async function removeFromShortlist(actor: StaffActor, staffUserId: string) {
  await prisma.staffShortlist.deleteMany({ where: { clubId: actor.clubId, staffUserId } });
  return { staffUserId, isShortlisted: false };
}

// ── comparison ───────────────────────────────────────────────────────────────
// Two or three records side by side. It reads the same projection a profile
// does, so a figure in the comparison and the same figure in the profile cannot
// disagree — there is no second derivation of anything here.
export async function compareStaff(actor: StaffActor, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 4);
  if (unique.length < 2) throw new BadRequestError('Comparing needs at least two staff members');
  const items = await Promise.all(unique.map((id) => readStaff(actor, id)));
  return { items, total: items.length };
}


// ── the club's own notes ─────────────────────────────────────────────────────
// Private to the club that wrote them. The staff member never sees them and
// neither does any other club — the clubId is the session's own.

async function readNoteBody(clubId: string, staffUserId: string) {
  const row = await prisma.staffClubNote.findUnique({
    where: { clubId_staffUserId: { clubId, staffUserId } },
    select: { body: true, updatedAt: true },
  });
  return row ? { body: row.body, updatedAt: row.updatedAt } : null;
}

export async function saveClubNote(actor: StaffActor, staffUserId: string, body: string) {
  const text = String(body ?? '').trim();
  const user = await prisma.user.findUnique({ where: { id: staffUserId }, select: { id: true } });
  if (!user) throw new NotFoundError('Staff member');
  if (!text) {
    await prisma.staffClubNote.deleteMany({ where: { clubId: actor.clubId, staffUserId } });
    return { staffUserId, note: null };
  }
  if (text.length > 4000) throw new BadRequestError('A note is at most 4000 characters');
  const saved = await prisma.staffClubNote.upsert({
    where: { clubId_staffUserId: { clubId: actor.clubId, staffUserId } },
    update: { body: text, updatedById: actor.userId },
    create: { clubId: actor.clubId, staffUserId, body: text, updatedById: actor.userId },
  });
  return { staffUserId, note: { body: saved.body, updatedAt: saved.updatedAt } };
}

// ── an approach the recipient has seen ───────────────────────────────────────
// Only the club being approached can move it to VIEWED, and only from a state
// that has actually been sent. It never moves backwards.
export async function markApproachViewed(actor: StaffActor, approachId: string) {
  const a = await prisma.staffApproach.findUnique({ where: { id: approachId } });
  if (!a) throw new NotFoundError('Approach');
  const mine = a.currentClubId === actor.clubId || (!a.currentClubId && a.staffUserId === actor.userId);
  if (!mine) throw new ForbiddenError('That approach is not yours');
  if (!['SUBMITTED', 'SENT'].includes(a.status)) return { id: a.id, status: a.status };
  const updated = await prisma.staffApproach.update({
    where: { id: approachId },
    data: { status: 'VIEWED', viewedAt: new Date() },
  });
  return { id: updated.id, status: updated.status, viewedAt: updated.viewedAt };
}

// ── an invitation to talk ────────────────────────────────────────────────────
// An interview is a message on the approach, not a second kind of record: the
// negotiation already is the conversation, and this puts the invitation in it
// where both clubs can see it.
export async function inviteToInterview(actor: StaffActor, approachId: string, when?: string, note?: string) {
  const a = await prisma.staffApproach.findUnique({ where: { id: approachId } });
  if (!a) throw new NotFoundError('Approach');
  if (a.fromClubId !== actor.clubId && a.currentClubId !== actor.clubId) {
    throw new ForbiddenError('That approach is not yours');
  }
  if (!isOpenApproach(a.status)) throw new ConflictError('That approach is not open');
  const body = ['Interview invitation', when ? `Proposed: ${new Date(when).toISOString().slice(0, 16).replace('T', ' ')}` : null, note || null]
    .filter(Boolean).join(' — ');
  const msg = await prisma.staffApproachMessage.create({
    data: { approachId, fromClubId: actor.clubId, body },
  });
  return { id: msg.id, approachId, body };
}

// ── external candidates ──────────────────────────────────────────────────────
// A free agent nobody employs still has one canonical identity: a User row and
// a StaffProfile hanging off it, exactly as an employed coach does. This adds
// that person once and refuses to add him twice, so the database never grows a
// second record for the same human being.
export async function addExternalStaff(actor: StaffActor, dto: {
  firstName: string; lastName: string; email?: string; nationality?: string;
  role?: MembershipRole; dateOfBirth?: string; level?: number;
}) {
  const first = String(dto?.firstName ?? '').trim();
  const last = String(dto?.lastName ?? '').trim();
  if (!first || !last) throw new BadRequestError('A first and last name are required');
  const email = String(dto.email ?? '').trim().toLowerCase()
    || `${first}.${last}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + `.${Date.now()}@external.familista`;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new ConflictError('Somebody with that email is already on the platform');

  const created = await prisma.user.create({
    data: {
      email,
      passwordHash: '!external',   // cannot sign in; this is a record, not an account
      firstName: first, lastName: last,
      role: 'HEAD_COACH',
      isActive: true,
      // User.clubId is the platform's tenancy column and is required. It says
      // which club's books the record was created under — it is NOT employment.
      // Employment is a Membership, and this person is given none, which is
      // exactly what makes him a free agent everywhere the market looks.
      club: { connect: { id: actor.clubId } },
      staffProfile: {
        create: {
          nationality: dto.nationality ?? null,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
          level: dto.level ?? 60,
          availability: 'FREE_AGENT',
          careerIntent: 'ACTIVELY_LOOKING',
          preferredRoles: dto.role ? [dto.role] : [],
        },
      },
    },
    select: { id: true },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'STAFF_EXTERNAL_ADDED', entityType: 'User', entityId: created.id,
    payload: { name: `${first} ${last}` },
  });
  return { staffUserId: created.id };
}

// ── the current technical staff directory ────────────────────────────────────
// The Coaches module. Not a market: this is who is working where, right now,
// read from the teams that exist and the memberships that exist. No group is
// written down anywhere — a team created after this was written appears the
// moment it exists, with whoever is in it, and a staff member who moves changes
// group by himself because the membership is the only thing that says where he
// is.
//
// A membership with no teamId is club-wide and covers every team, so it is its
// own group rather than being copied into each one.

export async function coachesDirectory(_actor: StaffActor) {
  const [teams, memberships] = await Promise.all([
    prisma.team.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, shortName: true, kind: true, ageMin: true, ageMax: true,
        emblem: true, color: true,
        club: { select: publicClubSelect },
      },
      orderBy: [{ clubId: 'asc' }, { kind: 'asc' }, { name: 'asc' }],
      take: 2000,
    }),
    prisma.membership.findMany({
      where: { isActive: true, role: { in: TECHNICAL_ROLES }, user: { isActive: true } },
      include: { user: { select: publicUserSelect }, club: { select: publicClubSelect } },
      take: 5000,
    }),
  ]);

  const profiles = await prisma.staffProfile.findMany({
    where: { userId: { in: [...new Set(memberships.map((m) => m.userId))] } },
    include: profileInclude,
  });
  const byUser = new Map(profiles.map((p) => [p.userId, p]));

  const engagements = await prisma.staffEngagement.findMany({
    where: { userId: { in: [...new Set(memberships.map((m) => m.userId))] }, isActive: true },
    select: { userId: true, contractEndsAt: true, salary: true, startedAt: true, clubId: true },
  });
  const engByUser = new Map(engagements.map((e) => [e.userId, e]));

  const card = (m: (typeof memberships)[number]) => {
    const p = byUser.get(m.userId) ?? null;
    const eng = engByUser.get(m.userId) ?? null;
    const contractEndsAt = eng?.contractEndsAt ?? null;
    return {
      staffUserId: m.userId,
      name: `${m.user.firstName} ${m.user.lastName}`.trim(),
      avatar: m.user.avatar,
      role: m.role,
      since: m.joinedAt,
      nationality: p?.nationality ?? null,
      age: p?.dateOfBirth
        ? Math.floor((Date.now() - p.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000))
        : null,
      highestLicence: p?.licences?.[0]
        ? { code: p.licences[0].code, name: p.licences[0].name }
        : null,
      yearsExperience: p?.yearsExperience ?? null,
      reputation: p?.reputation ?? null,
      contractEndsAt,
      salary: money(eng?.salary),
      // The same status the market shows, from the same function — a coach does
      // not have one standing here and another one there.
      employmentStatus: employmentStatus({
        hasClub: true,
        availability: p?.availability ?? null,
        careerIntent: p?.careerIntent ?? null,
        contractEndsAt,
      }),
      hasProfile: !!p,
    };
  };

  const byTeam = new Map<string, typeof memberships>();
  const clubWide = new Map<string, typeof memberships>();
  memberships.forEach((m) => {
    const key = m.teamId ?? null;
    const bucket = key ? byTeam : clubWide;
    const id = key ?? m.clubId;
    if (!bucket.has(id)) bucket.set(id, [] as never);
    bucket.get(id)!.push(m);
  });

  const groups = teams.map((t) => {
    const staff = (byTeam.get(t.id) ?? []).map(card)
      .sort((a, b) => TECHNICAL_ROLES.indexOf(a.role) - TECHNICAL_ROLES.indexOf(b.role));
    return {
      kind: 'TEAM' as const,
      teamId: t.id,
      teamName: t.name,
      shortName: t.shortName,
      teamKind: t.kind,
      ageGroup: t.ageMin != null || t.ageMax != null
        ? `U${t.ageMax ?? t.ageMin}` : null,
      emblem: t.emblem, color: t.color,
      club: t.club,
      staffCount: staff.length,
      staff,
    };
  });

  // A club-wide technical membership belongs to the club, not to one of its
  // teams. It is said once, under the club, rather than repeated under each.
  const clubIds = [...clubWide.keys()];
  const clubs = clubIds.length
    ? await prisma.club.findMany({ where: { id: { in: clubIds } }, select: publicClubSelect })
    : [];
  const clubById = new Map(clubs.map((c) => [c.id, c]));
  clubIds.forEach((cid) => {
    const club = clubById.get(cid);
    if (!club) return;
    const staff = (clubWide.get(cid) ?? []).map(card)
      .sort((a, b) => TECHNICAL_ROLES.indexOf(a.role) - TECHNICAL_ROLES.indexOf(b.role));
    groups.push({
      kind: 'CLUB' as never,
      teamId: null as never,
      teamName: 'Club-wide',
      shortName: null,
      teamKind: 'CLUB' as never,
      ageGroup: null,
      emblem: club.emblem, color: null,
      club,
      staffCount: staff.length,
      staff,
    });
  });

  const totalStaff = new Set(memberships.map((m) => m.userId)).size;
  return {
    groups,
    totals: {
      clubs: new Set(groups.map((g) => g.club.id)).size,
      teams: teams.length,
      groups: groups.length,
      staff: totalStaff,
      // Groups with nobody in them are still groups: a team with no coach is
      // the thing a director most needs to see.
      groupsWithoutStaff: groups.filter((g) => g.staffCount === 0).length,
    },
  };
}
