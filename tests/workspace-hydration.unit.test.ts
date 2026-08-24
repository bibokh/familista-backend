/**
 * tests/workspace-hydration.unit.test.ts
 *
 * Entering a club used to draw the whole application.
 *
 * loadAllData fanned out to some forty page renderers the moment club data
 * landed — every FOS platform board, every "centre", the GIS boards — whichever
 * page the reader had actually asked for. Eight of those pages are mounted
 * eagerly at boot, so their renderers did full work into containers nobody was
 * looking at: measured at 1,199ms of main thread, and twice over, because boot
 * and the club switch each ran the whole of it. That block sat between the club
 * being picked and the requested module being allowed to start.
 *
 * The split is by layer, and the routing is by destination:
 *
 *   Layer A — the critical club shell. Who the user is, which club is active,
 *   the membership and permissions behind it, the club identity, the team
 *   context. One gate, opened when a club is picked and closed when the server
 *   is answering as that club.
 *
 *   Layer B — module data. Read once per club, by the pages that draw from it,
 *   when they are on screen. A page is drawn when it is activated and its data
 *   has moved since it last drew.
 *
 * What is asserted here is that the fan-out is gone, that the gate is opened
 * before anything club-scoped can run, that there is exactly one of it, and
 * that no page can be left drawn from a club that has been left.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const DB = readFileSync(join(__dirname, '..', 'src', 'config', 'database.ts'), 'utf8');
const LIB = readFileSync(join(__dirname, '..', 'src', 'lib', 'prisma.ts'), 'utf8');

function fnBody(name: string) {
  const at = APP.search(new RegExp(`(async )?function ${name}\\s*\\(`));
  if (at < 0) return '';
  let i = APP.indexOf('{', at), depth = 0, j = i;
  for (; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) break;
  }
  return APP.slice(i, j);
}

describe('entering a club no longer draws the whole application', () => {
  it('loadAllData stores what it read and draws one page, not forty', () => {
    const f = fnBody('loadAllData');
    expect(f).toContain('State.analytics = analytics.value.data');
    expect(f).toContain('State.players   = players.value.data');
    expect(f).toContain('_famDataChanged();');
    // the fan-out, named so a reintroduction fails here rather than in a profile
    ['renderFOSCore', 'renderFOSAutomationCenter', 'renderFOSAdminCenter',
     'renderMultiClubNetwork', 'renderFOSObservability', 'renderFOSSecurityCenter',
     'renderAIWarRoom', 'renderGIS', 'renderAIScoutingCenter', 'renderMedicalCenter']
      .forEach((fn) => expect(f).not.toContain(fn));
  });

  it('and the pages it used to draw are drawn when they are opened instead', () => {
    // every renderer removed from the fan-out is still reachable, by page
    ['renderFOSCore', 'renderFOSAutomationCenter', 'renderFOSAdminCenter',
     'renderMultiClubNetwork', 'renderFOSObservability', 'renderFOSSecurityCenter',
     'renderAIWarRoom', 'renderAIScoutingCenter', 'renderMedicalCenter',
     'renderSquad', 'renderDashboard', 'renderMatches']
      .forEach((fn) => expect(APP).toContain(`['${fn}']`));
    const nav = APP.slice(APP.indexOf('function navTo(page, el, _opts)'),
                          APP.indexOf('function navTo(page, el, _opts)') + 8000);
    expect(nav).toContain('_famRenderPage(page)');
    // drawn after the page is activated, so the renderer finds its container
    expect(nav.indexOf('_famRenderPage(page)')).toBeGreaterThan(nav.indexOf("pg.classList.add('active')"));
  });

  it('a page already current for this data does nothing when re-opened', () => {
    const f = fnBody('_famRenderPage');
    expect(f).toContain('if (_FAM_PAGE_VERSION[page] === _FAM_DATA_VERSION) return;');
    // an unmounted page keeps its stale mark, so it draws when it is mounted
    expect(f).toContain("if (!document.getElementById('pg-' + page)) return;");
  });

  it('and new data marks every page stale, redrawing only the one on screen', () => {
    const f = fnBody('_famDataChanged');
    expect(f).toContain('_FAM_DATA_VERSION++;');
    expect(f).toContain('_FAM_PAGE_VERSION = {};');
    expect(f).toContain('_famRenderPage(_famActivePage())');
  });
});

describe('the club shell is one gate, opened when the club is picked', () => {
  it('openClub opens it before it touches the session or navigates', () => {
    const f = fnBody('openClub');
    expect(f).toContain('_famClubSwitchBegin(clubId)');
    expect(f.indexOf('_famClubSwitchBegin')).toBeLessThan(f.indexOf('State.context.clubId = clubId'));
    expect(f.indexOf('_famClubSwitchBegin')).toBeLessThan(f.indexOf("navTo('club-home'"));
  });

  it('switchClub closes it on both outcomes, and never opens a second one', () => {
    const s = APP.slice(APP.indexOf('async function switchClub('), APP.indexOf('async function switchTeam('));
    expect(s).toContain('_famClubSwitchBegin(clubId);');
    expect(s).toContain('_famClubSwitchEnd(true);');
    expect(s).toContain('_famClubSwitchEnd(false);');
    // the promise is not rebuilt here — that would strand whoever awaited the first
    expect(s).not.toContain('new Promise');
    const b = fnBody('_famClubSwitchBegin');
    expect(b).toContain('if (window.__famClubReadyFor === clubId && _FAM_CTX_DONE) return;');
  });

  it('and there is exactly one definition of what "ready" means', () => {
    expect((APP.match(/window\.__famClubReady = new Promise/g) || []).length).toBe(1);
    expect(fnBody('_famClubSwitchBegin')).toContain('window.__famClubReady = new Promise');
    // the Coach Market's own copy of the rule now defers to the shared one
    expect(fnBody('_stClubReady').replace(/\s+/g, ' ')).toContain('return _famClubReady();');
  });
});

describe('module data is read once, for the club it belongs to', () => {
  it('the read waits for the shell rather than racing it', () => {
    const f = fnBody('_famEnsureClubData');
    expect(f).toContain('_famClubReady()');
    expect(f.indexOf('_famClubReady()')).toBeLessThan(f.indexOf('loadAllData(opts'));
    // and a club picked while it waited owns the read instead
    expect(f).toContain('!== club');
  });

  it('two pages opened in quick succession join one read', () => {
    const f = fnBody('_famEnsureClubData');
    expect(f).toContain('if (_FAM_CLUB_DATA.for === club && _FAM_CLUB_DATA.p) return _FAM_CLUB_DATA.p;');
  });

  it('and leaving a club drops the read, so the next one cannot join it', () => {
    expect(fnBody('_famResetPageVersions')).toContain('_FAM_CLUB_DATA = { for: null, p: null };');
    expect(fnBody('_famClearClubScopedState')).toContain('_famResetPageVersions()');
    // switching team within a club rescopes it too
    const t = APP.slice(APP.indexOf('async function switchTeam('), APP.indexOf('function teams()'));
    expect(t).toContain('_FAM_CLUB_DATA = { for: null, p: null };');
  });
});

describe('the bootstrap knows where it is going', () => {
  it('a landing page that draws no club data reads none', () => {
    const f = fnBody('_famNeedsClubData');
    expect(f).toContain('_FAM_PAGE_RENDER[page]');
    expect(f).toContain('_FAM_CLUB_DATA_PAGES.indexOf(page)');
    // Owner Home and the Clubs picker are not in either list
    expect(APP).not.toMatch(/_FAM_CLUB_DATA_PAGES = \[[^\]]*'owner-home'/);
    expect(APP).not.toMatch(/_FAM_CLUB_DATA_PAGES = \[[^\]]*'clubs'/);
  });

  it('and boot stands down when a club entry has taken hydration over', () => {
    const f = fnBody('bootApp');
    expect(f).toContain('var _bootEntry = ');
    expect(f).toContain('_famClubEntry !== _bootEntry');
    expect(f).toContain('if (!_entryTookOver && _famNeedsClubData(_famActivePage()))');
    // boot reads through the same shared, deduped path as everything else
    expect(f).toContain('await _famEnsureClubData()');
    expect(f).not.toContain('await loadAllData()');
  });

  it('the club-workspace pages that need club data are all named', () => {
    ['club-home', 'transfers', 'coach-market', 'coaches', 'training', 'academy']
      .forEach((p) => expect(APP).toMatch(new RegExp(`_FAM_CLUB_DATA_PAGES = \\[[\\s\\S]{0,400}'${p}'`)));
  });
});

describe('one Prisma client, one connection pool', () => {
  it('the second client is gone — lib/prisma re-exports the singleton', () => {
    expect(LIB).not.toContain('new PrismaClient');
    expect(LIB).toContain("export { prisma } from '../config/database';");
  });

  it('and the singleton is held in production too, not only outside it', () => {
    expect(DB).toContain('global.__prisma = prisma;');
    expect(DB).not.toMatch(/if \(process\.env\.NODE_ENV !== 'production'\) \{\s*global\.__prisma = prisma;/);
  });

  it('so the whole server constructs exactly one client', () => {
    expect((DB.match(/new PrismaClient/g) || []).length).toBe(1);
    expect((LIB.match(/new PrismaClient/g) || []).length).toBe(0);
    // and nowhere under src/ constructs another. Seed scripts and one-off
    // maintenance scripts are separate processes with their own lifetime; the
    // server is what must hold a single pool.
    const built: string[] = [];
    (function walk(dir: string) {
      readdirSync(dir).forEach((n) => {
        const full = join(dir, n);
        if (statSync(full).isDirectory()) return walk(full);
        if (!/\.ts$/.test(n)) return;
        if (/new PrismaClient/.test(readFileSync(full, 'utf8'))) built.push(full);
      });
    })(join(__dirname, '..', 'src'));
    expect(built.map((f) => f.replace(/^.*\/src\//, 'src/'))).toEqual(['src/config/database.ts']);
  });
});
