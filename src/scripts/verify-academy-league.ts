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

import fs from 'fs';
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
  duplicateParticipants: number;
  duplicateFixtures: number;
  expectedFixtures: number;
  expectedRounds: number;
  ok: boolean;
  problems: string[];
}

export interface FirstTeamSnapshot {
  code: string;
  competitionId: string | null;
  season: string | null;
  participants: number;
  fixtures: number;
  standingsRows: number;
}

/**
 * The canonical First Team competition, counted.
 *
 * Taken before an initialisation and again after it, so "unchanged" is a
 * comparison of two readings rather than an assurance.
 */
export async function readFirstTeam(): Promise<FirstTeamSnapshot> {
  const first = await prisma.competition.findFirst({
    where: { clubId: null, code: LEAGUE_CODE },
    orderBy: [{ season: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, season: true },
  });
  return {
    code: LEAGUE_CODE,
    competitionId: first?.id ?? null,
    season: first?.season ?? null,
    participants: first ? await prisma.competitionTeam.count({ where: { competitionId: first.id } }) : 0,
    fixtures: first ? await prisma.fixture.count({ where: { competitionId: first.id } }) : 0,
    standingsRows: first ? await prisma.standingsEntry.count({ where: { competitionId: first.id } }) : 0,
  };
}

export async function verifyAcademyLeague(season: string): Promise<{
  season: string;
  bands: BandVerification[];
  firstTeam: FirstTeamSnapshot;
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
      select: { round: true, matchId: true, status: true, homeTeamId: true, awayTeamId: true },
    });

    // Duplicates, counted from the rows themselves: a team entered twice, or a
    // pair meeting twice in one round. Both are zero in a calendar generated
    // once; both would be the visible symptom of a second initialisation
    // having written over the first.
    const duplicateParticipants = entries.length - new Set(entries.map((e) => e.teamId)).size;
    const seenPairs = new Set<string>();
    let duplicateFixtures = 0;
    for (const f of fixtures) {
      const key = `${f.round}|${f.homeTeamId}|${f.awayTeamId}`;
      if (seenPairs.has(key)) duplicateFixtures++;
      seenPairs.add(key);
    }
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
    if (duplicateParticipants) problems.push(`${duplicateParticipants} duplicate participant(s)`);
    if (duplicateFixtures) problems.push(`${duplicateFixtures} duplicate fixture(s)`);

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
      duplicateParticipants,
      duplicateFixtures,
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

  return {
    season,
    bands,
    firstTeam: await readFirstTeam(),
    ok: bands.length > 0 && bands.every((b) => b.ok),
  };
}

async function main(): Promise<void> {
  const season = arg('season') ?? currentSeason();
  const snapshotTo = arg('snapshot-first-team');
  const compareWith = arg('compare-first-team');
  const quiet = process.argv.includes('--quiet');

  // ── snapshot mode: the First Team's numbers BEFORE anything runs ───────────
  if (snapshotTo) {
    const before = await readFirstTeam();
    console.log('\n═══ First Team Familista League — BEFORE ═══');
    console.log(pad('competition', `${before.code}  ·  ${before.competitionId ?? '—'}  ·  ${before.season ?? '—'}`));
    console.log(pad('participants', before.participants));
    console.log(pad('fixtures', before.fixtures));
    console.log(pad('standings rows', before.standingsRows));
    try { fs.writeFileSync(snapshotTo, JSON.stringify(before)); } catch (e) {
      console.log(`  (could not keep the snapshot at ${snapshotTo}: ${(e as Error).message})`);
    }
    await prisma.$disconnect();
    return;
  }

  const report = await verifyAcademyLeague(season);

  // ── check mode: is this season already initialised? ────────────────────────
  // Used by the boot so a season that is already in place is not initialised a
  // second time. It reads and reports an exit code, and prints nothing.
  if (quiet) {
    await prisma.$disconnect();
    process.exit(report.ok ? 0 : 1);
  }

  console.log(`\n╔══ Academy Familista League — what the database contains (${season}) ══╗`);

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

  console.log('\n═══ First Team Familista League — AFTER ═══');
  console.log(pad('competition', `${report.firstTeam.code}  ·  ${report.firstTeam.competitionId ?? '—'}  ·  ${report.firstTeam.season ?? '—'}`));
  console.log(pad('participants', report.firstTeam.participants));
  console.log(pad('fixtures', report.firstTeam.fixtures));
  console.log(pad('standings rows', report.firstTeam.standingsRows));
  console.log('  read only — no academy run selects this competition');

  // ── before and after, compared row by row ─────────────────────────────────
  let firstTeamUnchanged: boolean | null = null;
  if (compareWith) {
    try {
      const before = JSON.parse(fs.readFileSync(compareWith, 'utf8')) as FirstTeamSnapshot;
      const rows: Array<[string, string | number | null, string | number | null]> = [
        ['competition id', before.competitionId, report.firstTeam.competitionId],
        ['season', before.season, report.firstTeam.season],
        ['participants', before.participants, report.firstTeam.participants],
        ['fixtures', before.fixtures, report.firstTeam.fixtures],
        ['standings rows', before.standingsRows, report.firstTeam.standingsRows],
      ];
      console.log('\n═══ First Team — before → after ═══');
      firstTeamUnchanged = true;
      for (const [label, b, a] of rows) {
        const same = String(b) === String(a);
        if (!same) firstTeamUnchanged = false;
        console.log(`  ${label.padEnd(20, ' ')}${String(b ?? '—').padEnd(42, ' ')}→  ${String(a ?? '—')}   ${same ? 'unchanged' : 'CHANGED'}`);
      }
      console.log(`\nFIRST TEAM UNCHANGED: ${firstTeamUnchanged ? 'YES' : 'NO'}`);
    } catch (e) {
      console.log(`\n  (no before-snapshot to compare against: ${(e as Error).message})`);
    }
  }

  const totals = report.bands.reduce((acc, b) => ({
    cross: acc.cross + b.crossBandParticipants,
    senior: acc.senior + b.seniorParticipants,
    dupP: acc.dupP + b.duplicateParticipants,
    dupF: acc.dupF + b.duplicateFixtures,
  }), { cross: 0, senior: 0, dupP: 0, dupF: 0 });

  console.log('\n═══ totals ═══');
  console.log(pad('CROSS-AGE PARTICIPANTS', totals.cross));
  console.log(pad('FIRST-TEAM PARTICIPANTS', totals.senior));
  console.log(pad('DUPLICATE PARTICIPANTS', totals.dupP));
  console.log(pad('DUPLICATE FIXTURES', totals.dupF));

  const verified = report.ok && totals.cross === 0 && totals.senior === 0
    && totals.dupP === 0 && totals.dupF === 0 && firstTeamUnchanged !== false;
  console.log(`\nACADEMY LEAGUE VERIFIED: ${verified ? 'YES' : 'NO'}`);
  await prisma.$disconnect();
  process.exit(verified ? 0 : 1);
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(`\n${(e as Error).message}`);
    await prisma.$disconnect();
    process.exit(1);
  });
}
