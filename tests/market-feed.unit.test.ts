/**
 * tests/market-feed.unit.test.ts
 *
 * The market's activity, and the line between what it publishes and what it
 * keeps between two clubs.
 *
 * A football market publishes three things about itself: a club has said what
 * it is looking for, a club has put a player up for sale, and a player has
 * moved for a fee. The negotiation that produced the move is not one of them —
 * who offered what, who countered, who refused reaches the two clubs in it and
 * nobody else. These tests hold that line, and hold the feed to the rows the
 * platform already writes: no event is invented, and no club is.
 */

const needFindMany = jest.fn();
const itemFindMany = jest.fn();
const historyFindMany = jest.fn();
const offerFindMany = jest.fn();
const p2cFindMany = jest.fn();
const clubFindMany = jest.fn();
const clubFindUnique = jest.fn();
const playerFindMany = jest.fn();
const playerFindUnique = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    clubRecruitmentNeed:    { findMany: (...a: unknown[]) => needFindMany(...a) },
    marketplaceItem:        { findMany: (...a: unknown[]) => itemFindMany(...a) },
    athleteTransferHistory: { findMany: (...a: unknown[]) => historyFindMany(...a) },
    transferOffer:          { findMany: (...a: unknown[]) => offerFindMany(...a) },
    playerOfferToClub:      { findMany: (...a: unknown[]) => p2cFindMany(...a) },
    club:   { findMany: (...a: unknown[]) => clubFindMany(...a), findUnique: (...a: unknown[]) => clubFindUnique(...a) },
    player: { findMany: (...a: unknown[]) => playerFindMany(...a), findUnique: (...a: unknown[]) => playerFindUnique(...a) },
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));
jest.mock('./../src/transfer-market/transfer-market.service', () => ({
  getBalance: jest.fn().mockResolvedValue({ availableEur: 50_000_000 }),
}));

import { readMarketFeed, readMarketCompleted } from '../src/transfer-market/transfer-negotiation.service';

const A = 'club-a';     // published the need, bought the striker
const B = 'club-b';     // sold him
const C = 'club-c';     // watched from outside

const actor = (clubId: string) => ({ clubId, userId: 'u-' + clubId, role: 'HEAD_COACH' as never });
const ago = (mins: number) => new Date(Date.now() - mins * 60_000);

const NEED = {
  id: 'need-1', clubId: A, positions: 'ST', ageMin: 18, ageMax: 24, ratingMin: 75, ratingMax: null,
  budgetMinEur: null, budgetMaxEur: 12_000_000n, nationality: null, preferredFoot: 'RIGHT',
  playstyle: null, contractPreference: 'PERMANENT', priority: 'HIGH',
  note: 'CONFIDENTIAL — our wage ceiling is €90k.', isActive: true,
  expiresAt: new Date(Date.now() + 3600_000), createdAt: ago(30), updatedAt: ago(30),
};
const LISTING = {
  id: 'item-1', clubId: B, kind: 'TRANSFER_LISTING', status: 'ACTIVE',
  payload: { playerId: 'p-1', askingPriceEur: 9_000_000 }, createdAt: ago(20),
};
const HISTORY = {
  id: 'hist-1', athleteId: 'p-1', fromClubRef: B, toClubRef: A,
  feeCents: BigInt(870_000_000), currency: 'EUR', occurredAt: ago(5),
  payload: { offerId: 'offer-2', type: 'DIRECT_TRANSFER' },
};
const OFFER = {
  id: 'offer-2', playerId: 'p-1', sellerClubId: B, buyerClubId: A, feeEur: BigInt(8_700_000),
  status: 'ACCEPTED', message: 'Final word: 8.7 and he travels tonight.',
  parentOfferId: 'offer-1', createdByClubId: A, createdById: 'u1',
  respondedAt: ago(5), expiresAt: null, createdAt: ago(9), updatedAt: ago(5),
};
const P2C = {
  id: 'p2c-1', playerId: 'p-1', fromClubId: B, toClubId: A, needId: 'need-1',
  askingPriceEur: BigInt(9_500_000), matchPct: 100, message: null, status: 'CLOSED',
  respondedAt: null, createdById: 'u1', createdAt: ago(10), updatedAt: ago(10),
};
const PLAYER = {
  id: 'p-1', firstName: 'Mohamed', lastName: 'Ali', position: 'ST', overallRating: 81, avatar: null,
};
const CLUBS = [
  { id: A, name: 'FC Nord', shortName: 'NRD', emblem: null },
  { id: B, name: 'FC Familista', shortName: 'FAM', emblem: null },
  { id: C, name: 'FC Marzahn', shortName: 'MRZ', emblem: null },
];

beforeEach(() => {
  jest.clearAllMocks();
  needFindMany.mockResolvedValue([NEED]);
  itemFindMany.mockResolvedValue([LISTING]);
  historyFindMany.mockResolvedValue([HISTORY]);
  clubFindMany.mockResolvedValue(CLUBS);
  clubFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(CLUBS.find((c) => c.id === where.id) ?? null));
  playerFindMany.mockResolvedValue([PLAYER]);
  playerFindUnique.mockResolvedValue(PLAYER);
  // the negotiation belongs to A and B; C is party to nothing
  offerFindMany.mockImplementation(({ where }: { where: { OR: Array<Record<string, string>> } }) => {
    const ids = where.OR.map((o) => Object.values(o)[0]);
    return Promise.resolve(ids.includes(A) || ids.includes(B) ? [OFFER] : []);
  });
  p2cFindMany.mockImplementation(({ where }: { where: { OR: Array<Record<string, string>> } }) => {
    const ids = where.OR.map((o) => Object.values(o)[0]);
    return Promise.resolve(ids.includes(A) || ids.includes(B) ? [P2C] : []);
  });
});

const kinds = (items: Array<{ kind: string }>) => items.map((i) => i.kind);

describe('what the market publishes about itself', () => {
  it('a completed transfer names both clubs and the fee', async () => {
    const feed = await readMarketFeed(actor(C));
    const move = feed.items.find((i) => i.kind === 'TRANSFER_COMPLETED') as never as
      { fromClub: { name: string }; toClub: { name: string }; feeEur: number; scope: string };
    expect(move.fromClub.name).toBe('FC Familista');
    expect(move.toClub.name).toBe('FC Nord');
    expect(move.feeEur).toBe(8_700_000);
    expect(move.scope).toBe('PUBLIC');
  });

  it('a published need and a listing are public too', async () => {
    const feed = await readMarketFeed(actor(C));
    expect(kinds(feed.items)).toEqual(expect.arrayContaining(['NEED_PUBLISHED', 'PLAYER_LISTED']));
    for (const i of feed.items.filter((x) => x.kind !== 'TRANSFER_COMPLETED')) {
      if (i.scope === 'PUBLIC') expect(['NEED_PUBLISHED', 'PLAYER_LISTED']).toContain(i.kind);
    }
  });

  it('the need carries its criteria and never its note', async () => {
    const feed = await readMarketFeed(actor(C));
    const ev = feed.items.find((i) => i.kind === 'NEED_PUBLISHED') as never as
      { need: { positions: string[]; ratingMin: number } };
    expect(ev.need.positions).toEqual(['ST']);
    expect(ev.need.ratingMin).toBe(75);
    expect(JSON.stringify(feed)).not.toContain('CONFIDENTIAL');
    expect(JSON.stringify(feed)).not.toContain('wage ceiling');
  });

  it('every club in the feed comes from the club table', async () => {
    const feed = await readMarketFeed(actor(C));
    const names = JSON.stringify(feed).match(/"name":"([^"]+)"/g) ?? [];
    const known = CLUBS.map((c) => `"name":"${c.name}"`);
    for (const n of names) expect(known).toContain(n);
    // and none of the invented ones the simulated layer used to carry
    for (const fake of ['Northgate United', 'Real Verano', 'AC Meridiano', 'Sporting Aurora', 'FC Nordvik']) {
      expect(JSON.stringify(feed)).not.toContain(fake);
    }
  });

  it('a club reference that no longer resolves is named as unavailable', async () => {
    historyFindMany.mockResolvedValue([{ ...HISTORY, fromClubRef: 'club-deleted' }]);
    const feed = await readMarketFeed(actor(C));
    const move = feed.items.find((i) => i.kind === 'TRANSFER_COMPLETED') as never as { fromClub: { name: string } };
    expect(move.fromClub.name).toBe('Unknown / unavailable club');
  });
});

describe('what stays between the two clubs', () => {
  it('an uninvolved club sees no negotiation at all', async () => {
    const feed = await readMarketFeed(actor(C));
    expect(feed.items.every((i) => i.scope === 'PUBLIC')).toBe(true);
    expect(kinds(feed.items)).not.toContain('OFFER_ACCEPTED');
  });

  it('and never the message inside one', async () => {
    const feed = await readMarketFeed(actor(C));
    expect(JSON.stringify(feed)).not.toContain('he travels tonight');
  });

  it('the two clubs in it do see it, marked as theirs', async () => {
    for (const club of [A, B]) {
      const feed = await readMarketFeed(actor(club));
      const priv = feed.items.filter((i) => i.scope === 'CLUB');
      expect(priv.length).toBeGreaterThan(0);
      expect(priv.every((i) => i.mine)).toBe(true);
      expect(kinds(feed.items)).toContain('OFFER_ACCEPTED');
    }
  });

  it('the club stream is asked for by the caller’s own id, never a parameter', async () => {
    await readMarketFeed(actor(C));
    for (const call of offerFindMany.mock.calls) {
      const ids = call[0].where.OR.map((o: Record<string, string>) => Object.values(o)[0]);
      expect(ids).toEqual([C, C]);
    }
  });

  it('a public event involving my club is marked, but stays public', async () => {
    const feed = await readMarketFeed(actor(A));
    const move = feed.items.find((i) => i.kind === 'TRANSFER_COMPLETED') as never as { mine: boolean; scope: string };
    expect(move.mine).toBe(true);
    expect(move.scope).toBe('PUBLIC');
  });
});

describe('the feed is read, not written', () => {
  it('is bounded, and asks each source once', async () => {
    const feed = await readMarketFeed(actor(A));
    expect(needFindMany).toHaveBeenCalledTimes(1);
    expect(itemFindMany).toHaveBeenCalledTimes(1);
    expect(historyFindMany).toHaveBeenCalledTimes(1);
    expect(offerFindMany).toHaveBeenCalledTimes(1);
    expect(p2cFindMany).toHaveBeenCalledTimes(1);
    // clubs and players resolved in one query each, not one per event
    expect(clubFindMany).toHaveBeenCalledTimes(1);
    expect(playerFindMany).toHaveBeenCalledTimes(1);
    expect(feed.items.length).toBeLessThanOrEqual(60);
    for (const call of [needFindMany, itemFindMany, historyFindMany, offerFindMany, p2cFindMany]) {
      expect(call.mock.calls[0][0].take).toBeLessThanOrEqual(30);
    }
  });

  it('is newest first', async () => {
    const feed = await readMarketFeed(actor(A));
    const times = feed.items.map((i) => new Date(i.at).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('an empty market produces an empty feed, not an invented one', async () => {
    needFindMany.mockResolvedValue([]); itemFindMany.mockResolvedValue([]);
    historyFindMany.mockResolvedValue([]); offerFindMany.mockResolvedValue([]); p2cFindMany.mockResolvedValue([]);
    const feed = await readMarketFeed(actor(C));
    expect(feed.items).toEqual([]);
  });

  it('a transfer is completed because history says so, not because an offer was accepted', async () => {
    historyFindMany.mockResolvedValue([]);                 // settlement never wrote one
    const feed = await readMarketFeed(actor(A));
    expect(kinds(feed.items)).not.toContain('TRANSFER_COMPLETED');
    expect(kinds(feed.items)).toContain('OFFER_ACCEPTED');  // the offer still shows, privately
  });

  it('one settlement is one completed event', async () => {
    const feed = await readMarketFeed(actor(A));
    expect(feed.items.filter((i) => i.kind === 'TRANSFER_COMPLETED')).toHaveLength(1);
  });
});

describe('where players actually went, market-wide', () => {
  it('names both clubs, the fee and the origin', async () => {
    const out = await readMarketCompleted();
    expect(out.items).toHaveLength(1);
    expect(out.items[0].from!.name).toBe('FC Familista');
    expect(out.items[0].to!.name).toBe('FC Nord');
    expect(out.items[0].feeEur).toBe(8_700_000);
    expect(out.items[0].type).toBe('DIRECT_TRANSFER');
  });

  it('carries no negotiation content', async () => {
    const out = await readMarketCompleted();
    expect(JSON.stringify(out)).not.toContain('he travels tonight');
    expect(JSON.stringify(out)).not.toContain('CONFIDENTIAL');
  });
});
