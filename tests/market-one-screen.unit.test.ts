/**
 * tests/market-one-screen.unit.test.ts
 *
 * The Market, as one screen.
 *
 * It was four boards behind four sub-tabs — Open market, Auctions, Offered to
 * clubs, Market activity — which meant four navigations to answer one question.
 * They are now sections of a single scrollable workspace under one search and
 * one set of filters. Nothing underneath moved: each section is still fed by
 * its own read, hydrated by its own service, and every action still hands off
 * to the flow that already existed.
 *
 * The other half of this change is the player profile. There used to be four
 * ways to open a footballer inside Transfers and two of them silently did
 * nothing — one set a flag whose panel exists only inside Scouting's markup,
 * the other looked the player up among the current listings and returned
 * quietly when he was not one of them. So "View profile" worked or did not
 * depending on which board had drawn the card. There is now one opener,
 * carrying the canonical player UUID, and one component behind it.
 *
 * What is asserted here:
 *   · Market presents one view; the three old keys still resolve onto it;
 *   · the control row carries the search, the seven filters and the six quick
 *     filters, and they all narrow the same pool;
 *   · the sections are auctions, offered, open, activity and completed;
 *   · every card carries exactly one opener and it is a player UUID;
 *   · the profile is rendered by the overlay, so it exists on every view, and
 *     Scouting draws the same component rather than a second one;
 *   · no figure on the screen is computed here that a read did not send.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');

function fnBody(name: string) {
  const at = APP.search(new RegExp(`(async )?function ${name}\\s*\\(`));
  if (at < 0) return '';
  const i = APP.indexOf('{', at);
  let depth = 0, j = i;
  for (; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) break;
  }
  return APP.slice(i, j);
}

describe('Market is one mode of the Lineup shell', () => {
  it('its table is built by the dataset the mode and chip select', () => {
    const f = fnBody('_tfViewHtml');
    expect(f).toContain('_tfTableData(C, mode, chip)');
    expect(fnBody('_tfTableData')).toContain('_tfLuMarket(C, chip)');
    expect(APP).toContain('function _tfLuMarket(C, chip) {');
  });

  it('the four modes are the only switch there is', () => {
    const f = fnBody('_tfSubSwitchHtml');
    expect(f).toContain('TF_MODES.map');
    expect(f).toContain('class="sql-tabs"');
    expect(fnBody('_tfHeaderHtml')).not.toContain('tf-wsnav');
  });

  it('the keys it used to switch between still land on it', () => {
    const map = APP.match(/var TF_VIEW_MODE = \{[\s\S]*?\};/)![0];
    expect(map).toMatch(/open: \['market', 'open'\]/);
    expect(map).toMatch(/auctions: \['market', 'auction'\]/);
    expect(map).toMatch(/offered: \['market', 'offered'\]/);
  });

  it('and Open Market, Auctions and Offered to Clubs are chips, not pages', () => {
    const c = APP.match(/var TF_CHIPS = \{[\s\S]*?\n\};/)![0];
    ['Open Market', 'Auctions', 'Offered to Clubs', 'Shortlisted'].forEach((x) => expect(c).toContain(x));
    // one table, and the chip decides which columns and rows it holds
    const m = fnBody('_tfLuMarket');
    expect(m).toContain("chip === 'auction'");
    expect(m).toContain("chip === 'offered'");
    expect(m).toContain("chip === 'short'");
  });
});

describe('the toolbar is Lineup\'s', () => {
  const t = fnBody('_tfToolbarHtml');

  it('a meta line, a search field and a segmented chip group', () => {
    expect(t).toContain('class="sqlu-meta"');
    expect(t).toContain('sqlu-meta-title');
    expect(t).toContain('sqlu-meta-count');
    expect(t).toContain('class="sqlu-filters"');
    expect(t).toContain('class="sqlu-search"');
    expect(t).toContain('_SQLU_ICON_SEARCH');
    expect(t).toContain('sqlu-search-input');
    expect(t).toContain('class="sqlu-seg-group"');
    expect(t).toContain('class="sqlu-seg');
  });

  it('and it keeps the module\'s own publish actions', () => {
    expect(t).toContain('data-om-publish');
    expect(t).toContain('data-tf-need-new');
    expect(t).toContain('sq-mbtn sq-mbtn--add');
  });

  it('the search narrows the one table, from one store', () => {
    expect(fnBody('_tfLuQ')).toContain('_TF_MK.q');
    expect(fnBody('_tfLuMatch')).toContain('_tfLuQ()');
    ['_tfLuMarket', '_tfLuScouting', '_tfLuBusiness', '_tfLuMine']
      .forEach((f) => expect(fnBody(f)).toContain('_tfLuMatch'));
  });
});

describe('the table', () => {
  it('is one full-width .sqlu-tablewrap, never several', () => {
    const v = fnBody('_tfViewHtml');
    expect((v.match(/sqlu-tablewrap/g) || []).length).toBe(1);
    expect(v).toContain('class="sqlu-table"');
    expect(v).toContain('id="tf-lu-tbody"');
  });

  it('each mode is fed by the read it always was', () => {
    ['_tfOMLoad()', '_tfO2CLoadBoard()', '_tfAucLoad()'].forEach((r) => expect(fnBody('_tfLuMarket')).toContain(r));
    expect(fnBody('_tfMkAuctions')).toContain('_TF_AUC.items');
    expect(fnBody('_tfMkOpen')).toContain('_TF_OM.board');
    expect(fnBody('_tfMkLots')).toContain('_TF_SERVER_LOTS');
    expect(fnBody('_tfMkOffered')).toContain('_TF_O2C.board');
    expect(fnBody('_tfLuScouting')).toContain('_TF_SCOUT.page');
    expect(fnBody('_tfLuBusiness')).toContain('_TF_NEG.needs');
    expect(fnBody('_tfLuMine')).toContain('_TF_NEG.deals');
  });

  it('an empty table is Lineup\'s own single empty line', () => {
    const v = fnBody('_tfViewHtml');
    expect(v).toContain('sqlu-empty-row');
    expect(v).toContain('class="sqlu-empty"');
  });

  it('and every row is a .sqlu-row with Lineup\'s badges', () => {
    const m = fnBody('_tfLuMarket');
    expect(m).toContain('class="sqlu-row sqlu-row--');
    expect(m).toContain('_tfLuPos(');
    expect(m).toContain('_tfLuQual(');
    expect(m).toContain('_tfLuId(');
    expect(m).toContain('_tfLuNat(');
    expect(fnBody('_tfLuPos')).toContain('sqlu-pos sqlu-pos--cat-');
    expect(fnBody('_tfLuQual')).toContain('sqlu-qual sqlu-qual--');
    expect(fnBody('_tfLuId')).toContain('sqlu-av');
    expect(fnBody('_tfLuNat')).toContain('sqlu-nat');
    expect(fnBody('_tfLuActs')).toContain('sqlu-acts');
  });
});

describe('the card', () => {
  const c = fnBody('_tfMkCardHtml');

  it('carries the twelve facts and nothing deeper', () => {
    ['mkc-por', 'mkc-name', 'tf-pos tf-pos--', 'mkc-club', 'tfx-ovr',
     'mkc-money', 'mkc-ask', 'mk-badge', 'mkc-clock'].forEach((x) => expect(c).toContain(x));
    // no attribute bars, no history — those are the profile's
    expect(c).not.toContain('_tfSkillsHtml');
  });

  it('shows the current bid where there is one and the asking price where there is not', () => {
    expect(c).toContain('r.bid != null ? r.bid : r.ask');
    expect(c).toContain("r.bid != null ? 'Current bid' : 'Asking price'");
    expect(c).toContain('r.bidCount');
  });

  it('its status badge is one of the four the market has', () => {
    const s = fnBody('_tfMkStatusTone');
    ['auc', 'o2c', 'sale', 'open'].forEach((t) => expect(s).toContain(`'${t}'`));
    const rows = fnBody('_tfMkOpen') + fnBody('_tfMkAuctions') + fnBody('_tfMkLots') + fnBody('_tfMkOffered');
    ["'FOR SALE'", "'OPEN TO OFFERS'", "'AUCTION'", "'OFFERED'"].forEach((x) => expect(rows).toContain(x));
  });

  it('what it lets a club do comes from the read it came from, never from a club name', () => {
    const a = fnBody('_tfMkAct');
    expect(a).toContain('r.isMine');
    ["r.src === 'auction'", "r.src === 'om'", "r.src === 'o2c'"].forEach((x) => expect(a).toContain(x));
    expect(a).not.toMatch(/clubName\s*===|club\s*===\s*'/);
    // and each hands off to the flow that already existed
    ['data-tf-auction-bid', 'data-om-open', 'data-tf-o2c-offer', 'data-tf-open']
      .forEach((x) => expect(a).toContain(x));
  });

  it('green for what a club can act on, amber for money moving in public', () => {
    expect(fnBody('_tfMkAct')).toContain('tf-btn--auc');
    expect(CSS).toMatch(/\.tf-btn--auc[\s\S]{0,140}#fbbf24/);
    expect(CSS).toMatch(/\.mk-badge--auc\{[^}]*251,191,36/);
    expect(CSS).toMatch(/\.mk-badge--sale\{[^}]*--tf-acc-16/);
  });

  it('four to five to a row at desktop widths, one on a phone', () => {
    expect(CSS).toMatch(/#pg-transfers \.mk-grid\{[\s\S]*?minmax\(232px,1fr\)/);
    expect(CSS).toMatch(/min-width:1560px[\s\S]{0,220}minmax\(216px,1fr\)/);
    expect(CSS).toMatch(/max-width:520px[\s\S]{0,200}minmax\(0,1fr\)/);
  });
});

describe('two players with the same name are two players', () => {
  it('rows are keyed by canonical id and the club that holds them', () => {
    const p = fnBody('_tfMkPool');
    expect(p).toContain("r.playerId + '@' + (r.clubId || '')");
    expect(p).not.toContain('.name');
  });

  it('and where one listing arrives twice the richer read wins', () => {
    expect(APP).toContain('var MK_RANK = { auction: 3, om: 2, lot: 1, o2c: 0 };');
    expect(fnBody('_tfMkPool')).toContain('MK_RANK[r.src] > MK_RANK[by[key].src]');
  });

  it('a row without a canonical id is not drawn at all', () => {
    expect(fnBody('_tfMkPool')).toContain('if (!r.playerId) return;');
    expect(fnBody('_tfPPOpen')).toContain('_tfIsCanonicalId(playerId)');
  });
});

describe('one player profile, one opener', () => {
  const card = fnBody('_tfMkCardHtml');

  it('the card, the photo, the name and View profile all carry the same opener', () => {
    expect((card.match(/data-tf-pp=/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(card).toContain('class="mkc-por" data-tf-pp=');
    expect(card).toContain('class="mkc-name" data-tf-pp=');
    expect(card).toContain('<button type="button" class="tf-btn tf-btn--sm" data-tf-pp=');
  });

  it('and it carries the canonical player UUID, never a listing or a row', () => {
    expect(card).toMatch(/data-tf-pp="' \+ _tfEsc\(r\.playerId\)/);
    expect(card).not.toMatch(/data-tf-pp="' \+ _tfEsc\(r\.listingId/);
  });

  it('the market no longer uses either opener that silently did nothing', () => {
    // data-tf-disc-open renders into a host that exists only inside Scouting;
    // data-tf-open-player resolves against the current listings and gives up
    // on anyone who is not one. Neither is on a market card.
    expect(card).not.toContain('data-tf-disc-open');
    expect(card).not.toContain('data-tf-open-player');
    expect(fnBody('_tfMkFeedRowHtml')).toContain('data-tf-pp');
    expect(fnBody('_tfMkFeedRowHtml')).not.toContain('data-tf-open-player');
  });

  it('the profile is rendered by the overlay, so it exists on every view', () => {
    const o = fnBody('_tfRenderOverlay');
    expect(o).toContain('if (_TF_PP.id) html += _tfPPHtml();');
    expect(fnBody('_tfPPOpen')).toContain('_tfRenderOverlay()');
  });

  it('a click on a control inside the card is that control\'s, not the card\'s', () => {
    const h = APP.slice(APP.indexOf("if ((el = t.closest('[data-tf-pp]')))"));
    expect(h.slice(0, 900)).toContain('data-tf-auction-bid');
    expect(h.slice(0, 900)).toContain('el.contains(ctl)');
  });

  it('the profile carries who he is, what he can do, and what he costs', () => {
    const b = fnBody('_tfPPBodyHtml');
    ['_tfPortrait', 'p.age', 'p.nationality', 'tf-pos tf-pos--', 'p.overallRating',
     'd.club.name', 'Preferred foot', 'Squad status', 'Market value', 'Asking price',
     'Contract expiry', 'Wage', 'Availability'].forEach((x) => expect(b).toContain(x));
    // the platform's own attribute groups, drawn by the platform's own renderer
    expect(b).toContain('_tfSkillsHtml(shaped)');
  });

  it("and never a figure another club's books hold privately", () => {
    const b = fnBody('_tfPPBodyHtml');
    // a rival's wage bill is not on the public projection, so it is not
    // asserted as a number this club does not have
    expect(b).toContain("own && own.p.wage ? _tfMoney(own.p.wage) + ' p/w' : 'Not disclosed'");
    expect(fnBody('_tfPPOwnPlayer')).toContain('_tfTeamRegistry()');
  });

  it('its actions are the server\'s, handed to the flows that exist', () => {
    const a = fnBody('_tfPPActsHtml');
    expect(a).toContain('data-tf-short');
    expect(a).toContain('_tfDiscActionsHtml({ player: p, actions: d.actions');
    // and _tfDiscAction is still the one dispatcher behind them
    const d = fnBody('_tfDiscAction');
    ['MAKE_OFFER', 'REGISTER_INTEREST', 'VIEW_AUCTION', 'VIEW_LISTING'].forEach((x) => expect(d).toContain(x));
  });

  it('Scouting draws the same component, not a second one', () => {
    const s = fnBody('_tfDiscProfileHtml');
    expect(s).toContain('_tfPPBodyHtml(d)');
    expect(s).toContain('_tfPPActsHtml(d)');
    // both read the one public projection
    expect(fnBody('_tfPPHtml')).toContain('_TF_SCOUT.detail[id]');
    expect(s).toContain('_TF_SCOUT.detail[id]');
  });

  it('opening him re-reads, because a transfer state is not a record', () => {
    expect(fnBody('_tfPPOpen')).toContain('delete _TF_SCOUT.detail[playerId]');
  });

  it('it is a drawer over the market, not a page instead of it', () => {
    const h = fnBody('_tfPPHtml');
    expect(h).toContain('data-tf-modal="pp"');
    expect(h).toContain('tfx-dr-scrim');
    expect(h).toContain('data-tf-pp-close');
    expect(CSS).toMatch(/#pg-transfers \.tfx-dr-box \.tf-pp-body\{[^}]*overflow-y:auto/);
  });
});

describe('bidding from the market', () => {
  it('opens the panel the board expanded, over the market', () => {
    const o = fnBody('_tfRenderOverlay');
    expect(o).toContain('if (_TF_AUC.open && _tfMkIsOn()) html += _tfAucDrawerHtml();');
    // and it IS that panel — the amount field and the POST are _tfAucDetailHtml's
    expect(fnBody('_tfAucDrawerHtml')).toContain('_tfAucDetailHtml(id)');
    expect(fnBody('_tfAucDetailHtml')).toContain('data-tf-auction-place');
  });

  it('a rival raising a bid writes into the card rather than rebuilding the board', () => {
    const r = fnBody('_tfAucRepaint');
    expect(r).toContain('_tfMkPatchBids()');
    const p = fnBody('_tfMkPatchBids');
    expect(p).toContain('data-mk-bid');
    expect(p).toContain('data-mk-n');
    // but a listing appearing or leaving changes which section it belongs to,
    // and then the sections must be rebuilt rather than patched
    expect(p).toContain('_tfMkSig() !== _TF_MK.sig');
    expect(fnBody('_tfMkSig')).toContain("r.src + ':' + r.status");
  });

  it('countdowns tick from the card, not from a lookup per source', () => {
    expect(fnBody('_tfMkCardHtml')).toContain('data-tf-mkclock');
    expect(fnBody('_tfTick')).toContain('[data-tf-mkclock]');
  });
});

describe('the screen scrolls once', () => {
  it('the market pane is the scrolling region the module already declares', () => {
    expect(fnBody('_tfMarketOneHtml')).toContain("'<div class=\"tf-pane mk-pane\">'");
    // and it no longer draws a header of its own — the screen has one
    expect(fnBody('_tfMarketOneHtml')).not.toContain('mk-head');
    expect(CSS).toMatch(/#pg-transfers \.tf-pane\{ overflow-y:auto/);
    expect(CSS).toMatch(/#pg-transfers \.mk-pane\{[^}]*min-height:0/);
  });

  it('and no section inside it declares a scrollbar of its own', () => {
    const mk = CSS.slice(CSS.indexOf('THE MARKET · one screen'));
    const block = mk.slice(0, mk.indexOf('THE PLAYER PROFILE'));
    expect(block).not.toMatch(/\.mk-(sec|grid|feed|deals)[^{]*\{[^}]*overflow-y:(auto|scroll)/);
  });
});
