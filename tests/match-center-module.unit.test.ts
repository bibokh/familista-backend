// The Match Center as its own module — the properties that make the restructure
// safe rather than merely done.
//
// The Match Center used to be a tab inside Familista League. It is now a module
// of the Club Workspace holding every competition's fixtures, and the League is
// the competition workspace it used to contain. Three things must stay true for
// that to be an improvement rather than a second copy of a screen:
//
//   one Fixture row, read by two modules — never duplicated;
//   first teams only, decided by the rule that already exists;
//   a kickoff judged by the clock at the venue, on the server.
//
// The scheduling rules below are exercised for real, not asserted about: they
// are pure functions over a date and a policy, which is exactly the part of this
// feature a reader would want proved rather than described.

import fs from 'fs';
import path from 'path';
import {
  DEFAULT_SCHEDULING_POLICY,
  readSchedulingPolicy,
  resolveVenueTimeZone,
  validateKickoff,
  localClockAt,
  isValidTimeZone,
} from '../src/competition/match-scheduling';
import * as weather from '../src/competition/match-weather.service';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const APP = read('public/app.js');
const MCS = read('src/competition/match-center.service.ts');
const ROUTES = read('src/routes/match-center.routes.ts');
const CTRL = read('src/controllers/match-center.controller.ts');
const INDEX = read('src/routes/index.ts');
const ADMIN = read('src/competition/familista-league.admin.service.ts');
const SCHEMA = read('prisma/schema.prisma');

// A fixed "now" so "in the future" is a property of the input, not of the day
// the suite happens to run.
const NOW = new Date('2026-09-03T08:00:00Z');
const BERLIN = 'Europe/Berlin';

describe('a kickoff is judged by the clock at the venue', () => {
  it('05:00 local is refused under the default policy', () => {
    // 03:00Z is 05:00 in Berlin in September (CEST, UTC+2).
    const v = validateKickoff({
      at: '2026-10-01T03:00:00Z', timeZone: BERLIN, policy: DEFAULT_SCHEDULING_POLICY, now: NOW,
    });
    expect(v.localTime).toBe('05:00');
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe('BEFORE_EARLIEST');
    expect(v.message).toContain('09:00');
  });

  it('and 18:30 local is accepted', () => {
    const v = validateKickoff({
      at: '2026-10-01T16:30:00Z', timeZone: BERLIN, policy: DEFAULT_SCHEDULING_POLICY, now: NOW,
    });
    expect(v.localTime).toBe('18:30');
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('OK');
  });

  it('the boundaries themselves are inside the window, not outside it', () => {
    const at = (hhmmZ: string) => validateKickoff({
      at: `2026-10-01T${hhmmZ}:00Z`, timeZone: BERLIN, policy: DEFAULT_SCHEDULING_POLICY, now: NOW,
    });
    expect(at('07:00').localTime).toBe('09:00');          // earliest
    expect(at('07:00').ok).toBe(true);
    expect(at('19:30').localTime).toBe('21:30');          // latest
    expect(at('19:30').ok).toBe(true);
    expect(at('19:31').ok).toBe(false);
    expect(at('19:31').verdict).toBe('AFTER_LATEST');
  });

  it('the venue\'s clock decides, not the reader\'s', () => {
    // One instant, two venues. 18:30 in Berlin is 01:30 the next morning in
    // Tokyo, and Tokyo refuses it — which is the entire reason the rule is
    // written against a time zone rather than against UTC.
    const instant = '2026-10-01T16:30:00Z';
    const berlin = validateKickoff({ at: instant, timeZone: BERLIN, policy: DEFAULT_SCHEDULING_POLICY, now: NOW });
    const tokyo = validateKickoff({ at: instant, timeZone: 'Asia/Tokyo', policy: DEFAULT_SCHEDULING_POLICY, now: NOW });
    expect(berlin.ok).toBe(true);
    expect(tokyo.localTime).toBe('01:30');
    expect(tokyo.ok).toBe(false);
  });

  it('and a fixture across a daylight-saving boundary is judged by that day\'s clock', () => {
    // Europe/Berlin leaves summer time on 25 October 2026. 18:30Z reads 20:30
    // before the change and 19:30 after it; both are inside the window, and the
    // point is that the two differ at all — offset arithmetic of our own would
    // have given the same answer twice.
    expect(localClockAt(new Date('2026-10-20T18:30:00Z'), BERLIN).minutes).toBe(20 * 60 + 30);
    expect(localClockAt(new Date('2026-10-27T18:30:00Z'), BERLIN).minutes).toBe(19 * 60 + 30);
  });

  it('a kickoff in the past is refused whatever the hour says', () => {
    const v = validateKickoff({
      at: '2026-09-01T16:30:00Z', timeZone: BERLIN, policy: DEFAULT_SCHEDULING_POLICY, now: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe('IN_THE_PAST');
  });

  it('a malformed date is refused rather than coerced', () => {
    for (const bad of ['not a date', '2026-13-45T99:99:99Z', '']) {
      const v = validateKickoff({ at: bad, timeZone: BERLIN, policy: DEFAULT_SCHEDULING_POLICY, now: NOW });
      expect(v.ok).toBe(false);
      expect(v.verdict).toBe('MALFORMED');
    }
  });

  it('and proposing the kickoff a fixture already has is not a change', () => {
    const at = '2026-10-01T16:30:00Z';
    const v = validateKickoff({
      at, timeZone: BERLIN, policy: DEFAULT_SCHEDULING_POLICY, now: NOW, current: new Date(at),
    });
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe('UNCHANGED');
  });

  it('an unknown time zone falls back to UTC rather than throwing', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    const v = validateKickoff({
      at: '2026-10-01T16:30:00Z', timeZone: 'Mars/Olympus', policy: DEFAULT_SCHEDULING_POLICY, now: NOW,
    });
    expect(v.timeZone).toBe('UTC');
    expect(v.localTime).toBe('16:30');
  });
});

describe('the window is configuration, per competition', () => {
  it('the default is the safe one', () => {
    expect(DEFAULT_SCHEDULING_POLICY.earliestKickoff).toBe('09:00');
    expect(DEFAULT_SCHEDULING_POLICY.latestKickoff).toBe('21:30');
  });

  it('a competition may widen or narrow it', () => {
    const p = readSchedulingPolicy({ scheduling: { earliestKickoff: '11:00', latestKickoff: '23:00' } });
    expect(p.earliestKickoff).toBe('11:00');
    expect(p.latestKickoff).toBe('23:00');
    // And a kickoff the default would refuse is then allowed.
    const v = validateKickoff({ at: '2026-10-01T20:00:00Z', timeZone: BERLIN, policy: p, now: NOW });
    expect(v.localTime).toBe('22:00');
    expect(v.ok).toBe(true);
  });

  it('a competition with no rules gets the default, and so does a malformed one', () => {
    for (const rules of [null, undefined, {}, { scheduling: 'nonsense' }, { scheduling: { earliestKickoff: '25:99' } }]) {
      const p = readSchedulingPolicy(rules as never);
      expect(p.earliestKickoff).toBe('09:00');
      expect(p.latestKickoff).toBe('21:30');
    }
    // A window whose end is before its start is not a window; it falls back
    // whole rather than refusing every kickoff for the season.
    const inverted = readSchedulingPolicy({ scheduling: { earliestKickoff: '20:00', latestKickoff: '08:00' } });
    expect(inverted.earliestKickoff).toBe('09:00');
    expect(inverted.latestKickoff).toBe('21:30');
  });
});

describe('the venue\'s zone is resolved from records, in order', () => {
  it('the club\'s own zone wins', () => {
    expect(resolveVenueTimeZone({ clubTimeZone: 'Europe/Lisbon', clubCountry: 'Germany' }))
      .toEqual({ timeZone: 'Europe/Lisbon', source: 'CLUB' });
  });

  it('then the competition\'s, then the country the club is registered in', () => {
    expect(resolveVenueTimeZone({ clubCountry: 'Germany', policy: { ...DEFAULT_SCHEDULING_POLICY, timeZone: 'Asia/Tokyo' } }))
      .toEqual({ timeZone: 'Asia/Tokyo', source: 'COMPETITION' });
    expect(resolveVenueTimeZone({ clubCountry: 'Germany' }))
      .toEqual({ timeZone: BERLIN, source: 'COUNTRY' });
  });

  it('and UTC is the stated fallback rather than a silent guess', () => {
    // A country with more than one civil zone has no single right answer, so
    // none is invented for it.
    expect(resolveVenueTimeZone({ clubCountry: 'United States' }))
      .toEqual({ timeZone: 'UTC', source: 'FALLBACK' });
    expect(resolveVenueTimeZone({})).toEqual({ timeZone: 'UTC', source: 'FALLBACK' });
  });
});

describe('the weather is a boundary, not a fabrication', () => {
  const KEY = 'WEATHER_PROVIDER';
  afterEach(() => { delete process.env[KEY]; });

  it('with no provider configured there is no reading, and the page can say so', async () => {
    delete process.env[KEY];
    expect(weather.isConfigured()).toBe(false);
    await expect(weather.describe({
      venue: 'Anywhere', city: 'Berlin', country: 'Germany', timeZone: BERLIN, kickoffAt: new Date(),
    })).resolves.toBeNull();
  });

  it('and nothing in the service invents a temperature', () => {
    const src = codeOnly(read('src/competition/match-weather.service.ts'));
    expect(src).not.toContain('Math.random');
    expect(src).not.toMatch(/temperatureC:\s*\d/);
  });

  it('the calendar renders that nothing as an honest state', () => {
    const row = APP.slice(APP.indexOf('function _mccRowHtml('), APP.indexOf('function _mccListHtml('));
    expect(row).toContain('Weather unavailable');
    expect(row).toContain('r.weather');
    // The reading, when there is one, is the provider's own figure.
    expect(row).toContain('Math.round(r.weather.temperatureC)');
  });
});

describe('one fixture is one record', () => {
  it('the Match Center reads fixtures and never writes one', () => {
    const code = codeOnly(MCS);
    // The single fixture write in the module is the approved reschedule, and it
    // updates the existing row rather than creating a second one.
    expect(code).not.toContain('prisma.fixture.create');
    expect((code.match(/tx\.fixture\.update|prisma\.fixture\.update/g) || []).length).toBe(1);
    expect(code).toMatch(/tx\.fixture\.update\(\{[\s\S]{0,160}where: \{ id: req\.fixtureId \}/);
  });

  it('and the Match row the fixture is played as moves with it', () => {
    const code = codeOnly(MCS.slice(MCS.indexOf("if (next === 'APPROVED')")));
    expect(code).toContain('tx.match.update');
    expect(code).toContain('scheduledAt: req.proposedKickoff');
  });

  it('the League and the Match Center read the same fixture through one match reader', () => {
    // The Match Center does not reimplement the match document; it asks the
    // reader the League already uses.
    expect(MCS).toContain("import * as league from './familista-league.service'");
    expect(MCS).toContain('league.getMatchDetail(fixture.competitionId, fixture.id)');
    expect(APP.match(/function _mcOverviewHtml\(/g) || []).toHaveLength(1);
    expect(APP.match(/function _mcPreparationHtml\(/g) || []).toHaveLength(1);
  });
});

describe('first teams only, and no academy leakage', () => {
  it('the calendar asks the eligibility rule rather than naming teams', () => {
    expect(MCS).toContain("import { FIRST_TEAM_KINDS } from './league-eligibility'");
    expect(MCS).toContain('kind: { in: FIRST_TEAM_KINDS as TeamKind[] }');
    expect(MCS).not.toMatch(/ACADEMY_U\d|RESERVES/);
  });

  it('and every fixture is matched against those team ids, not against a club name', () => {
    const cal = MCS.slice(MCS.indexOf('export async function getCalendar'),
                          MCS.indexOf('export async function getFixtureDetail'));
    expect(cal).toContain('const teamIds = await firstTeamIdsForClub(clubId)');
    expect(cal).toContain('OR: [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }]');
    // Which side is ours is decided by team id too — never by a name test.
    expect(cal).toContain("teamIds.includes(f.homeTeamId) ? 'home'");
    expect(cal).not.toMatch(/familista/i);
  });

  it('and a fixture neither of our first teams is in cannot be opened', () => {
    const guard = MCS.slice(MCS.indexOf('async function assertOurFixture'),
                            MCS.indexOf('async function assertOurFixture') + 500);
    expect(guard).toContain('const ours = await firstTeamIdsForClub(actor.clubId)');
    expect(guard).toContain('throw new ForbiddenError');
    expect(MCS).toContain('await assertOurFixture(actor, fixture.homeTeamId, fixture.awayTeamId)');
  });
});

describe('the reschedule workflow', () => {
  it('carries every state the brief names, in the schema', () => {
    const block = SCHEMA.slice(SCHEMA.indexOf('enum FixtureChangeStatus {'),
                               SCHEMA.indexOf('model FixtureChangeRequest'));
    for (const state of ['DRAFT', 'REQUESTED', 'AWAITING_OPPONENT', 'OPPONENT_ACCEPTED',
                         'OPPONENT_REJECTED', 'AWAITING_COMPETITION_APPROVAL', 'APPROVED',
                         'REJECTED', 'CANCELLED']) {
      expect(block).toContain(state);
    }
  });

  it('keeps an append-only audit history', () => {
    expect(SCHEMA).toContain('model FixtureChangeEvent');
    const code = codeOnly(MCS);
    // Every transition writes a history row, and none of them rewrites one.
    expect(code).toMatch(/events: \{[\s\S]{0,600}status: next as never/);
    // An action that means two things records both, so the trail says who
    // agreed as well as what the request is now waiting on.
    expect(code).toContain("alsoRecord = 'OPPONENT_ACCEPTED'");
    expect(code).toMatch(/\.\.\.\(alsoRecord[\s\S]{0,200}status: alsoRecord as never/);
    expect(code).not.toContain('fixtureChangeEvent.update');
    expect(code).not.toContain('fixtureChangeEvent.delete');
  });

  it('a club may ask but not take: the fixture is written only on approval', () => {
    const act = MCS.slice(MCS.indexOf('export async function actOnRequest'));
    // Each move belongs to somebody, and the rule lives here rather than in a
    // screen that could simply not be used.
    expect(act).toContain("if (!isRequester) throw new ForbiddenError('Only the club that raised this may send it')");
    expect(act).toContain("if (!isOpponent && !isAdmin) throw new ForbiddenError('Only the opponent may accept this')");
    expect(act).toContain("if (!isAdmin) throw new ForbiddenError('Only the competition may approve a change')");
    // And the write happens under APPROVED and nowhere else.
    expect(codeOnly(act)).toMatch(/if \(next === 'APPROVED'\)[\s\S]{0,700}fixture\.update/);
  });

  it('and the proposal is re-checked at approval, against the policy in force then', () => {
    const act = codeOnly(MCS.slice(MCS.indexOf("if (next === 'APPROVED')")));
    expect(act).toContain('const ctx = await schedulingContextFor(req.fixtureId)');
    expect(act).toContain('validateKickoff({ at: req.proposedKickoff');
    expect(act).toContain('if (!check.ok) throw new BadRequestError(check.message)');
  });

  it('and the panel offers decisions, not a second form, while one is open', () => {
    const html = APP.slice(APP.indexOf('function _mccChangeHtml('), APP.indexOf('function _mccReqTone('));
    expect(html).toContain('var live = _mccOpenRequest(requests)');
    expect(html).toContain('var form = live');
    // Who may do what is read from the record, and confirmed again by the
    // server — the panel offers nothing this club could not actually do.
    const acts = APP.slice(APP.indexOf('function _mccRequestActions('), APP.indexOf('function _mccChangeHtml('));
    expect(acts).toContain('r.requestedByClubId === mine');
    expect(acts).toContain("r.opponentClubId && r.opponentClubId === mine && r.status === 'AWAITING_OPPONENT'");
    for (const label of ['Send to opponent', 'Withdraw request', 'Accept new time', 'Reject new time']) {
      expect(acts).toContain(label);
    }
    // And a decision re-reads the fixture rather than patching the panel.
    const act = APP.slice(APP.indexOf('async function _mccReqAct('), APP.indexOf('async function _mccChgSubmit('));
    expect(act).toContain("api('/match-center/change-requests/");
    expect(act).toContain('await _mccOpen(open.fixtureId)');
    expect(act).toContain('_mccLoad()');
  });

  it('one fixture cannot carry two live proposals', () => {
    const create = MCS.slice(MCS.indexOf('export async function createRequest'),
                             MCS.indexOf('export type RequestAction'));
    expect(create).toContain('status: { in: OPEN_STATES as never[] }');
    expect(create).toContain("throw new BadRequestError('A change request for this fixture is already open')");
  });

  it('the server validates, whatever the client did', () => {
    const create = MCS.slice(MCS.indexOf('export async function createRequest'),
                             MCS.indexOf('export type RequestAction'));
    expect(create).toContain('const check = validateKickoff({');
    expect(create).toContain('if (!check.ok) throw new BadRequestError(check.message)');
    // The administrator's own reschedule path asks the same rule, so the two
    // cannot drift apart.
    expect(ADMIN).toContain("import { validateKickoff } from './match-scheduling'");
    expect(ADMIN).toMatch(/rescheduleFixture[\s\S]{0,1400}validateKickoff\(\{/);
  });

  it('the kickoff a coach types is the venue\'s wall clock, not the browser\'s', () => {
    // 18:30 means half past six AT THE GROUND. Sending the browser's
    // interpretation of that would move the fixture by the difference between
    // two cities every time a coach abroad proposed one.
    const fn = APP.slice(APP.indexOf('function _mccVenueInstant('), APP.indexOf('function _mccChangeOpen('));
    expect(fn).toContain('_mccZoneOffset(at, tz)');
    expect(APP).toContain("var iso = _mccVenueInstant(c.day, c.time, c.timeZone || 'UTC').toISOString();");
    // The prefill is the venue's clock too, from the server's own resolution.
    const open = APP.slice(APP.indexOf('function _mccChangeOpen('), APP.indexOf('function _mccChangeHtml('));
    expect(open).toContain('row.localDate');
    expect(open).toContain('sched.localKickoff');
    // And the offset is read from the zone database rather than computed.
    expect(APP.slice(APP.indexOf('function _mccZoneOffset('), APP.indexOf('function _mccVenueInstant(')))
      .toContain('Intl.DateTimeFormat');
  });

  it('and the client checks first only so a coach is told before submitting', () => {
    const check = APP.slice(APP.indexOf('function _mccCheckProposal('), APP.indexOf('async function _mccChgSubmit('));
    expect(check).toContain('A kickoff must be in the future.');
    expect(check).toContain('outside the window this competition allows');
    // It never decides something is allowed — only that something is not.
    expect(check).toMatch(/return '';\s*\n\}/);
    // And the submit path posts to the server regardless of what it concluded.
    const submit = APP.slice(APP.indexOf('async function _mccChgSubmit('), APP.indexOf('async function _mccChgSubmit(') + 1400);
    expect(submit).toContain("api('/match-center/fixtures/");
    expect(submit).toContain('/change-requests');
  });
});

describe('the module is wired the way the rest of the platform is', () => {
  it('routes are mounted, authenticated, and scoped by the service', () => {
    expect(INDEX).toContain("router.use('/match-center',        matchCenterRoutes)");
    expect(ROUTES).toContain('router.use(authenticate)');
    for (const line of ["router.get('/calendar'", "router.get('/fixtures/:fixtureId'",
                        "router.get('/fixtures/:fixtureId/scheduling-policy'",
                        "router.get('/fixtures/:fixtureId/change-requests'",
                        "router.post('/fixtures/:fixtureId/change-requests'",
                        "router.post('/change-requests/:requestId/action'"]) {
      expect(ROUTES).toContain(line);
    }
    // No route creates a fixture: the Match Center displays what the
    // competition engine owns.
    expect(ROUTES).not.toMatch(/post\('\/fixtures'/);
  });

  it('the caller\'s club comes from the session, never from the request', () => {
    const actor = CTRL.slice(CTRL.indexOf('function actorOf('), CTRL.indexOf('const calendarSchema'));
    expect(actor).toContain('u?.currentClubId ?? u?.clubId ?? \'\'');
    expect(actor).not.toContain('req.body');
    expect(actor).not.toContain('req.query');
  });

  it('and every input is parsed before it reaches the service', () => {
    expect(CTRL).toContain("import { z } from 'zod'");
    for (const parse of ['calendarSchema.parse', 'fixtureSchema.parse', 'createSchema.parse', 'actSchema.parse']) {
      expect(CTRL).toContain(parse);
    }
  });
});
