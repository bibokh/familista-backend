/**
 * tests/transfer-correctness.unit.test.ts
 *
 * The rules that keep two live routes to the same player from colliding.
 *
 * A player could be at auction with money on the table and simultaneously be
 * the subject of a direct offer. Accepting that offer moved him and tore the
 * auction down — the auction row was left in CLOSED with no winner and no
 * settledAt, it disappeared from the board because CLOSED is not one of the
 * statuses the board reads, and the club that was leading it was told nothing.
 *
 * These tests hold the two halves of the fix: the collision cannot be created,
 * and if one somehow exists it ends as a cancellation that everybody hears
 * about rather than a silent close.
 */

const playerFindUnique = jest.fn();
const itemFindMany = jest.fn();
const itemFindUnique = jest.fn();
const itemUpdateMany = jest.fn();
const itemUpdate = jest.fn();
const itemCreate = jest.fn();
const offerFindFirst = jest.fn();
const offerFindUnique = jest.fn();
const offerUpdateMany = jest.fn();
const interestUpdateMany = jest.fn();
const p2cUpdateMany = jest.fn();
const contractUpdateMany = jest.fn();
const contractFindUnique = jest.fn();
const contractCreate = jest.fn();
const bidFindMany = jest.fn();
const bidFindFirst = jest.fn();
const clubFindUnique = jest.fn();
const balanceUpsert = jest.fn();
const balanceFindUnique = jest.fn();
const targetUpdateMany = jest.fn();
const historyCreate = jest.fn();
const teamFindFirst = jest.fn();
const playerUpdate = jest.fn();
const queryRaw = jest.fn();

const tx = {
  marketplaceItem: {
    findMany:   (...a: unknown[]) => itemFindMany(...a),
    findUnique: (...a: unknown[]) => itemFindUnique(...a),
    updateMany: (...a: unknown[]) => itemUpdateMany(...a),
    update:     (...a: unknown[]) => itemUpdate(...a),
    create:     (...a: unknown[]) => itemCreate(...a),
  },
  transferOffer:        { updateMany: (...a: unknown[]) => offerUpdateMany(...a), findFirst: (...a: unknown[]) => offerFindFirst(...a) },
  transferInterest:     { updateMany: (...a: unknown[]) => interestUpdateMany(...a) },
  playerOfferToClub:    { updateMany: (...a: unknown[]) => p2cUpdateMany(...a) },
  playerContractStatus: { updateMany: (...a: unknown[]) => contractUpdateMany(...a), findUnique: (...a: unknown[]) => contractFindUnique(...a), create: (...a: unknown[]) => contractCreate(...a) },
  clubTransferBalance:  { upsert: (...a: unknown[]) => balanceUpsert(...a), findUnique: (...a: unknown[]) => balanceFindUnique(...a) },
  transferBid:          { findMany: (...a: unknown[]) => bidFindMany(...a), findFirst: (...a: unknown[]) => bidFindFirst(...a), count: jest.fn().mockResolvedValue(1) },
  athleteTransferHistory: { create: (...a: unknown[]) => historyCreate(...a) },
  player: { findUnique: (...a: unknown[]) => playerFindUnique(...a), update: (...a: unknown[]) => playerUpdate(...a) },
  team:   { findFirst: (...a: unknown[]) => teamFindFirst(...a) },
  $queryRaw: (...a: unknown[]) => queryRaw(...a),
};

jest.mock('../src/config/database', () => ({
  prisma: {
    ...tx,
    club: { findUnique: (...a: unknown[]) => clubFindUnique(...a), findMany: jest.fn().mockResolvedValue([]) },
    transferTarget: { updateMany: (...a: unknown[]) => targetUpdateMany(...a) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    userNotification: { createMany: jest.fn() },
    transferOffer: { findFirst: (...a: unknown[]) => offerFindFirst(...a), findUnique: (...a: unknown[]) => offerFindUnique(...a), updateMany: (...a: unknown[]) => offerUpdateMany(...a), update: jest.fn() },
    $transaction: (fn: (t: unknown) => unknown) => (typeof fn === 'function' ? fn(tx) : Promise.resolve([])),
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));

const notifyClub = jest.fn().mockResolvedValue(1);
jest.mock('../src/transfer-market/transfer-notify', () => ({
  notifyClub: (...a: unknown[]) => notifyClub(...a),
  fmt: (n: number) => String(n),
}));

import { listPlayer, purchase, pendingOfferForPlayer, activeAuctionForPlayer } from '../src/transfer-market/transfer-market.service';
import { listAuction, cancelAuction } from '../src/transfer-market/transfer-auction.service';
import { makeOffer } from '../src/transfer-market/transfer-negotiation.service';

const A = { userId: 'ua', clubId: 'club-a' };   // the buyer
const B = { userId: 'ub', clubId: 'club-b' };   // the owner
const YEAR = 365.25 * 24 * 3600 * 1000;

const PLAYER = {
  id: 'p1', firstName: 'Orphan', lastName: 'Case', number: 9, position: 'ST',
  trainedPositions: null, nationality: 'Brazil', flag: '🇧🇷', avatar: null,
  overallRating: 80, potential: 85, preferredFoot: 'RIGHT', marketValue: 5_000_000,
  contractUntil: null, clubId: 'club-b', dateOfBirth: new Date(Date.now() - 22 * YEAR),
  roles: null, isActive: true, teamId: 'team-b',
};
const auctionItem = (over: Record<string, unknown> = {}) => ({
  id: 'auc-1', kind: 'TRANSFER_LISTING', clubId: 'club-b', status: 'ACTIVE',
  validUntil: new Date(Date.now() + 3600_000), createdAt: new Date(),
  payload: { playerId: 'p1', mode: 'AUCTION', startingPriceEur: 2_000_000, askingPriceEur: 2_000_000 },
  ...over,
});
const fixedItem = (over: Record<string, unknown> = {}) => ({
  id: 'lst-1', kind: 'TRANSFER_LISTING', clubId: 'club-b', status: 'ACTIVE',
  validUntil: new Date(Date.now() + 3600_000), createdAt: new Date(),
  payload: { playerId: 'p1', askingPriceEur: 4_000_000 },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  playerFindUnique.mockResolvedValue(PLAYER);
  itemFindMany.mockResolvedValue([]);
  itemUpdateMany.mockResolvedValue({ count: 1 });
  offerFindFirst.mockResolvedValue(null);
  offerUpdateMany.mockResolvedValue({ count: 0 });
  interestUpdateMany.mockResolvedValue({ count: 0 });
  p2cUpdateMany.mockResolvedValue({ count: 0 });
  contractUpdateMany.mockResolvedValue({ count: 0 });
  contractFindUnique.mockResolvedValue(null);
  bidFindMany.mockResolvedValue([]);
  bidFindFirst.mockResolvedValue(null);
  balanceFindUnique.mockResolvedValue({ budgetEur: BigInt(50_000_000), earnedEur: BigInt(0), spentEur: BigInt(0) });
  balanceUpsert.mockResolvedValue({ budgetEur: BigInt(50_000_000), earnedEur: BigInt(0), spentEur: BigInt(0) });
  clubFindUnique.mockResolvedValue({ id: 'club-b', name: 'FC Beispiel', shortName: null, emblem: null });
  targetUpdateMany.mockResolvedValue({ count: 0 });
  historyCreate.mockResolvedValue({ id: 'h1' });
  teamFindFirst.mockResolvedValue({ id: 'team-a' });
  itemCreate.mockResolvedValue(auctionItem());
  queryRaw.mockResolvedValue([{ id: 'bal-a' }]);
});

// ── 1 · a player at auction cannot be bought around it ──────────────────────
describe('one live route to a player, not two', () => {
  it('refuses a direct offer while an auction is running on him', async () => {
    itemFindMany.mockResolvedValue([auctionItem()]);
    await expect(makeOffer(A, { playerId: 'p1', feeEur: 3_000_000 }))
      .rejects.toThrow(/auction/i);
  });

  it('still allows a direct offer when the listing is a fixed price', async () => {
    itemFindMany.mockResolvedValue([fixedItem()]);
    // The guard is what is under test: a fixed-price listing is not an auction,
    // so this must get past it and fail later on, in the write it does not have.
    await expect(makeOffer(A, { playerId: 'p1', feeEur: 3_000_000 }))
      .rejects.toThrow(/transferOffer\.create/);
  });

  it('activeAuctionForPlayer tells an auction from a fixed-price listing', async () => {
    itemFindMany.mockResolvedValue([fixedItem()]);
    expect(await activeAuctionForPlayer('p1')).toBeNull();
    itemFindMany.mockResolvedValue([auctionItem()]);
    expect((await activeAuctionForPlayer('p1'))!.id).toBe('auc-1');
  });
});

// ── 2 · 3 · the mirror: no listing while a negotiation is open ──────────────
describe('a player being negotiated is not a player to put on the market', () => {
  it('refuses a fixed-price listing while an offer is pending', async () => {
    offerFindFirst.mockResolvedValue({ id: 'off-1', sellerClubId: 'club-b', buyerClubId: 'club-a', feeEur: BigInt(3e6) });
    await expect(listPlayer(B, { playerId: 'p1', askingPriceEur: 4_000_000 }))
      .rejects.toThrow(/open transfer offer/i);
  });

  it('refuses an auction while an offer is pending', async () => {
    offerFindFirst.mockResolvedValue({ id: 'off-1', sellerClubId: 'club-b', buyerClubId: 'club-a', feeEur: BigInt(3e6) });
    await expect(listAuction(B, { playerId: 'p1', startingPriceEur: 2_000_000, minutes: 30 }))
      .rejects.toThrow(/open transfer offer/i);
  });

  it('and allows both when nothing is pending', async () => {
    offerFindFirst.mockResolvedValue(null);
    await expect(listAuction(B, { playerId: 'p1', startingPriceEur: 2_000_000, minutes: 30 })).resolves.toBeDefined();
  });

  it('pendingOfferForPlayer looks only at PENDING', async () => {
    await pendingOfferForPlayer('p1');
    expect(offerFindFirst.mock.calls[0][0].where).toMatchObject({ playerId: 'p1', status: 'PENDING' });
  });
});

// ── 5 · 6 · a cancelled auction is CANCELLED, and its bidders are told ──────
describe('cancelling an auction', () => {
  beforeEach(() => {
    itemFindUnique.mockResolvedValue(auctionItem());
  });

  it('writes CANCELLED, never CLOSED', async () => {
    await cancelAuction(B, 'auc-1');
    const data = itemUpdateMany.mock.calls[0][0].data;
    expect(data.status).toBe('CANCELLED');
    expect(data.status).not.toBe('CLOSED');
    expect(data.settledAt).toBeInstanceOf(Date);
  });

  it('tells every club that had bid, once each', async () => {
    bidFindMany.mockResolvedValue([
      { bidderClubId: 'club-c' }, { bidderClubId: 'club-c' }, { bidderClubId: 'club-d' },
    ]);
    await cancelAuction(B, 'auc-1');
    const lost = notifyClub.mock.calls.filter((c) => c[1] === 'AUCTION_LOST');
    expect(lost.map((c) => c[0]).sort()).toEqual(['club-c', 'club-d']);
  });

  it('and says it was cancelled, not that they were outbid', async () => {
    bidFindMany.mockResolvedValue([{ bidderClubId: 'club-c' }]);
    await cancelAuction(B, 'auc-1');
    const call = notifyClub.mock.calls.find((c) => c[1] === 'AUCTION_LOST')!;
    expect(String(call[2])).toMatch(/cancelled/i);
    expect(call[4]).toMatchObject({ type: 'AUCTION_CANCELLED', outcome: 'CANCELLED' });
  });

  it('never notifies a club that was not in the auction', async () => {
    bidFindMany.mockResolvedValue([{ bidderClubId: 'club-c' }]);
    await cancelAuction(B, 'auc-1');
    expect(notifyClub.mock.calls.map((c) => c[0])).not.toContain('club-d');
    // and not the seller either — it is the one doing the cancelling
    expect(notifyClub.mock.calls.map((c) => c[0])).not.toContain('club-b');
  });

  it('says nothing at all when nobody had bid', async () => {
    bidFindMany.mockResolvedValue([]);
    await cancelAuction(B, 'auc-1');
    expect(notifyClub).not.toHaveBeenCalled();
  });
});

// ── 7 · 13 · a fixed-price purchase behaves like the offer path ────────────
describe('a fixed-price purchase', () => {
  beforeEach(() => {
    itemFindUnique.mockResolvedValue(fixedItem());
    itemFindMany.mockResolvedValue([]);
  });

  it('closes every competing negotiation on the player', async () => {
    await purchase(A, 'lst-1');
    expect(offerUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ playerId: 'p1', status: 'PENDING' }),
      data: expect.objectContaining({ status: 'REJECTED' }),
    }));
    expect(interestUpdateMany).toHaveBeenCalled();
    expect(p2cUpdateMany).toHaveBeenCalled();
    expect(contractUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { isAvailableForTransfer: false },
    }));
  });

  it('tells both clubs the transfer completed, once each', async () => {
    await purchase(A, 'lst-1');
    const done = notifyClub.mock.calls.filter((c) => c[1] === 'TRANSFER_COMPLETED');
    expect(done).toHaveLength(2);
    expect(done.map((c) => c[0]).sort()).toEqual(['club-a', 'club-b']);
    expect(done[0][4]).toMatchObject({ mode: 'FIXED_PRICE', from: 'club-b', to: 'club-a' });
  });

  it('writes exactly one history row, and one debit and one credit', async () => {
    await purchase(A, 'lst-1');
    expect(historyCreate).toHaveBeenCalledTimes(1);
    expect(historyCreate.mock.calls[0][0].data).toMatchObject({
      athleteId: 'p1', fromClubRef: 'club-b', toClubRef: 'club-a',
    });
    const spend = balanceUpsert.mock.calls.filter((c) => c[0].update.spentEur);
    const earn  = balanceUpsert.mock.calls.filter((c) => c[0].update.earnedEur);
    expect(spend).toHaveLength(1);
    expect(earn).toHaveLength(1);
    expect(spend[0][0].where.clubId).toBe('club-a');
    expect(earn[0][0].where.clubId).toBe('club-b');
  });

  it('archives the buyer\'s own shortlist entry for the player it just signed', async () => {
    await purchase(A, 'lst-1');
    expect(targetUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ playerId: 'p1', clubId: 'club-a', archivedAt: null }),
      data: expect.objectContaining({ archivedAt: expect.any(Date) }),
    }));
  });
});

// ── 10 · 11 · the money check moved inside, and it knows about auctions ────
describe('affordability', () => {
  beforeEach(() => { itemFindUnique.mockResolvedValue(fixedItem()); });

  it('locks the club\'s balance row before it reads it', async () => {
    await purchase(A, 'lst-1');
    expect(queryRaw).toHaveBeenCalled();
    const sql = String(queryRaw.mock.calls[0][0]);
    expect(sql).toMatch(/FOR UPDATE/);
  });

  it('subtracts what live auction leads already promise', async () => {
    // €50M budget, €4M asking — but €48M is committed to an auction we lead
    itemFindMany.mockImplementation((args: { where?: { status?: string } } = {}) => {
      if (args?.where?.status === 'ACTIVE') return Promise.resolve([auctionItem({ id: 'other', clubId: 'club-z' })]);
      return Promise.resolve([]);
    });
    bidFindFirst.mockResolvedValue({ id: 'b1', bidderClubId: 'club-a', amountEur: BigInt(48_000_000) });
    await expect(purchase(A, 'lst-1')).rejects.toThrow(/Insufficient transfer budget/i);
  });

  it('allows it when the commitment leaves exactly enough', async () => {
    itemFindMany.mockImplementation((args: { where?: { status?: string } } = {}) => {
      if (args?.where?.status === 'ACTIVE') return Promise.resolve([auctionItem({ id: 'other', clubId: 'club-z' })]);
      return Promise.resolve([]);
    });
    bidFindFirst.mockResolvedValue({ id: 'b1', bidderClubId: 'club-a', amountEur: BigInt(46_000_000) });
    await expect(purchase(A, 'lst-1')).resolves.toBeDefined();   // 50 − 46 = 4, exactly the fee
  });

  it('refuses when the balance simply does not cover it', async () => {
    balanceFindUnique.mockResolvedValue({ budgetEur: BigInt(1_000_000), earnedEur: BigInt(0), spentEur: BigInt(0) });
    balanceUpsert.mockResolvedValue({ budgetEur: BigInt(1_000_000), earnedEur: BigInt(0), spentEur: BigInt(0) });
    await expect(purchase(A, 'lst-1')).rejects.toThrow(/Insufficient transfer budget/i);
  });
});
