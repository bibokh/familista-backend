/**
 * tests/coach-market-route.unit.test.ts
 *
 * The Coach Market is reachable.
 *
 * A menu item that draws and does nothing is the failure this module was
 * reported for, and it has four parts, each of which can be absent on its own:
 * the sidebar entry, the navigation allow-list, the template registry, and the
 * click dispatcher's page gate. A page missing any one of them looks built and
 * is not, so all four are asserted here rather than the one that is easiest.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
const SVC = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'staff-market.service.ts'), 'utf8');
const ROUTES = readFileSync(join(__dirname, '..', 'src', 'routes', 'staff-market.routes.ts'), 'utf8');

describe('the sidebar item exists and sits below Transfers', () => {
  it('is a real nav entry, enabled', () => {
    expect(APP).toMatch(/slug:\s*'coach-market'[\s\S]{0,400}?enabled:\s*true/);
    expect(APP).toMatch(/slug:\s*'coach-market'[\s\S]{0,200}?label:\s*'Coach Market'/);
  });

  it('and orders after Transfers, which is what "directly below" means here', () => {
    const tOrder = /slug:\s*'transfers'[\s\S]*?order:\s*([\d.]+)/.exec(APP);
    const cOrder = /slug:\s*'coach-market'[\s\S]*?order:\s*([\d.]+)/.exec(APP);
    expect(tOrder).not.toBeNull();
    expect(cOrder).not.toBeNull();
    expect(Number(cOrder![1])).toBeGreaterThan(Number(tOrder![1]));
    // and nothing else is between them
    const between = [...APP.matchAll(/order:\s*([\d.]+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > Number(tOrder![1]) && n < Number(cOrder![1]));
    expect(between).toEqual([]);
  });
});

describe('the route is connected end to end', () => {
  it('navigation will not refuse it', () => {
    expect(APP).toMatch(/'transfers':\s*1,\s*'coach-market':\s*1/);
  });

  it('a template is registered, so the page mounts', () => {
    expect(APP).toContain("'coach-market':                renderCoachMarketHTML,");
    expect(APP).toContain('function renderCoachMarketHTML()');
    expect(APP).toContain('function renderCoachMarketPage()');
  });

  it('the page carries a title', () => {
    expect(APP).toContain("'coach-market':'Coach Market'");
  });

  it('entering it paints before it reads, so opening is a navigation', () => {
    const fn = APP.slice(APP.indexOf('function renderCoachMarketPage()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body.indexOf('host.innerHTML')).toBeGreaterThan(-1);
    expect(body.indexOf('host.innerHTML')).toBeLessThan(body.indexOf('_stSyncAll'));
  });

  it('and the click dispatcher answers on it — not only on Transfers', () => {
    expect(APP).toContain("if (!t.closest('#pg-transfers') && !t.closest('#pg-coach-market')) return;");
  });

  it('the page is what the module draws into, wherever it is mounted', () => {
    expect(APP).toContain('function _stHost()');
    expect(APP).toContain("document.getElementById('cm-body')");
  });
});

describe('the market belongs to the club being acted for', () => {
  it('no club id is sent from the browser — the server resolves it', () => {
    const q = APP.slice(APP.indexOf('function _stQuery()'), APP.indexOf('function _stLoadMarket()'));
    expect(q).not.toMatch(/currentClubId|State\.club/);
  });

  it('and leaving a club takes its desk with it', () => {
    expect(APP).toContain('function _stResetClubScoped()');
    expect(APP).toMatch(/_famClearClubScopedState[\s\S]*?_stResetClubScoped/);
  });

  it('the shortlist is the club\'s, keyed by the session\'s own club', () => {
    expect(SVC).toMatch(/clubId:\s*actor\.clubId/);
    expect(SVC).not.toMatch(/staffShortlist[\s\S]{0,200}clubId:\s*dto\./);
  });
});

describe('what the market recruits for', () => {
  it('covers the technical roles a staff has, not only the original six', () => {
    ['GOALKEEPING_COACH', 'FITNESS_COACH', 'TECHNICAL_COACH', 'TACTICAL_COACH',
     'YOUTH_COACH', 'PERFORMANCE_COACH'].forEach((r) => {
      expect(SVC).toContain(`'${r}'`);
      expect(APP).toContain(`'${r}'`);
    });
  });

  it('and they are the platform\'s own membership roles, added not substituted', () => {
    const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    const e = /enum MembershipRole \{([\s\S]*?)\}/.exec(schema)![1];
    ['HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'PLAYER', 'DEVICE'].forEach((r) => expect(e).toContain(r));
    expect(e).toContain('GOALKEEPING_COACH');
  });
});

describe('search, filters, sort, shortlist and comparison', () => {
  it('sorting is on figures the record holds, and asks the server for the order', () => {
    expect(APP).toContain('var ST_SORTS');
    expect(APP).toMatch(/q\.push\('sort='/);
    expect(SVC).toContain('const NUMERIC: Record<string, string>');
    // an unknown value never counts as zero
    expect(SVC).toContain('if (av == null) return 1;');
  });

  it('the shortlist lives on the server, not in this browser', () => {
    expect(APP).toContain("_stApi('GET', '/shortlist')");
    expect(APP).toMatch(/_stApi\('PUT', '\/shortlist\//);
    expect(APP).toMatch(/_stApi\('DELETE', '\/shortlist\//);
    expect(APP).not.toMatch(/localStorage[\s\S]{0,40}shortlist/i);
    expect(ROUTES).toContain("router.get('/shortlist',");
    expect(ROUTES).toMatch(/router\.put\('\/shortlist\/:staffUserId',\s*recruitGuard/);
    expect(ROUTES).toMatch(/router\.delete\('\/shortlist\/:staffUserId',\s*recruitGuard/);
  });

  it('comparison reads the same projection a profile does', () => {
    expect(SVC).toContain('export async function compareStaff');
    expect(SVC).toContain('unique.map((id) => readStaff(actor, id))');
    expect(APP).toContain('function _stCompareHtml()');
    expect(APP).toContain('function _stCompareTrayHtml()');
  });

  it('and the search and filters are still the ones that were there', () => {
    expect(APP).toContain('data-st-q');
    expect(APP).toContain('function _stFiltersHtml()');
  });
});

describe('the card says what the record holds', () => {
  it('carries every field the market decides on', () => {
    const card = APP.slice(APP.indexOf('function _stCardHtml(r)'), APP.indexOf('function _stExternalHtml()'));
    ['Licence', 'Level', 'Experience', 'Formation', 'Speciality', 'Salary', 'Contract', 'Languages']
      .forEach((l) => expect(card).toContain(`'${l}'`));
    expect(card).toContain('r.age');
    expect(card).toContain('r.nationality');
    expect(card).toContain('r.avatar');
    expect(card).toContain('r.reputation');
    expect(card).toContain('r.currentClub');
    expect(card).toContain('keyAttributes');
    expect(card).toContain('ST_STATUS_LABEL');
  });

  it('and says so when the platform does not hold one', () => {
    const card = APP.slice(APP.indexOf('function _stCardHtml(r)'), APP.indexOf('function _stExternalHtml()'));
    expect(card).toContain("var dash = '<i class=\"st-unknown\">—</i>'");
    expect(card).toContain('No coaching attributes recorded');
  });

  it('an age is derived from a date of birth, never invented', () => {
    expect(SVC).toContain("age: p?.dateOfBirth");
    expect(SVC).not.toMatch(/Math\.random/);
  });
});

describe('nothing existing is disturbed', () => {
  it('the player market keeps its page, its tab strip and its staff tab', () => {
    expect(APP).toContain('function renderTransfersHTML()');
    expect(APP).toContain("['staff', 'Coaches & Staff', 'Technical recruitment']");
    expect(APP).toContain("if (_TF.tab === 'staff') return _stHtml();");
  });

  it('every other workspace page is still registered', () => {
    ['squad', 'training', 'academy', 'academy-team', 'video-intelligence', 'transfers']
      .forEach((p) => expect(APP).toContain(`'${p}': 1`));
  });

  it('and the card grid does not change height with its contents', () => {
    expect(CSS).toMatch(/\.st-card\{[^}]*position:relative/);
    expect(CSS).toContain('.st-card-open{');
  });
});
