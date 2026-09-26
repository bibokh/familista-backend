/**
 * WHAT FAMILISTA VISION REMEMBERS, AND WHAT IT IS NOT ALLOWED TO FORGET.
 * ─────────────────────────────────────────────────────────────────────────────
 * Vision opened, worked, and then emptied itself. Live Analysis rendered a real
 * session and moments later read "NO SESSION LOADED"; other sections showed
 * real content and went blank on their own. Three faults, compounding:
 *
 *   1 · `boot()` WAS DESTRUCTIVE AND RE-ENTRANT. It refetched everything and
 *       re-opened `sessions[0]` on every call, and `openSession` began by
 *       setting `FV.session = null` and repainting. The shell calls the render
 *       hook far more often than "the reader opened this module" —
 *       `_famDataChanged()` fires when the club context hydrates and again when
 *       Layer B lands, both a second or two AFTER Vision first paints, and each
 *       one re-entered boot and wiped the open session out from under whatever
 *       section was being read.
 *
 *   2 · `teardownFamilistaVision` NULLED `sessionRef`. Leaving the module threw
 *       away the one fact that made returning to the same session possible.
 *
 *   3 · NOTHING WAS WRITTEN DOWN. No storage, no URL state — so a refresh could
 *       not restore a selection even in principle.
 *
 * And one that made all three worse: `renderShell` re-bound its delegated
 * listeners on every repaint, so after three mounts one click ran the handler
 * three times.
 *
 * These pin the fixed behaviour, and pin that the fix invents nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const JS = read('public/familista-vision/familista-vision.js');
const CSS = read('public/familista-vision/familista-vision.css');
const APP = read('public/app.js');

/** The section list, as declared. */
const RAIL = JS.slice(JS.indexOf('var SECTIONS = ['), JS.indexOf('/* ── the global bar'));
/** The platform module row, as declared. */
const MODS = JS.slice(JS.indexOf('var MODULES = ['), JS.indexOf('var SECTIONS = ['));

describe('the selection is written down, so it can survive a refresh', () => {
  it('persists the session reference and the section', () => {
    expect(JS).toContain('function rememberSession(');
    expect(JS).toContain('function rememberSection(');
    expect(JS).toMatch(/writeStore\(\{ sessionRef/);
    expect(JS).toMatch(/writeStore\(\{ section/);
  });

  it('uses sessionStorage, so two tabs may hold two different sessions', () => {
    expect(JS).toContain('window.sessionStorage.getItem');
    expect(JS).toContain('window.sessionStorage.setItem');
    // localStorage would make two tabs fight over one selection.
    expect(JS).not.toMatch(/localStorage\.setItem\(\s*storeKey/);
  });

  it('keys the record by user, so a selection never restores under another account', () => {
    const fn = JS.slice(JS.indexOf('function storeKey()'), JS.indexOf('function readStore()'));
    expect(fn).toMatch(/State\.user/);
    expect(fn).toMatch(/u\.id \|\| u\.email/);
  });

  it('stores a reference, never a payload — the server still decides', () => {
    const store = JS.slice(JS.indexOf('function readStore()'), JS.indexOf('function rememberSession'));
    // No session body, no tracks, no observations are written to the browser.
    expect(store).not.toContain('FV.session');
    expect(store).not.toContain('tracks');
    // And restoring re-reads through the authenticated API.
    const restore = JS.slice(JS.indexOf('function restoreSelection()'), JS.indexOf('function loadCatalogue()'));
    expect(restore).toContain('openSession(');
  });

  it('survives a storage that throws, as it does in a private window', () => {
    for (const fn of ['function readStore()', 'function writeStore(']) {
      const body = JS.slice(JS.indexOf(fn), JS.indexOf(fn) + 420);
      expect(body).toContain('try {');
      expect(body).toContain('catch');
    }
  });

  it('restores the last section before the first paint', () => {
    const boot = JS.slice(JS.indexOf('function boot()'), JS.indexOf('window.renderFamilistaVision'));
    expect(boot).toContain('readStore().section');
    // An id that no longer exists must not render nothing.
    expect(boot).toContain('sectionDef(savedSection)');
  });
});

describe('a remembered session is restored, and never silently swapped', () => {
  const RESTORE = JS.slice(JS.indexOf('function restoreSelection()'), JS.indexOf('function loadCatalogue()'));

  it('prefers the remembered session over the convenience default', () => {
    expect(RESTORE.indexOf('saved.sessionRef')).toBeLessThan(RESTORE.indexOf('list[0].sessionRef'));
  });

  it('only restores a session the catalogue still lists', () => {
    expect(RESTORE).toMatch(/list\.some\(function \(x\) \{ return x\.sessionRef === wanted; \}\)/);
  });

  it('reports a vanished session rather than opening a different one', () => {
    // Being shown another match because yours was deleted is worse than being
    // told yours is gone.
    expect(RESTORE).toContain('FV.sessionGone');
    expect(RESTORE).toContain('no longer in this account');
    const gone = RESTORE.indexOf('FV.sessionGone');
    const fallback = RESTORE.indexOf('list[0].sessionRef');
    expect(gone).toBeLessThan(fallback);
    // and the stale reference is cleared so it is not offered again
    expect(RESTORE).toContain('rememberSession(null)');
  });

  it('shows the empty state intentionally when there is nothing to open', () => {
    expect(RESTORE).toContain('if (list.length) { openSession(list[0].sessionRef); return; }');
    expect(RESTORE).toContain('renderSection();');
    // No invented session, ever.
    expect(RESTORE).not.toMatch(/sessionRef:\s*['"]/);
  });

  it('tells the four absences apart', () => {
    const need = JS.slice(JS.indexOf('function needSession()'), JS.indexOf('function Table('));
    expect(need).toContain('OPENING SESSION');       // in flight
    expect(need).toContain('SESSION NOT AVAILABLE'); // chosen, gone
    expect(need).toContain('NO SESSIONS RECORDED');  // account has none
    expect(need).toContain('NO SESSION LOADED');     // none chosen
  });
});

describe('mounting repaints; it does not reload and it does not destroy', () => {
  const BOOT = JS.slice(JS.indexOf('function boot()'), JS.indexOf('window.renderFamilistaVision'));

  it('reads the catalogue once and repaints on every mount after that', () => {
    expect(BOOT).toContain('if (FV.booted)');
    expect(BOOT).toContain('loadCatalogue()');
    // The re-entry path must not refetch the catalogue.
    const reentry = BOOT.slice(BOOT.indexOf('if (FV.booted)'), BOOT.indexOf('loadCatalogue()'));
    expect(reentry).not.toContain('get(');
  });

  it('never re-picks sessions[0] on a re-mount', () => {
    // This is the line that wiped the reader's choice on every data-version bump.
    expect(BOOT).not.toContain('sessions[0].sessionRef');
  });

  it('guards against a second read while the first is in the air', () => {
    const load = JS.slice(JS.indexOf('function loadCatalogue()'), JS.indexOf('function boot()'));
    expect(load).toContain('if (FV.loading) return');
    expect(load).toContain('FV.loading = true');
    expect(load).toContain('FV.loading = false');
  });

  it('restores the payload it released, without asking for a different session', () => {
    expect(BOOT).toContain('if (FV.sessionRef && !FV.session && !FV.loading) openSession(FV.sessionRef');
  });
});

describe('opening a session does not blank the screen', () => {
  const OPEN = JS.slice(JS.indexOf('function openSession('), JS.indexOf('function restoreSelection()'));

  it('is a no-op when the session asked for is the one already held', () => {
    expect(OPEN).toMatch(/FV\.sessionRef === ref && FV\.session && !opts\.force/);
  });

  it('does not null the held session before the replacement arrives', () => {
    const beforeFetch = OPEN.slice(0, OPEN.indexOf('Promise.all'));
    expect(beforeFetch).not.toContain('FV.session = null');
    expect(beforeFetch).not.toContain('FV.timeline = null');
  });

  it('ignores an answer that a newer read has overtaken', () => {
    expect(OPEN).toContain('var token = ++FV.loadToken');
    expect(OPEN).toContain('if (token !== FV.loadToken) return;');
  });

  it('records the choice as it is made', () => {
    expect(OPEN).toContain('rememberSession(ref)');
  });
});

describe('leaving releases the payload and keeps the choice', () => {
  const TEARDOWN = JS.slice(JS.indexOf('window.teardownFamilistaVision'), JS.indexOf('window.__FV_STATE'));

  it('drops the observations', () => {
    expect(TEARDOWN).toContain('FV.session = null');
    expect(TEARDOWN).toContain('FV.timeline = null');
  });

  it('keeps the session reference, which is what makes returning possible', () => {
    expect(TEARDOWN).not.toContain('FV.sessionRef = null');
  });

  it('is still the shell that calls it, on the way out only', () => {
    expect(APP).toContain("_wasVision && page !== 'familista-vision'");
    expect(APP).toContain('window.teardownFamilistaVision()');
  });
});

describe('the shell mounts Vision on the way in, not only the first time', () => {
  it('re-mounts when entering, keyed on the DOM rather than a flag', () => {
    // `_famRenderPage` is version-gated and the render switch naming this
    // module lives in `_flushPendingRender`, which only runs after a render
    // deferred for an open form. Without this, a second visit mounted nothing.
    expect(APP).toContain("page === 'familista-vision' && typeof window.mountFamilistaVision === 'function'");
    expect(APP).toContain("!_wasVision || !document.getElementById('vx-body')");
  });

  it('still tears down on the way out, and only then', () => {
    expect(APP).toContain("_wasVision && page !== 'familista-vision'");
  });
});

describe('a deep link survives the rest of the startup', () => {
  it('re-applies the route after the context settles', () => {
    // initHash runs at DOMContentLoaded, before the authority answer and the
    // club context; the landing then repaints and displaces the route. This
    // affected every platform room, not only Vision.
    expect(APP).toContain('function _reapplyDeepLink(');
    expect(APP).toContain('_reapplyDeepLink(hashPage)');
    expect(APP).toContain('_famContextReady');
  });

  it('gives up the moment the reader navigates, and never overrides them', () => {
    const fn = APP.slice(APP.indexOf('function _reapplyDeepLink('), APP.indexOf('function initHash()'));
    expect(fn).toContain('if (still !== hashPage) return;');
    expect(fn).toContain("if (active && active.id === 'pg-' + hashPage) return;");
    // Bounded: a fixed list of attempts, not a loop that can run for ever.
    expect(fn).toMatch(/var tries = \[[\d, ]+\]/);
  });
});

describe('Vision does not ask before it has a credential to ask with', () => {
  it('waits for auth before the first catalogue read', () => {
    // On a refresh the shell mounts this module while /auth/refresh is still in
    // flight, so the first reads went out unauthenticated and came back 401.
    expect(JS).toContain('function whenAuthReady()');
    expect(JS).toContain('return whenAuthReady().then(');
  });

  it('is bounded, so a deployment with no token still reaches the 401 screen', () => {
    const fn = JS.slice(JS.indexOf('function whenAuthReady()'), JS.indexOf('/** Read the catalogue.'));
    expect(fn).toMatch(/ceiling = \d+/);
    expect(fn).toContain('waited >= ceiling');
    // and it resolves immediately when a token is already present
    expect(fn).toContain('if (authToken()) return Promise.resolve();');
  });
});

describe('the delegated listeners are bound once', () => {
  it('binds on first shell render and not again', () => {
    const shell = JS.slice(JS.indexOf('function renderShell()'), JS.indexOf('function renderWorkbarOnly'));
    expect(shell).toContain('if (!FV.bound)');
    expect(shell).toContain('FV.bound = true');
    // `renderShell` replaces the root's CONTENTS, so the root survives and a
    // second bind would double every handler.
    expect(shell).toContain('root.innerHTML');
  });
});

describe('Vision is a Vision workspace, not a second copy of the platform', () => {
  const GLOBAL_ONLY = ['source-core', 'clubs', 'data-vault', 'infrastructure-city', 'settings'];

  it('keeps the platform rooms on the top row, routed to the shell', () => {
    for (const id of GLOBAL_ONLY) {
      expect(MODS).toContain("id: '" + id + "'");
      expect(APP).toContain("'" + id + "'");
    }
    expect(JS).toContain("window.navTo === 'function'");
  });

  it('no longer duplicates Vision sections onto the platform row', () => {
    // Reports, Models, Devices and AI Assistant were rail sections wearing a
    // top-row badge — one destination reachable from two places, one of them
    // mislabelled as a peer of Clubs and the Data Vault.
    expect(MODS).not.toContain('section: true');
    for (const dup of ['reports', 'models', 'device', 'ai-assistant']) {
      expect(MODS).not.toContain("id: '" + dup + "'");
    }
  });

  it('puts no global platform module in the Vision rail', () => {
    for (const id of GLOBAL_ONLY) {
      expect(RAIL).not.toContain("id: '" + id + "'");
    }
    expect(RAIL).not.toContain("id: 'owner-home'");
    expect(RAIL).not.toContain("id: 'infrastructure-city'");
  });

  it('carries exactly the three groups, in order', () => {
    const groups = [...RAIL.matchAll(/group: '([A-Z]+)'/g)].map((m) => m[1]);
    expect([...new Set(groups)]).toEqual(['VISION', 'INTELLIGENCE', 'SYSTEM']);
  });

  it('carries exactly the agreed sections, in the agreed order', () => {
    const ids = [...RAIL.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
    expect(ids).toEqual([
      'live', 'sessions', 'sources', 'device', 'tracking', 'ball', 'calibration',
      'teams', 'events', 'tactical', 'heatmaps', 'timeline', 'reports',
      'ai', 'insights', 'tacticalai', 'performance', 'comparisons',
      'health', 'models', 'integrations', 'logs', 'config',
    ]);
  });
});

describe('every rail section resolves to a screen', () => {
  const ids = [...RAIL.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  const ROUTES = JS.slice(JS.indexOf('var ROUTES = {'), JS.indexOf('function sectionDef('));
  const plannedIds = [...RAIL.matchAll(/\{ id: '([a-z]+)'[\s\S]*?(?=\{ id: '|\];)/g)]
    .filter((m) => m[0].includes('planned: {'))
    .map((m) => m[1]);

  it.each(ids)('%s is either implemented or explicitly planned', (id) => {
    const implemented = new RegExp('(^|[,{\\s])' + id + ':').test(ROUTES);
    const planned = plannedIds.includes(id);
    expect(implemented || planned).toBe(true);
    // Never both — a route and a "not built yet" screen contradict each other.
    expect(implemented && planned).toBe(false);
  });

  it('routes a planned section to the planned screen before the route table', () => {
    const rs = JS.slice(JS.indexOf('function renderSection()'), JS.indexOf('function get(path)'));
    expect(rs.indexOf('def.planned')).toBeLessThan(rs.indexOf('ROUTES[FV.section]'));
  });

  it('names what a planned section waits on, and measures nothing', () => {
    const fn = JS.slice(JS.indexOf('function secPlanned('), JS.indexOf('function rd('));
    expect(fn).toContain('What it will do');
    expect(fn).toContain('Why it is not here yet');
    expect(fn).toContain('What it waits on');
    expect(fn).toContain('Nothing on this screen is a measurement');
  });

  it('draws a planned entry as reachable rather than disabled', () => {
    const railFn = JS.slice(JS.indexOf('function rail()'), JS.indexOf('function secPlanned('));
    expect(railFn).toContain('PLANNED');
    expect(railFn).not.toContain('disabled');
    expect(railFn).not.toContain('N/A');
    expect(CSS).toContain('.vx-item-b--plan');
  });
});

describe('the credential fix that got Vision loading at all still holds', () => {
  it('sends the bearer the session actually runs on', () => {
    // The access cookie lives fifteen minutes; the SPA runs on the in-memory
    // bearer after that. Vision was the one client sending neither.
    expect(JS).toContain("Authorization: 'Bearer '");
    expect(JS).toContain("credentials: 'include'");
    expect(JS).toContain('FAM_CONFIG.API_BASE');
  });

  it('verifies each credential server-side rather than trusting the first present', () => {
    const MW = read('src/middleware/auth.middleware.ts');
    expect(MW).toMatch(/const candidates\s*=\s*\[cookieToken,\s*bearerToken\]/);
    expect(MW).toContain('for (const candidate of candidates)');
    // an expired cookie beside a valid bearer must not be a refusal
    expect(MW).not.toMatch(/if \(cookieToken\) \{\s*token = cookieToken;/);
  });

  it('still refuses when nothing valid is presented', () => {
    const MW = read('src/middleware/auth.middleware.ts');
    expect(MW).toMatch(/if \(candidates\.length === 0\)/);
    expect(MW).toContain("throw new UnauthorizedError('No token provided')");
    expect(MW).toContain("throw new UnauthorizedError('Invalid or expired token')");
  });

  it('shows an auth failure as a failure, not as loading for ever', () => {
    const live = JS.slice(JS.indexOf('function secLive()'), JS.indexOf('function trackFilters'));
    const code = live.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code.indexOf('VISION SERVICE UNAVAILABLE'))
      .toBeLessThan(code.indexOf('READING VISION SERVICE'));
  });
});
