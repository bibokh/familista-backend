/**
 * tests/academy-age-band-plan.unit.test.ts
 *
 * The age band is the team's own, and the plan is read-only.
 *
 * Production runs bands — U8-U10, U11-U13, U14-U16, U17-U19, U20-U23 — while
 * `TeamKind` carries a single age. A club running U8-U10 AND U11-U13 files both
 * under ACADEMY_U13, so grouping by kind puts two of one club's teams in one
 * competition and leaves other bands empty. That was the bug. These tests hold
 * the fix shut against a database shaped like the real one.
 *
 * The mocked client throws on every write, so a dry run that wrote anything
 * would fail here rather than in production.
 */

import { TeamKind } from '@prisma/client';

const BANDS = ['U8-U10', 'U11-U13', 'U14-U16', 'U17-U19', 'U20-U23'];
const CLUBS = ['club-a', 'club-b', 'club-c', 'club-d'];

// The kind a club's bootstrap picks from the oldest age in the band — which is
// exactly why two bands collide on ACADEMY_U13 and ACADEMY_U23.
const KIND_OF: Record<string, TeamKind> = {
  'U8-U10': TeamKind.ACADEMY_U13,
  'U11-U13': TeamKind.ACADEMY_U13,
  'U14-U16': TeamKind.ACADEMY_U17,
  'U17-U19': TeamKind.ACADEMY_U19,
  'U20-U23': TeamKind.ACADEMY_U23,
};

interface TeamRow {
  id: string; clubId: string; name: string; kind: TeamKind;
  isActive: boolean; ageMin: number | null; ageMax: number | null;
}

const TEAMS: TeamRow[] = [];
for (const clubId of CLUBS) {
  TEAMS.push({ id: `${clubId}-first`, clubId, name: 'First Team', kind: TeamKind.SENIOR, isActive: true, ageMin: null, ageMax: null });
  for (const band of BANDS) {
    TEAMS.push({
      id: `${clubId}-${band}`, clubId, name: `${clubId.toUpperCase()} ${band}`,
      kind: KIND_OF[band], isActive: true, ageMin: null, ageMax: null,
    });
  }
}

const SEASON = '2026/27';

// One academy competition already exists and is EMPTY — the state production is
// in. It must be populated, not duplicated. One legacy competition from the old
// single-age grouping also exists, and must be reported and left alone.
const COMPETITIONS = [
  { id: 'comp-first', clubId: null, code: 'FAMILISTA-LEAGUE', season: SEASON, ageGroup: null },
  { id: 'comp-u14-u16', clubId: null, code: 'FAMILISTA-LEAGUE-U14-U16', season: SEASON, ageGroup: 'U14-U16' },
  { id: 'comp-legacy-u13', clubId: null, code: 'FAMILISTA-LEAGUE-U13', season: SEASON, ageGroup: 'U13' },
];

const COMPETITION_TEAMS = [
  { competitionId: 'comp-first', teamId: 'club-a-first' },
  { competitionId: 'comp-first', teamId: 'club-b-first' },
  { competitionId: 'comp-first', teamId: 'club-c-first' },
  { competitionId: 'comp-first', teamId: 'club-d-first' },
];

const FIXTURES = [
  { id: 'fx-1', competitionId: 'comp-first', round: 1, status: 'PLAYED', homeTeamId: 'club-a-first', awayTeamId: 'club-b-first' },
  { id: 'fx-2', competitionId: 'comp-first', round: 1, status: 'SCHEDULED', homeTeamId: 'club-c-first', awayTeamId: 'club-d-first' },
];

const STANDINGS = COMPETITION_TEAMS.map((e) => ({ competitionId: e.competitionId, teamId: e.teamId }));

const writes: string[] = [];
const refuseWrite = (what: string) => async () => { writes.push(what); throw new Error(`WRITE ATTEMPTED: ${what}`); };

const idIn = (v: unknown, value: string | null) =>
  v == null ? true
    : typeof v === 'string' ? v === value
    : Array.isArray((v as { in?: string[] }).in) ? (v as { in: (string | null)[] }).in.includes(value)
    : true;

jest.mock('../src/config/database', () => ({
  prisma: {
    team: {
      findMany: async ({ where = {} }: any = {}) => TEAMS.filter((t) =>
        (where.isActive === undefined || t.isActive === where.isActive)
        && (where.kind ? idIn(where.kind, t.kind) : true)
        && (where.id ? idIn(where.id, t.id) : true))
        .map((t) => ({ ...t, club: { name: t.clubId.toUpperCase(), crestUrl: null, emblem: null } })),
      findUnique: async ({ where }: any) => TEAMS.find((t) => t.id === where.id) ?? null,
      count: async ({ where = {} }: any = {}) => TEAMS.filter((t) =>
        (where.isActive === undefined || t.isActive === where.isActive)
        && (where.kind ? idIn(where.kind, t.kind) : true)).length,
      create: refuseWrite('team.create'),
      update: refuseWrite('team.update'),
    },
    competition: {
      findFirst: async ({ where = {} }: any = {}) => COMPETITIONS.find((c) =>
        (where.clubId === undefined || c.clubId === where.clubId)
        && (where.code ? (typeof where.code === 'string' ? c.code === where.code : true) : true)
        && (where.season ? c.season === where.season : true)) ?? null,
      findMany: async ({ where = {} }: any = {}) => COMPETITIONS.filter((c) =>
        (where.clubId === undefined || c.clubId === where.clubId)
        && (where.code?.startsWith ? c.code.startsWith(where.code.startsWith) : true)),
      create: refuseWrite('competition.create'),
      update: refuseWrite('competition.update'),
      delete: refuseWrite('competition.delete'),
    },
    competitionTeam: {
      findMany: async ({ where = {} }: any = {}) => COMPETITION_TEAMS.filter((e) =>
        (where.competitionId ? e.competitionId === where.competitionId : true)),
      count: async ({ where = {} }: any = {}) =>
        COMPETITION_TEAMS.filter((e) => e.competitionId === where.competitionId).length,
      create: refuseWrite('competitionTeam.create'),
      createMany: refuseWrite('competitionTeam.createMany'),
      delete: refuseWrite('competitionTeam.delete'),
      deleteMany: refuseWrite('competitionTeam.deleteMany'),
    },
    fixture: {
      findMany: async ({ where = {} }: any = {}) => FIXTURES.filter((f) =>
        (where.competitionId ? f.competitionId === where.competitionId : true)),
      count: async ({ where = {} }: any = {}) => FIXTURES.filter((f) =>
        (where.competitionId ? f.competitionId === where.competitionId : true)
        && (where.status ? f.status === where.status : true)).length,
      create: refuseWrite('fixture.create'),
      createMany: refuseWrite('fixture.createMany'),
      delete: refuseWrite('fixture.delete'),
      deleteMany: refuseWrite('fixture.deleteMany'),
    },
    standingsEntry: {
      count: async ({ where = {} }: any = {}) =>
        STANDINGS.filter((s) => s.competitionId === where.competitionId).length,
      createMany: refuseWrite('standingsEntry.createMany'),
      deleteMany: refuseWrite('standingsEntry.deleteMany'),
    },
    match: { create: refuseWrite('match.create'), createMany: refuseWrite('match.createMany') },
    $transaction: refuseWrite('$transaction'),
  },
}));

import {
  planAcademySeasons, discoverAcademyBands, plannedCalendar, academyCategory,
} from '../src/competition/familista-league.bootstrap';

const bandOf = (plan: Awaited<ReturnType<typeof planAcademySeasons>>, band: string) =>
  plan.bands.find((b) => b.band === band)!;

describe('the bands are the ones production actually runs', () => {
  it('discovers each band from the team rows, not from the kind', async () => {
    const found = await discoverAcademyBands();
    expect(found.map((f) => f.band)).toEqual(BANDS.slice().sort((a, b) => a.localeCompare(b)));
    for (const f of found) {
      expect(f.teams).toHaveLength(CLUBS.length);
      expect(f.clubCount).toBe(CLUBS.length);
      // Every team in the band really carries that band, and the source says so.
      for (const t of f.teams) {
        expect(t.teamName).toContain(f.band);
        expect(t.bandSource).toBe('NAME_RANGE');
      }
    }
    // The collision the old grouping made: two bands, one kind — and they are
    // still two bands.
    const u8 = found.find((f) => f.band === 'U8-U10')!;
    const u11 = found.find((f) => f.band === 'U11-U13')!;
    expect(u8.teams.every((t) => t.kind === 'ACADEMY_U13')).toBe(true);
    expect(u11.teams.every((t) => t.kind === 'ACADEMY_U13')).toBe(true);
    expect(u8.teams.map((t) => t.teamId)).not.toEqual(expect.arrayContaining(u11.teams.map((t) => t.teamId)));
    // No first team is discovered as an academy band, ever.
    expect(found.flatMap((f) => f.teams).some((t) => t.kind === 'SENIOR')).toBe(false);
  });

  it('plans one competition per band, with its own code', async () => {
    const plan = await planAcademySeasons({ season: SEASON });
    expect(plan.bands.map((b) => b.band).sort()).toEqual(BANDS.slice().sort());
    for (const band of BANDS) {
      const b = bandOf(plan, band);
      expect(b.competitionCode).toBe(`FAMILISTA-LEAGUE-${band}`);
      expect(b.teams).toHaveLength(4);
      expect(b.skipped).toBe(false);
      // Four teams: every pair twice is twelve fixtures over six rounds.
      expect(b.participantsToAdd).toBe(4);
      expect(b.fixturesToCreate).toBe(12);
      expect(b.roundsToCreate).toBe(6);
      expect(b.standingsRowsToCreate).toBe(4);
      expect(b.crossBandParticipants).toBe(0);
      expect(b.seniorParticipants).toBe(0);
    }
    expect(plannedCalendar(4)).toEqual({ fixtures: 12, rounds: 6 });
    expect(plannedCalendar(3)).toEqual({ fixtures: 6, rounds: 6 });
    expect(plannedCalendar(1)).toEqual({ fixtures: 0, rounds: 0 });
  });

  it('populates an existing empty competition rather than duplicating it', async () => {
    const plan = await planAcademySeasons({ season: SEASON });
    const existing = bandOf(plan, 'U14-U16');
    expect(existing.competitionExists).toBe(true);
    expect(existing.competitionId).toBe('comp-u14-u16');
    expect(existing.existingParticipants).toBe(0);
    expect(existing.participantsToAdd).toBe(4);
    expect(existing.note).toMatch(/calendar would be generated/i);
    // Every other band has no competition yet and would get exactly one.
    for (const band of BANDS.filter((b) => b !== 'U14-U16')) {
      expect(bandOf(plan, band).competitionExists).toBe(false);
    }
    // One plan row per band: nothing is planned twice.
    expect(new Set(plan.bands.map((b) => b.competitionCode)).size).toBe(plan.bands.length);
  });

  it('reports the old single-age competition and leaves it alone', async () => {
    const plan = await planAcademySeasons({ season: SEASON });
    const orphan = plan.orphanCompetitions.find((c) => c.code === 'FAMILISTA-LEAGUE-U13');
    expect(orphan).toBeTruthy();
    expect(orphan!.participants).toBe(0);
    expect(orphan!.fixtures).toBe(0);
    // It is not adopted, renamed or claimed by any band.
    expect(plan.bands.some((b) => b.competitionId === orphan!.id)).toBe(false);
  });

  it('touches nothing of the First Team\'s league, and says so', async () => {
    const plan = await planAcademySeasons({ season: SEASON });
    expect(plan.firstTeam.code).toBe('FAMILISTA-LEAGUE');
    expect(plan.firstTeam.wouldChange).toBe(0);
    // Read, and reported as it stands.
    expect(plan.firstTeam.participants).toBe(4);
    expect(plan.firstTeam.fixtures).toBe(2);
    expect(plan.firstTeam.standingsRows).toBe(4);
    // No band's competition is the First Team's, by code or by id.
    for (const b of plan.bands) {
      expect(b.competitionCode.startsWith('FAMILISTA-LEAGUE-')).toBe(true);
      expect(b.competitionId).not.toBe('comp-first');
    }
  });

  it('ends in a verdict, and the verdict is derived rather than asserted', async () => {
    const plan = await planAcademySeasons({ season: SEASON });
    expect(plan.crossBandParticipants).toBe(0);
    expect(plan.duplicateParticipants).toBe(0);
    expect(plan.duplicateFixtures).toBe(0);
    expect(plan.blockers).toEqual([]);
    expect(plan.safe).toBe(true);
  });

  it('and the plan writes nothing at all', async () => {
    writes.length = 0;
    await planAcademySeasons({ season: SEASON });
    await discoverAcademyBands();
    expect(writes).toEqual([]);
  });

  it('a band nobody plays is named and skipped, never invented', async () => {
    const plan = await planAcademySeasons({ season: SEASON, ageGroups: ['U11-U13', 'U30-U32'] });
    expect(plan.bands.map((b) => b.band).sort()).toEqual(['U11-U13', 'U30-U32']);
    const missing = bandOf(plan, 'U30-U32');
    expect(missing.skipped).toBe(true);
    expect(missing.teams).toEqual([]);
    expect(missing.participantsToAdd).toBe(0);
    expect(missing.fixturesToCreate).toBe(0);
    expect(missing.note).toMatch(/no active team/i);
    // A named band is normalised the way a team's is, so spacing cannot split one.
    const spaced = await planAcademySeasons({ season: SEASON, ageGroups: ['u11 - u13'] });
    expect(spaced.bands.map((b) => b.band)).toEqual(['U11-U13']);
    expect(spaced.bands[0].teams).toHaveLength(4);
  });

  it('the same plan twice is the same plan — running it again adds nothing', async () => {
    const a = await planAcademySeasons({ season: SEASON });
    const b = await planAcademySeasons({ season: SEASON });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // And the category a band resolves to is stable, which is what makes the
    // write path idempotent: the same code is looked up, never a second one.
    expect(academyCategory('U11-U13').code).toBe(academyCategory('u11 - u13').code);
  });
});
