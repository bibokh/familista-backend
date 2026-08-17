/**
 * tests/no-generated-players.unit.test.ts
 *
 * A footballer who was never a footballer must not reach the Player table.
 *
 * The Group 6 audit found the path: the Scouting tab generated twelve invented
 * players per team, confirming one pushed him into the browser's squad through
 * signPlayer, and the roster bootstrap then wrote that squad to the database as
 * real Player rows. It needed a club that had never hydrated, so it was narrow —
 * but on that path an invented footballer became a real, listable, sellable
 * player.
 *
 * The generator is gone. These tests are the guard against it coming back:
 * they read the shipped client and assert that the invented-club list, the
 * generated market and the scouting pool are not there, that the surfaces which
 * used to call them do not, and that the bootstrap drops anything carrying the
 * transfer module's generated prefix — because a browser can still be holding a
 * squad it saved before this change.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

// The body of a top-level `function name(...) { ... }`, by brace balance.
function bodyOf(name: string): string | null {
  const at = APP.indexOf(`\nfunction ${name}(`);
  if (at < 0) return null;
  let i = APP.indexOf('{', at), depth = 0;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') { depth--; if (depth === 0) return APP.slice(i, j + 1); }
  }
  return null;
}

describe('the invented clubs and the generated market are gone', () => {
  it('the list of made-up club names does not exist any more', () => {
    expect(APP).not.toContain('var TF_CLUBS');
    for (const invented of ['Real Verano', 'AC Meridiano', 'Sporting Aurora', 'FC Nordvik',
                            'Riverport FC', 'Deportivo Cielo', 'Panthera FC']) {
      expect(APP).not.toContain(invented);
    }
  });

  it('the generated auction market and its invented rival bidders are gone', () => {
    expect(bodyOf('_tfMarket')).toBeNull();
    expect(APP).not.toContain('TF_AUCTION_SIZE');
  });

  it('the generated scouting pool and the credits that refreshed it are gone', () => {
    for (const dead of ['_tfScoutGenerate', '_tfScoutPool', '_tfScoutExpired',
                        '_tfSearchCost', '_tfRunSearch', 'TF_SCOUT_SIZE',
                        'TF_SEARCH_COST', 'TF_SCOUT_WINDOW_MS']) {
      expect(APP).not.toContain(dead);
    }
  });
});

describe('Scouting reads the server, not a generator', () => {
  const html = bodyOf('_tfScoutingHtml');

  it('the tab exists and is built from the discovery search', () => {
    expect(html).toBeTruthy();
    expect(APP).toContain("_tfNegApi('GET', '/discover'");
  });

  it('and it constructs no player of its own', () => {
    expect(html).not.toContain('_tfMakePlayer');
    expect(html).not.toContain('_tfScoutPool');
  });

  it('the shortlist is the server\'s, not an object in the page', () => {
    expect(APP).toContain("_tfNegApi('GET', '/shortlist')");
    expect(APP).toContain("_tfNegApi('POST', '/shortlist'");
    // the old per-context browser-only shortlist
    expect(APP).not.toContain('function _tfShort(');
  });
});

describe('a generated player cannot become a Player row', () => {
  it('the signing path refuses anything that is not a real listing', () => {
    const sign = bodyOf('_tfDoSign');
    expect(sign).toBeTruthy();
    // the branch that used to hand an invented footballer to the squad
    expect(sign).not.toContain('C.signPlayer');
    expect(sign).not.toContain('_tfSquadShape');
    expect(sign).toContain('not a real listing and cannot be signed');
  });

  it('the squad-shaped record that carried him into the roster is gone', () => {
    expect(bodyOf('_tfSquadShape')).toBeNull();
  });

  it('the bootstrap drops a generated player a stale browser may still hold', () => {
    const payload = bodyOf('_thBootstrapPayload');
    expect(payload).toBeTruthy();
    expect(payload).toContain('_thIsGeneratedPlayer');
    // both the senior squad and the academy rosters are filtered
    expect((payload!.match(/_thIsGeneratedPlayer/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(bodyOf('_thIsGeneratedPlayer')).toContain('/^sg-/');
  });
});

describe('a real market player carries no invented attribute', () => {
  const lot = bodyOf('_tfLotFromServer');

  it('the lot built from a server listing invents no playstyle, ability or contract', () => {
    expect(lot).toBeTruthy();
    expect(lot).not.toContain('TF_PLAYSTYLES');
    expect(lot).not.toContain('TF_ABILITIES');
    expect(lot).toContain('lot.playstyle = null');
    expect(lot).toContain('lot.special = null');
    expect(lot).toContain('lot.contract = null');
  });

  it('and the market no longer offers a filter over an ability nobody has', () => {
    expect(APP).not.toContain('_tfSpecials');
    expect(APP).not.toContain("f.special !== 'ALL'");
    expect(APP).not.toContain('Special ability</span>');
  });

  it('a wage another club never published reads as undisclosed, not as zero', () => {
    expect(bodyOf('_tfWage')).toContain('Not disclosed');
    expect(lot).toContain('lot.wage = 0');
  });
});

describe('what remains of the generator is the logged-out demo, and only that', () => {
  it('its one caller is the fixture counterparty club', () => {
    const calls = APP.split('\n')
      .map((l, i) => ({ l, i }))
      .filter((r) => r.l.includes('_tfMakePlayer(') && !r.l.includes('function _tfMakePlayer'));
    expect(calls).toHaveLength(1);
    expect(calls[0].l).toContain('rival:');
  });

  it('which keeps its roster in its own store and is never a signing destination', () => {
    expect(APP).toContain('TF_LS_RIVAL');
    expect(bodyOf('_tfTeamRegistry')).not.toContain('TF_RIVAL_CLUB');
  });

  it('and the live market never returns a generated lot', () => {
    const lots = bodyOf('_tfLots');
    expect(lots).toBeTruthy();
    expect(lots).not.toContain('_tfMarket');
    expect(lots).toContain('_TF_SERVER_LOTS');
  });
});
