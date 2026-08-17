/**
 * tests/scouting-discovery.unit.test.ts
 *
 * Finding a real footballer at another real club.
 *
 * Two things are held here, and they are deliberately separate. The first is
 * WHO can be found: active players, at other clubs, at clubs that exist — and
 * never our own squad unless something internal asks for it. The second is
 * WHAT can then be done about him, which is not the same question: a player
 * being visible in a search does not mean his club wants to sell him, and the
 * actions a row carries are derived from what that club actually did.
 *
 * Prisma is mocked in the way the rest of these suites mock it. The clubs, the
 * players and the listings are fixtures of this file.
 */

const playerFindMany = jest.fn();
const playerFindUnique = jest.fn();
const playerCount = jest.fn();
const itemFindMany = jest.fn();
const contractFindMany = jest.fn();
const contractFindUnique = jest.fn();
const targetFindMany = jest.fn();
const targetFindFirst = jest.fn();
const targetCreate = jest.fn();
const targetUpdateMany = jest.fn();
const needFindMany = jest.fn();
const clubFindMany = jest.fn();
const clubFindUnique = jest.fn();
const historyFindMany = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    player: {
      findMany:   (...a: unknown[]) => playerFindMany(...a),
      findUnique: (...a: unknown[]) => playerFindUnique(...a),
      count:      (...a: unknown[]) => playerCount(...a),
    },
    marketplaceItem:      { findMany: (...a: unknown[]) => itemFindMany(...a) },
    playerContractStatus: {
      findMany:   (...a: unknown[]) => contractFindMany(...a),
      findUnique: (...a: unknown[]) => contractFindUnique(...a),
    },
    transferTarget: {
      findMany:   (...a: unknown[]) => targetFindMany(...a),
      findFirst:  (...a: unknown[]) => targetFindFirst(...a),
      create:     (...a: unknown[]) => targetCreate(...a),
      updateMany: (...a: unknown[]) => targetUpdateMany(...a),
    },
    clubRecruitmentNeed:   { findMany: (...a: unknown[]) => needFindMany(...a) },
    club: {
      findMany:   (...a: unknown[]) => clubFindMany(...a),
      findUnique: (...a: unknown[]) => clubFindUnique(...a),
    },
    athleteTransferHistory: { findMany: (...a: unknown[]) => historyFindMany(...a) },
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

import {
  discover, readPublicPlayer, readShortlist, addToShortlist, removeFromShortlist,
} from '../src/transfer-market/transfer-discovery.service';

const ME = { userId: 'u1', clubId: 'club-a' };
const YEAR = 365.25 * 24 * 3600 * 1000;

const player = (over: Record<string, unknown> = {}) => ({
  id: 'p-b1', firstName: 'Tomás', lastName: 'Ferreira', number: 9,
  position: 'ST', trainedPositions: 'ST', nationality: 'Portugal', flag: '🇵🇹',
  avatar: null, overallRating: 82, potential: 88, preferredFoot: 'RIGHT',
  marketValue: 12_000_000, contractUntil: new Date('2028-06-30'),
  clubId: 'club-b', dateOfBirth: new Date(Date.now() - 23 * YEAR),
  roles: 'AF · ST', isActive: true, ...over,
});

const need = (over: Record<string, unknown> = {}) => ({
  id: 'need-1', clubId: 'club-a', positions: 'ST',
  ageMin: 18, ageMax: 28, ratingMin: 75, ratingMax: null,
  budgetMinEur: null, budgetMaxEur: BigInt(30_000_000),
  nationality: null, preferredFoot: null, playstyle: null,
  contractPreference: null, priority: 'HIGH', note: 'internal',
  isActive: true, expiresAt: null, createdAt: new Date(), ...over,
});

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'listing-1', clubId: 'club-b', status: 'ACTIVE',
  validUntil: new Date(Date.now() + 3600_000), createdAt: new Date(),
  payload: { playerId: 'p-b1', askingPriceEur: 9_000_000 }, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  playerFindMany.mockResolvedValue([player()]);
  playerCount.mockResolvedValue(1);
  itemFindMany.mockResolvedValue([]);
  contractFindMany.mockResolvedValue([]);
  contractFindUnique.mockResolvedValue(null);
  targetFindMany.mockResolvedValue([]);
  targetFindFirst.mockResolvedValue(null);
  needFindMany.mockResolvedValue([]);
  clubFindMany.mockResolvedValue([{ id: 'club-b', name: 'FC Beispiel', shortName: 'BSP', emblem: null }]);
  clubFindUnique.mockResolvedValue({ id: 'club-b', name: 'FC Beispiel', shortName: 'BSP', emblem: null });
  historyFindMany.mockResolvedValue([]);
});

const whereOf = () => playerFindMany.mock.calls[0][0].where;

// ── 1 · 2 · 3 · 4 — who can be found ────────────────────────────────────────
describe('who a search can find', () => {
  it('reaches across clubs — it is not scoped to the caller\'s squad', async () => {
    const r = await discover(ME);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].player.clubId).toBe('club-b');
    expect(r.items[0].club.name).toBe('FC Beispiel');
  });

  it('never returns our own players by default', async () => {
    await discover(ME);
    expect(whereOf().clubId).toEqual({ not: 'club-a' });
  });

  it('includes them only when something internal asks, never from the wire', async () => {
    await discover(ME, { includeOwnPlayers: true });
    expect(whereOf().clubId).toBeUndefined();
  });

  it('excludes deactivated players', async () => {
    await discover(ME);
    expect(whereOf().isActive).toBe(true);
  });

  it('requires the player to belong to a club that exists', async () => {
    await discover(ME);
    expect(whereOf().club).toEqual({ is: {} });
  });
});

// ── 5 — pagination ──────────────────────────────────────────────────────────
describe('pagination', () => {
  it('pages on the server and reports the true total', async () => {
    playerCount.mockResolvedValue(137);
    const r = await discover(ME, { page: 3, limit: 20 });
    const args = playerFindMany.mock.calls[0][0];
    expect(args.skip).toBe(40);
    expect(args.take).toBe(20);
    expect(r.total).toBe(137);
    expect(r.page).toBe(3);
  });

  it('bounds the page size however large the request is', async () => {
    await discover(ME, { limit: 100000 });
    expect(playerFindMany.mock.calls[0][0].take).toBe(100);
  });

  it('orders totally, so page 2 cannot repeat page 1', async () => {
    await discover(ME);
    expect(playerFindMany.mock.calls[0][0].orderBy)
      .toEqual([{ overallRating: 'desc' }, { id: 'asc' }]);
  });
});

// ── 6 — every filter ────────────────────────────────────────────────────────
describe('the filters are applied by the server', () => {
  it('searches name and nationality', async () => {
    await discover(ME, { search: 'ferre' });
    expect(whereOf().OR).toEqual([
      { firstName:   { contains: 'ferre', mode: 'insensitive' } },
      { lastName:    { contains: 'ferre', mode: 'insensitive' } },
      { nationality: { contains: 'ferre', mode: 'insensitive' } },
    ]);
  });

  it('narrows to one club', async () => {
    await discover(ME, { clubId: 'club-c' });
    expect(whereOf().clubId).toBe('club-c');
  });

  it('narrows by nationality, position, second position and foot', async () => {
    await discover(ME, {
      nationality: 'Portugal', position: 'ST', secondaryPosition: 'AMC', preferredFoot: 'LEFT',
    });
    const w = whereOf();
    expect(w.nationality).toEqual({ equals: 'Portugal', mode: 'insensitive' });
    expect(w.position).toBe('ST');
    expect(w.trainedPositions).toEqual({ contains: 'AMC', mode: 'insensitive' });
    expect(w.preferredFoot).toBe('LEFT');
  });

  it('narrows by rating and by value', async () => {
    await discover(ME, { ovrMin: 75, ovrMax: 90, valueMin: 1e6, valueMax: 2e7 });
    const w = whereOf();
    expect(w.overallRating).toEqual({ gte: 75, lte: 90 });
    expect(w.marketValue).toEqual({ gte: 1e6, lte: 2e7 });
  });

  it('turns an age range into a birth-date range the right way round', async () => {
    await discover(ME, { ageMin: 18, ageMax: 23 });
    const dob = whereOf().dateOfBirth;
    // older than 18 → born before now-18y; no older than 23 → born after now-24y
    expect(dob.lte.getTime()).toBeLessThan(Date.now() - 17.9 * YEAR);
    expect(dob.gt.getTime()).toBeGreaterThan(Date.now() - 24.1 * YEAR);
    // and the boundary agrees with the age the projection shows
    expect(dob.lte.getTime()).toBeGreaterThan(dob.gt.getTime());
  });

  it('narrows to players who are actually at auction', async () => {
    itemFindMany.mockResolvedValue([
      listing({ id: 'l-auc', payload: { playerId: 'p-b1', mode: 'AUCTION', startingPriceEur: 5e6 } }),
      listing({ id: 'l-fix', payload: { playerId: 'p-b2', askingPriceEur: 3e6 } }),
    ]);
    await discover(ME, { auctionOnly: true });
    expect(whereOf().id).toEqual({ in: ['p-b1'] });
  });

  it('narrows to players who are listed at all', async () => {
    itemFindMany.mockResolvedValue([
      listing({ id: 'l-auc', payload: { playerId: 'p-b1', mode: 'AUCTION' } }),
      listing({ id: 'l-fix', payload: { playerId: 'p-b2', askingPriceEur: 3e6 } }),
    ]);
    await discover(ME, { listedOnly: true });
    expect(whereOf().id.in.sort()).toEqual(['p-b1', 'p-b2']);
  });

  it('narrows to players their club marked available but never listed', async () => {
    contractFindMany.mockResolvedValue([{ playerId: 'p-b1' }, { playerId: 'p-b9' }]);
    itemFindMany.mockResolvedValue([listing({ payload: { playerId: 'p-b9', askingPriceEur: 1e6 } })]);
    await discover(ME, { transferStatus: 'AVAILABLE' });
    // p-b9 is listed, so he is LISTED and not merely AVAILABLE
    expect(whereOf().id).toEqual({ in: ['p-b1'] });
  });

  it('narrows to players nobody put on the market, as an exclusion', async () => {
    contractFindMany.mockResolvedValue([{ playerId: 'p-avail' }]);
    itemFindMany.mockResolvedValue([listing({ payload: { playerId: 'p-listed' } })]);
    await discover(ME, { transferStatus: 'NOT_AVAILABLE' });
    expect(whereOf().id.notIn.sort()).toEqual(['p-avail', 'p-listed']);
  });

  it('narrows to the shortlist', async () => {
    targetFindMany.mockResolvedValue([{ playerId: 'p-b1' }]);
    await discover(ME, { shortlistedOnly: true });
    expect(whereOf().id).toEqual({ in: ['p-b1'] });
  });

  it('an impossible combination returns nothing rather than everything', async () => {
    targetFindMany.mockResolvedValue([{ playerId: 'p-x' }]);
    itemFindMany.mockResolvedValue([listing({ payload: { playerId: 'p-y', mode: 'AUCTION' } })]);
    const r = await discover(ME, { shortlistedOnly: true, auctionOnly: true });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
    expect(playerFindMany).not.toHaveBeenCalled();
  });
});

// ── 7 — private fields never serialized ─────────────────────────────────────
describe('a search result carries no private field', () => {
  it('and the SELECT never asked for one', async () => {
    await discover(ME);
    const sel = playerFindMany.mock.calls[0][0].select;
    for (const f of ['email', 'parentEmail', 'parentPhone', 'notes', 'medicalStatus', 'paymentStatus', 'weeklyWage']) {
      expect(sel[f]).toBeUndefined();
    }
  });

  it('not even when the database hands back a full row anyway', async () => {
    playerFindMany.mockResolvedValue([{
      ...player(),
      email: 'boy@example.com', parentEmail: 'mum@example.com', parentPhone: '+49 555 1234',
      notes: 'knee trouble', medicalStatus: 'INJURED', paymentStatus: 'OVERDUE',
      condition: 61, form: 3, morale: 'Poor', isInjured: true, weeklyWage: 40_000,
    }]);
    const json = JSON.stringify(await discover(ME));
    for (const leak of ['boy@example.com', 'mum@example.com', '+49 555 1234', 'knee trouble',
                        'INJURED', 'OVERDUE', 'medicalStatus', 'weeklyWage', 'isInjured']) {
      expect(json).not.toContain(leak);
    }
  });
});

// ── the product rule: discoverable ≠ for sale ───────────────────────────────
describe('discoverable is not the same as available', () => {
  it('a player at auction is AUCTION, and only opens the auction', async () => {
    itemFindMany.mockResolvedValue([listing({
      payload: { playerId: 'p-b1', mode: 'AUCTION', startingPriceEur: 5e6 },
    })]);
    const r = await discover(ME);
    expect(r.items[0].transferState).toBe('AUCTION');
    expect(r.items[0].actions).toEqual(['VIEW_AUCTION']);
    expect(r.items[0].listingId).toBe('listing-1');
  });

  it('a player at a fixed price is LISTED, and can be bought', async () => {
    itemFindMany.mockResolvedValue([listing()]);
    const r = await discover(ME);
    expect(r.items[0].transferState).toBe('LISTED');
    expect(r.items[0].actions).toContain('PURCHASE');
    expect(r.items[0].askingPriceEur).toBe(9_000_000);
  });

  it('a player his club marked available is AVAILABLE, and can be offered for', async () => {
    contractFindMany.mockResolvedValue([{ playerId: 'p-b1' }]);
    const r = await discover(ME);
    expect(r.items[0].transferState).toBe('AVAILABLE');
    expect(r.items[0].actions).toContain('MAKE_OFFER');
  });

  it('a player nobody put on the market can only be asked about', async () => {
    const r = await discover(ME);
    expect(r.items[0].transferState).toBe('NOT_AVAILABLE');
    expect(r.items[0].actions).toEqual(['REGISTER_INTEREST']);
    expect(r.items[0].askingPriceEur).toBeNull();
  });

  it('our own player carries no transfer action', async () => {
    playerFindMany.mockResolvedValue([player({ clubId: 'club-a' })]);
    const r = await discover(ME, { includeOwnPlayers: true });
    expect(r.items[0].transferState).toBe('OWN');
    expect(r.items[0].actions).toEqual([]);
  });
});

// ── 10 · 11 — need matching ─────────────────────────────────────────────────
describe('matching against our own needs', () => {
  it('marks a player who answers one of our open needs', async () => {
    needFindMany.mockResolvedValue([need()]);
    const r = await discover(ME);
    expect(r.items[0].needMatches).toHaveLength(1);
    expect(r.items[0].needMatches[0].needId).toBe('need-1');
    expect(r.items[0].needMatches[0].matchPct).toBeGreaterThanOrEqual(60);
    expect(r.items[0].needMatches[0].reasons.length).toBeGreaterThan(0);
  });

  it('reads only OUR needs — never another club\'s', async () => {
    await discover(ME);
    expect(needFindMany.mock.calls[0][0].where.clubId).toBe('club-a');
  });

  it('a player who plays none of the positions we asked for is not a match', async () => {
    needFindMany.mockResolvedValue([need({ positions: 'GK' })]);
    const r = await discover(ME);
    expect(r.items[0].needMatches).toEqual([]);
  });

  it('filtering by our needs drops everyone who does not answer one', async () => {
    needFindMany.mockResolvedValue([need({ positions: 'GK' })]);
    const r = await discover(ME, { matchesMyNeeds: true });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('and with no open need at all, asking for matches returns nothing', async () => {
    needFindMany.mockResolvedValue([]);
    const r = await discover(ME, { matchesMyNeeds: true });
    expect(r.items).toEqual([]);
  });

  it('is deterministic: the same player and need always score the same', async () => {
    needFindMany.mockResolvedValue([need()]);
    const a = await discover(ME);
    const b = await discover(ME);
    expect(a.items[0].needMatches[0].matchPct).toBe(b.items[0].needMatches[0].matchPct);
    expect(a.items[0].needMatches[0].reasons).toEqual(b.items[0].needMatches[0].reasons);
  });

  it('never leaks the private note a need carries', async () => {
    needFindMany.mockResolvedValue([need()]);
    expect(JSON.stringify(await discover(ME))).not.toContain('internal');
  });
});

// ── the public player ───────────────────────────────────────────────────────
describe('one player, publicly', () => {
  beforeEach(() => { playerFindUnique.mockResolvedValue(player()); });

  it('is readable across clubs, unlike the club\'s own player profile', async () => {
    const d = await readPublicPlayer(ME, 'p-b1');
    expect(d.player.id).toBe('p-b1');
    expect(d.club.name).toBe('FC Beispiel');
  });

  it('carries the public transfer record', async () => {
    historyFindMany.mockResolvedValue([{
      id: 'h1', athleteId: 'p-b1', fromClubRef: 'club-c', toClubRef: 'club-b',
      feeCents: BigInt(500_000_000), occurredAt: new Date('2024-07-01'),
    }]);
    clubFindMany.mockResolvedValue([
      { id: 'club-b', name: 'FC Beispiel', shortName: null, emblem: null },
      { id: 'club-c', name: 'SV Dritte', shortName: null, emblem: null },
    ]);
    const d = await readPublicPlayer(ME, 'p-b1');
    expect(d.history).toHaveLength(1);
    expect(d.history[0].feeEur).toBe(5_000_000);
    expect(d.history[0].from!.name).toBe('SV Dritte');
  });

  it('carries no private field', async () => {
    playerFindUnique.mockResolvedValue({
      ...player(), email: 'x@y.z', parentPhone: '+49 1', medicalStatus: 'INJURED', notes: 'secret',
    });
    const json = JSON.stringify(await readPublicPlayer(ME, 'p-b1'));
    for (const leak of ['x@y.z', '+49 1', 'INJURED', 'secret']) expect(json).not.toContain(leak);
  });

  it('refuses a deactivated player rather than showing him', async () => {
    playerFindUnique.mockResolvedValue(player({ isActive: false }));
    await expect(readPublicPlayer(ME, 'p-b1')).rejects.toThrow(/not found|Player/i);
  });

  it('offers only REGISTER INTEREST for a player nobody listed', async () => {
    const d = await readPublicPlayer(ME, 'p-b1');
    expect(d.transferState).toBe('NOT_AVAILABLE');
    expect(d.actions).toEqual(['REGISTER_INTEREST']);
  });

  it('opens the real auction when there is one', async () => {
    itemFindMany.mockResolvedValue([listing({
      payload: { playerId: 'p-b1', mode: 'AUCTION', startingPriceEur: 4e6 },
    })]);
    const d = await readPublicPlayer(ME, 'p-b1');
    expect(d.actions).toEqual(['VIEW_AUCTION']);
    expect(d.listingId).toBe('listing-1');
    expect(d.auctionEndsAt).toBeInstanceOf(Date);
  });
});

// ── 12 · 13 · 14 — the shortlist ────────────────────────────────────────────
describe('the shortlist is TransferTarget, and it is the club\'s', () => {
  it('adds a real player as a SHORTLIST-stage target', async () => {
    playerFindUnique.mockResolvedValue({ id: 'p-b1', clubId: 'club-b', isActive: true });
    targetCreate.mockResolvedValue({ id: 't1' });
    await addToShortlist(ME, 'p-b1');
    expect(targetCreate.mock.calls[0][0].data).toMatchObject({
      clubId: 'club-a', playerId: 'p-b1', stage: 'SHORTLIST', createdBy: 'u1',
    });
  });

  it('refuses a player who does not exist', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(addToShortlist(ME, 'nope')).rejects.toThrow();
  });

  it('adding twice is the same entry, not a second one', async () => {
    playerFindUnique.mockResolvedValue({ id: 'p-b1', clubId: 'club-b', isActive: true });
    targetFindFirst.mockResolvedValue({ id: 't-existing' });
    const again = await addToShortlist(ME, 'p-b1');
    expect(targetCreate).not.toHaveBeenCalled();
    expect((again as { id: string }).id).toBe('t-existing');
  });

  it('removes only from the acting club\'s own list', async () => {
    targetUpdateMany.mockResolvedValue({ count: 1 });
    await removeFromShortlist(ME, 'p-b1');
    expect(targetUpdateMany.mock.calls[0][0].where).toMatchObject({
      clubId: 'club-a', playerId: 'p-b1', archivedAt: null,
    });
  });

  it('cannot remove another club\'s entry — there is nothing to remove', async () => {
    targetUpdateMany.mockResolvedValue({ count: 0 });
    await expect(removeFromShortlist(ME, 'p-b1')).rejects.toThrow(/Shortlist/i);
  });

  it('reads only this club\'s targets', async () => {
    targetFindMany.mockResolvedValue([]);
    await readShortlist(ME);
    expect(targetFindMany.mock.calls[0][0].where).toMatchObject({ clubId: 'club-a', archivedAt: null });
  });

  it('hydrates each entry through the public projection', async () => {
    targetFindMany.mockResolvedValue([{
      id: 't1', playerId: 'p-b1', stage: 'SHORTLIST', priorityScore: 50,
      notes: null, createdAt: new Date(),
    }]);
    playerFindMany.mockResolvedValue([{ ...player(), parentPhone: '+49 999', email: 'kid@x.z' }]);
    const r = await readShortlist(ME);
    expect(r.items[0].player!.name).toBe('Tomás Ferreira');
    expect(r.items[0].transferState).toBe('NOT_AVAILABLE');
    const json = JSON.stringify(r);
    expect(json).not.toContain('+49 999');
    expect(json).not.toContain('kid@x.z');
  });

  it('archives a shortlisted player who is gone rather than keeping a dead row', async () => {
    // Group 7: a permanent `player: null` entry could neither be acted on nor
    // cleared, so the read archives it through TransferTarget's own lifecycle.
    targetFindMany.mockResolvedValue([{
      id: 't1', playerId: 'p-gone', stage: 'SHORTLIST', priorityScore: 50,
      notes: null, createdAt: new Date(),
    }]);
    playerFindMany.mockResolvedValue([]);
    const r = await readShortlist(ME);
    expect(r.items).toEqual([]);
    expect(r.archived).toBe(1);
    expect(targetUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ archivedAt: expect.any(Date) }),
    }));
  });

  it('marks which search results are already on it', async () => {
    targetFindMany.mockResolvedValue([{ playerId: 'p-b1' }]);
    const r = await discover(ME);
    expect(r.items[0].shortlisted).toBe(true);
  });
});

// ── no request per player ───────────────────────────────────────────────────
describe('a page of results is a bounded number of queries', () => {
  it('does not ask the database once per row', async () => {
    playerFindMany.mockResolvedValue(Array.from({ length: 25 }, (_, i) =>
      player({ id: 'p-' + i, clubId: 'club-b' })));
    playerCount.mockResolvedValue(25);
    needFindMany.mockResolvedValue([need()]);
    const r = await discover(ME);
    expect(r.items).toHaveLength(25);
    expect(playerFindMany).toHaveBeenCalledTimes(1);
    expect(clubFindMany).toHaveBeenCalledTimes(1);
    expect(itemFindMany).toHaveBeenCalledTimes(1);
    expect(needFindMany).toHaveBeenCalledTimes(1);
    expect(playerFindUnique).not.toHaveBeenCalled();
  });
});
