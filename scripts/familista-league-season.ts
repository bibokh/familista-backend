#!/usr/bin/env ts-node
// Familista League — set up or rebuild a season
// ─────────────────────────────────────────────────────────────────────────────
// The administrative operation §34 describes, as a command rather than as a
// migration: choose the participating first teams, generate the calendar, give
// every fixture its Match, rebuild the table.
//
// It is a thin wrapper. Every decision it makes is made by the services the
// application itself uses — eligibility by league-eligibility.ts, participation
// and scheduling by familista-league.admin.service.ts, the pairings by the
// competition engine's round-robin, the table by the standings engine. Nothing
// here computes anything of its own, so running this cannot produce a season
// the application would not have produced.
//
//   npx ts-node scripts/familista-league-season.ts --dry-run
//   npx ts-node scripts/familista-league-season.ts --teams=<uuid>,<uuid>,…
//   npx ts-node scripts/familista-league-season.ts --start=2026-09-05 --interval=7
//
// With no --teams it enters every eligible first team on the platform. That is
// the intended production use: a platform with four registered clubs has four
// eligible first teams, and they are the four that play. Pass --teams to name
// them explicitly — which is what an environment full of test clubs needs.
//
// It refuses to touch a season that has a completed match, and says so. That
// check lives in the service, not here, so it cannot be bypassed by running
// this instead of using the application.

import { prisma } from '../src/config/database';
import { eligibleTeamWhere } from '../src/competition/league-eligibility';
import * as admin from '../src/competition/familista-league.admin.service';
import { getLeague } from '../src/competition/familista-league.service';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const DRY = process.argv.includes('--dry-run');

// The one actor allowed to do this. `assertLeagueAdmin` checks the role, and a
// command run against the database by an operator is the platform administrator
// by definition — there is no session to take it from.
const ACTOR: admin.LeagueActor = { userId: 'cli', clubId: '', role: 'SUPER_ADMIN' };

async function main(): Promise<void> {
  const league = await getLeague({});
  if (!league) {
    console.error('No Familista League exists. Create the competition first.');
    process.exit(1);
  }
  console.log(`League      ${league.name} · ${league.code} · season ${league.season}`);
  console.log(`Competition ${league.id}\n`);

  // ── what is there now ──────────────────────────────────────────────────────
  const [existingTeams, fixtures, played, withMatch, stats] = await Promise.all([
    prisma.competitionTeam.count({ where: { competitionId: league.id } }),
    prisma.fixture.count({ where: { competitionId: league.id } }),
    prisma.fixture.count({ where: { competitionId: league.id, status: 'PLAYED' } }),
    prisma.fixture.count({ where: { competitionId: league.id, matchId: { not: null } } }),
    prisma.fixture.findMany({ where: { competitionId: league.id, matchId: { not: null } }, select: { matchId: true } }),
  ]);
  const matchIds = stats.map((s) => s.matchId).filter((id): id is string => !!id);
  const recorded = matchIds.length
    ? await prisma.playerMatchStats.count({ where: { matchId: { in: matchIds } } })
    : 0;

  console.log('── current season ──');
  console.log(`  participants           ${existingTeams}`);
  console.log(`  fixtures               ${fixtures}  (${played} marked played)`);
  console.log(`  fixtures with a Match  ${withMatch}`);
  console.log(`  player records on them ${recorded}`);

  // Whether anything here is real is decided by whether it reaches the Match
  // Centre. A fixture with a score and no Match was written straight onto the
  // competition by an earlier setup; a fixture whose Match carries lineups,
  // events or player statistics is somebody's record of a game.
  if (recorded > 0) {
    console.error('\nSTOP: these fixtures carry recorded player statistics from the Match Centre.');
    console.error('That is real match history. Rebuilding the season would orphan it.');
    process.exit(2);
  }
  if (played > 0 && withMatch === 0) {
    console.log('\n  Those results were written onto the fixtures directly, with no Match behind');
    console.log('  any of them, so they are generated setup data from the previous League');
    console.log('  implementation rather than matches anybody played.');
  }

  // ── who should play ────────────────────────────────────────────────────────
  const named = (arg('teams') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const eligible = await prisma.team.findMany({
    where: {
      ...eligibleTeamWhere(),
      ...(named.length ? { id: { in: named } } : {}),
    },
    select: { id: true, name: true, clubId: true, club: { select: { name: true, crestUrl: true } } },
    orderBy: [{ club: { name: 'asc' } }],
  });

  if (named.length && eligible.length !== named.length) {
    console.error(`\n${named.length} team(s) named, ${eligible.length} of them eligible. An ineligible team cannot be entered.`);
    process.exit(1);
  }
  if (eligible.length < 2) {
    console.error('\nA league needs at least two eligible first teams.');
    process.exit(1);
  }

  console.log(`\n── participants to enter (${eligible.length}) ──`);
  for (const t of eligible) {
    console.log(`  ${t.club?.name ?? '—'}  ·  ${t.name}  ·  ${t.id}  ·  crest ${t.club?.crestUrl ? 'yes' : 'none'}`);
  }

  if (DRY) {
    console.log('\n--dry-run: nothing was written.');
    await prisma.$disconnect();
    return;
  }

  // ── enter them ─────────────────────────────────────────────────────────────
  const current = await prisma.competitionTeam.findMany({
    where: { competitionId: league.id },
    select: { teamId: true },
  });
  const wanted = new Set(eligible.map((t) => t.id));
  const have = new Set(current.map((c) => c.teamId));

  // Anything entered that is not wanted goes first, so that removing it happens
  // while the season still has no results — the service refuses otherwise.
  for (const teamId of have) {
    if (wanted.has(teamId)) continue;
    // Its fixtures go with it. They are the previous implementation's, and the
    // check above has already established that none of them reached a match.
    await prisma.fixture.deleteMany({
      where: { competitionId: league.id, OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] },
    });
    await prisma.competitionTeam.deleteMany({ where: { competitionId: league.id, teamId } });
    console.log(`  removed participant ${teamId}`);
  }
  for (const t of eligible) {
    if (have.has(t.id)) continue;
    await admin.addParticipant(ACTOR, league.id, t.id);
    console.log(`  entered ${t.club?.name ?? t.name}`);
  }

  // ── the calendar ───────────────────────────────────────────────────────────
  const outcome = await admin.rebuildSchedule(ACTOR, league.id, {
    startDate: arg('start'),
    intervalDays: arg('interval') ? Number(arg('interval')) : undefined,
  });

  console.log('\n── season built ──');
  console.log(`  participants    ${outcome.participants}`);
  console.log(`  matches         ${outcome.matches}`);
  console.log(`  rounds          ${outcome.rounds}`);
  console.log(`  Match rows made ${outcome.matchesLinked}`);
  console.log('\nEvery fixture is now a real Match. Play them in the Match Centre;');
  console.log('the table follows from there.');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
