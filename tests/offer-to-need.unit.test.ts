/**
 * tests/offer-to-need.unit.test.ts
 *
 * A club answering another club's need with one of its own players.
 *
 * The seller starts this conversation, which is the only thing that makes it
 * different from an ordinary offer: the same TransferOffer carries it, the
 * same counter engine answers it, and the same acceptOffer settles it. These
 * tests hold that line — that ownership is read from the player row and never
 * from the request, that a need which has lapsed cannot be answered, and that
 * the offer is written together with the record that links it to the need.
 *
 * Prisma is mocked, as in the sibling suites. What is being checked is the
 * decision each function makes and the rows it asks for, not the database.
 */

const playerFindUnique = jest.fn();
const needFindUnique = jest.fn();
const offerFindFirst = jest.fn();
const offerCreate = jest.fn();
const p2cCreate = jest.fn();
const p2cFindFirst = jest.fn();
const clubFindUnique = jest.fn();
const notifCreate = jest.fn();
const userFindMany = jest.fn();
const membershipFindMany = jest.fn();
const $transaction = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    player:              { findUnique: (...a: unknown[]) => playerFindUnique(...a) },
    clubRecruitmentNeed: { findUnique: (...a: unknown[]) => needFindUnique(...a) },
    transferOffer:       { findFirst:  (...a: unknown[]) => offerFindFirst(...a),
                           create:     (...a: unknown[]) => offerCreate(...a),
                           findUnique: jest.fn() },
    playerOfferToClub:   { create:     (...a: unknown[]) => p2cCreate(...a),
                           findFirst:  (...a: unknown[]) => p2cFindFirst(...a) },
    club:                { findUnique: (...a: unknown[]) => clubFindUnique(...a) },
    userNotification:    { createMany: (...a: unknown[]) => notifCreate(...a) },
    user:                { findMany:   (...a: unknown[]) => userFindMany(...a) },
    membership:          { findMany:   (...a: unknown[]) => membershipFindMany(...a) },
    $transaction:        (...a: unknown[]) => $transaction(...a),
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));
jest.mock('./../src/transfer-market/transfer-market.service', () => ({
  getBalance: jest.fn().mockResolvedValue({ availableEur: 50_000_000 }),
  // Group 7: the offer paths now refuse a player who is at auction, and clean
  // up competing state when one completes.
  activeAuctionForPlayer: jest.fn().mockResolvedValue(null),
  closeCompetingState: jest.fn().mockResolvedValue({ auctionListingId: null }),
  assertCanSpend: jest.fn().mockResolvedValue(undefined),
  archiveShortlistAfterTransfer: jest.fn().mockResolvedValue(0),
}));
jest.mock('./../src/transfer-market/transfer-auction.service', () => ({
  settleDueAuctions: jest.fn().mockResolvedValue([]),
  leadingCommitmentFor: jest.fn().mockResolvedValue(0),
  cancelAuctionForSettlement: jest.fn().mockResolvedValue(null),
  notifyCancelled: jest.fn().mockResolvedValue(undefined),
}));

import { offerPlayerToNeed } from '../src/transfer-market/transfer-negotiation.service';

const SELLER = 'club-seller';   // owns the striker
const BUYER  = 'club-buyer';    // published the need
const OTHER  = 'club-other';    // owns nothing here

const actor = (clubId: string) => ({ clubId, userId: 'u-' + clubId, role: 'HEAD_COACH' as never });
const born = (age: number) => new Date(Date.now() - age * 365.25 * 24 * 3600 * 1000);

const PLAYER = {
  id: 'p-1', clubId: SELLER, firstName: 'Mohamed', lastName: 'Ali',
  position: 'ST', trainedPositions: 'AML', roles: null, dateOfBirth: born(21),
  overallRating: 81, marketValue: 8_400_000, preferredFoot: 'RIGHT',
  nationality: 'Brazil', isActive: true,
};
const NEED = {
  id: 'need-1', clubId: BUYER, positions: 'ST',
  ageMin: 18, ageMax: 24, ratingMin: 75, ratingMax: null,
  budgetMinEur: null, budgetMaxEur: 12_000_000n,
  nationality: null, preferredFoot: 'RIGHT', playstyle: null, contractPreference: 'PERMANENT',
  priority: 'HIGH', note: null, isActive: true,
  expiresAt: new Date(Date.now() + 48 * 3600_000), createdAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  playerFindUnique.mockResolvedValue(PLAYER);
  needFindUnique.mockResolvedValue(NEED);
  offerFindFirst.mockResolvedValue(null);
  p2cFindFirst.mockResolvedValue(null);
  clubFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve({ id: where.id, name: where.id.toUpperCase(), logo: null }));
  userFindMany.mockResolvedValue([{ id: 'user-1' }]);
  membershipFindMany.mockResolvedValue([{ userId: 'user-1' }]);
  notifCreate.mockResolvedValue({ count: 1 });
  offerCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'offer-1', ...data, status: 'PENDING', createdAt: new Date(), parentOfferId: null,
                      respondedAt: null, message: data.message ?? null }));
  p2cCreate.mockResolvedValue({ id: 'p2c-1' });
  // run the interactive transaction against the same mocks
  $transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
    transferOffer:     { create: (...a: unknown[]) => offerCreate(...a) },
    playerOfferToClub: { create: (...a: unknown[]) => p2cCreate(...a) },
  }));
});

const DTO = { playerId: 'p-1', needId: 'need-1', askingPriceEur: 9_500_000 };

describe('a club offers its own player against a published need', () => {
  it('creates the offer with the seller as its author', async () => {
    await offerPlayerToNeed(actor(SELLER), DTO);
    const data = offerCreate.mock.calls[0][0].data;
    expect(data.sellerClubId).toBe(SELLER);
    expect(data.buyerClubId).toBe(BUYER);
    expect(data.createdByClubId).toBe(SELLER);
    expect(data.feeEur).toBe(BigInt(9_500_000));
  });

  it('and the record that links it to the need', async () => {
    await offerPlayerToNeed(actor(SELLER), DTO);
    const data = p2cCreate.mock.calls[0][0].data;
    expect(data.needId).toBe('need-1');
    expect(data.fromClubId).toBe(SELLER);
    expect(data.toClubId).toBe(BUYER);
    expect(data.matchPct).toBe(100);       // he satisfies every criterion stated
  });

  it('both rows are written in one transaction, or neither is', async () => {
    await offerPlayerToNeed(actor(SELLER), DTO);
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('the club that published the need is notified', async () => {
    await offerPlayerToNeed(actor(SELLER), DTO);
    expect(notifCreate).toHaveBeenCalledTimes(1);
    const rows = notifCreate.mock.calls[0][0].data;
    const first = Array.isArray(rows) ? rows[0] : rows;
    expect(first.clubId).toBe(BUYER);
    expect(first.kind).toBe('PLAYER_OFFERED_TO_CLUB');
    expect(first.title).toMatch(/Mohamed Ali/);
    expect(first.payload.offerId).toBe('offer-1');
    expect(first.payload.needId).toBe('need-1');
  });

  it('and nobody else is', async () => {
    await offerPlayerToNeed(actor(SELLER), DTO);
    const rows = notifCreate.mock.calls[0][0].data;
    const clubs = (Array.isArray(rows) ? rows : [rows]).map((r: { clubId: string }) => r.clubId);
    expect(clubs).not.toContain(SELLER);
    expect(clubs).not.toContain(OTHER);
  });
});

describe('ownership is the server’s to decide', () => {
  it('a club cannot offer a player it does not own', async () => {
    await expect(offerPlayerToNeed(actor(OTHER), DTO)).rejects.toThrow(/belongs to another club/i);
    expect(offerCreate).not.toHaveBeenCalled();
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it('the request cannot name the seller', async () => {
    await offerPlayerToNeed(actor(SELLER), { ...DTO, sellerClubId: OTHER } as never);
    expect(offerCreate.mock.calls[0][0].data.sellerClubId).toBe(SELLER);
  });

  it('a club cannot answer its own need', async () => {
    needFindUnique.mockResolvedValue({ ...NEED, clubId: SELLER });
    await expect(offerPlayerToNeed(actor(SELLER), DTO)).rejects.toThrow(/your own club/i);
    expect(offerCreate).not.toHaveBeenCalled();
  });

  it('an inactive player cannot be offered', async () => {
    playerFindUnique.mockResolvedValue({ ...PLAYER, isActive: false });
    await expect(offerPlayerToNeed(actor(SELLER), DTO)).rejects.toThrow(/not active/i);
    expect(offerCreate).not.toHaveBeenCalled();
  });

  it('a player who does not exist cannot be offered', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(offerPlayerToNeed(actor(SELLER), DTO)).rejects.toThrow();
    expect(offerCreate).not.toHaveBeenCalled();
  });
});

describe('a need that is no longer open cannot be answered', () => {
  it('expired', async () => {
    needFindUnique.mockResolvedValue({ ...NEED, expiresAt: new Date(Date.now() - 1000) });
    await expect(offerPlayerToNeed(actor(SELLER), DTO)).rejects.toThrow(/no longer open/i);
    expect(offerCreate).not.toHaveBeenCalled();
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it('deactivated', async () => {
    needFindUnique.mockResolvedValue({ ...NEED, isActive: false });
    await expect(offerPlayerToNeed(actor(SELLER), DTO)).rejects.toThrow(/no longer open/i);
    expect(offerCreate).not.toHaveBeenCalled();
  });

  it('gone', async () => {
    needFindUnique.mockResolvedValue(null);
    await expect(offerPlayerToNeed(actor(SELLER), DTO)).rejects.toThrow();
    expect(offerCreate).not.toHaveBeenCalled();
  });
});

describe('the same player is not offered to the same club twice', () => {
  it('a second proposal while one is open is refused', async () => {
    offerFindFirst.mockResolvedValue({ id: 'offer-open' });
    await expect(offerPlayerToNeed(actor(SELLER), DTO)).rejects.toThrow(/already have an open offer/i);
    expect(offerCreate).not.toHaveBeenCalled();
  });

  it('and the check is scoped to this pair of clubs', async () => {
    await offerPlayerToNeed(actor(SELLER), DTO);
    expect(offerFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { playerId: 'p-1', sellerClubId: SELLER, buyerClubId: BUYER, status: 'PENDING' },
    }));
  });
});

describe('the price is a number the server checks', () => {
  it.each([0, -1, NaN, undefined])('refuses %p', async (v) => {
    await expect(offerPlayerToNeed(actor(SELLER), { ...DTO, askingPriceEur: v as never }))
      .rejects.toThrow(/positive number/i);
    expect(offerCreate).not.toHaveBeenCalled();
  });
});
