// Familista — Competition Engine (Phase Q)
// Target: src/competition/competition.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Manages the full competition lifecycle:
//   • Create competition + assign teams
//   • Schedule fixtures manually or auto-generate round-robin
//   • Record results → atomically rebuild StandingsEntry
//   • Query the table with correct football sort (pts → GD → GF → W → name)
//
// Auto-generator uses the standard circle/polygon round-robin algorithm:
//   fix team[0], rotate all other teams; n-1 rounds × n/2 matches.
//   Home & away legs generated unless homeLegOnly = true.
//
// _rebuildStandings() is a full delete-then-insert in one transaction to
// guarantee the table is always consistent (no partial updates).

import { Prisma, Competition, CompetitionTeam, Fixture, StandingsEntry } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export interface CompActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─── Competition CRUD ─────────────────────────────────────────────────────────

export interface CreateCompetitionDto {
  name:          string;
  code:          string;     // 2–20 uppercase chars/digits/underscores e.g. "EPL" "U18_SOUTH"
  season:        string;     // e.g. "2024-25"
  format:        string;     // CompetitionFormat: LEAGUE | CUP | GROUP_STAGE | FRIENDLY
  ageGroup?:     string;     // "U18" | "U21" | "SENIOR" etc.
  gender?:       string;     // "MALE" | "FEMALE" | "MIXED"
  countryCode?:  string;     // ISO 3166-1 alpha-2
  description?:  string;
}

export async function createCompetition(
  actor: CompActor,
  dto: CreateCompetitionDto,
): Promise<Competition> {
  const codeUpper = dto.code.toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(codeUpper)) {
    throw new BadRequestError('code must be 2–20 uppercase letters, digits, or underscores');
  }

  const existing = await prisma.competition.findFirst({
    where: { code: codeUpper, season: dto.season, clubId: actor.clubId },
  });
  if (existing) {
    throw new BadRequestError(`Competition ${codeUpper}/${dto.season} already exists for this club`);
  }

  return prisma.competition.create({
    data: {
      clubId:      actor.clubId,
      name:        dto.name.trim(),
      code:        codeUpper,
      season:      dto.season,
      format:      dto.format as any,
      ageGroup:    dto.ageGroup    ?? null,
      gender:      dto.gender      ?? null,
      countryCode: dto.countryCode ?? null,
      description: dto.description ?? null,
      createdBy:   actor.userId,
    },
  });
}

export async function getCompetition(actor: CompActor, competitionId: string): Promise<Competition> {
  return _assertCompOwner(actor, competitionId);
}

export async function listCompetitions(
  actor: CompActor,
  opts: { season?: string; format?: string; limit?: number; offset?: number } = {},
): Promise<{ items: Competition[]; total: number }> {
  const { limit = 20, offset = 0 } = opts;
  const where: Prisma.CompetitionWhereInput = {
    clubId: actor.clubId,
    ...(opts.season ? { season: opts.season }        : {}),
    ...(opts.format ? { format: opts.format as any } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.competition.findMany({
      where,
      orderBy: [{ season: 'desc' }, { name: 'asc' }],
      take: Math.min(limit, 100),
      skip: offset,
    }),
    prisma.competition.count({ where }),
  ]);
  return { items, total };
}

// ─── Teams ────────────────────────────────────────────────────────────────────

export async function addTeamToCompetition(
  actor: CompActor,
  competitionId: string,
  teamId: string,
): Promise<CompetitionTeam> {
  await _assertCompOwner(actor, competitionId);

  return prisma.competitionTeam.upsert({
    where:  { competitionId_teamId: { competitionId, teamId } },
    create: { competitionId, teamId, clubId: actor.clubId },
    update: {},
  });
}

export async function removeTeamFromCompetition(
  actor: CompActor,
  competitionId: string,
  teamId: string,
): Promise<void> {
  await _assertCompOwner(actor, competitionId);

  const hasFixtures = await prisma.fixture.findFirst({
    where: {
      competitionId,
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    select: { id: true },
  });
  if (hasFixtures) {
    throw new BadRequestError('Cannot remove a team that has fixtures scheduled');
  }

  await prisma.competitionTeam.deleteMany({ where: { competitionId, teamId } });
}

export async function listTeamsInCompetition(competitionId: string): Promise<CompetitionTeam[]> {
  return prisma.competitionTeam.findMany({ where: { competitionId } });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

export interface CreateFixtureDto {
  competitionId: string;
  homeTeamId:    string;
  awayTeamId:    string;
  scheduledAt:   string;    // ISO datetime
  venue?:        string;
  round?:        number;
  leg?:          number;    // 1 or 2 for two-legged knock-out ties
  matchId?:      string;    // optional link to an existing Match row
}

export interface RecordResultDto {
  fixtureId:       string;
  homeScore:       number;
  awayScore:       number;
  homeScoreAet?:   number;
  awayScoreAet?:   number;
  homePenalties?:  number;
  awayPenalties?:  number;
}

export async function createFixture(actor: CompActor, dto: CreateFixtureDto): Promise<Fixture> {
  await _assertCompOwner(actor, dto.competitionId);
  if (dto.homeTeamId === dto.awayTeamId) {
    throw new BadRequestError('Home and away team cannot be the same');
  }

  return prisma.fixture.create({
    data: {
      competitionId: dto.competitionId,
      clubId:        actor.clubId,
      homeTeamId:    dto.homeTeamId,
      awayTeamId:    dto.awayTeamId,
      scheduledAt:   new Date(dto.scheduledAt),
      venue:         dto.venue   ?? null,
      round:         dto.round   ?? null,
      leg:           dto.leg     ?? null,
      matchId:       dto.matchId ?? null,
      status:        'SCHEDULED',
    },
  });
}

export async function updateFixture(
  actor: CompActor,
  fixtureId: string,
  dto: Partial<Pick<CreateFixtureDto, 'scheduledAt' | 'venue' | 'matchId'>>,
): Promise<Fixture> {
  const fixture = await _assertFixtureOwner(actor, fixtureId);
  if (fixture.status === 'PLAYED') throw new BadRequestError('Cannot edit a played fixture');

  return prisma.fixture.update({
    where: { id: fixtureId },
    data: {
      ...(dto.scheduledAt ? { scheduledAt: new Date(dto.scheduledAt) } : {}),
      ...(dto.venue       !== undefined ? { venue: dto.venue }         : {}),
      ...(dto.matchId     !== undefined ? { matchId: dto.matchId }     : {}),
    },
  });
}

/**
 * Record a match result and atomically rebuild standings for the competition.
 */
export async function recordResult(
  actor: CompActor,
  dto: RecordResultDto,
): Promise<{ fixture: Fixture; standingsRebuilt: number }> {
  const fixture = await _assertFixtureOwner(actor, dto.fixtureId);
  if (fixture.status === 'CANCELLED') {
    throw new BadRequestError('Cannot record a result on a cancelled fixture');
  }
  if (dto.homeScore < 0 || dto.awayScore < 0) {
    throw new BadRequestError('Scores cannot be negative');
  }

  const updated = await prisma.fixture.update({
    where: { id: dto.fixtureId },
    data: {
      homeScore:     dto.homeScore,
      awayScore:     dto.awayScore,
      homeScoreAet:  dto.homeScoreAet  ?? null,
      awayScoreAet:  dto.awayScoreAet  ?? null,
      homePenalties: dto.homePenalties ?? null,
      awayPenalties: dto.awayPenalties ?? null,
      status:        'PLAYED',
      playedAt:      new Date(),
    },
  });

  const rebuilt = await _rebuildStandings(fixture.competitionId);
  return { fixture: updated, standingsRebuilt: rebuilt };
}

export async function cancelFixture(actor: CompActor, fixtureId: string): Promise<Fixture> {
  const fixture = await _assertFixtureOwner(actor, fixtureId);
  if (fixture.status === 'PLAYED') throw new BadRequestError('Cannot cancel a played fixture');

  return prisma.fixture.update({
    where: { id: fixtureId },
    data:  { status: 'CANCELLED' },
  });
}

export async function listFixtures(
  actor: CompActor,
  competitionId: string,
  opts: { round?: number; status?: string; teamId?: string; limit?: number; offset?: number } = {},
): Promise<{ items: Fixture[]; total: number }> {
  const { limit = 50, offset = 0 } = opts;
  const where: Prisma.FixtureWhereInput = {
    competitionId,
    clubId: actor.clubId,
    ...(opts.round  ? { round: opts.round }           : {}),
    ...(opts.status ? { status: opts.status as any }  : {}),
    ...(opts.teamId ? { OR: [{ homeTeamId: opts.teamId }, { awayTeamId: opts.teamId }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.fixture.findMany({
      where,
      orderBy: [{ round: 'asc' }, { scheduledAt: 'asc' }],
      take: Math.min(limit, 500),
      skip: offset,
    }),
    prisma.fixture.count({ where }),
  ]);
  return { items, total };
}

// ─── Round-robin generator ────────────────────────────────────────────────────

/**
 * Auto-generate all round-robin fixtures for the registered teams.
 *
 * Algorithm: "circle method" (Berry, 1981)
 *   Fix team[0], rotate all others clockwise, n-1 rounds × n/2 matches.
 *   Odd number of teams → add a virtual BYE entry (those pairs are skipped).
 *
 * Both legs are generated by default (home + away, offset by half the total rounds).
 * Set homeLegOnly = true for a one-round competition.
 */
export async function generateRoundRobinFixtures(
  actor: CompActor,
  competitionId: string,
  startDate: string,
  matchdayIntervalDays = 7,
  homeLegOnly = false,
): Promise<{ created: number }> {
  await _assertCompOwner(actor, competitionId);

  const teams = await prisma.competitionTeam.findMany({ where: { competitionId } });
  if (teams.length < 2) throw new BadRequestError('Need at least 2 teams to generate fixtures');

  const ids = teams.map((t) => t.teamId);
  if (ids.length % 2 !== 0) ids.push('BYE');   // phantom team for byes

  const n      = ids.length;
  const rounds = n - 1;
  const start  = new Date(startDate);
  const fixtures: Prisma.FixtureCreateManyInput[] = [];

  // Work on a copy so we can rotate without mutating.
  const ring = [...ids];

  for (let r = 0; r < rounds; r++) {
    const matchdayDate = new Date(start);
    matchdayDate.setDate(start.getDate() + r * matchdayIntervalDays);

    for (let m = 0; m < n / 2; m++) {
      const home = ring[m];
      const away = ring[n - 1 - m];
      if (home === 'BYE' || away === 'BYE') continue;

      fixtures.push({
        competitionId,
        clubId:      actor.clubId,
        homeTeamId:  home,
        awayTeamId:  away,
        scheduledAt: new Date(matchdayDate),
        round:       r + 1,
        leg:         1,
        status:      'SCHEDULED',
      });

      if (!homeLegOnly) {
        const awayLegDate = new Date(start);
        awayLegDate.setDate(
          start.getDate() + (r + rounds) * matchdayIntervalDays,
        );
        fixtures.push({
          competitionId,
          clubId:      actor.clubId,
          homeTeamId:  away,
          awayTeamId:  home,
          scheduledAt: awayLegDate,
          round:       r + 1 + rounds,
          leg:         2,
          status:      'SCHEDULED',
        });
      }
    }

    // Rotate ring: keep ring[0] fixed, shift rest right.
    const last = ring[n - 1];
    for (let i = n - 1; i > 1; i--) ring[i] = ring[i - 1];
    ring[1] = last;
  }

  const result = await prisma.fixture.createMany({ data: fixtures });
  return { created: result.count };
}

// ─── Standings ────────────────────────────────────────────────────────────────

export async function getStandings(
  actor: CompActor,
  competitionId: string,
): Promise<StandingsEntry[]> {
  await _assertCompOwner(actor, competitionId);
  return prisma.standingsEntry.findMany({
    where:   { competitionId },
    orderBy: { position: 'asc' },
  });
}

/**
 * Force a standings rebuild without recording a new result.
 * Useful after data corrections or manual fixture edits.
 */
export async function rebuildStandings(
  actor: CompActor,
  competitionId: string,
): Promise<{ rebuilt: number }> {
  await _assertCompOwner(actor, competitionId);
  const rebuilt = await _rebuildStandings(competitionId);
  return { rebuilt };
}

// ─── Private: standings algorithm ────────────────────────────────────────────

interface StandingRow {
  teamId: string;
  played: number;
  won:    number;
  drawn:  number;
  lost:   number;
  gf:     number;
  ga:     number;
  gd:     number;
  points: number;
  form:   string[];   // 'W' | 'D' | 'L' last 5, in chronological order
}

async function _rebuildStandings(competitionId: string): Promise<number> {
  const fixtures = await prisma.fixture.findMany({
    where:   { competitionId, status: 'PLAYED' },
    orderBy: { playedAt: 'asc' },   // chronological for correct form string
  });

  const rows = new Map<string, StandingRow>();

  const row = (teamId: string): StandingRow => {
    if (!rows.has(teamId)) {
      rows.set(teamId, { teamId, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0, form: [] });
    }
    return rows.get(teamId)!;
  };

  for (const f of fixtures) {
    const h = row(f.homeTeamId);
    const a = row(f.awayTeamId);
    const hs = f.homeScore ?? 0;
    const as_ = f.awayScore ?? 0;

    h.played++; a.played++;
    h.gf += hs; h.ga += as_;
    a.gf += as_; a.ga += hs;

    if (hs > as_) {
      h.won++; h.points += 3; h.form.push('W');
      a.lost++;               a.form.push('L');
    } else if (hs === as_) {
      h.drawn++; h.points += 1; h.form.push('D');
      a.drawn++; a.points += 1; a.form.push('D');
    } else {
      a.won++; a.points += 3; a.form.push('W');
      h.lost++;               h.form.push('L');
    }
  }

  const sorted = [...rows.values()]
    .map((r) => ({ ...r, gd: r.gf - r.ga }))
    .sort(
      (a, b) =>
        b.points - a.points   ||
        b.gd     - a.gd       ||
        b.gf     - a.gf       ||
        b.won    - a.won,
    );

  await prisma.$transaction(async (tx) => {
    await tx.standingsEntry.deleteMany({ where: { competitionId } });
    await tx.standingsEntry.createMany({
      data: sorted.map((r, i) => ({
        competitionId,
        teamId:       r.teamId,
        position:     i + 1,
        played:       r.played,
        won:          r.won,
        drawn:        r.drawn,
        lost:         r.lost,
        goalsFor:     r.gf,
        goalsAgainst: r.ga,
        goalDiff:     r.gd,
        points:       r.points,
        form:         r.form.slice(-5).join(''),   // "WWDLW"
      })),
    });
  });

  return sorted.length;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _assertCompOwner(actor: CompActor, competitionId: string): Promise<Competition> {
  const comp = await prisma.competition.findUnique({ where: { id: competitionId } });
  if (!comp) throw new NotFoundError('Competition');
  if (comp.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return comp;
}

async function _assertFixtureOwner(actor: CompActor, fixtureId: string): Promise<Fixture> {
  const f = await prisma.fixture.findUnique({ where: { id: fixtureId } });
  if (!f) throw new NotFoundError('Fixture');
  if (f.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return f;
}
