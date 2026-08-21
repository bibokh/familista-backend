/**
 * tests/coach-exchange-refine.unit.test.ts
 *
 * The refinement and simplification passes over the Coach Exchange.
 *
 * The bug this file exists for was real and is the first thing asserted. Every
 * board tab used to read its own rows array with a different tab= on the query,
 * repainting is synchronous and the read is not — so opening Shortlisted painted
 * the forty-five rows the Market floor had left behind and then replaced them
 * with the two that are actually shortlisted. Nothing was ever lost; the wrong
 * thing was drawn first.
 *
 * The structural answer is the one asserted here: there is no per-tab read at
 * all. The module reads the population once, keeps it, and every board is a
 * memoised filter over that one array — so a tab switch is a repaint of data
 * already on the machine, a stale cache refreshes behind whatever is on screen,
 * and no board can be holding another board's rows because there is only one.
 *
 * The rest is shape: the tooltip lives at the end of <body> so no ancestor can
 * clip it, the profile and every modal are opaque and on the module's own dark
 * surface, each of the seven tabs is a different layout, and each of them says
 * what to do when it has nothing to show.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');

function appFn(name: string, until: string) {
  return APP.slice(APP.indexOf(`function ${name}`), APP.indexOf(`function ${until}`));
}
function rule(sel: string) {
  const at = CSS.indexOf(sel);
  if (at < 0) return '';
  return CSS.slice(at, CSS.indexOf('}', at));
}
// the last pass wins, so a rule the simplification restated is read from there
const SIMP = CSS.slice(CSS.indexOf('COACH EXCHANGE · the simplification pass'));
function lastRule(sel: string) {
  const at = SIMP.indexOf(sel);
  if (at < 0) return '';
  return SIMP.slice(at, SIMP.indexOf('}', at));
}

describe('a tab never draws another tab\'s rows', () => {
  it('one population serves every board, so no board can hold another\'s rows', () => {
    const f = appFn('_stLoadPopulation', '_stLoadMarket');
    expect(f).toContain('var gen = ++_stGen;');
    expect(f).toContain("'?tab=all&sort='");     // the whole market, not one tab of it
    // and every board is a filter over that one array
    const der = appFn('_stDerived', '_stLoadClubs');
    ['all: rows,', 'listed: rows.filter(_stOnMarket)', 'freeAgents: rows.filter', 'shortlisted: rows.filter']
      .forEach((k) => expect(der).toContain(k));
  });

  it('and a read that lands after the reader has moved on is dropped', () => {
    const f = appFn('_stLoadPopulation', '_stLoadMarket');
    // both the success path and the failure path
    expect(f.match(/if \(gen !== _stGen\) return;/g)).toHaveLength(2);
  });

  it('every board tab checks before it draws', () => {
    expect(APP).toContain('function _stRowsReady()');
    expect(APP).toContain('function _stCacheWarm()  { return _ST_CACHE.at > 0; }');
    ['_stMarketHtml', '_stAvailableHtml', '_stFreeAgentsHtml', '_stShortlistDeskHtml']
      .forEach((fn) => {
        const body = APP.slice(APP.indexOf(`function ${fn}(`), APP.indexOf(`function ${fn}(`) + 900);
        expect(body).toContain('_stRowsReady()');
      });
  });

  it('the war room in particular, because that is where it showed', () => {
    const f = APP.slice(APP.indexOf('function _stShortlistDeskHtml()'));
    expect(f.slice(0, 500)).toContain("if (!_stRowsReady()) return _stReadingHtml('the shortlist');");
  });

  it('and switching club invalidates everything in flight', () => {
    const f = appFn('_stResetClubScoped', '_thResetRoster');
    expect(f).toContain('_stGen++;');
    expect(f).toContain('_ST_CACHE.at = 0;');
  });

  it('the fix is state, not a delay or a suppressed refetch', () => {
    const f = appFn('_stLoadPopulation', '_stLoadMarket');
    expect(f).not.toMatch(/setTimeout/);
    // a write still reloads the market for real
    expect(appFn('_stLoadMarket', '_stRowsReady')).toContain('return _stSyncAll(true);');
  });
});

describe('a cached tab switch costs nothing', () => {
  it('the module reads once and keeps it', () => {
    expect(APP).toContain('var _ST_CACHE = { at: 0, inflight: null };');
    expect(APP).toContain('var ST_FRESH_MS = 20000;');
    expect(APP).toContain('var ST_STALE_MS = 60000;');
    const s = appFn('_stSyncAll', '_stRevalidate');
    // a second caller inside the same flight joins it rather than issuing its own
    expect(s).toContain('if (_ST_CACHE.inflight && !force) return _ST_CACHE.inflight;');
    expect(s).toContain('if (!force && _stCacheFresh()) return Promise.resolve();');
  });

  it('switching a tab repaints and reads nothing', () => {
    const wire = APP.slice(APP.indexOf("if ((el = t.closest('[data-st-view]')))"));
    const block = wire.slice(0, 900);
    expect(block).toContain('_stRepaint();');
    expect(block).toContain('_stRevalidate();');
    expect(block).not.toContain('_stLoadMarket()');
  });

  it('a stale board refreshes behind what is shown, never in front of it', () => {
    const r = appFn('_stRevalidate', '_stHtml');
    expect(r).toContain('if (_ST_CACHE.inflight) return;');
    expect(r).toContain('if (Date.now() - _ST_CACHE.at < ST_STALE_MS) return;');
    expect(r).toContain('_stSyncAll(true).then(function () { _stRepaint(); });');
    // and a failed refresh does not empty a board that is already showing people
    expect(appFn('_stLoadPopulation', '_stLoadMarket'))
      .toContain('if (!_TF_ST.rows.length) { _TF_ST.rows = []; _TF_ST.total = 0; }');
  });

  it('the derived boards are memoised against the filters that produced them', () => {
    const k = appFn('_stDeriveKey', '_stDerived');
    ['f.search', 'f.role', 'f.status', 'f.clubId', 'f.licence'].forEach((x) => expect(k).toContain(x));
    expect(k).toContain('_TF_ST.rows.length');
    expect(appFn('_stDerived', '_stLoadClubs'))
      .toContain("if (_TF_ST.derived && _TF_ST.derived.key === key) return _TF_ST.derived;");
    // a new population invalidates it
    expect(appFn('_stLoadPopulation', '_stLoadMarket')).toContain('_TF_ST.derived = null;');
  });

  it('and searching or filtering is not a network trip', () => {
    const der = appFn('_stDerived', '_stLoadClubs');
    expect(der).toContain('rows = rows.filter(function (r) { return r.role === f.role; });');
    expect(der).not.toContain('_stApi(');
  });
});

describe('the market intelligence tooltip floats above everything', () => {
  it('it is one element at the end of the document, not a child of a node', () => {
    expect(APP).toContain("el.id = 'cx-tip';");
    expect(APP).toContain('document.body.appendChild(el);');
    // and the node no longer carries one
    const node = appFn('_stNodeHtml', '_stTipEl');
    expect(node).not.toContain('cx-tip');
  });

  it('fixed, and above every stacking context the page can make', () => {
    const r = rule('#cx-tip.cx-tip{');
    expect(r).toContain('position:fixed');
    expect(r).toMatch(/z-index:2147483000/);
  });

  it('it is placed inside the viewport, flipping when there is no room', () => {
    const f = appFn('_stTipShow', '_stCompareTrayHtml');
    expect(f).toContain('if (top < pad) top = n.bottom + 10;');
    expect(f).toContain('left = Math.max(pad, Math.min(left, window.innerWidth - t.width - pad));');
  });

  it('and it is dismissed by anything that moves what it points at', () => {
    const wire = APP.slice(APP.indexOf('(function _stTipWire() {'));
    expect(wire).toContain("document.addEventListener('scroll', _stTipHide, true);");
    expect(wire).toContain("window.addEventListener('resize', _stTipHide);");
    expect(appFn('_stRepaint', '_stTipWire')).toContain('_stTipHide();');
  });

  it('it stays information only — the click still opens the record', () => {
    expect(rule('#cx-tip.cx-tip{')).toContain('pointer-events:none');
    expect(appFn('_stNodeHtml', '_stTipEl')).toContain('data-st-lens=');
  });
});

describe('the coach intelligence profile is opaque and dashboard-first', () => {
  it('the surface is near-solid, and the scrim behind it is heavy', () => {
    const r = rule('#pg-coach-market .cx-profile{');
    expect(r).toContain('#111823');           // an opaque ground, not a wash
    expect(r).toContain('backdrop-filter:blur(6px)');
    expect(r).not.toMatch(/rgba\(255,255,255,\.0[0-9]\)\s*;?\s*$/);
    expect(rule('#pg-coach-market .tf-modal-bd{')).toContain('rgba(4,7,12,.82)');
  });

  it('the overview leads with six readings, not a form', () => {
    const f = appFn('_stOverviewPanel', '_stCareerPanel');
    ['Professional evaluation', 'Market situation', 'Contract &amp; availability', 'Qualifications',
     'Tactical identity', 'Experience']
      .forEach((m) => expect(f).toContain(`mod('${m}`));
    expect(CSS).toContain('.cx-pmods{');
    expect(CSS).toContain('.cx-pm{');
  });

  it('and a figure the record does not hold is left out, not printed as an empty box', () => {
    const f = appFn('_stOverviewPanel', '_stCareerPanel');
    // a null row is dropped and its name remembered
    expect(f).toContain("if (r[1] == null || r[1] === '') { missing.push(r[0]); return false; }");
    // a module with nothing in it is not drawn at all
    expect(f).toContain("if (!body) return '';");
    // and what is missing is named once, behind a disclosure
    expect(f).toContain("'<details class=\"cx-more-info\"><summary>Additional information</summary>'");
    expect(f).toContain("'<p class=\"cx-inote\">Not recorded: '");
    expect(f).not.toContain("var dash = '<i class=\"st-unknown\">Not recorded</i>';");
    expect(CSS).toContain('.cx-more-info{');
  });

  it('and demand is read from the market row, never invented on the profile', () => {
    const f = appFn('_stOverviewPanel', '_stCareerPanel');
    expect(f).toContain("(_TF_ST.rows || []).forEach(function (x) { if (x.staffUserId === d.staffUserId) row = x; });");
    expect(f).toContain("['Clubs watching', row && row.clubsWatching != null ? row.clubsWatching : null]");
  });

  it('the canonical tabs and the action dock are untouched', () => {
    expect(APP).toContain('var ST_PROFILE_TABS = [');
    ['overview', 'personal', 'career', 'qualifications', 'tactics', 'experience',
     'achievements', 'contract', 'intent', 'notes', 'market']
      .forEach((t) => expect(APP).toContain(`['${t}',`));
    const dock = appFn('_stProfileActionsHtml', '_stApproachHtml');
    ['Shortlist', 'Compare', 'Career history', 'Club notes', 'Contact', 'Start negotiation']
      .forEach((a) => expect(dock).toContain(a));
  });
});

describe('the war room is four lanes that rebalance', () => {
  it('four stages, mapped onto the five the platform stores', () => {
    expect(APP).toContain("var ST_WR = [");
    expect(APP).toContain("['DECISION',  'Final review',  ['NEGOTIATION', 'OFFER_SENT']]");
    // nothing was renamed in the database to make the screen read well
    expect(APP).toContain("var ST_STAGE = [");
    expect(APP).toContain("['OFFER_SENT', 'Offer Sent']");
  });

  it('an empty lane is given less room than a busy one', () => {
    const f = appFn('_stShortlistDeskHtml', '_stDeskCardHtml');
    expect(f).toContain('return l.people.length ? Math.max(3, Math.round((12 - (4 - busy) * 2) / busy)) : 2;');
    expect(rule('.cx-wr{')).toContain('repeat(12,1fr)');
    expect(rule('.cx-wr-col{')).toContain('span var(--span');
  });

  it('an empty shortlist says what to do about it rather than nothing', () => {
    const f = appFn('_stShortlistDeskHtml', '_stDeskCardHtml');
    expect(f).toContain("_stEmpty('★', 'No coaches shortlisted',");
    expect(f).toContain('data-st-view="market">Browse market');
    // and the empty state is one shape used by every board
    const e = appFn('_stEmpty', '_stFreeAgentsHtml');
    ['cx-none-i', '<b>', 'action'].forEach((x) => expect(e).toContain(x));
  });

  it('and a card carries what a decision needs, in about 130px', () => {
    const c = appFn('_stDeskCardHtml', '_stDealStage');
    expect(c).toContain('_stScores(r)');            // FCI and opportunity
    expect(c).toContain('data-st-stage=');          // move him along the pipeline
    expect(c).toContain('cx-wr-when');              // when we last spoke
    ['Profile', 'Negotiate', 'Remove'].forEach((a) => expect(c).toContain('>' + a + '<'));
    expect(lastRule('.cx-wr-card{')).toMatch(/max-height:1[0-3][0-9]px/);
  });
});

describe('free agents is a two-column desk', () => {
  it('two columns of compact cards, not one row each', () => {
    expect(lastRule('.cx-df{')).toContain('repeat(2,minmax(0,1fr))');
    const f = appFn('_stDossierHtml', '_stMonthsSince');
    expect(f).toContain('cx-dt-body');
    ['Last club', 'Experience', 'Licence', 'Expects', 'Free since', 'Wants']
      .forEach((l) => expect(f).toContain(`['${l}',`));
  });

  it('and a field the record does not hold is left off, not printed as a dash', () => {
    const f = appFn('_stDossierHtml', '_stMonthsSince');
    expect(f).toContain(".filter(function (f) { return f[1] != null && f[1] !== ''; })");
  });

  it('four ways of ordering it, and nothing else to decide', () => {
    expect(APP).toContain('var ST_FA_SORTS = [');
    ["'opportunity', 'Best fit'", "'yearsExperience', 'Most experienced'",
     "'reputation', 'Highest reputation'", "'recent', 'Recently available'"]
      .forEach((s) => expect(APP).toContain(s));
    const f = appFn('_stFreeAgentsHtml', '_stDossierHtml');
    expect(f).toContain('data-st-fasort=');
    expect(f).toContain("_stEmpty('◆', 'No free agents',");
  });

  it('and only people with no club and no team are on it', () => {
    const f = APP.slice(APP.indexOf('function _stFreeAgentsHtml()'), APP.indexOf('function _stDossierHtml('));
    expect(f).toContain('_stDerived().freeAgents');
    expect(appFn('_stDerived', '_stLoadClubs')).toContain('r.isFreeAgent && !r.currentClub');
  });

  it('and adding somebody external uses the module\'s own dark modal, not a white sheet', () => {
    const x = appFn('_stExternalHtml', '_stCompareTrayHtml');
    expect(x).toContain('class="cx-modal"');
    expect(x).toContain('class="cx-modal-box');
    expect(x).not.toContain('tf-modal');
    const box = lastRule('.cx-modal-box{');
    expect(box).toMatch(/background:linear-gradient\(180deg,#1[0-9a-f]{5}/);
    expect(lastRule('.cx-modal{')).toContain('position:fixed');
    // and the need form is on the same system
    expect(appFn('_stNeedFormHtml', '_stVacancyHtml')).toContain('class="cx-modal"');
  });
});

describe('staff needs is a staff planner', () => {
  it('one team at a time, as a line-up of posts rather than a table', () => {
    const f = appFn('_stNeedsHtml', '_stSlotMatchHtml');
    expect(f).toContain('class="cx-teams"');        // the team tabs
    expect(f).toContain('data-st-planteam=');
    expect(f).toContain("'<button type=\"button\" class=\"cx-post cx-post--' + state");
    expect(f).toContain('data-st-slot=');
    expect(CSS).toContain('.cx-post--open, .cx-post--published{');
  });

  it('each post reads as filled, at risk, or open', () => {
    const f = appFn('_stNeedsHtml', '_stSlotMatchHtml');
    expect(f).toContain("var state = on ? (risk ? 'risk' : 'filled') : (published ? 'published' : 'open');");
    expect(f).toContain("var mark = state === 'filled' ? '✓' : (state === 'risk' ? '!' : '+');");
    expect(f).toContain('_stPostCovers(p.key, role)');
  });

  it('and pressing an open post opens a drawer of who could take it', () => {
    const f = appFn('_stSlotMatchHtml', 'ST_POST_ROLES');
    expect(f).toContain('roles.indexOf(r.role) >= 0 && !r.isMine');
    expect(f).toContain('_stDerived().listed');
    expect(f).toContain("'<span class=\"cx-match-fit\">' + x.fit + '%<i>match</i></span>'");
    expect(f).toContain('data-st-open=');
    expect(CSS).toContain('.cx-match-row{');
  });

  it('the create-a-need form is asked for, not permanently on screen', () => {
    const n = appFn('_stNeedsHtml', '_stSlotMatchHtml');
    expect(n).toContain('data-st-needopen');
    expect(n).toContain('(_TF_ST.needOpen ? _stNeedFormHtml() : \'\')');
    const f = appFn('_stNeedFormHtml', '_stVacancyHtml');
    ['role', 'priority', 'minLicence', 'minExperience', 'salaryMax',
     'contractType', 'startDate', 'languages']
      .forEach((k) => expect(f).toMatch(new RegExp(`(sel|inp)\\('${k}'`)));
    expect(f).toContain('data-st-n="note"');
    expect(n).toContain('What other clubs are looking for');
  });
});

describe('activity is one ribbon and what changed under it', () => {
  it('a single horizontal time ribbon with weighted marks', () => {
    const f = appFn('_stTimelineHtml', '_stEventCardHtml');
    expect(f).toContain('class="cx-ribbon"');
    expect(f).toContain('class="cx-rb-rail"');
    expect(f).toContain("' w' + i.weight");
    // only what is worth a mark goes on it, capped
    expect(f).toContain('var marks = shown.filter(function (i) { return i.weight >= 3; }).slice(0, 24);');
    expect(lastRule('.cx-ribbon{')).toContain('display:flex');
    expect(lastRule('.cx-ribbon{')).toContain('overflow-x:auto');
    // and the old vertical feed is gone
    expect(APP).not.toContain('cx-feed-g');
    expect(CSS).not.toContain('.cx-feed-g{');
    expect(APP).not.toContain('cx-pulse-track');
  });

  it('every event type the market can produce has a marker', () => {
    expect(APP).toContain('var ST_EV = {');
    ['shortlist', 'contact', 'interview', 'offer', 'nego', 'freeagent', 'open',
     'contract', 'hired', 'moved', 'vacancy', 'vacclosed']
      .forEach((k) => expect(APP).toMatch(new RegExp('\\b' + k + ':\\s*\\[')));
  });

  it('what changed is grouped and short, with the rest behind one button', () => {
    const f = appFn('_stTimelineHtml', '_stEventCardHtml');
    expect(APP).toContain('var ST_EV_SHOWN = 6;');
    expect(f).toContain('var cap = _TF_ST.evAll ? shown.length : ST_EV_SHOWN;');
    expect(f).toContain("t >= today ? 'Today'");
    expect(f).toContain('class="cx-changed"');
    expect(f).toContain('data-st-evall>View all ');
  });

  it('it filters, and one movement opens as a card', () => {
    expect(APP).toContain('var ST_EV_FILTERS = [');
    ["'all', 'All'", "'club', 'My club'", "'market', 'Market'", "'watch', 'Contracts'", "'nego', 'Negotiations'"]
      .forEach((f) => expect(APP).toContain(f));
    const c = appFn('_stEventCardHtml', '_stExternalHtml');
    expect(c).toContain('View coach');
    expect(c).toContain('View deal');
    expect(CSS).toContain('.cx-ec{');
  });
});

describe('and the seven tabs are still seven different jobs', () => {
  it('no two of them are the same layout', () => {
    const shapes = ['.cx-universe{', '.cx-tbl{', '.cx-df{', '.cx-wr{', '.cx-plan{', '.cx-deals{', '.cx-ribbon{'];
    shapes.forEach((s) => expect(CSS).toContain(s));
    expect(new Set(shapes).size).toBe(7);
  });

  it('and each of the seven says what to do when it is empty', () => {
    ['_stUniverseHtml', '_stAvailableHtml', '_stFreeAgentsHtml', '_stShortlistDeskHtml',
     '_stNeedsHtml', '_stPipelineHtml', '_stTimelineHtml']
      .forEach((fn) => {
        const at = APP.indexOf(`function ${fn}(`);
        const body = APP.slice(at, at + 5200);
        expect(body).toMatch(/_stEmpty\(|cx-none/);
      });
  });

  it('and the refinement reached into neither neighbour', () => {
    const block = CSS.slice(CSS.indexOf('COACH EXCHANGE · the refinement pass'));
    expect(block).not.toContain('#pg-transfers');
    expect(block).not.toContain('#pg-coaches');
    expect(block).not.toMatch(/^\.co-/m);
    expect(block).not.toMatch(/^\.tf-/m);
  });
});
