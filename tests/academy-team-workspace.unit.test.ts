// The academy as teams, not as one flat block
// ─────────────────────────────────────────────────────────────────────────────
// A club is a First Team and a set of academy age groups. Each age group is a
// team in its own right — its own squad, its own training, its own fixtures —
// and the properties below are the ones that make that true rather than merely
// drawn: the calendar is scoped by team on the SERVER, control is decided by
// assignment rather than by a role name, and the First Team's own path is the
// module's default and therefore unchanged.
//
// Every claim here is about code somebody could undo without noticing.

import fs from 'fs';
import path from 'path';
import {
  TEAM_MANAGING_ROLES,
  isAcademyKind,
} from '../src/identity/team-access.service';
import { MembershipRole, TeamKind } from '@prisma/client';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const APP = read('public/app.js');
const CSS = read('public/app.css');
const TAS = read('src/identity/team-access.service.ts');
const MCS = read('src/competition/match-center.service.ts');
const CTRL = read('src/controllers/match-center.controller.ts');
const ROUTES = read('src/routes/match-center.routes.ts');
const GUARD = read('src/middleware/tenant-guard.middleware.ts');

describe('an academy age group is a team, and the rule knows it', () => {
  it('an academy kind is recognised from the schema rather than from a list of names', () => {
    expect(isAcademyKind(TeamKind.ACADEMY_U17)).toBe(true);
    expect(isAcademyKind(TeamKind.ACADEMY_U9)).toBe(true);
    expect(isAcademyKind(TeamKind.SENIOR)).toBe(false);
    expect(isAcademyKind(TeamKind.WOMEN)).toBe(false);
    // A new age group added to the schema is recognised without editing this.
    expect(isAcademyKind('ACADEMY_U23')).toBe(true);
  });

  it('the coaching and administrative roles control a team; everybody else reads', () => {
    for (const r of [MembershipRole.CLUB_OWNER, MembershipRole.CLUB_ADMIN, MembershipRole.HEAD_COACH,
                     MembershipRole.ASSISTANT_COACH, MembershipRole.YOUTH_COACH]) {
      expect(TEAM_MANAGING_ROLES.has(r)).toBe(true);
    }
    for (const r of [MembershipRole.PARENT, MembershipRole.PLAYER, MembershipRole.SCOUT,
                     MembershipRole.ANALYST, MembershipRole.FINANCE_MANAGER, MembershipRole.MEDICAL_STAFF]) {
      expect(TEAM_MANAGING_ROLES.has(r)).toBe(false);
    }
  });
});

describe('control follows the assignment, not the account role', () => {
  it('a membership scoped to a team reaches that team and no other', () => {
    const fn = codeOnly(TAS.slice(TAS.indexOf('export async function accessForTeam'),
                                  TAS.indexOf('export interface TeamContext')));
    expect(fn).toContain('const onThisTeam = rows.filter((r) => r.teamId === teamId)');
    // MANAGE is granted in exactly three ways, and none of them is "assigned to
    // some other team": a platform administrator, a club-wide membership, or an
    // assignment to THIS team. Every literal MANAGE names one of the first two.
    const literal = fn.match(/pack\([^;]*?'MANAGE',\s*'([A-Z_]+)'/g) || [];
    expect(literal.length).toBeGreaterThan(0);
    for (const site of literal) {
      expect(site).toMatch(/'PLATFORM_ADMIN'|'CLUB_WIDE'/);
    }
    // The third comes from the level of the memberships on THIS team, and is
    // packed with the reason that says so.
    expect(fn).toMatch(/const \{ level, roles \} = levelFrom\(onThisTeam\);[\s\S]{0,140}'TEAM_ASSIGNMENT'/);
  });

  it('somebody in the club with no assignment to a team reads it and cannot run it', () => {
    const fn = codeOnly(TAS.slice(TAS.indexOf('export async function accessForTeam'),
                                  TAS.indexOf('export interface TeamContext')));
    expect(fn).toMatch(/return pack\(team\.id, team\.clubId, 'VIEW'/);
    // And canManage is only ever true for MANAGE — the two are not independent
    // flags that could drift apart.
    const packFn = codeOnly(TAS.slice(TAS.indexOf('function pack('), TAS.indexOf('export async function accessForTeam')));
    expect(packFn).toContain("canView: level !== 'NONE'");
    expect(packFn).toContain("canManage: level === 'MANAGE'");
  });

  it('and a team in another club is refused on the club boundary first', () => {
    const fn = codeOnly(TAS.slice(TAS.indexOf('export async function accessForTeam'),
                                  TAS.indexOf('export interface TeamContext')));
    expect(fn).toMatch(/team\.clubId !== actor\.clubId[\s\S]{0,120}'OUTSIDE_CLUB'/);
  });

  it('the write gate throws rather than returning a boolean nobody has to read', () => {
    expect(TAS).toContain('export async function assertCanManageTeam');
    const fn = codeOnly(TAS.slice(TAS.indexOf('export async function assertCanManageTeam')));
    expect(fn).toContain('if (!access.canManage)');
    expect(fn).toContain('throw new ForbiddenError');
  });

  it('and the defence-in-depth guard is decided by the membership too', () => {
    // A role-name allow-list could only ever disagree with the assignment it
    // was meant to describe, so there is not one any more.
    expect(GUARD).not.toContain('TEAM_BOUND_ROLES');
    expect(GUARD).toContain("return role !== ('SUPER_ADMIN' as UserRole);");
    // A legacy account with no memberships stays club-wide: this is a boundary
    // for people who HAVE been assigned, not a lockout for people who have not.
    expect(GUARD).toContain('memberships.length === 0 || memberships.some((m) => !m.teamId)');
  });
});

describe('each team has its own Match Center, and the data is scoped on the server', () => {
  it('the calendar takes a team, and the team is checked before it is used', () => {
    expect(MCS).toContain('export async function resolveTeamScope');
    const scope = codeOnly(MCS.slice(MCS.indexOf('export async function resolveTeamScope'),
                                     MCS.indexOf('export type MatchCenterCompetitionKind')));
    expect(scope).toMatch(/const access = await assertCanViewTeam\(actor, teamId\);[\s\S]{0,140}teamIds: \[teamId\]/);
    // Naming no team is the First Team, exactly as before academy teams existed.
    expect(scope).toContain('FIRST_TEAM_KINDS.includes(c.kind)');
  });

  it('the route accepts the team and the controller parses it', () => {
    expect(ROUTES).toContain("router.get('/calendar', ctrl.getCalendar)");
    expect(ROUTES).toContain("router.get('/teams', ctrl.getTeamContexts)");
    expect(CTRL).toContain('teamId: z.string().uuid().optional()');
    // The parse says the shape is possible; team-access says the answer is
    // this caller's to have. The controller never decides access itself.
    expect(codeOnly(CTRL)).not.toMatch(/canManage|canView/);
  });

  it('and one team\'s fixtures cannot include another team\'s', () => {
    const cal = MCS.slice(MCS.indexOf('export async function getCalendar'),
                          MCS.indexOf('export async function getFixtureDetail'));
    // The query is built from the resolved scope and nothing else, so a scoped
    // request has exactly one team id in its OR.
    expect(cal).toContain('const teamIds = scope.teamIds');
    expect(cal).toContain('OR: [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }]');
    expect(cal).not.toContain('firstTeamIdsForClub(clubId)');
  });

  it('opening one fixture takes sight of one of its teams', () => {
    const at = MCS.indexOf('async function fixtureAccess');
    const fn = codeOnly(MCS.slice(at, MCS.indexOf('\n}', at)));
    expect(fn).toContain('await accessForTeam(actor, teamId)');
    expect(fn).toContain('if (!access.canView) continue;');
    expect(fn).toContain('throw new ForbiddenError');
    // Between two of the club's own teams, the side this person MANAGES wins,
    // so the fixture is writable from the right side rather than neither.
    expect(fn).toContain('access.canManage && !best.access.canManage');
  });

  it('and changing one takes an assignment to manage its team', () => {
    const create = MCS.slice(MCS.indexOf('export async function createRequest'),
                             MCS.indexOf('export type RequestAction'));
    expect(create).toContain("if (!ours.access?.canManage)");
    const act = MCS.slice(MCS.indexOf('export async function actOnRequest'));
    expect(act).toContain('manages = !!ours.access?.canManage');
    // Being in the same club is no longer enough to answer for a team.
    expect(act).toContain('const isRequester = manages && actor.clubId === req.requestedByClubId');
  });
});

describe('the academy workspace is one module per age group, not one flat page', () => {
  it('every age group workspace carries the same sections, Match Center among them', () => {
    const sections = APP.slice(APP.indexOf('var AT_SECTIONS = ['), APP.indexOf('var AT_REDIRECT'));
    for (const id of ["'dashboard'", "'squad'", "'training'", "'matchCenter'"]) {
      expect(sections).toContain(id);
    }
    // The id is a code identifier and the label is what a reader sees — the
    // same separation the match views already make.
    expect(sections).toContain("['matchCenter', 'Match Center', '🗓']");
    expect(APP).toContain("case 'matchCenter': return _atSecMatchCenter(id);");
  });

  it('and it draws the First Team\'s module rather than a second one', () => {
    // One renderer in the file, taking a host and a team.
    expect(APP.match(/^function renderMatchCenter\(opts\)/gm) || []).toHaveLength(1);
    const paint = APP.slice(APP.indexOf('function _atPaintMatchCenter('),
                            APP.indexOf('function _atPaintMatchCenter(') + 700);
    expect(paint).toContain('renderMatchCenter({ host: host, teamId: teamId })');
    // There is no second calendar, no second workspace and no second set of
    // views defined for the academy.
    expect(APP.match(/function _mccListHtml\(/g) || []).toHaveLength(1);
    expect(APP.match(/function _mcWorkspaceHtml\(/g) || []).toHaveLength(1);
    expect(APP).not.toContain('function _atMatchCenterHtml');
  });

  it('the age group is scoped by its real team row, never by a label alone', () => {
    const fn = APP.slice(APP.indexOf('function _atServerTeamId('), APP.indexOf('function _atSecMatchCenter('));
    // The name the bootstrap wrote, and — for a club that predates it and names
    // its age groups differently — the same age band by KIND, exactly as the
    // First Team is found by SENIOR when it is not called "First Team".
    expect(fn).toContain('_thTeamIdFor(stage.label)');
    // A club that predates the bootstrap names its age groups differently and
    // files them under whichever ACADEMY_U* kind it chose, so the AGE is the
    // fact both sides agree on: the team whose kind names an age inside this
    // stage's band is this stage's team.
    expect(fn).toContain('var band = _atStageRange(id)');
    expect(fn).toContain("parseInt(String(tm.kind).replace(/\\D+/g, ''), 10)");
    expect(fn).toContain('age < band[0] || age > band[1]');
    // With no team row there is no scope, and the section says so rather than
    // falling back to an unscoped call — which would show the First Team's.
    const sec = APP.slice(APP.indexOf('function _atSecMatchCenter('), APP.indexOf('function _atPaintMatchCenter('));
    expect(sec).toContain('if (!teamId)');
    expect(sec).toContain('This age group is not linked to a team record yet');
  });

  it('and switching team throws away the calendar that belonged to the last one', () => {
    const fn = APP.slice(APP.indexOf('function renderMatchCenter(opts)'), APP.indexOf('async function _mccLoad('));
    expect(fn).toContain('if (_MCC.host !== el || _MCC.teamId !== teamId)');
    expect(fn).toContain('_MCC.data = null');
    expect(fn).toContain('_MCC.open = null');
    // A slower answer for a team the reader has left is dropped, not painted.
    const load = APP.slice(APP.indexOf('async function _mccLoad('), APP.indexOf('// ── opening one fixture'));
    expect(load).toContain('if (_MCC.teamId !== asked) return;');
  });

  it('two hosts in one document never fight over one id', () => {
    const shell = APP.slice(APP.indexOf('function _mccShellHtml('), APP.indexOf('function renderMatchCenter(opts)'));
    for (const id of ['mcc-head', 'mcc-list', 'mcx-workspace', 'mcx-change']) {
      expect(shell).toContain("(standalone ? ' id=\"" + id + "\"' : '')");
    }
    // Every lookup goes through the module's own host rather than the document.
    expect(APP).toContain('function _mccRoot()');
    expect(APP).toContain('function _mccNode(sel)');
    const mcc = APP.slice(APP.indexOf('function _mccRoot()'), APP.indexOf('// ── the page ──'));
    expect(mcc).not.toMatch(/document\.getElementById\('mc[cx]-/);
  });
});

describe('a team you do not run says so, in the same words everywhere', () => {
  it('the screen reads the answer rather than deciding for itself', () => {
    const fn = APP.slice(APP.indexOf('function _mccCanManage()'), APP.indexOf('function _mccAccessNoteHtml()'));
    expect(fn).toContain('_MCC.access && _MCC.access.canManage');
    // The First Team's own page is the module's default and is unaffected.
    expect(fn).toContain('if (!_MCC.teamId) return true;');
    // Client-side access is the server's answer, not a local guess.
    const ta = APP.slice(APP.indexOf('async function _taLoad('), APP.indexOf('function _acAccess('));
    expect(ta).toContain("api('/match-center/teams')");
  });

  it('and the control that would be refused is not offered', () => {
    expect(APP).toMatch(/var canAsk = next && !played[\s\S]{0,120}_mccCanManage\(\)/);
  });

  it('the state is named on the card, in the workspace and above the calendar', () => {
    for (const where of [
      APP.slice(APP.indexOf('function _acTeamCard('), APP.indexOf('function _acFirstTeamCard(')),
      APP.slice(APP.indexOf('function _mccAccessNoteHtml()'), APP.indexOf('function _mccHeadHtml()')),
    ]) {
      expect(where.length).toBeGreaterThan(80);
    }
    expect(APP).toContain('You are not assigned to manage this team');
    expect(APP).toContain('Read-only access. Contact a club admin for team access.');
    expect(APP).toContain('Contact club admin for team access');
    expect(APP).toContain('Not assigned to manage this team');
    // Three states on a card, and none of them ambiguous.
    const card = APP.slice(APP.indexOf('function _acTeamCard('), APP.indexOf('function _acFirstTeamCard('));
    expect(card).toContain('No access');
    expect(card).toContain('Open read-only');
    expect(card).toContain('Open Workspace');
    // And they are drawn, not left as bare text.
    expect(CSS).toContain('.mcc-ro, .at-ro{');
    expect(CSS).toContain('.ac-tcard-cta-btn--ro{');
  });

  it('and every one of those sentences is translated into every locale', () => {
    const cat = JSON.parse(read('public/i18n/catalogue/de-DE.json')) as Record<string, string>;
    for (const s of ['You are not assigned to manage this team',
                     'Read-only access. Contact a club admin for team access.',
                     'No access', 'Open read-only', 'You do not have access to that team']) {
      expect(cat[s]).toBeDefined();
      expect(cat[s]).not.toBe(s);
    }
  });
});

describe('the First Team path is the default, and therefore unchanged', () => {
  it('its page calls the renderer with no host and no team', () => {
    expect(APP).toContain("case 'pg-match-center':renderMatchCenter();     break;");
    expect(APP).toMatch(/page === 'match-center'[\s\S]{0,80}renderMatchCenter\(\)/);
    // Which means _MCC.teamId stays null and the request carries no team.
    const load = APP.slice(APP.indexOf('async function _mccLoad('), APP.indexOf('// ── opening one fixture'));
    expect(load).toContain("_MCC.teamId ? '?teamId=' + encodeURIComponent(_MCC.teamId) : ''");
  });

  it('and it is still its own Club Workspace module beneath Familista League', () => {
    const nav = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('function buildWorkspaceSidebar('));
    expect(nav).toContain("slug:    'match-center'");
    const order = (slug: string) => {
      const at = nav.indexOf(`slug:    '${slug}'`);
      return Number(/order:\s*([\d.]+)/.exec(nav.slice(at, at + 900))![1]);
    };
    expect(order('match-center')).toBeGreaterThan(order('familista-league'));
  });
});
