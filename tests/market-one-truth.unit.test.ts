/**
 * tests/market-one-truth.unit.test.ts
 *
 * One active listing on the server is one active listing on every surface.
 *
 * Reproduced in production: a club listed a player, and its own application
 * then disagreed with itself. Market activity said ACTIVE LISTINGS: 1 and
 * showed him. My activity showed him. The global market board said "No club has
 * a player on the market right now" and the header counted 0 live listings.
 *
 * The cause was one clause. `readMarket` filtered `clubId: { not: actor.clubId
 * }`, so it answered "what may I buy" while everything around it answered "what
 * is on the market": /feed and /my-listings carry a club's own listing, and
 * /auctions has always returned every auction with an `isMine` flag. For the
 * club that had just listed the only player on the platform, those are
 * different answers.
 *
 * Not being allowed to buy your own player is a rule about an action, and it
 * lives where the action is. These tests hold both halves: the row is visible
 * to its own seller and marked as his, and every way of acquiring him is still
 * refused.
 */

const itemFindMany   = jest.fn();
const itemCount      = jest.fn();
const itemFindUnique = jest.fn();
const playerFindUnique = jest.fn();
const clubFindUnique   = jest.fn();
const $transaction     = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    marketplaceItem: {
      findMany:   (...a: unknown[]) => itemFindMany(...a),
      count:      (...a: unknown[]) => itemCount(...a),
      findUnique: (...a: unknown[]) => itemFindUnique(...a),
    },
    player: { findUnique: (...a: unknown[]) => playerFindUnique(...a) },
    club:   { findUnique: (...a: unknown[]) => clubFindUnique(...a) },
    clubTransferBalance: {
      upsert: jest.fn().mockResolvedValue({ budgetEur: 50_000_000n, earnedEur: 0n, spentEur: 0n }),
    },
    $transaction: (...a: unknown[]) => $transaction(...a),
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));

import { readMarket, readOwnListings, purchase } from '../src/transfer-market/transfer-market.service';
import { ForbiddenError } from '../src/utils/errors';
import { readFileSync } from 'fs';
import { join } from 'path';

const SELLER = 'club-seller';
const OTHER  = 'club-other';

const LISTING = {
  id: 'listing-1', kind: 'TRANSFER_LISTING', clubId: SELLER, status: 'ACTIVE',
  validUntil: null, createdAt: new Date(),
  payload: { playerId: 'player-1', askingPriceEur: 34_500_000 },
};

beforeEach(() => {
  jest.clearAllMocks();
  itemFindMany.mockResolvedValue([LISTING]);
  itemCount.mockResolvedValue(1);
  itemFindUnique.mockResolvedValue(LISTING);
  playerFindUnique.mockResolvedValue({
    id: 'player-1', firstName: 'C.', lastName: 'Bibo', number: 9, position: 'ST',
    trainedPositions: null, nationality: 'Brazil', flag: '🇧🇷', avatar: null,
    overallRating: 80, potential: 85, preferredFoot: 'RIGHT', marketValue: 34_500_000,
    contractUntil: null, clubId: SELLER, dateOfBirth: new Date('2001-01-01'),
    roles: null, isActive: true,
  });
  clubFindUnique.mockResolvedValue({ id: SELLER, name: 'FC Seller', shortName: 'SEL', emblem: null });
});

describe('the market answers the same question to everyone', () => {
  it('does not filter the reader\'s own club out of the query', async () => {
    await readMarket({ userId: 'u', clubId: SELLER });
    const where = itemFindMany.mock.calls[0][0].where;
    expect(where.status).toBe('ACTIVE');
    // the clause that made the seller's own market empty
    expect(where.clubId).toBeUndefined();
  });

  it('the seller sees his own active listing on the market', async () => {
    const out = await readMarket({ userId: 'u', clubId: SELLER });
    expect(out.items).toHaveLength(1);
    expect(out.total).toBe(1);
    expect((out.items[0] as { listingId: string }).listingId).toBe('listing-1');
  });

  it('another club sees exactly the same listing', async () => {
    const out = await readMarket({ userId: 'u', clubId: OTHER });
    expect(out.items).toHaveLength(1);
    expect(out.total).toBe(1);
  });

  it('and the count the two of them read is the same number', async () => {
    const mine   = await readMarket({ userId: 'u', clubId: SELLER });
    const theirs = await readMarket({ userId: 'u', clubId: OTHER });
    expect(mine.items.length).toBe(theirs.items.length);
    expect(mine.total).toBe(theirs.total);
  });
});

describe('whose listing it is, is on the row', () => {
  it('marked for the club that owns it', async () => {
    const out = await readMarket({ userId: 'u', clubId: SELLER });
    expect((out.items[0] as { isMine: boolean }).isMine).toBe(true);
  });

  it('and not for anybody else', async () => {
    const out = await readMarket({ userId: 'u', clubId: OTHER });
    expect((out.items[0] as { isMine: boolean }).isMine).toBe(false);
  });

  it('a club\'s own listings surface says the same thing', async () => {
    const out = await readOwnListings({ userId: 'u', clubId: SELLER });
    expect((out.items[0] as { isMine: boolean }).isMine).toBe(true);
  });
});

describe('seeing it is still not buying it', () => {
  it('the seller is refused his own player', async () => {
    await expect(purchase({ userId: 'u', clubId: SELLER }, 'listing-1'))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(purchase({ userId: 'u', clubId: SELLER }, 'listing-1'))
      .rejects.toThrow(/cannot buy its own player/i);
  });

  it('and nothing settles — no transaction is opened at all', async () => {
    await expect(purchase({ userId: 'u', clubId: SELLER }, 'listing-1')).rejects.toThrow();
    expect($transaction).not.toHaveBeenCalled();
  });
});

// ── the screen that draws it ────────────────────────────────────────────────
describe('the client treats an own listing as a listing, not as a purchase', () => {
  const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const bodyOf = (name: string): string | null => {
    const at = APP.indexOf(`\nfunction ${name}(`);
    const as = APP.indexOf(`\nasync function ${name}(`);
    const start = at >= 0 ? at : as;
    if (start < 0) return null;
    let i = APP.indexOf('{', start), depth = 0;
    for (let j = i; j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}') { depth--; if (depth === 0) return APP.slice(i, j + 1); }
    }
    return null;
  };

  it('the lot carries the server\'s answer about whose it is', () => {
    expect(bodyOf('_tfLotFromServer')).toContain('lot.mine = !!rec.isMine;');
  });

  it('the panel for our own listing offers cancelling, not signing', () => {
    expect(APP).toContain('if (p.server && p.mine) {');
    const at = APP.indexOf('if (p.server && p.mine) {');
    const panel = APP.slice(at, APP.indexOf('if (p.server) {', at));
    expect(panel).toContain('YOUR LISTING');
    expect(panel).toContain('data-tf-delist=');
    expect(panel).not.toContain('data-tf-sign=');
  });

  it('signing refuses it even if something reaches that path', () => {
    expect(bodyOf('_tfDoSign')).toContain('if (p.mine)');
  });

  it('the assistant does not recommend a player we already own', () => {
    expect(bodyOf('_tfRecommendations')).toContain('!p.mine');
  });

  it('the live-listings counter is the server\'s count, not the page it sent', () => {
    // /market answers fifty rows at a time; counting those under-reports any
    // market larger than a page, and the counter is a statement about the
    // market.
    const c = bodyOf('_tfLiveListingCount');
    expect(c).toBeTruthy();
    expect(c).toContain('_TF_SERVER_TOTAL');
    expect(APP).toContain('var live = _tfLiveListingCount(C);');
    expect(bodyOf('_tfSyncServerMarket')).toContain('_TF_SERVER_TOTAL = typeof page.total');
  });

  it('and realtime keeps that counter in step with the board it sits above', () => {
    const patch = bodyOf('_tfHeaderPatch');
    expect(patch).toContain('[data-tf-hs="live"]');
    expect(patch).toContain('_tfLiveListingCount');
    expect(APP).toContain('data-tf-hs="live"');
    // the chip already has a width floor, so rewriting it shifts nothing
    const css = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
    expect(css).toMatch(/\.tf-hs\{\s*min-width:104px/);
  });

  it('a listing with no deadline does not read as closed on its own profile', () => {
    // the same rule the board already follows, on the surface that missed it
    const at = APP.indexOf("? '<div><i>' + (p.endsAt == null ? 'Listing' : 'Auction') + '</i>'");
    expect(at).toBeGreaterThan(-1);
    expect(APP.slice(at, at + 400)).toContain("p.endsAt == null ? 'No deadline'");
  });
});
