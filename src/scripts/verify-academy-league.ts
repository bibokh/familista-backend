#!/usr/bin/env node
// Academy Familista League — what the database actually contains
// ─────────────────────────────────────────────────────────────────────────────
//   node dist/scripts/verify-academy-league.js [--season=2026/27]
//
// Read-only. It writes nothing, creates nothing and repairs nothing: it reads
// the rows back and reports them, band by band, so a log is proof rather than a
// claim. Run it after an initialisation — the startup one-shot does exactly
// that — or at any time to see the state of the competitions.
//
// Every number below is counted from the database in this process. Nothing is
// carried over from the run that created the rows.

import { prisma } from '../config/database';
import {
  currentSeason,
  LEAGUE_CODE,
  plannedCalendar,
} from '../competition/familista-league.bootstrap';
import { eligibilityFor } from '../competition/league-eligibility';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const pad = (label: string, value: string | number): string => `  ${label.padEnd(30, ' ')}${value}`;

export interface BandVerification {
  code: string;
  ageGroup: string | null;
  competitionId: string;
  participants: number;
  standingsRows: number;
  rounds: number;
  fixtures: number;
  matchesLinked: number;
  playedFixtures: number;
  crossBandParticipants: number;
  seniorParticipants: number;
  expectedFixtures: number;
  expectedRounds: number;
  ok: boolean;
  problems: string[];
}

export async function verifyAcademyLeague(season: string): Promise<{
  season: string;
  bands: BandVerification[];
  firstTeam: { code: string; competitionId: string | null; season: string | null; participants: number; fixtures: number; standingsRows: number };
  ok: boolean;
}> {
  const comps = await prisma.competition.findMany({
    where: { clubId: null, code: { startsWith: `${LEAGUE_CODE}-` }, season },
    select: { id: true, code: true, season: true, ageGroup: true },
    orderBy: { code: 'asc' },
  });

  const bands: BandVerification[] = [];
  for (const c of comps) {
    const entries = await prisma.competitionTeam.findMany({
      where: { competitionId: c.id },
      select: { teamId: true },
    });
    const teams = entries.length
      ? await prisma.team.findMany({
          where: { id: { in: entries.map((e) => e.teamId) } },
          select: {
            id: true, name: true, kind: true, isActive: true, ageMin: true, ageMax: true,
            club: { select: { name: true } },
          },
          orderBy: { name: 'asc' },
        })
      : [];

    let crossBand = 0;
    let senior = 0;
    for (const t of teams) {
      const verdict = eligibilityFor(c, {
        kind: t.kind, isActive: t.isActive, name: t.name, ageMin: t.ageMin, ageMax: t.ageMax,
      });
      if (!verdict.eligible) crossBand++;
      if (String(t.kind) === 'SENIOR') senior++;
    }

    const fixtures = await prisma.fixture.findMany({
      where: { competitionId: c.id },
      select: { round: true, matchId: true, status: true },
    });
    const standingsRows = await prisma.standingsEntry.count({ where: { competitionId: c.id } });
    const expected = plannedCalendar(entries.length);

    const problems: string[] = [];
    if (entries.length < 2) problems.push('fewer than two participants');
    if (standingsRows !== entries.length) problems.push(`standings rows ${standingsRows} ≠ participants ${entries.length}`);
    if (fixtures.length !== expected.fixtures) problems.push(`fixtures ${fixtures.length} ≠ expected ${expected.fixtures}`);
    const matchesLinked = fixtures.filter((f) => f.matchId).length;
    if (matchesLinked !== fixtures.length) problems.push(`${fixtures.length - matchesLinked} fixture(s) with no Match`);
    if (crossBand) problems.push(`${crossBand} participant(s) outside this band`);
    if (senior) problems.push(`${senior} first-team participant(s)`);

    bands.push({
      code: c.code,
      ageGroup: c.ageGroup,
      competitionId: c.id,
      participants: entries.length,
      standingsRows,
      rounds: new Set(fixtures.map((f) => f.round).filter((r) => r != null)).size,
      fixtures: fixtures.length,
      matchesLinked,
      playedFixtures: fixtures.filter((f) => f.status === 'PLAYED').length,
      crossBandParticipants: crossBand,
      seniorParticipants: senior,
      expectedFixtures: expected.fixtures,
      expectedRounds: expected.rounds,
      ok: problems.length === 0,
      problems,
    });

    // The squad list is printed by the caller from these rows, not re-read.
    (bands[bands.length - 1] as BandVerification & { teams?: unknown }).teams = teams.map((t) => ({
      teamId: t.id, teamName: t.name, clubName: t.club?.name ?? '', kind: String(t.kind),
    }));
  }

  const first = await prisma.competition.findFirst({
    where: { clubId: null, code: LEAGUE_CODE },
    orderBy: [{ season: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, season: true },
  });

  return {
    season,
    bands,
    firstTeam: {
      code: LEAGUE_CODE,
      competitionId: first?.id ?? null,
      season: first?.season ?? null,
      participants: first ? await prisma.competitionTeam.count({ where: { competitionId: first.id } }) : 0,
      fixtures: first ? await prisma.fixture.count({ where: { competitionId: first.id } }) : 0,
      standingsRows: first ? await prisma.standingsEntry.count({ where: { competitionId: first.id } }) : 0,
    },
    ok: bands.length > 0 && bands.every((b) => b.ok),
  };
}

async function main(): Promise<void> {
  const season = arg('season') ?? currentSeason();
  console.log(`\n╔══ Academy Familista League — what the database contains (${season}) ══╗`);

  const report = await verifyAcademyLeague(season);

  if (!report.bands.length) {
    console.log('\n  No academy competition exists for this season.');
  }

  for (const b of report.bands) {
    const teams = (b as BandVerification & { teams?: Array<{ clubName: string; teamName: string; teamId: string; kind: string }> }).teams ?? [];
    console.log(`\n═══ ${b.ageGroup ?? b.code} ═══`);
    console.log(pad('competition', `${b.code}  ·  ${b.competitionId}`));
    console.log(pad('participants', b.participants));
    for (const t of teams) console.log(`    · ${t.clubName}  ·  ${t.teamName}  ·  ${t.kind}  ·  ${t.teamId}`);
    console.log(pad('standings rows', b.standingsRows));
    console.log(pad('rounds', `${b.rounds}  (expected ${b.expectedRounds})`));
    console.log(pad('fixtures', `${b.fixtures}  (expected ${b.expectedFixtures})`));
    console.log(pad('matches linked', `${b.matchesLinked}  (Match Center)`));
    console.log(pad('already played', b.playedFixtures));
    console.log(pad('cross-band participants', b.crossBandParticipants));
    console.log(pad('first-team participants', b.seniorParticipants));
    console.log(`  ${b.ok ? 'OK' : 'PROBLEM — ' + b.problems.join('; ')}`);
  }

  console.log('\n═══ First Team Familista League ═══');
  console.log(pad('competition', `${report.firstTeam.code}  ·  ${report.firstTeam.competitionId ?? '—'}  ·  ${report.firstTeam.season ?? '—'}`));
  console.log(pad('participants', report.firstTeam.participants));
  console.log(pad('fixtures', report.firstTeam.fixtures));
  console.log(pad('standings rows', report.firstTeam.standingsRows));
  console.log('  read only — no academy run selects this competition');

  console.log(`\nACADEMY LEAGUE VERIFIED: ${report.ok ? 'YES' : 'NO'}`);
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(`\n${(e as Error).message}`);
    await prisma.$disconnect();
    process.exit(1);
  });
}
