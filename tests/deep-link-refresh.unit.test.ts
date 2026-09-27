/**
 * A hard refresh must reopen the page the reader was on
 *
 * Refreshing inside Infrastructure City, Source Core or the Data Vault reloaded
 * into an empty dark shell and never recovered; refreshing inside Squad or
 * Training landed on Owner Home. Two causes, both in `public/app.js`:
 *
 *   1. `bootApp()` rebuilds every page shell with `renderAllPages()`, which
 *      destroys a page the deep link had already drawn. `_famRenderPage` is
 *      version-gated and still believed that page drawn, so when `navTo`
 *      re-mounted the empty shell the renderer was never called again.
 *
 *   2. The deep link routes at DOMContentLoaded, before the session's
 *      capabilities exist. The capability guard read "not known yet" as
 *      "denied", redirected, and rewrote the hash — so the deep-link repair
 *      believed the reader had moved away and gave up.
 *
 * The first is exercised against the real functions, lifted out of app.js and
 * run in a sandbox with a minimal document; the second is pinned by position.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** The source of one top-level function in app.js, from its declaration to the next one. */
function fnSource(name: string): string {
  const start = APP.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = APP.slice(start);
  const end = rest.search(/\n(?:async )?function \w+\(|\n\/\/ ──/);
  return end > 0 ? rest.slice(0, end) : rest;
}

describe('a page drawn before bootApp rebuilds the shells is drawn again, not left empty', () => {
  function sandbox() {
    const nodes: Record<string, { innerHTML: string }> = {};
    const calls: string[] = [];
    const container = {
      set innerHTML(html: string) {
        // Rebuilding the container replaces every page with its template: any
        // page not in the eager set is gone.
        for (const k of Object.keys(nodes)) if (k !== 'pages-container') delete nodes[k];
        for (const id of (html.match(/id="([^"]+)"/g) || []).map((m) => m.slice(4, -1))) nodes[id] = { innerHTML: '' };
      },
      get innerHTML() { return ''; },
    };
    const ctx: Record<string, unknown> = {
      document: { getElementById: (id: string) => (id === 'pages-container' ? container : nodes[id] || null) },
      window: { renderRoom: () => calls.push('renderRoom') },
      _FAM_DATA_VERSION: 1,
      _FAM_PAGE_VERSION: {},
      _FAM_GIS_PAGES: [],
      _FAM_PAGE_RENDER: { room: ['renderRoom'] },
      _EAGER_PAGES: ['owner-home'],
      _buildPageTemplateMap: () => ({ 'owner-home': () => '<div id="pg-owner-home"></div>' }),
      nodes, calls,
    };
    vm.createContext(ctx);
    vm.runInContext(`${fnSource('_famRenderPage')}\n${fnSource('renderAllPages')}`, ctx);
    return ctx as Record<string, unknown> & { nodes: typeof nodes; calls: string[] };
  }

  it('redraws a lazily mounted page after renderAllPages destroyed it', () => {
    const ctx = sandbox();
    // The deep link mounts and draws the room before the session is restored.
    ctx.nodes['pg-room'] = { innerHTML: '' };
    vm.runInContext("_famRenderPage('room')", ctx);
    expect(ctx.calls).toEqual(['renderRoom']);

    // bootApp rebuilds the shells: the room is gone.
    vm.runInContext('renderAllPages()', ctx);
    expect(ctx.nodes['pg-room']).toBeUndefined();

    // navTo re-mounts an empty room and asks for it to be drawn. Same data
    // version as before — and it must still be drawn.
    ctx.nodes['pg-room'] = { innerHTML: '' };
    vm.runInContext("_famRenderPage('room')", ctx);
    expect(ctx.calls).toEqual(['renderRoom', 'renderRoom']);
  });

  it('still skips a page that is genuinely drawn for the current data version', () => {
    const ctx = sandbox();
    ctx.nodes['pg-room'] = { innerHTML: '' };
    vm.runInContext("_famRenderPage('room'); _famRenderPage('room')", ctx);
    expect(ctx.calls).toEqual(['renderRoom']);
  });
});

describe('a capability-gated deep link waits for the capabilities instead of being refused', () => {
  const nav = fnSource('navTo');

  it('does nothing — no redirect, no hash rewrite — while the capabilities are unknown', () => {
    const gate = nav.indexOf('if (_gate && _gate.requires && !(window.State && State.context && State.context.effectiveAccess)) return;');
    expect(gate).toBeGreaterThan(-1);
    // Before anything is deactivated, torn down or pushed into history.
    expect(gate).toBeLessThan(nav.indexOf('_navReleaseFocus();'));
    expect(gate).toBeLessThan(nav.indexOf("document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));"));
    expect(gate).toBeLessThan(nav.indexOf('window.history.pushState'));
  });

  it('keeps refusing a reader who genuinely lacks the capability once it is known', () => {
    expect(nav).toContain("if (_navItem && _navItem.requires && !_access(_navItem.requires)) {");
    expect(nav).toContain("page = 'club-home';");
  });

  it('is repaired by the existing deep-link retry once the context settles', () => {
    const repair = APP.slice(APP.indexOf('function _reapplyDeepLink'), APP.indexOf('function initHash'));
    expect(repair).toContain('_famContextReady');
    expect(repair).toContain('navTo(hashPage, null, { fromPopState: true });');
  });
});
