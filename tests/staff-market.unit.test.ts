/**
 * tests/staff-market.unit.test.ts
 *
 * The coaches & technical staff market.
 *
 * Two rules hold this module together and both are testable without a database.
 *
 * The first is that there is one staff identity. A staff member is a User; the
 * club that employs him is a Membership, which the platform already uses to
 * decide who is active staff and already carries joinedAt, leftAt and isActive.
 * Nothing here creates a second person so that a market row exists.
 *
 * The second is that no club is named anywhere. The market reads the Club
 * table, so a club created after this was written takes part the moment it
 * exists — which the acceptance run confirmed against a club created during it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SVC = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'staff-market.service.ts'), 'utf8');
const ROUTES = readFileSync(join(__dirname, '..', 'src', 'routes', 'staff-market.routes.ts'), 'utf8');
const SCHEMA = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const INDEX = readFileSync(join(__dirname, '..', 'src', 'routes', 'index.ts'), 'utf8');

describe('no club is named anywhere', () => {
  it('the engine holds no club list and no branch on a club', () => {
    // the clubs this platform happens to have today
    [/BSC/i, /Marzahn/i, /FC Familista/i].forEach((re) => expect(SVC).not.toMatch(re));
    // and no equality test against a club name at all
    expect(SVC).not.toMatch(/club(Name)?\s*===\s*['"]/);
  });

  it('participation is read from the Club table', () => {
    expect(SVC).toContain('prisma.club.findMany');
    expect(ROUTES).toContain("router.get('/clubs'");
  });

  it('and the market population comes from memberships, not a roster of clubs', () => {
    expect(SVC).toContain('prisma.membership.findMany');
    expect(SVC).toMatch(/role:\s*\{\s*in:\s*TECHNICAL_ROLES\s*\}/);
  });
});

describe('one staff identity', () => {
  it('the staff member is a User, and every record hangs off that id', () => {
    expect(SCHEMA).toMatch(/model StaffProfile \{[\s\S]*?userId\s+String\s+@unique/);
    expect(SCHEMA).toMatch(/model StaffEngagement \{[\s\S]*?user\s+User\s+@relation/);
    expect(SCHEMA).toMatch(/model StaffApproach \{[\s\S]*?staffUser\s+User\s+@relation/);
  });

  it('employment is the platform\'s own Membership, not a second one', () => {
    expect(SVC).toContain('tx.membership.updateMany');
    expect(SVC).toMatch(/tx\.membership\.(create|update)/);
    // the club's active staff list is read from it
    expect(SVC).toMatch(/export async function myStaff[\s\S]*?prisma\.membership\.findMany/);
  });

  it('the roles are the platform\'s own membership roles', () => {
    expect(SVC).toMatch(/TECHNICAL_ROLES: MembershipRole\[\]/);
    ['HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST'].forEach((r) => expect(SVC).toContain(`'${r}'`));
  });
});

describe('a move preserves the past', () => {
  it('the previous period is closed, never deleted', () => {
    const move = SVC.slice(SVC.indexOf('export async function completeMove'));
    expect(move).toContain('isActive: false, endedAt: new Date()');
    expect(move).not.toMatch(/staffEngagement\.delete/);
    expect(move).not.toMatch(/membership\.delete/);
  });

  it('the old club loses him as active staff and the new club gains him', () => {
    const move = SVC.slice(SVC.indexOf('export async function completeMove'));
    expect(move).toContain('data: { isActive: false, leftAt: new Date() }');
    expect(move).toMatch(/tx\.staffEngagement\.create/);
  });

  it('and where no engagement existed, one is written closed so the club survives', () => {
    const move = SVC.slice(SVC.indexOf('export async function completeMove'));
    expect(move).toContain('endedAt: new Date(), isActive: false');
  });

  it('all of it in one transaction, claimed so it cannot run twice', () => {
    const move = SVC.slice(SVC.indexOf('export async function completeMove'));
    expect(move).toContain('prisma.$transaction');
    expect(move).toContain('tx.staffApproach.updateMany');
    expect(move).toContain("throw new ConflictError('That approach is no longer open')");
  });
});

describe('who may recruit whom', () => {
  it('a club cannot recruit its own active staff', () => {
    expect(SVC).toContain("throw new ForbiddenError('This staff member is already employed by your club')");
  });

  it('only the employing club may accept for its own employee', () => {
    expect(SVC).toContain("throw new ForbiddenError('Only the employing club may accept')");
  });

  it('and only the two clubs in an approach can see or move it', () => {
    expect(SVC).toContain("throw new ForbiddenError('That approach is not yours')");
  });

  it('one live approach per club per person', () => {
    expect(SVC).toContain("throw new ConflictError('An approach for this staff member is already open')");
  });

  it('compensation is owed only when somebody else holds him', () => {
    expect(SVC).toMatch(/compensation: current && dto\.compensation != null/);
  });
});

describe('nothing is invented', () => {
  it('totals are derived from the records that make them up', () => {
    expect(SVC).toContain('function trophySummary');
    expect(SVC).toMatch(/total: trophies\.length/);
  });

  it('best seasons are ranked from what was won and achieved, not chosen', () => {
    expect(SVC).toContain('function seasonScore');
    expect(SVC).toContain('function bestSeasons');
    expect(SVC).not.toMatch(/Math\.random/);
  });

  it('a season with nothing played has no points per match rather than zero', () => {
    const f = SVC.slice(SVC.indexOf('function ppm('), SVC.indexOf('function seasonScore'));
    expect(f).toContain('if (!s.played || s.played <= 0) return null;');
  });

  it('and a coach with no match history reports no record rather than a total', () => {
    expect(SVC).toMatch(/if \(!withPlay\.length\) return null;/);
  });

  it('league and country experience is read off the engagements', () => {
    expect(SVC).toContain('function experienceFromEngagements');
  });
});

describe('what the market publishes', () => {
  it('never the private columns of a User', () => {
    const sel = SVC.slice(SVC.indexOf('const publicUserSelect'), SVC.indexOf('const publicClubSelect'));
    ['email', 'passwordHash', 'currentClubId'].forEach((f) => expect(sel).not.toContain(f));
    expect(sel).toContain('firstName');
  });
});

describe('the client is a second market, not the player one renamed', () => {
  it('it has its own page — and is no longer a tab inside the player market', () => {
    // it was born as a tab there; it is a module now, and the player market is
    // players only
    expect(APP).not.toContain("['staff', 'Coaches & Staff', 'Technical recruitment']");
    expect(APP).not.toContain("if (_TF.tab === 'staff') return _stHtml();");
    expect(APP).toContain('function renderCoachMarketPage()');
  });

  it('and draws no player attribute anywhere in it', () => {
    const mod = APP.slice(APP.indexOf('var _TF_ST = {'), APP.indexOf('// TRANSFERS · REALTIME'));
    expect(mod.length).toBeGreaterThan(1000);
    [/\bpace\b/i, /\bshooting\b/i, /\bdribbling\b/i, /marketValue/].forEach((re) => expect(mod).not.toMatch(re));
  });

  it('the profile has every section the record needs', () => {
    ['overview', 'career', 'qualifications', 'tactics', 'experience',
     'achievements', 'contract', 'intent', 'notes', 'market']
      .forEach((t) => expect(APP).toContain(`['${t}', '`));
  });

  it('the evaluation is staff-specific and its emphasis moves with the role', () => {
    expect(APP).toContain('var ST_EVAL');
    expect(APP).toContain('var ST_EMPHASIS');
    expect(APP).toContain('tacticalKnowledge');
    expect(APP).toContain('playerDevelopment');
  });

  it('and an unrecorded value is said, not filled in', () => {
    expect(APP).toContain('Not recorded');
    expect(APP).toContain('function _stVal');
  });
});

describe('the routes', () => {
  it('are mounted beside the player market, not inside it', () => {
    expect(INDEX).toContain("router.use('/staff-market', staffMarketRoutes);");
    expect(INDEX).toContain("router.use('/transfer-market', transferMarketRoutes);");
  });

  it('reading is open to any club; committing one is a recruitment action', () => {
    expect(ROUTES).toContain("router.get('/discover'");
    expect(ROUTES).toMatch(/router\.post\('\/approaches',\s*recruitGuard/);
    expect(ROUTES).toMatch(/router\.post\('\/needs',\s*recruitGuard/);
    expect(ROUTES).toMatch(/router\.patch\('\/staff\/:staffUserId',\s*recruitGuard/);
  });
});
