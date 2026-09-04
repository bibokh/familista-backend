#!/usr/bin/env node
// Academy Familista League — start the current season, per age group
// ─────────────────────────────────────────────────────────────────────────────
//   npm run league:init-academy-season -- --dry-run
//   npm run league:init-academy-season
//   npm run league:init-academy-season -- --season=2026/27 --start=2026-09-05
//   npm run league:init-academy-season -- --groups=U15,U17
//
// One competition per age group, and only where a real one can exist: an age
// group with fewer than two real teams on the platform is SKIPPED and said to
// be skipped. No club is created, no opponent is invented, and no age group is
// mixed with another — each competition carries its own `ageGroup`, and
// league-eligibility refuses anything else at the door.
//
// Safe to run more than once, for exactly the reasons the First Team's command
// is: it creates only what is missing, never deletes a fixture, never touches a
// played match and never invents a result.

import { prisma } from '../config/database';
import { initAcademySeasons, currentSeason } from '../competition/familista-league.bootstrap';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const DRY = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const season = arg('season') ?? currentSeason();
  console.log(`Academy Familista League — season ${season}${DRY ? '  (dry run)' : ''}\n`);

  const out = await initAcademySeasons({
    season,
    ageGroups: (arg('groups') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    startDate: arg('start'),
    intervalDays: arg('interval') ? Number(arg('interval')) : undefined,
    maxDiscovered: arg('max') ? Number(arg('max')) : undefined,
    dryRun: DRY,
  });

  for (const g of out.groups) {
    console.log(`── ${g.ageGroup} ──`);
    console.log(`  real teams      ${g.teamCount}`);
    if (g.skipped) {
      console.log(`  skipped         ${g.note}`);
      console.log('');
      continue;
    }
    const r = g.result!;
    console.log(`  competition     ${r.competitionId ?? '—'}${r.competitionCreated ? '  (created)' : '  (existing)'}`);
    console.log(`  participants    ${r.participantsEntered + r.participantsReused}`);
    console.log(`  fixtures        ${r.fixturesCreated || r.fixturesReused}`);
    console.log(`  rounds          ${r.rounds}`);
    console.log(`  matches linked  ${r.matchesLinked}`);
    console.log(`  standings rows  ${r.standingsRows}`);
    for (const p of r.participants) {
      console.log(`    ${p.entered ? '+' : '·'} ${p.clubName}  ·  ${p.teamName}  ·  ${p.teamId}`);
    }
    console.log('');
  }

  console.log('── summary ──');
  console.log(`  competitions created  ${out.competitionsCreated}`);
  console.log(`  fixtures created      ${out.fixturesCreated}`);
  console.log(`  age groups skipped    ${out.groups.filter((g) => g.skipped).length}`);

  if (DRY) console.log('\n--dry-run: nothing was written.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`\n${(e as Error).message}`);
  await prisma.$disconnect();
  process.exit(1);
});
