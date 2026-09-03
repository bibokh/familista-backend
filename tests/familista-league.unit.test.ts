// Familista League — the invariants that make it safe to have added it.
//
// The league reuses the competition engine rather than restating it, sits in
// one place in the navigation, and can only ever be read through its own
// routes. Each of those is a property somebody could undo without noticing, so
// each is asserted here rather than left to review.

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Several assertions below are about what the CODE does, and would otherwise be
// answered by a comment that says the same thing in words. This strips comments
// so "does not mention saves" means the code, not the paragraph explaining why
// there are none.
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const APP = read('public/app.js');
const SERVICE = read('src/competition/familista-league.service.ts');
const CONTROLLER = read('src/controllers/familista-league.controller.ts');
const ROUTES = read('src/routes/familista-league.routes.ts');
const ADMIN = read('src/competition/familista-league.admin.service.ts');
const ELIGIBILITY = read('src/competition/league-eligibility.ts');
const ENGINE = read('src/competition/competition.service.ts');
const MATCH_SERVICE = read('src/services/match.service.ts');
const INDEX = read('src/routes/index.ts');
const SCHEMA = read('prisma/schema.prisma');

describe('Familista League — navigation', () => {
  const order = (slug: string): number => {
    // Each nav entry is an object literal; find this slug's `order:`.
    const at = APP.indexOf(`slug:    '${slug}'`);
    expect(at).toBeGreaterThan(-1);
    const tail = APP.slice(at, at + 900);
    const m = tail.match(/order:\s*([\d.]+)/);
    expect(m).toBeTruthy();
    return Number(m![1]);
  };

  it('sits directly below Coaches, and moves nothing else', () => {
    const coaches = order('coaches');
    const league = order('familista-league');
    expect(league).toBeGreaterThan(coaches);

    // Nothing else may fall between the two, or "directly below" stops being
    // true the moment another module is added with a value in the gap.
    const others = [...APP.matchAll(/slug:\s*'([a-z-]+)',[\s\S]{0,900}?order:\s*([\d.]+)/g)]
      .map((m) => ({ slug: m[1], order: Number(m[2]) }))
      .filter((n) => n.slug !== 'coaches' && n.slug !== 'familista-league');
    for (const n of others) {
      expect(`${n.slug}@${n.order}`).not.toBe(
        n.order > coaches && n.order < league ? `${n.slug}@${n.order}` : 'x',
      );
    }
    // The modules the brief says must not move keep the order they had.
    expect(order('transfers')).toBeLessThan(coaches);
    expect(order('coach-market')).toBeLessThan(coaches);
  });

  it('is routable: allow-listed, titled and mounted', () => {
    expect(APP).toContain("'familista-league': 1");
    expect(APP).toContain("'familista-league':'Familista League'");
    expect(APP).toContain("'familista-league':            renderFamilistaLeagueHTML");
  });

  it('opens the profiles that already exist instead of building its own', () => {
    // A player opens the canonical player record…
    expect(APP).toMatch(/act === 'flPlayer'[\s\S]{0,400}openPlayerModal\(pid\)/);
    // …and a match hands over to the Match Center, which is the module that
    // owns match preparation for every competition. The League does not draw a
    // match screen of its own.
    expect(APP).toMatch(/act === 'flMatch'[\s\S]{0,700}_flOpenPreview\(fid\)/);
    expect(APP).toMatch(/function _flOpenMatch[\s\S]{0,1500}navTo\('match-center'\)/);
    expect(APP).toMatch(/function _flOpenMatch[\s\S]{0,1600}_mccOpen\(fixtureId, back\)/);
    // And the section and round it was launched from travel with it, so closing
    // the workspace returns the reader exactly here.
    expect(APP).toMatch(/function _flOpenMatch[\s\S]{0,1400}page: 'familista-league'[\s\S]{0,120}round: _FL\.round/);
    // Inside an age group's workspace the fixture opens in that workspace's own
    // Match Center section, so the reader never leaves the team they are in.
    expect(APP).toMatch(/function _flOpenMatch[\s\S]{0,700}_atGo\('matchCenter'\)/);
    // No second player profile or match centre is defined by this module.
    expect(APP).not.toContain('function _flPlayerProfile');
    expect(APP).not.toContain('function _flMatchCenter');
    // And the Match Center is no longer a section of this workspace at all.
    expect(APP).not.toContain('function _flMatchHostHtml');
    expect(APP).not.toContain("['match', 'Match Center']");
  });

  it('never writes a colour as an inline style attribute', () => {
    // The platform's CSP has no 'unsafe-inline' for styles, so a configured
    // zone colour written as style="" is dropped silently. It goes through the
    // CSSOM instead, and this is the guard that keeps it that way.
    const block = APP.slice(APP.indexOf('//  FAMILISTA LEAGUE'));
    expect(block.length).toBeGreaterThan(1000);
    expect(block).not.toMatch(/style="[^"]*(--fl-zone|background:)/);
    expect(block).toContain("el.style.setProperty('--fl-zone'");
  });
});

describe('Familista League — the read model', () => {
  it('adds no second standings calculation', () => {
    // The engine in competition.service.ts owns the arithmetic. This service
    // may read StandingsEntry; it may not recompute points or positions.
    expect(SERVICE).toContain('prisma.standingsEntry.findMany');
    expect(SERVICE).not.toMatch(/points\s*\+=/);
    // Every column of the table itself is copied from the row the engine wrote,
    // never derived here. (The home/away split alongside it is a different
    // statistic, counted from the fixtures — it is not the table.)
    for (const field of ['played: e.played', 'won: e.won', 'drawn: e.drawn', 'lost: e.lost', 'points: e.points']) {
      expect(SERVICE).toContain(field);
    }
  });

  it('keeps every write out of the read service and behind an administrator', () => {
    // The read side stays read-only: this is what makes it safe to show the
    // league to every club.
    for (const verb of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', '$executeRaw']) {
      expect(SERVICE).not.toContain(`.${verb}(`);
    }
    // Writing lives in its own service, and every entry point asserts the role.
    const writes = ['addParticipant', 'removeParticipant', 'rebuildSchedule', 'rescheduleFixture'];
    for (const fn of writes) {
      const at = ADMIN.indexOf(`export async function ${fn}`);
      expect(`${fn}@${at > -1}`).toBe(`${fn}@true`);
      expect(ADMIN.slice(at, at + 400)).toContain('assertLeagueAdmin(actor)');
    }
    // …and every write route is role-gated in the router as well, so a service
    // called from somewhere new cannot be reached without the check either.
    const writeRoutes = ROUTES.match(/router\.(post|put|patch|delete)\([^\n]*/g) || [];
    expect(writeRoutes.length).toBeGreaterThanOrEqual(4);
    for (const line of writeRoutes) expect(line).toContain('authorize(UserRole.SUPER_ADMIN)');
    // No route records a league result: a result comes from the match.
    const routeLines = (codeOnly(ROUTES).match(/router\.[a-z]+\([^\n]*/g) || []).join('\n');
    expect(routeLines).not.toMatch(/result|score/i);
  });

  it('scopes player statistics to this competition structurally', () => {
    // The only matches counted are the ones this league's fixtures point at,
    // so another competition's goals cannot reach the leaderboard.
    expect(SERVICE).toMatch(/fixture\.findMany[\s\S]{0,200}competitionId/);
    expect(SERVICE).toMatch(/playerMatchStats\.findMany[\s\S]{0,200}matchId: \{ in: matchIds \}/);
  });

  it('takes the caller club from the session, never from the request', () => {
    expect(CONTROLLER).toContain('function callerClubId');
    expect(CONTROLLER).toMatch(/u\?\.currentClubId \?\? u\?\.clubId/);
    // A clubId arriving in the query or body must not be trusted.
    expect(CONTROLLER).not.toMatch(/req\.query\.clubId|req\.body\.clubId|req\.params\.clubId/);
  });

  it('requires authentication and is mounted once', () => {
    expect(ROUTES).toContain('router.use(authenticate)');
    expect((INDEX.match(/familista-league/g) || []).length).toBe(2); // import + mount
  });

  it('reads zones and prizes from configuration, not from code', () => {
    expect(SERVICE).toContain('rules.zones');
    // Prizes appear only when the league says they are enabled.
    expect(SERVICE).toMatch(/prizes.*enabled.*\?.*r\.prizes.*:.*\{ enabled: false \}/s);
    expect(APP).toContain('r.prizes && r.prizes.enabled');
  });
});

describe('Familista League — one rule for who may play', () => {
  it('states eligibility once, and nowhere else', () => {
    expect(ELIGIBILITY).toContain('export function isEligibleForFamilistaLeague');
    expect(ELIGIBILITY).toContain('export function eligibleTeamWhere');
    // Everything that needs the rule imports it. No file decides for itself.
    expect(ADMIN).toContain("from './league-eligibility'");
    // The academy kinds are never named by the League — exclusion is by not
    // being a first team, so a new academy age group needs no code change here.
    // (The Academy module elsewhere in app.js names its own age groups, which is
    // its business; this is scoped to the League.)
    const leagueBlock = APP.slice(APP.indexOf('//  FAMILISTA LEAGUE'));
    for (const file of [ADMIN, SERVICE, CONTROLLER, leagueBlock]) {
      expect(file).not.toMatch(/ACADEMY_U\d+/);
    }
  });

  it('expresses the same rule in memory and in the query', () => {
    // Both halves must consult FIRST_TEAM_KINDS; a `where` that hard-coded
    // SENIOR would silently drift the day the rule changes.
    const inMemory = ELIGIBILITY.slice(ELIGIBILITY.indexOf('export function eligibilityOf'));
    const asQuery = ELIGIBILITY.slice(ELIGIBILITY.indexOf('export function eligibleTeamWhere'));
    expect(inMemory).toContain('FIRST_TEAM_KINDS.includes');
    expect(asQuery).toContain('FIRST_TEAM_KINDS');
    expect(inMemory).toContain('isActive === false');
    expect(asQuery).toContain('isActive: true');
  });

  it('is built to widen later without the League being rewritten', () => {
    // The rule returns a reason, not a bare boolean, so a new condition is one
    // token here rather than a new check at every call site.
    expect(ELIGIBILITY).toContain('EligibilityVerdict');
    expect(ELIGIBILITY).toMatch(/reason: 'OK' \| 'NOT_FIRST_TEAM' \| 'INACTIVE'/);
  });
});

describe('Familista League — participation references, never copies', () => {
  it('stores a team id and reads identity from the club', () => {
    const add = ADMIN.slice(ADMIN.indexOf('export async function addParticipant'));
    const body = add.slice(0, add.indexOf('\n}'));
    expect(body).toContain('prisma.competitionTeam.create');
    // The only columns written are the reference and the owning club.
    expect(body).toMatch(/data: \{ competitionId, teamId, clubId: team\.clubId \}/);
    // Nothing about the team's identity is duplicated into that row.
    const code = codeOnly(body);
    for (const copied of ['crestUrl:', 'teamName:', 'name:', 'squadSize', 'players:']) {
      expect(`${copied}${code.includes(copied)}`).toBe(`${copied}false`);
    }
  });

  it('resolves crest and name from the club on every read', () => {
    // teamIdentities is the single place identity comes from, and it reads the
    // live rows — so a rename or a new crest shows up without a migration.
    expect(SERVICE).toMatch(/prisma\.club\.findMany[\s\S]{0,200}crestUrl: true/);
    expect(SERVICE).toContain('crestUrl: club?.crestUrl ?? club?.emblem ?? null');
  });

  it('cannot enter the same team twice, or an ineligible one', () => {
    const add = ADMIN.slice(ADMIN.indexOf('export async function addParticipant'));
    expect(add).toContain('already plays in this season');
    expect(add).toContain('Only a club first team can play in the Familista League');
    // The database agrees: participation is unique per competition and team.
    expect(SCHEMA).toMatch(/model CompetitionTeam \{[\s\S]*?@@unique\(\[competitionId, teamId\]\)/);
  });

  it('refuses to drop a team that has already played', () => {
    const rm = ADMIN.slice(ADMIN.indexOf('export async function removeParticipant'));
    expect(rm).toMatch(/status: 'PLAYED'[\s\S]{0,400}playedCount > 0/);
    expect(rm).toContain('scheduling decision rather than a deletion');
  });

  it('never deletes a match that carries anybody’s work', () => {
    const del = ADMIN.slice(ADMIN.indexOf('async function _deleteFixtureAndItsMatch'));
    for (const guard of ['lineups === 0', 'timeline === 0', 'events === 0', 'playerStats === 0', 'playerMatchStats === 0', 'tacticalSnapshots === 0']) {
      expect(del).toContain(guard);
    }
    expect(del).toContain('if (untouched) await prisma.match.delete');
  });
});

describe('Familista League — fixtures are matches', () => {
  it('reuses the engine’s round-robin rather than writing another', () => {
    expect(ADMIN).toContain("from './competition.service'");
    expect(ADMIN).toContain('generateRoundRobinFixtures(compActor');
    // No pairing arithmetic of its own, and no team count written down: the
    // shape of the season follows from however many teams are entered.
    const code = codeOnly(ADMIN);
    expect(code).not.toMatch(/circle method|rotate|ring\[/);
    expect(code).not.toMatch(/rounds\s*=\s*6|matches\s*=\s*12|length === 4/);
  });

  it('gives every fixture a real Match, with the competition on it', () => {
    const ensure = ADMIN.slice(ADMIN.indexOf('export async function ensureFixtureMatches'));
    expect(ensure).toContain('prisma.match.create');
    expect(ensure).toContain('competition: CompetitionType.LEAGUE');
    expect(ensure).toContain('competitionName: comp.name');
    expect(ensure).toContain('season: comp.season');
    expect(ensure).toContain('data: { matchId: match.id }');
  });

  it('moves the fixture and its match to the same date', () => {
    const re = ADMIN.slice(ADMIN.indexOf('export async function rescheduleFixture'));
    expect(re).toContain('prisma.fixture.update');
    expect(re).toContain('prisma.match.update');
    expect(re).toMatch(/scheduledAt: when[\s\S]{0,300}scheduledAt: when/);
  });

  it('will not regenerate a calendar that has results in it', () => {
    const rb = ADMIN.slice(ADMIN.indexOf('export async function rebuildSchedule'));
    expect(rb).toContain('Schedule adjustment required');
    expect(rb).toMatch(/status: 'PLAYED'[\s\S]{0,300}playedCount > 0/);
  });

  it('gives a platform fixture no owning club, so no club can edit it', () => {
    // The engine writes the competition's owner onto the fixture, which is null
    // for the league — and `_assertFixtureOwner` then matches nobody.
    expect(ENGINE).toContain('clubId:        comp.clubId');
    expect(ENGINE).toMatch(/clubId:      comp\.clubId/);
    expect(ENGINE).not.toMatch(/clubId:\s+actor\.clubId,\s*\n\s*homeTeamId/);
  });
});

describe('Familista League — a result arrives from the Match Centre', () => {
  it('hangs off the one funnel every match change goes through', () => {
    expect(MATCH_SERVICE).toContain("import { syncMatchToLeague } from '../competition/familista-league.admin.service'");
    const upd = MATCH_SERVICE.slice(MATCH_SERVICE.indexOf('export async function updateMatch'));
    expect(upd).toContain('await syncMatchToLeague(id)');
    // A league failure must never fail the match: the match is the record.
    expect(upd).toMatch(/try \{ await syncMatchToLeague\(id\); \} catch/);
  });

  it('copies the score across and lets the engine rebuild the table', () => {
    const sync = ADMIN.slice(ADMIN.indexOf('export async function syncMatchToLeague'));
    expect(sync).toContain('MatchStatus.FT');
    expect(sync).toContain('homeScore: settled ? match.homeScore ?? 0 : null');
    expect(sync).toContain('rebuildStandingsUnchecked(fixture.competitionId)');
    // It computes no points, no positions and no form of its own.
    expect(sync).not.toMatch(/points|position|form/i);
  });

  it('answers "not mine" for a match that is not a league fixture', () => {
    const sync = ADMIN.slice(ADMIN.indexOf('export async function syncMatchToLeague'));
    expect(sync).toMatch(/prisma\.fixture\.findFirst\(\{\s*\n?\s*where: \{ matchId \}/);
    expect(sync).toContain('if (!fixture) return { competitionId: null }');
    // …and a fixture belonging to a club's own competition is not one either.
    expect(sync).toMatch(/clubId: null[\s\S]{0,200}if \(!comp\) return \{ competitionId: null \}/);
  });

  it('leaves a team with no results in the table on zero', () => {
    // Otherwise a season that has not started has no table at all, and a team
    // that has not played is missing from one that does.
    expect(ENGINE).toContain('const entered = await prisma.competitionTeam.findMany');
    expect(ENGINE).toMatch(/for \(const t of entered\) row\(t\.teamId\)/);
  });
});

describe('Familista League — the Match Center it opens', () => {
  it('is the one canonical module, focused on a fixture', () => {
    // No second render function; the same module draws a different fixture.
    expect(APP).not.toContain('function renderLeagueMatchCenter');
    expect(APP).toMatch(/function _mcFocusFromDetail\(d\)/);
    expect(APP).toContain('window._MC_FOCUS = _mcFocusFromDetail(d)');
    // And there is exactly one place that translates a match record into the
    // shape the workspace reads.
    expect(APP.match(/function _mcFocusFrom/g) || []).toHaveLength(1);
  });

  it('knows which competition the match belongs to', () => {
    expect(APP).toMatch(/context: d\.context \|\| null/);
    expect(SERVICE).toContain('export interface LeagueMatchContext');
    for (const field of ['competitionId', 'code', 'name', 'season', 'round', 'fixtureId', 'matchId']) {
      expect(SERVICE).toMatch(new RegExp(`${field}:`));
    }
  });

  it('lets go of the open match when the Match Center is reached any other way', () => {
    expect(APP).toMatch(/data-page="match-center"[\s\S]{0,400}window\._MC_FOCUS = null/);
    expect(APP).toMatch(/data-page="match-center"[\s\S]{0,400}_MCC\.open = null/);
  });

  it('shows what was recorded, and an honest nothing when there is none', () => {
    // Every panel of the redesigned Match Center has an empty state of its own,
    // so a match with nothing recorded says so rather than showing a zero.
    expect(APP).toContain('No lineup available');
    expect(APP).toContain('No player statistics yet');
    expect(APP).toContain('No match events yet');
    expect(APP).toContain('No match statistics recorded');
    expect(APP).toContain('No league record for these teams yet');
    // Nothing is invented to fill the panels.
    expect(APP).not.toMatch(/Math\.random\(\)[\s\S]{0,120}focus/);
  });
});

describe('Familista League — statistics that are real or absent', () => {
  it('offers only what the Match Centre records', () => {
    expect(SERVICE).toContain('export interface LeaguePlayerRecord');
    for (const has of ['appearances', 'starts', 'minutes', 'goals', 'assists', 'averageRating',
      'yellowCards', 'redCards', 'shots', 'shotsOnTarget', 'passes', 'passAccuracy',
      'tackles', 'interceptions', 'xg', 'xa']) {
      expect(SERVICE).toMatch(new RegExp(`\\b${has}:`));
    }
    // Nothing in the platform captures these, so the league does not pretend to
    // have them — no field, no column, no zero standing in for a measurement.
    const code = codeOnly(SERVICE);
    for (const absent of ['saves', 'motm', 'manOfTheMatch', 'cleanSheet:']) {
      expect(`${absent}:${new RegExp(`\\b${absent}`, 'i').test(code)}`).toBe(`${absent}:false`);
    }
  });

  it('counts this league’s matches and no others', () => {
    expect(SERVICE).toMatch(/fixture\.findMany[\s\S]{0,200}competitionId/);
    expect(SERVICE).toMatch(/playerMatchStats\.findMany[\s\S]{0,200}matchId: \{ in: matchIds \}/);
  });

  it('leaves an unrecorded team statistic null rather than zero', () => {
    const ts = SERVICE.slice(SERVICE.indexOf('export async function getTeamStats'));
    expect(ts).toContain('possessionAvg: a.possession.length ?');
    expect(ts).toContain('shots: a.recorded ? a.shots : null');
  });
});

describe('Familista League — localization', () => {
  const CFG = read('public/i18n/config.js');
  const TAGS = [...CFG.matchAll(/tag: '([^']+)'/g)].map((m) => m[1]);
  const bundle = (t: string) => JSON.parse(read(`public/i18n/locales/${t}.json`));
  const cat = (t: string) => JSON.parse(read(`public/i18n/catalogue/${t}.json`));

  it('covers every locale the platform declares — read, not assumed', () => {
    expect(TAGS.length).toBeGreaterThan(0);
    for (const t of TAGS) {
      const b = bundle(t);
      expect(typeof b.navigation.familistaLeague).toBe('string');
      expect(b.navigation.familistaLeague.length).toBeGreaterThan(0);
      for (const c of ['pos', 'team', 'mp', 'w', 'd', 'l', 'gf', 'ga', 'dif', 'pts', 'form']) {
        expect(`${t}:col.${c}=${typeof b.league.col[c]}`).toBe(`${t}:col.${c}=string`);
        expect(`${t}:full.${c}=${typeof b.league.colFull[c]}`).toBe(`${t}:full.${c}=string`);
      }
      expect(typeof b.league.rulesTooltip).toBe('string');
      expect(typeof b.league.rulesDialog).toBe('string');
    }
  });

  it('answers every League prose string in every non-English locale', () => {
    const SLOT = String.fromCharCode(0);
    const PROSE = ['Standings', 'Matches', 'Player Stats', 'Rules', 'Season',
      'UPCOMING', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED',
      'Goals', 'Rating', 'Assists', 'League format', 'Points system', 'Ranking rules',
      'Qualification, promotion and relegation', 'Season information', 'Awards',
      'No fixtures available', 'The league has not started',
      'Player statistics not available yet', 'No active Familista League season',
      'Try again', 'Win', 'Draw', 'Loss', 'Round',
      'ROUND %d', 'Position %d', '%dW · %dD · %dL'];
    for (const t of TAGS.filter((x) => !/^en(-|$)/.test(x))) {
      const c = cat(t);
      const missing = PROSE.filter((s) => c[s.split('%d').join(SLOT)] == null);
      expect({ locale: t, missing }).toEqual({ locale: t, missing: [] });
    }
  });

  it('keeps the two passes off each other — a key-owned cell opts out', () => {
    // Portuguese renders TEAM as "TIME"; without the opt-out the automatic pass
    // reads that as the English word and turns it into "HORA".
    expect(APP).toMatch(/data-i18n="' \+ h\.key \+ '"[\s\S]{0,200}data-no-i18n/);
    expect(bundle('pt-BR').league.col.team).toBe('TIME');
  });

  it('leaves the league name and its season to the record', () => {
    // The name and the season value are data; only the word between them is ours.
    expect(APP).toMatch(/<span data-user-content>' \+ _esc\(lg\.name\)/);
    // The season is a labelled fact in the masthead's spine: the word is ours
    // and translated, the value is the record's and is left alone.
    expect(APP).toContain('<dt>Season</dt>');
    expect(APP).toMatch(/<dd data-user-content>' \+ _esc\(lg\.season\)/);
  });

  it('does not shout the league name in the markup', () => {
    // .fl-eyebrow uppercases in CSS. Shouting it in the markup too gave the
    // catalogue a second entry for one name, and the loose lookup then answered
    // the sidebar with the shouted form.
    const block = APP.slice(APP.indexOf('//  FAMILISTA LEAGUE'));
    expect(block).not.toContain('>FAMILISTA LEAGUE<');
    expect(read('public/app.css')).toMatch(/\.fl-eyebrow\{[^}]*text-transform:uppercase/);
  });
});

describe('Familista League — the schema it reuses', () => {
  it('adds no duplicate competition concepts', () => {
    for (const dup of ['model League ', 'model LeagueMatch ', 'model LeagueTeam ', 'model LeagueStanding ', 'model CompetitionSeason ']) {
      expect(SCHEMA).not.toContain(dup);
    }
    // The concepts it uses are the ones that were already there.
    for (const m of ['model Competition {', 'model CompetitionTeam {', 'model Fixture {', 'model StandingsEntry {']) {
      expect(SCHEMA).toContain(m);
    }
  });

  it('lets a competition belong to the platform rather than to a club', () => {
    const comp = SCHEMA.slice(SCHEMA.indexOf('model Competition {'));
    expect(comp.slice(0, comp.indexOf('\n}'))).toMatch(/clubId\s+String\?/);
    const fx = SCHEMA.slice(SCHEMA.indexOf('model Fixture {'));
    expect(fx.slice(0, fx.indexOf('\n}'))).toMatch(/clubId\s+String\?/);
  });

  it('keeps a platform competition unique per code and season', () => {
    // Two NULLs are distinct in Postgres, so the existing composite unique
    // stops covering platform rows; a partial index covers exactly those.
    const mig = read('prisma/migrations/20260830120000_familista_league/migration.sql');
    expect(mig).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,200}WHERE "clubId" IS NULL/);
  });
});
