/**
 * tests/club-entry-is-navigation.unit.test.ts
 *
 * Entering a club is a navigation, not a data load.
 *
 * openClub() started switchClub() and hung the move to the workspace off its
 * promise, so the Clubs picker stayed on screen until POST /me/context, then
 * loadTeams(), then _thHydrate() — a roster bootstrap plus every page of
 * /players — and then loadAllData() had all finished. Measured against a
 * healthy local server that was a full second; against an instance that is
 * waking, where a 502 or 503 sends those calls into the retry ladder and its
 * 1.5s and 3s sleeps, six to seven seconds, with the "Backend waking up" banner
 * over a page the manager had already left.
 *
 *   click → club shell     before            after
 *   healthy backend        999ms             110ms
 *   waking backend         6333–7515ms       78–144ms
 *
 * Nothing about the shell needs that data: the club's identity is known the
 * moment its card is clicked. So the navigation is synchronous and the load
 * follows it.
 *
 * And because the load now outlives the click, a switch can be superseded. Two
 * clubs, clicking the second 120ms after the first with every call slowed to
 * 350ms: before, the context settled on the FIRST club — the one no longer
 * open. Each entry is numbered now, and a superseded switch writes nothing.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

function bodyOf(name: string): string | null {
  const at = APP.indexOf(`\nfunction ${name}(`);
  const as = APP.indexOf(`\nasync function ${name}(`);
  const start = at >= 0 ? at : as;
  if (start < 0) return null;
  let i = APP.indexOf('{', start), depth = 0;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') { depth--; if (depth === 0) return APP.slice(i, j + 1); }
  }
  return null;
}

describe('opening a club waits for nothing', () => {
  const open = bodyOf('openClub');

  it('navigates without awaiting the switch', () => {
    expect(open).toBeTruthy();
    // the promise the move used to hang off
    expect(open).not.toContain('p.then(goToDashboard)');
    expect(open).not.toMatch(/\.then\([^)]*goToDashboard/);
  });

  it('commits the club and enters the workspace before any call is made', () => {
    const nav = open!.indexOf("navTo('club-home'");
    const call = open!.indexOf('AppContext.switchClub(');
    expect(nav).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(nav).toBeLessThan(call);
    // and the context it navigates with is set before it navigates
    expect(open!.indexOf('window.State.context.clubId = clubId')).toBeLessThan(nav);
  });

  it('clears the club being left first, so no other club\'s data is drawn', () => {
    const clear = open!.indexOf('_famClearClubScopedState');
    const nav = open!.indexOf("navTo('club-home'");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(nav);
    // and its private transfer stream goes with it
    expect(open!.indexOf('_tfRtReset')).toBeLessThan(nav);
  });

  it('and the switch it starts is fire-and-forget', () => {
    expect(open).toMatch(/if \(p && typeof p\.catch === 'function'\) p\.catch\(/);
  });
});

describe('a superseded switch writes nothing', () => {
  it('each entry is numbered', () => {
    expect(APP).toContain('var _famClubEntry = 0;');
    expect(bodyOf('openClub')).toContain('var gen = ++_famClubEntry;');
    expect(bodyOf('openClub')).toContain('isCurrent: function () { return gen === _famClubEntry; }');
  });

  it('switchClub checks after every await before it writes', () => {
    const at = APP.indexOf('async function switchClub(');
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf('async function switchTeam(', at));
    expect(body).toContain("const live = typeof opts.isCurrent === 'function'");
    // one guard per awaited step: context, teams, hydration, the rest
    expect((body.match(/if \(!live\(\)\) return;/g) || []).length).toBeGreaterThanOrEqual(4);
    // and a stale switch does not announce itself either
    expect(body).toContain("if (live()) showToast(");
  });

  it('the caller having already cleared is not undone', () => {
    const at = APP.indexOf('async function switchClub(');
    const body = APP.slice(at, APP.indexOf('async function switchTeam(', at));
    expect(body).toContain('if (!opts.alreadyReset && typeof _famClearClubScopedState');
    expect(body).toContain('if (!opts.alreadyReset && typeof _tfRtReset');
  });

  it('but the club dropdown, which resets nothing itself, still gets both', () => {
    // switchClub called without opts keeps its original behaviour
    expect(bodyOf('onContextClubChange')).toContain('AppContext.switchClub(v)');
  });
});

describe('what was deliberately left alone', () => {
  it('the retry ladder is untouched — it is right for a waking backend', () => {
    expect(APP).toMatch(/RETRY_COUNT:\s*2,/);
    expect(APP).toMatch(/RETRY_BACKOFF_MS:\s*1500,/);
    expect(APP).toMatch(/RETRYABLE_STATUSES:\s*\[0, 408, 425, 429, 502, 503, 504\]/);
  });

  it('and the waking banner still exists, as a pill that blocks nothing', () => {
    const css = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
    expect(css).toMatch(/\.backend-banner\{[^}]*position:fixed/);
    expect(css).toMatch(/\.backend-banner\{[^}]*top:12px/);
    // not an overlay: no inset:0, no full-viewport sizing
    expect(css).not.toMatch(/\.backend-banner\{[^}]*inset:\s*0/);
  });
});
