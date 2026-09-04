/**
 * tests/academy-one-shot-init.unit.test.ts
 *
 * The one-shot: a season initialised from a boot, on a plan with no shell.
 *
 * The startup hook is a few lines of bash, and every one of them is a decision
 * somebody could undo without noticing: that a failure does not take the API
 * down, that the proof is read back in its own process, that nothing about the
 * First Team is reachable from it, and that the verifier only reads.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const START = read('scripts/render-start.sh');
const VERIFY = read('src/scripts/verify-academy-league.ts');
const INIT = read('src/scripts/init-academy-league-season.ts');

describe('the boot that initialises a season', () => {
  it('runs only when an operator sets the variable, and says how to unset it', () => {
    expect(START).toContain('if [ -n "${ACADEMY_LEAGUE_INIT:-}" ]; then');
    expect(START).toContain('remove ACADEMY_LEAGUE_INIT from the environment');
    // A season is passed through as given; `1` means the current one.
    expect(START).toContain('SEASON_ARG="--season=${ACADEMY_LEAGUE_INIT}"');
    expect(START).toMatch(/1\|true\|TRUE\|yes\|YES\) SEASON_ARG="" ;;/);
  });

  it('runs the real initialiser, never the dry run, and never a reset', () => {
    const block = START.slice(START.indexOf('ACADEMY_LEAGUE_INIT — one-shot') >= 0 ? 0 : 0);
    const hook = block.slice(block.indexOf('if [ -n "${ACADEMY_LEAGUE_INIT:-}" ]; then'),
                             block.indexOf('# ── 5 · the server'));
    expect(hook).toContain('node dist/scripts/init-academy-league-season.js');
    expect(hook).not.toContain('--dry-run');
    for (const forbidden of ['migrate reset', 'db push', 'db:seed', 'deleteMany', '--force']) {
      expect(`${forbidden}:${hook.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it('and a failed initialisation does not take the API down with it', () => {
    const hook = START.slice(START.indexOf('if [ -n "${ACADEMY_LEAGUE_INIT:-}" ]; then'),
                             START.indexOf('# ── 5 · the server'));
    // set +e around each step, the code captured, and the boot continues.
    expect(hook).toContain('INIT_RC=$?');
    expect(hook).toContain('VERIFY_RC=$?');
    expect(hook).toContain('❌ academy initialisation exited');
    expect(hook).not.toContain('exit 1');
    // The server still starts afterwards.
    expect(START.slice(START.indexOf('# ── 5 · the server'))).toContain('exec node dist/server.js');
  });

  it('proves the result by reading the database back, in its own process', () => {
    const hook = START.slice(START.indexOf('if [ -n "${ACADEMY_LEAGUE_INIT:-}" ]; then'),
                             START.indexOf('# ── 5 · the server'));
    expect(hook).toContain('node dist/scripts/verify-academy-league.js');
    // The verifier is read-only: it counts and reads, and writes nothing.
    for (const forbidden of ['.create(', '.createMany(', '.update(', '.updateMany(',
                             '.delete(', '.deleteMany(', '.upsert(', '$executeRaw']) {
      expect(`${forbidden}:${VERIFY.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // What it reports, per band, is exactly what has to be proven.
    for (const line of ['competition', 'participants', 'standings rows', 'rounds', 'fixtures', 'matches linked']) {
      expect(VERIFY).toContain(line);
    }
    // Including the First Team's own row, read and labelled as untouched.
    expect(VERIFY).toContain('First Team Familista League');
    expect(VERIFY).toContain('read only — no academy run selects this competition');
  });

  it('and neither script can reach the First Team competition', () => {
    // Every academy competition is looked up by a code with a band suffix, so
    // the canonical code cannot be selected by either of them.
    expect(VERIFY).toContain('code: { startsWith: `${LEAGUE_CODE}-` }');
    expect(INIT).not.toMatch(/initCurrentSeason|FIRST_TEAM_CATEGORY/);
  });

  it('the verifier checks each band against what a full calendar should be', () => {
    expect(VERIFY).toContain('plannedCalendar(entries.length)');
    expect(VERIFY).toContain('standings rows ${standingsRows} ≠ participants');
    expect(VERIFY).toContain('fixture(s) with no Match');
    expect(VERIFY).toContain('participant(s) outside this band');
    expect(VERIFY).toContain('ACADEMY LEAGUE VERIFIED');
  });
});
