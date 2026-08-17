/**
 * tests/market-realtime.unit.test.ts
 *
 * Who hears what, and what travels when they do.
 *
 * The transfer market now announces itself. The thing that makes that safe is
 * that an event is an invalidation and not a copy of state: it names the
 * screens that went stale, and the client answers by re-reading endpoints that
 * were already authorised. So these tests hold two lines. The routing line —
 * a public fact reaches every club, a negotiation reaches exactly two — and
 * the payload line: no fee, no bid, no balance, no message, no note ever goes
 * on the wire, whatever the caller passes.
 */

import {
  publishPublic, publishToClubs, subscribeClub, subscribePublic,
  marketSubscriberCount, MarketEvent,
} from '../src/realtime/market-channel';

import {
  emitListingCreated, emitListingWithdrawn,
  emitAuctionCreated, emitAuctionBid, emitAuctionCancelled, emitAuctionSettled,
  emitInterest, emitInterestAnswered, emitOffer, emitPlayerOffered,
  emitTransferCompleted, emitNeedPublished, emitNeedUpdated, emitNeedClosed,
} from '../src/transfer-market/transfer-events';

jest.mock('../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// One listener per club, plus a listener standing in for "everyone".
function rig() {
  const heard: Record<string, MarketEvent[]> = { A: [], B: [], C: [], PUBLIC: [] };
  const offs = [
    subscribeClub('club-a', (e) => heard.A.push(e)),
    subscribeClub('club-b', (e) => heard.B.push(e)),
    subscribeClub('club-c', (e) => heard.C.push(e)),
    subscribePublic((e) => heard.PUBLIC.push(e)),
  ];
  return { heard, close: () => offs.forEach((f) => f()) };
}

// The only keys an event may carry. "balance" appears as a SURFACE NAME — a
// screen to re-read — and that is the point: the figure itself is never on the
// wire, only the instruction to go and read it. So the check is on the key set
// rather than on the text, which would confuse the two.
const ALLOWED_KEYS = ['kind', 'scope', 'surfaces', 'at', 'playerId', 'listingId', 'offerId', 'needId'];
const expectNoSecrets = (events: MarketEvent[]) => {
  for (const e of events) {
    for (const k of Object.keys(e)) expect(ALLOWED_KEYS).toContain(k);
    // and no value on it is a number, because every figure in this module is
    for (const [k, v] of Object.entries(e)) {
      if (k === 'surfaces') continue;
      expect(typeof v).not.toBe('number');
    }
  }
};

let R: ReturnType<typeof rig>;
beforeEach(() => { R = rig(); });
afterEach(() => { R.close(); });

// ── A · the market is public ────────────────────────────────────────────────
describe('a listing is a public fact', () => {
  it('reaches every connected club, not only the seller', () => {
    emitListingCreated('club-a', 'p1', 'l1');
    expect(R.heard.PUBLIC.map((e) => e.kind)).toContain('LISTING_CREATED');
    expect(R.heard.PUBLIC[0].surfaces).toEqual(expect.arrayContaining(['market', 'feed', 'discover']));
    expect(R.heard.PUBLIC[0].playerId).toBe('p1');
  });

  it('and the seller additionally re-reads its own desk', () => {
    emitListingCreated('club-a', 'p1', 'l1');
    const own = R.heard.A.find((e) => e.scope === 'CLUB')!;
    expect(own.surfaces).toContain('activity');
    // a club that is not the seller gets the public event and no private one
    expect(R.heard.B.filter((e) => e.scope === 'CLUB')).toHaveLength(0);
  });

  it('withdrawal is public too', () => {
    emitListingWithdrawn('club-a', 'p1', 'l1');
    expect(R.heard.PUBLIC.map((e) => e.kind)).toContain('LISTING_WITHDRAWN');
  });
});

// ── B · C · auctions ────────────────────────────────────────────────────────
describe('an auction', () => {
  it('announces itself publicly when it opens', () => {
    emitAuctionCreated('club-a', 'p1', 'l1');
    expect(R.heard.PUBLIC[0].kind).toBe('AUCTION_CREATED');
    expect(R.heard.PUBLIC[0].surfaces).toContain('auctions');
  });

  it('tells the market a bid happened without saying what it was', () => {
    emitAuctionBid('l1', 'p1', 'club-a', 'club-b', null);
    const pub = R.heard.PUBLIC.find((e) => e.kind === 'AUCTION_BID')!;
    expect(pub.surfaces).toEqual(['auctions']);
    expectNoSecrets(R.heard.PUBLIC);
  });

  it('tells the seller and the bidder their own consequences', () => {
    emitAuctionBid('l1', 'p1', 'club-a', 'club-b', null);
    expect(R.heard.A.find((e) => e.scope === 'CLUB')!.surfaces).toContain('notifications');
    expect(R.heard.B.find((e) => e.scope === 'CLUB')!.surfaces).toContain('balance');
  });

  it('and tells whoever was leading that they no longer are', () => {
    emitAuctionBid('l1', 'p1', 'club-a', 'club-b', 'club-c');
    const outbid = R.heard.C.find((e) => e.kind === 'AUCTION_OUTBID')!;
    expect(outbid).toBeTruthy();
    expect(outbid.surfaces).toEqual(expect.arrayContaining(['auctions', 'balance', 'notifications']));
  });

  it('never sends an outbid event to the club that just bid', () => {
    emitAuctionBid('l1', 'p1', 'club-a', 'club-b', 'club-b');
    expect(R.heard.B.map((e) => e.kind)).not.toContain('AUCTION_OUTBID');
  });

  it('a cancellation reaches the market, the seller and every bidder', () => {
    emitAuctionCancelled('l1', 'p1', 'club-a', ['club-b', 'club-c']);
    expect(R.heard.PUBLIC.map((e) => e.kind)).toContain('AUCTION_CANCELLED');
    expect(R.heard.B.find((e) => e.scope === 'CLUB')!.surfaces).toContain('balance');
    expect(R.heard.C.find((e) => e.scope === 'CLUB')!.surfaces).toContain('balance');
  });

  it('a settlement reaches the market, the seller, the winner and the losers', () => {
    emitAuctionSettled('l1', 'p1', 'club-a', 'club-b', ['club-c']);
    expect(R.heard.PUBLIC.map((e) => e.kind)).toContain('AUCTION_SETTLED');
    expect(R.heard.B.find((e) => e.scope === 'CLUB')!.surfaces).toContain('shortlist');
    expect(R.heard.C.find((e) => e.scope === 'CLUB')!.surfaces).toContain('balance');
    expectNoSecrets([...R.heard.PUBLIC, ...R.heard.A, ...R.heard.B, ...R.heard.C]);
  });
});

// ── E · F · I · negotiation is private ──────────────────────────────────────
describe('a negotiation is between two clubs', () => {
  it('an offer reaches the seller and the buyer, and nobody else', () => {
    emitOffer('OFFER_CREATED', 'club-a', 'club-b', 'p1', 'o1');
    expect(R.heard.A).toHaveLength(1);
    expect(R.heard.B).toHaveLength(1);
    expect(R.heard.C).toHaveLength(0);
    expect(R.heard.PUBLIC).toHaveLength(0);
  });

  it('so does a counter, a rejection and a withdrawal', () => {
    emitOffer('OFFER_COUNTERED', 'club-a', 'club-b', 'p1', 'o2');
    emitOffer('OFFER_REJECTED', 'club-a', 'club-b', 'p1', 'o1');
    emitOffer('OFFER_WITHDRAWN', 'club-a', 'club-b', 'p1', 'o1');
    expect(R.heard.C).toHaveLength(0);
    expect(R.heard.PUBLIC).toHaveLength(0);
    expect(R.heard.A.map((e) => e.kind)).toEqual(['OFFER_COUNTERED', 'OFFER_REJECTED', 'OFFER_WITHDRAWN']);
  });

  it('an interest reaches the owner and the interested club only', () => {
    emitInterest('club-a', 'club-b', 'p1');
    expect(R.heard.A).toHaveLength(1);
    expect(R.heard.B).toHaveLength(1);
    expect(R.heard.C).toHaveLength(0);
    expect(R.heard.PUBLIC).toHaveLength(0);
  });

  it('and so does the owner\'s answer to it', () => {
    emitInterestAnswered('club-a', 'club-b', 'p1');
    expect(R.heard.C).toHaveLength(0);
    expect(R.heard.PUBLIC).toHaveLength(0);
  });

  it('offering a player to a club is private to those two', () => {
    emitPlayerOffered('club-a', 'club-b', 'p1', 'need-1');
    expect(R.heard.C).toHaveLength(0);
    expect(R.heard.PUBLIC).toHaveLength(0);
  });

  it('and no figure or message ever travels on any of it', () => {
    emitOffer('OFFER_CREATED', 'club-a', 'club-b', 'p1', 'o1');
    emitOffer('OFFER_COUNTERED', 'club-a', 'club-b', 'p1', 'o2');
    emitInterest('club-a', 'club-b', 'p1');
    expectNoSecrets([...R.heard.A, ...R.heard.B]);
  });
});

// ── G · a completed transfer ────────────────────────────────────────────────
describe('where a player went is public; what it cost is not', () => {
  it('reaches the whole market', () => {
    emitTransferCompleted('club-a', 'club-b', 'p1', { listingId: 'l1' });
    const pub = R.heard.PUBLIC.find((e) => e.kind === 'TRANSFER_COMPLETED')!;
    expect(pub.surfaces).toEqual(expect.arrayContaining(['feed', 'market', 'discover']));
    expect(pub.playerId).toBe('p1');
  });

  it('and the two clubs additionally re-read their own money and lists', () => {
    emitTransferCompleted('club-a', 'club-b', 'p1', { listingId: 'l1' });
    for (const side of [R.heard.A, R.heard.B]) {
      const own = side.find((e) => e.scope === 'CLUB')!;
      expect(own.surfaces).toEqual(expect.arrayContaining(['balance', 'shortlist', 'activity']));
    }
    // an uninvolved club learns the public fact and nothing private
    expect(R.heard.C.filter((e) => e.scope === 'CLUB')).toHaveLength(0);
    expectNoSecrets([...R.heard.PUBLIC, ...R.heard.C]);
  });
});

// ── H · club needs ──────────────────────────────────────────────────────────
describe('a published need is a public statement', () => {
  it('publishing, editing and closing all reach the market', () => {
    emitNeedPublished('club-a', 'need-1');
    emitNeedUpdated('club-a', 'need-1');
    emitNeedClosed('club-a', 'need-1');
    expect(R.heard.PUBLIC.map((e) => e.kind))
      .toEqual(['NEED_PUBLISHED', 'NEED_UPDATED', 'NEED_CLOSED']);
    expect(R.heard.PUBLIC[0].needId).toBe('need-1');
  });

  it('and the private note is not on any of them', () => {
    emitNeedPublished('club-a', 'need-1');
    expectNoSecrets(R.heard.PUBLIC);
  });
});

// ── J · club switching ──────────────────────────────────────────────────────
describe('unsubscribing is complete', () => {
  it('a club that has unsubscribed receives nothing more', () => {
    const got: MarketEvent[] = [];
    const off = subscribeClub('club-x', (e) => got.push(e));
    publishToClubs(['club-x'], { kind: 'OFFER_CREATED', surfaces: ['offers'] });
    expect(got).toHaveLength(1);
    off();
    publishToClubs(['club-x'], { kind: 'OFFER_REJECTED', surfaces: ['offers'] });
    expect(got).toHaveLength(1);
    expect(marketSubscriberCount('club-x')).toBe(0);
  });

  it('and the channel forgets it entirely rather than keeping an empty set', () => {
    const off = subscribeClub('club-y', () => {});
    expect(marketSubscriberCount('club-y')).toBe(1);
    off();
    expect(marketSubscriberCount('club-y')).toBe(0);
  });

  it('a public subscriber that has gone receives nothing more either', () => {
    const got: MarketEvent[] = [];
    const off = subscribePublic((e) => got.push(e));
    publishPublic({ kind: 'LISTING_CREATED', surfaces: ['market'] });
    off();
    publishPublic({ kind: 'LISTING_WITHDRAWN', surfaces: ['market'] });
    expect(got).toHaveLength(1);
  });
});

// ── K · duplicates and delivery ─────────────────────────────────────────────
describe('delivery is forgiving', () => {
  it('a club named twice on one event is told once', () => {
    publishToClubs(['club-a', 'club-a'], { kind: 'OFFER_CREATED', surfaces: ['offers'] });
    expect(R.heard.A).toHaveLength(1);
  });

  it('a null or undefined club is skipped rather than throwing', () => {
    expect(() => publishToClubs([null, undefined, 'club-a'], { kind: 'OFFER_CREATED', surfaces: ['offers'] })).not.toThrow();
    expect(R.heard.A).toHaveLength(1);
  });

  it('one listener that throws never stops the others being told', () => {
    const off = subscribeClub('club-a', () => { throw new Error('bad listener'); });
    expect(() => publishToClubs(['club-a'], { kind: 'OFFER_CREATED', surfaces: ['offers'] })).not.toThrow();
    expect(R.heard.A).toHaveLength(1);
    off();
  });

  it('the same event delivered twice is two invalidations of the same surfaces', () => {
    emitListingCreated('club-a', 'p1', 'l1');
    emitListingCreated('club-a', 'p1', 'l1');
    // identical payloads: the client coalesces them into one re-read
    const [first, second] = R.heard.PUBLIC;
    expect(second.kind).toBe(first.kind);
    expect(second.surfaces).toEqual(first.surfaces);
    expect(second.playerId).toBe(first.playerId);
  });
});

// ── the shape itself ────────────────────────────────────────────────────────
describe('every event', () => {
  it('is stamped with its scope and a time', () => {
    emitListingCreated('club-a', 'p1', 'l1');
    const e = R.heard.PUBLIC[0];
    expect(e.scope).toBe('PUBLIC');
    expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    expect(R.heard.A.find((x) => x.scope === 'CLUB')!.scope).toBe('CLUB');
  });

  it('names surfaces and nothing that could be mistaken for state', () => {
    emitAuctionSettled('l1', 'p1', 'club-a', 'club-b', ['club-c']);
    for (const e of [...R.heard.PUBLIC, ...R.heard.A, ...R.heard.B, ...R.heard.C]) {
      expect(Array.isArray(e.surfaces)).toBe(true);
      expect(Object.keys(e).sort()).toEqual(
        expect.arrayContaining(['at', 'kind', 'scope', 'surfaces']));
      // the only extra keys allowed are already-public identifiers
      for (const k of Object.keys(e)) {
        expect(['at', 'kind', 'scope', 'surfaces', 'playerId', 'listingId', 'offerId', 'needId']).toContain(k);
      }
    }
  });
});
