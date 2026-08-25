/**
 * tests/transfers-redesign.unit.test.ts
 *
 * Transfers, presented as four workspaces instead of seven page-like tabs.
 *
 * This was an information-architecture and presentation change, and the thing
 * most worth guarding is that it was ONLY that. Every view still renders
 * through the builder it always rendered through; _TF.tab is still the view key
 * it always was, so the cross-links that set it from elsewhere in the module
 * keep working; and which workspace is on screen is derived from the view
 * rather than stored beside it, because two places holding that answer is how
 * they come to disagree.
 *
 * What is asserted here:
 *   · the four workspaces exist and every one of the seven old views is
 *     reachable through exactly one of them — nothing orphaned;
 *   · the builders, the API calls and the delegated actions are untouched;
 *   · a workspace change writes the body and the switches, not the shell;
 *   · the palette is dark and scoped, so Coach Market cannot be dragged into it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');

function fnBody(name: string) {
  const at = APP.search(new RegExp(`(async )?function ${name}\\s*\\(`));
  if (at < 0) return '';
  let i = APP.indexOf('{', at), depth = 0, j = i;
  for (; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) break;
  }
  return APP.slice(i, j);
}

const OLD_VIEWS = ['auctions', 'feed', 'offers', 'needs', 'activity', 'scouting', 'assistant'];

describe('four workspaces over the seven views', () => {
  it('the four are named, in order', () => {
    const m = APP.match(/var TF_WORKSPACES = \[[\s\S]*?\];/);
    expect(m).toBeTruthy();
    ['market', 'scouting', 'business', 'mine'].forEach((k) => expect(m![0]).toContain(`'${k}'`));
    ['Market', 'Scouting', 'Club business', 'My transfers'].forEach((k) => expect(m![0]).toContain(`'${k}'`));
  });

  it('and every old view lands in exactly one of them — nothing orphaned', () => {
    const map = APP.match(/var TF_VIEW_WS = \{[\s\S]*?\};/)![0];
    OLD_VIEWS.forEach((v) => expect(map).toMatch(new RegExp(`\\b${v}:\\s*'(market|scouting|business|mine)'`)));
    // assistant is folded into scouting, and offers into the club-business
    // board — neither is dropped, and both keys still resolve
    // Each workspace lists the sections it presents. Club business and My
    // transfers present theirs one at a time now, so the list names those
    // sections rather than the single page each used to be — while the old
    // keys stay resolvable through the map above.
    const ws = APP.match(/var TF_WORKSPACES = \[[\s\S]*?\];/)![0];
    ['auctions', 'feed', 'scouting'].forEach((v) => expect(ws).toContain(`'${v}'`));
    ['biz-in', 'biz-out', 'biz-needs', 'biz-interest'].forEach((v) => expect(ws).toContain(`'${v}'`));
    ['mt-action', 'mt-neg', 'mt-sent', 'mt-auc', 'mt-done'].forEach((v) => expect(ws).toContain(`'${v}'`));
    expect(map).toContain("assistant: 'scouting'");
    expect(map).toContain("offers: 'business'");
    // Club business and My transfers were later split into the sections a
    // reader actually asks for one at a time. The two original keys are kept
    // and still resolve to a section, so every cross-link that sets them from
    // elsewhere in the module keeps landing somewhere real.
    expect(fnBody('_tfViewHtml')).toContain("_TF.tab === 'offers'");
    expect(fnBody('_tfViewHtml')).toContain("_TF.tab === 'needs'");
    expect(fnBody('_tfViewHtml')).toContain("_TF.tab === 'activity'");
  });

  it('which workspace is on screen is derived, never stored', () => {
    expect(fnBody('_tfWs')).toContain('TF_VIEW_WS[_TF.tab]');
    // no second field holding the same answer
    expect(APP).not.toMatch(/_TF\.ws\s*=/);
    expect(APP).not.toMatch(/ws:\s*'market'/);
  });

  it('a workspace with one view shows no switch between one thing', () => {
    const f = fnBody('_tfSubSwitchHtml');
    expect(f).toContain('if (views.length < 2) return');
  });
});

describe('nothing underneath was rewritten', () => {
  it('every view still renders, through a builder that reads the same data', () => {
    const f = fnBody('_tfViewHtml');
    // Club business and My transfers are now sectioned, so the two boards they
    // used to be single pages of are drawn by their own builders; every other
    // view still renders through exactly the builder it always did.
    ['_tfFeedHtml', '_tfScoutingHtml', '_tfxMarketHtml', '_tfBizHtml', '_tfMineHtml', '_tfOMBoardHtml']
      .forEach((b) => expect(f).toContain(b));
    // the assistant's builder is still called, from inside scouting
    expect(fnBody('_tfScoutingHtml')).toContain('_tfAssistantHtml(C)');
    // the new builders draw from the module's own reads, computing nothing new
    expect(fnBody('_tfxMarketHtml')).toContain('_tfLots(C)');
    expect(fnBody('_tfxMarketHtml')).toContain('_tfPassFilters(p, C)');
    expect(fnBody('_tfxMarketHtml')).toContain('_tfAucBoardHtml()');
    // the sectioned surfaces read the module's existing loads, computing
    // nothing of their own
    expect(fnBody('_tfBizHtml')).toContain('_tfNegLoadActivity()');
    expect(fnBody('_tfBizHtml')).toContain('_tfO2CLoadBoard()');
    expect(fnBody('_tfBizHtml')).toContain('_tfNegLoadNeeds()');
    expect(fnBody('_tfMineHtml')).toContain('_tfNegLoadActivity()');
    expect(fnBody('_tfMineHtml')).toContain('_tfNegLoadDeals()');
    expect(fnBody('_tfMineHtml')).toContain('_tfOMLoad()');
    expect(fnBody('_tfxNeedListHtml')).toContain('_tfNeedRows().filter(_tfNeedPasses)');
  });

  it('and the presentation is cards and lanes, not a table', () => {
    // the market's own table is gone; the board is a grid of player cards,
    // drawn a page at a time through one builder the repaint shares
    expect(fnBody('_tfxMarketHtml')).toContain('_tfxGridHtml(pool, C)');
    expect(fnBody('_tfxGridHtml')).toContain('_tfxCardHtml(p, C)');
    expect(fnBody('_tfxGridHtml')).toContain('_TFX.all');
    expect(fnBody('_tfxRailHtml')).toContain('_tfxCardHtml(p, C)');
    expect(fnBody('_tfRepaintRows')).toContain('_tfxGridHtml(pool, C)');
    expect(fnBody('_tfxMarketHtml')).not.toContain('<table');
    expect(fnBody('_tfxDiscCardsHtml')).toContain('_tfxDiscCardHtml');
    // a card carries what a recruiter decides on — identity and money come
    // from the two shared blocks, so every card carries the same set
    const c = fnBody('_tfxCardHtml');
    ['_tfxIdentityHtml(p, p.club, p.qual, st)', '_tfxPriceHtml(p.mv, cost',
     '_tfCostOf(p)', '_tfStarBtn(p, C)'].forEach((x) => expect(c).toContain(x));
    expect(fnBody('_tfxPriceHtml')).toContain('<i>value</i>');
    // seven stages, and the desk among them
    const st = APP.match(/var TFX_STAGES = \[[\s\S]*?\];/)![0];
    ['received', 'desk', 'live', 'sent', 'bids', 'done', 'dead']
      .forEach((k) => expect(st).toContain(`'${k}'`));
  });

  it('the player is the visual focus of every card', () => {
    // one identity block, shared by the market, the auctions and scouting, so
    // a footballer is drawn the same way wherever he appears
    const id = fnBody('_tfxIdentityHtml');
    expect(id).toContain("_tfPortrait(p, 'xl')");
    expect(id).toContain('tfx-c-name');
    expect(id).toContain('tfx-ovr');
    ['_tfxCardHtml', '_tfxDiscCardHtml', '_tfAucRowHtml', '_tfxShortCardHtml']
      .forEach((f) => expect(fnBody(f)).toContain('_tfxIdentityHtml('));
    // the portrait is the largest thing on the card and the name reads as one
    expect(CSS).toMatch(/#pg-transfers \.tfx-c-por \.tf-po\{[^}]*width:66px/);
    expect(CSS).toMatch(/#pg-transfers \.tfx-c-name\{[^}]*font-size:15\.5px/);
    expect(CSS).toMatch(/#pg-transfers \.tfx-ovr b\{[^}]*font-size:23px/);
  });

  it('money is type on a baseline, not a pair of grey wells', () => {
    const f = fnBody('_tfxPriceHtml');
    expect(f).toContain('tfx-c-ask');
    expect(f).toContain('tfx-c-val');
    // the sunken two-cell grid the cards used to carry is gone
    expect(APP).not.toContain('tfx-c-money');
    // and the need card's three wells are type now too
    expect(CSS).toMatch(/#pg-transfers \.tf-nd-facts\{[^}]*background:transparent/);
  });

  it('an empty lane is a line, and a busy one gets the room', () => {
    const pipe = fnBody('_tfxPipelineHtml');
    expect(pipe).toContain("(empty ? ' is-empty' : '')");
    expect(pipe).toContain("(rows.length > 3 ? ' is-full' : '')");
    // the board uses the same rule through one lane builder
    expect(fnBody('_tfxBoardHtml')).toContain("(empty ? ' is-empty' : '')");
    expect(CSS).toContain('#pg-transfers .tfx-lane.is-full{ grid-column:span 2; }');
    expect(CSS).toMatch(/#pg-transfers \.tfx-lane\.is-empty \.tfx-lane-h\{/);
  });

  it('a quiet market fills itself from reads it already made', () => {
    const f = fnBody('_tfxQuietMarketHtml');
    // needs, the assistant, the shortlist and the market feed — all existing
    ['_TF_NEG.needs', '_tfRecommendations(C)', '_TF_SCOUT.shortlist', '_TF_NEG.feed']
      .forEach((x) => expect(f).toContain(x));
    // and it still says plainly that nothing is listed
    expect(f).toContain('_tfEmptyMarketMsg([], C)');
    // a section with nothing in it is not drawn at all
    expect(f).toContain('if (!n) return');
  });

  it('advanced scouting filters are disclosed, not removed', () => {
    const f = fnBody('_tfDiscFiltersHtml');
    expect(f).toContain('data-tf-dadv');
    expect(f).toContain('_TF_SCOUT.advOpen || advN > 0');   // a set filter cannot hide
    // every field the panel ever had is still bound to its own key
    ['search', 'position', 'secondaryPosition', 'preferredFoot', 'ageMin', 'ageMax',
     'ovrMin', 'ovrMax', 'valueMin', 'valueMax', 'transferStatus']
      .forEach((k) => expect(f).toContain(`'${k}'`));
    expect(CSS).toContain('#pg-transfers .tf-disc-adv{ display:none; }');
  });

  it('and a live bid still patches the card rather than rebuilding the board', () => {
    const f = fnBody('_tfPatchRow');
    expect(f).toContain(".tfx-c[data-tf-open=");
    expect(f).toContain('.tfx-c-ask b');
    // one place decides live from settled, so a repaint rebuilds what is shown
    const b = fnBody('_tfAucBoardHtml');
    expect(b).toContain("a.status === 'ACTIVE'");
    expect(fnBody('_tfxMarketHtml')).toContain('_tfAucBoardHtml()');
  });

  it('inspecting a player is a docked drawer, not a modal over the board', () => {
    const f = fnBody('_tfDetailHtml');
    expect(f).toContain('tfx-dr-box');
    expect(f).not.toContain("'<div class=\"tf-modal\" data-tf-modal=\"detail\">'");
    // anchored to the page, so it cannot displace the board or hide under the topbar
    expect(CSS).toContain('#pg-transfers .tfx-dr{ position:absolute; inset:0;');
    expect(CSS).toContain('#pg-transfers{ position:relative; }');
  });

  it('the view key is the one the rest of the module already sets', () => {
    // the cross-links that jump into a view from elsewhere still say _TF.tab
    ["_TF.tab = 'auctions'", "_TF.tab = 'needs'", "_TF.tab = 'activity'"]
      .forEach((x) => expect(APP).toContain(x));
  });

  it('the market reads exactly the endpoints it read before', () => {
    const f = fnBody('_tfSyncAll');
    ['_tfSyncServerMarket()', '_tfSyncMyListings()', '_tfSyncBalance()', '_tfNotifLoad()',
     '_tfScoutLoadShortlist()', '_tfDeskLoad()', '_tfNegLoadNeeds()', '_tfNegLoadActivity()',
     '_tfAucLoad()'].forEach((q) => expect(f).toContain(q));
  });

  it('and every action the board offers is still wired', () => {
    ['data-tf-auction-bid', 'data-tf-auction-place', 'data-tf-auction-cancel',
     'data-tf-offer-accept', 'data-tf-offer-reject', 'data-tf-offer-counter', 'data-tf-offer-withdraw',
     'data-tf-need-new', 'data-tf-need-matches', 'data-tf-need-offer', 'data-tf-need-edit',
     'data-tf-short', 'data-tf-sell-open', 'data-tf-delist', 'data-tf-bid',
     'data-tf-open-player', 'data-tf-compare', 'data-tf-sign']
      .forEach((a) => expect(APP).toContain(a));
  });

  it('the eight activity sections and five need views are all still there', () => {
    const acts = APP.match(/var TF_ACT_SECTIONS = \[[\s\S]*?\];/)![0];
    ['desk', 'live', 'sent', 'received', 'auctions', 'bids', 'done', 'dead']
      .forEach((k) => expect(acts).toContain(`'${k}'`));
    const nds = APP.match(/var TF_NEED_VIEWS = \[[\s\S]*?\];/)![0];
    ['all', 'urgent', 'matches', 'mine'].forEach((k) => expect(nds).toContain(`'${k}'`));
  });
});

describe('changing what is on screen does not rebuild the screen', () => {
  it('a view change writes the body and the switches, and nothing else', () => {
    const f = fnBody('_tfGoView');
    expect(f).toContain('_tfRenderBody();');
    expect(f).toContain('_tfSyncSwitches();');
    // the old behaviour: the whole shell, header included, for a change of tab
    expect(f).not.toContain('renderTransfersPage()');
  });

  it('the switches are class toggles, so no element is replaced', () => {
    const f = fnBody('_tfSyncSwitches');
    expect(f).toContain("classList.toggle('is-on'");
    expect(f).not.toContain('innerHTML');
  });

  it('and a workspace click opens that workspace\'s first view', () => {
    const wire = APP.slice(APP.indexOf("if ((el = t.closest('[data-tf-ws]')))"),
                           APP.indexOf("if ((el = t.closest('[data-tf-ws]')))") + 400);
    expect(wire).toContain('_tfWsViews(');
    expect(wire).toContain('_tfGoView(_wsv[0])');
  });
});

describe('the header is compact and premium, and the yellow is gone', () => {
  it('it names the module and the club, and states the five figures', () => {
    const f = fnBody('_tfHeaderHtml');
    expect(f).toContain('<h1>Transfers</h1>');
    expect(f).toContain('State.club && State.club.name');
    ["cell('Transfer budget'", "cell('Committed'", "cell('Available'",
     "cell('Active negotiations'", "cell('Shortlisted'"].forEach((c) => expect(f).toContain(c));
    // the destination selector is kept, compactly
    expect(f).toContain('teamSel');
  });

  it('the header band is no longer a slab of gold', () => {
    const head = CSS.slice(CSS.indexOf('.tf-head{'), CSS.indexOf('.tf-head{') + 320);
    expect(head).not.toContain('var(--tf-gold-hi)');
    expect(head).not.toContain('#8f6d13');
    expect(head).toContain('rgba(22,163,74');
  });

  it('and Transfers now carries a dark palette of its own', () => {
    const block = CSS.slice(CSS.indexOf('#pg-transfers{'), CSS.indexOf('#pg-transfers{') + 2600);
    expect(block).toContain('--tf-page:      #0a0e15');
    expect(block).toContain('--tf-gold:      #16a34a');   // Familista green as the accent
    expect(block).toContain('--tf-ink:       #e9eef6');
  });
});

describe('and the redesign could not reach Coach Market', () => {
  it('every override added for the dark skin names #pg-transfers', () => {
    // bounded to the block itself — everything after it belongs to another
    // module, and slicing to end-of-file would test that module instead
    const from = CSS.indexOf('/* ── Transfers is dark now:');
    const to = CSS.indexOf('/*', CSS.indexOf('#pg-transfers .tf-nd-when b:empty'));
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const tail = CSS.slice(from, to);
    const sels = (tail.match(/([^{}]+)\{/g) || [])
      .map((s) => s.replace(/\{$/, '').trim())
      .filter((s) => s && !s.startsWith('/*'));
    expect(sels.length).toBeGreaterThan(20);
    sels.forEach((s) => expect(s).toContain('#pg-transfers'));
  });

  it('and Coach Market keeps its own palette block untouched', () => {
    const cm = CSS.slice(CSS.indexOf('#pg-coach-market{'), CSS.indexOf('#pg-coach-market{') + 900);
    expect(cm).toContain('--tf-gold:      #10b981');
    expect(cm).toContain('--tf-page:      #0b0f16');
  });
});

describe('empty states are panels, not blank canvases', () => {
  it('the desk offers the two moves that exist from there', () => {
    const f = fnBody('_tfDeskHtml');
    expect(f).toContain('tf-empty');
    expect(f).toContain('data-tf-ws="scouting"');
    expect(f).toContain('data-tf-ws="business"');
  });

  it('and so does the assistant when it has nothing to recommend', () => {
    const f = fnBody('_tfAssistantHtml');
    expect(f).toContain('tf-empty');
    expect(f).toContain('data-tf-dview="search"');
    expect(CSS).toContain('.tf-empty{');
  });
});
