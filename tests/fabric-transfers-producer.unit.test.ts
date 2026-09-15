/**
 * tests/fabric-transfers-producer.unit.test.ts
 *
 * The player Transfers domain as a Data Fabric producer. The strictest of the
 * migrations so far, because a transfer is made of money and of private words
 * and neither may leave the module.
 *
 * ONE — MONEY NEVER TRAVELS. A fee, a bid, an asking price, a wage, a sell-on
 * percentage, a balance: every one of them is planted in the fixtures below at
 * a value that is searched for, as a number and as a string, in every event and
 * in every frame the board would draw. So are the words — an offer's message, a
 * scout's note on a child, a listing's private note.
 *
 * TWO — ONE SOURCE, FIVE FAMILIES. Listings, offers, negotiations, the
 * shortlist and completed moves are one lane and one card. They are told apart
 * by name and by `transferStage`, never by a source of their own.
 *
 * THREE — ONE CANONICAL EVENT PER ACTION. A transfer has two clubs in it and is
 * published ONCE, scoped to the club that acted, with the other named in the
 * payload. Every assertion is on the EXACT SET an action produced, because a
 * test checking "the event appears" passes just as well against a service that
 * publishes it twice.
 *
 * FOUR — THE SUBJECT IS THE ARTIFACT. A listing, an offer, a registered
 * interest, a shortlist entry. Never the footballer, who is frequently a child.
 *
 * FIVE — COACH MARKET IS SOMEWHERE ELSE. Asserted structurally, from the
 * source, rather than by hoping it stays that way.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER  = '22222222-2222-4222-8222-222222222222';
const THIRD  = '33333333-3333-4333-8333-333333333333';
const PLAYER = '44444444-4444-4444-8444-444444444444';
const LISTING = 'listing-0001';
const OFFER   = 'offer-0001';
const ACTOR   = 'u-actor';

/** Every figure and every private word the module handles. None may travel. */
const SECRETS = {
  askingPriceEur: 4_250_000,
  minAcceptableEur: 3_900_000,
  feeEur: 4_100_000,
  bidEur: 4_300_000,
  addOnsEur: 250_000,
  sellOnPct: 15,
  balanceEur: 12_000_000,
  offerMessage: 'We can pay 4.1m up front, rest on appearances. Our IBAN is GB29NWBK60161331926819.',
  listingNote: 'Release clause 3.9m expires in June — do not let his agent see this',
  scoutNote: 'Mother has asked that we not approach until he turns 16. Address: 14 Church Road, M20 6RQ',
  interestMessage: 'Would you take 3.8m? We are also talking to his brother’s club.',
};

const state = {
  players: [] as Row[], listings: [] as Row[], offers: [] as Row[],
  interests: [] as Row[], targets: [] as Row[], bids: [] as Row[],
  contracts: [] as Row[], clubs: [] as Row[], notifications: [] as Row[],
  audit: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((o) => match(row, o));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
    }
    // A nullable column nobody wrote reads as NULL, which is what the database
    // would say. Without this every `archivedAt: null` guard silently misses.
    if (v === null) return row[k] == null;
    return row[k] === v;
  });

const copy = <T>(row: T): T => {
  if (row == null) return row;
  return JSON.parse(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as T;
};

/** A table, in the handful of shapes the transfer services actually call. */
const table = (rows: () => Row[], prefix: string, defaults: Row = {}) => ({
  findUnique: async ({ where }: Row) => copy(rows().find((r) => r.id === where.id) ?? null),
  findFirst: async ({ where = {} }: Row = {}) => copy(rows().find((r) => match(r, where)) ?? null),
  findMany: async ({ where = {} }: Row = {}) => copy(rows().filter((r) => match(r, where))),
  count: async ({ where = {} }: Row = {}) => rows().filter((r) => match(r, where)).length,
  create: async ({ data }: Row) => {
    const row = { id: `${prefix}-${rows().length + 1}`, createdAt: new Date(), ...defaults, ...data };
    rows().push(row); return copy(row);
  },
  update: async ({ where, data }: Row) => {
    const r = rows().find((x) => x.id === where.id)!;
    Object.assign(r, data); return copy(r);
  },
  updateMany: async ({ where = {}, data }: Row = {}) => {
    const hits = rows().filter((r) => match(r, where));
    hits.forEach((r) => Object.assign(r, data));
    return { count: hits.length };
  },
});

const db: Row = {
  player: {
    ...table(() => state.players, 'p'),
  },
  marketplaceItem: table(() => state.listings, 'listing', { status: 'ACTIVE' }),
  transferOffer: table(() => state.offers, 'offer', { status: 'PENDING' }),
  transferInterest: table(() => state.interests, 'interest', { status: 'OPEN' }),
  transferTarget: table(() => state.targets, 'target', { archivedAt: null }),
  transferBid: table(() => state.bids, 'bid'),
  playerOfferToClub: table(() => [], 'pofc'),
  playerContractStatus: {
    findUnique: async ({ where }: Row) => copy(state.contracts.find((c) => c.playerId === where.playerId) ?? null),
    create: async ({ data }: Row) => { state.contracts.push(data); return copy(data); },
    update: async ({ where, data }: Row) => {
      const c = state.contracts.find((x) => x.playerId === where.playerId)!;
      Object.assign(c, data); return copy(c);
    },
    updateMany: async () => ({ count: 0 }),
  },
  club: table(() => state.clubs, 'club'),
  team: { findFirst: async () => null, findMany: async () => [] },
  membership: { findMany: async () => [] },
  user: { findMany: async () => [] },
  userNotification: { create: async ({ data }: Row) => { state.notifications.push(data); return data; }, createMany: async () => ({ count: 0 }) },
  clubTransferBalance: {
    findUnique: async () => null,
    upsert: async () => ({}),
  },
  athleteTransferHistory: { create: async ({ data }: Row) => data },
  auditEvent: { create: async ({ data }: Row) => { state.audit.push(data); return data; } },
  platformAuditEvent: { create: async ({ data }: Row) => data },
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));
jest.mock('../src/realtime/market-channel', () => ({
  publishPublic: () => {}, publishToClubs: () => {},
}));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor } from '../src/fabric/pulse/pulse.service';
import { fabricEvent, fabricEventsForSource } from '../src/fabric/registry/event-registry';
import { visibleFabricSources } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import '../src/fabric/producers/transfers.producer';

import * as events from '../src/transfer-market/transfer-events';
import * as discovery from '../src/transfer-market/transfer-discovery.service';
import * as negotiation from '../src/transfer-market/transfer-negotiation.service';

let published: FamilistaEvent[] = [];

/** Detached, and the completed-transfer path resolves a join on the way. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

const ACTOR_CTX = { userId: ACTOR, clubId: BUYER };

beforeEach(() => {
  published = [];
  setEventTransport(transport);
  state.players = [{
    id: PLAYER, clubId: SELLER, teamId: null, isActive: true,
    firstName: 'Tomás', lastName: 'Müller-Fernández', position: 'ST',
    contractUntil: new Date('2027-06-30T00:00:00Z'),
  }];
  state.listings = [];
  state.offers = [];
  state.interests = [];
  state.targets = [];
  state.bids = [];
  state.contracts = [];
  state.clubs = [
    { id: SELLER, name: 'FC Familista', country: 'DE' },
    { id: BUYER, name: 'SV Nord', country: 'NO' },
    { id: THIRD, name: 'Club Tercero', country: 'ES' },
  ];
  state.notifications = [];
  state.audit = [];
});

afterEach(async () => { await settle(); });
afterAll(async () => { await settle(); setEventTransport(null); });

const types = () => published.map((e) => e.eventType).sort();
const one = (type: string) => {
  const hits = published.filter((e) => e.eventType === type);
  expect(`${type} count: ${hits.length}`).toBe(`${type} count: 1`);
  return hits[0];
};

// ══════════════════════════════════════════════════════════════════════════════
// 1 · LISTINGS
// ══════════════════════════════════════════════════════════════════════════════

describe('a listing', () => {
  it('publishes exactly one transfer.listed, on the selling club, with the kind and no price', async () => {
    events.emitListingCreated(SELLER, PLAYER, LISTING, ACTOR);
    await settle();

    expect(types()).toEqual(['transfer.listed']);
    const e = one('transfer.listed');
    expect(e.clubId).toBe(SELLER);
    expect(e.subjectType).toBe('TRANSFER');
    expect(e.subjectId).toBe(LISTING);
    expect(e.actorUserId).toBe(ACTOR);
    expect(e.payload).toEqual({
      listingKind: 'FIXED_PRICE', playerId: PLAYER,
      counterpartyClubId: null, transferStage: 'LISTING',
    });
  });

  it('an auction and an open-market advert are the same event with a different kind', async () => {
    events.emitAuctionCreated(SELLER, PLAYER, LISTING, 'AUCTION', ACTOR);
    events.emitOpenMarketPublished(SELLER, PLAYER, 'listing-0002', true, ACTOR);
    events.emitOpenMarketPublished(SELLER, PLAYER, 'listing-0003', false, ACTOR);
    await settle();

    expect(types()).toEqual(['transfer.listed', 'transfer.listed', 'transfer.listed']);
    expect(published.map((e) => (e.payload as Row).listingKind))
      .toEqual(['AUCTION', 'OPEN_MARKET', 'OPEN_MARKET']);
    // and all three on the ONE Transfers lane, never a card of their own
    expect(new Set(published.map((e) => sourceLaneFor(e.eventType)))).toEqual(new Set(['Transfers']));
  });

  it('a listing the seller pulls and an auction the clock ends are told apart', async () => {
    events.emitListingWithdrawn(SELLER, PLAYER, LISTING, 'OPEN_MARKET', ACTOR);
    events.emitAuctionSettled(LISTING, PLAYER, SELLER, null, []);
    await settle();

    const withdrawals = published.filter((e) => e.eventType === 'transfer.listing.withdrawn');
    expect(withdrawals).toHaveLength(2);
    expect(withdrawals.map((e) => (e.payload as Row).withdrawnBy)).toEqual(['SELLER', 'EXPIRY']);
  });

  it('an auction that SOLD records no withdrawal — the completion is the event', async () => {
    events.emitAuctionSettled(LISTING, PLAYER, SELLER, BUYER, [THIRD]);
    await settle();
    expect(types()).toEqual([]);
  });

  it('extending a listing publishes transfer.listing.updated and never the new deadline', async () => {
    events.emitListingExtended(SELLER, PLAYER, LISTING, 'OPEN_MARKET', ACTOR);
    await settle();

    expect(types()).toEqual(['transfer.listing.updated']);
    expect(Object.keys(one('transfer.listing.updated').payload as Row).sort())
      .toEqual(['counterpartyClubId', 'listingKind', 'playerId', 'transferStage']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2 · OFFERS AND BIDS
// ══════════════════════════════════════════════════════════════════════════════

describe('an offer', () => {
  it('each of the five states publishes exactly one event, under its own name', async () => {
    events.emitOffer('OFFER_CREATED',   SELLER, BUYER, PLAYER, OFFER, BUYER, ACTOR);
    events.emitOffer('OFFER_COUNTERED', SELLER, BUYER, PLAYER, OFFER, SELLER, ACTOR);
    events.emitOffer('OFFER_ACCEPTED',  SELLER, BUYER, PLAYER, OFFER, SELLER, ACTOR);
    events.emitOffer('OFFER_REJECTED',  SELLER, BUYER, PLAYER, 'offer-0002', SELLER, ACTOR);
    events.emitOffer('OFFER_WITHDRAWN', SELLER, BUYER, PLAYER, 'offer-0003', BUYER, ACTOR);
    await settle();

    expect(types()).toEqual([
      'transfer.offer.accepted', 'transfer.offer.created', 'transfer.offer.rejected',
      'transfer.offer.updated', 'transfer.offer.withdrawn',
    ]);
  });

  it('is scoped to the club that acted, with the other one named — once, not once per club', async () => {
    events.emitOffer('OFFER_CREATED', SELLER, BUYER, PLAYER, OFFER, BUYER, ACTOR);
    await settle();

    const e = one('transfer.offer.created');
    expect(e.clubId).toBe(BUYER);                                  // the buyer made it
    expect((e.payload as Row).counterpartyClubId).toBe(SELLER);    // the seller received it
    expect(e.subjectId).toBe(OFFER);
    expect((e.payload as Row).transferStage).toBe('OFFER');
  });

  it('the seller accepting is scoped to the seller, and the counterparty flips with it', async () => {
    events.emitOffer('OFFER_ACCEPTED', SELLER, BUYER, PLAYER, OFFER, SELLER, ACTOR);
    await settle();

    const e = one('transfer.offer.accepted');
    expect(e.clubId).toBe(SELLER);
    expect((e.payload as Row).counterpartyClubId).toBe(BUYER);
  });

  it('a counter is transfer.offer.updated — one negotiation at a new figure, not a new one', async () => {
    events.emitOffer('OFFER_COUNTERED', SELLER, BUYER, PLAYER, OFFER, SELLER, ACTOR);
    await settle();
    expect(types()).toEqual(['transfer.offer.updated']);
  });

  it('a bid says whether it displaced a leader, and never how much it was', async () => {
    events.emitAuctionBid(LISTING, PLAYER, SELLER, BUYER, null, ACTOR);
    events.emitAuctionBid(LISTING, PLAYER, SELLER, THIRD, BUYER, ACTOR);
    await settle();

    const bids = published.filter((e) => e.eventType === 'transfer.bid.placed');
    expect(bids).toHaveLength(2);
    expect(bids.map((e) => (e.payload as Row).displacedLeader)).toEqual([false, true]);
    // the bidder acted; the seller is on the other side of it
    expect(bids[0].clubId).toBe(BUYER);
    expect((bids[0].payload as Row).counterpartyClubId).toBe(SELLER);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3 · NEGOTIATIONS — persisted transitions only
// ══════════════════════════════════════════════════════════════════════════════

describe('a negotiation', () => {
  it('starts on the club that asked, and carries no message', async () => {
    events.emitInterest(SELLER, BUYER, PLAYER, 'interest-1', ACTOR);
    await settle();

    const e = one('transfer.negotiation.started');
    expect(e.clubId).toBe(BUYER);
    expect((e.payload as Row).counterpartyClubId).toBe(SELLER);
    expect(e.subjectId).toBe('interest-1');
    expect(Object.keys(e.payload as Row).sort())
      .toEqual(['counterpartyClubId', 'playerId', 'transferStage']);
  });

  it('moves on the OWNER’s answer, carrying the token and not the words', async () => {
    events.emitInterestAnswered(SELLER, BUYER, PLAYER, 'interest-1', 'NOT_FOR_SALE', ACTOR);
    await settle();

    const e = one('transfer.negotiation.updated');
    expect(e.clubId).toBe(SELLER);
    expect((e.payload as Row).outcome).toBe('NOT_FOR_SALE');
    expect((e.payload as Row).counterpartyClubId).toBe(BUYER);
  });

  it('completes when a formal offer supersedes it — and publishes nothing when there was none', async () => {
    events.emitNegotiationSuperseded('interest-1', SELLER, BUYER, PLAYER, ACTOR);
    await settle();
    expect(types()).toEqual(['transfer.negotiation.completed']);
    expect(one('transfer.negotiation.completed').clubId).toBe(BUYER);

    published = [];
    events.emitNegotiationSuperseded(null, SELLER, BUYER, PLAYER, ACTOR);
    events.emitNegotiationSuperseded(undefined, SELLER, BUYER, PLAYER, ACTOR);
    await settle();
    expect(types()).toEqual([]);
  });

  it('every negotiation event carries the NEGOTIATION stage', async () => {
    events.emitInterest(SELLER, BUYER, PLAYER, 'interest-1', ACTOR);
    events.emitInterestAnswered(SELLER, BUYER, PLAYER, 'interest-1', 'INVITED', ACTOR);
    events.emitNegotiationSuperseded('interest-1', SELLER, BUYER, PLAYER, ACTOR);
    await settle();

    expect(published.map((e) => (e.payload as Row).transferStage))
      .toEqual(['NEGOTIATION', 'NEGOTIATION', 'NEGOTIATION']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4 · COMPLETION — and the Players domain beside it
// ══════════════════════════════════════════════════════════════════════════════

describe('a completed transfer', () => {
  it('publishes transfer.completed AND player.transferred, each exactly once', async () => {
    events.emitTransferCompleted(SELLER, BUYER, PLAYER, { offerId: OFFER }, 'OFFER_ACCEPTED', ACTOR);
    await settle();

    expect(types()).toEqual(['player.transferred', 'transfer.completed']);
    one('transfer.completed');
    one('player.transferred');
  });

  it('names both clubs outright, on the acquiring club, with no fee', async () => {
    events.emitTransferCompleted(SELLER, BUYER, PLAYER, { listingId: LISTING }, 'PURCHASE', ACTOR);
    await settle();

    const e = one('transfer.completed');
    expect(e.clubId).toBe(BUYER);                // where the player now is
    expect(e.subjectId).toBe(LISTING);           // the artifact that settled
    expect(e.payload).toEqual({
      originatingClubId: SELLER, destinationClubId: BUYER,
      settledBy: 'PURCHASE', playerId: PLAYER, transferStage: 'COMPLETION',
    });
  });

  it('the two events describe different things — one is the deal, one is the footballer', async () => {
    events.emitTransferCompleted(SELLER, BUYER, PLAYER, { offerId: OFFER }, 'AUCTION', ACTOR);
    await settle();

    expect(one('transfer.completed').subjectType).toBe('TRANSFER');
    expect(one('player.transferred').subjectType).toBe('PLAYER');
    expect(one('transfer.completed').subjectId).toBe(OFFER);
    expect(one('player.transferred').subjectId).toBe(PLAYER);
  });

  it('all three settlement routes record the route they took', async () => {
    for (const how of ['PURCHASE', 'OFFER_ACCEPTED', 'AUCTION'] as const) {
      published = [];
      events.emitTransferCompleted(SELLER, BUYER, PLAYER, { offerId: OFFER }, how, ACTOR);
      await settle();
      expect((one('transfer.completed').payload as Row).settledBy).toBe(how);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5 · THE SHORTLIST — durable actions only, through the real service
// ══════════════════════════════════════════════════════════════════════════════

describe('the shortlist', () => {
  it('adding a player publishes exactly one transfer.shortlisted, after the row exists', async () => {
    const row = await discovery.addToShortlist(ACTOR_CTX, PLAYER, SECRETS.scoutNote);
    await settle();

    expect(types()).toEqual(['transfer.shortlisted']);
    const e = one('transfer.shortlisted');
    expect(e.clubId).toBe(BUYER);
    expect(e.subjectId).toBe(row.id);
    expect(state.targets).toHaveLength(1);
  });

  it('asking twice announces nothing the second time', async () => {
    await discovery.addToShortlist(ACTOR_CTX, PLAYER);
    await settle();
    published = [];

    await discovery.addToShortlist(ACTOR_CTX, PLAYER);
    await settle();
    expect(types()).toEqual([]);
    expect(state.targets).toHaveLength(1);
  });

  it('removing publishes transfer.unshortlisted and names the entry that was archived', async () => {
    const row = await discovery.addToShortlist(ACTOR_CTX, PLAYER);
    await settle();
    published = [];

    await discovery.removeFromShortlist(ACTOR_CTX, PLAYER);
    await settle();
    expect(types()).toEqual(['transfer.unshortlisted']);
    expect(one('transfer.unshortlisted').subjectId).toBe(row.id);
  });

  it('removing something that is not on the list throws and announces nothing', async () => {
    await expect(discovery.removeFromShortlist(ACTOR_CTX, PLAYER)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('a shortlist event has nowhere to put a scouting note', async () => {
    await discovery.addToShortlist(ACTOR_CTX, PLAYER, SECRETS.scoutNote);
    await settle();
    expect(Object.keys(one('transfer.shortlisted').payload as Row).sort())
      .toEqual(['counterpartyClubId', 'playerId', 'transferStage']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6 · PUBLISH ONLY AFTER SUCCESS — through the real services
// ══════════════════════════════════════════════════════════════════════════════

describe('a business operation that fails', () => {
  it('registering interest in your own player publishes nothing', async () => {
    await expect(
      negotiation.registerInterest({ userId: ACTOR, clubId: SELLER }, PLAYER, SECRETS.interestMessage),
    ).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('registering interest in a player who does not exist publishes nothing', async () => {
    await expect(negotiation.registerInterest(ACTOR_CTX, 'no-such-player')).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('answering an interest that belongs to another club publishes nothing', async () => {
    state.interests.push({
      id: 'interest-1', playerId: PLAYER, ownerClubId: SELLER,
      interestedClubId: BUYER, status: 'OPEN',
    });
    await expect(
      negotiation.respondToInterest({ userId: ACTOR, clubId: THIRD }, 'interest-1', 'DECLINED'),
    ).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('a real registration publishes one negotiation.started, after the row is written', async () => {
    await negotiation.registerInterest(ACTOR_CTX, PLAYER, SECRETS.interestMessage);
    await settle();

    expect(types()).toEqual(['transfer.negotiation.started']);
    expect(state.interests).toHaveLength(1);
    expect(one('transfer.negotiation.started').subjectId).toBe(state.interests[0].id);
  });

  it('registering twice is the same question — one row, one event', async () => {
    await negotiation.registerInterest(ACTOR_CTX, PLAYER, SECRETS.interestMessage);
    await settle();
    published = [];

    await negotiation.registerInterest(ACTOR_CTX, PLAYER, SECRETS.interestMessage);
    await settle();
    expect(types()).toEqual([]);
    expect(state.interests).toHaveLength(1);
  });

  it('a real answer publishes one negotiation.updated carrying the persisted status', async () => {
    await negotiation.registerInterest(ACTOR_CTX, PLAYER, SECRETS.interestMessage);
    await settle();
    published = [];

    const id = state.interests[0].id;
    await negotiation.respondToInterest({ userId: ACTOR, clubId: SELLER }, id, 'INVITED');
    await settle();

    expect(types()).toEqual(['transfer.negotiation.updated']);
    expect((one('transfer.negotiation.updated').payload as Row).outcome).toBe('INVITED');
    expect(state.interests[0].status).toBe('INVITED');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7 · NOTHING PRIVATE TRAVELS
// ══════════════════════════════════════════════════════════════════════════════

describe('redaction', () => {
  const everything = () => {
    const frames = published.map((e) => project(e, 'STORED'));
    return JSON.stringify({ published, frames });
  };

  it('no figure and no private word survives any Transfers event or frame', async () => {
    await discovery.addToShortlist(ACTOR_CTX, PLAYER, SECRETS.scoutNote);
    await negotiation.registerInterest(ACTOR_CTX, PLAYER, SECRETS.interestMessage);
    events.emitListingCreated(SELLER, PLAYER, LISTING, ACTOR);
    events.emitOffer('OFFER_CREATED', SELLER, BUYER, PLAYER, OFFER, BUYER, ACTOR);
    events.emitAuctionBid(LISTING, PLAYER, SELLER, BUYER, THIRD, ACTOR);
    events.emitTransferCompleted(SELLER, BUYER, PLAYER, { offerId: OFFER }, 'OFFER_ACCEPTED', ACTOR);
    await settle();

    const blob = everything();
    for (const [name, secret] of Object.entries(SECRETS)) {
      // A two-digit percentage is a substring of half the ids and timestamps in
      // the blob, so searching for it proves nothing either way. The figures
      // worth searching for are searched for; the short one is covered by the
      // structural rule below, which is stronger than any substring sweep.
      if (typeof secret === 'number' && secret < 10_000) continue;
      expect(`${name}: ${blob.includes(String(secret))}`).toBe(`${name}: false`);
      expect(`${name} digits: ${blob.includes(String(secret).slice(0, 6))}`)
        .toBe(`${name} digits: false`);
    }
    // and the player's own name, which is data about a person and not a key
    expect(blob).not.toContain('Müller-Fernández');
    expect(blob).not.toContain('Tomás');
  });

  it('NO Transfers payload carries a number at all — which is what makes a figure impossible', async () => {
    events.emitListingCreated(SELLER, PLAYER, LISTING, ACTOR);
    events.emitListingWithdrawn(SELLER, PLAYER, LISTING, 'AUCTION', ACTOR);
    events.emitOffer('OFFER_ACCEPTED', SELLER, BUYER, PLAYER, OFFER, SELLER, ACTOR);
    events.emitAuctionBid(LISTING, PLAYER, SELLER, BUYER, THIRD, ACTOR);
    events.emitInterest(SELLER, BUYER, PLAYER, 'interest-1', ACTOR);
    events.emitInterestAnswered(SELLER, BUYER, PLAYER, 'interest-1', 'INVITED', ACTOR);
    events.emitShortlisted(BUYER, PLAYER, 'target-1', ACTOR);
    events.emitTransferCompleted(SELLER, BUYER, PLAYER, { offerId: OFFER }, 'PURCHASE', ACTOR);
    await settle();

    const transfers = published.filter((e) => e.eventType.startsWith('transfer.'));
    expect(transfers.length).toBeGreaterThan(7);
    for (const e of transfers) {
      for (const [k, v] of Object.entries(e.payload as Row)) {
        expect(`${e.eventType}.${k} is a ${typeof v}`).not.toBe(`${e.eventType}.${k} is a number`);
        expect(`${e.eventType}.${k}`).not.toMatch(
          /fee|price|amount|wage|salary|bonus|clause|balance|budget|pct|percent|note|message|iban|address/i,
        );
      }
    }
  });

  it('a frame carries no payload at all, so playerId never reaches the board', async () => {
    events.emitListingCreated(SELLER, PLAYER, LISTING, ACTOR);
    await settle();

    const frame = project(published[0], 'STORED') as Row;
    expect(frame.payload).toBeUndefined();
    expect(frame.metadata).toBeUndefined();
    expect(JSON.stringify(frame)).not.toContain(PLAYER);
    // the ARTIFACT id does reach it — that is what makes a negotiation followable
    expect(frame.subjectId).toBe(LISTING);
    expect(frame.subjectType).toBe('TRANSFER');
  });

  it('every payload validates against its declared schema, which is strict', async () => {
    events.emitListingCreated(SELLER, PLAYER, LISTING, ACTOR);
    events.emitListingWithdrawn(SELLER, PLAYER, LISTING, 'AUCTION', ACTOR);
    events.emitListingExtended(SELLER, PLAYER, LISTING, 'OPEN_MARKET', ACTOR);
    events.emitOffer('OFFER_ACCEPTED', SELLER, BUYER, PLAYER, OFFER, SELLER, ACTOR);
    events.emitAuctionBid(LISTING, PLAYER, SELLER, BUYER, null, ACTOR);
    events.emitInterest(SELLER, BUYER, PLAYER, 'interest-1', ACTOR);
    events.emitInterestAnswered(SELLER, BUYER, PLAYER, 'interest-1', 'DECLINED', ACTOR);
    events.emitNegotiationSuperseded('interest-1', SELLER, BUYER, PLAYER, ACTOR);
    events.emitShortlisted(BUYER, PLAYER, 'target-1', ACTOR);
    events.emitUnshortlisted(BUYER, PLAYER, 'target-1', ACTOR);
    events.emitTransferCompleted(SELLER, BUYER, PLAYER, { offerId: OFFER }, 'PURCHASE', ACTOR);
    await settle();

    const transfers = published.filter((e) => e.eventType.startsWith('transfer.'));
    expect(transfers.length).toBe(11);
    for (const e of transfers) {
      const check = validateEventPayload(e.eventType, 1, e.payload);
      expect(`${e.eventType}: ${check.ok ? 'ok' : JSON.stringify((check as Row).issues)}`)
        .toBe(`${e.eventType}: ok`);
    }
  });

  it('a strict schema refuses a fee somebody adds later', () => {
    const withFee = validateEventPayload('transfer.offer.created', 1, {
      playerId: PLAYER, counterpartyClubId: SELLER, transferStage: 'OFFER',
      feeEur: SECRETS.feeEur,
    });
    expect(withFee.ok).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8 · ONE SOURCE, AND COACH MARKET SOMEWHERE ELSE
// ══════════════════════════════════════════════════════════════════════════════

describe('the source', () => {
  it('every registered Transfers event is under the one transfers source', () => {
    const owned = fabricEventsForSource('transfers');
    expect(owned.length).toBeGreaterThan(10);
    for (const spec of owned) {
      expect(`${spec.type}: ${spec.source}`).toBe(`${spec.type}: transfers`);
      expect(spec.type.startsWith('transfer.')).toBe(true);
      expect(spec.entityType).toBe('TRANSFER');
    }
  });

  it('the five families create no source cards of their own', () => {
    const ids = visibleFabricSources().map((s) => s.id);
    for (const invented of ['market', 'shortlist', 'offers', 'negotiations', 'completed', 'auctions']) {
      expect(`${invented} is a source: ${ids.includes(invented)}`).toBe(`${invented} is a source: false`);
    }
    expect(ids).toContain('transfers');
  });

  it('the Coach Market does not reach the Transfers producer or its funnel', () => {
    const dir = path.join(__dirname, '..', 'src', 'staff-market');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(`${file} imports transfer-events: ${src.includes('transfer-events')}`)
        .toBe(`${file} imports transfer-events: false`);
      expect(`${file} imports transfers.producer: ${src.includes('transfers.producer')}`)
        .toBe(`${file} imports transfers.producer: false`);
      expect(`${file} publishes a transfer.*: ${/publishTransfer[A-Z]/.test(src)}`)
        .toBe(`${file} publishes a transfer.*: false`);
    }
  });

  it('no registered Transfers event is about a coach or a staff member', () => {
    for (const spec of fabricEventsForSource('transfers')) {
      expect(`${spec.type}: ${/coach|staff/i.test(`${spec.type} ${spec.describes}`)}`)
        .toBe(`${spec.type}: false`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9 · THE CATALOGUE
// ══════════════════════════════════════════════════════════════════════════════

describe('the catalogue', () => {
  const PRODUCED = [
    'transfer.listed', 'transfer.listing.updated', 'transfer.listing.withdrawn',
    'transfer.offer.created', 'transfer.offer.updated', 'transfer.offer.accepted',
    'transfer.offer.rejected', 'transfer.offer.withdrawn', 'transfer.bid.placed',
    'transfer.negotiation.started', 'transfer.negotiation.updated',
    'transfer.negotiation.completed',
    'transfer.shortlisted', 'transfer.unshortlisted', 'transfer.completed',
  ];

  it('registers every produced type, with a schema and a Transfers lane', () => {
    for (const type of PRODUCED) {
      const spec = fabricEvent(type);
      expect(`${type} registered: ${!!spec}`).toBe(`${type} registered: true`);
      expect(`${type} produced: ${spec!.produced}`).toBe(`${type} produced: true`);
      expect(sourceLaneFor(type)).toBe('Transfers');
      const check = validateEventPayload(type, 1, null);
      expect(`${type} has a schema: ${check.ok === false}`).toBe(`${type} has a schema: true`);
    }
  });

  it('says plainly which names are declared and not yet published', () => {
    const declared = fabricEventsForSource('transfers').filter((s) => !s.produced).map((s) => s.type).sort();
    // Two capabilities Familista has no flow for, and one legacy name the
    // five `transfer.offer.*` states replaced. A consumer reading the catalogue
    // is told, rather than left subscribing to something that never arrives.
    expect(declared).toEqual([
      'transfer.cancelled', 'transfer.negotiation.cancelled', 'transfer.offered',
    ]);
  });

  it('and everything else under the source IS published by this build', () => {
    const produced = fabricEventsForSource('transfers').filter((s) => s.produced).map((s) => s.type).sort();
    expect(produced).toEqual([...PRODUCED].sort());
  });

  it('every Transfers event is CONFIDENTIAL — a market is nobody else’s business', () => {
    for (const spec of fabricEventsForSource('transfers')) {
      expect(`${spec.type}: ${spec.classification}`).toBe(`${spec.type}: CONFIDENTIAL`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10 · THE FABRIC MUST NOT BE ABLE TO BREAK A TRANSFER
// ══════════════════════════════════════════════════════════════════════════════

describe('when the fabric is broken', () => {
  it('a transport that throws does not fail the market call that caused it', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('outbox is down'); },
      async read() { return []; },
    } as EventTransport);

    expect(() => events.emitListingCreated(SELLER, PLAYER, LISTING, ACTOR)).not.toThrow();
    expect(() => events.emitTransferCompleted(SELLER, BUYER, PLAYER, { offerId: OFFER }, 'PURCHASE', ACTOR)).not.toThrow();
    const row = await discovery.addToShortlist(ACTOR_CTX, PLAYER);
    await settle();

    // the business outcome stands
    expect(row.id).toBeTruthy();
    expect(state.targets).toHaveLength(1);
    setEventTransport(transport);
  });

  it('an unregistered subject id does not stop the rest of the market', async () => {
    expect(() => events.emitListingCreated(SELLER, PLAYER, '', ACTOR)).not.toThrow();
    events.emitListingCreated(SELLER, PLAYER, LISTING, ACTOR);
    await settle();
    expect(published.filter((e) => e.eventType === 'transfer.listed').length).toBeGreaterThan(0);
  });
});
