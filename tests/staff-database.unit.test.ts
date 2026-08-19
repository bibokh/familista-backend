/**
 * tests/staff-database.unit.test.ts
 *
 * The Coach Market as a staff database.
 *
 * Two things decide whether this is a database or a form with a list under it.
 *
 * The first is that there is one canonical person. All Staff is not a table
 * somebody fills in — it is every technical membership the platform already
 * holds, read directly, so a coach a club employs is on the market the moment
 * the club employs him and nothing is ever entered twice. A free agent is the
 * same person shape with no membership, not a second kind of record.
 *
 * The second is that employment status is derived once. Six statuses, one
 * function, and every surface that shows one — card, filter, tab, tile — calls
 * it. Two derivations of the same status is how a badge and the board it sits
 * on come to disagree.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { employmentStatus, isAvailable, TECHNICAL_ROLES } from '../src/staff-market/staff-market.service';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const SVC = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'staff-market.service.ts'), 'utf8');
const ROUTES = readFileSync(join(__dirname, '..', 'src', 'routes', 'staff-market.routes.ts'), 'utf8');
const SCHEMA = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

const soon = (days: number) => new Date(Date.now() + days * 86400000);

describe('employment status is derived once, from two facts', () => {
  it('nobody holding him makes him a free agent, whatever he says he wants', () => {
    expect(employmentStatus({ hasClub: false })).toBe('FREE_AGENT');
    expect(employmentStatus({ hasClub: false, careerIntent: 'NOT_LOOKING' })).toBe('FREE_AGENT');
  });

  it('unavailable outranks everything — he is not on the market at all', () => {
    expect(employmentStatus({ hasClub: false, availability: 'UNAVAILABLE' })).toBe('UNAVAILABLE');
    expect(employmentStatus({
      hasClub: true, availability: 'UNAVAILABLE', careerIntent: 'ACTIVELY_LOOKING',
    })).toBe('UNAVAILABLE');
  });

  it('a coach who says he is looking is looking, contract or not', () => {
    expect(employmentStatus({
      hasClub: true, careerIntent: 'ACTIVELY_LOOKING', contractEndsAt: soon(900),
    })).toBe('ACTIVELY_LOOKING');
  });

  it('a contract inside six months is ending soon, and says so before "open to offers"', () => {
    expect(employmentStatus({
      hasClub: true, careerIntent: 'OPEN_TO_OFFERS', contractEndsAt: soon(60),
    })).toBe('CONTRACT_ENDING_SOON');
  });

  it('a contract that already expired is not "ending soon" — it has ended', () => {
    expect(employmentStatus({ hasClub: true, contractEndsAt: soon(-30) })).toBe('EMPLOYED');
  });

  it('a long contract and nothing said is simply employed', () => {
    expect(employmentStatus({ hasClub: true, contractEndsAt: soon(900) })).toBe('EMPLOYED');
    expect(employmentStatus({ hasClub: true })).toBe('EMPLOYED');
  });

  it('and "Available" is everybody a club could move for — not everybody employed', () => {
    expect(isAvailable('FREE_AGENT')).toBe(true);
    expect(isAvailable('ACTIVELY_LOOKING')).toBe(true);
    expect(isAvailable('OPEN_TO_OFFERS')).toBe(true);
    expect(isAvailable('CONTRACT_ENDING_SOON')).toBe(true);
    expect(isAvailable('EMPLOYED')).toBe(false);
    expect(isAvailable('UNAVAILABLE')).toBe(false);
  });

  it('the card, the filter and the tile all read that one function', () => {
    // the row carries the derived value; nothing recomputes it downstream
    expect(SVC).toMatch(/employmentStatus: employmentStatus\(\{/);
    expect(SVC).toContain("out = out.filter((r) => r.employmentStatus === q.status)");
    expect(SVC).toContain("isAvailable(r.employmentStatus as EmploymentStatus)");
    // and the client only ever displays it
    expect(APP).toContain('var ST_STATUS_LABEL');
    expect(APP).not.toMatch(/function .*computeEmploymentStatus/);
  });
});

describe('All Staff is the platform, not a table somebody fills in', () => {
  it('it reads the memberships that exist, across every club', () => {
    const d = SVC.slice(SVC.indexOf('export async function discover'));
    expect(d).toContain('prisma.membership.findMany');
    expect(d).toMatch(/where: \{ isActive: true, role: \{ in: TECHNICAL_ROLES \}/);
    // no club is named and no club list is held
    [/BSC/i, /Marzahn/i, /FC Familista/i].forEach((re) => expect(SVC).not.toMatch(re));
  });

  it('somebody with two technical memberships is still one row', () => {
    const d = SVC.slice(SVC.indexOf('export async function discover'));
    expect(d).toContain('if (seen.has(userId)) return;');
    expect(d).toContain('seen.add(userId);');
  });

  it('a free agent is the same person shape with no membership', () => {
    const d = SVC.slice(SVC.indexOf('export async function discover'));
    expect(d).toContain('orphanProfiles.forEach((p) => build(p.userId, p.user, null, null));');
  });

  it('every board tab is one read of that same board', () => {
    const d = SVC.slice(SVC.indexOf('export async function discover'));
    ['available', 'employed', 'free-agents', 'shortlisted'].forEach((t) => expect(d).toContain(`'${t}'`));
    expect(APP).toContain('var ST_BOARD_TABS');
    expect(APP).toMatch(/q\.push\('tab='/);
  });

  it('and the tiles count the board itself rather than a second population', () => {
    const m = SVC.slice(SVC.indexOf('export async function marketSummary'));
    expect(m).toContain('discoverAllRows(actor)');
    expect(m).toContain('isAvailable(r.employmentStatus as EmploymentStatus)');
  });
});

describe('one canonical profile per person', () => {
  it('an external candidate is a User with a profile, and no membership', () => {
    const from = SVC.indexOf('export async function addExternalStaff');
    const f = SVC.slice(from, SVC.indexOf('export async function', from + 10));
    expect(f).toContain('prisma.user.create');
    expect(f).toContain('staffProfile: {');
    expect(f).not.toContain('membership.create');
    // a club connection here is tenancy, not employment — and it is commented as such
    expect(f).toContain('club: { connect: { id: actor.clubId } }');
    expect(f).toMatch(/NOT employment/);
  });

  it('and the same person is never added twice', () => {
    const from = SVC.indexOf('export async function addExternalStaff');
    const f = SVC.slice(from, SVC.indexOf('export async function', from + 10));
    expect(f).toContain("throw new ConflictError('Somebody with that email is already on the platform')");
  });

  it('a move still closes the old period rather than making a new person', () => {
    const from = SVC.indexOf('export async function completeMove');
    const move = SVC.slice(from, SVC.indexOf('export async function', from + 10));
    expect(move).toContain('data: { isActive: false, leftAt: new Date() }');
    expect(move).not.toMatch(/user\.create/);
  });
});

describe('the roles the database covers', () => {
  it('holds all twelve, and they are the platform\'s own membership roles', () => {
    ['HEAD_COACH', 'ASSISTANT_COACH', 'GOALKEEPING_COACH', 'FITNESS_COACH',
     'TECHNICAL_COACH', 'TACTICAL_COACH', 'YOUTH_COACH', 'PERFORMANCE_COACH',
     'ANALYST', 'MEDICAL_STAFF', 'PHYSIO', 'SCOUT'].forEach((r) => {
      expect(TECHNICAL_ROLES).toContain(r);
      expect(APP).toContain(`'${r}'`);
    });
    expect(TECHNICAL_ROLES).toHaveLength(12);
  });
});

describe('the record the profile shows', () => {
  it('the tactical profile is its own set of fields, not prose in a note', () => {
    ['attackingApproach', 'defensiveApproach', 'transitionApproach', 'developmentStyle']
      .forEach((f) => expect(SCHEMA).toContain(f));
    expect(SVC).toContain('approach: {');
    expect(APP).toContain('Attacking approach');
    expect(APP).toContain('Transition philosophy');
  });

  it('senior and academy experience are kept apart', () => {
    expect(SCHEMA).toContain('seniorYears');
    expect(SCHEMA).toContain('academyYears');
    expect(SCHEMA).toContain('youthAgeGroups');
    expect(APP).toContain('function _stExperiencePanel(d)');
  });

  it('qualifications are more than a licence', () => {
    expect(SCHEMA).toContain('certifications');
    expect(SCHEMA).toContain('education');
    expect(APP).toContain('function _stQualificationsPanel(d)');
  });

  it('career intent is his, and separate from what his club allows', () => {
    expect(SCHEMA).toContain('enum StaffCareerIntent');
    ['preferredRoles', 'preferredCountries', 'preferredLeagues', 'preferredClubLevel', 'availableFrom']
      .forEach((f) => expect(SCHEMA).toContain(f));
    expect(APP).toContain('function _stIntentPanel(d)');
  });

  it('the contract says everything a recruiter asks about it', () => {
    expect(SCHEMA).toMatch(/model StaffEngagement \{[\s\S]*?releaseClause/);
    expect(SCHEMA).toMatch(/model StaffEngagement \{[\s\S]*?renewalStatus/);
    // duration is counted from the two dates rather than stored beside them
    expect(SVC).toContain('durationMonths: current.contractEndsAt');
  });

  it('and a value the platform does not hold is said, never filled in', () => {
    expect(APP).toContain('Not recorded');
    expect(SVC).not.toMatch(/Math\.random/);
  });
});

describe('what a club can do about somebody', () => {
  it('every action in the profile is wired to something', () => {
    ['data-st-short', 'data-st-cmp', 'data-st-approach', 'data-st-club',
     'data-st-ptab="career"', 'data-st-ptab="notes"'].forEach((a) => expect(APP).toContain(a));
  });

  it('an offer carries its full terms', () => {
    ['startDate', 'bonuses', 'releaseClause'].forEach((f) => {
      expect(SCHEMA).toMatch(new RegExp(`model StaffApproach \\{[\\s\\S]*?${f}`));
      expect(SVC).toContain(f);
    });
    expect(APP).toContain('data-st-a="bonuses"');
    expect(APP).toContain('data-st-a="startDate"');
  });

  it('and moves through the states an offer really has', () => {
    ['DRAFT', 'SENT', 'VIEWED', 'NEGOTIATING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']
      .forEach((st) => expect(SCHEMA).toMatch(new RegExp(`enum StaffApproachStatus \\{[\\s\\S]*?${st}`)));
    // the state written before these were named in full still reads as open
    expect(SVC).toContain("const OPEN_APPROACH: StaffApproachStatus[] = ['SUBMITTED', 'SENT', 'VIEWED', 'NEGOTIATING']");
    expect(APP).toContain('var ST_OFFER_LABEL');
  });

  it('only the club being approached can mark one seen', () => {
    const f = SVC.slice(SVC.indexOf('export async function markApproachViewed'));
    expect(f).toContain("throw new ForbiddenError('That approach is not yours')");
    // and it never moves backwards out of a state past SENT
    expect(f).toContain("if (!['SUBMITTED', 'SENT'].includes(a.status)) return");
  });

  it('a club note is the club\'s own and keyed by the session\'s club', () => {
    const f = SVC.slice(SVC.indexOf('export async function saveClubNote'));
    expect(f).toContain('clubId: actor.clubId');
    expect(f).not.toMatch(/dto\.clubId|body\.clubId/);
    expect(ROUTES).toMatch(/router\.put\('\/notes\/:staffUserId',\s*recruitGuard/);
    expect(APP).not.toMatch(/localStorage[\s\S]{0,40}note/i);
  });
});

describe('nothing that was there is taken away', () => {
  it('the route and the page still exist, and the market is its own module', () => {
    expect(APP).toContain("slug:    'coach-market'");
    expect(APP).toContain('function renderCoachMarketPage()');
    expect(APP).not.toContain("if (_TF.tab === 'staff') return _stHtml();");
    expect(APP).toContain("if (!t.closest('#pg-transfers') && !t.closest('#pg-coach-market')) return;");
  });

  it('needs, activity, compare and the shortlist survive the redesign', () => {
    ['function _stNeedsHtml()', 'function _stPipelineHtml()', 'function _stTimelineHtml()',
     'function _stCompareHtml()', 'function _stLoadShortlist()'].forEach((f) => expect(APP).toContain(f));
    ['/needs', '/activity', '/compare', '/shortlist'].forEach((r) => expect(ROUTES).toContain(r));
  });

  it('and every other workspace page is still registered', () => {
    ['squad', 'training', 'academy', 'video-intelligence', 'transfers', 'coach-market', 'coaches']
      .forEach((p) => expect(APP).toContain(`'${p}': 1`));
  });
});
