/**
 * tests/squad-list-opens-the-player.unit.test.ts
 *
 * First Team → Squad → List → click a player → nothing opened.
 *
 * Measured in the browser, the click was delivered correctly and nothing was
 * covering the row:
 *
 *   CLICK on td.sqlu-c-nat → [data-action]=sqOpenPlayer  data-player-id=sq-1
 *   CALL sqOpenPlayer(sq-1)
 *   CALL _sqFind(sq-1)
 *     RET _sqFind -> null
 *     RET sqOpenPlayer -> undefined
 *
 * while the squad store held canonical UUIDs. The markup was stale: the Squad
 * page is built at boot, from the demo squad, and hydration then replaces the
 * store without anything redrawing the rows already on the page. Each row keeps
 * the id it was drawn with, so it asks for a footballer the store no longer has
 * and sqOpenPlayer returns at its guard — silently, which is why the click
 * looked dead. Re-rendering the same rows from the same context turned
 * `sq-1` into the canonical UUID and the profile opened.
 *
 * An age group never showed it because its page is built when the group is
 * opened, which is after hydration. Same row renderer, same opener contract —
 * only the moment the markup was produced differed.
 *
 * Held here: the store and the Squad surface are kept in step where the store
 * changes, through the context's own refreshRoster — the repaint every team
 * declares — so there is no First Team-only path, and sqOpenPlayer keeps the
 * guard that made the failure silent rather than wrong.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

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

describe('replacing the squad store redraws the squad surface', () => {
  it('_sqLoad repaints after it swaps the store, on both of its paths', () => {
    const body = fnBody('_sqLoad');
    expect(body).toContain('_sqSurfaceFollowStore');
    // the backend path and the saved-squad path both replace the array
    const hits = body.match(/_sqSurfaceFollowStore\(\)/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('the repaint is the context\'s own, not a First Team-only redraw', () => {
    const body = fnBody('_sqSurfaceFollowStore');
    expect(body).toContain('refreshRoster');
    // it asks the context for it rather than reaching into the table itself
    expect(body).not.toContain('sq-lineup-tbody');
    expect(body).not.toContain('innerHTML');
  });

  it('and it does nothing before the Squad page exists', () => {
    expect(fnBody('_sqSurfaceFollowStore')).toContain("getElementById('pg-squad')");
  });

  it('the First Team context still declares that repaint', () => {
    // _sqFirstCtx is an object literal, so read the declaration itself
    const at = APP.indexOf('function _sqFirstCtx');
    const decl = APP.slice(at, at + 6000);
    expect(decl).toMatch(/refreshRoster:\s*function/);
  });
});

describe('the row and the opener agree on one identity', () => {
  it('a list row carries the player id and the context\'s own open action', () => {
    // one renderer, both teams: the action is declared by the context
    expect(APP).toMatch(/data-action="'\s*\+\s*\(C\.openAction\s*\|\|\s*'sqOpenPlayer'\)/);
    expect(APP).toMatch(/data-player-id="'\s*\+\s*p\.id/);
  });

  it('the row id comes from the context roster, never from an index or a shirt number', () => {
    const rows = fnBody('_sqLineupRows');
    expect(rows).toContain('_sqLineupFiltered');
    expect(rows).not.toMatch(/data-player-id="'\s*\+\s*(i|idx|index|p\.num)\b/);
  });

  it('the filtered list reads the context roster, which is the live store', () => {
    expect(fnBody('_sqLineupFiltered')).toContain('C.roster');
    const at = APP.indexOf('function _sqFirstCtx');
    expect(APP.slice(at, at + 800)).toMatch(/get roster\(\)\s*\{\s*return SQ_DEMO_PLAYERS/);
  });

  it('sqOpenPlayer keeps its guard — a stale id must not open the wrong player', () => {
    const body = fnBody('sqOpenPlayer');
    expect(body).toContain('if (!_sqFind(id)) return;');
    expect(body).toContain('SQ_UI.playerId = id');
  });

  it('the delegated dispatcher passes the row\'s id straight through', () => {
    expect(APP).toMatch(/case 'sqOpenPlayer':\s*if \(typeof sqOpenPlayer === 'function'\)\s*sqOpenPlayer\(el\.dataset\.playerId\);/);
  });

  it('an age group routes the same row to its own opener, so neither team is special-cased', () => {
    expect(APP).toMatch(/case 'atLuOpenPlayer':/);
    expect(APP).toMatch(/openAction/);
  });
});
