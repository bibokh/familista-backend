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

describe('the Market is one lane of one screen', () => {
  it('the market lanes are drawn by one builder, told which lane to draw', () => {
    const f = fnBody('_tfViewHtml');
    expect(f).toContain('_tfMarketOneHtml(C, lane)');
    expect(APP).toContain('function _tfMarketOneHtml(C, lane) {');
  });

  it('the filter bar is the only switch there is', () => {
    const f = fnBody('_tfSubSwitchHtml');
    expect(f).toContain('TF_LANES.map');
    expect(fnBody('_tfHeaderHtml')).not.toContain('tf-wsnav');
  });

  it('the keys it used to switch between still land on it', () => {
    const lanes = APP.match(/var TF_VIEW_LANE = \{[\s\S]*?\};/)![0];
    expect(lanes).toMatch(/open: 'market'/);
    expect(lanes).toMatch(/auctions: 'auctions'/);
    expect(lanes).toMatch(/offered: 'offered'/);
    expect(lanes).toMatch(/feed: 'all'/);
  });
});

describe('the control row', () => {
  const ctl = fnBody('_tfMkControlsHtml');

  it('carries a search field and the seven filters', () => {
    expect(ctl).toContain('data-tf-mq');
    ['pos', 'age', 'ovr', 'nat', 'club', 'price', 'avail']
      .forEach((k) => expect(ctl).toMatch(new RegExp(`\\('${k}',`)));
    ['Position', 'Age to', 'OVR from', 'Nationality', 'Club', 'Price to (€M)', 'Availability']
      .forEach((l) => expect(ctl).toContain(l));
  });

  it('and the six quick filters', () => {
    const q = APP.match(/var MK_QUICK = \[[\s\S]*?\];/)![0];
    [['ALL', 'All'], ['SALE', 'For sale'], ['OFFERS', 'Open to offers'],
     ['AUCTION', 'Auctions'], ['OFFERED', 'Offered to us'], ['SOON', 'Expiring soon']]
      .forEach(([k, l]) => { expect(q).toContain(`'${k}'`); expect(q).toContain(`'${l}'`); });
  });

  it('every club and nationality it offers comes from rows the market sent', () => {
    // no hard-coded club list anywhere near the filters
    expect(ctl).toContain('all.forEach');
    expect(ctl).toContain('r.clubId');
    expect(ctl).not.toMatch(/club\s*===\s*'/);
    expect(ctl).not.toMatch(/\bBSC\b|FC Familista/);
  });

  it('they filter one pool, not four boards', () => {
    const m = fnBody('_tfMarketOneHtml');
    expect(m).toContain('pool.filter');
    expect(m).toContain('offered.filter(_tfMkPasses)');
    expect(m).toContain("r.src === 'auction' && _tfMkPasses(r)");
    expect(m).toContain("r.src !== 'auction' && _tfMkPasses(r)");
  });

  it('and a filter never survives as a second copy of the same answer', () => {
    // one store, read by one predicate
    expect(APP).toContain('var _TF_MK = {');
    const p = fnBody('_tfMkPasses');
    expect(p).toContain('_TF_MK.f');
    expect(p).toContain('_TF_MK.q');
    expect(p).toContain('_tfMkQuickPasses(r)');
  });
});

describe('the sections', () => {
  const m = fnBody('_tfMarketOneHtml');

  it('are auctions, offered to your club, the open market, activity and completed', () => {
    expect(m).toContain("_tfMkSecHtml('auctions', 'Live auctions'");
    expect(m).toContain("_tfMkSecHtml('offered', 'Offered to your club'");
    expect(m).toContain("_tfMkSecHtml('open', 'Open market'");
    // activity and completed belong to the overview, not to a named lane
    expect(m).toContain("lane === 'all' ? _tfMkActivityHtml() + _tfMkCompletedHtml() : ''");
  });

  it('each is fed by the read it always was', () => {
    ['_tfOMLoad()', '_tfO2CLoadBoard()', '_tfAucLoad()', '_tfNegLoadFeed()', '_tfNegLoadMarketCompleted()']
      .forEach((r) => expect(m).toContain(r));
    expect(fnBody('_tfMkAuctions')).toContain('_TF_AUC.items');
    expect(fnBody('_tfMkOpen')).toContain('_TF_OM.board');
    expect(fnBody('_tfMkLots')).toContain('_TF_SERVER_LOTS');
    expect(fnBody('_tfMkOffered')).toContain('_TF_O2C.board');
  });

  it('live auctions is drawn only when there are live auctions', () => {
    expect(m).toContain('fAuc.length');
    expect(m).toContain("want('auctions')");
  });

  it('a section with nothing in it is one compact row, never a panel', () => {
    expect(fnBody('_tfMkNoneHtml')).toContain('mk-none');
    expect(CSS).toMatch(/\.mk-none\{[^}]*padding:9px 12px/);
    // a section with nothing in it is not drawn at all unless it is the lane
    // that was asked for, and then it is one line
    expect(m).toContain("lane === 'offered'");
    expect(m).toContain("lane === 'auctions'");
    expect(m).toContain(": ''");
  });

  it('more than fits is expanded inline, never on another page', () => {
    expect(fnBody('_tfMarketOneHtml')).toContain('data-tf-mall');
    expect(APP).toContain("data-tf-mall]'))");
    ['auc', 'o2c', 'om', 'act', 'done'].forEach((k) => expect(APP).toContain(`mk === '${k}'`));
  });

  it('activity is a collapsible panel showing five, not a page', () => {
    const a = fnBody('_tfMkActivityHtml');
    expect(a).toContain('_TF_MK.actOpen');
    expect(a).toContain('rows.slice(0, 5)');
    expect(a).toContain('data-tf-mact');
  });

  it('completed transfers are Player | From | To | Fee | Date, five to begin with', () => {
    const c = fnBody('_tfMkCompletedHtml');
    ['<span>Player</span>', '<span>From</span>', '<span>To</span>', '<b>Fee</b>', '<em>Date</em>']
      .forEach((x) => expect(c).toContain(x));
    expect(c).toContain('deals.slice(0, 5)');
    expect(c).toContain("data-tf-mall=\"done\"");
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
