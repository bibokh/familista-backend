/**
 * tests/my-club-desk.unit.test.ts
 *
 * The club's own transfer desk, and the shortlist that has to keep up with it.
 *
 * The seller-side answer used to be four reads that nothing composed: listings
 * here, auctions there, offers and interests in a third, completed moves in a
 * fourth. This is the one read, and the thing it must never do is describe
 * anybody but the club that asked.
 */

const itemFindMany = jest.fn();
const offerFindMany = jest.fn();
const interestFindMany = jest.fn();
const p2cFindMany = jest.fn();
const historyFindMany = jest.fn();
const balanceFindUnique = jest.fn();
const playerFindMany = jest.fn();
const clubFindMany = jest.fn();
const bidFindMany = jest.fn();
const bidFindFirst = jest.fn();
const targetFindMany = jest.fn();
const targetUpdateMany = jest.fn();
const contractFindMany = jest.fn();
const needFindMany = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    marketplaceItem:      { findMany: (...a: unknown[]) => itemFindMany(...a) },
    transferOffer:        { findMany: (...a: unknown[]) => offerFindMany(...a) },
    transferInterest:     { findMany: (...a: unknown[]) => interestFindMany(...a) },
    playerOfferToClub:    { findMany: (...a: unknown[]) => p2cFindMany(...a) },
    athleteTransferHistory: { findMany: (...a: unknown[]) => historyFindMany(...a) },
    clubTransferBalance:  { findUnique: (...a: unknown[]) => balanceFindUnique(...a) },
    player:               { findMany: (...a: unknown[]) => playerFindMany(...a) },
    club:                 { findMany: (...a: unknown[]) => clubFindMany(...a) },
    transferBid:          { findMany: (...a: unknown[]) => bidFindMany(...a), findFirst: (...a: unknown[]) => bidFindFirst(...a) },
    transferTarget:       { findMany: (...a: unknown[]) => targetFindMany(...a), updateMany: (...a: unknown[]) => targetUpdateMany(...a) },
    playerContractStatus: { findMany: (...a: unknown[]) => contractFindMany(...a) },
    clubRecruitmentNeed:  { findMany: (...a: unknown[]) => needFindMany(...a) },
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));
jest.mock('../src/transfer-market/transfer-market.service', () => ({
  getBalance: jest.fn().mockResolvedValue({ availableEur: 50_000_000 }),
}));
jest.mock('../src/transfer-market/transfer-auction.service', () => ({
  settleDueAuctions: jest.fn().mockResolvedValue([]),
  leadingCommitmentFor: jest.fn().mockResolvedValue(0),
}));

import { readMyClub, readShortlist } from '../src/transfer-market/transfer-discovery.service';
import { leadingCommitmentFor } from '../src/transfer-market/transfer-auction.service';

const ME = { userId: 'u1', clubId: 'club-a' };
const YEAR = 365.25 * 24 * 3600 * 1000;

const player = (over: Record<string, unknown> = {}) => ({
  id: 'p1', firstName: 'Tomás', lastName: 'Ferreira', number: 9, position: 'ST',
  trainedPositions: null, nationality: 'Portugal', flag: '🇵🇹', avatar: null,
  overallRating: 82, potential: 88, preferredFoot: 'RIGHT', marketValue: 12_000_000,
  contractUntil: null, clubId: 'club-a', dateOfBirth: new Date(Date.now() - 23 * YEAR),
  roles: null, isActive: true, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  itemFindMany.mockResolvedValue([]);
  offerFindMany.mockResolvedValue([]);
  interestFindMany.mockResolvedValue([]);
  p2cFindMany.mockResolvedValue([]);
  historyFindMany.mockResolvedValue([]);
  balanceFindUnique.mockResolvedValue({ budgetEur: BigInt(50_000_000), earnedEur: BigInt(4_000_000), spentEur: BigInt(1_000_000) });
  playerFindMany.mockResolvedValue([player()]);
  clubFindMany.mockResolvedValue([
    { id: 'club-a', name: 'Alpha FC', shortName: 'ALP', emblem: null },
    { id: 'club-b', name: 'Beta FC', shortName: 'BET', emblem: null },
  ]);
  bidFindMany.mockResolvedValue([]);
  targetFindMany.mockResolvedValue([]);
  targetUpdateMany.mockResolvedValue({ count: 0 });
  contractFindMany.mockResolvedValue([]);
  needFindMany.mockResolvedValue([]);
  (leadingCommitmentFor as jest.Mock).mockResolvedValue(0);
});

// ── 17 · it can only ever describe the caller ──────────────────────────────
describe('the desk is the caller\'s club and nobody else\'s', () => {
  it('scopes every query to the acting club', async () => {
    await readMyClub(ME);
    expect(itemFindMany.mock.calls[0][0].where).toMatchObject({ clubId: 'club-a' });
    const offerWheres = offerFindMany.mock.calls.map((c) => c[0].where);
    expect(offerWheres[0]).toMatchObject({ createdByClubId: { not: 'club-a' } });
    expect(offerWheres[0].OR).toEqual([{ sellerClubId: 'club-a' }, { buyerClubId: 'club-a' }]);
    expect(offerWheres[1]).toMatchObject({ createdByClubId: 'club-a' });
    expect(interestFindMany.mock.calls[0][0].where).toMatchObject({ ownerClubId: 'club-a' });
    expect(interestFindMany.mock.calls[1][0].where).toMatchObject({ interestedClubId: 'club-a' });
    expect(p2cFindMany.mock.calls[0][0].where).toMatchObject({ toClubId: 'club-a' });
    expect(p2cFindMany.mock.calls[1][0].where).toMatchObject({ fromClubId: 'club-a' });
    expect(historyFindMany.mock.calls[0][0].where.OR).toEqual([{ fromClubRef: 'club-a' }, { toClubRef: 'club-a' }]);
    expect(balanceFindUnique.mock.calls[0][0].where).toEqual({ clubId: 'club-a' });
  });

  it('never carries a private player field', async () => {
    itemFindMany.mockResolvedValue([{
      id: 'l1', clubId: 'club-a', status: 'ACTIVE', createdAt: new Date(),
      winnerClubId: null, finalPriceEur: null,
      payload: { playerId: 'p1', askingPriceEur: 9_000_000 },
    }]);
    playerFindMany.mockResolvedValue([{
      ...player(), email: 'kid@secret.example', parentPhone: '+49 000',
      notes: 'SECRET', medicalStatus: 'INJURED', weeklyWage: 40_000,
    }]);
    const json = JSON.stringify(await readMyClub(ME));
    for (const leak of ['kid@secret.example', '+49 000', 'SECRET', 'INJURED', 'weeklyWage']) {
      expect(json).not.toContain(leak);
    }
  });
});

// ── what it composes ───────────────────────────────────────────────────────
describe('one row per thing the club has going on', () => {
  it('reports a fixed-price listing with the action the club can take', async () => {
    itemFindMany.mockResolvedValue([{
      id: 'l1', clubId: 'club-a', status: 'ACTIVE', createdAt: new Date(),
      winnerClubId: null, finalPriceEur: null,
      payload: { playerId: 'p1', askingPriceEur: 9_000_000 },
    }]);
    const r = await readMyClub(ME);
    const row = r.rows.find((x) => x.type === 'LISTING')!;
    expect(row.status).toBe('ACTIVE');
    expect(row.amountEur).toBe(9_000_000);
    expect(row.action).toMatch(/delist/i);
    expect(row.player!.name).toBe('Tomás Ferreira');
  });

  it('reports a running auction with its bid count', async () => {
    itemFindMany.mockResolvedValue([{
      id: 'a1', clubId: 'club-a', status: 'ACTIVE', createdAt: new Date(),
      winnerClubId: null, finalPriceEur: null,
      payload: { playerId: 'p1', mode: 'AUCTION', startingPriceEur: 5_000_000 },
    }]);
    bidFindMany.mockResolvedValue([
      { listingId: 'a1', bidderClubId: 'club-b', amountEur: BigInt(6_000_000) },
      { listingId: 'a1', bidderClubId: 'club-b', amountEur: BigInt(5_500_000) },
    ]);
    const r = await readMyClub(ME);
    const row = r.rows.find((x) => x.type === 'AUCTION')!;
    expect(row.bidCount).toBe(2);
    expect(row.highestBidEur).toBe(6_000_000);
    expect(row.action).toMatch(/cancel/i);
  });

  it('reports a sold auction with where he went', async () => {
    itemFindMany.mockResolvedValue([{
      id: 'a1', clubId: 'club-a', status: 'SOLD', createdAt: new Date(),
      winnerClubId: 'club-b', finalPriceEur: BigInt(7_000_000),
      payload: { playerId: 'p1', mode: 'AUCTION', startingPriceEur: 5_000_000 },
    }]);
    const r = await readMyClub(ME);
    const row = r.rows.find((x) => x.type === 'AUCTION')!;
    expect(row.result).toBe('Sold to Beta FC');
    expect(row.to!.name).toBe('Beta FC');
    expect(row.amountEur).toBe(7_000_000);
  });

  it('separates an offer we must answer from one we are waiting on', async () => {
    offerFindMany
      .mockResolvedValueOnce([{
        id: 'o1', playerId: 'p1', sellerClubId: 'club-a', buyerClubId: 'club-b',
        createdByClubId: 'club-b', status: 'PENDING', feeEur: BigInt(8_000_000), createdAt: new Date(),
      }])
      .mockResolvedValueOnce([{
        id: 'o2', playerId: 'p1', sellerClubId: 'club-b', buyerClubId: 'club-a',
        createdByClubId: 'club-a', status: 'PENDING', feeEur: BigInt(3_000_000), createdAt: new Date(),
      }]);
    const r = await readMyClub(ME);
    expect(r.rows.find((x) => x.type === 'OFFER_IN')!.action).toMatch(/answer it/i);
    expect(r.rows.find((x) => x.type === 'OFFER_OUT')!.action).toMatch(/waiting/i);
  });

  it('shows a completed transfer as FROM → TO', async () => {
    historyFindMany.mockResolvedValue([{
      id: 'h1', athleteId: 'p1', fromClubRef: 'club-a', toClubRef: 'club-b',
      feeCents: BigInt(900_000_000), occurredAt: new Date(), payload: { type: 'AUCTION' },
    }]);
    const r = await readMyClub(ME);
    const row = r.rows.find((x) => x.type === 'COMPLETED')!;
    expect(row.from!.name).toBe('Alpha FC');
    expect(row.to!.name).toBe('Beta FC');
    expect(row.amountEur).toBe(9_000_000);
    expect(row.result).toBe('Sold to Beta FC');
  });

  it('reads a bounded number of queries, not one per row', async () => {
    itemFindMany.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({
      id: 'l' + i, clubId: 'club-a', status: 'ACTIVE', createdAt: new Date(),
      winnerClubId: null, finalPriceEur: null, payload: { playerId: 'p1', askingPriceEur: 1e6 },
    })));
    await readMyClub(ME);
    expect(playerFindMany).toHaveBeenCalledTimes(1);
    expect(clubFindMany).toHaveBeenCalledTimes(1);
    expect(bidFindMany).toHaveBeenCalledTimes(1);
  });
});

// ── the money, including what the auctions already promise ─────────────────
describe('the balance the desk reports', () => {
  it('subtracts live auction commitments from what is available', async () => {
    (leadingCommitmentFor as jest.Mock).mockResolvedValue(20_000_000);
    const r = await readMyClub(ME);
    expect(r.balance.committedEur).toBe(20_000_000);
    // 50 + 4 − 1 − 20
    expect(r.balance.availableEur).toBe(33_000_000);
  });

  it('never reports a negative figure', async () => {
    balanceFindUnique.mockResolvedValue({ budgetEur: BigInt(1_000_000), earnedEur: BigInt(0), spentEur: BigInt(0) });
    (leadingCommitmentFor as jest.Mock).mockResolvedValue(9_000_000);
    const r = await readMyClub(ME);
    expect(r.balance.availableEur).toBe(0);
  });
});

// ── 18 · 19 · the shortlist keeps up ───────────────────────────────────────
describe('the shortlist after the world moves', () => {
  it('archives an entry whose player is gone rather than keeping a null row', async () => {
    targetFindMany.mockResolvedValue([
      { id: 't1', playerId: 'p-gone', stage: 'SHORTLIST', priorityScore: 50, notes: null, createdAt: new Date() },
    ]);
    playerFindMany.mockResolvedValue([]);
    const r = await readShortlist(ME);
    expect(r.items).toEqual([]);
    expect(r.archived).toBe(1);
    expect(targetUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['t1'] }, archivedAt: null }),
      data: expect.objectContaining({ archivedAt: expect.any(Date) }),
    }));
  });

  it('treats a deactivated player as gone', async () => {
    targetFindMany.mockResolvedValue([
      { id: 't1', playerId: 'p1', stage: 'SHORTLIST', priorityScore: 50, notes: null, createdAt: new Date() },
    ]);
    await readShortlist(ME);
    // the read asks only for active players, so an inactive one never comes back
    expect(playerFindMany.mock.calls[0][0].where).toMatchObject({ isActive: true });
  });

  it('leaves a live entry exactly as it was', async () => {
    targetFindMany.mockResolvedValue([
      { id: 't1', playerId: 'p1', stage: 'SHORTLIST', priorityScore: 50, notes: null, createdAt: new Date() },
    ]);
    playerFindMany.mockResolvedValue([player({ clubId: 'club-b' })]);
    const r = await readShortlist(ME);
    expect(r.items).toHaveLength(1);
    expect(r.archived).toBe(0);
    expect(targetUpdateMany).not.toHaveBeenCalled();
  });
});
