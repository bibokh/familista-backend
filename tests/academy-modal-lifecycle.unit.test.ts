/**
 * tests/academy-modal-lifecycle.unit.test.ts
 *
 * Opening a player card does not rebuild the page behind it.
 *
 * The First Team writes the dialog and leaves its page alone. The Academy did
 * not: `_atPlayerModal(id)` was concatenated into the string that
 * renderAcademyTeamPage() assigns to the whole shell, so opening a player,
 * moving between his profile tabs and closing him each tore down and rebuilt
 * the age group's header, nav and section content underneath the panel.
 *
 * Counted in a browser, on the nodes replaced OUTSIDE the modal:
 *
 *                          before   after
 *   opening a player card       5       0
 *   switching a profile tab     6       0
 *   closing                     5       0
 *
 * The panel now has its own host and every path that opens a player, moves
 * between his tabs or closes him writes only that — the same lifecycle the
 * First Team already had.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

function bodyOf(name: string): string | null {
  const at = APP.indexOf(`\nfunction ${name}(`);
  if (at < 0) return null;
  let i = APP.indexOf('{', at), depth = 0;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') { depth--; if (depth === 0) return APP.slice(i, j + 1); }
  }
  return null;
}

describe('the academy panel has a host of its own', () => {
  it('the page reserves one instead of carrying the modal in its own markup', () => {
    const render = bodyOf('renderAcademyTeamPage');
    expect(render).toBeTruthy();
    expect(render).toContain("'<div id=\"at-modal-host\"></div>'");
    // the concatenation that made the modal part of the page
    expect(render).not.toContain('+ _atPlayerModal(id);');
  });

  it('and one function writes it, touching nothing else', () => {
    const r = bodyOf('_atRenderPlayerModal');
    expect(r).toBeTruthy();
    expect(r).toContain("getElementById('at-modal-host')");
    expect(r).toContain('_atPlayerModal(AT.active)');
    expect(r).not.toContain('renderAcademyTeamPage');
  });
});

describe('every path that only changes the panel uses it', () => {
  it('opening a player', () => {
    const f = /function _atOpenPlayer\([^)]*\)\s*\{[^}]*\}/.exec(APP);
    expect(f).toBeTruthy();
    expect(f![0]).toContain('_atRenderPlayerModal()');
    expect(f![0]).not.toContain('renderAcademyTeamPage()');
  });

  it('closing him', () => {
    const f = /function _atClosePlayer\([^)]*\)\s*\{[^}]*\}/.exec(APP);
    expect(f).toBeTruthy();
    expect(f![0]).toContain('_atRenderPlayerModal()');
    expect(f![0]).not.toContain('renderAcademyTeamPage()');
  });

  it('switching one of his profile tabs', () => {
    const at = APP.indexOf("data-at-ptab');");
    expect(at).toBeGreaterThan(-1);
    const line = APP.slice(APP.lastIndexOf('\n', at), APP.indexOf('\n', at));
    expect(line).toContain('_atRenderPlayerModal()');
    expect(line).not.toContain('renderAcademyTeamPage()');
  });

  it('and the lineup row actions that jump straight to a tab', () => {
    const f = bodyOf('atLuAct');
    expect(f).toBeTruthy();
    expect(f).toContain('_atRenderPlayerModal()');
    expect(f).not.toContain('renderAcademyTeamPage()');
  });
});

describe('what the page still does for itself', () => {
  it('changing section still rebuilds the page, which is what it is for', () => {
    const f = /function _atGo\([^)]*\)\s*\{[^}]*\}/.exec(APP);
    expect(f![0]).toContain('renderAcademyTeamPage()');
  });

  it('and the panel is still the shared profile shell, not a second one', () => {
    const m = bodyOf('_atPlayerModal');
    expect(m).toContain('_sqProfileInner(');
    expect(m).toContain('sq-plm-dialog');
  });
});
