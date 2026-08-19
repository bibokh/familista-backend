/**
 * tests/market-separation.unit.test.ts
 *
 * Three modules, and the lines between them.
 *
 * Transfers trades players. Coach Market recruits staff. Coaches says who is
 * working where. They were one page with a tab strip; the thing worth asserting
 * now is that they are not — that no staff control is drawn inside the player
 * market, that the directory is not the market with a filter on it, and that
 * the one thing they legitimately share is the person.
 *
 * The directory in particular has no list of teams anywhere. It reads the Team
 * table and the memberships that exist, so a team created tomorrow is a group
 * tomorrow and a coach who moves changes group by himself.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
const SVC = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'staff-market.service.ts'), 'utf8');
const CO_ROUTES = readFileSync(join(__dirname, '..', 'src', 'routes', 'coaches.routes.ts'), 'utf8');
const INDEX = readFileSync(join(__dirname, '..', 'src', 'routes', 'index.ts'), 'utf8');

// the slice of app.js that is the player market's own module
const TF = APP.slice(APP.indexOf('function renderTransfersHTML()'), APP.indexOf('var _TF_ST = {'));

describe('Transfers is the player market and nothing else', () => {
  it('its tab strip has no staff tab', () => {
    const tabs = APP.slice(APP.indexOf('var TF_TABS = ['), APP.indexOf('function renderTransfersPage()'));
    ['auctions', 'feed', 'offers', 'needs', 'activity', 'scouting', 'assistant']
      .forEach((t) => expect(tabs).toContain(`'${t}'`));
    expect(tabs).not.toContain("'staff'");
    expect(tabs).not.toMatch(/Coaches/i);
  });

  it('and its tab router cannot reach the staff market', () => {
    expect(APP).not.toContain("if (_TF.tab === 'staff') return _stHtml();");
    const router = APP.slice(APP.indexOf('function _tfTabHtml(C) {'));
    expect(router.slice(0, router.indexOf('\n}'))).not.toContain('_stHtml');
  });

  it('the staff module never draws into the player market\'s body', () => {
    const host = APP.slice(APP.indexOf('function _stHost()'));
    expect(host.slice(0, host.indexOf('\n}'))).not.toContain('tf-body');
  });

  it('every player surface it had is still there', () => {
    ['_tfAucLoad', '_tfFeedHtml', '_tfNegLoadActivity', '_tfNegLoadNeeds',
     '_tfScoutLoad', '_tfAssistantHtml', '_tfSyncBalance', '_tfSyncServerMarket']
      .forEach((f) => expect(APP).toContain(f));
  });

  it('and it is still mounted on its own page, unchanged', () => {
    expect(APP).toContain("return '<div class=\"page\" id=\"pg-transfers\"><div class=\"tf-root\" id=\"tf-shell\"></div>'");
  });
});

describe('Coach Market recruits, and has no directory in it', () => {
  it('carries the seven recruitment tabs', () => {
    const tabs = APP.slice(APP.indexOf('var ST_TABS = ['), APP.indexOf('var ST_BOARD_TABS'));
    [['market', 'Market'], ['available', 'Available'], ['free-agents', 'Free Agents'],
     ['shortlisted', 'Shortlisted'], ['needs', 'Staff Needs'],
     ['negotiations', 'Negotiations'], ['activity', 'Activity']]
      .forEach(([slug, label]) => {
        expect(tabs).toContain(`'${slug}'`);
        expect(tabs).toContain(`'${label}'`);
      });
  });

  it('and no Coaches tab among them', () => {
    const tabs = APP.slice(APP.indexOf('var ST_TABS = ['), APP.indexOf('var ST_BOARD_TABS'));
    expect(tabs).not.toMatch(/'Coaches'/);
    expect(tabs).not.toContain("'coaches'");
  });

  it('every page is drawn as the thing it is, not as one grid seven times', () => {
    ['_stMarketHtml', '_stAvailableHtml', '_stFreeAgentsHtml', '_stShortlistDeskHtml',
     '_stNeedsHtml', '_stPipelineHtml', '_stTimelineHtml']
      .forEach((f) => expect(APP).toContain(`function ${f}(`));
    // and each has its own markup, not the market card
    expect(APP).toContain('function _stAvailRowHtml(r)');   // ranked list
    expect(APP).toContain('function _stDossierHtml(r)');    // scouting board
    expect(APP).toContain('function _stDeskCardHtml(r, m)'); // recruitment desk
    expect(APP).toContain('function _stVacancyHtml(x)');    // job board
    expect(APP).toContain('function _stDealHtml(d)');       // pipeline
  });

  it('the desk keeps the club\'s own judgement, on the server', () => {
    expect(APP).toContain('var ST_PRIORITY');
    expect(APP).toContain('var ST_STAGE');
    expect(SVC).toContain('export async function setShortlistMeta');
    expect(SVC).toContain("throw new BadRequestError('Unknown recruitment stage')");
    expect(APP).toMatch(/_stApi\('PATCH', '\/shortlist\//);
  });

  it('the pipeline has a column per offer state', () => {
    expect(APP).toContain("var ST_PIPE = ['DRAFT', 'SENT', 'VIEWED', 'NEGOTIATING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']");
  });

  it('and a vacancy says what the job actually is', () => {
    ['minExperience', 'contractType', 'startDate', 'languages', 'youthRequired', 'seniorRequired']
      .forEach((f) => expect(SVC).toContain(f));
    expect(APP).toContain('data-st-n="contractType"');
    expect(APP).toContain('data-st-nflag="youthRequired"');
  });
});

describe('Coaches is its own module, below Coach Market', () => {
  it('is a sidebar entry of its own', () => {
    expect(APP).toMatch(/slug:\s*'coaches',[\s\S]{0,1400}?enabled:\s*true/);
    expect(APP).toMatch(/slug:\s*'coaches',\s*\n\s*label:\s*'Coaches',/);
  });

  it('and sits directly below Coach Market, with nothing between', () => {
    const cm = /slug:\s*'coach-market'[\s\S]*?order:\s*([\d.]+)/.exec(APP)!;
    const co = /slug:\s*'coaches'[\s\S]*?order:\s*([\d.]+)/.exec(APP)!;
    expect(Number(co[1])).toBeGreaterThan(Number(cm[1]));
    const between = [...APP.matchAll(/order:\s*([\d.]+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > Number(cm[1]) && n < Number(co[1]));
    expect(between).toEqual([]);
  });

  it('is routed end to end, like any workspace page', () => {
    expect(APP).toContain("'coaches': 1");
    expect(APP).toContain("'coaches':                     renderCoachesHTML,");
    expect(APP).toContain("'coaches':'Coaches'");
    expect(APP).toContain('function renderCoachesPage()');
    expect(APP).toContain("if (!t.closest('#pg-coaches')) return;");
  });

  it('has its own endpoint, mounted beside the market rather than inside it', () => {
    expect(CO_ROUTES).toContain("router.get('/directory', ctrl.directory);");
    expect(INDEX).toContain("router.use('/coaches', coachesRoutes);");
    expect(INDEX).toContain("router.use('/staff-market', staffMarketRoutes);");
    expect(APP).toContain("function _coApi(method, path) { return _thApi(method, '/coaches' + path); }");
  });

  it('and is not the market\'s screen: no board, no negotiating, no shortlist on it', () => {
    const co = APP.slice(APP.indexOf('function _coHtml() {'), APP.indexOf('// The directory\'s own listeners'));
    expect(co).not.toContain('_stCardHtml');
    expect(co).not.toContain('data-st-approach');
    expect(co).not.toContain('data-st-short');
    expect(co).not.toContain('data-st-cmp');
    // its own markup instead
    expect(APP).toContain('function _coGroupHtml(g)');
    expect(APP).toContain('function _coStaffCardHtml(m)');
    expect(CSS).toContain('.co-team{');
    expect(CSS).toContain('.co-card{');
  });
});

describe('the directory is read from what the platform holds', () => {
  it('it queries the teams that exist — no group is written down', () => {
    const f = SVC.slice(SVC.indexOf('export async function coachesDirectory'));
    expect(f).toContain('prisma.team.findMany');
    expect(f).toContain('where: { isActive: true }');
    expect(f).toContain('prisma.membership.findMany');
    expect(f).toMatch(/role: \{ in: TECHNICAL_ROLES \}/);
    // no club and no team is named anywhere
    [/BSC/i, /Marzahn/i, /FC Familista/i, /First Team'/, /U13/, /U11/].forEach((re) => expect(f).not.toMatch(re));
  });

  it('a club-wide membership is its own group, not copied into every team', () => {
    const f = SVC.slice(SVC.indexOf('export async function coachesDirectory'));
    expect(f).toContain('const clubWide = new Map');
    expect(f).toContain("kind: 'CLUB' as never");
  });

  it('a team with nobody in it is still a group', () => {
    const f = SVC.slice(SVC.indexOf('export async function coachesDirectory'));
    expect(f).toContain('groupsWithoutStaff');
    expect(APP).toContain('No technical staff recorded for this team.');
  });

  it('and the status it shows is the market\'s own, from the same function', () => {
    const f = SVC.slice(SVC.indexOf('export async function coachesDirectory'));
    expect(f).toContain('employmentStatus: employmentStatus({');
  });
});

describe('one person, two perspectives', () => {
  it('the directory opens the market\'s canonical profile, not a second one', () => {
    const wire = APP.slice(APP.indexOf('function _coRepaint()'));
    expect(wire).toContain('_stProfileHtml()');
    expect(wire).toContain('_stLoadOne(id)');
    expect(APP).not.toMatch(/function _coProfileHtml/);
  });

  it('and the directory never creates a person', () => {
    const f = SVC.slice(SVC.indexOf('export async function coachesDirectory'));
    expect(f).not.toContain('prisma.user.create');
    expect(f).not.toContain('membership.create');
    expect(f).not.toContain('staffProfile.create');
  });

  it('the three modules keep their own state', () => {
    expect(APP).toContain('var _CO = {');
    expect(APP).toContain('var _TF_ST = {');
    // and a club switch clears the staff market's desk
    expect(APP).toContain('function _stResetClubScoped()');
  });
});
