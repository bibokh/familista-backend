#!/usr/bin/env node
// Academy Familista League — start the current season, per age BAND
// ─────────────────────────────────────────────────────────────────────────────
//   npm run league:init-academy-season -- --dry-run        (read-only, always safe)
//   npm run league:init-academy-season                     (writes)
//   npm run league:init-academy-season -- --season=2026/27 --start=2026-09-12
//   npm run league:init-academy-season -- --groups=U11-U13,U14-U16
//
// One competition per age band, where a band is the team's OWN band — the one
// the club wrote into its name or recorded as a range — and not an age inferred
// from its TeamKind. A club that runs U8-U10 and U11-U13 files both under
// ACADEMY_U13; grouping by kind would put them in one competition, which is the
// mis-grouping this command exists not to make.
//
// Bands are matched by exact string equality. There is no "<= age", no overlap
// and no nearest band: U8-U10 plays U8-U10 and nothing else.
//
// --dry-run performs NO WRITES. It reports, per band, what exists now and what
// would be added, proves that nothing touches the First Team's competition, and
// ends with an explicit verdict. Run it first, read the verdict, then run the
// command without the flag.
//
// The write mode is safe to run more than once: it creates only what is
// missing, never deletes a fixture, never regenerates a calendar that already
// exists, never touches a played match and never invents a club, a team or a
// result.

import { prisma } from '../config/database';
import {
  initAcademySeasons,
  planAcademySeasons,
  currentSeason,
  type AcademyPlan,
} from '../competition/familista-league.bootstrap';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const DRY = process.argv.includes('--dry-run');
const groups = (arg('groups') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const pad = (label: string, value: string | number): string =>
  `  ${label.padEnd(34, ' ')}${value}`;

function printPlan(plan: AcademyPlan): void {
  for (const b of plan.bands) {
    console.log(`\n═══ ${b.band} ═══`);
    console.log(pad('real eligible teams', b.teams.length));
    for (const t of b.teams) {
      console.log(`    · ${t.clubName}  ·  ${t.teamName}  ·  ${t.teamId}  ·  kind ${t.kind}  ·  band from ${t.bandSource}`);
    }
    console.log(pad('competition', b.competitionExists
      ? `${b.competitionCode}  (exists — would be reused)`
      : `${b.competitionCode}  (would be created)`));
    console.log(pad('existing participants', b.existingParticipants));
    console.log(pad('participants WOULD be added', b.participantsToAdd));
    console.log(pad('existing rounds', b.existingRounds));
    console.log(pad('rounds WOULD be created', b.roundsToCreate));
    console.log(pad('existing fixtures', b.existingFixtures));
    console.log(pad('fixtures WOULD be created', b.fixturesToCreate));
    console.log(pad('existing standings rows', b.existingStandingsRows));
    console.log(pad('standings rows WOULD be created', b.standingsRowsToCreate));
    console.log(pad('already played', b.playedFixtures));
    console.log(pad('cross-band participants', b.crossBandParticipants));
    console.log(pad('first-team participants', b.seniorParticipants));
    console.log(`  ${b.skipped ? 'SKIPPED — ' : ''}${b.note}`);
  }

  if (plan.orphanCompetitions.length) {
    console.log('\n═══ academy competitions no band claims ═══');
    console.log('  Left exactly where they are — nothing here deletes or renames one.');
    for (const c of plan.orphanCompetitions) {
      console.log(`    · ${c.code}  ·  ${c.season}  ·  ageGroup ${c.ageGroup ?? '—'}`
        + `  ·  ${c.participants} participant(s)  ·  ${c.fixtures} fixture(s)  ·  ${c.id}`);
    }
  }

  console.log('\n═══ safety ═══');
  console.log(pad('FIRST TEAM IMPACT', plan.firstTeam.wouldChange));
  console.log(`    ${plan.firstTeam.code} — ${plan.firstTeam.participants} participant(s), `
    + `${plan.firstTeam.fixtures} fixture(s), ${plan.firstTeam.standingsRows} standings row(s): read, not touched`);
  console.log(pad('CROSS-AGE PARTICIPANTS', plan.crossBandParticipants));
  console.log(pad('DUPLICATE PARTICIPANTS', plan.duplicateParticipants));
  console.log(pad('DUPLICATE FIXTURES', plan.duplicateFixtures));

  console.log('');
  if (plan.safe) {
    console.log('SAFE TO INITIALIZE: YES');
  } else {
    console.log('SAFE TO INITIALIZE: NO');
    for (const b of plan.blockers) console.log(`  · ${b}`);
  }
}

async function main(): Promise<void> {
  const season = arg('season') ?? currentSeason();
  console.log(`Academy Familista League — season ${season}${DRY ? '  (dry run — read-only)' : ''}`);

  if (DRY) {
    // Read-only by construction: the planner counts and reads, and the write
    // path below is not reached at all.
    const plan = await planAcademySeasons({
      season,
      ageGroups: groups,
      minTeams: arg('min') ? Number(arg('min')) : undefined,
    });
    printPlan(plan);
    console.log('\n--dry-run: nothing was written.');
    await prisma.$disconnect();
    return;
  }

  const out = await initAcademySeasons({
    season,
    ageGroups: groups,
    startDate: arg('start'),
    intervalDays: arg('interval') ? Number(arg('interval')) : undefined,
    maxDiscovered: arg('max') ? Number(arg('max')) : undefined,
    minTeams: arg('min') ? Number(arg('min')) : undefined,
  });

  for (const g of out.groups) {
    console.log(`\n═══ ${g.ageGroup} ═══`);
    console.log(pad('real teams', g.teamCount));
    if (g.skipped) {
      console.log(`  SKIPPED — ${g.note}`);
      continue;
    }
    const r = g.result!;
    console.log(pad('competition', `${r.competitionId ?? '—'}${r.competitionCreated ? '  (created)' : '  (existing)'}`));
    console.log(pad('participants', r.participantsEntered + r.participantsReused));
    console.log(pad('fixtures', r.fixturesCreated || r.fixturesReused));
    console.log(pad('rounds', r.rounds));
    console.log(pad('matches linked', r.matchesLinked));
    console.log(pad('standings rows', r.standingsRows));
    for (const p of r.participants) {
      console.log(`    ${p.entered ? '+' : '·'} ${p.clubName}  ·  ${p.teamName}  ·  ${p.teamId}`);
    }
  }

  console.log('\n═══ summary ═══');
  console.log(pad('competitions created', out.competitionsCreated));
  console.log(pad('fixtures created', out.fixturesCreated));
  console.log(pad('bands skipped', out.groups.filter((g) => g.skipped).length));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`\n${(e as Error).message}`);
  await prisma.$disconnect();
  process.exit(1);
});
