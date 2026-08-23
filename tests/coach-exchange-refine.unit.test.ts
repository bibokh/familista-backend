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

  it('the discovery groups are built when the data lands, not on a click', () => {
    const der = appFn('_stDerived', '_stPrepare');
    expect(der).toContain('lanes[L[0]] = listed.filter(L[2]).sort(');
    expect(der).toContain('ladder = listed.slice().sort(');
    expect(APP).toContain('function _stPrepare()');
    expect(appFn('_stLoadPopulation', '_stLoadMarket')).toContain('_stPrepare();');
    // so a board reads a prepared list rather than grouping one
    expect(fnBody('_stMarketHtml')).toContain('(d.lanes[oppKey] || [])');
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

describe('MARKET answers three questions in order', () => {
  it('recommended, opportunities, and the rest of the market', () => {
    const f = fnBody('_stMarketHtml');
    ['Recommended for your club', 'Market opportunities', 'Explore the market']
      .forEach((h) => expect(f).toContain('<h4>' + h + '</h4>'));
    // the recommendation is matched against the club's own open posts
    expect(f).toContain('(_TF_ST.gap || []).forEach(');
    expect(f).toContain('ST_POST_ROLES[p.key]');
    expect(f).toContain('Fits your open ');
    expect(rule('.cx-rail{')).toContain('repeat(3,minmax(0,1fr))');
  });

  it('four reasons to move on somebody now, and the rest behind one control', () => {
    expect(APP).toContain('var ST_OPPS = [');
    ["'Free agent'", "'Contract ending'", "'Open to offers'", "'Recently available'"]
      .forEach((l) => expect(APP).toContain(l));
    expect(APP).toContain('var ST_EXPLORE = 6;');
    const f = fnBody('_stMarketHtml');
    expect(f).toContain('data-st-opp=');
    expect(f).toContain('data-st-page=');
  });

  it('a candidate reads the same wherever he is found', () => {
    const c = fnBody('_stCandHtml');
    expect(c).toContain('_stFactsHtml(r)');
    expect(c).toContain('_stWhenHtml(r)');
    expect(c).toContain('_stActionsHtml(r)');
    const facts = fnBody('_stFactsHtml');
    ['Club', 'Nationality', 'Age', 'Licence', 'Experience', 'Reputation', 'Expects', 'Speciality']
      .forEach((k) => expect(facts).toContain("add('" + k + "'"));
  });

  it('the actions are ranked rather than lined up', () => {
    const a = fnBody('_stActionsHtml');
    expect(a).toContain('cx-btn cx-btn--primary" data-st-open=');   // primary
    expect(a).toContain('data-st-short=');                          // secondary
    expect(a).toContain('cx-btn--more');                            // tertiary
    ['Compare', 'Contact', 'Start negotiation'].forEach((x) => expect(a).toContain('>' + x + '<'));
    // the menu only exists while it is open, so nothing lingers in the DOM
    expect(a).toContain("_TF_ST.moreFor === r.staffUserId");
    expect(rule('.cx-btn--primary{')).toContain('var(--cx-green)');
    expect(rule('.cx-btn--danger{')).toContain('rgba(240,97,109');
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

  it('every action dialog is built by one function, on a solid surface', () => {
    expect(APP).toContain('function _stDlg(o)');
    ['_stApproachHtml', '_stExternalHtml', '_stNeedFormHtml']
      .forEach((fn) => expect(fnBody(fn)).toContain('_stDlg({'));
    // opaque, deliberately — the offer form used to let the board through
    expect(rule('.cx-dlg-box{')).toContain('background:#141b25');
    expect(rule('.cx-dlg-bd{')).toContain('rgba(3,6,10,.86)');
    // and the player market's glass box is no longer borrowed anywhere here
    const cm = APP.slice(APP.indexOf('function _stDlg(o)'), APP.indexOf('function _stHost()'));
    expect(cm).not.toContain('tf-modal-box');
    // two columns of fields, in named sections
    expect(APP).toContain('function _stDlgSec(title, fields)');
    expect(rule('.cx-fg{')).toContain('grid-template-columns:1fr 1fr');
    const offer = fnBody('_stApproachHtml');
    ['Role', 'Financial', 'Contract', 'Performance bonuses']
      .forEach((sec) => expect(offer).toContain("_stDlgSec('" + sec + "'"));
    ['Cancel', 'Save draft', 'Send offer'].forEach((x) => expect(offer).toContain(x));
  });
});

describe('the decision dock is where a first click lands', () => {
  it('it is a permanent column, not a drawer that appears', () => {
    expect(appFn('_stShellHtml', '_stPulseBarHtml')).toContain('class="cx-dock');
    expect(rule('.cx-stage{')).toContain('grid-template-columns:minmax(0,1fr) 440px');
  });

  it('with nobody picked it is market intelligence, four readings deep', () => {
    const f = fnBody('_stDockIntelHtml');
    ['Most wanted', 'Fastest rising', 'Best value', 'Contract risks']
      .forEach((t) => expect(f).toContain("sec('" + t + "'"));
    expect(f).toContain('.slice(0, 3)');
  });

  it('with somebody picked it is the candidate intelligence drawer', () => {
    const f = fnBody('_stDockCoachHtml');
    ['FCI', 'Opportunity', 'Reputation'].forEach((k) => expect(f).toContain("fig('" + k + "'"));
    ['Availability', 'Expected', 'Contract', 'Nationality', 'Age', 'Speciality']
      .forEach((k) => expect(f).toContain("kv('" + k + "'"));
    // six readings of how he fits, each off a stored figure
    expect(APP).toContain('var ST_ASSESS = [');
    ['Tactical fit', 'Experience', 'Development', 'Leadership', 'Salary', 'Availability']
      .forEach((k) => expect(APP).toContain("['" + k + "',"));
    expect(f).toContain('Quick assessment');
    ['Full profile', 'Compare', 'Contact', 'Start negotiation']
      .forEach((a) => expect(f).toContain(a));
    expect(f).toContain('data-st-short=');
  });

  it('a first click selects into the dock and does not open a record', () => {
    const wire = APP.slice(APP.indexOf("if ((el = t.closest('[data-st-lens]')))"),
      APP.indexOf("if ((el = t.closest('[data-st-lens]')))") + 800);
    expect(wire).toContain('_TF_ST.lens = (_TF_ST.lens === _lid) ? null : _lid;');
    expect(wire).toContain('_stRepaintDock(); _stSyncSel(); return;');
    expect(wire).not.toContain('_TF_ST.open');
    // every board's own unit selects rather than opens
    ['_stStripHtml', '_stRungHtml', '_stCandHtml', '_stDossierHtml', '_stDeskCardHtml']
      .forEach((fn) => expect(fnBody(fn)).toContain('data-st-lens='));
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
    // in Activity it is what a director has to act on, each figure counted
    const att = fnBody('_stDockMoversHtml');
    expect(att).toContain('What needs attention');
    ['awaiting a response', 'for our staff to answer', 'newly on the market',
     'end within six months', 'match a published need']
      .forEach((k) => expect(att).toContain(k));
  });

  it('and it folds away where it has to stack', () => {
    expect(fnBody('_stDockToggleHtml')).toContain('data-st-dock');
    expect(APP).toContain('_TF_ST.dockMin = !_TF_ST.dockMin;');
    expect(CSS).toContain('.cx-dock.is-min .cx-dk-body,');
    expect(CSS).toContain('.cx-dk-toggle{ display:flex; }');
  });
});

describe('every other mode is its own answer', () => {
  it('AVAILABLE is a ranking workspace, numbered and capped', () => {
    const f = fnBody('_stAvailableHtml');
    expect(f).toContain('class="cx-ladder"');
    expect(f).toContain('_stRungHtml(r, i + 1)');
    expect(APP).toContain('var ST_PAGE = 8;');
    const r = fnBody('_stRungHtml');
    expect(r).toContain('class="cx-rung-n"');
    expect(r).toContain('_stFactsHtml(r)');
    expect(r).toContain('_stWhenHtml(r)');
    expect(r).toContain('cx-rung-opp');       // the opportunity reading
    expect(r).toContain('_stActionsHtml(r)');
  });

  it('FREE AGENTS is a scouting board, and looks nothing like the ranking', () => {
    const f = fnBody('_stFreeAgentsHtml');
    expect(f).toContain('class="cx-hire"');
    expect(f).toContain('Free agent pool');
    expect(f).toContain('Immediate hires');
    expect(APP).toContain('var ST_FA_PAGE = 4;');
    ["'opportunity', 'Best available'", "'yearsExperience', 'Most experienced'",
     "'reputation', 'Highest reputation'", "'recent', 'Recently available'"]
      .forEach((o) => expect(APP).toContain(o));
    expect(rule('.cx-hire{')).toContain('repeat(2,minmax(0,1fr))');
    const b = fnBody('_stDossierHtml');
    expect(b).toContain('cx-hb-free">FREE AGENT<');
    ['Previous club', 'Last role', 'Experience', 'Licence', 'Reputation',
     'Expected salary', 'Free since', 'Speciality']
      .forEach((l) => expect(b).toContain(`['${l}',`));
    // recruitment language, on the shared action hierarchy
    expect(b).toContain('_stActionsHtml(r)');
    expect(b).not.toContain('>Inspect<');
    expect(b).not.toContain('>Approach<');
  });

  it('SHORTLIST is a recruitment workspace of five stages', () => {
    expect(APP).toContain('var ST_ROOMS = [');
    ["'WATCHING',    'Watching'", "'CONTACTED',   'Contacted'", "'INTERVIEW',   'Interview'",
     "'NEGOTIATION', 'Negotiation'", "'OFFER_SENT',  'Offer sent'"]
      .forEach((r) => expect(APP).toContain(r));
    expect(fnBody('_stShortlistDeskHtml')).toContain('class="cx-room"');
    expect(CSS).toContain('.cx-room{ grid-template-columns:repeat(5,minmax(0,1fr)); }');
    const c = fnBody('_stDeskCardHtml');
    ['Fit', 'Expects', 'Available', 'Last activity'].forEach((k) => expect(c).toContain('<i>' + k + '</i>'));
    expect(c).toContain('data-st-stage=');       // move stage
    expect(c).toContain('data-st-cmp=');         // compare
    expect(c).toContain('cx-btn--danger');       // remove
    expect(c).toContain('st-pri st-pri--');      // priority
    // and the Kanban board it replaced is gone
    expect(CSS).not.toContain('.cx-wr{');
    expect(APP).not.toContain('cx-wr-col');
  });

  it('NEEDS says who holds each post and what is being recruited', () => {
    const f = fnBody('_stNeedsHtml');
    expect(f).toContain("'FILLED'");
    expect(f).toContain("'CONTRACT ENDING'");
    expect(f).toContain("'VACANT'");
    // the holder's name comes from the club's own staff list
    expect(f).toContain('(_TF_ST.mine && _TF_ST.mine.items) || []');
    expect(f).toContain('holder ? _stEsc(holder.name)');
    // a vacancy says what it needs and offers the two things to do about it
    ['Priority', 'Licence', 'Target start'].forEach((k) => expect(f).toContain('<i>' + k + '</i>'));
    expect(f).toContain('>Find candidates<');
    expect(f).toContain('>Create requirement<');
    expect(f).toContain('data-st-needopen');
    expect(f).toContain("(_TF_ST.needOpen ? _stNeedFormHtml() : '')");
  });

  it('DEALS is a five-stage pipeline with history behind a filter', () => {
    expect(APP).toContain('var ST_DEAL_STAGES = [');
    ["'DRAFT',       'Draft'", "'SENT',        'Sent'", "'VIEWED',      'Viewed'",
     "'NEGOTIATING', 'Negotiating'", "'ACCEPTED',    'Accepted'"]
      .forEach((k) => expect(APP).toContain(k));
    expect(APP).toContain("var ST_DEAL_CLOSED = ['REJECTED', 'WITHDRAWN'];");
    const f = fnBody('_stPipelineHtml');
    expect(f).toContain('class="cx-pipe"');
    expect(f).toContain('data-st-deallane="history"');
    const t = fnBody('_stDealHtml');
    ['Salary', 'Length', 'Start', 'Last update'].forEach((k) => expect(t).toContain("kv('" + k + "'"));
    expect(t).toContain('cx-tk-next');
    expect(t).toContain('>Open deal<');
  });

  it('ACTIVITY is a recruitment activity centre with a period and filters', () => {
    const f = fnBody('_stTimelineHtml');
    expect(f).toContain('class="cx-radar"');
    expect(f).toContain('Recruitment activity');
    expect(f).toContain('data-st-evspan=');
    ["'today', 'Today'", "'week', 'This week'", "'all', 'All'"]
      .forEach((o) => expect(f).toContain(o));
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
    ['_TF_ST.moreFor', '_TF_ST.dealLane', '_TF_ST.faPage', '_TF_ST.opp']
      .forEach((k) => expect(f).toContain(k));
  });
});
