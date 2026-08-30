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

const APP = read('public/app.js');
const SERVICE = read('src/competition/familista-league.service.ts');
const CONTROLLER = read('src/controllers/familista-league.controller.ts');
const ROUTES = read('src/routes/familista-league.routes.ts');
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
    // …and a match hands over to the Match Centre.
    expect(APP).toMatch(/act === 'flMatch'[\s\S]{0,500}navTo\('match-center'\)/);
    // No second player profile or match centre is defined by this module.
    expect(APP).not.toContain('function _flPlayerProfile');
    expect(APP).not.toContain('function _flMatchCenter');
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
    expect(SERVICE).not.toMatch(/\bwon\+\+|\bdrawn\+\+|\blost\+\+/);
  });

  it('is read-only — no write reaches the database through it', () => {
    for (const verb of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', '$executeRaw']) {
      expect(SERVICE).not.toContain(`.${verb}(`);
      expect(CONTROLLER).not.toContain(`.${verb}(`);
    }
    // …and the routes expose nothing but GET.
    expect(ROUTES).not.toMatch(/router\.(post|put|patch|delete)\(/);
    expect((ROUTES.match(/router\.get\(/g) || []).length).toBeGreaterThanOrEqual(5);
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
