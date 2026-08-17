/**
 * tests/market-needs-only-a-session.unit.test.ts
 *
 * The transfer market is other clubs' business, answered from the session.
 *
 * It used to be answered only if this browser had first lifted its OWN squad
 * into Player rows. Every read in the module — the market, the auctions, the
 * balance, the needs, the negotiations, the shortlist, the inbox — returned
 * early unless _thIsHydrated(), and _thHydrate() fails for reasons that have
 * nothing to do with the market: a session whose role may not POST /bootstrap,
 * an instance that was asleep and does not answer the roster read inside the
 * request timeout, a club whose player list errors on one page.
 *
 * When it failed, not one transfer request was sent. The header drew 0 live
 * listings, 0 active needs, 0 open negotiations and 0 shortlisted; the table
 * fell through to the browser's own listing store, which is empty; and the
 * budget shown was the demo figure. The server, on that same session, was
 * returning a full market. Nothing on the screen said any of this, and no
 * server-side fix could reach it, because the question was never asked.
 *
 * These tests hold the separation: a signed-in session is all a read needs, a
 * hydrated roster is required only where a canonical player id genuinely is,
 * and a failure to hydrate is stated rather than drawn as zero.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

function bodyOf(name: string): string | null {
  const at = APP.indexOf(`\nfunction ${name}(`);
  const async_ = APP.indexOf(`\nasync function ${name}(`);
  const start = at >= 0 ? at : async_;
  if (start < 0) return null;
  let i = APP.indexOf('{', start), depth = 0;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') { depth--; if (depth === 0) return APP.slice(i, j + 1); }
  }
  return null;
}

describe('what a market read is allowed to require', () => {
  it('there is one test for it, and it is the session', () => {
    const s = bodyOf('_tfHasSession');
    expect(s).toBeTruthy();
    // A session restored from its cookie has a user and no in-memory bearer,
    // so the user counts too.
    expect(s).toContain('S.user');
    expect(s).toContain('S.token');
    expect(s).not.toContain('_thIsHydrated');
  });

  const reads = ['_tfSyncAll', '_tfSyncServerMarket', '_tfSyncBalance', '_tfSyncMyListings', '_tfNotifLoad'];
  it.each(reads)('%s asks for a session and not for a roster', (fn) => {
    const b = bodyOf(fn);
    expect(b).toBeTruthy();
    expect(b).toContain('_tfHasSession()');
    expect(b).not.toContain('_thIsHydrated');
  });

  it('the market on screen is the server\'s whenever there is a session', () => {
    const lots = bodyOf('_tfLots');
    expect(lots).toContain('if (_tfHasSession()) return _TF_SERVER_LOTS.slice();');
    expect(lots).not.toContain('_thIsHydrated');
  });

  it('and an empty market says so instead of promising it is still coming', () => {
    const msg = bodyOf('_tfEmptyMarketMsg');
    expect(msg).toContain('_tfHasSession()');
    expect(msg).not.toContain('_thIsHydrated');
  });

  it('the realtime socket needs its bearer, and nothing about the roster', () => {
    const c = bodyOf('_tfRtConnect');
    expect(c).toBeTruthy();
    expect(c).toContain('if (!State.token) return;');
    expect(c).not.toContain('_thIsHydrated');
  });
});

describe('the boot path reads the market either way', () => {
  it('_tfSyncAll is no longer inside the branch that runs only when the roster loaded', () => {
    const failed = APP.indexOf("showToast('Squad is running locally");
    expect(failed).toBeGreaterThan(-1);
    const sync = APP.indexOf('_tfSyncAll === \'function\') _tfSyncAll();', failed);
    // It appears AFTER the failure branch, so both outcomes reach it.
    expect(sync).toBeGreaterThan(failed);
    // and the ready-only branch no longer holds a copy of its own
    const ready = APP.slice(APP.indexOf("if (_hs === 'ready')"), failed);
    expect(ready).not.toContain('_tfSyncAll');
  });
});

describe('what still genuinely needs the roster', () => {
  it('listing one of our own players, because that needs his canonical id', () => {
    const at = APP.indexOf('var instantSale = ');
    expect(at).toBeGreaterThan(-1);
    const sell = APP.slice(at, at + 1400);
    expect(sell).toContain('_thIsHydrated()');
    expect(sell).toContain('_tfServerList(');
  });
});

describe('a roster that did not load is stated, not drawn as zero', () => {
  it('the page carries a notice naming the call that failed', () => {
    const n = bodyOf('_tfRosterNoticeHtml');
    expect(n).toBeTruthy();
    expect(n).toContain('Your squad has not loaded from the server');
    expect(n).toContain('The market below is live');
    expect(n).toContain('d.step');
    expect(n).toContain('data-tf-roster-retry');
  });

  it('and it keeps one height once shown, so recovering moves nothing', () => {
    const n = bodyOf('_tfRosterNoticeHtml')!;
    // Rendered from "it failed at some point", not from "it is failing now".
    expect(n).toContain('_TH.everFailed');
    expect(n).toContain('Your squad has loaded');
    expect(APP).toContain('_TH.everFailed = true;');
    const css = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
    expect(css).toMatch(/\.tf-roster-notice\{[^}]*min-height:38px/);
  });

  it('the retry is one call the manager can make, and one the page makes on entry', () => {
    expect(bodyOf('_tfRetryRoster')).toContain('_thHydrate()');
    const once = bodyOf('_tfRetryRosterOnce');
    expect(once).toContain('_TF_ROSTER_RETRIED');
    // once per session, not a loop
    expect(once).toContain('if (_TF_ROSTER_RETRIED) return;');
  });
});

describe('the budget on the header says where it came from', () => {
  it('the club\'s real transfer account is not labelled a demo budget', () => {
    const s = bodyOf('_tfBudgetSource');
    expect(s).toBeTruthy();
    expect(s).toContain("src === 'server' ? 'Transfer account'");
    expect(s).toContain("'Club finance'");
    expect(s).toContain("'Demo budget'");
    // and _tfEconomy really does report that source for a server balance
    expect(bodyOf('_tfEconomy')).toContain("source: 'server'");
  });
});
