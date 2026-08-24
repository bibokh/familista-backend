/**
 * tests/listed-player-one-record.unit.test.ts
 *
 * A player listed from Squad, and the market that must show him.
 *
 * Reproduced in production: a player was listed from Squad, Squad showed him as
 * LISTED and offered "Listed — manage", and Transfers → Market → Live market
 * said "No club has a player on the market right now". Both were reading
 * honestly; they were reading different records.
 *
 * The server was never wrong here — a listing created through POST /listings
 * appears in GET /market immediately, to its own seller as well as to every
 * other club, and tests/market-one-truth covers that. What diverged was in the
 * browser. _tfStatusOf answered "is he listed?" from the server's own listings
 * when it could, and fell back to a listing store held in the tab when it could
 * not; the listing itself fell back the same way whenever the roster had not
 * hydrated. So a signed-in club could create a listing only its own tab knew
 * about: Squad read it and said LISTED, the market read the server and said
 * nothing, and no amount of refreshing reconciled them because they were never
 * the same record.
 *
 * The browser store belongs to the logged-out demo. Signed in, the server's
 * listing is the only listing, and a player whose canonical id has not arrived
 * cannot be listed at all — rather than listed somewhere nobody can see.
 *
 * Held here: the server half of the flow end to end (list → market → edit →
 * unlist → gone), club isolation across two clubs, and the browser contract
 * that stops the second store existing.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

function fnBody(name: string) {
  const at = APP.search(new RegExp(`(async )?function ${name}\\s*\\(`));
  if (at < 0) return '';
  let i = APP.indexOf('{', at), depth = 0, j = i;
  for (; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) break;
  }
  return APP.slice(i, j);
}

// ── the server half, against a Prisma the test drives ───────────────────────
const itemFindMany = jest.fn();
const itemCount = jest.fn();
const itemFindFirst = jest.fn();
const itemCreate = jest.fn();
const itemUpdate = jest.fn();
const itemUpdateMany = jest.fn();
const playerFindUnique = jest.fn();
const clubFindUnique = jest.fn();
const offerFindFirst = jest.fn();
const contractFindUnique = jest.fn();
const contractCreate = jest.fn();
const contractUpdate = jest.fn();
const $transaction = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    marketplaceItem: {
      findMany: (...a: unknown[]) => itemFindMany(...a),
      count: (...a: unknown[]) => itemCount(...a),
      findFirst: (...a: unknown[]) => itemFindFirst(...a),
      findUnique: (...a: unknown[]) => itemFindFirst(...a),
      create: (...a: unknown[]) => itemCreate(...a),
      update: (...a: unknown[]) => itemUpdate(...a),
      updateMany: (...a: unknown[]) => itemUpdateMany(...a),
    },
    player: { findUnique: (...a: unknown[]) => playerFindUnique(...a) },
    club: { findUnique: (...a: unknown[]) => clubFindUnique(...a) },
    transferOffer: { findFirst: (...a: unknown[]) => offerFindFirst(...a) },
    playerContractStatus: {
      findUnique: (...a: unknown[]) => contractFindUnique(...a),
      create: (...a: unknown[]) => contractCreate(...a),
      update: (...a: unknown[]) => contractUpdate(...a),
    },
    $transaction: (...a: unknown[]) => $transaction(...a),
  },
}));
jest.mock('../src/transfer-market/transfer-market.events', () => ({
  emitListingCreated: jest.fn(), emitListingClosed: jest.fn(), emitMarketChanged: jest.fn(),
}), { virtual: true });
jest.mock('../src/services/audit.service', () => ({ appendAuditEventAsync: jest.fn() }), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../src/transfer-market/transfer-market.service');

const CLUB_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CLUB_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const YASSER = 'cccccccc-3333-4333-8333-cccccccccccc';
const TEAM_ACADEMY = 'dddddddd-4444-4444-8444-dddddddddddd';

const actorA = { userId: 'u-a', clubId: CLUB_A };
const actorB = { userId: 'u-b', clubId: CLUB_B };

const player = {
  id: YASSER, clubId: CLUB_A, teamId: TEAM_ACADEMY, isActive: true,
  firstName: 'Yasser', lastName: 'B', position: 'ST', marketValue: 8_000_000,
  contractUntil: new Date('2027-06-30'),
};

// the row POST /listings would have written
const listingRow = {
  id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
  clubId: CLUB_A, kind: 'TRANSFER_LISTING', status: 'ACTIVE',
  validFrom: new Date(), validUntil: null, createdAt: new Date(),
  payload: { playerId: YASSER, sellerClubId: CLUB_A, sellerTeamId: TEAM_ACADEMY, askingPriceEur: 5_000_000 },
};

beforeEach(() => {
  jest.clearAllMocks();
  playerFindUnique.mockResolvedValue(player);
  clubFindUnique.mockResolvedValue({ id: CLUB_A, name: 'Club A' });
  offerFindFirst.mockResolvedValue(null);
  itemFindFirst.mockResolvedValue(null);
  // findActiveListingForPlayer scans ACTIVE rows; nothing is listed to begin with
  itemFindMany.mockResolvedValue([]);
  itemCount.mockResolvedValue(0);
  itemCreate.mockResolvedValue(listingRow);
  contractFindUnique.mockResolvedValue(null);
  $transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    typeof fn === 'function'
      ? fn({
          marketplaceItem: { create: itemCreate, update: itemUpdate, updateMany: itemUpdateMany },
          player: { findUnique: playerFindUnique },
          playerContractStatus: { findUnique: contractFindUnique, create: contractCreate, update: contractUpdate },
        })
      : fn);
});

describe('list a player from Squad, and the market shows him', () => {
  it('the listing is written against the canonical player, club and team', async () => {
    await svc.listPlayer(actorA, { playerId: YASSER, askingPriceEur: 5_000_000 });
    expect(itemCreate).toHaveBeenCalledTimes(1);
    const data = itemCreate.mock.calls[0][0].data;
    expect(data.clubId).toBe(CLUB_A);
    expect(data.status).toBe('ACTIVE');
    expect(data.payload.playerId).toBe(YASSER);
    expect(data.payload.sellerClubId).toBe(CLUB_A);
    // the age group he was listed from travels with the listing
    expect(data.payload.sellerTeamId).toBe(TEAM_ACADEMY);
    expect(data.payload.askingPriceEur).toBe(5_000_000);
  });

  it('and the same row comes back on the market board, to his own club', async () => {
    itemFindMany.mockResolvedValue([listingRow]);
    itemCount.mockResolvedValue(1);
    const out = await svc.readMarket(actorA, {});
    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].listingId).toBe(listingRow.id);
    expect(out.items[0].player.id).toBe(YASSER);
    expect(out.items[0].isMine).toBe(true);
    // the board's query does not exclude the seller
    const where = itemFindMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('not');
    expect(where.status).toBe('ACTIVE');
  });

  it('and to a different club, as somebody else\'s listing', async () => {
    itemFindMany.mockResolvedValue([listingRow]);
    itemCount.mockResolvedValue(1);
    const out = await svc.readMarket(actorB, {});
    expect(out.items).toHaveLength(1);
    expect(out.items[0].listingId).toBe(listingRow.id);
    expect(out.items[0].isMine).toBe(false);
  });

  it('and on his own club\'s management surface', async () => {
    itemFindMany.mockResolvedValue([listingRow]);
    const out = await svc.readOwnListings(actorA);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].listingId).toBe(listingRow.id);
    expect(itemFindMany.mock.calls[0][0].where.clubId).toBe(CLUB_A);
  });
});

describe('managing it never creates a second one', () => {
  it('listing an already-listed player returns the listing he already has', async () => {
    itemFindMany.mockResolvedValue([listingRow]);
    const again = await svc.listPlayer(actorA, { playerId: YASSER, askingPriceEur: 9_000_000 });
    expect(again.id).toBe(listingRow.id);
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it('and unlisting takes that row out of the market', async () => {
    itemFindFirst.mockResolvedValue(listingRow);
    itemFindMany.mockResolvedValue([listingRow]);
    itemUpdateMany.mockResolvedValue({ count: 1 });
    itemUpdate.mockResolvedValue({ ...listingRow, status: 'CLOSED' });
    await svc.delistPlayer(actorA, listingRow.id);
    const wrote = [...itemUpdate.mock.calls, ...itemUpdateMany.mock.calls];
    expect(wrote.length).toBeGreaterThan(0);
    expect(JSON.stringify(wrote)).toContain('CLOSED');
    // and a CLOSED row is not what the board asks for
    itemFindMany.mockResolvedValue([]);
    itemCount.mockResolvedValue(0);
    const out = await svc.readMarket(actorA, {});
    expect(out.items).toHaveLength(0);
  });
});

describe('club isolation', () => {
  it('a club cannot list a player belonging to another club', async () => {
    playerFindUnique.mockResolvedValue({ ...player, clubId: CLUB_A });
    await expect(svc.listPlayer(actorB, { playerId: YASSER, askingPriceEur: 1 }))
      .rejects.toThrow(/another club/i);
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it('and a club\'s own management surface never returns another club\'s listings', async () => {
    itemFindMany.mockResolvedValue([]);
    await svc.readOwnListings(actorB);
    expect(itemFindMany.mock.calls[0][0].where.clubId).toBe(CLUB_B);
  });
});

// ── the browser half: the second store is gone ──────────────────────────────
describe('signed in, the server\'s listing is the only listing', () => {
  it('the LISTED badge stops consulting the tab\'s own store', () => {
    const f = fnBody('_tfStatusOf');
    // the server is asked first, as it always was
    expect(f).toContain('_tfMyListingFor(playerId)');
    // and a signed-in session never falls through to the browser record
    expect(f).toContain('if (_tfHasSession()) return { listed: false };');
    expect(f.indexOf('if (_tfHasSession()) return { listed: false };'))
      .toBeLessThan(f.indexOf('_tfListingFor(playerId)'));
  });

  it('and a signed-in listing is created on the server or not at all', () => {
    const wire = APP.slice(APP.indexOf("t.closest('[data-tf-list-confirm]')"),
                           APP.indexOf("t.closest('[data-tf-list-confirm]')") + 2600);
    expect(wire).toContain('if (_tfHasSession()) {');
    expect(wire).toContain('_tfServerList(p, price, { instant: instantSale })');
    // the browser store is reachable only when there is no session
    expect(wire.indexOf('_tfCreateListing(C, p, price'))
      .toBeGreaterThan(wire.indexOf('if (_tfHasSession()) {'));
  });
});

describe('entering a club lifts its roster into the store every surface resolves through', () => {
  it('switchClub loads the squad after hydrating it', () => {
    const sw = APP.slice(APP.indexOf('async function switchClub('), APP.indexOf('async function switchTeam('));
    expect(sw).toContain('_thHydrate()');
    expect(sw).toContain('_sqLoad()');
    // the lift happens after the read it depends on, and only when it succeeded
    expect(sw.indexOf('_sqLoad()')).toBeGreaterThan(sw.indexOf('_thHydrate()'));
    expect(sw).toContain('if (hydrated && typeof _sqLoad === \'function\')');
  });

  it('and the store it fills is the one the team context resolves against', () => {
    // _sqLoad replaces the demo squad with the server's adapted Player rows,
    // whose id is the canonical UUID; _sqP is what every findPlayer goes through
    const load = fnBody('_sqLoad');
    expect(load).toContain('_sqBackendSquad()');
    expect(load).toContain('SQ_DEMO_PLAYERS.length = 0');
    expect(fnBody('_sqBackendSquad')).toContain('_sqAdaptBackendPlayer');
    expect(APP).toContain("id: bp.id,");          // the adapter keeps the server id
    expect(APP).toContain('findPlayer: function (id) { return _sqP(id); }');
  });
});

describe('a transfer action carries the canonical player id', () => {
  it('the module knows what a canonical id is', () => {
    expect(APP).toContain('var TF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;');
    expect(fnBody('_tfIsCanonicalId')).toContain('TF_UUID_RE.test');
  });

  it('and refuses to send anything else, rather than inventing one', () => {
    const wire = APP.slice(APP.indexOf("t.closest('[data-tf-list-confirm]')"),
                           APP.indexOf("t.closest('[data-tf-list-confirm]')") + 2600);
    expect(wire).toContain('if (!_tfIsCanonicalId(p.id))');
    expect(wire.indexOf('if (!_tfIsCanonicalId(p.id))')).toBeLessThan(wire.indexOf('_tfServerList('));
    const offer = APP.slice(APP.indexOf("t.closest('[data-tf-offer-clubs]')"),
                            APP.indexOf("t.closest('[data-tf-offer-clubs]')") + 1400);
    expect(offer).toContain('if (!_tfIsCanonicalId(pid0))');
    expect(offer.indexOf('if (!_tfIsCanonicalId(pid0))')).toBeLessThan(offer.indexOf("'/offer-to-clubs'"));
    // no id is ever manufactured to get past the check
    expect(APP).not.toMatch(/toUuid|asUuid|fakeUuid|padUuid/i);
  });

  it('and the server still refuses a non-UUID, unweakened', () => {
    const ctrl = readFileSync(join(__dirname, '..', 'src', 'controllers', 'transfer-market.controller.ts'), 'utf8');
    expect(ctrl).toContain("requireUUID(dto?.playerId, 'playerId')");
    expect(ctrl).toContain("requireUUID(req.params.listingId, 'listingId')");
  });
});
