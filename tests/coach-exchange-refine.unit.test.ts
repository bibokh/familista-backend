/**
 * tests/coach-exchange-refine.unit.test.ts
 *
 * The Familista Recruitment Command Center.
 *
 * Three things are asserted here, in the order they were fixed.
 *
 * First, the bug: every board used to read its own rows with a different tab=
 * on the query, and repainting is synchronous where the read is not — so
 * opening Shortlist painted the rows the Market floor had left behind and then
 * replaced them. The structural answer is that there is no per-board read at
 * all. The module reads the population once and every board is a memoised
 * filter over that one array.
 *
 * Second, the shaking: a click used to rewrite the whole page — header, tabs
 * and every row — twice per profile open. The shell is now a permanent frame of
 * four addressed elements, and each of them is written only by the thing that
 * owns it. A mode change writes the stage; picking somebody writes the dock;
 * neither writes the other, and nothing writes the shell.
 *
 * Third, the shape: a pulse strip instead of KPI tiles, workspace modes instead
 * of tabs, five intelligence lanes instead of a card wall, and a decision dock
 * that a first click lands in — so inspecting somebody costs no modal at all.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');

function appFn(name: string, until: string) {
  return APP.slice(APP.indexOf(`function ${name}`), APP.indexOf(`function ${until}`));
}
function fnBody(name: string) {
  const at = APP.indexOf(`function ${name}(`);
  if (at < 0) return '';
  let i = APP.indexOf('{', at), depth = 0;
  for (; i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}') { depth--; if (!depth) break; }
  }
  return APP.slice(at, i + 1);
}
function rule(sel: string) {
  const at = CSS.indexOf(sel);
  if (at < 0) return '';
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('one population serves every board', () => {
  it('the module reads it once, and no board can hold another board\'s rows', () => {
    const f = appFn('_stLoadPopulation', '_stLoadMarket');
    expect(f).toContain('var gen = ++_stGen;');
    expect(f).toContain("'?tab=all&sort='");     // the whole market, not one board of it
    const der = appFn('_stDerived', '_stPrepare');
    ['all: rows,', 'listed: listed,', 'freeAgents: rows.filter', 'shortlisted: rows.filter']
      .forEach((k) => expect(der).toContain(k));
  });

  it('and a read that lands after the reader has moved on is dropped', () => {
    const f = appFn('_stLoadPopulation', '_stLoadMarket');
    expect(f.match(/if \(gen !== _stGen\) return;/g)).toHaveLength(2);
  });

  it('every board checks before it draws', () => {
    expect(APP).toContain('function _stCacheWarm()  { return _ST_CACHE.at > 0; }');
    ['_stMarketHtml', '_stAvailableHtml', '_stFreeAgentsHtml', '_stShortlistDeskHtml']
      .forEach((fn) => expect(fnBody(fn).slice(0, 400)).toContain('_stRowsReady()'));
  });

  it('and switching club invalidates everything in flight', () => {
    const f = appFn('_stResetClubScoped', '_thResetRoster');
    expect(f).toContain('_stGen++;');
    expect(f).toContain('_ST_CACHE.at = 0;');
  });
});

describe('a mode change costs nothing', () => {
  it('the module reads once and keeps it', () => {
    expect(APP).toContain('var _ST_CACHE = { at: 0, inflight: null };');
    expect(APP).toContain('var ST_FRESH_MS = 20000;');
    expect(APP).toContain('var ST_STALE_MS = 60000;');
    const s = appFn('_stSyncAll', '_stRevalidate');
    expect(s).toContain('if (_ST_CACHE.inflight && !force) return _ST_CACHE.inflight;');
    expect(s).toContain('if (!force && _stCacheFresh()) return Promise.resolve();');
  });

  it('changing mode writes one element and reads nothing', () => {
    const wire = APP.slice(APP.indexOf("if ((el = t.closest('[data-st-view]')))"),
      APP.indexOf("if ((el = t.closest('[data-st-view]')))") + 1100);
    expect(wire).toContain('_stRepaintBoard();');
    expect(wire).toContain('_stRevalidate();');
    expect(wire).not.toContain('_stLoadMarket()');
    const rb = fnBody('_stRepaintBoard');
    expect(rb).toContain("var board = document.getElementById('cm-board');");
    expect(rb).toContain('_stWrite(board, html)');
    expect(rb).toContain('_stSyncNav();');
  });

  it('a stale board refreshes behind what is shown, never in front of it', () => {
    const r = appFn('_stRevalidate', '_stHtml');
    expect(r).toContain('if (_ST_CACHE.inflight) return;');
    expect(r).toContain('if (Date.now() - _ST_CACHE.at < ST_STALE_MS) return;');
    expect(appFn('_stLoadPopulation', '_stLoadMarket'))
      .toContain('if (!_TF_ST.rows.length) { _TF_ST.rows = []; _TF_ST.total = 0; }');
  });

  it('the derived boards are memoised against the filters that produced them', () => {
    const k = appFn('_stDeriveKey', '_stDerived');
    ['f.search', 'f.role', 'f.status', 'f.clubId', 'f.licence'].forEach((x) => expect(k).toContain(x));
    expect(k).toContain('_TF_ST.rows.length');
    expect(appFn('_stDerived', '_stPrepare'))
      .toContain('if (_TF_ST.derived && _TF_ST.derived.key === key) return _TF_ST.derived;');
    expect(appFn('_stLoadPopulation', '_stLoadMarket')).toContain('_TF_ST.derived = null;');
  });

  it('and searching or filtering is not a network trip', () => {
    const der = appFn('_stDerived', '_stPrepare');
    expect(der).toContain('rows = rows.filter(function (r) { return r.role === f.role; });');
    expect(der).not.toContain('_stApi(');
  });

  it('the lanes are grouped and ranked when the data lands, not on a click', () => {
    const der = appFn('_stDerived', '_stPrepare');
    expect(der).toContain('lanes[L[0]] = listed.filter(L[3]).sort(');
    expect(der).toContain('ladder = listed.slice().sort(');
    expect(APP).toContain('function _stPrepare()');
    expect(appFn('_stLoadPopulation', '_stLoadMarket')).toContain('_stPrepare();');
    // so the board reads a prepared list rather than grouping one
    expect(fnBody('_stMarketHtml')).toContain('d.lanes[L[0]] || []');
    expect(fnBody('_stAvailableHtml')).toContain('d.ladder');
  });
});

describe('the shell is a permanent frame', () => {
  it('four addressed elements, written once', () => {
    const sh = appFn('_stShellHtml', '_stPulseBarHtml');
    ['id="cm-pulse"', 'id="cm-nav"', 'id="cm-board"', 'id="cm-dock"', 'id="cm-tray"']
      .forEach((id) => expect(sh).toContain(id));
    // the board html no longer carries the shell around with it
    expect(fnBody('_stHtml')).not.toContain('_stShellHtml(');
    // and the mode's selected state is a class flip, not a rebuild
    const nav = fnBody('_stSyncNav');
    expect(nav).toContain("btns[i].classList.toggle('is-on', on);");
    expect(nav).not.toContain('innerHTML');
  });

  it('each part is written only by the thing that owns it', () => {
    expect(fnBody('_stRepaintDock'))
      .toContain("_stWrite(document.getElementById('cm-dock'), _stDockHtml());");
    const ov = appFn('_stRepaintOverlay', '_stRepaintChrome');
    expect(ov).toContain("var ov = document.getElementById('cm-overlay');");
    expect(ov).not.toContain('cm-board');
    expect(fnBody('_stRepaintBoard')).not.toContain("getElementById('cm-dock')");
  });

  it('a write that would say the same thing is not made at all', () => {
    const w = appFn('_stWrite', '_stRepaintBoard');
    // the comparison is against the string last written, not innerHTML: reading
    // innerHTML back gives the browser's serialisation, so a valueless
    // data-st-modal comes back as data-st-modal="" and nothing ever matches
    expect(w).toContain("if (el.__stHtml === html && el.innerHTML !== '') return false;");
    expect(w).toContain('el.__stHtml = html;');
  });

  it('and a refresh never takes the caret out of a form somebody is typing into', () => {
    const ov = appFn('_stRepaintOverlay', '_stRepaintChrome');
    expect(ov).toContain('var a = document.activeElement;');
    expect(ov).toContain("if (a && ov.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;");
  });
});

describe('the pulse is a line, and the modes are not tabs', () => {
  it('five readings on one strip, no tiles and no giant numbers', () => {
    const f = fnBody('_stPulseBarHtml');
    ['available', 'open to offers', 'high demand', 'contract watch', 'new this week']
      .forEach((l) => expect(f).toContain("'" + l + "'"));
    // the two the server does not keep are counted off the population in hand
    expect(f).toContain("r.employmentStatus === 'OPEN_TO_OFFERS'");
    expect(f).toContain('(r.clubsWatching || 0) >= 2');
    // and the strip is one line
    expect(rule('.cx-pulsebar{')).toContain('display:flex');
    // the tiles it replaced are gone
    expect(APP).not.toContain('cx-ind--idx');
    expect(CSS).not.toContain('.cx-ind{');
  });

  it('seven workspace modes, drawn as switches rather than as browser tabs', () => {
    expect(APP).toContain('var ST_MODES = [');
    ["'market', 'Market'", "'available', 'Available'", "'free-agents', 'Free agents'",
     "'shortlisted', 'Shortlist'", "'needs', 'Needs'", "'negotiations', 'Deals'",
     "'activity', 'Activity'"].forEach((m) => expect(APP).toContain(m));
    expect(fnBody('_stNavHtml')).toContain('class="cx-mode');
    // no tab strip, no folder shape, no underline
    expect(APP).not.toContain('st-vtab');
    const r = rule('.cx-mode{');
    expect(r).toContain('border-radius:9px');
    expect(r).toContain('border:0');
  });
});

describe('MARKET is a recruitment flow board', () => {
  it('five intelligence lanes, in the order a recruiter asks', () => {
    expect(APP).toContain('var ST_LANES = [');
    ["'hot',   'Hot'", "'open',  'Open to offers'", "'free',  'Available'",
     "'watch', 'Contract watch'", "'new',   'New to market'"]
      .forEach((l) => expect(APP).toContain(l));
    expect(rule('.cx-flow{')).toContain('repeat(5,minmax(0,1fr))');
  });

  it('about five entries a lane, and the rest behind one control', () => {
    expect(APP).toContain('var ST_LANE_ROW = 5;');
    const f = fnBody('_stMarketHtml');
    expect(f).toContain('people.slice(0, ST_LANE_ROW)');
    expect(f).toContain('data-st-laneopen=');
    expect(f).toContain("'+' + more + ' more</button>'");
  });

  it('the unit is a staff strip, not a card', () => {
    const f = fnBody('_stStripHtml');
    expect(f).toContain('class="cx-strip');
    // who he is, the two figures, where he stands, and his movement
    expect(f).toContain('cx-strip-1');
    expect(f).toContain('cx-strip-2');
    expect(f).toContain('cx-strip-3');
    expect(f).toContain('_stMom(r.momentum)');
    expect(rule('.cx-strip{')).toContain('display:flex');
    // and the exchange map it replaced is gone with its tooltip
    expect(APP).not.toContain('function _stNodeHtml');
    expect(APP).not.toContain('function _stUniverseHtml');
    expect(APP).not.toContain('function _stTipShow');
    expect(CSS).not.toContain('.cx-node{');
  });
});

describe('the decision dock is where a first click lands', () => {
  it('it is a permanent column, not a drawer that appears', () => {
    expect(appFn('_stShellHtml', '_stPulseBarHtml')).toContain('class="cx-dock');
    expect(rule('.cx-stage{')).toContain('grid-template-columns:minmax(0,1fr) 336px');
  });

  it('with nobody picked it is market intelligence, four readings deep', () => {
    const f = fnBody('_stDockIntelHtml');
    ['Most wanted', 'Fastest rising', 'Best value', 'Contract risks']
      .forEach((t) => expect(f).toContain("sec('" + t + "'"));
    expect(f).toContain('.slice(0, 3)');
  });

  it('with somebody picked it is him, and the five things a club can do', () => {
    const f = fnBody('_stDockCoachHtml');
    ['FCI', 'Opportunity', 'Reputation'].forEach((k) => expect(f).toContain("fig('" + k + "'"));
    ['Availability', 'Expected', 'Contract', 'Fit'].forEach((k) => expect(f).toContain("kv('" + k + "'"));
    ['Profile', 'Compare', 'Contact', 'Negotiate'].forEach((a) => expect(f).toContain('>' + a + '<'));
    expect(f).toContain('data-st-short=');
  });

  it('a first click selects into the dock and does not open a record', () => {
    const wire = APP.slice(APP.indexOf("if ((el = t.closest('[data-st-lens]')))"),
      APP.indexOf("if ((el = t.closest('[data-st-lens]')))") + 800);
    expect(wire).toContain('_TF_ST.lens = (_TF_ST.lens === _lid) ? null : _lid;');
    expect(wire).toContain('_stRepaintDock(); _stSyncSel(); return;');
    expect(wire).not.toContain('_TF_ST.open');
    // every board's own unit selects rather than opens
    ['_stStripHtml', '_stRungHtml', '_stDeskCardHtml'].forEach((fn) => {
      expect(fnBody(fn)).toContain('data-st-lens=');
      expect(fnBody(fn)).not.toContain('data-st-open=');
    });
    // and marking the selection does not redraw the lane it sits in
    const sel = fnBody('_stSyncSel');
    expect(sel).toContain("classList.toggle('is-on'");
    expect(sel).not.toContain('innerHTML');
  });

  it('and the record is one further, deliberate step', () => {
    expect(fnBody('_stDockCoachHtml')).toContain('data-st-open="');
    const open = APP.slice(APP.indexOf("if ((el = t.closest('[data-st-open]')))"),
      APP.indexOf("if ((el = t.closest('[data-st-open]')))") + 800);
    expect(open).toContain('_stRepaintOverlay();');
    expect(open).not.toContain('_stRepaint();');
    // the record itself is still the dark one it was
    // the last rule for it wins, and that is the geometry the brief asks for
    const geo = CSS.slice(CSS.lastIndexOf('#pg-coach-market .cx-profile{'));
    expect(geo.slice(0, geo.indexOf('}'))).toContain('width:min(1080px, calc(100vw - 48px))');
    expect(geo.slice(0, geo.indexOf('}'))).toContain('height:min(780px, calc(100vh - 48px))');
    expect(rule('#pg-coach-market .tf-modal-bd{')).toContain('rgba(4,7,12,.82)');
  });

  it('it also carries the vacancy, the deal and the movers', () => {
    const d = fnBody('_stDockHtml') + fnBody('_stDockInnerHtml');
    expect(d).toContain('_stDockVacancyHtml()');
    expect(d).toContain('_stDockDealHtml()');
    expect(d).toContain('_stDockMoversHtml()');
    expect(fnBody('_stDockVacancyHtml')).toContain("'<section class=\"cx-dk-sec\"><h5>Best matches</h5>'");
    expect(fnBody('_stDockMoversHtml')).toContain('What moved most');
  });

  it('and it folds away where it has to stack', () => {
    expect(fnBody('_stDockToggleHtml')).toContain('data-st-dock');
    expect(APP).toContain('_TF_ST.dockMin = !_TF_ST.dockMin;');
    expect(CSS).toContain('.cx-dock.is-min .cx-dk-body,');
    expect(CSS).toContain('.cx-dk-toggle{ display:flex; }');
  });
});

describe('every other mode is its own answer', () => {
  it('AVAILABLE is a priority ladder, numbered and capped', () => {
    const f = fnBody('_stAvailableHtml');
    expect(f).toContain('class="cx-ladder"');
    expect(f).toContain('_stRungHtml(r, i + 1)');
    expect(APP).toContain('var ST_PAGE = 8;');
    expect(fnBody('_stRungHtml')).toContain('class="cx-rung-n"');
    expect(rule('.cx-ladder{')).toContain('flex-direction:column');
  });

  it('FREE AGENTS is an immediate hire board, and looks nothing like the ladder', () => {
    const f = fnBody('_stFreeAgentsHtml');
    expect(f).toContain('class="cx-hire"');
    expect(APP).toContain('var ST_FA_PAGE = 6;');
    expect(rule('.cx-hire{')).toContain('repeat(2,minmax(0,1fr))');
    const b = fnBody('_stDossierHtml');
    expect(b).toContain('cx-hb-free">FREE AGENT<');
    ['Last club', 'Experience', 'Licence', 'Expected', 'Opportunity', 'Free since']
      .forEach((l) => expect(b).toContain(`['${l}',`));
    expect(b).toContain('>Inspect<');
    expect(b).toContain('>Approach<');
  });

  it('SHORTLIST is a recruitment room of three sections', () => {
    expect(APP).toContain('var ST_ROOMS = [');
    ["'WATCHING',  'Watching'", "'CONTACTED', 'Contacted'", "'FINAL',     'Final'"]
      .forEach((r) => expect(APP).toContain(r));
    expect(fnBody('_stShortlistDeskHtml')).toContain('class="cx-room"');
    expect(rule('.cx-room{')).toContain('repeat(3,minmax(0,1fr))');
    // and the Kanban board it replaced is gone
    expect(CSS).not.toContain('.cx-wr{');
    expect(APP).not.toContain('cx-wr-col');
  });

  it('NEEDS is a vacancy matrix: teams beside a role grid', () => {
    const f = fnBody('_stNeedsHtml');
    expect(f).toContain('class="cx-matrix"');
    expect(f).toContain('class="cx-mx-teams"');
    expect(f).toContain('class="cx-mx-grid"');
    expect(f).toContain("'FILLED'");
    expect(f).toContain("'CONTRACT ENDING'");
    expect(f).toContain("'VACANT'");
    expect(f).toContain('data-st-slot=');
    expect(rule('.cx-matrix{')).toContain('184px minmax(0,1fr)');
    // and the create form is asked for, not permanently on screen
    expect(f).toContain('data-st-needopen');
    expect(f).toContain("(_TF_ST.needOpen ? _stNeedFormHtml() : '')");
  });

  it('DEALS is a room of tickets, not another Kanban', () => {
    const f = fnBody('_stPipelineHtml');
    expect(f).toContain('class="cx-tickets"');
    expect(f).toContain('_stDealHtml');
    const t = fnBody('_stDealHtml');
    ['Offer', 'Length', 'Bonus', 'Last update', 'Next action']
      .forEach((k) => expect(t).toContain("kv('" + k + "'"));
    expect(t).toContain('>Open deal<');
    expect(CSS).not.toContain('.cx-dr{');
    expect(CSS).not.toContain('.cx-pipe{');
  });

  it('ACTIVITY is a market radar, and only one representation of it', () => {
    const f = fnBody('_stTimelineHtml');
    expect(f).toContain('class="cx-radar"');
    expect(f).toContain('Market radar');
    expect(f).toContain('var strong = shown.filter(function (i) { return i.weight >= 3; });');
    expect(APP).toContain('var ST_EV_SHOWN = 6;');
    expect(f).toContain('data-st-evall');
    // the competing ribbon, feed and pulse track are all gone
    ['cx-ribbon', 'cx-rb-rail', 'cx-pulse-track', 'cx-feed-g'].forEach((c) => expect(APP).not.toContain(c));
  });

  it('and every one of the seven says what to do when it is empty', () => {
    ['_stMarketHtml', '_stAvailableHtml', '_stFreeAgentsHtml', '_stShortlistDeskHtml',
     '_stNeedsHtml', '_stPipelineHtml', '_stTimelineHtml']
      .forEach((fn) => expect(fnBody(fn)).toMatch(/_stEmpty\(/));
    const e = appFn('_stEmpty', '_stFreeAgentsHtml');
    ['cx-none-i', '<b>', 'action'].forEach((x) => expect(e).toContain(x));
  });
});

describe('and the rebuild reached into neither neighbour', () => {
  it('the command centre block names no other module', () => {
    const block = CSS.slice(CSS.indexOf('FAMILISTA RECRUITMENT COMMAND CENTER'));
    expect(block).not.toContain('#pg-transfers');
    expect(block).not.toContain('#pg-coaches');
    expect(block).not.toMatch(/^\.co-/m);
    expect(block).not.toMatch(/^\.tf-/m);
  });

  it('and the module is still the only thing that writes its own state', () => {
    expect(APP).toContain('function _stResetClubScoped()');
    const f = appFn('_stResetClubScoped', '_thResetRoster');
    ['_TF_ST.laneOpen', '_TF_ST.dealLane', '_TF_ST.faPage'].forEach((k) => expect(f).toContain(k));
  });
});
