/**
 * tests/coaches-hierarchy.unit.test.ts
 *
 * Coaches, read by drilling in.
 *
 * The page used to render every club, every team and every staff member at
 * once. With four clubs and ninety people that is a page nobody can navigate,
 * and the fix is structural rather than cosmetic: one tier is loaded at a time,
 * on the server as well as in the browser. A team card cannot carry its staff
 * because the endpoint that serves it does not send them.
 *
 * The other thing asserted here is who may look. A directory is not a market:
 * the market publishes availability across the platform, this says who works
 * where inside clubs the person is actually part of. A club id sent by a client
 * for a club it is not part of is refused, not filtered.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
const SVC = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'staff-market.service.ts'), 'utf8');
const ROUTES = readFileSync(join(__dirname, '..', 'src', 'routes', 'coaches.routes.ts'), 'utf8');

function svcFn(name: string) {
  const from = SVC.indexOf(`export async function ${name}`);
  const next = SVC.indexOf('export async function', from + 10);
  return SVC.slice(from, next < 0 ? undefined : next);
}
function appFn(name: string, until: string) {
  return APP.slice(APP.indexOf(`function ${name}`), APP.indexOf(`function ${until}`));
}

describe('one tier is served at a time', () => {
  it('there is an endpoint per level, not one that returns everything', () => {
    expect(ROUTES).toContain("router.get('/clubs',");
    expect(ROUTES).toContain("router.get('/clubs/:clubId/teams',");
    expect(ROUTES).toContain("router.get('/teams/:teamId/staff',");
    ['coachesClubs', 'coachesClubTeams', 'coachesTeamStaff']
      .forEach((f) => expect(SVC).toContain(`export async function ${f}`));
  });

  it('the clubs level counts staff without sending any', () => {
    const f = svcFn('coachesClubs');
    ['teams', 'staff', 'firstTeamStaff', 'academyStaff', 'onTheMarket', 'contractsEndingSoon', 'vacancies', 'coverage']
      .forEach((k) => expect(f).toContain(k));
    // it returns club rows, never a staff array
    expect(f).not.toMatch(/staff:\s*\[/);
    expect(f).not.toContain('publicUserSelect');
  });

  it('the teams level strips the people off before it answers', () => {
    const f = svcFn('coachesClubTeams');
    expect(f).toContain('const { staff, ...rest } = g as');
    expect(f).toContain('return rest;');
  });

  it('and each read is scoped to one club rather than the platform', () => {
    expect(svcFn('coachesClubTeams')).toContain('coachesDirectory(actor, { clubId })');
    expect(svcFn('coachesTeamStaff')).toContain('coachesDirectory(actor, { clubId: team.clubId })');
    const dir = svcFn('coachesDirectory');
    expect(dir).toContain('const scope = opts.clubId ? { clubId: opts.clubId } : {};');
    expect(dir).toContain('where: { isActive: true, ...scope }');
  });
});

describe('only clubs a person is part of', () => {
  it('the visible set is his own memberships', () => {
    const f = svcFn('authorisedClubIds');
    expect(f).toContain("if (actor.role === 'SUPER_ADMIN') return null;");
    expect(f).toContain('prisma.membership.findMany');
    expect(f).toContain('where: { userId: actor.userId, isActive: true }');
  });

  it('and a club id for a club he is not part of is refused, not filtered', () => {
    expect(SVC).toContain("throw new ForbiddenError('That club is not yours to see')");
    ['coachesClubTeams', 'coachesTeamStaff'].forEach((f) => {
      expect(svcFn(f)).toContain('assertClubVisible');
    });
  });

  it('the clubs list is filtered by that same set', () => {
    expect(svcFn('coachesClubs')).toContain('where: allowed ? { id: { in: allowed } } : {}');
  });

  it('and the fill cannot reach outside it either', () => {
    const f = svcFn('seedDemoStaff');
    expect(f).toContain('const allowed = await authorisedClubIds(actor);');
    expect(f).toContain('await assertClubVisible(actor, opts.clubId);');
    expect(f).toContain('where = { ...where, clubId: { in: allowed } };');
  });
});

describe('the page opens on the clubs and nothing else', () => {
  it('it has three views and one is drawn at a time', () => {
    ['_coClubsViewHtml', '_coClubViewHtml', '_coTeamViewHtml']
      .forEach((f) => expect(APP).toContain(`function ${f}(`));
    const router = appFn('_coHtml', '_coClubsViewHtml');
    expect(router).toContain("if (_CO.level === 'staff') return _coTeamViewHtml();");
    expect(router).toContain("if (_CO.level === 'teams') return _coClubViewHtml();");
    expect(router).toContain('return _coClubsViewHtml();');
  });

  it('entering always lands on the clubs', () => {
    const f = appFn('renderCoachesPage', '_coRepaint');
    expect(f).toContain("_CO.level = 'clubs'");
    expect(f).toContain('_coLoadClubs()');
    expect(f).not.toContain('_coLoadTeam(');
  });

  it('the clubs view draws club cards and no team or staff card', () => {
    const v = appFn('_coClubsViewHtml', '_coClubCardHtml');
    expect(v).toContain('_coClubCardHtml');
    expect(v).not.toContain('_coTeamCardHtml');
    expect(v).not.toContain('_coStaffCardHtml');
  });

  it('the club view draws team cards and no staff card', () => {
    const v = appFn('_coClubViewHtml', '_coTeamCardHtml');
    expect(v).toContain('_coTeamCardHtml');
    expect(v).not.toContain('_coStaffCardHtml');
  });

  it('and only the team view draws people', () => {
    const v = appFn('_coTeamViewHtml', '_coBackHtml');
    expect(v).toContain('_coStaffCardHtml');
    expect(v).toContain('CO_DEPTS.forEach');
    // departments with nobody in them are not drawn at all
    expect(v).toContain('if (inDept.length) groups.push(');
  });
});

describe('going back, and not carrying anything with you', () => {
  it('every level has its way back', () => {
    expect(APP).toContain('function _coBackHtml(label, to)');
    expect(APP).toContain("_coBackHtml('All clubs', 'clubs')");
    expect(APP).toMatch(/_coBackHtml\(_CO\.clubName \|\| 'Teams', 'teams'\)/);
  });

  it('each step loads its own level', () => {
    ['_coLoadClubs', '_coLoadTeams', '_coLoadTeam'].forEach((f) => expect(APP).toContain(`function ${f}(`));
    const wire = APP.slice(APP.indexOf('(function _coWire() {'));
    expect(wire).toContain('_coLoadTeams(_CO.clubId).then(_coRepaint);');
    expect(wire).toContain('_coLoadTeam(_CO.teamId).then(_coRepaint);');
    expect(wire).toContain('_coLoadClubs().then(_coRepaint);');
  });

  it('and drops the filters and the level below on the way', () => {
    const wire = APP.slice(APP.indexOf('(function _coWire() {'));
    // going into a club
    expect(wire).toMatch(/_CO\.level = 'teams'; _CO\.q = ''; _CO\.kind = ''; _CO\.role = '';/);
    expect(wire).toContain('_CO.teamId = null; _CO.teamGroup = null;');
    // going back to the clubs
    expect(wire).toContain("_CO.clubId = null; _CO.clubName = null;");
  });

  it('the reader is put at the top of the new level', () => {
    const wire = APP.slice(APP.indexOf('(function _coWire() {'));
    expect(wire).toContain('var _coScrollTop = function ()');
    expect(wire).toContain('_coScrollTop(); return;');
  });

  it('and reloading reads whichever level is open', () => {
    const f = appFn('_coLoad', '_coRepaint');
    expect(f).toContain("if (_CO.level === 'staff' && _CO.teamId) return _coLoadTeam(_CO.teamId);");
    expect(f).toContain("if (_CO.level === 'teams' && _CO.clubId) return _coLoadTeams(_CO.clubId);");
    expect(f).toContain('return _coLoadClubs();');
  });
});

describe('three tiers, three shapes', () => {
  it('each has its own card and its own styling', () => {
    ['_coClubCardHtml', '_coTeamCardHtml', '_coStaffCardHtml']
      .forEach((f) => expect(APP).toContain(`function ${f}(`));
    ['.co-cc{', '.co-tc{', '.co-sc{'].forEach((c) => expect(CSS).toContain(c));
    // and they are not the same size
    expect(CSS).toContain('.co-clubs{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,268px),1fr))');
    expect(CSS).toContain('.co-teamcards{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))');
    expect(CSS).toContain('.co-people{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,262px),1fr))');
  });

  // The desk is the width of the desk. auto-fill leaves empty tracks standing
  // when there are fewer clubs than the grid could hold, which is what put four
  // clubs in four narrow columns with half the screen unused beside them.
  it('the grids fill the workspace rather than leaving tracks standing', () => {
    expect(CSS).toContain('.co-pane{ width:100%; max-width:none; }');
    ['.co-clubs{', '.co-teamcards{', '.co-people{'].forEach((sel) => {
      const rule = CSS.slice(CSS.indexOf(sel));
      expect(rule.slice(0, rule.indexOf('}'))).toContain('auto-fit');
    });
  });

  it('the club card says what a club is chosen on', () => {
    const c = appFn('_coClubCardHtml', '_coClubViewHtml');
    ['Teams', 'Technical staff', 'First team', 'Academy'].forEach((l) => expect(c).toContain(l));
    expect(c).toContain('on the market');
    expect(c).toContain('contract ending');
    expect(c).toContain('vacant role');
    expect(c).toContain('% staffed');
  });

  it('the staff card stays compact — no salary on the front of it', () => {
    const c = appFn('_coStaffCardHtml', '_coProfileHtml');
    expect(c).toContain('CO_STATUS[st]');
    expect(c).toContain('m.highestLicence');
    expect(c).not.toContain('expectedSalary');
    expect(c).not.toContain('releaseClause');
    expect(c).not.toContain('_stMoney');
  });

  it('and clicking one still opens the canonical record', () => {
    expect(appFn('_coStaffCardHtml', '_coProfileHtml')).toContain('data-st-open=');
    const wire = APP.slice(APP.indexOf('(function _coWire() {'));
    expect(wire).toContain('_stLoadOne(id)');
    expect(APP).toContain('var CO_PTABS');
  });
});

describe('the sample fill covers every club it may see', () => {
  it('there is an all-clubs action, distinct from the one-club one', () => {
    expect(APP).toContain('data-co-seed-all');
    expect(APP).toContain('data-co-seed');
    expect(APP).toMatch(/_coApi\('POST', '\/demo-staff\?scope=all'\)/);
    expect(APP).toMatch(/_coApi\('POST', '\/demo-staff\?scope=club'\)/);
  });

  it('the sample staff vary rather than being cloned', () => {
    const f = svcFn('seedDemoStaff');
    ['DEMO_LANGS', 'DEMO_FORMATIONS', 'DEMO_PHILOSOPHY', 'DEMO_STYLES', 'DEMO_SPECIALITIES']
      .forEach((l) => expect(f).toContain(l));
    expect(f).toContain('tacticalKnowledge:');
    expect(f).toContain('releaseClause:');
  });

  it('and it lays out the market scenarios on purpose', () => {
    const f = svcFn('seedDemoStaff');
    expect(f).toContain('const endingSoon =');
    expect(f).toContain('const openToOffers =');
    expect(f).toContain('const activelyLooking =');
    expect(f).toContain("const intent = activelyLooking ? 'ACTIVELY_LOOKING'");
    // a contract inside the ending-soon window for those cases, a long one otherwise
    expect(f).toMatch(/endingSoon\s*\n?\s*\?\s*new Date\(Date\.now\(\) \+ \(30/);
  });

  it('including a few people with no club at all', () => {
    const f = svcFn('seedDemoStaff');
    expect(f).toContain('let freeAgents = 0;');
    expect(f).toContain("availability: 'FREE_AGENT'");
    expect(f).toContain('// tenancy only — no membership');
  });

  it('and it is still idempotent and still skips staffed teams', () => {
    const f = svcFn('seedDemoStaff');
    expect(f).toContain('if (taken.has(team.id)) continue;');
    expect(f).toContain('if (exists) continue;');
    expect(f).toContain('isDemo: true');
  });
});

describe('the club card says which job is missing', () => {
  it('coverage is counted per role, not as one percentage', () => {
    const f = svcFn('coachesClubs');
    expect(f).toContain('roleCoverage');
    ['Head coaches', 'Assistants', 'GK coaches', 'Performance', 'Analysis', 'Medical']
      .forEach((l) => expect(f).toContain(`'${l}'`));
  });

  it('and a team is only counted for a role its own structure runs', () => {
    const f = svcFn('coachesClubs');
    expect(f).toContain('const expected = clubTeams.filter((t) =>');
    expect(f).toContain('demoRolesFor({ kind: t.kind, name: t.name, ageMax: t.ageMax }).some((r) => rs.includes(r))');
    // a role no team runs is not shown as 0/0
    expect(f).toContain('.filter((r) => r.of > 0)');
  });

  it('the card draws those rows and an explicit way in', () => {
    const c = appFn('_coClubCardHtml', '_coClubViewHtml');
    expect(c).toContain('c.roleCoverage');
    expect(c).toContain('Open technical staff');
    expect(CSS).toContain('.co-cc-role{');
    expect(CSS).toContain('.co-cc-go{');
  });

  it('and the team card has its own way in', () => {
    const c = appFn('_coTeamCardHtml', '_coTeamViewHtml');
    expect(c).toContain('Open staff');
    expect(CSS).toContain('.co-tc-go{');
  });
});

describe('employment is not a market listing', () => {
  it('"available" is a status test, never "has a club"', () => {
    const d = svcFn('discover');
    expect(d).toContain("out = out.filter((r) => isAvailable(r.employmentStatus as EmploymentStatus))");
    // and EMPLOYED is not in that set
    expect(SVC).toContain("const AVAILABLE_STATUSES: EmploymentStatus[] =\n  ['FREE_AGENT', 'ACTIVELY_LOOKING', 'OPEN_TO_OFFERS', 'CONTRACT_ENDING_SOON'];");
  });

  it('so the sample fill leaves most of its people off the market', () => {
    const f = svcFn('seedDemoStaff');
    // the default intent is not-looking; the other two are the exceptions
    expect(f).toContain("const intent = activelyLooking ? 'ACTIVELY_LOOKING' : (openToOffers ? 'OPEN_TO_OFFERS' : 'NOT_LOOKING');");
    expect(f).toContain("availability: 'EMPLOYED'");
  });
});
