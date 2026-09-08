/**
 * tests/performance-stability-pass.unit.test.ts
 *
 * Three things this pass found, and nothing it did not.
 *
 * 1 · AN ACADEMY PLAYER'S PHOTO NEVER LEFT THE BROWSER. The handler wrote the
 *     data URL into the team's local overlay and called `_atSave()`, which is
 *     `localStorage`. The card repainted, so it looked saved — and it was gone
 *     on any other device, gone after clearing site data, and never visible to
 *     anybody else in the club. The Squad editor and the Player Center both
 *     PATCH `avatar` on the player's own record; this path did not, and now
 *     does, through the same route with the same authorization deciding.
 *
 * 2 · A ROUND TRIP ON THE END OF EVERY CLUB LOAD. `loadAllData` ran five reads
 *     in parallel and then awaited a sixth on its own. None of the six needs
 *     another's answer.
 *
 * 3 · A ROUND TRIP ON EVERY PLAYER SAVE. `_thRefresh` awaited `/teams` and then
 *     the roster. Independent reads, and this runs after every save.
 *
 * What is asserted below is the shape of each fix and, for the photo, the
 * request it now makes. Nothing here is a timing measurement: a stopwatch in a
 * unit test measures the machine it runs on. What can be pinned is that the
 * waiting is gone and cannot come back unnoticed.
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
describe('1 · an academy player\'s photo reaches the record', () => {
  /** The real `_atPersistPhoto`, with the transport observed. */
  function persist(playerId: string, hydrated = true) {
    // The sequence counter is part of the unit now: an older answer must not
    // land on a newer one, so it is sliced in with the function.
    const src = between('var _AT_PHOTO_SEQ = {};', 'function _atOverlay(id) {');
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    const toasts: string[] = [];
    const State: Record<string, unknown> = { players: [] };
    // eslint-disable-next-line no-new-func
    const fn = new Function('_thApi', '_thIsHydrated', 'showToast', '_atOverlay', '_atSave',
      'AT', 'window', 'State', `${src}\nreturn _atPersistPhoto;`);
    fn(
      (method: string, url: string, body: Record<string, unknown>) => {
        calls.push({ method, url, body });
        return Promise.resolve({ data: { id: playerId, avatar: String(body.avatar) } });
      },
      () => hydrated,
      (msg: string) => toasts.push(msg),
      () => ({}),
      () => {},
      { active: 'u15' },
      { State },
      State,
    )(playerId, 'data:image/jpeg;base64,AAAA');
    return { calls, toasts };
  }

  const REAL = '11111111-2222-3333-4444-555555555555';

  it('a real player\'s photo is PATCHed onto the player\'s own record', () => {
    const { calls } = persist(REAL);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe(`/players/${REAL}`);
    // One field, the same one the Squad editor and the Player Center write.
    expect(Object.keys(calls[0].body)).toEqual(['avatar']);
    expect(String(calls[0].body.avatar)).toContain('data:image/jpeg;base64,');
  });

  it('and the three photo paths all write the same field on the same route', () => {
    // The Squad editor maps its form's `photo` onto `avatar`…
    expect(APP).toContain("['photo',  'avatar',");
    // …the Player Center PATCHes it through SquadAPI…
    expect(APP).toContain('SquadAPI.update(playerId, { avatar: dataUrl })');
    // …and the academy card now does the same thing rather than stopping at
    // localStorage.
    const handler = between("if (e.target.getAttribute && e.target.getAttribute('data-at-photo')", '// Coaching-staff photo upload');
    expect(handler).toContain('_atPersistPhoto(_pid, url);');
    // The overlay write stays: it is what puts the picture on screen at once.
    expect(handler).toContain('_atSave();');
  });

  it('a card that exists only in this browser says so instead of pretending', () => {
    const { calls, toasts } = persist('u15-local-3');
    expect(calls).toHaveLength(0);
    expect(toasts).toEqual(['Photo updated on this device only']);
  });

  it('and an unhydrated session does not pretend either', () => {
    const { calls, toasts } = persist(REAL, false);
    expect(calls).toHaveLength(0);
    expect(toasts).toEqual(['Photo updated on this device only']);
  });

  it('the success message is the server\'s answer, not the repaint', () => {
    const src = decomment(between('function _atPersistPhoto(playerId, dataUrl) {', 'function _atOverlay(id) {'));
    // "Photo updated" is said inside the .then — after the server answered —
    // and a refusal is said out loud.
    expect(src).toMatch(/\.then\(function \(res\)[\s\S]*Photo updated/);
    expect(src).toContain('Photo not saved');
    // The failure is never swallowed into a silent success.
    expect(src).not.toMatch(/catch[\s\S]{0,80}success/);
  });

  it('and it adds no authorization of its own — the route decides', () => {
    const src = decomment(between('function _atPersistPhoto(playerId, dataUrl) {', 'function _atOverlay(id) {'));
    expect(src).not.toMatch(/CLUB_ADMIN|HEAD_COACH|SUPER_ADMIN|CLUB_OWNER|effectiveAccess|currentClubRole/);
    // And the route it uses is the one that was already there, with the guard
    // it already had.
    const routes = fs.readFileSync(path.join(ROOT, 'src/routes/player.routes.ts'), 'utf8');
    expect(routes).toContain("router.patch('/:id',            authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updatePlayer);");
  });

  it('and the server still persists that field, and still reads it back', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'src/services/player.service.ts'), 'utf8');
    expect(svc).toContain("...(dto.avatar        !== undefined && { avatar:        dto.avatar }),");
    // The list returns whole rows — `include`, never a top-level `select` —
    // so a saved photo comes back with the roster. (The relation `select`s
    // inside the include narrow the RELATIONS, not the player's own columns.)
    const list = svc.slice(svc.indexOf('export async function getPlayers('), svc.indexOf('export async function getPlayerById('));
    const call = list.slice(list.indexOf('prisma.player.findMany({'));
    expect(call.slice(0, call.indexOf('orderBy'))).not.toMatch(/\n\s{6}select: \{/);
    expect(call).toContain('include: {');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 · nothing waits for an answer it does not need', () => {
  it('every club-load read goes out together', () => {
    const fn = decomment(between('async function loadAllData(opts) {', '// ── Login field hygiene'));
    const batch = fn.slice(fn.indexOf('await Promise.allSettled(['), fn.indexOf(']);'));
    for (const url of [
      "api('/analytics/overview')",
      'SquadAPI.list(',
      "api('/matches?limit=20')",
      "api('/training?limit=10'",
      "api('/training/form'",
      "api('/analytics/performance-trend?weeks=8')",
    ]) {
      expect(`${url} in the batch: ${batch.includes(url)}`).toBe(`${url} in the batch: true`);
    }
    // And the sixth is no longer awaited on its own afterwards.
    const after = fn.slice(fn.indexOf(']);'));
    expect(after).not.toContain("await api('/analytics/performance-trend");
    expect(after).not.toMatch(/await\s+api\(/);
  });

  it('and the trend is still counted as one panel, not as all of them', () => {
    const fn = decomment(between('async function loadAllData(opts) {', '// ── Login field hygiene'));
    expect(fn).toContain("const trendOk = trend.status === 'fulfilled';");
    // The outcome still separates the five required reads from the trend, so a
    // failing trend cannot report itself as a failed club load.
    expect(fn).toContain('_famHydrationOutcome([analytics, players, matches, tourns, training], trendOk)');
    const outcome = between('function _famHydrationOutcome(settled, trendOk) {', 'function _thRosterIsCurrent() {');
    expect(outcome).toContain("var NAMES = ['analytics', 'players', 'matches', 'training', 'training form'];");
  });

  it('the roster and the teams are read together', () => {
    const fn = decomment(between('async function _thRefresh() {', 'function _thTeamIdFor(label) {'));
    expect(fn).toContain("await Promise.all([_thApi('GET', '/teams'), _thAllPlayers()])");
    // Neither is awaited before the other any more.
    expect(fn).not.toMatch(/var teams = _thUnwrap\(await _thApi\('GET', '\/teams'\)\);/);
    expect(fn).not.toMatch(/var list = await _thAllPlayers\(\);/);
  });

  it('and this pass bought none of it with a delay', () => {
    for (const [from, to] of [
      ['async function loadAllData(opts) {', '// ── Login field hygiene'],
      ['async function _thRefresh() {', 'function _thTeamIdFor(label) {'],
      ['function _atPersistPhoto(playerId, dataUrl) {', 'function _atOverlay(id) {'],
    ] as Array<[string, string]>) {
      const fn = decomment(between(from, to));
      expect(`${from} waits on a timer: ${/setTimeout|setInterval/.test(fn)}`)
        .toBe(`${from} waits on a timer: false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · and the mechanisms that were already right are still there', () => {
  it('concurrent identical reads join one request, and a write drops the cache', () => {
    const fn = decomment(between('  async function request(method, urlOrPath, opts) {', '  return {\n    request,'));
    expect(fn).toContain('const live = _inflight.get(key);');
    expect(fn).toContain('if (live) {');
    expect(fn).toContain('invalidateReadCache();');
    // A write is never served from, or left in, the read cache.
    expect(fn).toMatch(/if \(method !== 'GET'\)[\s\S]{0,200}invalidateReadCache/);
  });

  it('a club\'s data is loaded once per club, not once per caller', () => {
    const fn = decomment(between('function _famEnsureClubData(opts) {', 'function _famActivePage() {'));
    expect(fn).toContain('if (_FAM_CLUB_DATA.for === club && _FAM_CLUB_DATA.p) return _FAM_CLUB_DATA.p;');
    // And a held read never outlives the club it was read for.
    const reset = decomment(between('function _famResetPageVersions() {', 'async function loadAllData(opts) {'));
    expect(reset).toContain('_FAM_CLUB_DATA = { for: null, p: null };');
  });

  it('a page whose data has not moved is not redrawn', () => {
    const fn = decomment(between('function _famRenderPage(page) {', 'function _famDataChanged() {'));
    expect(fn).toContain('if (_FAM_PAGE_VERSION[page] === _FAM_DATA_VERSION) return;');
  });

  it('and no observer loop was introduced anywhere', () => {
    expect((APP.match(/new ResizeObserver/g) || []).length).toBe(0);
  });
});
