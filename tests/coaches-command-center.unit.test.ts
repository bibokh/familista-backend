/**
 * tests/coaches-command-center.unit.test.ts
 *
 * The Coaches module as a technical staff command centre.
 *
 * Three things carry the weight here.
 *
 * The demo fill exists because a platform being built has teams with nobody in
 * them, and an empty directory shows nothing. It must fill only teams that have
 * nobody — never top a team up, never write over a real record — and everything
 * it makes must be removable by the one flag that marks it.
 *
 * The lifecycle — add, move, release — must keep one person. A move updates the
 * membership he already has and closes the period he is leaving; a release
 * closes both and leaves the person exactly where he is, which is what makes
 * him a free agent rather than somebody deleted.
 *
 * And the market status on a staff card is the same field the Coach Market
 * reads. Not a copy of it, not a second one derived here: the same function,
 * so a coach cannot be Open to Offers on one screen and Not Looking on another.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { demoRolesFor, TECHNICAL_ROLES } from '../src/staff-market/staff-market.service';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
const SVC = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'staff-market.service.ts'), 'utf8');
const ROUTES = readFileSync(join(__dirname, '..', 'src', 'routes', 'coaches.routes.ts'), 'utf8');
const SCHEMA = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

function svcFn(name: string) {
  const from = SVC.indexOf(`export async function ${name}`);
  const next = SVC.indexOf('export async function', from + 10);
  return SVC.slice(from, next < 0 ? undefined : next);
}

describe('the demo fill sizes a staff to the team it is for', () => {
  it('a first team runs a full technical department', () => {
    const roles = demoRolesFor({ kind: 'SENIOR', name: 'First Team', ageMax: null });
    expect(roles).toContain('HEAD_COACH');
    expect(roles).toContain('GOALKEEPING_COACH');
    expect(roles).toContain('ANALYST');
    expect(roles).toContain('PHYSIO');
    expect(roles.length).toBeGreaterThanOrEqual(10);
  });

  it('an older academy side runs a smaller one', () => {
    const roles = demoRolesFor({ kind: 'ACADEMY_U19', name: 'U17–U19', ageMax: 19 });
    expect(roles).toContain('HEAD_COACH');
    expect(roles.length).toBeLessThan(demoRolesFor({ kind: 'SENIOR', name: 'First Team', ageMax: null }).length);
  });

  it('and the youngest age groups get two or three people, not eleven', () => {
    const young = demoRolesFor({ kind: 'ACADEMY_U11', name: 'U10–U11', ageMax: 11 });
    const mid = demoRolesFor({ kind: 'ACADEMY_U15', name: 'U14–U16', ageMax: 15 });
    expect(young.length).toBeLessThanOrEqual(3);
    expect(young.length).toBeLessThan(mid.length);
    // no age group is forced to the same size as another
    expect(new Set([
      demoRolesFor({ kind: 'SENIOR', name: 'First Team', ageMax: null }).length,
      demoRolesFor({ kind: 'ACADEMY_U19', name: 'U19', ageMax: 19 }).length,
      young.length,
    ]).size).toBe(3);
  });

  it('every role it hands out is one the platform already has', () => {
    [null, 19, 15, 11].forEach((age) => {
      demoRolesFor({ kind: age == null ? 'SENIOR' : 'ACADEMY', name: 'T', ageMax: age })
        .forEach((r) => expect(TECHNICAL_ROLES).toContain(r));
    });
  });
});

describe('the fill never touches a real record', () => {
  it('it skips any team that already has somebody', () => {
    const f = svcFn('seedDemoStaff');
    expect(f).toContain('const taken = new Set(');
    expect(f).toContain('if (taken.has(team.id)) continue;');
  });

  it('everything it creates is marked, and nothing else is', () => {
    expect(SCHEMA).toMatch(/isDemo\s+Boolean\s+@default\(false\)/);
    expect(svcFn('seedDemoStaff')).toContain('isDemo: true');
  });

  it('and removing the samples is that one flag, nothing more', () => {
    const f = svcFn('removeDemoStaff');
    expect(f).toContain('where: { isDemo: true }');
    expect(f).toContain('prisma.$transaction');
    // it deletes only the ids that flag returned
    expect(f).toContain('where: { userId: { in: ids } }');
  });

  it('it reads the teams that exist rather than a number of them', () => {
    const f = svcFn('seedDemoStaff');
    expect(f).toContain('prisma.team.findMany');
    expect(f).toMatch(/let where: Prisma\.TeamWhereInput = \{ isActive: true \}/);
    expect(f).not.toMatch(/Math\.random/);
  });

  it('and it is never automatic — a person asks for it', () => {
    expect(ROUTES).toContain("router.post('/demo-staff',   staffGuard, ctrl.seedDemo);");
    expect(ROUTES).toContain("router.delete('/demo-staff', staffGuard, ctrl.clearDemo);");
    expect(APP).toContain('data-co-seed');
    expect(APP).toContain('data-co-unseed');
  });
});

describe('the lifecycle keeps one person', () => {
  it('a move updates the membership he has rather than making another', () => {
    const f = svcFn('moveStaffMember');
    expect(f).toContain('tx.membership.update');
    expect(f).not.toContain('user.create');
    // and the period he is leaving is closed, so the move enters his history
    expect(f).toContain('data: { isActive: false, endedAt: new Date() }');
    expect(f).toContain('tx.staffEngagement.create');
  });

  it('a move into a period he already held reuses that row', () => {
    const f = svcFn('moveStaffMember');
    expect(f).toContain('const clash = await tx.membership.findFirst');
  });

  it('a release closes the employment and leaves the person standing', () => {
    const f = svcFn('releaseStaffMember');
    expect(f).toContain('data: { isActive: false, leftAt: new Date() }');
    expect(f).toContain("data: { availability: 'FREE_AGENT' }");
    expect(f).not.toContain('user.delete');
    expect(f).not.toContain('staffProfile.delete');
  });

  it('adding somebody creates one User, one profile and one membership', () => {
    const f = svcFn('addStaffMember');
    expect(f).toContain('tx.user.create');
    expect(f).toContain('staffProfile: {');
    expect(f).toContain('tx.membership.create');
    expect(f).toContain("throw new ConflictError('Somebody with that email is already on the platform')");
  });

  it('and no club can put somebody into another club\'s team', () => {
    const add = svcFn('addStaffMember');
    const move = svcFn('moveStaffMember');
    [add, move].forEach((f) => expect(f).toContain("throw new ForbiddenError('That team is not ours')"));
  });

  it('only the employing club may change any of it', () => {
    expect(SVC).toContain("throw new ForbiddenError('Only the employing club may change this')");
    ['/staff', '/move', '/release', '/career', '/achievements'].forEach((r) => expect(ROUTES).toContain(r));
    expect(ROUTES).toContain('staffGuard');
  });

  it('and the current period cannot be deleted as though it were history', () => {
    expect(svcFn('deleteCareerEntry'))
      .toContain("throw new ConflictError('The current period cannot be deleted — release him instead')");
  });
});

describe('one market status, shared with the market', () => {
  it('the directory derives it from the same function the market does', () => {
    const f = svcFn('coachesDirectory');
    expect(f).toContain('employmentStatus: employmentStatus({');
    expect(f).not.toMatch(/function .*coachEmploymentStatus/);
  });

  it('the card carries it, with what a move would take', () => {
    const card = APP.slice(APP.indexOf('function _coStaffCardHtml(m)'), APP.indexOf('function _coProfileHtml()'));
    expect(card).toContain('CO_STATUS[st]');
    expect(card).toContain('m.contractEndsAt');
    expect(card).toContain('m.highestLicence');
    // the detail stays off the front of the card, in the record behind it
    const svc = SVC.slice(SVC.indexOf('export async function coachesDirectory'));
    ['releaseClause', 'compensationFee', 'expectedSalary', 'availabilityDate']
      .forEach((k) => expect(svc).toContain(k));
  });

  it('and says it in the words a club uses about its own staff', () => {
    expect(APP).toMatch(/EMPLOYED: 'Not looking'/);
    ['Open to offers', 'Actively looking', 'Contract ending soon', 'Free agent']
      .forEach((l) => expect(APP).toContain(`'${l}'`));
  });

  it('editing it writes to the canonical profile the market reads', () => {
    expect(APP).toContain('function _coMarketPanel(d)');
    ['availability', 'careerIntent', 'wageExpectation', 'releaseClause', 'compensationFee', 'availableFrom']
      .forEach((k) => expect(APP).toContain(`'${k}'`));
    // through the market's own endpoint — there is no second one
    expect(APP).toMatch(/_stApi\('PATCH', '\/staff\//);
  });

  it('and the figures it edits exist on the one record', () => {
    expect(SCHEMA).toMatch(/model StaffProfile \{[\s\S]*?releaseClause/);
    expect(SCHEMA).toMatch(/model StaffProfile \{[\s\S]*?compensationFee/);
  });
});

describe('the command centre reads before it opens', () => {
  it('a team says who leads it and what state it is in', () => {
    const f = svcFn('coachesDirectory');
    ['headCoach', 'activeContracts', 'contractsEndingSoon', 'onTheMarket', 'completeness', 'health']
      .forEach((k) => expect(f).toContain(k));
  });

  it('completeness is measured against the structure that kind of team runs', () => {
    expect(svcFn('coachesDirectory')).toContain("demoRolesFor({ kind, name: '', ageMax })");
  });

  it('the page draws that, not a wall of cards', () => {
    expect(APP).toContain('var CO_HEALTH');
    expect(APP).toContain('function _coTeamCardHtml(g)');
    expect(CSS).toContain('.co-tc-mini{');
    expect(CSS).toContain('.co-tc-cov{');
    expect(CSS).toContain('.co-tc-lead{');
  });

  // A team card says which seat on the bench is taken, post by post, from
  // counts the server derived — it still carries nobody's name.
  it('the team card carries the unit line-up, post by post', () => {
    const f = svcFn('coachesDirectory');
    expect(f).toContain('const roleStrip = STAFF_POSTS');
    expect(f).toContain('.filter(([, , roles]) => roles.some((r) => runs.includes(r)))');
    const card = APP.slice(APP.indexOf('function _coTeamCardHtml('), APP.indexOf('function _coTeamViewHtml('));
    expect(card).toContain('g.roleStrip');
    expect(CSS).toContain('.co-unit{');
    expect(CSS).toContain('.co-post{');
    // and the posts are counts, never people
    expect(f).not.toContain('roleStrip: staff');
  });

  it('and staff appear only once a team is opened — never before', () => {
    // the team card carries no staff at all; the people are a separate read
    const card = APP.slice(APP.indexOf('function _coTeamCardHtml(g)'), APP.indexOf('function _coTeamViewHtml()'));
    expect(card).not.toContain('_coStaffCardHtml');
    // it reads the count, never the people (g.staffCount is not g.staff)
    expect(card).not.toMatch(/g\.staff[.[]/);
    expect(card).toContain('g.staffCount');
    expect(SVC).toContain('export async function coachesTeamStaff');
    // and the level-2 read strips them off the server side too
    expect(SVC).toContain('const { staff, ...rest } = g as');
  });
});

describe('the profile edits every section it shows', () => {
  it('has all eleven of them', () => {
    ['overview', 'personal', 'career', 'qualifications', 'tactics', 'experience',
     'achievements', 'contract', 'market', 'intent', 'notes']
      .forEach((t) => expect(APP).toContain(`['${t}', '`));
  });

  it('a field is text or an input depending on the mode, in one place', () => {
    expect(APP).toContain('function _coF(label, key, value, opts)');
    expect(APP).toContain("if (!_CO.editing || !key) return");
  });

  it('career periods and honours are rows, added and removed as rows', () => {
    expect(APP).toContain('data-co-carsave');
    expect(APP).toContain('data-co-cardel');
    expect(APP).toContain('data-co-trsave');
    expect(ROUTES).toMatch(/router\.put\('\/staff\/:staffUserId\/career'/);
    expect(ROUTES).toMatch(/router\.delete\('\/staff\/:staffUserId\/career\/:entryId'/);
    expect(ROUTES).toMatch(/router\.put\('\/staff\/:staffUserId\/achievements'/);
  });

  it('and adding, moving and releasing are all reachable from it', () => {
    ['data-co-addsave', 'data-co-movesave', 'data-co-release'].forEach((a) => expect(APP).toContain(a));
    expect(APP).toContain('function _coAddHtml()');
    expect(APP).toContain('function _coMoveHtml()');
  });
});
