/**
 * tests/coach-exchange-refine.unit.test.ts
 *
 * The refinement pass over the Coach Exchange.
 *
 * The bug this file exists for was real and is the first thing asserted. Every
 * board tab reads one rows array with a different tab= on the query, repainting
 * is synchronous and the read is not — so opening Shortlisted used to paint the
 * forty-five rows the Market floor had left behind and then replace them with
 * the two that are actually shortlisted. Nothing was ever lost; the wrong thing
 * was drawn first. The fix is a generation counter and a record of which tab
 * produced the rows, and both are asserted here rather than described.
 *
 * The rest is shape: the tooltip lives at the end of <body> so no ancestor can
 * clip it, the profile is opaque, and the four remaining surfaces are each the
 * thing they are rather than four card grids.
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

describe('a tab never draws another tab\'s rows', () => {
  it('the rows carry the tab that produced them', () => {
    expect(APP).toContain('rowsFor: null,');
    const f = appFn('_stLoadMarket', '_stRowsReady');
    expect(f).toContain('var gen = ++_stGen;');
    expect(f).toContain('var forView = _TF_ST.view;');
    expect(f).toContain('_TF_ST.rowsFor = forView;');
  });

  it('and a read that lands after the reader has moved on is dropped', () => {
    const f = appFn('_stLoadMarket', '_stRowsReady');
    // three guards: the success path, the failure path and the loading flag
    expect(f.match(/if \(gen !== _stGen\) return;/g)).toHaveLength(2);
    expect(f).toContain('if (gen === _stGen) _TF_ST.loading = false;');
  });

  it('every board tab checks before it draws', () => {
    expect(APP).toContain('function _stRowsReady()');
    expect(APP).toContain('return _TF_ST.rowsFor === _TF_ST.view;');
    ['_stMarketHtml', '_stAvailableHtml', '_stFreeAgentsHtml', '_stShortlistDeskHtml']
      .forEach((fn) => {
        const body = APP.slice(APP.indexOf(`function ${fn}(`), APP.indexOf(`function ${fn}(`) + 900);
        expect(body).toContain('_stRowsReady()');
      });
  });

  it('the war room in particular, because that is where it showed', () => {
    const f = APP.slice(APP.indexOf('function _stShortlistDeskHtml()'));
    expect(f.slice(0, 500)).toContain("if (!_stRowsReady()) return _stReadingHtml('the war room');");
  });

  it('and switching club invalidates everything in flight', () => {
    const f = appFn('_stResetClubScoped', '_thResetRoster');
    expect(f).toContain('_TF_ST.rowsFor = null; _stGen++;');
  });

  it('the fix is state, not a delay or a suppressed refetch', () => {
    const f = appFn('_stLoadMarket', '_stRowsReady');
    expect(f).not.toMatch(/setTimeout/);
    // the read still happens on every tab switch
    const wire = APP.slice(APP.indexOf("if ((el = t.closest('[data-st-view]')))"));
    expect(wire.slice(0, 900)).toContain('_stLoadMarket()');
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

  it('the overview is eight modules, not a form', () => {
    const f = appFn('_stOverviewPanel', '_stCareerPanel');
    ['Professional evaluation', 'Market position', 'Contract &amp; availability', 'Qualifications',
     'Tactical identity', 'Experience', 'Career peak', 'Specialities']
      .forEach((m) => expect(f).toContain(`mod('${m}`));
    expect(CSS).toContain('.cx-pmods{');
    expect(CSS).toContain('.cx-pm{');
  });

  it('and demand is read from the market row, never invented on the profile', () => {
    const f = appFn('_stOverviewPanel', '_stCareerPanel');
    expect(f).toContain("(_TF_ST.rows || []).forEach(function (x) { if (x.staffUserId === d.staffUserId) row = x; });");
    expect(f).toContain("['Clubs watching', row && row.clubsWatching != null ? row.clubsWatching : dash]");
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
    expect(APP).toContain("['DECISION',  'Final decision', ['NEGOTIATION', 'OFFER_SENT']]");
    // nothing was renamed in the database to make the screen read well
    expect(APP).toContain("var ST_STAGE = [");
    expect(APP).toContain("['OFFER_SENT', 'Offer Sent']");
  });

  it('an empty lane is given less room than a busy one', () => {
    const f = appFn('_stShortlistDeskHtml', '_stDeskCardHtml');
    expect(f).toContain('if (!l.people.length) return 2;');
    expect(rule('.cx-wr{')).toContain('repeat(12,1fr)');
    expect(rule('.cx-wr-col{')).toContain('span var(--span');
  });

  it('and a ticket carries what a decision needs', () => {
    const c = appFn('_stDeskCardHtml', '_stPipelineHtml');
    expect(c).toContain('_stScores(r)');            // FCI and opportunity
    expect(c).toContain('_stMom(r.momentum)');      // market movement
    expect(c).toContain('Last contact');
    expect(c).toContain('cx-wr-next');              // the next action
    expect(c).toContain('data-st-pri=');
    expect(c).toContain('data-st-stage=');
    ['Profile', 'Compare', 'Contact', 'Negotiate', 'Remove']
      .forEach((a) => expect(c).toContain('>' + a + '<'));
  });
});

describe('free agents is a deal floor', () => {
  it('compact tickets across the width, not one row each', () => {
    expect(rule('.cx-df{')).toContain('minmax(min(100%,332px),1fr)');
    const f = appFn('_stDossierHtml', '_stMonthsSince');
    expect(f).toContain('cx-dt-body');
    ['Last club', 'Last role', 'Out of work', 'Experience', 'Asking', 'Available', 'Licence', 'Wants']
      .forEach((l) => expect(f).toContain(`['${l}',`));
  });

  it('and a field the record does not hold is left off, not printed as a dash', () => {
    const f = appFn('_stDossierHtml', '_stMonthsSince');
    expect(f).toContain(".filter(function (f) { return f[1] != null && f[1] !== ''; })");
  });

  it('with a market heat indicator read from real interest', () => {
    const f = appFn('_stDossierHtml', '_stMonthsSince');
    expect(f).toContain("var heat = Math.min(4, (r.clubsWatching || 0) + (r.approachCount || 0));");
    expect(CSS).toContain('.cx-dt-heat--4 i{');
  });

  it('and only people with no club and no team are on it', () => {
    const f = APP.slice(APP.indexOf('function _stFreeAgentsHtml()'), APP.indexOf('function _stDossierHtml('));
    expect(f).toContain('r.isFreeAgent && !r.currentClub');
  });
});

describe('staff needs is a demand exchange', () => {
  it('team lanes of slots, not a table', () => {
    const f = appFn('_stGapMapHtml', '_stSlotMatchHtml');
    expect(f).toContain('cx-lane-team');
    expect(f).toContain('cx-slot cx-slot--');
    expect(f).toContain('data-st-slot=');
    expect(CSS).toContain('.cx-slot--open, .cx-slot--published{');
  });

  it('a published vacancy turns an empty seat into an open search', () => {
    const f = appFn('_stGapMapHtml', '_stSlotMatchHtml');
    expect(f).toContain("var state = on ? 'FILLED' : (askedFor ? 'PUBLISHED' : 'OPEN');");
    expect(f).toContain('_stPostCovers(p.key, role)');
  });

  it('and pressing an open slot asks the market who could take it', () => {
    const f = appFn('_stSlotMatchHtml', '_stPostCovers');
    expect(f).toContain('roles.indexOf(r.role) >= 0 && _stOnMarket(r) && !r.isMine');
    expect(f).toContain('data-st-open=');
    expect(CSS).toContain('.cx-match{');
  });

  it('the create-a-need form keeps every real field', () => {
    const f = appFn('_stNeedsHtml', '_stGapMapHtml');
    ['role', 'priority', 'minLicence', 'minExperience', 'minLevel', 'salaryMax',
     'contractType', 'startDate', 'languages', 'note']
      .forEach((k) => expect(f).toContain(`data-st-n="${k}"`));
    expect(f).toContain('What other clubs are looking for');
  });
});

describe('activity is a pulse, not a feed', () => {
  it('one horizontal track with weighted event nodes', () => {
    const f = appFn('_stTimelineHtml', '_stEventCardHtml');
    expect(f).toContain('cx-pulse-track');
    expect(f).toContain('cx-pl-rail');
    expect(f).toContain("' w' + i.weight");
    expect(rule('.cx-pulse-track{')).toContain('display:flex');
    expect(rule('.cx-pulse-track{')).toContain('overflow-x:auto');
    // and the old vertical feed is gone
    expect(APP).not.toContain('cx-feed-g');
    expect(CSS).not.toContain('.cx-feed-g{');
  });

  it('every event type the market can produce has a marker', () => {
    expect(APP).toContain('var ST_EV = {');
    ['shortlist', 'contact', 'interview', 'offer', 'nego', 'freeagent', 'open',
     'contract', 'hired', 'moved', 'vacancy', 'vacclosed']
      .forEach((k) => expect(APP).toMatch(new RegExp('\\b' + k + ':\\s*\\[')));
  });

  it('time is context on the track, not a heading over a list', () => {
    const f = appFn('_stTimelineHtml', '_stEventCardHtml');
    expect(f).toContain('cx-pl-band');
    expect(f).toContain("t >= today ? 'Today'");
  });

  it('it filters, and one movement opens as a card', () => {
    expect(APP).toContain('var ST_EV_FILTERS = [');
    ["'all', 'All'", "'club', 'My club'", "'market', 'Market'", "'watch', 'Contracts'", "'nego', 'Negotiations'"]
      .forEach((f) => expect(APP).toContain(f));
    const c = appFn('_stEventCardHtml', '_stExternalHtml');
    expect(c).toContain('View coach');
    expect(c).toContain('View negotiation');
    expect(CSS).toContain('.cx-ec{');
  });
});

describe('and the seven tabs are still seven different jobs', () => {
  it('no two of them are the same layout', () => {
    const shapes = ['.cx-universe{', '.cx-radar{', '.cx-df{', '.cx-wr{', '.cx-demand{', '.cx-dr{', '.cx-pulse-track{'];
    shapes.forEach((s) => expect(CSS).toContain(s));
    expect(new Set(shapes).size).toBe(7);
  });

  it('and the refinement reached into neither neighbour', () => {
    const block = CSS.slice(CSS.indexOf('COACH EXCHANGE · the refinement pass'));
    expect(block).not.toContain('#pg-transfers');
    expect(block).not.toContain('#pg-coaches');
    expect(block).not.toMatch(/^\.co-/m);
    expect(block).not.toMatch(/^\.tf-/m);
  });
});
