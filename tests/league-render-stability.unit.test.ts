/**
 * tests/league-render-stability.unit.test.ts
 *
 * The League is built once, and re-entering it does not demolish it.
 *
 * Production showed the workspace shaking. The cause was a double mount, not a
 * timing problem: `renderFamilistaLeagueHTML` scheduled `renderFamilistaLeaguePage`
 * on a tick, and `navTo` calls that function itself right after mounting the
 * page. So entering the League ran the whole build twice — shell written, header
 * and body painted, then a tick later the shell overwritten, the section reset
 * to Standings, the round dropped, and a SECOND overview read fired behind the
 * first. Two answers, two repaints, one visible shudder.
 *
 * Three things follow from fixing it, and each is pinned below.
 *
 *   · The template is markup. Nothing schedules a page build from it.
 *   · A shell that is already standing is kept. Re-entering the League from the
 *     Match Centre repaints the header and the body it needs and leaves the rest
 *     of the DOM alone, so the reader's section and round survive the trip.
 *   · One overview read at a time, and only the newest fixture answer paints.
 *
 * `tests/league-premium.unit.test.ts` pins the geometry that keeps the page
 * still — fixed-height column, `scrollbar-gutter: stable`, fixed-position
 * panels. This file pins the render path above it. Neither adds a delay: there
 * is no `setTimeout` in any of it, and the two ticks that were there are gone.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

function between(from: string, to: string): string {
  const a = APP.indexOf(from);
  const b = APP.indexOf(to, a + 1);
  expect(`${from} found: ${a > -1}`).toBe(`${from} found: true`);
  expect(`${to} after it: ${b > a}`).toBe(`${to} after it: true`);
  return APP.slice(a, b);
}
const decomment = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · the workspace is built once', () => {
  it('the League template is markup and schedules nothing', () => {
    const fn = decomment(between('function renderFamilistaLeagueHTML() {', 'function _flShellHtml(standalone) {'));
    expect(fn).toContain("id=\"fl-shell\"");
    expect(fn).not.toContain('setTimeout');
    expect(fn).not.toContain('renderFamilistaLeaguePage');
  });

  it('and navTo is the one caller that builds it', () => {
    const nav = decomment(between("if (page === 'familista-league' && typeof renderFamilistaLeaguePage === 'function') {", '// Academy Team Workspace is a child of Academy'));
    expect(nav).toContain('renderFamilistaLeaguePage();');
  });

  it('and the academy workspace that embeds a League is the same', () => {
    // It hosts the League inside itself, so a double mount there built the
    // League twice over as well.
    const fn = decomment(between('function renderAcademyTeamHTML() {', 'function renderAcademyTeamPage() {'));
    expect(fn).toContain('id="at-shell"');
    expect(fn).not.toContain('setTimeout');
    expect(fn).not.toContain('renderAcademyTeamPage');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 · re-entering it keeps what is on screen', () => {
  const page = () => between('function renderFamilistaLeaguePage(opts) {', '// Colours that come from configuration');

  it('the shell is rebuilt only when the host or the team changed, or there is none', () => {
    const fn = decomment(page());
    expect(fn).toContain('var moved = (_FL.host !== host || _FL.teamId !== teamId);');
    expect(fn).toContain("var fresh = moved || !host.querySelector('.fl-body');");
    expect(fn).toContain('if (fresh) {');
    // The unconditional demolition is gone: the assignment now sits inside the
    // branch, and the section reset with it.
    expect(fn).not.toMatch(/\n\s*host\.innerHTML = _flShellHtml\(standalone\);\n\s*_flPaintHead/);
  });

  it('and the section, round and open panel are reset only on a fresh build', () => {
    const fn = decomment(page());
    const freshBlock = fn.slice(fn.indexOf('if (fresh) {'), fn.indexOf('_flPaintHead();'));
    expect(freshBlock).toContain("_FL.tab = 'standings'");
    expect(freshBlock).toContain('_FL.round = null');
    expect(freshBlock).toContain('_FL.preview = null');
  });

  it('and a League that already has its season repaints rather than re-reading it', () => {
    const fn = decomment(page());
    expect(fn).toContain('if (fresh || (!_FL.league && !_FL.loading.overview)) _flLoadOverview();');
    expect(fn).toContain('else _flPaintBody();');
  });

  it('so closing the Match Centre restores the section in one paint, not two', () => {
    const fn = decomment(between('function _mccClose() {', '// ── the workspace'));
    const i = fn.indexOf("_FL.tab = back.tab");
    const j = fn.indexOf("navTo('familista-league')");
    expect(i).toBeGreaterThan(-1);
    // State first, navigation second: the League no longer overwrites it, so
    // there is no reset for a correction to chase.
    expect(`state before nav: ${i < j}`).toBe('state before nav: true');
    expect(fn).not.toContain('_flPaintHead(); _flPaintBody();');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · and no answer paints over a newer one', () => {
  it('one overview read at a time', () => {
    const fn = decomment(between('async function _flLoadOverview() {', 'async function _flLoadTab() {'));
    expect(fn).toContain('if (_FL.loading.overview) return;');
  });

  it('a fixture answer for a team the reader has left is dropped', () => {
    const fn = decomment(between('async function _flLoadOverview() {', 'async function _flLoadTab() {'));
    expect(fn).toContain('if (_FL.teamId !== asked) return;');
  });

  it('and only the newest Match Centre request paints', () => {
    const fn = decomment(between('async function _mccOpen(fixtureId, returnTo) {', 'function _mccClose() {'));
    expect(fn).toContain('var seq = (_MCC.seq = (_MCC.seq || 0) + 1);');
    expect((fn.match(/if \(seq !== _MCC\.seq\) return;/g) || []).length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 · and none of it was bought with a delay', () => {
  it('the League module schedules nothing on a timer', () => {
    const league = decomment(between('var _FL = {', '// ── handing a league fixture to the Match Center'));
    expect(league).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
  });

  it('and the handoff into the Match Centre is one deterministic step', () => {
    const fn = decomment(between('function _flOpenMatch(fixtureId) {', 'function _flTabTo(tab) {'));
    // `_atGo` paints synchronously, so the tick that used to sit between it and
    // the open was waiting for something that had already happened.
    expect(fn).not.toContain('setTimeout');
    expect(fn).toContain("_atGo('matchCenter')");
    expect(fn).toContain('_mccOpen(fixtureId,');
  });

  it('and switching section repaints the body, not the workspace', () => {
    const fn = decomment(between('function _flTabTo(tab) {', '// ── managing participants'));
    expect(fn).not.toContain('renderFamilistaLeaguePage');
    expect(fn).not.toContain('innerHTML');
    expect(fn).toContain('_flPaintBody()');
  });

  it('and each paint writes into one region rather than replacing its node', () => {
    for (const [from, to] of [
      ['function _flPaintHead() {', 'function _flPaintBody() {'],
      ['function _flPaintBody() {', 'function _flPaintOverlay() {'],
    ] as Array<[string, string]>) {
      const fn = decomment(between(from, to));
      expect(`${from} writes innerHTML: ${fn.includes('.innerHTML =')}`).toBe(`${from} writes innerHTML: true`);
      expect(`${from} replaces the node: ${fn.includes('outerHTML')}`).toBe(`${from} replaces the node: false`);
    }
  });

  it('and a panel floats over the page rather than growing it', () => {
    const CSS = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');
    const bg = CSS.slice(CSS.indexOf('.lg-float-bg{'), CSS.indexOf('@keyframes lgFade'));
    expect(bg).toContain('position:fixed');
    expect(bg).toContain('inset:0');
    // And the workspace keeps its own gutter, so content arriving cannot shift
    // the columns sideways.
    const body = CSS.slice(CSS.indexOf('.fl-body{'), CSS.indexOf('.fl-body > .lg-panel'));
    expect(body).toContain('scrollbar-gutter:stable');
    expect(body).toContain('overflow-y:auto');
  });
});
