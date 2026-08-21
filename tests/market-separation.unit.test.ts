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

// A service function's own body, bounded by the next export.
function svcFn(name: string) {
  const from = SVC.indexOf(`export async function ${name}`);
  const next = SVC.indexOf('export async function', from + 10);
  return SVC.slice(from, next < 0 ? undefined : next);
}

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
    const form = APP.slice(APP.indexOf('function _stNeedFormHtml()'), APP.indexOf('function _stVacancyHtml('));
    ['role', 'priority', 'minLicence', 'minExperience', 'salaryMax', 'contractType',
     'startDate', 'languages', 'note']
      .forEach((k) => expect(form).toMatch(new RegExp(`(sel|inp)\\('${k}'|data-st-n="${k}"`)));
    expect(form).toContain('data-st-nflag="youthRequired"');
    expect(form).toContain('data-st-nflag="seniorRequired"');
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
    expect(CO_ROUTES).toMatch(/router\.get\('\/directory',\s*ctrl\.directory\);/);
    expect(INDEX).toContain("router.use('/coaches', coachesRoutes);");
    expect(INDEX).toContain("router.use('/staff-market', staffMarketRoutes);");
    expect(APP).toContain("function _coApi(method, path) { return _thApi(method, '/coaches' + path); }");
  });

  it('and is not the market\'s screen: no board, no negotiating, no shortlist on it', () => {
    const co = APP.slice(APP.indexOf('function _coHtml() {'), APP.indexOf('function _coProfileHtml()'));
    expect(co.length).toBeGreaterThan(500);
    expect(co).not.toContain('_stCardHtml');
    expect(co).not.toContain('data-st-approach');
    expect(co).not.toContain('data-st-short');
    expect(co).not.toContain('data-st-cmp');
    // its own markup instead
    expect(APP).toContain('function _coTeamCardHtml(g)');
    expect(APP).toContain('function _coStaffCardHtml(m)');
    expect(CSS).toContain('.co-tc{');
    expect(CSS).toContain('.co-sc{');
    // and it does not borrow the market's palette: it defines its own
    expect(CSS).toMatch(/#pg-coaches\{[\s\S]*?--co-bg:/);
    expect(CSS).not.toMatch(/:is\(#pg-transfers,#pg-coach-market,#pg-coaches\)/);
  });
});

describe('the directory is read from what the platform holds', () => {
  it('it queries the teams that exist — no group is written down', () => {
    const f = svcFn('coachesDirectory');
    expect(f).toContain('prisma.team.findMany');
    expect(f).toContain('where: { isActive: true, ...scope }');
    expect(f).toContain('prisma.membership.findMany');
    expect(f).toMatch(/role: \{ in: TECHNICAL_ROLES \}/);
    // no club and no team is named anywhere
    [/\bBSC\b/i, /\bMarzahn\b/i, /\bFC Familista\b/i, /'First Team'/, /'U13'/, /'U11'/].forEach((re) => expect(f).not.toMatch(re));
  });

  it('a club-wide membership is its own group, not copied into every team', () => {
    const f = svcFn('coachesDirectory');
    expect(f).toContain('const clubWide = new Map');
    expect(f).toContain("kind: 'CLUB' as never");
  });

  it('a team with nobody in it is still a group', () => {
    const f = svcFn('coachesDirectory');
    expect(f).toContain('groupsWithoutStaff');
    expect(APP).toContain('No technical staff assigned to this team yet.');
  });

  it('and the status it shows is the market\'s own, from the same function', () => {
    const f = svcFn('coachesDirectory');
    expect(f).toContain('employmentStatus: employmentStatus({');
  });
});

describe('one person, two perspectives', () => {
  it('the directory opens the market\'s canonical profile, not a second one', () => {
    // the panel is the directory's, the record inside it is the market's own
    expect(APP).toContain('function _coProfileHtml()');
    const wire = APP.slice(APP.indexOf('(function _coWire() {'));
    expect(wire).toContain('_stLoadOne(id)');
    expect(wire).toMatch(/_stApi\('PATCH', '\/staff\//);   // edits the canonical record
    expect(APP).not.toMatch(/_coApi2\('POST', '\/profiles/); // and never a second one
  });

  it('and the directory never creates a person', () => {
    const f = svcFn('coachesDirectory');
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

describe('three modules, three visual identities', () => {
  it('the player market keeps its own palette, untouched', () => {
    // mustard band, silver board — the tokens it always had
    expect(CSS).toMatch(/:is\(#pg-transfers,#pg-coach-market\)\{[\s\S]*?--tf-gold:\s*#c9a32e/);
    expect(CSS).toMatch(/--tf-page:\s*#c5c9cb/);
    expect(CSS).toMatch(/\.tf-head\{[\s\S]*?var\(--tf-gold-hi\)/);
  });

  it('the recruitment desk re-points those tokens rather than duplicating rules', () => {
    const cm = CSS.slice(CSS.indexOf('#pg-coach-market{'), CSS.indexOf('[data-theme="light"] #pg-coach-market'));
    expect(cm).toMatch(/--tf-gold:\s*#10b981/);   // emerald, not mustard
    expect(cm).toMatch(/--tf-page:\s*#0b0f16/);   // deep navy, not silver
    expect(cm).toMatch(/--tf-acc:\s*#2dd4bf/);    // teal
    expect(cm).toMatch(/--tf-champagne:\s*#5eead4/); // cyan
    // and it does not wear the player market's band
    expect(CSS).toContain('.cm-head{');
    expect(CSS).not.toMatch(/\.cm-head[\s\S]{0,200}--tf-gold-hi/);
  });

  it('the directory is on its own ground, borrowing no market token at all', () => {
    const co = CSS.slice(CSS.indexOf('#pg-coaches{'), CSS.indexOf('[data-theme="light"] #pg-coaches'));
    expect(co).toMatch(/--co-bg:\s*#070d18/);
    expect(co).not.toContain('--tf-gold');
    expect(co).not.toContain('--tf-page');
    expect(CSS).toContain('.co-head{');
  });

  it('and the three grounds are three different colours', () => {
    const tf = /:is\(#pg-transfers,#pg-coach-market\)\{[\s\S]*?--tf-page:\s*(#[0-9a-f]{6})/i.exec(CSS)![1];
    const cm = /#pg-coach-market\{[\s\S]*?--tf-page:\s*(#[0-9a-f]{6})/i.exec(CSS)![1];
    const co = /#pg-coaches\{[\s\S]*?--co-bg:\s*(#[0-9a-f]{6})/i.exec(CSS)![1];
    expect(new Set([tf.toLowerCase(), cm.toLowerCase(), co.toLowerCase()]).size).toBe(3);
  });

  it('the directory groups staff into departments rather than one flat grid', () => {
    expect(APP).toContain('var CO_DEPTS');
    ['Leadership', 'Coaching', 'Performance', 'Analysis', 'Medical', 'Scouting']
      .forEach((d) => expect(APP).toContain(`['${d}',`));
    // a role the departments do not cover is still shown, never dropped
    expect(APP).toMatch(/if \(rest\.length\) groups\.push\(\{ name: 'Other'/);
    expect(CSS).toContain('.co-dept-h{');
  });

  it('its teams collapse, and each carries its own colour', () => {
    // one tier at a time, and each team carries its own colour
    expect(APP).toContain("data-co-club=");
    expect(APP).toContain("data-co-team=");
    expect(APP).toContain("' style=\"--co-accent:'");
    expect(CSS).toContain('border-left:3px solid var(--co-accent);');
  });

  it('and a free agent can never appear in it', () => {
    // the directory is built from memberships; a free agent has none
    const f = svcFn('coachesDirectory');
    expect(f).not.toContain('staffProfile.findMany({ where: { user');
    expect(f).toMatch(/memberships\.forEach/);
    expect(f).not.toContain('orphanProfiles');
    expect(f).toContain('hasClub: true');
  });
});
