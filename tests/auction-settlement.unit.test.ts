/**
 * tests/auction-settlement.unit.test.ts
 *
 * An auction that the server holds: the eight things a bid has to satisfy, and
 * the one thing settlement must never do twice.
 *
 * The design being guarded is that the highest bid is not stored anywhere. It
 * is MAX(amountEur) over immutable TransferBid rows, so two clubs bidding at
 * the same instant cannot corrupt it — there is nothing to overwrite. What does
 * race is settlement, and it is claimed the way purchase() already claims a
 * listing: `updateMany` on a row that is still ACTIVE, so exactly one caller
 * can take it and everything else happens inside that transaction.
 *
 * Prisma is mocked, as in the sibling suites. The concurrency here is modelled
 * rather than real: the claim is made to succeed once and report zero rows the
 * second time, which is exactly what Postgres does.
 */

const itemFindUnique = jest.fn();
const itemUpdateMany = jest.fn();
const itemFindMany = jest.fn();
const bidFindFirst = jest.fn();
const bidCreate = jest.fn();
const bidCount = jest.fn();
const bidFindMany = jest.fn();
const playerFindUnique = jest.fn();
const playerUpdate = jest.fn();
const clubFindUnique = jest.fn();
const balanceUpsert = jest.fn();
const contractUpdateMany = jest.fn();
const historyCreate = jest.fn();
const notifCreate = jest.fn();
const membershipFindMany = jest.fn();
const userFindMany = jest.fn();
const teamFindFirst = jest.fn();
const $transaction = jest.fn();

const tx = () => ({
  marketplaceItem:        { findUnique: (...a: unknown[]) => itemFindUnique(...a),
                            updateMany: (...a: unknown[]) => itemUpdateMany(...a),
                            findMany:   (...a: unknown[]) => itemFindMany(...a) },
  transferBid:            { findFirst:  (...a: unknown[]) => bidFindFirst(...a),
                            create:     (...a: unknown[]) => bidCreate(...a),
                            count:      (...a: unknown[]) => bidCount(...a),
                            findMany:   (...a: unknown[]) => bidFindMany(...a) },
  player:                 { findUnique: (...a: unknown[]) => playerFindUnique(...a),
                            update:     (...a: unknown[]) => playerUpdate(...a) },
  clubTransferBalance:    { upsert:     (...a: unknown[]) => balanceUpsert(...a) },
  playerContractStatus:   { updateMany: (...a: unknown[]) => contractUpdateMany(...a),
                            findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  athleteTransferHistory: { create:     (...a: unknown[]) => historyCreate(...a) },
  team:                   { findFirst:  (...a: unknown[]) => teamFindFirst(...a) },
});

jest.mock('../src/config/database', () => ({
  prisma: {
    ...tx(),
    club:             { findUnique: (...a: unknown[]) => clubFindUnique(...a), findMany: jest.fn().mockResolvedValue([]) },
    userNotification: { createMany: (...a: unknown[]) => notifCreate(...a) },
    membership:       { findMany:   (...a: unknown[]) => membershipFindMany(...a) },
    user:             { findMany:   (...a: unknown[]) => userFindMany(...a) },
    $transaction:     (...a: unknown[]) => $transaction(...a),
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));

const getBalance = jest.fn();
jest.mock('../src/transfer-market/transfer-market.service', () => ({
  getBalance: (...a: unknown[]) => getBalance(...a),
  setAvailability: jest.fn(),
  defaultTeamFor: jest.fn().mockResolvedValue({ id: 'team-buyer' }),
  findActiveListingForPlayer: jest.fn().mockResolvedValue(null),
}));

import { placeBid, settleAuction, requiredBid } from '../src/transfer-market/transfer-auction.service';

const SELLER = 'club-a';
const B = 'club-b';
const C = 'club-c';
const LISTING = 'listing-1';

const actor = (clubId: string) => ({ clubId, userId: 'u-' + clubId, role: 'HEAD_COACH' });

const AUCTION = {
  id: LISTING, clubId: SELLER, kind: 'TRANSFER_LISTING', title: 'Player X · ST',
  status: 'ACTIVE', validFrom: new Date(Date.now() - 60_000),
  validUntil: new Date(Date.now() + 900_000),
  payload: { playerId: 'p-1', sellerClubId: SELLER, mode: 'AUCTION', startingPriceEur: 5_000_000, askingPriceEur: 5_000_000 },
  winnerClubId: null, finalPriceEur: null, settledAt: null,
  createdById: 'u1', createdAt: new Date(), updatedAt: new Date(), description: null,
};
const PLAYER = {
  id: 'p-1', clubId: SELLER, firstName: 'Player', lastName: 'X', position: 'ST',
  overallRating: 80, marketValue: 5_000_000, teamId: 'team-seller', isActive: true,
};
const bid = (club: string, amount: number, id = 'bid-' + club) => ({
  id, listingId: LISTING, bidderClubId: club, amountEur: BigInt(amount),
  createdById: 'u', createdAt: new Date(),
});

beforeEach(() => {
  jest.clearAllMocks();
  itemFindUnique.mockResolvedValue(AUCTION);
  itemFindMany.mockResolvedValue([]);                 // no other live auctions
  playerFindUnique.mockResolvedValue(PLAYER);
  playerUpdate.mockResolvedValue(PLAYER);
  clubFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve({ id: where.id, name: where.id.toUpperCase() }));
  getBalance.mockResolvedValue({ availableEur: 50_000_000 });
  bidFindFirst.mockResolvedValue(null);               // no bids yet
  bidFindMany.mockResolvedValue([]);
  bidCount.mockResolvedValue(0);
  bidCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'bid-new', ...data, createdAt: new Date() }));
  itemUpdateMany.mockResolvedValue({ count: 1 });
  balanceUpsert.mockResolvedValue({});
  contractUpdateMany.mockResolvedValue({ count: 1 });
  historyCreate.mockResolvedValue({ id: 'hist-1' });
  teamFindFirst.mockResolvedValue({ id: 'team-buyer' });
  membershipFindMany.mockResolvedValue([{ userId: 'user-1' }]);
  userFindMany.mockResolvedValue([{ id: 'user-1' }]);
  notifCreate.mockResolvedValue({ count: 1 });
  $transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx()));
});

describe('the minimum next bid', () => {
  it('is the starting price when nobody has bid', () => {
    expect(requiredBid(5_000_000, null)).toBe(5_000_000);
  });
  it('and a step above the highest once someone has', () => {
    expect(requiredBid(5_000_000, 6_000_000)).toBeGreaterThan(6_000_000);
  });
  it('the same inputs always give the same number', () => {
    expect(requiredBid(5_000_000, 6_000_000)).toBe(requiredBid(5_000_000, 6_000_000));
  });
});

describe('what a bid has to satisfy', () => {
  it('the seller cannot bid on his own player', async () => {
    await expect(placeBid(actor(SELLER), LISTING, 6_000_000)).rejects.toThrow(/cannot bid on its own/i);
    expect(bidCreate).not.toHaveBeenCalled();
  });

  it('a club that is not in the club table cannot bid', async () => {
    clubFindUnique.mockResolvedValue(null);
    await expect(placeBid(actor('ghost'), LISTING, 6_000_000)).rejects.toThrow(/unknown club/i);
    expect(bidCreate).not.toHaveBeenCalled();
  });

  it('an expired auction takes no bid', async () => {
    itemFindUnique.mockResolvedValue({ ...AUCTION, validUntil: new Date(Date.now() - 1000) });
    await expect(placeBid(actor(B), LISTING, 6_000_000)).rejects.toThrow(/closed/i);
    expect(bidCreate).not.toHaveBeenCalled();
  });

  it('so does one that is already settled or cancelled', async () => {
    for (const status of ['SOLD', 'UNSOLD', 'CANCELLED', 'CLOSED']) {
      itemFindUnique.mockResolvedValue({ ...AUCTION, status });
      await expect(placeBid(actor(B), LISTING, 6_000_000)).rejects.toThrow(/no longer open/i);
    }
    expect(bidCreate).not.toHaveBeenCalled();
  });

  it('a bid below the starting price is refused', async () => {
    await expect(placeBid(actor(B), LISTING, 4_000_000)).rejects.toThrow(/at least/i);
    expect(bidCreate).not.toHaveBeenCalled();
  });

  it('so is one that only equals the highest', async () => {
    bidFindFirst.mockResolvedValue(bid(B, 6_000_000));
    await expect(placeBid(actor(C), LISTING, 6_000_000)).rejects.toThrow(/at least/i);
    expect(bidCreate).not.toHaveBeenCalled();
  });

  it('a club that cannot afford it is refused', async () => {
    getBalance.mockResolvedValue({ availableEur: 1_000_000 });
    await expect(placeBid(actor(B), LISTING, 6_000_000)).rejects.toThrow(/insufficient/i);
    expect(bidCreate).not.toHaveBeenCalled();
  });

  it('a player the seller no longer owns cannot be bid on', async () => {
    playerFindUnique.mockResolvedValue({ ...PLAYER, clubId: 'someone-else' });
    await expect(placeBid(actor(B), LISTING, 6_000_000)).rejects.toThrow(/no longer belongs/i);
    expect(bidCreate).not.toHaveBeenCalled();
  });

  it('a valid bid is written with the bidder resolved from the session', async () => {
    await placeBid(actor(B), LISTING, 6_000_000);
    const data = bidCreate.mock.calls[0][0].data;
    expect(data.listingId).toBe(LISTING);
    expect(data.bidderClubId).toBe(B);
    expect(data.amountEur).toBe(BigInt(6_000_000));
    // the bid carries no copy of the player or the seller — both are the listing's
    expect(data).not.toHaveProperty('playerId');
    expect(data).not.toHaveProperty('sellerClubId');
  });

  it('the seller is told, and the club that led is told it no longer does', async () => {
    bidFindFirst.mockResolvedValue(bid(B, 6_000_000));
    await placeBid(actor(C), LISTING, 7_000_000);
    const targets = notifCreate.mock.calls.flatMap((c) => {
      const d = c[0].data; return (Array.isArray(d) ? d : [d]).map((r: { clubId: string; kind: string }) => r.clubId + ':' + r.kind);
    });
    expect(targets).toEqual(expect.arrayContaining([SELLER + ':AUCTION_BID_RECEIVED', B + ':AUCTION_LOST']));
  });
});

describe('two clubs bidding at the same instant', () => {
  it('both bids are written, and neither overwrites anything', async () => {
    // B and C both read the same "no bids yet" state, then both insert
    await placeBid(actor(B), LISTING, 6_000_000);
    bidFindFirst.mockResolvedValue(bid(B, 6_000_000));
    await placeBid(actor(C), LISTING, 7_000_000);

    expect(bidCreate).toHaveBeenCalledTimes(2);
    const amounts = bidCreate.mock.calls.map((c) => Number(c[0].data.amountEur));
    expect(amounts).toEqual([6_000_000, 7_000_000]);
    // nothing was updated — a bid is an insert, so there is no lost update
    expect(itemUpdateMany).not.toHaveBeenCalled();
  });

  it('the highest is read back, never stored', async () => {
    bidFindMany.mockResolvedValue([bid(C, 7_000_000, 'bid-c'), bid(B, 6_000_000, 'bid-b')]);
    bidFindFirst.mockResolvedValue(bid(C, 7_000_000, 'bid-c'));
    bidCount.mockResolvedValue(2);
    itemFindUnique.mockResolvedValue({ ...AUCTION, validUntil: new Date(Date.now() - 1000) });

    const out = await settleAuction(LISTING);
    expect(out.status).toBe('SOLD');
    const claim = itemUpdateMany.mock.calls[0][0];
    expect(claim.data.winnerClubId).toBe(C);
    expect(Number(claim.data.finalPriceEur)).toBe(7_000_000);
  });
});

describe('settlement', () => {
  const expired = { ...AUCTION, validUntil: new Date(Date.now() - 1000) };

  beforeEach(() => {
    itemFindUnique.mockResolvedValue(expired);
    bidFindFirst.mockResolvedValue(bid(C, 7_000_000, 'bid-c'));
    bidCount.mockResolvedValue(2);
    bidFindMany.mockResolvedValue([bid(B, 6_000_000, 'bid-b')]);
  });

  it('moves the player exactly once, to the winner', async () => {
    await settleAuction(LISTING);
    expect(playerUpdate).toHaveBeenCalledTimes(1);
    expect(playerUpdate.mock.calls[0][0]).toMatchObject({ where: { id: 'p-1' }, data: { clubId: C } });
  });

  it('charges the winner once and credits the seller once', async () => {
    await settleAuction(LISTING);
    expect(balanceUpsert).toHaveBeenCalledTimes(2);
    const [buyerCall, sellerCall] = balanceUpsert.mock.calls.map((c) => c[0]);
    expect(buyerCall.where.clubId).toBe(C);
    expect(buyerCall.update.spentEur.increment).toBe(BigInt(7_000_000));
    expect(sellerCall.where.clubId).toBe(SELLER);
    expect(sellerCall.update.earnedEur.increment).toBe(BigInt(7_000_000));
  });

  it('writes one history row, from the seller to the winner, marked AUCTION', async () => {
    await settleAuction(LISTING);
    expect(historyCreate).toHaveBeenCalledTimes(1);
    const d = historyCreate.mock.calls[0][0].data;
    expect(d.athleteId).toBe('p-1');
    expect(d.fromClubRef).toBe(SELLER);
    expect(d.toClubRef).toBe(C);
    expect(d.feeCents).toBe(BigInt(700_000_000));
    expect((d.payload as { type: string }).type).toBe('AUCTION');
  });

  it('persists the outcome on the listing', async () => {
    await settleAuction(LISTING);
    const claim = itemUpdateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: LISTING, status: 'ACTIVE' });
    expect(claim.data.status).toBe('SOLD');
    expect(claim.data.winnerClubId).toBe(C);
    expect(claim.data.settledAt).toBeInstanceOf(Date);
  });

  it('tells the winner, the seller and the losing bidder', async () => {
    await settleAuction(LISTING);
    const targets = notifCreate.mock.calls.flatMap((c) => {
      const d = c[0].data; return (Array.isArray(d) ? d : [d]).map((r: { clubId: string; kind: string }) => r.clubId + ':' + r.kind);
    });
    expect(targets).toEqual(expect.arrayContaining([
      C + ':AUCTION_WON', SELLER + ':TRANSFER_COMPLETED', C + ':TRANSFER_COMPLETED', B + ':AUCTION_LOST',
    ]));
  });

  it('a second settlement attempt takes nothing', async () => {
    // the claim reports zero rows: another caller already took it
    itemUpdateMany.mockResolvedValue({ count: 0 });
    await expect(settleAuction(LISTING)).rejects.toThrow(/already settled/i);
    expect(playerUpdate).not.toHaveBeenCalled();
    expect(balanceUpsert).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
  });

  it('an auction that is still running does not settle', async () => {
    itemFindUnique.mockResolvedValue(AUCTION);          // deadline in the future
    await expect(settleAuction(LISTING)).rejects.toThrow(/still running/i);
    expect(playerUpdate).not.toHaveBeenCalled();
  });

  it('a cancelled auction can never settle', async () => {
    itemFindUnique.mockResolvedValue({ ...expired, status: 'CANCELLED' });
    await expect(settleAuction(LISTING)).rejects.toThrow(/already settled/i);
    expect(playerUpdate).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
  });

  it('a player who left before the hammer fell stops the settlement', async () => {
    playerFindUnique.mockResolvedValue({ ...PLAYER, clubId: 'gone-elsewhere' });
    await expect(settleAuction(LISTING)).rejects.toThrow(/no longer belongs/i);
    expect(playerUpdate).not.toHaveBeenCalled();
    expect(balanceUpsert).not.toHaveBeenCalled();
  });
});

describe('an auction nobody bid on', () => {
  beforeEach(() => {
    itemFindUnique.mockResolvedValue({ ...AUCTION, validUntil: new Date(Date.now() - 1000) });
    bidFindFirst.mockResolvedValue(null);
  });

  it('ends UNSOLD', async () => {
    const out = await settleAuction(LISTING);
    expect(out.status).toBe('UNSOLD');
    expect(itemUpdateMany.mock.calls[0][0].data.status).toBe('UNSOLD');
  });

  it('and nothing moves', async () => {
    await settleAuction(LISTING);
    expect(playerUpdate).not.toHaveBeenCalled();
    expect(balanceUpsert).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
  });
});
