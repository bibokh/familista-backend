// Familista League — starting a season, safely and more than once.
//
// Production had the League deployed and no season in it, and the screen
// correctly said so. Nothing in this repository created the competition: the
// admin service manages one that exists and scripts/familista-league-season.ts
// rebuilds one, and both refuse when there is none. This is the step that was
// missing, so what it must never do matters as much as what it does.

import fs from 'fs';
import path from 'path';
import { currentSeason } from '../src/competition/familista-league.bootstrap';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Several assertions below are about what the CODE does, and a comment saying
// the same thing in words would otherwise answer them.
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const BOOT = read('src/competition/familista-league.bootstrap.ts');
const BOOT_CODE = codeOnly(BOOT);
const CLI = read('src/scripts/init-league-season.ts');
const CLI_CODE = codeOnly(CLI);
const PKG = JSON.parse(read('package.json'));

describe('the season a date falls in', () => {
  it('runs July to June', () => {
    expect(currentSeason(new Date('2026-08-31T00:00:00Z'))).toBe('2026/27');
    expect(currentSeason(new Date('2027-02-01T00:00:00Z'))).toBe('2026/27');
    expect(currentSeason(new Date('2027-06-30T00:00:00Z'))).toBe('2026/27');
    expect(currentSeason(new Date('2027-07-01T00:00:00Z'))).toBe('2027/28');
  });

  it('pads the second year, so a century roll still reads as a season', () => {
    expect(currentSeason(new Date('2099-09-01T00:00:00Z'))).toBe('2099/00');
    expect(currentSeason(new Date('2100-09-01T00:00:00Z'))).toBe('2100/01');
  });
});

describe('what it uses', () => {
  it('discovers first teams through the one eligibility rule', () => {
    expect(BOOT).toContain("from './league-eligibility'");
    // Asked about THIS competition's category: with no age group it is the
    // first-team rule, unchanged and shared with the First Team's own run.
    expect(BOOT).toContain('...eligibleTeamWhereFor(category.ageGroup)');
    // No team is chosen by its name, and no academy kind is named here.
    expect(BOOT).not.toMatch(/ACADEMY|name: \{ contains/);
  });

  it('reuses the existing generator rather than pairing teams itself', () => {
    expect(BOOT).toContain('generateRoundRobinFixtures(actor, comp.id, start');
    expect(BOOT_CODE).not.toMatch(/circle method|rotate|\bring\[/);
    // The shape of the season follows from the entered teams; no count is
    // written down, so four teams give six rounds because that is what a double
    // round-robin between four teams is.
    expect(BOOT_CODE).not.toMatch(/rounds\s*=\s*6|matches\s*=\s*12|=== 4\b/);
  });

  it('gives every fixture the Match the Match Centre opens', () => {
    expect(BOOT).toContain('ensureFixtureMatches(comp.id)');
    expect(BOOT).not.toContain('prisma.match.create');
  });

  it('creates no club, team, player or crest', () => {
    for (const forbidden of ['prisma.club.create', 'prisma.team.create', 'prisma.player.create']) {
      expect(`${forbidden}:${BOOT_CODE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // A crest is read, to report whether a club has one. It is never written.
    expect(BOOT_CODE).toContain('crestUrl: true');
    expect(BOOT_CODE).not.toMatch(/crestUrl:\s*['"`]/);
    // Participation is a reference and a club attribution, nothing more.
    expect(BOOT).toContain('data: { competitionId: comp.id, teamId: team.id, clubId: team.clubId }');
  });

  it('invents no result', () => {
    // Nothing sets a score, a played status or a played date.
    for (const forbidden of ['homeScore', 'awayScore', "'PLAYED'", 'playedAt']) {
      const writes = new RegExp(`${forbidden}\\s*[:=]\\s*[^=]`).test(BOOT_CODE);
      expect(`${forbidden}:${writes}`).toBe(`${forbidden}:false`);
    }
  });

  it('leaves the table showing every entered team on zero', () => {
    expect(BOOT).toContain('rebuildStandingsUnchecked(comp.id)');
  });
});

describe('what it refuses to do', () => {
  it('never deletes anything', () => {
    for (const verb of ['delete', 'deleteMany']) {
      expect(`${verb}:${BOOT.includes(`.${verb}(`)}`).toBe(`${verb}:false`);
    }
  });

  it('does not regenerate a calendar that has results in it', () => {
    expect(BOOT).toContain("status: 'PLAYED'");
    expect(BOOT).toContain('the calendar is left untouched');
    // The generator is reached only when there are no fixtures at all.
    expect(BOOT).toMatch(/existingFixtures > 0[\s\S]{0,200}not regenerated/);
  });

  it('stops rather than entering a database full of something else', () => {
    // A platform with four clubs has four eligible first teams. A number far
    // above that means the command is pointed somewhere it should not be.
    expect(BOOT).toContain('maxDiscovered ?? 32');
    expect(BOOT).toContain('safety limit');
  });

  it('leaves participants somebody else entered alone', () => {
    expect(BOOT).toContain('left alone');
    expect(BOOT).not.toContain('competitionTeam.delete');
  });

  it('is not wired into server startup', () => {
    // A server that rebuilds a competition on boot will one day rebuild one
    // somebody is using.
    for (const f of ['src/server.ts', 'src/app.ts', 'scripts/render-start.sh', 'scripts/render-predeploy.sh']) {
      expect(`${f}:${/initCurrentSeason|init-league-season/.test(read(f))}`).toBe(`${f}:false`);
    }
  });
});

describe('how it is run', () => {
  it('is an npm script following the repository’s conventions', () => {
    expect(PKG.scripts['league:init-current-season']).toBe('node dist/scripts/init-league-season.js');
  });

  it('runs from the built output, so a Render one-off job needs no ts-node', () => {
    const tsconfig = JSON.parse(read('tsconfig.json').replace(/\/\/[^\n]*/g, ''));
    expect(tsconfig.compilerOptions.rootDir).toBe('./src');
    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
    expect(tsconfig.include).toContain('src/**/*');
    // Which means the CLI has to live under src/, and it does.
    expect(fs.existsSync(path.join(ROOT, 'src/scripts/init-league-season.ts'))).toBe(true);
  });

  it('reads the environment the service already has, and prints no secret', () => {
    expect(CLI_CODE).toContain("from '../config/database'");
    expect(CLI_CODE).not.toMatch(/DATABASE_URL|process\.env\.[A-Z_]*(SECRET|KEY|PASSWORD|TOKEN)/);
  });

  it('can be asked what it would do without doing it', () => {
    expect(CLI).toContain("process.argv.includes('--dry-run')");
    expect(BOOT).toContain('opts.dryRun');
  });
});

describe('Manage Teams before there is a season', () => {
  const CONTROLLER = read('src/controllers/familista-league.controller.ts');
  const APP = read('public/app.js');

  it('answers instead of failing when no competition exists', () => {
    const fn = CONTROLLER.slice(CONTROLLER.indexOf('export async function getManageContext'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // resolveLeague throws NotFound when there is no season; this must not use it.
    expect(body).not.toContain('resolveLeague(req)');
    expect(body).toContain('hasSeason: !!found');
  });

  it('and the screen asks for that answer even with no season', () => {
    // The call is unconditional now; it used to sit behind `if (_FL.league)`.
    expect(APP).toContain("api('/familista-league/manage' + _flSeasonQ())");
    expect(APP).not.toMatch(/if \(_FL\.league\) \{\s*\n\s*try \{\s*\n\s*var mg =/);
    expect(APP).toContain('_FL.hasSeason = !!(mg && mg.data && mg.data.hasSeason)');
  });

  it('does not ask for a selector it cannot use', () => {
    expect(APP).toMatch(/if \(d\.hasSeason\) \{[\s\S]{0,200}manage\/eligible-teams/);
  });

  it('says what is missing rather than showing an empty list', () => {
    expect(APP).toContain("} else if (!m.hasSeason) {");
    // Reuses the string the empty state already uses — no new text to translate.
    expect(APP).toContain("_flEmpty('No active Familista League season')");
  });
});
