#!/usr/bin/env node
// Familista League — start the current season
// ─────────────────────────────────────────────────────────────────────────────
//   npm run league:init-current-season -- --dry-run
//   npm run league:init-current-season
//   npm run league:init-current-season -- --season=2026/27 --start=2026-09-05
//   npm run league:init-current-season -- --teams=<uuid>,<uuid>,…
//
// On Render this is a one-off job against the deployed image, which already
// carries `dist/` and the same DATABASE_URL as the service:
//
//   npm run league:init-current-season
//
// It compiles into dist/ with everything else, so it needs no ts-node and no
// database credentials of its own — it reads the environment the service
// already has. Nothing is printed that a log drain should not see: team and club
// names and ids, and counts.
//
// Safe to run more than once. It creates only what is missing, never deletes a
// fixture, never touches a played match, and never invents a club, a team, a
// player or a result. Run it with --dry-run first if you want to see what it
// would do.

import { prisma } from '../config/database';
import { initCurrentSeason, currentSeason } from '../competition/familista-league.bootstrap';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const DRY = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const season = arg('season') ?? currentSeason();
  console.log(`Familista League — season ${season}${DRY ? '  (dry run)' : ''}\n`);

  const result = await initCurrentSeason({
    season,
    teamIds: (arg('teams') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    startDate: arg('start'),
    intervalDays: arg('interval') ? Number(arg('interval')) : undefined,
    maxDiscovered: arg('max') ? Number(arg('max')) : undefined,
    dryRun: DRY,
  });

  console.log('── participants ──');
  for (const p of result.participants) {
    console.log(`  ${p.entered ? '+' : '·'} ${p.clubName}  ·  ${p.teamName}  ·  ${p.teamId}  ·  crest ${p.hasCrest ? 'yes' : 'none'}`);
  }

  console.log('\n── what happened ──');
  for (const n of result.notes) console.log(`  · ${n}`);

  console.log('\n── season now ──');
  console.log(`  competition     ${result.competitionId ?? '—'}${result.competitionCreated ? '  (created)' : '  (existing)'}`);
  console.log(`  participants    ${result.participantsEntered + result.participantsReused}`);
  console.log(`  fixtures        ${result.fixturesCreated || result.fixturesReused}`);
  console.log(`  rounds          ${result.rounds}`);
  console.log(`  matches linked  ${result.matchesLinked}`);
  console.log(`  standings rows  ${result.standingsRows}`);
  console.log(`  already played  ${result.playedFixtures}`);

  if (DRY) {
    console.log('\n--dry-run: nothing was written.');
  } else {
    console.log('\nThe season is live. Play the matches in the Match Centre; the table follows.');
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`\n${(e as Error).message}`);
  await prisma.$disconnect();
  process.exit(1);
});
